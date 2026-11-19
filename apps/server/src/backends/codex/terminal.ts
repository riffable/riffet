import type { Project, Session } from '../../../../../packages/contracts/src/index.js';
import { codexTrustArgs } from '../shared/cli-trust.js';
import { AppError } from '../../errors.js';
import { sameTerminalAppearance } from '../../terminal/appearance.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativePtyLaunchSpec } from '../types.js';
import type { CodexConnection } from './connection.js';
import { executableOf, probeAppServer, TUI_TOKEN_ENV } from './config.js';
import { codexInvocation, codexInvocationFingerprint, codexTerminalEndpoint } from './endpoint.js';
import { isMissingTerminalError } from './errors.js';
import type { CodexFlavor } from './flavors.js';
import type { CodexObservation } from './observation.js';
import type { TerminalEndpointState } from './types.js';

/** What `CodexTerminal` needs from the runtime that owns it. */
export interface CodexTerminalContext {
  readonly host: NativeBackendHost;
  readonly project: Project;
  readonly profile: NativeBackendProfileConfig;
  readonly flavor: CodexFlavor;
  /** Reports what shell commands change in the working tree (`observation.ts`). */
  readonly observation?: CodexObservation;
  /** The session as this runtime last saw it, for the launch of a terminal. */
  session(): Session;
  threadId(): string | undefined;
  /** Whether a turn, a dispatch or a request is in flight, which a relaunch must not cut off. */
  turnInFlight(): boolean;
}

/**
 * The terminal client that shares this runtime's app-server: launching it, relaunching it for a
 * colour change, and confirming that it is connected to the endpoint the runtime writes through.
 *
 * It owns the terminal's id, the last endpoint check and its result, whether the app-server can be
 * shared with a terminal at all, and a colour change waiting for a turn to end.
 *
 * It does not own the app-server connection: a check that finds the terminal on another endpoint
 * tells the connection to block writes, and a confirmed one tells it to open them again. The
 * connection's status stays with the runtime's `refreshStatus`.
 */
export class CodexTerminal {
  private terminalId: string | undefined;
  private checkedAt = 0;
  private state: TerminalEndpointState = 'absent';
  private check?: Promise<TerminalEndpointState>;
  /** Set when the app-server could not be shared privately, so no TUI may attach to it. */
  private unavailable = false;
  /** A colour change waiting for the turn to end before the TUI is relaunched to probe it. */
  private pendingAppearance = false;

  constructor(private readonly ctx: CodexTerminalContext, private readonly connection: CodexConnection, terminalId: string | undefined) {
    this.terminalId = terminalId;
  }

  private get label(): string { return this.ctx.flavor.label; }

  get id(): string | undefined { return this.terminalId; }
  /** The result of the last endpoint check, which the connection's conflict message reads. */
  get endpointStateValue(): TerminalEndpointState { return this.state; }
  get appearancePending(): boolean { return this.pendingAppearance; }

  /** The session names a terminal this runtime did not know: its endpoint is checked again. */
  adoptTerminal(id: string | undefined): void {
    if (id && id !== this.terminalId) {
      this.terminalId = id;
      this.checkedAt = 0;
    }
  }

  /** The terminal this runtime drives, without a new endpoint check. */
  bind(id: string | undefined): void {
    this.terminalId = id;
  }

  noteUnavailable(unavailable: boolean): void {
    this.unavailable ||= unavailable;
  }

