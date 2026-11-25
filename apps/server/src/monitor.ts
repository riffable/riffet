import { cpus, freemem, hostname, loadavg, totalmem, uptime } from 'node:os';
import { basename } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';
import { runProcess } from './git/exec.js';
import { listWorkbenchAppServers } from './backends/shared/app-server-daemons.js';
import { appServerOwner } from './backends/shared/codex-app-server.js';
import { appServerCredentialDirs } from './backends/codex/config.js';
import { loopHealth } from './loop-health.js';
import { SERVER_VERSION } from './version.js';
import type { Store } from './store.js';
import type { TerminalService } from './terminal/index.js';
import type { AgentProcessReport, ClientCacheSample, ClientMetrics, ClientMetricsPlatform, ClientMetricsSample, ServiceMonitorSample, ServiceMonitorSnapshot, ServiceProcess, ServiceRouteStat } from '../../../packages/contracts/src/index.js';

const SAMPLE_MS = 10_000;
/** 30 minutes of samples. */
const SERIES_LENGTH = 180;
const LATENCIES_KEPT = 1000;
const ROUTE_LATENCIES_KEPT = 100;
const TOP_ROUTES = 8;
const PROCESSES_SHOWN = 200;
const COMMAND_CHARS = 300;
/** Requests the router matched to no route share one key, so probes cannot grow the table. */
const UNMATCHED = '(unmatched)';

/** The most recent latencies; percentiles over them cost a sort of at most `size` numbers. */
class LatencyRing {
  private readonly values: Float64Array;
  private next = 0;
  private filled = 0;
  constructor(size: number) { this.values = new Float64Array(size); }
  push(ms: number) { this.values[this.next] = ms; this.next = (this.next + 1) % this.values.length; this.filled = Math.min(this.filled + 1, this.values.length); }
  p95(): number {
    if (!this.filled) return 0;
    const sorted = this.values.slice(0, this.filled).sort();
    return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!);
  }
}

interface RouteTally { method: string; route: string; count: number; errors: number; totalMs: number; latencies: LatencyRing }
interface PsRow { pid: number; ppid: number; cpu: number; rssKiB: number; elapsedSec: number; command: string }

export interface ServiceMonitorDeps {
  store: Store; terminal: TerminalService; streams: Set<ServerResponse>;
  /** Active server memory profile (`full` or `lite`). */
  profile?: 'full' | 'lite';
  /** The reclaimer's last pass (docs/guide/performance.md §3.10). */
  agentProcesses?: () => AgentProcessReport | undefined;
  /** Server-side registered caches (`ServerCacheRegistry`). */
  caches?: () => ClientCacheSample[];
}

/**
 * The running service's own load for the settings page: request accounting fed by app hooks, a
 * 30-minute ring of 10-second samples, and the process tree it owns, read from `ps` per request.
 */
export class ServiceMonitor {
  private readonly startedAt = Date.now() - process.uptime() * 1000;
  private total = 0;
  private totalMs = 0;
  private inFlight = 0;
  private readonly byStatus = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  private readonly latencies = new LatencyRing(LATENCIES_KEPT);
  private readonly routes = new Map<string, RouteTally>();
  private bucket = { requests: 0, errors: 0, totalMs: 0, since: Date.now() };
  private readonly series: ServiceMonitorSample[] = [];
  private cpuAt = performance.now();
  private cpu = process.cpuUsage();
  private timer: NodeJS.Timeout | undefined;
  /** What clients report about themselves (`POST /api/system/client-metrics`). */
  readonly clients = new ClientMetricsStore();

  constructor(private readonly deps: ServiceMonitorDeps) {}

  get inFlightRequests(): number { return this.inFlight; }

