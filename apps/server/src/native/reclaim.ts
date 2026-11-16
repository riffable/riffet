import { DEFAULT_IDLE_RECLAIM_MINUTES, DEFAULT_MAX_LIVE_AGENTS } from '../../../../packages/contracts/src/index.js';
import type { AppSettings, Session, TerminalInfo } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import type { TerminalService } from '../terminal/service.js';
import { isWarmupTerminal } from '../terminal/service.js';
import { isAgentTerminal } from '../terminal/kinds.js';
import type { NativeBackendService } from '../backends/service.js';
import type { SessionLockHandle } from '../agent-host/session-lock.js';
import { sweepWorkbenchAppServers } from '../backends/shared/app-server-daemons.js';
import { appServerCredentialDirs } from '../backends/codex/config.js';
import { appServerOwner } from '../backends/shared/codex-app-server.js';

/** Jupyter's culler checks every five minutes too; nothing here needs to be faster than that. */
const TICK_MS = 5 * 60_000;
const FIRST_TICK_MS = 2 * 60_000;
/** A CLI launched this recently is left alone: Claude Code reads a quick exit as a crashed launch. */
const MIN_LAUNCH_AGE_MS = 10 * 60_000;
/** The live-count cap never takes a conversation used more recently than this. */
const CAP_MIN_IDLE_MS = 30 * 60_000;
/** A tmux session with no record behind it is this old before it counts as stray: creating one saves its record after. */
const STRAY_MIN_AGE_MS = 10 * 60_000;
/** States a conversation can rest in; every other one is a turn in flight, a failure to look at, or archived. */
const RESTING = new Set<Session['state']>(['idle', 'interrupted']);

export interface AgentReclaimDeps {
  store: Store;
  terminal: TerminalService;
  nativeBackends: NativeBackendService;
  runtime: SessionLockHandle;
  settings(): Pick<AppSettings, 'idleReclaimMinutes' | 'maxLiveAgents'>;
  log(message: string, fields: Record<string, unknown>): void;
}

interface LiveAgent { session: Session; terminal?: TerminalInfo; lastUsed: number }

/** A pane as last compared: what it showed, and since when. */
interface PaneScreen { text: string; changedAt: number; checkedAt: number }

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
 * with hundreds of conversations does not keep a process for each one forever.
 *
 * Modelled on Jupyter's kernel culler: a conversation is reclaimed only when it has been idle past
 * the timeout **and** nothing is in flight **and** nobody is viewing it; a cap on live CLIs then takes
 * the least recently used resting ones first. A reclaimed conversation keeps its provider session id,
 * so the next message or "resume" relaunches the CLI on the same thread. Only CLIs that can resume
 * are touched; Droid and DSH stop their own idle processes.
 *
 * Each pass also sweeps what no conversation can reach any more: app-servers an earlier service
 * instance left, tmux sessions without a live terminal record, and CLIs of archived conversations.
 */
export class AgentReclaimer {
  private timer: NodeJS.Timeout | undefined;
  private pass: Promise<unknown> | undefined;
  /** When a viewer was last seen on a conversation, as sampled each pass: watching it is using it. */
  private readonly viewedAt = new Map<string, number>();
  /**
   * Each live pane's settled text. tmux records when a pane last drew, but a spinner or an elapsed
   * timer draws every second, even on a turn hung for days; only a change in what it says is use.
   */
  private readonly screens = new Map<string, PaneScreen>();