  /**
   * The launch of a terminal client joining this runtime's app-server, or undefined where the build
   * or the endpoint offers no shared transport. `ensureTui` starts it as Riffet's own terminal;
   * `terminalLaunch` hands it to the reader's terminal.
   */
  async tuiLaunchSpec(): Promise<NativePtyLaunchSpec | undefined> {
    const { project, profile, flavor } = this.ctx;
    const transport = this.connection.transport;
    if (!transport) return undefined;
    // A recovered old process has no recoverable launch config beyond its hash. Do not launch a
    // new remote TUI with the edited provider flags; the protocol conversation remains usable.
    if (this.connection.transportBorrowed && this.connection.profilePending) return undefined;
    const probe = await probeAppServer(executableOf(profile, flavor));
    const shared = flavor.terminalTransport(probe);
    if (shared === 'none' || this.unavailable) return undefined;
    const address = transport.remoteAddress;
    if (shared === 'ws' ? !address.startsWith('ws:') || !transport.authToken : !address.startsWith('unix:')) return undefined;
    const token = shared === 'ws' ? transport.authToken : undefined;
    const command = executableOf(profile, flavor);
    // Riffet's own observation hooks are confirmed on the server first, so the TUI does not ask
    // about them each time it starts; a failure leaves the CLI's prompt as the fallback.
    await this.ctx.observation?.trust(transport, project.cwd).catch(() => undefined);
    // Directory trust is a global override, so it stays ahead of `resume`. Review of other hooks
    // remains the CLI's own prompt, lifted into Riffet by TerminalDialogObserver; the CLI persists
    // each trusted hook hash. Disable the separate startup update prompt, which otherwise returns
    // after every Codex release until the reader dismisses it in the terminal.
    const args = [
      ...flavor.args(profile.config), ...codexTrustArgs(project.cwd), '-c', 'check_for_update_on_startup=false',
      '--remote', address, ...(token ? ['--remote-auth-token-env', TUI_TOKEN_ENV] : []),
      // Riffet scrolls tmux history. A full-screen TUI leaves that history empty, so use the
      // CLI's inline mode when this installed build advertises it.
      ...(probe.noAltScreen ? ['--no-alt-screen'] : []),
      '--cd', project.cwd, 'resume', this.ctx.threadId()!,
    ];
    const invocation = codexInvocation([command, ...args], project.cwd, this.ctx.threadId()!);
    return {
      command,
      args,
      env: flavor.env(profile.config),
      ...(token ? { secretEnv: { [TUI_TOKEN_ENV]: token } } : {}),
      cwd: project.cwd,
      title: this.label,
      // Recovery still matches the live pane's argv and cwd; this only rules out a look-alike launch.
      ...(invocation ? { launchMarker: codexInvocationFingerprint(invocation) } : {}),
    };
  }

  async ensureTui(): Promise<string | undefined> {
    const { host } = this.ctx;
    // While a terminal holds the conversation it is the only client; Riffet's own TUI must not come back.
    if (host.getSession(this.ctx.session().id).terminalHold) return undefined;
    this.connection.assertWritable();
    if (!this.connection.transport) return undefined;
    let existing: Awaited<ReturnType<NativeBackendHost['terminal']['get']>> | undefined;
    if (this.terminalId) {
      try { existing = await host.terminal.get(this.terminalId); }
      catch (error) {
        if (!isMissingTerminalError(error)) {
          this.connection.deferForEndpointConflict();
          throw new AppError('NATIVE_ENDPOINT_CONFLICT', `The ${this.label} terminal state could not be verified, so no new terminal was started.`, 409);
        }
      }
    }
    if (existing?.state === 'running') {
      // The write gate just verified this terminal. Reuse that short-lived proof instead of
      // scanning the same process tree again and turning a transient timeout into a conflict.
      const state = await this.endpointState(true);
      if (state === 'verified') return existing.id;
      // A running TUI may be the only remaining owner of this thread. Never replace it based on
      // an in-memory transport identity or a profile change; the terminal worker verifies the
      // actual endpoint when it can.
      this.connection.deferForEndpointConflict();
      throw new AppError('NATIVE_ENDPOINT_CONFLICT', this.connection.endpointConflictMessage(), 409);
    }
    if (existing && existing.state !== 'exited') {
      this.connection.deferForEndpointConflict();
      throw new AppError('NATIVE_ENDPOINT_CONFLICT', `A ${this.label} terminal is still changing state and its endpoint is not verified.`, 409);
    }
    const spec = await this.tuiLaunchSpec();
    if (!spec) return undefined;
    const terminal = await host.launchPty(this.ctx.session(), this.ctx.project, spec);
    this.terminalId = terminal.id;
    this.checkedAt = 0;
    return terminal.id;
  }

