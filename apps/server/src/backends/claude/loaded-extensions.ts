import { spawn } from 'node:child_process';
import type { LoadedExtensions } from '../../../../../packages/contracts/src/index.js';
import { RIFFET_MCP_NAME } from '../../riffet-mcp/service.js';

const PROBE_TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 1_500;
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Belt and braces: the probe sends no user message, so no model request is made, but nothing listens here either. */
const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9';
/** Provider switches that make the CLI ignore the base URL; the probe starts without them. */
const PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

/**
 * The MCP servers and skills a Claude Code launch in `cwd` loads (docs/EXTENSIONS.md), read over the stream-json
 * control channel like the slash probe (`slash.ts`): `initialize` lists the commands and skills, `mcp_status` the
 * servers. No user message is sent, so no model is called, and hooks are off; nothing is persisted. Only names leave
 * this function: `mcp_status` also carries each server's command line and environment, which are never read.
 *
 * `initialize` does not tell a bundled skill from a built-in command, so only skills the CLI marks are listed: those
 * from the user's or the project's skill folders (`(user)` / `(project)`) and plugins (`plugin:name`).
 */
export async function probeClaudeLoadedExtensions(executable: string, cwd: string, env: Record<string, string>): Promise<Omit<LoadedExtensions, 'checkedAt'>> {
  const settings = JSON.stringify({ disableAllHooks: true, env: { ANTHROPIC_BASE_URL: UNREACHABLE_BASE_URL } });
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env, ANTHROPIC_BASE_URL: UNREACHABLE_BASE_URL };
  for (const name of PROVIDER_SWITCHES) delete childEnv[name];
  const child = spawn(executable, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', settings, '--no-session-persistence',
  ], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  return await new Promise((resolve, reject) => {
    let buffer = '';
    let size = 0;
    let settled = false;
    let initialize: unknown;
    let status: unknown;
    let result: { value?: Omit<LoadedExtensions, 'checkedAt'>; error?: Error } | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, KILL_GRACE_MS).unref();
    };
    // The answer is delivered once the process is gone, so a finished probe leaves nothing behind.
    const finish = (outcome: NonNullable<typeof result>) => {
      if (result) return;
      result = outcome;
      clearTimeout(timer);
      stop();
    };
    const timer = setTimeout(() => finish({ error: new Error('Claude Code did not report its extensions in time') }), PROBE_TIMEOUT_MS);
    timer.unref?.();
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result?.value) resolve(result.value); else reject(result?.error ?? new Error('Claude Code probe failed'));
    };
    child.on('error', error => { result ??= { error }; settle(); });
    child.on('close', code => { result ??= { error: new Error(`Claude Code exited (${code ?? 'signal'}) before reporting its extensions`) }; settle(); });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROBE_OUTPUT_BYTES) return finish({ error: new Error('Claude Code output exceeded the read limit') });
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const response = controlResponse(line);
        if (!response) continue;
        if (response.error) return finish({ error: new Error(response.error) });
        if (response.id === 'riffet-initialize') initialize = response.body;
        else if (response.id === 'riffet-mcp-status') status = response.body;
        if (initialize !== undefined && status !== undefined) return finish({ value: { mcp: parseMcpStatus(status), skills: parseSkills(initialize) } });
      }
    });
    child.stdin.on('error', () => undefined);
    for (const [id, subtype] of [['riffet-initialize', 'initialize'], ['riffet-mcp-status', 'mcp_status']]) {
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } })}\n`);
    }
  });
}

function controlResponse(line: string): { id: string; body: unknown; error?: string } | undefined {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(message) || message.type !== 'control_response' || !isRecord(message.response)) return undefined;
  const envelope = message.response;
  const id = typeof envelope.request_id === 'string' ? envelope.request_id : '';
  if (!id.startsWith('riffet-')) return undefined;
  if (envelope.subtype === 'error') return { id, body: undefined, error: typeof envelope.error === 'string' ? envelope.error.slice(0, 200) : 'Claude Code refused the request' };
  return { id, body: envelope.response ?? {} };
}

/** Server names from an `mcp_status` response, Riffet's own left out; a tool count only when the CLI reports the tools. */
export function parseMcpStatus(value: unknown): LoadedExtensions['mcp'] {
  const mcp: LoadedExtensions['mcp'] = [];
  const servers = isRecord(value) && Array.isArray(value.mcpServers) ? value.mcpServers : [];
  for (const server of servers) {
    if (!isRecord(server) || typeof server.name !== 'string' || !server.name || server.name === RIFFET_MCP_NAME || mcp.some(item => item.name === server.name)) continue;
    mcp.push({ name: server.name, ...(Array.isArray(server.tools) && server.tools.length ? { tools: server.tools.length } : {}) });
  }
  return mcp;
}

/** Skills among the `initialize` commands: user and project ones carry a `(user)` / `(project)` suffix, plugin ones are `plugin:name`. */
export function parseSkills(value: unknown): LoadedExtensions['skills'] {
  const skills: LoadedExtensions['skills'] = [];
  const commands = isRecord(value) && Array.isArray(value.commands) ? value.commands : [];
  for (const command of commands) {
    if (!isRecord(command) || typeof command.name !== 'string') continue;
    const name = command.name.replace(/^\//, '').trim();
    const raw = typeof command.description === 'string' ? command.description.trim() : '';
    const marked = /\s\((user|project)\)$/.exec(raw);
    if (!name || (!marked && !name.includes(':')) || skills.some(item => item.name === name)) continue;
    const description = (marked ? raw.slice(0, marked.index) : raw).trim();
    skills.push({ name, ...(description ? { description } : {}) });
  }
  return skills;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
