import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { NativeBackendId, Project, TerminalInfo, TerminalServerMessage } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { Store } from '../store.js';
import { deriveSessionState, sessionStatePatch } from '../backends/service.js';
import { redactSensitiveText } from '../settings/config-documents.js';
import { stripTerminalSequences } from '../../../../packages/plugin-api/src/kit/terminal-text.js';
import { ControlClient } from './control.js';
import { OuterTerminalState } from './protocol-state.js';
import { assembleSeed, seedCommands, seedLine, SEED_BLOCKS, type Seed } from './seed.js';
import {
  appearanceCommands, ATTACH_STABLE_MS, BACKGROUND_COLS, BACKGROUND_RESIZE_DELAY_MS, BACKGROUND_ROWS,
  HISTORY_CAPTURE_BYTES, IDLE_DETACH_DEFAULT_MS, isAgentTerminal, isWarmupTerminal, MAX_UNACKED_CHARS,
  observationFor, OutputTail, parsePaneExitCode, REATTACH_DELAY_MS, REATTACH_MAX_DELAY_MS,
  RESEED_MAX_WAIT_MS, SEED_RETRY_MAX_MS, SEED_RETRY_MS, SNAPSHOT_OUTPUT_QUIET_MS, STARTUP_SCAN_LINES,
  terminalName, warmupOf,
  type TerminalBehaviour, type TerminalObservation, type TerminalObserver, type TerminalRuntime,
  type TerminalSubscription, type Viewer,
} from './shared.js';

export interface TerminalStreamDeps {
  store: Store;
  socketPath: string;
  idleDetachMs?: number;
  runtime: Map<string, TerminalRuntime>;
  listeners: Map<string, Set<Viewer>>;
  observers: Map<string, Set<TerminalObserver>>;
  attachFailures: Map<string, number>;
  snapshotTimers: Map<string, NodeJS.Timeout>;
  idleDetachTimers: Map<string, NodeJS.Timeout>;
  finalizations: Map<string, Promise<void>>;
  stopping: Set<string>;
  isShuttingDown(): boolean;
  inputAvailable(terminal: TerminalInfo): void;
  hasExclusiveOperation(id: string): boolean;
  invalidateScreen(id: string): void;
  ensureRestored(id: string): Promise<void>;
  assertTmuxVersion(): Promise<void>;
  ensureModernServerOptions(): Promise<void>;
  paneFeatures(): Promise<boolean>;
  tmux(args: string[]): Promise<string>;
  runTmux(args: string[], timeout?: number, extraEnv?: NodeJS.ProcessEnv, maxBuffer?: number): Promise<string>;
  tmuxProcessEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  killSession(id: string): Promise<void>;
  resizeWindow(id: string, cols: number, rows: number): Promise<void>;
  behaviourFor(kind: TerminalInfo['kind'], sessionId: string | undefined, backendId: NativeBackendId | undefined): TerminalBehaviour | undefined;
}

export class TerminalStream {
  constructor(private readonly deps: TerminalStreamDeps) {}

