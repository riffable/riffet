import { randomUUID } from 'node:crypto';
import type {
  CapturedSessionReference, NativeDeliveryState, NativeRunConfig,
  NativeRunDetails, NativeRunInput, NativeTurnTarget, Run, RunMetrics,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { NATIVE_MODEL_LIMIT, restartObservation, type IdentifiedRun } from '../session-identity.js';
import { hitFromSession } from './derived-search.js';
import {
  fingerprint, normalizeNativeConfig, now, PENDING_FORK_BRIEF_PREFIX, searchScope,
  type MessageSearchHit, type PendingForkBrief, type StorePort,
} from './shared.js';

export function createRun(port: StorePort, sessionId: string, commandId: string, prompt: string): Run {
  return port.transaction(() => {
    const duplicate = port.sql('SELECT json FROM runs WHERE session_id=? AND command_id=?').get(sessionId, commandId) as { json: string } | undefined;
    if (duplicate) return port.run(duplicate.json);
    port.getSession(sessionId);
    const stamp = now();
    const run: Run = { id: randomUUID(), sessionId, commandId, prompt, state: 'queued', createdAt: stamp, updatedAt: stamp };
    port.sql('INSERT INTO runs(id,session_id,command_id,json) VALUES(?,?,?,?)').run(run.id, sessionId, commandId, JSON.stringify(run));
    port.updateSessionActivity(sessionId, stamp);
    port.nameFromMessage(sessionId, prompt);
    port.runChanged(run);
    return run;
  });
}

export function acceptNativeRun(
  port: StorePort,
  sessionId: string,
  commandId: string,
  input: NativeRunInput,
  config: NativeRunConfig,
  expectedConfigRevision?: number,
  steer?: { target: NativeTurnTarget; ownerRunId?: string; sourceRunId?: string },
  contextSnapshots?: CapturedSessionReference[],
): IdentifiedRun {
  if (typeof commandId !== 'string' || !commandId || commandId.length > 200) throw new AppError('INVALID_COMMAND_ID', 'commandId must be a non-empty string up to 200 characters');
  const normalizedInput = port.normalizeNativeInput(input);
  // Ordinary requests need no session lookup before the transaction; long, qualified side-chat selectors do.
  const owner = typeof config?.model === 'string' && config.model.length > NATIVE_MODEL_LIMIT ? port.getSession(sessionId) : undefined;
  const normalizedConfig = normalizeNativeConfig(config, owner?.backendId === 'chat' && owner.origin?.kind === 'discussion');
  const idempotencyFingerprint = fingerprint(steer
    ? { input: normalizedInput, intent: 'steer', target: { nativeSessionId: steer.target.nativeSessionId, turnId: steer.target.turnId }, ...(steer.sourceRunId ? { sourceRunId: steer.sourceRunId } : {}) }
    : { input: normalizedInput, config: normalizedConfig });
  return port.transaction(() => {
    const session = port.getSession(sessionId);
    if (session.kind !== 'native') throw new AppError('NOT_NATIVE', 'Native submissions require a native conversation', 409);
    const duplicate = port.sql('SELECT json FROM runs WHERE session_id=? AND command_id=?').get(sessionId, commandId) as { json: string } | undefined;
    if (duplicate) {
      const existing = port.run(duplicate.json);
      if (existing.native?.fingerprint !== idempotencyFingerprint) throw new AppError('COMMAND_ID_CONFLICT', 'This commandId was already used for a different native submission', 409);
      return existing;
    }
    if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'Restore this conversation before sending a message', 409);
    if (steer && (!steer.target.nativeSessionId || !steer.target.turnId || session.nativeSessionId !== steer.target.nativeSessionId)) {
      throw new AppError('STEER_TARGET_CHANGED', 'The current task changed; the instruction was not sent', 409);
    }
    const configRevision = session.configRevision ?? 0;
    if (expectedConfigRevision !== undefined && expectedConfigRevision !== configRevision) {
      throw new AppError('NATIVE_CONFIG_CHANGED', 'Native conversation settings changed before this submission was accepted', 409, { expected: expectedConfigRevision, actual: configRevision });
    }
    const stamp = now();
    let effectiveInput = normalizedInput;
    if (!steer) {
      const briefKey = `${PENDING_FORK_BRIEF_PREFIX}${sessionId}`;
      const pendingBrief = port.getSetting<PendingForkBrief | undefined>(briefKey, undefined);
      if (pendingBrief) {
        const trimmedStart = normalizedInput.text.trimStart();
        if (trimmedStart.startsWith('/')) {
          if (/^\/(?:clear|new)(?:\s|$)/i.test(trimmedStart)) port.deleteSetting(briefKey);
        } else {
          const heading = pendingBrief.language === 'en' ? '## Next step' : '## 接下来';
          effectiveInput = { ...normalizedInput, text: `${pendingBrief.brief}\n\n${heading}\n${normalizedInput.text}` };
          port.deleteSetting(briefKey);
        }
      }
    }
    const run = port.identified({
      id: randomUUID(), sessionId, commandId, prompt: effectiveInput.text, state: 'queued', createdAt: stamp, updatedAt: stamp,
      native: {
        input: effectiveInput,
        ...(contextSnapshots?.length ? { contextSnapshots } : {}),
        config: normalizedConfig,
        fingerprint: idempotencyFingerprint,
        delivery: 'queued',
        attempt: 0,
        ...(session.terminalId ? { terminalId: session.terminalId } : {}),
        backendId: session.backendId,
        ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
        configRevision,
        ...(steer ? {
          intent: 'steer' as const, nativeSessionId: steer.target.nativeSessionId, nativeTurnId: steer.target.turnId,
          ...(steer.ownerRunId ? { ownerRunId: steer.ownerRunId } : {}), ...(steer.sourceRunId ? { sourceRunId: steer.sourceRunId } : {}), stage: 'steer_pending',
        } : {}),
      },
    });
    port.sql('INSERT INTO runs(id,session_id,command_id,json) VALUES(?,?,?,?)').run(run.id, sessionId, commandId, JSON.stringify(run));
    port.updateSessionActivity(sessionId, stamp);
    port.appendEvent(sessionId, 'run_updated', { run }, { runId: run.id });
    port.nameFromMessage(sessionId, normalizedInput.text);
    port.runChanged(run);
    return run;
  });
}

