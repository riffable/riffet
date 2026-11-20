import type { NativeInteraction, NativeStatus, Project, Session, TerminalInfo } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { ensureClaudeWorkspaceTrust } from '../shared/cli-trust.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeControlMessage, StandingLaunch } from '../types.js';
import { ClaudeHookBridge } from './hook-bridge.js';
import { ClaudeTranscript, findClaudeTranscript } from './history.js';
import { isClaudeScreenInteraction } from './screen-dialog.js';
import { type ClaudeSessionState, type ClaudeSignal, type Transition } from './session-state.js';
import { string, executableOf, runHelp, STANDING_ISOLATION, CLAUDE_PERMISSIONS, configDirOf, profileEnv, inspectSavedTerminal, permissionArgs, claudeAvailability } from './launch.js';
import { ClaudeHookOverlay } from './hook-overlay.js';
import { ClaudeInteractions } from './interactions.js';
import { LaunchCrashGuard } from './launch-guard.js';
import { ReadyGate } from './ready-gate.js';
import { normalizeClaudeModel, declaredLongContext, selectedModel, modelArgs, validateModelSelection, gatewayContextEnv } from './models.js';

/**
 * How long a picked model, effort, Fast or permission setting stands before an idle CLI is relaunched
 * for it. Each relaunch is a stop and a `--resume`, so adjusting three settings in a row is one.
 */
export const CLAUDE_CONFIG_SETTLE_MS = 1_200;

/**
 * Say out loud that the workbench answered Claude Code's trust gate, or that it could not. The
 * answer changes what runs in this directory without further review, so it is never silent.
 */
function trustNotice(result: { path: string; changed: boolean; error?: string }, cwd: string): string {
  if (result.error) return `已跳过 Claude Code 信任状态写入（${result.error}）；若启动后出现信任对话框，请在该会话的终端中确认。`;
  return `已把 ${cwd} 记入 Claude Code 的受信任目录（${result.path}），启动时不再询问。`;
}

/** What the group takes from `ClaudeSessionRuntime`: values read on demand and callbacks, never the runtime itself. */
export interface ClaudeTerminalBindingDeps {
  bridge: ClaudeHookBridge;
  host: NativeBackendHost;
  interactions: ClaudeInteractions;
  launchGuard: LaunchCrashGuard;
  nativeSessionId: string;
  overlay: ClaudeHookOverlay;
  project: Project;
  readyGate: ReadyGate;
  resumeRequested: boolean;
  transcript: ClaudeTranscript;
  disposed(): boolean;
  session(): Session;
  state(): ClaudeSessionState;
  status(): NativeStatus;
  dispatchSignal(signal: ClaudeSignal, status?: Omit<NativeStatus, 'phase'>): Transition;
  emit(message: NativeControlMessage): void;
  endorsesDialog(dialog: NativeInteraction): boolean;
  idleForRelaunch(): boolean;
  quiet(): boolean;
  refreshTranscript(follow?: boolean): Promise<void>;
  setScreenAttention(shown: boolean): void;
  setSession(session: Session): void;
  setStatus(requested: Omit<NativeStatus, 'phase'>): void;
}

/** The CLI process and its terminal: launching, taking over a running one, watching it exit, and relaunching for a recorded change of model, permission mode or profile. */
export class ClaudeTerminalBinding {
  terminalId?: string;
  started = false;
  profile: NativeBackendProfileConfig;
  private terminalStatusTask?: Promise<void>;
  private unsubscribeTerminal?: () => void;
  private observedTerminalId?: string;
  /** Counts launches, so a terminal inspection begun before one is not taken as news of the process it started. */
  private launches = 0;
  /** Said once, with the next launch: why it starts a conversation of its own. */
  private launchNotice?: string;
  /** The profile the running CLI was launched with; `profile` can already name the one it moves to next. */
  private launchedProfileId?: string;
  private terminalExitNotice?: { terminalId: string; message: string };
  private stagedConfig?: Pick<Session, 'model' | 'approval'>;
  terminalExited = false;
  private configuring = false;
  /** A picked setting is not applied before this moment (`deferConfig`). */
  private configSettlesAt = 0;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private startTask?: Promise<TerminalInfo | undefined>;