  /**
   * A viewer first gets a `snapshot` (the pane's scrollback, screen and modes, see `seed.ts`), then the
   * pane's output. Protocol 3 viewers ack what they have written; one that falls too far behind is
   * dropped to a fresh snapshot instead of being disconnected. Protocol 2 snapshots carry the
   * screen only, because those clients read the scrollback from `history()`.
   */
  subscribe(id: string, callback: (message: TerminalServerMessage) => void, options: { protocol?: number } = {}): TerminalSubscription {
    const viewer: Viewer = { send: callback, protocol: options.protocol ?? 2, unacked: 0, seedChars: 0, seeding: true, seedInFlight: false, seedTicket: 0, closed: false };
    const group = this.deps.listeners.get(id) ?? new Set<Viewer>();
    group.add(viewer);
    this.deps.listeners.set(id, group);
    this.cancelIdleDetach(id);
    void this.deps.ensureRestored(id).then(async () => {
      if (viewer.closed) return;
      const info = this.deps.store.getTerminal(id);
      if (info.state !== 'exited') await this.attach(info, this.deps.store.getProject(info.projectId));
      if (viewer.closed) return;
      callback({ type: 'state', terminal: this.deps.store.getTerminal(id) });
      if (viewer.seeding && !viewer.seedInFlight) this.seedViewers(id, [viewer]);
    }).catch(error => {
      callback({ type: 'error', code: error instanceof AppError ? error.code : 'TERMINAL_UNAVAILABLE', message: error instanceof AppError ? error.message : 'Terminal is unavailable' });
    });
    const unsubscribe = () => {
      viewer.closed = true;
      group.delete(viewer);
      if (group.size === 0 && this.deps.listeners.get(id) === group) {
        this.deps.listeners.delete(id);
        setTimeout(() => this.restoreBackgroundSize(id), BACKGROUND_RESIZE_DELAY_MS).unref?.();
        this.scheduleIdleDetach(id);
      }
    };
    return Object.assign(unsubscribe, {
      ack: (chars: number) => {
        if (!Number.isFinite(chars) || chars <= 0) return;
        viewer.unacked = Math.max(0, viewer.unacked - chars);
        viewer.seedChars = Math.max(0, viewer.seedChars - chars);
      },
    });
  }

  /**
   * Register a server-side observer for a terminal. Unlike subscribe(), this does not
   * attach/replay through the browser protocol and does not affect websocket listeners.
   */
  observe(id: string, callback: TerminalObserver): () => void {
    const group = this.deps.observers.get(id) ?? new Set<TerminalObserver>();
    group.add(callback);
    this.deps.observers.set(id, group);
    this.cancelIdleDetach(id);
    const runtime = this.deps.runtime.get(id);
    if (runtime?.output.length) this.deliver(id, { type: 'output', terminalId: id, data: runtime.output.text(), sequence: runtime.sequence });
    let closed = false;
    if (!runtime) void this.deps.ensureRestored(id).then(() => {
      if (closed) return;
      const restored = this.deps.runtime.get(id);
      if (restored?.output.length) this.deliver(id, { type: 'output', terminalId: id, data: restored.output.text(), sequence: restored.sequence });
    }).catch(() => undefined);
    return () => {
      if (closed) return;
      closed = true;
      group.delete(callback);
      if (group.size === 0) {
        this.deps.observers.delete(id);
        this.scheduleIdleDetach(id);
      }
    };
  }

  /** Open terminal websockets: each is one `subscribe` listener. */
  viewerCount(): number {
    let count = 0;
    for (const group of this.deps.listeners.values()) count += group.size;
    return count;
  }

  /** Whether a terminal websocket is open on this terminal right now. */
  hasViewer(id: string): boolean {
    return Boolean(this.deps.listeners.get(id)?.size);
  }

  /** Bring viewers to the pane's present state with one seed (`seed.ts`). */
  seedViewers(id: string, viewers: Iterable<Viewer>, options: { resume?: boolean; attempt?: number } = {}): void {
    const runtime = this.deps.runtime.get(id);
    const targets = [...viewers].filter(viewer => !viewer.closed);
    if (!runtime || !targets.length || this.deps.isShuttingDown()) return;
    const tickets = new Map(targets.map(viewer => { viewer.seeding = true; viewer.seedInFlight = true; return [viewer, ++viewer.seedTicket] as const; }));
    const current = (viewer: Viewer) => !viewer.closed && viewer.seedTicket === tickets.get(viewer);
    const retry = (pending: Viewer[]) => {
      const waiting = pending.filter(current);
      if (!waiting.length || this.deps.runtime.get(id) !== runtime || this.deps.isShuttingDown()) return;
      const attempt = options.attempt ?? 0;
      setTimeout(() => {
        const still = waiting.filter(current);
        if (still.length && this.deps.runtime.get(id) === runtime) this.seedViewers(id, still, { ...options, attempt: attempt + 1 });
      }, Math.min(SEED_RETRY_MS * 2 ** attempt, SEED_RETRY_MAX_MS)).unref?.();
    };
    const line = (options.resume ? `refresh-client -A '${runtime.pane}:continue' ; ` : '') + seedLine(runtime.pane);
    runtime.control.request(line, SEED_BLOCKS + (options.resume ? 1 : 0), all => {
      if (this.deps.runtime.get(id) !== runtime) return;
      this.flushOutput(id, runtime);
      const blocks = all.slice(all.length - SEED_BLOCKS);
      const seeds = new Map<boolean, Seed | undefined>();
      const failed: Viewer[] = [];
      let metadataSynced = false;
      for (const viewer of targets) {
        if (!current(viewer)) continue;
        const history = viewer.protocol >= 3;
        if (!seeds.has(history)) seeds.set(history, assembleSeed(blocks, runtime.modes, history));
        const seed = seeds.get(history);
        if (seed) {
          if (!metadataSynced) {
            metadataSynced = true;
            this.updateMetadata(id, { cwd: seed.cwd, foregroundCommand: seed.foregroundCommand, paneTitle: seed.paneTitle });
          }
          this.sendSnapshot(viewer, runtime, seed);
        } else failed.push(viewer);
      }
      retry(failed);
    }).catch(() => retry(targets));
  }

