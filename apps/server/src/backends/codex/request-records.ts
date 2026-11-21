import type { SyncLane } from '../../../../../packages/contracts/src/sync.js';
import type { TracePromptBlock, TraceRequests, TraceToolDefinition } from '../../../../../packages/contracts/src/trace.js';
import type { Session } from '../../../../../packages/contracts/src/index.js';
import { isRecord, noRequests, readRecordLines, stringOf, TraceRequestsBuilder } from '../shared/trace-requests.js';
import { findCodexRollout } from './rollout-usage.js';

/*
 * Codex's request context (docs/TRACE.md §2.1), read from the thread's rollout. Codex does not record each model
 * request; it records what a turn is sent with:
 * - `session_meta.base_instructions`: the system prompt;
 * - `response_item` of type `additional_tools`: the tool definitions, grouped by namespace;
 * - `turn_context`: one per turn, the model, effort, sandbox and approval settings;
 * - `response_item` messages in the developer role, and the user-role parts Codex writes itself (AGENTS.md,
 *   `<environment_context>`): the injected context. Other user parts are conversation messages.
 * Context written before a turn's `turn_context` is carried by that turn.
 */

const NEEDLES = ['"session_meta"', '"turn_context"', '"additional_tools"', '"developer"', '"user"'];

/** A user-role part Codex wrote itself rather than the person: a leading tag or the AGENTS.md heading; an `<image>` is the person's attachment. */
const injected = (text: string): boolean => /^\s*(?:<(?!image[\s>])[a-zA-Z][\w-]*[\s>]|# AGENTS\.md instructions)/.test(text);

function toolsOf(value: unknown, group?: string): TraceToolDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tool): TraceToolDefinition[] => {
    if (!isRecord(tool)) return [];
    const name = stringOf(tool.name) ?? stringOf(tool.type);
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) return toolsOf(tool.tools, name ?? group);
    if (!name) return [];
    const description = stringOf(tool.description);
    const schema = tool.parameters ?? tool.input_schema ?? tool.format;
    return [{ name, ...(description ? { description } : {}), ...(schema !== undefined ? { schema } : {}), ...(group ? { group } : {}) }];
  });
}

const partsOf = (content: unknown): string[] => Array.isArray(content)
  ? content.flatMap((part) => isRecord(part) && typeof part.text === 'string' ? [part.text] : [])
  : typeof content === 'string' ? [content] : [];

export class CodexRequestRecords {
  private readonly builder: TraceRequestsBuilder;
  private system: TracePromptBlock[] = [];
  private tools: TraceToolDefinition[] = [];
  private promptId?: string;
  /** Context and conversation written since the last turn began, for the next turn to carry. */
  private pending: Array<string | null> = [];
  private turns = 0;

  constructor(lane: SyncLane, backendId = 'codex') { this.builder = new TraceRequestsBuilder(lane, backendId, 'turn'); }

  line(record: Record<string, unknown>): void {
    const payload = isRecord(record.payload) ? record.payload : undefined;
    if (!payload) return;
    const at = stringOf(record.timestamp) ?? '';
    if (record.type === 'session_meta') {
      this.builder.version = stringOf(payload.cli_version) ?? this.builder.version;
      const base = isRecord(payload.base_instructions) ? stringOf(payload.base_instructions.text) : stringOf(payload.base_instructions);
      if (base) { this.system = [{ role: 'system', text: base }]; this.promptId = undefined; }
      return;
    }
    if (record.type === 'turn_context') {
      const turnId = stringOf(payload.turn_id);
      const { turn_id: _turn, root_turn_id: _root, ...params } = payload;
      this.promptId ??= this.system.length || this.tools.length ? this.builder.prompt(at, this.system, this.tools) : undefined;
      const model = stringOf(payload.model);
      this.turns += 1;
      this.builder.request({
        id: turnId ?? `turn-${this.turns}`, at,
        ...(turnId ? { turnId } : {}),
        ...(this.promptId ? { prompt: this.promptId } : {}),
        params: this.builder.paramSet(params),
        ...(model ? { model } : {}),
        added: this.pending,
      });
      this.pending = [];
      return;
    }
    if (record.type !== 'response_item') return;
    if (payload.type === 'additional_tools') {
      this.tools = toolsOf(payload.tools);
      this.promptId = undefined;
      return;
    }
    if (payload.type !== 'message') return;
    const role = stringOf(payload.role);
    if (role !== 'developer' && role !== 'user') return;
    const added: Array<string | null> = [];
    for (const text of partsOf(payload.content)) {
      // The base instructions are also sent as the first developer message; they are the prompt's, not context.
      if (role === 'developer' && this.system.some((block) => block.text === text)) continue;
      added.push(role === 'developer' || injected(text) ? this.builder.contextMessage(role, text) : null);
    }
    if (!added.length) return;
    // Written after its turn began: that turn carries it. Before any turn: the first turn does.
    const last = this.builder.last;
    if (last?.added) last.added.push(...added); else this.pending.push(...added);
  }

  result(): TraceRequests { return this.builder.build(); }
}

/** The lane's rollout: the thread's own for the main lane, the child thread's (its `agentId`) for a subagent lane. */
export async function readCodexRequests(backendId: string, session: Session, codexHome: string, lane: SyncLane, agentId: string | undefined, signal: AbortSignal): Promise<TraceRequests> {
  const threadIds = lane === 'main'
    ? [...(session.previousNativeSessionIds ?? []), ...(session.nativeSessionId ? [session.nativeSessionId] : [])]
    : agentId ? [agentId] : [];
  const files = (await Promise.all(threadIds.map((id) => findCodexRollout(codexHome, id)))).filter((file): file is string => Boolean(file));
  if (!files.length) return noRequests(lane, 'missing', backendId);
  const records = new CodexRequestRecords(lane, backendId);
  const read = await readRecordLines(files, NEEDLES, (record) => records.line(record), signal);
  if (read !== 'read') return noRequests(lane, read, backendId);
  return records.result();
}