  constructor(private readonly deps: ClaudeTerminalBindingDeps, profile: NativeBackendProfileConfig, session: Session, launchNotice?: string) {
    this.profile = profile;
    this.terminalId = session.terminalId;
    // A saved terminal with no change waiting runs what the record says, on this profile.
    if (session.terminalId && !session.configPending) this.launchedProfileId = profile.id;
    this.launchNotice = launchNotice;
  }

  async setStartRequested(): Promise<void> { await this.start(); }

  /**
   * Whether Claude Code is really running for this session.
   *
   * `started` only means *this process* launched or took over the TUI. After a workbench restart the
   * session still carries its `terminalId` and the CLI behind it is alive, while the runtime was rebuilt
   * by `subscribe` and started nothing — so a caller that trusted `started` alone treated a running
   * CLI as absent.
   */
  isLive(): boolean { return this.started || (this.terminalId !== undefined && !this.terminalExited); }

  /**
   * Marks a configuration change as in flight, so a hook read stops following the CLI's own mode.
   *
   * Per-runtime, not per-session as in DSH: one Claude runtime already is one session.
   */
  setConfiguring(configuring: boolean): void { this.configuring = configuring; }

  /**
   * Follow the permission mode Claude Code reports for its own TUI.
   *
   * The mode can be changed inside the CLI (Shift+Tab, `/permissions`), and every hook then carries
   * the mode the TUI is really in. Adopting it is what keeps a later *partial* `configure` — which
   * merges the record (`{...session, ...patch}` → `stagedConfig`) — from pinning the CLI back to a
   * mode the user has already left.
   *
   * Only a label `--permission-mode` accepts is adopted. An unknown one is either a mode from a
   * newer CLI or a non-mode label, and writing it into the record would make the next launch fail
   * on an argument this build cannot validate (`permissionArgs`).
   *
   * @param reported - `permission_mode` from the hook payload, verbatim and untrusted.
   * @returns the approval to publish in the status.
   */
  adoptApproval(reported: unknown): string | undefined {
    const session = this.deps.host.getSession(this.deps.session().id);
    const recorded = session.approval;
    // The CLI still reports the mode being replaced while our own change is in flight; publishing
    // that would flicker the picker back, and writing it would undo the user's request.
    if (this.configuring || session.configPending) return this.deps.status().approval ?? recorded;
    const permission = string(reported);
    if (!permission || permission === recorded) return recorded;
    if (!CLAUDE_PERMISSIONS.some(item => item.id === permission)) return recorded;
    // The meaning moved, so the record's revision has to move with it: a client holding the old
    // settings finds out before it submits rather than after (the store compares its expectation).
    // A message already waiting in the queue is delivered under the mode in effect when it starts.
    const updated = this.deps.host.bumpConfig(session.id, { approval: permission });
    this.deps.setSession({ ...this.deps.session(), approval: permission, configRevision: updated.configRevision ?? this.deps.session().configRevision });
    this.deps.emit({ type: 'session', session: updated });
    return permission;
  }

  /** A recorded switch survives old hooks and is applied only once nothing is running. */
  async applyPendingConfig(): Promise<void> {
    if (this.deps.disposed() || this.configuring || this.startTask || Date.now() < this.configSettlesAt || !this.deps.idleForRelaunch()
      || !this.deps.host.getSession(this.deps.session().id).configPending) return;
    this.configuring = true;
    try {
      await this.deps.host.withSessionLock(this.deps.session().id, async () => {
        const current = this.deps.host.getSession(this.deps.session().id);
        if (this.deps.disposed() || current.archivedAt || !current.configPending || !this.deps.idleForRelaunch()) return;
        const opened = this.started ? await this.reconfigure(current) : await this.start();
        if (this.deps.disposed()) return;
        // A pick that landed while this relaunch ran is still waiting for one of its own.
        const pending = !this.launchedMatches(this.deps.host.getSession(current.id));
        const updated = this.deps.host.updateSession(current.id, {
          configPending: pending, ...(opened.terminalId ? { terminalId: opened.terminalId } : {}),
        });
        this.deps.emit({ type: 'session', session: updated });
        if (pending) this.deferConfig();
      });
    } catch (error) {
      if (!(error instanceof AppError) || !['CLI_BUSY', 'CLI_INTERACTION_REQUIRED'].includes(error.code)) {
        this.deps.setStatus({ ...this.deps.status(), notice: error instanceof Error ? error.message : 'Claude settings could not be applied.', noticeLevel: 'error' });
      }
    } finally { this.configuring = false; }
  }

