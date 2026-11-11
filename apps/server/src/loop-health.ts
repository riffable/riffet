import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Profiler, Session } from 'node:inspector/promises';
import { SourceMap } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export interface LoopHealthSnapshot { p50Ms: number; p99Ms: number; maxMs: number; utilization: number; stalls: number; lastStallAt?: string; recentLagMs: number; }

type Log = { warn: (obj: object, msg: string) => void };

const TICK_MS = 500;
const STALL_MS = 250;
const LOG_EVERY_MS = 10_000;
const LAG_WINDOW_MS = 5_000;
const SNAPSHOT_WINDOW_MS = 60_000;
/** A stall this long, or this many within the window, gets the next stretch profiled. */
const PROFILE_STALL_MS = 1_000;
const PROFILE_REPEAT = 3;
const PROFILE_REPEAT_WINDOW_MS = 60_000;
const PROFILE_MS = 30_000;
const PROFILE_EVERY_MS = 60 * 60_000;
const PROFILE_KEEP = 3;
/** Where the program's own files sit: `dist/cli.js` when built, `apps/server/src/*.ts` under tsx. */
const ROOT = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../../' : '../', import.meta.url));

interface Monitor {
  users: number;
  timer: NodeJS.Timeout;
  histogram: ReturnType<typeof monitorEventLoopDelay>;
  windowStart: number;
  windowElu: EventLoopUtilization;
  stalls: number;
  lastStallAt?: number;
  lags: Array<{ at: number; ms: number }>;
  lastLogAt: number;
  /** Utilization is reported over the stretch since the last line, not since boot, where a saturated minute would vanish. */
  logElu: EventLoopUtilization;
  suppressed: number;
  suppressedMaxMs: number;
  /** Unset (tests, embedders) never profiles. */
  profileDir?: string;
  stallTimes: number[];
  profiledAt: number;
  cancelProfile?: () => void;
}

// One monitor per process; the app (and tests that build several) share it by reference count.
let monitor: Monitor | undefined;

/**
 * Makes a blocked event loop visible: a saturated loop starves every request while the process
 * still looks alive, so nothing else would report it.
 */
export function startLoopHealth(log: Log, profileDir?: string): { stop(): void } {
  if (!monitor) monitor = create(log, profileDir);
  const owner = monitor;
  owner.users++;
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (--owner.users > 0) return;
      clearInterval(owner.timer);
      owner.cancelProfile?.();
      owner.histogram.disable();
      if (monitor === owner) monitor = undefined;
    },
  };
}

function create(log: Log, profileDir?: string): Monitor {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const state: Monitor = { users: 0, timer: undefined as unknown as NodeJS.Timeout, histogram, windowStart: Date.now(), windowElu: performance.eventLoopUtilization(), stalls: 0, lags: [], lastLogAt: 0, logElu: performance.eventLoopUtilization(), suppressed: 0, suppressedMaxMs: 0, profileDir, stallTimes: [], profiledAt: -Infinity };
  // A timer fires late by as long as something held the loop; the histogram only says how much, not when.
  let last = performance.now();
  state.timer = setInterval(() => {
    const at = performance.now();
    const late = Math.max(0, at - last - TICK_MS);
    last = at;
    const wall = Date.now();
    state.lags.push({ at: wall, ms: late });
    while (state.lags.length && wall - state.lags[0]!.at > LAG_WINDOW_MS) state.lags.shift();
    if (late <= STALL_MS) return;
    state.stalls++;
    state.lastStallAt = wall;
    state.suppressed++;
    state.suppressedMaxMs = Math.max(state.suppressedMaxMs, late);
    state.stallTimes.push(wall);
    while (wall - state.stallTimes[0]! > PROFILE_REPEAT_WINDOW_MS) state.stallTimes.shift();
    if (state.profileDir && !state.cancelProfile && wall - state.profiledAt >= PROFILE_EVERY_MS && (late >= PROFILE_STALL_MS || state.stallTimes.length >= PROFILE_REPEAT)) {
      state.profiledAt = wall;
      profileStalls(state, state.profileDir, log, { blockedMs: Math.round(late), stallsInMinute: state.stallTimes.length });
    }
    if (wall - state.lastLogAt < LOG_EVERY_MS) return;
    // The line itself is the newest stall; the rest were folded in while rate-limited.
    log.warn({ blockedMs: Math.round(state.suppressedMaxMs), utilization: share(state.logElu), suppressed: state.suppressed - 1 }, 'event loop blocked');
    state.lastLogAt = wall;
    state.logElu = performance.eventLoopUtilization();
    state.suppressed = 0;
    state.suppressedMaxMs = 0;
  }, TICK_MS);
  state.timer.unref();
  return state;
}

/**
 * The stall line says how long, not what. Stalls tend to recur, so profiling the stretch after one
 * names the code. A CPU profile holds code locations only: no heap, arguments or user data.
 */
