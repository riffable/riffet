import { fileURLToPath } from 'node:url';
import type { NativeWorkbenchEvent, Session, ShareModelInfo, ShareSelection, ShareTurn } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { NativeEventLog } from '../../journal/native-log.js';
import type { NativeBackendHost, NativeShareReadOptions, NativeShareTranscript } from '../types.js';
import { readIngestState } from './journal-space.js';
import { rolloutRows } from './rollout-records.js';
import { parseRolloutPlan } from './rollout-plan.js';
import { projectToolItem, isCodexToolItem, isSpawnAgentItem, isSubagentStart, subagentName, userItemText } from './transcript.js';
import { codexQuestionReply, CodexQuestionHistory } from './question-history.js';
import { commandIdOfMessageId } from './message-tag.js';
import { asRecord, asArray, firstLine, str, safeJson } from './util.js';
import type { RpcItem } from './types.js';
import { MAX_ROLLOUT_BYTES } from './config.js';
import { shareHistoryTooLarge, shareRolloutReader } from './share-rollout.js';
import { shareModelInfo } from '../shared/share-model.js';
import { projectCodexItem } from './project-item.js';

interface ProjectedRollout { events: NativeWorkbenchEvent[]; modelInfo?: Record<string, ShareModelInfo>; children: Array<{ toolCallId: string; agentId: string; title?: string; prompt?: string; model?: string }> }

