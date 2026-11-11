import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import type { ChatMessage } from '../../auxiliary/gateway.js';
import { estimateTokens } from '../../metrics/tokens.js';

/*
 * A quick chat's own record (docs/QUICK-CHAT.md): one JSONL file per conversation, appended and never
 * rewritten. Each record names its parent, so the file is already a message tree; the workbench only
 * ever follows the newest branch, and a fork starts a new conversation instead.
 *
 * A turn is a `user` record and the `assistant` record that settles it, or a single `clear` record,
 * which ends the context the model sees. A `summary` record belongs to no turn: it stands in for the
 * turns up to `upTo` once they no longer fit, and nothing shows it.
 */

export type ChatTurnStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

interface RecordBase { id: string; parentId?: string; turnId: string; runId?: string; at: string }
export type ChatRecord =
  /** `attachments`: uploads the turn carried, read again from the workbench's store for every turn that sends them. */
  | RecordBase & { kind: 'user'; text: string; commandId: string; attachments?: ChatAttachment[] }
  /** `dropped`: earlier turns the token budget left out of what the model saw. */
  | RecordBase & { kind: 'assistant'; text: string; reasoning?: string; status: ChatTurnStatus; error?: string; model?: string; dropped?: number }
  | RecordBase & { kind: 'clear'; commandId: string }
  | { kind: 'summary'; id: string; at: string; upTo: string; text: string };

export type TurnRecord = Exclude<ChatRecord, { kind: 'summary' }>;
export interface ChatAttachment { id: string; name: string; mimeType: string; width?: number; height?: number }

/** Records in file order; a line that does not parse is left out. */
export function readRecords(file: string): ChatRecord[] {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: ChatRecord[] = [];
  const lines = text.split('\n');
  lines.forEach(line => {
    if (!line.trim()) return;
    // A torn line is skipped: the last one may still be being written, any other was left by a crash and written past.
    try { records.push(JSON.parse(line) as ChatRecord); } catch { /* see above */ }
  });
  return records;
}

export function appendRecord(file: string, record: ChatRecord): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // A write a crash cut short leaves a torn last line; starting a fresh line keeps it from swallowing this record.
  appendFileSync(file, `${endsTorn(file) ? '\n' : ''}${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function endsTorn(file: string): boolean {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return false; }
  try {
    const { size } = fstatSync(fd);
    if (!size) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally { closeSync(fd); }
}

/** The answered turns since the last `clear`, oldest first, with the record that ends each. */
export function turnsSince(records: readonly ChatRecord[], from: number): Array<{ end: string; user: string; assistant: string }> {
  const turns: Array<{ end: string; user: string; assistant: string }> = [];
  let question: string | undefined;
  for (const record of records.slice(from)) {
    if (record.kind === 'user') question = withAttachmentNames(record);
    else if (record.kind === 'assistant') {
      if (question !== undefined && record.text.trim()) turns.push({ end: record.id, user: question, assistant: record.text });
      question = undefined;
    }
  }
  return turns;
}

/** Where the context starts: after the last `clear`, and after what the newest summary since then covers. */
export function contextStart(records: readonly ChatRecord[]): { from: number; summary?: string } {
  const cleared = records.findLastIndex(record => record.kind === 'clear') + 1;
  for (let index = records.length - 1; index >= cleared; index -= 1) {
    const record = records[index]!;
    if (record.kind !== 'summary') continue;
    const covered = records.findIndex(item => item.id === record.upTo);
    if (covered >= cleared) return { from: covered + 1, summary: record.text };
  }
  return { from: cleared };
}

/**
 * What the model is sent: the turns since the last `clear` (or the summary that stands in for the
 * oldest of them), newest kept first until `budget` tokens are spent, then `next`. A turn that
 * produced no answer is left out, so roles still alternate.
 */
export function contextOf(records: readonly ChatRecord[], next: string, budget: number): { messages: ChatMessage[]; dropped: number; summary?: string } {
  const { from, summary } = contextStart(records);
  const turns: Array<[ChatMessage, ChatMessage]> = [];
  let question: string | undefined;
  for (const record of records.slice(from)) {
    // Earlier turns go back by name only: their files were read when they were asked about.
    if (record.kind === 'user') question = withAttachmentNames(record);
    else if (record.kind === 'assistant') {
      if (question !== undefined && record.text.trim()) turns.push([{ role: 'user', content: question }, { role: 'assistant', content: record.text }]);
      question = undefined;
    }
  }
  let spent = estimateTokens(next) + (summary ? estimateTokens(summary) : 0);
  let kept = turns.length;
  while (kept > 0) {
    const [user, assistant] = turns[kept - 1]!;
    const cost = estimateTokens(user.content) + estimateTokens(assistant.content);
    if (spent + cost > budget) break;
    spent += cost;
    kept -= 1;
  }
  return { messages: [...turns.slice(kept).flat(), { role: 'user', content: next }], dropped: kept, ...(summary ? { summary } : {}) };
}

function withAttachmentNames(record: Extract<ChatRecord, { kind: 'user' }>): string {
  const names = record.attachments?.map(attachment => attachment.name) ?? [];
  return names.length ? `${record.text}\n\n[${names.join(', ')}]` : record.text;
}

export const userEventId = (record: TurnRecord) => `${record.id}:user`;
export const answerEventId = (assistantId: string, part: 'text' | 'reasoning') => `${assistantId}:${part}`;

/** The events of one record, as the timeline reads them. */
export function recordEvents(sessionId: string, record: ChatRecord): NativeWorkbenchEvent[] {
  if (record.kind === 'summary') return [];
  const base = { sequence: 0, sessionId, nativeTurnId: record.turnId, createdAt: record.at, ...(record.runId ? { runId: record.runId } : {}) };
  // `/clear` stays in the transcript as it was typed: the line the context starts over at.
  if (record.kind !== 'assistant') {
    return [{ ...base, type: 'user_message_chunk', nativeId: userEventId(record),
      data: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: record.kind === 'clear' ? '/clear' : record.text }, commandId: record.commandId,
        ...(record.kind === 'user' && record.attachments?.length ? { attachments: record.attachments.map(attachment => ({ ...attachment, type: attachment.mimeType.startsWith('image/') ? 'image' : 'file' })) } : {}) } }];
  }
  const events: NativeWorkbenchEvent[] = [];
  if (record.reasoning) events.push(answerEvent(base, record.id, 'reasoning', record.reasoning));
  if (record.text) events.push(answerEvent(base, record.id, 'text', record.text));
  // How a turn that did not complete ended, in the transcript itself, as every provider's reads.
  const outcome = record.status === 'failed' ? { type: 'run_failed', data: { error: record.error ?? 'The model could not answer' } }
    : record.status === 'cancelled' ? { type: 'run_cancelled', data: {} }
    : record.status === 'interrupted' ? { type: 'run_interrupted', data: record.error ? { reason: record.error } : {} }
    : undefined;
  if (outcome) events.push({ ...base, type: outcome.type, nativeId: `${record.id}:outcome`, data: { sessionUpdate: outcome.type, ...outcome.data } });
  return events;
}

export function answerEvent(base: Omit<NativeWorkbenchEvent, 'type' | 'nativeId' | 'data'>, assistantId: string, part: 'text' | 'reasoning', text: string): NativeWorkbenchEvent {
  const type = part === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk';
  return { ...base, type, nativeId: answerEventId(assistantId, part),
    data: { sessionUpdate: type, content: { type: 'text', text }, ...(part === 'reasoning' ? { channel: 'thinking' } : {}) } };
}
