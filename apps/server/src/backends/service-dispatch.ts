import type {
  ModelInfo, NativeActivity, NativeBackendId, NativeInteraction, NativeInteractionResponse,
  NativeInteractionResult, NativeRunConfig, NativeRunInput, NativeStopRequest, Project,
  Run, Session, TerminalInfo,
} from '../../../../packages/contracts/src/index.js';
import type { SessionLockHandle } from '../agent-host/session-lock.js';
import { AppError } from '../errors.js';
import { backendIdOf } from '../session-identity.js';
import type { Store } from '../store.js';
import { assertTaskWorkspaceAvailable } from '../task-workspaces/identity.js';
import type { TerminalService } from '../terminal/service.js';
import { BackendCatalog, curateModels, modelNormalizer, profileDefaultModel } from './catalog.js';
import type { NativeBackendRegistry } from './registry.js';
import { modelFamily } from './shared/model-selection.js';
import { prepareSource } from './shared/model-source.js';
import type { TerminalDialogObserver } from './shared/terminal-dialogs.js';
import type {
  ExternalSessionEntry, ExternalSessionScan, NativeBackendDriver, NativeBackendHost,
  NativeBackendProfileConfig, NativeDispatchBinding, NativePtyLaunchSpec,
} from './types.js';
import type { WatchHub } from './watch-hub.js';

/** A word the shell reads back unchanged: bare when it has nothing special in it, quoted otherwise. */
function shellWord(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export interface DispatchDeps {
  readonly store: Store;
  readonly terminal: TerminalService;
  readonly runtime: SessionLockHandle;
  readonly registry: NativeBackendRegistry;
  readonly catalog: BackendCatalog;
  readonly terminalDialogs: TerminalDialogObserver;
  readonly watches: WatchHub;
  readonly host: NativeBackendHost;
  readonly prepareContextInput?: (run: Run) => Promise<NativeRunInput>;
  resolve(session: Session, requestedProfileId?: string): Promise<{ driver: NativeBackendDriver; profile: NativeBackendProfileConfig }>;
  resolveSync(session: Session): { driver: NativeBackendDriver; profile: NativeBackendProfileConfig };
  bindProfile(session: Session, driver: NativeBackendDriver, profile: NativeBackendProfileConfig): void;
  unavailable(backendId: NativeBackendId): AppError | undefined;
  assertSessionReferences(session: Pick<Session, 'backendId' | 'backendProfileId'>): Promise<void>;
  dispose(sessionId: string): Promise<void>;
  journalBaseline(sessionId: string): number | undefined;
}

export function liveTerminalOf(store: Store, session: Session): TerminalInfo | undefined {
  if (!session.terminalId) return undefined;
  try {
    const terminal = store.getTerminal(session.terminalId);
    return terminal.state === 'exited' ? undefined : terminal;
  } catch { return undefined; }
}

/**
 * The provider thread may be held by a CLI outside Riffet (the user's own terminal): launching ours
 * on it too would interleave two writers in one transcript. Asked only when this conversation has no
 * live CLI of its own, which would be the holder; so any process found, even one in a Riffet terminal
 * (a shell there, an orphan), is a second writer.
 */
export async function assertNotHeldElsewhere(deps: DispatchDeps, session: Session, driver: NativeBackendDriver, profile: NativeBackendProfileConfig): Promise<void> {
  if (!session.nativeSessionId || !driver.external?.holder) return;
  if (liveTerminalOf(deps.store, session)) return;
  const holder = await driver.external.holder(deps.host, profile, session.nativeSessionId).catch(() => undefined);
  if (holder) {
    throw new AppError('NATIVE_SESSION_HELD_EXTERNALLY', 'This conversation is open in a terminal outside Riffet; exit it there first', 409, { pid: holder.pid, ...(holder.status ? { status: holder.status } : {}) });
  }
}

export function externalSessionSources(deps: DispatchDeps): Array<{ backendId: NativeBackendId; profileId: string; list(options: ExternalSessionScan): Promise<ExternalSessionEntry[]> }> {
  const sources: Array<{ backendId: NativeBackendId; profileId: string; list(options: ExternalSessionScan): Promise<ExternalSessionEntry[]> }> = [];
  for (const driver of deps.registry.list()) {
    if (!driver.external?.list) continue;
    const seen = new Set<string>();
    const profiles = deps.catalog.profiles(driver);
    for (const profile of [...profiles.filter(item => item.isDefault), ...profiles.filter(item => !item.isDefault)]) {
      const key = driver.continuationKey?.(profile) ?? profile.id;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ backendId: driver.id, profileId: profile.id, list: options => driver.external!.list!(deps.host, profile, options) });
    }
  }
  return sources;
}

