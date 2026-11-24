import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { NativeBackendId, Project, TerminalAppearance, TerminalGridDiagnostics, TerminalInfo, TerminalProfile, TerminalServerMessage } from '../../../../packages/contracts/src/index.js';
import { terminalEnvironment } from '../environment.js';
import { AppError, requireString } from '../errors.js';
import { exec } from '../exec.js';
import { assertTaskWorkspaceAvailable } from '../task-workspaces/identity.js';
import { Store } from '../store.js';
import { deriveSessionState, sessionStatePatch } from '../backends/service.js';
import { stopProcessGroup } from '../backends/shared/codex-app-server.js';
import { sendKeysLines, tmuxTooOld, TMUX_MIN_VERSION } from './control.js';
import { resolveTerminalAppearance, sameTerminalAppearance } from './appearance.js';
import { claimTmuxServerCommands } from './orphans.js';
import { launchArgAccepted, tmuxArgument } from './launch-args.js';
import { detectShellKind, prepareShellLaunch } from './shell-integration.js';
import { PaneInspector } from './pane-inspection.js';
import { TerminalStream } from './stream.js';
import {
  appearanceCommands, BACKGROUND_COLS, BACKGROUND_ROWS, defaultShell, HISTORY_LIMIT,
  isAgentTerminal, isWarmupTerminal, LAUNCH_MARKER, LAUNCH_MARKER_OPTION, LAUNCH_PID_OPTION,
  MAX_INPUT_CHARS, MAX_UNACKED_CHARS, PANE_HANGUP_GRACE_MS, run, SCREEN_CACHE_MS, terminalName,
  tmuxTargetMissing, trimTrailingBlankLines, validDimension, warmupOf,
  type InteractionTransaction, type PaneProcess, type ScreenRead, type TerminalBehaviour,
  type TerminalBehaviourSource, type TerminalCreateInput, type TerminalInteractionControl,
  type TerminalLaunchEnv, type TerminalObservation, type TerminalObserver, type TerminalRuntime,
  type TerminalServiceOptions, type TerminalSubscription, type TerminalWarmupMetadata,
  type Viewer, type WarmupTerminalInfo,
} from './shared.js';

export {
  isAgentTerminal, isWarmupTerminal, MAX_UNACKED_CHARS, SCREEN_CACHE_MS, warmupOf,
  type PaneProcess, type TerminalBehaviour, type TerminalBehaviourSource, type TerminalCreateInput,
  type TerminalInteractionControl, type TerminalLaunchEnv, type TerminalObservation,
  type TerminalObserver, type TerminalServiceOptions, type TerminalSubscription,
  type TerminalWarmupMetadata, type WarmupTerminalInfo,
};

export class TerminalService {
  private readonly socketPath: string;
  private readonly stateDir: string;
  private readonly socketDirectory: string;
  private tmuxPaneFeatures?: Promise<boolean>;
  private tmuxVersion?: Promise<string>;
  private modernServerOptions?: Promise<void>;
  /** Kept as a resolved compatibility barrier; restoration is now scoped to one terminal. */
  private readonly ready = Promise.resolve();
  private readonly restorations = new Map<string, Promise<void>>();
  private readonly finalizations = new Map<string, Promise<void>>();
  private runtime = new Map<string, TerminalRuntime>();
  private readonly attachFailures = new Map<string, number>();
  private readonly snapshotTimers = new Map<string, NodeJS.Timeout>();
  private readonly idleDetachTimers = new Map<string, NodeJS.Timeout>();
  private listeners = new Map<string, Set<Viewer>>();
  private observers = new Map<string, Set<TerminalObserver>>();
  private readonly liveCreations = new Map<string, Promise<TerminalInfo>>();
  private readonly seenLaunchEnv = { managed: new Set<string>(), secrets: new Set<string>() };
  private readonly interactions = new Map<string, InteractionTransaction>();
  private readonly externalMutations = new Map<string, number>();
  private readonly pasteBuffers = new Set<string>();
  private readonly screenReads = new Map<string, ScreenRead>();
  private readonly screenGenerations = new Map<string, number>();
  private readonly operationWaiters = new Map<string, Set<() => void>>();
  private readonly stopping = new Set<string>();
  private shuttingDown = false;
  private previousWarmupsEnded?: Promise<void>;

  private readonly inspector: PaneInspector;
  private readonly streams: TerminalStream;

  constructor(private readonly store: Store, private readonly options: TerminalServiceOptions) {
    const stateDir = resolve(options.stateDir);
    this.stateDir = stateDir;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const candidate = join(stateDir, 'tmux.sock');
    if (Buffer.byteLength(candidate) <= 90) {
      this.socketPath = candidate;
      this.socketDirectory = stateDir;
    } else {
      this.socketDirectory = join(tmpdir(), `riffet-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(stateDir).digest('hex').slice(0, 12)}`);
      this.socketPath = join(this.socketDirectory, 'tmux.sock');
      mkdirSync(this.socketDirectory, { recursive: true, mode: 0o700 });
      chmodSync(this.socketDirectory, 0o700);
    }
    this.inspector = new PaneInspector({
      store,
      runtime: this.runtime,
      ready: this.ready,
      ensureRestored: id => this.ensureRestored(id),
      paneFeatures: () => this.paneFeatures(),
      tmux: args => this.tmux(args),
      runTmux: (args, timeout, extraEnv, maxBuffer) => this.runTmux(args, timeout, extraEnv, maxBuffer),
    });
    this.streams = new TerminalStream({
      store,
      socketPath: this.socketPath,
      idleDetachMs: options.idleDetachMs,
      runtime: this.runtime,
      listeners: this.listeners,
      observers: this.observers,
      attachFailures: this.attachFailures,
      snapshotTimers: this.snapshotTimers,
      idleDetachTimers: this.idleDetachTimers,
      finalizations: this.finalizations,
      stopping: this.stopping,
      isShuttingDown: () => this.shuttingDown,
      hasExclusiveOperation: id => this.hasExclusiveOperation(id),
      invalidateScreen: id => this.invalidateScreen(id),
      ensureRestored: id => this.ensureRestored(id),
      assertTmuxVersion: () => this.assertTmuxVersion(),
      ensureModernServerOptions: () => this.ensureModernServerOptions(),
      paneFeatures: () => this.paneFeatures(),
      tmux: args => this.tmux(args),
      runTmux: (args, timeout, extraEnv, maxBuffer) => this.runTmux(args, timeout, extraEnv, maxBuffer),
      tmuxProcessEnv: extra => this.tmuxProcessEnv(extra),
      killSession: id => this.killSession(id),
      resizeWindow: (id, cols, rows) => this.resizeWindow(id, cols, rows),
      behaviourFor: (kind, sessionId, backendId) => this.behaviourFor(kind, sessionId, backendId),
    });
  }

