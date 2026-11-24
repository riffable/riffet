import type { ActivationScope, Contributions, PluginHost, PluginManifest } from '@riffet/plugin-api';
import type { PluginEnablement } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { checkedContributions } from './descriptors.js';
import {
  bounded, describeError, DISPOSE_TIMEOUT_MS, Superseded,
  type Activation, type Entry, type RegistryContext,
} from './entry.js';

export function serial<T>(entry: Entry, change: () => Promise<T>): Promise<T> {
  const done = entry.tail.then(change);
  entry.tail = done.then(() => undefined, () => undefined);
  return done;
}

/** A cycle has no activation order: every plugin on one is rejected, naming the path. */
export function rejectCycles(ctx: RegistryContext): void {
  const cycleFrom = (start: string): string[] | undefined => {
    const walk = (id: string, path: string[]): string[] | undefined => {
      for (const dependency of ctx.entries.get(id)?.plugin.manifest.requires ?? []) {
        if (dependency.id === start) return [...path, start];
        if (!ctx.entries.has(dependency.id) || path.includes(dependency.id)) continue;
        const found = walk(dependency.id, [...path, dependency.id]);
        if (found) return found;
      }
      return undefined;
    };
    return walk(start, [start]);
  };
  const cyclic = [...ctx.entries.keys()].flatMap(id => { const path = cycleFrom(id); return path ? [{ id, path }] : []; });
  for (const { id, path } of cyclic) {
    const { plugin: { manifest }, source } = ctx.entries.get(id)!;
    ctx.entries.delete(id);
    for (const [declared, owner] of ctx.declared) if (owner === id) ctx.declared.delete(declared);
    ctx.reject({ id, vendor: String(manifest.vendor), name: String(manifest.name), reason: `dependency cycle: ${path.join(' -> ')}`, source });
  }
}

/** Whether `id` requiring `requires` would close a cycle through the plugins that are loaded. */
export function wouldCycle(ctx: RegistryContext, id: string, requires: PluginManifest['requires']): boolean {
  const seen = new Set<string>();
  const reaches = (from: string): boolean => {
    if (from === id) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (ctx.entries.get(from)?.plugin.manifest.requires ?? []).some(item => reaches(item.id));
  };
  return (requires ?? []).some(item => reaches(item.id));
}

/** The plugins that name `id` among their requirements, directly or through others. */
export function dependents(ctx: RegistryContext, id: string): string[] {
  const found = new Set<string>();
  const visit = (target: string) => {
    for (const [other, entry] of ctx.entries) {
      if (found.has(other) || !entry.plugin.manifest.requires?.some(item => item.id === target)) continue;
      found.add(other);
      visit(other);
    }
  };
  visit(id);
  return [...found];
}

export async function ensureEntry(ctx: RegistryContext, entry: Entry, trigger: string): Promise<void> {
  if (!ctx.permitted(entry)) throw new AppError('INTEGRATION_DISABLED', 'This plugin is off or paused', 409);
  if (entry.active) return;
  if (entry.demanding) return entry.demanding;
  const pending = demandEntry(ctx, entry, trigger);
  entry.demanding = pending;
  try { await pending; } finally { if (entry.demanding === pending) entry.demanding = undefined; }
}

async function demandEntry(ctx: RegistryContext, entry: Entry, trigger: string): Promise<void> {
  for (const requirement of entry.plugin.manifest.requires ?? []) {
    const dependency = ctx.entries.get(requirement.id);
    if (dependency && (!requirement.optional || ctx.permitted(dependency))) await ensureEntry(ctx, dependency, `dependency:${entry.plugin.manifest.id}`);
  }
  const previous = entry.source === 'installed' ? ctx.packages.record(entry.plugin.manifest.id)?.lastActivated : undefined;
  const previousData = previous && previous !== entry.version ? await ctx.packages.dataVersion(entry.plugin.manifest.id) : undefined;
  await serial(entry, async () => {
    if (!ctx.permitted(entry)) throw new AppError('INTEGRATION_DISABLED', 'This plugin is off or paused', 409);
    if (!entry.active) { entry.demand = trigger; await evaluate(ctx, entry); }
  });
  if (!entry.active && previous && previous !== entry.version && ctx.permitted(entry)) {
    const failedVersion = entry.version;
    const failure = entry.problem ?? 'Activation did not complete';
    await ctx.exclusive(async () => {
      // A concurrent activation may already have recovered the same plugin.
      if (entry.active) return;
      await ctx.packages.rollbackData(entry.plugin.manifest.id, previousData);
      const error = await ctx.switchVersion(entry, previous, true);
      if (!error && entry.active) {
        entry.note = `version ${failedVersion} could not start (${failure}); still using ${previous}`;
        ctx.log(entry, 'warn', 'rollback', entry.note);
        ctx.changed();
      }
    });
  }
  if (!entry.active) throw new AppError('PLUGIN_ACTIVATION_FAILED', entry.problem ?? 'This plugin is unavailable', 409);
}

