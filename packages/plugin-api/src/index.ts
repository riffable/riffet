// What a built-in plugin may use and provide (docs/PLUGIN_ARCHITECTURE.md).
//
// A plugin imports only this package and `@contracts`; everything else it needs from the
// core comes through `PluginHost`. That is what lets the core change behind it, and what lets a
// build leave a vendor's plugins out without touching anything else.
//
// `PLUGIN_API_VERSION` names the shapes below. Changes are additive only: a new optional member
// keeps the version, anything an existing plugin could break on bumps it, and the registry
// refuses a manifest written against another version.

import type {
  ActionStep, PluginField, PluginStatus, LocalizedText, ModelConfigOption, ModelInfo,
  NativeBackendId, NativeBackendUsage, NativeRuntimeControl, PluginCommandResult, PluginDeclarations, PluginRequirement, ShareCapability, Task, TaskActionPresentation, TaskDiagnostic, TaskParamField, TaskParams,
} from '@riffet/contracts';
import type { AgentBackend, AgentProfile } from './agent.js';
import type { GatewayProtocol } from '@riffet/contracts';

export type { ActionStep, PluginField, PluginStatus, TaskActionPresentation, TaskDiagnostic, TaskParamField, TaskParams };
export type { TaskActionIcon, TaskLogRecords, TaskLogRule, TaskLogTone } from '@riffet/contracts';
export type { PluginCommandResult };
export * from './agent.js';
export * from './kit/index.js';

export const PLUGIN_API_VERSION = 1;

export interface PluginManifest {
  /** `<vendor>.<name>`, lowercase. Also the plugin's key in `plugins.json`. */
  id: `${string}.${string}`;
  vendor: string;
  name: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  /** Used while the user has not chosen. `auto` asks `detect()`. */
  defaultEnabled: 'auto' | boolean;
  /** Requires explicit local trust to use in-process host APIs; this never grants execution trust. */
  requiresTrustedHost?: boolean;
  /** Editable while the plugin is off. A secret's value is readable only through `host.secrets`. */
  settings?: Array<Pick<PluginField, 'key' | 'label' | 'kind'>>;
  /** Package semver. It does not take part in contribution ids. */
  version?: string;
  /** Shown instead of `name` in the client's language; `name` is the fallback. */
  title?: LocalizedText;
  description?: LocalizedText;
  /** Static declarations, read without running the plugin, so they are listed while it is off. The registry validates them and rejects the plugin if they are invalid. */
  contributes?: PluginDeclarations;
  /** Plugins that must be on first. A missing or off required one keeps this plugin off (`requires <id>`); cycles are rejected. */
  requires?: PluginRequirement[];
  /** Semver ranges the package needs of this host, per entry: `server` against `PLUGIN_API_VERSION`, `web` against the web plugin SDK version, `agent` against `AGENT_PROTOCOL_VERSION`. An entry that does not match is not used and shows why. */
  hostApi?: { server?: string; web?: string; agent?: string };
  /** The version of the data this package keeps in its state directory. A higher one than recorded backs the directory up first; a lower one refuses to activate. */
  dataVersion?: number;
  /** Missing means startup for API-v1 compatibility. Other kinds activate only on matching declared contribution use. */
  activation?: Array<'startup' | 'command' | 'model-source' | 'task' | 'view'>;
  /** What an installed package asks for (`PLUGIN_CAPABILITIES`); the user grants exactly this set at install. Not a sandbox for in-process built-in, development or explicitly trusted installed code. */
  capabilities?: string[];
}

export interface Plugin {
  manifest: PluginManifest;
  /** Whether this machine is one the plugin serves. Runs on start, after a settings change and on an explicit refresh, never when the list is read; keep it a cheap local check. */
  detect?(host: PluginHost): Promise<boolean>;
  /**
   * Called each time the plugin is turned on. Contributions are staged: they take effect only
   * once this resolves and the activation is still wanted. A throw or rejection discards them, and
   * `scope` disposers run.
   */
  activate(host: PluginHost, scope: ActivationScope): Contributions | Promise<Contributions>;
}

/** One activation of an integration: what it opens belongs to it and is released when it ends. */
export interface ActivationScope {
  /** Increases with each activation of this plugin; a late result tagged with an older one is stale. */
  readonly generation: number;
  /** Aborts when the activation is turned off or replaced; stop starting new work then. */
  readonly signal: AbortSignal;
  /**
   * Runs `fn` when the activation ends, last registered first, each bounded to about five seconds.
   * Registered after the end it runs at once. Release what only this plugin holds (timers,
   * watchers, observation of a sidecar); a process that outlives Riffet is detached, not stopped.
   */
  onDispose(fn: () => void | Promise<void>): void;
}

