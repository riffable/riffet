import type { NativeBackendId } from './agent-ids.js';
import type { GatewayProtocol } from './plugin-management.js';

export interface ConfigFile { id: string; label: string; path: string; scope: 'project' | 'user'; kind: 'rules' | 'skills' | 'commands' | 'mcp' | 'hooks' | 'cli' | 'worktrees'; exists: boolean; content?: string; hash?: string; }
export interface CommandResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean; truncated?: boolean; }
export interface TailscaleCapability {
  present: boolean; loggedIn?: boolean; ip?: string; version?: string; message: string;
}
export interface CapabilityReport {
  cliPath: string; cliVersion?: string; authenticated: boolean; authMessage?: string;
  tmux: boolean; nativePersistence: string; models: string[];
  tailscale: TailscaleCapability;
  checkedAt: string; warnings: string[];
}
/**
 * Whether a backend's shell commands are observed for the files they change (`GET /api/backends/:id/command-observation`).
 * `unsupported`: this CLI cannot; `untrusted`: it waits for the user to trust the hooks that observe, in the CLI's own
 * trust store; `inactive`: trusted or not, the running server was started without them; `active`: observed.
 */
export interface CommandObservation { state: 'unsupported' | 'inactive' | 'untrusted' | 'active' }
/** What the machine offers every Agent (`GET /api/system/machine`): tmux for their terminals, and the tailnet. Not an Agent's own fact, so it is there while any Agent plugin is off. */
export interface MachineReport { tmux: boolean; tailscale: TailscaleCapability; warnings: string[]; checkedAt: string; }
export interface ModelConfigOption { id: string; name: string; description?: string; category?: string; type: 'select'; currentValue: string; options: Array<{ value: string; name: string; description?: string }>; }
export interface NativeModelVariant { value: string; name: string; }
export interface ModelInfo {
  value: string; name: string; configOptions: ModelConfigOption[];
  /** Provider-declared identities for this model, including selectors saved before a rename. */
  aliases?: string[];
  /** Exact CLI-listed variants behind the generated controls. */
  nativeVariants?: NativeModelVariant[];
  /** Provider-declared context/input token limit; absent when the catalog declares none. */
  contextWindow?: number;
  /**
   * The catalog lists this model as its long-context variant (Claude Code's `[1m]` suffix on a
   * discovered gateway id), so the client may offer the 1M request even without a token limit.
   */
  longContext?: boolean;
}

/** One metered usage window, as the share of it already used. */
export interface UsageWindow {
  usedPercent: number;
  /** Length of the window (300 is five hours, 10080 a week); absent when the provider does not say. */
  windowMinutes?: number;
  /** ISO time the window resets. */
  resetsAt?: string;
}
/** A daily soft quota. Exhaustion lowers request priority rather than disabling the model. */
export interface ModelDailyQuota extends UsageWindow {
  remaining: number;
  limit: number;
  depleted?: boolean;
}
/** A model's live standing at its provider. Every field is absent when the provider did not report it. */
export interface ModelStatus {
  /** Load as the provider measures it; above 100 means requests wait in the provider's queue. */
  loadPercent?: number;
  /** A metered quota this model draws from; several models may share one. */
  quota?: UsageWindow & { remaining?: number; limit?: number; depleted?: boolean };
  /** Whether the provider applies the shared weekly quota; true without a snapshot means unavailable. */
  quotaLimited?: boolean;
  /** The provider's exact daily quota binding; present without dailyQuota when its read is unavailable. */
  dailyQuotaKey?: string;
  dailyQuota?: ModelDailyQuota;
}
/** What the signed-in account may still use with a backend, and how busy each of its models is. */
export interface NativeBackendUsage {
  account?: { plan?: string; windows: UsageWindow[]; credits?: { balance?: number; unlimited?: boolean }; limitReached?: boolean };
  /** Keyed by `ModelInfo.value`; provider aliases also resolve older cached catalogs. */
  models: Record<string, ModelStatus>;
  fetchedAt: string;
}

