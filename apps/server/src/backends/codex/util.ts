import { open, stat } from 'node:fs/promises';

export function requestIdString(id: unknown): string | undefined { return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined; }
export function toIso(ms: number | undefined): string | undefined { return ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined; }
export function titleCase(value: string): string { return value.replace(/[-_]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()); }
export function firstLine(value: string): string { return value.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? ''; }
export function str(value: unknown): string | undefined { return typeof value === 'string' && value.length ? value : undefined; }
export function finiteToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function asRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
export function asArray<T>(value: unknown): T[] { return Array.isArray(value) ? value as T[] : []; }
export function safeJson(value: string): unknown { try { return JSON.parse(value); } catch { return { value }; } }
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : item);
}

/** The last `bytes` of a file, decoded as UTF-8; the first line is usually a partial one. */
export async function readFileTail(path: string, bytes: number): Promise<string> {
  const info = await stat(path);
  const start = Math.max(0, info.size - bytes);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Number(info.size - start));
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}
