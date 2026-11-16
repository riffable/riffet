import type {
  AgentBackend, AgentContext, AgentControlMessage, AgentDelivery, AgentDispatchBinding, AgentEvent, AgentHost, AgentProfile, AgentReservation, AgentRunRef, AgentSessionView,
  AgentTerminalView, AgentTranscript, AgentTranscriptBatch, AgentTranscriptSource,
} from '@riffet/plugin-api/experimental/agent';
import { basename } from 'node:path';
import { sourceProtocols } from '@riffet/plugin-api/kit';
import type { NativeBackendId, NativeInteractionResult, NativeStatus, NativeWorkbenchEvent, Project, Run, Session, TerminalInfo } from '../../../../packages/contracts/src/index.js';
import { NativeInteractions } from '../agent-host/interactions.js';
import { AppError } from '../errors.js';
import type { LaneWriter, TranscriptSource } from '../journal/ingest.js';
import { backendIdOf } from '../session-identity.js';
import { launchSource, modelSourceOf, modelSourceProvider, sourceEndpoint } from './shared/model-source.js';
import { isWarmupTerminal, warmupOf, type WarmupTerminalInfo } from '../terminal/service.js';
import type {
  NativeBackendAvailability, NativeBackendDriver, NativeBackendHost, NativeBackendOpenOptions, NativeBackendProfileConfig, NativeBackendSendRequest,
  NativeControlMessage, NativeDispatchBinding, NativeDriverAdmin, NativeDriverExtensions, NativeDriverStored, NativeShareReadOptions, NativeShareTranscript,
} from './types.js';

/*
 * An `AgentBackend` from an enabled plugin, as the core's own `NativeBackendDriver`. This is the only
 * place that knows both: everything the service, the dispatcher and the journal do with a driver
 * keeps working unchanged, and the plugin sees `AgentHost`, which is `NativeBackendHost` reduced to
 * asynchronous operations named by intent over plain data (docs/design/plugin-system.md §5.1).
 *
 * The core keeps the durable side: the fence is committed through the run's own closure, the receipt
 * and the outcome reach the dispatcher as the events it already reads, and the transcript is written
 * through the journal's lane writer. The plugin never holds any of them.
 */

/** Batches one `pull` reads before it hands control back; a long first import continues on the next pull. */
const MAX_BATCHES = 64;

const sessionView = (session: Session): AgentSessionView => ({
  id: session.id, projectId: session.projectId, title: session.title, state: session.state,
  ...(session.backendProfileId !== undefined ? { backendProfileId: session.backendProfileId } : {}),
  ...(session.nativeSessionId !== undefined ? { nativeSessionId: session.nativeSessionId } : {}),
  ...(session.terminalId !== undefined ? { terminalId: session.terminalId } : {}),
  ...(session.model !== undefined ? { model: session.model } : {}),
  mode: session.mode,
  ...(session.approval !== undefined ? { approval: session.approval } : {}),
  ...(session.configRevision !== undefined ? { configRevision: session.configRevision } : {}),
  ...(session.configPending !== undefined ? { configPending: session.configPending } : {}),
  ...(session.archivedAt !== undefined ? { archivedAt: session.archivedAt } : {}),
  ...(session.error !== undefined ? { error: session.error } : {}),
  ...(session.terminalAppearance !== undefined ? { terminalAppearance: session.terminalAppearance } : {}),
  ...(session.resumePicker !== undefined ? { resumePicker: session.resumePicker } : {}),
  ...(session.titleSource !== undefined ? { titleSource: session.titleSource } : {}),
  ...(session.lastActivityAt !== undefined ? { lastActivityAt: session.lastActivityAt } : {}),
  ...(session.toolGroups !== undefined ? { toolGroups: session.toolGroups } : {}),
  ...(session.extensionsOff !== undefined ? { extensionsOff: session.extensionsOff } : {}),
  ...(session.terminalHold !== undefined ? { terminalHold: session.terminalHold } : {}),
});

/** A terminal record without the host's private reservation bookkeeping. */
const terminalView = (info: TerminalInfo): AgentTerminalView => {
  if (!('warmup' in info)) return info;
  const { warmup: _reservation, ...rest } = info as WarmupTerminalInfo;
  return rest;
};

/** What a session patch may carry, and what only a backend that keeps the session's run state may. */
const PATCH_FIELDS = ['model', 'mode', 'approval', 'configPending', 'terminalId', 'title', 'titleSource', 'nativeSessionId'] as const;
const OBSERVED_FIELDS = ['state', 'error'] as const;

const profileView = (profile: NativeBackendProfileConfig): AgentProfile => ({
  id: profile.id, name: profile.name,
  ...(profile.description !== undefined ? { description: profile.description } : {}),
  ...(profile.isDefault !== undefined ? { isDefault: profile.isDefault } : {}),
  config: profile.config,
});

const projectView = (project: Project) => ({ id: project.id, name: project.name, cwd: project.cwd, ...(project.archivedAt !== undefined ? { archivedAt: project.archivedAt } : {}) });

const runRef = (run: Run): AgentRunRef => ({
  id: run.id, sessionId: run.sessionId, commandId: run.commandId, state: run.state,
  ...(run.native?.delivery ? { delivery: run.native.delivery } : {}), ...(run.native?.intent ? { intent: run.native.intent } : {}),
  ...(run.native?.nativeSessionId ? { nativeSessionId: run.native.nativeSessionId } : {}),
  ...(run.native?.nativeTurnId ? { nativeTurnId: run.native.nativeTurnId } : {}),
  ...(run.native?.nativeMessageId ? { nativeMessageId: run.native.nativeMessageId } : {}),
  ...(run.error !== undefined ? { error: run.error } : {}),
  ...(run.native?.stage ? { stage: run.native.stage } : {}),
  ...(run.native?.renderedText !== undefined ? { renderedText: run.native.renderedText } : {}),
  ...(run.native?.input ? { inputText: run.native.input.text } : {}),
  ...(run.native?.ownerRunId ? { ownerRunId: run.native.ownerRunId } : {}),
  ...(run.native?.config ? { config: run.native.config } : {}),
  ...(run.native?.resolvedConfig ? { resolvedConfig: run.native.resolvedConfig } : {}),
  ...(run.native?.timings?.inputSentAt !== undefined ? { inputSentAt: run.native.timings.inputSentAt } : {}),
  ...(run.native?.nativeInputBoundary !== undefined ? { nativeInputBoundary: run.native.nativeInputBoundary } : {}),
});

