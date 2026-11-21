import { access } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SyncLane } from '../../../../../packages/contracts/src/sync.js';
import type { TracePromptBlock, TraceRequests, TraceToolDefinition } from '../../../../../packages/contracts/src/trace.js';
import type { Session } from '../../../../../packages/contracts/src/index.js';
import { contentText, isRecord, noRequests, readRecordLines, stringOf, TraceRequestsBuilder } from '../shared/trace-requests.js';
import { findClaudeTranscript } from './history.js';

/*
 * Claude Code's request records (docs/TRACE.md §2.1), written into its transcript beside the conversation:
 * - `api-request-shape`: the system blocks and tool definitions, once per distinct shape (`shapeHash`);
 * - `api-request`: one per model request: parameters, the shape it used, and its messages as `keep` of the
 *   request it builds on followed by the `tail` of message hashes;
 * - `api-request-blob`: the body of a tail message that is not a conversation row (a system-reminder, the
 *   environment, instruction files), by hash. A tail hash without a blob is a conversation message.
 * The format is Claude Code's own and undocumented; a transcript without these lines answers `unrecognized`.
 */

const NEEDLES = ['"api-request'];

/** The tool's group: the MCP server of an `mcp__<server>__<tool>` name. */
const groupOf = (name: string): string | undefined => /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name)?.[1];

function toolOf(value: unknown): TraceToolDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const name = stringOf(value.name) ?? stringOf(value.type);
  if (!name) return undefined;
  const description = stringOf(value.description);
  const schema = value.input_schema ?? value.parameters;
  const group = groupOf(name);
  return { name, ...(description ? { description } : {}), ...(schema !== undefined ? { schema } : {}), ...(group ? { group } : {}) };
}

function systemOf(value: unknown): TracePromptBlock[] {
  if (typeof value === 'string') return [{ role: 'system', text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((block): TracePromptBlock[] => {
    const text = isRecord(block) ? stringOf(block.text) : typeof block === 'string' ? block : undefined;
    return text ? [{ role: 'system', text }] : [];
  });
}

/** Parses the lines of one lane's transcripts, in the order they were written. */
export class ClaudeRequestRecords {
  private readonly builder: TraceRequestsBuilder;
  private readonly shapes = new Map<string, { system: TracePromptBlock[]; tools: TraceToolDefinition[] }>();
  private readonly pending: Array<{ id: string; at: string; shape?: string; params?: Record<string, unknown>; source?: string; messages?: number; tail: string[] }> = [];

  constructor(lane: SyncLane) { this.builder = new TraceRequestsBuilder(lane, 'claude', 'request'); }

  line(record: Record<string, unknown>): void {
    const type = record.type;
    if (type === 'api-request-shape') {
      const hash = stringOf(record.shapeHash);
      const shape = isRecord(record.shape) ? record.shape : undefined;
      if (!hash || !shape) return;
      const tools = Array.isArray(shape.tools) ? shape.tools.flatMap((tool) => toolOf(tool) ?? []) : [];
      this.shapes.set(hash, { system: systemOf(shape.system), tools });
    } else if (type === 'api-request-blob') {
      const hash = stringOf(record.hash);
      const message = isRecord(record.message) ? record.message : undefined;
      if (hash && message) this.builder.contextMessage(stringOf(message.role) ?? 'user', contentText(message.content), hash);
    } else if (type === 'api-request') {
      const id = stringOf(record.id);
      const at = stringOf(record.timestamp);
      if (!id || !at) return;
      this.builder.version = stringOf(record.version) ?? this.builder.version;
      const tail = Array.isArray(record.tail) ? record.tail.filter((hash): hash is string => typeof hash === 'string') : [];
      const keep = typeof record.keep === 'number' && record.keep >= 0 ? record.keep : undefined;
      const shape = stringOf(record.shapeHash);
      const source = stringOf(record.querySource);
      this.pending.push({
        id, at, tail,
        ...(shape ? { shape } : {}),
        ...(isRecord(record.params) ? { params: record.params } : {}),
        ...(source ? { source } : {}),
        ...(keep !== undefined ? { messages: keep + tail.length } : {}),
      });
    }
  }

  /** Built once every line is read: a blob may be written after the request that carries it. */
  result(): TraceRequests {
    for (const request of this.pending) {
      const shape = request.shape ? this.shapes.get(request.shape) : undefined;
      const prompt = shape && request.shape ? this.builder.prompt(request.at, shape.system, shape.tools, request.shape) : undefined;
      const model = stringOf(request.params?.model);
      this.builder.request({
        id: request.id, at: request.at,
        ...(prompt ? { prompt } : {}),
        ...(request.params ? { params: this.builder.paramSet(request.params) } : {}),
        ...(model ? { model } : {}),
        ...(request.source ? { source: request.source } : {}),
        ...(request.messages !== undefined ? { messages: request.messages } : {}),
        added: request.tail.map((hash) => this.builder.hasContext(hash) ? hash : null),
      });
    }
    return this.builder.build();
  }
}

const exists = (path: string) => access(path).then(() => true, () => false);

/**
 * The lane's request records: the main lane reads the conversation's transcripts oldest first (earlier topics
 * included); a subagent lane reads its child's own transcript, found beside whichever topic's transcript ran it.
 */
export async function readClaudeRequests(session: Session, configDir: string, lane: SyncLane, agentId: string | undefined, signal: AbortSignal): Promise<TraceRequests> {
  const ids = [...(session.previousNativeSessionIds ?? []), ...(session.nativeSessionId ? [session.nativeSessionId] : [])];
  const transcripts = (await Promise.all(ids.map((id) => findClaudeTranscript(configDir, id)))).filter((file): file is string => Boolean(file));
  let files = transcripts;
  if (lane !== 'main') {
    // The id names a file; one that is not a plain id (from a damaged or imported journal) must not walk out of the folder.
    if (!agentId || !/^[\w-]{1,128}$/.test(agentId)) return noRequests(lane, 'missing', 'claude');
    const children = transcripts.map((file) => join(dirname(file), basename(file, '.jsonl'), 'subagents', `agent-${agentId}.jsonl`));
    const found: string[] = [];
    for (const child of children) if (await exists(child)) found.push(child);
    files = found;
  }
  if (!files.length) return noRequests(lane, 'missing', 'claude');
  const records = new ClaudeRequestRecords(lane);
  const read = await readRecordLines(files, NEEDLES, (record) => records.line(record), signal);
  if (read !== 'read') return noRequests(lane, read, 'claude');
  return records.result();
}
