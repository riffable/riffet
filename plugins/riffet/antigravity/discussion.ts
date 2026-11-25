import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDiscussionRequest, AgentHost, AgentProfile } from '@riffet/plugin-api/experimental/agent';
import { discussionPrompt, runProcess } from '@riffet/plugin-api/kit';
import { agySelection, discussionModelSettings } from './config.js';
import { agyLaunchModel, agyProcessEnvironment, launchProfile, nativeModels } from './models.js';
import { agyRecord } from './protocol.js';
import type { Hub } from './runtime.js';

const AGENT = 'riffet-discussion';
const AGENT_DEFINITION = [
  '---', `name: ${AGENT}`, 'description: Answers side questions.', 'mainAgent: true', 'subagent: false', 'tools: []', '---',
].join('\n');
// agy adds manage_task even to a custom main agent with an empty tool list. Veto tool execution in this fresh session.
const HOOKS = { discussion: { enabled: true, PreToolUse: [{ matcher: '*', hooks: [{
  type: 'command', command: `echo '{"decision":"deny","reason":"Side chats have no tools"}'`,
}] }] } };

export async function streamAgyDiscussion(hub: Hub, host: AgentHost, profile: AgentProfile, request: AgentDiscussionRequest): Promise<void> {
  request.signal.throwIfAborted();
  const launch = await launchProfile(host, profile);
  // Native Google sign-in selects an account from the OS keyring. A temporary root has no
  // binding to the parent session's account, so it cannot send the quoted transcript that way.
  if (!launch.hasApiKey) throw host.error('DISCUSSION_PROVIDER_UNAVAILABLE',
    'Antigravity side chats require a provider configured with a Gemini API key', 409);
  const selection = agySelection(request.model || (typeof profile.config.defaultModel === 'string' ? profile.config.defaultModel : undefined));
  const catalog = selection ? await nativeModels(hub, launch) : [];
  const model = agyLaunchModel(selection, catalog, launch);
  if (selection?.effort && model.effort !== selection.effort && !model.model?.endsWith(`-${selection.effort}`))
    throw new Error('Antigravity could not resolve the selected reasoning effort');
  const modelSettings = await discussionModelSettings(launch, model.custom);
  request.signal.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), 'riffet-agy-discussion-'));
  try {
    const cwd = join(root, 'workspace');
    const native = join(root, 'native');
    const agents = join(native, 'config', 'agents');
    await mkdir(agents, { recursive: true, mode: 0o700 });
    await mkdir(cwd, { mode: 0o700 });
    await writeFile(join(agents, AGENT + '.md'), `${AGENT_DEFINITION}\n${request.system}\n`, { mode: 0o600 });
    await writeFile(join(native, 'config', 'hooks.json'), JSON.stringify(HOOKS), { mode: 0o600 });
    const args = [`--gemini_dir=${native}`, '--agent', AGENT, '--disable-slash-commands', '--log-file', devNull,
      '--settings', JSON.stringify({ ...modelSettings, toolPermission: 'strict', agentMode: '', allowNonWorkspaceAccess: false, trustedWorkspaces: [cwd] }),
      '--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (model.model) args.push('--model', model.model);
    if (model.effort) args.push('--effort', model.effort);
    const prompt = discussionPrompt(request.messages);
    let started = false;
    let completed = false;
    let emitted = false;
    const processResult = await runProcess(launch.executable, args, {
      cwd, env: agyProcessEnvironment(launch), signal: request.signal, timeoutMs: null,
      input: Buffer.from(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n'),
      onStdoutLine(line) {
        if (!line.trim()) return;
        let event: unknown;
        try { event = JSON.parse(line); } catch { throw new Error('Invalid Antigravity side chat event'); }
        if (!agyRecord(event)) throw new Error('Invalid Antigravity side chat event');
        if (event.event === 'init') {
          const init = event.init;
          if (!agyRecord(init) || init.agent !== AGENT || init.permission_mode !== 'strict')
            throw new Error('Antigravity did not start the restricted side chat');
          if (model.model && init.model !== model.model && !catalog.some(item => item.value === init.model && model.labels.includes(item.name)))
            throw new Error('Antigravity did not start the selected model');
          started = true;
        } else if (event.event === 'step_update' && started) {
          const step = event.step_update;
          if (agyRecord(step) && step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
            request.onDelta(step.text_delta);
            emitted = true;
          }
        } else if (event.event === 'result' && started) {
          const result = event.result;
          if (!agyRecord(result) || result.status !== 'SUCCESS') throw new Error('Antigravity could not complete the side chat');
          if (!emitted && typeof result.response === 'string' && result.response) {
            request.onDelta(result.response);
            emitted = true;
          }
          completed = true;
        }
      },
    });
    request.signal.throwIfAborted();
    if (!completed || !emitted || processResult.code !== 0 || processResult.truncated)
      throw new Error('Antigravity did not return a side chat answer');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
