import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { parseAsyncQuestionReplies } from './interactions.js';
import type { CodexPendingInteraction, RpcItem } from './types.js';
import { isTaggedMessageId } from './message-tag.js';
import { asArray, asRecord, firstLine, safeJson, str } from './util.js';

interface Question {
  id?: string;
  header?: string;
  question: string;
  options: string[];
  isSecret?: boolean;
}

interface QuestionReply {
  tool: string;
  callId: string;
  index: number;
  question: string;
  answers: string[];
  isSecret?: boolean;
}

const SECRET_ANSWER = '[REDACTED]';

/** Only the provider's complete, structured reply envelope is an interaction receipt. */
export function codexQuestionReply(text: string): QuestionReply[] | undefined {
  const body = parseAsyncQuestionReplies(text, true);
  if (!body) return undefined;
  const replies: QuestionReply[] = [];
  for (const value of body) {
    const row = asRecord(value);
    const identity: unknown = typeof row?.questionItemId === 'string' ? safeJson(row.questionItemId) : undefined;
    if (!Array.isArray(identity) || identity.length !== 3 || !questionTools.has(identity[0]) || !str(identity[1])
      || !Number.isSafeInteger(identity[2]) || identity[2] < 0 || typeof row?.question !== 'string') return undefined;
    const answers = typeof row?.answer === 'string' ? [row.answer] : row?.answer;
    if (!Array.isArray(answers) || !answers.every(answer => typeof answer === 'string')) return undefined;
    replies.push({ tool: identity[0], callId: identity[1], index: identity[2], question: row!.question as string,
      answers: answers.filter(answer => answer.trim()), ...(row?.isSecret === true ? { isSecret: true } : {}) });
  }
  return replies;
}

type EventFactory = (id: string, type: string, data: Record<string, unknown>) => NativeWorkbenchEvent;

interface QuestionCall {
  runId?: string;
  questions: Map<number, Question>;
  /** Question ids retain their classification when a later copy reorders or omits a question. */
  metadata: Map<string, Question>;
  answers: Map<number, string[]>;
}

const questionTools = new Set(['request_user_input', 'request_user_input_async', 'request_user_input_asynch']);

export function isCodexQuestionTool(item: RpcItem): boolean {
  const name = str(item.tool) ?? str(item.name);
  return Boolean(name && questionTools.has(name.split('.').at(-1)!))
    || (item.type === 'agentMessage' && Array.isArray(item.questions) && item.questions.length > 0);
}

function questionsOf(value: unknown): Question[] {
  return asArray<unknown>(value).flatMap(value => {
    const row = asRecord(value);
    // The published question/title is a string, not a nonempty label. In particular, an empty
    // secret question still identifies its native question id and index for all later answers.
    const question = typeof row?.question === 'string' ? row.question : typeof row?.title === 'string' ? row.title : undefined;
    if (question === undefined) return [];
    const options = asArray<unknown>(row?.options).flatMap(option => {
      const label = str(option) ?? str(asRecord(option)?.label);
      return label ? [label] : [];
    });
    return [{ question, options: row?.isSecret === true ? [] : options, ...(row?.isSecret === true ? { isSecret: true } : {}),
      ...(str(row?.id) ? { id: str(row?.id) } : {}), ...(str(row?.header) ? { header: str(row?.header) } : {}) }];
  });
}

/**
 * Shared by live items and ordered history, including replies delivered in a later native turn.
 * Secret redaction requires the original question metadata (or explicit reply metadata) for the
 * same native call id. Output-only history and unrelated native prose do not identify secrets.
 */
export class CodexQuestionHistory {
  private readonly calls = new Map<string, QuestionCall>();

