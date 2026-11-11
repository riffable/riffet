import { createContext, useContext, useSyncExternalStore } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { NativeHistoryState, NativeJob, SyncLane, WorkbenchEvent } from '@contracts';
import { chunkText, type TimelineItem } from './model';
import type { EarlierLoad } from './useEarlierHistory';

export interface SubagentTranscript { agentId: string; subagentType?: string; title?: string; prompt?: string; model?: string; events: WorkbenchEvent[]; history?: NativeHistoryState; resetVersion?: number; running?: boolean;
  /** The child's live turn (`runId` of its rows) while it runs, when its backend names one. */
  activeTurnId?: string; status?: 'running' | 'completed' | 'failed' | 'cancelled'; startedAt?: string; endedAt?: string;
  /** Sync v3: the child's lane, and the rows the server folded it into, shown as they are; `synced` once its stream has answered. */
  lane?: SyncLane; timeline?: TimelineItem[]; synced?: boolean; loadingEarlier?: boolean; }

/** Sync v3: a child's lane is streamed only while a panel shows it (docs/SYNC-V3.md, 传输). */
export interface SubagentLanes {
  /** Subscribes to the child's lane; the returned function lets go of it. */
  watch(toolCallId: string): () => void;
  loadEarlier(toolCallId: string): Promise<EarlierLoad>;
}
export interface StoredSubagent { toolCallId: string; transcript: SubagentTranscript; }

/** TRAE's activity announces the same spawn under this prefix; the spawn's own call id is canonical. */
const ACTIVITY_PREFIX = 'subagent-activity:';

/**
 * The same child reached under another call id: a repair moved it, or its activity announced it.
 * Only this merge keeps what the earlier entry already knew; a write for one id replaces it, so
 * a lane that answered with nothing really clears what it showed.
 */
function merged(held: SubagentTranscript, incoming: SubagentTranscript): SubagentTranscript {
  const timeline = incoming.timeline?.length ? incoming.timeline : held.timeline;
  const history = incoming.history ?? held.history;
  return {
    ...held, ...incoming,
    agentId: incoming.agentId || held.agentId,
    events: incoming.events.length ? incoming.events : held.events,
    ...(timeline ? { timeline } : {}),
    ...(history ? { history } : {}),
  };
}

/** Stores transcripts by tool call so a child update wakes only its expanded panel. */
export class SubagentStore {
  /** Set by sync v3, which streams a child's transcript only while it is open. */
  lanes?: SubagentLanes;
  private values = new Map<string, SubagentTranscript>();
  /** A duplicate's id, from TRAE's activity or a repair that moved the child, to the one it is stored under. */
  private aliases = new Map<string, string>();
  private listeners = new Map<string, Set<() => void>>();
  private allListeners = new Set<() => void>();
  private snapshot: readonly StoredSubagent[] = [];

  /**
   * The call a child is stored under. One spawn reaches the transcript twice: as the spawn call and
   * as its activity. The activity names the same call after `subagent-activity:`, so the spawn's id
   * stays the child's identity even after the server retires the duplicate. A summary that first
   * identifies another call for an already known agent resolves to that same entry before its write.
   */
  canonical(toolCallId: string, agentId?: string): string {
    let own = toolCallId;
    while (own.startsWith(ACTIVITY_PREFIX) && own.length > ACTIVITY_PREFIX.length) own = own.slice(ACTIVITY_PREFIX.length);
    const seen = new Set<string>();
    let id = own;
    while (!seen.has(id)) {
      seen.add(id);
      const alias = this.aliases.get(id);
      if (!alias) break;
      id = alias;
    }
    // A repaired call may now name a different child. Its old alias describes the old agent, not
    // the new claim; resolve the latter independently before choosing its summary watermark.
    const held = this.values.get(id);
    if (agentId && held?.agentId && held.agentId !== agentId) id = own;
    return (agentId ? this.twin(agentId, id)?.[0] : undefined) ?? id;
  }

  get(toolCallId: string): SubagentTranscript | undefined { return this.values.get(this.canonical(toolCallId)); }
  getSnapshot = (): readonly StoredSubagent[] => this.snapshot;

  subscribeAll = (listener: () => void): (() => void) => {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  };

