import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AuxiliaryModelRef, DiscussionCreateRequest, DiscussionSource, MarkAnchor, MarkQuote, NativeWorkbenchEvent, Run, Session, WorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { buildTimeline } from '../../../../packages/timeline/src/buildTimeline.js';
import { projectEvents } from '../../../../packages/timeline/src/projectEvents.js';
import { gatewayEfforts, gatewayModelId, gatewayProtocol } from '../auxiliary/gateway.js';
import { chatModelRef, chatModelValue } from '../backends/chat/index.js';
import { nativeModelEffort, parseNativeModelSelection } from '../backends/shared/model-selection.js';
import { profileChatModels, profileModelEndpoint } from '../auxiliary/models.js';
import { AppError, requireString } from '../errors.js';
import { sessionDeleted } from '../store.js';
import type { IdentifiedSession } from '../session-identity.js';
import { hasTurnEnded, servingKey } from '../journal/ingest.js';
import { DRAFT_KIND } from '../journal/journal.js';
import { estimateTokens } from '../metrics/tokens.js';
import { clientSupportsFeature, requireSessionVisibleToClient } from '../native/client-features.js';
import { resolveNativeSessionInput } from '../native/session-input.js';
import type { RouteDeps } from '../routes/deps.js';
import { quickChatProject } from './quick-chat.js';

/** Parent history and the quotation share this fixed budget; the discussion keeps the remainder. */
const SOURCE_TOKENS = 18_000;
const SELECTION_TOKENS = 8_000;
// Same comparison as saved highlights: Markdown list numbers and link destinations are not selected text.
const comparable = (text: string) => text.replace(/^[ \t>]*\d+[.)][ \t]+/gm, '').replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, ']').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** A side chat is pinned to its parent's provider; unrelated quick-chat defaults never apply. */
async function inheritedModel(deps: RouteDeps, parent: IdentifiedSession, requested?: string, validate = true): Promise<string> {
  const unavailable = () => new AppError('DISCUSSION_PROVIDER_UNAVAILABLE', "This conversation's model provider is unavailable for side chats", 409);
  const backendId = parent.backendId;
  // A chat with no explicit choice may already have a dispatched choice. Keep that routing rather
  // than consulting whichever other conversation happened to be used most recently.
  const runs = deps.store.listRuns(parent.id);
  const previousModel = runs.findLast(run => run.native?.resolvedConfig?.model)?.native?.resolvedConfig?.model
    ?? runs.findLast(run => run.native?.config.model)?.native?.config.model;
  let ref: AuxiliaryModelRef | undefined;
  let selection: ReturnType<typeof parseNativeModelSelection>;
  if (backendId === 'chat') {
    const value = parent.model ?? previousModel;
    ref = value === undefined ? undefined : chatModelRef(value);
    selection = parseNativeModelSelection(value);
  } else {
    if (!gatewayProtocol(backendId)) throw unavailable();
    const profile = deps.nativeBackends.validateProfile(backendId, parent.backendProfileId);
    const defaults = deps.settings.getSettings().nativeBackendDefaults?.[backendId];
    const defaultModel = typeof profile.config.defaultModel === 'string' ? profile.config.defaultModel : undefined;
    const appliesDefaults = defaults?.profileId ? defaults.profileId === profile.id : profile.isDefault;
    const value = parent.model ?? previousModel ?? (appliesDefaults ? defaults?.model : undefined) ?? defaultModel;
    selection = parseNativeModelSelection(value);
    const model = gatewayModelId(backendId, selection.model);
    if (!model) throw unavailable();
    ref = { backendId, profileId: profile.id, model };
  }
  if (!ref) throw unavailable();
  const inheritedProfileId = ref.profileId;
  const profile = deps.nativeBackends.validateProfile(ref.backendId, inheritedProfileId);
  if (requested !== undefined) {
    const requestedRef = chatModelRef(requested);
    if (!requestedRef || requestedRef.backendId !== ref.backendId || requestedRef.profileId !== ref.profileId) throw unavailable();
    ref = requestedRef;
    selection = parseNativeModelSelection(requested);
  }
  if (validate) {
    try { await profileModelEndpoint(ref, profile); } catch { throw unavailable(); }
    // A native short alias is accepted only when the same provider explicitly lists it.
    if (ref.backendId === 'claude' && ['default', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'best'].includes(ref.model.toLowerCase())) {
      const catalog = await profileChatModels(ref, profile).catch(() => []);
      if (!catalog.some(model => model.value === chatModelValue(ref!))) throw unavailable();
    }
  }
  const effort = nativeModelEffort(selection);
  const efforts = gatewayEfforts(gatewayProtocol(ref.backendId)!);
  if (effort && effort !== 'default' && !efforts.includes(effort as typeof efforts[number])) throw unavailable();
  const params = [
    ...(effort && effort !== 'default' ? [`effort=${effort}`] : []),
    ...(selection.params.fast === 'true' && gatewayProtocol(ref.backendId) === 'responses' ? ['fast=true'] : []),
  ];
  return `${chatModelValue(ref)}${params.length ? `[${params.join(',')}]` : ''}`;
}

