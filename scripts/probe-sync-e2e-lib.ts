/**
 * The shared half of the real-CLI sync probes (`probe-<backend>-e2e.ts`): an in-process server on a temp
 * state dir, a conversation driven through the same requests a client sends, and the sync v3 checks
 * docs/SYNC-V3.md asks of every backend:
 *
 * - seq: each lane's `rows` frames tile its change log with no gap or overlap, and no two rows share a seq;
 * - answers: every finished turn's last answer reached the live stream as the server finally holds it;
 * - restart: a new server over the same state dir serves every row under the same seq and generation,
 *   and a client resuming from the head is answered with a delta and nothing to send;
 * - state: every run completed, the CLI reports idle, and the outline holds one finished turn per prompt.
 *
 * Isolation: its own state dir (hence its own tmux socket), a temp git project, auth off, a loopback port.
 * It never touches the running Riffet service (port 4337, ~/.local/share/riffet). The CLI's own config
 * (credentials, transcripts of the temp project) is the user's.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeBackendId, Run, SyncFrame, SyncLane, TimelineChanges, TimelineRow, TurnOutlineV3 } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/server/src/app.js';

export interface ProbeArgs { model?: string; timeoutSeconds: number; keep: boolean; out?: string; prompts?: string[]; profile?: string }
export interface Check { name: string; ok: boolean; detail?: unknown }

const started = Date.now();
export const log = (message: string) => console.error(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** `--model`, `--timeout <seconds>`, `--keep` (leave the temp dirs), `--out <report.json>`, `--prompt <text>` (repeatable), `--profile <name>` ({@link copyRiffetProfile}). */
export function probeArgs(argv = process.argv.slice(2)): ProbeArgs & { option(name: string): string | undefined } {
  const option = (name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const prompts = argv.flatMap((value, index) => argv[index - 1] === '--prompt' ? [value] : []);
  return {
    option, model: option('--model'), profile: option('--profile'), timeoutSeconds: Number(option('--timeout') ?? 300), keep: argv.includes('--keep'), out: option('--out'),
    ...(prompts.length ? { prompts } : {}),
  };
}

/** Stops the probe with one clear line when the CLI it drives is not installed. */
export function requireCli(executable: string, label: string, hint: string): string {
  try {
    const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')[0] ?? '';
    log(`${label}: ${executable} ${version}`);
    return version;
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found on PATH' : (error as Error).message.split('\n')[0];
    console.error(`${label} probe: cannot run \`${executable} --version\` (${reason}). ${hint}`);
    process.exit(2);
  }
}

type Services = Awaited<ReturnType<typeof createApp>>;

/**
 * Copies the provider profile named [name] (or with that id) of the user's own Riffet into the probe's
 * server, so a CLI nobody signed in to runs on a custom LLM route the user already set up (its address,
 * key and models). The user's profiles are only read: `<RIFFET_STATE_DIR or ~/.local/share/riffet>/native-backend-profiles.json`.
 * The model is `--model`, else the profile's DeepSeek V4.1 Flash (its default when that is one), else its default or first enabled model.
 */
export async function copyRiffetProfile(post: (url: string, body: Record<string, unknown>) => Promise<unknown>, backend: NativeBackendId, name: string): Promise<{ backendProfileId: string; model?: string }> {
  const file = join(process.env.RIFFET_STATE_DIR?.trim() || join(homedir(), '.local/share/riffet'), 'native-backend-profiles.json');
  const all = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Record<string, Array<Record<string, unknown>>>;
  const profiles = all[backend] ?? [];
  const profile = profiles.find(item => item.id === name) ?? profiles.find(item => String(item.name).toLowerCase() === name.toLowerCase());
  if (!profile) throw new Error(`no ${backend} profile named ${name} in ${file} (have: ${profiles.map(item => item.name).join(', ') || 'none'})`);
  const backendProfileId = `probe-${String(profile.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const fields = ['apiEndpoint', 'apiKey', 'defaultModel', 'enabledModels', 'modelInputModalities', 'modelContextWindows', 'modelSource'] as const;
  await post(`/api/backends/${backend}/profiles`, { id: backendProfileId, name: `Probe (${String(profile.name)})`, ...Object.fromEntries(fields.flatMap(field => profile[field] === undefined ? [] : [[field, profile[field]]])) });
  const enabled = Array.isArray(profile.enabledModels) ? profile.enabledModels.map(String) : [];
  const bare = (model: unknown) => typeof model === 'string' ? model.replace(/\[[^\]]*\]$/, '') : undefined;
  const flash = (item: string | undefined) => item !== undefined && /deepseek[-_]?v?4[._]1[-_]flash/i.test(item);
  const preferred = bare(profile.defaultModel);
  const model = (flash(preferred) ? preferred : enabled.find(flash)) ?? preferred ?? enabled[0];
  log(`${backend}: profile ${String(profile.name)} copied as ${backendProfileId} (${String(profile.apiEndpoint ?? profile.modelSource ?? 'default route')}), model ${model ?? 'default'}`);
  return { backendProfileId, ...(model ? { model } : {}) };
}

/** One server over [stateDir], listening on a loopback port for the sync stream. */
export async function bootServer(stateDir: string, options: { cliPath?: string } = {}) {
  const services = await createApp({ stateDir, auth: false, cliPath: options.cliPath ?? 'cursor-agent' });
  await services.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (services.app.server.address() as { port: number }).port;
  // Auth off still signs every request in with a local cookie, and a mutation carries its CSRF token.
  const origin = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
  const status = await services.app.inject({ url: '/api/auth/status', headers: origin });
  const cookie = String(status.headers['set-cookie']).split(';')[0]!;
  const headers = { ...origin, cookie, 'x-csrf-token': String(status.json().csrfToken) };
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<T> => {
    const response = await services.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    if (response.statusCode >= 400) throw new Error(`${method} ${url}: ${response.statusCode} ${response.body}`);
    return (response.body ? response.json() : undefined) as T;
  };
  return { services, port, cookie, call, close: () => services.app.close() };
}
export type ProbeServer = Awaited<ReturnType<typeof bootServer>>;

/** A temp state dir and a temp git project inside it. */
export async function probeDirs(prefix: string): Promise<{ root: string; stateDir: string; project: string; remove(): Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `riffet-${prefix}-probe-`)));
  const project = join(root, 'project');
  execFileSync('mkdir', ['-p', project]);
  execFileSync('git', ['init', '-q'], { cwd: project });
  execFileSync('git', ['-c', 'user.email=probe@riffet', '-c', 'user.name=probe', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: project });
  return { root, stateDir: join(root, 'state'), project, remove: () => rm(root, { recursive: true, force: true }) };
}

/** What a sync stream of one lane received: its frames in order, and where it holds the lane. */
export interface LaneStream {
  frames: SyncFrame[];
  generation(): string | undefined;
  head(): number;
  close(): void;
}

/** `GET /api/v3/sessions/:id/sync` for [lane], resuming after [after] under [generation] when given; [onFrame] hears each frame as it arrives. */
export function openLane(server: Pick<ProbeServer, 'port' | 'cookie'>, sessionId: string, lane: SyncLane = 'main', resume?: { generation: string; after: number }, onFrame?: (frame: SyncFrame) => void): LaneStream {
  const frames: SyncFrame[] = [];
  let generation: string | undefined, head = -1;
  const query = new URLSearchParams({ lane, rows: '1000', ...(resume ? { generation: resume.generation, after: String(resume.after) } : {}) });
  const request = httpRequest({ host: '127.0.0.1', port: server.port, path: `/api/v3/sessions/${sessionId}/sync?${query}`, headers: { host: '127.0.0.1:4317', cookie: server.cookie, accept: 'text/event-stream' } }, (response: IncomingMessage) => {
    response.setEncoding('utf8');
    let buffer = '';
    response.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
        if (!data) continue;
        const frame = JSON.parse(data) as SyncFrame;
        frames.push(frame);
        if (frame.type === 'hello') { generation = frame.generation; head = frame.headSeq; }
        else if (frame.type === 'snapshot' && frame.final) { generation = frame.generation; head = frame.asOfSeq; }
        else if (frame.type === 'rows') head = Math.max(head, frame.to);
        onFrame?.(frame);
      }
    });
    response.on('error', () => undefined);
  });
  request.on('error', () => undefined);
  request.end();
  return { frames, generation: () => generation, head: () => head, close: () => request.destroy() };
}

/** Everything the lane holds now, by `/timeline/changes` from the start. */
export async function laneRows(server: ProbeServer, sessionId: string, lane: SyncLane = 'main'): Promise<TimelineChanges> {
  return await server.call<TimelineChanges>('GET', `/api/v3/sessions/${sessionId}/timeline/changes?lane=${encodeURIComponent(lane)}&after=0&rows=1000&budget=2097152`);
}

/** The lane's outline: every turn and its status. */
export async function laneOutline(server: ProbeServer, sessionId: string, lane: SyncLane = 'main'): Promise<{ turnCount: number; turns: TurnOutlineV3[] }> {
  return await server.call('GET', `/api/v3/sessions/${sessionId}/outline?lane=${encodeURIComponent(lane)}`);
}

/** Sends [text] the way a client does and waits for its run to end; returns the run as it ended. */
export async function sendAndWait(server: ProbeServer, sessionId: string, text: string, timeoutSeconds: number): Promise<Run> {
  const commandId = `probe-${randomUUID()}`;
  const accepted = await server.call<Run>('POST', `/api/sessions/${sessionId}/native/send`, { commandId, text });
  log(`sent ${commandId}: ${text.slice(0, 60)}`);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const run = server.services.store.getRun(accepted.id);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)) { log(`run ${run.id} ${run.state}${run.error ? `: ${run.error}` : ''}`); return run; }
    await sleep(500);
  }
  throw new Error(`run ${accepted.id} did not end within ${timeoutSeconds}s`);
}

/** Waits until the CLI's status says it is idle again (a turn's end can lead its last write). */
export async function waitIdle(server: ProbeServer, sessionId: string, seconds = 30): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  let phase = '';
  while (Date.now() < deadline) {
    phase = server.services.nativeBackends.status(sessionId).phase;
    if (phase === 'idle' || phase === 'offline') return phase;
    await sleep(500);
  }
  return phase;
}

/** The rows frames of one lane tile its change log from the opening head, and no two rows the server holds share a seq. */
export function seqChecks(lane: SyncLane, stream: LaneStream, final: TimelineChanges): Check[] {
  const hello = stream.frames.find((frame): frame is Extract<SyncFrame, { type: 'hello' }> => frame.type === 'hello');
  const gaps: string[] = [];
  let held = hello ? hello.headSeq : -1;
  for (const frame of stream.frames) {
    if (frame.type === 'snapshot' && frame.final) held = frame.asOfSeq;
    if (frame.type === 'reset') held = -1;
    if (frame.type !== 'rows') continue;
    if (held >= 0 && frame.from !== held + 1) gaps.push(`rows ${frame.from}..${frame.to} after ${held}`);
    const outside = frame.upserts.filter(row => row.seq < frame.from || row.seq > frame.to);
    if (outside.length) gaps.push(`rows ${frame.from}..${frame.to} carries seq ${outside.map(row => row.seq).join(',')}`);
    held = frame.to;
  }
  const seen = new Map<number, string>();
  const duplicates: string[] = [];
  for (const row of final.rows) {
    const other = seen.get(row.seq);
    if (other !== undefined) duplicates.push(`${row.seq}: ${other} and ${row.key}`);
    seen.set(row.seq, row.key);
  }
  return [
    { name: `${lane}: rows frames are contiguous`, ok: gaps.length === 0, ...(gaps.length ? { detail: gaps.slice(0, 10) } : {}) },
    { name: `${lane}: seq unique`, ok: duplicates.length === 0, ...(duplicates.length ? { detail: duplicates.slice(0, 10) } : {}) },
    { name: `${lane}: stream reached the head`, ok: stream.head() >= final.headSeq, detail: { stream: stream.head(), head: final.headSeq } },
  ];
}

/** Every finished turn's last answer, as the server finally holds it, was on the live stream. */
export function answerChecks(lane: SyncLane, stream: LaneStream, final: TimelineChanges, outline: TurnOutlineV3[]): Check[] {
  const live = new Map<string, TimelineRow>();
  for (const frame of stream.frames) {
    const rows = frame.type === 'rows' ? frame.upserts : frame.type === 'snapshot' ? frame.rows : [];
    for (const row of rows) live.set(row.key, row);
  }
  const missing: string[] = [];
  for (const turn of outline.filter(item => item.status === 'completed')) {
    // A planning turn can end on its proposed plan alone (Codex, TraeX): that plan is its answer.
    const answers = final.rows.filter(row => row.turn === turn.turn && (row.kind === 'assistant' || (row.kind === 'tool' && row.event.data.kind === 'plan')));
    const last = answers.sort((a, b) => a.pos - b.pos).at(-1);
    if (!last) { missing.push(`${turn.turnId}: no answer row`); continue; }
    const delivered = live.get(last.key);
    if (!delivered || delivered.seq !== last.seq) missing.push(`${turn.turnId}: ${last.key} live seq ${delivered?.seq ?? 'none'}, server ${last.seq}`);
  }
  return [{ name: `${lane}: last answer of every turn delivered`, ok: missing.length === 0, ...(missing.length ? { detail: missing } : {}) }];
}

/** The state after the conversation: runs done, the CLI idle, one finished turn per prompt. */
export function stateChecks(runs: Run[], phase: string, outline: { turnCount: number; turns: TurnOutlineV3[] }, prompts: number): Check[] {
  const unfinished = runs.filter(run => run.state !== 'completed').map(run => `${run.id}: ${run.state}${run.error ? ` (${run.error})` : ''}`);
  const open = outline.turns.filter(turn => turn.status !== 'completed').map(turn => `${turn.turnId}: ${turn.status}`);
  return [
    { name: 'every run completed', ok: unfinished.length === 0, ...(unfinished.length ? { detail: unfinished } : {}) },
    { name: 'CLI reports idle', ok: phase === 'idle', detail: phase },
    { name: 'outline holds one finished turn per prompt', ok: outline.turnCount >= prompts && open.length === 0, detail: { turnCount: outline.turnCount, prompts, open } },
  ];
}

/** Restarts the server over the same state dir: every row keeps its seq and the generation stays, and resuming at the head is a delta with nothing to send. */
export async function restartChecks(stateDir: string, before: ProbeServer, sessionId: string, lanes: SyncLane[], cliPath?: string): Promise<{ checks: Check[]; server: ProbeServer }> {
  const held = new Map<SyncLane, TimelineChanges>();
  for (const lane of lanes) held.set(lane, await laneRows(before, sessionId, lane));
  await before.close();
  log('server restarted over the same state dir');
  const server = await bootServer(stateDir, cliPath ? { cliPath } : {});
  const checks: Check[] = [];
  for (const lane of lanes) {
    const old = held.get(lane)!;
    const now = await laneRows(server, sessionId, lane);
    const seqs = new Map(old.rows.map(row => [row.key, row.seq]));
    const moved = now.rows.filter(row => seqs.has(row.key) && seqs.get(row.key) !== row.seq).map(row => `${row.key}: ${seqs.get(row.key)} -> ${row.seq}`);
    checks.push({ name: `${lane}: seq and generation unchanged after a restart`, ok: moved.length === 0 && now.generation === old.generation, detail: { moved: moved.slice(0, 10), generation: [old.generation, now.generation] } });
    const resumed = openLane(server, sessionId, lane, { generation: old.generation, after: old.headSeq });
    await sleep(3_000);
    resumed.close();
    const hello = resumed.frames.find((frame): frame is Extract<SyncFrame, { type: 'hello' }> => frame.type === 'hello');
    const resent = resumed.frames.filter(frame => frame.type === 'rows' || frame.type === 'snapshot').length;
    checks.push({ name: `${lane}: resuming at the head after a restart is an empty delta`, ok: hello?.mode === 'delta' && resent === 0, detail: { mode: hello?.mode, framesWithRows: resent } });
  }
  return { checks, server };
}

/** Prints the report, writes it when asked, and exits non-zero on a failed check. */
export async function finish(backend: NativeBackendId | string, checks: Check[], extra: Record<string, unknown>, args: ProbeArgs): Promise<never> {
  if (typeof extra.skipped === 'string') {
    // The CLI could not run a turn on this machine (no credentials, no login): nothing of sync v3 was tested.
    const report = { backend, ok: false, skipped: extra.skipped, checks, ...extra };
    if (args.out) { const { writeFile } = await import('node:fs/promises'); await writeFile(args.out, JSON.stringify(report, null, 2)); }
    console.log(JSON.stringify(report, null, 2));
    log(`SKIP environment: ${extra.skipped}`);
    process.exit(2);
  }
  const failed = checks.filter(check => !check.ok);
  const report = { backend, ok: failed.length === 0, checks, ...extra };
  if (args.out) { const { writeFile } = await import('node:fs/promises'); await writeFile(args.out, JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report, null, 2));
  for (const check of checks) log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}`);
  process.exit(failed.length ? 1 : 0);
}

