/**
 * Manual real-CLI probe of the 个人助理's main conversation on Codex, through an in-process server on a temp state dir.
 *
 *   node --import tsx scripts/probe-codex-assistant.ts [--profile <name>] [--model <id>] [--timeout <seconds>] [--keep]
 *
 * Without `--profile` the CLI's own configuration is used, which is what the isolation is checked against.
 *
 * Isolation (docs/ASSISTANT.md §4), read from what the model was sent (the thread's rollout): the 助理's system prompt
 * instead of Codex's; its rules, profile and memory index as developer instructions, the directory's `AGENTS.md` not
 * read again as a project file; Riffet's skills and no other; none of the owner's MCP servers, plugins or apps; the
 * time ahead of each message, which the timeline leaves out.
 *
 * The rest of §4.1: the directory's `.mcp.json` server is declared in the thread; its `AGENTS.md` is read-only in the
 * thread's permission profile, and an edit to it is refused; a background run (`dontAsk`) runs without asking.
 *
 * A new topic (§5.5): `/new` is offered and ends without a turn; the conversation follows a new thread and keeps the
 * old one; the next turn does not know the previous topic; the timeline shows every message once, `/new` between the
 * topics; after a restart, and after the journal is read again from scratch, it still does, and so does a share.
 */
import type { Run, Session } from '../packages/contracts/src/index.js';
import type { TranscriptIngest } from '../apps/server/src/sync/ingest.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findCodexRollout } from '../apps/server/src/backends/codex/rollout-usage.js';
import { bootServer, copyRiffetProfile, finish, log, probeArgs, probeDirs, requireCli, sendAndWait, waitIdle, type Check, type ProbeServer } from './probe-sync-e2e-lib.js';

