import type { PluginHost } from '@riffet/plugin-api';

// The devices adb sees: the device choice of the tasks that install or read a device, and the plugin page.
// Both run this often, so the answer is kept for a few seconds and a missing or stuck adb is an empty
// list, never an error.

const CACHE_MS = 3000;
const SERIAL = /^[A-Za-z0-9._:-]{1,128}$/;

/** A line of `adb devices`: `state` is adb's word (`device` when ready, `unauthorized`, `offline`, …). */
export interface AdbDevice { serial: string; state: string }

let cached: { at: number; value: Promise<AdbDevice[]> } | undefined;

/** Every device adb lists, in adb's order. */
export function listDevices(host: PluginHost): Promise<AdbDevice[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = list(host).catch(() => []);
  cached = { at: Date.now(), value };
  return value;
}

/** Serials of the devices that are ready (`device`), in adb's order. */
export async function readyDevices(host: PluginHost): Promise<string[]> {
  return (await listDevices(host)).filter(device => device.state === 'device').map(device => device.serial);
}

async function list(host: PluginHost): Promise<AdbDevice[]> {
  const adb = host.resolveCli('adb');
  if (!adb) return [];
  // The first call may start adb's server, which takes a second or two.
  const result = await host.runProcess(adb, ['devices'], { cwd: await host.stateDir(), timeoutMs: 4000, maxOutputBytes: 64 * 1024 });
  if (result.code !== 0) return [];
  return parseDevices(result.stdout);
}

export function parseDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of output.split(/\r?\n/).slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state && SERIAL.test(serial)) devices.push({ serial, state });
  }
  return devices;
}