/** The subagent lanes the main lane's tool rows name. */
export function subagentLanes(rows: TimelineRow[]): SyncLane[] {
  return [...new Set(rows.flatMap(row => row.kind === 'tool' && row.subagent ? [row.subagent.lane] : []))];
}

/**
 * The whole probe for one backend: a conversation of [prompts] over a live sync stream of the main lane
 * (and of every subagent lane its rows name), then the checks, a restart and the restart checks.
 */
export async function runConversationProbe(options: {
  backend: NativeBackendId; label: string; args: ProbeArgs; prompts: string[]; cliPath?: string;
  /** Before the server first starts: files the state dir needs (a CLI's own settings). */
  seed?: (stateDir: string) => Promise<void>;
  /** Before the session: a profile to write and select, a model to use. */
  prepare?: (server: ProbeServer) => Promise<{ backendProfileId?: string; model?: string }>;
  /**
   * Why the first turn could not run on this machine, when that is the CLI's environment (a missing key,
   * a login screen) rather than Riffet: the probe then ends as skipped. `run` is undefined when it never ended.
   */
  environment?: (server: ProbeServer, sessionId: string, run?: Run) => Promise<string | undefined>;
}): Promise<never> {
  const { backend, label, args, prompts } = options;
  const dirs = await probeDirs(backend);
  await options.seed?.(dirs.stateDir);
  let server = await bootServer(dirs.stateDir, options.cliPath ? { cliPath: options.cliPath } : {});
  const checks: Check[] = [];
  const extra: Record<string, unknown> = { stateDir: dirs.stateDir };
  try {
    const prepared = {
      ...(args.profile ? await copyRiffetProfile((url, body) => server.call('POST', url, body), backend, args.profile) : {}),
      ...await options.prepare?.(server),
    };
    const model = args.model ?? prepared.model;
    const project = server.services.store.createProject(dirs.project, `${label} sync probe`);
    const session = await server.call<{ id: string }>('POST', '/api/sessions', {
      projectId: project.id, kind: 'native', title: `${label} sync probe`, backendId: backend,
      ...(prepared.backendProfileId ? { backendProfileId: prepared.backendProfileId } : {}), ...(model ? { model } : {}),
    });
    extra.sessionId = session.id;
    extra.model = model ?? 'default';
    const main = openLane(server, session.id);
    const runs: Run[] = [];
    for (const prompt of prompts) {
      const run = await sendAndWait(server, session.id, prompt, args.timeoutSeconds).catch(async (error: unknown) => {
        const reason = runs.length ? undefined : await options.environment?.(server, session.id);
        if (reason) throw new EnvironmentSkip(reason);
        throw error;
      });
      const reason = runs.length || run.state === 'completed' ? undefined : await options.environment?.(server, session.id, run);
      if (reason) throw new EnvironmentSkip(reason);
      runs.push(run);
    }
    const phase = await waitIdle(server, session.id);
    // A turn's last rows can be read a moment after its run settled.
    await sleep(3_000);
    const final = await laneRows(server, session.id);
    const outline = await laneOutline(server, session.id);
    const lanes: SyncLane[] = ['main', ...subagentLanes(final.rows)];
    checks.push(...seqChecks('main', main, final), ...answerChecks('main', main, final, outline.turns), ...stateChecks(runs, phase, outline, prompts.length));
    for (const lane of lanes.slice(1)) {
      const stream = openLane(server, session.id, lane);
      await sleep(2_000);
      stream.close();
      const rows = await laneRows(server, session.id, lane);
      checks.push(...seqChecks(lane, stream, rows), ...answerChecks(lane, stream, rows, (await laneOutline(server, session.id, lane)).turns));
    }
    main.close();
    extra.lanes = lanes;
    extra.rows = final.rows.length;
    const restarted = await restartChecks(dirs.stateDir, server, session.id, lanes, options.cliPath);
    server = restarted.server;
    checks.push(...restarted.checks);
  } catch (error) {
    if (error instanceof EnvironmentSkip) extra.skipped = error.message;
    else checks.push({ name: 'probe ran to the end', ok: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    await server.close().catch(() => undefined);
    if (!args.keep) await dirs.remove();
  }
  return await finish(backend, checks, extra, args);
}

/** The CLI cannot run a turn on this machine; see `environment`. */
class EnvironmentSkip extends Error {}
