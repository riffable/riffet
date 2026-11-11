/**
 * Benchmark for the server timeline fold (docs/SYNC-V3.md, 时间线由服务端折叠; U2 acceptance: one append on a
 * 6844-entry turn folds in p99 < 20ms).
 *
 * 1. Synthetic: a session of finished turns and an open turn of 6844 entries (answers, thoughts, tool calls
 *    that later complete as new versions). Reports the full-session fold, a cold start after a restart
 *    (only the open turn is folded again), per-append latency on the open turn, and the row table's size.
 * 2. With `--db <copy of workbench.db>`: a real session's journal (the largest unless `--session`), copied
 *    into a temporary database first so the input is only read. Folds it whole, then replays the tail of
 *    its largest turn one row at a time for per-append latency.
 *
 * Run: node --import tsx scripts/bench-timeline.ts [--db COPY] [--session ID] [--appends N]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { NativeWorkbenchEvent } from '../packages/contracts/src/index.js';
import { JournalLaneWriter } from '../apps/server/src/journal/ingest.js';
import { Journal } from '../apps/server/src/journal/journal.js';
import { TimelineService } from '../apps/server/src/timeline/service.js';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const APPENDS = Number(option('--appends') ?? 400);
const OPEN_TURN = 6844;
const ms = (value: number) => `${value.toFixed(1)}ms`;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)}KB`;
const quantile = (values: number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!; };
const latency = (label: string, values: number[]) => console.log(`${label}: n=${values.length} p50=${ms(quantile(values, 0.5))} p95=${ms(quantile(values, 0.95))} p99=${ms(quantile(values, 0.99))} max=${ms(Math.max(...values))}`);

function service(db: DatabaseSync, journal: Journal): TimelineService {
  return new TimelineService({ db, journal, listRuns: () => [], debounceMs: 0, onError: error => { throw error; } });
}

function tableSize(db: DatabaseSync, sessionId: string): string {
  const rows = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(LENGTH(key)+LENGTH(turn)+LENGTH(digest)+40),0) AS overhead FROM timeline_rows WHERE session_id=?').get(sessionId) as { n: number; bytes: number; overhead: number };
  const journal = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS bytes FROM journal_events WHERE session_id=? OR (session_id>=? AND session_id<?)').get(sessionId, `${sessionId}#`, `${sessionId}$`) as { n: number; bytes: number };
  return `rows=${rows.n} payload=${kb(rows.bytes)} (+~${kb(rows.overhead)} keys) vs journal events=${journal.n} payload=${kb(journal.bytes)}`;
}

async function synthetic(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'riffet-bench-timeline-'));
  const path = join(dir, 'state.db');
  const sessionId = 'bench-session';
  let tick = 0;
  const at = () => new Date(Date.UTC(2026, 9, 1) + ++tick * 1000).toISOString();
  const event = (nativeId: string, type: string, data: Record<string, unknown>, turn: string): NativeWorkbenchEvent => ({ sequence: 0, sessionId, type, data, createdAt: at(), nativeId, nativeTurnId: turn });
  const text = (value: string) => ({ content: { type: 'text', text: value } });
  const prose = (index: number) => `Step ${index}: ${'reading the code and deciding what to change next. '.repeat(4)}`;
  let db = new DatabaseSync(path);
  let journal = new Journal(db);
  const writer = JournalLaneWriter.open(journal, sessionId);
  let cursor = 0;
  const commit = (events: NativeWorkbenchEvent[]) => writer.commit({ events, cursor: String(++cursor) });
  /** Entry `index` of a turn: a thought, an answer, or a tool call whose completion follows two entries later. */
  const entries = (turn: string, count: number, offset = 0) => {
    const out: NativeWorkbenchEvent[] = [];
    for (let index = offset; index < offset + count; index += 1) {
      const kind = index % 4;
      if (kind === 0) out.push(event(`${turn}:th${index}`, 'agent_thought_chunk', text(prose(index)), turn));
      else if (kind === 1) out.push(event(`${turn}:as${index}`, 'agent_message_chunk', text(prose(index)), turn));
      else out.push(event(`${turn}:tool${index}`, 'tool_call', { toolCallId: `${turn}-call-${index}`, title: `Read file ${index}`, kind: 'read', status: 'completed', rawInput: { path: `src/file-${index}.ts` }, content: [{ type: 'content', content: { type: 'text', text: prose(index).repeat(3) } }] }, turn));
    }
    return out;
  };

  const FINISHED = 60, PER_TURN = 60;
  for (let turnIndex = 0; turnIndex < FINISHED; turnIndex += 1) {
    const turn = `turn-${turnIndex}`;
    writer.turnStarted(turn, at());
    commit([event(`${turn}:user`, 'user_message_chunk', text(`Question ${turnIndex}`), turn), ...entries(turn, PER_TURN)]);
    writer.turnEnded(turn, 'completed', at());
  }
  const open = 'turn-open';
  writer.turnStarted(open, at());
  commit([event(`${open}:user`, 'user_message_chunk', text('The long task'), open)]);
  for (let offset = 0; offset < OPEN_TURN - 1; offset += 500) commit(entries(open, Math.min(500, OPEN_TURN - 1 - offset), offset));
  console.log(`synthetic: ${FINISHED} finished turns of ${PER_TURN + 1} entries, open turn of ${OPEN_TURN} entries`);

  let timeline = service(db, journal);
  let start = performance.now();
  await timeline.ready(sessionId, 'main');
  console.log(`full-session fold (first open, nothing stored): ${ms(performance.now() - start)}`);
  console.log(`row table: ${tableSize(db, sessionId)}`);
  timeline.close(); db.close();

  db = new DatabaseSync(path);
  journal = new Journal(db);
  const restarted = JournalLaneWriter.open(journal, sessionId);
  timeline = service(db, journal);
  start = performance.now();
  await timeline.ready(sessionId, 'main');
  console.log(`cold start after restart (folds the open turn only): ${ms(performance.now() - start)}`);

  const appends: number[] = [];
  const kinds = new Map<string, number[]>();
  for (let index = 0; index < APPENDS; index += 1) {
    const kind = ['new tool call', 'tool completes (new version)', 'new answer', 'answer grows (new version)'][index % 4]!;
    const own = index - (index % 2);
    const batch = [index % 4 === 0 ? event(`${open}:live-tool${own}`, 'tool_call', { toolCallId: `live-${own}`, title: 'npm test', status: 'in_progress' }, open)
      : index % 4 === 1 ? event(`${open}:live-tool${own}`, 'tool_call', { toolCallId: `live-${own}`, title: 'npm test', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] }, open)
        : index % 4 === 2 ? event(`${open}:live-as${own}`, 'agent_message_chunk', text(prose(own)), open)
          : event(`${open}:live-as${own}`, 'agent_message_chunk', text(`${prose(own)} And more.`), open)];
    restarted.commit({ events: batch, cursor: String(++cursor) });
    const begin = performance.now();
    await timeline.ready(sessionId, 'main');
    const spent = performance.now() - begin;
    appends.push(spent);
    kinds.set(kind, [...(kinds.get(kind) ?? []), spent]);
  }
  latency(`append on the ${OPEN_TURN}-entry open turn`, appends);
  for (const [kind, values] of kinds) latency(`  ${kind}`, values);
  timeline.close(); db.close();
  rmSync(dir, { recursive: true, force: true });
}