function profileStalls(state: Monitor, dir: string, log: Log, trigger: { blockedMs: number; stallsInMinute: number }): void {
  const abort = new AbortController();
  let session: Session | undefined;
  const cancel = () => { abort.abort(); session?.disconnect(); };
  state.cancelProfile = cancel;
  void (async () => {
    // The hourly limit outlives the process: a server restarted because it stalls waits its turn.
    const [newest] = await profiles(dir);
    if (newest && Date.now() - (await stat(join(dir, newest))).mtimeMs < PROFILE_EVERY_MS) return;
    // Loaded on use: a Node built without the inspector throws on import.
    const inspector = await import('node:inspector/promises');
    abort.signal.throwIfAborted();
    session = new inspector.Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
    await sleep(PROFILE_MS, undefined, { signal: abort.signal, ref: false });
    const { profile } = await session.post('Profiler.stop');
    session.disconnect();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `stall-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
    await writeFile(file, JSON.stringify(profile), { mode: 0o600 });
    for (const old of (await profiles(dir)).slice(PROFILE_KEEP)) await rm(join(dir, old), { force: true });
    log.warn({ ...trigger, profile: file, top: await hottest(profile) }, 'event loop stall profiled');
  })().catch(error => { if (!abort.signal.aborted) log.warn({ ...trigger, error: error instanceof Error ? error.message : String(error) }, 'event loop stall profile failed'); })
    .finally(() => { session?.disconnect(); if (state.cancelProfile === cancel) state.cancelProfile = undefined; });
}

/** Stall profiles, newest first: the timestamped names sort by time. */
async function profiles(dir: string): Promise<string[]> {
  try { return (await readdir(dir)).filter(name => /^stall-.+\.cpuprofile$/.test(name)).sort().reverse(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

type Frame = Profiler.ProfileNode['callFrame'];
const own = (frame: Frame) => frame.url.startsWith('file:') && !frame.url.includes('/node_modules/');

/** The five places with the most self time; library and native work is charged to the riffet code that called it. */
async function hottest(profile: Profiler.Profile, count = 5): Promise<string[]> {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const totals = new Map<string, { us: number; leaf: Frame; caller?: Frame }>();
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index++) {
    const leaf = nodes.get(samples[index]!)?.callFrame;
    if (!leaf || leaf.functionName === '(idle)') continue;
    let caller: Frame | undefined;
    for (let id = parents.get(samples[index]!); !own(leaf) && !caller && id !== undefined; id = parents.get(id)) if (own(nodes.get(id)!.callFrame)) caller = nodes.get(id)!.callFrame;
    const key = [leaf, caller].map(frame => frame && `${frame.functionName}@${frame.url}:${frame.lineNumber}:${frame.columnNumber}`).join('|');
    const entry = totals.get(key) ?? { us: 0, leaf, caller };
    // A sample lasts until the next one.
    entry.us += deltas[index + 1] ?? 0;
    totals.set(key, entry);
  }
  const maps = new Map<string, Promise<SourceMap | undefined>>();
  return Promise.all([...totals.values()].sort((a, b) => b.us - a.us).slice(0, count).map(async ({ us, leaf, caller }) =>
    `${Math.round(us / 1000)}ms ${await place(leaf, maps)}${caller ? ` ← ${await place(caller, maps)}` : ''}`));
}

/** `name path:line`, with the path relative to the riffet root and mapped back to the source a bundle was built from. */
async function place(frame: Frame, maps: Map<string, Promise<SourceMap | undefined>>): Promise<string> {
  const name = frame.functionName || '(anonymous)';
  if (!frame.url) return name;
  if (!frame.url.startsWith('file:')) return `${name} ${frame.url}:${frame.lineNumber + 1}`;
  let file = fileURLToPath(frame.url), line = frame.lineNumber + 1;
  if (!maps.has(file)) maps.set(file, readFile(`${file}.map`, 'utf8').then(text => new SourceMap(JSON.parse(text))).catch(() => undefined));
  const origin = (await maps.get(file))?.findEntry(frame.lineNumber, frame.columnNumber);
  if (origin && 'originalSource' in origin) { file = resolve(dirname(file), origin.originalSource); line = origin.originalLine + 1; }
  const path = relative(ROOT, file);
  const shown = path.includes('node_modules/') ? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length) : path.startsWith('..') ? file : path;
  return `${name} ${shown}:${line}`;
}

const share = (since: EventLoopUtilization) => Math.round(performance.eventLoopUtilization(since).utilization * 100) / 100;
const utilization = (state: Monitor) => share(state.windowElu);
const toMs = (ns: number) => Number.isFinite(ns) ? Math.round(ns / 1e6) : 0;

/** Recent behaviour of the event loop, for diagnostics. Zeroes when the monitor is not running. */
export function loopHealth(): LoopHealthSnapshot {
  const state = monitor;
  if (!state) return { p50Ms: 0, p99Ms: 0, maxMs: 0, utilization: 0, stalls: 0, recentLagMs: 0 };
  const snapshot: LoopHealthSnapshot = {
    p50Ms: toMs(state.histogram.percentile(50)),
    p99Ms: toMs(state.histogram.percentile(99)),
    maxMs: toMs(state.histogram.max),
    utilization: utilization(state),
    stalls: state.stalls,
    ...(state.lastStallAt ? { lastStallAt: new Date(state.lastStallAt).toISOString() } : {}),
    recentLagMs: recentLag(state),
  };
  // Roll the window so the percentiles describe the last minute, not everything since boot.
  if (Date.now() - state.windowStart >= SNAPSHOT_WINDOW_MS) {
    state.histogram.reset();
    state.windowStart = Date.now();
    state.windowElu = performance.eventLoopUtilization();
  }
  return snapshot;
}

function recentLag(state: Monitor): number {
  const cutoff = Date.now() - LAG_WINDOW_MS;
  return Math.round(Math.max(0, ...state.lags.filter(lag => lag.at >= cutoff).map(lag => lag.ms)));
}

/** Whether the loop is lagging; background jobs defer work while it is. False when not monitoring. */
export function eventLoopBusy(thresholdMs = 100): boolean {
  return monitor !== undefined && recentLag(monitor) > thresholdMs;
}
