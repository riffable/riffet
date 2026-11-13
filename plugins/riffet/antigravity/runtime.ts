import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { NativeRuntimeNotice, NativeStatus } from '@contracts';
import type { AgentConfigurePatch, AgentContext, AgentHost, AgentOpenResult } from '@riffet/plugin-api';
import { readJson } from './bridge.js';
import { sha } from './composer.js';
import type { PreparedAgySession } from './config.js';
import { agyRecord, type AgyRecord, type AgySnapshot } from './protocol.js';
import type { AgyRpc } from './rpc.js';
import { agyStepIdentity } from './transcript.js';

export interface Launch extends PreparedAgySession {
  config?: AgentConfigurePatch;
  configRevision?: number;
  command: string;
  args: string[];
  marker: string;
  nonce: string;
  token: string;
  terminalId: string;
  epoch: number;
  startedAt: number;
}

export interface Runtime {
  configBlocked?: 'draft';
  failure?: string;
  ownershipMisses?: number;
  cancelling?: boolean;
  models?: Array<{ value: string; name: string; configOptions: [] }>;
  applying?: boolean;
  conflict?: boolean;
  host: AgentHost;
  context: AgentContext;
  launch: Launch;
  rpc?: AgyRpc;
  snapshot?: AgySnapshot;
  status: NativeStatus;
  stopped: boolean;
  tick?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  /** A pending wake for stream frames, which arrive per token and are folded together. */
  frameWake?: ReturnType<typeof setTimeout>;
  stream?: AbortController;
  /** When the stream last failed: it is not reopened on every poll tick while agy keeps refusing it. */
  streamFailedAt?: number;
  /** When the stream last delivered a frame, or was reopened. */
  frameAt?: number;
  streamId?: string;
  /** When the bridge wrote the status `nativeStatus` last returned. */
  statusAt?: number;
  /** The bridge status that last triggered an idle resync; each status record triggers one. */
  idleResyncAt?: number;
  unbind?: () => void;
  verifiedAt?: number;
}

/** State shared by every session of one backend instance. */
export interface Hub {
  readonly stateDir: string;
  closed: boolean;
  readonly runtimes: Map<string, Runtime>;
  readonly attaching: Map<string, Promise<Runtime | undefined>>;
  readonly opening: Map<string, Promise<AgentOpenResult>>;
  readonly watchers: Map<string, Set<() => void>>;
  readonly lifecycle: Map<string, number>;
  /** Set by the backend: a queued configuration relaunches through its own `open`. */
  reopen: (host: AgentHost, context: AgentContext) => Promise<AgentOpenResult>;
}

/** Three definite misses in a row (about two seconds of polling) is a pane that is not ours, not a slow lookup. */
export const OWNERSHIP_MISSES = 3;
export const OWNERSHIP_FAILED =
  "Riffet could not verify the Antigravity process in this conversation's terminal. " +
  'Close that terminal; the next message starts a new one.';

export class AgyOwnershipError extends Error {}

export const waiting = (snapshot?: AgySnapshot) => snapshot?.steps.some(step => String(step.status).endsWith('_WAITING')) ?? false;

export const userBoundary = (snapshot?: AgySnapshot) =>
  snapshot?.steps.flatMap((step, index) => (step.userInput ? [agyStepIdentity(snapshot, step, index)] : [])) ?? [];

export const sessionRoot = (hub: Hub, id: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid session identity');
  return join(hub.stateDir, 'sessions', id);
};

export async function loadContext(host: AgentHost, id: string): Promise<AgentContext> {
  const session = await host.session(id);
  return { session, project: await host.project(session.projectId), profile: await host.profile(id) };
}

export const epochOf = (hub: Hub, id: string) => hub.lifecycle.get(id) ?? 0;

export function assertCurrent(hub: Hub, id: string, epoch: number): void {
  if (hub.closed || epochOf(hub, id) !== epoch) throw new Error('Antigravity operation was closed');
}

export function detach(hub: Hub, id: string): void {
  hub.lifecycle.set(id, epochOf(hub, id) + 1);
  const runtime = hub.runtimes.get(id);
  if (!runtime) return;
  runtime.stopped = true;
  clearTimeout(runtime.timer);
  clearTimeout(runtime.frameWake);
  runtime.stream?.abort();
  runtime.unbind?.();
  hub.runtimes.delete(id);
}

