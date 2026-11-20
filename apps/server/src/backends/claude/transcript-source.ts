import { stat } from 'node:fs/promises';
import type { NativeActivity, NativeWorkbenchEvent, Run, Session } from '../../../../../packages/contracts/src/index.js';
import { SYNC_BUDGET } from '../../../../../packages/contracts/src/sync.js';
import { activityId, activityOfEvent } from '../../journal/activity.js';
import { subagentMetaId, turnMetaId, type LaneWriter, type TranscriptSource, type TurnEndStatus } from '../../journal/ingest.js';
import { ClaudeActivities, type ClaudeActivitiesState } from './activity.js';
import { activeTurnOf, initialState, reduce } from './session-state.js';
import { ClaudeSubagentDiscovery, type ClaudeSubagentMeta as SubagentMeta } from './subagents.js';
import { mapRow, type ClaudeTranscriptHooks, type MapperState } from './row-mapper.js';
import { claudeApiFailure, claudeFailureText, claudePromptKey, claudeRowSignals, clip, subagentSettles, subagentWake, type ClaudeRow } from './rows.js';
import { ClaudeLiveDrafts, type LiveDrift } from './live/drafts.js';
import type { ClaudeScreenFeed } from './live/feed.js';
import { EMPTY, LaneRead, NO_TIME, OpenCalls, READ_CHUNK, RETAIN_ENDED, STEP_MS, cursorTurn, decode, fresh, giveWay, openFile, parseLine, readRange, record, sameFile, type Cursor, type QueueReceipt } from './lane-read.js';

/*
 * Claude Code's transcript as the session journal reads it (docs/SYNC-V3.md, 写入契约). The CLI only
 * appends to `<projects>/<dir>/<sessionId>.jsonl`, so a lane's cursor is a byte offset into the file, the
 * file's identity (inode, and the bytes just before the offset) and what mapping a row needs from the
 * rows before it: the open turn, unanswered tool calls, the task plan and the system activities. Rows
 * are mapped by `mapRow`, the mapping the live view uses, so every entity is keyed by the row's own
 * `uuid` and content part and reading a line again writes nothing. Subagents are read from their own
 * `subagents/agent-<id>.jsonl` into a lane per spawning tool call.
 */

/** A pull reads about this much, so a long import goes in steps that leave the event loop free. */
const PULL_BYTES = 4 * 1024 * 1024;
/** A tail window holds at least what the largest snapshot a client may ask for needs (G4). */
const TAIL_ROWS = SYNC_BUDGET.snapshot.maxRows;
const TAIL_BYTES = SYNC_BUDGET.snapshot.maxBytes;
/** How far back a tail window is looked for: a transcript with less conversation than that in it starts at its first prompt there. */
const TAIL_SCAN_BYTES = 8 * PULL_BYTES;
export interface ClaudeTranscriptSourceOptions {
  /** The workbench session the events are stamped with. */
  sessionId: string;
  /** Claude's session id now; a launch that had to start over gets a new one. */
  nativeSessionId(): string | undefined;
  /** The ids the conversation ran under before, oldest first: their transcripts lead it (`Session.previousNativeSessionIds`). */
  previousNativeSessionIds?(): readonly string[];
  /** The transcript file of a Claude session, once the CLI has written one. */
  locate(nativeSessionId: string): Promise<string | undefined>;
  /** Calls `wake` when the CLI may have written something (a hook, the runtime's transcript poll); returns how to stop. */
  watch?(wake: () => void): () => void;
  /**
   * Since when the CLI writing the conversation is known to be gone, while it is: what it left open never ends on its
   * own. Undefined while it may be running, or nothing knows.
   */
  exited?(): string | undefined;
  /**
   * The CLI's terminal, looked at for the text block it is drawing before it writes it (`live/`). Without it the
   * conversation's text arrives a block at a time.
   */
  screen?: Pick<ClaudeScreenFeed, 'watch' | 'arm' | 'read'>;
  /** A draft its transcript text contradicted: the screen's layout has likely changed (`live/screen.ts`). */
  drift?(drift: LiveDrift): void;
  /** What a running conversation knows about its rows; nothing that acts on the CLI. */
  hooks?: Pick<ClaudeTranscriptHooks, 'additionalContext' | 'commandForUserMessage' | 'promptText' | 'putBlob' | 'observedChanges'> & {
    /** Persisted input fences survive the runtime and the journal's read cursor. */
    inputRuns?: () => readonly Run[];
    inputReceipt?: (event: NativeWorkbenchEvent) => void;
    /** Native input queue receipts use this file's durable byte boundary, never the model's response text. */
    queuedInput?: (row: ClaudeRow, position: { offset: number; inode?: number; receipt?: QueueReceipt }) => NativeWorkbenchEvent[];
  };
}

/** The complete lines of `bytes`, which start at file offset `from`; a fragment before the first newline is dropped when `partial`. */
function linesOf(bytes: Buffer, from: number, partial: boolean): Array<{ start: number; bytes: Buffer }> {
  const lines: Array<{ start: number; bytes: Buffer }> = [];
  let at = partial ? bytes.indexOf(0x0a) + 1 : 0;
  if (partial && at === 0) return lines;
  for (let newline = bytes.indexOf(0x0a, at); newline >= 0; newline = bytes.indexOf(0x0a, at)) {
    lines.push({ start: from + at, bytes: bytes.subarray(at, newline + 1) });
    at = newline + 1;
  }
  return lines;
}

/** What a receipt scan keeps of a transcript suffix, in file order: the CLI's queue moves and its prompt rows. */
type SuffixStep =
  | { op: 'enqueue'; offset: number; at: number; text?: string }
  | { op: 'dequeue' }
  | { op: 'popAll' }
  | { op: 'remove'; text?: string }
  | { op: 'prompt'; offset: number; event?: NativeWorkbenchEvent };

