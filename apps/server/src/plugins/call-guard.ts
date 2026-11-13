import type { Contributions } from '@riffet/plugin-api';
import type { PluginLogEntry } from '../../../../packages/contracts/src/plugin-management.js';
import { AppError } from '../errors.js';
import { TIMEOUTS } from '../plugins-host/remote.js';
import type { Activation, Entry } from './entry.js';

/** What one call into in-process plugin code may take before its caller stops waiting; an isolated package's proxy has its own limits (`TIMEOUTS`). */
const CALL_LIMITS_MS = {
  'modelSource.prepare': TIMEOUTS.prepare, 'modelSource.catalog': TIMEOUTS.catalog, 'modelSource.usage': 30_000,
  'runtimeHook.prepare': 30_000, 'runtimeHook.recover': 30_000, 'runtimeAttachment.bindNative': 10_000, 'runtimeAttachment.stop': 10_000, 'runtimeAttachment.act': 30_000,
  'sharePublisher.capability': 30_000, 'sharePublisher.deploy': 600_000, 'sharePublisher.find': 60_000, 'sharePublisher.remove': 60_000, 'sharePublisher.verify': 60_000,
} as const;
/** Consecutive timeouts of one activation after which its calls are refused for `FAIL_FAST_MS`. */
const FAIL_FAST_AFTER = 3;
export const FAIL_FAST_MS = 60_000;

/** Errors already written to a plugin's journal, so one that passes through two guards is written once. */
const attributed = new WeakSet<object>();
type Method = (...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

/** `target` with some methods replaced: other members, `this` and optional-ness are the target's own. A method that cannot be replaced (frozen) stays as it is. */
function intercepting<T extends object>(target: T, wrap: Record<string, (original: Method) => Method>): T {
  return new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);
      if (descriptor && !descriptor.configurable && !descriptor.writable && 'value' in descriptor) return value;
      // A method that is not replaced still runs on the target: a class with private fields would throw on the proxy.
      if (typeof prop !== 'string' || !Object.hasOwn(wrap, prop)) return (value as Method).bind(t);
      return wrap[prop]!((value as Method).bind(t));
    },
  });
}

/** What the call guard needs of the registry: the journal, the change signal, and the two timing options. */
export interface CallGuardPort {
  log(entry: Entry, level: PluginLogEntry['level'], phase: string, message: string): void;
  changed(): void;
  /** Replaces every limit in `CALL_LIMITS_MS`. */
  callTimeoutMs?: number;
  failFastMs: number;
}

export class CallGuard {
  constructor(private readonly port: CallGuardPort) {}

