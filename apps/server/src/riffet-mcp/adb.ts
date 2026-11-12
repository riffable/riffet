import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DeviceAdbGrant, DeviceAdbStatus } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { isExecutableFile, pathEntries } from '../environment.js';

/**
 * The optional adb shortcut of docs/DEVICES.md §3: a phone that is also connected to this Mac over adb
 * can have the Riffet app granted `WRITE_SECURE_SETTINGS` and restricted settings. Only the fixed
 * commands below ever run, each as an argument list (no shell on this side), against a serial whose
 * `riffet-installation-id` file matches the calling device's installation.
 */

/** The only packages the grant may name: the Riffet app. Anything a caller sends is checked against this, never trusted. */
export const RIFFET_PACKAGES: ReadonlySet<string> = new Set(['io.github.riffable.android']);
const ADB_TIMEOUT_MS = 8_000;
const SERIAL = /^[A-Za-z0-9._:\-]{1,200}$/;

export interface AdbResult { ok: boolean; output: string; }
/** Runs one adb invocation; never rejects. */
export type AdbRunner = (adb: string, args: string[]) => Promise<AdbResult>;

const run: AdbRunner = (adb, args) => new Promise(resolve => {
  execFile(adb, args, { timeout: ADB_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    resolve({ ok: !error, output: `${stderr}\n${stdout}` });
  });
});

/** `adb` on the server's PATH, else where the SDK and Homebrew put it (a server started from the Mac app has the GUI's PATH). */
export function locateAdb(path = process.env.PATH ?? '', home = homedir()): string | undefined {
  const candidates = [...pathEntries(path).map(dir => join(dir, 'adb')), join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'), '/opt/homebrew/bin/adb', '/usr/local/bin/adb'];
  return candidates.find(isExecutableFile);
}

/** The line that says why: `pm` prints "Exception occurred while executing …" first and the `…Exception: …` reason after it. */
const reason = (output: string): string => {
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.find(line => /^[\w.$]*Exception: /.test(line)) ?? lines[0] ?? 'adb failed';
};
/** A failed `shell` command does not always fail adb itself (older adb exits 0), so its message counts too. */
const failed = (result: AdbResult): boolean => !result.ok || /\b(exception|error|unknown|not found|failed)\b/i.test(result.output);

export interface DeviceAdbOptions { runner?: AdbRunner; locate?: () => string | undefined; }

export class DeviceAdb {
  private readonly runner: AdbRunner;
  private readonly locate: () => string | undefined;

  constructor(options: DeviceAdbOptions = {}) {
    this.runner = options.runner ?? run;
    this.locate = options.locate ?? (() => locateAdb());
  }

  /** The adb entry that belongs to [installationId], if any. */
  private async find(installationId: string | undefined, packageName: string): Promise<{ state: DeviceAdbStatus['state']; serial?: string; adb?: string }> {
    const adb = this.locate();
    if (!adb) return { state: 'no-adb' };
    if (!installationId) return { state: 'absent', adb };
    const listed = await this.runner(adb, ['devices', '-l']);
    const entries = listed.output.split('\n').map(line => line.trim().split(/\s+/)).filter(([serial, state]) => serial && state && SERIAL.test(serial) && !serial.startsWith('*'));
    const ready = entries.filter(([, state]) => state === 'device');
    const marks = await Promise.all(ready.map(async ([serial]) => {
      const read = await this.runner(adb, ['-s', serial!, 'shell', 'cat', `/sdcard/Android/data/${packageName}/files/riffet-installation-id`]);
      return read.ok && read.output.trim() === installationId ? serial : undefined;
    }));
    const serial = marks.find(Boolean);
    if (serial) return { state: 'ready', serial, adb };
    return { state: entries.some(([, state]) => state === 'unauthorized') ? 'unauthorized' : 'absent', adb };
  }

  async status(installationId: string | undefined, packageName: string): Promise<DeviceAdbStatus> {
    return { state: (await this.find(installationId, packageName)).state };
  }

  async grant(installationId: string | undefined, packageName: string): Promise<DeviceAdbGrant> {
    const found = await this.find(installationId, packageName);
    if (found.state !== 'ready' || !found.serial || !found.adb) throw new AppError('ADB_UNAVAILABLE', `This phone is not reachable over adb (${found.state})`, 409);
    const { adb, serial } = found;
    const granted = await this.runner(adb, ['-s', serial, 'shell', 'pm', 'grant', packageName, 'android.permission.WRITE_SECURE_SETTINGS']);
    if (failed(granted)) throw new AppError('ADB_GRANT_FAILED', reason(granted.output), 409);
    const allowed = await this.runner(adb, ['-s', serial, 'shell', 'appops', 'set', packageName, 'ACCESS_RESTRICTED_SETTINGS', 'allow']);
    return { restrictedSettings: failed(allowed) ? 'unsupported' : 'allowed' };
  }
}