/** `shortLabel` is the name a toolbar shows when the full label would not fit beside the model. */
export interface NativeBackendOption { id: string; label: string; shortLabel?: string; description?: string; }
/** Input types one model accepts. DSH names the DeepSeek catalog field `inputModalities`. */
export type ModelInputModality = 'text' | 'image';
/** Declared input types per model id, at least one type per entry. */
export type ModelInputModalities = Record<string, ModelInputModality[]>;
/** Context window in tokens, by model id. */
export type ModelContextWindows = Record<string, number>;
/**
 * A named connection source or gateway adapter a profile can use, provided by a plugin.
 *
 * Connection sources may supply a canonical endpoint and a credential the user cannot reasonably type: an SSO token
 * in another tool's cache, a JWT minted per request by a CLI, a key that lives in the environment.
 * Naming the source is what lets the server resolve it, and what tells the driver which injection
 * path to take. Sources come from plugins, so the set is open: a name nothing provides on this
 * server is kept as saved and resolves to nothing. Gateway adapters instead interpret the profile's
 * existing address and key, adding catalog and optional quota support without replacing the connection.
 */
export type NativeModelSource = string;
/** Wire API used by a custom model provider. Omitted keeps the backend's existing default. */
export const NATIVE_MODEL_API_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const;
export type NativeModelApiProtocol = typeof NATIVE_MODEL_API_PROTOCOLS[number];
/** Public profile metadata. Runtime secrets and provider-specific settings stay on the server. */
export interface NativeBackendProfile { id: string; backendId: NativeBackendId; name: string; description?: string; isDefault?: boolean; }
/** Safe editable profile fields. Credentials are write-only; responses report only `hasApiKey`. */
export interface NativeBackendProfileSettings extends NativeBackendProfile {
  executable?: string; configDir?: string; sourceDir?: string;
  apiEndpoint?: string; agentEndpoint?: string; disableAutoUpdate?: boolean;
  apiProtocol?: NativeModelApiProtocol;
  defaultModel?: string; hasApiKey?: boolean;
  /**
   * Model ids offered in session pickers. `undefined` means the whole catalog, so a freshly
   * configured endpoint is usable before anyone curates it; `[]` is an explicit empty selection
   * and is honoured as such. The two are not interchangeable.
   */
  enabledModels?: string[];
  /**
   * What each model accepts, for the ids a user had to answer for.
   *
   * A gateway is the only authority on the ids it serves and almost never publishes what a model
   * takes, so a human has to state it. DSH is the one consumer: an id missing from its own catalog
   * is treated as text-only, and every image is swapped for a text placeholder *before the request
   * leaves* — the transcript then shows a missing image nobody can diagnose from the app. Absent
   * entries are left to the backend's own answer, so declaring nothing changes nothing.
   */
  modelInputModalities?: ModelInputModalities;
  /**
   * Context window in tokens per model id, for the ids whose gateway does not say. Claude Code is the
   * consumer: a window is what offers a model's 1M variant and what the CLI is told to budget for. A
   * gateway's own declaration is not overridden by an absent entry, so declaring nothing changes nothing.
   */
  modelContextWindows?: ModelContextWindows;
  /**
   * The plugin connection source or gateway adapter used by this profile. Absent means what the profile has always
   * meant: the CLI's own login, or the `apiEndpoint` + `apiKey` the user typed. A source supplies
   * both the catalog and the credential; adapters use the profile's own connection. For sources, `apiEndpoint` overrides the default
   * address, and `apiKey` only an override of its key.
   */
  modelSource?: NativeModelSource;
}
/** `null` clears a field: it drops the stored credential, or restores the uncurated full catalog. */
export type NativeBackendProfileSettingsUpdate = Partial<Omit<NativeBackendProfileSettings, 'id' | 'backendId' | 'hasApiKey' | 'isDefault' | 'enabledModels' | 'modelInputModalities' | 'modelContextWindows' | 'modelSource' | 'apiProtocol'>> & { apiKey?: string | null; enabledModels?: string[] | null; modelInputModalities?: ModelInputModalities | null; modelContextWindows?: ModelContextWindows | null; modelSource?: NativeModelSource | null; apiProtocol?: NativeModelApiProtocol | null };
export interface NativeBackendProfilesResponse { profiles: NativeBackendProfileSettings[]; defaultProfileId?: string; }
export interface NativeBackendCapabilities {
  backendId: NativeBackendId;
  label: string;
  modes: NativeBackendOption[];
  permissions: NativeBackendOption[];
  interactionTransport: 'terminal' | 'protocol' | 'both' | 'none';
  supportsResume: boolean;
  supportsInterrupt: boolean;
  /** Missing means unsupported; never fall back to interrupting or queuing. */
  supportsSteer?: boolean;
  supportsRecovery?: boolean;
  supportsTargetedStop?: boolean;
  supportsHistory: boolean;
  supportsModelSelection: boolean;
  supportsModeSelection: boolean;
  supportsPermissionSelection: boolean;
  supportsTerminal?: boolean;
  /**
   * The conversation lives in its terminal: it is live, and takes a message, only while that terminal
   * runs, and a stopped one is resumed on request. Missing means it is live while its status is not `offline`.
   */
  requiresLiveTerminal?: boolean;
  supportsPrewarm?: boolean;
  /** The backend can take a brand-new session's first user message as a launch argument. */
  supportsInitialPromptArgs?: boolean;
  slashCommands?: Array<{ name: string; description?: string; hint?: string }>;
  /**
   * Leading slash command (without `/`) that triggers manual context compaction
   * (`summarize` for Cursor, `compact` for Claude Code and Codex). Absent when unsupported.
   */
  compactCommand?: string;
  /**
   * A skill named mid-message (`… /name …`) is invoked, not only one that opens the message.
   * Commands only ever work as the leading token.
   */
  inlineSkills?: boolean;
  /**
   * A conversation's tool groups reach this backend: each launch is given the Riffet MCP server
   * without editing the CLI's own config. Missing means the backend runs without Riffet tools.
   */
  supportsRiffetTools?: boolean;
  /**
   * Which kinds of the user's installed extensions a conversation can switch off for itself
   * (`Session.extensionsOff`). Missing means neither.
   */
  extensionToggles?: { mcp: boolean; skills: boolean };
  /** This backend/profile can read a referenced session's materialized snapshot on the execution host. */
  supportsSessionReferences?: boolean;
  /**
   * The permission a conversation of this backend runs under when another Agent consults it (docs/AGENT-CALLS.md §5):
   * it reads freely and asks before anything that writes. Missing means the backend can only be called to work in a
   * worktree of its own.
   */
  consultPermission?: string;
  /**
   * The gateway protocols this backend's launches can be pointed at. A model source is offered to it when the source's
   * `protocols` intersect these. Missing from a server that predates it: match the source's `backends` then.
   */
  consumesProtocols?: GatewayProtocol[];
}
/** One entry of the composer's `/` menu. */
export interface NativeSlashItem {
  name: string;
  description?: string;
  hint?: string;
  /** A `command` only works as the message's first token; a `skill` may also be named mid-message. */
  kind: 'command' | 'skill';
  /** The skill's instruction file, when the provider reports one. */
  path?: string;
}
/** What `/` offers for one backend profile in one project: built-in commands plus discovered skills. */
export interface NativeSlashCatalog {
  items: NativeSlashItem[];
  inlineSkills: boolean;
  /** Set when discovery failed and only the built-in commands are listed. */
  reason?: string;
}
/**
 * How the installed CLI compares with the versions its adapter declares: `too-old` is below a
 * version known to break it, `untested` newer than any verified, `unknown` unreadable. Only a
 * check the adapter already makes refuses a version; `untested` never does.
 */
