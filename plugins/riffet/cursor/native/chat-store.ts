import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NativeContext } from '@contracts';
import { isJobLogPath } from './job-log.js';
import { announcedImagePaths, imagePathFields, isImagePath, parseSteerContexts, toolImageContent } from '@riffet/plugin-api/kit';

/**
 * Read-only access to the Cursor CLI chat store (`<config>/chats/<md5(cwd)>/<chatId>/store.db`).
 *
 * The layout is internal to the CLI, so everything here is defensive: `meta` row `0` holds
 * hex-encoded JSON, blobs are content-addressed, and the latest root blob is a protobuf whose
 * field 1 lists message blob ids in order, field 5 carries the `/context` breakdown, and
 * field 13 references compaction archives whose field 4 identifies the summary they replaced.
 * Messages are AI-SDK style JSON (`{role, content}`); anything that does not parse is skipped.
 */

export interface ChatMeta {
  agentId: string;
  latestRootBlobId?: string;
  name?: string;
  createdAt?: number;
  lastUsedModel?: string;
  subagentInfo?: { parentAgentId?: string; rootParentAgentId?: string; toolCallId?: string; typeName?: string };
}

/** One compaction archive: the summary that replaced a prefix, and where that prefix ends in the expanded message list. */
export interface ChatCompaction { summaryId: string; boundary: number; summary?: string }

export interface ChatSnapshot {
  meta: ChatMeta; messageIds: string[]; context?: NativeContext; rootAvailable: boolean; contextIncomplete?: boolean; rawMessagePositions?: Map<number, number>;
  compactions?: ChatCompaction[];
  /** The step the model is still in, not yet committed as a message (see `decodeRoot`). */
  pending?: ChatMessage;
}

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature?: unknown }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args?: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result?: unknown; experimental_content?: unknown }
  | { type: string; [key: string]: unknown };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string | ChatPart[];
  providerOptions?: { cursor?: Record<string, unknown> };
}

export function workspaceChatsDir(configDir: string, cwd: string): string {
  return join(configDir, 'chats', createHash('md5').update(cwd).digest('hex'));
}

export function chatStorePath(configDir: string, cwd: string, chatId: string): string {
  return join(workspaceChatsDir(configDir, cwd), chatId, 'store.db');
}

/**
 * Keeps the chat store's persisted approval metadata in step with an explicit launch/restart choice.
 *
 * `cursor-agent --resume <chatId>` has no `--allowlist` flag: without `--force` or `--auto-review`
 * it reads `approvalMode` and `isRunEverything` straight out of `store.db` (`meta` row `0`), and if
 * `cli-config.json` has `approvalMode: "unrestricted"` its startup `wantsAutoRun` check also forces
 * `Run Everything` back on over `--auto-review` and `allowlist`.
 */
export function writeChatApproval(configDir: string | undefined, cwd: string, chatId: string | undefined, approval: string | undefined): void {
  if (!configDir || !approval) return;
  if (approval !== 'unrestricted') {
    let configPath = join(configDir, 'cli-config.json');
    let temporary: string | undefined;
    try {
      if (existsSync(configPath)) {
        if (lstatSync(configPath).isSymbolicLink()) configPath = realpathSync(configPath);
        const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.approvalMode === 'unrestricted') {
          parsed.approvalMode = 'allowlist';
          temporary = `${configPath}.${randomBytes(8).toString('hex')}.tmp`;
          writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
          renameSync(temporary, configPath);
          temporary = undefined;
        }
      }
    } catch { /* best-effort */ }
    finally { if (temporary) { try { unlinkSync(temporary); } catch { /* ignore */ } } }
  }
  if (!chatId) return;
  const path = chatStorePath(configDir, cwd, chatId);
  if (!existsSync(path)) return;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { timeout: 2000 });
    const row = db.prepare("SELECT value FROM meta WHERE key='0'").get() as { value?: string } | undefined;
    if (!row?.value) return;
    const isHex = /^[0-9a-f]+$/i.test(row.value);
    const text = isHex ? Buffer.from(row.value, 'hex').toString('utf8') : row.value;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const isRunEverything = approval === 'unrestricted';
    if (parsed.approvalMode === approval && parsed.isRunEverything === isRunEverything) return;
    parsed.approvalMode = approval;
    parsed.isRunEverything = isRunEverything;
    const serialized = JSON.stringify(parsed);
    const nextValue = isHex ? Buffer.from(serialized, 'utf8').toString('hex') : serialized;
    db.prepare("UPDATE meta SET value=? WHERE key='0'").run(nextValue);
  } catch { /* best-effort; launch flags still carry the mode */ }
  finally { try { db?.close(); } catch { /* ignore */ } }
}

type Field = [number, number | Uint8Array];

function varint(buffer: Uint8Array, start: number): [number, number] {
  let result = 0;
  let shift = 0;
  let position = start;
  for (;;) {
    if (position >= buffer.length) throw new Error('truncated varint');
    const byte = buffer[position++]!;
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [result, position];
    shift += 7;
    if (shift > 63) throw new Error('varint overflow');
  }
}

export function protoFields(buffer: Uint8Array): Field[] {
  const fields: Field[] = [];
  let position = 0;
  while (position < buffer.length) {
    const [key, next] = varint(buffer, position);
    position = next;
    const number = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) { const [value, after] = varint(buffer, position); fields.push([number, value]); position = after; }
    else if (wire === 2) {
      const [length, after] = varint(buffer, position);
      if (after + length > buffer.length) throw new Error('truncated field');
      fields.push([number, buffer.subarray(after, after + length)]);
      position = after + length;
    } else if (wire === 1) position += 8;
    else if (wire === 5) position += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

const bytesOf = (fields: Field[], number: number) => fields.filter(([n, v]) => n === number && v instanceof Uint8Array).map(([, v]) => v as Uint8Array);
const numberOf = (fields: Field[], number: number) => { const hit = fields.find(([n, v]) => n === number && typeof v === 'number'); return hit ? hit[1] as number : undefined; };

/**
 * The channel recorded in a reasoning part's signature header: `thinking` is the model's own
 * reasoning, `narration` the short summary in the user's language that the CLI shows instead.
 */
export function reasoningChannel(signature: unknown): string | undefined {
  if (typeof signature !== 'string' || !signature) return undefined;
  try {
    const envelope = bytesOf(protoFields(Buffer.from(signature, 'base64')), 2)[0];
    const header = envelope && bytesOf(protoFields(envelope), 1)[0];
    const channel = header && bytesOf(protoFields(header), 8)[0];
    return channel ? Buffer.from(channel).toString('utf8') : undefined;
  } catch { return undefined; }
}

function decodeContext(buffer: Uint8Array): NativeContext | undefined {
  // Root field 5 is `ConversationTokenDetails`: f1 = used_tokens, f2 = max_tokens, f3 =
  // `PromptTokenBreakdownSnapshot` (f1 = total_used_tokens, f2 = max_tokens, f3 = categories[]).
  // Cursor CLI's own meter reads the outer f1/f2; after compaction or a reset the inner snapshot
  // can lag behind or linger after outer f1/f2 return to 0, so outer values always lead and a
  // mismatched inner snapshot is omitted rather than mixed with them.
  const fields = protoFields(buffer);
  const used = numberOf(fields, 1);
  const size = numberOf(fields, 2);
  if (!used || !size) return undefined;
  const detail = bytesOf(fields, 3)[0];
  if (!detail) return { used, size, breakdown: [] };
  const inner = protoFields(detail);
  const innerUsed = numberOf(inner, 1);
  const innerSize = numberOf(inner, 2);
  if ((innerUsed !== undefined && innerUsed !== used) || (innerSize !== undefined && innerSize !== size)) {
    return { used, size, breakdown: [] };
  }
  const text = (value: Uint8Array | undefined) => (value ? Buffer.from(value).toString('utf8') : '');
  const breakdown = bytesOf(inner, 3).map((entry) => {
    const item = protoFields(entry);
    return { id: text(bytesOf(item, 1)[0]), label: text(bytesOf(item, 2)[0]), tokens: numberOf(item, 3) ?? 0 };
  }).filter((item) => item.id);
  return { used, size, breakdown };
}

/** The summary a compaction left behind, without the CLI's envelope around `<summary_content>`. */
function compactionSummaryText(message: ChatMessage | undefined): string | undefined {
  if (!message) return undefined;
  const texts = typeof message.content === 'string' ? [message.content]
    : message.content.flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []));
  const text = texts.join('\n').trim();
  if (!text) return undefined;
  const inner = /<summary_content>([\s\S]*?)<\/summary_content>/.exec(text);
  return (inner ? inner[1]! : text).trim() || undefined;
}

