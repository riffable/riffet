import { runProcess } from '@riffet/plugin-api/kit';
import type { AgentHost } from '@riffet/plugin-api/experimental/agent';
import { agyToolPermission } from './config.js';
import { queueConfiguration } from './config-queue.js';
import { launchProfile, nativeModels } from './models.js';
import { AGY_ID, agyRecord, applyAgyUpdate, type AgyRecord } from './protocol.js';
import { receipts } from './receipts.js';
import { AgyRpc } from './rpc.js';
import { interactionOf } from './interactions.js';
import {
  FINISHED_SUBAGENT_STATES,
  OWNERSHIP_FAILED,
  OWNERSHIP_MISSES,
  changed,
  detach,
  idle,
  nativeStatus,
  owned,
  waiting,
  type Hub,
  type Runtime,
} from './runtime.js';
import { mapAgySnapshot, mapLiveSnapshot } from './transcript.js';

type Session = NonNullable<ReturnType<AgentHost['view']['session']>>;

async function connect(runtime: Runtime): Promise<AgyRpc> {
  const pid = await owned(runtime);
  const result = await runProcess('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], {
    cwd: runtime.context.project.cwd,
    timeoutMs: 3000,
    maxOutputBytes: 16384,
  });
  const ports = [...new Set([...result.stdout.matchAll(/^n(?:127\.0\.0\.1|\[::1\]):(\d+)$/gm)].map(match => Number(match[1])))];
  for (const port of ports) {
    const rpc = new AgyRpc({ port, token: runtime.launch.token });
    try {
      await rpc.call('Heartbeat', {}, AbortSignal.timeout(1000));
      await owned(runtime);
      return rpc;
    } catch {
      /* only the authenticated HTTP listener of this verified process is accepted */
    }
  }
  throw new Error('Antigravity local protocol is unavailable');
}

const ACTIVE_POLL_MS = 750;
const IDLE_POLL_MS = 3000;

export function schedule(hub: Hub, runtime: Runtime): void {
  if (runtime.stopped || hub.closed || runtime.failure) return;
  // One loop per runtime: a recovery that reschedules while a tick is still finishing replaces it.
  clearTimeout(runtime.timer);
  const quiet =
    runtime.status.phase === 'idle' &&
    runtime.status.connection?.state === 'connected' &&
    Boolean(runtime.stream && !runtime.stream.signal.aborted) &&
    !runtime.host.view.session(runtime.context.session.id)?.configPending;
  runtime.timer = setTimeout(() => {
    void refresh(hub, runtime).finally(() => schedule(hub, runtime));
  }, quiet ? IDLE_POLL_MS : ACTIVE_POLL_MS);
  runtime.timer.unref();
}

/** The poll failed: record why the pane is unreachable, and end the turns of a terminal that has exited. */
async function pollFailed(hub: Hub, runtime: Runtime): Promise<void> {
  if (runtime.stopped) return;
  runtime.rpc = undefined;
  runtime.stream?.abort();
  const terminal = await runtime.host.terminals.get(runtime.launch.terminalId).catch(() => undefined);
  const exited = terminal?.state === 'exited';
  if (exited) await endOpenTurns(runtime);
  if (!exited && (runtime.ownershipMisses ?? 0) >= OWNERSHIP_MISSES) runtime.failure = OWNERSHIP_FAILED;
  runtime.status = runtime.failure
    ? { phase: 'offline', notice: runtime.failure, noticeLevel: 'error', connection: { state: 'failed', message: runtime.failure } }
    : {
        ...runtime.status,
        phase: exited ? 'offline' : 'starting',
        connection: { state: exited ? 'disconnected' : 'reconnecting', message: 'Antigravity connection is unavailable' },
      };
  changed(hub, runtime);
  // Nothing comes back from an exited terminal: stop polling it and release its MCP binding. The session then
  // reports offline until the next message or an explicit open launches agy again.
  if (exited && hub.runtimes.get(runtime.context.session.id) === runtime) detach(hub, runtime.context.session.id);
}

/** Ends the turns agy left open when its terminal exited: nothing will record their end now. */
export async function endOpenTurns(runtime: Runtime): Promise<void> {
  const turns = runtime.snapshot ? mapAgySnapshot(runtime.snapshot).turns.filter(turn => !turn.status) : [];
  runtime.snapshot = undefined;
  for (const turn of turns) {
    await runtime.host.transcript
      .endTurn(runtime.context.session.id, turn.id, 'interrupted', new Date().toISOString(), 'Antigravity terminal exited')
      .catch(() => undefined);
  }
}