  /** Writes a failure of a call into the plugin's journal, once per error. An answer below 500 is the plugin's domain talking, not a failure. */
  private attribute(entry: Entry, operation: string, error: unknown): void {
    if (typeof error === 'object' && error) { if (attributed.has(error)) return; attributed.add(error); }
    const domain = error instanceof AppError && error.statusCode < 500;
    this.port.log(entry, domain ? 'debug' : 'error', 'runtime', `${operation} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }

  /**
   * One call into a contribution. With `ms` (in-process code) the wait ends then, and an activation whose calls time out
   * three times in a row is refused for a while instead of making every caller wait again. Without it (an isolated package,
   * whose proxy has its own limits, or a call that waits for people) the call is only attributed. The error a call throws is rethrown as it is.
   */
  private async through<T>(entry: Entry, activation: Activation, operation: string, ms: number | undefined, run: () => Promise<T>): Promise<T> {
    const id = entry.plugin.manifest.id;
    if (ms !== undefined && activation.timeouts >= FAIL_FAST_AFTER && Date.now() < activation.openUntil) {
      throw new AppError('PLUGIN_NOT_RESPONDING', `${id} is not responding; ${operation} is refused, it will be tried again in ${Math.ceil((activation.openUntil - Date.now()) / 1000)} s`, 503);
    }
    let timer: NodeJS.Timeout | undefined;
    let timedOut: AppError | undefined;
    try {
      const result = ms === undefined ? await run() : await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timedOut = new AppError('PLUGIN_CALL_TIMEOUT', `${id}: ${operation} did not finish within ${ms / 1000}s`, 504)), ms); timer.unref(); }),
      ]);
      if (ms !== undefined) this.answered(entry, activation);
      return result;
    } catch (error) {
      if (ms !== undefined) {
        if (error === timedOut) this.timedOut(entry, activation, operation);
        else this.answered(entry, activation);
      }
      this.attribute(entry, operation, error);
      throw error;
    } finally { clearTimeout(timer); }
  }

  private timedOut(entry: Entry, activation: Activation, operation: string): void {
    if (++activation.timeouts < FAIL_FAST_AFTER) return;
    activation.openUntil = Date.now() + this.port.failFastMs;
    // `note` is the entry's attention text: it reaches the status and the diagnostics, and it is not an off-switch like `problem`.
    const notice = `not responding: ${operation} timed out ${activation.timeouts} times in a row; calls are refused until ${new Date(activation.openUntil).toISOString().slice(11, 19)} UTC`;
    if (!activation.notice || entry.note === activation.notice) entry.note = notice;
    activation.notice = notice;
    this.port.changed();
  }

  /** The plugin returned or threw rather than hanging. */
  private answered(entry: Entry, activation: Activation): void {
    if (!activation.timeouts) return;
    activation.timeouts = 0; activation.openUntil = 0;
    if (activation.notice && entry.note === activation.notice) { entry.note = undefined; this.port.changed(); }
    activation.notice = undefined;
  }

  /** The contributions consumers read, with the calls that can hang or fail going through `through`. Built once per activation. */
  guardContributions(entry: Entry, activation: Activation, contributions: Contributions): Contributions {
    const inProcess = entry.source !== 'installed' || entry.trusted === true;
    const limit = (operation: keyof typeof CALL_LIMITS_MS): number | undefined => inProcess ? this.port.callTimeoutMs ?? CALL_LIMITS_MS[operation] : undefined;
    const timed = (operation: keyof typeof CALL_LIMITS_MS, then?: (result: unknown) => unknown) => (original: Method): Method =>
      async (...args) => { const result = await this.through(entry, activation, operation, limit(operation), async () => original(...args)); return then ? then(result) : result; };
    const sync = (operation: string) => (original: Method): Method => (...args) => {
      try { return original(...args); } catch (error) { this.attribute(entry, operation, error); throw error; }
    };
    const attachment = (value: unknown): unknown => value && typeof value === 'object'
      ? intercepting(value as object, { bindNative: timed('runtimeAttachment.bindNative'), stop: timed('runtimeAttachment.stop'), act: timed('runtimeAttachment.act') }) : value;
    const replaced: Record<string, unknown> = {};
    if (contributions.modelSources) {
      replaced.modelSources = contributions.modelSources.map(source => intercepting(source, {
        prepare: timed('modelSource.prepare'), catalog: timed('modelSource.catalog'), usage: timed('modelSource.usage'), resolve: sync('modelSource.resolve'),
      }));
    }
    if (contributions.sharePublisher) {
      replaced.sharePublisher = intercepting(contributions.sharePublisher, {
        capability: timed('sharePublisher.capability'), deploy: timed('sharePublisher.deploy'), find: timed('sharePublisher.find'),
        remove: timed('sharePublisher.remove'), verify: timed('sharePublisher.verify'), publicUrl: sync('sharePublisher.publicUrl'),
      });
    }
    if (contributions.runtimeHooks) {
      replaced.runtimeHooks = contributions.runtimeHooks.map(hook => intercepting(hook, {
        prepare: timed('runtimeHook.prepare', attachment), recover: timed('runtimeHook.recover', attachment),
      }));
    }
    if (contributions.agentTools) {
      replaced.agentTools = Object.fromEntries(Object.entries(contributions.agentTools).map(([key, group]) => [key, intercepting(group, {
        call: original => (...args) => this.through(entry, activation, `agentTool.${key}.call`, undefined, async () => original(...args)),
      })]));
    }
    if (!Object.keys(replaced).length) return contributions;
    const copy = Object.create(Object.getPrototypeOf(contributions) as object | null) as Contributions;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(contributions))) Object.defineProperty(copy, key, { ...descriptor, configurable: true });
    for (const [key, value] of Object.entries(replaced)) Object.defineProperty(copy, key, { value, enumerable: true, writable: true, configurable: true });
    return copy;
  }
}