/** Adapt native rollout items to the ThreadItem schema consumed by the shared live projector. */
function nativeItem(source: Record<string, unknown>): RpcItem {
  const item: RpcItem = { ...source, type: String(source.type).replace(/^[A-Z]/, value => value.toLowerCase()) };
  for (const [key, value] of Object.entries(source)) if (key !== 'type') item[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  if (item.type === 'agentMessage') item.text = str(item.text) ?? contentText(item.content);
  if (item.type === 'enteredReviewMode') item.review = str(item.review) ?? str(item.userFacingHint);
  if (item.type === 'exitedReviewMode') item.review = str(item.review) ?? reviewOutputText(item.reviewOutput);
  if (item.type === 'reasoning') { item.summary = item.summaryText ?? item.summary; item.content = item.rawContent ?? item.content; }
  if (item.type === 'userMessage') item.content = asArray<Record<string, unknown>>(item.content).map(part => ({
    ...part, type: part.type === 'local_image' ? 'localImage' : part.type,
  }));
  if (item.type === 'commandExecution') {
    const argv = asArray<unknown>(item.command).filter((part): part is string => typeof part === 'string');
    if (argv.length) item.command = argv.map(part => /^[\w./:=+-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(' ');
    // Rollout CommandExecution is the native item, not the app-server ThreadItem. Feed its
    // parsed actions to the same read/search/compound-command projector as the live view.
    if (Array.isArray(item.parsedCmd)) item.commandActions = asArray<Record<string, unknown>>(item.parsedCmd).map(action => ({
      ...action, type: action.type === 'list_files' ? 'listFiles' : action.type, command: action.cmd,
      ...(argv.length ? { input: { type: 'shell', command: argv } } : {}),
    }));
    if (str(item.cwd)?.startsWith('file:')) {
      try { item.cwd = fileURLToPath(String(item.cwd)); } catch { /* Keep the provider's printable cwd. */ }
    }
  }
  if (item.type === 'fileChange' && asRecord(item.changes)) item.changes = Object.entries(asRecord(item.changes)!).map(([path, value]) => {
    const change = asRecord(value) ?? {};
    const body = str(change.content) ?? '';
    const diff = str(change.unified_diff) ?? body.split('\n').map(line => `${change.type === 'delete' ? '-' : '+'}${line}`).join('\n');
    return { path, kind: { type: change.type }, diff, ...(str(change.move_path) ? { movePath: change.move_path } : {}) };
  });
  return item;
}

/** Core rollout review items carry structured output; app-server ThreadItems carry its text. */
function reviewOutputText(value: unknown): string {
  const output = asRecord(value);
  const findings = asArray<Record<string, unknown>>(output?.findings);
  const comments = findings.map(finding => {
    const location = asRecord(finding.code_location), range = asRecord(location?.line_range);
    return `- ${str(finding.title) ?? ''} — ${str(location?.absolute_file_path) ?? ''}:${range?.start ?? ''}-${range?.end ?? ''}\n${(str(finding.body) ?? '').split('\n').map(line => `  ${line}`).join('\n')}`;
  });
  return [str(output?.overall_explanation)?.trim(), comments.length ? `${comments.length > 1 ? 'Full review comments:' : 'Review comment:'}\n\n${comments.join('\n\n')}` : undefined].filter(Boolean).join('\n\n') || 'Reviewer failed to output a response.';
}

/** Legacy EventMsg review fanout has the same item identity when the provider supplies one. */
function rolloutItem(payload: Record<string, unknown>, turnId: string): RpcItem | undefined {
  const source = payload.type === 'item_completed' ? asRecord(payload.item) : undefined;
  if (source) return nativeItem(source);
  if (payload.type === 'entered_review_mode' || payload.type === 'exited_review_mode') return nativeItem({
    ...payload, type: payload.type === 'entered_review_mode' ? 'enteredReviewMode' : 'exitedReviewMode', id: str(payload.item_id) ?? turnId,
  });
}

function contentText(content: unknown): string {
  return typeof content === 'string' ? content : str(asRecord(content)?.text) ?? asArray<unknown>(content).flatMap(part => {
    const row = asRecord(part); return str(row?.text) ?? [];
  }).join('');
}

/**
 * Model input is broader than the user-visible ThreadItem: user-role rows also carry repository
 * instructions and environment context. Codex records each block's origin alongside the content;
 * keep user-origin blocks before adapting the model-input casing to the live transcript shape.
 * Older providers without origin metadata retain their existing response-item fallback.
 */
function responseUserItem(payload: Record<string, unknown>): RpcItem | undefined {
  const kinds = asRecord(payload.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  const content = asArray<Record<string, unknown>>(payload.content)
    .filter((_, index) => !Array.isArray(kinds) || (typeof kinds[index] === 'string' && kinds[index].startsWith('user.')))
    .map(part => ({ ...part, type: part.type === 'input_text' ? 'text' : part.type === 'input_image' ? 'image' : part.type,
      ...(part.type === 'input_image' && str(part.image_url) ? { url: part.image_url } : {}) }));
  return content.length ? nativeItem({ ...payload, type: 'userMessage', content }) : undefined;
}

/** Reuses the tool and question projections which the live timeline receives. */
export function projectShareRollout(content: string, sessionId: string, threadId: string, messagesOnly = false): ProjectedRollout {
  const rows = [...rolloutRows(content)];
  const modelInfo: Record<string, ShareModelInfo> = Object.create(null);
  const canonicalTurns = new Set<string>();
  const canonicalUsers = new Set<string>(), canonicalAgents = new Set<string>(), canonicalReasoning = new Set<string>();
  const canonicalReviews = new Set<string>();
  let scanTurn = `rollout:${threadId}`;
  for (const row of rows) {
    const payload = asRecord(row.payload);
    if (row.type === 'turn_context' || (row.type === 'event_msg' && payload?.type === 'task_started')) scanTurn = str(payload?.turn_id) ?? scanTurn;
    if (row.type === 'event_msg' && payload) {
      const id = str(payload?.turn_id) ?? scanTurn;
      const item = rolloutItem(payload, id);
      if (!item) continue;
      if (payload.type === 'item_completed') {
        canonicalTurns.add(id);
        if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') canonicalReviews.add(`${id}:${item.type}`);
      }
      const type = item.type;
      if (type === 'userMessage') canonicalUsers.add(id);
      else if (type === 'agentMessage' || (type === 'exitedReviewMode' && str(item.review)?.trim())) canonicalAgents.add(id);
      else if (type === 'reasoning') canonicalReasoning.add(id);
    }
  }
  const events: NativeWorkbenchEvent[] = [], children: ProjectedRollout['children'] = [];
  const questions = new CodexQuestionHistory();
  const calls = new Map<string, RpcItem>();
  let turnId = `rollout:${threadId}`, sequence = 0, serial = 0;
  const project = (item: RpcItem, at: string) => {
    const base = `${threadId}:${turnId}:${item.id ?? ++serial}`;
    const event = (nativeId: string, type: string, data: Record<string, unknown>): NativeWorkbenchEvent => ({
      sequence: ++sequence, sessionId, runId: turnId, nativeTurnId: turnId, nativeId, type, data: { sessionUpdate: type, ...data }, createdAt: at,
    });
    if (item.type === 'shareProcessBoundary') {
      events.push(event(`${base}:process`, 'share_process', {}));
      return;
    }
    const question = messagesOnly ? undefined : questions.project(item, threadId, base, event);
    if (question) { events.push(...question); return; }
    if (item.type === 'userMessage') {
      const parts = asArray<Record<string, unknown>>(item.content);
      const images = parts.flatMap(part => ['localImage', 'image', 'input_image'].includes(String(part.type)) && str(part.path ?? part.url ?? part.image_url) ? [{ type: 'image', path: str(part.path ?? part.url ?? part.image_url) }] : []);
      const commandId = str(item.clientId) ?? commandIdOfMessageId(item.id);
      const nativeId = commandId ? `${threadId}:${turnId}:web:${commandId}:user` : `${base}:user`;
      const text = userItemText(item);
      const replies = messagesOnly ? codexQuestionReply(text) : undefined;
      const display = replies?.map(reply => `> ${reply.question}\n\n${reply.answers.join('\n')}`).join('\n\n') ?? text;
      events.push(event(nativeId, 'user_message_chunk', { content: { type: 'text', text: display }, ...(commandId ? { commandId } : {}), ...(images.length ? { attachments: images } : {}) }));
    } else if (item.type === 'agentMessage') {
      const text = str(item.text) ?? contentText(item.content);
      if (text) {
        const id = `${base}:assistant`;
        events.push(event(id, 'agent_message_chunk', { content: { type: 'text', text }, ...(str(item.phase) ? { phase: item.phase } : {}) }));
        const metadata = asRecord(item.shareModel) ?? item;
        const model = shareModelInfo(metadata.model, 'codex', 'history', metadata);
        if (model) modelInfo[id] = model;
      }
    } else if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
      events.push(...projectCodexItem(item, { id: turnId }, { sessionId, threadId, runId: turnId, createdAt: at }).map(({ raw: _raw, ...projected }) => ({ ...projected, sequence: ++sequence })));
    } else if (item.type === 'reasoning') {
      const summary = asArray<unknown>(item.summary).map(value => str(value) ?? str(asRecord(value)?.text) ?? '').filter(Boolean);
      const body = asArray<unknown>(item.content).map(value => str(value) ?? str(asRecord(value)?.text) ?? '').filter(Boolean);
      const text = [...summary, ...body].join('\n\n');
      if (text) events.push(event(`${base}:thinking`, 'agent_thought_chunk', { channel: summary.length ? 'narration' : 'thinking', content: { type: 'text', text } }));
    } else if (item.type === 'contextCompaction') {
      events.push(event(`${base}:compaction`, 'session/update', { sessionUpdate: 'activity', activity: { id: base, kind: 'compaction', title: '上下文压缩', status: 'completed' } }));
    } else if (isCodexToolItem(item)) {
      events.push(...projectToolItem(item, event, base));
    } else if (item.type === 'plan' && str(item.text)) {
      events.push(event(`${base}:plan`, 'tool_call', { toolCallId: item.id ?? base, toolName: 'Plan', kind: 'plan', title: 'Proposed plan', status: 'completed', content: [{ type: 'markdown', text: item.text }] }));
    }
    const childId = isSubagentStart(item) ? str(item.agentThreadId) : item.type === 'collabAgentToolCall' && isSpawnAgentItem(item) ? str(asArray<unknown>(item.receiverThreadIds)[0]) : undefined;
    const title = isSubagentStart(item) ? subagentName(item) : str(item.description) ?? firstLine(str(item.prompt) ?? '');
    if (childId && item.id) children.push({ toolCallId: item.id, agentId: childId, ...(str(item.prompt) ? { prompt: str(item.prompt) } : {}), ...(title ? { title } : {}), ...(str(item.model) ? { model: str(item.model) } : {}) });
  };
  for (const row of rows) {
    const payload = asRecord(row.payload);
    if (!payload) continue;
    const at = str(row.timestamp) ?? new Date(0).toISOString();
    if (row.type === 'turn_context') { turnId = str(payload.turn_id) ?? turnId; continue; }
    if (row.type === 'event_msg') {
      const item = rolloutItem(payload, str(payload.turn_id) ?? turnId);
      if (payload.type === 'task_started') turnId = str(payload.turn_id) ?? turnId;
      else if (item) {
        turnId = str(payload.turn_id) ?? turnId;
        if (payload.type === 'item_completed' || !canonicalReviews.has(`${turnId}:${item.type}`)) project(item, at);
      }
      else if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
        const id = str(payload.turn_id) ?? turnId;
        events.push({ sequence: ++sequence, sessionId, runId: id, nativeTurnId: id, nativeId: `${threadId}:${id}:end`, type: payload.type === 'task_complete' ? 'run_completed' : 'run_cancelled', data: {}, createdAt: at });
      }
      continue;
    }
    if (row.type !== 'response_item') continue;
    turnId = str(asRecord(payload.internal_chat_message_metadata_passthrough)?.turn_id) ?? turnId;
    if (payload.type === 'message' && payload.role === 'assistant' && canonicalAgents.has(turnId)) continue;
    // Older versions normalize tools before they normalize user/assistant messages. Prefer
    // canonical items by category, retaining the missing message category's origin-filtered
    // fallback while excluding duplicate protocol wrappers and encoded image envelopes.
    if (canonicalTurns.has(turnId)) {
      const missingMessage = payload.type === 'message' && (payload.role === 'user' ? !canonicalUsers.has(turnId) : payload.role === 'assistant' && !canonicalAgents.has(turnId));
      if (!missingMessage && !(payload.type === 'reasoning' && !canonicalReasoning.has(turnId))) continue;
    }
    if (payload.type === 'message' && ['user', 'assistant'].includes(String(payload.role))) {
      const item = payload.role === 'user' ? responseUserItem(payload) : { ...payload, type: 'agentMessage', text: contentText(payload.content) };
      if (!item) continue;
      project(item, at);
    } else if (payload.type === 'reasoning') {
      project({ ...payload, type: 'reasoning' }, at);
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const id = str(payload.call_id) ?? str(payload.id);
      if (!id) continue;
      const args = typeof payload.arguments === 'string' ? safeJson(payload.arguments) : payload.arguments;
      const input = asRecord(args);
      const name = str(payload.name) ?? 'Tool';
      const item: RpcItem = /(?:exec_command|shell_command|shell)$/.test(name) ? { type: 'commandExecution', id, command: str(input?.cmd ?? input?.command) ?? str(payload.input), status: 'inProgress' }
        : { type: 'dynamicToolCall', id, tool: name, arguments: args ?? payload.input, status: 'inProgress' };
      calls.set(id, item);
      project(item, at);
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const id = str(payload.call_id), call = id ? calls.get(id) : undefined;
      if (call) {
        const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
        // The result updates the existing call identity instead of inserting a second tool call.
        const base = `${threadId}:${turnId}:${call.id}`;
        events.push({ sequence: ++sequence, sessionId, runId: turnId, nativeTurnId: turnId, nativeId: `${base}:result`, type: 'tool_call_update', data: { toolCallId: call.id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }] }, createdAt: at });
      }
    }
  }
  const plan = messagesOnly ? undefined : parseRolloutPlan(content);
  if (plan) events.push({ sequence: ++sequence, sessionId, runId: plan.turnId ?? turnId, nativeTurnId: plan.turnId ?? turnId, nativeId: `${threadId}:plan:${plan.callId ?? sequence}`, type: 'plan', data: { entries: plan.entries }, createdAt: plan.timestamp });
  events.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.sequence - right.sequence);
  events.forEach((event, index) => { event.sequence = index + 1; });
  return { events, children, ...(Object.keys(modelInfo).length ? { modelInfo } : {}) };
}