export function refresh(hub: Hub, runtime: Runtime): Promise<void> {
  if (runtime.tick) return runtime.tick;
  const tick = poll(hub, runtime)
    .catch(() => pollFailed(hub, runtime))
    .finally(() => {
      if (runtime.tick === tick) runtime.tick = undefined;
    });
  runtime.tick = tick;
  return tick;
}

/** Each wake has the host map the whole conversation, so frames that arrive per token share one per window. */
const FRAME_WAKE_MS = 100;
function frameChanged(hub: Hub, runtime: Runtime): void {
  if (runtime.frameWake) return;
  runtime.frameWake = setTimeout(() => {
    runtime.frameWake = undefined;
    if (!runtime.stopped && !hub.closed) changed(hub, runtime);
  }, FRAME_WAKE_MS);
  runtime.frameWake.unref();
}

function readStream(hub: Hub, runtime: Runtime, id: string): void {
  if (runtime.stopped || hub.closed || runtime.cancelling) return;
  runtime.stream?.abort();
  const controller = new AbortController();
  runtime.stream = controller;
  runtime.streamId = id;
  void runtime
    .rpc!.stream(
      id,
      update => {
        if (controller.signal.aborted || runtime.stream !== controller || runtime.stopped || hub.closed || runtime.cancelling) return;
        runtime.frameAt = Date.now();
        runtime.snapshot = applyAgyUpdate(runtime.snapshot, update);
        const interaction = runtime.snapshot && interactionOf(runtime.snapshot)?.view;
        runtime.status = {
          ...runtime.status,
          ...(waiting(runtime.snapshot)
            ? { phase: 'attention' as const }
            : runtime.snapshot?.status === 'CASCADE_RUN_STATUS_RUNNING'
            ? { phase: 'busy' as const }
            : {}),
          ...(interaction ? { interaction } : { interaction: undefined }),
        };
        frameChanged(hub, runtime);
      },
      controller.signal,
    )
    .catch(() => {
      if (runtime.stream === controller && !controller.signal.aborted) runtime.streamFailedAt = Date.now();
    })
    .finally(() => {
      controller.abort();
    });
}

/**
 * Replaces the snapshot with a fresh full read and reopens the stream on it. A unary read assigned while the
 * old stream keeps applying frames can land after a newer frame and roll a step back, and that index then
 * gets no further frame; a reopened stream starts again from a baseline.
 */
export async function resync(hub: Hub, runtime: Runtime, id: string) {
  runtime.stream?.abort();
  runtime.snapshot = await runtime.rpc!.snapshot(id);
  runtime.frameAt = Date.now();
  readStream(hub, runtime, id);
  return runtime.snapshot;
}

const STREAM_RETRY_MS = 5000;
/** The stream has no keepalive. A run with no frame for this long gets one fresh read; a long tool call may just be quiet. */
const STREAM_SILENT_MS = 30_000;

function derivePhase(runtime: Runtime, status: AgyRecord) {
  if (waiting(runtime.snapshot) || status.tool_confirmation_pending) return 'attention';
  if (idle(runtime, status)) return 'idle';
  if (status.agent_state === 'working' || runtime.snapshot?.status === 'CASCADE_RUN_STATUS_RUNNING') return 'busy';
  return 'starting';
}

/**
 * A queued restart is acknowledged once agy is idle on a launch that carries the saved revision. What agy then
 * reports is the configuration even where it differs from the request (a model outside its agent catalog falls
 * back, the reader picks another in the TUI); `adoptObservedConfig` records that. Waiting for an exact match
 * would hold every message for good.
 */
async function settleConfiguration(hub: Hub, runtime: Runtime, session: Session): Promise<void> {
  if (session.configRevision !== runtime.launch.configRevision) {
    queueConfiguration(hub, runtime);
    return;
  }
  await runtime.host.updateSession(session.id, { configPending: false });
}

const SETTLED_STEP_STATUS = /_(?:DONE|ERROR|CANCELED|INTERRUPTED|CLEARED|INVALID)$/;

