import type { NativeWorkbenchEvent, Run, Session, ShareModelInfo, ShareSnapshot, ShareTurn, ShareTurnCatalog, WorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { messageAttachments } from '../../../../packages/timeline/src/model.js';
import { isInteractionToolData } from '../../../../packages/timeline/src/toolTitle.js';
import { AppError } from '../errors.js';
import type { Store } from '../store.js';
import type { IdentifiedSession } from '../session-identity.js';
import type { NativeBackendService } from '../backends/service.js';
import type { NativeShareReadOptions, NativeShareTranscript } from '../backends/types.js';
import { shareModelInfo } from '../backends/shared/share-model.js';

type CaptureDependencies = { store: Store; nativeBackends: NativeBackendService };

/** Group provider records by their own turn identity; untagged formats follow user boundaries. */
function transcriptTurns(events: NativeWorkbenchEvent[]) {
  const turns = new Map<string, ShareTurn>(), assignments = new Map<NativeWorkbenchEvent, string>();
  const runTurns = new Map<string, string>(), toolTurns = new Map<string, string>();
  const positions = new Map<string, number>();
  let current: string | undefined;
  for (const event of events) {
    if (event.type !== 'user_message_chunk' || event.data.hidden === true) continue;
    const id = event.nativeTurnId ?? event.runId ?? event.nativeId;
    if (event.runId) runTurns.set(event.runId, id);
    if (turns.has(id)) continue;
    const content = event.data.content as { text?: unknown } | undefined;
    const text = typeof content?.text === 'string' ? content.text : typeof event.data.text === 'string' ? event.data.text : '';
    turns.set(id, { id, text: text.replace(/\s+/g, ' ').trim().slice(0, 240) || '附件', createdAt: event.createdAt });
  }
  for (const event of events) {
    if (event.type === 'user_message_chunk' && event.data.hidden !== true) current = event.nativeTurnId ?? event.runId ?? event.nativeId;
    const toolId = typeof event.data.toolCallId === 'string' ? event.data.toolCallId : undefined;
    const visible = ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(event.type) && event.data.hidden !== true;
    const id = event.nativeTurnId ?? (event.runId ? runTurns.get(event.runId) ?? event.runId : undefined) ?? (toolId ? toolTurns.get(toolId) : undefined) ?? current ?? (visible ? event.nativeId : undefined);
    if (id) {
      assignments.set(event, id);
      if (!positions.has(id)) positions.set(id, positions.size);
      if (toolId) toolTurns.set(toolId, id);
      if (visible && !turns.has(id)) {
        const content = event.data.content as { text?: unknown } | undefined;
        const text = typeof content?.text === 'string' ? content.text : typeof event.data.text === 'string' ? event.data.text : '工具记录';
        turns.set(id, { id, text: text.replace(/\s+/g, ' ').trim().slice(0, 240), createdAt: event.createdAt });
        current ??= id;
      }
    }
  }
  return { turns: [...turns.values()].sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0)), assignments };
}

async function readTranscript(deps: CaptureDependencies, sessionId: string, options: NativeShareReadOptions): Promise<NativeShareTranscript> {
  const session = deps.store.getSession(sessionId);
  if (session.kind === 'native') return deps.nativeBackends.readShareTranscript(sessionId, options);
  const events: NativeWorkbenchEvent[] = [];
  let after = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const page = deps.store.getEvents(sessionId, after, 2000);
    if (!page.length) break;
    for (const event of page) events.push({ ...event, nativeId: (event as Partial<NativeWorkbenchEvent>).nativeId ?? `riffet:${event.sequence}` });
    after = page.at(-1)!.sequence;
    if (page.length < 2000) break;
  }
  return { events, subagents: [], warnings: [] };
}

