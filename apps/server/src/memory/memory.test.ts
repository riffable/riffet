import { describe, expect, it, vi } from 'vitest';
import { SERVER_PROFILE_AUTO_RAM_BYTES } from '../../../../packages/contracts/src/index.js';
import { ServerCacheRegistry } from './cache-registry.js';
import { isServerProfileInput, parseIdleExitMs, resolveServerProfile } from './profile.js';

describe('server memory profile and idle-exit parsing', () => {
  it('resolves explicit and auto profiles based on host RAM threshold', () => {
    expect(isServerProfileInput('full')).toBe(true);
    expect(isServerProfileInput('lite')).toBe(true);
    expect(isServerProfileInput('auto')).toBe(true);
    expect(isServerProfileInput('tiny')).toBe(false);

    expect(resolveServerProfile('full', 512 * 1024 * 1024)).toBe('full');
    expect(resolveServerProfile('lite', 64 * 1024 * 1024 * 1024)).toBe('lite');
    expect(resolveServerProfile('auto', SERVER_PROFILE_AUTO_RAM_BYTES)).toBe('lite');
    expect(resolveServerProfile('auto', SERVER_PROFILE_AUTO_RAM_BYTES + 1)).toBe('full');
  });

  it('parses human duration strings for --idle-exit and rejects invalid ones', () => {
    expect(parseIdleExitMs(undefined)).toBeUndefined();
    expect(parseIdleExitMs('')).toBeUndefined();
    expect(parseIdleExitMs('0')).toBe(0);
    expect(parseIdleExitMs('off')).toBe(0);
    expect(parseIdleExitMs('30s')).toBe(30_000);
    expect(parseIdleExitMs('15m')).toBe(900_000);
    expect(parseIdleExitMs('2h')).toBe(7_200_000);
    expect(parseIdleExitMs('1d')).toBe(86_400_000);
    expect(() => parseIdleExitMs('5s')).toThrow('--idle-exit');
    expect(() => parseIdleExitMs('-5m')).toThrow('--idle-exit');
    expect(() => parseIdleExitMs('abc')).toThrow('--idle-exit');
  });
});

describe('ServerCacheRegistry', () => {
  it('reports cache stats and auto-trims once per idle window or under pressure', () => {
    vi.useFakeTimers();
    try {
      const registry = new ServerCacheRegistry();
      let items = 10;
      const trim = vi.fn(() => { items = 0; });
      registry.register({ name: 'test-cache', stats: () => ({ count: items, maxEntries: 50 }), trim });

      expect(registry.report()).toEqual([{ name: 'test-cache', count: 10, maxEntries: 50 }]);

      let busy = true;
      let pressure: 'normal' | 'warning' | 'critical' = 'normal';
      let managed = 100 * 1024 * 1024;
      const stop = registry.startAutoTrim({
        isBusy: () => busy,
        idleMs: 10_000,
        checkIntervalMs: 5_000,
        pressureCooldownMs: 5_000,
        pressure: () => pressure,
        managedSoftLimitBytes: 256 * 1024 * 1024,
        managedBytes: () => managed,
      });

      // Busy & below managed limit -> never trims.
      vi.advanceTimersByTime(30_000);
      expect(trim).not.toHaveBeenCalled();

      // Idle for >= idleMs -> trims once, not repeatedly while staying idle.
      busy = false;
      vi.advanceTimersByTime(15_000);
      expect(trim).toHaveBeenCalledTimes(1);
      expect(trim).toHaveBeenLastCalledWith('idle');
      expect(registry.report()[0]?.count).toBe(0);

      vi.advanceTimersByTime(30_000);
      expect(trim).toHaveBeenCalledTimes(1);

      // Become busy then idle again -> trims again on next idle window.
      busy = true;
      items = 5;
      vi.advanceTimersByTime(5_000);
      busy = false;
      vi.advanceTimersByTime(15_000);
      expect(trim).toHaveBeenCalledTimes(2);

      // Under OS memory pressure -> trims even when busy.
      busy = true;
      items = 8;
      pressure = 'warning';
      vi.advanceTimersByTime(5_000);
      expect(trim).toHaveBeenCalledTimes(3);
      expect(trim).toHaveBeenLastCalledWith('pressure');

      // Managed heap + external exceeding soft limit -> trims even when OS pressure is normal.
      pressure = 'normal';
      managed = 300 * 1024 * 1024;
      vi.advanceTimersByTime(5_000);
      expect(trim).toHaveBeenCalledTimes(4);
      expect(trim).toHaveBeenLastCalledWith('pressure');

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