/** What the journal stores: it numbers the event and stamps the session, so the plugin supplies neither. */
const stamped = (sessionId: string, event: AgentEvent, sequence = 0): NativeWorkbenchEvent => ({ ...event, sequence, sessionId });

/** The conversation as the journal reads it: the plugin's batches written through the lane writer. */
class PluginTranscriptSource implements TranscriptSource {
  constructor(private readonly options: {
    transcript: AgentTranscript; sessionId: string; nativeSessionId(): string | undefined; transaction<T>(fn: () => T): T;
    /** False once the plugin was turned off: a source still held by the journal's follow must not call it again. */
    active(): boolean;
  }) {}

  identity(): string | undefined { return this.options.nativeSessionId(); }

  pull(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> { return this.read(w, signal); }

  /** What is stored goes into the log that serves, after any read in flight. */
  async drain(w: LaneWriter): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) if ((await this.read(w.scratch ?? w, new AbortController().signal)).caughtUp) return;
  }

  private async read(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    const nativeSessionId = this.identity();
    if (!nativeSessionId || !this.options.active()) return { caughtUp: true };
    for (let step = 0; step < MAX_BATCHES; step += 1) {
      const batch = await this.options.transcript.read({ nativeSessionId, cursor: w.cursor }, signal);
      // A conversation switched meanwhile belongs to the next read, which starts the lane over.
      if (signal.aborted || this.identity() !== nativeSessionId) return { caughtUp: false };
      writeBatch(w, this.options.sessionId, batch, this.options.transaction);
      if (batch.caughtUp) return { caughtUp: true };
    }
    return { caughtUp: false };
  }
}

/**
 * A source the plugin wrote against the lane writer, handed to the journal as it is, except that once the
 * plugin is turned off nothing in it is called again: the journal may still hold the source in a follow.
 */
class PluginLaneSource implements TranscriptSource {
  readonly watch: TranscriptSource['watch'];
  private lastIdentity: string | undefined;

  constructor(readonly inner: AgentTranscriptSource, private readonly active: () => boolean) {
    if (inner.watch) this.watch = (w, wake) => this.active() ? inner.watch!(w, wake) : () => undefined;
  }

  identity(): string | undefined { return this.active() ? (this.lastIdentity = this.inner.identity()) : this.lastIdentity; }
  async pull(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> { return this.active() ? this.inner.pull(w, signal) : { caughtUp: true }; }
  async drain(w: LaneWriter): Promise<void> { if (this.active()) await this.inner.drain(w); }
}

/** The control message a core listener takes: a bare `session` report is completed with the record. */
const controlOf = (native: NativeBackendHost, sessionId: string, message: AgentControlMessage): NativeControlMessage =>
  message.type === 'session' ? { type: 'session', session: native.getSession(sessionId) } : message;

/** Rows, cursor and turn edges in one transaction: a restart never holds one without the others. */
function writeBatch(w: LaneWriter, sessionId: string, batch: AgentTranscriptBatch, transaction: <T>(fn: () => T) => T): void {
  const drafts = batch.drafts?.map(({ finalId, event }) => ({ finalId, event: stamped(sessionId, event) }));
  transaction(() => {
    if (batch.events.length || drafts?.length || batch.retire?.length || batch.cursor !== w.cursor) {
      w.commit({ events: batch.events.map(event => stamped(sessionId, event)), ...(drafts?.length ? { drafts } : {}), ...(batch.retire?.length ? { retire: batch.retire } : {}), cursor: batch.cursor });
    }
    for (const turn of batch.turns ?? []) {
      if (turn.edge === 'started') w.turnStarted(turn.turnId, turn.at, turn.runId);
      else w.turnEnded(turn.turnId, turn.status, turn.at, turn.error);
    }
  });
}

/**
 * The host as the plugin sees it, with every call refused once `revoked()`: a timer or listener that outlived its
 * activation can neither read nor write. A member declared `async` rejects, any other throws; what a call
 * returned (an unsubscribe, say) is not wrapped, so releasing after the fact still works.
 */
function revocable<T extends object>(target: T, revoked: () => boolean, label: string): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(target)) {
    if (typeof value === 'function') {
      const call = value as (...args: unknown[]) => unknown;
      const asynchronous = call.constructor.name === 'AsyncFunction';
      out[key] = (...args: unknown[]) => {
        if (!revoked()) return call(...args);
        const refused = new AppError('AGENT_HOST_REVOKED', `${label} was turned off; its host no longer accepts calls`, 409);
        if (asynchronous) return Promise.reject(refused);
        throw refused;
      };
    } else out[key] = value && typeof value === 'object' ? revocable(value, revoked, label) : value;
  }
  return out as T;
}

/**
 * The working-tree observer (`shared/workspace-observer.ts`), as this driver needs it: the app builds it, since the kernel
 * does not import `shared/`. Its diffs are plain records here, the plugin's own shape.
 */
export interface WorkspaceObserver {
  begin(key: string, cwd: string): Promise<void>;
  end(key: string): Promise<readonly Record<string, unknown>[] | undefined>;
  discard(key: string): void;
  record(scope: string, key: string, diffs: readonly Record<string, unknown>[]): void;
  changes(scope: string, key: string): readonly Record<string, unknown>[] | undefined;
}

/** The observer's windows are keyed process-wide, so a plugin's keys are scoped to its session. */
function workspaceChangesOf(observer: WorkspaceObserver, own: (sessionId: string) => unknown): NonNullable<AgentHost['workspaceChanges']> {
  const scoped = (sessionId: string, key: string) => `${sessionId}\0${key}`;
  return {
    begin: async (id, key, cwd) => { own(id); await observer.begin(scoped(id, key), cwd); },
    end: async (id, key) => { own(id); return observer.end(scoped(id, key)); },
    discard: (id, key) => { own(id); observer.discard(scoped(id, key)); },
    record: (id, callId, diffs) => { own(id); observer.record(id, callId, diffs); },
    changes: (id, callId) => { own(id); return observer.changes(id, callId); },
  };
}

/** A conversation the plugin has not reported on is offline, which is also what the core shows for a closed one. */
const OFFLINE: NativeStatus = { phase: 'offline' };
const UNFINISHED_DELIVERIES = new Set<string>(['queued', 'preparing', 'dispatching', 'input_sent', 'observed', 'uncertain']);
const FINISHED_STATES = new Set<string>(['completed', 'failed', 'cancelled']);

