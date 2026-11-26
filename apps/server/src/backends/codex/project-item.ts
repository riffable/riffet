import type { NativeActivity, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { ACTIVITY_EVENT_TYPE } from '../../journal/activity.js';
import { messagePhase, reasoningChannel } from './drafts.js';
import { asyncQuestionReplyDisplay } from './interactions.js';
import type { CodexQuestionHistory } from './question-history.js';
import { isCodexToolItem, isFinalTurnStatus, projectToolItem, sanitizedCodexRaw, spanTime, subagentToolCallId, taskNotice, userItemText, type ItemSpan, type ObservedChanges } from './transcript.js';
import type { RpcItem, RpcTurn } from './types.js';
import { asArray, asRecord, str } from './util.js';

/**
 * One app-server thread item as transcript events: the projection the live runtime (v2) and the
 * journal's transcript source (`transcript-source.ts`) share, so both name an item's rows alike.
 * Every id is the thread, the turn and the item's own id (`<thread>:<turn>:<item>:<part>`), so a
 * re-read, a restart or the other reader finds the same entity (G2).
 */
export interface CodexItemContext {
  sessionId: string;
  /** The thread the item belongs to: the conversation's, or a subagent's. */
  threadId: string;
  runId: string;
  createdAt: string;
  /** When the item itself began and ended, where known; its rows are stamped with these instead of `createdAt`. A user message keeps `createdAt`: it opens its turn. */
  span?: ItemSpan;
  /** The workbench command a user item answers; its row is then named after the command. */
  commandId?: string;
  /** Request/answer pairs of the thread's question tools, which become one question row. */
  questions?: CodexQuestionHistory;
  /** The phase of an answer whose item does not state one, from what was streamed for it. */
  phase?(itemId: string, nativeId: string): 'commentary' | 'final_answer' | undefined;
  /** A compaction as an activity row; without it a compaction is not an event (a child's, or a reader that keeps activities apart). */
  compaction?(item: RpcItem, turn: Pick<RpcTurn, 'id' | 'startedAt' | 'status' | 'items'>, settled: boolean): NativeActivity;
  /** What a command changed in the working tree, by its tool call id (`observation.ts`). */
  observedChanges?: ObservedChanges;
  /** The text of a user message, for the conversation's first-message title. */
  onUserText?(text: string): void;
}

/**
 * What identifies one text row of a conversation: the kind of text and the words themselves.
 *
 * Used only to tell a provider's two namings of one item apart — a copy served while a turn runs
 * contains the words the written item contains, so the words are what says they are the same row.
 * Tool rows repeat legitimately within a turn and carry none, so they are never compared this way.
 */
export function rowTextKey(event: NativeWorkbenchEvent): string | undefined {
  if (event.type !== 'agent_message_chunk' && event.type !== 'agent_thought_chunk') return undefined;
  const text = str(asRecord(event.data.content)?.text);
  return text ? `${event.type}\u0000${text}` : undefined;
}

export function userMessageText(item: RpcItem): string { return userItemText(item); }

export function projectCodexItem(item: RpcItem, turn: Pick<RpcTurn, 'id' | 'startedAt' | 'status' | 'items'>, context: CodexItemContext): NativeWorkbenchEvent[] {
  const { threadId, runId, commandId } = context;
  const span = item.type === 'userMessage' ? undefined : context.span;
  const base = `${threadId}:${turn.id}:${subagentToolCallId(item) ?? item.type}`;
  const raw = sanitizedCodexRaw(item);
  const event = (nativeId: string, type: string, data: Record<string, unknown>): NativeWorkbenchEvent => ({
    sequence: 0,
    sessionId: context.sessionId,
    ...(runId ? { runId } : {}),
    type,
    data: { sessionUpdate: type, ...data },
    raw,
    createdAt: spanTime(span, type, context.createdAt),
    nativeId,
    nativeTurnId: turn.id,
  });
  const questions = !commandId ? context.questions?.project(item, threadId, base, event) : undefined;
  if (questions) return questions;
  if (item.type === 'userMessage') {
    const parts = asArray<Record<string, unknown>>(item.content);
    const text = userMessageText(item);
    const reply = asyncQuestionReplyDisplay(text);
    if (text.trim() && !reply) context.onUserText?.(text);
    const images = parts.filter(part => part.type === 'localImage' || part.type === 'image').map(part => ({ type: 'image', path: str(part.path) ?? str(part.url) }));
    const nativeId = commandId ? `${threadId}:${turn.id}:web:${commandId}:user` : `${base}:user`;
    return [event(nativeId, 'user_message_chunk', {
      content: { type: 'text', text: reply ?? text },
      ...(commandId ? { commandId } : {}),
      ...(images.length ? { attachments: images } : {}),
    })];
  }
  if (item.type === 'agentMessage') {
    const text = str(item.text) ?? '';
    const nativeId = `${base}:assistant`;
    // A committed draft is gone by the next history read. Missing/unknown history metadata must
    // not erase its known phase, and only this exact item may supply that fallback.
    const phase = messagePhase(item.phase) ?? (item.id ? context.phase?.(item.id, nativeId) : undefined);
    return text ? [event(nativeId, 'agent_message_chunk', { ...(phase ? { phase } : {}), content: { type: 'text', text } })] : [];
  }
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    const text = str(item.review) ?? '';
    if (!text.trim()) return [];
    // Both review items may share an id (including the turn id), so their parts must remain distinct.
    return item.type === 'enteredReviewMode'
      ? [event(`${base}:review:entered`, 'agent_thought_chunk', { channel: 'narration', content: { type: 'text', text } })]
      : [event(`${base}:review:result`, 'agent_message_chunk', { phase: 'final_answer', content: { type: 'text', text } })];
  }
  if (item.type === 'reasoning') {
    const summary = asArray<unknown>(item.summary).map(value => str(value) ?? '').filter(Boolean);
    const text = [...summary, ...asArray<unknown>(item.content).map(value => str(value) ?? '').filter(Boolean)].join('\n\n');
    return text ? [event(`${base}:thinking`, 'agent_thought_chunk', { channel: reasoningChannel(summary[0]), content: { type: 'text', text } })] : [];
  }
  // Historical ThreadItem.type='plan' is unstructured prose — Codex's "Proposed Plan", written in
  // planning mode. It must not reach the `plan` event, whose readers want `entries` and would drop
  // a body found there; the execution checklist is restored from the rollout's `update_plan` calls
  // instead. So it rides a tool call as Markdown, the shape Claude's `ExitPlanMode` and Cursor's
  // `CreatePlan` already use, and one renderer serves all three.
  if (item.type === 'plan') {
    const text = str(item.text) ?? '';
    return text.trim() ? [event(`${base}:plan`, 'tool_call', {
      toolCallId: `${item.id ?? 'plan'}`, toolName: 'Plan', kind: 'plan', title: 'Proposed plan', status: 'completed',
      content: [{ type: 'markdown', text }],
    })] : [];
  }
  if (item.type === 'contextCompaction' && str(item.id) && context.compaction) {
    const activity = context.compaction(item, turn, isFinalTurnStatus(turn.status));
    return [event(activity.id, ACTIVITY_EVENT_TYPE, { sessionUpdate: 'activity', activity })];
  }
  if (isCodexToolItem(item)) return projectToolItem(item, event, base, context.observedChanges);
  // TRAE CLI items Codex does not have. Each becomes the notice row other backends already use for
  // background work, rather than a turn that silently loses part of what happened.
  if (item.type === 'taskNotification') {
    const notice = taskNotice(userItemText(item));
    return notice ? [event(`${base}:task`, 'task_notification', notice)] : [];
  }
  if (item.type === 'sessionPeerMessage' && str(item.message)) {
    return [event(`${base}:peer`, 'task_notification', {
      kind: 'message', status: 'completed', title: `Message from ${str(item.sender) ?? 'another session'}`, detail: str(item.message),
    })];
  }
  if (item.type === 'worktreeSessionEntered' || item.type === 'worktreeSessionExited') {
    const worktree = asRecord(item.worktree);
    const path = str(worktree?.path) ?? str(worktree?.worktreePath) ?? str(item.originalCwd);
    return [event(`${base}:worktree`, 'task_notification', {
      kind: 'worktree', status: 'completed',
      title: item.type === 'worktreeSessionEntered' ? 'Working in a separate worktree' : 'Left the worktree',
      ...(path ? { detail: path } : {}),
    })];
  }
  if (item.type === 'terminalInteraction' && str(item.stdin)) {
    const toolCallId = item.id ?? base;
    const command = str(item.command);
    return [
      event(`${base}:call`, 'tool_call', {
        toolCallId, toolName: 'Terminal input', kind: 'execute', status: 'in_progress',
        title: command ? `Input to ${command}` : 'Input to a running process', rawInput: { stdin: item.stdin },
      }),
      event(`${base}:result`, 'tool_call_update', { toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: item.stdin } }] }),
    ];
  }
  return [];
}