interface SourceMessage {
  id: string; role: 'user' | 'assistant'; text: string;
  aliases: string[]; runId?: string; nativeTurnId?: string;
}

function sourceOf(body: Partial<DiscussionCreateRequest>): DiscussionSource {
  const rawAnchor = body.anchor as Partial<MarkAnchor> | undefined;
  const rawQuote = body.quote as Partial<MarkQuote> | undefined;
  if (!rawAnchor || typeof rawAnchor !== 'object' || !rawQuote || typeof rawQuote !== 'object') throw new AppError('INVALID_INPUT', 'anchor and quote are required');
  const anchor: MarkAnchor = { messageId: requireString(rawAnchor.messageId, 'anchor.messageId', 1000) };
  if (rawAnchor.aliases !== undefined) {
    if (!Array.isArray(rawAnchor.aliases) || rawAnchor.aliases.length > 20 || rawAnchor.aliases.some(alias => typeof alias !== 'string' || !alias || alias.length > 500)) throw new AppError('INVALID_INPUT', 'anchor.aliases must list at most 20 short strings');
    anchor.aliases = [...new Set(rawAnchor.aliases)];
  }
  for (const key of ['runId', 'nativeTurnId', 'generation'] as const) if (rawAnchor[key] !== undefined) anchor[key] = requireString(rawAnchor[key], `anchor.${key}`, 200);
  if (rawAnchor.sequence !== undefined) {
    if (!Number.isSafeInteger(rawAnchor.sequence) || rawAnchor.sequence < 0) throw new AppError('INVALID_INPUT', 'anchor.sequence must be a non-negative integer');
    anchor.sequence = rawAnchor.sequence;
  }
  const exact = requireString(rawQuote.exact, 'quote.exact', 64_000);
  if (estimateTokens(exact) > SELECTION_TOKENS) throw new AppError('DISCUSSION_SELECTION_TOO_LARGE', 'Choose a smaller passage');
  if (!comparable(exact)) throw new AppError('INVALID_CONTEXT', 'Choose a passage with readable text');
  if (typeof rawQuote.prefix !== 'string' || typeof rawQuote.suffix !== 'string' || rawQuote.prefix.length > 1000 || rawQuote.suffix.length > 1000) throw new AppError('INVALID_INPUT', 'quote.prefix and quote.suffix must be short strings');
  const quote: MarkQuote = { exact, prefix: rawQuote.prefix, suffix: rawQuote.suffix };
  for (const key of ['start', 'end'] as const) if (rawQuote[key] !== undefined) {
    if (!Number.isSafeInteger(rawQuote[key]) || rawQuote[key]! < 0) throw new AppError('INVALID_INPUT', `quote.${key} must be a non-negative integer`);
    quote[key] = rawQuote[key];
  }
  if (quote.start !== undefined && quote.end !== undefined && quote.end < quote.start) throw new AppError('INVALID_INPUT', 'quote.end precedes quote.start');
  return { anchor, quote };
}

function messagesOf(events: readonly WorkbenchEvent[], runs: Run[]): SourceMessage[] {
  // Use the same grouping as the visible transcript, including answers split across provider ids.
  return buildTimeline(projectEvents([...events]), runs).flatMap(item => {
    if (item.kind !== 'user' && item.kind !== 'assistant') return [];
    const sources = [item.event, ...item.event.sourceEvents] as NativeWorkbenchEvent[];
    const native = sources.find(event => event.nativeId) ?? sources[0]!;
    const runId = native.runId ?? (item.kind === 'user' ? item.run?.id : undefined);
    return [{ id: native.nativeId || String(native.sequence), role: item.kind as 'user' | 'assistant', text: item.text,
      aliases: [...new Set(sources.flatMap(event => [event.nativeId, ...(event.nativeAliases ?? [])]).filter(Boolean))],
      ...(runId ? { runId } : {}), ...(native.nativeTurnId ? { nativeTurnId: native.nativeTurnId } : {}) }];
  });
}