  /** Cold monitoring only observes the saved PTY. It never launches or writes to Claude. */
  async refreshTerminalStatus(force = false): Promise<void> {
    if (this.deps.disposed() || (this.started && !force)) return;
    if (this.terminalStatusTask) return await this.terminalStatusTask;
    const task = (async () => {
      const session = this.deps.host.getSession(this.deps.session().id);
      if (!session.terminalId) {
        if (this.startTask) this.deps.dispatchSignal({ type: 'process', process: 'starting' });
        else this.deps.dispatchSignal({ type: 'process', process: 'exited' }, { ...this.deps.status(), notice: undefined, noticeLevel: undefined });
        return;
      }
      const observedSession = this.terminalId && (this.started || this.startTask)
        ? { ...session, terminalId: this.terminalId }
        : session;
      const sessionId = this.deps.nativeSessionId;
      const launches = this.launches;
      const inspected = await inspectSavedTerminal(this.deps.host, observedSession, dialog => this.deps.endorsesDialog(dialog));
      // A launch begun meanwhile, or still under way, speaks for the process: the terminal inspected may be the one it
      // replaces, and its exit must not mark the new CLI gone.
      if (this.deps.disposed() || sessionId !== this.deps.nativeSessionId || launches !== this.launches
        || (this.startTask && inspected.process === 'exited')
        || this.deps.host.getSession(this.deps.session().id).terminalId !== session.terminalId) return;
      if (inspected.terminal) {
        this.terminalId = inspected.terminal.id;
        if (inspected.terminal.kind === 'native' && inspected.terminal.sessionId === this.deps.session().id && inspected.terminal.state !== 'exited') {
          this.terminalExited = false;
          if (this.observedTerminalId !== inspected.terminal.id) this.attachTerminal(inspected.terminal.id);
        }
      }
      if (inspected.process === 'exited' && inspected.terminal?.state === 'exited') {
        this.terminalExited = true;
        this.started = false;
      }
      // The inspection is the authority on whether anything still needs saying, so its notice wins
      // even when it has none. A warning from a previous inspection must clear when it recovers.
      // Likewise a screen dialog that has gone must not linger, but a hook-held request still stands —
      // and outranks the dialog the CLI draws for that same request, which it alone can answer (see `refreshScreenState`).
      const held = this.deps.interactions.hasPending() || this.deps.status().interaction?.transport === 'protocol';
      const keepInteraction = held || (this.deps.status().interaction !== undefined && !isClaudeScreenInteraction(this.deps.status().interaction));
      this.deps.setScreenAttention(!held && (inspected.interaction !== undefined || inspected.observed === true));
      const interaction = held ? this.deps.status().interaction : inspected.interaction ?? (keepInteraction ? this.deps.status().interaction : undefined);
      if (inspected.process === 'alive') this.terminalExitNotice = undefined;
      const exitNotice = inspected.process === 'exited' && inspected.terminal?.id === this.terminalExitNotice?.terminalId
        ? this.terminalExitNotice?.message : undefined;
      const status: NativeStatus = { ...this.deps.status(), notice: inspected.notice ?? exitNotice, noticeLevel: inspected.notice ? 'warning' : exitNotice ? 'error' : undefined, interaction, model: this.deps.status().model ?? this.deps.session().model };
      if (inspected.process === 'unknown') {
        // Neither proof of life nor of exit: the transcript's state stands, with a notice.
        if (this.deps.state().process === 'starting') this.deps.dispatchSignal({ type: 'process', process: 'alive' }, status);
        else this.deps.setStatus(status);
        return;
      }
      if (inspected.process === 'exited') { this.deps.dispatchSignal({ type: 'process', process: 'exited' }, status); return; }
      this.deps.dispatchSignal({ type: 'process', process: 'alive' }, status);
    })();
    this.terminalStatusTask = task;
    try { await task; }
    finally { if (this.terminalStatusTask === task) this.terminalStatusTask = undefined; }
  }