/** Assign legacy logs stable user-turn boundaries while preserving native turn IDs and steering. */
function scopedRows(threadId: string, visit: (row: Record<string, unknown>, turnId: string) => void): (row: Record<string, unknown>) => void {
  let turnId = `rollout:${threadId}`, explicit = false, legacyUser = 0, pendingResponseUser = false;
  return raw => {
    const payload = asRecord(raw.payload);
    const rows = raw.type === 'history_mutation'
      ? asArray<Record<string, unknown>>(payload?.items).map(item => ({ type: 'response_item', timestamp: raw.timestamp, payload: item }))
      : [raw];
    for (const row of rows) {
      const data = asRecord(row.payload);
      if (!data) continue;
      const id = str(data.turn_id) ?? str(asRecord(data.internal_chat_message_metadata_passthrough)?.turn_id);
      if (id) { turnId = id; explicit = true; }
      if (!explicit) {
        const isResponseUser = row.type === 'response_item' && data.type === 'message' && data.role === 'user' && !!responseUserItem(data);
        const item = asRecord(data.item);
        const isCanonicalUser = row.type === 'event_msg' && data.type === 'item_completed' && String(item?.type).replace(/^[A-Z]/, letter => letter.toLowerCase()) === 'userMessage';
        if (isResponseUser) { turnId = `rollout:${threadId}:${++legacyUser}`; pendingResponseUser = true; }
        else if (isCanonicalUser) {
          if (!pendingResponseUser) turnId = `rollout:${threadId}:${++legacyUser}`;
          pendingResponseUser = false;
        }
      }
      visit(row, turnId);
    }
  };
}

