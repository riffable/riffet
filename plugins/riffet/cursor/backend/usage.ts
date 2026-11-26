import type { UsageObservation } from '@riffet/plugin-api/kit';
import type { AgentHost, AgentProjectView, AgentSessionView } from '@riffet/plugin-api/experimental/agent';
import { ChatReader, chatStorePath } from '../native/chat-store.js';
import { cursorPromptAlias, type CursorLive, type CursorUsageCapture } from '../native/live.js';

/** The stream counts cache hits inside input, and reasoning inside output. Unknown stays absent. */
export function cursorUsageObservation(capture: CursorUsageCapture, owner: { parentNativeSessionId?: string; subagentType?: string }): UsageObservation {
  const raw = capture.rawUsage;
  const usage = { ...raw };
  if (raw.inputTokens !== undefined) {
    // A missing cache counter cannot be treated as zero. Keep the raw counters for diagnosis.
    const cached = raw.cacheReadTokens !== undefined && raw.cacheWriteTokens !== undefined
      ? raw.cacheReadTokens + raw.cacheWriteTokens : undefined;
    if (cached !== undefined && Number.isSafeInteger(cached) && cached <= raw.inputTokens) usage.inputTokens = raw.inputTokens - cached;
    else delete usage.inputTokens;
  }
  return {
    nativeSessionId: capture.nativeSessionId, nativeTurnId: capture.nativeTurnId, requestId: capture.requestId,
    scope: 'agent-turn', agentKind: owner.parentNativeSessionId ? 'subagent' : 'main', ...owner,
    startedAt: capture.startedAt, endedAt: capture.endedAt, status: 'completed',
    ...(capture.requestedModel ? { requestedModel: capture.requestedModel } : {}),
    usage, rawUsage: { ...raw },
  };
}

interface Owner { session: AgentSessionView; parentNativeSessionId?: string; subagentType?: string }
const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * Terminal counters outlive the CLI. Consume only after the ledger confirms a durable write;
 * a missing session binding or child metadata is retried, including after a server restart.
 * This observer belongs to the backend activation, independently of transcript subscribers.
 */
export class CursorUsageIngest {
  private closed = false;
  private again = false;
  private pending?: Promise<void>;
  private readonly timer: NodeJS.Timeout;
  private readonly unwatch: () => void;

  constructor(
    private readonly host: AgentHost,
    private readonly live: Pick<CursorLive, 'readUsage' | 'ackUsage' | 'watchUsage'>,
    private readonly configDir: string,
    private readonly configDirFor?: (project: AgentProjectView, session?: AgentSessionView) => string,
  ) {
    this.unwatch = live.watchUsage(() => { void this.drain(); });
    this.timer = setInterval(() => { void this.drain(); }, 2_000);
    this.timer.unref();
    void this.drain();
  }

  drain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) { this.again = true; return this.pending; }
    this.pending = (async () => {
      do {
        this.again = false;
        await this.scan();
      } while (this.again && !this.closed);
    })().catch(() => {
      // Storage/identity races leave the spool intact. Statistics must never affect a CLI.
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async scan(): Promise<void> {
    if (!this.host.stats.recordObservation) return;
    const owners = new Map<string, Owner | undefined>();
    for (const { file, observation: capture } of this.live.readUsage()) {
      if (this.closed) return;
      try {
        if (!owners.has(capture.nativeSessionId)) owners.set(capture.nativeSessionId, this.owner(capture.nativeSessionId));
        const owner = owners.get(capture.nativeSessionId);
        if (!owner) continue;
        const { session } = owner;
        // A child's own native turn must never be assigned to an unrelated main run by time.
        const runs = this.host.view.runsOfTurn(session.id, capture.nativeSessionId, capture.nativeTurnId);
        let runId = runs.length === 1 ? runs[0]!.id : undefined;
        if (!runId && !owner.parentNativeSessionId) {
          const matched = await this.host.runs.find(session.id, { nativeMessageId: cursorPromptAlias(capture.requestId) });
          if (matched.length === 1) runId = matched[0]!.id;
        }
        if (this.closed) return;
        if (this.host.stats.recordObservation(session.id, runId, cursorUsageObservation(capture, owner.parentNativeSessionId
          ? { parentNativeSessionId: owner.parentNativeSessionId, ...(owner.subagentType ? { subagentType: owner.subagentType } : {}) } : {}))) this.live.ackUsage(file);
      } catch { /* Retry this record; one unreadable store does not block the rest. */ }
    }
  }

  private owner(nativeId: string): Owner | undefined {
    if (!CHAT_ID.test(nativeId) || nativeId === '.' || nativeId === '..') return;
    const sessions = this.host.view.sessions();
    const owns = (session: AgentSessionView, id: string) => session.nativeSessionId === id || Boolean(session.previousNativeSessionIds?.includes(id));
    const exact = sessions.filter(session => owns(session, nativeId));
    const current = exact.filter(session => !session.archivedAt);
    if (current.length === 1) return { session: current[0]! };
    if (current.length > 1) return;
    if (exact.length === 1) return { session: exact[0]! };
    if (exact.length > 1) return;

    const candidates: Owner[] = [];
    const seenSessions = new Set<string>();
    const projects = new Set(sessions.map(session => session.projectId));
    for (const projectId of projects) {
      const project = this.host.view.project(projectId);
      if (!project) continue;
      const projectSessions = sessions.filter(session => session.projectId === projectId);
      // A code project can host both ordinary sessions and project-scoped team members in different config dirs.
      const dirs = new Set<string>([this.configDirFor?.(project) ?? this.configDir]);
      for (const s of projectSessions) dirs.add(this.configDirFor?.(project, s) ?? this.configDir);
      for (const dir of dirs) {
        const visited = new Set<string>([nativeId]);
        let child = nativeId;
        let parentNativeSessionId: string | undefined;
        let subagentType: string | undefined;
        for (let depth = 0; depth < 8; depth++) {
          const reader = new ChatReader(chatStorePath(dir, project.cwd, child));
          const meta = (() => { try { return reader.meta(); } finally { reader.close(); } })();
          if (meta?.agentId !== child || !meta.subagentInfo) break;
          const info = meta.subagentInfo;
          const parent = info.parentAgentId ?? info.rootParentAgentId;
          if (!parent || !CHAT_ID.test(parent) || visited.has(parent)) break;
          parentNativeSessionId ??= parent;
          if (depth === 0 && typeof info.typeName === 'string') subagentType = info.typeName;
          const matches = projectSessions.filter(session => owns(session, parent));
          const active = matches.filter(session => !session.archivedAt);
          const session = active.length === 1 ? active[0] : active.length === 0 && matches.length === 1 ? matches[0] : undefined;
          if (session) {
            if (!seenSessions.has(session.id)) {
              seenSessions.add(session.id);
              candidates.push({ session, parentNativeSessionId, ...(subagentType ? { subagentType } : {}) });
            }
            break;
          }
          visited.add(parent);
          child = parent;
        }
      }
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.unwatch();
    await this.pending;
  }
}