  async create(project: Project, input: TerminalCreateInput = {}): Promise<TerminalInfo> {
    await this.ready;
    const currentProject = this.store.getProject(project.id);
    if (currentProject.cwd !== project.cwd) throw new AppError('PROJECT_MISMATCH', 'Project directory changed before terminal creation', 409);
    const kind = input.kind ?? 'shell';
    if (this.shuttingDown) throw new AppError('TERMINAL_SERVICE_CLOSED', 'Terminal service is shutting down', 503);
    if (input.sessionId) {
      const session = this.store.getSession(input.sessionId);
      if (session.projectId !== currentProject.id) throw new AppError('PROJECT_SESSION_MISMATCH', 'Conversation does not belong to this project', 409);
    }
    if (kind === 'native' && !input.sessionId) throw new AppError('NATIVE_LAUNCH_REQUIRED', 'A native terminal needs a linked session and an adapter launch specification', 400);
    this.assertLaunchSpec(kind, input, currentProject);
    if (input.reuseLive && input.sessionId) {
      const currentCreation = this.liveCreations.get(input.sessionId);
      if (currentCreation) return currentCreation;
      const existing = this.store.listTerminals().find(item => item.sessionId === input.sessionId && item.kind === kind && item.state !== 'exited');
      if (existing) {
        await this.ensureRestored(existing.id);
        const restored = this.store.getTerminal(existing.id);
        if (restored.state !== 'exited') return restored;
      }
      const creation = this.createTerminal(currentProject, { ...input, kind });
      this.liveCreations.set(input.sessionId, creation);
      try { return await creation; }
      finally { if (this.liveCreations.get(input.sessionId) === creation) this.liveCreations.delete(input.sessionId); }
    }
    return await this.createTerminal(currentProject, { ...input, kind });
  }