/** A real session's journal copied out of `source` into a fresh database: rows, heads and the blobs they refer to. */
function copySession(source: string, sessionId: string | undefined, path: string): { sessionId: string; db: DatabaseSync } {
  const input = new DatabaseSync(source, { readOnly: true });
  const id = sessionId ?? (input.prepare("SELECT session_id FROM journal_events WHERE instr(session_id,'#')=0 GROUP BY session_id ORDER BY COUNT(*) DESC LIMIT 1").get() as { session_id: string }).session_id;
  const db = new DatabaseSync(path);
  new Journal(db);
  const match = 'session_id=? OR (session_id>=? AND session_id<?)';
  const params = [id, `${id}#`, `${id}$`];
  db.exec('BEGIN');
  const insertHead = db.prepare('INSERT INTO journal_heads(session_id,generation,last_seq,ingest_cursor,projection_seq,updated_at,identity) VALUES(?,?,?,?,0,?,?)');
  for (const head of input.prepare(`SELECT * FROM journal_heads WHERE ${match}`).all(...params) as Array<Record<string, string | number | null>>) {
    insertHead.run(head.session_id, head.generation, head.last_seq, head.ingest_cursor, head.updated_at, head.identity ?? null);
  }
  const insertEvent = db.prepare('INSERT INTO journal_events(session_id,seq,kind,native_id,rev,turn_id,at,payload,blob_ref,digest) VALUES(?,?,?,?,?,?,?,?,?,?)');
  // The input is only ever read: blobs come through its read-only handle.
  const readBlob = input.prepare('SELECT hash,size,bytes,created_at FROM blobs WHERE hash=?');
  const insertBlob = db.prepare('INSERT OR IGNORE INTO blobs(hash,size,bytes,created_at) VALUES(?,?,?,?)');
  for (const row of input.prepare(`SELECT * FROM journal_events WHERE ${match} ORDER BY session_id, seq`).iterate(...params) as Iterable<Record<string, string | number | null>>) {
    insertEvent.run(row.session_id, row.seq, row.kind, row.native_id, row.rev, row.turn_id, row.at, row.payload, row.blob_ref, row.digest);
    const blob = row.blob_ref ? readBlob.get(row.blob_ref) as { hash: string; size: number; bytes: Uint8Array; created_at: string } | undefined : undefined;
    if (blob) insertBlob.run(blob.hash, blob.size, blob.bytes, blob.created_at);
  }
  db.exec('COMMIT');
  input.close();
  return { sessionId: id, db };
}