export async function shareTurnCatalog(deps: CaptureDependencies, sessionId: string, signal?: AbortSignal): Promise<ShareTurnCatalog> {
  const session = deps.store.getSession(sessionId);
  const transcript = await readTranscript(deps, sessionId, { catalogOnly: true, messagesOnly: true, signal });
  const current = deps.store.getSession(sessionId);
  if (current.nativeSessionId !== session.nativeSessionId || current.backendId !== session.backendId) throw new AppError('SHARE_HISTORY_CHANGED', 'The conversation history changed; generate the preview again', 409);
  return { turns: transcript.turns ?? transcriptTurns(readingMessages(transcript.events)).turns, nativeChatId: session.nativeSessionId };
}

/** Keep the same final-answer boundary as the workbench: unphased prose before later
 * tool work is process commentary; explicit final answers always remain readable. */
function readingMessages(events: NativeWorkbenchEvent[]): NativeWorkbenchEvent[] {
  const { assignments } = transcriptTurns(events);
  const laterProcess = new Set<string>(), retained = new Set<NativeWorkbenchEvent>();
  // Tool results update an existing row in the workbench. They must not turn a later
  // completed answer back into process prose when background work finishes after it.
  const seenTools = new Set<string>(), toolUpdates = new Set<NativeWorkbenchEvent>();
  for (const event of events) {
    const kind = typeof event.data.sessionUpdate === 'string' ? event.data.sessionUpdate : event.type;
    const toolId = typeof event.data.toolCallId === 'string' ? event.data.toolCallId : undefined;
    if ((kind === 'tool_call' || kind === 'tool_call_update') && toolId) {
      if (seenTools.has(toolId)) toolUpdates.add(event);
      seenTools.add(toolId);
    }
  }
  const processKinds = new Set(['tool_call', 'tool_call_update', 'agent_thought_chunk', 'share_process', 'plan', 'activity']);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.data.hidden === true) continue;
    const kind = typeof event.data.sessionUpdate === 'string' ? event.data.sessionUpdate : event.type;
    const turn = assignments.get(event) ?? event.nativeTurnId ?? event.runId ?? 'unscoped';
    if (kind === 'user_message_chunk') { retained.add(event); laterProcess.clear(); }
    else if (kind === 'agent_message_chunk') {
      const phase = event.data.phase ?? event.data.channel;
      if (phase === 'commentary') laterProcess.add(turn);
      else if (phase === 'final_answer' || !laterProcess.has(turn)) retained.add(event);
    } else if ((kind === 'tool_call' || kind === 'tool_call_update') && !toolUpdates.has(event) && isInteractionToolData(event.data)) {
      laterProcess.delete(turn);
    } else if (processKinds.has(kind) && !toolUpdates.has(event)) laterProcess.add(turn);
  }
  return events.filter(event => retained.has(event));
}

/** Export just reading data. A run can supply the original prompt/attachment receipt, never
 * runtime configuration, process output or execution metrics. */
function readingEvent(source: WorkbenchEvent, run?: Run): NativeWorkbenchEvent {
  const kind = typeof source.data.sessionUpdate === 'string' ? source.data.sessionUpdate : source.type;
  const content = source.data.content as Record<string, unknown> | undefined;
  const data: Record<string, unknown> = { sessionUpdate: kind };
  if (content?.type === 'image') {
    data.content = Object.fromEntries(Object.entries(content).filter(([key]) => ['type', 'path', 'src', 'data', 'mimeType', 'width', 'height'].includes(key)));
  } else {
    const text = kind === 'user_message_chunk' && run ? run.prompt : typeof content?.text === 'string' ? content.text : typeof source.data.text === 'string' ? source.data.text : '';
    const references = kind === 'user_message_chunk' ? run?.native?.contextSnapshots : undefined;
    const referencedText = references?.length ? `${text}\n\n${references.map(ref => `Reference: ${ref.title} (${ref.capturedAt})\n${ref.excerpt}`).join('\n\n')}` : text;
    data.content = { type: 'text', text: referencedText };
  }
  if (source.data.replayId) data.replayId = source.data.replayId;
  if (kind === 'agent_message_chunk') data.phase = 'final_answer';
  const attachments = messageAttachments(source, kind === 'user_message_chunk' ? run?.native?.input.attachmentIds : undefined);
  if (attachments.length) data.attachments = attachments;
  const native = source as Partial<NativeWorkbenchEvent>;
  return {
    sequence: source.sequence, sessionId: source.sessionId, type: kind, data: structuredClone(data), createdAt: source.createdAt,
    nativeId: native.nativeId ?? `riffet:${source.sequence}`,
    ...(native.nativeTurnId ? { nativeTurnId: native.nativeTurnId } : {}),
    ...(native.nativeAliases ? { nativeAliases: [...native.nativeAliases] } : {}),
  };
}