  /** Every kind but a shell runs a process an adapter chose; it is checked here, whoever asks. */
  private assertLaunchSpec(kind: TerminalInfo['kind'], input: TerminalCreateInput, project: Project): void {
    if (kind === 'shell') return;
    const spec = input.launchSpec;
    if (!spec) throw new AppError('NATIVE_LAUNCH_REQUIRED', 'A native terminal needs a linked session and an adapter launch specification', 400);
    if (spec.cwd !== project.cwd) throw new AppError('NATIVE_LAUNCH_CWD_INVALID', 'Native terminal cwd must match its project workspace', 400);
    if (!spec.command || spec.command.length > 4096 || /[\0\r\n]/.test(spec.command)
      || !Array.isArray(spec.args) || spec.args.length > 200 || !spec.args.every(launchArgAccepted)) {
      throw new AppError('NATIVE_LAUNCH_INVALID', 'Native terminal launch command is invalid', 400);
    }
    for (const [key, value] of Object.entries({ ...spec.env, ...spec.secretEnv })) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length > 64 * 1024 || /[\0\r\n]/.test(value)) {
        throw new AppError('NATIVE_LAUNCH_ENV_INVALID', 'Native terminal environment is invalid', 400);
      }
    }
  }

  private async createTerminal(currentProject: Project, input: TerminalCreateInput & { kind: TerminalInfo['kind'] }): Promise<TerminalInfo> {
    await assertTaskWorkspaceAvailable(currentProject);
    await this.assertTmuxVersion();
    const kind = input.kind;
    const cols = validDimension(input.cols, isAgentTerminal(kind) ? BACKGROUND_COLS : 80);
    const rows = validDimension(input.rows, isAgentTerminal(kind) ? BACKGROUND_ROWS : 24);
    const appearance = resolveTerminalAppearance(input.appearance ?? (input.sessionId ? this.store.getSession(input.sessionId).terminalAppearance : undefined));
    const terminalId = randomUUID();
    const behaviour = this.behaviourFor(kind, input.sessionId, input.warmup?.backendId);
    const profile = kind === 'shell' ? this.resolveProfile(input.profileId) : undefined;
    const launchCwd = kind === 'shell' ? this.resolveShellCwd(input.cwd ?? profile?.cwd, currentProject.cwd) : currentProject.cwd;
    const title = input.title?.trim().slice(0, 120) || profile?.name || behaviour?.title || (kind === 'shell' ? 'Shell' : kind === 'login' ? 'Login' : 'Native Agent');
    const info: TerminalInfo = {
      id: terminalId,
      projectId: currentProject.id,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      title,
      kind,
      state: 'running',
      persistent: true,
      epoch: 0,
      cols,
      rows,
      ...(appearance ? { appearance } : {}),
      ...(kind === 'shell' ? { cwd: launchCwd } : {}),
      createdAt: new Date().toISOString(),
      ...(input.warmup ? { warmup: input.warmup } : {}),
    };
    this.prepareSocketDirectory();
    const { command, args, tmuxEnv, env: commandEnv } = this.commandFor(kind, input, profile);
    const secretEnv = kind === 'shell' ? {} : input.launchSpec?.secretEnv ?? {};
    const env = Object.keys(secretEnv).length ? { ...commandEnv, ...secretEnv } : commandEnv;
    const launchMarker = kind !== 'shell' && LAUNCH_MARKER.test(input.launchSpec?.launchMarker ?? '') ? input.launchSpec!.launchMarker : undefined;
    try {
      const sessionEnv = { ...terminalEnvironment(), ...(tmuxEnv ?? {}) };
      const tmuxCommands = ['start-server', ';', ...claimTmuxServerCommands(this.stateDir), ...[...this.launchEnv().managed, ...Object.keys(secretEnv)].flatMap(name => [';', 'if-shell', '-F', `#{m:*${name}*,#{update-environment}}`, '', `set-option -ga update-environment ${name}`]), ';', 'set-option', '-s', 'escape-time', '10', ';', 'set-option', '-g', 'focus-events', 'on', ';', 'set-option', '-g', 'history-limit', String(HISTORY_LIMIT), ';', 'set-option', '-g', 'remain-on-exit', 'on', ';', 'new-session'];
      await this.runTmux([
        ...tmuxCommands,
        ...Object.entries(sessionEnv).flatMap(([key, value]) => ['-e', tmuxArgument(`${key}=${value}`)]), '-d', '-P', '-F', '#{session_id}',
        '-x', String(cols), '-y', String(rows), '-s', terminalName(terminalId), '-c', tmuxArgument(launchCwd), tmuxArgument(command), ...args.map(tmuxArgument),
        ';', 'set-option', '-w', '-t', terminalName(terminalId), 'window-size', 'manual',
        ...(launchMarker ? this.launchRecordCommands(terminalId, launchMarker) : []),
        ...(await this.paneFeatures().catch(() => false) ? appearanceCommands(terminalId, appearance) : []),
      ], 5000, env);
      await this.ensureModernServerOptions();
      if (launchMarker) this.inspector.invalidateLaunchRecords();
      await this.runTmux(['set-hook', '-t', terminalName(terminalId), 'pane-died', `detach-client -s ${terminalName(terminalId)}`]);
      this.store.saveTerminal(info);
      if (input.sessionId) {
        const linked = this.store.getSession(input.sessionId);
        this.store.updateSession(input.sessionId, {
          terminalId,
          ...(isAgentTerminal(kind) ? sessionStatePatch(linked, deriveSessionState({ current: linked.state, phase: 'starting' })) : {}),
        });
      }
      await this.streams.attach(info, currentProject);
      return this.store.getTerminal(terminalId);
    } catch (error) {
      await this.killSession(terminalId).catch(() => undefined);
      const stored = this.store.listTerminals().find(item => item.id === terminalId);
      if (stored) {
        const updated = this.store.updateTerminal(terminalId, { state: 'exited', ownerId: undefined, epoch: stored.epoch + 1 });
        this.streams.emit(terminalId, { type: 'state', terminal: updated });
        this.streams.clearObservers(terminalId);
        this.streams.reportLinkedTerminal(updated, false);
      }
      if (error instanceof AppError) throw error;
      throw new AppError('TERMINAL_CREATE_FAILED', 'Could not create the persistent terminal', 503);
    }
  }

  async list(): Promise<TerminalInfo[]> {
    await this.ready;
    const terminals = this.listSnapshot();
    await this.restoreMany(terminals.map(item => item.id));
    return terminals.map(item => this.store.getTerminal(item.id)).filter(item => !isWarmupTerminal(item));
  }

  /** Read stored terminal metadata without attaching every persistent tmux session. */
  listSnapshot(): TerminalInfo[] {
    return this.store.listTerminals().filter(item => !isWarmupTerminal(item));
  }

  async get(id: string): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    return this.store.getTerminal(id);
  }

  /** The kind is the launch's (`native` unless given); the reservation is a session's terminal once claimed. */
  async createWarmup(project: Project, input: Omit<TerminalCreateInput, 'sessionId' | 'warmup' | 'reuseLive'> & { warmup: TerminalWarmupMetadata }): Promise<WarmupTerminalInfo> {
    await this.endPreviousWarmupsOnce();
    await this.ready;
    if (this.shuttingDown) throw new AppError('TERMINAL_SERVICE_CLOSED', 'Terminal service is shutting down', 503);
    const currentProject = this.store.getProject(project.id);
    if (currentProject.cwd !== project.cwd) throw new AppError('PROJECT_MISMATCH', 'Project directory changed before terminal creation', 409);
    if (!input.warmup.nativeSessionId) throw new AppError('WARMUP_CHAT_ID_REQUIRED', 'A native warmup needs its reserved conversation id', 409);
    if (!input.warmup.ownerToken || !input.warmup.resourceKey || input.warmup.expiresAt <= Date.now()) {
      throw new AppError('INVALID_WARMUP', 'Native warmup reservation is invalid or expired', 409);
    }
    const kind = input.kind ?? 'native';
    if (kind === 'shell' || kind === 'login') throw new AppError('INVALID_WARMUP', 'Only an agent process can be held ahead of its session', 409);
    this.assertLaunchSpec(kind, input, currentProject);
    return await this.createTerminal(currentProject, { ...input, kind }) as WarmupTerminalInfo;
  }

  async listWarmups(ownerToken?: string): Promise<WarmupTerminalInfo[]> {
    return this.store.listTerminals().filter(isWarmupTerminal)
      .filter(item => item.state !== 'exited')
      .filter(item => ownerToken === undefined || item.warmup.ownerToken === ownerToken)
      .map(item => ({ ...item, warmup: warmupOf(item) }));
  }

  async extendWarmup(id: string, input: { ownerToken: string; resourceKey: string; expiresAt: number }): Promise<WarmupTerminalInfo> {
    await this.ensureRestored(id);
    if (this.stopping.has(id)) throw new AppError('WARMUP_CLAIM_STALE', 'Native startup reservation is no longer available', 409);
    const info = this.store.getTerminal(id);
    if (!isWarmupTerminal(info) || info.warmup.ownerToken !== input.ownerToken || info.warmup.resourceKey !== input.resourceKey) {
      throw new AppError('WARMUP_CLAIM_STALE', 'Native startup reservation is no longer available', 409);
    }
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) {
      throw new AppError('INVALID_WARMUP', 'Native startup reservation expiry is invalid', 409);
    }
    return this.store.saveTerminal({ ...info, warmup: { ...warmupOf(info), expiresAt: input.expiresAt } } as WarmupTerminalInfo) as WarmupTerminalInfo;
  }

  /** Atomically converts an unused temporary CLI into the requested native session. */
  async claimWarmup(id: string, input: { ownerToken: string; resourceKey: string; sessionId: string }): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    if (this.stopping.has(id)) throw new AppError('WARMUP_CLAIM_STALE', 'Native startup reservation is no longer available', 409);
    const info = this.store.getTerminal(id);
    if (!isWarmupTerminal(info) || info.warmup.ownerToken !== input.ownerToken || info.warmup.resourceKey !== input.resourceKey) {
      throw new AppError('WARMUP_CLAIM_STALE', 'Native startup reservation is no longer available', 409);
    }
    if (info.warmup.expiresAt <= Date.now()) {
      await this.stopWarmup(id, input.ownerToken);
      throw new AppError('WARMUP_EXPIRED', 'Native startup reservation expired', 409);
    }
    if (info.state !== 'running') throw new AppError('WARMUP_NOT_READY', 'Native startup reservation is not attached and ready', 409);
    const session = this.store.getSession(input.sessionId);
    if (session.projectId !== info.projectId || session.kind !== 'native') {
      throw new AppError('WARMUP_PROJECT_MISMATCH', 'Native startup reservation belongs to another project', 409);
    }
    if (!sameTerminalAppearance(session.terminalAppearance, info.appearance)) {
      throw new AppError('WARMUP_APPEARANCE_MISMATCH', 'Native startup reservation uses a different terminal appearance', 409);
    }
    if (session.terminalId && session.terminalId !== id) {
      const linked = this.store.getTerminal(session.terminalId);
      if (linked.state !== 'exited') throw new AppError('SESSION_TERMINAL_EXISTS', 'Conversation already has a running terminal', 409);
    }
    const { warmup: _warmup, ...claimed } = info;
    const updated = this.store.saveTerminal({ ...claimed, sessionId: input.sessionId, ownerId: undefined, epoch: info.epoch + 1 });
    this.store.updateSession(input.sessionId, { terminalId: id, nativeSessionId: warmupOf(info).nativeSessionId, state: 'running', error: undefined });
    this.streams.emit(id, { type: 'state', terminal: updated });
    return updated;
  }

  endPreviousWarmupsOnce(): Promise<void> { return this.previousWarmupsEnded ??= this.endPreviousWarmups(); }

  private async endPreviousWarmups(): Promise<void> {
    const previous = this.store.listTerminals().filter(info => info.state !== 'exited' && isWarmupTerminal(info));
    await Promise.allSettled(previous.map(info => this.stopWarmup(info.id, (info as WarmupTerminalInfo).warmup.ownerToken)));
  }

  async stopWarmup(id: string, ownerToken: string): Promise<boolean> {
    await this.ensureRestored(id);
    return await this.stopRestored(id, ownerToken);
  }

  subscribe(id: string, callback: (message: TerminalServerMessage) => void, options: { protocol?: number } = {}): TerminalSubscription {
    return this.streams.subscribe(id, callback, options);
  }

  observe(id: string, callback: TerminalObserver): () => void {
    return this.streams.observe(id, callback);
  }

  private async resizeWindow(id: string, cols: number, rows: number): Promise<void> {
    await this.tmux(['resize-window', '-t', terminalName(id), '-x', String(cols), '-y', String(rows)]);
  }

  async claim(id: string, clientId: string, takeover = false): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    requireString(clientId, 'clientId', 200);
    do { await this.waitForExclusiveOperation(id); } while (this.hasExclusiveOperation(id));
    const info = this.store.getTerminal(id);
    if (info.state !== 'running') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
    if (info.ownerId && info.ownerId !== clientId && !takeover) throw new AppError('TERMINAL_CONTROLLED', 'Another browser currently controls this terminal', 409, { ownerId: info.ownerId, epoch: info.epoch });
    if (info.ownerId === clientId) return info;
    const updated = this.store.updateTerminal(id, { ownerId: clientId, epoch: info.epoch + 1 });
    this.streams.emit(id, { type: 'state', terminal: updated });
    return updated;
  }

  async withInteraction<T>(id: string, task: (control: TerminalInteractionControl) => Promise<T>, options: { authorize?: () => void; beforeWrite?: () => void } = {}): Promise<T> {
    await this.ensureRestored(id);
    if (this.shuttingDown || this.stopping.has(id)) throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is stopping', 409);
    const info = this.store.getTerminal(id);
    if (info.state !== 'running') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
    const runtime = this.runtime.get(id);
    if (!runtime) throw new AppError('TERMINAL_DETACHED', 'Terminal is reconnecting; interaction was not started', 409);
    if (this.interactions.has(id) || (this.externalMutations.get(id) ?? 0) > 0 || this.pasteBuffers.has(id)) throw this.interactionBusy();

    const transaction: InteractionTransaction = { runtime, epoch: info.epoch, ...options };
    this.interactions.set(id, transaction);
    let stepTail: Promise<void> = Promise.resolve();
    const step = <R>(runStep: () => Promise<R>): Promise<R> => {
      const result = stepTail.then(runStep);
      stepTail = result.then(() => undefined, () => undefined);
      return result;
    };
    const control: TerminalInteractionControl = {
      screen: options => step(async () => {
        this.assertInteractionCurrent(id, transaction);
        const result = options?.styled
          ? await this.tmux(['capture-pane', '-p', '-e', '-t', terminalName(id)]).then(trimTrailingBlankLines, () => undefined)
          : await this.screen(id, { fresh: true });
        this.assertInteractionCurrent(id, transaction);
        return result;
      }),
      keys: keys => step(async () => {
        this.assertInteractionCurrent(id, transaction);
        try { if (keys.length) { this.beforeInteractionWrite(id, transaction); await this.tmux(['send-keys', '-t', terminalName(id), ...keys]); } }
        finally { this.invalidateScreen(id); }
        this.assertInteractionCurrent(id, transaction);
      }),
      paste: (text, submit) => step(async () => {
        this.assertInteractionCurrent(id, transaction);
        await this.pasteToTerminal(id, text, submit, transaction);
        this.assertInteractionCurrent(id, transaction);
      }),
    };

    try { return await task(control); }
    finally {
      await stepTail.catch(() => undefined);
      if (this.interactions.get(id) === transaction) this.interactions.delete(id);
      this.notifyOperationWaiters(id);
    }
  }

  async pasteAttachmentsWithLease(id: string, clientId: string, epoch: number, text: string, authorize?: () => void, beforeWrite?: () => void): Promise<void> {
    if (typeof text !== 'string' || text.length > MAX_INPUT_CHARS) throw new AppError('INVALID_TERMINAL_INPUT', `Terminal input must be a string up to ${MAX_INPUT_CHARS} characters`);
    await this.withInteraction(id, async control => {
      this.assertController(id, clientId, epoch);
      authorize?.();
      await control.paste(text, false);
    }, { authorize, beforeWrite });
  }

  async input(id: string, clientId: string, epoch: number, data: string): Promise<void> {
    await this.ensureRestored(id);
    this.assertNoInteraction(id);
    const info = this.assertController(id, clientId, epoch);
    if (typeof data !== 'string' || data.length > MAX_INPUT_CHARS) throw new AppError('INVALID_TERMINAL_INPUT', `Terminal input must be a string up to ${MAX_INPUT_CHARS} characters`);
    const attached = this.runtime.get(id);
    if (!attached) throw new AppError('TERMINAL_DETACHED', 'Terminal is reconnecting; input was not sent', 409);
    this.writeToPane(attached, Buffer.from(data, 'utf8'));
    this.invalidateScreen(id);
    void info;
  }

  private writeToPane(runtime: TerminalRuntime, bytes: Buffer): void {
    for (const line of sendKeysLines(runtime.pane, bytes)) void runtime.control.request(line).catch(() => undefined);
  }

  gridDiagnostics(id: string): Promise<TerminalGridDiagnostics> { return this.inspector.gridDiagnostics(id); }
  history(id: string, known?: string, tail = false): Promise<{ version: string; cols: number; text?: string; append?: boolean }> { return this.inspector.history(id, known, tail); }

  async resize(id: string, clientId: string, epoch: number, cols: number, rows: number): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    this.assertNoInteraction(id);
    this.assertController(id, clientId, epoch);
    cols = validDimension(cols, 80);
    rows = validDimension(rows, 24);
    const current = this.store.getTerminal(id);
    if (current.cols === cols && current.rows === rows) return current;
    const attached = this.runtime.get(id);
    if (!attached) throw new AppError('TERMINAL_DETACHED', 'Terminal is reconnecting; resize was not applied', 409);
    await this.resizeWindow(id, cols, rows);
    this.invalidateScreen(id);
    const updated = this.store.updateTerminal(id, { cols, rows });
    this.streams.emit(id, { type: 'state', terminal: updated });
    this.streams.scheduleSnapshot(id);
    return updated;
  }

  async release(id: string, clientId: string, epoch: number): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    do { await this.waitForExclusiveOperation(id); } while (this.hasExclusiveOperation(id));
    const info = this.assertController(id, clientId, epoch);
    const updated = this.store.updateTerminal(id, { ownerId: undefined, epoch: info.epoch + 1 });
    this.streams.emit(id, { type: 'state', terminal: updated });
    return updated;
  }

  async interrupt(id: string): Promise<void> {
    await this.ensureRestored(id);
    this.beginExternalMutation(id);
    try {
      const info = this.store.getTerminal(id);
      if (info.state !== 'running') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
      const attached = this.runtime.get(id);
      if (attached) this.writeToPane(attached, Buffer.from([0x03]));
      else await this.tmux(['send-keys', '-t', terminalName(id), 'C-c']);
    } finally {
      this.invalidateScreen(id);
      this.endExternalMutation(id);
    }
  }

  async paste(id: string, text: string, submit: boolean): Promise<void> {
    await this.ensureRestored(id);
    if (typeof text !== 'string' || text.length > MAX_INPUT_CHARS) throw new AppError('INVALID_TERMINAL_INPUT', `Terminal input must be a string up to ${MAX_INPUT_CHARS} characters`);
    this.beginExternalMutation(id, true);
    try {
      const info = this.store.getTerminal(id);
      if (info.state === 'exited') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
      await this.pasteToTerminal(id, text, submit);
    } finally {
      this.endExternalMutation(id, true);
    }
  }

  private async pasteToTerminal(id: string, text: string, submit: boolean, transaction?: InteractionTransaction): Promise<void> {
    if (typeof text !== 'string' || text.length > MAX_INPUT_CHARS) throw new AppError('INVALID_TERMINAL_INPUT', `Terminal input must be a string up to ${MAX_INPUT_CHARS} characters`);
    if (transaction) this.assertInteractionCurrent(id, transaction);
    const buffer = `${terminalName(id)}-paste`;
    let loaded = false;
    if (this.pasteBuffers.has(id)) throw this.interactionBusy();
    this.pasteBuffers.add(id);
    try {
      if (text) {
        await exec('tmux', ['-S', this.socketPath, 'load-buffer', '-b', buffer, '-'], { timeout: 5000, input: text })
          .catch(() => { throw new AppError('TMUX_COMMAND_FAILED', 'tmux could not complete the terminal operation', 503); });
        loaded = true;
        if (transaction) this.beforeInteractionWrite(id, transaction);
        await this.tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', terminalName(id)]);
        loaded = false;
        if (transaction) this.assertInteractionCurrent(id, transaction);
      }
      if (submit) {
        if (text) {
          await new Promise((wait) => setTimeout(wait, 80));
          if (transaction) this.assertInteractionCurrent(id, transaction);
        }
        if (transaction) this.beforeInteractionWrite(id, transaction);
        await this.tmux(['send-keys', '-t', terminalName(id), 'Enter']);
        if (transaction) this.assertInteractionCurrent(id, transaction);
      }
    } finally {
      this.invalidateScreen(id);
      this.pasteBuffers.delete(id);
      if (loaded) await this.tmux(['delete-buffer', '-b', buffer]).catch(() => undefined);
    }
  }

  async sendKeys(id: string, keys: string[]): Promise<void> {
    await this.ensureRestored(id);
    this.beginExternalMutation(id);
    try {
      const info = this.store.getTerminal(id);
      if (info.state === 'exited') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
      if (keys.length) await this.tmux(['send-keys', '-t', terminalName(id), ...keys]);
    } finally {
      this.invalidateScreen(id);
      this.endExternalMutation(id);
    }
  }

  async screen(id: string, options: { fresh?: boolean; scrollback?: number } = {}): Promise<string | undefined> {
    await this.ensureRestored(id);
    const scrollback = Math.min(options.scrollback ?? 0, HISTORY_LIMIT);
    if (Number.isInteger(scrollback) && scrollback > 0) {
      return this.tmux(['capture-pane', '-p', '-S', `-${scrollback}`, '-t', terminalName(id)]).then(trimTrailingBlankLines, () => undefined);
    }
    const generation = this.screenGenerations.get(id) ?? 0;
    const runtime = this.runtime.get(id);
    const cached = this.screenReads.get(id);
    if (!options.fresh && cached && cached.generation === generation) {
      if (!cached.settled) return await cached.task;
      if (Date.now() - cached.startedAt < SCREEN_CACHE_MS && cached.runtime === runtime && cached.sequence === runtime?.sequence) return cached.text;
    }
    const read: ScreenRead = {
      generation, runtime, sequence: runtime?.sequence, startedAt: Date.now(), settled: false,
      task: this.tmux(['capture-pane', '-p', '-t', terminalName(id)]).then(trimTrailingBlankLines, () => undefined),
    };
    this.screenReads.set(id, read);
    const text = await read.task;
    read.text = text;
    read.settled = true;
    if (this.screenReads.get(id) === read && (text === undefined || (this.screenGenerations.get(id) ?? 0) !== generation)) this.screenReads.delete(id);
    return text;
  }

  private invalidateScreen(id: string): void {
    this.screenGenerations.set(id, (this.screenGenerations.get(id) ?? 0) + 1);
    this.screenReads.delete(id);
  }

  panePid(id: string): Promise<number | undefined> { return this.inspector.panePid(id); }
  paneActivity(timeoutMs = 2000): Promise<Map<string, number>> { return this.inspector.paneActivity(timeoutMs); }
  tail(id: string, rows: number): Promise<{ text: string; cols: number } | undefined> { return this.inspector.tail(id, rows); }
  paneText(id: string, timeoutMs = 2000): Promise<string | undefined> { return this.inspector.paneText(id, timeoutMs); }
  reapStraySessions(minAgeMs: number, now = Date.now(), timeoutMs = 2000): Promise<string[]> { return this.inspector.reapStraySessions(minAgeMs, now, timeoutMs); }
  paneProcesses(timeoutMs = 2000): Promise<{ serverPid?: number; panes: Array<{ terminalId: string; pid: number }> }> { return this.inspector.paneProcesses(timeoutMs); }
  viewerCount(): number { return this.streams.viewerCount(); }
  hasViewer(id: string): boolean { return this.streams.hasViewer(id); }
  inspectPane(terminalId: string, sessionId: string, options: { deadline: number; select: (argv: string[], launchMarker: string | undefined) => boolean }): Promise<PaneProcess[] | undefined> {
    return this.inspector.inspectPane(terminalId, sessionId, options);
  }
  paneLaunchMarker(terminalId: string, sessionId: string): Promise<string | undefined> { return this.inspector.paneLaunchMarker(terminalId, sessionId); }
  adoptPaneLaunch(terminalId: string, sessionId: string, marker: string, pid: number): Promise<void> { return this.inspector.adoptPaneLaunch(terminalId, sessionId, marker, pid); }

  private launchRecordCommands(id: string, marker: string): string[] {
    const name = terminalName(id);
    return [';', 'set-option', '-t', name, LAUNCH_MARKER_OPTION, marker, ';', 'set-option', '-F', '-t', name, LAUNCH_PID_OPTION, '#{pane_pid}'];
  }

  async setAppearance(id: string, appearance: TerminalAppearance): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    const info = this.store.getTerminal(id);
    if (info.state === 'exited' || sameTerminalAppearance(info.appearance, appearance)) return info;
    if (await this.paneFeatures()) await this.tmux(appearanceCommands(id, appearance).slice(1));
    const updated = this.store.updateTerminal(id, { appearance });
    this.streams.emit(id, { type: 'state', terminal: updated });
    return updated;
  }

  async stop(id: string): Promise<void> {
    await this.ensureRestored(id);
    await this.stopRestored(id);
  }

  private async stopRestored(id: string, expectedWarmupOwner?: string): Promise<boolean> {
    const info = this.store.getTerminal(id);
    if (expectedWarmupOwner !== undefined && (!isWarmupTerminal(info) || info.warmup.ownerToken !== expectedWarmupOwner)) return false;
    if (info.state === 'exited') return false;
    if (this.stopping.has(id)) throw this.interactionBusy();
    this.stopping.add(id);
    const pendingSnapshot = this.snapshotTimers.get(id);
    if (pendingSnapshot) { clearTimeout(pendingSnapshot); this.snapshotTimers.delete(id); }
    this.streams.cancelIdleDetach(id);
    const attached = this.runtime.get(id);
    if (attached) attached.snapshotGeneration += 1;
    this.store.updateTerminal(id, { ownerId: undefined, epoch: info.epoch + 1 });
    try {
      const panePid = await this.inspector.livePanePid(id, 2000);
      await this.killSession(id);
      if (panePid) await stopProcessGroup(panePid, PANE_HANGUP_GRACE_MS).catch(() => undefined);
      const currentRuntime = this.runtime.get(id);
      if (currentRuntime) {
        this.runtime.delete(id);
        currentRuntime.control.kill();
      }
      const updated = this.store.updateTerminal(id, { state: 'exited', ownerId: undefined });
      this.streams.emit(id, { type: 'state', terminal: updated });
      this.streams.emit(id, { type: 'exit', exitCode: 0 });
      this.streams.clearObservers(id);
      this.screenReads.delete(id);
      this.screenGenerations.delete(id);
      this.streams.reportLinkedTerminal(updated, false);
      return true;
    } finally {
      this.stopping.delete(id);
    }
  }

  async closeAll(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled([...this.liveCreations.values(), ...this.restorations.values(), ...this.finalizations.values()]);
    const attachedIds = new Set(this.runtime.keys());
    for (const [id, attached] of this.runtime) {
      attached.snapshotGeneration += 1;
      const info = this.store.getTerminal(id);
      const updated = this.store.updateTerminal(id, { state: 'detached', ownerId: undefined, epoch: info.epoch + 1 });
      this.streams.emit(id, { type: 'state', terminal: updated });
      attached.control.kill();
    }
    this.runtime.clear();
    for (const info of this.store.listTerminals()) {
      if (info.state === 'exited' || attachedIds.has(info.id)) continue;
      const updated = this.store.updateTerminal(info.id, { state: 'detached', ownerId: undefined, epoch: info.epoch + 1 });
      this.streams.emit(info.id, { type: 'state', terminal: updated });
    }
    this.observers.clear();
    for (const timer of this.snapshotTimers.values()) clearTimeout(timer);
    this.snapshotTimers.clear();
    for (const timer of this.idleDetachTimers.values()) clearTimeout(timer);
    this.idleDetachTimers.clear();
    if (this.options.ephemeral) await this.runTmux(['kill-server'], 3000).catch(() => undefined);
  }

  get socket(): string { return this.socketPath; }

  async claimServer(): Promise<void> {
    await this.runTmux(claimTmuxServerCommands(this.stateDir), 2000).catch(() => undefined);
  }

  private async restoreMany(ids: string[]): Promise<void> {
    let index = 0;
    const worker = async () => {
      for (;;) {
        const current = index++;
        if (current >= ids.length) return;
        await this.ensureRestored(ids[current]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  }

  private async ensureRestored(id: string): Promise<void> {
    const finalizing = this.finalizations.get(id);
    if (finalizing) return finalizing;
    const first = this.store.getTerminal(id);
    if (first.state === 'exited' || this.runtime.has(id)) return;
    if (this.shuttingDown) throw new AppError('TERMINAL_SERVICE_CLOSED', 'Terminal service is shutting down', 503);
    const current = this.restorations.get(id);
    if (current) return current;
    const task = (async () => {
      const info = this.store.getTerminal(id);
      if (info.state === 'exited' || this.runtime.has(id)) return;
      if (isWarmupTerminal(info) && info.warmup.expiresAt <= Date.now()) {
        await this.killSession(id).catch(() => undefined);
        const updated = this.store.updateTerminal(id, { state: 'exited', ownerId: undefined, epoch: info.epoch + 1 });
        this.streams.emit(id, { type: 'state', terminal: updated });
        this.streams.emit(id, { type: 'exit', exitCode: info.exitCode });
        return;
      }
      try {
        if (await this.hasSession(id)) {
          const dead = await this.streams.paneExitCode(id);
          if (dead !== undefined) { await this.streams.finishExit(id, dead); return; }
          await this.streams.attach(info, this.store.getProject(info.projectId));
        } else {
          const updated = this.store.updateTerminal(id, { state: 'exited', ownerId: undefined, epoch: info.epoch + 1 });
          this.streams.emit(id, { type: 'state', terminal: updated });
          this.streams.emit(id, { type: 'exit', exitCode: info.exitCode });
          this.streams.clearObservers(id);
          this.streams.reportLinkedTerminal(updated, false);
        }
      } catch {
        const fresh = this.store.getTerminal(id);
        if (fresh.state === 'exited') return;
        const updated = this.store.updateTerminal(id, { state: 'detached', ownerId: undefined, epoch: fresh.epoch + 1 });
        this.streams.emit(id, { type: 'state', terminal: updated });
      }
    })();
    this.restorations.set(id, task);
    try { await task; }
    finally { if (this.restorations.get(id) === task) this.restorations.delete(id); }
  }

  private async assertTmuxVersion(): Promise<void> {
    const version = await (this.tmuxVersion ??= run('tmux', ['-V']).then(text => text.trim()).catch(error => { this.tmuxVersion = undefined; throw error; }));
    if (tmuxTooOld(version)) throw new AppError('TMUX_TOO_OLD', `${version} is too old: Riffet terminals need tmux ${TMUX_MIN_VERSION} or newer`, 503);
  }

  private paneFeatures(): Promise<boolean> {
    return this.tmuxPaneFeatures ??= this.tmux(['start-server', ';', 'list-commands'])
      .then(commands => /^capture-pane\b[^\n]*\[-[^\]]*N[^\]]*\]/m.test(commands))
      .catch(error => { this.tmuxPaneFeatures = undefined; throw error; });
  }

  private ensureModernServerOptions(): Promise<void> {
    return this.modernServerOptions ??= (async () => {
      try {
        await this.tmux([
          'set-option', '-s', 'escape-time', '10',
          ';', 'set-option', '-g', 'focus-events', 'on',
          ';', 'set-option', '-s', 'extended-keys', 'on',
          ';', 'set-option', '-s', 'extended-keys-format', 'csi-u',
          ';', 'set-option', '-s', 'terminal-features[90]', 'xterm*:RGB:strikethrough:usstyle:overline:sync:extkeys:hyperlinks',
        ]);
      } catch {
        await this.tmux(['set-option', '-s', 'escape-time', '10']).catch(() => undefined);
        await this.tmux(['set-option', '-g', 'focus-events', 'on']).catch(() => undefined);
        await this.tmux(['set-option', '-s', 'extended-keys', 'on']).catch(() => undefined);
        await this.tmux(['set-option', '-s', 'extended-keys-format', 'csi-u']).catch(() => undefined);
        await this.tmux(['set-option', '-s', 'terminal-features[90]', 'xterm*:RGB:strikethrough:usstyle:overline:sync']).catch(() => undefined);
      }
    })();
  }

  private resolveProfile(profileId: string | undefined): TerminalProfile | undefined {
    if (profileId === undefined) return undefined;
    const id = requireString(profileId, 'profileId', 64);
    const profile = this.options.shellSettings?.()?.profiles?.find(item => item.id === id);
    if (!profile) throw new AppError('TERMINAL_PROFILE_NOT_FOUND', `Terminal profile "${id}" not found`, 404);
    return profile;
  }

  private resolveShellCwd(candidate: string | undefined, fallback: string): string {
    if (!candidate) return fallback;
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > 4096 || /[\0\r\n]/.test(trimmed)) throw new AppError('INVALID_TERMINAL_CWD', 'Terminal working directory is invalid', 400);
    const expanded = trimmed === '~' || trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(trimmed === '~' ? 1 : 2)) : trimmed;
    if (!isAbsolute(expanded)) throw new AppError('INVALID_TERMINAL_CWD', 'Terminal working directory must be an absolute path', 400);
    const resolvedPath = resolve(expanded);
    try { if (statSync(resolvedPath).isDirectory()) return resolvedPath; }
    catch { /* fall through to project directory */ }
    return fallback;
  }

  private commandFor(kind: TerminalInfo['kind'], input: TerminalCreateInput, profile?: TerminalProfile): { command: string; args: string[]; env?: NodeJS.ProcessEnv; tmuxEnv?: Record<string, string> } {
    if (kind === 'shell') {
      const shellConfig = this.options.shellSettings?.();
      const command = profile?.command || shellConfig?.defaultShell || defaultShell();
      const baseArgs = profile?.args !== undefined
        ? [...profile.args]
        : (detectShellKind(command) || ['sh', 'dash', 'ash', 'ksh', 'nu'].includes(basename(command).replace(/^-/, '').toLowerCase())) ? ['-i'] : [];
      const args = [...baseArgs, ...(input.args ?? [])];
      const integrationEnabled = shellConfig?.shellIntegration !== false;
      return prepareShellLaunch(this.stateDir, { command, args, ...(profile?.env ? { tmuxEnv: { ...profile.env } } : {}) }, integrationEnabled);
    }
    const spec = input.launchSpec;
    if (!spec) throw new AppError('NATIVE_LAUNCH_REQUIRED', 'A native terminal needs an adapter launch specification', 400);
    return { command: spec.command, args: [...spec.args], tmuxEnv: spec.env };
  }

  private behaviourFor(kind: TerminalInfo['kind'], sessionId: string | undefined, backendId: NativeBackendId | undefined): TerminalBehaviour | undefined {
    if (kind === 'shell' || kind === 'login') return undefined;
    return this.options.behaviour?.resolve({ kind, ...(sessionId ? { sessionId } : {}), ...(backendId ? { backendId } : {}) });
  }

  private launchEnv(): { managed: string[]; secrets: string[] } {
    const declared = this.options.behaviour?.launchEnv();
    for (const name of declared?.managed ?? []) this.seenLaunchEnv.managed.add(name);
    for (const name of declared?.secrets ?? []) this.seenLaunchEnv.secrets.add(name);
    return { managed: [...this.seenLaunchEnv.managed], secrets: [...this.seenLaunchEnv.secrets] };
  }

  private tmuxProcessEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...process.env, ...extra };
    for (const name of this.launchEnv().secrets) if (!extra || !Object.prototype.hasOwnProperty.call(extra, name)) delete env[name];
    return env;
  }

  private async runTmux(args: string[], timeout = 5000, extraEnv?: NodeJS.ProcessEnv, maxBuffer?: number): Promise<string> {
    return run('tmux', ['-S', this.socketPath, ...args], timeout, this.tmuxProcessEnv(extraEnv), maxBuffer);
  }

  private assertController(id: string, clientId: string, epoch: number): TerminalInfo {
    requireString(clientId, 'clientId', 200);
    const info = this.store.getTerminal(id);
    if (!Number.isInteger(epoch) || !info.ownerId || info.ownerId !== clientId || info.epoch !== epoch) {
      throw new AppError('TERMINAL_CONTROL_STALE', 'Terminal input lease is stale; claim control again', 409, { epoch: info.epoch, ownerId: info.ownerId });
    }
    if (info.state !== 'running') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
    return info;
  }

  private assertNoInteraction(id: string): void {
    if (this.interactions.has(id) || this.stopping.has(id) || (this.externalMutations.get(id) ?? 0) > 0 || this.pasteBuffers.has(id)) {
      throw this.interactionBusy();
    }
  }

  private beginExternalMutation(id: string, usesPasteBuffer = false): void {
    this.assertNoInteraction(id);
    if (usesPasteBuffer && this.pasteBuffers.has(id)) throw this.interactionBusy();
    this.externalMutations.set(id, (this.externalMutations.get(id) ?? 0) + 1);
  }

  private endExternalMutation(id: string, usesPasteBuffer = false): void {
    const remaining = (this.externalMutations.get(id) ?? 1) - 1;
    if (remaining > 0) this.externalMutations.set(id, remaining);
    else this.externalMutations.delete(id);
    if (usesPasteBuffer) this.pasteBuffers.delete(id);
    this.notifyOperationWaiters(id);
  }

  private hasExclusiveOperation(id: string): boolean {
    return this.interactions.has(id) || (this.externalMutations.get(id) ?? 0) > 0 || this.pasteBuffers.has(id);
  }

  private async waitForExclusiveOperation(id: string): Promise<void> {
    while (this.hasExclusiveOperation(id)) {
      await new Promise<void>(resolveWait => {
        const waiters = this.operationWaiters.get(id) ?? new Set<() => void>();
        waiters.add(resolveWait);
        this.operationWaiters.set(id, waiters);
      });
    }
  }

  private notifyOperationWaiters(id: string): void {
    if (this.hasExclusiveOperation(id)) return;
    const waiters = this.operationWaiters.get(id);
    if (!waiters) return;
    this.operationWaiters.delete(id);
    for (const resolveWait of waiters) resolveWait();
  }

  private assertInteractionCurrent(id: string, transaction: InteractionTransaction): void {
    const info = this.store.getTerminal(id);
    if (this.shuttingDown || this.stopping.has(id) || this.interactions.get(id) !== transaction || this.runtime.get(id) !== transaction.runtime || info.epoch !== transaction.epoch || info.state !== 'running') {
      throw new AppError('TERMINAL_INTERACTION_STALE', 'Terminal interaction lost control; read the current screen before continuing', 409, { epoch: info.epoch, ownerId: info.ownerId });
    }
    transaction.authorize?.();
  }

  private beforeInteractionWrite(id: string, transaction: InteractionTransaction): void {
    this.assertInteractionCurrent(id, transaction);
    if (!transaction.writeStarted) {
      transaction.beforeWrite?.();
      transaction.writeStarted = true;
    }
  }

  private interactionBusy(): AppError {
    return new AppError('TERMINAL_INTERACTION_BUSY', 'Another operation currently controls this terminal', 409);
  }

  private async hasSession(id: string): Promise<boolean> {
    try {
      await this.tmux(['has-session', '-t', terminalName(id)]);
      return true;
    } catch (error) {
      if (tmuxTargetMissing(error)) return false;
      throw error;
    }
  }

  private async killSession(id: string): Promise<void> {
    try { await this.tmux(['kill-session', '-t', terminalName(id)]); }
    catch (error) {
      if (tmuxTargetMissing(error)) return;
      throw error;
    }
  }

  private async tmux(args: string[]): Promise<string> {
    return await this.runTmux(args);
  }

  private prepareSocketDirectory(): void {
    mkdirSync(this.socketDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.socketDirectory, 0o700);
  }
}
