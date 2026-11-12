import type { NativeStatus } from '../../../../../packages/contracts/src/index.js';
import type { ClaudeProcess } from './session-state.js';

/**
 * A launched Claude is not ready when its SessionStart hook fires: on `--resume` the hook precedes the
 * redrawn input box. The hook only opens the ready gate; the screen has to show the composer after
 * that. Without it the gate gives up after this long and accepts the hook alone, so it can never
 * hold a session longer than a hook-only start would have.
 */
export const READY_GATE_MS = 10_000;
/** A launch with neither a session hook nor a readable input box by now is reported as failed rather than left `starting`. */
const STARTUP_FAILED_MS = 45_000;

/**
 * Armed only by a launch this process made, and only while that launch is `starting`. A terminal
 * found already running (the server restarted, or the session was reopened) has no gate: it is alive.
 */
export class ReadyGate {
  private gate?: { opened: boolean; failure: NodeJS.Timeout; timeout?: NodeJS.Timeout };

  constructor(private readonly deps: {
    phase(): NativeStatus['phase'];
    process(): ClaudeProcess;
    isDisposed(): boolean;
    onFail(): void;
    onOpen(): void;
  }) {}

  get opened(): boolean | undefined { return this.gate?.opened; }

  arm(): void {
    this.clear();
    const failure = setTimeout(() => {
      if (this.gate !== gate || this.deps.isDisposed() || this.deps.phase() !== 'starting') return;
      this.deps.onFail();
    }, STARTUP_FAILED_MS);
    failure.unref?.();
    const gate = this.gate = { opened: false, failure };
  }

  /** The session announced itself. That is not yet a prompt to type into; see `READY_GATE_MS`. */
  open(): void {
    const gate = this.gate;
    if (!gate || gate.opened) return;
    gate.opened = true;
    gate.timeout = setTimeout(() => {
      if (this.gate !== gate || this.deps.isDisposed() || this.deps.process() !== 'starting') return;
      this.deps.onOpen();
    }, READY_GATE_MS);
    gate.timeout.unref?.();
  }

  clear(): void {
    const gate = this.gate;
    if (!gate) return;
    clearTimeout(gate.failure);
    if (gate.timeout) clearTimeout(gate.timeout);
    this.gate = undefined;
  }
}
