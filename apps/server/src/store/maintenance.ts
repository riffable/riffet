import { SETTING_DEFAULTS, STORAGE_BUDGET, type Session } from '../../../../packages/contracts/src/index.js';
import { eventLoopBusy } from '../loop-health.js';
import { restartObservation } from '../session-identity.js';
import { optimizeDatabase, reclaimFreePages } from '../sqlite-storage.js';
import { maintainDerivedSearch } from './derived-search.js';
import { ACTIVE_SESSION_STATES, now, SESSION_SNAPSHOTS_KEPT, type StorePort } from './shared.js';

/** Schema v2 cleanup: drop the ACP-only `interactions` table and every non-native conversation with its runs and events. */
function purgeAcpConversations(port: StorePort): void {
  port.db.exec('BEGIN IMMEDIATE');
  try {
    port.db.exec('DROP TABLE IF EXISTS interactions;');
    const acp = (port.sql("SELECT id FROM sessions WHERE json_extract(json,'$.kind') IS NOT 'native'").all() as Array<{ id: string }>).map(row => row.id);
    const removeEvents = port.sql('DELETE FROM events WHERE session_id=?');
    const removeRuns = port.sql('DELETE FROM runs WHERE session_id=?');
    const removeSession = port.sql('DELETE FROM sessions WHERE id=?');
    for (const id of acp) { removeEvents.run(id); removeRuns.run(id); removeSession.run(id); }
    port.db.exec('PRAGMA user_version=2;');
    port.db.exec('COMMIT;');
  } catch (error) {
    port.db.exec('ROLLBACK');
    throw error;
  }
}

