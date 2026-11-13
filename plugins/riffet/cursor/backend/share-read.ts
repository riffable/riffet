import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeWorkbenchEvent } from '@contracts';
import { SHARE_MAX_CHILDREN as MAX_CHILDREN, shareChildReferences as childReferences, shareUnavailable as unavailable } from '@riffet/plugin-api/kit';
import { type AgentContext, type AgentHistory, type AgentHistoryOptions } from '@riffet/plugin-api/experimental/agent';
import { ChatReader, workspaceChatsDir } from '../native/chat-store.js';
import { readCompleteTranscript } from '../native/transcript.js';

export async function readCursorShare({ session, project }: AgentContext, configDir: string, options: AgentHistoryOptions = {}): Promise<AgentHistory> {
  options.signal?.throwIfAborted();
  const nativeId = session.nativeSessionId;
  if (!nativeId) return { events: [], subagents: [] };
  const directory = workspaceChatsDir(configDir, project.cwd);
  const read = async (id: string): Promise<NativeWorkbenchEvent[]> => {
    options.signal?.throwIfAborted();
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw unavailable('The Cursor conversation id is invalid');
    const events = await readCompleteTranscript(join(directory, id, 'store.db'), session.id);
    options.signal?.throwIfAborted();
    return events;
  };
  const events = await read(nativeId), warnings: string[] = [], subagents: AgentHistory['subagents'] = [];
  if (options.messagesOnly) return { events, subagents };
  const pending = childReferences(events), visited = new Set([nativeId]);
  // Children still running may not yet have a tool result; their own store metadata identifies the call.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    options.signal?.throwIfAborted();
    if (!entry.isDirectory() || !/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
    const reader = new ChatReader(join(directory, entry.name, 'store.db'));
    try {
      const info = reader.meta()?.subagentInfo;
      if ((info?.rootParentAgentId === nativeId || info?.parentAgentId === nativeId) && info.toolCallId) pending.push({ toolCallId: info.toolCallId, agentId: entry.name, ...(info.typeName ? { subagentType: info.typeName } : {}) });
    } finally { reader.close(); }
  }
  for (let index = 0; index < pending.length && index < MAX_CHILDREN; index++) {
    options.signal?.throwIfAborted();
    const child = pending[index]!;
    if (visited.has(child.agentId)) continue;
    visited.add(child.agentId);
    try { const childEvents = await read(child.agentId); subagents.push({ ...child, events: childEvents }); pending.push(...childReferences(childEvents)); }
    catch { options.signal?.throwIfAborted(); warnings.push(`子 Agent ${child.agentId} 的历史不可用`); }
  }
  if (pending.length > MAX_CHILDREN) warnings.push('部分子 Agent 的历史不可用');
  options.signal?.throwIfAborted();
  return { events, subagents, warnings };
}
