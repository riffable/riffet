import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect } from 'vitest';
import type { TimelineRow } from '../../../../packages/contracts/src/sync.js';
import { JournalFeed } from '../journal/feed.js';
import { hasTurnEnded, turnMetaId, type TranscriptSource, type TurnEndStatus } from '../journal/ingest.js';
import { checkSession } from '../journal/ingest-contract.js';
import { DRAFT_KIND, Journal, TOMBSTONE_KIND, laneKey } from '../journal/journal.js';
import { TimelineService, type TimelineChange } from '../timeline/service.js';
import { TranscriptIngest } from './ingest.js';

/**
 * Cross-layer read-pipeline contract (Journal + TranscriptIngest + JournalFeed + TimelineService/LaneFold).
 *
 * Enforces six system invariants that single-module unit tests miss because they emerge across module seams:
 * - **P1 (Timeline Equivalence)**: incremental `TimelineService` rows equal a full fold of the journal from seq 1.
 * - **P2 (No-Flicker & Row-Key Stability)**: across `TranscriptIngest.endTurn` and delayed backend flush, every
 *   intermediate client-visible frame preserves drafted content under the exact same `TimelineRow.key`.
 * - **P3 (Old-Turn Freeze)**: once a subsequent turn arrives, `LaneFold.rebase()` freezes the stopped turn
 *   (`timeline_heads.folded_through` advances past it and no live draft remains in it).
 * - **P4 (Control-Plane Truthfulness)**: delayed flush never emits a synthetic `turn_reopened` on an ended turn
 *   and preserves any refined failure `error` diagnostic on `meta.turn_ended`.
 * - **P5 (Visible Turn-Order Monotonicity)**: sorted by `identity`, live visible entities never interleave across
 *   turns (`T1 -> T2 -> T1`).
 * - **P6 (Delayed-Commit Convergence & Zero Spurious Reset)**: live timeline converges to a cold fresh import
 *   without emitting `reset` frames.
 */

export interface StopLifecycleContext {
  /** Pull the live source through `TranscriptIngest` and wait for `TimelineService` to settle. */
  pull(): Promise<void>;
}

export interface StopLifecycleSetup {
  /** Native turn id being interrupted/failed mid-flight. */
  turnId: string;
  /** Visible text snippet already present in the live timeline before stop that must survive stop and flush. */
  mustPreserveText: string;
  /** Status passed to `TranscriptIngest.endTurn` (default `'interrupted'`). */
  stopStatus?: TurnEndStatus;
  /** Optional failure diagnostic passed to `TranscriptIngest.endTurn`. */
  stopError?: string;
  /** ISO timestamp passed to `TranscriptIngest.endTurn`. */
  stopAt: string;
}

export interface ReadPipelineStopLifecycle {
  /** Bring the session to an active mid-turn state (prompt + streamed draft/work) before external stop. */
  startMidTurn(ctx: StopLifecycleContext): Promise<StopLifecycleSetup>;
  /** Optional: record a refined failure diagnostic before delayed backend persistence flushes (tests P4). */
  refineError?: { at: string; error: string };
  /** Optional: flush delayed backend persistence after external stop (e.g. `store.db` / JSONL late write). */
  flushAfterStop?(): Promise<void> | void;
  /** Optional: append a subsequent completed turn so P3 (`LaneFold.rebase()`) and P5 (monotonicity) are tested. */
  appendNextTurn?(): Promise<void> | void;
  /** Verify live timeline converges to a cold fresh import after `flushAfterStop` (default `true`). */
  checkColdEquivalence?: boolean;
  /** Forbid any `TimelineChange` with `type: 'reset'` during stop, flush, and next turn (default `true`). */
  forbidReset?: boolean;
}

export interface PreparedReadPipeline {
  sessionId?: string;
  /** Create a fresh `TranscriptSource` over the current backing store (used for both live run and cold import). */
  source(): TranscriptSource;
  /** Optional live stop-during-draft / delayed-flush scenario. */
  stopLifecycle?: ReadPipelineStopLifecycle;
  cleanup?(): Promise<void> | void;
}

export interface ReadPipelineFixture {
  name: string;
  prepare(): Promise<PreparedReadPipeline> | PreparedReadPipeline;
}

interface PipelineHost {
  db: DatabaseSync;
  journal: Journal;
  feed: JournalFeed;
  ingest: TranscriptIngest;
  timeline: TimelineService;
  sessionId: string;
  laneKey: string;
  pull(): Promise<void>;
  rows(): TimelineRow[];
  close(): void;
}