/** Only exact receipts, commands and native identities can join a response to an execution. */
function modelFacts(session: IdentifiedSession, transcript: NativeShareTranscript, events: NativeWorkbenchEvent[], runs: Run[]): Record<string, ShareModelInfo> {
  const backend = session.backendId;
  const byId = new Map(runs.map(run => [run.id, run]));
  const byReceipt = new Map<string, Run[]>(), byCommand = new Map<string, Run[]>(), byTurn = new Map<string, Run[]>();
  const index = (map: Map<string, Run[]>, key: string | undefined, run: Run) => { if (key) map.set(key, [...(map.get(key) ?? []), run]); };
  for (const run of runs) {
    index(byReceipt, run.native?.nativeMessageId, run);
    index(byCommand, run.commandId, run);
    index(byTurn, run.native?.nativeTurnId, run);
  }
  const owner = (run: Run): Run | undefined => run.native?.ownerRunId ? byId.get(run.native.ownerRunId) : run.native?.intent === 'steer' ? undefined : run;
  const unique = (values: Run[]): Run | undefined => {
    const owners = new Map(values.flatMap(run => { const execution = owner(run); return execution ? [[execution.id, execution] as const] : []; }));
    return owners.size === 1 ? [...owners.values()][0] : undefined;
  };
  const { assignments } = transcriptTurns(transcript.events);
  const ambiguousTurns = new Set(transcript.ambiguousModelTurns);
  const receipts = new Map<string, Run[]>();
  for (const event of transcript.events) {
    if (event.type !== 'user_message_chunk') continue;
    const turn = assignments.get(event);
    if (!turn) continue;
    const ids = new Set([event.nativeId, ...(event.nativeAliases ?? [])]);
    let matches = [...ids].flatMap(id => byReceipt.get(id) ?? []);
    if (!matches.length && typeof event.data.commandId === 'string') matches = byCommand.get(event.data.commandId) ?? [];
    if (!matches.length && event.runId && byId.has(event.runId)) matches = [byId.get(event.runId)!];
    if (matches.length) receipts.set(turn, [...(receipts.get(turn) ?? []), ...matches]);
  }
  const result: Record<string, ShareModelInfo> = Object.create(null);
  for (const event of events) {
    if (event.type !== 'agent_message_chunk') continue;
    const turn = assignments.get(event);
    const nativeMatches = event.nativeTurnId ? byTurn.get(event.nativeTurnId) ?? [] : [];
    const run = nativeMatches.length ? unique(nativeMatches) : turn && receipts.has(turn) ? unique(receipts.get(turn)!) : event.runId && byId.has(event.runId) ? owner(byId.get(event.runId)!) : undefined;
    const resolved = !ambiguousTurns.has(event.nativeTurnId ?? '') ? shareModelInfo(run?.native?.resolvedConfig?.model, backend, 'resolved') : undefined;
    const message = Object.hasOwn(transcript.modelInfo ?? {}, event.nativeId) ? transcript.modelInfo![event.nativeId] : undefined;
    const turnFact = event.nativeTurnId && Object.hasOwn(transcript.turnModels ?? {}, event.nativeTurnId) ? transcript.turnModels![event.nativeTurnId] : undefined;
    const historical = message ? { ...(turnFact?.model === message.model ? turnFact : {}), ...message } : turnFact;
    const history = historical ? shareModelInfo(historical.model, backend, 'history', { ...historical }) : undefined;
    if (history) {
      // Parameters may only fill gaps when they describe this same execution model.
      const base = resolved?.model === history.model ? resolved : undefined;
      result[event.nativeId] = { ...base, ...history };
    } else if (resolved) result[event.nativeId] = resolved;
  }
  return result;
}

