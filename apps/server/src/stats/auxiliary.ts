import type { DatabaseSync } from 'node:sqlite';
import type {
  AuxiliaryCallLogEntry, AuxiliaryJobKind, AuxiliaryModelTransport, ModelLeaderboardCategory, ModelLeaderboardResponse, ModelLeaderboardRow, ModelLeaderboardSource, ModelProbePreset, NativeBackendId,
} from '../../../../packages/contracts/src/index.js';
import { isPluginAgentId } from '../../../../packages/contracts/src/index.js';
import type { AuxiliaryCallRecord } from '../auxiliary/telemetry.js';
import { percentiles, StatsQuery, type ResolvedFilter, type StatsLabels } from './query.js';

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 90;
const MAX_KEPT_ROWS = 20_000;
const PRUNE_INTERVAL_WRITES = 50;
const MIN_DECODE_MS = 300;
const MIN_DECODE_TOKENS = 8;
const MAX_PLAUSIBLE_TPS = 1_000;

interface AuxiliaryCallRow {
  id: number;
  created_at: number;
  kind: string;
  preset: string | null;
  source: 'live' | 'probe';
  backend_id: string;
  profile_id: string;
  model: string;
  transport: AuxiliaryModelTransport;
  protocol: string | null;
  ok: 0 | 1;
  auth_ms: number;
  ttft_ms: number | null;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  reasoning_chars: number;
  thinking_detected: 0 | 1;
  streaming: 0 | 1;
  error_code: string | null;
  detail: string | null;
}

