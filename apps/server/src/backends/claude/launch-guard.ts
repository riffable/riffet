import type { Session } from '../../../../../packages/contracts/src/index.js';
import type { NativeBackendHost } from '../types.js';

/** A CLI that exits sooner than this after its launch did not get going. */
export const QUICK_EXIT_MS = 30_000;
/** Consecutive quick exits after which the next launch drops `--resume` and starts a conversation of its own. */
export const QUICK_EXIT_LIMIT = 2;

export class LaunchCrashGuard {
  /** The launch being timed for crash protection, and the timer that clears the count once it has survived. */
  private launch?: { terminalId: string; at: number };
  private healthyTimer?: NodeJS.Timeout;

  constructor(private readonly deps: {
    host: NativeBackendHost;
    session(): Session;
    isDisposed(): boolean;
    isTerminalExited(): boolean;
  }) {}

  begin(terminalId: string): void {
    this.launch = { terminalId, at: Date.now() };
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.healthyTimer = setTimeout(() => {
      this.healthyTimer = undefined;
      if (!this.deps.isDisposed() && !this.deps.isTerminalExited() && this.launch?.terminalId === terminalId) {
        try { this.clearQuickExits(); } catch { /* the session may be gone */ }
      }
    }, QUICK_EXIT_MS);
    this.healthyTimer.unref?.();
  }

  /** Stops the timer that would clear the count; the runtime is closing. */
  dispose(): void {
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
  }

  /**
   * Crash protection. A CLI that exits within `QUICK_EXIT_MS` of the launch this runtime made counts as
   * a quick exit; the count is kept on the session, so it survives a workbench restart, and a launch
   * that lives past the window clears it. At `QUICK_EXIT_LIMIT` the adapter's next open starts afresh
   * (see `openOrResume`). Returns what to tell the reader when that point is reached.
   */
  noteLaunchExit(terminalId: string): string | undefined {
    const launch = this.launch;
    if (!launch || launch.terminalId !== terminalId || this.deps.isDisposed()) return undefined;
    this.launch = undefined;
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.healthyTimer = undefined;
    try {
      if (Date.now() - launch.at >= QUICK_EXIT_MS) { this.clearQuickExits(); return undefined; }
      const count = (this.deps.host.getSession(this.deps.session().id).quickExitCount ?? 0) + 1;
      this.deps.host.updateSession(this.deps.session().id, { quickExitCount: count });
      return count >= QUICK_EXIT_LIMIT ? '它已连续多次在启动后立即退出；下次启动将不再恢复旧会话，改为全新启动。' : undefined;
    } catch { return undefined; }
  }

  private clearQuickExits(): void {
    if ((this.deps.host.getSession(this.deps.session().id).quickExitCount ?? 0) > 0) this.deps.host.updateSession(this.deps.session().id, { quickExitCount: 0 });
  }
}
