const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MINUTES = { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080, mo: 43200 };

/** LiteLLM `budget_duration` strings: "30s", "30m", "30h", "30d", "1mo". Unknown forms yield undefined. */
export function budgetMinutes(duration) {
  const match = typeof duration === 'string' ? /^(\d+)(s|m|h|d|w|mo)$/.exec(duration.trim()) : null;
  if (!match) return undefined;
  const minutes = Math.round(Number(match[1]) * MINUTES[match[2]]);
  return Number.isSafeInteger(minutes) && minutes > 0 && minutes <= 2_147_483_647 ? minutes : undefined;
}

const num = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;

/**
 * Maps a `GET /key/info` body to the host's usage shape. The key's budget becomes one window; without a
 * positive `max_budget` there is nothing to measure against, so no window is reported (never 0%).
 */
export function usageFromKeyInfo(body, now = Date.now()) {
  const info = isRecord(body) && isRecord(body.info) ? body.info : undefined;
  if (!info) throw new Error('Unsupported LiteLLM key info');
  const result = { models: {}, fetchedAt: new Date(now).toISOString() };
  const spend = num(info.spend);
  const max = num(info.max_budget);
  if (spend === undefined || spend < 0 || max === undefined || max <= 0) return result;
  const window = { usedPercent: Math.min(100, Math.round((spend / max) * 100)) };
  const minutes = budgetMinutes(info.budget_duration);
  if (minutes !== undefined) window.windowMinutes = minutes;
  if (typeof info.budget_reset_at === 'string') {
    const reset = Date.parse(info.budget_reset_at);
    if (Number.isFinite(reset) && reset > now) window.resetsAt = new Date(reset).toISOString();
  }
  result.account = { windows: [window], ...(spend >= max ? { limitReached: true } : {}) };
  return result;
}