/** Evaluates `ids`, each after the plugins it requires that are part of the same pass. */
export function evaluateAll(ctx: RegistryContext, ids: readonly string[]): Promise<unknown> {
  const wanted = new Set(ids.filter(id => ctx.entries.has(id)));
  const started = new Map<string, Promise<void>>();
  const run = (id: string): Promise<void> => {
    let promise = started.get(id);
    if (!promise) {
      const entry = ctx.entries.get(id)!;
      started.set(id, promise = (async () => {
        await Promise.all((entry.plugin.manifest.requires ?? []).filter(item => wanted.has(item.id)).map(item => run(item.id)));
        await serial(entry, () => evaluate(ctx, entry));
      })());
    }
    return promise;
  };
  return Promise.all([...wanted].map(run));
}

/** Returns why activation failed, when it was tried and did not succeed. */
export async function evaluate(ctx: RegistryContext, entry: Entry): Promise<string | undefined> {
  try { return await decide(ctx, entry); }
  finally { entry.evaluated = true; }
}

async function decide(ctx: RegistryContext, entry: Entry): Promise<string | undefined> {
  if (ctx.closed) return undefined;
  const { manifest } = entry.plugin;
  let enablement: PluginEnablement;
  try { enablement = ctx.store.enablement(manifest.id); ctx.storeProblem = undefined; }
  catch (error) {
    // Nothing runs on a guess: an `off` the file can no longer say must not become an `auto` that detects on.
    ctx.storeProblem = describeError(error);
    return settle(ctx, entry, false);
  }
  entry.problem = undefined;
  // This host can never run the entry: the declarations stay, the code does not start.
  if (entry.blocked) { entry.problem = entry.blocked; return settle(ctx, entry, false); }
  if (ctx.isLazy(entry) && !entry.demand && !entry.active) {
    entry.allowed = ctx.permitted(entry);
    return undefined;
  }
  let enabled: boolean;
  if (entry.source !== 'builtin' && ctx.store.recovery()) { entry.problem = 'External plugins are paused by recovery mode'; enabled = false; }
  else if (enablement !== 'auto') enabled = enablement === 'on';
  else if (manifest.defaultEnabled !== 'auto') enabled = manifest.defaultEnabled;
  else {
    const started = Date.now();
    try {
      let detected = false;
      await bounded(async () => { detected = await entry.plugin.detect?.(entry.host) ?? false; }, ctx.activationTimeoutMs);
      enabled = detected;
      ctx.log(entry, 'debug', 'detect', `Detection ${enabled ? 'matched' : 'did not match'} in ${Date.now() - started} ms`);
    }
    catch (error) {
      enabled = false; entry.problem = `detection failed: ${ctx.journal.redact(manifest.id, describeError(error))}`;
      entry.runtime = { trigger: entry.demand ?? 'startup', failedPhase: 'detect', durationMs: Date.now() - started };
      ctx.log(entry, 'error', 'detect', error instanceof Error ? error.stack ?? error.message : String(error));
    }
  }
  if (enabled) {
    for (const required of manifest.requires ?? []) {
      const dependency = ctx.entries.get(required.id);
      if (!required.optional && dependency && !dependency.active && ctx.permitted(dependency)) {
        dependency.demand = `dependency:${manifest.id}`;
        await serial(dependency, () => evaluate(ctx, dependency));
      }
    }
  }
  entry.allowed = enabled;
  if (!enabled) entry.demand = undefined;
  const missing = enabled ? manifest.requires?.find(item => !item.optional && !ctx.entries.get(item.id)?.active) : undefined;
  if (missing) { entry.problem = `requires ${missing.id}`; enabled = false; }
  // Turned off by choice while it has running tasks: it stays up for them, refusing new ones, until they end (design §8).
  if (!enabled && !missing && entry.active && !entry.force && !ctx.closed && ctx.runningTasks(manifest.id) > 0) {
    if (entry.waiting?.kind !== 'switch') entry.waiting = { kind: 'off' };
    return undefined;
  }
  if (entry.waiting?.kind === 'off') entry.waiting = undefined;
  return settle(ctx, entry, enabled);
}

