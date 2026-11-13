import type { PluginLogEntry } from '../../../../packages/contracts/src/plugin-management.js';
import { describeError, type Entry } from './entry.js';

/** Pauses before an isolated package whose process died is started again; after the last one it stays off until someone refreshes it. */
export const RESTART_DELAYS_MS = [2_000, 10_000, 60_000] as const;
/** A restarted process that stays up this long has its attempts counted from the start again. */
export const RESTART_STABLE_MS = 600_000;

/** What restart scheduling needs of the registry. */
export interface RestartsPort {
  closed(): boolean;
  recovery(): boolean;
  evaluateAll(ids: readonly string[]): Promise<unknown>;
  dependents(id: string): string[];
  log(entry: Entry, level: PluginLogEntry['level'], phase: string, message: string): void;
  entry(id: string): Entry | undefined;
  restartDelaysMs: readonly number[];
  restartStableMs: number;
}

export class Restarts {
  constructor(private readonly port: RestartsPort) {}

  /** Forgets pending restarts of `entry`; `attempts` too unless the entry is on its way to the next one. */
  clearRestarts(entry: Entry, all = true): void {
    const state = entry.restarts;
    if (!state) return;
    clearTimeout(state.timer); state.timer = undefined;
    if (all) { clearTimeout(state.stable); state.stable = undefined; }
  }

  /** A process that stays up for a while is no longer failing: its next failure starts the delays again. */
  armStable(entry: Entry): void {
    const state = entry.restarts;
    if (!state || !state.attempts || this.port.closed()) return;
    clearTimeout(state.stable);
    state.stable = setTimeout(() => { state.attempts = 0; state.stable = undefined; }, this.port.restartStableMs);
    state.stable.unref();
  }

  /**
   * After a live process died and the entry was deactivated: starts it again after the next delay, by the same evaluation a
   * refresh does (so detection, requirements and dependents are decided as usual). When the delays are used up it stays off with its problem.
   */
  scheduleRestart(entry: Entry): void {
    const state = entry.restarts ??= { attempts: 0 };
    clearTimeout(state.stable); state.stable = undefined;
    clearTimeout(state.timer); state.timer = undefined;
    if (this.port.closed() || this.port.recovery()) return;
    const id = entry.plugin.manifest.id;
    if (state.attempts >= this.port.restartDelaysMs.length) {
      if (entry.problem && !entry.active) {
        entry.problem = `${entry.problem} (automatic restarts stopped; refresh the plugin to start it again)`;
        this.port.log(entry, 'warn', 'restart', `Automatic restarts stopped after ${state.attempts} attempts`);
      }
      return;
    }
    const delay = this.port.restartDelaysMs[state.attempts]!;
    const attempt = ++state.attempts;
    const { plugin, version, generation } = entry;
    this.port.log(entry, 'warn', 'restart', `Restarting in ${delay / 1000} s (attempt ${attempt} of ${this.port.restartDelaysMs.length})`);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      // Anything that changed the entry meanwhile (turned off or on, reloaded, switched, removed) has decided for itself.
      if (this.port.closed() || this.port.entry(id) !== entry || entry.active || entry.starting || entry.generation !== generation || entry.plugin !== plugin || entry.version !== version) return;
      void (async () => {
        await this.port.evaluateAll([id, ...this.port.dependents(id)]);
        if (entry.active) this.port.log(entry, 'info', 'restart', `Restarted (attempt ${attempt})`);
        else if (entry.problem) { this.port.log(entry, 'warn', 'restart', `Restart failed (attempt ${attempt}): ${entry.problem}`); this.scheduleRestart(entry); }
      })().catch((error: unknown) => console.warn(`[riffet] plugin ${id} automatic restart failed: ${describeError(error)}`));
    }, delay);
    state.timer.unref();
  }
}