function openHost(sessionId: string, source: TranscriptSource): PipelineHost {
  const db = new DatabaseSync(':memory:');
  const journal = new Journal(db);
  const feed = new JournalFeed(journal);
  const ingest = new TranscriptIngest({ journal, source: id => (id === sessionId ? source : undefined) });
  const timeline = new TimelineService({
    db, journal, listRuns: () => [], nativeChatId: () => source.identity(),
    coldSweep: false, busy: () => false, debounceMs: 0, rebuildSettleMs: 0,
  });
  const key = laneKey(sessionId, 'main');
  return {
    db, journal, feed, ingest, timeline, sessionId, laneKey: key,
    async pull() {
      const release = ingest.follow(sessionId);
      try { await ingest.read(sessionId); } finally { release(); }
      await timeline.ready(sessionId, 'main');
    },
    rows: () => timeline.page(sessionId, 'main', { from: 0, rows: 500, bytes: 1024 * 1024 }).rows,
    close() {
      timeline.close();
      ingest.close();
      feed.close();
      db.close();
    },
  };
}

/** Canonical fold of a lane from seq 1 in a fresh TimelineService over an exact copy of the journal tables (P1 ground truth). */
export async function foldedFromScratch(sourceDb: DatabaseSync, sessionId: string, nativeChatId?: string): Promise<TimelineRow[]> {
  const scratchDb = new DatabaseSync(':memory:');
  const scratchJournal = new Journal(scratchDb);
  const heads = sourceDb.prepare('SELECT session_id, generation, last_seq, ingest_cursor, projection, projection_seq, updated_at, identity, compacted_seq FROM journal_heads').all() as Array<Record<string, SQLInputValue>>;
  const insertHead = scratchDb.prepare('INSERT INTO journal_heads(session_id, generation, last_seq, ingest_cursor, projection, projection_seq, updated_at, identity, compacted_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const h of heads) insertHead.run(h.session_id!, h.generation!, h.last_seq!, h.ingest_cursor!, h.projection!, h.projection_seq!, h.updated_at!, h.identity!, h.compacted_seq!);
  const events = sourceDb.prepare('SELECT session_id, seq, kind, native_id, rev, turn_id, at, digest, blob_ref, payload FROM journal_events ORDER BY session_id, seq').all() as Array<Record<string, SQLInputValue>>;
  const insertEvent = scratchDb.prepare('INSERT INTO journal_events(session_id, seq, kind, native_id, rev, turn_id, at, digest, blob_ref, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of events) insertEvent.run(row.session_id!, row.seq!, row.kind!, row.native_id!, row.rev!, row.turn_id!, row.at!, row.digest!, row.blob_ref!, row.payload!);
  const scratchTimeline = new TimelineService({
    db: scratchDb, journal: scratchJournal, listRuns: () => [], nativeChatId: () => nativeChatId,
    coldSweep: false, busy: () => false, debounceMs: 0, rebuildSettleMs: 0,
  });
  try {
    await scratchTimeline.ready(sessionId, 'main');
    return scratchTimeline.page(sessionId, 'main', { from: 0, rows: 500, bytes: 1024 * 1024 }).rows;
  } finally {
    scratchTimeline.close();
    scratchDb.close();
  }
}

const stripSeq = (rows: TimelineRow[]) => rows.map(({ seq: _seq, rev: _rev, ...rest }) => rest);

const rowHasText = (row: TimelineRow, needle: string): boolean => {
  if ('text' in row && typeof row.text === 'string' && row.text.includes(needle)) return true;
  return JSON.stringify(row.event).includes(needle);
};

/** Normalized semantic signature of a timeline row for cold-vs-live convergence checks (P6). */
function rowSummary(row: TimelineRow): { kind: TimelineRow['kind']; text?: string; toolCallId?: string; status?: string } {
  const data = row.event.data as { toolCallId?: string; status?: string } | undefined;
  return {
    kind: row.kind,
    ...('text' in row && typeof row.text === 'string' ? { text: row.text } : {}),
    ...(data?.toolCallId ? { toolCallId: data.toolCallId } : {}),
    ...(data?.status ? { status: data.status } : {}),
  };
}

/** P1: live `TimelineService` rows must match a clean fold from journal seq 1. */
async function assertTimelineEquivalence(host: PipelineHost, nativeChatId?: string): Promise<void> {
  const scratch = await foldedFromScratch(host.db, host.sessionId, nativeChatId);
  expect(stripSeq(host.rows())).toEqual(stripSeq(scratch));
}

/** P5: visible committed entities sorted by `identity` never interleave across turns (`T1 -> T2 -> T1`). */
function assertTurnOrderMonotonicity(journal: Journal, key: string): void {
  const latest = new Map<string, { identity: number; kind: string; turnId?: string; type?: string }>();
  for (const row of journal.range(key, 0, 1_000_000)) {
    if (row.kind.startsWith('meta.')) continue;
    const identity = latest.get(row.nativeId)?.identity ?? row.seq;
    const payload = row.payload as { type?: string } | undefined;
    latest.set(row.nativeId, { identity, kind: row.kind, ...(row.turnId ? { turnId: row.turnId } : {}), ...(payload?.type ? { type: payload.type } : {}) });
  }
  const visible = [...latest.values()]
    .filter(entity => entity.kind !== TOMBSTONE_KIND && entity.kind !== 'activity' && entity.turnId)
    .sort((left, right) => left.identity - right.identity);
  const closed = new Set<string>();
  let current: string | undefined;
  for (const entity of visible) {
    const turnId = entity.turnId!;
    expect(closed.has(turnId), `turn ${turnId} interleaved after a later turn began`).toBe(false);
    if (entity.type === 'user_message_chunk' && current && current !== turnId) {
      closed.add(current);
      current = turnId;
    } else if (!current) {
      current = turnId;
    }
  }
}

/** Runs all applicable P1–P6 invariants against a backend fixture using the real server read pipeline. */
export async function runReadPipelineContract(fixture: ReadPipelineFixture): Promise<void> {
  const prepared = await fixture.prepare();
  const sessionId = prepared.sessionId ?? `pipeline-${fixture.name}`;
  const liveSource = prepared.source();
  const host = openHost(sessionId, liveSource);

  try {
    // Baseline pull + P1 + P5 + G1–G10.
    if (!prepared.stopLifecycle) {
      await host.pull();
      checkSession(host.journal, sessionId);
      await assertTimelineEquivalence(host, liveSource.identity());
      assertTurnOrderMonotonicity(host.journal, host.laneKey);
      return;
    }

    const lifecycle = prepared.stopLifecycle;
    const setup = await lifecycle.startMidTurn({ pull: () => host.pull() });
    await host.timeline.ready(sessionId, 'main');
    await assertTimelineEquivalence(host, liveSource.identity());

    // Capture pre-stop client view and locate the preserved row key (P2).
    const beforeRows = host.rows();
    const clientView = new Map<string, TimelineRow>(beforeRows.map(row => [row.key, row]));
    const findPreserved = () => [...clientView.values()].find(row => rowHasText(row, setup.mustPreserveText));
    const preservedBefore = findPreserved();
    expect(preservedBefore, `expected "${setup.mustPreserveText}" in timeline before stop`).toBeDefined();
    const expectedKey = preservedBefore!.key;

    // Track every client-visible TimelineChange frame (P2 + P6) and every turn_reopened tombstone (P4).
    const frames: TimelineChange[] = [];
    const frameViolations: string[] = [];
    let trackingFlushReopens = false;
    const flushReopens: string[] = [];
    const endMarkerId = turnMetaId(setup.turnId, 'ended');
    const unsubTimeline = host.timeline.subscribe(sessionId, 'main', change => {
      frames.push(change);
      if (change.type === 'reset') {
        clientView.clear();
        return;
      }
      if (change.type !== 'rows') return;
      for (const delKey of change.deletes) clientView.delete(delKey);
      for (const row of change.upserts) clientView.set(row.key, row);
      // P2: no intermediate frame may drop or re-key the preserved row.
      const current = findPreserved();
      if (!current) frameViolations.push(`frame dropped "${setup.mustPreserveText}" during stop/flush`);
      else if (current.key !== expectedKey) frameViolations.push(`row key swapped (${expectedKey} -> ${current.key}) for "${setup.mustPreserveText}"`);
    });
    const unsubFeed = host.feed.subscribe(
      (sid, lane) => sid === sessionId && lane === 'main',
      batch => {
        if (!trackingFlushReopens) return;
        for (const item of batch.items) {
          if ('mark' in item && item.mark.edge === 'reopened' && item.mark.turnId === setup.turnId) {
            flushReopens.push(item.mark.turnId);
          }
        }
      },
    );

    try {
      // External stop through real TranscriptIngest.endTurn (D2).
      const stopStatus = setup.stopStatus ?? 'interrupted';
      await host.ingest.endTurn(sessionId, setup.turnId, stopStatus, setup.stopAt, setup.stopError);
      await host.timeline.ready(sessionId, 'main');

      expect(hasTurnEnded(host.journal, host.laneKey, setup.turnId)).toBe(true);
      expect(frameViolations).toEqual([]);
      await assertTimelineEquivalence(host, liveSource.identity());

      // P2 post-stop check on persisted timeline rows.
      const afterStop = host.rows().find(row => rowHasText(row, setup.mustPreserveText));
      expect(afterStop, `row "${setup.mustPreserveText}" vanished after stop`).toBeDefined();
      expect(afterStop!.key).toBe(expectedKey);

      // Optional P4 diagnostic refinement before delayed flush.
      let expectedError = setup.stopError;
      if (lifecycle.refineError) {
        const currentEnd = host.journal.entity(host.laneKey, endMarkerId);
        const currentStatus = (currentEnd?.payload as { status?: TurnEndStatus } | undefined)?.status ?? stopStatus;
        host.journal.append(host.laneKey, [{
          nativeId: endMarkerId,
          kind: 'meta.turn_ended',
          turnId: setup.turnId,
          at: lifecycle.refineError.at,
          payload: { turnId: setup.turnId, status: currentStatus, error: lifecycle.refineError.error },
        }]);
        expectedError = lifecycle.refineError.error;
        await host.timeline.ready(sessionId, 'main');
      }

      // Delayed backend persistence flush (P2 + P4 + P6).
      trackingFlushReopens = true;
      if (lifecycle.flushAfterStop) {
        await lifecycle.flushAfterStop();
        await host.pull();
      }
      // Allow JournalFeed's setImmediate delivery to flush before asserting P4.
      await new Promise<void>(resolve => setImmediate(resolve));
      trackingFlushReopens = false;

      // P4: zero synthetic turn_reopened during delayed flush, and failure diagnostic intact.
      expect(flushReopens, 'delayed flush must not emit synthetic turn_reopened').toEqual([]);
      expect(frameViolations).toEqual([]);
      if (expectedError !== undefined) {
        const endEntity = host.journal.entity(host.laneKey, endMarkerId);
        expect((endEntity?.payload as { error?: string } | undefined)?.error).toBe(expectedError);
      }

      // P1 + P2 + P5 after delayed flush.
      await assertTimelineEquivalence(host, liveSource.identity());
      assertTurnOrderMonotonicity(host.journal, host.laneKey);
      const afterFlush = host.rows().find(row => rowHasText(row, setup.mustPreserveText));
      expect(afterFlush, `row "${setup.mustPreserveText}" vanished after delayed flush`).toBeDefined();
      expect(afterFlush!.key).toBe(expectedKey);

      // Optional Turn 2 -> verifies P3 (old-turn freeze via LaneFold.rebase()) & P5 (monotonicity).
      if (lifecycle.appendNextTurn) {
        await lifecycle.appendNextTurn();
        await host.pull();
        expect(frameViolations).toEqual([]);
        await assertTimelineEquivalence(host, liveSource.identity());
        assertTurnOrderMonotonicity(host.journal, host.laneKey);

        // P3: Turn 1 must be frozen by LaneFold.rebase() (no leaked draft, no turn overlap).
        const stoppedTurnRows = host.journal.range(host.laneKey, 0, 1_000_000)
          .filter(row => row.turnId === setup.turnId && !row.kind.startsWith('meta.'));
        const latestStopped = new Map<string, string>();
        for (const row of stoppedTurnRows) latestStopped.set(row.nativeId, row.kind);
        expect([...latestStopped.values()].filter(kind => kind === DRAFT_KIND), 'stopped turn leaked an active draft').toEqual([]);

        const firstStoppedIdentity = stoppedTurnRows.length ? Math.min(...stoppedTurnRows.map(row => row.seq)) : 0;
        const head = host.db.prepare('SELECT folded_through FROM timeline_heads WHERE session_id = ? AND lane = ?')
          .get(sessionId, 'main') as { folded_through: number } | undefined;
        expect(head?.folded_through ?? 0, 'LaneFold.rebase() failed to freeze stopped turn after Turn 2').toBeGreaterThanOrEqual(firstStoppedIdentity);
      }

      // P6: zero spurious reset frames.
      if (lifecycle.forbidReset !== false) {
        expect(frames.filter(frame => frame.type === 'reset'), 'unexpected timeline reset during stop/flush/next-turn').toEqual([]);
      }

      // Journal contract checks (G1–G10) across the live session.
      checkSession(host.journal, sessionId);

      // P6: cold fresh import convergence against live timeline.
      if (lifecycle.checkColdEquivalence !== false) {
        const coldSource = prepared.source();
        const coldHost = openHost(sessionId, coldSource);
        try {
          await coldHost.pull();
          expect(host.rows().map(rowSummary)).toEqual(coldHost.rows().map(rowSummary));
        } finally {
          coldHost.close();
        }
      }
    } finally {
      unsubTimeline();
      unsubFeed();
    }
  } finally {
    host.close();
    await prepared.cleanup?.();
  }
}
