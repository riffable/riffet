/** Readers for untrusted payload values; the same rules as the web's `lib/utils`. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** A CLI hand-back receipt points to a report elsewhere; it is not the report's body. */
export function taskReportDetail(value: unknown, taskId: string | undefined): string | undefined {
  const detail = str(value);
  if (!detail || !taskId) return detail;
  const receipt = /^This agent's report was delivered to you as a message from "([^"]+)" \(its SubagentHandback call\)\. Read it there; it is not repeated here\.$/.exec(detail.replace(/\s+/g, ' ').trim());
  return receipt?.[1] === taskId ? undefined : detail;
}

/** Positive integer pixel edge from an untrusted payload; anything else is unknown. */
export function pixelEdge(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