/**
 * A saved model/mode/permission change only reaches agy through a relaunch of its TUI, which waits for the
 * native work and the terminal draft. Say so while it waits: the terminal will restart, and a draft holds it.
 */
function configNotice(runtime: Runtime): NativeRuntimeNotice | undefined {
  const session = runtime.host.view.session(runtime.context.session.id);
  if (!session?.configPending || session.configRevision === runtime.launch.configRevision) return undefined;
  return {
    tone: 'neutral',
    label:
      runtime.configBlocked === 'draft'
        ? { en: 'Clear the terminal input to apply settings', 'zh-Hans': '清空终端输入后应用设置' }
        : { en: 'Restarts when idle to apply settings', 'zh-Hans': '空闲后重启以应用设置' },
  };
}

const STOP_LABEL = { en: 'Stop current Antigravity work', 'zh-Hans': '停止当前 Antigravity 任务' };

export function changed(hub: Hub, runtime: Runtime): void {
  for (const wake of hub.watchers.get(runtime.context.session.id) ?? []) wake();
  runtime.host.transcript.wake(runtime.context.session.id);
  const connected = runtime.status.connection?.state === 'connected';
  const stoppable = connected && ['busy', 'attention'].includes(runtime.status.phase);
  const notice = connected ? configNotice(runtime) : undefined;
  runtime.status.runtimeControl =
    stoppable || notice
      ? {
          owner: 'riffet.antigravity',
          revision: sha(`${runtime.launch.nonce}:${runtime.status.activeTurnId ?? 'current'}`),
          ...(notice ? { notice } : {}),
          ...(stoppable ? { actions: [{ id: 'stop-current', label: STOP_LABEL }] } : {}),
        }
      : undefined;
  runtime.host.emit(runtime.context.session.id, { type: 'status', status: runtime.status });
}

export async function nativeStatus(runtime: Runtime): Promise<AgyRecord | undefined> {
  const record = await readJson(join(runtime.launch.root, 'bridge', 'status.json'));
  if (record?.nonce !== runtime.launch.nonce || !(record.at >= runtime.launch.startedAt) || !agyRecord(record.payload)) return undefined;
  runtime.statusAt = record.at;
  return record.payload;
}

export function idle(runtime: Runtime, status: AgyRecord | undefined): boolean {
  if (
    !status ||
    status.agent_state !== 'idle' ||
    status.tool_confirmation_pending ||
    Number(status.pending_input_count ?? 0) > 0 ||
    Number(status.task_count ?? 0) > 0
  ) {
    return false;
  }
  if (
    Array.isArray(status.subagents) &&
    status.subagents.some((child: AgyRecord) => !['done', 'completed', 'stopped', 'failed'].includes(child.state ?? child.status))
  ) {
    return false;
  }
  if (!status.conversation_id) return !runtime.snapshot;
  return (
    runtime.snapshot?.conversationId === status.conversation_id &&
    runtime.snapshot?.status === 'CASCADE_RUN_STATUS_IDLE' &&
    !waiting(runtime.snapshot)
  );
}

export async function owned(runtime: Runtime): Promise<number> {
  const pids = await runtime.host.terminals.inspect(runtime.launch.terminalId, {
    command: runtime.launch.command,
    args: runtime.launch.args,
    launchMarker: runtime.launch.marker,
  });
  if (pids === undefined) throw new Error('Antigravity terminal could not be inspected');
  if (pids.length !== 1) {
    runtime.ownershipMisses = (runtime.ownershipMisses ?? 0) + 1;
    throw new AgyOwnershipError('Antigravity terminal ownership could not be verified');
  }
  runtime.ownershipMisses = 0;
  runtime.verifiedAt = Date.now();
  return pids[0]!;
}

/** `owned` for an explicit request: a pane that is still exec'ing its launcher gets a moment before it counts as foreign. */
export async function verifyOwnership(host: AgentHost, runtime: Runtime): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await owned(runtime);
    } catch (error) {
      if (!(error instanceof AgyOwnershipError)) throw error;
      if (attempt >= OWNERSHIP_MISSES) throw host.error('AGY_TERMINAL_UNVERIFIED', OWNERSHIP_FAILED, 409);
      await delay(500);
    }
  }
}