  /** The seed replaces everything this viewer shows, so it also replaces its debt of unacked output. */
  sendSnapshot(viewer: Viewer, source: Pick<TerminalRuntime, 'sequence' | 'streamId'>, seed: Seed): void {
    viewer.seeding = false;
    viewer.seedInFlight = false;
    viewer.unacked = viewer.seedChars = seed.data.length;
    try { viewer.send({ type: 'snapshot', data: seed.data, cols: seed.cols, rows: seed.rows, sequence: source.sequence, streamId: source.streamId }); } catch { /* A disconnected browser does not own the tmux process. */ }
  }

  /** A phone that viewed the CLI leaves it narrow; widen it again once no browser is watching. */
  restoreBackgroundSize(id: string): void {
    const runtime = this.deps.runtime.get(id);
    if (!runtime || this.deps.listeners.has(id) || this.deps.hasExclusiveOperation(id) || this.deps.isShuttingDown()) return;
    const info = this.deps.store.listTerminals().find(item => item.id === id);
    if (!info || !isAgentTerminal(info.kind) || info.state !== 'running') return;
    const cols = Math.max(info.cols, BACKGROUND_COLS), rows = Math.max(info.rows, BACKGROUND_ROWS);
    if (cols === info.cols && rows === info.rows) return;
    void this.deps.resizeWindow(id, cols, rows).then(() => {
      if (this.deps.runtime.get(id) !== runtime || this.deps.isShuttingDown()) return;
      this.deps.invalidateScreen(id);
      this.emit(id, { type: 'state', terminal: this.deps.store.updateTerminal(id, { cols, rows }) });
    }).catch(() => undefined);
  }

