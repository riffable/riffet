/**
 * Manual real-CLI probe of the 助理's standing conversation (docs/ASSISTANT.md §3–§5), driven through an in-process
 * server on a temp state dir. It never touches the running Riffet service or the user's profiles: the Claude profile
 * is copied read-only into the temp state dir, with its endpoint replaced by a local proxy that forwards every model
 * request to the real one and keeps the request bodies (never the headers) to read what the model was actually sent.
 *
 *   node --import tsx scripts/probe-assistant-e2e.ts --profile <name> [--model <id>] [--only b,c,e,f,g,h,s] [--timeout <seconds>] [--keep]
 *
 * a. launch: the first conversation opened in the 助理's project becomes its main one; the model request carries
 *    Riffet's system prompt instead of the CLI's, the directory's `AGENTS.md` and `USER.md`, the time, the 助理's
 *    tools, and nothing of the user's own instructions or MCP servers.
 * b. memory: asked to remember something, the 助理 writes it inside its directory, and the change is committed.
 * c. tools: `server_status` answers with the server's version.
 * d. record: the conversation shows each message as it was typed, without the context that rode along.
 * e. summary: after `/compact` the next request says the history was summarized and still carries the instructions.
 * f. new CLI session: when the CLI session is replaced, the next request carries the last turns of the conversation,
 *    and a question about them is answered.
 * g. sign-in: a profile whose endpoint and key live in the CLI's own settings file (not in Riffet) still reaches the
 *    model, although the launch reads none of that file's other settings.
 * h. the owner's files: asked to edit its own rules with its file tools, the 助理 does not, and a stray file left in
 *    the directory is not committed. Two things hold the rules: the system prompt, which this model obeys without
 *    trying, and a deny rule in the launch settings, which this probe therefore does not reach.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Run, Session } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/server/src/app.js';
import { SERVER_VERSION } from '../apps/server/src/version.js';
import { copyRiffetProfile, log, probeDirs, requireCli } from './probe-sync-e2e-lib.js';

for (const name of Object.keys(process.env)) {
  if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|RIFFET_CLAUDE_HOOK_.*|AI_AGENT|CODEX_.*)$/.test(name) && name !== 'CODEX_HOME') delete process.env[name];
}
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
const profileName = option('--profile', '');
if (!profileName) throw new Error('Pass --profile <name>: a Claude profile of your own Riffet to copy');
const modelOverride = option('--model', '');
const keep = args.includes('--keep');
/** `a` (the launch) and `d` (the turn the later ones ask about) always run. */
const only = new Set(option('--only', 'b,c,e,f,g,h,s').split(',').map(item => item.trim()));
const turnSeconds = Number(option('--timeout', '300'));
requireCli('claude', 'Claude Code', 'Install Claude Code');

const dirs = await probeDirs('assistant');
const services = await createApp({ stateDir: dirs.stateDir, auth: false, cliPath: 'cursor-agent' });
await services.app.listen({ host: '127.0.0.1', port: 0 });
const origin = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const status = await services.app.inject({ url: '/api/auth/status', headers: origin });
const base = { ...origin, cookie: String(status.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': String(status.json().csrfToken) };
async function call<T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<T> {
  const response = await services.app.inject({ method, url, headers: base, ...(payload === undefined ? {} : { payload: payload as object }) });
  if (response.statusCode >= 400) throw new Error(`${method} ${url}: ${response.statusCode} ${response.body}`);
  return (response.body ? response.json() : undefined) as T;
}

/** A model request as the CLI sent it: the system prompt, the messages and the tool names, flattened to text. */
interface ModelRequest { system: string; messages: string; tools: string[] }
const modelRequests: ModelRequest[] = [];
let upstream: URL | undefined;
const flat = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const proxy = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(chunk as Buffer));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { system?: unknown; messages?: unknown; tools?: Array<{ name: string }> };
      if (Array.isArray(parsed.messages)) modelRequests.push({ system: flat(parsed.system), messages: flat(parsed.messages), tools: (parsed.tools ?? []).map(tool => tool.name) });
    } catch { /* not a model request */ }
    if (!upstream) { res.writeHead(502); res.end(); return; }
    const target = new URL(upstream.origin + upstream.pathname.replace(/\/$/, '') + (req.url ?? ''));
    const out = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: req.method, headers: { ...req.headers, host: upstream.host, 'content-length': String(body.length) } }, up => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    out.on('error', () => { res.writeHead(502); res.end(); });
    out.end(body);
  });
});
await new Promise<void>(done => proxy.listen(0, '127.0.0.1', done));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

