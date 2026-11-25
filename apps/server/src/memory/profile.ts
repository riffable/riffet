import { totalmem } from 'node:os';
import { SERVER_PROFILE_AUTO_RAM_BYTES, SERVER_PROFILE_BUDGET } from '../../../../packages/contracts/src/budgets.js';

export type ServerProfile = 'full' | 'lite';
export type ServerProfileInput = ServerProfile | 'auto';
export type ServerProfileBudget = (typeof SERVER_PROFILE_BUDGET)[ServerProfile];

export function isServerProfileInput(value: string): value is ServerProfileInput {
  return value === 'full' || value === 'lite' || value === 'auto';
}

/** Resolves `full`, `lite`, or `auto` (picks `lite` on hosts with <= 4 GiB RAM). */
export function resolveServerProfile(input: ServerProfileInput | undefined, totalMemBytes = totalmem()): ServerProfile {
  if (input === 'lite') return 'lite';
  if (input === 'auto') return totalMemBytes <= SERVER_PROFILE_AUTO_RAM_BYTES ? 'lite' : 'full';
  return 'full';
}

export function serverProfileBudget(profile: ServerProfile): ServerProfileBudget {
  return SERVER_PROFILE_BUDGET[profile];
}

const DURATION_RE = /^(\d+)(ms|s|m|h|d)?$/i;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parses an idle-exit duration string (`30m`, `1h`, `1800s`, `0` or `off` to disable).
 * Bare positive integers are interpreted as minutes; `0` / `off` disables idle exit.
 * Throws on invalid syntax or sub-10s non-zero durations.
 */
export function parseIdleExitMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^(?:off|false|none)$/i.test(trimmed)) return 0;
  const match = DURATION_RE.exec(trimmed);
  if (!match) throw new Error(`--idle-exit must be a duration like 30m, 2h, 1800s, or 0, not ${raw}`);
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`--idle-exit is out of range: ${raw}`);
  if (amount === 0) return 0;
  const unit = (match[2] ?? 'm').toLowerCase();
  const ms = amount * UNIT_MS[unit]!;
  // Minimum 10s when enabled so an active handshake cannot race with immediate exit.
  if (ms < 10_000) throw new Error(`--idle-exit must be at least 10s (or 0 to disable), not ${raw}`);
  return ms;
}