  project(item: RpcItem, threadId: string, base: string, event: EventFactory): NativeWorkbenchEvent[] | undefined {
    if (item.type === 'userMessage') {
      // A tagged workbench message is user-authored even if it quotes a protocol envelope.
      if (item.clientId || isTaggedMessageId(item.id)) return undefined;
      // Official UserInput permits text (with text_elements), image/localImage and skill/mention
      // parts together. Attachments cannot make an otherwise complete native reply public.
      const parts = asArray<Record<string, unknown>>(item.content);
      const texts = parts.filter(part => part.type === 'text').map(part => str(part.text) ?? '');
      const text = texts.join('');
      const complete = codexQuestionReply(text);
      const replies: QuestionReply[] = [];
      const ordinary: string[] = [];
      for (const body of complete ? [text] : texts) {
        const parsed = complete ?? codexQuestionReply(body);
        if (!parsed) { ordinary.push(body); continue; }
        replies.push(...parsed);
        // The shared parser recognizes the IDE wrapper only when My request is exactly a reply.
        // Retain its non-answer context, and any independent ordinary text parts, as user prose.
        const marker = '\n## My request for Codex:\n';
        const prefix = body.trim().startsWith('# Context from my IDE setup:\n')
          ? body.slice(0, body.lastIndexOf(marker) + marker.length) : '';
        if (prefix.trim()) ordinary.push(prefix);
      }
      if (!replies.length) return undefined;
      const grouped = new Map<string, QuestionReply[]>();
      for (const reply of replies) grouped.set(reply.callId, [...(grouped.get(reply.callId) ?? []), reply]);
      // One native message can answer multiple calls. If any answer is identifiable as secret,
      // omit that entire item's raw copy from every event, not only the secret call's event.
      const secretReply = replies.some(reply => reply.isSecret || this.call(threadId, reply.callId).questions.get(reply.index)?.isSecret);
      const attachments = parts.flatMap(part => part.type === 'localImage' || part.type === 'image'
        ? [{ type: 'image', path: str(part.path) ?? str(part.url) }]
        : part.type === 'skill' || part.type === 'mention'
          ? [{ type: 'file', name: `${part.type}: ${str(part.name) ?? ''}`, path: str(part.path) }] : []);
      const ordinaryText = ordinary.join('');
      const events = [...(ordinaryText.trim() || attachments.length ? [event(`${base}:user`, 'user_message_chunk', {
        content: { type: 'text', text: ordinaryText }, ...(attachments.length ? { attachments } : {}),
      })] : []), ...[...grouped].map(([callId, replies]) => {
        const call = this.call(threadId, callId);
        for (const reply of replies) {
          const original = call.questions.get(reply.index);
          const secret = original?.isSecret || reply.isSecret;
          call.questions.set(reply.index, { ...original, question: secret && original ? original.question : reply.question,
            options: secret ? [] : original?.options ?? [], ...(secret ? { isSecret: true } : {}) });
          call.answers.set(reply.index, secret ? [SECRET_ANSWER] : reply.answers);
        }
        const result = event(`${base}:question:${encodeURIComponent(callId)}`, 'tool_call_update', this.data(callId, call, replies[0]!.tool));
        call.runId ??= result.runId;
        return { ...result, ...(call.runId ? { runId: call.runId } : {}) };
      })];
      return secretReply ? events.map(row => ({ ...row, raw: undefined })) : events;
    }

    const name = str(item.tool) ?? str(item.name);
    const args = typeof item.arguments === 'string' ? asRecord(safeJson(item.arguments)) : asRecord(item.arguments);
    const outputValue = item.output ?? item.contentItems;
    const outputText = typeof outputValue === 'string' ? outputValue : asArray<unknown>(outputValue).flatMap(value => {
      const part = asRecord(value);
      return part?.type === 'input_text' || part?.type === 'inputText' || part?.type === 'text' ? [str(part.text) ?? ''] : [];
    }).join('');
    const output = outputText ? asRecord(safeJson(outputText)) : asRecord(outputValue);
    const questions = questionsOf(args?.questions ?? item.questions ?? output?.questions);
    const attached = item.type === 'agentMessage' && questions.length > 0;
    if (item.type === 'agentMessage' && !attached) return undefined;
    if (!attached && !isCodexQuestionTool(item)) return undefined;
    const callId = item.id;
    if (!callId) return undefined;
    const call = this.call(threadId, callId);
    this.rememberQuestions(call, questions);
    const outputAnswers = asRecord(output?.answers);
    // A later metadata copy can omit a question id; its native output still uses that identity.
    for (const id of Object.keys(outputAnswers ?? {})) {
      const known = call.metadata.get(id);
      if (known && ![...call.questions.values()].some(question => question.id === id)) {
        const index = Math.max(-1, ...call.questions.keys()) + 1;
        call.questions.set(index, known);
      }
    }
    if (outputAnswers && !call.questions.size) {
      for (const [id, value] of Object.entries(outputAnswers)) {
        const answers = asRecord(value)?.answers;
        if (!Array.isArray(answers) || !answers.every(answer => typeof answer === 'string')) continue;
        const index = call.questions.size;
        call.questions.set(index, { id, question: `问题 ${index + 1}`, options: [] });
      }
    }
    for (const [index, question] of call.questions) {
      const answers = asRecord(outputAnswers?.[question.id ?? String(index)])?.answers;
      if (Array.isArray(answers) && answers.every(answer => typeof answer === 'string')) {
        call.answers.set(index, question.isSecret ? [SECRET_ANSWER] : answers);
      }
    }
    const secret = [...call.questions.values()].some(question => question.isSecret);
    const projected = event(`${base}:call`, 'tool_call', this.data(callId, call, name ?? 'request_user_input_async'));
    if (!call.answers.size && item.type === 'functionCallOutput' && name?.split('.').at(-1) === 'request_user_input' && outputText) {
      projected.data = { ...projected.data, status: 'completed', title: '提问结果', content: secret ? [] : [{ type: 'markdown', text: outputText }] };
    }
    if (!call.answers.size && (item.status === 'failed' || asRecord(item.status)?.type === 'failed' || item.success === false)) {
      projected.data = { ...projected.data, status: 'failed', title: '提问失败', ...(!secret && item.error ? { error: item.error } : {}) };
    }
    call.runId = projected.runId;
    // An attached question may share a message with ordinary assistant prose.
    const text = attached ? str(item.text) : undefined;
    const events = [...(text ? [event(`${base}:assistant`, 'agent_message_chunk', { content: { type: 'text', text } })] : []), projected];
    return secret ? events.map(row => ({ ...row, raw: undefined })) : events;
  }

