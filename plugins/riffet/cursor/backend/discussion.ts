import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentDiscussionRequest } from '@riffet/plugin-api/experimental/agent';
import { discussionPrompt, redactSensitiveText } from '@riffet/plugin-api/kit';
import { cursorUsesAccountLogin, runCursor, withCursorConfigDir, type CursorLaunchProfile } from '../cli-driver.js';
import { MODEL_ID } from '../native/model-list.js';

// A private cli-config keeps the provider, default model and privacy settings. The owner’s
// permissions, extensions, rules and chat store do not belong to a text-only discussion.
const PROFILE_FIELDS = [
  'version', 'channel', 'network', 'bedrock', 'awsAuthRefresh', 'authInfo', 'privacyCache', 'model',
  'selectedModel', 'modelParameters', 'hasChangedDefaultModel', 'maxMode', 'maxModeAutoEnabled',
] as const;

async function copyProviderConfig(owner: string, directory: string): Promise<void> {
  let text: string;
  try { text = await readFile(join(owner, 'cli-config.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const config = JSON.parse(text) as Record<string, unknown>;
  const settings = Object.fromEntries(PROFILE_FIELDS.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  await writeFile(join(directory, 'cli-config.json'), JSON.stringify(settings), { mode: 0o600 });
}

/** Cursor looks up account credentials through the OS, separately from CURSOR_CONFIG_DIR.
 * A file-store user gets the original auth file. Skills, hooks, plugins and MCP configs live
 * elsewhere in the owner's home and are never mounted in the side chat. */
async function mountCursorLogin(home: string): Promise<void> {
  const source = process.platform === 'darwin' ? join(homedir(), '.cursor', 'auth.json')
    : process.platform === 'win32' ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'auth.json')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cursor', 'auth.json');
  const target = process.platform === 'darwin' ? join(home, '.cursor', 'auth.json')
    : process.platform === 'win32' ? join(home, 'AppData', 'Roaming', 'Cursor', 'auth.json')
    : join(home, '.config', 'cursor', 'auth.json');
  try { await access(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target, 'file');
}

/** Partial-output format: timestamped assistant chunks carry text. The model-call and final
 * flushes repeat the block. On a retry the CLI can repeat it without a model_call_id.
 * https://cursor.com/docs/cli/reference/output-format */
function cursorReply(onDelta: AgentDiscussionRequest['onDelta']) {
  let sent = '', block = '', possibleRepeat = '';
  let complete = false;
  const emit = (text: string) => {
    if (!text) return;
    onDelta(text);
    sent += text;
    block += text;
  };
  return {
    completed: () => complete,
    line(line: string) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'tool_call' || event.type === 'interaction_query') throw new Error('Cursor requested a tool during a text-only discussion');
      if (event.type === 'assistant') {
        const text = event.message.content.filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('');
        if (event.timestamp_ms === undefined || event.model_call_id !== undefined) {
          if (possibleRepeat && text === block + possibleRepeat) emit(possibleRepeat);
          possibleRepeat = '';
        } else {
          // Identical consecutive deltas are valid. Keep an ambiguous repeat until the next
          // delta or checkpoint identifies it, while forwarding other text immediately.
          emit(possibleRepeat);
          possibleRepeat = text === block ? text : '';
          if (!possibleRepeat) emit(text);
        }
      } else if (event.type === 'usage' || event.type === 'retry') {
        possibleRepeat = block = '';
      } else if (event.type === 'result') {
        if (event.is_error || event.subtype !== 'success') throw new Error('Cursor failed to answer the side chat');
        if (typeof event.result !== 'string' || !event.result.startsWith(sent)) throw new Error('Cursor returned inconsistent side chat output');
        emit(event.result.slice(sent.length));
        complete = true;
      }
    },
  };
}

export async function streamCursorDiscussion(owner: CursorLaunchProfile, request: AgentDiscussionRequest): Promise<void> {
  request.signal.throwIfAborted();
  if (request.model && !MODEL_ID.test(request.model)) throw new Error('The selected Cursor model id is invalid');
  const root = await mkdtemp(join(tmpdir(), 'riffet-cursor-discussion-'));
  try {
    const cwd = join(root, 'workspace');
    const home = join(root, 'home');
    const config = join(home, '.cursor');
    await Promise.all([mkdir(join(cwd, '.cursor'), { recursive: true }), mkdir(config, { recursive: true })]);
    if (cursorUsesAccountLogin(owner)) await mountCursorLogin(home);
    await copyProviderConfig(owner.configDir, config);
    // Even a custom gateway that ignores the CLI’s empty model tool list meets the local
    // preToolUse deny hook. Workspace hooks also cover launch wrappers with their own config dir.
    const hooks = JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'exit 2', failClosed: true }] } });
    await Promise.all([writeFile(join(config, 'hooks.json'), hooks), writeFile(join(cwd, '.cursor/hooks.json'), hooks)]);
    const reply = cursorReply(request.onDelta);
    const result = await runCursor(withCursorConfigDir(owner, config), [
      '--print', '--mode', 'ask', '--output-format', 'stream-json', '--stream-partial-output',
      '--allowed-tools=', '--disable-indexing', '--trust', '--workspace', cwd,
      ...(request.model ? ['--model', request.model] : []),
    ], {
      cwd, isolatedHome: home, env: { CURSOR_DATA_DIR: config }, signal: request.signal, timeoutMs: null,
      input: Buffer.from(request.system + '\n\n' + discussionPrompt(request.messages)), onStdoutLine: reply.line,
    });
    request.signal.throwIfAborted();
    if (result.truncated) throw new Error('Cursor side chat exceeded the output limit');
    if (result.code !== 0) throw new Error(redactSensitiveText(result.stderr.trim()).slice(-1000) || 'Cursor side chat failed');
    if (!reply.completed()) throw new Error('Cursor exited before finishing the side chat');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