  async start(): Promise<{ nativeSessionId: string; terminalId?: string }> {
    if (this.deps.disposed()) throw new AppError('CLAUDE_RUNTIME_DISPOSED', 'Claude runtime has been closed', 503);
    if (this.started && this.terminalId) {
      const current = this.deps.host.getSession(this.deps.session().id);
      if (selectedModel(current, this.profile) !== selectedModel(this.deps.session(), this.profile) || current.approval !== this.deps.session().approval
        || this.launchedProfileId !== this.profile.id) {
        this.setConfiguring(true);
        try { return await this.reconfigure(current); }
        finally { this.setConfiguring(false); }
      }
      return { nativeSessionId: this.deps.nativeSessionId, terminalId: this.terminalId };
    }
    if (this.startTask) {
      const terminal = await this.startTask;
      return { nativeSessionId: this.deps.nativeSessionId, ...(terminal ? { terminalId: terminal.id } : {}) };
    }
    this.startTask = this.startTui();
    try {
      const terminal = await this.startTask;
      this.started = Boolean(terminal);
      if (terminal) this.terminalId = terminal.id;
      return { nativeSessionId: this.deps.nativeSessionId, ...(terminal ? { terminalId: terminal.id } : {}) };
    } finally { this.startTask = undefined; }
  }

  private async startTui(): Promise<TerminalInfo | undefined> {
    const persisted = this.deps.host.getSession(this.deps.session().id);
    const current = this.stagedConfig ? { ...persisted, ...this.stagedConfig } : persisted;
    const model = selectedModel(current, this.profile);
    await validateModelSelection(this.profile, model);
    const availability = await claudeAvailability(this.profile);
    if (!availability.available) throw new AppError('CLAUDE_UNAVAILABLE', availability.reason ?? 'Claude Code is unavailable', 503);
    const adopted = await this.adoptExistingTerminal();
    if (adopted) return adopted;
    await this.deps.overlay.ensureHookServer(model);
    const configDir = configDirOf(this.profile);
    // The workspace-trust dialog appears before any session exists, so no hook can answer it. Claude
    // Code persists the answer per project; recording it here is what keeps the launch in the web
    // UI. Only the profile's own `configDir` is passed: `configDirOf` defaults it to `~/.claude`,
    // which would move the global config to `~/.claude/.claude.json` — a path Claude never reads.
    const trust = ensureClaudeWorkspaceTrust({ configHome: string(this.profile.config.configDir), cwd: this.deps.project.cwd });
    const oldTranscript = await findClaudeTranscript(configDir, this.deps.nativeSessionId);
    if (this.deps.resumeRequested && !oldTranscript) throw new AppError('CLAUDE_SESSION_NOT_FOUND', 'The saved Claude session could not be found in this profile', 404);
    if (oldTranscript) {
      await this.deps.transcript.setFile(oldTranscript);
      // What the old CLI left behind is history: it is read before the launch, which then starts turn-free.
      await this.deps.refreshTranscript();
    }
    const standing = this.deps.host.standing?.launch(this.deps.project, this.deps.session());
    const mcpConfigs = [this.deps.overlay.mcpConfigFile, ...(standing?.mcpConfigFiles ?? [])].filter((file): file is string => Boolean(file));
    const args = [
      ...(oldTranscript ? ['--resume', this.deps.nativeSessionId] : ['--session-id', this.deps.nativeSessionId]),
      // Riffet's own MCP server for this launch only; the reader's MCP configuration still loads beside it
      // (a standing conversation loads its own directory's instead).
      ...(mcpConfigs.length ? ['--mcp-config', ...mcpConfigs] : []),
      '--settings', this.deps.overlay.overlayFile!,
      ...(standing ? await this.standingArgs(standing, model) : []),
      ...modelArgs(model, await declaredLongContext(this.profile, model)),
      ...permissionArgs(current.approval ?? string(this.profile.config.approval)),
    ];
    const launchNotice = this.launchNotice;
    this.launchNotice = undefined;
    // The hooks find the server through the descriptor. The endpoint's token would let anything the CLI runs speak as any
    // conversation, so it is put in the environment only where there is no descriptor to read.
    const env = {
      ...profileEnv(this.profile),
      ...(this.deps.bridge.descriptorPath ? {} : { RIFFET_CLAUDE_HOOK_URL: this.deps.overlay.hookUrl!, RIFFET_CLAUDE_HOOK_TOKEN: this.deps.overlay.hookToken! }),
    };
    this.deps.setSession(current);
    // From here the terminal being replaced no longer speaks for the process: its exit, reported late, would mark the
    // new CLI gone. The launched terminal is observed once it exists (`attachTerminal`).
    this.launches += 1;
    this.unsubscribeTerminal?.();
    this.unsubscribeTerminal = undefined;
    this.observedTerminalId = undefined;
    this.deps.dispatchSignal({ type: 'process', process: 'starting' }, {
      transcript: this.deps.transcript.state,
      model: selectedModel(current, this.profile), approval: current.approval,
      ...(launchNotice || (trust && (trust.changed || trust.error)) ? { notice: [launchNotice, trust && (trust.changed || trust.error) ? trustNotice(trust, this.deps.project.cwd) : undefined].filter(Boolean).join(' '), noticeLevel: trust?.error ? 'error' : launchNotice ? 'warning' : 'info' } : {}),
    });
    const terminal = await this.deps.host.launchPty(current, this.deps.project, {
      command: executableOf(this.profile), args, env, cwd: this.deps.project.cwd,
      title: 'Claude Agent',
    });
    this.terminalId = terminal.id;
    this.launchedProfileId = this.profile.id;
    this.deps.launchGuard.begin(terminal.id);
    this.attachTerminal(terminal.id);
    if (this.deps.state().process === 'starting') this.deps.readyGate.arm();
    if (this.deps.host.getSession(current.id).configPending) this.deps.host.updateSession(current.id, { configPending: false });
    return terminal;
  }