  /**
   * Relaunches the remote TUI so it probes the session's current terminal colours: Codex reads them
   * once at startup and keeps its diff and composer palette for the life of the process. The thread
   * lives in the app-server, so the new TUI resumes it unchanged. A turn in flight is never cut off;
   * the relaunch waits for it to settle. Callers hold the session lock.
   */
  async relaunchTuiForAppearance(): Promise<void> {
    const { host, flavor, profile } = this.ctx;
    if (this.ctx.turnInFlight()) {
      this.pendingAppearance = true;
      return;
    }
    this.pendingAppearance = false;
    const terminalId = this.terminalId;
    if (!terminalId || !this.connection.transport?.isOnline || this.unavailable || this.connection.profilePending) return;
    const current = await host.terminal.get(terminalId).catch(() => undefined);
    const wanted = host.getSession(this.ctx.session().id).terminalAppearance;
    if (!current || current.state !== 'running' || !wanted || sameTerminalAppearance(current.appearance, wanted)) return;
    // Stop the old TUI only where `ensureTui` will launch its successor: a writable runtime whose
    // terminal is verified on this endpoint, and a build that still offers a remote TUI on it.
    if (host.getSession(this.ctx.session().id).terminalHold) return;
    try { this.connection.assertWritable(); } catch { return; }
    if (await this.endpointState(true) !== 'verified') return;
    const shared = flavor.terminalTransport(await probeAppServer(executableOf(profile, flavor)));
    const address = this.connection.transport?.remoteAddress;
    if (!address || shared === 'none' || (shared === 'ws' ? !address.startsWith('ws:') || !this.connection.transport?.authToken : !address.startsWith('unix:'))) return;
    await host.terminal.stop(terminalId);
    await this.ensureTui();
  }

  async endpointState(force = false): Promise<TerminalEndpointState> {
    const { host } = this.ctx;
    if (!this.terminalId || !this.ctx.threadId() || !this.connection.transport?.remoteAddress) return this.confirmEndpoint('absent');
    if (this.check) {
      const checking = this.check;
      const state = await checking;
      if (!force || state !== 'unknown') return state;
      if (this.check === checking) this.check = undefined;
      // Another caller may already have started the fresh check while this one was waiting.
      if (this.check) return await this.check;
    }
    const elapsed = Date.now() - this.checkedAt;
    if (this.checkedAt && elapsed < 2_500 && (!force || elapsed < 750)
      && (!force || this.state !== 'unknown')) return this.state;
    const task = (async () => {
      // A read-only scan can time out while tmux or the event loop is busy. A user action gets
      // one fresh retry, but a changed endpoint or two unverified scans still block every write.
      for (let attempt = 0; attempt < (force ? 2 : 1); attempt += 1) {
        const terminalId = this.terminalId;
        const threadId = this.ctx.threadId();
        const address = this.connection.transport?.remoteAddress;
        let state: TerminalEndpointState = 'unknown';
        try {
          if (!terminalId || !threadId || !address) state = 'absent';
          else {
            let terminal: Awaited<ReturnType<NativeBackendHost['terminal']['get']>> | undefined;
            try { terminal = await host.terminal.get(terminalId); }
            catch (error) { if (!isMissingTerminalError(error)) throw error; }
            if (!terminal || terminal.state === 'exited') state = 'absent';
            else if (terminal.state === 'running') {
              const endpoint = await this.endpoint(terminalId, threadId);
              state = endpoint ? endpoint === address ? 'verified' : 'changed' : 'unknown';
            }
          }
        } catch { /* Retry an unverified scan without sending or replacing anything. */ }
        // A scan of a previous binding cannot verify the terminal selected while it was in flight.
        if (terminalId !== this.terminalId || threadId !== this.ctx.threadId() || address !== this.connection.transport?.remoteAddress) continue;
        if (state === 'unknown') continue;
        if (state === 'changed') {
          this.state = state;
          this.checkedAt = Date.now();
          this.connection.deferForEndpointConflict();
        } else {
          this.confirmEndpoint(state);
        }
        return state;
      }
      this.state = 'unknown';
      this.checkedAt = Date.now();
      this.connection.deferForEndpointConflict();
      return 'unknown' as const;
    })();
    this.check = task;
    try { return await task; }
    finally { if (this.check === task) this.check = undefined; }
  }

  private confirmEndpoint(state: 'absent' | 'verified'): 'absent' | 'verified' {
    const wasBlocked = this.connection.clearEndpointBlock();
    this.state = state;
    this.checkedAt = Date.now();
    this.connection.settleAfterEndpoint(wasBlocked);
    return state;
  }

  async endpoint(terminalId: string, threadId: string): Promise<string | undefined> {
    return await codexTerminalEndpoint(this.ctx.host, this.ctx.session().id, terminalId, threadId, this.ctx.project.cwd, this.connection.transport?.remoteAddress);
  }
}
