import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { activityOfEvent } from './activity.js';
import { JOURNAL_PAYLOAD_LIMIT, Journal, isHiddenKind, laneOfKey, type JournalRow } from './journal.js';
import { JournalLaneWriter, pullLane, servingKey, type LaneBatch, type LaneWriter, type TranscriptSource } from './ingest.js';

/**
 * The write contract of docs/SYNC-V3.md (G1–G10) as checks a backend runs against fixtures of its own.
 * {@link runIngestContract} drives a {@link TranscriptSource} through a first import, a restart, an
 * append, an update in place, a failed commit, a turn typed into the terminal, a subagent and an
 * identity change, and checks the journal after each step; the checks are exported for scenarios a
 * backend adds itself. After every step the log must equal a fresh import of the same native data
 * (same entities, same order, same content), which is what catches unstable ids and skipped reads.
 */

const PAGE = 5000;

/** Every row of a log, oldest first. */
export function rowsOf(journal: Journal, key: string): JournalRow[] {
  const rows: JournalRow[] = [];
  for (let after = 0; ;) {
    const page = journal.range(key, after, PAGE);
    rows.push(...page);
    if (page.length < PAGE) return rows;
    after = page.at(-1)!.seq;
  }
}

/** One row per number, from 1 to the head, nothing past it (G1, invariant 1). Returns the head. */
export function assertContiguous(journal: Journal, key: string): number {
  let expected = 1;
  for (let after = 0; ;) {
    const page = journal.range(key, after, PAGE);
    for (const row of page) { assert.equal(row.seq, expected, `G1: ${key} has seq ${row.seq} where ${expected} belongs`); expected += 1; }
    if (page.length < PAGE) break;
    after = page.at(-1)!.seq;
  }
  const head = journal.peek(key)?.lastSeq ?? 0;
  assert.equal(expected - 1, head, `G1: ${key} holds ${expected - 1} rows but its head is at ${head}`);
  return head;
}

export interface LaneCheckOptions {
  /** The newest turn of a lane may still be running; otherwise every turn must have ended. */
  openLastTurn?: boolean;
}

interface TurnFacts { started?: number; ended?: number; first?: number; lastNew?: number }

/** G1, G3, G5, G6 and G10 for one log; returns its rows. */
export function checkLane(journal: Journal, key: string, options: LaneCheckOptions = {}): JournalRow[] {
  assertContiguous(journal, key);
  const rows = rowsOf(journal, key);
  const turns = new Map<string, TurnFacts>();
  const facts = (turnId: string) => { let turn = turns.get(turnId); if (!turn) turns.set(turnId, turn = {}); return turn; };
  for (const row of rows) {
    const where = `${key} seq ${row.seq} (${row.kind} ${row.nativeId})`;
    const payload = row.payload as Record<string, unknown> | null;
    assert.ok(!payload || typeof payload !== 'object' || !('raw' in payload), `G5: ${where} stores the provider's raw record`);
    if (!row.blobRef) assert.ok(Buffer.byteLength(JSON.stringify(row.payload)) <= JOURNAL_PAYLOAD_LIMIT, `G5: ${where} keeps an oversized payload inline`);
    if (row.kind === 'meta.turn_started' && row.turnId) { facts(row.turnId).started ??= row.seq; continue; }
    if (row.kind === 'meta.turn_ended' && row.turnId) {
      // A corrected end supersedes the earlier outcome; a tombstoned end proves nothing about
      // completion. G6 still checks that the effective settled read follows the recovered items.
      if (journal.locate(key, row.nativeId)?.seq === row.seq) facts(row.turnId).ended = row.seq;
      continue;
    }
    if (isHiddenKind(row.kind)) continue;
    assert.ok(row.turnId, `G3: ${where} has no turn id`);
    const activity = activityOfEvent(payload);
    if (activity) { assert.equal(row.nativeId, activity.id, `G10: ${where} carries activity ${activity.id} under another id`); facts(row.turnId).first ??= row.seq; continue; }
    // Activities are their own axis and may outlive their turn; anything else is part of it.
    if (row.rev === 1) { const turn = facts(row.turnId); turn.first ??= row.seq; turn.lastNew = row.seq; }
  }
  const ordered = [...turns].sort(([, left], [, right]) => (left.started ?? left.first ?? 0) - (right.started ?? right.first ?? 0));
  ordered.forEach(([turnId, turn], index) => {
    if (turn.first !== undefined) assert.ok(turn.started !== undefined && turn.started < turn.first, `G3: turn ${turnId} in ${key} has no turn_started before its first event`);
    if (!(options.openLastTurn && index === ordered.length - 1)) assert.ok(turn.ended !== undefined, `G3: turn ${turnId} in ${key} has no turn_ended`);
    if (turn.ended !== undefined && turn.lastNew !== undefined) assert.ok(turn.lastNew < turn.ended, `G6: turn ${turnId} in ${key} gained an event after it ended; drain before turn_ended`);
  });
  return rows;
}