function deriveActivity(runtime: Runtime, status: AgyRecord, sessionId: string) {
  const compacting = Boolean(
    runtime.snapshot?.steps.some(step => agyRecord(step.checkpoint) && !SETTLED_STEP_STATUS.test(String(step.status ?? ''))),
  );
  const taskCount = Number(status.task_count ?? 0);
  const runningSubagents = Array.isArray(status.subagents)
    ? status.subagents.filter(
        (child: AgyRecord) => !FINISHED_SUBAGENT_STATES.has(String(child.state ?? child.status ?? '').toLowerCase()),
      ).length
    : 0;
  const runningJobs = runtime.snapshot
    ? mapLiveSnapshot(runtime.snapshot, sessionId).jobs.filter(job => job.status === 'running').length
    : 0;
  const background = Math.max(Number.isFinite(taskCount) && taskCount > 0 ? taskCount : 0, runningSubagents + runningJobs);
  return compacting || background > 0 ? { compacting, background } : undefined;
}

/**
 * Mirror the model, mode and permission the terminal reports back into the session. agy running the model its launch
 * asked for keeps that launch's selection (its effort, a gateway id); another one - a pick in agy's `/model`, or the
 * default agy fell back to at start - is read back into agy's id. While agy starts (`authenticating`,
 * `initializing`) its status line shows the model saved in its settings, not the one it runs, so only a started
 * agy is read.
 */
async function adoptObservedConfig(runtime: Runtime, session: Session, status: AgyRecord): Promise<void> {
  const started = status.agent_state === 'idle' || status.agent_state === 'working';
  const label = started
    ? [status.model?.display_name, status.model?.id].find((value): value is string => typeof value === 'string' && !!value)
    : undefined;
  const requested = runtime.launch.requestedModel;
  const selected = runtime.launch.config?.model;
  const asked = !!label && !!requested?.labels.includes(label);
  // While the session still holds the selection this launch started with, another model is agy's own fallback.
  if (label && requested && !asked && session.model === selected)
    runtime.modelFallback = `Antigravity could not use ${requested.id}; running ${label} instead.`;
  const model = !label ? undefined : asked ? selected : runtime.models?.find(item => item.name === label)?.value;
  const mode =
    typeof status.cycle_mode === 'string' && status.cycle_mode === ''
      ? 'agent'
      : typeof status.cycle_mode === 'string' && ['plan', 'accept-edits', 'auto', 'agent'].includes(status.cycle_mode)
        ? status.cycle_mode
        : runtime.launch.config?.mode ?? session.mode;
  const rawApproval = status.tool_permission ?? status.toolPermission ?? status.approval;
  let observedApproval: string | undefined;
  if (typeof rawApproval === 'string' && rawApproval) {
    try {
      observedApproval = agyToolPermission(rawApproval);
    } catch {
      /* ignore unknown native permission values */
    }
  }
  const approval = observedApproval ?? runtime.launch.config?.approval;
  const patch = { ...(model ? { model } : {}), mode, ...(approval ? { approval } : {}) };
  runtime.status = { ...runtime.status, ...patch };
  if (Object.entries(patch).some(([key, value]) => session[key as keyof typeof session] !== value)) {
    await runtime.host.updateSession(session.id, patch);
  }
}