/** A human prompt of the suffix; `queued` when the CLI ran it from its queue, placed at the row that queued it. */
interface SuffixPrompt { event: NativeWorkbenchEvent; offset: number; at: number; queued?: true }

function promptText(event: NativeWorkbenchEvent): string | undefined {
  const text = (event.data.content as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : undefined;
}

/**
 * The human prompts of a transcript suffix, each placed where the CLI took it in. A prompt the CLI ran
 * from its own input queue stands at the row that queued it: that is the position and time a dispatch
 * fence is compared with, and the prompt row itself may come long after a later send. What the queue
 * held when the suffix begins is not in it, so it is inferred first: a dequeue or remove the suffix's
 * own enqueues cannot answer took an input queued earlier, and that many unknown inputs are put ahead.
 * A prompt run from an unknown input, or whose text is not the one queued, is left out.
 */
function suffixPrompts(steps: readonly SuffixStep[]): SuffixPrompt[] {
  const replay = (unknown: number) => {
    const queue: Array<{ offset?: number; at?: number; text?: string; dequeued?: true }> = Array.from({ length: unknown }, () => ({}));
    const users: SuffixPrompt[] = [];
    let missing = 0;
    for (const step of steps) {
      if (step.op === 'enqueue') queue.push({ offset: step.offset, at: step.at, ...(step.text !== undefined ? { text: step.text } : {}) });
      else if (step.op === 'popAll') queue.length = 0;
      else if (step.op === 'dequeue') {
        const input = queue.find(item => !item.dequeued);
        if (input) input.dequeued = true; else missing += 1;
      } else if (step.op === 'remove') {
        let index = step.text === undefined ? -1 : queue.findIndex(item => !item.dequeued && item.text === step.text);
        if (index < 0) index = queue.findIndex(item => !item.dequeued && item.text === undefined);
        if (index >= 0) queue.splice(index, 1); else missing += 1;
      } else {
        const index = queue.findIndex(item => item.dequeued);
        const input = index >= 0 ? queue.splice(index, 1)[0] : undefined;
        const text = step.event && promptText(step.event);
        if (!step.event || text === undefined) continue;
        if (!input) users.push({ event: step.event, offset: step.offset, at: Date.parse(step.event.createdAt) });
        else if (input.offset !== undefined && input.text !== undefined && claudePromptKey(input.text) === claudePromptKey(text)) {
          users.push({ event: step.event, offset: input.offset, at: input.at!, queued: true });
        }
      }
    }
    return { users, missing };
  };
  const first = replay(0);
  return first.missing ? replay(first.missing).users : first.users;
}

/**
 * Where a first import's tail window starts (G4): at a prompt, so every turn in it is whole, holding at
 * least the rows or bytes of the largest snapshot; 0 when the whole file is that small.
 */
async function tailStart(path: string): Promise<number> {
  const handle = await openFile(path);
  if (!handle) return 0;
  try {
    const { size } = await handle.stat();
    for (let span = PULL_BYTES; ; span *= 2) {
      const from = Math.max(0, size - span);
      const lines = linesOf(await readRange(handle, from, size), from, from > 0);
      let rows = 0, bytes = 0, earliest = 0, since = performance.now();
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (performance.now() - since > STEP_MS) { await giveWay(); since = performance.now(); }
        const line = lines[index]!;
        const row = parseLine(line.bytes);
        if (!row || row.isSidechain === true) continue;
        if (row.type === 'user' || row.type === 'assistant') { rows += 1; bytes += line.bytes.length; }
        if (!claudeRowSignals(row).some(signal => signal.type === 'prompt')) continue;
        earliest = line.start;
        if (rows >= TAIL_ROWS || bytes >= TAIL_BYTES) return line.start;
      }
      if (from === 0) return 0;
      if (span >= TAIL_SCAN_BYTES) return earliest;
    }
  } finally { await handle.close(); }
}

/**
 * The conversation's transcripts, read into its lanes: `main` from the session file (and, before it, the
 * files of the ids it ran under earlier), `sub:<toolCallId>` from each subagent's own file.
 */
export class ClaudeTranscriptSource implements TranscriptSource {
  /** Where each Claude session's file was found; a file that went is looked for again. */
  private readonly located = new Map<string, string>();
  /** Subagent metadata as last read, by file, and the lane writers handed out for the main writer of one generation. */
  private readonly discovery = new ClaudeSubagentDiscovery();
  private lanes?: { owner: LaneWriter; generation: string; writers: Map<string, LaneWriter>; bound: Map<string, { spawner: LaneWriter; info: string }>; read: Map<string, string> };

  private readonly inputCommands = new Map<string, string>();
  private inputScan?: string;
  private readonly repairedInputs = new Set<string>();

  /** Drafts of the text the CLI draws, for the turns this process saw open. */
  readonly live?: ClaudeLiveDrafts;

  constructor(private readonly options: ClaudeTranscriptSourceOptions) {
    if (options.screen) this.live = new ClaudeLiveDrafts({ sessionId: options.sessionId, clip: text => clip(text), ...(options.drift ? { report: options.drift } : {}) });
  }

  get sessionId(): string { return this.options.sessionId; }
  get hooks(): NonNullable<ClaudeTranscriptSourceOptions['hooks']> {
    const hooks = this.options.hooks ?? {};
    return { ...hooks, commandForUserMessage: hooks.inputRuns
      ? message => this.inputCommands.get(message.uuid)
      : hooks.commandForUserMessage };
  }

  identity(): string | undefined {
    const current = this.options.nativeSessionId();
    return current ? [...(this.options.previousNativeSessionIds?.() ?? []), current].join(' ') : undefined;
  }