function chooseTurns(turns: ShareTurn[], selection?: ShareSelection): string[] {
  if (!selection || selection.mode === 'all') return turns.map(turn => turn.id);
  if (selection.mode === 'recent') {
    if (!Number.isSafeInteger(selection.count) || selection.count < 1) throw new AppError('SHARE_SELECTION_INVALID', 'The number of shared turns is invalid', 400, undefined, { reason: 'count' });
    return turns.slice(-selection.count).map(turn => turn.id);
  }
  const ids = new Set(selection.turnIds), known = new Set(turns.map(turn => turn.id));
  if (!ids.size || [...ids].some(id => !known.has(id))) throw new AppError('SHARE_SELECTION_INVALID', 'The selected messages changed; select them again', 409, undefined, { reason: 'changed' });
  return turns.filter(turn => ids.has(turn.id)).map(turn => turn.id);
}

/** Keep only reader-visible message fields before the selected-history byte budget is applied. */
function messageOnlyRow(row: Record<string, unknown>, turnId: string, canonicalUser: boolean, canonicalAgent: boolean): Record<string, unknown> | undefined {
  const payload = asRecord(row.payload);
  if (!payload) return;
  const boundary = () => ({ type: 'event_msg', timestamp: row.timestamp, payload: { type: 'item_completed', turn_id: turnId, item: { type: 'shareProcessBoundary' } } });
  const message = (source: RpcItem): Record<string, unknown> => {
    const identity = { ...(str(source.id) ? { id: source.id } : {}), ...(str(source.clientId) ? { clientId: source.clientId } : {}) };
    if (source.type === 'exitedReviewMode') return { ...identity, type: source.type, review: str(source.review) ?? '' };
    if (source.type === 'userMessage') {
      const content = asArray<Record<string, unknown>>(source.content).flatMap((part): Record<string, unknown>[] => {
        if (part.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text }];
        if (['localImage', 'image', 'input_image'].includes(String(part.type))) {
          const path = str(part.path), url = str(part.url ?? part.image_url);
          if (path || url) return [{ type: path ? 'localImage' : 'image', ...(path ? { path } : { url }) }];
        }
        return [];
      });
      return { ...identity, type: source.type, content };
    }
    const shareModel = shareModelInfo(source.model, 'codex', 'history', source);
    return { ...identity, type: 'agentMessage', text: str(source.text) ?? contentText(source.content), ...(str(source.phase) ? { phase: source.phase } : {}), ...(shareModel ? { shareModel } : {}) };
  };
  if (row.type === 'event_msg') {
    if (['task_started', 'task_complete', 'turn_aborted'].includes(String(payload.type))) return {
      type: row.type, timestamp: row.timestamp, payload: { type: payload.type, turn_id: turnId },
    };
    const source = rolloutItem(payload, turnId);
    if (!source) return;
    const type = source.type;
    if (type !== 'userMessage' && type !== 'agentMessage' && type !== 'exitedReviewMode') return boundary();
    if (type === 'agentMessage' && source.phase === 'commentary') return boundary();
    return { type: row.type, timestamp: row.timestamp, payload: { type: 'item_completed', turn_id: turnId, item: message(source) } };
  }
  if (row.type !== 'response_item') return;
  if (payload.type !== 'message') return boundary();
  if (payload.role === 'user') {
    if (canonicalUser) return;
    const source = responseUserItem(payload);
    if (!source) return;
    return { type: 'event_msg', timestamp: row.timestamp, payload: { type: 'item_completed', turn_id: turnId, item: message(source) } };
  }
  if (payload.role === 'assistant') {
    if (canonicalAgent) return;
    if (payload.phase === 'commentary') return boundary();
    return { type: 'event_msg', timestamp: row.timestamp, payload: { type: 'item_completed', turn_id: turnId, item: message({ ...payload, type: 'agentMessage' }) } };
  }
}

