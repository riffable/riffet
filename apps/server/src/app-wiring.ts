import { randomUUID } from 'node:crypto';
import type { PluginAgentHost, PluginManifest } from '@riffet/plugin-api';
import type { NativeRunInput, Run } from '../../../packages/contracts/src/index.js';
import type { AgentTeamService } from './assistant/team.js';
import { isNativeBackendId, type NativeBackendRegistry } from './backends/registry.js';
import type { NativeBackendService } from './backends/service.js';
import { sessionReferenceInputs } from './context-references/input.js';
import { AppError, requireString } from './errors.js';
import { agentMentionInputs } from './native/agent-mentions.js';
import type { NativeDispatcher } from './native/dispatch.js';
import { resolveNativeSessionInput } from './native/session-input.js';
import type { SessionCommands } from './orchestration/session-commands.js';
import type { NativeMessageBody } from './routes/deps.js';
import type { SettingsService } from './settings/index.js';
import type { Store } from './store.js';
import type { TranscriptIngest } from './sync/ingest.js';
import type { TimelineService } from './timeline/service.js';
import type { WorkspaceService } from './workspace/index.js';

export function createActiveWorkbenchRunResolver(deps: {
  store: Store;
  nativeBackends: () => NativeBackendService;
  team: () => AgentTeamService | undefined;
}): (sessionId: string) => string | undefined {
  return (sessionId) => {
    const session = deps.store.getSession(sessionId);
    if (session.archivedAt || session.state === 'archived') return undefined;
    const project = deps.store.getProject(session.projectId);
    if (project.system !== 'assistant' || project.archivedAt || project.mainSessionId !== sessionId || session.origin?.kind === 'assistant') return undefined;
    const member = deps.team()?.resolveFor(project, session);
    if (member && !member.capabilities.workbenchAdmin) return undefined;
    const turn = deps.nativeBackends().ownedForegroundTurn(sessionId);
    if (!turn) return undefined;
    const run = deps.store.getRun(turn.ownerRunId);
    if (
      run.sessionId !== sessionId
      || run.state !== 'running'
      || !run.native
      || run.native.intent
      || run.native.nativeSessionId !== turn.nativeSessionId
      || (run.native.nativeTurnId && run.native.nativeTurnId !== turn.turnId)
    ) return undefined;
    return run.id;
  };
}

export function createNativeInputReader(workspace: WorkspaceService) {
  return async (body: NativeMessageBody, options: { validateAttachments?: boolean } = {}): Promise<NativeRunInput> => {
    const text = requireString(body?.text, 'text', 100_000).trim();
    if (!text) throw new AppError('INVALID_PROMPT', 'Enter a message');
    if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 20)) {
      throw new AppError('INVALID_ATTACHMENTS', 'Use at most 20 attachments');
    }
    const attachmentIds = (body.attachments ?? []).map((item) => requireString(item?.id, 'attachment.id', 100));
    // Metadata and a stat prove the file is there and intact; the bytes are read at delivery.
    if (options.validateAttachments !== false) {
      for (const id of attachmentIds) await workspace.readAttachmentMetadata(id);
    }
    if (body.context !== undefined && (!Array.isArray(body.context) || body.context.length > 20)) {
      throw new AppError('INVALID_CONTEXT', 'Use at most 20 file references');
    }
    const context = (body.context ?? []).map((item) => {
      const path = requireString(item?.path, 'context.path', 8192);
      if (item.line !== undefined && (!Number.isSafeInteger(item.line) || item.line < 1)) {
        throw new AppError('INVALID_LINE', 'Reference line must be a positive integer');
      }
      return { path, ...(item.line !== undefined ? { line: item.line } : {}) };
    });
    if (body.expectedConfigRevision !== undefined && (!Number.isSafeInteger(body.expectedConfigRevision) || body.expectedConfigRevision < 0)) {
      throw new AppError('INVALID_CONFIG_REVISION', 'Configuration revision must be a non-negative integer');
    }
    const references = sessionReferenceInputs(body.references);
    const agents = agentMentionInputs(body.agents);
    return { text, attachmentIds, context, ...(references ? { references } : {}), ...(agents ? { agents } : {}) };
  };
}

