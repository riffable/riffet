/**
 * Manual real-CLI probe of Agent calls (docs/AGENT-CALLS.md), driven through an in-process server on a temp state
 * dir. It never touches the running Riffet service or the user's profiles: the Claude profile is copied into the
 * temp state dir, and both the caller and the called Agent run on it.
 *
 *   node --import tsx scripts/probe-agent-calls-e2e.ts --profile <name> [--only a,b] [--keep] [--timeout 420] [--caller cursor --cursor-cli <cursor-cli.json> [--caller-approval <id>]]
 *
 * With `--caller cursor` the conversations that call run on Cursor (its settings copied from the given file), which
 * reaches Riffet's tools through a plugin directory of their own (`plugins/riffet/cursor/backend/riffet-tools.ts`).
 *
 * a. The owner @-mentions Claude and asks the conversation's Agent to have it find a bug: the Agent calls
 *    `agent_call`, a conversation of its own opens (`origin.kind: 'call'`, read-only consult permission), its
 *    answer comes back in the same tool call, and the project is left unchanged.
 * b. The Agent is told to call with `wait: 0` and end its turn: the answer arrives later as one message
 *    (`call-<run id>`) into the caller, which answers it.
 * c. The owner picked the provider and a model with its parameters on the mention: the called conversation runs on
 *    exactly that selection, whatever the Agent asks for.
 * d. Nothing picked: the Agent reads the provider's models, parameters and quota with `agent_list`, then calls with a
 *    model and params of its choosing, which the called conversation runs on.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogParams, catalogSelection, parseSelection, type AgentCall, type AgentMention, type NativeBackendCatalogEntry, type Run, type Session } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/server/src/app.js';
import { copyRiffetProfile, log, probeDirs, requireCli } from './probe-sync-e2e-lib.js';

for (const name of Object.keys(process.env)) {
  if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|RIFFET_CLAUDE_HOOK_.*|AI_AGENT|CODEX_.*)$/.test(name) && name !== 'CODEX_HOME') delete process.env[name];
}
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
const profileName = option('--profile', '');
if (!profileName) throw new Error('Pass --profile <name>: a Claude profile of your own Riffet to copy');
const only = new Set(option('--only', 'a,b,c,d').split(',').map(item => item.trim()));
const keep = args.includes('--keep');
const turnSeconds = Number(option('--timeout', '420'));
const callerBackend = option('--caller', 'claude');
const cursorSettings = option('--cursor-cli', '');
const callerApproval = option('--caller-approval', callerBackend === 'claude' ? 'bypassPermissions' : '');
requireCli('claude', 'Claude Code', 'Install Claude Code');
if (callerBackend === 'cursor' && !cursorSettings) throw new Error('Pass --cursor-cli <cursor-cli.json>: a Cursor that is not logged in waits at its login screen');

const dirs = await probeDirs('agent-calls');
if (cursorSettings) { await mkdir(dirs.stateDir, { recursive: true }); await copyFile(cursorSettings, join(dirs.stateDir, 'cursor-cli.json')); }
const git = (...rest: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...rest], { cwd: dirs.project, stdio: 'ignore' });
await mkdir(join(dirs.project, 'src'), { recursive: true });
const SOURCE = "export function slugify(text) {\n  return text.trim().toLowerCase().replace(' ', '-');\n}\n";
await writeFile(join(dirs.project, 'src/slug.js'), SOURCE);
git('init', '-q'); git('add', '.'); git('-c', 'user.email=probe@example.com', '-c', 'user.name=probe', 'commit', '-qm', 'init');

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

// Every request the shim forwards, with its outcome.
const rpcLog: string[] = [];
{
  const service = services.riffetMcp as unknown as { handle: (authorization: string | undefined, method: unknown, params: unknown, signal?: AbortSignal) => Promise<unknown> };
  const original = service.handle.bind(service);
  service.handle = async (authorization, method, params, signal) => {
    try {
      const result = await original(authorization, method, params, signal);
      if (method === 'tools/call') rpcLog.push(`${JSON.stringify(params ?? {}).slice(0, 300)} -> ${JSON.stringify(result).slice(0, 3000)}`);
      return result;
    } catch (error) { rpcLog.push(`${String(method)} ${JSON.stringify(params ?? {}).slice(0, 200)} -> ${error instanceof Error ? error.message : String(error)}`); throw error; }
  };
}
/** Thrown to end a scenario that stops where it means to (an approval nobody here gives). */
const STOPPED = new Error('stopped at the approval');
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
const called = (callerId: string) => services.store.listSessions().filter(item => item.origin?.kind === 'call' && item.origin.sessionId === callerId);
async function transcript(sessionId: string): Promise<string[]> {
  try {
    const page = await call<{ rows?: Array<Record<string, unknown>> }>('GET', `/api/v3/sessions/${sessionId}/timeline?lane=main&rows=300&from=0`);
    return (page.rows ?? []).flatMap(row => row.kind === 'assistant' ? [`assistant: ${String(row.text).slice(0, 300)}`]
      : row.kind === 'user' ? [`user: ${String(row.text).slice(0, 200)}`]
        : row.kind === 'tool' ? [`tool: ${JSON.stringify((row.event as { data?: unknown } | undefined)?.data ?? {}).slice(0, 200)}`] : []);
  } catch (error) { return [`timeline unavailable: ${error instanceof Error ? error.message : String(error)}`]; }
}

