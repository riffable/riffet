import { requestResponse } from '@/lib/api';

/** The largest web entry the host will read. A bundled view is a few hundred kilobytes; this leaves room for a library. */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

const HEX = /^[0-9a-f]{64}$/;

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `sha256-<hex>` or `sha256-<base64>` as the hex digest it stands for; undefined for any other form. */
function expectedDigest(integrity: string): string | undefined {
  const match = /^sha256-(.+)$/.exec(integrity);
  if (!match) return undefined;
  const body = match[1]!;
  if (HEX.test(body.toLowerCase())) return body.toLowerCase();
  try {
    const bytes = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
    return bytes.length === 32 ? hexOf(bytes) : undefined;
  } catch { return undefined; }
}

/** Rejects unless `bytes` hash to `integrity`. A form the host does not know is a mismatch: an integrity it cannot check is not one it can pass. */
export async function verifyIntegrity(bytes: ArrayBuffer, integrity: string | undefined): Promise<void> {
  if (integrity === undefined) return;
  const expected = expectedDigest(integrity);
  const actual = hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  if (expected !== actual) throw new Error('The view\'s script does not match its recorded integrity');
}

const encoded = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * The web entry of a development or installed package, read through the files route with the user's
 * session (which the view never sees) and checked against its integrity when the server recorded one.
 */
export async function loadEntryCode({ pluginId, path, integrity, version }: { pluginId: string; path: string; integrity?: string | undefined; version?: string | undefined }, signal: AbortSignal): Promise<string> {
  // The address carries the entry's digest (or the package version), so a copy the browser or the service worker kept of an earlier version is never what answers.
  const key = integrity ?? version;
  const response = await requestResponse(`/api/integrations/${encodeURIComponent(pluginId)}/files/${encoded(path)}${key ? `?v=${encodeURIComponent(key)}` : ''}`, { signal });
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_ENTRY_BYTES) throw new Error('The view\'s script is too large');
  await verifyIntegrity(bytes, integrity);
  return new TextDecoder().decode(bytes);
}
