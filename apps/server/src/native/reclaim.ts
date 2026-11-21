import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { AGENT_PROCESS_BUDGET } from '../../../../packages/contracts/src/index.js';
import type { AgentProcessReport, AgentProcessUsage, AgentRetention, AppSettings, Session, TerminalInfo } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import type { TerminalService } from '../terminal/service.js';
import { isWarmupTerminal } from '../terminal/service.js';
import { isAgentTerminal } from '../terminal/kinds.js';
import type { TmuxServerProcess } from '../terminal/orphans.js';
import type { NativeBackendService } from '../backends/service.js';
import type { SessionLockHandle } from '../agent-host/session-lock.js';
import { sweepWorkbenchAppServers, type WorkbenchAppServer } from '../backends/shared/app-server-daemons.js';
import { appServerCredentialDirs } from '../backends/codex/config.js';
import { appServerOwner } from '../backends/shared/codex-app-server.js';
import { agentMemory, memoryPressure, type AgentProcessRoots, type MemoryPressure } from './agent-processes.js';

/** A tmux session with no record behind it is this old before it counts as stray: creating one saves its record after. */
const ORPHAN_GRACE_MS = AGENT_PROCESS_BUDGET.orphanGraceMinutes * 60_000;
const TICK_MS = AGENT_PROCESS_BUDGET.passMinutes * 60_000;
const FIRST_TICK_MS = 2 * 60_000;
const MIN_LAUNCH_AGE_MS = AGENT_PROCESS_BUDGET.minLaunchAgeMinutes * 60_000;
const MEMORY_MIN_IDLE_MS = AGENT_PROCESS_BUDGET.memoryMinIdleMinutes * 60_000;
const MIB = 1024 * 1024;
const USAGE_FILE_VERSION = 1;

export interface AgentReclaimDeps {
  store: Store;
  terminal: TerminalService;
  nativeBackends: NativeBackendService;
  runtime: SessionLockHandle;
  settings(): Pick<AppSettings, 'idleReclaimMinutes' | 'maxAgentMemoryMb'>;
  log(message: string, fields: Record<string, unknown>): void;
  /** Where `lastUsedAt` and pane captures persist across restarts; in memory only when absent. */
  usageFile?: string;
  /** Resident memory per conversation; `agentMemory` when absent. */
  memory?: (roots: ReadonlyMap<string, AgentProcessRoots>) => Promise<Map<string, number>>;
  /** `memoryPressure` when absent. */
  pressure?: () => Promise<MemoryPressure>;
  /** Ends unreachable tmux servers of other instances; not run when absent. */
  sweepOrphans?: () => Promise<TmuxServerProcess[]>;
}

interface LiveAgent {
  session: Session; terminal?: TerminalInfo; appServer?: WorkbenchAppServer;
  lastUsed: number; retainedBy: AgentRetention[]; rssBytes: number;
}

/** What persists per conversation: when it was last used, and its pane as last captured. */
interface UsageRecord {
  lastUsedAt: number;
  /** A digest of the settled pane text (`settledScreen`), the terminal it was read from, and when. */
  screen?: { terminalId: string; digest: string; checkedAt: number };
}

/** States a conversation can rest in. */
const RESTING = new Set<Session['state']>(['idle', 'interrupted']);
/** States in which it waits on its owner: a question, a permission, a failure to look at. */
const ATTENDED = new Set<Session['state']>(['waiting', 'failed']);

/**
 * A pane's text without what animates on its own: spinner glyphs, elapsed times and clocks, the
 * rotating verb of a busy line and the tips under it. What is left changes only when the CLI makes
 * progress — a new line, a token count, another prompt.
 */