// Every request the shim forwards, with its outcome.
const rpcLog: string[] = [];
{
  const service = services.riffetMcp as unknown as { handle: (authorization: string | undefined, method: unknown, params: unknown, signal?: AbortSignal) => Promise<unknown> };
  const original = service.handle.bind(service);
  service.handle = async (authorization, method, params, signal) => {
    try { const result = await original(authorization, method, params, signal); rpcLog.push(`${String(method)} ${JSON.stringify(params ?? {}).slice(0, 120)} -> ok ${JSON.stringify(result).slice(0, 200)}`); return result; }
    catch (error) { rpcLog.push(`${String(method)} ${JSON.stringify(params ?? {}).slice(0, 120)} -> ${error instanceof Error ? error.message : String(error)}`); throw error; }
  };
}
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const checks: Array<{ scenario: string; name: string; ok: boolean; evidence: string }> = [];
const check = (scenario: string, name: string, ok: boolean, evidence: unknown) => {
  const text = typeof evidence === 'string' ? evidence : JSON.stringify(evidence) ?? 'undefined';
  checks.push({ scenario, name, ok, evidence: text.slice(0, 800) });
  log(`${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name} — ${text.slice(0, 400)}`);
};
const runs = (sessionId: string): Run[] => services.store.listRuns(sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const settled = (run: Run) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state);
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
const turnEnded = (sessionId: string, commandId: string, seconds = turnSeconds) =>
  until(`turn ${commandId}`, seconds, () => runs(sessionId).find(run => run.commandId === commandId && settled(run)));
interface Shown { kind: string; text: string }
async function shown(sessionId: string): Promise<Shown[]> {
  const page = await call<{ rows?: Array<{ block?: Record<string, unknown> } & Record<string, unknown>> }>('GET', `/api/v3/sessions/${sessionId}/timeline?lane=main&rows=300&from=0`);
  return (page.rows ?? []).flatMap(row => {
    const block = (row.block ?? row) as Record<string, unknown>;
    return block.kind === 'assistant' || block.kind === 'user' ? [{ kind: String(block.kind), text: String(block.text ?? '') }] : [];
  });
}
/** Sends [text] and waits for its turn; the requests the model received for it are the ones from [mark] on. */
async function turn(sessionId: string, commandId: string, text: string): Promise<{ run?: Run; requests: ModelRequest[] }> {
  const mark = modelRequests.length;
  await call('POST', `/api/sessions/${sessionId}/native/send`, { commandId, text });
  const run = await turnEnded(sessionId, commandId);
  await sleep(1500);
  return { run, requests: modelRequests.slice(mark) };
}
/** What the conversation's terminal shows, for a turn that did not end as expected. */
async function screen(sessionId: string): Promise<string> {
  const terminalId = services.store.getSession(sessionId).terminalId;
  if (!terminalId) return 'no terminal';
  try { return ((await services.terminal.screen(terminalId)) ?? '').split('\n').filter(line => line.trim()).slice(-25).join('\n'); } catch (error) { return `screen unavailable: ${error instanceof Error ? error.message : String(error)}`; }
}
const lastAnswer = async (sessionId: string) => (await shown(sessionId)).filter(row => row.kind === 'assistant').at(-1)?.text ?? '';
/** A line of the user's own instructions that must never reach the 助理; undefined when they have none. */
function ownInstructionsLine(): string | undefined {
  try {
    return readFileSync(join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), 'CLAUDE.md'), 'utf8').split('\n').map(line => line.trim()).find(line => line.length >= 12);
  } catch { return undefined; }
}

