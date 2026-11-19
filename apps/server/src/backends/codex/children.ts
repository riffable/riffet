import type { LaneWriter, SubagentBinding } from '../../journal/ingest.js';
import type { SyncLane } from '../../../../../packages/contracts/src/sync.js';
import { decode, namedThreads, spawnedThread, type LaneState } from './lane-state.js';
import { isProvisionalItemId, subagentName, subagentToolCallId } from './transcript.js';
import type { RpcItem } from './types.js';
import { str } from './util.js';

/*
 * The subagent threads of the conversation and the lanes they are read into (G9). It owns one observer per
 * native thread and the set of lanes whose durable bindings were restored.
 *
 * It does not read a thread: `CodexTranscriptSource` pages the children it lists. It does not follow the
 * conversation's thread either; the source clears it when another thread is followed.
 */

/** Subagents within subagents followed; the app-server's own limit is far below. */
export const CHILD_DEPTH = 8;

/** A subagent thread and its lane; `owner` names the log that spawned it, resolved against the writers of the current read. */
export interface Child { toolCallId: string; threadId: string; writer: LaneWriter; owner: { lane: SyncLane; scratch: boolean }; depth: number; readAt: number; due: boolean }

/** What `CodexChildren` needs from the transcript source that owns it. */
export interface CodexChildrenContext {
  /** The main lane's writer of the read in progress. */
  main(): LaneWriter | undefined;
  /** The thread the conversation follows now. */
  thread(): string | undefined;
}

export class CodexChildren {
  /** One observer per native thread, regardless of how many items announce its creation. */
  private readonly children = new Map<string, Child>();
  private readonly restoredBindings = new Set<string>();

  constructor(private readonly context: CodexChildrenContext) {}

  clear(): void {
    this.children.clear();
    this.restoredBindings.clear();
  }

  get(threadId: string): Child | undefined { return this.children.get(threadId); }

  values(): Child[] { return [...this.children.values()]; }

  /** The child thread's next read is due: something asked for it. */
  markDue(threadId: string): void {
    const child = this.children.get(threadId);
    if (child) child.due = true;
  }

  /** A spawning item gets its lane (G9); a later call naming a known child has it read again. */
  noteChildren(w: LaneWriter, item: RpcItem, depth: number, flush: () => void): void {
    const spawned = spawnedThread(item);
    const toolCallId = subagentToolCallId(item);
    if (spawned && toolCallId && !isProvisionalItemId(toolCallId) && depth < CHILD_DEPTH) {
      flush();
      const known = this.children.get(spawned);
      const info = item.type === 'collabAgentToolCall'
        ? { title: str(item.description) ?? str(item.prompt)?.split('\n')[0], model: str(item.model), subagentType: str(item.agentRole) }
        : known ? {} : { title: subagentName(item), model: str(item.model) };
      this.adopt(w, toolCallId, spawned, depth + 1, info);
    }
    for (const threadId of namedThreads(item)) {
      const child = this.children.get(threadId);
      if (child) child.due = true;
    }
  }

  private adopt(spawner: LaneWriter, toolCallId: string, threadId: string, depth: number, info: { title?: string; model?: string; subagentType?: string } = {}): Child {
    const known = this.children.get(threadId);
    toolCallId = known?.toolCallId ?? toolCallId;
    const writer = spawner.child(toolCallId, threadId, info);
    const owner = this.ownerOf(spawner);
    if (known && known.threadId === threadId) { known.writer = writer; known.owner = owner; known.due = true; return known; }
    const child: Child = { toolCallId, threadId, writer, owner, depth, readAt: 0, due: true };
    this.children.set(threadId, child);
    return child;
  }

  /** Durable bindings restore finished children too: a later follow-up can wake the same thread. */
  restoreAgents(w: LaneWriter, state: LaneState | undefined, depth: number): void {
    if (depth >= CHILD_DEPTH) return;
    const owner = this.ownerOf(w);
    const key = `${owner.lane}:${owner.scratch}:${w.generation}`;
    if (!this.restoredBindings.has(key)) {
      const bindings = new Map<string, SubagentBinding[]>();
      for (const binding of w.subagents) {
        const group = bindings.get(binding.agentId) ?? [];
        group.push(binding);
        bindings.set(binding.agentId, group);
      }
      for (const [threadId, group] of bindings) {
        // Prefer the original spawn when upgrading an older log that stored both announcements.
        const primary = group.find(binding => !binding.toolCallId.startsWith('subagent-activity:')) ?? group[0]!;
        const known = this.children.has(threadId);
        const child = this.adopt(w, primary.toolCallId, threadId, depth + 1, primary);
        const stored = decode(child.writer.cursor);
        // A finished child's stored transcript is ready already. Restore its observer so a
        // follow-up can wake it, without rereading every finished thread on the first pull.
        if (!known && stored?.phase === 'ready' && !stored.open && !state?.agents?.some(([, id]) => id === threadId)) {
          child.due = false;
          child.readAt = Date.now();
        }
        for (const binding of group) if (binding.toolCallId !== child.toolCallId) w.retireSubagent(binding.toolCallId, child.toolCallId);
      }
      this.restoredBindings.add(key);
    }
    for (const [toolCallId, threadId] of state?.agents ?? []) if (!this.children.has(threadId)) this.adopt(w, toolCallId, threadId, depth + 1);
  }

  /** The subagents spawned in `w` that are still running: their lanes are read again after a restart. */
  agentsOf(w: LaneWriter): Array<[string, string]> {
    const agents: Array<[string, string]> = [];
    for (const child of this.children.values()) {
      const owner = this.ownerOf(w);
      if (child.owner.lane !== owner.lane || child.owner.scratch !== owner.scratch) continue;
      const state = decode(child.writer.cursor);
      if (!state || state.phase === 'importing' || state.open) agents.push([child.toolCallId, child.threadId]);
    }
    return agents;
  }

  /** Which log `w` is: a lane's own, or main's scratch window. */
  ownerOf(w: LaneWriter): Child['owner'] {
    const main = this.context.main();
    return { lane: w.lane, scratch: w.lane === 'main' && main !== undefined && main !== w && main.scratch === w };
  }

  /** The writer of a log in the current read. */
  writerOf(where: Child['owner']): LaneWriter | undefined {
    const main = this.context.main();
    if (where.lane === 'main') return where.scratch ? main?.scratch : main;
    for (const child of this.children.values()) if (child.writer.lane === where.lane) return child.writer;
    return undefined;
  }

  /** The thread a lane reads: the conversation's for main and its window, the subagent's for a child lane. */
  threadOf(w: LaneWriter): string | undefined {
    for (const child of this.children.values()) if (child.writer === w) return child.threadId;
    return this.context.thread();
  }
}