export async function captureShareSnapshot(deps: CaptureDependencies, sessionId: string, options: NativeShareReadOptions = {}): Promise<ShareSnapshot> {
  const session = deps.store.getSession(sessionId);
  const selection = options.selection ?? { mode: 'all' };
  if (selection.mode === 'selected' && selection.nativeChatId !== undefined && selection.nativeChatId !== session.nativeSessionId) throw new AppError('SHARE_HISTORY_CHANGED', 'The conversation history changed; generate the preview again', 409);
  const runs = deps.store.listRuns(sessionId).filter(run => run.state !== 'queued'
    && (!run.native || !['queued', 'preparing'].includes(run.native.delivery))
    && (!run.native?.nativeSessionId || run.native.nativeSessionId === session.nativeSessionId)
    && (!run.native?.backendId || run.native.backendId === session.backendId));
  const byReceipt = new Map(runs.flatMap(run => run.native?.nativeMessageId ? [[run.native.nativeMessageId, run] as const] : []));
  const byCommand = new Map(runs.map(run => [run.commandId, run]));
  const capturedAt = new Date().toISOString();
  const transcript = await readTranscript(deps, sessionId, { ...options, messagesOnly: true });
  options.signal?.throwIfAborted();
  const current = deps.store.getSession(sessionId);
  if (current.nativeSessionId !== session.nativeSessionId || current.backendId !== session.backendId) throw new AppError('SHARE_HISTORY_CHANGED', 'The conversation history changed; generate the preview again', 409);
  let events = readingMessages(transcript.events);
  let scope: ShareSnapshot['scope'];
  if (selection.mode !== 'all') {
    const grouped = transcriptTurns(events);
    const selected = new Set(transcript.selectedTurnIds ?? (selection.mode === 'recent' ? grouped.turns.slice(-selection.count).map(turn => turn.id) : selection.turnIds));
    scope = { mode: selection.mode, turnCount: selected.size };
    if (!transcript.selectedTurnIds && selection.mode === 'selected' && selection.turnIds.some(id => !grouped.turns.some(turn => turn.id === id))) throw new AppError('SHARE_SELECTION_CHANGED', 'The selected turns are no longer available; select them again', 409);
    events = events.filter(event => selected.has(grouped.assignments.get(event) ?? ''));
  }
  const modelInfo = modelFacts(session, transcript, events, runs);
  return {
    format: 'riffet-share-v1', title: session.displayTitle ?? session.title, capturedAt, backendId: session.backendId, ...(scope ? { scope } : {}),
    ...(session.nativeSessionId ? { nativeChatId: session.nativeSessionId } : {}),
    ...(Object.keys(modelInfo).length ? { modelInfo } : {}),
    events: events.map(event => {
      const run = event.type === 'user_message_chunk' ? [event.nativeId, ...(event.nativeAliases ?? [])].map(id => byReceipt.get(id)).find(Boolean) ?? (typeof event.data.commandId === 'string' ? byCommand.get(event.data.commandId) : undefined) : undefined;
      return readingEvent(event, run);
    }),
    runs: [], subagents: [], jobs: [],
    warnings: [...new Set((transcript.warnings ?? []).filter(warning => !/子 Agent|后台任务/.test(warning)))], resources: {}, blobs: {}, diagramPages: {},
  };
}
