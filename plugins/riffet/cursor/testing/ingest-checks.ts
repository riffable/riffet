import assert from 'node:assert/strict';
import { activityOfEvent } from '@riffet/plugin-api/kit';
import { type AgentLaneBatch, type AgentLaneWriter, type AgentTranscriptSource } from '@riffet/plugin-api/experimental/agent';
import { FakeLaneWriter, FakeLanes, isHiddenKind, pullLane, type FakeRow } from './fake-lane-writer.js';

/*
 * What a transcript source must hold for any lane writer, as docs/SYNC-V3.md writes it (G2-G10), over
 * the recording writer: the checks about what the source writes. The journal's own guarantees (G1 numbering,
 * G5 payload storage, the generation a client sees across its storage) are the core's and tested there.
 */

const isScratch = (key: string): boolean => key.endsWith('#tail');

/** A copy of every row of a log, oldest first. */
export const rowsOf = (lanes: FakeLanes, key = 'main'): FakeRow[] => [...lanes.peek(key)?.rows ?? []];

export interface LaneCheckOptions {
  /** The newest turn of a lane may still be running; otherwise every turn must have ended. */
  openLastTurn?: boolean;
}

interface TurnFacts { started?: number; ended?: number; endStatus?: string; first?: number; lastNew?: number; toolCalls?: Set<string> }