  /** The `Session` the mapping stamps rows with; ids derive from the current Claude session. */
  session(): Session {
    return { id: this.options.sessionId, nativeSessionId: this.options.nativeSessionId(), updatedAt: NO_TIME } as Session;
  }

  invalidAgentActivity(activity: NativeActivity): boolean {
    return activity.task?.kind === 'agent' && Boolean(activity.toolCallId)
      && this.discovery.invalidates(activity.id.slice('claude:'.length), activity.toolCallId!);
  }

  async pull(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    const files = await this.files();
    const current = files.at(-1);
    if (!current) return { caughtUp: true };
    for (const target of [w, w.scratch]) {
      const cursor = target ? decode(target.cursor) : undefined;
      if (cursor && !await sameFile(files[cursor.f], cursor)) { w.rebuild('identity-changed'); break; }
    }
    const receipts = await this.recoverInputs(current, signal);
    const metas = await this.discovery.read(current, signal);
    await this.window(w, files, metas, signal);
    if (signal.aborted) return { caughtUp: false };
    const { done } = await this.read(w, files, decode(w.cursor) ?? fresh(0, 0), PULL_BYTES, metas, signal);
    this.publishInputs(w, receipts);
    const children = await this.children(w, metas, PULL_BYTES, signal);
    // Drafts are a preview: one that cannot be drawn never holds up the transcript.
    if (done && !signal.aborted) await this.drawLive(w).catch(error => console.warn('[claude] live draft skipped', { sessionId: this.sessionId, error: error instanceof Error ? error.message : String(error) }));
    return { caughtUp: done && children && !signal.aborted };
  }

  watch(_w: LaneWriter, wake: () => void): () => void {
    const transcript = this.options.watch?.(wake);
    const screen = this.options.screen?.watch(wake);
    return () => { transcript?.(); screen?.(); };
  }

  /**
   * Drafts what the screen shows of the open turn past what the transcript has, once the transcript is read to its end;
   * takes back the drafts of turns that are over. Never on a lane being rebuilt: its open turn is not settled yet.
   */
  private async drawLive(w: LaneWriter): Promise<void> {
    const { live } = this, { screen } = this.options;
    if (!live || !screen || w.scratch) return;
    const turnId = this.activeTurn(w)?.turnId;
    const watching = live.watching(turnId);
    screen.arm(watching);
    const tail = watching ? await screen.read() : undefined;
    // The read may have let a commit in: the plan is for the turn open now.
    const plan = live.plan(this.activeTurn(w)?.turnId === turnId ? turnId : undefined, tail, new Date().toISOString());
    if (plan.drafts.length || plan.retire.length) w.commit({ events: [], drafts: plan.drafts, retire: plan.retire, cursor: w.cursor });
  }

  async drain(w: LaneWriter): Promise<void> {
    const files = await this.files();
    const current = files.at(-1);
    if (!current) return;
    const receipts = await this.recoverInputs(current);
    const metas = await this.discovery.read(current);
    // A lane never read gets its tail window like a first pull would, not a whole import in one go (G4).
    if (!await this.window(w, files, metas)) await this.read(w, files, decode(w.cursor) ?? fresh(0, 0), Infinity, metas);
    this.publishInputs(w, receipts);
    await this.children(w, metas, Infinity);
  }

  /**
   * Ends the turn rows go to, for the control path when the transcript will not (the CLI took a prompt back
   * without a row): reads what is on disk first (G6), and records the end in the cursor so a row read later
   * opens a turn of its own. With `promptId`, only if the open turn is that prompt's; without, whatever turn
   * is open, which only a caller that knows nothing will write to it may want (a CLI that is gone ends its
   * turn through `exited` instead). A lane nothing was read into has no turn to end. Returns the turn ended.
   */
  async endTurn(w: LaneWriter, status: TurnEndStatus, at: string, promptId?: string): Promise<string | undefined> {
    await this.drain(w);
    const target = w.scratch ?? w;
    const cursor = decode(target.cursor);
    const turn = cursor && cursorTurn(cursor.s);
    if (!cursor || !turn?.open || (promptId !== undefined && turn.p !== promptId && turn.k !== promptId)) return undefined;
    cursor.s.t = turn;
    target.turnEnded(turn.k, status, at);
    turn.open = false;
    target.commit({ events: [], cursor: JSON.stringify(cursor) });
    return turn.k;
  }

  /**
   * A compaction its PreCompact hook announced before any row of it, written as the lane's own activity after what is
   * on disk, so the boundary read later completes the same one.
   */
  async compactionHooked(w: LaneWriter, id: string, trigger: 'manual' | 'auto', at: string, promptId?: string): Promise<void> {
    await this.drain(w);
    const target = w.scratch ?? w;
    const cursor = decode(target.cursor);
    if (cursor) new LaneRead(this, target, cursor, true).compactionHooked(id, trigger, at, promptId);
  }

  /** A control-path end survives a missing JSONL marker; only that exact, already-read prompt is closed. */
  closedPrompt(w: LaneWriter, promptId: string): boolean {
    const state = decode((w.scratch ?? w).cursor)?.s;
    const turn = state && cursorTurn(state);
    return turn?.open === false && (turn.p === promptId || turn.k === promptId);
  }

  /** The execution grouping clients read, including continued output after a control-path end. */
  activeTurn(w: LaneWriter): { turnId: string; promptId?: string } | undefined {
    const state = decode((w.scratch ?? w).cursor)?.s;
    const turn = state && cursorTurn(state);
    return turn?.open ? { turnId: turn.k, ...(turn.p ? { promptId: turn.p } : {}) } : undefined;
  }