/** A message as the CLI stores it: one JSON object, the same shape in a blob or inline in a root. */
function parseMessage(data: Uint8Array | undefined): ChatMessage | undefined {
  if (!data || data[0] !== 0x7b) return undefined;
  try {
    const value = JSON.parse(Buffer.from(data).toString('utf8')) as ChatMessage;
    return typeof value.role === 'string' && (typeof value.content === 'string' || Array.isArray(value.content)) ? value : undefined;
  } catch { return undefined; }
}

/**
 * Field 4 of a root holds the assistant step in progress, inline: its reasoning, its text and the
 * tool calls it is waiting on. It becomes a message blob only once those calls return, so a step
 * blocked on a long command, a subagent or a question for the user exists nowhere else meanwhile.
 */
export function decodeRoot(buffer: Uint8Array): { messageIds: string[]; compactionIds?: string[]; context?: NativeContext; contextIncomplete?: boolean; pending?: ChatMessage } {
  const fields = protoFields(buffer);
  const pendingMessage = parseMessage(bytesOf(fields, 4)[0]);
  const pending = pendingMessage?.role === 'assistant' ? pendingMessage : undefined;
  const messageIds = bytesOf(fields, 1).filter((value) => value.length === 32).map((value) => Buffer.from(value).toString('hex'));
  const compactionIds = bytesOf(fields, 13).filter((value) => value.length === 32).map((value) => Buffer.from(value).toString('hex'));
  const contextIncomplete = fields.some(([number, value]) => (number === 1 || number === 13)
    && (!(value instanceof Uint8Array) || value.length !== 32));
  let context: NativeContext | undefined;
  const raw = bytesOf(fields, 5)[0];
  if (raw) { try { context = decodeContext(raw); } catch { context = undefined; } }
  return { messageIds, ...(compactionIds.length ? { compactionIds } : {}), ...(context ? { context } : {}), ...(contextIncomplete ? { contextIncomplete: true } : {}), ...(pending ? { pending } : {}) };
}

export class ChatReader {
  private db: DatabaseSync | undefined;
  private readonly messages = new Map<string, { value: ChatMessage | null; bytes: number }>();
  private cachedBytes = 0;
  private readonly maxCachedMessages = 512;
  private readonly maxCachedBytes = 16 * 1024 * 1024;
  readonly metrics = { rootDecodes: 0, messageReads: 0, messageParses: 0 };

  constructor(readonly path: string) {}

  private open(): DatabaseSync | undefined {
    if (this.db) return this.db;
    if (!existsSync(this.path)) return undefined;
    try { this.db = new DatabaseSync(this.path, { readOnly: true, timeout: 2000 }); }
    catch { return undefined; }
    return this.db;
  }

  /** Whether the CLI has created this chat's store at all (it may not exist before the first turn). */
  available(): boolean {
    return existsSync(this.path);
  }