  /**
   * A CLI that outlived the server is taken over, never restarted: its hooks reach whichever server
   * is up (the descriptor), and what it is doing is read back from its transcript. The one exception
   * is a recorded model or permission change, which only a new launch can apply, and only while
   * nothing is running that a relaunch would end.
   */
  private async adoptExistingTerminal(): Promise<TerminalInfo | undefined> {
    const session = this.deps.host.getSession(this.deps.session().id);
    if (!session.terminalId) return undefined;
    const terminal = await this.deps.host.terminal.get(session.terminalId).catch(() => undefined);
    if (!terminal || terminal.kind !== 'native' || terminal.sessionId !== session.id || terminal.state === 'exited') return undefined;
    await this.deps.overlay.registerHooks();
    await this.deps.refreshTranscript();
    if (session.configPending) {
      if (!this.deps.quiet()) throw new AppError('CLI_BUSY', 'Claude Code is still active in the existing terminal. Stop or finish that turn before applying the new settings.', 409);
      await this.deps.host.terminal.stop(terminal.id);
      this.terminalId = undefined;
      return undefined;
    }
    this.terminalId = terminal.id;
    this.launchedProfileId = this.profile.id;
    this.terminalExited = false;
    this.attachTerminal(terminal.id);
    this.deps.dispatchSignal({ type: 'process', process: 'alive' }, { ...this.deps.status(), notice: undefined, noticeLevel: undefined });
    return terminal;
  }

  private attachTerminal(terminalId: string): void {
    this.unsubscribeTerminal?.();
    this.terminalExited = false;
    this.observedTerminalId = terminalId;
    this.terminalExitNotice = undefined;
    let exitHandled = false;
    const exited = () => {
      if (exitHandled) return;
      exitHandled = true;
      this.terminalExited = true;
      this.started = false;
      const crashNotice = this.deps.launchGuard.noteLaunchExit(terminalId);
      this.terminalExitNotice = crashNotice ? { terminalId, message: crashNotice } : undefined;
      this.deps.dispatchSignal({ type: 'process', process: 'exited' }, { notice: crashNotice, noticeLevel: 'error' });
    };
    this.unsubscribeTerminal = this.deps.host.terminal.observe(terminalId, observation => {
      if (observation.type === 'exit' || (observation.type === 'state' && observation.terminal.state === 'exited')) exited();
    });
  }