export interface Contributions {
  /** Runs when the activation ends, before the scope's disposers. */
  dispose?(): void | Promise<void>;
  modelSources?: ModelSourceProvider[];
  sharePublisher?: SharePublisher;
  /** One per backend; a second for the same backend is ignored. */
  runtimeHooks?: NativeRuntimeHook[];
  actions?: Record<string, ActionHandler>;
  status?(): Promise<PluginStatus>;
  doctorChecks?(): Promise<DoctorCheck[]>;
  /** Each id is declared in the manifest's `contributes.tasks`. The host runs the tasks, so turning the plugin off never stops one that is running. */
  taskProviders?: TaskProvider[];
  /** Experimental (see `agent.ts`). Each id is declared in the manifest's `contributes.agentBackends`. Turning the plugin off stops new sessions and deliveries; native processes that outlive Riffet keep running. */
  agentBackends?: AgentBackend[];
  /** Keyed by command id; each is declared in the manifest's `contributes.commands`. Run by `POST /api/integrations/:id/commands/:name` after the server has checked the caller, the scope, `when` and the arguments. */
  commands?: Record<string, CommandHandler>;
  /**
   * Services other plugins can use, by name (`/^[a-z0-9][a-z0-9.-]{0,63}$/`), each with a semver `version` and its methods. A
   * consumer must list this plugin in its `requires` and asks `host.services.get`. In-process packages only, including explicitly trusted installs: an
   * isolated package cannot share these objects, so its services are not offered and it gets none.
   */
  services?: Record<string, PluginService>;
  /** Keyed by style id; each is declared in the manifest's `contributes.avatarStyles`. Installed isolated packages can provide them too. */
  avatarStyles?: Record<string, AvatarStyleProvider>;
}

/** What a generated avatar is drawn from (docs/OWNER.md「随机头像」). */
export interface AvatarStyleRequest {
  /** The same request must give the same picture. */
  seed: string;
  /** Side of the square, in pixels; the core rasterizes at this size. */
  size: number;
  /** `#rrggbb` of the client's text color; draw lines and glyphs with it. */
  ink: string;
  /** `#rrggbb` of the client's background color; fill the square with it. */
  paper: string;
  /** The owner's name, passed only to a style declared `needsName`. */
  name?: string;
}

/** One style of generated avatar. Returns an SVG document; the core checks it (size, no script, no external reference) before it draws it, and never serves it. */
export interface AvatarStyleProvider {
  generate(request: AvatarStyleRequest): string | Promise<string>;
}

/** A service a plugin offers other plugins in the server process: the host hands the object over as it is, with no permission of its own. */
export interface PluginService { version: string; [member: string]: unknown }

// ── Host ─────────────────────────────────────────────────────────────────────

export interface ProcessOptions { cwd: string; timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv }
export interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }

export interface GatewayModelsRequest {
  baseUrl: string;
  apiKey?: string;
  /** `anthropic` sends `x-api-key`; otherwise `Authorization: Bearer`. */
  auth?: 'bearer' | 'anthropic';
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Expose the gateway's declared reasoning ladder as an `effort` option. */
  reasoningLevels?: boolean;
  /** When the listing is not at `<base>/v1/models`. */
  modelsPath?: string;
  headers?: Record<string, string>;
  select?: (entry: Record<string, unknown>) => boolean;
}

