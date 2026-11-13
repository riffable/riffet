import type { Contributions, DeviceFlow, Plugin, PluginHost } from '@riffet/plugin-api';
import type { PluginDescriptor, PluginStatus } from '../../../../packages/contracts/src/index.js';
import type { PluginActivationState } from '../../../../packages/contracts/src/plugin-management.js';

export type Source = NonNullable<PluginDescriptor['source']>;
/** One activation: what `activate` opened, ended as a whole. */
export interface Activation {
  generation: number;
  controller: AbortController;
  /** Registered through `scope.onDispose`, run last first. */
  disposers: Array<() => void | Promise<void>>;
  ended: boolean;
  contributions?: Contributions;
  /** Set when the package's process failed before this activation was committed. */
  failed?: string;
  /** The last answer of `status()`, and the call still out: a list read never starts a second one. */
  statusLast?: PluginStatus;
  statusCall?: Promise<PluginStatus>;
  /** Timeouts in a row of calls through the guard (see `through`), and until when calls are refused because of them. */
  timeouts: number;
  openUntil: number;
  /** The `note` this activation put on its entry while calls are refused. */
  notice?: string;
}
export interface Entry {
  plugin: Plugin;
  host: PluginHost;
  source: Source;
  /** The real path of a development package's directory, or of the selected version of an installed one. */
  root?: string;
  /** The version an installed package runs. */
  version?: string;
  /** Explicit local-operator trust, separate from the installed source and package claims. */
  trusted?: boolean;
  /** The web entry of a development or installed package (`webEntry` on the descriptor). */
  web?: WebEntry;
  /** The server entry, which the files route never serves. */
  server?: string;
  /** Why this host can never run the package's server entry (`hostApi`); it keeps its declarations. */
  blocked?: string;
  /** A version switch that was undone, shown until the next one. */
  note?: string;
  /** What this host left out of the manifest as unknown to it (`loadableManifest`), once per load: shown in diagnostics; `ids` cannot be run. */
  skipped?: { notes: string[]; ids: string[] };
  /** Committed: lookups serve its contributions. */
  active?: Activation;
  /** Its enablement has been decided at least once, whichever way. */
  evaluated?: boolean;
  allowed?: boolean;
  demand?: string;
  demanding?: Promise<void>;
  runtime?: Omit<PluginActivationState, 'events' | 'state'>;
  /** Awaiting commit. `update()` aborts it, since the choice may have changed meanwhile. */
  starting?: Activation;
  generation: number;
  /** Why it is off although it should be on, or why detection could not answer. */
  problem?: string;
  /** What the last teardown could not release. It stays until a teardown ends cleanly or the plugin is on again. */
  cleanup?: string;
  /**
   * A turn-off or a switch to `version` that waits for the plugin's running tasks (design §8). The activation stays up and refuses
   * new tasks and commands; it goes ahead when the last task ends, or at once when an update says `force`.
   */
  waiting?: { kind: 'off' } | { kind: 'switch'; version: string };
  /** Set while an update with `force` evaluates, so a turn-off does not wait for tasks. */
  force?: boolean;
  /** Automatic restarts of an isolated package whose process died while it was live. */
  restarts?: { attempts: number; timer?: NodeJS.Timeout; stable?: NodeJS.Timeout };
  /** Lifecycle changes of this entry, one at a time. */
  tail: Promise<void>;
}
export type WebEntry = NonNullable<PluginDescriptor['webEntry']>;
export interface Flow { pluginId: string; flow: DeviceFlow; polling: boolean; /** The activation that started it: a flow outlives neither it nor the integration being on. */ activation: Activation }

export function describeError(error: unknown): string { return error instanceof Error && error.message ? error.message : String(error); }

/** Ends the wait after `ms`; the code itself cannot be stopped, only no longer waited for. */
export async function bounded(run: () => void | Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`did not finish within ${ms / 1000}s`)), ms); timer.unref(); }),
    ]);
  } finally { clearTimeout(timer); }
}