  async attach(info: TerminalInfo, project: Project): Promise<void> {
    if (this.deps.isShuttingDown() || this.deps.runtime.has(info.id)) return;
    await this.deps.assertTmuxVersion();
    await this.deps.ensureModernServerOptions();
    const name = terminalName(info.id);
    await this.deps.tmux(['set-option', '-w', '-t', name, 'remain-on-exit', 'on', ';', 'set-hook', '-t', name, 'pane-died', `detach-client -s ${name}`, ...(await this.deps.paneFeatures().catch(() => false) ? appearanceCommands(info.id, info.appearance) : [])]);
    const dead = await this.paneExitCode(info.id);
    if (dead !== undefined) { await this.finishExit(info.id, dead); return; }
    const size = this.deps.store.getTerminal(info.id);
    const pane = (await this.deps.tmux([
      'set-option', '-t', name, 'status', 'off',
      ';', 'resize-window', '-t', name, '-x', String(size.cols), '-y', String(size.rows),
      ';', 'display-message', '-p', '-t', name, '#{pane_id}',
    ])).trim();
    if (!/^%\d+$/.test(pane)) throw new AppError('TMUX_COMMAND_FAILED', 'tmux could not complete the terminal operation', 503);
    if (this.deps.isShuttingDown() || this.deps.runtime.has(info.id)) return;
    const control: ControlClient = new ControlClient(this.deps.socketPath, name, {
      output: (from, data) => { if (from === pane) this.queueOutput(info.id, runtime, data); },
      pause: from => {
        if (from !== pane || this.deps.runtime.get(info.id) !== runtime) return;
        this.flushOutput(info.id, runtime);
        const viewers = [...this.deps.listeners.get(info.id) ?? []];
        if (viewers.length) this.seedViewers(info.id, viewers, { resume: true });
        else void control.request(`refresh-client -A '${pane}:continue'`).catch(() => undefined);
      },
      windowRenamed: renamed => {
        if (this.deps.runtime.get(info.id) !== runtime || this.deps.isShuttingDown()) return;
        const cleaned = renamed.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
        if (cleaned) this.updateMetadata(info.id, { paneTitle: cleaned });
      },
      exit: () => { void this.onAttachExit(info.id, runtime); },
    }, {
      cwd: existsSync(project.cwd) ? project.cwd : homedir(),
      env: this.deps.tmuxProcessEnv(),
    });
    const runtime: TerminalRuntime = { terminalId: info.id, kind: info.kind, ...this.behaviourOf(info), control, pane, sequence: 0, streamId: randomUUID(), modes: new OuterTerminalState(), output: new OutputTail(), pending: [], lastOutputAt: Date.now(), attachedAt: Date.now(), snapshotGeneration: 0 };
    this.deps.runtime.set(info.id, runtime);
    const current = this.deps.store.getTerminal(info.id);
    const updated = this.deps.store.updateTerminal(info.id, { state: 'running', ownerId: undefined, epoch: current.epoch + 1 });
    this.reportLinkedTerminal(updated, true);
    this.emit(info.id, { type: 'state', terminal: updated });
    if (current.state === 'detached' || current.ownerId) this.deps.inputAvailable(updated);
    this.seedViewers(info.id, this.deps.listeners.get(info.id) ?? []);
    if (!this.deps.listeners.has(info.id)) {
      setTimeout(() => this.restoreBackgroundSize(info.id), BACKGROUND_RESIZE_DELAY_MS).unref?.();
      this.scheduleIdleDetach(info.id);
    }
  }

  private queueOutput(id: string, runtime: TerminalRuntime, data: string): void {
    if (runtime.pending.push(data) === 1) queueMicrotask(() => this.flushOutput(id, runtime));
  }

  private flushOutput(id: string, runtime: TerminalRuntime): void {
    if (!runtime.pending.length) return;
    const data = runtime.pending.join('');
    runtime.pending.length = 0;
    if (this.deps.runtime.get(id) !== runtime || this.deps.isShuttingDown()) return;
    runtime.lastOutputAt = Date.now();
    runtime.sequence += 1;
    runtime.output.append(data);
    const prevCwd = runtime.modes.cwd;
    const prevTitle = runtime.modes.paneTitle;
    runtime.modes.accept(data);
    if (runtime.modes.cwd !== prevCwd || runtime.modes.paneTitle !== prevTitle) {
      this.updateMetadata(id, {
        ...(runtime.modes.cwd !== prevCwd ? { cwd: runtime.modes.cwd } : {}),
        ...(runtime.modes.paneTitle !== prevTitle ? { paneTitle: runtime.modes.paneTitle } : {}),
      });
    }
    if (runtime.behaviour?.ready && !runtime.agentReady) runtime.agentReady = runtime.behaviour.ready(stripTerminalSequences(runtime.output.tail(16 * 1024)));
    this.emit(id, { type: 'output', data, sequence: runtime.sequence, streamId: runtime.streamId });
  }

