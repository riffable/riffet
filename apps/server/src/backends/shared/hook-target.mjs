// Where a native CLI hook finds the workbench. Shared by the hook and status line collectors, and
// shipped next to them in `dist/`, so it imports nothing but Node built-ins.
//
// The server publishes one private descriptor file per state directory (`claude-hook.json`). A CLI
// that outlives a server restart reads it again on every hook, so the port is never cached.
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DESCRIPTOR_NAME = 'claude-hook.json';
/** The server refreshes `heartbeatAt` far more often than this; a file older than it is abandoned. */
export const DESCRIPTOR_MAX_AGE_MS = 30_000;
const MAX_DESCRIPTOR_BYTES = 4096;

/** Where a CLI launched before descriptors existed looks: it carries no state directory of its own. */
export function defaultDescriptorPath(env = process.env) {
  const stateDir = env.RIFFET_STATE_DIR?.trim() || join(homedir(), '.local/share/riffet');
  return join(stateDir, DESCRIPTOR_NAME);
}

/** A loopback http address without credentials, and a token to present to it. */
export function isHookTarget(url, token) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && !parsed.username && !parsed.password
      && typeof token === 'string' && token.length > 0;
  } catch { return false; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/**
 * Reads the descriptor. `absent` means no server ever published one here; `stale` means one exists
 * but cannot be trusted (owner dead, heartbeat expired, wrong owner or permissions, malformed), so the
 * caller fails open instead of sending a prompt anywhere.
 */
export function readHookDescriptor(path, now = Date.now()) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (stat.size > MAX_DESCRIPTOR_BYTES) return { state: 'stale' };
    // The token is a secret: only the user's own private file may vouch for an address.
    if (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) return { state: 'stale' };
    const data = JSON.parse(readFileSync(fd, 'utf8'));
    if (!isHookTarget(data.url, data.token) || !alive(data.pid)) return { state: 'stale' };
    if (!Number.isFinite(data.heartbeatAt) || Math.abs(now - data.heartbeatAt) > DESCRIPTOR_MAX_AGE_MS) return { state: 'stale' };
    return { state: 'live', url: data.url, token: data.token };
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'absent' : 'stale' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
