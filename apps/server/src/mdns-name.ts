import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { isIP } from 'node:net';

let cached: string[] | undefined;

/**
 * The name Bonjour actually answers for.
 *
 * On macOS `os.hostname()` is the DHCP/NetBIOS name, and macOS publishes the mDNS name under a
 * *different* one: `scutil --get LocalHostName`. The two disagree whenever they were set apart
 * (typically a serial-derived DHCP name versus the friendly Bonjour one), and only the latter
 * resolves on the network. Building a
 * `*.local` name out of `os.hostname()` therefore produces an address nothing can dial — which is
 * exactly how the pairing QR ended up pointing at a host no phone could reach.
 */
function localHostName(): string {
  if (process.platform === 'darwin') {
    try {
      const value = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (value) return value;
    } catch { /* No scutil, or it refused; the DHCP name is still worth a try. */ }
  }
  return hostname();
}

/** The `*.local` names a candidate host name implies, or `[]` when it cannot be published. */
export function mdnsNamesFrom(host: string): string[] {
  const base = host.trim().replace(/\.local\.?$/i, '').replace(/^\[|\]$/g, '');
  const valid = base && base.toLowerCase() !== 'localhost' && !isIP(base)
    && base.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
  return valid ? [`${base}.local`] : [];
}

/**
 * The `*.local` names this host answers to, most preferred first; `[]` when there are none.
 *
 * Memoized: `localHosts()` reads it on every pairing-code request, and the lookup spawns a process.
 */
export function mdnsNames(): string[] {
  if (cached === undefined) cached = mdnsNamesFrom(localHostName());
  return cached;
}