export interface PluginHost {
  readonly id: PluginManifest['id'];
  /** Bounded, attributed host logs; implementations redact configured secrets before persisting. */
  logger?: { debug(message: string): void; info(message: string): void; warn(message: string): void; error(message: string): void };
  /** `<stateDir>/plugin-data/<id>`, created private on first call. */
  stateDir(): Promise<string>;
  /** Saved values of the manifest's `text` settings. */
  settings(): Readonly<Record<string, string>>;
  /** Saved `secret` settings plus whatever the plugin stores itself. Never sent to clients. */
  secrets: { get(name: string): string | undefined; set(name: string, value: string | null): Promise<void> };
  runProcess(file: string, args: string[], options: ProcessOptions): Promise<ProcessResult>;
  /** Absolute path of a CLI, searched beyond the daemon's PATH; `undefined` when it is not installed. */
  resolveCli(command: string, env?: NodeJS.ProcessEnv): string | undefined;
  gateway: {
    /** Throws on an unreachable or rejecting gateway; an empty directory is an empty list. */
    fetchModels(request: GatewayModelsRequest): Promise<ModelInfo[]>;
    /** `baseUrl` with a version segment, unless it already ends in one. */
    baseUrl(url: string, segment?: string): string;
    /** `url` without a trailing version segment. */
    rootUrl(url: string): string;
    effortOption(levels: readonly string[], declaredDefault?: string): ModelConfigOption | undefined;
  };
  /** After a credential changes, so pickers fetch again. */
  invalidateModelCatalogs(): void;
  /** Whether a saved profile names this model source, so `detect()` can keep on what a profile already relies on. */
  modelSourceInUse?(id: string): boolean;
  /** The profiles of an Agent this plugin provides as the user has them configured (`config` included), for a check that runs without a session. Empty when the host keeps none. */
  agentProfiles?(backendId: NativeBackendId): AgentProfile[];
  /**
   * Starts a task of one of this plugin's own task providers through the task service, so it is the host's task (log, lock,
   * cancel, a plan of an installed package confirmed first) and not a process of the plugin's. `providerId` may be left out when the
   * plugin declares one provider. A failure is the task service's own error, which a command passes on to its caller.
   * Absent for isolated installed packages, whose host does not offer it.
   */
  tasks?: { start(projectId: string, actionId: string, params?: TaskParams, options?: { providerId?: string; confirm?: string }): Promise<Task> };
  /**
   * A service of a plugin this one lists in `requires` (`Contributions.services`), when that plugin is on and its `version`
   * satisfies the semver `range`. `undefined` when it is off, the version does not match, the service does not exist or the
   * dependency is optional and absent; asking for a plugin not in `requires` throws. Absent for isolated installed packages.
   */
  services?: { get<T extends PluginService = PluginService>(pluginId: string, name: string, range: string): T | undefined };
  /** An error whose message reaches the client unchanged when `statusCode` is below 500. */
  error(code: string, message: string, statusCode?: number): Error;
}

// ── Commands ─────────────────────────────────────────────────────────────────

/** What a command runs with. `projectId` and `sessionId` have been checked by the server against the command's scope and the caller. */
export interface CommandContext {
  readonly projectId?: string;
  readonly sessionId?: string;
  /** Validated against the declaration's `params`, defaults filled in. */
  readonly args: Readonly<Record<string, string | number | boolean>>;
  /** The approval a caller sent for a plan of a task this command starts; pass it on as `host.tasks.start`'s `confirm`. */
  readonly confirm?: string;
  /** Aborts when the plugin is turned off, or the command takes too long. */
  readonly signal: AbortSignal;
}

export interface CommandHandler {
  run(context: CommandContext): Promise<PluginCommandResult>;
}

// ── Model sources ────────────────────────────────────────────────────────────

export type { GatewayProtocol };
/** The older, per-CLI way to say what a source serves; `kit/gateway.ts` maps it to the protocol it stands for. */
export type ModelSourceBackend = 'claude' | 'codex';
/** Where one protocol of a source is reached. */
export interface SourceEndpoint {
  /** What the consuming CLI appends its wire path to: Anthropic Messages is the root (`/v1/messages` follows), Responses and Chat carry their version segment. */
  baseUrl: string;
  /** Sent with every model request over this protocol. */
  headers?: Record<string, string>;
}
/** What a profile may override of a source's defaults. */
export interface SourceOverrides { apiEndpoint?: string; apiKey?: string }
export type SourceCredential = { kind: 'static'; key: string } | { kind: 'command'; command: string; args: string[] };

export interface ResolvedSource {
  /** Where each protocol the source serves is reached. A driver reads it through `sourceEndpoint`, which also answers from the three older members below. */
  endpoints?: Partial<Record<GatewayProtocol, SourceEndpoint>>;
  /** Older form of `endpoints['anthropic-messages'].baseUrl`: the root Claude Code appends `/v1/messages` to. */
  claudeBaseUrl?: string;
  /** Older form of `endpoints['openai-responses'].baseUrl`: the base Codex appends its wire path to, version segment included. */
  codexBaseUrl?: string;
  /** Already accounts for the profile's own key: a source that honours an override returns it here. */
  credential?: SourceCredential;
  /** Older form of an endpoint's `headers`, per backend. */
  headers?: Partial<Record<ModelSourceBackend, Record<string, string>>>;
  disableWebsockets?: boolean;
  /** Why the source cannot be used right now. Never contains a credential. */
  reason?: string;
}

