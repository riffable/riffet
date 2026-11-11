import { stat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeWorkbenchEvent, Session } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { ClaudeTranscript, findClaudeTranscript } from '../claude/history.js';
import { findDroidTranscript, parseDroidTranscript, projectDroidChain } from '../droid/history.js';
import type { NativeBackendHost, NativeShareReadOptions, NativeShareTranscript } from '../types.js';
import { shareModelInfo } from './share-model.js';
import { SHARE_MAX_CHILDREN as MAX_CHILDREN, shareChildReferences as childReferences, shareUnavailable as unavailable } from '../../../../../packages/plugin-api/src/kit/share-read.js';

// The generic part of a share read lives in the kit; the old names stay for the readers that use them.
export { MAX_CHILDREN, childReferences, unavailable };

/** Refuse a parse that raced a rewrite or append; retries use fresh parser instances. */
async function fileStamp(path: string): Promise<string> {
  const info = await stat(path);
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

async function stableFile<T>(path: string, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const before = await fileStamp(path);
    const result = await read();
    signal?.throwIfAborted();
    const after = await fileStamp(path);
    signal?.throwIfAborted();
    if (before === after) return result;
  }
  throw new AppError('SHARE_HISTORY_CHANGED', 'The conversation is still being written; try sharing again shortly', 409);
}

export async function readDroidShare(host: NativeBackendHost, session: Session, options: NativeShareReadOptions = {}): Promise<NativeShareTranscript> {
  options.signal?.throwIfAborted();
  if (!session.nativeSessionId) return { events: [], subagents: [] };
  const cwd = host.getProject(session.projectId).cwd;
  const read = async (id: string, child = false) => {
    options.signal?.throwIfAborted();
    const file = await findDroidTranscript(id, cwd);
    options.signal?.throwIfAborted();
    if (!file) throw unavailable('The Droid conversation history file does not exist');
    return await stableFile(file, async () => {
      if ((await stat(file)).size > 256 * 1024 * 1024) throw new AppError('SHARE_HISTORY_TOO_LARGE', 'The Droid conversation history exceeds the read limit', 413);
      const content = await readFile(file, { encoding: 'utf8', signal: options.signal }), lines = content.split('\n');
      for (let index = 0; index < lines.length; index++) {
        options.signal?.throwIfAborted();
        if (!lines[index]!.trim()) continue;
        try { JSON.parse(lines[index]!); }
        catch { if (index !== lines.length - 1) throw unavailable('The Droid conversation history contains a corrupted record'); }
      }
      const transcript = parseDroidTranscript(content, file, id);
      if (transcript.chain[0]?.parentId) throw unavailable('The Droid conversation history is missing a parent message');
      return projectDroidChain(transcript, { sessionId: session.id, unbounded: true }, child ? false : messageId => {
        const runId = host.findRunIdByNativeMessage(session.id, messageId);
        return runId ? { runId, commandId: '' } : undefined;
      });
    }, options.signal);
  };
  const events = await read(session.nativeSessionId);
  if (options.messagesOnly) return { events, subagents: [] };
  const subagents: NativeShareTranscript['subagents'] = [], warnings: string[] = [];
  const pending = childReferences(events), visited = new Set([session.nativeSessionId]);
  for (let index = 0; index < pending.length && index < MAX_CHILDREN; index++) {
    options.signal?.throwIfAborted();
    const child = pending[index]!;
    if (visited.has(child.agentId)) continue;
    visited.add(child.agentId);
    try {
      const childEvents = await read(child.agentId, true);
      subagents.push({ ...child, events: childEvents });
      pending.push(...childReferences(childEvents));
    } catch { options.signal?.throwIfAborted(); warnings.push(`子 Agent ${child.agentId} 的历史不可用`); }
  }
  if (pending.length > MAX_CHILDREN) warnings.push('部分子 Agent 的历史不可用');
  options.signal?.throwIfAborted();
  return { events, subagents, warnings };
}

export async function readClaudeShare(session: Session, configDir: string, options: NativeShareReadOptions = {}): Promise<NativeShareTranscript> {
  options.signal?.throwIfAborted();
  const nativeId = session.nativeSessionId;
  if (!nativeId) return { events: [], subagents: [] };
  const files: string[] = [];
  for (const id of [...(session.previousNativeSessionIds ?? []), nativeId]) {
    options.signal?.throwIfAborted();
    const file = await findClaudeTranscript(configDir, id);
    options.signal?.throwIfAborted();
    if (!file) throw unavailable('The Claude Code conversation history file is incomplete');
    files.push(file);
  }
  const file = files.at(-1)!;
  for (let attempt = 0; attempt < 3; attempt++) {
    options.signal?.throwIfAborted();
    const before = await Promise.all(files.map(fileStamp));
    const modelInfo: NonNullable<NativeShareTranscript['modelInfo']> = Object.create(null);
    const transcript = new ClaudeTranscript(session, nativeId, {
      precedingConfigDir: configDir, unbounded: true, skipSubagents: options.messagesOnly,
      onMessageModel: (id, model) => { const info = shareModelInfo(model, 'claude', 'history'); if (info) modelInfo[id] = info; },
    });
    await transcript.setFile(file);
    options.signal?.throwIfAborted();
    if (transcript.state !== 'ok') throw unavailable('The Claude Code conversation history could not be parsed');
    const events = transcript.allEvents(), subagents: NativeShareTranscript['subagents'] = [];
    const warnings: string[] = [];
    for (const frame of options.messagesOnly ? [] : transcript.subagentFrames()) {
      options.signal?.throwIfAborted();
      let childEvents = frame.events;
      let history = frame.history;
      while (history?.hasMore) {
        options.signal?.throwIfAborted();
        if (!history.cursor || history.contextIncomplete) throw unavailable('The Claude Code subagent history is incomplete');
        const page = transcript.subagentHistory(frame.toolCallId, history.cursor, history.generation);
        if (page.history.generation !== history.generation) throw unavailable('The Claude Code subagent history changed');
        childEvents = [...page.events, ...childEvents];
        history = page.history;
      }
      subagents.push({ toolCallId: frame.toolCallId, agentId: frame.agentId, ...(frame.subagentType ? { subagentType: frame.subagentType } : {}), events: childEvents });
    }
    const loaded = new Set(subagents.map(child => child.agentId));
    if (!options.messagesOnly) for (const child of childReferences(events)) if (!loaded.has(child.agentId)) warnings.push(`子 Agent ${child.agentId} 的历史不可用`);
    const after = await Promise.all(files.map(fileStamp));
    options.signal?.throwIfAborted();
    if (before.every((stamp, index) => stamp === after[index])) return { events, subagents, warnings, modelInfo };
  }
  throw new AppError('SHARE_HISTORY_CHANGED', 'The conversation is still being written; try sharing again shortly', 409);
}