  /**
   * A standing conversation (docs/ASSISTANT.md §4) runs on its own directory: its system prompt replaces the CLI's,
   * and the owner's instructions, skills, plugins and MCP servers are left out. Sign-in is unaffected, since the
   * profile's config directory is still the one in use.
   */
  private async standingArgs(standing: StandingLaunch, model: string | undefined): Promise<string[]> {
    const args = ['--system-prompt-file', standing.systemPromptFile, ...STANDING_ISOLATION, ...standing.pluginDirs.flatMap(dir => ['--plugin-dir', dir])];
    // A gateway model with a declared window no larger than the threshold already summarizes before it.
    const declared = Number((await gatewayContextEnv(this.profile, model)).CLAUDE_CODE_MAX_CONTEXT_TOKENS);
    const probe = await runHelp(executableOf(this.profile)).catch(() => undefined);
    if (probe?.help.includes('--autocompact') && !(declared <= standing.compactAtTokens)) args.push('--autocompact', String(standing.compactAtTokens));
    return args;
  }

  get profileId(): string { return this.profile.id; }

  /** Whether the running CLI was launched with `next`'s model, permission mode and profile. */
  launchedMatches(next: Session, profile: NativeBackendProfileConfig = this.profile): boolean {
    const approval = (value: Session) => value.approval ?? string(profile.config.approval) ?? 'default';
    return profile.id === this.launchedProfileId
      && normalizeClaudeModel(selectedModel(next, profile) ?? '') === normalizeClaudeModel(selectedModel(this.deps.session(), profile) ?? '')
      && approval(next) === approval(this.deps.session());
  }

  /** Applies the recorded change once nothing new has been picked for `CLAUDE_CONFIG_SETTLE_MS`. */
  deferConfig(): void {
    this.configSettlesAt = Date.now() + CLAUDE_CONFIG_SETTLE_MS;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { this.settleTimer = undefined; void this.applyPendingConfig(); }, CLAUDE_CONFIG_SETTLE_MS);
    this.settleTimer.unref?.();
  }

  /** The profile the next launch uses; a CLI already running keeps its own until it is relaunched. */
  useProfile(profile: NativeBackendProfileConfig): void { this.profile = profile; }

  async reconfigure(next: Session, profile: NativeBackendProfileConfig = this.profile): Promise<{ nativeSessionId: string; terminalId?: string }> {
    if (this.deps.disposed()) throw new AppError('CLAUDE_RUNTIME_DISPOSED', 'Claude runtime has been closed', 503);
    // A repeated selection is harmless even while work runs. Compare the applied launch settings,
    // not just the record: the latter can already contain a switch waiting for this turn to end.
    if (this.started && !this.terminalExited && this.terminalId && this.launchedMatches(next, profile)) {
      return { nativeSessionId: this.deps.nativeSessionId, terminalId: this.terminalId };
    }
    if (this.deps.status().phase === 'attention' || this.deps.status().phase === 'starting' || !this.deps.quiet()) {
      throw new AppError(this.deps.status().phase === 'attention' ? 'CLI_INTERACTION_REQUIRED' : 'CLI_BUSY', 'Claude Code must finish its turn and background work before changing its model or permission mode', 409);
    }
    await validateModelSelection(profile, selectedModel(next, profile));
    this.profile = profile;
    if (this.terminalId) {
      const terminalId = this.terminalId;
      this.unsubscribeTerminal?.();
      this.unsubscribeTerminal = undefined;
      this.observedTerminalId = undefined;
      await this.deps.host.terminal.stop(terminalId);
      this.started = false;
      this.terminalId = undefined;
    }
    this.stagedConfig = { model: next.model, approval: next.approval };
    this.deps.setSession({ ...next, nativeSessionId: this.deps.nativeSessionId });
    try {
      const opened = await this.start();
      return opened;
    } finally { this.stagedConfig = undefined; }
  }

  /** Stops watching the terminal and drops the pending settle; the CLI itself keeps running. */
  dispose(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.unsubscribeTerminal?.();
    this.unsubscribeTerminal = undefined;
    this.observedTerminalId = undefined;
  }
}