  /**
   * A receipt is established from the complete file suffix, never the row currently being mapped.
   * Every later write (including cancelled/acknowledged writes) fences off the previous input.
   * Both sides must be unique: two native prompts or equal Run boundaries are left unresolved.
   */
  private async recoverInputs(path: string, signal?: AbortSignal): Promise<Array<{ event: NativeWorkbenchEvent; run: Run }>> {
    const runs = this.options.hooks?.inputRuns?.();
    const nativeSessionId = this.options.nativeSessionId();
    if (!runs || !nativeSessionId) return [];
    const fences = runs.flatMap(run => {
      const native = run.native;
      if (native?.backendId !== 'claude' || native.nativeSessionId !== nativeSessionId || !native.nativeInputBoundary) return [];
      try {
        const fence = record(JSON.parse(native.nativeInputBoundary));
        if (fence?.type !== 'claude-transcript' || fence.nativeSessionId !== nativeSessionId
          || !Number.isSafeInteger(fence.offset) || (fence.offset as number) < 0
          || (fence.inode !== undefined && typeof fence.inode !== 'number')) return [];
        return [{ run, offset: fence.offset as number, inode: fence.inode as number | undefined }];
      } catch { return []; }
    });
    const handle = await openFile(path);
    if (!handle) return [];
    try {
      const { ino, size, mtimeMs } = await handle.stat();
      const compatible = fences.filter(fence => fence.inode === undefined || fence.inode === ino);
      // A later fence beyond EOF means this inode was truncated; no earlier fence remains proof.
      if (compatible.some(fence => fence.offset > size)) { this.inputCommands.clear(); this.inputScan = undefined; return []; }
      const key = JSON.stringify([nativeSessionId, ino, size, mtimeMs, compatible.map(({ run, offset }) =>
        [run.id, offset, run.native!.nativeMessageId, run.native!.delivery, run.native!.stage])]);
      if (key === this.inputScan) return [];
      const eligible = compatible.filter(({ run }) => !run.native!.slashCommand && run.native!.intent !== 'steer'
        && (run.native!.nativeMessageId
          ? run.native!.nativeMessageId.startsWith(`claude:${nativeSessionId}:`) && !run.native!.nativeMessageId.startsWith(`claude:${nativeSessionId}:queue:`)
            && !this.repairedInputs.has(`${run.id}:${run.native!.nativeMessageId}`)
          : ['dispatching', 'input_sent', 'uncertain'].includes(run.native!.delivery)));
      this.inputCommands.clear();
      for (const { run } of compatible) {
        const id = run.native!.nativeMessageId;
        const prefix = `claude:${nativeSessionId}:`;
        if (id?.startsWith(prefix) && id.endsWith(':0') && !id.startsWith(`${prefix}queue:`)) this.inputCommands.set(id.slice(prefix.length, -2), run.commandId);
      }
      // After `/clear` the earlier files are read again under the new id, but their runs keep the id they
      // were received under: the row finds its run by command, as ids no longer say.
      const earlier = (this.options.previousNativeSessionIds?.() ?? []).map(id => `claude:${id}:`);
      for (const run of earlier.length ? runs : []) {
        const id = run.native?.nativeMessageId;
        const prefix = id?.endsWith(':0') ? earlier.find(item => id.startsWith(item) && !id.startsWith(`${item}queue:`)) : undefined;
        if (prefix) this.inputCommands.set(id!.slice(prefix.length, -2), run.commandId);
      }
      if (!eligible.length) { this.inputScan = key; return []; }
      const from = Math.min(...eligible.map(fence => fence.offset));
      // A fence captured in the middle of an unfinished JSONL row must not make that row claimable.
      const partial = from > 0 && (await readRange(handle, from - 1, from))[0] !== 0x0a;
      const steps: SuffixStep[] = [];
      let at = from, buffer = EMPTY, skipPartial = partial;
      while (at < size) {
        if (signal?.aborted) return [];
        const chunk = await readRange(handle, at, Math.min(size, at + Math.max(READ_CHUNK, buffer.length)));
        if (!chunk.length) break;
        const joined = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        const start = at - buffer.length;
        const lines = linesOf(joined, start, skipPartial);
        for (const line of lines) {
          const row = parseLine(line.bytes);
          if (!row || row.isSidechain === true || row.agentId !== undefined
            || (row.sessionId !== undefined && row.sessionId !== nativeSessionId)) continue;
          if (row.type === 'queue-operation') {
            const text = typeof row.content === 'string' ? row.content : undefined;
            if (row.operation === 'enqueue') steps.push({ op: 'enqueue', offset: line.start, at: Date.parse(String(row.timestamp)), ...(text !== undefined ? { text } : {}) });
            else if (row.operation === 'dequeue') steps.push({ op: 'dequeue' });
            else if (row.operation === 'popAll') steps.push({ op: 'popAll' });
            else if (row.operation === 'remove') steps.push({ op: 'remove', ...(text !== undefined ? { text } : {}) });
            continue;
          }
          if (row.type !== 'user') continue;
          const prompt = claudeRowSignals(row).some(signal => signal.type === 'prompt');
          const human = typeof row.uuid === 'string' && row.isMeta !== true && row.isCompactSummary !== true && row.isVisibleInTranscriptOnly !== true
            && (record(row.origin)?.kind === undefined || record(row.origin)?.kind === 'human');
          const mapper: MapperState = { turnAt: '', calls: new Map(), tasks: new Map(), activities: new ClaudeActivities(this.sessionId) };
          const event = human ? mapRow(row, line.start, { ...this.session(), nativeSessionId }, mapper, { unbounded: true }, false).find(event => event.type === 'user_message_chunk') : undefined;
          if (prompt || event) steps.push({ op: 'prompt', offset: line.start, ...(event ? { event: { ...event, sequence: 0 } } : {}) });
        }
        const last = joined.lastIndexOf(0x0a);
        if (last >= 0) { buffer = joined.subarray(last + 1); skipPartial = false; }
        else buffer = joined;
        at += chunk.length;
        await giveWay();
      }
      if (nativeSessionId !== this.options.nativeSessionId()) { this.inputCommands.clear(); return []; }
      const users = suffixPrompts(steps);
      const matches = eligible.map(fence => {
        const native = fence.run.native!;
        const next = compatible.filter(other => other.offset > fence.offset).reduce((limit, other) => Math.min(limit, other.offset), Infinity);
        const at = native.timings?.dispatchAt;
        const candidates = users.filter(user => {
          if (native.nativeMessageId) return user.event.nativeId === native.nativeMessageId;
          if (compatible.some(other => other.run.native!.nativeMessageId === user.event.nativeId)
            || compatible.filter(other => other.offset === fence.offset).length !== 1
            || user.offset < fence.offset || user.offset >= next || at === undefined || !Number.isFinite(at)
            || !Number.isFinite(user.at) || user.at < at
            // A queued input is the queue receipt's to claim; this only settles one whose send was left unknown.
            || user.queued && native.delivery !== 'uncertain') return false;
          const text = promptText(user.event);
          return text !== undefined && claudePromptKey(text) === claudePromptKey(native.renderedText ?? native.input.text);
        });
        return { run: fence.run, candidates };
      });
      const receipts: Array<{ event: NativeWorkbenchEvent; run: Run }> = [];
      for (const match of matches) {
        if (match.candidates.length !== 1) continue;
        const user = match.candidates[0]!;
        if (matches.filter(other => other.candidates.some(candidate => candidate.event.nativeId === user.event.nativeId)).length !== 1) continue;
        const event = { ...user.event, data: { ...user.event.data, commandId: match.run.commandId } };
        this.inputCommands.set(event.nativeAliases![0]!, match.run.commandId);
        receipts.push({ event, run: match.run });
      }
      this.inputScan = key;
      return receipts;
    } finally { await handle.close(); }
  }

