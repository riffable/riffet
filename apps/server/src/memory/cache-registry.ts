import type { ClientCacheSample } from '../../../../packages/contracts/src/index.js';

export type ServerCacheTrimReason = 'idle' | 'pressure';

export interface RegisteredServerCache {
  name: string;
  stats: () => Omit<ClientCacheSample, 'name'>;
  trim: (reason: ServerCacheTrimReason) => void;
}

export interface AutoTrimOptions {
  /** Returns true while clients, terminal sockets, in-flight requests or running turns are active. */
  isBusy: () => boolean;
  /** Idle period (ms) before triggering an `'idle'` trim once per idle spell. */
  idleMs: number;
  /**
   * Managed memory ceiling (`heapUsed + external`, bytes) above which `'pressure'` trim triggers
   * (0 disables managed-heap-triggered trim). Excludes clean file-backed SQLite mmap pages so
   * healthy active traffic does not thrash caches.
   */
  managedSoftLimitBytes?: number;
  /** Optional external OS memory pressure probe. */
  pressure?: () => 'normal' | 'warning' | 'critical';
  /** Poll interval (ms); defaults to 60s. */
  checkIntervalMs?: number;
  /** Cooldown (ms) between consecutive pressure trims; defaults to 60s. */
  pressureCooldownMs?: number;
  now?: () => number;
  managedBytes?: () => number;
}

/**
 * Server-side cache registry (docs/guide/performance.md §3.1): gives every long-lived server cache
 * a uniform observability entry in `/api/system/monitor` and a shared release hook on idle spells
 * or memory pressure.
 */
export class ServerCacheRegistry {
  private readonly entries = new Map<string, RegisteredServerCache>();
  private timer: ReturnType<typeof setInterval> | undefined;

  register(entry: RegisteredServerCache): () => void {
    this.entries.set(entry.name, entry);
    return () => {
      if (this.entries.get(entry.name) === entry) this.entries.delete(entry.name);
    };
  }

  report(): ClientCacheSample[] {
    const out: ClientCacheSample[] = [];
    for (const entry of this.entries.values()) {
      try { out.push({ name: entry.name, ...entry.stats() }); }
      catch { /* observability must never break monitoring */ }
    }
    return out;
  }

  trim(reason: ServerCacheTrimReason): void {
    for (const entry of this.entries.values()) {
      try { entry.trim(reason); }
      catch { /* one failing cache must not block trimming the rest */ }
    }
  }

  startAutoTrim(options: AutoTrimOptions): () => void {
    this.stop();
    const now = options.now ?? Date.now;
    const managedBytes = options.managedBytes ?? (() => {
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.external;
    });
    const softLimit = options.managedSoftLimitBytes ?? 0;
    const checkMs = Math.max(1_000, options.checkIntervalMs ?? 60_000);
    const cooldownMs = Math.max(1_000, options.pressureCooldownMs ?? 60_000);
    let lastActiveAt = now();
    let trimmedWhileIdle = false;
    let lastPressureTrimAt = 0;

    const tick = () => {
      const current = now();
      const busy = options.isBusy();
      if (busy) {
        lastActiveAt = current;
        trimmedWhileIdle = false;
      }
      const pressure = options.pressure?.() ?? 'normal';
      const overManaged = softLimit > 0 && managedBytes() > softLimit;
      if ((pressure !== 'normal' || overManaged) && current - lastPressureTrimAt >= cooldownMs) {
        lastPressureTrimAt = current;
        this.trim('pressure');
        return;
      }
      if (!busy && !trimmedWhileIdle && options.idleMs > 0 && current - lastActiveAt >= options.idleMs) {
        trimmedWhileIdle = true;
        this.trim('idle');
      }
    };

    this.timer = setInterval(tick, checkMs);
    this.timer.unref();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
}