  meta(): ChatMeta | undefined {
    const db = this.open();
    if (!db) return undefined;
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key='0'").get() as { value?: string } | undefined;
      if (!row?.value) return undefined;
      const text = /^[0-9a-f]+$/i.test(row.value) ? Buffer.from(row.value, 'hex').toString('utf8') : row.value;
      const parsed = JSON.parse(text) as ChatMeta;
      return typeof parsed.agentId === 'string' ? parsed : undefined;
    } catch { return undefined; }
  }

  snapshot(meta = this.meta()): ChatSnapshot | undefined {
    if (!meta) return undefined;
    if (!meta.latestRootBlobId) return { meta, messageIds: [], rootAvailable: true };
    const root = this.blob(meta.latestRootBlobId);
    if (!root) return { meta, messageIds: [], rootAvailable: false };
    this.metrics.rootDecodes += 1;
    try {
      const { messageIds, compactionIds = [], context, contextIncomplete, pending } = decodeRoot(root);
      const current = { meta, messageIds, ...(context ? { context } : {}), ...(pending ? { pending } : {}), rootAvailable: true };
      const incomplete = () => ({ ...current, contextIncomplete: true });
      if (contextIncomplete) return incomplete();
      const archives = new Map<string, string[]>();
      if (new Set(compactionIds).size !== compactionIds.length) return incomplete();
      for (const id of compactionIds) {
        const archive = this.blob(id);
        // The root can be committed before its archive. Retry it instead of clearing history.
        if (!archive) return { meta, messageIds: [], rootAvailable: false };
        let fields: Field[];
        try { fields = protoFields(archive); } catch { return incomplete(); }
        const summaries = bytesOf(fields, 4);
        const messages = bytesOf(fields, 1);
        // Unknown layouts must keep the current transcript intact, rather than partially
        // stitching in history. Nested archive links need evidence of their CLI semantics.
        if (summaries.length !== 1 || summaries[0]!.length !== 32 || !messages.length
          || fields.some(([number, value]) => (number === 1 || number === 4) && (!(value instanceof Uint8Array) || value.length !== 32))
          || fields.some(([number]) => number === 13)) return incomplete();
        const summary = Buffer.from(summaries[0]!).toString('hex');
        if (archives.has(summary)) return incomplete();
        archives.set(summary, messages.map((value) => Buffer.from(value).toString('hex')));
      }
      const complete = (expanded: string[], positions: Map<number, number>) => {
        // A raw position is meaningful only together with its message hash. If separate
        // occurrences shared that identity in different checkpoints, no receipt can safely
        // distinguish them. Keep those occurrences visible without assigning the same receipt.
        const owners = new Map<string, number | null>();
        for (const [position, raw] of positions) {
          if (raw === position || expanded[raw] === expanded[position]) { positions.delete(position); continue; }
          const key = `${raw}:${expanded[position]}`;
          owners.set(key, !owners.has(key) || owners.get(key) === position ? position : null);
        }
        for (const [position, raw] of positions) {
          if (owners.get(`${raw}:${expanded[position]}`) !== position) positions.delete(position);
        }
        return { ...current, messageIds: expanded, ...(positions.size ? { rawMessagePositions: positions } : {}) };
      };
      const summaries = [...archives.keys()];
      const latestSummary = summaries.at(-1);
      const summaryPosition = latestSummary === undefined ? -1 : messageIds.indexOf(latestSummary);
      const summaryIds = new Set(summaries);
      // The CLI's hydrateSummaryArchives concatenates archives in their stored order. A later
      // compaction removes the earlier summary from the live prompt instead of archiving it.
      // Anchor that chronological history to the latest replacement summary in this root.
      const sequential = latestSummary !== undefined && summaryPosition >= 0
        && messageIds.lastIndexOf(latestSummary) === summaryPosition
        && summaries.slice(0, -1).every((summary) => !messageIds.includes(summary))
        && [...archives.values()].every((ids) => ids.every((id) => !summaryIds.has(id)));
      if (sequential) {
        // A compaction during a turn re-states that turn's prompt ahead of the summary, and the
        // next compaction archives the copy again. The archive already holds the prompt where it
        // was sent; keeping a copy repeats it and shifts every later position, so a receipt taken
        // before the compaction no longer finds its message.
        // Unarchived messages ahead of the first archived message in the root prefix (e.g. system
        // prompts excluded from the archive) belong before the archives; unarchived messages after
        // an archived prefix item (e.g. a task_notification hoisted ahead of the summary) belong
        // right after the archives rather than at index 0.
        const archived = new Set([...archives.values()].flat());
        const prefix = messageIds.slice(0, summaryPosition);
        const firstArchived = prefix.findIndex((id) => archived.has(id));
        const expanded = firstArchived < 0 ? [...prefix] : prefix.slice(0, firstArchived);
        const preservedAfterArchive: Array<{ id: string; raw: number }> = [];
        if (firstArchived >= 0) {
          for (let index = firstArchived; index < prefix.length; index += 1) {
            const id = prefix[index]!;
            if (!archived.has(id)) preservedAfterArchive.push({ id, raw: index });
          }
        }
        const rawMessagePositions = new Map<number, number>();
        let previousShift: number | undefined;
        const append = (id: string) => {
          const position = expanded.length;
          if (previousShift !== undefined) rawMessagePositions.set(position, position - previousShift);
          expanded.push(id);
        };
        const stitched = new Set<string>();
        const compactions: ChatCompaction[] = [];
        for (const [summaryId, ids] of archives) {
          let start = 0;
          while (start < ids.length && stitched.has(ids[start]!)) start += 1;
          ids.slice(start).forEach(append);
          ids.forEach((id) => stitched.add(id));
          const summary = compactionSummaryText(this.message(summaryId));
          compactions.push({ summaryId, boundary: expanded.length, ...(summary ? { summary } : {}) });
          // After each compaction, that entire archived prefix is replaced by one summary.
          // Only the immediately preceding root's position is proven for this archive. Do not
          // invent aliases in earlier roots that may never have contained these messages.
          previousShift = expanded.length - summaryPosition - 1;
        }
        for (const { id, raw } of preservedAfterArchive) {
          rawMessagePositions.set(expanded.length, raw);
          expanded.push(id);
        }
        if (archives.size) previousShift = expanded.length - summaryPosition - 1;
        messageIds.slice(summaryPosition + 1).forEach(append);
        return { ...complete(expanded, rawMessagePositions), ...(compactions.length ? { compactions } : {}) };
      }
      const replaced = new Set<string>();
      const expand = (ids: string[], visiting = new Set<string>()): string[] => ids.flatMap((id) => {
        const archived = archives.get(id);
        if (!archived) return [id];
        if (visiting.has(id) || replaced.has(id) || visiting.size >= 64) throw new Error('Ambiguous compaction archive boundary');
        replaced.add(id);
        visiting.add(id);
        const expanded = expand(archived, visiting);
        visiting.delete(id);
        return expanded;
      });
      // Substitute only the summary named by this root's archive. Unrelated roots and repeated
      // message occurrences stay distinct; forks never inherit history from a different branch.
      try {
        if (!archives.size) return current;
        const expanded: string[] = [];
        const rawMessagePositions = new Map<number, number>();
        for (let index = 0; index < messageIds.length; index += 1) {
          const id = messageIds[index]!;
          const position = expanded.length;
          if (!archives.has(id) && position !== index) rawMessagePositions.set(position, index);
          for (const message of expand([id])) expanded.push(message);
        }
        if (replaced.size !== archives.size) return incomplete();
        // Old web versions receipted the compacted root's positions. Keep an exact occurrence
        // crosswalk for its live tail, without pairing identical blobs from other positions.
        return complete(expanded, rawMessagePositions);
      }
      catch { return incomplete(); }
    }
    catch { return { meta, messageIds: [], rootAvailable: false }; }
  }

  /** `bytes` is the size of the stored blob, for a reader that bounds how much it reads at once. */
  readMessage(id: string): { status: 'ok'; message: ChatMessage; bytes: number } | { status: 'missing' | 'invalid' } {
    const cached = this.messages.get(id);
    if (cached !== undefined) {
      this.messages.delete(id);
      this.messages.set(id, cached);
      return cached.value ? { status: 'ok', message: cached.value, bytes: cached.bytes } : { status: 'invalid' };
    }
    this.metrics.messageReads += 1;
    const data = this.blob(id);
    if (data && data[0] === 0x7b) this.metrics.messageParses += 1;
    const parsed = parseMessage(data) ?? null;
    // Blobs are content-addressed, so a missing blob may still arrive later; only cache hits and parse failures.
    // The LRU is byte-bounded because one cached message may contain a large tool result.
    if (data && data.byteLength <= this.maxCachedBytes) {
      this.messages.set(id, { value: parsed, bytes: data.byteLength });
      this.cachedBytes += data.byteLength;
      while (this.messages.size > this.maxCachedMessages || this.cachedBytes > this.maxCachedBytes) {
        const oldest = this.messages.keys().next().value as string | undefined;
        if (!oldest) break;
        const removed = this.messages.get(oldest);
        if (removed) this.cachedBytes -= removed.bytes;
        this.messages.delete(oldest);
      }
    }
    if (!data) return { status: 'missing' };
    return parsed ? { status: 'ok', message: parsed, bytes: data.byteLength } : { status: 'invalid' };
  }

  message(id: string): ChatMessage | undefined {
    const result = this.readMessage(id);
    return result.status === 'ok' ? result.message : undefined;
  }

  private blob(id: string): Uint8Array | undefined {
    const db = this.open();
    if (!db) return undefined;
    try {
      const row = db.prepare('SELECT data FROM blobs WHERE id=?').get(id) as { data?: Uint8Array } | undefined;
      return row?.data;
    } catch { return undefined; }
  }

  close(): void {
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = undefined;
    this.messages.clear();
    this.cachedBytes = 0;
  }
}

/* ---------------------------------------------------------------- transcript mapping */