async function settle(ctx: RegistryContext, entry: Entry, enabled: boolean): Promise<string | undefined> {
  if (enabled && !entry.active) return activate(ctx, entry);
  if (!enabled) ctx.restarts.clearRestarts(entry);
  if (!enabled && entry.active) {
    await deactivateDependents(ctx, entry, true, true);
    await deactivate(ctx, entry);
  }
  return undefined;
}

/**
 * Turns off what is on and needs `entry` (`requiredOnly`), or everything that names it (a shutdown), the
 * ones furthest from it first, so nothing runs without what it depends on.
 */
export async function deactivateDependents(ctx: RegistryContext, entry: Entry, notify: boolean, requiredOnly: boolean): Promise<void> {
  const id = entry.plugin.manifest.id;
  const direct = [...ctx.entries.values()].filter(other => other !== entry && other.plugin.manifest.requires?.some(item => item.id === id && (!requiredOnly || !item.optional)));
  await Promise.all(direct.map(other => serial(other, async () => {
    await deactivateDependents(ctx, other, notify, requiredOnly);
    if (!other.active) return;
    if (requiredOnly) other.problem = `requires ${id}`;
    await deactivate(ctx, other, notify);
  })));
}

async function activate(ctx: RegistryContext, entry: Entry): Promise<string | undefined> {
  const started = Date.now();
  entry.runtime = { trigger: entry.demand ?? 'startup' };
  const activation: Activation = { generation: ++entry.generation, controller: new AbortController(), disposers: [], ended: false, timeouts: 0, openUntil: 0 };
  const { signal } = activation.controller;
  const id = entry.plugin.manifest.id;
  const version = entry.plugin.manifest.version;
  const host: PluginHost = { ...entry.host, logger: Object.fromEntries((['debug', 'info', 'warn', 'error'] as const).map(level => [level, (message: string) => {
    ctx.journal.append({ pluginId: id, ...(version ? { version } : {}), generation: activation.generation, level, phase: 'runtime', message: String(message) });
  }])) as NonNullable<PluginHost['logger']> };
  const scope: ActivationScope = {
    generation: activation.generation, signal,
    onDispose: fn => {
      if (!activation.ended) activation.disposers.push(fn);
      else void bounded(fn, DISPOSE_TIMEOUT_MS).catch((error: unknown) => console.warn(`[riffet] plugin ${id} late disposer failed: ${describeError(error)}`));
    },
  };
  entry.starting = activation;
  ctx.log(entry, 'info', 'activate', `Activation started (${entry.runtime.trigger})`);
  const { dataVersion } = entry.plugin.manifest;
  // Data is made ready for this version first; an older version than the data refuses to start.
  const result = Promise.resolve().then(async () => {
    if (dataVersion !== undefined) await ctx.packages.prepareData(id, dataVersion);
    return entry.plugin.activate(host, scope);
  });
  let staged: Contributions | undefined;
  let timer: NodeJS.Timeout | undefined;
  let problem: string | undefined;
  try {
    // The wait ends when the activation is superseded or takes too long; whatever the code returns later is released.
    if (signal.aborted) throw new Superseded();
    staged = await Promise.race([
      result,
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Superseded()), { once: true })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`did not finish within ${ctx.activationTimeoutMs / 1000}s`)), ctx.activationTimeoutMs); timer.unref(); }),
    ]);
    if (signal.aborted) throw new Superseded();
    if (activation.failed) throw new Error(activation.failed);
    checkedContributions(ctx, staged, entry.plugin.manifest, entry.skipped?.ids ?? []);
    if (entry.source === 'installed' && entry.version) ctx.packages.markActivated(id, entry.version);
    activation.contributions = ctx.guard.guardContributions(entry, activation, staged);
    entry.active = activation;
    entry.cleanup = undefined;
    entry.runtime = { ...entry.runtime, activatedAt: new Date().toISOString(), durationMs: Date.now() - started };
    ctx.log(entry, 'info', 'activate', `Activation completed in ${Date.now() - started} ms`);
    ctx.restarts.armStable(entry);
  } catch (error) {
    if (!(error instanceof Superseded)) {
      entry.problem = problem = `activation failed: ${ctx.journal.redact(id, describeError(error))}`;
      entry.runtime = { ...entry.runtime, failedPhase: 'activate', durationMs: Date.now() - started };
      ctx.log(entry, 'error', 'activate', error instanceof Error ? error.stack ?? error.message : String(error));
    }
    const failures = await endActivation(activation, staged);
    if (failures.length) entry.cleanup = `a failed activation left something behind: ${failures.join('; ')}`;
    // A result that arrives after the wait ended is released the same way.
    if (!staged) void result.then(late => endActivation(activation, late), () => [] as string[]).then(late => { if (late.length) entry.cleanup = `a late activation left something behind: ${late.join('; ')}`; });
  } finally { clearTimeout(timer); if (entry.starting === activation) entry.starting = undefined; }
  // Outside the try: a failing host callback must not dispose contributions that stay committed.
  if (entry.active === activation) { ctx.invalidate(); ctx.changed(); await refreshOptionalDependents(ctx, entry); }
  return problem;
}

