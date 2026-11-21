import type { NativeBackendId } from './agent-ids.js';

/*
 * 任务 (docs/TASK-BOARD.md §4): a piece of work the owner tracks across conversations. The code name
 * is `WorkItem` because `Task` already names a project's build processes (docs/TASKS.md).
 *
 * A work item owns no conversation; a conversation points at it through `Session.workItemId`. What a
 * work item is doing right now (running, waiting, failed, new results) is not stored here: clients
 * derive it from those conversations with `session-attention.ts`, as the sidebar does.
 */

/** `done` is only ever set by the owner; an agent can at most ask for review. */
export const WORK_ITEM_STATUSES = ['todo', 'doing', 'watching', 'review', 'done', 'cancelled'] as const;
export type WorkItemStatus = typeof WORK_ITEM_STATUSES[number];

/** Optional observation settings while a task sits in `watching` (docs/TASK-BOARD.md §4.1). */
export interface WorkItemWatch {
  /** ISO timestamp when this watching item should resurface in the inbox; omitted for open-ended manual watching. */
  until?: string;
  /** What the owner is waiting on or observing. */
  note?: string;
  /** Optional linked AssistantDelegation id for automated monitoring. */
  delegationId?: string;
}

/**
 * Who works on it: an agent, or the owner themself. An agent's `profileId` and `model` (with the composer's
 * parameters, `model[effort=high]`) are what its conversations start on; unset, the agent's own defaults.
 */
export type WorkItemAssignee = { kind: 'agent'; backendId: NativeBackendId; profileId?: string; model?: string } | { kind: 'owner' };

export interface WorkItem {
  id: string;
  /** `#128`: allocated once per server, never reused. */
  number: number;
  title: string;
  /** Markdown: the goal and its background. */
  description?: string;
  /** What done means, one line each. A submission answers them in order. */
  criteria?: string[];
  status: WorkItemStatus;
  assignee: WorkItemAssignee;
  /** Unset for work that belongs to no project yet. */
  projectId?: string;
  /** One level only: a parent's parent is rejected. */
  parentId?: string;
  /**
   * Tasks that must be `done` before this one starts (docs/TASK-BOARD.md §4.4), by id. 开始 on an item with any
   * of them still open moves it to `doing` without a conversation; the server opens one when the last is done.
   */
  blockedBy?: string[];
  /**
   * When 开始 was asked while a prerequisite was open: the task waits, and the server opens its first conversation once
   * they are all done. Cleared when a conversation joins it or it leaves `doing`.
   */
  startQueued?: string;
  labels: string[];
  /**
   * The conversation whose title this one follows: set when the item was created with that
   * conversation, cleared once anyone edits the title. Clients show that conversation's current
   * title when they hold it, so a generated title arrives without a work item write.
   */
  titleSessionId?: string;
  /**
   * How it came to be. `composer`: with the first message of a conversation, before only the board,
   * the 助理 and 转为任务 made tasks; no longer created, and those left without activity were removed;
   * `assistant`: planned by the 助理, waiting in its conversation for 开始 while still 待办.
   */
  source: 'board' | 'composer' | 'session' | 'assistant';
  /** Questions its conversations asked (`task_ask`) that nobody has answered yet, oldest first. */
  questions?: WorkItemQuestion[];
  /** The latest submission (`task_submit`); kept after review so the panel can show what was delivered. */
  submission?: WorkItemSubmission;
  /**
   * Set by the 助理's supervision when it could not move the task on (docs/TASK-BOARD.md §3): its
   * judgment, for the inbox's 推不动. Cleared when the task's conversation runs again or the owner acts.
   */
  stuck?: { note: string; at: string };
  /** Observation metadata when `status` is `watching`. */
  watch?: WorkItemWatch;
  /** The latest check of a submission by another Agent (docs/TASK-BOARD.md §6.1). */
  verification?: WorkItemVerification;
  /** When `status` last changed. */
  statusAt: string;
  createdAt: string;
  updatedAt: string;
}

/** A question a conversation put to the owner through `task_ask`; the answer goes back to it as a message. */
export interface WorkItemQuestion {
  id: string;
  sessionId: string;
  text: string;
  /** Choices the agent offered; the owner may still answer in their own words. */
  options?: string[];
  at: string;
}

/**
 * A command a conversation ran, read by the server from the conversation's own tool events, never
 * from what the agent says about it. `exitCode` when the CLI reports one; otherwise `result` is the
 * CLI's own success or failure, or `unknown`.
 */
export interface WorkItemCommand {
  command: string;
  result: 'ok' | 'failed' | 'unknown';
  exitCode?: number;
  sessionId: string;
  at: string;
}

/**
 * What the server collected when work was submitted: the files the conversations changed through
 * their edit tools (edits made by shell commands are not seen) and the commands they ran since the
 * previous submission, latest last.
 */
export interface WorkItemEvidence {
  files: string[];
  commands: WorkItemCommand[];
}

export interface WorkItemSubmission {
  sessionId: string;
  at: string;
  /** The agent's own account. */
  summary: string;
  /** The criteria as they were when submitted, each with the agent's word on it. */
  criteria: Array<{ text: string; met?: boolean; note?: string }>;
  evidence: WorkItemEvidence;
}

/**
 * A read-only check of a submission by the Agent set as 核验 (`AppSettings.workItems.verifier`): a call made on
 * behalf of the submitting conversation (docs/AGENT-CALLS.md), whose answer goes on the task and never back to it.
 */