function messageOnlyJournalEvent(event: NativeWorkbenchEvent): NativeWorkbenchEvent | undefined {
  const identity: NativeWorkbenchEvent = {
    sequence: event.sequence, sessionId: event.sessionId, runId: event.runId,
    nativeTurnId: event.nativeTurnId, nativeId: event.nativeId, type: event.type, data: {}, createdAt: event.createdAt,
  };
  const user = event.type === 'user_message_chunk', assistant = event.type === 'agent_message_chunk';
  if (user || (assistant && event.data.phase !== 'commentary')) {
    identity.data = { content: { type: 'text', text: contentText(event.data.content) }, ...(str(event.data.phase) ? { phase: event.data.phase } : {}) };
    if (user) {
      if (str(event.data.commandId)) identity.data.commandId = event.data.commandId;
      const attachments = asArray<Record<string, unknown>>(event.data.attachments).map(attachment => Object.fromEntries(
        ['id', 'name', 'mimeType', 'type', 'path', 'width', 'height'].filter(key => attachment[key] !== undefined).map(key => [key, attachment[key]]),
      ));
      if (attachments.length) identity.data.attachments = attachments;
    }
    return identity;
  }
  if (assistant || event.type === 'agent_thought_chunk' || event.type.includes('tool_call') || event.type === 'plan' || event.data.activity || event.data.subagent) {
    return { ...identity, type: 'share_process' };
  }
}

