import type { TailscaleCapability } from '@riffet/contracts';
import { runProcess } from './exec.js';

// What a capability report says of the machine around an Agent, not of the Agent itself.

/** `pause-after`, `refresh-client -A` and fair output scheduling arrived in tmux 3.2. */
export const TMUX_MIN_VERSION = '3.2';

/** True only for a version that parses and is older than the floor; `next-3.7` and `master` pass. */
export function tmuxTooOld(versionText: string): boolean {
  const match = /(\d+)\.(\d+)/.exec(versionText);
  if (!match) return false;
  const [floorMajor, floorMinor] = TMUX_MIN_VERSION.split('.').map(Number) as [number, number];
  const major = Number(match[1]), minor = Number(match[2]);
  return major < floorMajor || (major === floorMajor && minor < floorMinor);
}

/** Optional remote access; absence or a logged-out client is informational, never a doctor failure. */
export async function detectTailscale(cwd = process.cwd()): Promise<TailscaleCapability> {
  const probe = await runProcess('tailscale', ['version'], { cwd, timeoutMs: 3000, maxOutputBytes: 16 * 1024 });
  const present = probe.code !== null || probe.timedOut;
  if (!present) return { present: false, message: 'Tailscale was not found on PATH.' };
  const version = probe.code === 0 ? probe.stdout.split('\n').map(line => line.trim()).find(Boolean) : undefined;
  const address = await runProcess('tailscale', ['ip', '-4'], { cwd, timeoutMs: 3000, maxOutputBytes: 16 * 1024 });
  const ip = address.code === 0 ? address.stdout.split('\n').map(line => line.trim()).find(Boolean) : undefined;
  const loggedIn = address.code === 0 && Boolean(ip);
  return {
    present: true,
    ...(version ? { version } : {}),
    loggedIn,
    ...(ip ? { ip } : {}),
    message: loggedIn ? `Tailscale is connected${ip ? ` at ${ip}` : ''}.` : 'Tailscale is installed but this machine has no Tailscale IP; run `tailscale up`.',
  };
}