function backfillSessionActivity(port: StorePort): void {
  port.db.exec('BEGIN IMMEDIATE');
  try {
    const sessions = port.sql('SELECT id,json FROM sessions').all() as Array<{ id: string; json: string }>;
    const latestRun = new Map((port.sql("SELECT session_id,MAX(json_extract(json,'$.createdAt')) AS at FROM runs GROUP BY session_id").all() as Array<{ session_id: string; at: string | null }>).flatMap(row => row.at ? [[row.session_id, row.at] as const] : []));
    const latestMessage = new Map((port.sql(`SELECT session_id,MAX(json_extract(json,'$.createdAt')) AS at FROM events
      WHERE json_extract(json,'$.type') IN ('user_message_chunk','agent_message_chunk','agent_thought_chunk','tool_call','tool_call_update','plan','question_answer')
      GROUP BY session_id`).all() as Array<{ session_id: string; at: string | null }>).flatMap(row => row.at ? [[row.session_id, row.at] as const] : []));
    for (const row of sessions) {
      const session = JSON.parse(row.json) as Session;
      if (typeof session.lastActivityAt === 'string' && Number.isFinite(Date.parse(session.lastActivityAt))) continue;
      const candidates = [session.createdAt, latestRun.get(row.id), latestMessage.get(row.id)]
        .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
        .map(value => new Date(value).toISOString());
      session.lastActivityAt = candidates.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? now();
      port.sql('UPDATE sessions SET json=? WHERE id=?').run(JSON.stringify(session), row.id);
    }
    port.sql('INSERT INTO settings(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run('session-last-activity-backfill-v1', JSON.stringify(true));
    port.db.exec('COMMIT;');
  } catch (error) {
    port.db.exec('ROLLBACK');
    throw error;
  }
}

export function runStartupMigrations(port: StorePort, schemaVersion: number): void {
  if (schemaVersion < 2) {
    try { purgeAcpConversations(port); } catch (error) { console.error('[riffet] store migration purge-acp (schema v2) failed; retrying on next start:', error); }
  }
  const userVersion = () => (port.sql('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (userVersion() === 2) port.db.exec('PRAGMA user_version=3;');
  port.db.exec('DROP TABLE IF EXISTS project_entry_revisions; DROP TABLE IF EXISTS project_entries; DROP TABLE IF EXISTS project_mutations; DROP TABLE IF EXISTS project_credentials; DROP TABLE IF EXISTS project_injections; DROP TABLE IF EXISTS project_messages; DROP TABLE IF EXISTS project_contexts;');
  const dropSpaceTables = `DROP TABLE IF EXISTS space_entry_revisions; DROP TABLE IF EXISTS space_entries; DROP TABLE IF EXISTS space_messages;
    DROP TABLE IF EXISTS space_injections; DROP TABLE IF EXISTS space_credentials; DROP TABLE IF EXISTS space_mutations;
    DROP INDEX IF EXISTS session_space; DROP TABLE IF EXISTS spaces;`;
  const scrubSpaceReferences = `UPDATE sessions SET json=json_remove(json,'$.spaceId') WHERE json_extract(json,'$.spaceId') IS NOT NULL;
    UPDATE runs SET json=json_remove(json,'$.native.spaceContext') WHERE json_extract(json,'$.native.spaceContext') IS NOT NULL;`;
  let spacesRemoved = false;
  if (userVersion() === 3) {
    try {
      port.transaction(() => {
        port.db.exec(dropSpaceTables);
        port.db.exec(scrubSpaceReferences);
        port.db.exec('PRAGMA user_version=4;');
      });
      spacesRemoved = true;
    } catch (error) { console.error('[riffet] store migration drop-spaces (schema v4) failed; retrying on next start:', error); }
  }
  if (!spacesRemoved) {
    try { port.db.exec(dropSpaceTables); port.db.exec(scrubSpaceReferences); } catch (error) { console.error('[riffet] store cleanup spaces failed; retrying on next start:', error); }
  }
  if (userVersion() === 4) port.db.exec('PRAGMA user_version=5;');
  if (!port.getSetting('session-last-activity-backfill-v1', false)) {
    try { backfillSessionActivity(port); } catch (error) { console.error('[riffet] store migration session-last-activity-backfill-v1 failed; retrying on next start:', error); }
  }
  if (port.getSetting('session-last-activity-backfill-v1', false) && !port.getSetting('session-seen-backfill-v1', false)) {
    try {
      port.transaction(() => {
        port.db.exec(`UPDATE sessions SET json=json_set(json,'$.seenActivityAt',COALESCE(json_extract(json,'$.lastActivityAt'),json_extract(json,'$.createdAt')))
          WHERE json_extract(json,'$.seenActivityAt') IS NULL`);
        port.setSetting('session-seen-backfill-v1', true);
      });
    } catch (error) { console.error('[riffet] store migration session-seen-backfill-v1 failed; retrying on next start:', error); }
  }
  try { pruneAllSnapshots(port); } catch (error) { console.error('[riffet] startup snapshot pruning failed; retrying on next start:', error); }
}

export function pruneAllSnapshots(port: StorePort): number {
  const ids = (port.sql('SELECT id FROM sessions').all() as Array<{ id: string }>).map(row => row.id);
  let removed = 0;
  port.transaction(() => {
    for (const id of ids) removed += pruneSessionSnapshots(port, id) + pruneRunSnapshots(port, id);
  });
  if (removed && (port.sql('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum === 2) port.db.exec('PRAGMA incremental_vacuum(5000)');
  return removed;
}

export function pruneSessionSnapshots(port: StorePort, sessionId: string, keep: number = SESSION_SNAPSHOTS_KEPT): number {
  const cutoff = port.sql(`SELECT sequence FROM events WHERE session_id=? AND json_extract(json,'$.type')='session' ORDER BY sequence DESC LIMIT 1 OFFSET ?`).get(sessionId, Math.max(0, keep - 1)) as { sequence: number } | undefined;
  if (!cutoff) return 0;
  return Number(port.sql(`DELETE FROM events WHERE session_id=? AND sequence<? AND json_extract(json,'$.type')='session'`).run(sessionId, cutoff.sequence).changes);
}

export function pruneRunSnapshots(port: StorePort, sessionId: string, runId?: string): number {
  if (runId !== undefined) {
    return Number(port.sql(`DELETE FROM events WHERE session_id=?1 AND json_extract(json,'$.type')='run_updated' AND json_extract(json,'$.runId')=?2
      AND sequence<(SELECT MAX(sequence) FROM events WHERE session_id=?1 AND json_extract(json,'$.type')='run_updated' AND json_extract(json,'$.runId')=?2)`).run(sessionId, runId).changes);
  }
  return Number(port.sql(`DELETE FROM events WHERE session_id=?1 AND json_extract(json,'$.type')='run_updated'
    AND sequence NOT IN (SELECT MAX(sequence) FROM events WHERE session_id=?1 AND json_extract(json,'$.type')='run_updated' GROUP BY json_extract(json,'$.runId'))`).run(sessionId).changes);
}

/** Ids of cold conversations archived before `cutoffIso` (skipping any with live hot timeline rows). */
export function archivedSessionsBefore(port: StorePort, cutoffIso: string): string[] {
  const hot = port.hotTimelineSessions();
  return port.allSessions()
    .filter(session => typeof session.archivedAt === 'string' && session.archivedAt < cutoffIso && !hot.has(session.id))
    .map(session => session.id);
}

/** Ids of cold conversations eligible for oversized tool output head+tail trimming. */
export function coldSessionsForTrimming(port: StorePort, nowMs = Date.now()): string[] {
  const archivedCutoff = STORAGE_BUDGET.archivedTrimDays > 0
    ? new Date(nowMs - STORAGE_BUDGET.archivedTrimDays * 86_400_000).toISOString()
    : undefined;
  const inactiveCutoff = STORAGE_BUDGET.inactiveTrimDays > 0
    ? new Date(nowMs - STORAGE_BUDGET.inactiveTrimDays * 86_400_000).toISOString()
    : undefined;
  if (!archivedCutoff && !inactiveCutoff) return [];
  const hot = port.hotTimelineSessions();
  const ids: string[] = [];
  for (const session of port.allSessions()) {
    if (hot.has(session.id) || ACTIVE_SESSION_STATES.has(session.state)) continue;
    if (typeof session.archivedAt === 'string') {
      if (archivedCutoff && session.archivedAt < archivedCutoff) ids.push(session.id);
      continue;
    }
    if (!inactiveCutoff) continue;
    const latest = [session.lastActivityAt, session.updatedAt, session.createdAt]
      .filter((value): value is string => typeof value === 'string')
      .sort()
      .at(-1);
    if (latest && latest < inactiveCutoff) ids.push(session.id);
  }
  return ids;
}

/** The active personal-assistant main conversation and an age cutoff (`beforeAt`) for trimming old oversized tool outputs. */
export function assistantMainForTrimming(port: StorePort, nowMs = Date.now()): { sessionId: string; beforeAt: string } | undefined {
  if (STORAGE_BUDGET.assistantTrimDays <= 0) return undefined;
  const project = port.listProjects().find(item => item.system === 'assistant' && typeof item.mainSessionId === 'string');
  const mainId = project?.mainSessionId;
  if (!mainId) return undefined;
  const session = port.get<Session>('sessions', mainId);
  if (!session || typeof session.archivedAt === 'string' || ACTIVE_SESSION_STATES.has(session.state)) return undefined;
  let beforeAt = new Date(nowMs - STORAGE_BUDGET.assistantTrimDays * 86_400_000).toISOString();
  const settings = port.getSettings();
  if (settings.assistant?.consolidation ?? SETTING_DEFAULTS.assistant.consolidation) {
    const consolidatedThrough = port.getSetting<string | undefined>('assistant-consolidated-through', undefined);
    if (consolidatedThrough && consolidatedThrough < beforeAt) beforeAt = consolidatedThrough;
  }
  return { sessionId: mainId, beforeAt };
}

/** Attachments a message still points at: every unfinished run's, and every run's accepted since `since`. */
export function referencedAttachmentIds(port: StorePort, since: string): Set<string> {
  const rows = port.sql(`SELECT DISTINCT a.value AS id FROM runs r, json_each(r.json,'$.native.input.attachmentIds') a
    WHERE json_extract(r.json,'$.createdAt')>=? OR json_extract(r.json,'$.state') NOT IN ('completed','failed','cancelled','interrupted')`).all(since) as Array<{ id: unknown }>;
  const terminalRows = port.sql(`SELECT DISTINCT a.value AS id FROM settings s, json_each(s.json,'$.attachmentIds') a
    WHERE s.key LIKE 'terminal-paste:%'`).all() as Array<{ id: unknown }>;
  const followUpRows = port.sql("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='automations'").get()
    ? port.sql(`SELECT DISTINCT a.value AS id FROM automations f, json_each(f.json,'$.input.attachmentIds') a
      WHERE f.follow_up_session IS NOT NULL AND json_extract(f.json,'$.followUp.by')='user'`).all() as Array<{ id: unknown }> : [];
  return new Set([...rows, ...terminalRows, ...followUpRows].flatMap(row => typeof row.id === 'string' ? [row.id] : []));
}

/**
 * Drops exited terminal records created before `before` that nothing active needs any more.
 * Cold non-running sessions whose `terminalId` still points at such an old exited terminal are
 * detached from that dead `terminalId` (their `nativeSessionId` is untouched so resuming still works).
 */
export function pruneExitedTerminals(port: StorePort, before: string): number {
  const activeRunTerminals = new Set<string>();
  for (const run of port.listUnfinishedNativeRuns()) if (run.native?.terminalId) activeRunTerminals.add(run.native.terminalId);
  const oldExited = new Set(
    (port.sql(`SELECT id FROM terminals WHERE json_extract(json,'$.state')='exited' AND json_extract(json,'$.createdAt')<?`).all(before) as Array<{ id: string }>)
      .map(row => row.id),
  );
  if (!oldExited.size) return 0;

  const referenced = new Set<string>(activeRunTerminals);
  const detachSessions: Array<{ id: string; json: string }> = [];
  for (const row of port.sql(`SELECT id, json FROM sessions WHERE json_extract(json,'$.terminalId') IS NOT NULL`).all() as Array<{ id: string; json: string }>) {
    let parsed: { terminalId?: string; state?: string };
    try { parsed = JSON.parse(row.json) as { terminalId?: string; state?: string }; } catch { continue; }
    const terminalId = parsed.terminalId;
    if (!terminalId) continue;
    const isWorking = parsed.state === 'starting' || parsed.state === 'running' || parsed.state === 'waiting' || parsed.state === 'cancelling';
    if (!isWorking && oldExited.has(terminalId) && !activeRunTerminals.has(terminalId)) {
      const { terminalId: _drop, ...rest } = parsed as Record<string, unknown>;
      detachSessions.push({ id: row.id, json: JSON.stringify(rest) });
    } else {
      referenced.add(terminalId);
    }
  }

  const remove = port.sql('DELETE FROM terminals WHERE id=?');
  const updateSession = port.sql('UPDATE sessions SET json=? WHERE id=?');
  let removed = 0;
  port.transaction(() => {
    for (const item of detachSessions) updateSession.run(item.json, item.id);
    for (const id of oldExited) {
      if (referenced.has(id)) continue;
      removed += Number(remove.run(id).changes);
      port.sql('DELETE FROM settings WHERE key LIKE ?').run(`terminal-paste:${id}:%`);
    }
  });
  if (detachSessions.length) port.sessionsChanged(detachSessions.map(item => item.id));
  if (removed) port.terminalsChanged();
  return removed;
}

/** Bounded online incremental vacuum, planner stats refresh, and incremental maintenance across L0, L1 and L2. */
export function reclaimSpace(port: StorePort, options: { busy?: () => boolean; checkpoint?: boolean; vacuumOnly?: boolean } = {}): { control: number; journal: number; derived: number } {
  const isBusy = options.busy ?? eventLoopBusy;
  if (!options.vacuumOnly && !isBusy()) {
    let trimmedBlobs = 0;
    try {
      const coldIds = coldSessionsForTrimming(port);
      if (coldIds.length) trimmedBlobs = port.journal.trimArchivedToolBlobs(coldIds, { limit: 20 });
      const assistant = assistantMainForTrimming(port);
      if (assistant && trimmedBlobs < 20) {
        trimmedBlobs += port.journal.trimArchivedToolBlobs([assistant.sessionId], { limit: 20 - trimmedBlobs, beforeAt: assistant.beforeAt });
      }
    } catch { /* best-effort cold trimming */ }
    if (trimmedBlobs > 0 && !isBusy()) {
      try { port.journal.sweepBlobs(); } catch { /* best-effort immediate sweep of newly unreferenced blobs */ }
    }
    if (!isBusy()) {
      try { port.journal.recompressSmallBlobs({ maxBlobs: 200 }); } catch { /* best-effort dict upgrade */ }
    }
    if (!isBusy()) maintainDerivedSearch(port, { maxToolTrims: 500 });
  }
  const result = {
    control: reclaimFreePages(port.db, { ...options, busy: isBusy }),
    journal: reclaimFreePages(port.journalDb, { ...options, busy: isBusy }),
    derived: reclaimFreePages(port.derivedDb, { ...options, busy: isBusy }),
  };
  if ((!options.vacuumOnly || options.checkpoint) && !isBusy()) {
    optimizeDatabase(port.db);
    optimizeDatabase(port.journalDb);
    optimizeDatabase(port.derivedDb);
  }
  if (options.checkpoint) {
    for (const db of [port.db, port.journalDb, port.derivedDb]) {
      try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* ignore */ }
    }
  }
  return result;
}

export function recoverInterruptedRuns(port: StorePort): void {
  port.transaction(() => {
    for (const session of port.listSessions()) {
      for (const run of port.listRuns(session.id)) {
        if (session.kind === 'native' && run.native) {
          if (['completed', 'failed', 'cancelled'].includes(run.state) || ['failed', 'cancelled'].includes(run.native.delivery)) continue;
          const delivery = run.native.delivery;
          if (delivery === 'queued' || delivery === 'preparing') {
            if (run.native.intent === 'steer') { port.requeueSteer(run.id); continue; }
            if (delivery !== 'queued' || run.state !== 'queued' || run.error) {
              port.transitionNativeRun(run.id, [delivery], { delivery: 'queued' }, { state: 'queued', error: undefined });
            }
          } else if (delivery === 'dispatching' || delivery === 'input_sent') {
            const released = run.native.intent === 'steer' && port.isSteerTargetTurnEnded(run);
            port.transitionNativeRun(run.id, [delivery], {
              delivery: 'uncertain',
              ...(released ? { queueReleasedAt: now() } : {}),
            }, {
              state: 'interrupted',
              error: 'Local service restarted while native terminal delivery was in progress; the prompt was not resent.',
            });
          } else if (!run.native.queueReleasedAt && (restartObservation(run.native.backendId) === 'hook'
            && (delivery === 'observed' || delivery === 'uncertain' && run.native.nativeMessageId
              && ['runtime_exit', 'turn_outcome_unknown'].includes(run.native.stage ?? ''))
            && (run.native.expectsTurnOutcome || run.native.intent === 'steer')
            || restartObservation(run.native.backendId) === 'daemon' && delivery === 'observed' && run.native.nativeTurnId)) {
            port.transitionNativeRun(run.id, [delivery], { delivery: 'observed', stage: 'executing', expectsTurnOutcome: true }, {
              state: 'running', error: undefined,
            });
          } else if (delivery === 'uncertain' && run.native.intent === 'steer' && !run.native.queueReleasedAt && port.isSteerTargetTurnEnded(run)) {
            port.transitionNativeRun(run.id, ['uncertain'], { queueReleasedAt: now() });
          }
        } else if (run.state === 'running') {
          port.updateRun(run.id, { state: 'interrupted', error: 'Local service restarted; prompt was not resubmitted.' });
        }
      }
    }
  });
}