try {
  const claude = await copyRiffetProfile((url, body) => {
    // The copy talks to the proxy; the proxy talks to the profile's own endpoint.
    if (typeof body.apiEndpoint === 'string') { upstream = new URL(body.apiEndpoint); return call('POST', url, { ...body, apiEndpoint: proxyUrl }); }
    return call('POST', url, body);
  }, 'claude', profileName);
  if (!upstream) throw new Error(`profile ${profileName} has no endpoint of its own to forward to`);
  const model = modelOverride || claude.model;
  const assistant = services.store.listProjects().find(project => project.system === 'assistant');
  if (!assistant) throw new Error('the server made no 助理 project');
  const sessionId = 'probe-assistant';

  // a. launch
  const created = await call<{ session: Session }>('POST', '/api/sessions', {
    kind: 'native', projectId: assistant.id, clientSessionId: sessionId, backendId: 'claude', backendProfileId: claude.backendProfileId, model,
    approval: 'bypassPermissions', initialMessage: { commandId: 'probe-1', text: 'Who are you, in one short sentence?' },
  });
  check('a', 'the first conversation is the main one', services.store.getProject(assistant.id).mainSessionId === created.session.id, { mainSessionId: services.store.getProject(assistant.id).mainSessionId });
  const first = await turnEnded(sessionId, 'probe-1');
  await sleep(1500);
  check('a', 'turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
  const launch = modelRequests.find(request => request.tools.length > 0) ?? modelRequests.at(-1);
  check('a', 'a model request was seen', Boolean(launch), { requests: modelRequests.length });
  if (launch) {
    check('a', "Riffet's system prompt replaces the CLI's", launch.system.includes("the owner's personal assistant") && launch.system.length < 8_000, { chars: launch.system.length });
    check('a', "the directory's AGENTS.md and USER.md are loaded", launch.messages.includes("这份文件是用户给你定的规则") && launch.messages.includes('# Owner'), { agents: launch.messages.includes("这份文件是用户给你定的规则"), user: launch.messages.includes('# Owner') });
    check('a', 'the time is told', /<riffet-context>\\nNow: \w+ \d{4}-\d\d-\d\d \d\d:\d\d \(/.test(launch.messages), launch.messages.match(/<riffet-context>[^<]{0,160}/)?.[0] ?? 'absent');
    // The CLI may defer MCP tools: then they are announced by name in the messages rather than listed as tools.
    const mcp = [...new Set([...launch.tools, ...(launch.messages.match(/mcp__[A-Za-z0-9-]+__[A-Za-z0-9_]+/g) ?? [])].filter(name => name.startsWith('mcp__')))];
    check('a', 'its tools are offered and no other MCP server', ['session_list', 'session_read', 'history_search', 'server_status', 'task_list'].every(tool => mcp.includes(`mcp__riffet__${tool}`)) && mcp.every(name => name.startsWith('mcp__riffet__')), mcp);
    const own = ownInstructionsLine();
    const unlisted = ['tasks', 'progress', 'reminders', 'briefing', 'phone', 'browser', 'riffet'].filter(name => !launch.messages.includes(`- riffet:${name}: `));
    check('a', "Riffet's skills are offered", unlisted.length === 0, unlisted.length ? { missing: unlisted } : 'all seven are listed');
    check('a', 'scheduled tasks are not among its tools', !launch.messages.includes('mcp__riffet__schedule_task') && !launch.tools.includes('mcp__riffet__schedule_task'), 'schedule_task was looked for');
    // The CLI's own skills are listed to the model as `- name: description`.
    const bundled = ['code-review', 'simplify', 'security-review', 'claude-api', 'plugin-authoring', 'init'].filter(name => launch.messages.includes(`- ${name}: `));
    check('a', "the CLI's own skills are not offered", bundled.length === 0, bundled.length ? bundled : 'none of the bundled skills is listed');
    check('a', "the user's own instructions are not loaded", !own || !launch.messages.includes(own.slice(0, 40)), own ? 'a line of the user CLAUDE.md was looked for' : 'the user has no CLAUDE.md to look for');
  }

  if (only.has('b')) {
  // b. memory
  const remember = await turn(sessionId, 'probe-2', 'Remember this for later conversations: my favourite tea is Longjing. Save it now, then reply "saved".');
  check('b', 'turn completed', remember.run?.state === 'completed', { state: remember.run?.state, error: remember.run?.error });
  const notes = [join(assistant.cwd, 'USER.md'), ...readdirSync(join(assistant.cwd, 'memory')).map(name => join(assistant.cwd, 'memory', name))];
  const holding = notes.filter(file => readFileSync(file, 'utf8').includes('Longjing'));
  check('b', 'written inside its directory', holding.length > 0, holding.map(file => file.slice(assistant.cwd.length + 1)));
  const committed = await until('the commit', 30, () => {
    try { return existsSync(join(assistant.cwd, '.git')) && execFileSync('git', ['log', '--oneline'], { cwd: assistant.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
  });
  check('b', 'the change is committed', Boolean(committed), committed ?? 'no commit');

  }
  if (only.has('c')) {
  // c. tools
  const version = await turn(sessionId, 'probe-3', 'Call server_status and reply with the server version only.');
  check('c', 'server_status was called', rpcLog.some(line => line.startsWith('tools/call') && line.includes('server_status') && line.includes('-> ok')), rpcLog.filter(line => line.includes('server_status')));
  check('c', 'the version is answered', (await lastAnswer(sessionId)).includes(SERVER_VERSION), { answer: await lastAnswer(sessionId), version: SERVER_VERSION, state: version.run?.state });

  }
  if (only.has('s')) {
  // s. a skill of Riffet's is loaded and followed
  const reminder = await turn(sessionId, 'probe-skill', '25 分钟后提醒我喝水。');
  check('s', 'the reminders skill was loaded', reminder.requests.some(request => /"skill":\s*"riffet:reminders"/.test(request.messages)), reminder.requests.length ? 'looked for a Skill call naming riffet:reminders' : 'no model request');
  check('s', 'a wake-up was scheduled', rpcLog.some(line => line.startsWith('tools/call') && line.includes('schedule_wakeup') && line.includes('-> ok')), rpcLog.filter(line => line.includes('wakeup')));
  check('s', 'the time is told back', /\d{1,2}[:：]\d{2}/.test(await lastAnswer(sessionId)), { answer: await lastAnswer(sessionId) });

  }
  // d. record
  const sum = await turn(sessionId, 'probe-4', 'What is 17 + 25? Reply with the number only.');
  check('d', 'turn completed', sum.run?.state === 'completed', { state: sum.run?.state, error: sum.run?.error });
  const rows = await shown(sessionId);
  check('d', 'messages are shown as typed', rows.some(row => row.kind === 'user' && row.text.trim() === 'What is 17 + 25? Reply with the number only.') && !rows.some(row => row.text.includes('riffet-context')), rows.filter(row => row.kind === 'user').map(row => row.text.slice(0, 60)));
  check('d', 'each message carried the time', sum.requests.some(request => (request.messages.match(/<riffet-context>/g) ?? []).length >= runs(sessionId).length), { contexts: sum.requests.map(request => (request.messages.match(/<riffet-context>/g) ?? []).length), messages: runs(sessionId).length });

  if (only.has('e')) {
  // e. summary
  const compact = await turn(sessionId, 'probe-5', '/compact');
  check('e', 'the summary finished', compact.run?.state === 'completed', { state: compact.run?.state, error: compact.run?.error });
  check('e', "the summary was given the directory's instructions", compact.requests.some(request => request.messages.includes('Compact Instructions')), { requests: compact.requests.length });
  const after = await turn(sessionId, 'probe-6', 'Reply with the single word: ready.');
  const told = after.requests.at(-1);
  check('e', 'the next request says the history was summarized', Boolean(told?.messages.includes('was just summarized')), told?.messages.match(/<riffet-context>[^<]*summarized[^<]*/)?.[0] ?? 'absent');
  check('e', 'the instructions are still loaded', Boolean(told?.messages.includes("这份文件是用户给你定的规则")), { state: after.run?.state });

  }
  if (only.has('f')) {
  // f. new CLI session
  const before = services.store.getSession(sessionId).nativeSessionId;
  // The CLI is stopped the way an idle one is reclaimed, and two quick exits are recorded: that is what makes the
  // driver give up on `--resume` and start a new CLI session at the next message (`launch-guard.ts`).
  await services.nativeBackends.dispose(sessionId);
  const terminalId = services.store.getSession(sessionId).terminalId;
  if (terminalId && services.store.getTerminal(terminalId).state !== 'exited') await services.terminal.stop(terminalId);
  services.store.updateSession(sessionId, { quickExitCount: 2 });
  const recall = await turn(sessionId, 'probe-7', 'Earlier I asked you to add two numbers. What was the result? Reply with the number only.');
  const now = services.store.getSession(sessionId);
  check('f', 'the CLI session was replaced', Boolean(before) && now.nativeSessionId !== before && (now.previousNativeSessionIds ?? []).includes(before!), { before, after: now.nativeSessionId });
  const carried = recall.requests.find(request => request.messages.includes('This CLI session is new'));
  check('f', 'the last turns were carried over', Boolean(carried?.messages.includes('17 + 25')), carried ? carried.messages.match(/This CLI session is new[^<]{0,400}/)?.[0] ?? '' : 'absent');
  check('f', 'a question about them is answered', recall.run?.state === 'completed' && (await lastAnswer(sessionId)).includes('42'), { state: recall.run?.state, answer: await lastAnswer(sessionId) });
  check('f', 'still the main conversation', services.store.getProject(assistant.id).mainSessionId === sessionId, { mainSessionId: services.store.getProject(assistant.id).mainSessionId });
  if (recall.run?.state !== 'completed') log(`f: run ${recall.run?.state} ${recall.run?.error ?? ''}; ${recall.requests.length} model requests; screen:\n${await screen(sessionId)}`);
  }
  if (only.has('h')) {
  // h. the owner's files
  const rules = readFileSync(join(assistant.cwd, 'AGENTS.md'), 'utf8');
  writeFileSync(join(assistant.cwd, 'stray.bin'), 'not a note');
  const edit = await turn(sessionId, 'probe-8', 'Two steps, with your file tools only, never a shell command. 1: use the Edit tool to add the line "PROBE-EDIT" at the end of AGENTS.md in your directory. 2: use the Write tool to create memory/probe.md containing "probe". Then reply with what happened at each step.');
  check('h', 'its rules were not edited', readFileSync(join(assistant.cwd, 'AGENTS.md'), 'utf8') === rules, { state: edit.run?.state, answer: (await lastAnswer(sessionId)).slice(0, 300) });
  check('h', 'its notes still are', existsSync(join(assistant.cwd, 'memory', 'probe.md')), readdirSync(join(assistant.cwd, 'memory')));
  const tracked = await until('the commit of the note', 30, () => {
    try { const files = execFileSync('git', ['ls-files'], { cwd: assistant.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n'); return files.includes('memory/probe.md') && files; } catch { return undefined; }
  });
  check('h', 'the note is committed and the stray file is not', Boolean(tracked) && !tracked!.includes('stray.bin'), tracked ?? 'not committed');
  }
  if (only.has('g')) {
  // g. sign-in kept in the CLI's own settings
  const configDir = join(dirs.root, 'claude-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  let key = '';
  await copyRiffetProfile((url, body) => {
    key = String(body.apiKey ?? '');
    const { apiEndpoint: _endpoint, apiKey: _key, modelSource: _source, ...rest } = body;
    return call('POST', url, { ...rest, id: 'probe-own', name: 'Probe (own settings)', configDir });
  }, 'claude', profileName);
  writeFileSync(join(configDir, 'key'), key, { mode: 0o600 });
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: proxyUrl }, apiKeyHelper: `cat '${join(configDir, 'key')}'`, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch '${join(configDir, 'own-hook-ran')}'` }] }] } }), { mode: 0o600 });
  // A config directory nobody has used asks its first-run questions before anything else.
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
  const mark = modelRequests.length;
  await call('POST', '/api/sessions', {
    kind: 'native', projectId: assistant.id, clientSessionId: 'probe-own', backendId: 'claude', backendProfileId: 'probe-own', model,
    approval: 'bypassPermissions', initialMessage: { commandId: 'probe-own-1', text: 'Reply with the single word: ready.' },
  });
  const own = await turnEnded('probe-own', 'probe-own-1');
  await sleep(1500);
  check('g', 'the model was reached through the settings file\'s endpoint and key', own?.state === 'completed' && modelRequests.length > mark, { state: own?.state, error: own?.error, requests: modelRequests.length - mark });
  check('g', "the file's other settings were not read", !existsSync(join(configDir, 'own-hook-ran')) && Boolean(modelRequests.at(-1)?.system.includes("the owner's personal assistant")), { ownHookRan: existsSync(join(configDir, 'own-hook-ran')) });
  check('g', 'a second conversation does not take the main one\'s place', services.store.getProject(assistant.id).mainSessionId === sessionId, { mainSessionId: services.store.getProject(assistant.id).mainSessionId });
  if (own?.state !== 'completed') log(`g: screen:\n${await screen('probe-own')}`);
  }
} catch (error) {
  check('probe', 'ran to the end', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  log(`Riffet MCP requests:\n  ${rpcLog.filter(line => line.startsWith('tools/call')).join('\n  ')}`);
  const failed = checks.filter(entry => !entry.ok);
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  // Archiving stops each conversation's CLI and terminal before the server goes.
  for (const session of services.store.listSessions()) await call('PATCH', `/api/sessions/${session.id}`, { archived: true }).catch(() => undefined);
  await services.app.close().catch(() => undefined);
  proxy.close();
  if (!keep) await dirs.remove().catch(() => undefined);
  else log(`kept ${dirs.root}`);
  process.exit(failed.length ? 1 : 0);
}