const project = await call<{ id: string }>('POST', '/api/projects', { cwd: dirs.project });
const claude = await copyRiffetProfile((url, body) => call('POST', url, body), 'claude', profileName);
const mention: AgentMention = { backendId: 'claude', backendProfileId: claude.backendProfileId };

async function open(id: string, text: string, agents: AgentMention[] = [mention]): Promise<Session> {
  const created = await call<{ session: Session }>('POST', '/api/sessions', {
    kind: 'native', projectId: project.id, clientSessionId: id,
    ...(callerBackend === 'claude' ? { backendId: 'claude', backendProfileId: claude.backendProfileId, ...(claude.model ? { model: claude.model } : {}) } : { backendId: callerBackend }),
    ...(callerApproval ? { approval: callerApproval } : {}), initialMessage: { commandId: `${id}-1`, text, agents },
  });
  return created.session;
}

try {
  if (only.has('a')) {
    const caller = await open('probe-a', '请用 agent_call 让我提到的这个 Agent 读 src/slug.js，找出 slugify 的 bug（不要让它改文件），等它回答后用一句话把它的结论告诉我。你自己不要读这个文件。');
    if (callerApproval === 'allowlist') {
      // Cursor asks before each MCP tool unless the owner allowlisted it: the conversation waits on the owner.
      const waiting = await until('the approval', 120, () => services.store.getSession(caller.id).state === 'waiting' ? services.store.getSession(caller.id) : undefined);
      const terminalId = services.store.getSession(caller.id).terminalId;
      const screen = (terminalId ? await services.terminal.screen(terminalId).catch(() => '') : '') ?? '';
      check('a', 'the tool call waits on the owner\'s approval', Boolean(waiting) && /agent_/.test(screen), screen.split('\n').filter(line => line.trim()).slice(-14).join('\n'));
      throw STOPPED;
    }
    const first = await turnEnded(caller.id, 'probe-a-1');
    check('a', 'caller turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
    check('a', 'the caller used agent_call', rpcLog.some(line => line.includes('"agent_call"')), rpcLog);
    const [callee] = called(caller.id);
    check('a', 'a called conversation opened', Boolean(callee), called(caller.id).map(item => ({ id: item.id, origin: item.origin })));
    if (callee) {
      check('a', 'it runs read-only (consult permission)', callee.approval === 'dontAsk' && callee.projectId === caller.projectId, { approval: callee.approval, projectId: callee.projectId });
      check('a', 'its turn completed', runs(callee.id)[0]?.state === 'completed', runs(callee.id).map(run => `${run.commandId}:${run.state}`));
      const calls = await call<{ calls: AgentCall[] }>('GET', `/api/sessions/${caller.id}/calls`);
      check('a', 'the caller lists the call', calls.calls.length === 1 && calls.calls[0]!.id === callee.id && calls.calls[0]!.state === 'completed', calls.calls);
      log(`a callee transcript:\n  ${(await transcript(callee.id)).join('\n  ')}`);
    }
    check('a', 'the project is unchanged', await readFile(join(dirs.project, 'src/slug.js'), 'utf8') === SOURCE, await readFile(join(dirs.project, 'src/slug.js'), 'utf8'));
    const answer = (await transcript(caller.id)).filter(line => line.startsWith('assistant:')).at(-1) ?? '';
    check('a', 'the caller relays the finding', /空格|replace|第一个|all|全部/i.test(answer), answer);
    log(`a caller transcript:\n  ${(await transcript(caller.id)).join('\n  ')}`);
  }

  if (only.has('w') && callerBackend === 'cursor') {
    // A warm CLI holds a provisional credential; the conversation that takes it adopts it, so its tools act for it.
    let state = '';
    for (let i = 0; i < 90 && state !== 'ready'; i++) {
      state = (await call<{ state: string }>('POST', '/api/native/prewarm', { projectId: project.id, backendId: 'cursor', ...(callerApproval ? { approval: callerApproval } : {}) })).state;
      if (state !== 'ready') await sleep(1000);
    }
    check('w', 'a warm Cursor CLI got ready', state === 'ready', state);
    const caller = await open('probe-w', '请用 agent_call 让我提到的这个 Agent 用一句话说明 src/slug.js 里 slugify 做什么，等它回答后转述给我。');
    const first = await turnEnded(caller.id, 'probe-w-1');
    check('w', 'caller turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
    const terminalId = services.store.getSession(caller.id).terminalId;
    const terminal = terminalId ? await services.terminal.get(terminalId).catch(() => undefined) as { title?: string } | undefined : undefined;
    check('w', 'it took the warm CLI', /warmup/i.test(terminal?.title ?? ''), terminal?.title);
    check('w', 'its Riffet tools act for it', called(caller.id).length === 1 && runs(called(caller.id)[0]!.id)[0]?.state === 'completed', rpcLog.filter(line => line.includes('agent_call')).map(line => line.slice(0, 300)));
  }

  if (only.has('b')) {
    const caller = await open('probe-b', '请用 agent_call 让我提到的这个 Agent 读 src/slug.js 并说明 slugify 做什么，调用时传 wait: 0。调用返回后不要等它，也不要调用 agent_wait，直接结束这一轮，只回复「已交给它」。等它的回答送来后，再用一句话转述给我。');
    const first = await turnEnded(caller.id, 'probe-b-1');
    check('b', 'caller turn completed without waiting', first?.state === 'completed', { state: first?.state, error: first?.error });
    const callee = await until('the called conversation', 30, () => called(caller.id)[0]);
    check('b', 'a called conversation opened', Boolean(callee), called(caller.id).map(item => item.id));
    const calleeRun = callee ? await until('the called turn', turnSeconds, () => runs(callee.id).find(settled)) : undefined;
    check('b', 'the called turn ended', calleeRun?.state === 'completed', calleeRun && { state: calleeRun.state, error: calleeRun.error });
    const delivered = calleeRun ? await until('the answer message', 60, () => runs(caller.id).find(run => run.commandId === `call-${calleeRun.id}`)) : undefined;
    check('b', 'the answer arrived as one message', Boolean(delivered) && runs(caller.id).filter(run => run.commandId.startsWith('call-')).length === 1, runs(caller.id).map(run => `${run.commandId}:${run.state}`));
    if (delivered) {
      check('b', 'it is framed as another Agent\'s answer', delivered.prompt.startsWith('[Riffet 调用结果]'), delivered.prompt.slice(0, 200));
      const answered = await turnEnded(caller.id, delivered.commandId);
      check('b', 'the caller answered it', answered?.state === 'completed', { state: answered?.state, error: answered?.error });
    }
    await sleep(3000);
    check('b', 'nothing was sent twice', runs(caller.id).filter(run => run.commandId.startsWith('call-')).length === 1, runs(caller.id).map(run => run.commandId));
    log(`b caller transcript:\n  ${(await transcript(caller.id)).join('\n  ')}`);
  }
  // What the model menu offers this provider; c pins a model whose effort is off its default, d checks the Agent's pick against it.
  const catalog = await call<NativeBackendCatalogEntry>('GET', `/api/backends/claude/catalog?projectId=${project.id}&profileId=${claude.backendProfileId}`);
  const withEffort = catalog.models.find(model => catalogParams(catalog.models, model.value, {}).some(param => param.id === 'effort' || param.category === 'thought_level'));
  log(`catalog: ${catalog.models.length} models, ${withEffort ? `${withEffort.value} has an effort` : 'none has an effort'}`);

  if (only.has('c')) {
    const hasEffort = (value: string) => catalogParams(catalog.models, value, {}).some(param => param.id === 'effort' || param.category === 'thought_level');
    // The profile's own model is the one known to answer through this gateway.
    const base = catalog.models.find(model => model.value === claude.model && hasEffort(model.value)) ?? catalog.models.find(model => model.value === claude.model) ?? withEffort ?? catalog.models[0];
    const effort = base && catalogParams(catalog.models, base.value, {}).find(param => param.id === 'effort' || param.category === 'thought_level');
    const other = effort?.options.find(item => item.value !== effort.value && item.value !== 'default')?.value;
    const pin = base ? catalogSelection(catalog.models, base.value, effort && other ? { [effort.id]: other } : {}) : undefined;
    log(`c pins ${pin ?? '(no model)'}`);
    const caller = await open('probe-c', '请用 agent_call 让我提到的这个 Agent 用一句话说明 src/slug.js 里 slugify 做什么，调用时传 model: "nonexistent-model" 和 params: {"effort": "max"}。等它回答后把它的回答和调用结果里的 model 告诉我。', [{ ...mention, ...(pin ? { model: pin } : {}) }]);
    const first = await turnEnded(caller.id, 'probe-c-1');
    check('c', 'caller turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
    const [callee] = called(caller.id);
    check('c', 'a called conversation opened', Boolean(callee), rpcLog);
    if (callee) {
      check('c', 'it runs on the picked provider and selection', callee.backendProfileId === claude.backendProfileId && (!pin || callee.model === pin), { profile: callee.backendProfileId, model: callee.model, pin });
      check('c', 'its turn completed', runs(callee.id)[0]?.state === 'completed', runs(callee.id).map(run => `${run.commandId}:${run.state}`));
      check('c', 'the caller was told its choice was not used', rpcLog.some(line => line.includes('not used')), rpcLog.filter(line => line.includes('agent_call')));
    }
  }

  if (only.has('d')) {
    const caller = await open('probe-d', '先用 agent_list（传 agent）看我提到的这个 Agent 有哪些模型、每个模型的参数和账户额度，然后自己选一个模型调用它：问它 src/slug.js 里 slugify 做什么。如果你选的模型有 effort 参数，把 effort 设成它的可选值里最低的一档。等它回答后，告诉我你选了哪个模型和参数、额度情况，以及它的回答。');
    const first = await turnEnded(caller.id, 'probe-d-1');
    check('d', 'caller turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
    check('d', 'it read the provider\'s models, parameters and quota', rpcLog.some(line => line.includes('"agent_list"') && line.includes('\\"params\\"')), rpcLog.filter(line => line.includes('agent_list')).map(line => line.slice(0, 600)));
    const [callee] = called(caller.id);
    check('d', 'a called conversation opened', Boolean(callee), rpcLog.filter(line => line.includes('agent_call')));
    if (callee) {
      const picked = parseSelection(callee.model);
      const effort = catalogParams(catalog.models, picked.model, picked.params).find(param => param.id === 'effort' || param.category === 'thought_level');
      check('d', 'it runs on a model of the catalog', !catalog.models.length || catalog.models.some(model => model.value === picked.model), { model: callee.model });
      if (effort) check('d', 'with the lowest effort, as asked', effort.value === effort.options.find(item => item.value !== 'default')?.value, { model: callee.model, options: effort.options.map(item => item.value) });
      check('d', 'its turn completed', runs(callee.id)[0]?.state === 'completed', runs(callee.id).map(run => `${run.commandId}:${run.state}`));
    }
    log(`d caller transcript:\n  ${(await transcript(caller.id)).join('\n  ')}`);
  }
} catch (error) {
  if (error !== STOPPED) check('probe', 'ran to the end', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  log(`Riffet MCP tool calls:\n  ${rpcLog.join('\n  ')}`);
  const failed = checks.filter(entry => !entry.ok);
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  // Archiving stops each conversation's CLI and terminal before the server goes.
  for (const session of services.store.listSessions()) await call('PATCH', `/api/sessions/${session.id}`, { archived: true }).catch(() => undefined);
  await services.app.close().catch(() => undefined);
  if (!keep) await dirs.remove().catch(() => undefined);
  else log(`kept ${dirs.root}`);
  process.exit(failed.length ? 1 : 0);
}