/** {@link checkLane} for every log of the session, and G9: a subagent lane is named by the lane that spawned it. */
export function checkSession(journal: Journal, sessionId: string, options: LaneCheckOptions = {}): void {
  const keys = journal.keysOf(sessionId);
  const named = new Set<string>();
  for (const key of keys) {
    for (const row of checkLane(journal, key, options)) if (row.kind === 'meta.subagent') named.add(String((row.payload as { lane?: unknown }).lane));
  }
  for (const key of keys) {
    const where = laneOfKey(key);
    if (where && where.lane !== 'main' && !where.scratch) assert.ok(named.has(where.lane), `G9: lane ${where.lane} is not named by a meta.subagent row`);
  }
}

/** What every log of a session holds, to compare before and after a step. */
export type SessionSnapshot = Map<string, { generation: string; lastSeq: number; cursor: string | null; rows: string[] }>;

export function snapshot(journal: Journal, sessionId: string): SessionSnapshot {
  const logs: SessionSnapshot = new Map();
  for (const key of journal.keysOf(sessionId)) {
    const head = journal.peek(key)!;
    logs.set(key, { generation: head.generation, lastSeq: head.lastSeq, cursor: head.ingestCursor, rows: rowsOf(journal, key).map(row => `${row.nativeId}#${row.rev}:${row.digest}`) });
  }
  return logs;
}

/** Nothing was written: a replay from a committed cursor (G7), with the same native ids (G2) and generation (G8). */
export function assertUnchanged(before: SessionSnapshot, after: SessionSnapshot, step: string, rule = 'G7'): void {
  assert.deepEqual([...after.keys()], [...before.keys()], `${rule}: ${step} changed which logs the session has`);
  for (const [key, log] of before) {
    const now = after.get(key)!;
    assert.equal(now.generation, log.generation, `G8: ${step} changed the generation of ${key}`);
    assert.equal(now.lastSeq, log.lastSeq, `${rule}: ${step} wrote ${now.lastSeq - log.lastSeq} rows to ${key}; it should find nothing new`);
  }
}

/** Rows were only added: every earlier row is where it was and the generation held (G8). */
export function assertExtends(before: SessionSnapshot, after: SessionSnapshot, step: string): void {
  for (const [key, log] of before) {
    const now = after.get(key);
    assert.ok(now, `G8: ${step} removed ${key}`);
    assert.equal(now.generation, log.generation, `G8: ${step} changed the generation of ${key}`);
    assert.deepEqual(now.rows.slice(0, log.rows.length), log.rows, `${step}: rows of ${key} were rewritten`);
  }
}

/** Each visible entity of every lane once, at its first position, with its latest content: the session as a reader shows it. */
export function visibleLanes(journal: Journal, sessionId: string): Record<string, Array<{ nativeId: string; kind: string; content: string }>> {
  const lanes: Record<string, Array<{ nativeId: string; kind: string; content: string }>> = {};
  for (const key of journal.keysOf(sessionId).sort()) {
    const where = laneOfKey(key);
    if (!where || where.scratch) continue;
    lanes[where.lane] = journal.entitiesBefore(key, Number.MAX_SAFE_INTEGER, 1_000_000).map(entity => {
      // An activity's own times come from the ledger (now, when the native data has none); its state is its status.
      const activity = activityOfEvent(entity.payload);
      return { nativeId: entity.nativeId, kind: entity.kind, content: activity ? activity.status : entity.digest };
    });
  }
  return lanes;
}