/** Accept a distinct steering command and cancel its queued source in the same durable write. */
export function steerQueuedNativeRun(port: StorePort, sessionId: string, sourceRunId: string, commandId: string, target: NativeTurnTarget, config: NativeRunConfig, ownerRunId?: string): IdentifiedRun {
  return port.transaction(() => {
    const existing = port.findRunByCommand(sessionId, commandId);
    if (existing) {
      if (!existing.native || existing.native.sourceRunId !== sourceRunId) throw new AppError('COMMAND_ID_CONFLICT', 'This request was already used for another message', 409);
      return acceptNativeRun(port, sessionId, commandId, existing.native.input, existing.native.config, undefined, { target, sourceRunId, ownerRunId: existing.native.ownerRunId });
    }
    const source = port.getRun(sourceRunId);
    if (source.sessionId !== sessionId || !source.native) throw new AppError('RUN_NOT_FOUND', 'The queued message does not exist', 404);
    if (source.native.intent || source.state !== 'queued' || source.native.delivery !== 'queued') throw new AppError('RUN_NOT_QUEUED', 'This message has left the queue; refresh and try again', 409);
    const run = acceptNativeRun(port, sessionId, commandId, source.native.input, config, undefined, { target, sourceRunId, ownerRunId }, source.native.contextSnapshots);
    const cancelled = transitionNativeRun(port, source.id, ['queued'], { delivery: 'cancelled', stage: 'steer_replaced' }, { state: 'cancelled' });
    if (!cancelled) throw new AppError('RUN_NOT_QUEUED', 'This message has left the queue; refresh and try again', 409);
    return run;
  });
}

export function requeueSteer(port: StorePort, id: string): IdentifiedRun | undefined {
  return port.transaction(() => {
    const native = port.getRun(id).native;
    if (native?.intent !== 'steer') return undefined;
    return transitionNativeRun(port, id, ['queued', 'preparing'], {
      intent: undefined, nativeTurnId: undefined, ownerRunId: undefined, renderedText: undefined, diagnostic: undefined,
      delivery: 'queued', stage: 'steer_fallback', timings: { ...native.timings, fallbackAt: native.timings?.fallbackAt ?? Date.now() },
    }, { state: 'queued', error: undefined });
  });
}

export function getRun(port: StorePort, id: string): IdentifiedRun {
  const row = port.sql('SELECT json FROM runs WHERE id=?').get(id) as { json: string } | undefined;
  if (!row) throw new AppError('RUN_NOT_FOUND', 'Run does not exist', 404);
  return port.run(row.json);
}

export function previousRunId(port: StorePort, sessionId: string, runId: string): string | undefined {
  const row = port.sql('SELECT id FROM runs WHERE session_id=? AND rowid < (SELECT rowid FROM runs WHERE session_id=? AND id=?) ORDER BY rowid DESC LIMIT 1')
    .get(sessionId, sessionId, runId) as { id: string } | undefined;
  return row?.id;
}