  private async onAttachExit(id: string, runtime: TerminalRuntime): Promise<void> {
    if (this.deps.runtime.get(id) !== runtime) return;
    runtime.snapshotGeneration += 1;
    const pendingSnapshot = this.deps.snapshotTimers.get(id);
    if (pendingSnapshot) { clearTimeout(pendingSnapshot); this.deps.snapshotTimers.delete(id); }
    this.cancelIdleDetach(id);
    if (this.deps.isShuttingDown()) return;
    const dead = await this.paneExitCode(id).catch(() => undefined);
    if (this.deps.isShuttingDown()) return;
    if (dead !== undefined) { await this.finishExit(id, dead, runtime); return; }
    if (this.deps.runtime.get(id) === runtime) this.deps.runtime.delete(id);
    const alive = await this.hasSession(id).catch(() => true);
    if (this.deps.isShuttingDown()) return;
    if (alive) {
      const info = this.deps.store.getTerminal(id);
      const updated = this.deps.store.updateTerminal(id, { state: 'detached', ownerId: undefined });
      this.emit(id, { type: 'state', terminal: updated });
      const failures = Date.now() - runtime.attachedAt < ATTACH_STABLE_MS ? (this.deps.attachFailures.get(id) ?? 0) + 1 : 0;
      this.deps.attachFailures.set(id, failures);
      setTimeout(() => {
        if (this.deps.isShuttingDown() || this.deps.runtime.has(id)) return;
        void this.attach(info, this.deps.store.getProject(info.projectId)).catch(() => undefined);
      }, Math.min(REATTACH_DELAY_MS * 2 ** Math.max(0, failures - 1), REATTACH_MAX_DELAY_MS)).unref();
      return;
    }
    this.deps.attachFailures.delete(id);
    await this.finishExit(id, this.deps.store.getTerminal(id).exitCode, runtime);
  }

  /** A retained dead pane is the authority; the outer tmux client's exit status is unrelated. */
  async paneExitCode(id: string): Promise<number | null | undefined> {
    const result = await this.deps.tmux(['display-message', '-p', '-t', terminalName(id), '#{pane_dead};#{pane_dead_status};#{pane_dead_signal}']);
    return parsePaneExitCode(result);
  }

  finishExit(id: string, exitCode: number | null | undefined, runtime?: TerminalRuntime): Promise<void> {
    const current = this.deps.finalizations.get(id);
    if (current) return current;
    const task = this.completeExit(id, exitCode, runtime).finally(() => {
      if (this.deps.finalizations.get(id) === task) this.deps.finalizations.delete(id);
    });
    this.deps.finalizations.set(id, task);
    return task;
  }

  private async completeExit(id: string, exitCode: number | null | undefined, runtime?: TerminalRuntime): Promise<void> {
    if (this.deps.isShuttingDown()) return;
    const info = this.deps.store.getTerminal(id);
    if (info.state === 'exited' || this.deps.stopping.has(id)) return;
    const source = runtime ?? this.deps.runtime.get(id);
    if (source) this.flushOutput(id, source);
    const viewers = [...(this.deps.listeners.get(id) ?? [])];
    if (viewers.length) {
      const seeds = await this.captureSeed(id, source?.modes ?? new OuterTerminalState());
      if (this.deps.isShuttingDown() || this.deps.stopping.has(id)) return;
      const marker = { sequence: source?.sequence ?? 0, streamId: source?.streamId ?? randomUUID() };
      for (const viewer of viewers) {
        const seed = viewer.protocol >= 3 ? seeds.full : seeds.screenOnly;
        if (seed) this.sendSnapshot(viewer, marker, seed);
        else if (source?.output.length) this.sendSnapshot(viewer, marker, { data: '\u001bc' + source.output.text(), cols: info.cols, rows: info.rows });
      }
    }
    const behaviour = source?.behaviour ?? this.deps.behaviourFor(info.kind, info.sessionId, isWarmupTerminal(info) ? warmupOf(info).backendId : undefined);
    let startupError = source && !source.agentReady
      ? behaviour?.startupError?.(redactSensitiveText(stripTerminalSequences(source.output.text()))) : undefined;
    if (!startupError && behaviour?.startupError && !source?.agentReady) {
      startupError = await this.paneStartupError(id, behaviour);
      if (this.deps.isShuttingDown() || this.deps.stopping.has(id)) return;
    }
    const updated = this.deps.store.updateTerminal(id, { state: 'exited', exitCode: exitCode ?? undefined, ownerId: undefined, epoch: info.epoch + 1 });
    this.cancelIdleDetach(id);
    const attached = this.deps.runtime.get(id);
    this.deps.runtime.delete(id);
    if (attached) attached.control.kill();
    this.reportLinkedTerminal(updated, false, startupError);
    this.emit(id, { type: 'state', terminal: updated });
    this.emit(id, { type: 'exit', exitCode: exitCode ?? undefined });
    this.clearObservers(id);
    await this.deps.killSession(id).catch(() => undefined);
  }

