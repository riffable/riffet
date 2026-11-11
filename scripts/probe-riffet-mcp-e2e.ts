/**
 * Manual real-CLI probe of the Riffet MCP server (docs/DEVICES.md §2), driven through an in-process
 * server on a temp state dir. It never touches the running Riffet service or the user's profiles:
 * the Claude profile is copied read-only into the temp state dir, the Codex one is created there.
 *
 *   node --import tsx scripts/probe-riffet-mcp-e2e.ts --profile <name> [--model <id>] [--source <model source id>] [--only a,b,c] [--keep]
 *
 * a. Claude, created as `android` with `riffet.core` on: the agent calls `notify_user` and
 *    `schedule_wakeup(inMinutes: 1)`; the wake-up starts exactly one more turn in the same conversation.
 * b. Claude, created as `web` with defaults: the launch carries no Riffet MCP server.
 * c. Codex on the `--source` model source (skipped without it), read-only sandbox: the shim reaches the server from inside
 *    the Codex session, while a sandboxed shell command cannot reach the same loopback port.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, Session } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/server/src/app.js';
import { copyRiffetProfile, log, probeDirs, requireCli } from './probe-sync-e2e-lib.js';

for (const name of Object.keys(process.env)) {
  if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|RIFFET_CLAUDE_HOOK_.*|AI_AGENT|CODEX_.*)$/.test(name) && name !== 'CODEX_HOME') delete process.env[name];
}
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
const profileName = option('--profile', '');
if (!profileName) throw new Error('Pass --profile <name>: a Claude profile of your own Riffet to copy');
const modelOverride = option('--model', '');
const modelSource = option('--source', '');
const only = new Set(option('--only', 'a,b,c').split(',').map(item => item.trim()));
const keep = args.includes('--keep');
requireCli('claude', 'Claude Code', 'Install Claude Code');
if (only.has('c')) requireCli('codex', 'Codex', 'Install Codex');

const dirs = await probeDirs('riffet-mcp');
const services = await createApp({ stateDir: dirs.stateDir, auth: false, cliPath: 'cursor-agent' });
await services.app.listen({ host: '127.0.0.1', port: 0 });
const port = (services.app.server.address() as { port: number }).port;
const origin = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const status = await services.app.inject({ url: '/api/auth/status', headers: origin });
const base = { ...origin, cookie: String(status.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': String(status.json().csrfToken) };
async function call<T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const response = await services.app.inject({ method, url, headers: { ...base, ...extra }, ...(payload === undefined ? {} : { payload: payload as object }) });
  if (response.statusCode >= 400) throw new Error(`${method} ${url}: ${response.statusCode} ${response.body}`);
  return (response.body ? response.json() : undefined) as T;
}

// Every native launch, as the terminal service receives it: the evidence of what was injected.
const launches: Array<{ sessionId?: string; command: string; args: string[] }> = [];
{
  const terminal = services.terminal as unknown as { create: (project: unknown, input: { sessionId?: string; launchSpec?: { command: string; args: string[] } }) => Promise<unknown> };
  const original = terminal.create.bind(terminal);
  terminal.create = async (project, input) => {
    if (input.launchSpec) launches.push({ sessionId: input.sessionId, command: input.launchSpec.command, args: [...input.launchSpec.args] });
    return await original(project, input);
  };
}

// Every request the shim forwards, with its outcome.
const rpcLog: string[] = [];
{
  const service = services.riffetMcp as unknown as { handle: (authorization: string | undefined, method: unknown, params: unknown) => Promise<unknown> };
  const original = service.handle.bind(service);
  service.handle = async (authorization, method, params) => {
    try { const result = await original(authorization, method, params); rpcLog.push(`${String(method)} ${JSON.stringify(params ?? {}).slice(0, 80)} -> ok ${JSON.stringify(result).slice(0, 80)}`); return result; }
    catch (error) { rpcLog.push(`${String(method)} -> ${error instanceof Error ? error.message : String(error)}`); throw error; }
  };
}
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const checks: Array<{ scenario: string; name: string; ok: boolean; evidence: string }> = [];
const check = (scenario: string, name: string, ok: boolean, evidence: unknown) => {
  const text = typeof evidence === 'string' ? evidence : JSON.stringify(evidence);
  checks.push({ scenario, name, ok, evidence: text.slice(0, 600) });
  log(`${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name} — ${text.slice(0, 300)}`);
};
const runs = (sessionId: string): Run[] => services.store.listRuns(sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
async function until<T>(what: string, seconds: number, probe: () => T | undefined | false): Promise<T | undefined> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await sleep(1000);
  }
  log(`timed out waiting for ${what}`);
  return undefined;
}
const settled = (run: Run) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state);
async function transcript(sessionId: string): Promise<string[]> {
  try {
    const page = await call<{ rows?: Array<{ block?: Record<string, unknown> } & Record<string, unknown>> }>('GET', `/api/v3/sessions/${sessionId}/timeline?lane=main&rows=200&from=0`);
    return (page.rows ?? []).flatMap(row => {
      const block = (row.block ?? row) as Record<string, unknown>;
      if (block.kind === 'assistant') return [`assistant: ${String(block.text).slice(0, 200)}`];
      if (block.kind === 'tool') return [`tool: ${JSON.stringify(block.activity ?? block.job ?? block).slice(0, 200)}`];
      if (block.kind === 'user') return [`user: ${String(block.text).slice(0, 120)}`];
      return [];
    });
  } catch (error) { return [`timeline unavailable: ${error instanceof Error ? error.message : String(error)}`]; }
}

const project = await call<{ id: string }>('POST', '/api/projects', { cwd: dirs.project });
const claude = await copyRiffetProfile((url, body) => call('POST', url, body), 'claude', profileName);
const model = modelOverride || claude.model;

async function create(id: string, client: string | undefined, target: Record<string, unknown>, text: string): Promise<Session> {
  const created = await call<{ session: Session }>('POST', '/api/sessions', {
    kind: 'native', projectId: project.id, clientSessionId: id, ...(client ? { toolGroups: ['riffet.core'] } : {}), ...target, initialMessage: { commandId: `${id}-1`, text },
  });
  return created.session;
}

try {
  if (only.has('a')) {
    const prompt = [
      'You have Riffet MCP tools (server "riffet"). Do exactly these steps, without running any shell command:',
      '1. Call notify_user with title "probe" and body "PROBE-NOTICE-A".',
      '2. Call schedule_wakeup with inMinutes 1 and note "PROBE-WAKEUP: reply with exactly the word WOKE and do nothing else."',
      '3. Reply with exactly DONE.',
    ].join('\n');
    const session = await create('probe-a', 'android', { backendId: 'claude', backendProfileId: claude.backendProfileId, model, approval: 'bypassPermissions' }, prompt);
    check('a', 'session snapshot from android', JSON.stringify(services.store.getSession(session.id).toolGroups) === '["riffet.core"]', { toolGroups: services.store.getSession(session.id).toolGroups });
    const first = await until('first turn', 240, () => runs(session.id).find(run => run.commandId === 'probe-a-1' && settled(run)));
    const launch = launches.find(item => item.sessionId === session.id);
    const configFile = launch?.args[launch.args.indexOf('--mcp-config') + 1];
    const config = configFile && launch!.args.includes('--mcp-config') ? JSON.parse(readFileSync(configFile, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> } : undefined;
    check('a', 'launch carries --mcp-config with the riffet shim', Boolean(config?.mcpServers.riffet?.args.some(arg => arg.endsWith('riffet-mcp.mjs'))), { mcpConfig: config ? { riffet: { command: config.mcpServers.riffet?.command, args: config.mcpServers.riffet?.args.map(arg => arg.replace(dirs.root, '<tmp>')) } } : launch?.args });
    check('a', 'first turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
    const notices = await call<Array<{ body: string; source: string }>>('GET', `/api/sessions/${session.id}/notices`);
    check('a', 'notify_user recorded a notice', notices.some(item => item.body === 'PROBE-NOTICE-A'), notices);
    const wakeups = await call<Array<{ id: string; status: string; dueAt: string; note: string }>>('GET', `/api/sessions/${session.id}/wakeups`);
    check('a', 'schedule_wakeup recorded one pending wake-up', wakeups.length === 1 && wakeups[0]!.status === 'pending', wakeups);
    if (wakeups[0]) {
      const woken = await until('wake-up turn', 200, () => runs(session.id).find(run => run.commandId === `wakeup-${wakeups[0]!.id}` && settled(run)));
      check('a', 'wake-up started a turn in the same conversation', woken?.state === 'completed', { state: woken?.state, prompt: woken?.prompt.slice(0, 160), firedAt: (await call<Array<{ firedAt?: string }>>('GET', `/api/sessions/${session.id}/wakeups`))[0]?.firedAt, dueAt: wakeups[0].dueAt });
      log('waiting 45s to make sure the wake-up does not fire again');
      await sleep(45_000);
      const after = await call<Array<{ status: string; runId?: string }>>('GET', `/api/sessions/${session.id}/wakeups`);
      check('a', 'wake-up fired exactly once', runs(session.id).length === 2 && after[0]?.status === 'fired', { runs: runs(session.id).map(run => `${run.commandId}:${run.state}`), wakeup: after[0] });
    }
    log(`a transcript:\n  ${(await transcript(session.id)).join('\n  ')}`);
  }

  if (only.has('b')) {
    const session = await create('probe-b', undefined, { backendId: 'claude', backendProfileId: claude.backendProfileId, model, approval: 'bypassPermissions' },
      'If you have any tool whose name contains "riffet", list their names; otherwise reply with exactly NONE. Do not run any command.');
    check('b', 'web session has no tool groups', services.store.getSession(session.id).toolGroups === undefined, { toolGroups: services.store.getSession(session.id).toolGroups });
    const first = await until('web turn', 240, () => runs(session.id).find(run => settled(run)));
    const launch = launches.find(item => item.sessionId === session.id);
    check('b', 'launch carries no --mcp-config', Boolean(launch) && !launch!.args.includes('--mcp-config'), { args: launch?.args.filter(arg => arg.startsWith('--')) });
    check('b', 'turn completed', first?.state === 'completed', { state: first?.state });
    log(`b transcript:\n  ${(await transcript(session.id)).join('\n  ')}`);
  }

  if (only.has('c') && !modelSource) log('c skipped: pass --source <model source id>');
  if (only.has('c') && modelSource) {
    // Codex runs on a config dir of its own, so its history and state stay out of the user's `~/.codex`;
    // `--codex-home <dir>` names another (`--codex-home ''` uses the user's).
    const codexHome = option('--codex-home', join(dirs.root, 'codex-home'));
    if (codexHome) execFileSync('mkdir', ['-p', codexHome]);
    await call('POST', '/api/backends/codex/profiles', { id: 'probe-codex', name: 'Probe (codex)', modelSource, ...(codexHome ? { configDir: codexHome } : {}) });
    const prompt = [
      'You have Riffet MCP tools (server "riffet"). Do exactly these steps, without running any shell command:',
      '1. Call the riffet notify_user tool with body "PROBE-NOTICE-C".',
      '2. Call the riffet list_devices tool.',
      '3. Reply with exactly DONE.',
    ].join('\n');
    const session = await create('probe-c', 'android', { backendId: 'codex', backendProfileId: 'probe-codex', model, approval: 'read-only' }, prompt);
    check('c', 'session snapshot from android', JSON.stringify(services.store.getSession(session.id).toolGroups) === '["riffet.core"]', { toolGroups: services.store.getSession(session.id).toolGroups });
    const first = await until('codex turn', 300, () => runs(session.id).find(run => settled(run)));
    check('c', 'turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
    const notices = await call<Array<{ body: string }>>('GET', `/api/sessions/${session.id}/notices`);
    check('c', 'shim reached the server from the read-only Codex session', notices.some(item => item.body === 'PROBE-NOTICE-C'), notices);
    log(`c transcript:\n  ${(await transcript(session.id)).join('\n  ')}`);
    // The control: the same loopback port from a command run under Codex's own seatbelt policy.
    let sandboxed: string;
    try { sandboxed = execFileSync('codex', ['sandbox', '--', 'curl', '-sS', '-m', '5', `http://127.0.0.1:${port}/health`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { sandboxed = `exit ${(error as { status?: number }).status}: ${String((error as { stderr?: string }).stderr ?? '').trim().slice(0, 200)}`; }
    check('c', 'a sandboxed shell command cannot reach the same port (control)', !sandboxed.includes('"ok":true'), sandboxed);
  }
} finally {
  log(`Riffet MCP requests:\n  ${rpcLog.join('\n  ')}`);
  const failed = checks.filter(item => !item.ok);
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  // Archiving stops each conversation's CLI, app-server and terminal before the server goes.
  for (const session of services.store.listSessions()) await call('PATCH', `/api/sessions/${session.id}`, { archived: true }).catch(() => undefined);
  await services.app.close().catch(() => undefined);
  if (!keep) await dirs.remove().catch(() => undefined);
  else log(`kept ${dirs.root}`);
  process.exit(failed.length ? 1 : 0);
}