export function findRunByCommand(port: StorePort, sessionId: string, commandId: string): IdentifiedRun | undefined {
  const row = port.sql('SELECT json FROM runs WHERE session_id=? AND command_id=?').get(sessionId, commandId) as { json: string } | undefined;
  return row ? port.run(row.json) : undefined;
}

export function findRunsByNativeTurn(port: StorePort, sessionId: string, nativeSessionId: string, turnId: string): IdentifiedRun[] {
  return (port.sql("SELECT json FROM runs WHERE session_id=? AND json_extract(json,'$.native.nativeSessionId')=? AND json_extract(json,'$.native.nativeTurnId')=? ORDER BY rowid")
    .all(sessionId, nativeSessionId, turnId) as { json: string }[]).map(row => port.run(row.json));
}

export function isSteerTargetTurnEnded(port: StorePort, run: Run): boolean {
  const native = run.native;
  if (native?.intent !== 'steer') return false;
  if (native.stage === 'steer_stopped') return true;
  const settledOwner = (candidate: Run) =>
    candidate.native?.intent !== 'steer'
    && (['completed', 'failed', 'cancelled'].includes(candidate.state)
      || (candidate.state === 'interrupted' && candidate.native?.delivery === 'cancelled'));
  if (native.ownerRunId) {
    try { if (settledOwner(getRun(port, native.ownerRunId))) return true; } catch { /* owner deleted */ }
  }
  if (native.nativeSessionId && native.nativeTurnId) {
    if (findRunsByNativeTurn(port, run.sessionId, native.nativeSessionId, native.nativeTurnId).some(settledOwner)) return true;
    const anchor = port.sql('SELECT rowid FROM runs WHERE id=?').get(run.id) as { rowid: number } | undefined;
    if (anchor) {
      const steerAt = native.timings?.dispatchAt ?? (Date.parse(run.createdAt) || 0);
      const newer = port.sql(`SELECT 1 FROM runs
        WHERE session_id=?
          AND id!=?
          AND (rowid > ? OR (? > 0 AND COALESCE(json_extract(json,'$.native.timings.observedAt'), json_extract(json,'$.native.timings.dispatchAt'), 0) > ?))
          AND json_extract(json,'$.native.intent') IS NULL
          AND json_extract(json,'$.native.nativeSessionId')=?
          AND json_extract(json,'$.native.nativeTurnId') IS NOT NULL
          AND json_extract(json,'$.native.nativeTurnId')!=?
          AND (json_extract(json,'$.native.delivery')='observed' OR json_extract(json,'$.state') IN ('completed','failed'))
        LIMIT 1`).get(run.sessionId, native.ownerRunId ?? '', anchor.rowid, steerAt, steerAt, native.nativeSessionId, native.nativeTurnId);
      if (newer) return true;
    }
  }
  if (native.terminalId && restartObservation(native.backendId ?? '') === 'hook') {
    try {
      const terminal = port.getTerminal(native.terminalId);
      if (terminal.sessionId === run.sessionId && terminal.state === 'exited') return true;
    } catch { /* terminal pruned */ }
  }
  return false;
}

export function findRunByNativeMessage(port: StorePort, sessionId: string, nativeMessageId: string): IdentifiedRun | undefined {
  const row = port.sql("SELECT json FROM runs WHERE session_id=? AND json_extract(json,'$.native.nativeMessageId')=? ORDER BY rowid DESC LIMIT 1")
    .get(sessionId, nativeMessageId) as { json: string } | undefined;
  return row ? port.run(row.json) : undefined;
}

export function saveRunMetrics(port: StorePort, id: string, metrics: RunMetrics): void {
  const current = getRun(port, id);
  if (!current.native || current.native.intent === 'steer' || JSON.stringify(current.native.metrics) === JSON.stringify(metrics)) return;
  const run = { ...current, native: { ...current.native, metrics } };
  port.replace('runs', id, run);
  port.runChanged(run);
}

export function listRuns(port: StorePort, sessionId: string): IdentifiedRun[] {
  return (port.sql('SELECT json FROM runs WHERE session_id=? ORDER BY rowid').all(sessionId) as { json: string }[]).map(r => port.run(r.json));
}

export function updateRun(port: StorePort, id: string, patch: Partial<Run>): IdentifiedRun {
  const item = port.identified({ ...getRun(port, id), ...patch, id, updatedAt: now() });
  port.replace('runs', id, item);
  port.runChanged(item);
  return item;
}