async function readSelectedRollout(stateHome: string, threadId: string, options: NativeShareReadOptions, includeInherited = true, excludedRootTurns?: Set<string>): Promise<{ content: string; turns: ShareTurn[]; selectedTurnIds: string[]; allTurnIds: Set<string>; turnModels?: Record<string, ShareModelInfo>; ambiguousModelTurns?: string[] }> {
  const reader = await shareRolloutReader(stateHome, threadId, options.signal, includeInherited);
  const allTurnIds = new Set<string>();
  const canonicalReviews = new Set<string>();
  const catalog = new Map<string, { fallback?: ShareTurn; canonical?: ShareTurn; assistant?: ShareTurn; assistantFallback?: ShareTurn; tool?: ShareTurn; hasCanonical?: boolean; canonicalAgent?: boolean; canonicalReasoning?: boolean }>();
  await reader.scan(scopedRows(threadId, (row, turnId) => {
    if (excludedRootTurns?.has(turnId)) return;
    allTurnIds.add(turnId);
    const payload = asRecord(row.payload);
    if (!payload) return;
    const item = row.type === 'event_msg' ? rolloutItem(payload, turnId) : undefined;
    const entry = catalog.get(turnId) ?? {};
    if (item && payload.type === 'item_completed') {
      entry.hasCanonical = true;
      if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') canonicalReviews.add(`${turnId}:${item.type}`);
    }
    const type = item?.type;
    if (type === 'agentMessage' || (type === 'exitedReviewMode' && str(item?.review)?.trim())) entry.canonicalAgent = true;
    else if (type === 'reasoning') entry.canonicalReasoning = true;
    const normalized = type === 'userMessage' ? item : undefined;
    const summary = (text: string): ShareTurn => ({ id: turnId, text: text.trim().replace(/\s+/g, ' ').slice(0, 240), createdAt: str(row.timestamp) ?? new Date(0).toISOString() });
    const user = normalized?.type === 'userMessage' ? normalized
      : row.type === 'response_item' && payload.type === 'message' && payload.role === 'user' ? responseUserItem(payload) : undefined;
    if (user) {
      const turn = summary(userItemText(user));
      if (normalized) entry.canonical ??= turn;
      else entry.fallback ??= turn;
    }
    if (item && (type === 'exitedReviewMode' || (type === 'agentMessage' && (!options.messagesOnly || item.phase !== 'commentary')))) {
      const text = type === 'exitedReviewMode' ? str(item.review) : str(item.text) ?? contentText(item.content);
      if (text) entry.assistant ??= summary(text);
    } else if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && (!options.messagesOnly || payload.phase !== 'commentary')) {
      const text = contentText(payload.content);
      if (text) entry.assistantFallback ??= summary(text);
    }
    const tool = item && type && isCodexToolItem({ type, kind: item.kind, agentThreadId: item.agentThreadId ?? item.agent_thread_id });
    if (tool || (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(String(payload.type)))) entry.tool ??= summary('工具记录');
    if (entry.hasCanonical || entry.fallback || entry.canonical || entry.assistant || entry.assistantFallback || entry.tool) catalog.set(turnId, entry);
  }));
  const turns = [...catalog.values()].flatMap(entry => entry.canonical ?? entry.fallback ?? entry.assistant ?? entry.assistantFallback ?? (options.messagesOnly ? undefined : entry.tool) ?? []);
  const selectedTurnIds = chooseTurns(turns, options.selection);
  if (options.catalogOnly) return { content: '', turns, selectedTurnIds, allTurnIds };
  const selected = options.messagesOnly || (options.selection && options.selection.mode !== 'all') ? new Set(selectedTurnIds) : undefined;
  const turnModels: Record<string, ShareModelInfo> = Object.create(null);
  const ambiguousModels = new Set<string>();
  const lines: string[] = [];
  const planCalls = new Set<string>();
  let bytes = 0, previousTurn: string | undefined, previousBoundaryTurn: string | undefined;
  await reader.scan(scopedRows(threadId, (row, turnId) => {
    if (excludedRootTurns?.has(turnId)) return;
    if (selected && !selected.has(turnId)) return;
    let retained = row;
    const payload = asRecord(row.payload);
    if (!payload) return;
    if (row.type === 'event_msg' && (payload.type === 'entered_review_mode' || payload.type === 'exited_review_mode')) {
      const type = payload.type === 'entered_review_mode' ? 'enteredReviewMode' : 'exitedReviewMode';
      if (canonicalReviews.has(`${turnId}:${type}`)) return;
    }
    if (row.type === 'turn_context') {
      const model = shareModelInfo(payload.model, 'codex', 'history', payload);
      if (model && !ambiguousModels.has(turnId)) {
        if (turnModels[turnId] && JSON.stringify(turnModels[turnId]) !== JSON.stringify(model)) {
          delete turnModels[turnId]; ambiguousModels.add(turnId);
        } else turnModels[turnId] = model;
      }
    }
    if (options.messagesOnly) {
      const entry = catalog.get(turnId);
      const messageRow = messageOnlyRow(row, turnId, !!entry?.canonical, !!entry?.canonicalAgent);
      if (!messageRow) return;
      retained = messageRow;
      const boundary = asRecord(asRecord(retained.payload)?.item)?.type === 'shareProcessBoundary';
      if (boundary && previousBoundaryTurn === turnId) return;
      previousBoundaryTurn = boundary ? turnId : undefined;
    } else {
      // These are the only event rows the shared projector consumes. Context is recreated below.
      if (row.type === 'event_msg') {
        if (!['task_started', 'item_completed', 'task_complete', 'turn_aborted', 'entered_review_mode', 'exited_review_mode'].includes(String(payload.type))) return;
      } else if (row.type === 'response_item') {
        const entry = catalog.get(turnId);
        if (payload.type === 'message' && payload.role === 'assistant' && entry?.canonicalAgent) return;
        const missingMessage = payload.type === 'message' && (payload.role === 'user' ? !entry?.canonical : payload.role === 'assistant' && !entry?.canonicalAgent);
        if (entry?.hasCanonical && !missingMessage && !(payload.type === 'reasoning' && !entry.canonicalReasoning)) {
          // Canonical ThreadItems already contain the visible transcript. Keep only the tiny
          // protocol fragments needed by parseRolloutPlan, never encoded image/tool envelopes.
          const callId = str(payload.call_id);
          if (payload.type === 'function_call' && ['update_plan', 'TaskCreate', 'TaskUpdate'].includes(String(payload.name)) && callId) {
            planCalls.add(callId);
            retained = { type: row.type, timestamp: row.timestamp, payload: { type: payload.type, call_id: callId, name: payload.name, arguments: payload.arguments } };
          } else if (payload.type === 'function_call_output' && callId && planCalls.has(callId)) {
            retained = { type: row.type, timestamp: row.timestamp, payload: { type: payload.type, call_id: callId, output: typeof payload.output === 'string' ? payload.output.slice(0, 4096) : payload.output } };
          } else return;
        }
      } else return;
    }
    if (turnId !== previousTurn) {
      const context = JSON.stringify({ type: 'turn_context', payload: { turn_id: turnId } });
      lines.push(context); bytes += Buffer.byteLength(context) + 1; previousTurn = turnId;
    }
    const line = JSON.stringify(retained);
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > MAX_ROLLOUT_BYTES) throw shareHistoryTooLarge();
    lines.push(line);
  }));
  return { content: lines.join('\n'), turns, selectedTurnIds, allTurnIds, turnModels, ambiguousModelTurns: [...ambiguousModels] };
}

