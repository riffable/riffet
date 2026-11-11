import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshRpcPeer } from './rpc.js';
import type { DshProfileRuntime } from './runtime.js';
import type { DshRuntimeSettings } from './settings.js';
import { BRIDGE_PACKAGE_NAME, dshProfilePatch } from './profile-patch.js';

export { dshProfilePatch } from './profile-patch.js';

export const BRIDGE_PROTOCOL = 1;
const PROFILE_MANIFEST_NAME = 'riffet-dsh-profile';
export const peerHandlers = new WeakMap<DshRpcPeer, DshProfileRuntime>();

export function listenForBridge(): Promise<{ server: net.Server; endpoint: string; token: string }> {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Could not bind a local DeepSeek Harness bridge')); return; }
      resolvePromise({ server, endpoint: `tcp://127.0.0.1:${address.port}`, token: randomUUID() });
    });
  });
}

export function waitForBridge(server: net.Server, token: string, profileName: string): Promise<DshRpcPeer> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    server.on('connection', (socket) => {
      if (settled) { socket.destroy(); return; }
      const peer = new DshRpcPeer(socket, {
        onNotification(method, params) {
          if (method === 'bridge/connected') return;
          const runtime = peerHandlers.get(peer);
          runtime?.handleNotification(method, params);
        },
        async onRequest(method, params) {
          if (!settled) {
            if (method !== 'bridge/ready' || params.token !== token || params.protocolVersion !== BRIDGE_PROTOCOL || params.profileName !== profileName) {
              throw new Error('DeepSeek Harness bridge authentication or protocol version failed');
            }
            settled = true;
            resolvePromise(peer);
            return { protocolVersion: BRIDGE_PROTOCOL };
          }
          const runtime = peerHandlers.get(peer);
          if (!runtime) throw new Error('DeepSeek Harness runtime is not ready');
          return await runtime.handleRequest(method, params);
        },
        onClose(error) {
          const runtime = peerHandlers.get(peer);
          if (runtime) runtime.handleClose(error);
          if (!settled) reject(error);
        },
      });
      void peer;
    });
  });
}

export async function provisionBridgeProfile(settings: DshRuntimeSettings): Promise<void> {
  await mkdir(settings.bridgePackageDir, { recursive: true, mode: 0o700 });
  const runtimeAsset = fileURLToPath(new URL('./bridge-runtime/index.mjs', import.meta.url));
  let bridgeSource: string;
  try { bridgeSource = await readFile(runtimeAsset, 'utf8'); } catch {
    throw new Error(`Missing DSH bridge runtime asset at ${runtimeAsset}; include apps/server/src/backends/dsh/bridge-runtime in the Riffet build.`);
  }
  const bridgePackage = {
    name: BRIDGE_PACKAGE_NAME,
    version: '0.2.0',
    private: true,
    type: 'module',
    exports: './index.mjs',
  };
  const profileManifest = {
    name: PROFILE_MANIFEST_NAME,
    private: true,
    dependencies: { [BRIDGE_PACKAGE_NAME]: '0.2.0' },
    // Auto review is a bundle the DSH installation ships switched off; it adds the `auto` preset. It
    // stays in the profile for good: a session persisted under `auto` cannot be resumed without it.
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-auto-review'] } },
  };
  const patch = dshProfilePatch(settings);
  const profileFile = join(settings.profileDir, 'package.json');
  let existingManifest = false;
  if (existsSync(profileFile)) {
    if ((await lstat(profileFile)).isSymbolicLink()) throw new Error('Refusing to rewrite a symlinked DSH profile manifest');
    let current: { name?: unknown; dependencies?: Record<string, unknown> };
    try {
      current = JSON.parse(await readFile(profileFile, 'utf8')) as { name?: unknown };
    } catch (error) {
      throw new Error(`Refusing to replace unreadable DSH profile ${settings.profileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (current.name !== PROFILE_MANIFEST_NAME) {
      throw new Error(`Refusing to replace existing DSH profile ${settings.profileName}`);
    }
    existingManifest = true;
    // Preserve bundles, dependencies and all settings maintained by DSH's own manager.
    if (current.dependencies?.[BRIDGE_PACKAGE_NAME] !== bridgePackage.version) {
      current.dependencies = { ...current.dependencies, [BRIDGE_PACKAGE_NAME]: bridgePackage.version };
      await atomicWrite(profileFile, JSON.stringify(current, undefined, 2) + '\n');
    }
  }
  await mkdir(settings.profileDir, { recursive: true, mode: 0o700 });
  if (!existingManifest) await writeFile(profileFile, JSON.stringify(profileManifest, undefined, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await atomicWrite(settings.bridgePatchPath, patch);
  await atomicWrite(join(settings.bridgePackageDir, 'package.json'), JSON.stringify(bridgePackage, undefined, 2) + '\n');
  await atomicWrite(join(settings.bridgePackageDir, 'index.mjs'), bridgeSource);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>(resolvePromise => {
    if (!server.listening) { resolvePromise(); return; }
    server.close(() => resolvePromise());
  });
}