export async function poll(hub: Hub, runtime: Runtime): Promise<void> {
  if (runtime.stopped || runtime.cancelling) return;
  if (!runtime.rpc) runtime.rpc = await connect(runtime);
  if (!runtime.verifiedAt || Date.now() - runtime.verifiedAt > 5000) await owned(runtime);
  const status = await nativeStatus(runtime);
  if (runtime.stopped || hub.closed || runtime.cancelling) return;
  if (!status) {
    const interaction = await runtime.host.dialogs.current?.(runtime.context.session.id).catch(() => null);
    if (interaction) {
      runtime.status = { phase: 'attention', interaction, connection: { state: 'connected' } };
      changed(hub, runtime);
    }
    return;
  }
  // Once per launch: a failed list is not cached by `nativeModels`, and this runs on every tick.
  runtime.models ??= await launchProfile(runtime.host, runtime.context.profile)
    .then(profile => nativeModels(hub, profile))
    .catch(() => []);
  const id = typeof status.conversation_id === 'string' && AGY_ID.test(status.conversation_id) ? status.conversation_id : undefined;
  const session = runtime.host.view.session(runtime.context.session.id);
  if (!session) return;
  if (session.nativeSessionId && ((id && id !== session.nativeSessionId) || (!id && status.agent_state === 'idle'))) {
    runtime.conflict = true;
    runtime.stream?.abort();
    runtime.status = {
      phase: 'attention',
      connection: { state: 'conflict', message: 'The terminal switched to another Antigravity conversation' },
    };
    changed(hub, runtime);
    return;
  }
  runtime.conflict = false;
  if (id && !session.nativeSessionId) {
    await runtime.host.setNativeSessionId(session.id, id);
    runtime.snapshot = undefined;
    runtime.stream?.abort();
    runtime.streamId = undefined;
  }
  const streamDown = !runtime.stream || runtime.stream.signal.aborted || runtime.streamId !== id;
  const backingOff = runtime.streamId === id && Date.now() - (runtime.streamFailedAt ?? 0) < STREAM_RETRY_MS;
  const silent = runtime.snapshot?.status === 'CASCADE_RUN_STATUS_RUNNING' && Date.now() - (runtime.frameAt ?? 0) > STREAM_SILENT_MS;
  // The bridge can report idle before the stream does, or keep an idle status through a turn when agy does not
  // refresh its status line, so a disagreement is checked once per status record, not on every tick.
  const unconfirmedIdle =
    status.agent_state === 'idle' && runtime.snapshot?.status !== 'CASCADE_RUN_STATUS_IDLE' && runtime.idleResyncAt !== runtime.statusAt;
  if (id && !backingOff && (streamDown || silent || unconfirmedIdle)) {
    if (unconfirmedIdle) runtime.idleResyncAt = runtime.statusAt;
    await resync(hub, runtime, id);
  } else if (id && streamDown) runtime.snapshot = await runtime.rpc.snapshot(id);
  let interaction = runtime.snapshot && interactionOf(runtime.snapshot)?.view;
  if (!interaction && (status.tool_confirmation_pending || waiting(runtime.snapshot) || !runtime.snapshot)) {
    interaction = (await runtime.host.dialogs.current?.(session.id).catch(() => null)) ?? undefined;
  }
  const phase = derivePhase(runtime, status);
  const turn = runtime.snapshot && mapLiveSnapshot(runtime.snapshot, session.id).turns.findLast(turn => !turn.status);
  const activity = deriveActivity(runtime, status, session.id);
  runtime.status = {
    phase,
    ...(turn && id ? { activeTurnId: turn.id, activeTurn: { nativeSessionId: id, turnId: turn.id } } : {}),
    connection: { state: 'connected' },
    ...(id ? { history: { state: 'ready' as const } } : {}),
    ...(interaction ? { interaction } : {}),
    ...(activity ? { activity } : {}),
    // A model agy would not start with is said for as long as this launch runs: the first message usually rides on it.
    // Answering agy's trust gate changes what runs in this directory without review, so it is never silent either;
    // said once, on the launch that recorded it, until the conversation's first input.
    ...(runtime.modelFallback
      ? { notice: runtime.modelFallback, noticeLevel: 'warning' as const }
      : runtime.launch.trustAdded && !runtime.snapshot?.steps.some(step => step.userInput)
        ? { notice: `Trusted ${runtime.context.project.cwd} for this Antigravity conversation.`, noticeLevel: 'info' as const }
        : {}),
  };
  if (runtime.snapshot) await receipts(runtime);
  if (phase === 'idle' && session.configPending) await settleConfiguration(hub, runtime, session);
  if (!runtime.host.view.session(session.id)?.configPending) await adoptObservedConfig(runtime, session, status);
  const meter = status.context_window;
  if (Number.isFinite(meter?.context_window_size) && meter.context_window_size > 0) {
    const usage = meter.current_usage;
    const used =
      Number(usage?.input_tokens ?? 0) +
      Number(usage?.cache_read_input_tokens ?? 0) +
      Number(usage?.cache_creation_input_tokens ?? 0);
    if (usage || used > 0) {
      const context = { used, size: meter.context_window_size, breakdown: [] };
      const contextJson = JSON.stringify(context);
      if (contextJson !== runtime.lastContextJson) {
        runtime.lastContextJson = contextJson;
        runtime.host.emit(session.id, { type: 'context', context });
      }
    }
  }
  changed(hub, runtime);
}