export interface IngestContractFixture {
  /** A source over the native data as it is now; a new one is what a restarted service builds. */
  source(): TranscriptSource;
  /** The first import is long enough to be served from a scratch tail window before it is promoted (G4). */
  scratch?: boolean;
  /** New entries at the end; every turn they touch ends. Called twice, so each call must add new turns. */
  append(): void | Promise<void>;
  /** An entry already read changes under its own native id (a tool result settles, a message is edited). */
  update(): void | Promise<void>;
  /** A whole turn typed into the CLI's own terminal, which no workbench run started. */
  terminalTurn(): void | Promise<void>;
  /** A subagent runs and writes a transcript of its own (G9). */
  subagent?(): void | Promise<void>;
  /** The session now follows another native conversation: `identity()` changes (G8). */
  changeIdentity?(): void | Promise<void>;
  /** Visible native ids per lane in transcript order, when the fixture knows them. */
  order?(): Record<string, string[]>;
}

export interface IngestContractOptions extends LaneCheckOptions {
  sessionId?: string;
  /** Pulls a step may take before the source counts as never catching up. */
  maxPulls?: number;
  /** How long `watch` has to call `wake` after the native data changed. */
  watchMs?: number;
}

export interface IngestContractReport {
  /** Generations a client saw during the first import, in order: a scratch window's, then the lane's own. */
  served: Array<{ generation: string; scratch: boolean }>;
  /** Rows per lane at the end. */
  lanes: Record<string, number>;
}

class InjectedFault extends Error {}