export interface WorkItemVerification {
  /** The called conversation, listed under the submitting one; absent when it could not be opened (`failed`, `text` says why). */
  sessionId?: string;
  /** The submission it checks (`WorkItemSubmission.at`). */
  submittedAt: string;
  backendId: NativeBackendId;
  model?: string;
  state: 'running' | 'done' | 'failed';
  /** From the first line of its answer; `unclear` when it did not say. */
  verdict?: 'pass' | 'fail' | 'unclear';
  /** Its answer, clipped to `WORK_ITEM_LIMITS.summary`. */
  text?: string;
  at: string;
  endedAt?: string;
}

export interface WorkItemCreate {
  /** A client-made id; a retried create with the same id returns the first result. */
  id?: string;
  title: string;
  description?: string;
  criteria?: string[];
  status?: Extract<WorkItemStatus, 'todo' | 'doing' | 'watching'>;
  assignee?: WorkItemAssignee;
  projectId?: string;
  parentId?: string;
  blockedBy?: string[];
  labels?: string[];
  watch?: WorkItemWatch;
}

/** Each field given replaces its own; `null` clears an optional one. Editing `title` stops it following a conversation. */
export interface WorkItemPatch {
  title?: string;
  description?: string | null;
  criteria?: string[];
  status?: WorkItemStatus;
  assignee?: WorkItemAssignee;
  projectId?: string | null;
  parentId?: string | null;
  blockedBy?: string[] | null;
  labels?: string[];
  watch?: WorkItemWatch | null;
}

/** The activity of a work item, oldest first. */
export type WorkItemEvent = { id: string; workItemId: string; at: string } & (
  | { kind: 'created'; source: WorkItem['source'] }
  | { kind: 'status'; from: WorkItemStatus; to: WorkItemStatus }
  /** A conversation was attached (`sessionId`) or detached (`detached: true`). */
  | { kind: 'session'; sessionId: string; detached?: true }
  | { kind: 'comment'; text: string }
  | { kind: 'question'; question: WorkItemQuestion }
  /** The owner answered `questionId`; the text went to the conversation that asked. */
  | { kind: 'answer'; questionId: string; text: string }
  | { kind: 'submit'; submission: WorkItemSubmission }
  /** Sent back for more work with the owner's reasons (or the 助理's, `by`), which went to the conversation as a message. */
  | { kind: 'rework'; sessionId: string; text: string; by?: 'assistant' }
  /** The 助理's supervision moved a stopped conversation on: 「继续」, or an answer to its question. */
  | { kind: 'nudge'; sessionId: string; text: string }
  /** The 助理's supervision could not move it on; the note is its judgment, shown in the inbox. */
  | { kind: 'stuck'; note: string }
  /** The 核验 Agent finished checking a submission. */
  | { kind: 'verify'; verification: WorkItemVerification });

/** `POST /api/work-items/:id/questions/:questionId/answer`. `commandId` makes a retry send the answer once. */
export interface WorkItemAnswer { text: string; commandId: string }

/** `POST /api/work-items/:id/rework`: back to `doing`, with what to change sent to its latest conversation. */
export interface WorkItemRework { text: string; commandId: string }

/**
 * One day of the north star (docs/TASK-BOARD.md §1), in the asking client's time zone: what reached
 * the owner (approvals and questions a conversation waited on, `task_ask` questions, work submitted
 * for review) and how long conversations stood waiting on the owner, by the day the wait began.
 */
export interface NorthStarDay { date: string; decisions: number; questions: number; reviews: number; waitMs: number }

/** `GET /api/work-items/north-star?from&to&tz`. `since`: when recording began; days before it are unknown, not zero. */
export interface NorthStarReport { since?: string; days: NorthStarDay[] }

/** `GET /api/work-items/:id/brief`: the first message of a conversation that starts this item. */
export interface WorkItemBrief { text: string }

/** `POST /api/work-items/:id/start`. No `sessionId`: a prerequisite is still open, and it starts when they are all done. */
export interface WorkItemStartResult { item: WorkItem; sessionId?: string }

/** The prerequisites of [item] that are not done yet, in its order; one missing from [items] counts as done. */
export function openPrerequisites(item: Pick<WorkItem, 'blockedBy'>, items: ReadonlyMap<string, WorkItem>): WorkItem[] {
  return (item.blockedBy ?? []).flatMap(id => { const other = items.get(id); return other && other.status !== 'done' ? [other] : []; });
}

/** Lightweight shell projection of a work item, carried by `/api/bootstrap` and local cache. */
export interface WorkItemSummary {
  id: string;
  number: number;
  status: WorkItemStatus;
  hasQuestion?: boolean;
  stuck?: boolean;
  watchUntil?: string;
}

export function summarizeWorkItem(item: WorkItem): WorkItemSummary {
  return {
    id: item.id,
    number: item.number,
    status: item.status,
    ...(item.questions?.length ? { hasQuestion: true } : {}),
    ...(item.stuck ? { stuck: true } : {}),
    ...(item.status === 'watching' && item.watch?.until ? { watchUntil: item.watch.until } : {}),
  };
}

/** `GET /api/work-items`, served under the work items revision (an ETag); `/api/lists/stream` pushes it as `workItems`. */
export interface WorkItemList { items: WorkItem[] }

/** `POST /api/sessions/:id/work-item`: attach to an item, make a new one from the conversation, or detach (`null`). */
export interface SessionWorkItemRequest { workItemId: string | 'new' | null }

export const WORK_ITEM_LIMITS = {
  title: 200, description: 20_000, labels: 10, label: 32, comment: 20_000,
  criteria: 10, criterion: 500, blockedBy: 10, summary: 20_000, note: 2_000, watchNote: 500, question: 4_000, options: 6, option: 200,
} as const;