  /** Before the auth hook, so refused requests are counted too. */
  observe(app: FastifyInstance): void {
    app.addHook('onRequest', async (request, reply) => {
      if (longLived(request)) return;
      this.inFlight++;
      // `close` also fires for a client that went away mid-response, which `onResponse` never sees.
      reply.raw.once('close', () => { this.inFlight--; });
    });
    app.addHook('onResponse', async (request, reply) => {
      if (longLived(request)) return;
      const ms = reply.elapsedTime, status = reply.statusCode, error = status >= 500;
      this.total++; this.totalMs += ms; this.latencies.push(ms);
      const statusClass = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
      this.byStatus[statusClass]++;
      this.bucket.requests++; this.bucket.totalMs += ms; if (error) this.bucket.errors++;
      // The route template, never the URL, so ids do not multiply the keys.
      const route = request.routeOptions.url, method = route ? request.method : '*', key = `${method} ${route ?? UNMATCHED}`;
      let tally = this.routes.get(key);
      if (!tally) this.routes.set(key, tally = { method, route: route ?? UNMATCHED, count: 0, errors: 0, totalMs: 0, latencies: new LatencyRing(ROUTE_LATENCIES_KEPT) });
      tally.count++; tally.totalMs += ms; tally.latencies.push(ms); if (error) tally.errors++;
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.timer.unref();
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  private sample(): void {
    const at = performance.now(), used = process.cpuUsage(this.cpu);
    const cpuPercent = round((used.user + used.system) / 1000 / Math.max(1, at - this.cpuAt) * 100);
    this.cpuAt = at; this.cpu = process.cpuUsage();
    const memory = process.memoryUsage(), { requests, errors, totalMs } = this.bucket;
    this.series.push({ at: Date.now(), cpuPercent, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, requests, errors,
      avgMs: requests ? round(totalMs / requests) : 0, loopLagMs: loopHealth().recentLagMs, load1: round(loadavg()[0]!) });
    if (this.series.length > SERIES_LENGTH) this.series.shift();
    this.bucket = { requests: 0, errors: 0, totalMs: 0, since: Date.now() };
  }

  async snapshot(): Promise<ServiceMonitorSnapshot> {
    const now = Date.now(), memory = process.memoryUsage(), cores = cpus();
    // Before the first sample, the share since start-up.
    const last = this.series.at(-1);
    const cpuPercent = last?.cpuPercent ?? (() => { const used = process.cpuUsage(this.cpu); return round((used.user + used.system) / 1000 / Math.max(1, performance.now() - this.cpuAt) * 100); })();
    const recent = this.series.slice(-6);
    const perMinute = recent.length
      ? Math.round(recent.reduce((sum, sample) => sum + sample.requests, 0) / recent.length * (60_000 / SAMPLE_MS))
      : Math.round(this.bucket.requests * 60_000 / Math.max(1_000, now - this.bucket.since));
    const topRoutes: ServiceRouteStat[] = [...this.routes.values()].sort((a, b) => b.count - a.count).slice(0, TOP_ROUTES)
      .map(tally => ({ method: tally.method, route: tally.route, count: tally.count, errors: tally.errors, avgMs: round(tally.totalMs / tally.count), p95Ms: tally.latencies.p95() }));
    const counts = this.deps.store.stateCounts();
    const agentProcesses = this.deps.agentProcesses?.();
    const sessions = (...states: string[]) => states.reduce((sum, state) => sum + (counts.sessions[state] ?? 0), 0);
    const terminalsTotal = Object.values(counts.terminals).reduce((sum, n) => sum + n, 0);
    const [load1, load5, load15] = loadavg() as [number, number, number];
    const caches = this.deps.caches?.();
    return {
      generatedAt: new Date(now).toISOString(),
      process: {
        pid: process.pid, version: SERVER_VERSION, nodeVersion: process.version, platform: process.platform, arch: process.arch,
        startedAt: new Date(this.startedAt).toISOString(), uptimeSec: Math.round(process.uptime()),
        cpuPercent, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external,
        ...(this.deps.profile ? { profile: this.deps.profile } : {}),
      },
      host: { hostname: hostname(), cpuModel: cores[0]?.model.trim() ?? '', cpuCount: cores.length, loadAvg: [round(load1), round(load5), round(load15)],
        totalMemBytes: totalmem(), freeMemBytes: freemem(), uptimeSec: Math.round(uptime()) },
      eventLoop: loopHealth(),
      requests: { total: this.total, inFlight: this.inFlight, perMinute, avgMs: this.total ? round(this.totalMs / this.total) : 0, p95Ms: this.latencies.p95(),
        byStatus: { ...this.byStatus }, topRoutes },
      connections: { eventStreams: this.deps.streams.size, terminalSockets: this.deps.terminal.viewerCount() },
      // A detached terminal still has its tmux session; only an exited one is gone.
      terminals: { total: terminalsTotal, live: terminalsTotal - (counts.terminals.exited ?? 0) },
      // "Running" as the web title counts it: a turn in flight, including its start and cancellation.
      sessions: { total: Object.values(counts.sessions).reduce((sum, n) => sum + n, 0), running: sessions('starting', 'running', 'cancelling'), waiting: sessions('waiting') },
      series: [...this.series],
      processes: (await this.processes()).slice(0, PROCESSES_SHOWN),
      ...(agentProcesses ? { agentProcesses } : {}),
      ...(caches?.length ? { caches } : {}),
      clients: this.clients.list(now),
    };
  }

  /** Re-reads the tree at call time: a pid from the client is only a request, never a permission. */
  async terminate(raw: string): Promise<void> {
    const pid = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(pid) || pid < 1) throw new AppError('INVALID_PID', 'Process id must be a positive integer');
    const target = (await this.processes()).find(item => item.pid === pid);
    if (!target) throw new AppError('PROCESS_NOT_FOUND', 'This process is not one the service started', 404);
    if (!target.canTerminate) throw new AppError('PROCESS_PROTECTED', 'The service and its tmux server cannot be stopped from here', 403);
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') throw new AppError('PROCESS_NOT_FOUND', 'The process has already exited', 404);
      throw error;
    }
  }

  /**
   * The server, the private tmux server, the app-server daemons conversations own (detached, so
   * outside both trees) and everything under any of them; empty when `ps` cannot be read.
   */
  private async processes(): Promise<ServiceProcess[]> {
    // tmux first: a client still running would show up in the listing as a child of the server.
    const [tmux, daemons] = await Promise.all([this.deps.terminal.paneProcesses(), listWorkbenchAppServers(appServerCredentialDirs()).catch(() => [])]);
    const env = { ...process.env, LC_ALL: 'C' };
    const [table, names] = await Promise.all([
      runProcess('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pcpu=,rss=,etime=,args='], { cwd: process.cwd(), timeoutMs: 3000, env }),
      // `comm` may contain spaces, so it is read on its own where it can be the last column.
      runProcess('ps', ['-A', '-ww', '-o', 'pid=,comm='], { cwd: process.cwd(), timeoutMs: 3000, env }),
    ]);
    if (table.code !== 0 || table.timedOut) return [];
    const rows = new Map<number, PsRow>(), children = new Map<number, number[]>(), comm = new Map<number, string>();
    for (const line of table.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
      if (!match) continue;
      const row = { pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), rssKiB: Number(match[4]), elapsedSec: elapsedSeconds(match[5]!), command: match[6]! };
      rows.set(row.pid, row);
      children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
    }
    if (names.code === 0) for (const line of names.stdout.split('\n')) {
      const match = /^\s*(\d+)\s(.*)$/.exec(line);
      if (match) comm.set(Number(match[1]), basename(match[2]!.trim()));
    }
    const panes = new Map(tmux.panes.map(pane => [pane.pid, pane.terminalId]));
    const owner = new Map<number, string>();
    const result: ServiceProcess[] = [];
    const visit = (root: number, rootKind: 'server' | 'tmux' | 'child', session?: Pick<ServiceProcess, 'sessionId' | 'sessionTitle' | 'backendId'>) => {
      const pending: Array<[number, string | undefined]> = [[root, undefined]];
      while (pending.length) {
        const [pid, inheritedTerminal] = pending.pop()!;
        const row = rows.get(pid);
        if (!row || owner.has(pid)) continue;
        const name = comm.get(pid) ?? basename(row.command.split(' ')[0] ?? '');
        // The listing's own `ps` processes.
        if (row.ppid === process.pid && name === 'ps') continue;
        const terminalId = panes.get(pid) ?? inheritedTerminal;
        const kind: ServiceProcess['kind'] = pid === root ? rootKind : pid === tmux.serverPid ? 'tmux' : pid === process.pid ? 'server' : panes.has(pid) ? 'agent' : 'child';
        owner.set(pid, kind);
        result.push({ pid, ppid: row.ppid, kind, name, command: maskCommand(row.command), cpuPercent: row.cpu, rssBytes: row.rssKiB * 1024, elapsedSec: row.elapsedSec,
          ...(terminalId ? this.terminalOf(terminalId) : session ?? {}), canTerminate: kind !== 'server' && kind !== 'tmux' });
        for (const child of children.get(pid) ?? []) pending.push([child, terminalId]);
      }
    };
    // Daemons first: one this server spawned is still its child, and would otherwise be claimed by the
    // server's tree without the conversation it belongs to.
    if (daemons.length) {
      const owners = new Map<string, Pick<ServiceProcess, 'sessionId' | 'sessionTitle' | 'backendId'>>();
      for (const session of this.deps.store.listSessions()) {
        if (session.nativeRuntime?.address) owners.set(session.nativeRuntime.address, { sessionId: session.id, sessionTitle: session.displayTitle ?? session.title, ...(session.backendId ? { backendId: session.backendId } : {}) });
      }
      // Another workbench instance's daemons are its own business.
      const ownTag = appServerOwner();
      for (const daemon of daemons) {
        const session = daemon.address ? owners.get(daemon.address) : undefined;
        // The group leader (a wrapper) may have exited while the native child still serves.
        if (session || (ownTag && daemon.owner === ownTag)) visit(rows.has(daemon.pgid) ? daemon.pgid : daemon.pid, 'child', session);
      }
    }
    visit(process.pid, 'server');
    if (tmux.serverPid) visit(tmux.serverPid, 'tmux');
    const rank = { server: 0, tmux: 1, agent: 2, child: 3 };
    return result.sort((a, b) => rank[a.kind] - rank[b.kind] || b.cpuPercent - a.cpuPercent);
  }

  private terminalOf(terminalId: string): Pick<ServiceProcess, 'terminalId' | 'sessionId' | 'sessionTitle' | 'backendId'> {
    const sessionId = this.deps.store.findTerminal(terminalId)?.sessionId;
    if (!sessionId) return { terminalId };
    try {
      const session = this.deps.store.getSession(sessionId);
      return { terminalId, sessionId, sessionTitle: session.displayTitle ?? session.title, ...(session.backendId ? { backendId: session.backendId } : {}) };
    } catch { return { terminalId, sessionId }; }
  }
}

