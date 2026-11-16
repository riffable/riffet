// The wire protocol between the server and the process an installed package runs in
// (docs/PLUGIN_ARCHITECTURE.md "独立包"). JSON messages, one per line, on the child's stdin and stdout; the child side is
// `child.mjs`, which imports nothing of this package (it is the only file the child may read besides
// the package), so the shapes below are the contract both sides are written against.

import type { ActionOutcome, AvatarStyleRequest, GatewayProtocol, ModelSourceBackend, ResolvedSource, SourceOverrides, TaskActionSpec, TaskDiagnostic, TaskPlan } from '../index.js';
import type { DoctorCheck, GatewayModelsRequest, PluginStatus } from '../index.js';
import type { ModelInfo, NativeBackendUsage, PluginCommandResult, Task, TaskParams } from '@riffet/contracts';

export const RUNTIME_PROTOCOL_VERSION = 1;

export interface RpcError { code?: string; message: string; statusCode?: number }
/** A request has `method`; a response has `result` or `error` under the id of the request it answers. Both sides send both. */
export interface RpcRequest { id: number; method: string; params?: unknown }
export interface RpcResponse { id: number; result?: unknown; error?: RpcError }
export type RpcMessage = RpcRequest | RpcResponse;

/** What the child may do on the server's behalf, by method; every one is checked against the package's grants and the call it belongs to. */
export type ChildToHost = {
  'host.secrets.set': { params: { name: string; value: string | null }; result: null };
  'host.invalidateModelCatalogs': { params: Record<string, never>; result: null };
  'host.gateway.fetchModels': { params: { request: Omit<GatewayModelsRequest, 'signal' | 'select'> }; result: ModelInfo[] };
  /** `handle` names the project the call being served was made for; it is valid until that call ends. */
  'project.exists': { params: { handle: string; path: string }; result: boolean };
  'project.readText': { params: { handle: string; path: string; maxBytes: number }; result: string | null };
  'project.list': { params: { handle: string; path: string }; result: string[] };
  /** `process.exec`: `command` is one of the package's declared `executables`; the host runs it in the package's state directory. */
  'host.exec': { params: { command: string; args: string[]; timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> }; result: { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean } };
  /** `tasks.run`: the package's own task providers only; `confirm` is the plan fingerprint the user approved. */
  'host.tasks.start': { params: { projectId: string; actionId: string; params?: TaskParams; providerId?: string; confirm?: string }; result: Task };
};

export interface ChildContributions {
  modelSources: Array<{ id: string; role?: 'source' | 'adapter'; label: string; /** The protocols it serves, or the older `backends` they stand for: at least one of the two. */ protocols?: GatewayProtocol[]; backends?: ModelSourceBackend[]; defaultEndpoint?: string; overridable?: Array<keyof SourceOverrides>; loginAction?: string; hint?: { text: string; command?: string }; usage?: boolean }>;
  taskProviders: Array<{ id: string; diagnostics: boolean }>;
  actions: Array<{ id: string; label: string; kind: 'run' | 'device-flow' }>;
  /** The ids of the commands it handles (`Contributions.commands`); the server checks each against the manifest. */
  commands: string[];
  /** The ids of the avatar styles it provides (`Contributions.avatarStyles`); the server checks each against the manifest. */
  avatarStyles: string[];
  status: boolean;
  doctorChecks: boolean;
  /** Whether it gives a page (`Contributions.page`); absent from a child written before pages existed. */
  page?: boolean;
  /** Contribution kinds the package returned that cannot run out of process in this version. */
  unsupported: string[];
}

export type ChildDeviceFlow = { kind: 'device-flow'; verificationUri: string; userCode?: string; intervalMs: number; expiresAt: number; flow: string };

/** What the child's synchronous members answer from, sent with `load` and again with `state` whenever it changes; absent from a server written before them. */
export interface ChildFacts {
  /** Which of the package's declared `executables` are installed on the host now (empty without `process.exec`). */
  executables?: Record<string, boolean>;
  /** Which of the package's own model source ids a saved profile names. */
  modelSourcesInUse?: string[];
}

export interface ProjectCall { handle: string; id: string; name: string }

/** What the server asks of the child. */
export type HostToChild = {
  load: { params: { entry: string; pluginId: string; stateDir: string; settings: Record<string, string>; secrets: Record<string, string> } & ChildFacts & { /** The capabilities granted for this version: `host.tasks` exists only with `tasks.run`. */ granted?: string[] }; result: { protocol: number } };
  state: { params: { settings: Record<string, string>; secrets: Record<string, string> } & ChildFacts; result: null };
  activate: { params: { generation: number }; result: ChildContributions };
  dispose: { params: Record<string, never>; result: { failures: string[] } };
  'action.run': { params: { id: string }; result: ActionOutcome | ChildDeviceFlow };
  'flow.poll': { params: { flow: string }; result: ActionOutcome };
  status: { params: Record<string, never>; result: PluginStatus };
  doctorChecks: { params: Record<string, never>; result: DoctorCheck[] };
  /** The server checks the page before a client sees it. */
  'page.read': { params: { locale: string }; result: unknown };
  'page.run': { params: { locale: string; action: string; item?: string }; result: { message?: string } };
  'modelSource.catalog': { params: { id: string; backend: ModelSourceBackend; overrides: SourceOverrides }; result: ModelInfo[] };
  'modelSource.prepare': { params: { id: string; overrides: SourceOverrides }; result: ResolvedSource };
  'modelSource.usage': { params: { id: string; overrides: SourceOverrides }; result: NativeBackendUsage };
  'task.detect': { params: { provider: string; project: ProjectCall }; result: boolean };
  'task.actions': { params: { provider: string; project: ProjectCall }; result: TaskActionSpec[] };
  'task.plan': { params: { provider: string; action: string; taskParams: TaskParams; project: ProjectCall }; result: TaskPlan };
  /** The child cannot know the project's location, so `file` comes back as the log printed it and the server maps it into the project. */
  'task.diagnostics': { params: { provider: string; logTail: string }; result: TaskDiagnostic[] };
  /** `args` have been validated against the declaration; the child stops the handler's `signal` after `timeoutMs`, before the server gives up on the call. */
  /** Resolves with the style's SVG; the server checks it before drawing it. */
  'avatar.generate': { params: { id: string; request: AvatarStyleRequest }; result: string };
  'command.run': { params: { id: string; projectId?: string; sessionId?: string; args: Record<string, string | number | boolean>; timeoutMs: number }; result: PluginCommandResult };
};