  /** Remember native request metadata even when its thread has no question item in history. */
  request(params: Record<string, unknown>, threadId = str(params.threadId)): RpcItem | undefined {
    const id = str(params.itemId);
    if (!id) return undefined;
    if (threadId) this.rememberQuestions(this.call(threadId, id), questionsOf(params.questions));
    return { type: 'dynamicToolCall', id, tool: 'request_user_input', arguments: { questions: params.questions } };
  }

  /** Metadata-only copies for an independent transcript reader; never export answer/run state. */
  requests(threadId: string): RpcItem[] {
    const prefix = `${threadId}\u0000`;
    return [...this.calls].flatMap(([key, call]) => key.startsWith(prefix) && call.questions.size ? [{
      type: 'dynamicToolCall', id: key.slice(prefix.length), tool: 'request_user_input',
      arguments: { questions: [...[...call.questions].sort(([left], [right]) => left - right).map(([, question]) => question),
        ...[...call.metadata.values()].filter(known => ![...call.questions.values()].some(question => question.id === known.id)),
      ].map(question => ({ ...question, options: [...question.options] })) },
    }] : []);
  }

  answered(pending: CodexPendingInteraction): RpcItem | undefined {
    if (pending.request.method !== 'item/tool/requestUserInput' || !pending.candidateSent) return undefined;
    const params = pending.request.params;
    const callId = str(params.itemId);
    if (!callId) return undefined;
    const replies = questionsOf(params.questions).flatMap((question, index) => {
      if (question.isSecret) return [];
      const answers = pending.answers[question.id ?? String(index)]?.answers;
      return answers ? [{ question: question.question, answer: answers,
        questionItemId: JSON.stringify(['request_user_input', callId, index]) }] : [];
    });
    if (!replies.length) return undefined;
    return { type: 'userMessage', id: `${callId}:answered`, content: [{ type: 'text',
      text: `<send_user_message_question_reply>${JSON.stringify(replies)}</send_user_message_question_reply>` }] };
  }

  private rememberQuestions(call: QuestionCall, questions: Question[]): void {
    const previous = new Map(call.questions);
    questions.forEach((question, index) => {
      const original = question.id ? call.metadata.get(question.id) : previous.get(index);
      // Secret identity is the native question id when supplied, not its display order or label.
      const secret = question.isSecret || original?.isSecret;
      const known = { ...question, ...(secret ? { isSecret: true, options: [] } : {}) };
      if (question.id) call.metadata.set(question.id, known);
      call.questions.set(index, known);
      if (previous.get(index)?.id !== question.id) call.answers.delete(index);
      if (secret && call.answers.has(index)) call.answers.set(index, [SECRET_ANSWER]);
    });
  }

  private call(threadId: string, callId: string): QuestionCall {
    const key = `${threadId}\u0000${callId}`;
    const existing = this.calls.get(key);
    if (existing) return existing;
    const call: QuestionCall = { questions: new Map(), metadata: new Map(), answers: new Map() };
    this.calls.set(key, call);
    if (this.calls.size > 512) this.calls.delete(this.calls.keys().next().value!);
    return call;
  }

  private data(callId: string, call: QuestionCall, name: string): Record<string, unknown> {
    const questions = [...call.questions].sort(([left], [right]) => left - right);
    const first = questions[0]?.[1];
    const label = first?.header ?? (first ? firstLine(first.question).slice(0, 80) : undefined);
    const complete = call.answers.size > 0 && call.answers.size >= call.questions.size;
    const state = complete ? '已回答' : call.answers.size ? `已回答 ${call.answers.size}/${call.questions.size}` : '提问';
    return {
      toolCallId: callId, toolName: name, kind: 'question',
      title: `${state}${label ? ` · ${label}` : ''}`,
      status: complete ? 'completed' : 'in_progress',
      rawInput: { questions: questions.map(([, question]) => question) },
      content: questions.flatMap(([index, question]) => call.answers.has(index) ? [{
        type: 'question_answer', question: question.question, answers: call.answers.get(index),
        ...(question.options.length ? { options: question.options } : {}),
      }] : []),
    };
  }
}