export function settledScreen(text: string): string {
  return text.split('\n')
    .filter(line => !/^[\s│└⎿]*Tip:/.test(line))
    .map(line => line.includes('esc to interrupt') ? line.replace(/^[^(]*\(/, '(') : line)
    .join('\n')
    .replace(/(?<![\w.])\d+(?:\.\d+)?\s?(?:ms|[hms])(?:\s?\d+(?:\.\d+)?\s?(?:ms|[hms]))*\b/g, '#')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '#')
    .replace(/[\u00b7*\u2022\u23e9-\u23fa\u25a0-\u25ff\u2700-\u27bf\u2800-\u28ff]/g, '~')
    // A right-aligned timer shifts its padding as it grows.
    .replace(/[ \t]+/g, ' ');
}


/**
 * Stops the CLIs of conversations nobody is using, and the app-servers they own, so that a workbench
 * with hundreds of conversations does not keep a process for each one (docs/guide/performance.md §3.10).
 *
 * A conversation's CLI is stopped when nothing retains it (`AgentRetention`) and either it has gone
 * unused past the idle threshold, or the CLIs together hold more memory than the budget and it is
 * among the least recently used. Use is when a turn starts or ends, when a client is subscribed, and
 * when its pane shows something new; it persists across restarts. A stopped conversation keeps its
 * provider session id, so the next message relaunches the CLI on the same thread. Only CLIs that can
 * resume are touched; Droid, Pi and DSH stop their own idle processes.
 *
 * Each pass also sweeps what no conversation can reach any more: app-servers an earlier service
 * instance left, tmux sessions without a live terminal record, tmux servers of temp instances that
 * are gone, and CLIs of archived conversations.
 */
export class AgentReclaimer {
  private timer: NodeJS.Timeout | undefined;
  private pass: Promise<unknown> | undefined;
  private readonly usage = new Map<string, UsageRecord>();
  private dirty = false;
  private stopping = false;
  private last: AgentProcessReport | undefined;

  constructor(private readonly deps: AgentReclaimDeps) {
    if (deps.usageFile) this.load(deps.usageFile);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref();
      void this.tick();
    }, FIRST_TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer); clearInterval(this.timer); this.timer = undefined;
    // A pass in progress stops between CLIs, so shutdown does not wait for every stop it planned.
    this.stopping = true;
    for (const id of [...this.restarts.keys()]) this.finishRestart(id);
    await this.pass?.catch(() => undefined);
    await this.save();
  }

  /** The last pass's findings, for the service monitor. */
  report(): AgentProcessReport | undefined { return this.last; }

  /** One pass; overlapping calls share the pass in progress. */
  tick(now = Date.now()): Promise<{ reclaimed: string[]; swept: number }> {
    if (this.pass) return this.pass as Promise<{ reclaimed: string[]; swept: number }>;
    const pass = this.run(now).catch(error => {
      this.deps.log('agent reclaim pass failed', { error: error instanceof Error ? error.message : String(error) });
      return { reclaimed: [], swept: 0 };
    }).finally(() => { if (this.pass === pass) this.pass = undefined; });
    this.pass = pass;
    return pass;
  }

  private async run(now: number): Promise<{ reclaimed: string[]; swept: number }> {
    const all = this.deps.store.listSessions(), archived = (session: Session) => Boolean(session.archivedAt) || session.state === 'archived';
    const sessions = all.filter(session => !archived(session));
    const bindings = (list: Session[]) => new Set(list.flatMap(session => session.nativeRuntime?.address ? [session.nativeRuntime.address] : []));
    const owner = appServerOwner();
    const sweep = await sweepWorkbenchAppServers({ ...(owner ? { owner } : {}), bound: bindings(sessions), archived: bindings(all.filter(archived)) }, appServerCredentialDirs());
    if (sweep.stopped.length || sweep.removedArtifacts) this.deps.log('swept unreachable app-servers', { stopped: sweep.stopped.map(server => server.pgid), removedArtifacts: sweep.removedArtifacts });
    await this.deps.terminal.claimServer?.();
    const strays = await this.deps.terminal.reapStraySessions(ORPHAN_GRACE_MS, now);
    if (strays.length) this.deps.log('reaped stray terminal sessions', { sessions: strays });
    const orphans = await this.deps.sweepOrphans?.().catch(() => []) ?? [];
    if (orphans.length) this.deps.log('ended unreachable tmux servers', { servers: orphans.map(server => ({ pid: server.pid, socket: server.socket })) });
    // Archiving through the API stops the CLI; any other path (an attempt discarded, say) leaves it to this.
    const stale: string[] = [];
    for (const session of all) if (archived(session) && this.liveTerminal(session) && await this.release(session.id)) stale.push(session.id);
    if (stale.length) this.deps.log('stopped CLIs of archived conversations', { sessions: stale });

    const daemons = new Map(sweep.live.flatMap(server => server.address ? [[server.address, server] as const] : []));
    // A CLI working on its own leaves no trace in the conversation, and its runtime may not even be loaded;
    // its screen is the one witness that it is busy.
    const [drawn, panes] = await Promise.all([this.deps.terminal.paneActivity(), this.deps.terminal.paneProcesses()]);
    const panePids = new Map(panes.panes.map(pane => [pane.terminalId, pane.pid]));
    const live: LiveAgent[] = [];
    for (const session of sessions) {
      const terminal = this.liveTerminal(session);
      // A Codex conversation that was only viewed has an app-server and no TUI.
      const appServer = session.nativeRuntime?.address ? daemons.get(session.nativeRuntime.address) : undefined;
      if (!terminal && !appServer) continue;
      const record = this.record(session.id);
      if (this.subscribed(session, terminal)) this.touch(record, now);
      const screen = terminal ? await this.observe(record, terminal.id, drawn.get(terminal.id), now) : 'same';
      const lastUsed = Math.max(Date.parse(session.lastActivityAt ?? session.createdAt) || 0, record.lastUsedAt, terminal ? Date.parse(terminal.createdAt) || 0 : 0);
      live.push({ session, ...(terminal ? { terminal } : {}), ...(appServer ? { appServer } : {}), lastUsed, retainedBy: this.retention(session, terminal, screen, now), rssBytes: 0 });
    }
    const liveIds = new Set(live.map(entry => entry.session.id));
    for (const id of [...this.usage.keys()]) if (!liveIds.has(id)) { this.usage.delete(id); this.dirty = true; }

    const roots = new Map(live.map(entry => [entry.session.id, { ...(entry.terminal && panePids.has(entry.terminal.id) ? { panePid: panePids.get(entry.terminal.id)! } : {}), ...(entry.appServer ? { appServerPgid: entry.appServer.pgid } : {}) }]));
    const [memory, pressure] = await Promise.all([
      (this.deps.memory ?? agentMemory)(roots).catch(() => new Map<string, number>()),
      (this.deps.pressure ?? memoryPressure)().catch((): MemoryPressure => 'normal'),
    ]);
    for (const entry of live) entry.rssBytes = memory.get(entry.session.id) ?? 0;

    const { idleMs, memoryLimit } = this.limits(pressure);
    const picked = new Set<LiveAgent>();
    if (idleMs) for (const entry of live) if (!entry.retainedBy.length && now - entry.lastUsed >= idleMs) picked.add(entry);
    const total = live.reduce((sum, entry) => sum + entry.rssBytes, 0);
    if (memoryLimit) {
      let remaining = total - [...picked].reduce((sum, entry) => sum + entry.rssBytes, 0);
      for (const entry of [...live].sort((a, b) => a.lastUsed - b.lastUsed)) {
        if (remaining <= memoryLimit) break;
        // Stopping a CLI whose memory could not be read frees nothing that can be counted.
        if (picked.has(entry) || !entry.rssBytes || entry.retainedBy.length || now - entry.lastUsed < MEMORY_MIN_IDLE_MS) continue;
        picked.add(entry); remaining -= entry.rssBytes;
      }
    }
    const reclaimed: string[] = [];
    for (const entry of picked) {
      if (this.stopping) break;
      if (await this.reclaim(entry, now)) reclaimed.push(entry.session.id);
    }
    const stopped = new Set(reclaimed);
    const kept = live.filter(entry => !stopped.has(entry.session.id)).sort((a, b) => a.lastUsed - b.lastUsed);
    if (reclaimed.length) this.deps.log('reclaimed idle agent CLIs', { sessions: reclaimed, live: kept.length, memoryBytes: total, pressure });
    this.last = {
      checkedAt: new Date(now).toISOString(), idleMinutes: Math.round(idleMs / 60_000), memoryLimitBytes: memoryLimit, pressure,
      memoryBytes: kept.reduce((sum, entry) => sum + entry.rssBytes, 0),
      agents: kept.map((entry): AgentProcessUsage => ({
        sessionId: entry.session.id, ...(entry.terminal ? { terminalId: entry.terminal.id } : {}), rssBytes: entry.rssBytes,
        lastUsedAt: new Date(entry.lastUsed).toISOString(), retainedBy: entry.retainedBy,
        ...(!entry.retainedBy.length && idleMs ? { reclaimAt: new Date(entry.lastUsed + idleMs).toISOString() } : {}),
      })),
    };
    await this.save();
    return { reclaimed, swept: sweep.stopped.length + orphans.length };
  }

  private async reclaim(entry: LiveAgent, now: number): Promise<boolean> {
    const { session: picked } = entry;
    const sessionId = picked.id;
    return await this.deps.runtime.withDetachedSession(sessionId, async () => {
      // Re-read under the lock: a message may have arrived, and even finished, since the pass looked.
      let session: Session;
      try { session = this.deps.store.getSession(sessionId); } catch { return false; }
      if (session.archivedAt || session.lastActivityAt !== picked.lastActivityAt) return false;
      const terminal = this.liveTerminal(session);
      // Nor may its screen have moved on since, or be unreadable: the CLI may have taken up a turn of its
      // own while the pass was deciding.
      const screen = terminal ? await this.observe(this.record(sessionId), terminal.id, Number.MAX_SAFE_INTEGER, now) : 'same';
      if (screen !== 'same' || this.retention(session, terminal, screen, now).length) return false;
      // The same order as closing a native terminal by hand: the provider runtime (and its app-server)
      // first, then the CLI itself.
      await this.stopAgent(session, terminal);
      return true;
    }).catch(error => {
      this.deps.log('agent reclaim failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
      return false;
    });
  }

  /**
   * Stops [sessionId]'s CLI as soon as it rests, watched or not, so its next message starts it again with what
   * changed in its launch (a pack added to the 助理). One that is working is stopped when that work ends.
   */
  restartWhenRested(sessionId: string): void {
    if (this.restarts.has(sessionId)) return;
    const attempt = async (): Promise<boolean> => await this.deps.runtime.withDetachedSession(sessionId, async () => {
      let session: Session;
      try { session = this.deps.store.getSession(sessionId); } catch { return true; }
      if (session.archivedAt) return true;
      const terminal = this.liveTerminal(session);
      if (!terminal) return true;
      if (this.work(session).length || !this.resumable(session)) return false;
      await this.stopAgent(session, terminal);
      return true;
    }).catch(() => false);
    const off = this.deps.store.onSessionState((session) => {
      if (session.id !== sessionId || !RESTING.has(session.state)) return;
      setImmediate(() => { void attempt().then(done => { if (done) this.finishRestart(sessionId); }); });
    });
    this.restarts.set(sessionId, off);
    void attempt().then(done => { if (done) this.finishRestart(sessionId); });
  }

  private readonly restarts = new Map<string, () => void>();
  private finishRestart(sessionId: string): void { this.restarts.get(sessionId)?.(); this.restarts.delete(sessionId); }

  /** Stops an archived conversation's CLI that is still running; whatever it was doing, nobody can reach it. */
  private async release(sessionId: string): Promise<boolean> {
    return await this.deps.runtime.withDetachedSession(sessionId, async () => {
      let session: Session;
      try { session = this.deps.store.getSession(sessionId); } catch { return false; }
      if (!session.archivedAt && session.state !== 'archived') return false;
      await this.stopAgent(session, this.liveTerminal(session));
      return true;
    }).catch(error => {
      this.deps.log('stopping an archived CLI failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
      return false;
    });
  }

  private async stopAgent(session: Session, terminal: TerminalInfo | undefined): Promise<void> {
    await this.deps.nativeBackends.dispose(session.id);
    if (terminal && this.deps.store.getTerminal(terminal.id).state !== 'exited') await this.deps.terminal.stop(terminal.id);
    if (this.usage.delete(session.id)) this.dirty = true;
  }

  /**
   * Compares the pane with its last capture. tmux's draw time only says whether reading it again is
   * worth it: tmux marks every window drawn every few minutes, and a spinner draws every second.
   * `unobserved` when there is no earlier capture of this terminal to compare with, or none could be
   * taken now that one was due; a change counts as use.
   */
  private async observe(record: UsageRecord, terminalId: string, drawnAt: number | undefined, now: number): Promise<'changed' | 'same' | 'unobserved'> {
    const seen = record.screen?.terminalId === terminalId ? record.screen : undefined;
    if (drawnAt === undefined) return seen ? 'same' : 'unobserved';
    if (seen && drawnAt <= seen.checkedAt) return 'same';
    const text = await this.deps.terminal.paneText(terminalId);
    if (text === undefined) return 'unobserved';
    const digest = createHash('sha256').update(settledScreen(text)).digest('base64url');
    record.screen = { terminalId, digest, checkedAt: now };
    this.dirty = true;
    if (!seen) return 'unobserved';
    if (seen.digest === digest) return 'same';
    this.touch(record, now);
    return 'changed';
  }

  /** Everything that keeps this conversation's CLI running now; empty when it may be stopped. */
  private retention(session: Session, terminal: TerminalInfo | undefined, screen: 'changed' | 'same' | 'unobserved', now: number): AgentRetention[] {
    const reasons = this.work(session);
    if (this.subscribed(session, terminal)) reasons.push('subscribed');
    if (terminal && now - (Date.parse(terminal.createdAt) || now) < MIN_LAUNCH_AGE_MS) reasons.push('launching');
    if (screen === 'unobserved') reasons.push('unobserved');
    if (!this.resumable(session)) reasons.push('not-resumable');
    return [...new Set(reasons)];
  }

  /** What the conversation is doing: a turn, something it waits on its owner for, background work. */
  private work(session: Session): AgentRetention[] {
    const reasons: AgentRetention[] = [];
    if (ATTENDED.has(session.state)) reasons.push('interaction');
    else if (!RESTING.has(session.state)) reasons.push('turn');
    if (this.deps.store.listUnfinishedNativeRuns(session.id).some(run => !run.native?.queueReleasedAt)) reasons.push('turn');
    // A terminal holds it: for Codex that terminal is joined to the very app-server this would stop.
    if (session.terminalHold) reasons.push('terminal-held');
    // Only known while the provider runtime is loaded; an unloaded one reports `offline`.
    let status;
    try { status = this.deps.nativeBackends.status(session.id); } catch { reasons.push('turn'); return reasons; }
    if (status.phase === 'starting' || status.phase === 'busy') reasons.push('turn');
    if (status.phase === 'attention' || status.interaction) reasons.push('interaction');
    if (status.activity?.background || status.activity?.compacting) reasons.push('background');
    return reasons;
  }

  /** Whether relaunching continues the same provider thread rather than starting over or asking; a backend that is not installed does not. */
  private resumable(session: Session): boolean {
    if (!session.nativeSessionId || !session.backendId || !this.deps.nativeBackends.catalog.traits(session.backendId).resumesByNativeId) return false;
    // Claude Code writes its transcript with the first message; resuming an unused id fails outright.
    return !(session.backendId === 'claude' && !session.lastActivityAt && !this.deps.store.listRecentNativeRuns(session.id, 1).length);
  }

  private subscribed(session: Session, terminal: TerminalInfo | undefined): boolean {
    return this.deps.nativeBackends.hasListeners(session.id) || Boolean(terminal && this.deps.terminal.hasViewer(terminal.id));
  }

  /** The conversation's own CLI terminal while it runs; never a shell, a login or an unclaimed warm-up. */
  private liveTerminal(session: Session): TerminalInfo | undefined {
    if (!session.terminalId) return undefined;
    try {
      const terminal = this.deps.store.getTerminal(session.terminalId);
      if (terminal.sessionId !== session.id || !isAgentTerminal(terminal)) return undefined;
      return terminal.state === 'exited' || isWarmupTerminal(terminal) ? undefined : terminal;
    } catch { return undefined; }
  }

  private limits(pressure: MemoryPressure): { idleMs: number; memoryLimit: number } {
    const settings = this.deps.settings();
    const idleMs = (settings.idleReclaimMinutes ?? AGENT_PROCESS_BUDGET.idleMinutes) * 60_000;
    const memoryLimit = settings.maxAgentMemoryMb !== undefined ? settings.maxAgentMemoryMb * MIB : AGENT_PROCESS_BUDGET.memoryBytes;
    return { idleMs: pressure === 'normal' ? idleMs : Math.round(idleMs / AGENT_PROCESS_BUDGET.pressureIdleDivisor), memoryLimit };
  }

  private record(sessionId: string): UsageRecord {
    let record = this.usage.get(sessionId);
    if (!record) { record = { lastUsedAt: 0 }; this.usage.set(sessionId, record); this.dirty = true; }
    return record;
  }

  private touch(record: UsageRecord, now: number): void {
    if (record.lastUsedAt >= now) return;
    record.lastUsedAt = now;
    this.dirty = true;
  }

  private load(path: string): void {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; sessions?: Record<string, UsageRecord> };
      if (value.version !== USAGE_FILE_VERSION || !value.sessions || typeof value.sessions !== 'object') return;
      // A time ahead of the clock (it was set back) would hold a CLI, or skip reading its pane, until then.
      const now = Date.now();
      for (const [id, record] of Object.entries(value.sessions)) {
        if (!record || typeof record.lastUsedAt !== 'number') continue;
        const screen = record.screen;
        const valid = screen && typeof screen.digest === 'string' && typeof screen.terminalId === 'string' && typeof screen.checkedAt === 'number';
        this.usage.set(id, { lastUsedAt: Math.min(record.lastUsedAt, now), ...(valid ? { screen: { terminalId: screen.terminalId, digest: screen.digest, checkedAt: Math.min(screen.checkedAt, now) } } : {}) });
      }
    } catch { /* absent or unreadable: every CLI starts unobserved */ }
  }

  private async save(): Promise<void> {
    const path = this.deps.usageFile;
    if (!path || !this.dirty) return;
    this.dirty = false;
    const temp = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: USAGE_FILE_VERSION, sessions: Object.fromEntries(this.usage) }), { mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      this.dirty = true;
      this.deps.log('saving agent usage failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
