import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Session } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeShareReadOptions, NativeShareTranscript } from '../types.js';
import { projectDshEvent } from './events.js';
import { dshInstallRequire, storageCompression } from './log-store.js';
import { runtimeSettings } from './settings.js';

interface ColdLog { header: { id: string; cwd?: string }; events: unknown[] }
interface ReadContext {
  fiber: { dispose(): Promise<void> };
  sessionPersistence: unknown;
}

/** Load only DSH's official persistence reader. No profile, agents, tools, hooks or LLM services are mounted. */
export async function readDshShare(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options: NativeShareReadOptions = {}): Promise<NativeShareTranscript> {
  options.signal?.throwIfAborted();
  if (!session.nativeSessionId) return { events: [], subagents: [] };
  const settings = runtimeSettings(profile);
  const require = await dshInstallRequire(settings);
  options.signal?.throwIfAborted();
  if (!require) throw new AppError('SHARE_HISTORY_UNAVAILABLE', 'The DSH read-only history parser is unavailable', 409);
  let modules: unknown[];
  try {
    modules = await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-session-query'].map(async name => await import(pathToFileURL(require.resolve(name)).href)));
  } catch { options.signal?.throwIfAborted(); throw new AppError('SHARE_HISTORY_UNAVAILABLE', 'This DSH installation lacks the official read-only history parser', 409); }
  options.signal?.throwIfAborted();
  const { Context } = modules[0] as { Context: new () => ReadContext };
  const { apply } = modules[1] as { apply(context: ReadContext, config: { root: string; compression: 'none' | 'zstd' }): Promise<void> };
  const { readColdSessionLog } = modules[2] as { readColdSessionLog(persistence: unknown, id: string): Promise<ColdLog> };
  const context = new Context(), root = join(settings.profileHome, 'sessions');
  const cwd = resolve(host.getProject(session.projectId).cwd);
  try {
    // The default DSH profile owns this root; sniff only the released physical encoding, leaving decoding to DSH.
    const compression = await storageCompression(root, options.signal);
    options.signal?.throwIfAborted();
    await apply(context, { root, compression });
    options.signal?.throwIfAborted();
    const read = async (id: string) => {
      options.signal?.throwIfAborted();
      const log = await readColdSessionLog(context.sessionPersistence, id);
      options.signal?.throwIfAborted();
      if (log.header.id !== id || !log.header.cwd || resolve(log.header.cwd) !== cwd) throw new AppError('SHARE_HISTORY_SCOPE_MISMATCH', 'The DSH conversation history belongs to another workspace', 409);
      return log.events.flatMap(event => projectDshEvent(event, { sessionId: session.id, unbounded: true }));
    };
    const events = await read(session.nativeSessionId), warnings: string[] = [], subagents: NativeShareTranscript['subagents'] = [];
    if (options.messagesOnly) return { events, subagents };
    const pending = [...events], visited = new Set([session.nativeSessionId]);
    for (let index = 0; index < pending.length; index++) {
      options.signal?.throwIfAborted();
      const event = pending[index]!;
      const result = event.data.subagentResult as { agentId?: unknown } | undefined;
      const agentId = result?.agentId, toolCallId = event.data.toolCallId;
      if (typeof agentId !== 'string' || typeof toolCallId !== 'string' || visited.has(agentId)) continue;
      if (visited.size > 128) { warnings.push('部分子 Agent 的历史不可用'); break; }
      visited.add(agentId);
      try { const childEvents = await read(agentId); subagents.push({ toolCallId, agentId, events: childEvents }); pending.push(...childEvents); }
      catch { options.signal?.throwIfAborted(); warnings.push(`子 Agent ${agentId} 的历史不可用`); }
    }
    return { events, subagents, warnings };
  } finally { await context.fiber.dispose(); }
}
