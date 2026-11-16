import type { NativeBackendId } from './agent-ids.js';

/** One process the service started or hosts: the server itself, the private tmux server, the CLIs in its panes. */
export interface ServiceProcess {
  pid: number; ppid: number;
  /** `server` is this Node process, `tmux` the private tmux server, `agent` a CLI in a pane, `child` anything else under them or a conversation's app-server daemon. */
  kind: 'server' | 'tmux' | 'agent' | 'child';
  /** Executable name, e.g. `node`, `tmux`, `claude`. */
  name: string;
  /** The full command line, truncated; arguments that look like secrets are masked. */
  command: string;
  /** Share of one core, as `ps` reports it. */
  cpuPercent: number;
  rssBytes: number;
  elapsedSec: number;
  /** The terminal (tmux session) and Riffet session this pane process belongs to, when known. */
  terminalId?: string; sessionId?: string; sessionTitle?: string; backendId?: NativeBackendId;
  /** Only processes in the service's own tree that are not the server itself may be stopped. */
  canTerminate: boolean;
}
/** A 10-second bucket of the service's own load. */
export interface ServiceMonitorSample {
  at: number;
  cpuPercent: number; rssBytes: number; heapUsedBytes: number;
  /** Requests that finished in the bucket, and those of them with a 5xx status. */
  requests: number; errors: number;
  /** Mean latency of the bucket's requests, 0 when there were none. */
  avgMs: number;
  loopLagMs: number; load1: number;
}
export interface ServiceRouteStat { method: string; route: string; count: number; errors: number; avgMs: number; p95Ms: number; }
/** Where a client's figures come from (docs/guide/performance.md §4). */
export type ClientMetricsPlatform = 'mac' | 'web' | 'ios' | 'android';
/** One registered cache: its name in the client's cache registry, what it holds now, and its ceiling. */
export interface ClientCacheSample { name: string; bytes?: number; limitBytes?: number; count?: number }
/** A client's own figures at one moment. `footprintBytes` is the platform's footprint (§2); `hitches` counts main-thread stalls over 100 ms since the previous sample. */
export interface ClientMetricsSample {
  at: number;
  footprintBytes?: number; managedHeapBytes?: number; streams?: number; hitches?: number;
  caches?: ClientCacheSample[];
}
/** `POST /api/system/client-metrics`: one sample. `clientId` tells apart the tabs or apps signed in with one credential. */
export interface ClientMetricsReport {
  clientId: string; platform: ClientMetricsPlatform; appVersion?: string;
  sample: Omit<ClientMetricsSample, 'at'>;
}
/** A client as the monitor shows it: the newest sample with its caches, and the last six hours of the rest. */
export interface ClientMetrics {
  key: string; platform: ClientMetricsPlatform; name?: string; appVersion?: string;
  latest: ClientMetricsSample; peakFootprintBytes?: number;
  /** Oldest first, without `caches`. */
  series: Omit<ClientMetricsSample, 'caches'>[];
}
/** `GET /api/system/monitor`: the running service at a glance, for the settings page. */
export interface ServiceMonitorSnapshot {
  generatedAt: string;
  process: {
    pid: number; version: string; nodeVersion: string; platform: string; arch: string;
    startedAt: string; uptimeSec: number;
    cpuPercent: number; rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number;
  };
  host: { hostname: string; cpuModel: string; cpuCount: number; loadAvg: [number, number, number]; totalMemBytes: number; freeMemBytes: number; uptimeSec: number };
  eventLoop: { p50Ms: number; p99Ms: number; maxMs: number; utilization: number; stalls: number; lastStallAt?: string; recentLagMs: number };
  /** Since the service started. Long-lived streams (SSE, WebSocket) are counted as connections, not requests. */
  requests: {
    total: number; inFlight: number; perMinute: number; avgMs: number; p95Ms: number;
    byStatus: { '2xx': number; '3xx': number; '4xx': number; '5xx': number };
    topRoutes: ServiceRouteStat[];
  };
  connections: { eventStreams: number; terminalSockets: number };
  terminals: { total: number; live: number };
  sessions: { total: number; running: number; waiting: number };
  /** Oldest first, at most the last 30 minutes. */
  series: ServiceMonitorSample[];
  processes: ServiceProcess[];
  /** Clients that reported in the last six hours (§4), most recent first. */
  clients?: ClientMetrics[];
}