export async function resumeCommand(deps: DispatchDeps, session: Session): Promise<{ nativeSessionId: string; command: string; credentialsOmitted: boolean }> {
  const { driver, profile } = await deps.resolve(session);
  if (!driver.external?.resumeCommand) throw new AppError('TERMINAL_RESUME_UNSUPPORTED', driver.label + ' cannot be continued in a terminal', 409);
  if (!session.nativeSessionId) throw new AppError('NATIVE_SESSION_NOT_STARTED', 'This conversation has not started yet', 409);
  const { argv, env, credentialsOmitted } = driver.external.resumeCommand(session, profile);
  const project = deps.store.getProject(session.projectId);
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${shellWord(value)}`);
  return {
    nativeSessionId: session.nativeSessionId,
    command: `cd ${shellWord(project.cwd)} && ${[...assignments, ...argv.map(shellWord)].join(' ')}`,
    credentialsOmitted: Boolean(credentialsOmitted),
  };
}

export async function releaseToTerminal(deps: DispatchDeps, session: Session): Promise<NativePtyLaunchSpec> {
  const { driver, profile } = await deps.resolve(session);
  if (!driver.external?.terminalLaunch) throw new AppError('TERMINAL_RESUME_UNSUPPORTED', driver.label + ' cannot be continued in a terminal', 409);
  if (!session.nativeSessionId) throw new AppError('NATIVE_SESSION_NOT_STARTED', 'Send a message first; this conversation has nothing to continue yet', 409);
  await assertNotHeldElsewhere(deps, session, driver, profile);
  const project = deps.store.getProject(session.projectId);
  const { spec, keepsRuntime } = await driver.external.terminalLaunch(deps.host, session, project, profile);
  if (!keepsRuntime) await deps.dispose(session.id);
  const current = deps.store.getSession(session.id);
  const terminal = liveTerminalOf(deps.store, current);
  if (terminal) await deps.terminal.stop(terminal.id);
  return spec;
}

/**
 * The stop the caller saw, checked again at the write. An absent `terminalEpoch` is not a mismatch:
 * the lease is only compared when the stop captured one. The run's older dispatch-time epoch is not
 * this check — that comparison belongs nowhere in target matching.
 */
export function stopTargetGuard(deps: DispatchDeps, sessionId: string, driver: NativeBackendDriver, profile: NativeBackendProfileConfig, expected: NativeStopRequest): (allowEnded?: boolean) => void {
  return (allowEnded = false) => {
    const current = deps.catalog.currentSession(deps.store.getSession(sessionId));
    const status = driver.status(deps.host, current, profile);
    if ((current.nativeSessionId ?? '') !== expected.nativeSessionId
      || status.activeTurn?.turnId !== expected.turnId && !(allowEnded && !status.activeTurn)
      || status.activeTurn !== undefined && status.activeTurn.nativeSessionId !== expected.nativeSessionId
      || expected.terminalId !== undefined && current.terminalId !== expected.terminalId
      || expected.terminalEpoch !== undefined && (!current.terminalId || deps.store.getTerminal(current.terminalId).epoch !== expected.terminalEpoch)) {
      throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original task changed before stopping', 409);
    }
  };
}

export async function sendRun(deps: DispatchDeps, session: Session, run: Run, commitDispatchFence: (binding?: NativeDispatchBinding) => Run, options: { now?: boolean; expectedStop?: NativeStopRequest } = {}): Promise<void | { settled: true }> {
  if (!run.native) throw new AppError('NOT_NATIVE_RUN', 'Only native runs can be dispatched', 409);
  await assertTaskWorkspaceAvailable(deps.store.getProject(session.projectId));
  if (run.native.intent === 'steer') throw new AppError('STEER_REJECTED', 'An in-flight instruction must use the steer endpoint.', 409);
  const { driver, profile } = await deps.resolve(session);
  await prepareSource(profile.config);
  deps.watches.ensureWatch(session, driver, profile);
  deps.watches.scheduleWatchRelease(session.id);
  if (run.native.input.references?.length) await deps.assertSessionReferences(session);
  const config: NativeRunConfig = {
    ...(session.model !== undefined ? { model: session.model } : {}),
    mode: session.mode,
    ...(session.approval !== undefined ? { approval: session.approval } : {}),
  };
  const beforeWrite = options.now && options.expectedStop ? stopTargetGuard(deps, session.id, driver, profile, options.expectedStop) : undefined;
  beforeWrite?.();
  const outcome = await driver.send(deps.host, {
    session, project: deps.store.getProject(session.projectId), profile,
    commandId: run.commandId, runId: run.id, sourceText: run.native.input.text, input: deps.prepareContextInput ? await deps.prepareContextInput(run) : run.native.input, config,
    commitDispatchFence,
    ...(options.now && driver.sendsNow ? { now: true } : {}),
    ...(beforeWrite ? { beforeWrite } : {}),
  });
  const updated = deps.store.getSession(session.id);
  deps.bindProfile(updated, driver, profile);
  deps.watches.ensureWatch(updated, driver, profile);
  deps.watches.scheduleWatchRelease(session.id);
  return outcome;
}

export async function steerRun(deps: DispatchDeps, session: Session, run: Run, commitDispatchFence: (binding?: NativeDispatchBinding) => Run): Promise<void | { deferred: true }> {
  if (!run.native || run.native.intent !== 'steer' || !run.native.nativeSessionId || !run.native.nativeTurnId) {
    throw new AppError('STEER_REJECTED', 'An in-flight instruction requires its original turn target.', 409);
  }
  await assertTaskWorkspaceAvailable(deps.store.getProject(session.projectId));
  const { driver, profile } = await deps.resolve(session);
  if (!driver.steer || !(await deps.catalog.driverCapabilities(driver, profile)).supportsSteer) throw new AppError('STEER_UNSUPPORTED', 'This backend does not support steering an active turn.', 409);
  if (session.nativeSessionId !== run.native.nativeSessionId) throw new AppError('STEER_TARGET_CHANGED', 'The target conversation changed before delivery.', 409);
  if (run.native.input.references?.length) await deps.assertSessionReferences(session);
  const result = await driver.steer(deps.host, {
    session, project: deps.store.getProject(session.projectId), profile,
    commandId: run.commandId, runId: run.id, sourceText: run.native.input.text, input: deps.prepareContextInput ? await deps.prepareContextInput(run) : run.native.input, config: run.native.config,
    target: { nativeSessionId: run.native.nativeSessionId, turnId: run.native.nativeTurnId },
    commitDispatchFence,
  });
  deps.watches.ensureWatch(session, driver, profile);
  deps.watches.scheduleWatchRelease(session.id);
  return result;
}

export function commitDispatchFence(deps: DispatchDeps, runId: string, binding: NativeDispatchBinding = {}): Run {
  return deps.store.transaction(() => {
    const run = deps.store.getRun(runId);
    if (!run.native) throw new AppError('NOT_NATIVE_RUN', 'Only native runs can be dispatched', 409);
    const session = deps.store.getSession(run.sessionId);
    const expectedBackend = session.backendId;
    if (binding.backendId && binding.backendId !== expectedBackend) throw new AppError('NATIVE_BACKEND_CHANGED', 'Backend changed before message delivery', 409);
    if (session.archivedAt || deps.host.isRunCancelled(runId)) throw new AppError('RUN_CANCELLED', 'Message was cancelled before delivery', 409);
    if (run.native.intent === 'steer' && (
      run.native.nativeSessionId !== session.nativeSessionId ||
      binding.nativeSessionId !== run.native.nativeSessionId || binding.nativeTurnId !== run.native.nativeTurnId
    )) throw new AppError('STEER_TARGET_CHANGED', 'The target turn changed before delivery.', 409);
    if (binding.nativeSessionId && binding.nativeSessionId !== session.nativeSessionId) deps.host.setNativeSessionId(session.id, binding.nativeSessionId);
    const changed = deps.store.transitionNativeRun(runId, ['preparing'], {
      delivery: 'dispatching', stage: 'input', backendId: expectedBackend,
      ...(binding.nativeTurnId ? { nativeTurnId: binding.nativeTurnId } : {}),
      ...(binding.ownerRunId ? { ownerRunId: binding.ownerRunId } : {}),
      ...(binding.terminalId ? { terminalId: binding.terminalId } : session.terminalId ? { terminalId: session.terminalId } : {}),
      ...(binding.terminalEpoch !== undefined ? { terminalEpoch: binding.terminalEpoch } : {}),
      ...(binding.nativeSessionId ? { nativeSessionId: binding.nativeSessionId } : session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
      ...(binding.baselineSequence !== undefined ? { baselineSequence: deps.journalBaseline(session.id) ?? binding.baselineSequence } : {}),
      ...(binding.renderedText !== undefined ? { renderedText: binding.renderedText } : {}),
      ...(binding.nativeInputBoundary !== undefined ? { nativeInputBoundary: binding.nativeInputBoundary } : {}),
      ...(binding.slashCommand !== undefined ? { slashCommand: binding.slashCommand } : {}),
      ...(binding.resolvedConfig ? { resolvedConfig: binding.resolvedConfig } : {}),
      timings: { ...run.native.timings, dispatchAt: Date.now() },
    });
    if (!changed) throw new AppError('RUN_CANCELLED', 'Message was cancelled before delivery', 409);
    return changed;
  });
}

export async function interaction(deps: DispatchDeps, session: Session): Promise<NativeInteraction | undefined> {
  if (deps.unavailable(backendIdOf(session))) return undefined;
  session = deps.catalog.currentSession(session);
  const { driver, profile } = await deps.resolve(session);
  const driverInteraction = await driver.interaction(deps.host, session, profile);
  if (driverInteraction || !deps.watches.usesTerminalDialogs(session)) return driverInteraction;
  return await deps.terminalDialogs.refresh(session);
}

export async function respondInteraction(deps: DispatchDeps, session: Session, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
  session = deps.catalog.currentSession(session);
  const { driver, profile } = await deps.resolve(session);
  let terminalAnswer = false;
  const result = await deps.runtime.withSession(session.id, async () => {
    const current = deps.catalog.currentSession(deps.store.getSession(session.id));
    const replay = deps.terminalDialogs.replay(current, response);
    if (replay) return replay;
    if (deps.terminalDialogs.ownsInteraction(response.interactionId)) {
      const protocol = await driver.interaction(deps.host, current, profile);
      const dialog = deps.watches.usesTerminalDialogs(current) ? deps.terminalDialogs.current(current) : undefined;
      if (protocol || !dialog || dialog.id !== response.interactionId) {
        return Promise.resolve<NativeInteractionResult>({
          status: 'uncertain', interaction: protocol ?? dialog,
          message: '此终端交互已失效，未发送按键。请同步当前请求或查看终端。',
        });
      }
      terminalAnswer = true;
      return deps.terminalDialogs.respond(current, response, async observed => {
        const before = deps.catalog.currentSession(deps.store.getSession(session.id));
        if (!deps.watches.usesTerminalDialogs(before) || before.terminalId !== observed.terminalId) return false;
        const selected = deps.resolveSync(before);
        if (await selected.driver.interaction(deps.host, before, selected.profile)) return false;
        const latest = deps.catalog.currentSession(deps.store.getSession(session.id));
        if (!deps.watches.usesTerminalDialogs(latest) || latest.terminalId !== observed.terminalId) return false;
        if (backendIdOf(latest) !== selected.driver.id || latest.backendProfileId !== before.backendProfileId) return false;
        if (selected.driver.status(deps.host, latest, selected.profile).interaction) return false;
        return selected.driver.endorsesScreenDialog?.(deps.host, latest, observed) ?? true;
      });
    }
    return driver.respond(deps.host, current, profile, response);
  });
  const current = deps.catalog.currentSession(deps.store.getSession(session.id));
  if (current.nativeSessionId || current.terminalId) deps.bindProfile(current, driver, profile);
  if (terminalAnswer) {
    await deps.terminalDialogs.refresh(current).catch(() => undefined);
    deps.watches.publishStatus(current.id, driver, profile);
  }
  return result;
}

export async function interrupt(deps: DispatchDeps, sessionId: string, options?: { clearPrompt?: boolean; expectedStop?: NativeStopRequest }): Promise<void> {
  const session = deps.catalog.currentSession(deps.store.getSession(sessionId));
  const { driver, profile } = await deps.resolve(session);
  await deps.runtime.withSession(session.id, () => {
    const expected = options?.expectedStop;
    const beforeWrite = expected ? stopTargetGuard(deps, sessionId, driver, profile, expected) : undefined;
    beforeWrite?.();
    return driver.interrupt(deps.host, deps.catalog.currentSession(deps.store.getSession(sessionId)), profile, expected ? { ...options, beforeWrite } : options);
  });
  if (session.nativeSessionId || session.terminalId) deps.bindProfile(session, driver, profile);
}

export async function configure(deps: DispatchDeps, session: Session, request: { model?: string; mode?: string; approval?: string; backendProfileId?: string }): Promise<Session> {
  const { backendProfileId, ...patch } = request;
  const source = backendProfileId === session.nativeRuntime?.profileId ? deps.catalog.currentSession(session) : session;
  const { driver, profile: from } = await deps.resolve(source);
  const switching = backendProfileId !== undefined && backendProfileId !== (session.backendProfileId ?? from.id);
  const profile = switching ? (await deps.resolve(session, backendProfileId)).profile : from;
  if (switching && profile.id !== from.id) {
    await prepareSource(profile.config);
    const key = driver.continuationKey?.(from);
    if (key === undefined || driver.continuationKey!(profile) !== key
      || driver.canContinueProfile && !driver.canContinueProfile(from, profile, session)) {
      throw new AppError('NATIVE_PROFILE_SWITCH_UNSUPPORTED', 'This conversation cannot continue on that provider; hand it off instead', 409, { backendId: driver.id });
    }
    const family = (of: NativeBackendProfileConfig, value: string | undefined) => value ? modelFamily(modelNormalizer(driver, of)(value)) : undefined;
    if (family(profile, patch.model ?? session.model ?? profileDefaultModel(driver, profile)) !== family(from, session.model ?? profileDefaultModel(driver, from))) {
      throw new AppError('NATIVE_PROFILE_SWITCH_MODEL', 'A conversation moves to another provider within its model line; hand it off instead', 409, { backendId: driver.id });
    }
  }
  const normalizedPatch = patch.model === undefined ? patch : { ...patch, model: driver.normalizeModel?.(patch.model, profile) ?? patch.model };
  const result = await driver.configure(deps.host, session, profile, normalizedPatch);
  if (switching) {
    deps.bindProfile(deps.store.getSession(session.id), driver, profile);
    const watch = deps.watches.watches.get(session.id);
    if (watch) watch.profile = profile;
  } else if (result.nativeSessionId || result.terminalId) deps.bindProfile(deps.store.getSession(session.id), driver, profile);
  const next: Partial<Session> = {
    ...(switching ? { backendProfileId: profile.id } : {}),
    ...normalizedPatch,
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.mode !== undefined ? { mode: result.mode } : {}),
    ...(result.approval !== undefined ? { approval: result.approval } : {}),
    ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
    ...(result.terminalId ? { terminalId: result.terminalId } : {}),
  };
  const normalize = modelNormalizer(driver, profile);
  const current = deps.store.getSession(session.id);
  const changed = switching || (['model', 'mode', 'approval'] as const).some(key => key in next &&
    (key === 'model' ? normalize(next.model ?? '') !== normalize(current.model ?? '') : next[key] !== current[key]));
  let updated = current;
  if (changed || !Object.entries(next).every(([key, value]) => current[key as keyof Session] === value)) {
    updated = changed ? deps.store.bumpConfig(session.id, next) : deps.store.updateSession(session.id, next);
    deps.store.appendEvent(session.id, 'session', { session: updated });
  }
  try { driver.afterConfigure?.(deps.host, updated, profile); } catch { /* retried by later session activity */ }
  return updated;
}

export async function models(deps: DispatchDeps, session: Session): Promise<ModelInfo[]> {
  const { driver, profile } = await deps.resolve(session);
  return curateModels(await deps.catalog.listModels(driver, deps.store.getProject(session.projectId), profile, session), profile, session, modelNormalizer(driver, profile));
}

export async function forkNativeSession(
  deps: DispatchDeps,
  source: Session,
  targetProject: Project,
  target: { backendId?: NativeBackendId; backendProfileId?: string },
  options: { upToRunId?: string; upToNativeTurnId?: string; upToNativeMessageId?: string } = {},
): Promise<{ nativeSessionId: string; cleanup?: () => Promise<void> } | undefined> {
  if (source.kind !== 'native' || !source.nativeSessionId) return undefined;
  if (target.backendId && target.backendId !== source.backendId) return undefined;
  try {
    const { driver, profile: from } = await deps.resolve(source);
    if (!driver.forkSession) return undefined;
    const to = target.backendProfileId && target.backendProfileId !== from.id
      ? (await deps.resolve(source, target.backendProfileId)).profile
      : from;
    if (to.id !== from.id) {
      const key = driver.continuationKey?.(from);
      if (key === undefined || driver.continuationKey!(to) !== key
        || (driver.canContinueProfile && !driver.canContinueProfile(from, to, source))) {
        return undefined;
      }
    }
    return await driver.forkSession(deps.host, source, targetProject, to, options);
  } catch {
    return undefined;
  }
}

export async function stopActivity(deps: DispatchDeps, session: Session, activityId: string): Promise<NativeActivity> {
  session = deps.catalog.currentSession(session);
  const { driver, profile } = await deps.resolve(session);
  if (!driver.stopActivity) throw new AppError('ACTIVITY_STOP_UNSUPPORTED', 'This backend cannot stop its background tasks from here', 409);
  return await driver.stopActivity(deps.host, session, profile, activityId);
}