/** SSE streams and websockets live as long as the page that opened them; they are counted as connections instead. */
function longLived(request: FastifyRequest): boolean {
  return (request as FastifyRequest & { ws?: boolean }).ws === true || /\/(stream|ws)$/.test(request.routeOptions.url ?? '');
}

/** `ps` elapsed time: `[[dd-]hh:]mm:ss`. */
function elapsedSeconds(text: string): number {
  const [days, clock] = text.includes('-') ? text.split('-') as [string, string] : ['0', text];
  return clock.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) + Number(days) * 86_400 || 0;
}

const SECRET_NAME = 'key|token|secret|passw(?:or)?d|auth|credential|cookie';
const SECRET_FLAG = new RegExp(`(?<![\\w-])(--?[\\w-]*(?:${SECRET_NAME})[\\w-]*)(=|\\s+)(?!-)("[^"]*"|'[^']*'|\\S+)`, 'gi');
const SECRET_ENV = new RegExp(`\\b((?:[A-Za-z_]\\w*)?(?:${SECRET_NAME})\\w*)=("[^"]*"|'[^']*'|\\S+)`, 'gi');
/**
 * A long word outside a path whose dash-separated parts include a 20+ character mix of letters and
 * digits reads as a key or token; UUIDs and model names (short parts) stay readable.
 */