/** Clips older context, never the selected passage; the quotation is also carried separately. */
function fit(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low)}\n[Earlier context clipped]`;
}

async function capture(deps: RouteDeps, parent: Session, source: DiscussionSource): Promise<string> {
  let events: WorkbenchEvent[] = [];
  try { events = await deps.nativeBackends.indexableTranscript(parent.id); } catch { /* a journal can outlive its provider profile */ }
  const runs = deps.store.listRuns(parent.id);
  let messages = messagesOf(events, runs);
  const quote = comparable(source.quote.exact);
  const find = (items: SourceMessage[]) => items.findIndex((message, index) => {
    if (message.role !== 'assistant' || !(message.id === source.anchor.messageId || message.aliases.includes(source.anchor.messageId)
      || source.anchor.runId && message.runId === source.anchor.runId || source.anchor.nativeTurnId && message.nativeTurnId === source.anchor.nativeTurnId
      || source.anchor.aliases?.some(alias => message.aliases.includes(alias) || message.id.split(':').includes(alias)))) return false;
    let end = index + 1;
    while (end < items.length && items[end]!.role === 'assistant') end += 1;
    return comparable(items.slice(index, end).map(item => item.text).join('')).includes(quote);
  });
  let selected = find(messages);
  if (selected < 0) {
    const { key } = servingKey(deps.store.journal, parent.id, 'main');
    // The transcript shown by SSE includes unfinished drafts, while indexing reads committed events.
    // Read only each entity's current version; ended turns must not resurrect their discarded drafts.
    events = deps.store.journal.tail(key, Number.MAX_SAFE_INTEGER, true)
      .filter(entity => entity.kind !== DRAFT_KIND || !entity.turnId || !hasTurnEnded(deps.store.journal, key, entity.turnId))
      .map(entity => ({ ...(entity.payload as Omit<NativeWorkbenchEvent, 'sessionId' | 'sequence'>), sessionId: parent.id, sequence: entity.identity }));
    messages = messagesOf(events, runs);
    selected = find(messages);
  }
  if (selected < 0) {
    // A whole rendered answer may join several provider messages; its run is then the stable identity.
    const matches = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'assistant'
      && comparable(message.text).includes(quote) && ((source.anchor.runId && message.runId === source.anchor.runId) || (source.anchor.nativeTurnId && message.nativeTurnId === source.anchor.nativeTurnId)));
    if (matches.length === 1) selected = matches[0]!.index;
  }
  if (selected < 0) throw new AppError('DISCUSSION_SOURCE_UNAVAILABLE', 'The selected answer is no longer available; select its text again');
  // Include every assistant segment in the selected answer, up to the following human message.
  let end = selected + 1;
  while (end < messages.length && messages[end]!.role === 'assistant') end += 1;
  const available = SOURCE_TOKENS - estimateTokens(source.quote.exact) - 1000;
  let question = selected - 1;
  while (question >= 0 && messages[question]!.role !== 'user') question -= 1;
  const nearby = messages.slice(Math.max(0, question), end);
  const questionBudget = Math.min(4000, Math.ceil(available / 3));
  const questionText = question >= 0 ? fit(messages[question]!.text, questionBudget) : undefined;
  const answerBudget = available - (questionText ? estimateTokens(questionText) + 20 : 0);
  const answer = fit(nearby.filter(message => message.role === 'assistant').map(message => message.text).join('\n\n'), answerBudget);
  const kept: Array<{ role: SourceMessage['role']; text: string }> = [
    ...(questionText ? [{ role: 'user' as const, text: questionText }] : []), { role: 'assistant', text: answer },
  ];
  let remaining = available - kept.reduce((sum, message) => sum + estimateTokens(message.text) + 20, 0);
  for (let index = question - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index]!;
    const text = fit(message.text, remaining);
    kept.unshift({ role: message.role, text });
    remaining -= estimateTokens(text) + 20;
  }
  return JSON.stringify({ sessionTitle: parent.title, messages: kept });
}

/** A durable child session and its immutable source are committed with the first question. */
export function registerDiscussionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const pending = new Map<string, Promise<unknown>>();
  app.get<{ Params: { id: string } }>('/api/sessions/:id/discussions', async request => {
    if (!clientSupportsFeature(request.headers, 'quick-chat')) throw new AppError('FEATURE_REQUIRED', 'Update the client to open a discussion', 409);
    const parent = deps.store.getSession(request.params.id);
    requireSessionVisibleToClient(request.headers, parent, id => deps.store.getProject(id));
    return deps.store.listSessions().filter(session => session.origin?.kind === 'discussion' && session.origin.sessionId === parent.id);
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/discussions/models', async request => {
    if (!clientSupportsFeature(request.headers, 'quick-chat')) throw new AppError('FEATURE_REQUIRED', 'Update the client to open a side chat', 409);
    const session = deps.store.getSession(request.params.id);
    requireSessionVisibleToClient(request.headers, session, id => deps.store.getProject(id));
    const model = await inheritedModel(deps, session, undefined, false);
    const ref = chatModelRef(model)!;
    const profile = deps.nativeBackends.validateProfile(ref.backendId, ref.profileId);
    try {
      const models = await profileChatModels(ref, profile, { effort: ref.effort });
      return { model, models, providerName: profile.name };
    } catch { throw new AppError('DISCUSSION_PROVIDER_UNAVAILABLE', 'The model provider is unavailable for side chats', 409); }
  });
  app.post<{ Params: { id: string }; Body: DiscussionCreateRequest }>('/api/sessions/:id/discussions', async (request, reply) => {
    if (!clientSupportsFeature(request.headers, 'quick-chat')) throw new AppError('FEATURE_REQUIRED', 'Update the client to open a discussion', 409);
    const body = request.body ?? {};
    const source = sourceOf(body);
    const clientSessionId = requireString(body.clientSessionId, 'clientSessionId', 100);
    const commandId = requireString(body.commandId, 'commandId', 100);
    const text = requireString(body.text, 'text').trim();
    const model = body.model === undefined ? undefined : requireString(body.model, 'model', 200);
    const fingerprint = createHash('sha256').update(JSON.stringify({ parentId: request.params.id, source, commandId, text, model })).digest('hex');
    const previous = pending.get(clientSessionId) ?? Promise.resolve();
    const operation = deps.sessionCommands.submit(deps.store, clientSessionId, commandId, { operation: 'discussion', parentId: request.params.id, body }, () => previous.catch(() => undefined).then(async () => {
      const parent = deps.store.getSession(request.params.id);
      requireSessionVisibleToClient(request.headers, parent, id => deps.store.getProject(id));
      // A retried creation of a deleted side chat is refused before anything is captured.
      if (deps.store.isSessionDeleted(clientSessionId)) throw sessionDeleted(clientSessionId);
      const parentDeleting = () => { if (deps.sessionCommands.isDeleting(parent.id)) throw new AppError('SESSION_DELETING', 'Conversation is being deleted', 409); };
      parentDeleting();
      if (parent.kind !== 'native' || parent.origin?.kind === 'discussion') throw new AppError('INVALID_CONTEXT', 'Select a passage in the main conversation');
      const existing = deps.store.listSessions().find(session => session.id === clientSessionId);
      if (existing) {
        const run = deps.store.findRunByCommand(existing.id, commandId);
        if (existing.origin?.kind !== 'discussion' || existing.origin.sessionId !== parent.id || existing.origin.discussion?.requestFingerprint !== fingerprint || !run) throw new AppError('SESSION_ID_CONFLICT', 'This clientSessionId was already used for another discussion', 409);
        deps.dispatch.kick();
        return { session: existing, run };
      }
      const discussionModel = await inheritedModel(deps, parent, model);
      const project = quickChatProject(deps.store, deps.stateDir);
      const input = await resolveNativeSessionInput(deps, { projectId: project.id, backendId: 'chat', mode: 'agent', model: discussionModel }, request.headers);
      const context = await capture(deps, parent, source);
      const result = deps.store.transaction(() => {
        // The parent may have been deleted, or its deletion begun, while its passage was captured.
        deps.store.getSession(parent.id);
        parentDeleting();
        const contextRef = deps.store.journal.putSessionBlob(clientSessionId, Buffer.from(context), 'application/vnd.riffet.discussion+json');
        return deps.store.createNativeSubmission(clientSessionId, { ...input, origin: { kind: 'discussion', sessionId: parent.id,
          ...(source.anchor.runId ? { runId: source.anchor.runId } : {}), discussion: { ...source, capturedAt: new Date().toISOString(), contextRef, requestFingerprint: fingerprint } } },
        commandId, { text, attachmentIds: [], context: [] });
      });
      deps.dispatch.kick();
      return result;
    }));
    pending.set(clientSessionId, operation);
    try { const result = await operation; reply.code(202); return result; }
    finally { if (pending.get(clientSessionId) === operation) pending.delete(clientSessionId); }
  });
}