  /** Repair already-ingested rows before announcing their receipt; the input itself is never replayed. */
  private publishInputs(writer: LaneWriter, receipts: Array<{ event: NativeWorkbenchEvent; run: Run }>): void {
    for (const { event, run } of receipts) {
      if (run.native?.nativeSessionId !== this.options.nativeSessionId()) { this.inputScan = undefined; continue; }
      const w = writer.scratch ?? writer;
      if (!w.canReproject(event)) { this.inputScan = undefined; continue; }
      w.commit({ events: [event], cursor: w.cursor!, reproject: true });
      const nativeTurnId = event.nativeTurnId ?? event.runId!;
      if (!w.turnEndStatus(nativeTurnId)) w.turnStarted(nativeTurnId, event.createdAt, run.id);
      this.repairedInputs.add(`${run.id}:${event.nativeId}`);
      this.options.hooks?.inputReceipt?.({ ...event, runId: run.id, nativeTurnId,
        type: 'native_input_receipt', data: { commandId: run.commandId, nativeSessionId: this.options.nativeSessionId() } });
    }
  }

  private async files(): Promise<Array<string | undefined>> {
    const current = this.options.nativeSessionId();
    if (!current) return [];
    const ids = [...(this.options.previousNativeSessionIds?.() ?? []), current];
    const paths = await Promise.all(ids.map(async id => {
      const known = this.located.get(id);
      if (known && await stat(known).then(info => info.isFile(), () => false)) return known;
      const found = await this.options.locate(id);
      if (found) this.located.set(id, found); else this.located.delete(id);
      return found;
    }));
    return paths.at(-1) ? paths : [];
  }

  private async totalSize(files: ReadonlyArray<string | undefined>): Promise<number> {
    const sizes = await Promise.all(files.map(file => file ? stat(file).then(info => info.size, () => 0) : 0));
    return sizes.reduce((sum, size) => sum + size, 0);
  }

  /**
   * The tail window of a first import (G4), opened or read up to the end: what serves while `w` is imported from
   * the start. True while one serves.
   */
  private async window(w: LaneWriter, files: ReadonlyArray<string | undefined>, metas: readonly SubagentMeta[], signal?: AbortSignal): Promise<boolean> {
    const current = files.at(-1)!;
    if (w.cursor === null && !w.scratch && await this.totalSize(files) > PULL_BYTES) {
      const start = await tailStart(current);
      if (start > 0 || files.length > 1) await this.read(w.openScratch(), files, fresh(files.length - 1, start), Infinity, metas, signal);
    } else if (w.scratch) {
      await this.read(w.scratch, files, decode(w.scratch.cursor) ?? fresh(files.length - 1, await tailStart(current)), Infinity, metas, signal);
    }
    return w.scratch !== undefined;
  }

  /** Reads one main lane from `cursor`; once it is read to the end, what the files beside it say is settled in it too. */
  private async read(w: LaneWriter, files: ReadonlyArray<string | undefined>, cursor: Cursor, limit: number, metas: readonly SubagentMeta[], signal?: AbortSignal): Promise<{ done: boolean; read: number }> {
    if (!await this.repairLifecycle(w, files, cursor, true, signal)) return { done: false, read: 0 };
    cursor = decode(w.cursor) ?? cursor;
    if (!await this.recoverForkActivities(w, files, cursor, metas, signal)) return { done: false, read: 0 };
    cursor = decode(w.cursor) ?? cursor;
    const reader = new LaneRead(this, w, cursor, true);
    const result = await reader.run(files, limit, signal);
    if (result.done && !signal?.aborted) await reader.settle(metas, this.options.exited?.());
    return result;
  }