export class PluginBackendDriver implements NativeBackendDriver {
  readonly id: NativeBackendId;
  readonly label: string;
  readonly traits: NativeBackendDriver['traits'];
  readonly cliVersions: NativeBackendDriver['cliVersions'];
  readonly sendsNow: boolean | undefined;
  readonly steer: NativeBackendDriver['steer'];
  readonly requestInterrupt: NativeBackendDriver['requestInterrupt'];
  readonly normalizeModel: NativeBackendDriver['normalizeModel'];
  readonly validateNativeSessionId: NativeBackendDriver['validateNativeSessionId'];
  readonly validateProfileConfig: NativeBackendDriver['validateProfileConfig'];
  readonly describeProfile: NativeBackendDriver['describeProfile'];
  readonly slashItems: NativeBackendDriver['slashItems'];
  readonly dispose: NativeBackendDriver['dispose'];
  readonly close: NativeBackendDriver['close'];
  readonly terminal: NativeBackendDriver['terminal'];
  readonly launchEnv: NativeBackendDriver['launchEnv'];
  readonly prewarm: NativeBackendDriver['prewarm'];
  readonly releasePrewarm: NativeBackendDriver['releasePrewarm'];
  readonly usage: NativeBackendDriver['usage'];
  readonly canReleaseInput: NativeBackendDriver['canReleaseInput'];
  readonly runtimeAction: NativeBackendDriver['runtimeAction'];
  readonly stopActivity: NativeBackendDriver['stopActivity'];
  readonly extendInteraction: NativeBackendDriver['extendInteraction'];
  readonly relaunchForAppearance: NativeBackendDriver['relaunchForAppearance'];
  readonly rename: NativeBackendDriver['rename'];
  readonly invalidateModels: NativeBackendDriver['invalidateModels'];
  readonly endorsesScreenDialog: NativeBackendDriver['endorsesScreenDialog'];
  readonly projectConfigs: NativeBackendDriver['projectConfigs'];
  readonly extensions: NativeBackendDriver['extensions'];
  readonly stored: NativeBackendDriver['stored'];
  readonly admin: NativeBackendDriver['admin'];
  readonly start: NativeBackendDriver['start'];

  /** Sessions the plugin has been asked to open or observe: what `detach` has to release. */
  private readonly attached = new Set<string>();
  private readonly statuses = new Map<string, NativeStatus>();
  /** Per call of `open`, `send` and `interrupt`: the core's own closures the plugin reaches through `AgentHost`. */
  private readonly spawnGuards = new Map<string, (() => void | Promise<void>) | undefined>();
  private readonly stopGuards = new Map<string, (allowEnded?: boolean) => void>();
  private readonly fences = new Map<string, (binding?: NativeDispatchBinding) => Run>();
  /** The fence of a steer the plugin deferred to the Agent's next boundary: kept for its one commit. */
  private readonly deferredFences = new Map<string, (binding?: NativeDispatchBinding) => Run>();
  private readonly hosts = new WeakMap<NativeBackendHost, AgentHost>();
  /** Terminal dialogs the plugin reads and answers (`host.dialogs`); one per backend, so its idempotency records are its own. */
  private interactions?: NativeInteractions;
  /** The attachments of the inputs being delivered now, by run: all an agent can name to `readAttachment`. */
  private readonly deliveringAttachments = new Map<string, readonly string[]>();
  /** Set when the plugin is turned off; this driver is then never registered again (a new activation builds a new one). */
  private retired = false;
  /** Set once the plugin's activation has been released: its host then refuses every call. */
  private revoked = false;
  private readonly observationSubscriptions = new Set<() => void>();

