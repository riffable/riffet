/**
 * Real-CLI probe of the assistant's workbench reads, using a temporary Riffet instance.
 *
 * node --import tsx scripts/probe-assistant-workbench.ts --backend claude --profile <profile>
 * node --import tsx scripts/probe-assistant-workbench.ts --backend codex --profile <profile>
 */
import { Buffer } from 'node:buffer';
import type { Run, Session } from '../packages/contracts/src/index.js';
import { bootServer, copyRiffetProfile, finish, log, probeArgs, probeDirs, requireCli, sendAndWait, type Check } from './probe-sync-e2e-lib.js';

for (const key of Object.keys(process.env)) {
  if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|RIFFET_CLAUDE_HOOK_.*|CODEX_THREAD_ID)$/.test(key)) delete process.env[key];
}
const args = probeArgs();
const backend = args.option('--backend');
if (backend !== 'claude' && backend !== 'codex') throw new Error('Pass --backend claude or --backend codex');
requireCli(backend, backend, 'Install and configure the selected CLI.');
const dirs = await probeDirs(`workbench-${backend}`);
const server = await bootServer(dirs.stateDir);
const { store, workItems, plugins, riffetMcp } = server.services;
const checks: Check[] = [];
const calls: Array<{ name: string; id?: string; result?: Record<string, unknown>; error: boolean }> = [];
const originalHandle = riffetMcp.handle.bind(riffetMcp);
riffetMcp.handle = async (authorization, method, params, signal) => {
  const response = await originalHandle(authorization, method, params, signal);
  if (method === 'tools/call' && params && typeof params === 'object') {
    const { name, arguments: input } = params as { name?: string; arguments?: { id?: string } };
    const result = response as { isError?: boolean; structuredContent?: Record<string, unknown> };
    if (name) calls.push({ name, id: input?.id, result: result.structuredContent, error: Boolean(result.isError) });
  }
  return response;
};

const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); };
const browserQuestion = '我启用了 Riffet 的浏览器插件，为什么你现在用不了？';
const questionText = '发布前用哪个测试区域？';
const sessionId = 'workbench-probe-main';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let tools: Record<string, { count: number; bytes: number }> = {};
try {
  await plugins.refresh();
  const profile = args.profile ? await copyRiffetProfile((url, body) => server.call('POST', url, body), backend, args.profile) : {};
  const assistant = store.listProjects().find(project => project.system === 'assistant');
  if (!assistant) throw new Error('No personal assistant project');
  const project = store.createProject(dirs.project, 'Workbench probe');
  const task = workItems.create({ title: 'Verify test release', projectId: project.id, status: 'doing' });
  const taskSession = store.createSession({ projectId: project.id, kind: 'native', state: 'idle', workItemId: task.id, backendId: backend });
  const pending = workItems.ask(taskSession.id, { question: questionText });

  const first = await server.call<{ run: Run }>('POST', '/api/sessions', {
    clientSessionId: sessionId, projectId: assistant.id, kind: 'native', backendId: backend, ...profile,
    ...(args.model ? { model: args.model } : {}),
    approval: backend === 'claude' ? 'bypassPermissions' : 'dontAsk',
    initialMessage: { commandId: 'workbench-probe-browser', text: browserQuestion },
  });
  const until = Date.now() + args.timeoutSeconds * 1000;
  let turn = store.getRun(first.run.id);
  while (Date.now() < until && (turn.state === 'queued' || turn.state === 'running')) {
    await sleep(500);
    turn = store.getRun(first.run.id);
  }
  const browserCalls = calls.splice(0);
  const inspect = browserCalls.find(call => call.name === 'capability_read' && call.id === 'plugins.inspect')?.result;
  const browserGroups = inspect?.toolGroups as Array<{ authorized?: boolean; serverAvailable?: boolean; cliLoaded?: string }> | undefined;
  check('the browser question used capability discovery and inspected the plugin',
    turn.state === 'completed' && browserCalls.some(call => call.name === 'capability_find' && !call.error) && Boolean(inspect),
    browserCalls.map(({ name, id, error }) => ({ name, id, error })));
  check('the enabled browser is ungranted and loading is unknown',
    Boolean((inspect?.plugin as { active?: boolean } | undefined)?.active && browserGroups?.some(group => group.authorized === false && group.serverAvailable === false && group.cliLoaded === 'unknown')),
    browserGroups?.map(({ authorized, serverAvailable, cliLoaded }) => ({ authorized, serverAvailable, cliLoaded })));

  if (turn.state !== 'completed') throw new Error('The first turn did not complete');
  await sendAndWait(server, sessionId, '今天有什么等我处理？', args.timeoutSeconds);
  const attention = calls.find(call => call.name === 'capability_read' && call.id === 'workbench.attention')?.result;
  check('the attention question used workbench capabilities and found the idle task’s unanswered question',
    calls.some(call => call.name === 'capability_find' && !call.error) && Boolean(attention && JSON.stringify(attention).includes(pending.id)),
    calls.map(({ name, id, error }) => ({ name, id, error })));

  const supervise = store.createSession({ projectId: assistant.id, kind: 'native', backendId: backend, origin: { kind: 'assistant', job: 'supervise' } });
  const sessions: Record<string, Session> = { main: store.getSession(sessionId), task: taskSession, supervise };
  tools = Object.fromEntries(Object.entries(sessions).map(([role, session]) => {
    const listed = riffetMcp.tools(session);
    return [role, { count: listed.length, bytes: Buffer.byteLength(JSON.stringify(listed), 'utf8') }];
  }));
} catch (error) {
  log('The workbench probe did not finish.');
  check('probe completed', false, error instanceof Error ? error.name : 'Unknown failure');
} finally {
  await server.close();
  if (!args.keep) await dirs.remove();
}
await finish(backend, checks, { tools }, args);
