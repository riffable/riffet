/** The poll cadence of a session nobody has watched while idle for `DORMANT_AFTER_MS`: enough to notice a turn the CLI starts on its own. */
export const DORMANT_POLL_MS = 5_000;
const DORMANT_AFTER_MS = 30_000;

/** When a session last mattered to anybody, which decides whether its polls may slow down. */
export class DormancyClock {
  private watchedAt = Date.now();

  /** `active`: a client watches, or a turn, request or dialog is open. Dormant once neither has held for a while. */
  dormant(active: boolean, now = Date.now()): boolean {
    if (active) this.watchedAt = now;
    return !active && now - this.watchedAt >= DORMANT_AFTER_MS;
  }

  /** Counts the session as last watched at `at`. */
  watched(at: number): void { this.watchedAt = at; }
}
