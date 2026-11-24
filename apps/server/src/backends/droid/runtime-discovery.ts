import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { ModelInfo, NativeSlashItem } from '../../../../../packages/contracts/src/index.js';
import { waitForExit } from '../shared/child-process.js';
import type { NativeBackendAvailability, NativeBackendProfileConfig } from '../types.js';
import { DroidRpcClient } from './rpc.js';
import {
  droidEnvironment, errorMessage, isMissingCliError, launchCommand, MODEL_CACHE_MS, record, spawnDroid, str,
} from './runtime-shared.js';

const MODEL_CACHE_LIMIT = 16;

class BoundedModelCache {
  private readonly entries = new Map<string, { at: number; models: Promise<ModelInfo[]> }>();

  get(key: string): Promise<ModelInfo[]> | undefined {
    const cached = this.entries.get(key);
    if (!cached) return undefined;
    if (Date.now() - cached.at >= MODEL_CACHE_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return cached.models;
  }

  set(key: string, models: Promise<ModelInfo[]>): void {
    const now = Date.now();
    for (const [entryKey, entry] of this.entries) {
      if (now - entry.at >= MODEL_CACHE_MS) this.entries.delete(entryKey);
    }
    while (this.entries.size >= MODEL_CACHE_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { at: now, models });
    models.catch(() => {
      if (this.entries.get(key)?.models === models) this.entries.delete(key);
    });
  }
}

const modelCache = new BoundedModelCache();

/** Probes the configured CLI without starting a session. */
export async function probeDroidCli(profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
  const launch = launchCommand(profile);
  const run = (args: string[]) => new Promise<string>((resolvePromise, reject) => {
    const child = spawn(launch.command, [...launch.args, ...args], { env: droidEnvironment(profile), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out')); }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => { if (output.length < 256 * 1024) output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (output.length < 256 * 1024) output += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); resolvePromise(output); });
  });
  try {
    const version = await run(['--version']);
    const help = await run(['exec', '--help']);
    if (!help.includes('stream-jsonrpc')) return { available: false, reason: `“${launch.configured}” does not support \`droid exec --input-format stream-jsonrpc\`; update Droid.`, version };
    return { available: true, version };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const cliMissing = isMissingCliError(error, launch.configured);
      return { available: false, ...(cliMissing ? { cliMissing: true } : {}), reason: `Cannot find “${launch.configured}”. Install Droid (https://factory.ai) or set this profile's executable to its absolute path.` };
    }
    return { available: false, reason: `Could not start Droid at “${launch.command}” (${errorMessage(error)}).` };
  }
}

/** Droid's model catalog. `droid.list_models` answers without a session, so a short-lived process serves it. */
export async function listDroidModels(profile: NativeBackendProfileConfig): Promise<ModelInfo[]> {
  const key = JSON.stringify([str(profile.config.executable) ?? 'droid', createHash('sha256').update(str(profile.config.apiKey) ?? '').digest('hex')]);
  const cached = modelCache.get(key);
  if (cached) return await cached;
  const models = fetchDroidModels(profile);
  modelCache.set(key, models);
  return await models;
}

async function fetchDroidModels(profile: NativeBackendProfileConfig): Promise<ModelInfo[]> {
  const child = spawnDroid(profile, homedir());
  const rpc = new DroidRpcClient(child.stdin!, child.stdout!, { onNotification: () => undefined, onRequest: async () => ({}) });
  child.once('error', error => rpc.close(error));
  child.once('exit', () => rpc.close());
  try {
    const result = await rpc.request<{ models?: unknown[] }>('droid.list_models', {}, { timeoutMs: 30_000 });
    return droidModelInfos(result.models ?? []);
  } finally {
    rpc.close();
    child.stdin?.end();
    if (!await waitForExit(child, 2_000)) child.kill('SIGKILL');
  }
}

/**
 * Droid's `/` catalog for `cwd`: user-invocable skills and custom commands. Both RPCs answer without
 * a session, so a short-lived process serves them. Droid invokes a skill wherever `/name` sits in
 * the message, so every skill is offered mid-message too.
 */
export async function listDroidSlashItems(profile: NativeBackendProfileConfig, cwd: string): Promise<NativeSlashItem[]> {
  const child = spawnDroid(profile, cwd);
  const rpc = new DroidRpcClient(child.stdin!, child.stdout!, { onNotification: () => undefined, onRequest: async () => ({}) });
  child.once('error', error => rpc.close(error));
  child.once('exit', () => rpc.close());
  try {
    const [skills, commands] = await Promise.all([
      rpc.request<{ skills?: unknown[] }>('droid.list_skills', {}, { timeoutMs: 30_000 }),
      rpc.request<{ commands?: unknown[] }>('droid.list_commands', {}, { timeoutMs: 30_000 }).catch(() => ({ commands: [] as unknown[] })),
    ]);
    return droidSlashItems(skills.skills ?? [], commands.commands ?? []);
  } finally {
    rpc.close();
    child.stdin?.end();
    if (!await waitForExit(child, 2_000)) child.kill('SIGKILL');
  }
}

export function droidSlashItems(skills: unknown[], commands: unknown[]): NativeSlashItem[] {
  const items: NativeSlashItem[] = [];
  for (const value of commands) {
    const command = record(value);
    const name = str(command?.name)?.replace(/^\//, '');
    if (!command || !name) continue;
    const description = str(command.description);
    const hint = str(command.argumentHint) ?? str(command.argumentsHint);
    items.push({ name, kind: 'command', ...(description ? { description } : {}), ...(hint ? { hint } : {}) });
  }
  for (const value of skills) {
    const skill = record(value);
    const name = str(skill?.name);
    if (!skill || !name || skill.enabled === false || skill.userInvocable === false) continue;
    const description = str(skill.description);
    const path = str(skill.filePath);
    items.push({ name, kind: 'skill', ...(description ? { description } : {}), ...(path ? { path } : {}) });
  }
  return items;
}

export function droidModelInfos(models: unknown[]): ModelInfo[] {
  return models.flatMap(value => {
    const model = record(value);
    const id = str(model?.id) ?? str(model?.modelId);
    if (!model || !id || model.deprecated === true || model.disabled === true) return [];
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap(item => str(item) ?? []).filter(effort => effort !== 'none')
      : [];
    const defaultEffort = str(model.defaultReasoningEffort);
    return [{
      value: id,
      name: str(model.displayName) ?? id,
      configOptions: [...(efforts.length ? [{
        id: 'effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select' as const,
        currentValue: defaultEffort && efforts.includes(defaultEffort) ? defaultEffort : efforts[0]!,
        options: efforts.map(effort => ({ value: effort, name: effort === 'xhigh' ? 'Extra high' : effort[0]!.toUpperCase() + effort.slice(1) })),
      }] : []), ...(model.isCustom === false && model.kind !== 'router' ? [{
        id: 'context',
        name: 'Context budget',
        category: 'model_config',
        description: 'Default follows Droid\'s compaction setting. Long context requests a compaction threshold of up to 1M; the actual threshold is bounded by the model\'s input window and organization policy. A change applies from the next turn.',
        type: 'select' as const,
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'long', name: 'Long · ≤1M', description: 'An upper bound; the budget in force is what Droid reports.' },
        ],
      }] : [])],
    }];
  });
}