  constructor(private readonly backend: AgentBackend, readonly owner: string, private readonly observer?: WorkspaceObserver) {
    this.id = backend.id;
    this.label = backend.label;
    this.traits = backend.traits;
    this.cliVersions = backend.cliVersions;
    this.sendsNow = backend.sendsNow;
    // An optional member that is absent must stay absent: the service decides what to offer by its presence.
    if (backend.steer) {
      this.steer = async (host, request) => {
        const delivery = await this.delivered(host, request, () => backend.steer!(this.hostFor(host), { ...this.sendRequest(request), target: request.target }));
        return delivery && 'deferred' in delivery ? { deferred: true } : undefined;
      };
    }
    if (backend.requestInterrupt) this.requestInterrupt = (host, session) => backend.requestInterrupt!(this.hostFor(host), session.id);
    if (backend.normalizeModel) this.normalizeModel = (model, profile) => backend.normalizeModel!(model, profileView(profile));
    if (backend.validateNativeSessionId) this.validateNativeSessionId = id => backend.validateNativeSessionId!(id);
    if (backend.validateProfileConfig) this.validateProfileConfig = config => backend.validateProfileConfig!(config);
    if (backend.describeProfile) this.describeProfile = profile => backend.describeProfile!(profileView(profile));
    if (backend.slashItems) this.slashItems = (host, project, profile) => backend.slashItems!(this.hostFor(host), project && projectView(project), profileView(profile));
    if (backend.stop) {
      this.dispose = async (host, sessionId) => {
        this.forget(sessionId);
        await backend.stop!(this.hostFor(host), sessionId);
      };
    }
    if (backend.close) this.close = host => backend.close!(this.hostFor(host));
    if (backend.start) this.start = async (host, profile) => { await backend.start!(this.hostFor(host), profileView(profile)); };
    this.terminal = backend.terminal;
    this.launchEnv = backend.launchEnv;
    // Optional members map one to one: the context is built from the host's records at the call, and an absent member stays absent.
    if (backend.prewarm) this.prewarm = (host, project, profile, request) => backend.prewarm!(this.hostFor(host), projectView(project), profileView(profile), request);
    if (backend.releasePrewarm) this.releasePrewarm = (host, claimId) => backend.releasePrewarm!(this.hostFor(host), claimId);
    if (backend.usage) this.usage = (host, project, profile, session) => backend.usage!(this.hostFor(host), this.query(project, profile, session));
    if (backend.canReleaseInput) this.canReleaseInput = (host, session, profile, run) => backend.canReleaseInput!(this.hostFor(host), this.context(host, session, profile), runRef(run));
    if (backend.runtimeAction) this.runtimeAction = (host, session, profile, request) => backend.runtimeAction!(this.hostFor(host), this.context(host, session, profile), request);
    if (backend.stopActivity) this.stopActivity = (host, session, profile, activityId) => backend.stopActivity!(this.hostFor(host), this.context(host, session, profile), activityId);
    if (backend.extendInteraction) this.extendInteraction = (host, session, profile, interactionId) => backend.extendInteraction!(this.hostFor(host), this.context(host, session, profile), interactionId);
    if (backend.relaunchForAppearance) this.relaunchForAppearance = (host, session, profile) => backend.relaunchForAppearance!(this.hostFor(host), this.context(host, session, profile));
    if (backend.rename) this.rename = (host, session, profile) => backend.rename!(this.hostFor(host), this.context(host, session, profile));
    if (backend.invalidateModels) this.invalidateModels = () => backend.invalidateModels!();
    if (backend.endorsesScreenDialog) {
      this.endorsesScreenDialog = (host, session, dialog) => {
        const profile = host.getProfile?.(session);
        return profile ? backend.endorsesScreenDialog!(this.hostFor(host), this.context(host, session, profile), dialog) : true;
      };
    }
    const extensions: NativeDriverExtensions = {};
    if (backend.extensionLayout) extensions.layout = profile => backend.extensionLayout!(profileView(profile));
    if (backend.extensionRuntime) extensions.runtime = (host, project, profile) => backend.extensionRuntime!(this.hostFor(host), project && projectView(project), profileView(profile));
    if (backend.skillStates) extensions.skillStates = (host, project, profile) => backend.skillStates!(this.hostFor(host), project && projectView(project), profileView(profile));
    if (backend.setSkillEnabled) extensions.setSkillEnabled = (host, project, profile, path, enabled) => backend.setSkillEnabled!(this.hostFor(host), project && projectView(project), profileView(profile), path, enabled);
    if (backend.reloadExtensions) extensions.reload = (host, project, profile) => backend.reloadExtensions!(this.hostFor(host), project && projectView(project), profileView(profile));
    if (backend.authorizeMcp) extensions.authorizeMcp = (host, project, profile, name) => backend.authorizeMcp!(this.hostFor(host), project && projectView(project), profileView(profile), name);
    if (backend.extensionManagementCapabilities) extensions.managementCapabilities = (host, profile) => backend.extensionManagementCapabilities!(this.hostFor(host), profileView(profile));
    if (backend.manageExtension) extensions.manage = (host, profile, input, item) => backend.manageExtension!(this.hostFor(host), profileView(profile), input, item);
    if (Object.keys(extensions).length) this.extensions = extensions;
    const stored: NativeDriverStored = {};
    if (backend.readOnlyHistory !== undefined) (stored as { readOnly?: boolean }).readOnly = backend.readOnlyHistory;
    if (backend.usageTranscript) stored.usage = (host, session, profile, known) => backend.usageTranscript!(this.hostFor(host), this.context(host, session, profile), known);
    if (backend.readHistory) {
      stored.share = async (host, session, profile, options) => {
        const history = await backend.readHistory!(this.hostFor(host), this.context(host, session, profile), options as NativeShareReadOptions | undefined);
        return {
          ...history,
          events: history.events.map((event, index) => stamped(session.id, event, index + 1)),
          subagents: history.subagents.map(child => ({ ...child, events: child.events.map((event, index) => stamped(session.id, event, index + 1)) })),
        } satisfies NativeShareTranscript;
      };
    }
    if (Object.keys(stored).length) this.stored = stored;
    const admin: NativeDriverAdmin = {};
    if (backend.loginLaunch) admin.loginLaunch = (host, project, profile) => backend.loginLaunch!(this.hostFor(host), projectView(project), profileView(profile));
    if (backend.capabilityReport) admin.capabilityReport = (host, profile) => backend.capabilityReport!(this.hostFor(host), profileView(profile));
    if (backend.runCommand) admin.runCommand = (host, profile, request) => backend.runCommand!(this.hostFor(host), profileView(profile), request);
    if (backend.runtimeStats) admin.runtimeStats = host => backend.runtimeStats!(this.hostFor(host));
    if (Object.keys(admin).length) this.admin = admin;
    if (backend.projectConfigs) {
      const configs = backend.projectConfigs;
      this.projectConfigs = {
        list: (host, project, profile) => configs.list(this.hostFor(host), projectView(project), profileView(profile)),
        read: (host, project, profile, id) => configs.read(this.hostFor(host), projectView(project), profileView(profile), id),
        write: (host, project, profile, id, content, expectedHash) => configs.write(this.hostFor(host), projectView(project), profileView(profile), id, content, expectedHash),
        create: (host, project, profile, input) => configs.create(this.hostFor(host), projectView(project), profileView(profile), input),
      };
    }
  }

  profiles(host: NativeBackendHost): NativeBackendProfileConfig[] {
    return this.backend.profiles(this.hostFor(host)).map(profile => ({ ...profile, backendId: this.id }));
  }

  async capabilities(host: NativeBackendHost, profile: NativeBackendProfileConfig) {
    return { ...await this.backend.capabilities(this.hostFor(host), profileView(profile)), backendId: this.id, label: this.label };
  }

  available(host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
    return this.backend.available(this.hostFor(host), profileView(profile));
  }