export interface ModelSourceProvider {
  /** Stored in a profile's `modelSource`: `/^[a-z0-9][a-z0-9.-]{0,63}$/`, unique across integrations. */
  id: string;
  label: string;
  /** The gateway protocols the source serves; an Agent whose `consumesProtocols` share one is offered it. */
  protocols?: readonly GatewayProtocol[];
  /** Older form of `protocols`, read only when `protocols` is absent. */
  backends?: readonly ModelSourceBackend[];
  /** Used when the profile leaves its address empty. */
  defaultEndpoint?: string;
  /** What a profile may override. Absent means both; a client hides the rest. */
  overridable?: ReadonlyArray<keyof SourceOverrides>;
  /** An action of the same plugin that signs in to this source. */
  loginAction?: string;
  /** Shown with the source in a profile editor, such as how to sign in outside Riffet. */
  hint?: { text: string; command?: string };
  /** Synchronous: the drivers build a launch environment synchronously. */
  resolve(overrides: SourceOverrides): ResolvedSource;
  /**
   * Gets `resolve(overrides)` ready: the host awaits it before a catalog or usage read for the same overrides. A source that
   * runs out of process cannot answer `resolve` from another process, so its proxy returns the value `prepare` last
   * fetched for these overrides (a `reason` until the first one), and refreshes it in the background when it is old.
   */
  prepare?(overrides: SourceOverrides): Promise<void>;
  catalog(backend: ModelSourceBackend, overrides: SourceOverrides): Promise<ModelInfo[]>;
  /**
   * Quota and load for these credentials, independent of the Agent consuming this source.
   * A failed read must reject rather than report zero or unlimited quota.
   * Percentages, windowMinutes and quota.remaining/limit must be nonnegative Int32 integers
   * (windowMinutes must be positive); dailyQuota.remaining/limit and credit balances may be fractional.
   * Times must be UTC ISO 8601 (Z); the isolated host also accepts and normalizes timezone offsets.
   */
  usage?(overrides: SourceOverrides): Promise<NativeBackendUsage>;
}

// ── Share publishing ─────────────────────────────────────────────────────────

export interface ShareIdentity { username: string; profile?: string }
export interface PublishedPreview { id: string; url: string; expiresAt?: string; deploymentId?: string }

/** Publisher failures localized by the host, including publishers distributed outside the host repository. */
export type SharePublisherErrorCode =
  | 'INVALID_SHARE_ALIAS'
  | 'SHARE_ALIAS_EXISTS'
  | 'SHARE_CLI_MISSING'
  | 'SHARE_CLI_TIMEOUT'
  | 'SHARE_LIST_INCOMPLETE'
  | 'SHARE_LOGIN_REQUIRED'
  | 'SHARE_PERMISSION_DENIED'
  | 'SHARE_PLATFORM_UNAVAILABLE';

/** Where a share package goes. The core owns the package, the alias and the receipts; credentials stay with the publisher. */
export interface SharePublisher {
  /** Pure synchronous display-link projection for existing receipts; must not perform I/O. */
  publicUrl?(alias: string): string;
  label: string;
  /** Who can open a published page. */
  audience: string;
  capability(options?: { fresh?: boolean }): Promise<ShareCapability>;
  deploy(directory: string, alias: string, expiryDays: number, identity: ShareIdentity, override: boolean): Promise<PublishedPreview>;
  find(alias: string, identity: ShareIdentity): Promise<PublishedPreview | undefined>;
  remove(previewId: string, identity: ShareIdentity): Promise<void>;
  /** Whether the page at `alias` serves the package with this hash. */
  verify(alias: string, hash: string): Promise<boolean>;
}

// ── Native runtime hooks ─────────────────────────────────────────────────────

export interface RuntimeContext {
  sessionId: string;
  /** The native process's launch identity; an attachment is only recovered under the same one. */
  fingerprint: string;
  profileConfig: Readonly<Record<string, unknown>>;
  /** Private directory for this backend's attachments. */
  directory: string;
  /** What `control` returns has changed; the core reads it again and republishes the session. */
  onChange(): void;
}

/** The control a sidecar shows on its conversation; the core adds `owner`. */
export type RuntimeControl = Omit<NativeRuntimeControl, 'owner'>;

/** A sidecar bound to one native process, such as a routing proxy. */
export interface RuntimeAttachment {
  /** Persisted with the native process, so a later server can `recover` it. */
  readonly id: string;
  /** Merged into the native process's environment at spawn. */
  readonly launchEnv: Record<string, string>;
  /**
   * The control for the conversation's current model, read synchronously at every publish; must not
   * do I/O. Absent, or `undefined`, shows nothing.
   */
  control?(input: { model?: string }): RuntimeControl | undefined;
  /**
   * Runs an action `control` offered. Reject with `host.error('RUNTIME_CONTROL_CHANGED', …, 409)` when
   * `revision` is no longer current; any `host.error` reaches the client as it is.
   */
  act?(input: { action: string; revision: string; model?: string }): Promise<void>;
  bindNative(input: { address: string; pid?: number; nativeSessionId?: string }): Promise<void>;
  /** Stops observing; the attachment keeps serving a native process that outlives this server. */
  detach(): void;
  stop(): Promise<void>;
}