  /** Recover only omitted Skill activities before an old cursor; never replay input or unrelated events. */
  private async recoverForkActivities(w: LaneWriter, files: ReadonlyArray<string | undefined>, cursor: Cursor, metas: readonly SubagentMeta[], signal?: AbortSignal): Promise<boolean> {
    const targets = metas.flatMap(meta => {
      if (!meta.fork || !meta.background || meta.parentAgentId || w.event(activityId('claude', meta.agentId))) return [];
      const result = w.event(`claude:${this.options.nativeSessionId()}:${meta.fork.resultUuid}:0`);
      return result?.type === 'tool_call_update' && result.data.toolCallId === meta.toolUseId && result.data.status === 'completed' ? [{ meta, result }] : [];
    });
    if (!targets.length) return true;
    const activities = new ClaudeActivities(this.sessionId);
    const mapper: MapperState = { turnAt: '', calls: new OpenCalls(), tasks: new Map(), activities };
    for (let f = 0; f <= cursor.f; f += 1) {
      const file = files[f];
      if (!file) continue;
      const handle = await openFile(file);
      if (!handle) return false;
      try {
        const { size } = await handle.stat();
        const end = f === cursor.f ? Math.min(size, cursor.o) : size;
        let position = 0, buffer = EMPTY, since = performance.now();
        while (position < end) {
          if (signal?.aborted) return false;
          const chunk = await readRange(handle, position, Math.min(end, position + READ_CHUNK));
          if (!chunk.length) return false;
          const bytes = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
          for (const line of linesOf(bytes, position - buffer.length, false)) {
            const row = parseLine(line.bytes);
            if (row && row.isSidechain !== true && row.agentId === undefined) mapRow(row, line.start, this.session(), mapper, {});
            if (performance.now() - since >= STEP_MS) { await giveWay(); since = performance.now(); }
            if (signal?.aborted) return false;
          }
          const newline = bytes.lastIndexOf(0x0a);
          buffer = newline >= 0 ? bytes.subarray(newline + 1) : bytes;
          position += chunk.length;
        }
      } finally { await handle.close(); }
    }
    const exited = this.options.exited?.();
    for (const { meta } of targets) {
      const id = activityId('claude', meta.agentId);
      if (meta.finished || meta.stopped) activities.ended(id, meta.stopped ? 'stopped' : 'completed', meta.at);
      else if (exited) activities.ended(id, 'unknown', exited);
    }
    const recovered = activities.state();
    const ids = new Set(targets.map(({ meta }) => activityId('claude', meta.agentId)));
    const items = recovered.items.filter(item => ids.has(item.id));
    if (!items.length) return true;
    const old = cursor.s.m.x ?? { items: [] };
    const merged: ClaudeActivitiesState = {
      ...old, items: [...old.items.filter(item => !ids.has(item.id)), ...items],
      runs: [...(old.runs ?? []).filter(([id]) => !ids.has(id)), ...(recovered.runs ?? []).filter(([id]) => ids.has(id))],
      byToolCall: [...(old.byToolCall ?? []).filter(([, id]) => !ids.has(id)), ...(recovered.byToolCall ?? []).filter(([, id]) => ids.has(id))],
      agentsOver: [...new Set([...(old.agentsOver ?? []).filter(id => !ids.has(activityId('claude', id))), ...(recovered.agentsOver ?? []).filter(id => ids.has(activityId('claude', id)))])],
    };
    const next: Cursor = { ...cursor, s: { ...cursor.s, m: { ...cursor.s.m, x: merged } } };
    // Activities enter through the writer's ledger, in their original issuing turn. Naming an
    // existing turn changes no journal row; restore the cursor's current turn before continuing.
    w.transaction(() => {
      for (const activity of items) {
        const result = targets.find(({ meta }) => activityId('claude', meta.agentId) === activity.id)!.result;
        if (result.nativeTurnId) w.turnStarted(result.nativeTurnId, result.createdAt);
        w.activities.apply(activity);
      }
      const current = cursorTurn(cursor.s);
      if (current) w.turnStarted(current.k, NO_TIME);
      w.commit({ events: [], cursor: JSON.stringify(next) });
    });
    return true;
  }

