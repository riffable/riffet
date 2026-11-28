import { createAbortError } from './types.js';

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface GateEntry {
  reached: boolean;
  released: boolean;
  failedError?: Error;
  reachedWaiters: Set<Waiter>;
  releaseWaiters: Set<Waiter>;
}

/**
 * Bidirectional synchronization barrier between the mock LLM stream and test harness.
 *
 * - Stream side calls `arrive(name, signal)` to signal it reached the checkpoint and wait for `release(name)`.
 * - Test side calls `waitUntilReached(name)` to block until the stream reaches that point, then calls `release(name)` or `fail(name, err)`.
 * - Calling `release(name)` before `arrive(name)` pre-releases the gate so `arrive` passes immediately.
 */
export class GateRegistry {
  private readonly gates = new Map<string, GateEntry>();

  private getOrCreate(name: string): GateEntry {
    let entry = this.gates.get(name);
    if (!entry) {
      entry = {
        reached: false,
        released: false,
        reachedWaiters: new Set(),
        releaseWaiters: new Set(),
      };
      this.gates.set(name, entry);
    }
    return entry;
  }

  /**
   * Called by the mock LLM stream when reaching a gate checkpoint.
   * Marks the gate as reached and blocks until released, failed, or aborted.
   */
  arrive(name: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError(`Gate "${name}" aborted before arrival`));
    }

    const entry = this.getOrCreate(name);
    entry.reached = true;

    for (const waiter of entry.reachedWaiters) {
      waiter.resolve();
    }
    entry.reachedWaiters.clear();

    if (entry.failedError) {
      return Promise.reject(entry.failedError);
    }
    if (entry.released) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (err: Error) => {
          cleanup();
          reject(err);
        },
      };

      const onAbort = () => {
        entry.releaseWaiters.delete(waiter);
        reject(createAbortError(`Gate "${name}" aborted while waiting for release`));
      };

      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };

      entry.releaseWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Called by the test harness to wait until the mock LLM reaches `name`.
   * Resolves immediately if already reached.
   */
  waitUntilReached(name: string, timeoutMs = 30_000): Promise<void> {
    const entry = this.getOrCreate(name);
    if (entry.reached) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };

      const timer = setTimeout(() => {
        entry.reachedWaiters.delete(waiter);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for gate "${name}" to be reached`));
      }, timeoutMs);
      timer.unref?.();

      entry.reachedWaiters.add(waiter);
    });
  }

  /**
   * Releases a gate. Safe to call before or after `arrive(name)`.
   */
  release(name: string): void {
    const entry = this.getOrCreate(name);
    entry.released = true;
    entry.failedError = undefined;
    for (const waiter of entry.releaseWaiters) {
      waiter.resolve();
    }
    entry.releaseWaiters.clear();
  }

  /**
   * Fails a gate so any stream currently waiting (or arriving next) throws `error`.
   */
  fail(name: string, error: Error | string): void {
    const err = error instanceof Error ? error : new Error(error);
    const entry = this.getOrCreate(name);
    entry.failedError = err;
    for (const waiter of entry.releaseWaiters) {
      waiter.reject(err);
    }
    entry.releaseWaiters.clear();
  }

  isReached(name: string): boolean {
    return this.gates.get(name)?.reached === true;
  }

  isReleased(name: string): boolean {
    return this.gates.get(name)?.released === true;
  }

  /**
   * Releases all currently pending gates so streams unwind cleanly before shutdown.
   */
  releaseAll(): void {
    for (const entry of this.gates.values()) {
      entry.released = true;
      for (const waiter of entry.releaseWaiters) {
        waiter.resolve();
      }
      entry.releaseWaiters.clear();
    }
  }

  /**
   * Clears one gate (if `name` provided) or all gates. Pending arrivals are released first so nothing hangs.
   */
  reset(name?: string): void {
    if (name !== undefined) {
      const entry = this.gates.get(name);
      if (entry) {
        for (const waiter of entry.releaseWaiters) {
          waiter.resolve();
        }
        entry.releaseWaiters.clear();
        const resetErr = new Error(`Gate "${name}" was reset`);
        for (const waiter of entry.reachedWaiters) {
          waiter.reject(resetErr);
        }
        entry.reachedWaiters.clear();
        this.gates.delete(name);
      }
      return;
    }

    this.releaseAll();
    const resetErr = new Error('GateRegistry was reset');
    for (const entry of this.gates.values()) {
      for (const waiter of entry.reachedWaiters) {
        waiter.reject(resetErr);
      }
      entry.reachedWaiters.clear();
    }
    this.gates.clear();
  }
}