export interface NativeRuntimeHook {
  backendId: NativeBackendId;
  /** Before the native process spawns. `undefined` leaves it alone; so does a rejection, reported as unavailable. */
  prepare(context: RuntimeContext): Promise<RuntimeAttachment | undefined>;
  /** For a native process that outlived the previous server. */
  recover(context: RuntimeContext & { id: string; address: string }): Promise<RuntimeAttachment | undefined>;
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** Any step but `show-code`, which the host builds from a `DeviceFlow`. */
export type ActionOutcome = Exclude<ActionStep, { kind: 'show-code' }>;

/**
 * A started device-code login. The host shows the code under a flow id of its own and calls `poll`
 * for it, so the device code never leaves the server.
 */
export interface DeviceFlow {
  kind: 'device-flow';
  verificationUri: string;
  userCode?: string;
  intervalMs: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  poll(): Promise<ActionOutcome>;
}

export interface ActionHandler {
  label: string;
  kind: 'run' | 'device-flow';
  run(): Promise<ActionOutcome | DeviceFlow>;
}

// ── Doctor ───────────────────────────────────────────────────────────────────

export type DoctorStatus = 'ok' | 'warn' | 'fail';
export interface DoctorCheck {
  id: string; label: string; status: DoctorStatus; detail: string; fix?: string;
  /** An Agent's check sets it when its CLI is on this machine; `riffet doctor` reports "no agent CLI" only when no check did. */
  installed?: boolean;
}

// ── Task providers ───────────────────────────────────────────────────────────

/**
 * One project as a task provider sees it: read-only, confined to the project root by the host's
 * realpath checks (a path that leaves it throws), and never an absolute path. The host resolves the
 * working directory of a task from the project; a plan only names one inside it.
 */
export interface ProjectContext {
  readonly id: string;
  readonly name: string;
  /** `relPath` is project-relative; `''` is the root. */
  exists(relPath: string): Promise<boolean>;
  /** Up to `maxBytes` of a regular file as text, or `undefined` when it is missing or not a file. */
  readText(relPath: string, maxBytes: number): Promise<string | undefined>;
  /** The entry names of a directory (not paths), at most a few thousand; empty when it is missing. */
  list(relDir: string): Promise<string[]>;
}

/** What a provider may ask of the host while reading a log. */
export interface DiagnosticsContext {
  /** An absolute or project-relative path from the log as a project-relative one, or `undefined` for a path outside the project. */
  relativize(path: string): string | undefined;
}

/** Presentation (`group`, `primary`, `icon`, `confirm`, `log`) is optional; a host that predates a field ignores it. */
export interface TaskActionSpec extends TaskActionPresentation {
  /** `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, unique within the provider. */
  id: string;
  title: LocalizedText;
  /** The values the action takes. A request carrying any other key or kind is refused before `plan`. */
  params?: TaskParamField[];
}

/** The command of one task: fixed when the task starts and kept by the host, whatever happens to the plugin afterwards. */
export interface TaskPlan {
  /** A bare command found on PATH (`gradle`), or `./path` inside the project (`./gradlew`). Never absolute, never containing `..`. */
  file: string;
  args: string[];
  /** Project-relative; defaults to the project root. */
  cwd?: string;
  /** Added to the server's environment, which carries the user's PATH, JAVA_HOME and ANDROID_HOME. */
  env?: Record<string, string>;
  /** A task of the same project with the same lock may not start while one runs; none means the task never waits on another. */
  lock?: string;
  /** Project-relative globs (`*`, `?`, `**`) of files to register as artifacts after a successful run. */
  artifacts?: string[];
}

export interface TaskProvider {
  /** `<pluginId>/<name>`, declared in the manifest. */
  id: string;
  /** Whether this project is one the provider serves. Reads marker files only: it runs whenever actions are listed. */
  detect(project: ProjectContext): Promise<boolean>;
  actions(project: ProjectContext): Promise<TaskActionSpec[]>;
  plan(actionId: string, params: TaskParams, project: ProjectContext): Promise<TaskPlan>;
  /** Reads the end of the log (at most 512 KB, starting at a line) after the task ends. Skipped when the plugin is off by then. */
  diagnostics?(logTail: string, context: DiagnosticsContext): TaskDiagnostic[] | Promise<TaskDiagnostic[]>;
}