/** G3, G6 and G10 for one log. */
export function checkLane(lanes: FakeLanes, key: string, options: LaneCheckOptions = {}): readonly FakeRow[] {
  const rows = rowsOf(lanes, key);
  const turns = new Map<string, TurnFacts>();
  const facts = (turnId: string) => { let turn = turns.get(turnId); if (!turn) turns.set(turnId, turn = {}); return turn; };
  for (const row of rows) {
    const where = `${key} seq ${row.seq} (${row.kind} ${row.nativeId})`;
    if (row.kind === 'meta.turn_started' && row.turnId) { facts(row.turnId).started ??= row.seq; continue; }
    if (row.kind === 'meta.turn_ended' && row.turnId) {
      // A corrected end supersedes the earlier outcome; a tombstoned end proves nothing about completion.
      if (lanes.entity(key, row.nativeId)?.seq === row.seq) {
        const turn = facts(row.turnId);
        turn.ended = row.seq;
        const status = (row.payload as { status?: unknown } | null)?.status;
        if (typeof status === 'string') turn.endStatus = status;
      }
      continue;
    }
    if (isHiddenKind(row.kind)) continue;
    assert.ok(row.turnId, `G3: ${where} has no turn id`);
    const activity = activityOfEvent(row.payload);
    if (activity) { assert.equal(row.nativeId, activity.id, `G10: ${where} carries activity ${activity.id} under another id`); facts(row.turnId).first ??= row.seq; continue; }
    const turn = facts(row.turnId);
    const toolCallId = (row.payload as { data?: { toolCallId?: unknown } } | null)?.data?.toolCallId;
    if (row.kind === 'tool_call' && typeof toolCallId === 'string') (turn.toolCalls ??= new Set()).add(toolCallId);
    const lateToolSettlement = row.kind === 'tool_call_update' && turn.ended !== undefined && turn.endStatus !== 'completed'
      && typeof toolCallId === 'string' && turn.toolCalls?.has(toolCallId);
    if (row.rev === 1) {
      turn.first ??= row.seq;
      if (!lateToolSettlement) turn.lastNew = row.seq;
    }
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
export function checkSession(lanes: FakeLanes, options: LaneCheckOptions = {}): void {
  const named = new Set<string>();
  for (const key of lanes.keys()) {
    for (const row of checkLane(lanes, key, options)) if (row.kind === 'meta.subagent') named.add(String((row.payload as { lane?: unknown }).lane));
  }
  for (const key of lanes.keys()) if (key.startsWith('sub:') && !isScratch(key)) assert.ok(named.has(key), `G9: lane ${key} is not named by a meta.subagent row`);
}

/** What every log of the session holds, to compare before and after a step. */
export type SessionSnapshot = Map<string, { generation: string; lastSeq: number; cursor: string | null; rows: string[] }>;

export function snapshot(lanes: FakeLanes): SessionSnapshot {
  const logs: SessionSnapshot = new Map();
  for (const key of lanes.keys()) {
    const log = lanes.peek(key)!;
    logs.set(key, { generation: log.generation, lastSeq: log.rows.length, cursor: log.cursor, rows: log.rows.map(row => `${row.nativeId}#${row.rev}:${row.digest}`) });
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
export function visibleLanes(lanes: FakeLanes): Record<string, Array<{ nativeId: string; kind: string; content: string }>> {
  const result: Record<string, Array<{ nativeId: string; kind: string; content: string }>> = {};
  for (const key of lanes.keys()) {
    if (isScratch(key)) continue;
    result[key] = lanes.entities(key).filter(entity => !isHiddenKind(entity.kind)).map(entity => {
      const activity = activityOfEvent(entity.payload);
      return { nativeId: entity.nativeId, kind: entity.kind, content: activity ? activity.status : entity.digest };
    });
  }
  return result;
}

export interface IngestContractFixture {
  /** A source over the native data as it is now; a new one is what a restarted service builds. */
  source(): AgentTranscriptSource;
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
}

export interface IngestContractOptions extends LaneCheckOptions {
  /** Pulls a step may take before the source counts as never catching up. */
  maxPulls?: number;
  /** How long `watch` has to call `wake` after the native data changed. */
  watchMs?: number;
}

export interface IngestContractReport {
  /** Generations a client would see during the first import, in order: a scratch window's, then the lane's own. */
  served: Array<{ generation: string; scratch: boolean }>;
  /** Rows per lane at the end. */
  lanes: Record<string, number>;
}

class InjectedFault extends Error {}

/** `writer`, whose every `commit` writes and then fails, so the rows are taken back. */
function failingCommits(writer: FakeLaneWriter): AgentLaneWriter {
  return new Proxy(writer, {
    get(target, property) {
      if (property === 'commit') return (batch: AgentLaneBatch) => { const saved = target.lanes.save(); target.commit(batch); target.lanes.restore(saved); throw new InjectedFault('injected commit fault'); };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function catchUp(source: AgentTranscriptSource, writer: FakeLaneWriter, maxPulls: number): Promise<void> {
  const signal = new AbortController().signal;
  for (let pulls = 0; pulls < maxPulls; pulls += 1) {
    if ((await pullLane(source, writer, signal)).caughtUp) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail(`the source did not catch up within ${maxPulls} pulls`);
}

/** The session as a fresh import of the fixture's current native data writes it. */
async function freshImport(fixture: IngestContractFixture, maxPulls: number) {
  const lanes = new FakeLanes();
  await catchUp(fixture.source(), FakeLaneWriter.open(lanes), maxPulls);
  return visibleLanes(lanes);
}

/**
 * Drives a source through a first import, a restart, an append, an update in place, a failed commit, a turn
 * typed into the terminal, a subagent and an identity change, and checks the lanes after each step. After
 * every step the lanes must equal a fresh import of the same native data (same entities, order and content),
 * which is what catches unstable ids and skipped reads. Throws an `AssertionError` naming the guarantee.
 */
export async function runIngestContract(fixture: IngestContractFixture, options: IngestContractOptions = {}): Promise<IngestContractReport> {
  const maxPulls = options.maxPulls ?? 10_000;
  const lanes = new FakeLanes();
  let writer = FakeLaneWriter.open(lanes);
  let source = fixture.source();
  const restart = () => { writer = FakeLaneWriter.open(lanes); source = fixture.source(); };
  const now = () => snapshot(lanes);
  const sameAsFresh = async (step: string) => {
    assert.deepEqual(visibleLanes(lanes), await freshImport(fixture, maxPulls),
      `G2/G7: after ${step} the log differs from a fresh import of the same native data: an id is not stable, or a read skipped or repeated something`);
  };
  const replays = async (step: string) => {
    restart();
    const before = now();
    await catchUp(source, writer, maxPulls);
    assertUnchanged(before, now(), step);
  };
  // First import: the generation a client sees changes once at most, from a scratch window to the lane's own log (G4).
  const served: IngestContractReport['served'] = [];
  const stop = lanes.onChange(key => {
    if (key !== 'main' && key !== 'main#tail') return;
    const scratch = lanes.peek('main#tail') !== undefined;
    const head = lanes.peek(scratch ? 'main#tail' : 'main');
    if (head && head.rows.length > 0 && served.at(-1)?.generation !== head.generation) served.push({ generation: head.generation, scratch });
  });
  await catchUp(source, writer, maxPulls);
  stop();
  assert.ok(!lanes.peek('main#tail'), 'G4: the scratch window still serves after the import caught up');
  assert.equal(served.at(-1)?.generation, writer.generation, 'G4: the lane does not end up served from its own log');
  if (fixture.scratch) assert.deepEqual(served.map(item => item.scratch), [true, false], `G4: the first import served ${served.length} generations; a scratch window, then the lane's own`);
  else assert.deepEqual(served.map(item => item.scratch), [false], `G4: the first import served ${served.length} generations; it serves one`);
  checkSession(lanes, options);
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
  assert.ok(rowsOf(lanes).length > before.get('main')!.lastSeq, 'an append wrote nothing');
  checkSession(lanes, options);
  await sameAsFresh('an append');

  // An update in place is a new version of the entity it changes (G2).
  before = now();
  await fixture.update();
  await catchUp(source, writer, maxPulls);
  assertExtends(before, now(), 'an update');
  const versions = rowsOf(lanes).filter(row => row.seq > before.get('main')!.lastSeq && row.rev > 1 && !isHiddenKind(row.kind));
  assert.ok(versions.length > 0, 'G2: an update in place wrote no new version of an existing entity');
  checkSession(lanes, options);
  await sameAsFresh('an update');

  // A failed commit leaves the cursor where it was, and the next read resumes from it (G7).
  await fixture.append();
  const cursor = writer.cursor;
  await source.pull(failingCommits(writer), new AbortController().signal).catch((error: unknown) => { if (!(error instanceof InjectedFault)) throw error; });
  assert.equal(writer.cursor, cursor, 'G7: a commit that failed moved the cursor');
  await catchUp(source, writer, maxPulls);
  checkSession(lanes, options);
  await sameAsFresh('a read resumed after a failed commit');
  await replays('a restart after a failed commit');

  // A turn nobody started from the workbench still has its start and end (G3); drain reads what is on disk (G6).
  await fixture.terminalTurn();
  await source.drain(writer);
  before = now();
  await catchUp(source, writer, maxPulls);
  assertUnchanged(before, now(), 'a read after drain', 'G6');
  checkSession(lanes, options);
  await sameAsFresh('a turn typed into the terminal');

  // A subagent writes to a lane of its own (G9).
  if (fixture.subagent) {
    const count = lanes.keys().length;
    before = now();
    await fixture.subagent();
    await catchUp(source, writer, maxPulls);
    assertExtends(before, now(), 'a subagent');
    assert.ok(lanes.keys().length > count, 'G9: a subagent opened no lane of its own');
    checkSession(lanes, options);
    await sameAsFresh('a subagent');
  }
  await replays('a restart');

  // Only another native conversation starts the log over (G8), under a new generation.
  if (fixture.changeIdentity) {
    const generation = writer.generation;
    await fixture.changeIdentity();
    await catchUp(source, writer, maxPulls);
    assert.notEqual(writer.generation, generation, 'G8: the lane kept its generation although it now reads another conversation');
    checkSession(lanes, options);
    await sameAsFresh('an identity change');
    await replays('a restart after an identity change');
  }
  const counts: Record<string, number> = {};
  for (const key of lanes.keys()) if (!isScratch(key)) counts[key] = lanes.peek(key)!.rows.length;
  return { served, lanes: counts };
}
