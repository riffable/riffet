import { spawn } from 'node:child_process';
import type { NativeSlashItem } from '../../../../../packages/contracts/src/index.js';
import { referencedSkills } from '../shared/slash-tokens.js';

const PROBE_TIMEOUT_MS = 30_000;
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Claude Code's own `/` catalog: built-in commands, bundled, user, project and plugin skills, and
 * custom commands. The stream-json `initialize` control request answers before any prompt is
 * sent, so no model is called; hooks are disabled and nothing is persisted, so the probe leaves no
 * trace in the user's sessions or hook pipelines.
 */
export async function probeClaudeSlashItems(executable: string, cwd: string, env: Record<string, string>, launchArgs: readonly string[] = []): Promise<NativeSlashItem[]> {
  const child = spawn(executable, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--settings', JSON.stringify({ disableAllHooks: true }), '--no-session-persistence', ...launchArgs,
  ], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const requestId = 'riffet-slash';
  return await new Promise<NativeSlashItem[]>((resolve, reject) => {
    let buffer = '';
    let size = 0;
    let settled = false;
    const finish = (error: Error | undefined, items?: NativeSlashItem[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(items ?? []);
    };
    const timer = setTimeout(() => finish(new Error('Claude Code did not list its commands in time')), PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', error => finish(error));
    child.on('exit', code => finish(new Error(`Claude Code exited (${code ?? 'signal'}) before listing its commands`)));
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROBE_OUTPUT_BYTES) return finish(new Error('Claude Code command listing exceeded the read limit'));
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let response: { commands?: unknown } | undefined;
        try { response = controlResponse(line, requestId); } catch (error) { return finish(error as Error); }
        if (response) return finish(undefined, parseClaudeCommands(response.commands));
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })}\n`);
  });
}

function controlResponse(line: string, requestId: string): { commands?: unknown } | undefined {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(message) || message.type !== 'control_response' || !isRecord(message.response)) return undefined;
  const envelope = message.response;
  if (envelope.request_id !== undefined && envelope.request_id !== requestId) return undefined;
  if (envelope.subtype === 'error') throw new Error(typeof envelope.error === 'string' ? envelope.error : 'Claude Code refused to list its commands');
  return isRecord(envelope.response) ? envelope.response : envelope;
}

/**
 * Claude reports no kind per entry, but it marks what it loaded from files: user and project
 * entries end in `(user)` / `(project)`, and plugin entries are namespaced `plugin:name`. Those are
 * prompt templates that are safe to invoke from mid-message; everything else is treated as a
 * built-in command that only works as the leading token.
 */
export function parseClaudeCommands(value: unknown): NativeSlashItem[] {
  if (!Array.isArray(value)) return [];
  const items: NativeSlashItem[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue;
    const name = entry.name.replace(/^\//, '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const rawDescription = typeof entry.description === 'string' ? entry.description.trim() : '';
    const source = /\s\((user|project)\)$/.exec(rawDescription);
    const description = source ? rawDescription.slice(0, source.index).trim() : rawDescription;
    const hint = typeof entry.argumentHint === 'string' ? entry.argumentHint.trim() : '';
    items.push({
      name,
      kind: source || name.includes(':') ? 'skill' : 'command',
      ...(description ? { description } : {}),
      ...(hint ? { hint } : {}),
    });
  }
  return items;
}

/**
 * Claude Code expands a skill only when it opens the message; named mid-message it is prose the
 * model may or may not act on. A message that names exactly one skill, and does not already open
 * with a command, is moved behind that skill so the expansion is deterministic; the text itself
 * travels unchanged as the skill's arguments. With two or more there is no single leading seat,
 * so the text is left for the model to act on.
 */
export function leadWithInlineSkill(text: string, items: readonly NativeSlashItem[]): string {
  if (/^\s*\//.test(text)) return text;
  const skills = referencedSkills(text, items.filter(item => item.kind === 'skill'));
  if (skills.length !== 1) return text;
  return `/${skills[0]!.name} ${text}`;
}

/**
 * Whether Claude answers `text` inside its own pane as a slash command. A leading `/name` naming a
 * skill is not one: Claude runs the skill as an ordinary turn whose reply lands in the transcript.
 */
export function leadsWithCommand(text: string, items: readonly NativeSlashItem[]): boolean {
  const name = /^\s*\/(\S+)/.exec(text)?.[1];
  if (!name) return false;
  return items.find(item => item.name === name)?.kind !== 'skill';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