export function createPluginAgentHostFactory(deps: {
  store: Store;
  settings: SettingsService;
  nativeBackends: NativeBackendService;
  team: AgentTeamService;
  memberMain: (memberId: string) => string | undefined;
  sessionCommands: SessionCommands;
  dispatch: NativeDispatcher;
  ingest: TranscriptIngest;
  timeline: TimelineService;
}): (pluginId: PluginManifest['id']) => PluginAgentHost {
  const { store, settings, nativeBackends, team, memberMain, sessionCommands, dispatch, ingest, timeline } = deps;
  return (pluginId) => ({
    listBackends: async () => (await nativeBackends.catalog.listBackends()).map((entry) => ({
      id: entry.backendId,
      label: entry.label,
      available: entry.available,
      ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
    })),
    listMembers: () => team.list().map((member) => {
      const mainSessionId = memberMain(member.id);
      return {
        id: member.id,
        name: member.name,
        ...(member.description ? { description: member.description } : {}),
        scope: member.scope.kind,
        ...(member.scope.projectIds?.length ? { projectIds: member.scope.projectIds } : {}),
        ...(mainSessionId ? { mainSessionId } : {}),
        ...(member.target?.backendId ? { backendId: member.target.backendId } : {}),
        ...(member.target?.model ? { model: member.target.model } : {}),
      };
    }),
    listProjects: () => store.listProjects().filter((project) => !project.archivedAt && !project.system).map((project) => ({
      id: project.id,
      name: project.name,
      cwd: project.cwd,
    })),
    run: async (request) => {
      const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
      if (!prompt) throw new AppError('INVALID_INPUT', 'prompt is required');
      const target = request.target ?? {};
      const commandId = request.commandId?.trim() || randomUUID();
      const timeoutMs = Math.min(15 * 60_000, Math.max(5_000, Math.floor(request.timeoutMs ?? 5 * 60_000)));
      const input = { text: prompt, attachmentIds: [], context: [] };
      let sessionId: string;
      let run: Run;
      if (target.sessionId) {
        const session = store.getSession(target.sessionId);
        if (session.archivedAt) throw new AppError('SESSION_ARCHIVED', 'Restore this conversation before continuing it', 409);
        if (session.kind !== 'native') throw new AppError('NOT_NATIVE', 'Only native conversations accept text input', 409);
        const existing = store.findRunByCommand(session.id, commandId);
        if (existing) {
          run = store.acceptNativeRun(session.id, commandId, input, existing.native!.config);
        } else {
          sessionCommands.admit(session);
          nativeBackends.assertAvailable(session);
          run = store.acceptNativeRun(session.id, commandId, input, { model: session.model, mode: session.mode, approval: session.approval });
        }
        sessionId = session.id;
        dispatch.kick();
      } else {
        const sessionInput = await resolveNativeSessionInput({ store, settings, nativeBackends, team: () => team }, {
          ...(target.memberId ? { agentMemberId: target.memberId } : { agentMemberId: null }),
          ...(target.projectId ? { projectId: target.projectId } : {}),
          ...(target.backendId ? { backendId: target.backendId } : {}),
          ...(target.profileId ? { backendProfileId: target.profileId } : {}),
          ...(target.model ? { model: target.model } : {}),
          ...(target.approval ? { approval: target.approval } : {}),
          ...(target.title ? { title: target.title } : {}),
        });
        const created = store.createNativeSubmission(randomUUID(), { ...sessionInput, origin: { kind: 'plugin', pluginId } }, commandId, input);
        sessionId = created.session.id;
        run = created.run;
        dispatch.kick();
      }
      const terminal = (state: string): state is 'completed' | 'failed' | 'cancelled' | 'interrupted' =>
        state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted';
      const settled = await new Promise<Run>((resolve, reject) => {
        const finish = (current: Run) => { cleanup(); resolve(current); };
        const fail = (error: Error) => { cleanup(); reject(error); };
        const onAbort = () => fail(new AppError('PLUGIN_AGENT_ABORTED', 'Agent run wait aborted', 499));
        const timer = setTimeout(() => fail(new AppError('PLUGIN_AGENT_TIMEOUT', `Agent run did not settle within ${Math.round(timeoutMs / 1000)}s`, 504)), timeoutMs);
        timer.unref?.();
        const off = store.onRunChanged((changed) => { if (changed.id === run.id && terminal(changed.state)) finish(changed); });
        const cleanup = () => { clearTimeout(timer); off(); request.signal?.removeEventListener('abort', onAbort); };
        if (request.signal?.aborted) { onAbort(); return; }
        request.signal?.addEventListener('abort', onAbort, { once: true });
        const current = store.getRun(run.id);
        if (terminal(current.state)) finish(current);
      });
      await ingest.read(sessionId)?.catch(() => undefined);
      await timeline.ready(sessionId, 'main').catch(() => undefined);
      const turn = timeline.outline(sessionId, 'main', 20).turns.find((item) => item.runId === settled.id);
      let answer = turn ? (timeline.turnText(sessionId, turn.turn)?.answer?.trim() ?? '') : '';
      if (!answer && turn) {
        const page = timeline.page(sessionId, 'main', { from: turn.startPos, rows: 400 });
        const last = page.rows.filter((row) => row.turn === turn.turn).findLast((row) => row.kind === 'assistant' && 'text' in row && typeof row.text === 'string' && Boolean(row.text.trim()));
        answer = last && 'text' in last && typeof last.text === 'string' ? last.text.trim() : '';
      }
      return {
        sessionId,
        runId: settled.id,
        status: settled.state as 'completed' | 'failed' | 'cancelled' | 'interrupted',
        answer,
        ...(settled.error ? { error: settled.error } : {}),
      };
    },
  });
}