/** Lookups stop first, then flows are dropped and the scope ends. */
export async function deactivate(ctx: RegistryContext, entry: Entry, notify = true): Promise<void> {
  const started = Date.now();
  const activation = entry.active!;
  entry.active = undefined;
  entry.waiting = undefined;
  ctx.restarts.clearRestarts(entry, false);
  if (activation.notice && entry.note === activation.notice) entry.note = undefined;
  const id = entry.plugin.manifest.id;
  ctx.flows.forget(id);
  if (notify) { ctx.invalidate(); ctx.changed(); }
  const failures = await endActivation(activation, activation.contributions);
  ctx.log(entry, failures.length ? 'warn' : 'info', 'dispose', `Deactivation completed in ${Date.now() - started} ms${failures.length ? `: ${failures.join('; ')}` : ''}`);
  entry.cleanup = failures.length ? `turning off left something behind: ${failures.join('; ')}` : undefined;
  for (const listener of ctx.endListeners) {
    try { listener(activation.contributions); } catch (error) { console.warn('[riffet] plugin end listener failed:', describeError(error)); }
  }
  if (notify) await refreshOptionalDependents(ctx, entry);
}

/**
 * A plugin came on or went off: the ones that are on and name it as an optional dependency are turned off and on again,
 * so what they built from it is revoked or built anew. (A required dependency that goes off takes its dependents with it.) A
 * dependent first turned on after it, or evaluated in the same pass, is not on yet and needs nothing.
 */
async function refreshOptionalDependents(ctx: RegistryContext, entry: Entry): Promise<void> {
  if (ctx.closed) return;
  const id = entry.plugin.manifest.id;
  const users = [...ctx.entries.values()].filter(other => other !== entry && other.active && !other.waiting && other.plugin.manifest.requires?.some(item => item.id === id && item.optional));
  await Promise.all(users.map(other => serial(other, async () => {
    if (!other.active || ctx.closed) return;
    const otherId = other.plugin.manifest.id;
    await deactivateDependents(ctx, other, true, true);
    await deactivate(ctx, other);
    await evaluate(ctx, other);
    await evaluateAll(ctx, dependents(ctx, otherId));
  })));
}

/** Aborts the signal, then runs `contributions.dispose` and the scope's disposers, last registered first. Returns what failed. */
async function endActivation(activation: Activation, contributions?: Contributions): Promise<string[]> {
  const disposers = [...activation.disposers].reverse();
  activation.disposers.length = 0;
  if (!activation.ended) { activation.ended = true; activation.controller.abort(); }
  const failures: string[] = [];
  for (const dispose of [...(contributions?.dispose ? [() => contributions.dispose!()] : []), ...disposers]) {
    try { await bounded(dispose, DISPOSE_TIMEOUT_MS); }
    catch (error) { failures.push(describeError(error)); }
  }
  return failures;
}