  /**
   * Upgrade an already-read lane once. Only rows which the old classifier demonstrably got wrong
   * are revised; control-path stops, receipt ownership, unrelated rows and the generation survive.
   * Scan into memory before writing so an interrupted scan leaves the old cursor fully usable.
   */
  private async repairLifecycle(w: LaneWriter, files: ReadonlyArray<string | undefined>, cursor: Cursor, main: boolean, signal?: AbortSignal): Promise<boolean> {
    if (cursor.lifecycle === 1 || cursor.o === 0 && cursor.f === 0) return true;
    const changes: NativeWorkbenchEvent[] = [];
    const reopen = new Map<string, string>();
    const retire = new Set<string>();
    const continuations = new Map<string, string>();
    const stopped = new Set<string>();
    const ends = new Map<string, { status: TurnEndStatus; at: string; error?: string }>();
    const mapper: MapperState = { turnAt: '', calls: new OpenCalls(), tasks: new Map(), ...(main ? { activities: new ClaudeActivities(this.sessionId, {}, { retainEnded: RETAIN_ENDED }) } : {}) };
    const parents = new Map<string, string>();
    let state = initialState('alive'), correction: { promptId: string; runId?: string } | undefined;
    let childTurn: string | undefined, childSettled = false, boundary: { promptId: string; blocked: boolean } | undefined;
    for (let f = 0; f <= cursor.f; f += 1) {
      const path = files[f];
      if (!path) continue;
      const handle = await openFile(path);
      if (!handle) continue;
      try {
        const { size } = await handle.stat();
        const end = f === cursor.f ? Math.min(cursor.o, size) : size;
        let position = 0, buffer = EMPTY, since = performance.now();
        while (position < end) {
          if (signal?.aborted) return false;
          const chunk = await readRange(handle, position, Math.min(end, position + READ_CHUNK));
          if (!chunk.length) break;
          const bytes = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
          for (const line of linesOf(bytes, position - buffer.length, false)) {
            if (performance.now() - since > STEP_MS) { await giveWay(); since = performance.now(); if (signal?.aborted) return false; }
            const row = parseLine(line.bytes);
            if (!row || main && (row.isSidechain === true || row.agentId !== undefined)) continue;
            const at = typeof row.timestamp === 'string' ? row.timestamp : NO_TIME;
            const uuid = typeof row.uuid === 'string' ? row.uuid : `line-${line.start}`;
            const before = activeTurnOf(state.mainTurn);
            const signals = main ? claudeRowSignals(row, parents, before?.promptId) : [];
            const failure = claudeApiFailure(row);
            const message = record(row.message);
            if (main && row.isApiErrorMessage === true && message?.stop_reason === 'tool_use' && before?.promptId) {
              const content = message.content;
              const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => record(part)?.text ?? '').join('') : '';
              if (w.turnFailedAt(before.promptId, at, claudeFailureText(text))) {
                correction = { promptId: before.promptId, ...(mapper.turnId ? { runId: mapper.turnId } : {}) };
                reopen.set(before.promptId, at);
              }
            }
            if (!main && childSettled && subagentWake(row)) { childTurn = mapper.turnId = `claude-turn:${uuid}`; childSettled = false; }
            if (!main) childSettled = subagentSettles(row) ?? childSettled;
            const previousTurn = mapper.turnId;
            const events = mapRow(row, line.start, this.session(), mapper, {}, !main);
            if (!main && mapper.turnId && (!childTurn || previousTurn !== mapper.turnId)) childTurn = mapper.turnId;
            for (const event of events) {
              if (activityOfEvent(event)) continue;
              if (correction) {
                const saved = w.event(event.nativeId);
                // Old readers opened an anonymous continuation after the false failure. Reassign
                // only rows in that continuation or the original prompt, preserving their data.
                const old = saved?.nativeTurnId;
                const belongs = !signals.some(signal => signal.type === 'prompt') && (!old || old === correction.promptId || old.startsWith('claude-turn:'));
                if (belongs) {
                  if (old && old !== correction.promptId) {
                    const status = w.turnEndStatus(old);
                    if (status === 'cancelled' || status === 'interrupted') stopped.add(correction.promptId);
                    continuations.set(old, correction.promptId);
                    retire.add(turnMetaId(old, 'started')); retire.add(turnMetaId(old, 'ended'));
                  }
                  changes.push({ ...(saved ?? event), sequence: 0, nativeTurnId: correction.promptId,
                    ...(correction.runId ? { runId: correction.runId } : {}) } as NativeWorkbenchEvent);
                }
              }
            }
            if (!main && failure) {
              const id = `claude:${this.options.nativeSessionId()}:${uuid}:0`;
              const turnId = w.event(id)?.nativeTurnId ?? childTurn;
              if (turnId && w.turnEndStatus(turnId) === 'completed') {
                ends.set(turnId, { status: 'failed', at, error: failure });
                retire.add(id);
              }
            }
            for (const signal of signals) {
              const transition = reduce(state, signal);
              state = transition.state;
              const ended = transition.ended;
              if (ended?.promptId && (correction?.promptId === ended.promptId || signal.type === 'turn_end' && signal.reason === 'stop' && w.turnEndStatus(ended.promptId) === undefined)) {
                ends.set(ended.promptId, { status: ended.reason === 'stop_failure' ? 'failed' : ended.reason === 'interrupted' ? 'cancelled' : 'completed', at, ...(ended.error ? { error: ended.error } : {}) });
              }
              if (ended) correction = undefined;
            }
            const active = activeTurnOf(state.mainTurn);
            boundary = active?.promptId ? { promptId: active.promptId, blocked: active.stopBlocked === true } : undefined;
          }
          const newline = bytes.lastIndexOf(0x0a);
          buffer = newline >= 0 ? bytes.subarray(newline + 1) : bytes;
          position += chunk.length;
        }
      } finally { await handle.close(); }
    }
    if (signal?.aborted) return false;
    for (const promptId of stopped) { reopen.delete(promptId); ends.delete(promptId); }
    for (const [turnId, promptId] of continuations) if (stopped.has(promptId)) {
      retire.delete(turnMetaId(turnId, 'started')); retire.delete(turnMetaId(turnId, 'ended'));
    }
    const next: Cursor = { ...cursor, s: { ...cursor.s, m: { ...cursor.s.m }, ...(parents.size ? { parents: [...parents] } : {}) }, lifecycle: 1 };
    const old = cursorTurn(cursor.s);
    if (old && main && (reopen.has(old.p ?? old.k) || retire.has(turnMetaId(old.k, 'started')))) {
      const promptId = old.p ?? old.k;
      next.s.t = { k: promptId, p: promptId, open: !ends.has(promptId), ...(boundary?.promptId === promptId && boundary.blocked ? { b: 1 } : {}) };
      next.s.m.n = promptId;
      if (mapper.turnId) next.s.m.u = mapper.turnId;
      next.s.r = (next.s.r ?? []).filter(key => !retire.has(turnMetaId(key, 'started')));
    } else if (old && ends.has(old.k)) next.s.t = { ...old, open: false };
    else if (old?.open && boundary && boundary.promptId === old.p) next.s.t = { ...old, ...(boundary.blocked ? { b: 1 } : {}) };
    next.s.x = next.s.x?.filter(op => op[0] === 'act' || !reopen.has(op[1]) && !ends.has(op[1]) && !retire.has(turnMetaId(op[1], 'started')));
    // Open calls keep their issuing turn so later tool results merge with the corrected call.
    next.s.m.c = next.s.m.c?.map(([id, call]) => {
      const promptId = call.nativeTurnId ? continuations.get(call.nativeTurnId) : undefined;
      if (!promptId || stopped.has(promptId)) return [id, call];
      const changed = changes.find(event => event.type === 'tool_call' && event.data.toolCallId === id && event.nativeTurnId === promptId);
      return [id, { ...call, nativeTurnId: promptId, ...(changed?.runId ? { runId: changed.runId } : {}) }];
    });
    w.transaction(() => {
      for (const [turnId, at] of reopen) w.turnReopened(turnId, at);
      w.commit({ events: changes.filter(event => !stopped.has(event.nativeTurnId!)), retire: [...retire], cursor: w.cursor });
      for (const [turnId, end] of ends) w.turnEnded(turnId, end.status, end.at, end.error);
      w.commit({ events: [], cursor: JSON.stringify(next) });
    });
    return true;
  }

  /** Every subagent of the conversation into its lane, the agent that spawned it naming it there (G9). */
  private async children(w: LaneWriter, metas: readonly SubagentMeta[], limit: number, signal?: AbortSignal): Promise<boolean> {
    if (this.lanes?.owner !== w || this.lanes.generation !== w.generation) this.lanes = { owner: w, generation: w.generation, writers: new Map(), bound: new Map(), read: new Map() };
    const lanes = this.lanes;
    // Bindings are durable, so reconcile even after a restart or when this scan found no children.
    const visited = new Set<LaneWriter>();
    const reconcile = (owner: LaneWriter) => {
      if (visited.has(owner)) return;
      visited.add(owner);
      for (const binding of owner.subagents) {
        if (this.discovery.invalidates(binding.agentId, binding.toolCallId)) {
          const id = activityId('claude', binding.agentId);
          const activity = activityOfEvent(owner.event(id));
          owner.transaction(() => {
            owner.commit({ events: [], retire: [subagentMetaId(binding.toolCallId), ...(activity && this.invalidAgentActivity(activity) ? [id] : [])], cursor: owner.cursor });
            if (activity && this.invalidAgentActivity(activity)) owner.activities.forget(id);
          });
          lanes.writers.delete(binding.toolCallId);
          lanes.bound.delete(binding.toolCallId);
          lanes.read.delete(binding.toolCallId);
        } else reconcile(owner.child(binding.toolCallId, binding.agentId, binding));
      }
    };
    reconcile(w);
    if (w.scratch) reconcile(w.scratch);
    const exited = this.options.exited?.();
    let budget = limit, caughtUp = true;
    for (const meta of metas) {
      // The metadata file can acquire its title after this child was first opened. The writer keeps
      // its identity/cursor and only records fields that changed, even when the transcript did not.
      // Its first spawner stays: naming it again from a parent found later would record it twice.
      const described = JSON.stringify([meta.agentId, meta.info]);
      const bound = lanes.bound.get(meta.toolUseId);
      let child = lanes.writers.get(meta.toolUseId);
      if (!child || bound?.info !== described) {
        const spawner = bound?.spawner ?? (meta.parentAgentId ? lanes.writers.get(metas.find(item => item.agentId === meta.parentAgentId)?.toolUseId ?? '') : w);
        if (!spawner) continue;
        // Discovery reads ahead of the lane cursor. Wait until the launch has been ingested so
        // a partial import cannot permanently bind this child to an earlier unrelated turn.
        if (meta.fork && !spawner.event(`claude:${this.options.nativeSessionId()}:${meta.fork.resultUuid}:0`)) continue;
        child = spawner.child(meta.toolUseId, meta.agentId, meta.info);
        lanes.writers.set(meta.toolUseId, child);
        lanes.bound.set(meta.toolUseId, { spawner, info: described });
      }
      if (signal?.aborted || budget <= 0) { caughtUp = false; continue; }
      const info = await stat(meta.file).catch(() => undefined);
      if (!info) continue;
      // A child that has not changed since it was read is not opened again.
      const seen = `${info.ino}:${info.size}:${info.mtimeMs}:${meta.finished}:${meta.stopped}:${exited ?? ''}`;
      if (lanes.read.get(meta.toolUseId) === `${seen}:${child.cursor}`) continue;
      let cursor = decode(child.cursor);
      if (cursor && !await sameFile(meta.file, cursor)) { child.rebuild('identity-changed'); cursor = undefined; }
      if (cursor && !await this.repairLifecycle(child, [meta.file], cursor, false, signal)) { caughtUp = false; continue; }
      cursor = decode(child.cursor);
      const reader = new LaneRead(this, child, cursor ?? fresh(0, 0), false);
      const { done, read } = await reader.run([meta.file], budget, signal);
      budget -= read;
      if (!done) { caughtUp = false; continue; }
      // A child stopped or done for good writes no end of its own when it was cut off mid-round, nor one the CLI took with it.
      if (meta.finished || meta.stopped) reader.finish(meta.stopped ? 'cancelled' : 'completed', new Date(info.mtimeMs).toISOString());
      else if (exited) reader.finish('interrupted', exited);
      lanes.read.set(meta.toolUseId, `${seen}:${child.cursor}`);
    }
    return caughtUp;
  }

}

/** Who to wake when a conversation's transcript may have changed: the hooks and the transcript poll a running CLI already has. */
export class ClaudeTranscriptChanges {
  private readonly wakes = new Map<string, Set<() => void>>();

  on(sessionId: string, wake: () => void): () => void {
    let set = this.wakes.get(sessionId);
    if (!set) this.wakes.set(sessionId, set = new Set());
    set.add(wake);
    return () => { set.delete(wake); if (!set.size && this.wakes.get(sessionId) === set) this.wakes.delete(sessionId); };
  }

  emit(sessionId: string): void {
    for (const wake of this.wakes.get(sessionId) ?? []) { try { wake(); } catch { /* a reader's failure is its own */ } }
  }
}
