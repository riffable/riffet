/** The one-use payload printed by `riffet pair` and returned by `/api/pairing/code`. */
export interface PairingQr {
  origin: string;
  code: string;
}

const PAIRING_CODE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

/** Codes are typed or read aloud: whitespace and case do not matter, `I`, `L`, `O`, `U` never occur. */
export function normalizePairingCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

export function isPairingCode(raw: string): boolean {
  return PAIRING_CODE.test(normalizePairingCode(raw));
}

/**
 * What a person types for a server, as an origin: `host`, `host:port`, `http(s)://host:port/path`,
 * `[v6]:port`. Like the phone, a bare host means http on the `riffet` launcher's default port 4337; an `https://`
 * address without a port means a TLS front door on 443. A bare IPv6 literal is ambiguous and refused.
 */
export function parseServerAddress(input: string): string | undefined {
  const https = /^https:\/\//i.test(input.trim());
  const authority = input.trim().replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0]!.trim();
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!match) return undefined;
  const port = match[2] ? Number(match[2]) : https ? undefined : 4337;
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  try { return new URL(`${https ? 'https' : 'http'}://${match[1]!.toLowerCase()}${port === undefined ? '' : `:${port}`}/`).origin; }
  catch { return undefined; }
}

export function parsePairingQr(raw: string): PairingQr | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  if (payload.v !== 1 || typeof payload.host !== 'string' || typeof payload.port !== 'number'
    || !Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535
    || typeof payload.code !== 'string') return undefined;
  const host = payload.host;
  const scheme = payload.scheme === undefined ? 'http' : payload.scheme;
  const code = payload.code.trim().toUpperCase();
  if (!host || !/^[\w.:\-\[\]]+$/.test(host) || (scheme !== 'http' && scheme !== 'https')
    || !isPairingCode(code)) return undefined;
  try {
    const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const url = new URL(`${scheme}://${address}:${payload.port}/`);
    const port = url.port || (scheme === 'https' ? '443' : '80');
    if (url.username || url.password || url.pathname !== '/' || port !== String(payload.port)
      || url.hostname.replace(/^\[|\]$/g, '').toLowerCase() !== host.replace(/^\[|\]$/g, '').toLowerCase()) return undefined;
    return { origin: url.origin, code };
  } catch { return undefined; }
}

/** A fragment keeps the one-use code out of the destination server's URL and access logs. */
export function pairingHandoffUrl(pairing: PairingQr): string {
  const url = new URL('/', pairing.origin);
  url.hash = new URLSearchParams({ pair: pairing.code }).toString();
  return url.toString();
}

/** Leaves for the other server, whose web login redeems the code; the current one just reloads to do so. */
export function openPairing(pairing: PairingQr): void {
  const url = pairingHandoffUrl(pairing);
  if (pairing.origin === window.location.origin) {
    // A hash-only navigation does not remount App, whose startup consumes the one-use code.
    window.history.replaceState(window.history.state, '', url);
    window.location.reload();
  } else window.location.assign(url);
}