export type NativeCliVersionStatus = 'supported' | 'untested' | 'too-old' | 'unknown';
export interface NativeCliVersion {
  /** The version the CLI printed (`2.1.302`, `2026.10.01-e373342`); absent when it could not be read. */
  version?: string;
  status: NativeCliVersionStatus;
  minimum?: string;
  /** The newest version actually verified with this adapter. */
  testedThrough?: string;
}
export interface NativeBackendCatalogEntry {
  backendId: NativeBackendId;
  label: string;
  available: boolean;
  reason?: string;
  /** The Agent is installed but its account is not signed in; `reason` may say more. A client shows one generic hint for it. */
  needsLogin?: boolean;
  profiles: NativeBackendProfile[];
  capabilities: NativeBackendCapabilities;
  models: ModelInfo[];
  defaultModel?: string;
  /** The described profile's CLI version, as its availability probe read it. */
  cliVersion?: NativeCliVersion;
  /**
   * Only on a conversation's catalog: the backend's other profiles that keep conversations where this
   * one does and serve the model line it runs on (Claude, GPT…), so it continues on them in place. Each
   * lists its models of that line; picking one is a `configure` carrying both `backendProfileId` and
   * `model`. Absent when there are none, or from a server that predates it.
   */
  continuations?: NativeProfileContinuation[];
}
export interface NativeProfileContinuation { profile: NativeBackendProfile; models: ModelInfo[]; }