  constructor(private readonly deps: AgentReclaimDeps) {}

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
    for (const id of [...this.restarts.keys()]) this.finishRestart(id);
    await this.pass?.catch(() => undefined);
  }

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

    const daemons = new Set(sweep.live.flatMap(server => server.address ? [server.address] : []));
    const strays = await this.deps.terminal.reapStraySessions(STRAY_MIN_AGE_MS, now);
    if (strays.length) this.deps.log('reaped stray terminal sessions', { sessions: strays });
    // Archiving through the API stops the CLI; any other path (an attempt discarded, say) leaves it to this.
    const stale: string[] = [];
    for (const session of all) if (archived(session) && this.liveTerminal(session) && await this.release(session.id)) stale.push(session.id);
    if (stale.length) this.deps.log('stopped CLIs of archived conversations', { sessions: stale });
    // A CLI working on its own leaves no trace in the conversation, and its runtime may not even be loaded;
    // its screen is the one witness that it is busy.
    const drawn = await this.deps.terminal.paneActivity();
    const live: LiveAgent[] = [];
    for (const session of sessions) {
      const terminal = this.liveTerminal(session);
      // A Codex conversation that was only viewed has an app-server and no TUI.
      if (!terminal && !(session.nativeRuntime?.address && daemons.has(session.nativeRuntime.address))) continue;
      if (this.viewed(session, terminal)) this.viewedAt.set(session.id, now);
      const lastUsed = Math.max(Date.parse(session.lastActivityAt ?? session.createdAt) || 0, this.viewedAt.get(session.id) ?? 0, terminal ? Math.max(Date.parse(terminal.createdAt) || 0, await this.screenChangedAt(terminal.id, drawn.get(terminal.id), now)) : 0);
      live.push({ session, ...(terminal ? { terminal } : {}), lastUsed });
    }
    for (const id of this.viewedAt.keys()) if (!live.some(entry => entry.session.id === id)) this.viewedAt.delete(id);
    for (const id of this.screens.keys()) if (!live.some(entry => entry.terminal?.id === id)) this.screens.delete(id);

    const { idleMs, cap } = this.limits();
    const picked = new Set<LiveAgent>();
    if (idleMs) for (const entry of live) if (now - entry.lastUsed >= idleMs && this.reclaimable(entry, now)) picked.add(entry);
    if (cap) {
      let remaining = live.length - picked.size;
      for (const entry of [...live].sort((a, b) => a.lastUsed - b.lastUsed)) {
        if (remaining <= cap) break;
        if (picked.has(entry) || now - entry.lastUsed < CAP_MIN_IDLE_MS || !this.reclaimable(entry, now)) continue;
        picked.add(entry); remaining--;
      }
    }
    const reclaimed: string[] = [];
    for (const entry of picked) if (await this.reclaim(entry, now)) reclaimed.push(entry.session.id);
    if (reclaimed.length) this.deps.log('reclaimed idle agent CLIs', { sessions: reclaimed, live: live.length - reclaimed.length });
    return { reclaimed, swept: sweep.stopped.length };
  }

  private async reclaim(entry: LiveAgent, now: number): Promise<boolean> {
    const { session: picked, lastUsed } = entry;
    const sessionId = picked.id;
    return await this.deps.runtime.withDetachedSession(sessionId, async () => {
      // Re-read under the lock: a message may have arrived, and even finished, since the pass looked.
      let session: Session;
      try { session = this.deps.store.getSession(sessionId); } catch { return false; }
      if (session.archivedAt || session.lastActivityAt !== picked.lastActivityAt) return false;
      const terminal = this.liveTerminal(session);
      // Nor may its screen have moved on since: the CLI took up a turn of its own while the pass was deciding.
      if (terminal && await this.screenChangedAt(terminal.id, (await this.deps.terminal.paneActivity()).get(terminal.id), Date.now()) > lastUsed) return false;
      if (!this.reclaimable({ session, ...(terminal ? { terminal } : {}), lastUsed }, now)) return false;
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
      if (!RESTING.has(session.state) || !this.resumable(session) || session.terminalHold || this.deps.store.listUnfinishedNativeRuns(session.id).length) return false;
      let status;
      try { status = this.deps.nativeBackends.status(session.id); } catch { return false; }
      if (status.phase === 'starting' || status.phase === 'busy' || status.phase === 'attention' || status.interaction || status.activity?.background || status.activity?.compacting) return false;
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
    this.viewedAt.delete(session.id);
    if (terminal) this.screens.delete(terminal.id);
  }

  /**
   * When the pane last showed something new, given when tmux says it last drew. The text is read
   * only when it drew since the last look. A pane seen for the first time counts from that draw.
   */
  private async screenChangedAt(terminalId: string, drawnAt: number | undefined, now: number): Promise<number> {
    if (!drawnAt) return 0;
    const seen = this.screens.get(terminalId);
    if (seen && drawnAt <= seen.checkedAt) return seen.changedAt;
    const text = await this.deps.terminal.paneText(terminalId);
    if (text === undefined) return drawnAt;
    const settled = settledScreen(text);
    const changedAt = seen && seen.text === settled ? seen.changedAt : drawnAt;
    this.screens.set(terminalId, { text: settled, changedAt, checkedAt: now });
    return changedAt;
  }

  private reclaimable(entry: LiveAgent, now: number): boolean {
    const { session, terminal } = entry;
    if (!RESTING.has(session.state) || !this.resumable(session)) return false;
    // A terminal holds it: for Codex that terminal is joined to the very app-server this would stop.
    if (session.terminalHold) return false;
    // Claude Code writes its transcript with the first message; resuming an unused id fails outright.
    if (session.backendId === 'claude' && !session.lastActivityAt && !this.deps.store.listRecentNativeRuns(session.id, 1).length) return false;
    if (terminal && now - (Date.parse(terminal.createdAt) || now) < MIN_LAUNCH_AGE_MS) return false;
    if (this.viewed(session, terminal)) return false;
    if (this.deps.store.listUnfinishedNativeRuns(session.id).length) return false;
    // Only known while the provider runtime is loaded; an unloaded one reports `offline`.
    let status;
    try { status = this.deps.nativeBackends.status(session.id); } catch { return false; }
    if (status.phase === 'starting' || status.phase === 'busy' || status.phase === 'attention') return false;
    return !status.interaction && !status.activity?.background && !status.activity?.compacting;
  }

  /** Whether relaunching continues the same provider thread rather than starting over or asking; a backend that is not installed does not. */
  private resumable(session: Session): boolean {
    return Boolean(session.nativeSessionId && session.backendId && this.deps.nativeBackends.catalog.traits(session.backendId).resumesByNativeId);
  }

  private viewed(session: Session, terminal: TerminalInfo | undefined): boolean {
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

  private limits(): { idleMs: number; cap: number } {
    const settings = this.deps.settings();
    return { idleMs: (settings.idleReclaimMinutes ?? DEFAULT_IDLE_RECLAIM_MINUTES) * 60_000, cap: settings.maxLiveAgents ?? DEFAULT_MAX_LIVE_AGENTS };
  }
}