export interface TranscriptEvent {
  type: string;
  runId?: string;
  nativeTurnId?: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface MessageRecord { id: string; message: ChatMessage; seenAt?: string; }

const TEXT_LIMIT = 24 * 1024;
const FILE_LIMIT = 256 * 1024;

/**
 * The CLI's own words for a backgrounded shell. A job's id, its log file and its completion all
 * arrive as prose inside a tool result, so they are read here once instead of in the interface.
 */
const JOB_STARTED = /Shell ID:\s*(\d+)/i;
const JOB_OUTPUT_PATH = /(?:output_file_path:|Output will be written to)\s*(\S+\.txt)/i;
const JOB_DONE = /Task completed in (\d+)ms with exit code:\s*(-?\d+)/i;
const JOB_PENDING = /timed out|still running|not (?:yet )?completed|did not complete/i;
const JOB_PATTERN = /Pattern matched:\s*([^\n]*)/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
/**
 * Drop the unchanged lines around an edit, keeping the `context` lines the diff view shows. The
 * view only renders those plus "N 行未改动" gaps, so shipping both whole files would make every
 * edit cost up to twice the file size in each transcript snapshot.
 */
export function trimDiff(before: string, after: string, context = 3): { oldText: string; newText: string; lineOffset?: number; trailingLines?: number } {
  if (!before) return { oldText: before, newText: after };
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let suffix = 0;
  while (suffix < a.length - start && suffix < b.length - start && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const lineOffset = Math.max(0, start - context);
  const trailingLines = Math.max(0, suffix - context);
  if (!lineOffset && !trailingLines) return { oldText: before, newText: after };
  return {
    oldText: a.slice(lineOffset, a.length - trailingLines).join('\n'),
    newText: b.slice(lineOffset, b.length - trailingLines).join('\n'),
    ...(lineOffset ? { lineOffset } : {}),
    ...(trailingLines ? { trailingLines } : {}),
  };
}

const clip = (text: string, limit = TEXT_LIMIT) => (text.length > limit ? `${text.slice(0, limit)}\n… 已截断 ${text.length - limit} 个字符` : text);

/** `Thursday, Oct 1, 2026, 12:14 AM (UTC+8)` → ISO, or undefined when the CLI changes its format. */
export function parsePromptTimestamp(value: string): string | undefined {
  const match = /^(?:[A-Za-z]+,\s*)?([A-Za-z]{3,9} \d{1,2}, \d{4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)\s*\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[3]);
  const offset = `${hours < 0 ? '-' : '+'}${String(Math.abs(hours)).padStart(2, '0')}${match[4] ?? '00'}`;
  const date = new Date(`${match[1]} ${match[2]} GMT${offset}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

interface TaskNotification {
  timestamp?: string;
  tasks: Array<{
    kind: string;
    sourceStatus?: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
    taskId?: string;
    title: string;
    command?: string;
    detail?: string;
    exitCode?: number;
  }>;
}

const TASK_FIELDS = /^(kind|status|task_id|title|detail):\s*(.*)$/i;

/** Decode the XML escaping used when CLI command text is embedded in a notification. */
function decodeNotificationText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    const normalized = name.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    const codePoint = normalized.startsWith('#x') ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
    try { return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity; } catch { return entity; }
  });
}

function taskStatus(sourceStatus: string | undefined): TaskNotification['tasks'][number]['status'] {
  switch (sourceStatus?.trim().toLowerCase()) {
    case 'running': case 'in_progress': case 'in-progress': case 'pending': return 'running';
    case 'success': case 'succeeded': case 'completed': case 'complete': return 'completed';
    case 'error': case 'failed': case 'failure': return 'failed';
    case 'cancelled': case 'canceled': case 'aborted': case 'interrupted': return 'cancelled';
    default: return 'unknown';
  }
}

/**
 * CLI task completions are stored as a structural top-level system_notification followed by an
 * internal user_query. Recognize only the top-level prefix so a human quoting the same tags in a
 * normal user_query remains an ordinary user turn.
 */
function taskNotification(message: ChatMessage): TaskNotification | undefined {
  const texts = typeof message.content === 'string'
    ? [message.content]
    : message.content.flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []));
  for (const text of texts) {
    const prefix = /^\s*(?:<timestamp>([\s\S]*?)<\/timestamp>\s*)?<system_notification(?:\s[^>]*)?>/i.exec(text);
    if (!prefix) continue;
    const bodyStart = prefix[0].length;
    const close = /<\/system_notification\s*>/i.exec(text.slice(bodyStart));
    const body = close ? text.slice(bodyStart, bodyStart + close.index) : text.slice(bodyStart).trim();
    const timestamp = prefix[1] ? parsePromptTimestamp(prefix[1]) : undefined;
    const taskBlocks = [...body.matchAll(/<task(?:\s[^>]*)?>([\s\S]*?)<\/task\s*>/gi)];
    const tasks: TaskNotification['tasks'] = [];

    for (const block of taskBlocks) {
      const lines = block[1]!.replace(/\r\n?/g, '\n').split('\n');
      const titleLine = lines.findIndex((line) => /^\s*title:\s*/i.test(line));
      let detailLine = -1;
      lines.forEach((line, index) => {
        if (index > titleLine && /^\s*detail:\s*/i.test(line)) detailLine = index;
      });
      const headerEnd = titleLine >= 0 ? titleLine : lines.length;
      const fields = new Map<string, string>();
      for (const line of lines.slice(0, headerEnd)) {
        const field = TASK_FIELDS.exec(line);
        if (field) fields.set(field[1]!.toLowerCase(), field[2]!.trim());
      }
      const titleLines = titleLine >= 0
        ? [lines[titleLine]!.replace(/^\s*title:\s*/i, ''), ...lines.slice(titleLine + 1, detailLine >= 0 ? detailLine : undefined)]
        : [];
      const fullTitle = decodeNotificationText(titleLines.join('\n').trim());
      const rawKind = fields.get('kind')?.trim();
      const sourceStatus = fields.get('status')?.trim();
      const status = taskStatus(sourceStatus);
      const taskId = fields.get('task_id')?.trim();
      const detailText = detailLine >= 0
        ? decodeNotificationText([lines[detailLine]!.replace(/^\s*detail:\s*/i, ''), ...lines.slice(detailLine + 1)].join('\n').trim())
        : undefined;
      const rawTask = decodeNotificationText(block[1]!.trim());
      const incompleteMetadata = !fullTitle || !taskId || !sourceStatus;
      const exitMatch = detailText && /\bexit[_ ]code\s*[:=]\s*(-?\d+)/i.exec(detailText);
      const kind = rawKind || 'unknown';
      tasks.push({
        kind,
        ...(sourceStatus ? { sourceStatus } : {}),
        status,
        ...(taskId ? { taskId } : {}),
        title: fullTitle || `CLI task (${kind})`,
        ...(kind.toLowerCase() === 'shell' && fullTitle ? { command: fullTitle } : {}),
        ...(incompleteMetadata && rawTask ? { detail: rawTask } : detailText ? { detail: detailText } : {}),
        ...(exitMatch ? { exitCode: Number(exitMatch[1]) } : {}),
      });
    }

    // Preserve malformed or newly-versioned notification data as a readable unknown event.
    if (!tasks.length) {
      tasks.push({
        kind: 'unknown', status: 'unknown', title: 'CLI task notification',
        detail: decodeNotificationText(body.trim() || 'The CLI emitted an unreadable task notification.'),
      });
    }
    return { ...(timestamp ? { timestamp } : {}), tasks };
  }
  return undefined;
}

/** The visible part of a user turn. Context the CLI injects (`<user_info>`, reminders…) is dropped. */
export function userQuery(message: ChatMessage): { text: string; at?: string } | undefined {
  // System task notifications are stored as user-role messages, but their trailing user_query is
  // internal CLI text rather than a human prompt. Keep this shared predicate consistent for
  // transcript mapping, history boundaries, and native echo matching.
  if (taskNotification(message)) return undefined;
  const texts = typeof message.content === 'string'
    ? [message.content]
    : message.content.flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []));
  for (const text of texts) {
    const query = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(text);
    if (query) {
      const stamp = /<timestamp>([^<]*)<\/timestamp>/.exec(text);
      const at = stamp ? parsePromptTimestamp(stamp[1]!) : undefined;
      return { text: query[1]!, ...(at ? { at } : {}) };
    }
  }
  // A prompt the CLI took from a person carries its request id. Plain text without one is the agent
  // talking to itself: "Your previous response was interrupted. Continue…" after a broken stream, or a
  // summary restated after compaction. Neither is a message from the user, nor the start of a turn.
  if (!str(message.providerOptions?.cursor?.requestId)) return undefined;
  const plain = texts.map((text) => text.trim()).filter((text) => text && !text.startsWith('<')).join('\n\n');
  return plain ? { text: plain } : undefined;
}

interface ToolIdentity { name: string; input: Record<string, unknown>; }

function unwrap(toolName: string, args: unknown): ToolIdentity {
  const input = isRecord(args) ? args : {};
  if (toolName === 'CallDynamicTool' && typeof input.toolName === 'string') return { name: input.toolName, input: dynamicArguments(input.arguments) };
  return { name: toolName, input };
}

/** Images Cursor saved with a user turn, rather than file paths mentioned in the user's prompt. */
function userImageAttachments(message: ChatMessage): Record<string, unknown>[] {
  const parts = Array.isArray(message.content) ? message.content : [];
  const images = parts.filter(part => part.type === 'image');
  if (!images.length) return [];
  const paths = new Set<string>();
  for (const part of parts) {
    if (part.type !== 'text' || typeof part.text !== 'string') continue;
    for (const block of part.text.matchAll(/<image_files>([\s\S]*?)<\/image_files>/g)) {
      for (const line of block[1]!.split('\n')) {
        const path = /^\s*\d+\.\s+(.+?)\s*$/.exec(line)?.[1];
        if (path?.startsWith('/') && isImagePath(path)) paths.add(path);
      }
    }
  }
  return [...paths].slice(0, 64).map((path, index) => {
    const image = images[index] as Record<string, unknown> | undefined;
    const mimeType = str(image?.mimeType) ?? str(image?.mediaType);
    const extension = path.split('.').at(-1)!.toLowerCase();
    const fallback = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
    return { type: 'image', name: basename(path), path, mimeType: mimeType?.startsWith('image/') ? mimeType : fallback };
  });
}

/**
 * The CLI records a dynamic tool's arguments either as an object or as the model's JSON text,
 * verbatim. That text can carry a stray closing brace after a complete object, which the CLI itself
 * tolerates, so the leading object is read when the whole text does not parse.
 */
function dynamicArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  const parse = (text: string) => { try { return JSON.parse(text) as unknown; } catch { return undefined; } };
  let parsed = parse(value);
  if (parsed === undefined) {
    const end = leadingObjectEnd(value);
    if (end > 0) parsed = parse(value.slice(0, end));
  }
  return isRecord(parsed) ? parsed : {};
}

/** The index just past the first complete top-level JSON object in [text], or -1. */
function leadingObjectEnd(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

const base = (path: string | undefined) => (path ? basename(path) : '');

function isAgentToolOutputPath(path: string | undefined): boolean {
  if (!path) return false;
  const parts = path.split(/[/\\]/).filter(Boolean);
  for (let index = 0; index < parts.length - 3; index += 1) {
    if (parts[index] === '.cursor' && parts[index + 1] === 'projects' && parts[index + 3] === 'agent-tools') {
      return parts.length === index + 5 && parts[index + 4]!.endsWith('.txt');
    }
  }
  return false;
}

function readLineRange(offset: unknown, limit: unknown): string | undefined {
  if (typeof offset === 'number' && Number.isFinite(offset)) {
    const start = Math.max(1, Math.trunc(offset));
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      const count = Math.trunc(limit);
      return count === 1 ? `line ${start}` : `lines ${start}-${start + count - 1}`;
    }
    return `line ${start}`;
  }
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    const count = Math.trunc(limit);
    return count === 1 ? 'line 1' : `lines 1-${count}`;
  }
  return undefined;
}

/** Tool call → the `tool_call` fields the shared timeline already knows how to render. */
export function describeToolCall(toolName: string, args: unknown, unbounded = false): Record<string, unknown> {
  const { name, input } = unwrap(toolName, args);
  const path = str(input.path) ?? str(input.target_file) ?? str(input.file_path);
  const location = path ? [{ path, ...(typeof input.offset === 'number' && input.offset > 0 ? { line: input.offset } : {}) }] : [];
  switch (name) {
    case 'Shell':
      return {
        kind: 'execute',
        title: str(input.command) ?? 'Shell',
        rawInput: { command: str(input.command) ?? '', ...(str(input.working_directory) ? { cwd: input.working_directory } : {}) },
        // `block_until_ms: 0` is how the CLI says "do not wait": the command becomes a background
        // job, and its id plus the file its output is streamed to come back in the result.
        ...(input.block_until_ms === 0 ? { job: { title: str(input.description) ?? str(input.command) ?? '后台任务', command: str(input.command) ?? '', status: 'running' } } : {}),
      };
    case 'AwaitShell':
      // Folded into the job it waits for. The CLI's own tool documentation asks hosts to render a
      // wait nicely rather than let it read as another opaque call.
      return { hidden: true, kind: 'execute', title: '等待后台命令', rawInput: input };
    case 'Read': case 'ReadFile': {
      const toolOutput = isAgentToolOutputPath(path);
      const label = toolOutput ? 'tool output' : base(path);
      const range = readLineRange(input.offset, input.limit);
      return {
        kind: 'read',
        title: ['Read', label, range].filter(Boolean).join(' ').trim(),
        locations: toolOutput ? [] : location,
        rawInput: input,
      };
    }
    case 'StrReplace': case 'Edit': case 'MultiEdit':
      return {
        kind: 'edit', title: `Edit ${base(path)}`.trim(), locations: location, rawInput: { path },
        ...(typeof input.old_string === 'string' || typeof input.new_string === 'string'
          ? { content: [{ type: 'diff', path, oldText: clip(str(input.old_string) ?? '', unbounded ? Infinity : FILE_LIMIT), newText: clip(str(input.new_string) ?? '', unbounded ? Infinity : FILE_LIMIT) }] } : {}),
      };
    case 'Write':
      return { kind: 'edit', title: `Write ${base(path)}`.trim(), locations: location, rawInput: { path }, ...(typeof input.contents === 'string' ? { content: [{ type: 'diff', path, oldText: '', newText: clip(input.contents, unbounded ? Infinity : FILE_LIMIT) }] } : {}) };
    case 'Delete':
      return { kind: 'delete', title: `Delete ${base(path)}`.trim(), locations: location, rawInput: input };
    case 'Grep': case 'rg':
      return { kind: 'search', title: `grep ${str(input.pattern) ?? ''}`.trim(), ...(path ? { locations: [{ path }] } : {}), rawInput: input };
    case 'Glob': {
      const directory = str(input.target_directory) ?? path;
      return { kind: 'search', title: `glob ${str(input.glob_pattern) ?? ''}`.trim(), ...(directory ? { locations: [{ path: directory }] } : {}), rawInput: input };
    }
    case 'SemanticSearch': case 'codebase_search':
      return { kind: 'search', title: str(input.query) ?? 'Search', rawInput: input };
    case 'CreatePlan': {
      // Cursor's plan mode. The checklist is already a plan card, so this call carries what the
      // card cannot: the plan's own name and the Markdown body the reader needs to approve it.
      const overview = str(input.overview);
      const body = str(input.plan);
      const text = [overview, body].filter(Boolean).join('\n\n');
      return {
        // `plan`, not `think`: this is the same row Claude's `ExitPlanMode` and Codex's proposed
        // plan produce, and one `kind` is what lets a single icon and renderer serve all three.
        kind: 'plan',
        title: str(input.name) ? `Plan · ${str(input.name)}` : 'Proposed plan',
        rawInput: input,
        ...(text ? { content: [{ type: 'markdown', text: clip(text, unbounded ? Infinity : FILE_LIMIT) }] } : {}),
      };
    }
    case 'GetDynamicTools':
      // Schema discovery: it exists so the agent can then call a dynamic tool, and says nothing to
      // anyone reading the conversation.
      return { hidden: true, kind: 'search', title: `查看工具 ${[str(input.namespace), str(input.toolName)].filter(Boolean).join(' · ')}`.trim(), rawInput: input };
    case 'WebFetch':
      return { kind: 'fetch', title: str(input.url) ?? 'Fetch', rawInput: input };
    case 'WebSearch':
      return { kind: 'fetch', title: str(input.search_term) ?? str(input.query) ?? 'Web search', rawInput: input };
    case 'Task': case 'Subagent':
      return { kind: 'agent', title: str(input.description) ?? 'Subagent', rawInput: input, subagent: { type: str(input.subagent_type), description: str(input.description), prompt: clip(str(input.prompt) ?? '', unbounded ? Infinity : 8 * 1024), model: str(input.model), background: input.run_in_background === true } };
    case 'AskQuestion':
      return { kind: 'question', title: str(input.title) ?? '提问', rawInput: input };
    case 'SwitchMode':
      return { kind: 'switch_mode', title: `切换到 ${str(input.target_mode_id) ?? '模式'}`, rawInput: input };
    default:
      return { kind: 'other', title: name, rawInput: input };
  }
}

function highLevel(message: ChatMessage): { output?: Record<string, unknown>; isError: boolean } {  const result = message.providerOptions?.cursor?.highLevelToolCallResult;
  if (!isRecord(result)) return { isError: false };
  return { ...(isRecord(result.output) ? { output: result.output } : {}), isError: result.isError === true };
}

const textContent = (text: string, unbounded = false) => [{ type: 'content', content: { type: 'text', text: unbounded ? text : clip(text) } }];

/**
 * The CLI's AskQuestion UI stores successful answers as question ids plus selected option ids
 * (and optional freeform text). Resolve them against the original call rather than rendering
 * the internal ids as JSON. A partial answer set is valid: the CLI can skip individual questions.
 */
function questionAnswerContent(input: Record<string, unknown>, success: Record<string, unknown>): Record<string, unknown>[] | undefined {
  if (!Array.isArray(input.questions) || !Array.isArray(success.answers)) return undefined;
  const questions = input.questions;
  const answers = success.answers;
  if (!questions.length || !answers.length) return undefined;

  const questionsById = new Map<string, { prompt: string; options: Map<string, string> }>();
  for (const raw of questions) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.prompt !== 'string' || !Array.isArray(raw.options) || questionsById.has(raw.id)) return undefined;
    const options = new Map<string, string>();
    for (const option of raw.options) {
      if (!isRecord(option) || typeof option.id !== 'string' || typeof option.label !== 'string' || options.has(option.id)) return undefined;
      options.set(option.id, option.label);
    }
    questionsById.set(raw.id, { prompt: raw.prompt, options });
  }

  const answersByQuestion = new Map<string, string[]>();
  for (const raw of answers) {
    if (!isRecord(raw) || typeof raw.questionId !== 'string' || !Array.isArray(raw.selectedOptionIds) || answersByQuestion.has(raw.questionId)) return undefined;
    const question = questionsById.get(raw.questionId);
    if (!question || raw.selectedOptionIds.some((id: unknown) => typeof id !== 'string' || !question.options.has(id))) return undefined;
    const selectedIds = raw.selectedOptionIds as string[];
    if (new Set(selectedIds).size !== selectedIds.length) return undefined;
    const labels = selectedIds.map((id) => question.options.get(id)!);
    if (raw.freeformText !== undefined && typeof raw.freeformText !== 'string') return undefined;
    const freeform = typeof raw.freeformText === 'string' ? raw.freeformText.trim() : '';
    if (freeform) labels.push(freeform);
    answersByQuestion.set(raw.questionId, labels);
  }

  return questions.map((raw) => {
    const question = raw as Record<string, unknown>;
    return { type: 'question_answer', question: question.prompt as string, answers: answersByQuestion.get(question.id as string) ?? [] };
  });
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined || result === null) return '';
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

type ToolResultPart = { toolName: string; result?: unknown; content?: unknown };

/** Tool result → the `tool_call_update` fields (status plus renderable content). */
export function describeToolResult(part: ToolResultPart, message: ChatMessage, call?: { toolName: string; args?: unknown }, unbounded = false): Record<string, unknown> {
  const described = describeToolOutcome(part, message, call, unbounded);
  const images = described.hidden || described.status === 'failed' ? [] : toolResultImages(part, message, call, unbounded);
  if (!images.length) return described;
  return { ...described, content: [...(Array.isArray(described.content) ? described.content : []), ...images] };
}

/**
 * Images the CLI kept with a tool result (`experimental_content`, e.g. a Read of a PNG), referenced
 * by the file they came from when it is known; otherwise the image files an image-producing tool
 * reports having written.
 */
function toolResultImages(part: ToolResultPart, message: ChatMessage, call?: { toolName: string; args?: unknown }, unbounded = false): Record<string, unknown>[] {
  const { output } = highLevel(message);
  const success = isRecord(output?.success) ? output.success : undefined;
  const identity = call ? unwrap(call.toolName, call.args) : { name: part.toolName, input: {} };
  const inline = (Array.isArray(part.content) ? part.content : []).filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'image' && typeof block.data === 'string');
  if (inline.length) {
    const sourcePath = [success?.path, identity.input.path, identity.input.target_file].find(isImagePath);
    return inline.slice(0, unbounded ? undefined : 4).map((block, index) => toolImageContent({
      ...(index === 0 && sourcePath ? { path: sourcePath } : {}),
      data: block.data as string,
      ...(str(block.mimeType) ?? str(block.mediaType) ? { mimeType: str(block.mimeType) ?? str(block.mediaType) } : {}),
    }, { unbounded }));
  }
  if (identity.name !== 'GenerateImage' && !/screenshot|capture|image/i.test(identity.name)) return [];
  const paths = new Set([...imagePathFields(success), ...announcedImagePaths(resultText(part.result))]);
  return [...paths].slice(0, unbounded ? undefined : 4).map(path => toolImageContent({ path }));
}

function describeToolOutcome(part: ToolResultPart, message: ChatMessage, call?: { toolName: string; args?: unknown }, unbounded = false): Record<string, unknown> {
  const { output, isError } = highLevel(message);
  const content = (value: string) => textContent(value, unbounded);
  const success = isRecord(output?.success) ? output.success : undefined;
  const failure = isRecord(output?.failure) ? output.failure : isRecord(output?.error) ? output.error : undefined;
  const status = isError || failure ? 'failed' : 'completed';
  const name = call ? unwrap(call.toolName, call.args).name : part.toolName;
  const detail = success ?? failure;
  switch (name) {
    case 'Shell': {
      // A backgrounded shell answers with its id and the file its output streams to, not with output.
      const raw = resultText(part.result);
      const shellId = typeof success?.shellId === 'number' ? String(success.shellId) : str(success?.shellId) ?? JOB_STARTED.exec(raw)?.[1];
      const announcedPath = JOB_OUTPUT_PATH.exec(raw)?.[1];
      const outputPath = announcedPath && isJobLogPath(announcedPath) ? announcedPath : undefined;
      const background = status !== 'failed' && Boolean(shellId || success?.backgroundReason || outputPath);
      if (background) {
        return { status, hidden: true, job: { ...(shellId ? { id: shellId } : {}), status: 'running', ...(outputPath ? { outputPath } : {}) } };
      }
      const out = str(detail?.interleavedOutput) ?? [str(detail?.stdout), str(detail?.stderr)].filter(Boolean).join('\n');
      const exit = typeof failure?.exitCode === 'number' ? `\n[exit ${failure.exitCode}]` : '';
      const text = detail ? out : raw;
      const done = JOB_DONE.exec(raw);
      const exitCode = typeof failure?.exitCode === 'number' ? failure.exitCode : done ? Number(done[2]) : undefined;
      const runningMs = typeof success?.localExecutionTimeMs === 'number' && Number.isFinite(success.localExecutionTimeMs)
        ? success.localExecutionTimeMs
        : done ? Number(done[1]) : undefined;
      return {
        status,
        jobResult: {
          status: status === 'failed' || (exitCode !== undefined && exitCode !== 0) ? 'failed' : 'succeeded',
          ...(typeof exitCode === 'number' ? { exitCode } : {}),
          ...(typeof runningMs === 'number' && Number.isFinite(runningMs) && runningMs > 0 ? { runningMs } : {}),
        },
        ...(text.trim() || exit ? { content: content(`${text.replace(/\n+$/, '')}${exit}`) } : {}),
      };
    }
    case 'AwaitShell': {
      // The wait is folded into the job it names, so the timeline shows one row per background task.
      const text = resultText(part.result);
      const awaited = call ? unwrap(call.toolName, call.args).input : {};
      const outputPath = JOB_OUTPUT_PATH.exec(text)?.[1];
      const done = JOB_DONE.exec(text);
      const id = str(awaited.shell_id) ?? (outputPath ? /\/terminals\/(\d+)\.txt$/i.exec(outputPath)?.[1] : undefined);
      return {
        status, hidden: true,
        jobResult: {
          ...(id ? { id } : {}),
          status: done ? (done[2] === '0' ? 'succeeded' : 'failed') : JOB_PENDING.test(text) ? 'running' : status === 'failed' ? 'failed' : 'succeeded',
          ...(done ? { runningMs: Number(done[1]), exitCode: Number(done[2]) } : {}),
          ...(JOB_PATTERN.exec(text)?.[1] ? { matched: clip(JOB_PATTERN.exec(text)![1]!, 400) } : {}),
          ...(outputPath ? { outputPath } : {}),
        },
      };
    }
    case 'StrReplace': case 'Edit': case 'MultiEdit': case 'Write': {
      const before = str(success?.beforeFullFileContent);
      const after = str(success?.afterFullFileContent);
      const path = str(success?.path);
      if (after !== undefined && (unbounded || (after.length <= FILE_LIMIT && (before ?? '').length <= FILE_LIMIT))) return { status, content: [{ type: 'diff', path, ...trimDiff(before ?? '', after) }] };
      if (str(success?.diffString)) return { status, content: content(str(success?.diffString)!) };
      return { status, ...(status === 'failed' ? { content: content(resultText(part.result)) } : {}) };
    }
    case 'Read': case 'ReadFile':
      return { status, ...(status === 'failed' ? { content: content(resultText(part.result)) } : {}) };
    case 'GetDynamicTools':
      return { status, hidden: true, ...(status === 'failed' ? { content: content(resultText(part.result)) } : {}) };
    case 'Task': case 'Subagent': {
      const agentId = str(success?.agentId);
      const duration = Number(success?.durationMs);
      return { status, content: content(resultText(part.result).replace(/^This is the output of the subagent:\s*/, '')), subagentResult: { ...(agentId ? { agentId } : {}), ...(Number.isFinite(duration) ? { durationMs: duration } : {}), background: success?.isBackground === true } };
    }
    case 'AskQuestion': {
      const input = call ? unwrap(call.toolName, call.args).input : undefined;
      const content = status === 'completed' && success && input ? questionAnswerContent(input, success) : undefined;
      return { status, content: content ?? textContent(resultText(part.result), unbounded) };
    }
    default:
      return { status, content: content(resultText(part.result)) };
  }
}

interface Todo { id: string; content: string; status: string; }

function todoEntries(input: Record<string, unknown>, current: Map<string, Todo>): Record<string, unknown>[] | undefined {
  if (!Array.isArray(input.todos)) return undefined;
  if (input.merge !== true) current.clear();
  for (const raw of input.todos) {
    if (!isRecord(raw)) continue;
    const id = str(raw.id) ?? String(current.size);
    const previous = current.get(id);
    current.set(id, { id, content: str(raw.content) ?? previous?.content ?? id, status: str(raw.status) ?? previous?.status ?? 'pending' });
  }
  return [...current.values()].map((todo) => ({ ...todo }));
}

/** A tool call as its result needs it. */
interface PendingCall { toolName: string; args?: unknown; runId?: string }

/** Calls still waiting for a result past this many have lost it (an interrupted step); the oldest go. */
const PENDING_CALL_LIMIT = 256;

/**
 * What a result is described with: the tool's own name and the few arguments a result reads
 * (`describeToolResult`). Keeping only these leaves every mapped event as it was while the call is
 * small enough to carry in a reader's saved state; a `Write` call's file is not among them.
 */
function pendingCall(toolName: string, args: unknown, runId: string | undefined): PendingCall {
  const { name, input } = unwrap(toolName, args);
  const kept = Object.fromEntries(['shell_id', 'questions', 'path', 'target_file'].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  return { toolName: name, ...(Object.keys(kept).length ? { args: kept } : {}), ...(runId ? { runId } : {}) };
}

/** Everything a {@link TranscriptMapper} carries from one message to the next, as plain data. */
export interface TranscriptMapperState {
  turn?: string;
  nativeTurnId?: string;
  turnAt: string;
  awaitingReply: boolean;
  calls: Array<[string, PendingCall]>;
  todos: Todo[];
}

/**
 * Stateful mapper so a growing transcript can be translated incrementally: feeding messages
 * one at a time produces exactly the events a full rebuild would, which lets the server
 * append instead of resending the whole conversation on every step.
 */
export class TranscriptMapper {
  /** Full static exports use the same projection without browser payload bounds. */
  constructor(private readonly unbounded = false) {}
  private turn: string | undefined;
  private nativeTurnId: string | undefined;
  private turnAt = '';
  /** `runId` is the turn the call was issued in; its result keeps it so the pair merges into one card. */
  private readonly calls = new Map<string, PendingCall>();
  private readonly todos = new Map<string, Todo>();
  /** What a shell call changed in the working tree, seen around it; appended to its result. Not part of the state: the lookup is the host's, and replays. */
  observedChanges?: (toolCallId: string) => readonly Record<string, unknown>[] | undefined;

  /** The state after the last mapped message; {@link restore} continues from it as this mapper would. */
  state(): TranscriptMapperState {
    return {
      ...(this.turn !== undefined ? { turn: this.turn } : {}), ...(this.nativeTurnId !== undefined ? { nativeTurnId: this.nativeTurnId } : {}),
      turnAt: this.turnAt, awaitingReply: this.awaitingReply, calls: [...this.calls], todos: [...this.todos.values()].map(todo => ({ ...todo })),
    };
  }

  static restore(state: TranscriptMapperState, unbounded = false): TranscriptMapper {
    const mapper = new TranscriptMapper(unbounded);
    mapper.turn = state.turn;
    mapper.nativeTurnId = state.nativeTurnId;
    mapper.turnAt = state.turnAt;
    mapper.awaitingReply = state.awaitingReply;
    for (const [id, call] of state.calls) mapper.calls.set(id, call);
    for (const todo of state.todos) mapper.todos.set(todo.id, { ...todo });
    return mapper;
  }

  /** The turn (`runId`) the last mapped message belongs to; a new value means a new turn began. */
  get run(): string | undefined {
    return this.turn;
  }
  /**
   * Whether the last message mapped leaves the model owing another step: a prompt of any kind
   * (including the ones the CLI injects itself), a tool result, or a step that called a tool.
   * A turn ends on an assistant message that calls nothing.
   */
  awaitingReply = false;

  /** The CLI's request id of the turn the last mapped message belongs to; `undefined` for a synthetic turn. */
  get turnId(): string | undefined {
    return this.nativeTurnId;
  }

  /** A copy to map a provisional message with, leaving this mapper's state as it was. */
  fork(): TranscriptMapper {
    const copy = new TranscriptMapper(this.unbounded);
    copy.observedChanges = this.observedChanges;
    copy.turn = this.turn;
    copy.nativeTurnId = this.nativeTurnId;
    copy.turnAt = this.turnAt;
    for (const [id, call] of this.calls) copy.calls.set(id, call);
    for (const [id, todo] of this.todos) copy.todos.set(id, { ...todo });
    copy.awaitingReply = this.awaitingReply;
    return copy;
  }

  map(record: MessageRecord): TranscriptEvent[] {
    const { id, message } = record;
    if (message.role === 'system') return [];
    if (message.role !== 'assistant') this.awaitingReply = true;
    if (message.role === 'user') {
      const notification = taskNotification(message);
      if (notification) {
        const events: TranscriptEvent[] = [];
        notification.tasks.forEach((task, index) => {
          // A task notification is a synthetic turn boundary, but it is never a human user turn.
          // Give each notification occurrence its own run so the preceding completed answer is
          // not reopened when the CLI follows the notification with a short generated response.
          this.turn = `turn:${id}${notification.tasks.length > 1 ? `:${index + 1}` : ''}`;
          this.nativeTurnId = undefined;
          this.turnAt = notification.timestamp ?? record.seenAt ?? '';
          const taskId = task.taskId ?? `${id}:${index + 1}`;
          const jobStatus = task.status === 'completed' ? 'succeeded'
            : task.status === 'failed' ? 'failed'
              : task.status === 'running' ? 'running' : undefined;
          const jobResult = task.kind.toLowerCase() === 'shell' && task.taskId && jobStatus
            ? { id: task.taskId, status: jobStatus, ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}) }
            : undefined;
          events.push({
            type: 'task_notification',
            runId: this.turn,
            createdAt: this.turnAt,
            data: {
              sessionUpdate: 'task_notification', taskId, kind: task.kind, status: task.status,
              ...(task.sourceStatus ? { sourceStatus: task.sourceStatus } : {}),
              title: task.title,
              ...(task.command ? { command: task.command } : {}),
              ...(task.detail ? { detail: task.detail } : {}),
              ...(jobResult ? { jobResult } : {}),
            },
          });
        });
        return events;
      }
      const query = userQuery(message);
      if (!query) return [];
      const requestId = str(message.providerOptions?.cursor?.requestId);
      // Cursor can append an in-flight input with the original requestId. Output still belongs
      // to the first user turn; the extra input must not steal tool/usage ownership.
      if (!requestId || requestId !== this.nativeTurnId) this.turn = `turn:${id}`;
      this.nativeTurnId = requestId;
      this.turnAt = query.at ?? record.seenAt ?? '';
      const attachments = userImageAttachments(message);
      return [{ type: 'user_message_chunk', runId: this.turn, ...(requestId ? { nativeTurnId: requestId } : {}), createdAt: this.turnAt, data: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: query.text }, ...(attachments.length ? { attachments } : {}) } }];
    }
    const createdAt = record.seenAt ?? this.turnAt;
    const run = { ...(this.turn ? { runId: this.turn } : {}), ...(this.nativeTurnId ? { nativeTurnId: this.nativeTurnId } : {}) };
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content } as ChatPart] : message.content;
    // The CLI shows its narration summary instead of the model's raw reasoning, so drop the
    // thinking parts of any message that also narrates. This is decided per message on purpose:
    // a flag latched across messages would hide a part or not depending on whether the mapper
    // had been rebuilt — and `Transcript` rebuilds it on open, on branch switch, on a large
    // backlog and for every older-history window — which breaks the guarantee above that feeding
    // messages one at a time produces exactly what a full rebuild does.
    const narrates = parts.some(part => part.type === 'reasoning' && reasoningChannel(part.signature) === 'narration');
    if (message.role === 'assistant') this.awaitingReply = parts.some(part => part.type === 'tool-call');
    const events: TranscriptEvent[] = [];
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string' && message.role === 'assistant') {
        if (part.text.trim()) events.push({ type: 'agent_message_chunk', ...run, createdAt, data: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: this.unbounded ? part.text : clip(part.text) } } });
      } else if (part.type === 'reasoning' && typeof part.text === 'string') {
        // An unreadable signature is treated as raw reasoning: that is what it looks like, and
        // the web UI only folds it into one line rather than dropping it.
        const channel = reasoningChannel(part.signature) === 'narration' ? 'narration' : 'thinking';
        if (channel === 'thinking' && narrates) continue;
        if (part.text.trim()) events.push({ type: 'agent_thought_chunk', ...run, createdAt, data: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: this.unbounded ? part.text : clip(part.text) }, channel } });
      } else if (part.type === 'tool-call' && typeof part.toolCallId === 'string' && typeof part.toolName === 'string') {
        this.calls.delete(part.toolCallId);
        this.calls.set(part.toolCallId, pendingCall(part.toolName, part.args, this.turn));
        if (this.calls.size > PENDING_CALL_LIMIT) this.calls.delete(this.calls.keys().next().value!);
        const { name, input } = unwrap(part.toolName, part.args);
        if (name === 'TodoWrite') {
          const entries = todoEntries(input, this.todos);
          if (entries) events.push({ type: 'plan', ...run, createdAt, data: { sessionUpdate: 'plan', entries } });
          continue;
        }
        // Cursor's plan mode writes the plan with `CreatePlan`: a title, an overview, the plan body
        // as Markdown, and the checklist it will then track with `TodoWrite`. The checklist is the
        // same list, so it seeds the same todo state — otherwise the first `TodoWrite` would look
        // like a brand-new plan and the reader would see the list appear twice. Its items carry no
        // status (nothing has run yet), which `todoEntries` reads as `pending`.
        if (name === 'CreatePlan') {
          const entries = todoEntries(input, this.todos);
          if (entries) events.push({ type: 'plan', ...run, createdAt, data: { sessionUpdate: 'plan', entries } });
          // The body is kept as an ordinary call so it stays readable in full, under its own title,
          // instead of being folded into the checklist card or thrown away.
          events.push({ type: 'tool_call', ...run, createdAt, data: { sessionUpdate: 'tool_call', toolCallId: part.toolCallId, toolName: name, status: 'in_progress', ...describeToolCall(part.toolName, part.args, this.unbounded) } });
          continue;
        }
        events.push({ type: 'tool_call', ...run, createdAt, data: { sessionUpdate: 'tool_call', toolCallId: part.toolCallId, toolName: name, status: 'in_progress', ...describeToolCall(part.toolName, part.args, this.unbounded) } });
      } else if (part.type === 'tool-result' && typeof part.toolCallId === 'string') {
        // Read the persisted hook context before ordinary tool-result display truncation. Only
        // the bounded, nonce-bearing carrier is retained, never another copy of tool output.
        const context = cursorSteerContext(part);
        const carriers = context ? parseSteerContexts(context).map(value => value.carrier) : [];
        const displayPart = carriers.length ? withoutSteerCarriers(part, carriers) as typeof part : part;
        const displayMessage = carriers.length ? { ...message, providerOptions: withoutSteerCarriers(message.providerOptions, carriers) as ChatMessage['providerOptions'] } : message;
        const call = this.calls.get(part.toolCallId);
        if (call && unwrap(call.toolName, call.args).name === 'TodoWrite') {
          if (context) events.push({ type: 'cursor_tool_context', ...run, createdAt, data: { hidden: true, text: context, toolCallId: part.toolCallId } });
          this.calls.delete(part.toolCallId);
          continue;
        }
        const resultRun = call ? { ...(call.runId ? { runId: call.runId } : {}), ...(run.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}) } : run;
        const described = describeToolResult({ toolName: str(part.toolName) ?? call?.toolName ?? 'tool', result: displayPart.result, content: displayPart.experimental_content }, displayMessage, call, this.unbounded);
        // A background shell has no result of its own to merge into: what it changes is not the command's.
        const observed = !described.hidden && call && unwrap(call.toolName, call.args).name === 'Shell' ? this.observedChanges?.(part.toolCallId) ?? [] : [];
        const data = observed.length ? { ...described, content: [...(Array.isArray(described.content) ? described.content : []), ...observed] } : described;
        events.push({ type: 'tool_call_update', ...resultRun, createdAt, data: { sessionUpdate: 'tool_call_update', toolCallId: part.toolCallId, ...(!call ? { contextMissing: true } : {}), ...data } });
        if (context) events.push({ type: 'cursor_tool_context', ...run, createdAt,
          data: { hidden: true, text: context, toolCallId: part.toolCallId } });
        this.calls.delete(part.toolCallId);
      }
    }
    return events;
  }
}

function withoutSteerCarriers(value: unknown, carriers: string[], depth = 0): unknown {
  if (typeof value === 'string') {
    for (const carrier of carriers) value = (value as string).replaceAll(carrier, '');
    return value;
  }
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map(child => withoutSteerCarriers(child, carriers, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withoutSteerCarriers(child, carriers, depth + 1)]));
}

export function cursorSteerContext(part: ChatPart): string | undefined {
  const carriers = new Set<string>();
  let remaining = 2048;
  function visit(value: unknown, depth = 0): void {
    if (--remaining < 0 || depth > 8) return;
    if (typeof value === 'string') {
      // Scan the full string (parseSteerContexts short-circuits when the opening tag is absent)
      // so large tool outputs never push a steer carrier outside a fixed tail window.
      for (const context of parseSteerContexts(value)) carriers.add(context.carrier);
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
  }
  visit(part);
  return carriers.size ? [...carriers].join('\n\n') : undefined;
}

export function mapTranscript(records: MessageRecord[]): TranscriptEvent[] {
  const mapper = new TranscriptMapper();
  return records.flatMap((record) => mapper.map(record));
}