  private async paneStartupError(id: string, behaviour: TerminalBehaviour): Promise<string | undefined> {
    const captured = await this.deps.tmux(['capture-pane', '-p', '-J', '-S', `-${STARTUP_SCAN_LINES}`, '-t', terminalName(id)]).catch(() => undefined);
    if (!captured?.trim()) return undefined;
    const text = redactSensitiveText(stripTerminalSequences(captured));
    if (behaviour.ready?.(text)) return undefined;
    return behaviour.startupError?.(text);
  }

  scheduleSnapshot(id: string): void {
    const runtime = this.deps.runtime.get(id);
    if (!runtime) return;
    const pending = this.deps.snapshotTimers.get(id);
    if (pending) clearTimeout(pending);
    const generation = ++runtime.snapshotGeneration;
    runtime.reseedBy ??= Date.now() + RESEED_MAX_WAIT_MS;
    this.armSnapshotTimer(id, runtime, generation, SNAPSHOT_OUTPUT_QUIET_MS);
  }

  private armSnapshotTimer(id: string, runtime: TerminalRuntime, generation: number, delay: number): void {
    const timer = setTimeout(() => {
      this.deps.snapshotTimers.delete(id);
      if (this.deps.isShuttingDown() || this.deps.runtime.get(id) !== runtime || runtime.snapshotGeneration !== generation) return;
      const remainingQuietTime = SNAPSHOT_OUTPUT_QUIET_MS - (Date.now() - runtime.lastOutputAt);
      if (remainingQuietTime > 0 && Date.now() < (runtime.reseedBy ?? 0)) {
        this.armSnapshotTimer(id, runtime, generation, Math.min(remainingQuietTime, Math.max(0, (runtime.reseedBy ?? 0) - Date.now())));
        return;
      }
      runtime.reseedBy = undefined;
      this.seedViewers(id, this.deps.listeners.get(id) ?? []);
    }, delay);
    timer.unref?.();
    this.deps.snapshotTimers.set(id, timer);
  }

  private async captureSeed(id: string, modes: OuterTerminalState): Promise<{ screenOnly?: Seed; full?: Seed }> {
    try {
      const blocks = await Promise.all(seedCommands(terminalName(id)).map(async tokens => {
        const text = await this.deps.runTmux(tokens, 5000, undefined, HISTORY_CAPTURE_BYTES);
        return (text === '' ? [] : text.replace(/\n$/, '').split('\n')).map(line => Buffer.from(line, 'utf8'));
      }));
      return { full: assembleSeed(blocks, modes, true), screenOnly: assembleSeed(blocks, modes, false) };
    } catch { return {}; }
  }

  private updateMetadata(id: string, patch: { cwd?: string; foregroundCommand?: string; paneTitle?: string }): void {
    if (this.deps.isShuttingDown()) return;
    const current = this.deps.store.findTerminal(id);
    if (!current || current.state === 'exited') return;
    const nextPatch: Partial<TerminalInfo> = {};
    if (patch.cwd && patch.cwd !== current.cwd) nextPatch.cwd = patch.cwd;
    if (patch.foregroundCommand && patch.foregroundCommand !== current.foregroundCommand) nextPatch.foregroundCommand = patch.foregroundCommand;
    if (patch.paneTitle && patch.paneTitle !== current.paneTitle) nextPatch.paneTitle = patch.paneTitle;
    if (!Object.keys(nextPatch).length) return;
    const updated = this.deps.store.updateTerminal(id, nextPatch);
    this.emit(id, { type: 'state', terminal: updated });
  }