  transcript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): TranscriptSource {
    const { backend } = this;
    // A source the plugin wrote itself goes to the journal as it is; the batch reader below is for the simple case.
    if (backend.transcriptSource) return new PluginLaneSource(backend.transcriptSource(this.hostFor(host), this.context(host, session, profile)), () => !this.retired);
    const transcript = backend.transcript?.(this.hostFor(host), this.context(host, session, profile))
      // A plugin that reports only through events leaves the journal untouched.
      ?? { read: async ({ cursor }): Promise<AgentTranscriptBatch> => ({ events: [], cursor, caughtUp: true }) };
    return new PluginTranscriptSource({
      transcript, sessionId: session.id, active: () => !this.retired,
      nativeSessionId: () => { try { return host.getSession(session.id).nativeSessionId; } catch { return undefined; } },
      transaction: fn => host.journal ? host.journal.tx(fn) : fn(),
    });
  }

  async openOrResume(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig, options: NativeBackendOpenOptions = {}) {
    this.attached.add(session.id);
    this.spawnGuards.set(session.id, options.beforeSpawn);
    try {
      const opened = await this.backend.open(this.hostFor(host), { session: sessionView(session), project: projectView(project), profile: profileView(profile) }, {
        ...(options.restartFingerprint ? { restartFingerprint: options.restartFingerprint } : {}),
        ...(options.restartAddress ? { restartAddress: options.restartAddress } : {}),
        ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
      });
      if (opened.status) this.statuses.set(session.id, opened.status);
      return opened;
    } finally { this.spawnGuards.delete(session.id); }
  }

  async send(host: NativeBackendHost, request: NativeBackendSendRequest): Promise<void> {
    await this.delivered(host, request, () => this.backend.send(this.hostFor(host), { ...this.sendRequest(request), ...(request.now ? { now: true } : {}) }));
  }

  async interrupt(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options?: Parameters<NativeBackendDriver['interrupt']>[3]): Promise<void> {
    if (!this.backend.interrupt) throw new AppError('NATIVE_STOP_UNSUPPORTED', `${this.label} cannot stop a running turn from here`, 409);
    if (options?.beforeWrite) this.stopGuards.set(session.id, options.beforeWrite);
    try {
      await this.backend.interrupt(this.hostFor(host), this.context(host, session, profile), {
        ...(options?.clearPrompt !== undefined ? { clearPrompt: options.clearPrompt } : {}),
        ...(options?.expectedStop ? { expectedStop: options.expectedStop } : {}),
      });
    } finally { this.stopGuards.delete(session.id); }
  }

  respond(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, response: Parameters<NativeBackendDriver['respond']>[3]): Promise<NativeInteractionResult> {
    if (!this.backend.respond) throw new AppError('NATIVE_INTERACTION_UNSUPPORTED', `${this.label} does not take interaction answers from here`, 409);
    return this.backend.respond(this.hostFor(host), this.context(host, session, profile), response);
  }

  async interaction(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig) {
    return await this.backend.interaction?.(this.hostFor(host), this.context(host, session, profile));
  }

  async configure(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, patch: Parameters<NativeBackendDriver['configure']>[3]) {
    // Without a method of its own the change is only recorded; the next open reads it from the session.
    return this.backend.configure ? await this.backend.configure(this.hostFor(host), this.context(host, session, profile), patch) : { ...patch };
  }

  async listModels(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session) {
    return await this.backend.listModels?.(this.hostFor(host), {
      ...(project ? { project: projectView(project) } : {}), profile: profileView(profile), ...(session ? { session: sessionView(session) } : {}),
    }) ?? [];
  }

  status(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): NativeStatus {
    return this.backend.status?.(this.hostFor(host), this.context(host, session, profile)) ?? this.statuses.get(session.id) ?? OFFLINE;
  }

  subscribe(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    this.attached.add(session.id);
    const observe = this.backend.observe;
    if (!observe) return () => undefined;
    let stop: (() => void) | undefined;
    let released = false;
    // `host.emit` reaches everyone following the session; `report` is this subscriber's alone.
    const report = (message: AgentControlMessage) => {
      if (released) return;
      if (message.type === 'status') this.statuses.set(session.id, message.status);
      listener(controlOf(host, session.id, message));
    };
    void Promise.resolve()
      .then(() => observe.call(this.backend, this.hostFor(host), this.context(host, session, profile), report))
      .then(release => { if (released) release(); else stop = release; })
      .catch((error: unknown) => console.warn(`[riffet] ${this.owner}: observing ${session.id} failed: ${error instanceof Error ? error.message : String(error)}`));
    return () => { released = true; const release = stop; stop = undefined; release?.(); };
  }

  /**
   * The plugin is turned off: observation of every session it holds is released. Nothing here ends a native
   * process, which may outlive this server; that is `dispose`, for a session closed on purpose.
   */
  async detachAll(host: NativeBackendHost): Promise<void> {
    this.retired = true;
    const agent = this.hostFor(host);
    const sessions = [...this.attached];
    this.attached.clear();
    for (const sessionId of sessions) {
      try { await this.backend.detach?.(agent, sessionId); }
      catch (error) { console.warn(`[riffet] ${this.owner}: detaching ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.statuses.clear();
  }

  /** The plugin's activation has been released: nothing it left behind (a timer, a listener) can reach the core through the host any more. */
  revoke(): void {
    this.retired = true;
    this.revoked = true;
    for (const unsubscribe of this.observationSubscriptions) unsubscribe();
    this.observationSubscriptions.clear();
  }

  private forget(sessionId: string): void {
    this.attached.delete(sessionId);
    this.statuses.delete(sessionId);
  }

  private context(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): AgentContext {
    return { session: sessionView(session), project: projectView(host.getProject(session.projectId)), profile: profileView(profile) };
  }

  private query(project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session) {
    return { ...(project ? { project: projectView(project) } : {}), profile: profileView(profile), ...(session ? { session: sessionView(session) } : {}) };
  }

  private sendRequest(request: NativeBackendSendRequest) {
    return {
      context: { session: sessionView(request.session), project: projectView(request.project), profile: profileView(request.profile) },
      commandId: request.commandId, runId: request.runId, input: request.input, ...(request.sourceText !== undefined ? { sourceText: request.sourceText } : {}), config: request.config,
    };
  }

  /**
   * Runs a delivery with the run's fence available to the plugin, then turns what it proved into the
   * events the dispatcher reads: `submitted` is the return of this call, `accepted` is a receipt
   * carrying the command id, `completed` is also the turn's outcome.
   */
  private async delivered(host: NativeBackendHost, request: NativeBackendSendRequest, run: () => Promise<AgentDelivery | { deferred: true } | void>): Promise<AgentDelivery | { deferred: true } | void> {
    this.attached.add(request.session.id);
    this.fences.set(request.runId, request.commitDispatchFence);
    this.deliveringAttachments.set(request.runId, request.input.attachmentIds);
    let delivery: AgentDelivery | { deferred: true } | void;
    try { delivery = await run(); }
    finally { this.fences.delete(request.runId); this.deliveringAttachments.delete(request.runId); }
    if (delivery && 'deferred' in delivery) {
      this.deferredFences.set(request.runId, request.commitDispatchFence);
      while (this.deferredFences.size > 256) this.deferredFences.delete(this.deferredFences.keys().next().value!);
    }
    if (!delivery || 'deferred' in delivery || delivery.state === 'submitted') return delivery;
    const base = { sequence: 0, sessionId: request.session.id, runId: request.runId, createdAt: new Date().toISOString(), ...(delivery.nativeTurnId ? { nativeTurnId: delivery.nativeTurnId } : {}) };
    host.emitEvent(request.session.id, {
      ...base, type: 'native_input_receipt', nativeId: delivery.nativeMessageId ?? `receipt:${request.commandId}`,
      data: { commandId: request.commandId, content: { type: 'text', text: request.input.text } },
    });
    if (delivery.state === 'completed') {
      const type = delivery.status === 'completed' ? 'run_completed' : delivery.status === 'failed' ? 'run_failed' : 'run_cancelled';
      host.emitEvent(request.session.id, {
        ...base, type, nativeId: `outcome:${request.commandId}`,
        data: { sessionUpdate: type, commandId: request.commandId, ...(delivery.status === 'completed' ? { reason: 'completed' } : delivery.status === 'failed' ? { error: delivery.error ?? 'The agent ended this turn without completing it.' } : { reason: delivery.error ?? 'The agent stopped this turn.' }) },
      });
    }
    return delivery;
  }

  private hostFor(native: NativeBackendHost): AgentHost {
    let agent = this.hosts.get(native);
    if (!agent) this.hosts.set(native, agent = revocable(this.createHost(native), () => this.revoked, this.label));
    return agent;
  }

  private createHost(native: NativeBackendHost): AgentHost {
    const own = (sessionId: string): Session => {
      const session = native.getSession(sessionId);
      if (backendIdOf(session) !== this.id) throw new AppError('AGENT_SESSION_FOREIGN', `Session ${sessionId} does not belong to ${this.label}`, 403);
      return session;
    };
    const foreign = (what: string) => new AppError('AGENT_SESSION_FOREIGN', `This ${what} does not belong to this agent`, 403);
    /** A terminal of one of this agent's sessions, or one of its reservations; read from the stored record, so it can be asked synchronously. */
    const ownTerminal = (terminalId: string): TerminalInfo => {
      const info = native.findTerminal?.(terminalId);
      if (!info) throw new AppError('TERMINAL_NOT_FOUND', 'Terminal does not exist', 404);
      if (isWarmupTerminal(info)) {
        if (warmupOf(info).backendId !== this.id) throw foreign('terminal');
      } else {
        if (!info.sessionId) throw foreign('terminal');
        own(info.sessionId);
      }
      return info;
    };
    /** Another agent's reservation is refused; a terminal that is not a reservation (any more) is left to the terminal service, which says the reservation is stale. */
    const ownReservation = (terminalId: string): void => {
      const info = native.findTerminal?.(terminalId);
      if (info && isWarmupTerminal(info) && warmupOf(info).backendId !== this.id) throw foreign('reservation');
    };
    const reservation = (info: WarmupTerminalInfo): AgentReservation => {
      const warmup = warmupOf(info);
      return { terminal: handle(info), ownerToken: warmup.ownerToken, resourceKey: warmup.resourceKey, nativeSessionId: warmup.nativeSessionId, expiresAt: warmup.expiresAt };
    };
    const handle = (info: { id: string; epoch: number; state: 'running' | 'exited' | 'detached' }) => ({ id: info.id, epoch: info.epoch, state: info.state });
    const view = (id: string) => sessionView(own(id));
    /** The session a run belongs to; undefined for a run that is not stored (pruned, or never made). */
    const runSession = (runId: string): string | undefined => { try { return native.getRun?.(runId).sessionId; } catch { return undefined; } };
    /** The sessions of this agent, for the synchronous reads. A foreign or missing one is simply not there. */
    const ownSession = (id: string): Session | undefined => { try { const session = native.getSession(id); return backendIdOf(session) === this.id ? session : undefined; } catch { return undefined; } };
    const ownSessions = (): Session[] => (native.listSessions?.() ?? []).filter(session => backendIdOf(session) === this.id);
    const interactions = this.interactions ??= new NativeInteractions(native.terminal, this.backend.settledScreen ? { settledScreen: screen => this.backend.settledScreen!(screen) } : {});
    const lock = <T>(sessionId: string, operation: () => Promise<T> | T, options?: { detached?: boolean }): Promise<T> => {
      own(sessionId);
      return options?.detached && native.withDetachedSessionLock ? native.withDetachedSessionLock(sessionId, operation) : native.withSessionLock(sessionId, operation);
    };
    return {
      error: (code, message, statusCode) => new AppError(code, message, statusCode),
      session: async id => view(id),
      project: async id => projectView(native.getProject(id)),
      profile: async id => {
        const session = own(id);
        const profile = native.getProfile?.(session);
        if (!profile) throw new AppError('NATIVE_PROFILE_UNAVAILABLE', 'No profile is configured', 503);
        return profileView(profile);
      },
      firstUserMessage: async id => { own(id); return native.firstUserMessage?.(id); },
      setNativeSessionId: async (id, nativeSessionId) => { own(id); return sessionView(native.setNativeSessionId(id, nativeSessionId)); },
      // The write is made before the promise is returned, which is what `host.view` promises: a read after the call sees it.
      updateSession: async (id, patch, options) => {
        own(id);
        const allowed: Record<string, unknown> = {};
        for (const key of PATCH_FIELDS) if (key in patch) allowed[key] = patch[key];
        for (const key of OBSERVED_FIELDS) {
          if (!(key in patch)) continue;
          // For any other backend the core derives the run state from its own evidence, and a plugin's word would race it.
          if (!this.backend.traits?.ownsSessionObservation) throw new AppError('AGENT_PATCH_REFUSED', `${this.label} does not keep the session ${key} itself`, 403);
          allowed[key] = patch[key];
        }
        const before = own(id);
        const updated = options?.bump ? native.bumpConfig(id, allowed) : native.updateSession(id, allowed);
        // As `setNativeSessionId` does: readers following the conversation look at the record again.
        if (updated.nativeSessionId !== before.nativeSessionId) native.emit(id, { type: 'session', session: updated });
        return sessionView(updated);
      },
      recordActivity: async (id, at) => {
        own(id);
        const updated = native.recordActivity?.(id, at);
        return updated && sessionView(updated);
      },
      view: {
        session: id => { const session = ownSession(id); return session && sessionView(session); },
        sessions: () => ownSessions().map(sessionView),
        project: id => { try { return projectView(native.getProject(id)); } catch { return undefined; } },
        terminal: id => { try { return terminalView(ownTerminal(id)); } catch { return undefined; } },
        terminals: () => {
          const mine = new Set(ownSessions().map(session => session.id));
          return (native.listTerminals?.() ?? []).filter(info => !isWarmupTerminal(info) && info.sessionId !== undefined && mine.has(info.sessionId)).map(terminalView);
        },
        firstUserMessage: id => ownSession(id) ? native.firstUserMessage?.(id) : undefined,
        runsOfTurn: (id, nativeSessionId, nativeTurnId) => ownSession(id) ? (native.findRunsByNativeTurn?.(id, nativeSessionId, nativeTurnId) ?? []).map(runRef) : [],
      },
      dialogs: {
        observe: (screen, terminal) => { ownTerminal(terminal.id); return interactions.observe(screen, terminal)?.interaction; },
        current: async id => interactions.current(own(id)),
        respond: async (id, response, guard) => interactions.respond(own(id), response, guard),
        replay: (id, response) => interactions.replay(own(id), response),
        isResponding: terminalId => interactions.isResponding(terminalId),
        owns: interactionId => interactions.ownsInteraction(interactionId),
      },
      emit: (id, message: AgentControlMessage) => {
        own(id);
        if (message.type === 'status') this.statuses.set(id, message.status);
        native.emit(id, controlOf(native, id, message));
      },
      emitEvent: (id, event) => { own(id); native.emitEvent(id, stamped(id, event)); },
      transcript: {
        wake: id => { own(id); native.transcript?.wake(id); },
        drain: async id => { own(id); await native.transcript?.drain(id); },
        endTurn: async (id, turnId, status, at, error) => { own(id); await native.transcript?.endTurn(id, turnId, status, at, error); },
        ingest: async (id, batch) => {
          own(id);
          const transaction = <T>(fn: () => T): T => native.journal ? native.journal.tx(fn) : fn();
          // Between the conversation's reads, into the log that serves: the way in for a plugin that is told of events rather than asked for them.
          await native.transcript?.withSource(id, (_source, w) => writeBatch(w.scratch ?? w, id, batch, transaction));
        },
        withSource: async (id, task) => {
          own(id);
          // The plugin's own source, not the wrapper that keeps it from being called after it was turned off.
          return native.transcript?.withSource(id, (source, w) => task(source instanceof PluginLaneSource ? source.inner : source, w));
        },
      },
      commitDispatchFence: async (runId, binding?: AgentDispatchBinding) => {
        const fence = this.fences.get(runId) ?? this.deferredFences.get(runId);
        if (!fence) throw new AppError('AGENT_RUN_UNKNOWN', 'No input of this agent is being delivered for this run', 409);
        this.deferredFences.delete(runId);
        fence({
          backendId: this.id,
          ...(binding?.nativeSessionId ? { nativeSessionId: binding.nativeSessionId } : {}),
          ...(binding?.nativeTurnId ? { nativeTurnId: binding.nativeTurnId } : {}),
          ...(binding?.ownerRunId ? { ownerRunId: binding.ownerRunId } : {}),
          ...(binding?.terminal ? { terminalId: binding.terminal.id, ...(binding.terminal.epoch !== undefined ? { terminalEpoch: binding.terminal.epoch } : {}) } : {}),
          // The core replaces it with the journal's own baseline; an absent one would leave the receipt window unrecorded.
          baselineSequence: 0,
          ...(binding?.renderedText !== undefined ? { renderedText: binding.renderedText } : {}),
          ...(binding?.nativeInputBoundary !== undefined ? { nativeInputBoundary: binding.nativeInputBoundary } : {}),
          ...(binding?.slashCommand !== undefined ? { slashCommand: binding.slashCommand } : {}),
          ...(binding?.resolvedConfig ? { resolvedConfig: binding.resolvedConfig } : {}),
        });
      },
      beforeSpawn: async id => { own(id); await this.spawnGuards.get(id)?.(); },
      checkStopTarget: async (id, allowEnded) => { own(id); this.stopGuards.get(id)?.(allowEnded); },
      isRunCancelled: async runId => {
        const sessionId = runSession(runId);
        // As the core reads it: a run that is not stored counts as cancelled. Another agent's run is not answered.
        if (sessionId === undefined) return true;
        own(sessionId);
        return native.isRunCancelled(runId);
      },
      runs: {
        find: async (id, query) => {
          own(id);
          const runs = native.listRuns?.(id) ?? [];
          if ('commandId' in query) return runs.filter(run => run.commandId === query.commandId).map(runRef);
          if ('nativeMessageId' in query) return runs.filter(run => run.native?.nativeMessageId === query.nativeMessageId).map(runRef);
          // The store's own rule (`listUnfinishedNativeRuns`): a run parked `uncertain` after a restart is not finished either.
          if ('unfinished' in query) return runs.filter(run => run.native && UNFINISHED_DELIVERIES.has(run.native.delivery) && !FINISHED_STATES.has(run.state)).map(runRef);
          return (native.findRunsByNativeTurn?.(id, query.nativeSessionId, query.nativeTurnId) ?? []).map(runRef);
        },
      },
      modelSources: {
        resolve: async (profileId, protocol) => {
          // Only this Agent's own profiles: another's config carries its own keys.
          // A session can outlive its provider (deleting one keeps its sessions), so a profile that no longer
          // resolves is skipped rather than failing every launch of this Agent.
          const resolveOwn = (session: Session) => { try { return native.getProfile?.(session); } catch { return undefined; } };
          const profile = ownSessions().filter(session => session.backendProfileId === profileId).map(resolveOwn).find(item => item?.id === profileId)
            ?? this.backend.profiles(this.hostFor(native)).find(item => item.id === profileId);
          if (!profile) throw new AppError('AGENT_PROFILE_FOREIGN', `Profile ${profileId} does not belong to ${this.label}`, 403);
          const source = modelSourceOf(profile.config);
          const provider = source ? modelSourceProvider(source) : undefined;
          if (!provider || !sourceProtocols(provider).includes(protocol)) return undefined;
          const { resolved } = launchSource(profile.config);
          const endpoint = resolved?.reason ? undefined : sourceEndpoint(resolved, protocol);
          if (!endpoint) return undefined;
          // A `command` credential runs outside Riffet (the drivers' helper scripts): it is not data to hand over.
          const credential = resolved?.credential?.kind === 'static' ? { kind: 'static' as const, key: resolved.credential.key } : undefined;
          return { baseUrl: endpoint.baseUrl, ...(endpoint.headers ? { headers: { ...endpoint.headers } } : {}), ...(credential ? { credential } : {}) };
        },
      },
      terminals: {
        launch: async (id, spec) => {
          const session = own(id);
          return handle(await native.launchPty(session, native.getProject(session.projectId), { ...spec, args: [...spec.args] }));
        },
        get: async terminalId => { ownTerminal(terminalId); return handle(await native.terminal.get(terminalId)); },
        screen: async (terminalId, options) => { ownTerminal(terminalId); return native.terminal.screen(terminalId, options); },
        paste: async (terminalId, text, submit) => { ownTerminal(terminalId); await native.terminal.paste(terminalId, text, submit); },
        sendKeys: async (terminalId, keys) => { ownTerminal(terminalId); await native.terminal.sendKeys(terminalId, keys); },
        stop: async terminalId => { ownTerminal(terminalId); await native.terminal.stop(terminalId); },
        interact: async (terminalId, task, options) => { ownTerminal(terminalId); return native.terminal.withInteraction(terminalId, task, options); },
        observe: (terminalId, callback) => {
          ownTerminal(terminalId);
          return native.terminal.observe(terminalId, observation => callback(observation.type === 'state' ? { ...observation, terminal: terminalView(observation.terminal) } : observation));
        },
        panePid: async terminalId => { ownTerminal(terminalId); return native.terminal.panePid(terminalId); },
        inspect: async (terminalId, expected) => {
          const terminal = ownTerminal(terminalId);
          if (!terminal.sessionId || !/^[a-f0-9]{64}$/.test(expected.launchMarker)) return undefined;
          const matches = await native.terminal.inspectPane?.(terminalId, terminal.sessionId, {
            deadline: Date.now() + 3000,
            select: (argv, marker) => marker === expected.launchMarker
              // A launcher script that `exec`s the real binary leaves that binary's path in argv[0].
              && basename(argv[0] ?? '') === basename(expected.command)
              && argv.length === expected.args.length + 1
              && expected.args.every((arg, index) => argv[index + 1] === arg),
          });
          return matches?.map(item => item.pid);
        },
        reserve: async request => {
          const project = native.getProject(request.projectId);
          const { spec } = request;
          if (spec.cwd !== project.cwd) throw new AppError('NATIVE_LAUNCH_CWD_INVALID', 'Native terminal cwd must match its project workspace', 400);
          return reservation(await native.terminal.createWarmup(project, {
            kind: spec.kind ?? 'native', ...(spec.title ? { title: spec.title } : {}), ...(request.appearance ? { appearance: request.appearance } : {}),
            launchSpec: { command: spec.command, args: [...spec.args], ...(spec.env ? { env: spec.env } : {}), ...(spec.secretEnv ? { secretEnv: spec.secretEnv } : {}), cwd: spec.cwd, ...(spec.launchMarker ? { launchMarker: spec.launchMarker } : {}) },
            warmup: { ownerToken: request.ownerToken, resourceKey: request.resourceKey, nativeSessionId: request.nativeSessionId, expiresAt: request.expiresAt, backendId: this.id },
          }));
        },
        claim: async (terminalId, claim) => {
          ownReservation(terminalId);
          own(claim.sessionId);
          return handle(await native.terminal.claimWarmup(terminalId, claim));
        },
        extendReservation: async (terminalId, extension) => { ownReservation(terminalId); return reservation(await native.terminal.extendWarmup(terminalId, extension)); },
        reservations: async ownerToken => (await native.terminal.listWarmups(ownerToken)).filter(info => warmupOf(info).backendId === this.id).map(reservation),
        releaseReservation: async (terminalId, ownerToken) => { ownReservation(terminalId); return native.terminal.stopWarmup(terminalId, ownerToken); },
      },
      withSessionLock: lock,
      stats: {
        recordUsage: (id, runId, usage) => {
          own(id);
          const owner = runId === undefined ? undefined : runSession(runId);
          if (owner !== undefined && owner !== id) throw foreign('run');
          native.stats.recordUsage(id, runId, usage);
        },
        recordObservation: (id, runId, observation) => {
          own(id);
          const owner = runId === undefined ? undefined : runSession(runId);
          if (owner !== undefined && owner !== id) throw foreign('run');
          return native.stats.recordObservation?.(id, runId, observation) ?? false;
        },
        readObservations: async () => {
          const observations = await native.stats.readObservations?.(this.id) ?? [];
          // The await may race plugin disablement; never deliver data to a revoked host.
          if (this.revoked) throw new AppError('AGENT_HOST_REVOKED', 'Agent is disabled', 409);
          return observations.filter(observation => {
            if (observation.backendId !== this.id) return false;
            try { own(observation.sessionId); return true; } catch { return false; }
          });
        },
        subscribeObservations: listener => {
          const unsubscribe = native.stats.subscribeObservations?.(observation => {
            if (this.revoked || observation.backendId !== this.id) return;
            try { own(observation.sessionId); } catch { return; }
            listener(observation);
          }, this.id) ?? (() => {});
          const dispose = () => { if (this.observationSubscriptions.delete(dispose)) unsubscribe(); };
          this.observationSubscriptions.add(dispose);
          return dispose;
        },
        saveRunMetrics: (runId, metrics) => {
          // A run that is not stored is dropped, as the core does for a turn that was pruned meanwhile.
          const sessionId = runSession(runId);
          if (sessionId === undefined) return;
          own(sessionId);
          native.saveRunMetrics(runId, metrics);
        },
        observeEvents: (id, events) => { own(id); native.stats.observeEvents(id, events); },
      },
      ...(this.observer ? { workspaceChanges: workspaceChangesOf(this.observer, own) } : {}),
      // An attachment belongs to a run's input: the ones of the inputs this agent is delivering are all it can name.
      readAttachment: async id => {
        if (![...this.deliveringAttachments.values()].some(ids => ids.includes(id))) throw foreign('attachment');
        return native.readAttachment(id);
      },
      interactionReceipts: {
        get: async (id, requestId) => { own(id); return native.getInteractionReceipt(id, requestId); },
        save: async (id, requestId, receipt) => { own(id); return native.saveInteractionReceipt(id, requestId, receipt); },
      },
      riffetMcp: async id => { own(id); return native.riffetMcp?.server(id); },
      bindRiffetMcp: (id, validate) => { own(id); return native.riffetMcp?.bind?.(id, metadata => { if (this.revoked) throw new AppError('AGENT_HOST_REVOKED', 'Agent is disabled', 409); own(id); return validate(metadata); }) ?? (() => {}); },
    };
  }
}