export async function readCodexShare(host: NativeBackendHost, session: Session, stateHome: string, options: NativeShareReadOptions = {}): Promise<NativeShareTranscript> {
  const threadId = session.nativeSessionId;
  if (!threadId) return { events: [], subagents: [], turns: [], selectedTurnIds: [] };
  if (options.selection?.mode === 'selected' && options.selection.nativeChatId && options.selection.nativeChatId !== threadId) throw new AppError('SHARE_SELECTION_INVALID', 'The selected messages do not belong to this conversation', 409, undefined, { reason: 'session' });
  // A retained journal is a fallback only when the original file was pruned. `ready` carries no
  // rollout watermark, so it cannot prove that an external CLI has not appended more history.
  const journal = host.journal, state = journal ? readIngestState(journal, session.id) : undefined;
  const head = state?.phase === 'ready' && state.threadId === threadId ? journal?.peek(session.id) : undefined;
  let source: Awaited<ReturnType<typeof readSelectedRollout>>;
  try { source = await readSelectedRollout(stateHome, threadId, options); }
  catch (error) {
    // A retained complete journal also supports sessions whose provider pruned its rollout.
    if (!(error instanceof AppError) || error.code !== 'SHARE_HISTORY_NOT_FOUND' || !head || !journal) throw error;
    const retained = new NativeEventLog(journal, session.id).tail(head.lastSeq + 1);
    const events = options.messagesOnly ? retained.flatMap(event => messageOnlyJournalEvent(event) ?? []) : retained;
    const byTurn = new Map<string, ShareTurn>(), userTurns = new Set<string>();
    for (const event of events) if (event.type === 'user_message_chunk' || (options.messagesOnly && event.type === 'agent_message_chunk')) {
      const id = event.nativeTurnId ?? event.runId;
      if (id && (!byTurn.has(id) || (event.type === 'user_message_chunk' && !userTurns.has(id)))) {
        byTurn.set(id, { id, text: contentText(event.data.content).replace(/\s+/g, ' ').slice(0, 240), createdAt: event.createdAt });
      }
      if (id && event.type === 'user_message_chunk') userTurns.add(id);
    }
    const turns = [...byTurn.values()], selectedTurnIds = chooseTurns(turns, options.selection);
    const selected = new Set(selectedTurnIds);
    return {
      events: options.catalogOnly ? [] : options.messagesOnly || (options.selection && options.selection.mode !== 'all') ? events.filter(event => selected.has(event.nativeTurnId ?? event.runId ?? '')) : events,
      subagents: [], turns, selectedTurnIds,
      warnings: ['原生历史文件已清理，分享使用本地保留记录', ...(events.some(event => event.data.subagent) ? ['子 Agent 的历史不可用'] : [])],
    };
  }
  if (options.catalogOnly) return { events: [], subagents: [], turns: source.turns, selectedTurnIds: source.selectedTurnIds };
  const root = projectShareRollout(source.content, session.id, threadId, options.messagesOnly), warnings: string[] = [], subagents: NativeShareTranscript['subagents'] = [];
  if (options.messagesOnly) return { events: root.events, subagents, warnings, turns: source.turns, selectedTurnIds: source.selectedTurnIds, modelInfo: root.modelInfo, turnModels: source.turnModels, ambiguousModelTurns: source.ambiguousModelTurns };
  const pending = [...root.children], visited = new Set([threadId]);
  const partial = options.selection && options.selection.mode !== 'all';
  for (let index = 0; index < pending.length && index < 128; index++) {
    options.signal?.throwIfAborted();
    const child = pending[index]!;
    if (visited.has(child.agentId)) continue;
    visited.add(child.agentId);
    try {
      // Some versions copied the parent rollout into the child's own file rather than recording
      // history_base. Filter every root turn before projection, including before child discovery.
      const childSource = await readSelectedRollout(stateHome, child.agentId, { signal: options.signal }, !partial, partial ? source.allTurnIds : undefined);
      const projected = projectShareRollout(childSource.content, session.id, child.agentId);
      subagents.push({ ...child, events: projected.events }); pending.push(...projected.children);
    } catch {
      options.signal?.throwIfAborted();
      warnings.push(`子 Agent ${child.agentId} 的历史不可用`);
    }
  }
  if (pending.length > 128) warnings.push('部分子 Agent 的历史不可用');
  return { events: root.events, subagents, warnings, turns: source.turns, selectedTurnIds: source.selectedTurnIds, modelInfo: root.modelInfo, turnModels: source.turnModels, ambiguousModelTurns: source.ambiguousModelTurns };
}