const args = probeArgs();
requireCli(process.env.CODEX_CLI?.trim() || 'codex', 'Codex', 'Install the Codex CLI and sign in, or set CODEX_CLI.');
const dirs = await probeDirs('codex-assistant');
let server = await bootServer(dirs.stateDir);
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, detail }); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail ?? '').slice(0, 400)}`); };
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const sessionId = 'probe-codex-assistant';

async function ended(runId: string, seconds: number): Promise<Run> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const run = server.services.store.getRun(runId);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state) || Date.now() > deadline) return run;
    await sleep(500);
  }
}
interface Shown { kind: string; text: string }
async function shown(on: ProbeServer): Promise<Shown[]> {
  const page = await on.call<{ rows?: Array<{ block?: Record<string, unknown> } & Record<string, unknown>> }>('GET', `/api/v3/sessions/${sessionId}/timeline?lane=main&rows=300&from=0`);
  return (page.rows ?? []).flatMap(row => {
    const block = (row.block ?? row) as Record<string, unknown>;
    return block.kind === 'assistant' || block.kind === 'user' ? [{ kind: String(block.kind), text: String(block.text ?? '').trim() }] : [];
  });
}
/** The timeline once it holds [expected] user rows, or as it is when it does not in time. */
async function settledTimeline(on: ProbeServer, expected: number): Promise<Shown[]> {
  let rows: Shown[] = [];
  for (let tries = 0; tries < 30; tries += 1) {
    rows = await shown(on);
    if (rows.filter(row => row.kind === 'user').length >= expected) return rows;
    await sleep(1000);
  }
  return rows;
}

/** What a thread's model requests carried: the base prompt, the developer and user messages, the last turn's settings. */
async function sent(threadId: string): Promise<{ base: string; developer: string[]; user: string[]; turn: Record<string, unknown> }> {
  const file = await findCodexRollout(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), threadId);
  if (!file) throw new Error(`no rollout for ${threadId}`);
  const out = { base: '', developer: [] as string[], user: [] as string[], turn: {} as Record<string, unknown> };
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as { type: string; payload: Record<string, unknown> };
    if (row.type === 'session_meta') out.base = String((row.payload.base_instructions as { text?: string } | undefined)?.text ?? '');
    if (row.type === 'turn_context') out.turn = row.payload;
    if (row.type !== 'response_item' || row.payload.type !== 'message') continue;
    const text = ((row.payload.content ?? []) as Array<{ text?: string }>).map(part => part.text ?? '').join('');
    if (row.payload.role === 'developer') out.developer.push(text); else if (row.payload.role === 'user') out.user.push(text);
  }
  return out;
}

/** The skill names of a request's catalog. */
function catalogSkills(developer: string[]): string[] {
  const catalog = developer.find(text => text.includes('<skills_instructions>')) ?? '';
  const available = catalog.slice(catalog.indexOf('### Available skills'), catalog.indexOf('</skills_instructions>'));
  return [...available.matchAll(/^- ([^:\s]+(?::[^:\s]+)?): /gm)].map(match => match[1]!);
}

const FIRST = 'Isolated integration test. Do not use tools. Remember the code word PLUM. Reply only OK.';
const THIRD = 'Do not use tools. What code word did I give you earlier? If you do not know of one, reply only UNKNOWN.';
const PROTECTED = 'Integration test. Using apply_patch, append the line "probe" to the file AGENTS.md in the current directory. Do not use the shell. Then reply only DONE, or BLOCKED if it was refused.';
/** A stdio MCP server with one tool, enough for the CLI to list it. */
const MCP_SERVER = `let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);if(m.id===undefined)continue;
const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'probe',version:'0'}}:m.method==='tools/list'?{tools:[{name:'probe_ping',description:'Answers pong.',inputSchema:{type:'object',properties:{}}}]}:m.method==='tools/call'?{content:[{type:'text',text:'pong'}]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`;
const typedOrder = (rows: Shown[]) => rows.filter(row => row.kind === 'user').map(row => row.text);
const inOrder = (rows: Shown[], typed = [FIRST, '/new', THIRD, PROTECTED]) => JSON.stringify(typedOrder(rows)) === JSON.stringify(typed);

try {
  const prepared: { backendProfileId?: string; model?: string } = args.profile ? await copyRiffetProfile((url, body) => server.call('POST', url, body), 'codex', args.profile) : {};
  const model = args.model ?? prepared.model;
  const assistant = server.services.store.listProjects().find(project => project.system === 'assistant');
  if (!assistant) throw new Error('the server made no 助理 project');
  const script = join(dirs.root, 'probe-mcp.cjs');
  writeFileSync(script, MCP_SERVER);
  writeFileSync(join(assistant.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { probe_mcp: { command: process.execPath, args: [script] } } }));
  const rulesFile = join(assistant.cwd, 'AGENTS.md');
  const rulesText = readFileSync(rulesFile, 'utf8');
  const created = await server.call<{ session: Session; run: Run }>('POST', '/api/sessions', {
    kind: 'native', projectId: assistant.id, clientSessionId: sessionId, backendId: 'codex',
    ...(prepared.backendProfileId ? { backendProfileId: prepared.backendProfileId } : {}), ...(model ? { model } : {}),
    initialMessage: { commandId: 'probe-1', text: FIRST },
  });
  check('the conversation is the main one', server.services.store.getProject(assistant.id).mainSessionId === sessionId);
  const first = await ended(created.run.id, args.timeoutSeconds);
  check('the first turn completed', first.state === 'completed', { state: first.state, error: first.error });
  await waitIdle(server, sessionId);
  const before = server.services.store.getSession(sessionId);

  const request = await sent(before.nativeSessionId!);
  check('the 助理\'s system prompt replaces Codex\'s', request.base.startsWith('You are the owner\'s personal assistant'), request.base.slice(0, 80));
  const rules = request.developer.find(text => text.includes('# AGENTS.md')) ?? '';
  check('its rules, profile and memory index are developer instructions', rules.includes('# USER.md') && rules.includes('# memory/MEMORY.md'), rules.slice(0, 200));
  const project = request.user.filter(text => text.startsWith('# AGENTS.md instructions for'));
  check('the directory\'s AGENTS.md is not read again as a project file', project.length === 0, project.map(text => text.slice(0, 80)));
  const skills = catalogSkills(request.developer);
  check('Riffet\'s skills and no other', skills.includes('riffet:tasks') && skills.every(name => name.startsWith('riffet:')), skills);
  const tools = request.developer.find(text => text.startsWith('<tools>')) ?? '';
  // What the live thread connected to, as the extensions page's runtime view reads it.
  const live = await server.call<{ entries: Array<{ sessionId: string; kind: string; name: string; enabled?: boolean; tools?: string[] }> }>('GET', `/api/backends/codex/extensions/runtime?projectId=${assistant.id}`);
  // The owner's are listed too, switched off.
  const servers = live.entries.filter(entry => entry.sessionId === sessionId && entry.kind === 'mcp' && entry.enabled !== false);
  check('the directory\'s .mcp.json server is the thread\'s', servers.some(entry => entry.name === 'probe_mcp' && entry.tools?.some(tool => tool.includes('probe_ping'))), servers.map(entry => entry.name));
  check('none of the owner\'s MCP servers', servers.every(entry => ['probe_mcp', 'riffet'].includes(entry.name)), servers.map(entry => entry.name));
  const files = JSON.stringify(request.turn.permission_profile ?? '');
  check('its AGENTS.md is read-only in the thread\'s profile', files.includes(rulesFile) && /"access":\s*"read"/.test(files), files.slice(0, 300));
  check('none of the owner\'s MCP servers, plugins or apps', !/codex_apps|node_repl|computer.use/.test(tools) && !request.developer.some(text => text.includes('<recommended_plugins>')), tools.slice(0, 300));
  const message = request.user.find(text => text.includes(FIRST)) ?? '';
  check('the time rides ahead of the message', /^<riffet-context>\nNow: /.test(message), message.slice(0, 120));
  const typed = (await settledTimeline(server, 1)).filter(row => row.kind === 'user').map(row => row.text);
  check('the timeline shows the message as typed', JSON.stringify(typed) === JSON.stringify([FIRST]), typed);

  const slash = await server.call<{ items: Array<{ name: string }> }>('GET', `/api/backends/codex/slash?projectId=${assistant.id}&sessionId=${sessionId}`);
  check('/new is offered', slash.items.some(item => item.name === 'new'));

  const topic = await sendAndWait(server, sessionId, '/new', 60);
  // Its row is a turn of its own in the journal (`transcript-source.ts`), not a model turn.
  const topicTurn = server.services.store.getRun(topic.id).native?.nativeTurnId;
  check('/new completed without a model turn', topic.state === 'completed' && (!topicTurn || topicTurn.endsWith(':topic')), { state: topic.state, error: topic.error, turn: topicTurn });
  const after = server.services.store.getSession(sessionId);
  check('a new thread, the old one kept', Boolean(after.nativeSessionId) && after.nativeSessionId !== before.nativeSessionId && after.previousNativeSessionIds?.at(-1) === before.nativeSessionId, { before: before.nativeSessionId, now: after.nativeSessionId, previous: after.previousNativeSessionIds });
  check('the terminal shows the new thread', Boolean(after.terminalId) && after.terminalId !== before.terminalId, { before: before.terminalId, now: after.terminalId });

  const third = await sendAndWait(server, sessionId, THIRD, args.timeoutSeconds);
  check('the next turn completed', third.state === 'completed', { state: third.state, error: third.error });
  await waitIdle(server, sessionId);
  const rows = await settledTimeline(server, 3);
  const answer = rows.filter(row => row.kind === 'assistant').at(-1)?.text ?? '';
  check('the previous topic is not in the context', /UNKNOWN/i.test(answer) && !/PLUM/i.test(answer), { answer: answer.slice(0, 200) });
  check('every message shown once, /new between the topics', inOrder(rows, [FIRST, '/new', THIRD]), typedOrder(rows));
  const next = await sent(after.nativeSessionId!);
  const nextSkills = catalogSkills(next.developer);
  check('the new topic\'s thread is isolated too', next.base.startsWith('You are the owner\'s personal assistant') && nextSkills.length > 0 && nextSkills.every(name => name.startsWith('riffet:')), nextSkills);
  check('both answers shown', rows.filter(row => row.kind === 'assistant').length >= 2, rows.filter(row => row.kind === 'assistant').map(row => row.text.slice(0, 40)));

  const edit = await sendAndWait(server, sessionId, PROTECTED, args.timeoutSeconds);
  await waitIdle(server, sessionId);
  const status = server.services.store.getSession(sessionId);
  check('an edit to AGENTS.md is refused without asking', readFileSync(rulesFile, 'utf8') === rulesText && edit.state === 'completed', { state: edit.state, error: edit.error, state2: status.state });

  // A background run: started by the server on the 助理's agent, it never stops to ask (§6).
  await server.call('PATCH', '/api/settings', { assistant: { backendId: 'codex', ...(prepared.backendProfileId ? { profileId: prepared.backendProfileId } : {}), ...(model ? { model } : {}) } });
  const services = server.services as unknown as { assistantRuns: { enqueue(job: string, key: string, brief: Record<string, string>, subject?: string): { id: string }; get(id: string): { state: string; sessionId?: string; error?: string } | undefined }; assistantDelegations: { create(input: Record<string, unknown>): { id: string } } };
  const delegation = services.assistantDelegations.create({ goal: 'Integration test: nothing to watch', attention: 'Nothing', trigger: { kind: 'schedule', cron: '0 9 * * 5' } }).id;
  const queued = services.assistantRuns.enqueue('delegation', `delegation:${delegation}:probe`, { goal: 'Integration test: nothing to watch', attention: 'Nothing', trigger: '{}', until: '2027-01-01', cursor: 'v1', reason: 'Probe run: do nothing, use no tools, and end at once with nothing to report.', payload: 'none' }, delegation);
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  while (Date.now() < deadline && !['done', 'failed', 'ask', 'skipped'].includes(services.assistantRuns.get(queued.id)?.state ?? '')) await sleep(1000);
  const run = services.assistantRuns.get(queued.id);
  const runSession = run?.sessionId ? server.services.store.getSession(run.sessionId) : undefined;
  const runTurn = runSession?.nativeSessionId ? (await sent(runSession.nativeSessionId)).turn : {};
  check('a background run starts on Codex and never asks', runSession?.backendId === 'codex' && runSession.approval === 'dontAsk' && runTurn.approval_policy === 'never', { run, approval: runSession?.approval, policy: runTurn.approval_policy });

  await server.close();
  server = await bootServer(dirs.stateDir);
  const restarted = await settledTimeline(server, 4);
  check('after a restart', inOrder(restarted), typedOrder(restarted));

  // A lane read from scratch imports the earlier thread first, then the boundary, then the current one.
  const ingest = (server.services.nativeBackends as unknown as { ingest: TranscriptIngest }).ingest;
  const generation = server.services.store.journal.peek(sessionId)?.generation;
  ingest.writer(sessionId).rebuild('identity-changed');
  // A client reading the conversation keeps it followed, so it is read while the loop below looks.
  const release = ingest.follow(sessionId);
  let rebuilt: Shown[] = [];
  for (let tries = 0; tries < 30; tries += 1) {
    await sleep(1000);
    const head = server.services.store.journal.peek(sessionId);
    rebuilt = await shown(server);
    const cursor = JSON.parse(head?.ingestCursor ?? '{}') as { threadId?: string; settled?: string };
    if (head?.generation !== generation && cursor.threadId === server.services.store.getSession(sessionId).nativeSessionId && cursor.settled && inOrder(rebuilt)) break;
  }
  release();
  check('after the journal is read again from scratch', inOrder(rebuilt), typedOrder(rebuilt));
  const share = await server.services.nativeBackends.readShareTranscript(sessionId, { messagesOnly: true });
  const shared = share.events.filter(event => event.type === 'user_message_chunk').map(event => String((event.data.content as { text?: string } | undefined)?.text ?? '').trim());
  check('a share holds both topics', JSON.stringify(shared) === JSON.stringify([FIRST, '/new', THIRD, PROTECTED]), shared);
} catch (error) {
  check('probe ran', false, error instanceof Error ? error.stack : String(error));
} finally {
  await server.close().catch(() => undefined);
  if (!args.keep) await dirs.remove();
}
await finish('codex-assistant', checks, { stateDir: dirs.stateDir }, args);
