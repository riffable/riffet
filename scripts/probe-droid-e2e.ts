/**
 * Manual real-CLI probe of the Droid backend through the in-process server, read over sync v3.
 *
 *   node --import tsx scripts/probe-droid-e2e.ts [--model <id>] [--timeout <seconds>] [--keep] [--out report.json]
 *
 * Scenarios: a first turn, a permission card answered, a configure, a command with live output, an awaited
 * Task subagent, an interrupt, a server restart, a resumed turn, and a turn whose CLI is killed. Over them,
 * the sync checks of scripts/probe-sync-e2e-lib.ts on the main lane and the subagent's lane.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Run } from '../packages/contracts/src/index.js';
import {
  answerChecks, bootServer, finish, laneOutline, laneRows, log, openLane, probeArgs, probeDirs, requireCli, restartChecks, seqChecks, stateChecks, subagentLanes, waitIdle,
  type Check, type ProbeServer,
} from './probe-sync-e2e-lib.js';

const args = probeArgs();
requireCli(process.env.DROID_CLI?.trim() || 'droid', 'Droid', 'Install the Factory Droid CLI (https://docs.factory.ai) and sign in with `droid` first.');
const model = args.model ?? 'claude-haiku-4-5-20251001';
const dirs = await probeDirs('droid');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let server: ProbeServer = await bootServer(dirs.stateDir);
const post = <T = any>(url: string, payload: Record<string, unknown>) => server.call<T>('POST', url, payload);
const get = <T = any>(url: string) => server.call<T>('GET', url);
const settle = async (runId: string, timeoutMs = args.timeoutSeconds * 1000): Promise<Run> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = server.services.store.getRun(runId);
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(run.state)) return run;
    if (Date.now() > deadline) throw new Error(`Run ${runId} timed out in ${run.state}: ${JSON.stringify(run.native)}`);
    await sleep(200);
  }
};
const until = async (label: string, check: () => boolean, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
};

const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
let sessionId = '';
try {
  const project = server.services.store.createProject(dirs.project, 'Droid e2e');
  const first = await post<{ session: { id: string }; run: { id: string } }>('/api/sessions', {
    projectId: project.id, kind: 'native', backendId: 'droid', model, mode: 'agent', approval: 'off',
    clientSessionId: randomUUID(),
    initialMessage: { commandId: randomUUID(), text: 'Isolated integration test. Do not use tools. Reply only DROID_E2E_OK.' },
  });
  sessionId = first.session.id;
  const main = openLane(server, sessionId);
  const runs: Run[] = [await settle(first.run.id)];
  const session = server.services.store.getSession(sessionId);
  check('first turn completed with a native session', runs[0]!.state === 'completed' && !!session.nativeSessionId, { state: runs[0]!.state });

  const ask = await post<Run>(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Run the shell command `touch approved.txt` with the Execute tool, then reply DONE.' });
  await until('permission card', () => server.services.nativeBackends.status(sessionId).phase === 'attention');
  const interaction = await get(`/api/sessions/${sessionId}/native/interaction`);
  await post(`/api/sessions/${sessionId}/native/interaction`, { interactionId: interaction.id, revision: interaction.revision, requestId: interaction.requestId, action: 'proceed_once' });
  runs.push(await settle(ask.id));
  check('approved command ran', runs.at(-1)!.state === 'completed' && existsSync(join(dirs.project, 'approved.txt')));

  const configured = await post(`/api/sessions/${sessionId}/native/configure`, { approval: 'low', mode: 'spec' });
  check('configure applied', configured.approval === 'low' && configured.mode === 'spec', { approval: configured.approval, mode: configured.mode });
  await post(`/api/sessions/${sessionId}/native/configure`, { mode: 'agent', approval: 'high' });

  const exec = await post<Run>(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Use the Execute tool to run exactly this command: `for i in 1 2 3 4; do echo tick$i; sleep 1; done`. Then reply DONE.' });
  runs.push(await settle(exec.id));
  const toolUpdates = main.frames.flatMap(frame => frame.type === 'rows' ? frame.upserts : []).filter(row => row.kind === 'tool' && row.runId === exec.id);
  check('the command row reached the stream', toolUpdates.length > 0, { updates: toolUpdates.length });

  const task = await post<Run>(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Use the Task tool with subagent_type "worker" (await it) to do this: "Use the LS tool on the current directory and report how many entries it has." Then reply with its answer.' });
  runs.push(await settle(task.id, 240_000));

  const long = await post<Run>(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Do not use tools. Write the integers from 1 to 3000, one per line, without abbreviating.' });
  await until('busy turn', () => server.services.nativeBackends.status(sessionId).phase === 'busy' && server.services.store.getRun(long.id).native?.nativeMessageId !== undefined);
  await sleep(1500);
  await post(`/api/sessions/${sessionId}/cancel`, {});
  const stopped = await settle(long.id, 30_000);
  await until('idle after interrupt', () => server.services.nativeBackends.status(sessionId).phase === 'idle', 15_000);
  check('interrupt cancelled the run', stopped.state === 'cancelled' || stopped.state === 'interrupted', { state: stopped.state });

  const phase = await waitIdle(server, sessionId);
  await sleep(3_000);
  const final = await laneRows(server, sessionId);
  const outline = await laneOutline(server, sessionId);
  const lanes = ['main' as const, ...subagentLanes(final.rows)];
  check('the Task row names a subagent lane', lanes.length > 1, lanes);
  checks.push(...seqChecks('main', main, final), ...answerChecks('main', main, final, outline.turns), ...stateChecks(runs, phase, { ...outline, turns: outline.turns.filter(turn => turn.runId !== long.id) }, runs.length));
  for (const lane of lanes.slice(1)) {
    const stream = openLane(server, sessionId, lane);
    await sleep(2_000);
    stream.close();
    const rows = await laneRows(server, sessionId, lane);
    check(`${lane}: the subagent transcript has rows`, rows.rows.length > 0, { rows: rows.rows.length });
    checks.push(...seqChecks(lane, stream, rows));
  }
  main.close();

  const restarted = await restartChecks(dirs.stateDir, server, sessionId, lanes);
  server = restarted.server;
  checks.push(...restarted.checks);

  const resumed = await post<Run>(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'What file did you create earlier? Reply with only its name.' });
  const three = await settle(resumed.id);
  check('resumed turn completed in the same native session', three.state === 'completed' && server.services.store.getSession(sessionId).nativeSessionId === session.nativeSessionId);

  const doomed = await post<Run>(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Do not use tools. Write the integers from 1 to 3000, one per line, without abbreviating.' });
  await until('busy turn before crash', () => server.services.nativeBackends.status(sessionId).phase === 'busy' && server.services.store.getRun(doomed.id).native?.nativeMessageId !== undefined);
  await sleep(1000);
  execFileSync('pkill', ['-9', '-f', `droid exec.*${basename(dirs.root)}`]);
  const crashed = await settle(doomed.id, 15_000);
  check('a turn Droid died in failed its run', crashed.state === 'failed', { state: crashed.state, error: crashed.error });
  const recovered = await post<Run>(`/api/sessions/${sessionId}/native/send`, { commandId: randomUUID(), text: 'Reply only RECOVERED.' });
  check('the session recovered after Droid died', (await settle(recovered.id)).state === 'completed');
} catch (error) {
  check('probe ran to the end', false, error instanceof Error ? error.message : String(error));
  if (sessionId) log(JSON.stringify(server.services.store.listRuns(sessionId).map(run => ({ id: run.id, state: run.state, error: run.error, native: run.native }))));
} finally {
  await server.close().catch(() => undefined);
  if (!args.keep) await dirs.remove();
}
await finish('droid', checks, { sessionId, model }, args);
