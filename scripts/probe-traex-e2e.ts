/**
 * Manual real-CLI probe of the TRAE CLI backend through the in-process server, read over sync v3:
 *
 *   node --import tsx scripts/probe-traex-e2e.ts [--model <slug>] [--tool-model <slug>] [--keep] [--out report.json]
 *
 * Besides the TRAE scenarios (TUI and web turns, a permission card, steering, plan mode, built-in tools,
 * a server restart onto the same app-server, an interrupt) it runs the sync checks of
 * scripts/probe-sync-e2e-lib.ts on the main lane.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeContext, Run, TimelineRow } from '../packages/contracts/src/index.js';
import {
  answerChecks, bootServer, finish, laneOutline, laneRows, log as note, openLane, probeArgs, probeDirs, requireCli, restartChecks, seqChecks, waitIdle,
  type Check, type ProbeServer,
} from './probe-sync-e2e-lib.js';

const args = probeArgs();
requireCli(process.env.TRAEX_CLI?.trim() || 'traex', 'TRAE CLI', 'Install the TRAE CLI and sign in first.');
const model = args.model ?? 'GPT-5.5';
const toolModel = args.option('--tool-model') ?? 'DeepSeek-V4-Flash';
const dirs = await probeDirs('traex');
const projectDir = dirs.project;
const credentialDir = join(homedir(), '.riffet', 'traex', 'endpoints');
const tokensBefore = new Set(await readdir(credentialDir).catch(() => []));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const log = (step: string, detail: Record<string, unknown> = {}) => note(JSON.stringify({ step, ...detail }));
const checks: Check[] = [];

let server: ProbeServer = await bootServer(dirs.stateDir);
let services = server.services;
const post = (url: string, payload: Record<string, unknown>): Promise<any> => server.call('POST', url, payload);
const get = (url: string): Promise<any> => server.call('GET', url);
const settle = async (runId: string, timeoutMs = 180_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = services.store.getRun(runId);
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(run.state)) return run;
    if (Date.now() > deadline) throw new Error(`Run ${runId} timed out in ${run.state}: ${JSON.stringify(run.native)}`);
    await sleep(250);
  }
};
const until = async (label: string, check: () => boolean | Promise<boolean>, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(250);
  }
};
const textOf = (row: TimelineRow) => 'text' in row ? row.text : '';
const rows = async (id: string) => (await laneRows(server, id)).rows;
const screen = async (terminalId: string) => (await services.terminal.screen(terminalId)) ?? '';

let sessionId = '';
try {
  const catalog = await get(`/api/backends/traex/catalog?projectId=${services.store.createProject(projectDir, 'TRAE e2e').id}`);
  log('catalog', { available: catalog.available, reason: catalog.reason, models: catalog.models?.length, modes: catalog.capabilities?.modes?.map((mode: { id: string }) => mode.id) });
  if (!catalog.available) throw new Error(`TRAE CLI is not available: ${catalog.reason}`);
  const project = services.store.listProjects().find(item => item.cwd === projectDir)!;

  const first = await post('/api/sessions', {
    projectId: project.id, kind: 'native', backendId: 'traex', model, mode: 'default', approval: 'on-request',
    clientSessionId: randomUUID(),
    initialMessage: { commandId: randomUUID(), text: 'Isolated integration test. Do not use tools. Reply only TRAEX_E2E_OK.' },
  });
  sessionId = first.session.id;
  const one = await settle(first.run.id);
  const session = services.store.getSession(sessionId);
  log('first-turn', { state: one.state, nativeSessionId: session.nativeSessionId, address: session.nativeRuntime?.address, terminalId: session.terminalId, nativeMessageId: one.native?.nativeMessageId });
  if (one.state !== 'completed' || !session.nativeRuntime?.address.startsWith('ws://127.0.0.1:')) throw new Error('First turn did not complete on a loopback app-server');
  const firstUser = (await rows(sessionId)).find(row => row.kind === 'user');
  if (firstUser?.event.data.commandId !== first.run.commandId && firstUser?.event.data.commandId === undefined) throw new Error('The first message was not tied to its run');

  const terminalId = services.store.getSession(sessionId).terminalId;
  if (!terminalId) throw new Error('No TUI was attached');
  // Watching the session is what makes the server read the TUI's own startup screens.
  const main = openLane(server, sessionId);
  await until('TUI past startup', async () => /TRAEX_E2E_OK|Hooks\s+need\s+review/.test(await screen(terminalId)), 45_000);
  if (/Hooks\s+need\s+review/.test(await screen(terminalId))) {
    let card: { id: string; revision: string; title: string; options: Array<{ id: string; label: string }> } | undefined;
    await until('hook review card', async () => {
      card = await get(`/api/sessions/${sessionId}/native/interaction`).catch(() => undefined);
      return card?.title === 'Hooks need review';
    }, 20_000);
    const skip = card!.options.find(item => /without trusting/i.test(item.label))!;
    const answered = await post(`/api/sessions/${sessionId}/native/interaction`, { interactionId: card!.id, revision: card!.revision, requestId: randomUUID(), action: `option:${skip.id}` });
    log('hook-review-card', { options: card!.options.map(item => item.label), answered: answered.status });
  }
  await until('TUI shows the first answer', async () => /TRAEX_E2E_OK/.test(await screen(terminalId)), 45_000);
  log('tui-attached', { terminalId });
  await services.terminal.paste(terminalId, 'Do not use tools. Reply only FROM_TUI_OK.', true);
  await until('a TUI-typed message reaching the workbench', async () => (await rows(sessionId)).some(row => row.kind === 'assistant' && /FROM_TUI_OK/.test(textOf(row))), 120_000);
  const tuiUser = (await rows(sessionId)).find(row => row.kind === 'user' && /FROM_TUI_OK/.test(textOf(row)));
  log('tui-to-web', { commandId: tuiUser?.event.data.commandId ?? null });
  const web = await post(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Do not use tools. Reply only FROM_WEB_OK.' });
  await settle(web.id);
  await until('a web turn showing in the TUI', async () => /FROM_WEB_OK/.test(await screen(terminalId)), 30_000);
  log('web-to-tui', { shown: true });

  await post(`/api/sessions/${sessionId}/native/configure`, { approval: 'read-only' });
  const ask = await post(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Run exactly this shell command: touch approved.txt  Then reply DONE.' });
  await until('permission card', () => services.nativeBackends.status(sessionId).phase === 'attention', 120_000);
  const interaction = await get(`/api/sessions/${sessionId}/native/interaction`);
  log('permission', { kind: interaction.kind, title: interaction.title, actions: interaction.actions.map((action: { id: string }) => action.id) });
  await post(`/api/sessions/${sessionId}/native/interaction`, { interactionId: interaction.id, revision: interaction.revision, requestId: randomUUID(), action: 'approve' });
  const two = await settle(ask.id);
  log('permission-turn', { state: two.state, created: existsSync(join(projectDir, 'approved.txt')) });
  await post(`/api/sessions/${sessionId}/native/configure`, { approval: 'on-request' });

  const longRun = await post(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Run the shell command `sleep 12`, then tell me what extra word you were asked to add.' });
  await until('a running command to steer into', () => services.nativeBackends.status(sessionId).phase === 'busy' && main.frames.some(frame => frame.type === 'rows' && frame.upserts.some(row => row.kind === 'tool' && row.runId === longRun.id)), 120_000);
  const steer = await post(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Also end your answer with the word PINEAPPLE.' });
  const [longState, steerState] = [await settle(longRun.id), await settle(steer.id)];
  const steered = (await rows(sessionId)).find(row => row.kind === 'user' && /PINEAPPLE/.test(textOf(row)));
  log('steer', { long: longState.state, steer: steerState.state, steeredCommandId: steered?.event.data.commandId ?? null, expected: steer.commandId });

  await post(`/api/sessions/${sessionId}/native/configure`, { mode: 'plan' });
  const plan = await post(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Plan, but do not implement, adding a file hello.txt that contains hi. Keep the plan to two steps.' });
  const planRun = await settle(plan.id).catch(() => services.store.getRun(plan.id));
  const planRow = (await rows(sessionId)).find(row => row.kind === 'tool' && row.event.data.kind === 'plan');
  log('plan-mode', { state: planRun.state, planRow: Boolean(planRow), status: services.nativeBackends.status(sessionId).phase, created: existsSync(join(projectDir, 'hello.txt')) });
  if (services.nativeBackends.status(sessionId).phase === 'attention') {
    const card = await get(`/api/sessions/${sessionId}/native/interaction`);
    log('plan-card', { kind: card.kind, title: card.title });
    await post(`/api/sessions/${sessionId}/native/interaction`, { interactionId: card.id, revision: card.revision, requestId: randomUUID(), action: 'deny' });
  }
  await post(`/api/sessions/${sessionId}/native/configure`, { mode: 'default' });

  await post(`/api/sessions/${sessionId}/native/configure`, { model: toolModel });
  const read = await post(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Use your file-reading tool (not a shell command) to read the first line of approved.txt or, if it is empty, of .git/HEAD. Then reply READ_OK.' });
  const readRun = await settle(read.id);
  const tools = (await rows(sessionId)).filter(row => row.kind === 'tool').map(row => ({ name: row.event.data.toolName, kind: row.event.data.kind, title: row.event.data.title }));
  log('builtin-tools', { state: readRun.state, model: toolModel, tools: tools.slice(-4) });
  await post(`/api/sessions/${sessionId}/native/configure`, { model });

  const contexts = main.frames.flatMap(frame => frame.type === 'hello' || frame.type === 'context' ? [frame.context] : []).filter((context): context is NativeContext => context !== undefined);
  log('context', { context: contexts.at(-1) });
  const queueNotices = main.frames.flatMap(frame => frame.type === 'status' && frame.status.notice ? [frame.status.notice] : []).filter(notice => /queue|hook/i.test(notice));
  log('notices', { notices: [...new Set(queueNotices)].slice(0, 5) });
  await waitIdle(server, sessionId);
  await sleep(3_000);
  const final = await laneRows(server, sessionId);
  checks.push(...seqChecks('main', main, final), ...answerChecks('main', main, final, (await laneOutline(server, sessionId)).turns));
  main.close();

  const addressBefore = services.store.getSession(sessionId).nativeRuntime?.address;
  const restart = await restartChecks(dirs.stateDir, server, sessionId, ['main']);
  server = restart.server;
  services = server.services;
  checks.push(...restart.checks);
  const after = await rows(sessionId);
  const resumed = await post(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Do not use tools. Reply only AFTER_RESTART_OK.' });
  const three = await settle(resumed.id);
  const restarted = services.store.getSession(sessionId);
  log('restart', { rows: after.length, state: three.state, sameAddress: restarted.nativeRuntime?.address === addressBefore, sameTerminal: restarted.terminalId === terminalId });
  await until('TUI still in step after restart', async () => /AFTER_RESTART_OK/.test(await screen(terminalId)), 30_000);
  if (three.state !== 'completed' || restarted.nativeRuntime?.address !== addressBefore) throw new Error('Restart did not reconnect to the same app-server');

  const long = await post(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Run the shell command `sleep 30`, then reply DONE.' });
  // A TUI dialog the reader has not answered shows as `attention` over a running turn; the run's own
  // delivery is what says the turn is executing.
  await until('executing turn', () => services.store.getRun(long.id).native?.delivery === 'observed', 60_000);
  const during = services.nativeBackends.status(sessionId);
  log('before-interrupt', { phase: during.phase, interaction: during.interaction?.title ?? null });
  await sleep(3_000);
  await post(`/api/sessions/${sessionId}/cancel`, {});
  const stopped = await settle(long.id, 30_000);
  log('interrupt', { state: stopped.state });
} catch (error) {
  checks.push({ name: 'probe ran to the end', ok: false, detail: error instanceof Error ? error.message : String(error) });
  if (sessionId) {
    const status = (() => { try { return services.nativeBackends.status(sessionId); } catch { return undefined; } })();
    console.error(JSON.stringify({ runs: services.store.listRuns(sessionId).map(run => ({ id: run.id, state: run.state, error: run.error, native: run.native })), status }, null, 1));
  }
} finally {
  if (sessionId) await services.nativeBackends.dispose(sessionId).catch(() => undefined);
  await server.close().catch(() => undefined);
  // Anything this run spawned and did not end is stopped by its token file, which names only this run's servers.
  for (const name of await readdir(credentialDir).catch(() => [])) {
    if (tokensBefore.has(name)) continue;
    try { execFileSync('pkill', ['-f', `--ws-token-file ${join(credentialDir, name)}`]); } catch { /* already gone */ }
    await rm(join(credentialDir, name), { force: true });
  }
  if (!args.keep) await dirs.remove();
}
await finish('traex', checks, { sessionId, model }, args);
