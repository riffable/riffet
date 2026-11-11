/** Manual real-CLI probe: node --import tsx scripts/probe-native-startup.ts --model '<native model>' [--cold] [--interrupt] */
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../apps/server/src/app.js';

const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
if (!args.includes('--model') || !model || model.startsWith('--')) throw new Error('Pass --model with an available Native model ID. Optional: --cold. CURSOR_CLI selects the launcher (default cursor-agent).');
const cold = args.includes('--cold');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'riffet-startup-probe-')));
await mkdir(join(directory, 'project'));
const services = await createApp({ stateDir: join(directory, 'state'), cliPath: process.env.CURSOR_CLI ?? 'cursor-agent', auth: false });
const { app, store, terminal } = services;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
try {
  const origin = { host: '127.0.0.1:4337', origin: 'http://127.0.0.1:4337' };
  const auth = await app.inject({ url: '/api/auth/status', headers: origin });
  const headers = { ...origin, cookie: String(auth.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': auth.json().csrfToken as string };
  const post = async (url: string, payload: Record<string, unknown>) => {
    const response = await app.inject({ url, method: 'POST', headers, payload });
    if (response.statusCode >= 400) throw new Error(`${url}: ${response.body}`);
    return response.json();
  };
  const project = store.createProject(join(directory, 'project'), 'Isolated startup probe');
  const config = { projectId: project.id, model, mode: 'agent' };
  if (!cold) {
    const start = Date.now();
    for (;;) {
      const warm = await post('/api/native/prewarm', config);
      if (warm.state === 'ready') { console.log(JSON.stringify({ warmReadyMs: Date.now() - start })); break; }
      if (warm.state === 'skipped' || Date.now() - start > 45_000) throw new Error(`Warmup unavailable: ${JSON.stringify(warm)}`);
      await sleep(200);
    }
  }
  const prompt = 'Isolated integration test. Do not read or change files or run tools. Reply only STARTUP_PROBE_OK.';
  const body = { ...config, kind: 'native', clientSessionId: randomUUID(), initialMessage: { commandId: randomUUID(), text: prompt } };
  const acceptedAt = Date.now();
  const first = await post('/api/sessions', body);
  console.log(JSON.stringify({ cold, acceptedMs: Date.now() - acceptedAt }));
  const duplicate = await post('/api/sessions', body);
  if (duplicate.run.id !== first.run.id) throw new Error('Idempotent create returned a different run');
  const complete = async (id: string) => {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const run = store.getRun(id);
      if (['failed', 'interrupted', 'cancelled'].includes(run.state)) throw new Error(`Run ${run.state}: ${run.error ?? run.native?.stage}`);
      if (run.state === 'completed') {
        console.log(JSON.stringify({ elapsedMs: Date.now() - Date.parse(run.createdAt), timings: run.native?.timings }));
        return run;
      }
      if (Date.now() > deadline) throw new Error(`Completion timeout: ${run.native?.delivery}`);
      await sleep(200);
    }
  };
  const one = await complete(first.run.id);
  const next = await post(`/api/sessions/${first.session.id}/native/send`, { commandId: randomUUID(), text: prompt, expectedConfigRevision: 0 });
  const two = await complete(next.id);
  if (!one.native?.nativeMessageId || !two.native?.nativeMessageId || one.native.nativeMessageId === two.native.nativeMessageId) throw new Error('Identical prompts were not separately bound');
  if (args.includes('--interrupt')) {
    const ongoing = await post(`/api/sessions/${first.session.id}/native/send`, { commandId: randomUUID(), text: 'Isolated interruption test. Do not use tools or access files. Write the integers from 1 to 10000, one per line, without abbreviating.' });
    const deadline = Date.now() + 30_000;
    while (services.nativeBackends.status(first.session.id).phase !== 'busy') {
      if (Date.now() > deadline || store.getRun(ongoing.id).state === 'completed') throw new Error('Could not observe a running turn to interrupt');
      await sleep(100);
    }
    const commandId = randomUUID(), stopAt = Date.now();
    const replacement = await post(`/api/sessions/${first.session.id}/native/interrupt-and-send`, { commandId, text: prompt });
    const replay = await post(`/api/sessions/${first.session.id}/native/interrupt-and-send`, { commandId, text: prompt });
    if (replay.id !== replacement.id) throw new Error('Interrupt-and-send replay was not idempotent');
    await complete(replacement.id);
    if (store.getRun(ongoing.id).native?.stage !== 'interrupted') throw new Error('Original turn was not marked interrupted');
    console.log(JSON.stringify({ interruptAndFollowupMs: Date.now() - stopAt, interruptPassed: true }));
    const stopped = await post(`/api/sessions/${first.session.id}/native/send`, { commandId: randomUUID(), text: 'Isolated multiline interruption test. Do not use tools.\nWrite integers from 1 to 10000, one per line, without abbreviating.' });
    const stopDeadline = Date.now() + 30_000;
    while (services.nativeBackends.status(first.session.id).phase !== 'busy') {
      if (Date.now() > stopDeadline || store.getRun(stopped.id).state === 'completed') throw new Error('Could not observe the stop-only test running');
      await sleep(100);
    }
    await post(`/api/sessions/${first.session.id}/cancel`, {});
    const afterStop = await post(`/api/sessions/${first.session.id}/native/send`, { commandId: randomUUID(), text: prompt });
    await complete(afterStop.id);
    console.log(JSON.stringify({ stopThenSendPassed: true }));
  }
  console.log(JSON.stringify({ passed: true, noBrowserSubscriber: true, stats: await services.nativeBackends.runtimeStats('cursor') }));
} catch (error) {
  for (const session of store.listSessions()) {
    console.error(JSON.stringify({ diagnostics: { runs: store.listRuns(session.id).map(run => ({ id: run.id, state: run.state, native: run.native })), status: services.nativeBackends.status(session.id) } }));
    if (session.terminalId) console.error((await terminal.screen(session.terminalId))?.slice(-5000));
  }
  throw error;
} finally {
  for (const info of await terminal.list()) await terminal.stop(info.id).catch(() => undefined);
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