const BLOB = /(?<![\w/.-])[A-Za-z0-9+_-]{20,}={0,2}(?![\w/.+-])/g;
const tokenLike = (part: string) => part.length >= 20 && /\d/.test(part) && /[A-Za-z]/.test(part);

/** Argument values that look like credentials are replaced before the command line leaves the server. */
function maskCommand(command: string): string {
  const masked = command
    .replace(SECRET_FLAG, (_all, flag: string, separator: string) => `${flag}${separator}***`)
    .replace(SECRET_ENV, (_all, name: string) => `${name}=***`)
    .replace(BLOB, blob => blob.split(/[-_]/).some(tokenLike) ? '***' : blob);
  return masked.length > COMMAND_CHARS ? `${masked.slice(0, COMMAND_CHARS - 1)}…` : masked;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Six hours at the clients' five-minute cadence (docs/guide/performance.md §4). */
const CLIENT_KEPT_MS = 6 * 60 * 60_000;
const CLIENT_SERIES_LENGTH = 80;
const MAX_CLIENTS = 32;
const MAX_CACHES = 32;
/** A client may not report more often than this; a faster one is answered and dropped. */
const MIN_INTERVAL_MS = 30_000;
const PLATFORMS: readonly ClientMetricsPlatform[] = ['mac', 'web', 'ios', 'android'];

interface Entry extends Omit<ClientMetrics, 'series'> { series: Omit<ClientMetricsSample, 'caches'>[]; seenAt: number }

const bytes = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(Math.min(value, 2 ** 50)) : undefined;
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const defined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;

function cache(value: unknown): ClientCacheSample | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>, name = text(item.name, 64);
  return name ? defined({ name, bytes: bytes(item.bytes), limitBytes: bytes(item.limitBytes), count: bytes(item.count) }) : undefined;
}