export function transitionNativeRun(port: StorePort, id: string, expectedDelivery: NativeDeliveryState[], nativePatch: Partial<NativeRunDetails>, runPatch: Partial<Run> = {}): IdentifiedRun | undefined {
  return port.transaction(() => {
    const current = getRun(port, id);
    if (!current.native || !expectedDelivery.includes(current.native.delivery)) return undefined;
    const run = port.identified({
      ...current,
      ...runPatch,
      id: current.id,
      sessionId: current.sessionId,
      commandId: current.commandId,
      prompt: current.prompt,
      updatedAt: now(),
      native: { ...current.native, ...nativePatch },
    });
    port.replace('runs', id, run);
    port.appendEvent(run.sessionId, 'run_updated', { run }, { runId: run.id });
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state) || ['failed', 'cancelled'].includes(run.native!.delivery)) port.pruneRunSnapshots(run.sessionId, run.id);
    port.runChanged(run);
    return run;
  });
}

export function listUnfinishedNativeRuns(port: StorePort, sessionId?: string): IdentifiedRun[] {
  const sessionFilter = sessionId === undefined ? '' : 'AND r.session_id=?';
  const parameters = sessionId === undefined ? [] : [sessionId];
  return (port.sql(`SELECT r.json FROM runs r INDEXED BY run_native_unfinished JOIN sessions s ON s.id=r.session_id
    WHERE json_extract(s.json,'$.kind')='native'
      ${sessionFilter}
      AND json_extract(r.json,'$.native.delivery') IN ('queued','preparing','dispatching','input_sent','observed','uncertain')
      AND json_extract(r.json,'$.state') NOT IN ('completed','failed','cancelled')
    ORDER BY r.rowid`).all(...parameters) as { json: string }[]).map(row => port.run(row.json));
}

export function listRecentNativeRuns(port: StorePort, sessionId: string, limit = 100): IdentifiedRun[] {
  const boundedLimit = Number.isInteger(limit) ? Math.max(0, Math.min(limit, 1000)) : 100;
  return (port.sql(`SELECT r.json FROM runs r JOIN sessions s ON s.id=r.session_id
    WHERE r.session_id=? AND json_extract(s.json,'$.kind')='native'
    ORDER BY r.rowid DESC LIMIT ?`).all(sessionId, boundedLimit) as { json: string }[]).map(row => port.run(row.json));
}

export function listProviderEndedNativeRuns(port: StorePort): IdentifiedRun[] {
  const candidates = (port.sql(`SELECT r.json FROM runs r JOIN sessions s ON s.id=r.session_id
    WHERE json_extract(s.json,'$.kind')='native'
      AND ((json_extract(r.json,'$.state')='interrupted'
        AND json_extract(r.json,'$.native.delivery')='cancelled'
        AND json_extract(r.json,'$.native.stage')='provider_cancelled')
      OR (json_extract(r.json,'$.state')='failed' AND json_extract(r.json,'$.native.delivery')='failed'
        AND json_extract(r.json,'$.native.stage')='provider_failed')
      OR (json_extract(r.json,'$.state')='completed' AND json_extract(r.json,'$.native.delivery')='observed'
        AND json_extract(r.json,'$.native.stage')='completed'))
      AND json_extract(r.json,'$.native.nativeSessionId') IS NOT NULL
      AND json_extract(r.json,'$.native.nativeTurnId') IS NOT NULL`).all() as { json: string }[]).map(row => port.run(row.json));
  return candidates.filter(run => {
    if (run.state === 'interrupted' && run.native?.delivery === 'cancelled' && run.native.stage === 'provider_cancelled') return true;
    const turnId = run.native?.nativeTurnId;
    return Boolean(turnId && port.journal.retraction(run.sessionId, `meta:turn:${turnId}:ended`));
  });
}

export function searchPrompts(port: StorePort, pattern: string, limit: number, sessionId?: string, excludedBackendIds?: readonly string[], excludeTaskWorkspaces = false, hidePluginAgents = false, assistantHistory = false): MessageSearchHit[] {
  const scope = searchScope(sessionId, excludedBackendIds, excludeTaskWorkspaces, hidePluginAgents, assistantHistory);
  const rows = port.sql(`SELECT r.command_id AS commandId, r.json AS runJson, s.json AS sessionJson
    FROM runs r JOIN sessions s ON s.id = r.session_id
    WHERE json_extract(r.json,'$.prompt') LIKE ? ESCAPE '\\'${scope.clause} ORDER BY r.rowid DESC LIMIT ?`).all(pattern, ...scope.params, limit) as Array<{ commandId: string; runJson: string; sessionJson: string }>;
  return rows.map(row => {
    const run = JSON.parse(row.runJson) as Run;
    return { ...hitFromSession(port.session(row.sessionJson), `prompt:${row.commandId}`, 'user', run.prompt, run.createdAt), runId: run.id };
  });
}
