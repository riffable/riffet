import type { PluginHost } from '@riffet/plugin-api';

// The devices adb sees, for the device choice of the tasks that install or read a device. Listing
// actions runs this each time, so the answer is kept for a few seconds and a missing or stuck adb is
// an empty list, never an error.

const CACHE_MS = 3000;
const SERIAL = /^[A-Za-z0-9._:-]{1,128}$/;

let cached: { at: number; value: Promise<string[]> } | undefined;

/** Serials of the devices that are ready (`device`), in adb's order. */
export function readyDevices(host: PluginHost): Promise<string[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = list(host).catch(() => []);
  cached = { at: Date.now(), value };
  return value;
}

async function list(host: PluginHost): Promise<string[]> {
  const adb = host.resolveCli('adb');
  if (!adb) return [];
  // The first call may start adb's server, which takes a second or two.
  const result = await host.runProcess(adb, ['devices'], { cwd: await host.stateDir(), timeoutMs: 4000, maxOutputBytes: 64 * 1024 });
  if (result.code !== 0) return [];
  return parseDevices(result.stdout);
}

export function parseDevices(output: string): string[] {
  const serials: string[] = [];
  for (const line of output.split(/\r?\n/).slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state === 'device' && SERIAL.test(serial)) serials.push(serial);
  }
  return serials;
}
