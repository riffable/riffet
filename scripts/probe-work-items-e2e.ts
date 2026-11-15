/**
 * Manual real-CLI probe of the task loop (docs/TASK-BOARD.md §4–§7), driven through an in-process server
 * on a temp state dir. It never touches the running Riffet service or the user's profiles: the Claude
 * profile is copied read-only into the temp state dir.
 *
 *   node --import tsx scripts/probe-work-items-e2e.ts --profile <name> [--model <id>] [--only a,b] [--keep]
 *
 * a. A task with criteria, started the way the board starts it (the server's brief as the first message):
 *    the agent fixes a bug, runs the test, calls `task_submit`; the task goes to review with the edited file
 *    and the passing command as evidence. A rework note reaches the same conversation once and comes back
 *    as a second submission whose evidence covers only the new round.
 * b. A task whose description leaves a choice to the owner: the agent calls `task_ask` and stops; the
 *    answer reaches the same conversation once, and the agent finishes and submits.
 * c. A conversation opened from the composer, which gets its task card on its own: the agent does what it
 *    was asked and does not submit, so the task stays in progress rather than coming back for review.
 * Then the north-star report counts the question and the submissions.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NorthStarReport, Run, Session, WorkItem, WorkItemEvent } from '../packages/contracts/src/index.js';
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
const only = new Set(option('--only', 'a,b,c').split(',').map(item => item.trim()));
const keep = args.includes('--keep');
const turnSeconds = Number(option('--timeout', '420'));
requireCli('claude', 'Claude Code', 'Install Claude Code');

const dirs = await probeDirs('work-items');
const git = (...rest: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...rest], { cwd: dirs.project, stdio: 'ignore' });
await mkdir(join(dirs.project, 'src'), { recursive: true });
await writeFile(join(dirs.project, 'package.json'), '{ "name": "probe", "type": "module", "private": true }\n');
await writeFile(join(dirs.project, 'src/slug.js'), "export function slugify(text) {\n  return text.trim().toLowerCase().replace(' ', '-');\n}\n");
await writeFile(join(dirs.project, 'test.js'), [
  "import assert from 'node:assert/strict';",
  "import { slugify } from './src/slug.js';",
  "assert.equal(slugify('Hello World'), 'hello-world');",
  "assert.equal(slugify('Make It Work Now'), 'make-it-work-now');",
  "console.log('ok');", '',
].join('\n'));
await writeFile(join(dirs.project, 'src/greet.js'), "export const greeting = 'Hello';\n");
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
/** Tool names each conversation was offered, from the `tools/list` answers. */
const offered: string[][] = [];
{
  const service = services.riffetMcp as unknown as { handle: (authorization: string | undefined, method: unknown, params: unknown, signal?: AbortSignal) => Promise<unknown> };
  const original = service.handle.bind(service);
  service.handle = async (authorization, method, params, signal) => {
    try {
      const result = await original(authorization, method, params, signal);
      if (method === 'tools/list') offered.push(((result as { tools?: Array<{ name: string }> }).tools ?? []).map(tool => tool.name));
      rpcLog.push(`${String(method)} ${JSON.stringify(params ?? {}).slice(0, 160)} -> ok ${JSON.stringify(result).slice(0, 160)}`); return result; }
    catch (error) { rpcLog.push(`${String(method)} ${JSON.stringify(params ?? {}).slice(0, 160)} -> ${error instanceof Error ? error.message : String(error)}`); throw error; }
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
/** The turn [commandId] started, once it has ended. */
const turnEnded = (sessionId: string, commandId: string, seconds = turnSeconds) =>
  until(`turn ${commandId}`, seconds, () => runs(sessionId).find(run => run.commandId === commandId && settled(run)));
const item = (id: string) => services.workItems.get(id) as WorkItem;
const events = (id: string) => call<WorkItemEvent[]>('GET', `/api/work-items/${id}/events`);
async function transcript(sessionId: string): Promise<string[]> {
  try {
    const page = await call<{ rows?: Array<{ block?: Record<string, unknown> } & Record<string, unknown>> }>('GET', `/api/v3/sessions/${sessionId}/timeline?lane=main&rows=300&from=0`);
    return (page.rows ?? []).flatMap(row => {
      const block = (row.block ?? row) as Record<string, unknown>;
      if (block.kind === 'assistant') return [`assistant: ${String(block.text).slice(0, 240)}`];
      if (block.kind === 'tool') return [`tool: ${JSON.stringify(block.activity ?? block.job ?? block).slice(0, 240)}`];
      if (block.kind === 'user') return [`user: ${String(block.text).slice(0, 160)}`];
      return [];
    });
  } catch (error) { return [`timeline unavailable: ${error instanceof Error ? error.message : String(error)}`]; }
}

const project = await call<{ id: string }>('POST', '/api/projects', { cwd: dirs.project });
const claude = await copyRiffetProfile((url, body) => call('POST', url, body), 'claude', profileName);
const model = modelOverride || claude.model;

/** Starts [task] the way the board does: the server's brief is the first message of a new conversation that belongs to it. */
async function start(task: WorkItem, id: string): Promise<Session> {
  const { text } = await call<{ text: string }>('GET', `/api/work-items/${task.id}/brief`);
  log(`brief for #${task.number}:\n${text.split('\n').map(line => `    ${line}`).join('\n')}`);
  const created = await call<{ session: Session }>('POST', '/api/sessions', {
    kind: 'native', projectId: project.id, clientSessionId: id, backendId: 'claude', backendProfileId: claude.backendProfileId, model,
    approval: 'bypassPermissions', workItemId: task.id, initialMessage: { commandId: `${id}-1`, text },
  });
  return created.session;
}

try {
  if (only.has('a')) {
    const task = await call<WorkItem>('POST', '/api/work-items', {
      title: 'slugify 只替换了第一个空格',
      description: '`src/slug.js` 的 `slugify` 应把所有空格都换成连字符，现在只换第一个。',
      criteria: ['`node test.js` 通过', '不改 test.js'],
      assignee: { kind: 'agent', backendId: 'claude' }, projectId: project.id,
    });
    const session = await start(task, 'probe-a');
    check('a', 'conversation belongs to the task', services.store.getSession(session.id).workItemId === task.id, { workItemId: services.store.getSession(session.id).workItemId });
    const first = await turnEnded(session.id, 'probe-a-1');
    check('a', 'first turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
    check('a', 'the CLI was offered task_submit and task_ask', offered.some(names => names.includes('task_submit') && names.includes('task_ask')), offered);
    const submitted = item(task.id);
    check('a', 'task went to review', submitted.status === 'review', { status: submitted.status });
    check('a', 'submission from this conversation, criteria answered', submitted.submission?.sessionId === session.id && submitted.submission.criteria.length === 2 && submitted.submission.criteria.every(entry => typeof entry.met === 'boolean'), submitted.submission);
    check('a', 'evidence: the edited file', JSON.stringify(submitted.submission?.evidence.files) === '["src/slug.js"]', submitted.submission?.evidence.files);
    const test = submitted.submission?.evidence.commands.filter(entry => entry.command.includes('test.js'));
    check('a', 'evidence: the test command, last run passing', Boolean(test?.length) && test!.at(-1)!.result === 'ok', submitted.submission?.evidence.commands);
    check('a', 'the fix is real', /replace(All)?\(/.test(await readFile(join(dirs.project, 'src/slug.js'), 'utf8')) && (() => { try { execFileSync('node', ['test.js'], { cwd: dirs.project, stdio: 'ignore' }); return true; } catch { return false; } })(), await readFile(join(dirs.project, 'src/slug.js'), 'utf8'));

    if (submitted.status === 'review') {
      const before = runs(session.id).length;
      const rework = { text: '再加一个用例：连续多个空格只变成一个连字符（"a  b" → "a-b"），可以改 test.js，并让它通过。', commandId: 'probe-a-rework' };
      await call('POST', `/api/work-items/${task.id}/rework`, rework);
      await call('POST', `/api/work-items/${task.id}/rework`, rework);
      check('a', 'rework moved the task back to doing', item(task.id).status === 'doing', { status: item(task.id).status });
      check('a', 'rework sent once to the same conversation', runs(session.id).length === before + 1 && runs(session.id).at(-1)!.commandId === 'probe-a-rework', runs(session.id).map(run => `${run.commandId}:${run.state}`));
      const second = await turnEnded(session.id, 'probe-a-rework');
      check('a', 'rework turn completed', second?.state === 'completed', { state: second?.state, error: second?.error });
      const again = item(task.id);
      const kinds = (await events(task.id)).map(event => event.kind);
      check('a', 'second submission after the rework', again.status === 'review' && kinds.filter(kind => kind === 'submit').length === 2, { status: again.status, kinds });
      check('a', 'second evidence covers only the new round', Boolean(again.submission?.evidence.files.includes('test.js')), again.submission?.evidence);
      const brief = await call<{ text: string }>('GET', `/api/work-items/${task.id}/brief`);
      check('a', 'the brief now carries the previous submissions', brief.text.includes(again.submission?.summary.slice(0, 20) ?? '\u0000'), brief.text.slice(0, 600));
    }
    log(`a transcript:\n  ${(await transcript(session.id)).join('\n  ')}`);
  }

  if (only.has('b')) {
    const task = await call<WorkItem>('POST', '/api/work-items', {
      title: '换欢迎语',
      description: '`src/greet.js` 里的欢迎语要换成 "Hi" 或 "Welcome back" 之一，用哪个由我决定。不要自己挑，先问我。',
      criteria: ['greeting 换成我选的那个'],
      assignee: { kind: 'agent', backendId: 'claude' }, projectId: project.id,
    });
    const session = await start(task, 'probe-b');
    const first = await turnEnded(session.id, 'probe-b-1');
    check('b', 'first turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
    const asked = item(task.id);
    const question = asked.questions?.[0];
    check('b', 'the agent asked through task_ask', Boolean(question) && question!.sessionId === session.id, asked.questions);
    check('b', 'it stopped without choosing', (await readFile(join(dirs.project, 'src/greet.js'), 'utf8')).includes("'Hello'"), await readFile(join(dirs.project, 'src/greet.js'), 'utf8'));
    const report = await call<NorthStarReport>('GET', `/api/work-items/north-star?tz=UTC`);
    check('b', 'north star counts the question', report.days.reduce((sum, day) => sum + day.questions, 0) >= 1, report.days.at(-1));
    if (question) {
      const before = runs(session.id).length;
      const answer = { text: 'Welcome back', commandId: question.id };
      await call('POST', `/api/work-items/${task.id}/questions/${question.id}/answer`, answer);
      await call('POST', `/api/work-items/${task.id}/questions/${question.id}/answer`, answer);
      check('b', 'answer sent once to the conversation that asked', runs(session.id).length === before + 1, runs(session.id).map(run => `${run.commandId}:${run.state}`));
      check('b', 'the question is cleared', !item(task.id).questions?.length, item(task.id).questions);
      const answered = runs(session.id).at(-1)!;
      const done = await turnEnded(session.id, answered.commandId);
      check('b', 'answer turn completed', done?.state === 'completed', { state: done?.state, error: done?.error });
      check('b', 'the chosen greeting is in place', (await readFile(join(dirs.project, 'src/greet.js'), 'utf8')).includes('Welcome back'), await readFile(join(dirs.project, 'src/greet.js'), 'utf8'));
      check('b', 'submitted for review', item(task.id).status === 'review' && item(task.id).submission?.evidence.files.includes('src/greet.js') === true, { status: item(task.id).status, evidence: item(task.id).submission?.evidence });
    }
    log(`b transcript:\n  ${(await transcript(session.id)).join('\n  ')}`);
  }

  if (only.has('c')) {
    await call('PATCH', '/api/settings', { workItemCards: true });
    const created = await call<{ session: Session }>('POST', '/api/sessions', {
      kind: 'native', projectId: project.id, clientSessionId: 'probe-c', backendId: 'claude', backendProfileId: claude.backendProfileId, model,
      approval: 'bypassPermissions', initialMessage: { commandId: 'probe-c-1', text: '把 src/greet.js 里的 greeting 改成 \'Hey\'' },
    });
    const taskId = services.store.getSession(created.session.id).workItemId;
    check('c', 'the composer conversation got its task card', Boolean(taskId), { workItemId: taskId });
    const first = await turnEnded(created.session.id, 'probe-c-1');
    check('c', 'turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
    check('c', 'the change was made', (await readFile(join(dirs.project, 'src/greet.js'), 'utf8')).includes('Hey'), await readFile(join(dirs.project, 'src/greet.js'), 'utf8'));
    if (taskId) check('c', 'not submitted on its own: the task stays in progress', item(taskId).status === 'doing' && !item(taskId).submission, { status: item(taskId).status, submitted: Boolean(item(taskId).submission) });
    log(`c transcript:\n  ${(await transcript(created.session.id)).join('\n  ')}`);
  }

  const report = await call<NorthStarReport>('GET', '/api/work-items/north-star?tz=UTC');
  const total = report.days.reduce((sum, day) => ({ decisions: sum.decisions + day.decisions, questions: sum.questions + day.questions, reviews: sum.reviews + day.reviews, waitMs: sum.waitMs + day.waitMs }), { decisions: 0, questions: 0, reviews: 0, waitMs: 0 });
  check('north-star', 'reviews counted', total.reviews >= (only.has('a') ? 2 : 0) + (only.has('b') ? 1 : 0), total);
} catch (error) {
  check('probe', 'ran to the end', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  log(`Riffet MCP requests:\n  ${rpcLog.join('\n  ')}`);
  const failed = checks.filter(entry => !entry.ok);
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  // Archiving stops each conversation's CLI and terminal before the server goes.
  for (const session of services.store.listSessions()) await call('PATCH', `/api/sessions/${session.id}`, { archived: true }).catch(() => undefined);
  await services.app.close().catch(() => undefined);
  if (!keep) await dirs.remove().catch(() => undefined);
  else log(`kept ${dirs.root}`);
  process.exit(failed.length ? 1 : 0);
}