async function realSample(source: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'riffet-bench-timeline-real-'));
  const { sessionId, db } = copySession(source, option('--session'), join(dir, 'state.db'));
  const journal = new Journal(db);
  const head = journal.peek(sessionId)!;
  const biggest = db.prepare('SELECT turn_id, COUNT(*) AS n, MAX(seq) AS last FROM journal_events WHERE session_id=? AND turn_id IS NOT NULL GROUP BY turn_id ORDER BY n DESC LIMIT 1').get(sessionId) as { turn_id: string; n: number; last: number };
  console.log(`\nreal sample ${sessionId}: ${head.lastSeq} journal rows; largest turn ${biggest.turn_id} has ${biggest.n} rows (last seq ${biggest.last})`);

  let timeline = service(db, journal);
  let start = performance.now();
  await timeline.ready(sessionId, 'main');
  console.log(`offline fold of the whole session: ${ms(performance.now() - start)}`);
  console.log(`row table: ${tableSize(db, sessionId)}`);
  const outline = timeline.outline(sessionId, 'main');
  console.log(`outline: ${outline.turnCount} turns`);
  timeline.close();

  // Replay the largest turn's last rows one at a time onto a log cut just before them.
  const replay = Math.min(APPENDS, biggest.n - 1);
  const cut = biggest.last - replay;
  const tail = journal.range(sessionId, cut, replay);
  db.exec('BEGIN');
  db.prepare('DELETE FROM journal_events WHERE session_id=? AND seq>?').run(sessionId, cut);
  db.prepare('UPDATE journal_heads SET last_seq=? WHERE session_id=?').run(cut, sessionId);
  for (const table of ['timeline_rows', 'timeline_heads', 'timeline_turns']) db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
  db.exec('COMMIT');
  const replayed = new Journal(db);
  timeline = service(db, replayed);
  start = performance.now();
  await timeline.ready(sessionId, 'main');
  console.log(`fold up to ${replay} rows before the largest turn's end: ${ms(performance.now() - start)}`);
  const window = db.prepare('SELECT folded_through FROM timeline_heads WHERE session_id=? AND lane=?').get(sessionId, 'main') as { folded_through: number };
  console.log(`window starts after journal seq ${window.folded_through}`);
  const appends: number[] = [];
  const slowest: Array<{ spent: number; what: string }> = [];
  for (const row of tail) {
    replayed.append(sessionId, [{ kind: row.kind, nativeId: row.nativeId, ...(row.turnId ? { turnId: row.turnId } : {}), at: row.at, payload: row.payload }]);
    const begin = performance.now();
    await timeline.ready(sessionId, 'main');
    const spent = performance.now() - begin;
    appends.push(spent);
    slowest.push({ spent, what: `${row.kind}${row.rev > 1 ? ` rev ${row.rev}` : ''}` });
  }
  latency(`append replayed onto the ${biggest.n}-row turn`, appends);
  console.log(`  slowest: ${slowest.sort((a, b) => b.spent - a.spent).slice(0, 4).map(item => `${ms(item.spent)} ${item.what}`).join(', ')}`);
  timeline.close(); db.close();
  rmSync(dir, { recursive: true, force: true });
}

await synthetic();
const source = option('--db');
if (source) await realSample(source);