export class AuxiliaryStats {
  private writes = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: { onChanged?: () => void; now?: () => number } = {},
  ) {}

  record(entry: AuxiliaryCallRecord): void {
    try {
      const now = entry.createdAt ?? (this.options.now?.() ?? Date.now());
      this.db.prepare(`INSERT INTO auxiliary_calls(
        created_at, kind, preset, source, backend_id, profile_id, model, transport, protocol,
        ok, auth_ms, ttft_ms, duration_ms, input_tokens, output_tokens, reasoning_tokens,
        reasoning_chars, thinking_detected, streaming, error_code, detail
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        Math.round(now),
        entry.kind,
        entry.preset ?? null,
        entry.source,
        entry.backendId,
        entry.profileId,
        entry.model,
        entry.transport,
        entry.protocol ?? null,
        entry.ok ? 1 : 0,
        Math.max(0, Math.round(entry.authMs)),
        entry.ttftMs !== null && Number.isFinite(entry.ttftMs) ? Math.max(0, Math.round(entry.ttftMs)) : null,
        Math.max(0, Math.round(entry.durationMs)),
        entry.inputTokens ?? null,
        entry.outputTokens ?? null,
        entry.reasoningTokens ?? null,
        Math.max(0, Math.round(entry.reasoningChars)),
        entry.thinkingDetected ? 1 : 0,
        entry.streaming ? 1 : 0,
        entry.errorCode ?? null,
        entry.detail ? entry.detail.slice(0, 240) : null,
      );
      this.writes += 1;
      if (this.writes % PRUNE_INTERVAL_WRITES === 0) this.prune(now);
      this.options.onChanged?.();
    } catch { /* auxiliary telemetry is best-effort */ }
  }

  private prune(now: number): void {
    const cutoff = now - RETENTION_DAYS * DAY_MS;
    this.db.prepare('DELETE FROM auxiliary_calls WHERE created_at < ?').run(cutoff);
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM auxiliary_calls').get() as { count: number }).count;
    if (total > MAX_KEPT_ROWS) {
      this.db.prepare('DELETE FROM auxiliary_calls WHERE id IN (SELECT id FROM auxiliary_calls ORDER BY created_at ASC, id ASC LIMIT ?)').run(total - MAX_KEPT_ROWS);
    }
  }

  leaderboard(params: {
    category: ModelLeaderboardCategory;
    source?: ModelLeaderboardSource;
    days?: number;
    labels: StatsLabels;
    filter?: ResolvedFilter;
    hiddenBackends?: readonly string[];
    hidePluginAgents?: boolean;
  }): ModelLeaderboardResponse {
    const now = this.options.now?.() ?? Date.now();
    const days = Math.min(Math.max(1, Math.trunc(params.days ?? 30)), 365);
    const source: ModelLeaderboardSource = params.source ?? 'all';
    if (params.category === 'agent') {
      const filter: ResolvedFilter = params.filter ?? {
        from: now - days * DAY_MS,
        to: now + 1,
        tz: 'UTC',
        backends: [], models: [], projects: [], profiles: [],
        agentKind: 'all', includeArchived: true, includeEstimated: true,
        ...(params.hiddenBackends?.length ? { hiddenBackends: [...params.hiddenBackends] } : {}),
        ...(params.hidePluginAgents ? { hidePluginAgents: true } : {}),
      };
      const query = new StatsQuery(this.db, params.labels, () => now);
      const latency = query.latency(filter, 'model');
      const breakdown = query.breakdown(filter, 'model');
      const breakdownByKey = new Map(breakdown.rows.map(row => [row.key, row]));
      const rows: ModelLeaderboardRow[] = latency.rows.map(row => {
        const b = breakdownByKey.get(row.key);
        const totalRuns = b?.count ?? row.durationMs?.samples ?? row.ttftMs?.samples ?? 0;
        const okRuns = b?.states.completed ?? 0;
        return {
          key: row.key,
          label: row.label,
          ...(row.backendId ? { backendId: row.backendId } : {}),
          model: row.label,
          samples: totalRuns,
          probeSamples: 0,
          successRate: totalRuns > 0 ? okRuns / totalRuns : null,
          thinkingRate: null,
          authMs: null,
          ttftMs: row.ttftMs,
          durationMs: row.durationMs,
          outputTokensPerSecond: row.outputTokensPerSecond,
        };
      }).sort((a, b) => {
        const aOk = (a.successRate ?? 0) > 0 ? 0 : 1;
        const bOk = (b.successRate ?? 0) > 0 ? 0 : 1;
        if (aOk !== bOk) return aOk - bOk;
        const aTtft = a.ttftMs?.p50 ?? Number.POSITIVE_INFINITY;
        const bTtft = b.ttftMs?.p50 ?? Number.POSITIVE_INFINITY;
        if (aTtft !== bTtft) return aTtft - bTtft;
        const aDur = a.durationMs?.p50 ?? Number.POSITIVE_INFINITY;
        const bDur = b.durationMs?.p50 ?? Number.POSITIVE_INFINITY;
        return aDur - bDur || a.label.localeCompare(b.label);
      });
      return { category: 'agent', source: 'live', generatedAt: new Date(now).toISOString(), rows };
    }

    const from = now - days * DAY_MS;
    const categoryClause = params.category === 'short'
      ? "(kind IN ('title','summary') OR (kind='probe' AND preset='short'))"
      : params.category === 'stream'
        ? "(kind IN ('plugin','chat') OR (kind='probe' AND preset='stream'))"
        : "(kind='handoff' OR (kind='probe' AND preset='long'))";
    const sourceClause = source === 'all' ? '' : 'AND source=?';
    const rawRows = this.db.prepare(
      `SELECT * FROM auxiliary_calls WHERE created_at>=? AND created_at<=? AND ${categoryClause} ${sourceClause}`,
    ).all(from, now, ...(source === 'all' ? [] : [source])) as unknown as AuxiliaryCallRow[];

    const hidden = new Set(params.hiddenBackends ?? []);
    const grouped = new Map<string, AuxiliaryCallRow[]>();
    for (const row of rawRows) {
      if (hidden.has(row.backend_id)) continue;
      if (params.hidePluginAgents && isPluginAgentId(row.backend_id)) continue;
      const key = `${row.backend_id}|${row.profile_id}|${row.model}`;
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }

    const rows: ModelLeaderboardRow[] = [...grouped.entries()].map(([key, items]) => {
      const first = items[0]!;
      const backendId = first.backend_id as NativeBackendId;
      const profileName = params.labels.profileLabel(backendId, first.profile_id) || first.profile_id;
      const okItems = items.filter(item => item.ok === 1);
      const fastItems = okItems.filter(item => item.kind !== 'chat');
      const speeds: number[] = [];
      for (const item of okItems) {
        if (!item.streaming || item.ttft_ms === null) continue;
        const genMs = item.duration_ms - item.ttft_ms;
        if (genMs < MIN_DECODE_MS) continue;
        if (item.output_tokens === null || item.output_tokens < MIN_DECODE_TOKENS) continue;
        const tps = item.output_tokens / (genMs / 1000);
        if (tps > 0 && tps <= MAX_PLAUSIBLE_TPS) speeds.push(tps);
      }
      const last = items.reduce((best, item) => Math.max(best, item.created_at), 0);
      const latestTransport = items.reduce((latest, item) => (item.created_at >= latest.created_at ? item : latest), first).transport;
      return {
        key,
        label: profileName ? `${profileName} · ${first.model}` : first.model,
        backendId,
        profileId: first.profile_id,
        profileName,
        model: first.model,
        transport: latestTransport,
        samples: items.length,
        probeSamples: items.filter(item => item.source === 'probe').length,
        successRate: items.length > 0 ? okItems.length / items.length : null,
        thinkingRate: fastItems.length > 0 ? fastItems.filter(item => item.thinking_detected === 1).length / fastItems.length : null,
        authMs: percentiles(items.map(item => item.auth_ms)),
        ttftMs: percentiles(okItems.map(item => item.ttft_ms).filter((value): value is number => value !== null)),
        durationMs: percentiles(okItems.map(item => item.duration_ms)),
        outputTokensPerSecond: percentiles(speeds),
        ...(last > 0 ? { lastSampleAt: new Date(last).toISOString() } : {}),
      };
    });

    rows.sort((left, right) => {
      const leftHasOk = left.durationMs !== null ? 0 : 1;
      const rightHasOk = right.durationMs !== null ? 0 : 1;
      if (leftHasOk !== rightHasOk) return leftHasOk - rightHasOk;
      if (params.category === 'short') {
        const lDur = left.durationMs?.p50 ?? Number.POSITIVE_INFINITY;
        const rDur = right.durationMs?.p50 ?? Number.POSITIVE_INFINITY;
        if (lDur !== rDur) return lDur - rDur;
        return (left.ttftMs?.p50 ?? Number.POSITIVE_INFINITY) - (right.ttftMs?.p50 ?? Number.POSITIVE_INFINITY) || left.label.localeCompare(right.label);
      }
      if (params.category === 'stream') {
        const lTtft = left.ttftMs?.p50 ?? left.durationMs?.p50 ?? Number.POSITIVE_INFINITY;
        const rTtft = right.ttftMs?.p50 ?? right.durationMs?.p50 ?? Number.POSITIVE_INFINITY;
        if (lTtft !== rTtft) return lTtft - rTtft;
        const lTps = left.outputTokensPerSecond?.p50 ?? -1;
        const rTps = right.outputTokensPerSecond?.p50 ?? -1;
        if (lTps !== rTps) return rTps - lTps;
        return (left.durationMs?.p50 ?? Number.POSITIVE_INFINITY) - (right.durationMs?.p50 ?? Number.POSITIVE_INFINITY) || left.label.localeCompare(right.label);
      }
      const lTtft = left.ttftMs?.p50 ?? left.durationMs?.p50 ?? Number.POSITIVE_INFINITY;
      const rTtft = right.ttftMs?.p50 ?? right.durationMs?.p50 ?? Number.POSITIVE_INFINITY;
      if (lTtft !== rTtft) return lTtft - rTtft;
      return (left.durationMs?.p50 ?? Number.POSITIVE_INFINITY) - (right.durationMs?.p50 ?? Number.POSITIVE_INFINITY) || left.label.localeCompare(right.label);
    });

    return {
      category: params.category,
      source,
      generatedAt: new Date(now).toISOString(),
      rows,
    };
  }

  recentCalls(params: {
    limit?: number;
    labels: StatsLabels;
    hiddenBackends?: readonly string[];
    hidePluginAgents?: boolean;
  }): AuxiliaryCallLogEntry[] {
    const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 30)), 100);
    const rows = this.db.prepare('SELECT * FROM auxiliary_calls ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit * 2) as unknown as AuxiliaryCallRow[];
    const hidden = new Set(params.hiddenBackends ?? []);
    const out: AuxiliaryCallLogEntry[] = [];
    for (const row of rows) {
      if (hidden.has(row.backend_id)) continue;
      if (params.hidePluginAgents && isPluginAgentId(row.backend_id)) continue;
      const backendId = row.backend_id as NativeBackendId;
      const profileName = params.labels.profileLabel(backendId, row.profile_id) || row.profile_id;
      out.push({
        id: row.id,
        at: new Date(row.created_at).toISOString(),
        kind: row.kind as AuxiliaryJobKind,
        ...(row.preset ? { preset: row.preset as ModelProbePreset } : {}),
        source: row.source,
        backendId,
        profileId: row.profile_id,
        profileName,
        model: row.model,
        transport: row.transport,
        ok: row.ok === 1,
        authMs: row.auth_ms,
        ttftMs: row.ttft_ms,
        durationMs: row.duration_ms,
        thinkingDetected: row.thinking_detected === 1,
        ...(row.error_code ? { errorCode: row.error_code } : {}),
        ...(row.detail ? { detail: row.detail } : {}),
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}