export function createControlCapabilityTracker(backendRegistry: NativeBackendRegistry, nativeBackends: NativeBackendService) {
  // Read on the sync tick, which cannot await. A known backend defaults to interrupt and targeted stop until `capabilitiesFor` fills this cache; when it resolves, active sync streams refresh `control`.
  const cache = new Map<string, { supportsInterrupt: boolean; supportsTargetedStop: boolean; supportsSteer?: boolean }>();
  const pending = new Set<string>();
  const refreshListeners = new Set<() => void>();
  const notifyRefresh = () => {
    for (const listener of refreshListeners) {
      try { listener(); } catch { /* each stream is independent */ }
    }
  };
  const capabilities = (session: { backendId?: string; backendProfileId?: string }) => {
    const backendId = session.backendId;
    if (!backendId || !isNativeBackendId(backendId)) return undefined;
    if (!backendRegistry.get(backendId)) return undefined;
    const key = `${backendId}\n${session.backendProfileId ?? ''}`;
    const cached = cache.get(key);
    if (!cached && !pending.has(key)) {
      pending.add(key);
      // A profile that no longer resolves (deleted, renamed) falls back to the backend's default one, so steering is not lost with it.
      void nativeBackends.catalog.capabilitiesFor(backendId, session.backendProfileId)
        .catch(() => nativeBackends.catalog.capabilitiesFor(backendId))
        .then((caps) => {
          cache.set(key, { supportsInterrupt: caps.supportsInterrupt, supportsTargetedStop: caps.supportsTargetedStop !== false, supportsSteer: caps.supportsSteer === true });
          notifyRefresh();
        })
        .catch(() => undefined)
        .finally(() => { pending.delete(key); });
    }
    return cached ?? { supportsInterrupt: true, supportsTargetedStop: true };
  };
  const subscribeRefresh = (listener: () => void) => {
    refreshListeners.add(listener);
    return () => { refreshListeners.delete(listener); };
  };
  return { capabilities, subscribeRefresh };
}