/** `writer`, whose every `commit` writes and then fails, so the transaction takes the rows back. */
function failingCommits(writer: JournalLaneWriter, journal: Journal): LaneWriter {
  return new Proxy(writer, {
    get(target, property) {
      if (property === 'commit') return (batch: LaneBatch) => journal.tx(() => { target.commit(batch); throw new InjectedFault('injected commit fault'); });
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function catchUp(source: TranscriptSource, writer: JournalLaneWriter, maxPulls: number): Promise<void> {
  const signal = new AbortController().signal;
  for (let pulls = 0; pulls < maxPulls; pulls += 1) {
    if ((await pullLane(source, writer, signal)).caughtUp) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail(`the source did not catch up within ${maxPulls} pulls`);
}

/** The session as a fresh import of the fixture's current native data writes it. */
async function freshImport(fixture: IngestContractFixture, sessionId: string, maxPulls: number) {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new Journal(db);
    await catchUp(fixture.source(), JournalLaneWriter.open(journal, sessionId), maxPulls);
    return visibleLanes(journal, sessionId);
  } finally { db.close(); }
}

/**
 * Runs the whole contract against `fixture` in a temporary database and throws an `AssertionError`
 * naming the guarantee (G1–G10) that does not hold. The fixture's native data is changed by its own
 * step functions; each step leaves every native turn finished unless `openLastTurn`.
 */
export async function runIngestContract(fixture: IngestContractFixture, options: IngestContractOptions = {}): Promise<IngestContractReport> {
  const sessionId = options.sessionId ?? 'contract-session';
  const maxPulls = options.maxPulls ?? 10_000;
  const dir = await mkdtemp(join(tmpdir(), 'riffet-ingest-contract-'));
  const path = join(dir, 'workbench.db');
  let db = new DatabaseSync(path);
  let journal = new Journal(db);
  let writer = JournalLaneWriter.open(journal, sessionId);
  let source = fixture.source();
  const restart = () => {
    db.close();
    db = new DatabaseSync(path);
    journal = new Journal(db);
    writer = JournalLaneWriter.open(journal, sessionId);
    source = fixture.source();
  };
  const now = () => snapshot(journal, sessionId);
  const sameAsFresh = async (step: string) => {
    assert.deepEqual(visibleLanes(journal, sessionId), await freshImport(fixture, sessionId, maxPulls),
      `G2/G7: after ${step} the log differs from a fresh import of the same native data: an id is not stable, or a read skipped or repeated something`);
    if (fixture.order) {
      const lanes = visibleLanes(journal, sessionId);
      for (const [lane, ids] of Object.entries(fixture.order())) assert.deepEqual(lanes[lane]?.map(entity => entity.nativeId), ids, `G4: after ${step} lane ${lane} is not in transcript order`);
    }
  };
  const replays = async (step: string) => {
    restart();
    const before = now();
    await catchUp(source, writer, maxPulls);
    assertUnchanged(before, now(), step);
  };
  try {
    // First import: the generation a client sees changes once at most, from a scratch window to the lane's own log (G4).
    const served: IngestContractReport['served'] = [];
    const stop = journal.onAppend(change => {
      if (change.lane !== 'main') return;
      const serving = servingKey(journal, sessionId, 'main');
      const head = journal.peek(serving.key);
      if (head && head.lastSeq > 0 && served.at(-1)?.generation !== head.generation) served.push({ generation: head.generation, scratch: serving.scratch });
    });
    await catchUp(source, writer, maxPulls);
    stop();
    assert.ok(!servingKey(journal, sessionId, 'main').scratch, 'G4: the scratch window still serves after the import caught up');
    assert.equal(served.at(-1)?.generation, writer.generation, 'G4: the lane does not end up served from its own log');
    if (fixture.scratch) assert.deepEqual(served.map(item => item.scratch), [true, false], `G4: the first import served ${served.length} generations; a scratch window, then the lane's own`);
    else assert.deepEqual(served.map(item => item.scratch), [false], `G4: the first import served ${served.length} generations; it serves one`);
    checkSession(journal, sessionId, options);
    await sameAsFresh('the first import');
    await replays('a restart after the first import');

    // Appending writes only new rows after the old ones, and `watch` notices.
    let before = now();
    if (source.watch) {
      let woke = false;
      const unwatch = source.watch(writer, () => { woke = true; });
      await fixture.append();
      const deadline = Date.now() + (options.watchMs ?? 2000);
      while (!woke && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      unwatch();
      assert.ok(woke, 'watch did not wake after the native data changed');
    } else await fixture.append();
    await catchUp(source, writer, maxPulls);
    assertExtends(before, now(), 'an append');
    assert.ok(journal.peek(writer.key)!.lastSeq > before.get(writer.key)!.lastSeq, 'an append wrote nothing');
    checkSession(journal, sessionId, options);
    await sameAsFresh('an append');

    // An update in place is a new version of the entity it changes (G2).
    before = now();
    await fixture.update();
    await catchUp(source, writer, maxPulls);
    assertExtends(before, now(), 'an update');
    const versions = rowsOf(journal, writer.key).filter(row => row.seq > before.get(writer.key)!.lastSeq && row.rev > 1 && !isHiddenKind(row.kind));
    assert.ok(versions.length > 0, 'G2: an update in place wrote no new version of an existing entity');
    checkSession(journal, sessionId, options);
    await sameAsFresh('an update');

    // A failed commit leaves the cursor where it was, and the next read resumes from it (G7).
    await fixture.append();
    const cursor = writer.cursor;
    await source.pull(failingCommits(writer, journal), new AbortController().signal).catch((error: unknown) => { if (!(error instanceof InjectedFault)) throw error; });
    assert.equal(writer.cursor, cursor, 'G7: a commit that failed moved the cursor');
    await catchUp(source, writer, maxPulls);
    checkSession(journal, sessionId, options);
    await sameAsFresh('a read resumed after a failed commit');
    await replays('a restart after a failed commit');

    // A turn nobody started from the workbench still has its start and end (G3); drain reads what is on disk (G6).
    await fixture.terminalTurn();
    await source.drain(writer);
    before = now();
    await catchUp(source, writer, maxPulls);
    assertUnchanged(before, now(), 'a read after drain', 'G6');
    checkSession(journal, sessionId, options);
    await sameAsFresh('a turn typed into the terminal');

    // A subagent writes to a lane of its own (G9).
    if (fixture.subagent) {
      const lanes = journal.keysOf(sessionId).length;
      before = now();
      await fixture.subagent();
      await catchUp(source, writer, maxPulls);
      assertExtends(before, now(), 'a subagent');
      assert.ok(journal.keysOf(sessionId).length > lanes, 'G9: a subagent opened no lane of its own');
      checkSession(journal, sessionId, options);
      await sameAsFresh('a subagent');
    }
    await replays('a restart');

    // Only another native conversation starts the log over (G8), under a new generation.
    if (fixture.changeIdentity) {
      const generation = writer.generation;
      await fixture.changeIdentity();
      await catchUp(source, writer, maxPulls);
      assert.notEqual(writer.generation, generation, 'G8: the lane kept its generation although it now reads another conversation');
      checkSession(journal, sessionId, options);
      await sameAsFresh('an identity change');
      await replays('a restart after an identity change');
    }
    const lanes: Record<string, number> = {};
    for (const key of journal.keysOf(sessionId)) { const where = laneOfKey(key); if (where && !where.scratch) lanes[where.lane] = journal.peek(key)!.lastSeq; }
    return { served, lanes };
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