  subscribe(toolCallId: string, listener: () => void): () => void {
    // Keep the requested call, not today's canonical id: aliases can split, merge or disappear on
    // reset while a panel remains open. Each write resolves subscriptions against the current map.
    const listeners = this.listeners.get(toolCallId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(toolCallId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(toolCallId);
    };
  }

  set(toolCallId: string, transcript: SubagentTranscript): void {
    let own = toolCallId;
    while (own.startsWith(ACTIVITY_PREFIX) && own.length > ACTIVITY_PREFIX.length) own = own.slice(ACTIVITY_PREFIX.length);
    let id = this.canonical(own);
    let held = this.values.get(id);
    if (own !== id && transcript.agentId && held?.agentId && held.agentId !== transcript.agentId) {
      // Only detach this call's claim. The former canonical entry and its other aliases still
      // belong to the old child; neither its history nor its listeners move to the new one.
      this.aliases.delete(own);
      id = own;
      held = this.values.get(id);
    }
    // An activity announcement names the same spawn after a prefix. While the spawn's own row is
    // held, its lane is the one the server streams, so the announcement does not move the entry.
    const incoming = held?.lane && toolCallId.startsWith(ACTIVITY_PREFIX) ? { ...transcript, lane: held.lane } : transcript;
    // The same child announced under another call id joins the entry already held for its agent.
    const twin = incoming.agentId ? this.twin(incoming.agentId, id) : undefined;
    if (twin) {
      this.values.delete(id);
      this.aliases.set(id, twin[0]);
      this.write(twin[0], merged(twin[1], incoming));
      return;
    }
    this.write(id, incoming);
  }

  clear(): void {
    if (!this.values.size) return;
    this.values.clear();
    this.aliases.clear();
    this.snapshot = [];
    this.listeners.forEach((listeners) => listeners.forEach((listener) => listener()));
    this.allListeners.forEach((listener) => listener());
  }

  private twin(agentId: string, except: string): [string, SubagentTranscript] | undefined {
    for (const [id, transcript] of this.values) if (id !== except && transcript.agentId === agentId) return [id, transcript];
    return undefined;
  }

  private write(id: string, transcript: SubagentTranscript): void {
    this.values.set(id, transcript);
    this.snapshot = [...this.values].map(([toolCallId, value]) => ({ toolCallId, transcript: value }));
    // A panel subscribed under a retired duplicate still reads this child through `get`, even when
    // the duplicate it named has since moved to another entry.
    for (const [call, listeners] of this.listeners) if (this.canonical(call) === id) listeners.forEach((listener) => listener());
    this.allListeners.forEach((listener) => listener());
  }
}

/** Generic backend role labels carry no task name. */
export function specificSubagentLabel(value: string | undefined): string | undefined {
  const label = value?.trim();
  return label && !['generalpurpose', 'subagent'].includes(label.toLowerCase().replace(/[-_\s]/g, '')) ? label : undefined;
}

/** What the Task call that spawned this subagent asked for, when that call is still in the timeline. */
export interface SubagentBrief { title: string; detail?: string; }

/** The prompt the CLI handed the subagent, read from its own transcript as a fallback label. */
export function promptFromTranscript(events: readonly WorkbenchEvent[]): string {
  for (const event of events) {
    if (event.type !== 'user_message_chunk') continue;
    const text = chunkText(event);
    if (text.trim()) return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  }
  return '';
}

/**
 * A subagent's name: what the call asked for, else what its own transcript says it is doing.
 * Its tool row and the aside list share this so one subagent never has two names.
 */
export function subagentTitle(entry: StoredSubagent, brief?: SubagentBrief): string {
  return specificSubagentLabel(brief?.title) || specificSubagentLabel(entry.transcript.title)
    || specificSubagentLabel(promptFromTranscript(entry.transcript.events)) || specificSubagentLabel(entry.transcript.subagentType) || i18n._(msg`子 Agent`);
}

/** A job status update wakes only the tool card whose toolCallId owns that job. */
export class NativeJobStore {
  private values = new Map<string, NativeJob>();
  private listeners = new Map<string, Set<() => void>>();
  private allListeners = new Set<() => void>();
  private snapshot: readonly NativeJob[] = [];

  get(toolCallId: string): NativeJob | undefined { return this.values.get(toolCallId); }
  getSnapshot = (): readonly NativeJob[] => this.snapshot;

  subscribeAll = (listener: () => void): (() => void) => {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  };

  subscribe(toolCallId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(toolCallId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(toolCallId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(toolCallId);
    };
  }

  set(job: NativeJob): void {
    this.values.set(job.toolCallId, job);
    this.snapshot = [...this.values.values()];
    this.listeners.get(job.toolCallId)?.forEach((listener) => listener());
    this.allListeners.forEach((listener) => listener());
  }

  clear(): void {
    if (!this.values.size) return;
    const ids = [...this.values.keys()];
    this.values.clear();
    this.snapshot = [];
    for (const id of ids) this.listeners.get(id)?.forEach((listener) => listener());
    this.allListeners.forEach((listener) => listener());
  }
}

/**
 * A subagent to show. `event` is the tool call that spawned it, when the caller has it at hand: a
 * nested child's call lives in its parent's transcript, not in the conversation timeline.
 */
export interface SubagentTarget { toolCallId: string; running?: boolean; event?: WorkbenchEvent; }

/** Opens a subagent's own transcript in a dialog when the conversation can provide one. */
export interface SubagentRenderer { open: (target: SubagentTarget) => void; }

export const SubagentContext = createContext<SubagentRenderer | null>(null);
export const SubagentStoreContext = createContext<SubagentStore | null>(null);
export const NativeJobStoreContext = createContext<NativeJobStore | null>(null);

export function useSubagentTranscript(toolCallId: string): SubagentTranscript | undefined {
  const store = useContext(SubagentStoreContext);
  return useSyncExternalStore(
    (listener) => store ? store.subscribe(toolCallId, listener) : () => undefined,
    () => store?.get(toolCallId),
    () => store?.get(toolCallId),
  );
}

/** Whether the backend reports this subagent working, `undefined` while it has said nothing. */
export function useSubagentRunning(toolCallId: string): boolean | undefined {
  const store = useContext(SubagentStoreContext);
  return useSyncExternalStore(
    (listener) => store && toolCallId ? store.subscribe(toolCallId, listener) : () => undefined,
    () => toolCallId ? store?.get(toolCallId)?.running : undefined,
    () => toolCallId ? store?.get(toolCallId)?.running : undefined,
  );
}

/**
 * How many subagents the backend reports still working (`running === true`). A primitive selector,
 * so a transcript growing does not re-render the caller; only the count changing does. `NativeJob`s
 * are not counted: the server's layered stop ends the main turn and background agents, not shell jobs.
 */
export function useRunningSubagentCount(store: SubagentStore): number {
  const count = () => store.getSnapshot().filter((entry) => entry.transcript.running === true).length;
  return useSyncExternalStore(store.subscribeAll, count, count);
}

export function useNativeJob(toolCallId: string): NativeJob | undefined {
  const store = useContext(NativeJobStoreContext);
  return useSyncExternalStore(
    (listener) => store ? store.subscribe(toolCallId, listener) : () => undefined,
    () => store?.get(toolCallId),
    () => store?.get(toolCallId),
  );
}