  cancelIdleDetach(id: string): void {
    const timer = this.deps.idleDetachTimers.get(id);
    if (timer) { clearTimeout(timer); this.deps.idleDetachTimers.delete(id); }
  }

  scheduleIdleDetach(id: string): void {
    const delay = this.deps.idleDetachMs ?? IDLE_DETACH_DEFAULT_MS;
    if (!(delay > 0) || this.deps.isShuttingDown()) return;
    const info = this.deps.store.findTerminal(id);
    if (!info || info.kind !== 'shell' || info.state === 'exited') return;
    if (this.deps.listeners.has(id) || this.deps.observers.has(id)) return;
    this.cancelIdleDetach(id);
    const timer = setTimeout(() => {
      this.deps.idleDetachTimers.delete(id);
      if (this.deps.isShuttingDown() || this.deps.listeners.has(id) || this.deps.observers.has(id) || this.deps.hasExclusiveOperation(id)) return;
      const attached = this.deps.runtime.get(id);
      if (!attached || attached.kind !== 'shell') return;
      const current = this.deps.store.findTerminal(id);
      if (!current || current.state === 'exited') return;
      this.deps.runtime.delete(id);
      attached.snapshotGeneration += 1;
      const pendingSnapshot = this.deps.snapshotTimers.get(id);
      if (pendingSnapshot) { clearTimeout(pendingSnapshot); this.deps.snapshotTimers.delete(id); }
      attached.control.kill();
      const updated = this.deps.store.updateTerminal(id, { state: 'detached', ownerId: undefined });
      this.emit(id, { type: 'state', terminal: updated });
    }, delay);
    timer.unref?.();
    this.deps.idleDetachTimers.set(id, timer);
  }

  /** Reports whether the session's own terminal is alive; `Session.state` itself is derived (see `deriveSessionState`). */
  reportLinkedTerminal(terminal: TerminalInfo, live: boolean, startupError?: string): void {
    if (!terminal.sessionId || !isAgentTerminal(terminal.kind)) return;
    const session = this.deps.store.getSession(terminal.sessionId);
    if (session.kind !== 'native' || session.archivedAt || session.terminalId !== terminal.id) return;
    const state = deriveSessionState({ current: session.state, terminalLive: live, startError: Boolean(startupError) });
    if (state === session.state && !(state !== 'failed' && session.error)) return;
    const updated = this.deps.store.updateSession(session.id, { ...sessionStatePatch(session, state, startupError), terminalId: terminal.id });
    if (startupError) this.deps.store.appendEvent(session.id, 'session', { session: updated });
  }

  emit(id: string, message: TerminalServerMessage): void {
    for (const viewer of [...this.deps.listeners.get(id) ?? []]) {
      if (message.type === 'output') {
        if (viewer.seeding) continue;
        if (viewer.protocol >= 3 && (viewer.unacked += message.data.length) > MAX_UNACKED_CHARS + viewer.seedChars) {
          this.seedViewers(id, [viewer]);
          continue;
        }
      }
      try { viewer.send(message); } catch { /* Disconnected browsers do not own the tmux process. */ }
    }
    const observation = observationFor(id, message);
    if (observation) this.deliver(id, observation);
  }

  private deliver(id: string, observation: TerminalObservation): void {
    const group = this.deps.observers.get(id);
    if (!group || group.size === 0) return;
    for (const callback of [...group]) {
      try { callback(observation); } catch { /* Observers are best-effort hints; they must not interrupt terminal handling. */ }
    }
  }

  clearObservers(id: string): void {
    this.deps.observers.delete(id);
  }

  private behaviourOf(info: TerminalInfo): { behaviour?: TerminalBehaviour } {
    const behaviour = this.deps.behaviourFor(info.kind, info.sessionId, isWarmupTerminal(info) ? warmupOf(info).backendId : undefined);
    return behaviour ? { behaviour } : {};
  }

  private async hasSession(id: string): Promise<boolean> {
    try {
      await this.deps.tmux(['has-session', '-t', terminalName(id)]);
      return true;
    } catch { return false; }
  }
}