/**
 * The figures clients report about themselves, held in memory only: a client's newest sample and a
 * bounded series, dropped six hours after it last reported. Numbers and cache names only.
 */
export class ClientMetricsStore {
  private readonly entries = new Map<string, Entry>();

  /** `credential` is the paired device id, or `cookie` for a browser signed in with the access token. */
  record(credential: string, body: unknown, name?: string, now = Date.now()): void {
    if (!body || typeof body !== 'object') throw new AppError('INVALID_METRICS', 'Metrics must be an object', 400);
    const report = body as Record<string, unknown>;
    const clientId = text(report.clientId, 64), platform = report.platform as ClientMetricsPlatform;
    if (!clientId || !PLATFORMS.includes(platform)) throw new AppError('INVALID_METRICS', 'Metrics need a clientId and a platform', 400);
    const raw = report.sample && typeof report.sample === 'object' ? report.sample as Record<string, unknown> : {};
    const caches = Array.isArray(raw.caches) ? raw.caches.slice(0, MAX_CACHES).map(cache).filter((item) => item !== undefined) : undefined;
    const sample: ClientMetricsSample = defined({
      at: now, footprintBytes: bytes(raw.footprintBytes), managedHeapBytes: bytes(raw.managedHeapBytes),
      streams: bytes(raw.streams), hitches: bytes(raw.hitches), caches,
    });
    const key = `${credential}:${clientId}`;
    const entry = this.entries.get(key);
    if (entry && now - entry.latest.at < MIN_INTERVAL_MS) return;
    const { caches: _caches, ...point } = sample;
    const next: Entry = entry ?? { key, platform, latest: sample, series: [], seenAt: now };
    next.platform = platform;
    next.latest = sample;
    next.seenAt = now;
    const version = text(report.appVersion, 40);
    if (version) next.appVersion = version;
    if (name) next.name = name.slice(0, 80);
    if (sample.footprintBytes !== undefined) next.peakFootprintBytes = Math.max(next.peakFootprintBytes ?? 0, sample.footprintBytes);
    next.series.push(point);
    while (next.series.length > CLIENT_SERIES_LENGTH || (next.series[0] && now - next.series[0].at > CLIENT_KEPT_MS)) next.series.shift();
    this.entries.delete(key);
    this.entries.set(key, next);
    this.prune(now);
  }

  /** Most recent first. */
  list(now = Date.now()): ClientMetrics[] {
    this.prune(now);
    return [...this.entries.values()].reverse().map(({ seenAt: _seen, ...entry }) => ({ ...entry, series: [...entry.series] }));
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (now - entry.seenAt > CLIENT_KEPT_MS) this.entries.delete(key);
    // Insertion order is report order: the first entries are the longest silent.
    while (this.entries.size > MAX_CLIENTS) this.entries.delete(this.entries.keys().next().value!);
  }
}
