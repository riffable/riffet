import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { NativeInteraction, NativeInteractionResponse } from '../../../../../packages/contracts/src/index.js';
import type { JsonRpcServerRequest } from '../shared/codex-app-server.js';
import { AppError } from '../../errors.js';
import type { CodexPendingInteraction, RpcQuestion } from './types.js';
import { str, asRecord, asArray, safeJson } from './util.js';

export function makePendingInteraction(request: JsonRpcServerRequest): CodexPendingInteraction | undefined {
  const params = request.params;
  const id = `codex:${String(params.threadId ?? 'thread')}:${String(request.id)}`;
  const revision = `${request.id}:0`;
  if (request.method === 'item/tool/requestUserInput') {
    const questions = asArray<RpcQuestion>(params.questions);
    if (!questions.length) return undefined;
    return { request, interaction: questionInteraction(request, questions[0]!, 0, questions.length, revision, id), currentQuestion: 0, revisionCounter: 0, answers: {}, candidateSent: false };
  }
  if (request.method === 'mcpServer/elicitation/request') {
    const mode = str(params.mode) ?? 'form';
    const form = ['form', 'openai/form', 'openaiForm'].includes(mode) ? elicitationForm(params.requestedSchema) : undefined;
    const message = [str(params.message), mode === 'url' ? str(params.url) : undefined,
      form ? 'Enter a JSON object for free-form fields.' : mode !== 'url' ? 'This schema is not supported by the web form. Answer in the native terminal.' : undefined,
    ].filter(Boolean).join('\n\n') || 'A connected Codex tool needs an answer.';
    return {
      request,
      interaction: {
        id, revision, transport: 'protocol', requestId: String(request.id), request: params,
        kind: 'question', title: str(params.serverName) ?? 'Codex asks', message,
        options: form ? elicitationOptions(form) : [], allowOther: Boolean(form), multiple: Boolean(form),
        actions: mode === 'url'
          ? [{ id: 'cancel', label: 'Cancel', tone: 'danger' }]
          : [...(form ? [{ id: 'answer', label: 'Submit', tone: 'primary' as const }] : []), { id: 'decline', label: 'Decline', tone: 'danger' }, { id: 'cancel', label: 'Cancel', tone: 'danger' }],
      },
      currentQuestion: 0, revisionCounter: 0, answers: {}, candidateSent: false,
    };
  }
  if (/Approval|requestApproval/i.test(request.method)) {
    const command = displayCommand(params.command ?? params.argv);
    const isFile = request.method.includes('fileChange') || request.method === 'applyPatchApproval';
    const isCommand = request.method === 'item/commandExecution/requestApproval';
    const decisions = isCommand ? commandApprovalChoices(request) : undefined;
    const grantRoot = str(params.grantRoot);
    const fileChanges = asRecord(params.fileChanges);
    const network = asRecord(params.networkApprovalContext);
    const message = [
      str(params.reason),
      command ? `Command: ${command}` : undefined,
      str(params.cwd) ? `Working directory: ${params.cwd}` : undefined,
      isFile && grantRoot ? `Requested session write root: ${grantRoot}` : undefined,
      isFile && fileChanges && Object.keys(fileChanges).length ? `Files to change:\n${Object.keys(fileChanges).join('\n')}` : undefined,
      network ? `Network request: ${str(network.protocol) ?? 'network'}://${str(network.host) ?? '(unspecified host)'}` : undefined,
      ...permissionSummary(params.permissions ?? params.additionalPermissions),
      decisions?.some(({ decision }) => typeof decision !== 'string' && 'acceptWithExecpolicyAmendment' in decision)
        ? 'A remembered command-prefix rule also allows matching future commands without prompting.' : undefined,
      decisions?.some(({ decision }) => typeof decision !== 'string' && 'applyNetworkPolicyAmendment' in decision)
        ? 'A remembered network rule applies to future requests for the named host.' : undefined,
    ].filter(Boolean).join('\n\n');
    return {
      request,
      interaction: {
        id, revision, transport: 'protocol', requestId: String(request.id), request: params,
        kind: 'permission',
        title: isFile ? 'Allow file changes?' : isCommand || command ? 'Allow command?' : 'Allow additional permissions?',
        message,
        options: [],
        actions: decisions ? decisions.map(commandApprovalAction) : [
          { id: 'approve', label: 'Allow', tone: 'primary' },
          { id: 'approveForSession', label: 'Allow for session' },
          { id: 'deny', label: 'Deny', tone: 'danger' },
        ],
      },
      currentQuestion: 0, revisionCounter: 0, answers: {}, candidateSent: false,
    };
  }
  return undefined;
}

/** The app-server's native decision, including the two published amendment envelopes. */
export type CommandApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: { host: string; action: 'allow' | 'deny' } } };

const commandActionIds = { accept: 'approve', acceptForSession: 'approveForSession', decline: 'deny', cancel: 'cancel' } as const;

function isCommandApprovalDecision(value: unknown): value is CommandApprovalDecision {
  if (typeof value === 'string') return Object.hasOwn(commandActionIds, value);
  const record = asRecord(value);
  if (!record || Object.keys(record).length !== 1) return false;
  const exec = asRecord(record.acceptWithExecpolicyAmendment);
  if (exec) return Object.keys(exec).length === 1 && Array.isArray(exec.execpolicy_amendment)
    && exec.execpolicy_amendment.every(part => typeof part === 'string');
  const network = asRecord(record.applyNetworkPolicyAmendment);
  const amendment = asRecord(network?.network_policy_amendment);
  return Boolean(network && Object.keys(network).length === 1 && amendment && Object.keys(amendment).length === 2
    && typeof amendment.host === 'string' && (amendment.action === 'allow' || amendment.action === 'deny'));
}

function commandApprovalChoices(request: JsonRpcServerRequest): Array<{ id: string; decision: CommandApprovalDecision }> {
  // A supplied empty or invalid list must never widen to the legacy defaults. Null means absent
  // in the published optional/nullable protocol, just as an omitted field does.
  const available = request.params.availableDecisions;
  const humanCommand = request.params.kind === 'humanCommand';
  const decisions = available == null
    ? humanCommand ? ['accept', 'decline', 'cancel'] : ['accept', 'acceptForSession', 'decline']
    : asArray<unknown>(available);
  // Managed command checkpoints require a fresh human decision for each execution, even if a
  // server includes a session grant or a remembered rule in its advertised choices.
  return decisions.flatMap((decision, index) => isCommandApprovalDecision(decision)
    && (!humanCommand || decision === 'accept' || decision === 'decline' || decision === 'cancel')
    ? [{ id: typeof decision === 'string' ? commandActionIds[decision] : `decision:${index}`, decision }] : []);
}

/** Resolve only an action actually offered by this native request, before recording or sending it. */
export function commandApprovalDecision(request: JsonRpcServerRequest, action: string): CommandApprovalDecision {
  const choice = request.method === 'item/commandExecution/requestApproval'
    ? commandApprovalChoices(request).find(choice => choice.id === action) : undefined;
  if (!choice) throw new AppError('INVALID_NATIVE_INTERACTION', 'The selected command approval is not available for this native request', 400);
  return choice.decision;
}

function commandApprovalAction({ id, decision }: { id: string; decision: CommandApprovalDecision }): NativeInteraction['actions'][number] {
  if (typeof decision === 'string') {
    switch (decision) {
      case 'accept': return { id, label: 'Allow once', tone: 'primary' };
      case 'acceptForSession': return { id, label: 'Allow for session' };
      case 'decline': return { id, label: 'Deny', tone: 'danger' };
      case 'cancel': return { id, label: 'Cancel', tone: 'danger' };
    }
  }
  if ('acceptWithExecpolicyAmendment' in decision) {
    const prefix = displayCommand(decision.acceptWithExecpolicyAmendment.execpolicy_amendment);
    return {
      id, label: `Allow and remember command prefix: ${prefix}`, tone: 'primary',
      shortLabel: 'Allow and remember',
      detail: `Matching future commands will run without prompting.\n\nCommand prefix:\n${prefix}`,
    };
  }
  const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  return {
    id, label: `Remember network ${amendment.action}: ${amendment.host}`,
    shortLabel: amendment.action === 'deny' ? 'Deny and remember' : 'Allow and remember',
    detail: `Future network requests to this host will be ${amendment.action === 'deny' ? 'denied' : 'allowed'}.\n\nHost:\n${amendment.host}`,
    ...(amendment.action === 'deny' ? { tone: 'danger' as const } : {}),
  };
}

function displayCommand(value: unknown): string {
  return str(value) ?? asArray<unknown>(value).filter((part): part is string => typeof part === 'string')
    .map(part => /^[A-Za-z0-9_./:=@%+,-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(' ');
}

function permissionSummary(value: unknown): string[] {
  const permission = asRecord(value);
  const network = asRecord(permission?.network);
  const fileSystem = asRecord(permission?.fileSystem);
  const summary: string[] = [];
  if (typeof network?.enabled === 'boolean') summary.push(`Network access: ${network.enabled ? 'enabled' : 'disabled'}`);
  for (const access of ['read', 'write'] as const) {
    const paths = asArray<unknown>(fileSystem?.[access]).filter((path): path is string => typeof path === 'string');
    if (paths.length) summary.push(`Filesystem ${access}:\n${paths.join('\n')}`);
  }
  for (const value of asArray<unknown>(fileSystem?.entries)) {
    const entry = asRecord(value), path = asRecord(entry?.path);
    const target = str(path?.path) ?? str(path?.pattern) ?? (path ? JSON.stringify(path) : '(unspecified path)');
    summary.push(`Filesystem ${str(entry?.access) ?? 'access'}${path?.type === 'glob_pattern' ? ' glob' : ''}: ${target}`);
  }
  if (typeof fileSystem?.globScanMaxDepth === 'number') summary.push(`Filesystem glob scan depth: ${fileSystem.globScanMaxDepth}`);
  return summary;
}

/**
 * One question from an `agentMessage` with `questions` (Codex's `request_user_input_async`). The turn
 * keeps running; the answer is a user message in the envelope Codex's own clients send.
 */
export interface CodexAsyncQuestion {
  itemId: string;
  turnId: string;
  index: number;
  count: number;
  title: string;
  options: string[];
  /** Codex's identity for the question: `JSON.stringify(['request_user_input_async', itemId, index])`. */
  questionItemId: string;
}

const ASYNC_REPLY_OPEN = '<send_user_message_question_reply>';
const ASYNC_REPLY_CLOSE = '</send_user_message_question_reply>';
const ASYNC_TITLE_BYTES = 512;
const ASYNC_INTERACTION_PREFIX = 'codex-async:';

export function asyncQuestionsOf(item: Record<string, unknown>, turnId: string): CodexAsyncQuestion[] {
  const itemId = str(item.id);
  if (!itemId) return [];
  const questions = asArray<Record<string, unknown>>(item.questions).filter(question => str(question?.title)?.trim());
  return questions.map((question, index) => ({
    itemId, turnId, index, count: questions.length,
    title: str(question.title)!,
    // The same bounds the TUI puts on model-authored suggestions.
    options: asArray<unknown>(question.options).filter((label): label is string => typeof label === 'string' && label.length > 0 && label.length <= 512).slice(0, 32),
    questionItemId: JSON.stringify(['request_user_input_async', itemId, index]),
  }));
}

export function isAsyncQuestionInteraction(interaction: NativeInteraction | undefined): boolean {
  return Boolean(interaction?.id.startsWith(ASYNC_INTERACTION_PREFIX));
}

export function asyncQuestionInteraction(question: CodexAsyncQuestion, label: string): NativeInteraction {
  const last = question.index + 1 >= question.count;
  return {
    id: `${ASYNC_INTERACTION_PREFIX}${question.questionItemId}`, revision: '1', transport: 'protocol', requestId: question.questionItemId,
    kind: 'question', title: `${label} asks`, message: question.title,
    options: question.options.map((option, index) => ({ id: `option:${index}`, label: option, selected: false })),
    allowOther: true,
    ...(question.count > 1 ? { questionIndex: question.index + 1, questionCount: question.count } : {}),
    actions: [{ id: 'answer', label: last ? '提交' : '下一题', tone: 'primary' }, { id: 'skip', label: '跳过' }],
  };
}

/** The typed answer, else the chosen option. */
export function asyncAnswerText(question: CodexAsyncQuestion, response: NativeInteractionResponse): string {
  const typed = response.otherText?.trim();
  if (typed) return typed;
  const selected = response.selectedIds?.[0]?.match(/^option:(\d+)$/);
  return selected ? question.options[Number(selected[1])] ?? '' : '';
}

/** The message Codex reads as the answer, byte for byte what its TUI renders (`AnsweredQuestion`). */
export function asyncQuestionReply(question: CodexAsyncQuestion, answer: string): string {
  const bytes = Buffer.from(question.title, 'utf8');
  let title = question.title;
  if (bytes.length > ASYNC_TITLE_BYTES) {
    title = bytes.subarray(0, ASYNC_TITLE_BYTES).toString('utf8').replace(/\uFFFD+$/, '');
  }
  const reply = [{ answer, question: title.replace(/[\r\n]/g, ' '), questionItemId: question.questionItemId }];
  return `${ASYNC_REPLY_OPEN}\n${JSON.stringify(reply)}\n${ASYNC_REPLY_CLOSE}`;
}

/** The replies in a user message that is exactly one reply envelope, as the TUI recognizes them. */
export function parseAsyncQuestionReplies(text: string): Array<{ questionItemId: string; question: string; answer: string }> | undefined;
export function parseAsyncQuestionReplies(text: string, multipleAnswers: true): Array<{ questionItemId: string; question: string; answer: string | string[]; isSecret?: boolean }> | undefined;
export function parseAsyncQuestionReplies(text: string, multipleAnswers = false): Array<{ questionItemId: string; question: string; answer: string | string[]; isSecret?: boolean }> | undefined {
  let body = text.trim();
  if (body.startsWith('# Context from my IDE setup:\n')) {
    const marker = '\n## My request for Codex:\n';
    const at = body.lastIndexOf(marker);
    if (at < 0) return undefined;
    body = body.slice(at + marker.length).trim();
  }
  if (!body.startsWith(ASYNC_REPLY_OPEN) || !body.endsWith(ASYNC_REPLY_CLOSE)) return undefined;
  const parsed = safeJson(body.slice(ASYNC_REPLY_OPEN.length, -ASYNC_REPLY_CLOSE.length));
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const replies = entries.map(entry => {
    const record = asRecord(entry);
    const questionItemId = str(record?.questionItemId), question = typeof record?.question === 'string' ? record.question : undefined, answer = record?.answer;
    const validAnswer = typeof answer === 'string' || (multipleAnswers && Array.isArray(answer) && answer.every(value => typeof value === 'string'));
    return questionItemId !== undefined && question !== undefined && validAnswer
      ? { questionItemId, question, answer: answer as string | string[], ...(record?.isSecret === true ? { isSecret: true } : {}) } : undefined;
  });
  return replies.length && replies.every(Boolean) ? replies as Array<{ questionItemId: string; question: string; answer: string | string[]; isSecret?: boolean }> : undefined;
}

/** How a reply reads in the transcript: the question quoted, then the answer. */
export function asyncQuestionReplyDisplay(text: string): string | undefined {
  return parseAsyncQuestionReplies(text)?.map(reply => `> ${reply.question}\n\n${reply.answer}`).join('\n\n');
}

export function questionInteraction(request: JsonRpcServerRequest, question: RpcQuestion, questionIndex: number, questionCount: number, revision: string, id = `codex:${String(request.params.threadId ?? 'thread')}:${String(request.id)}`): NativeInteraction {
  const secret = question.isSecret === true;
  const options = secret ? [] : asArray<Record<string, unknown>>(question.options).map((option, index) => ({
    id: `option:${index}`,
    label: [str(option.label), str(option.description)].filter(Boolean).join(' · '),
    selected: false,
  }));
  return {
    id, revision, transport: 'protocol', requestId: String(request.id), request: request.params,
    kind: 'question', title: str(question.header) ?? `Question ${questionIndex + 1}`,
    message: [str(question.question), secret ? 'This question requires a secret. Answer in the native terminal; this web form does not collect secret answers.' : undefined].filter(Boolean).join('\n\n'),
    options,
    multiple: !secret && question.multiSelect === true,
    allowOther: !secret && question.isOther === true,
    questionIndex: questionIndex + 1,
    questionCount,
    actions: [...(!secret ? [{ id: 'answer', label: questionIndex + 1 < questionCount ? '下一题' : '提交', tone: 'primary' as const }] : []), { id: 'cancel', label: '取消', tone: 'danger' }],
  };
}

export function answerValues(question: RpcQuestion, response: NativeInteractionResponse): string[] {
  if (response.action !== 'answer' && response.action !== 'submit' && response.action !== 'accept') return [];
  if (question.isSecret === true) throw new AppError('INVALID_NATIVE_INTERACTION', 'Secret questions must be answered in the native terminal', 400);
  const options = asArray<Record<string, unknown>>(question.options);
  const selected = response.selectedIds ?? [];
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length) {
    throw new AppError('INVALID_NATIVE_INTERACTION', 'Select each native option at most once', 400);
  }
  const labels = new Map<string, string>(options.flatMap((option, index) => typeof option.label === 'string' ? [[`option:${index}`, option.label] as const] : []));
  if (selected.some(id => !labels.has(id))) throw new AppError('INVALID_NATIVE_INTERACTION', 'A selected option is not available for this native question', 400);
  const other = response.otherText?.trim();
  if (other && question.isOther !== true) throw new AppError('INVALID_NATIVE_INTERACTION', 'This native question does not allow a free-text answer', 400);
  const count = selected.length + (other ? 1 : 0);
  if (!count || (question.multiSelect !== true && count !== 1)) {
    throw new AppError('INVALID_NATIVE_INTERACTION', question.multiSelect === true ? 'Choose at least one option or enter an answer' : 'Choose one option or enter an alternative answer', 400);
  }
  const values = options.flatMap((option, index) => selected.includes(`option:${index}`) ? [option.label as string] : []);
  if (other) values.push(other);
  if (new Set(values).size !== values.length) throw new AppError('INVALID_NATIVE_INTERACTION', 'The native answer must not contain duplicate values', 400);
  return values;
}

// The published McpElicitationSchema is a flat object of primitive fields (MCP 2025-11-25).
// Zod is already installed; it has no JSON-schema importer. Validate this supported subset
// explicitly, including every constraint we advertise, rather than accepting arbitrary schemas.
const elicitationAnnotations = { title: z.string().optional(), description: z.string().optional() };
const elicitationSize = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const elicitationConstOptions = z.array(z.strictObject({ const: z.string(), title: z.string() })).min(1);
const elicitationPrimitiveSchema = z.union([
  z.strictObject({ ...elicitationAnnotations, type: z.literal('string'), default: z.string().optional(),
    minLength: elicitationSize.optional(), maxLength: elicitationSize.optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
    enum: z.array(z.string()).min(1).optional(), enumNames: z.array(z.string()).optional(), oneOf: elicitationConstOptions.optional(),
  }),
  z.strictObject({ ...elicitationAnnotations, type: z.enum(['number', 'integer']), default: z.number().optional(),
    minimum: z.number().optional(), maximum: z.number().optional(),
  }),
  z.strictObject({ ...elicitationAnnotations, type: z.literal('boolean'), default: z.boolean().optional() }),
  z.strictObject({ ...elicitationAnnotations, type: z.literal('array'), default: z.array(z.string()).optional(),
    minItems: elicitationSize.optional(), maxItems: elicitationSize.optional(), uniqueItems: z.boolean().optional(),
    items: z.union([z.strictObject({ type: z.literal('string'), enum: z.array(z.string()).min(1) }),
      z.strictObject({ anyOf: elicitationConstOptions })]),
  }),
]);
const elicitationSchema = z.strictObject({ ...elicitationAnnotations, $schema: z.string().optional(), type: z.literal('object'),
  properties: z.record(z.string(), elicitationPrimitiveSchema), required: z.array(z.string()).optional(),
  additionalProperties: z.boolean().optional(),
});

type ElicitationForm = {
  validator: z.ZodType;
  fields: Array<{ name: string; multiple: boolean; choices: Array<{ value: string; label: string }> }>;
};

function elicitationForm(schema: unknown): ElicitationForm | undefined {
  const parsed = elicitationSchema.safeParse(schema);
  if (!parsed.success) return undefined;
  const { properties, required = [], additionalProperties } = parsed.data;
  if (new Set(required).size !== required.length || required.some(name => !Object.hasOwn(properties, name))) return undefined;
  const fields: ElicitationForm['fields'] = [];
  const shape: Array<[string, z.ZodType]> = [];
  for (const [name, property] of Object.entries(properties)) {
    // Zod deliberately omits this key when parsing objects; never claim to validate it.
    if (name === '__proto__') return undefined;
    let validator: z.ZodType;
    let choices: Array<{ value: string; label: string }> = [];
    if (property.type === 'string') {
      if (property.enum && property.oneOf || property.enumNames && (!property.enum || property.enumNames.length !== property.enum.length)) return undefined;
      choices = property.oneOf?.map(option => ({ value: option.const, label: option.title }))
        ?? property.enum?.map((value, index) => ({ value, label: property.enumNames?.[index] ?? value })) ?? [];
      if (new Set(choices.map(choice => choice.value)).size !== choices.length) return undefined;
      if (property.minLength !== undefined && property.maxLength !== undefined && property.minLength > property.maxLength) return undefined;
      const format = property.format === 'email' ? z.email() : property.format === 'uri' ? z.url()
        : property.format === 'date' ? z.iso.date() : property.format === 'date-time' ? z.iso.datetime({ offset: true }) : undefined;
      validator = z.string().refine(value => (!choices.length || choices.some(choice => choice.value === value))
        && (property.minLength === undefined || [...value].length >= property.minLength)
        && (property.maxLength === undefined || [...value].length <= property.maxLength)
        && (!format || (property.format === 'date-time'
          ? /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && format.safeParse(value.toUpperCase()).success
          : format.safeParse(value).success)));
    } else if (property.type === 'array') {
      choices = 'enum' in property.items ? property.items.enum.map(value => ({ value, label: value }))
        : property.items.anyOf.map(option => ({ value: option.const, label: option.title }));
      if (new Set(choices.map(choice => choice.value)).size !== choices.length) return undefined;
      if (property.minItems !== undefined && property.maxItems !== undefined && property.minItems > property.maxItems) return undefined;
      let array = z.array(z.enum(choices.map(choice => choice.value)));
      if (property.minItems !== undefined) array = array.min(property.minItems);
      if (property.maxItems !== undefined) array = array.max(property.maxItems);
      validator = property.uniqueItems ? array.refine(values => new Set(values).size === values.length) : array;
    } else if (property.type === 'boolean') validator = z.boolean();
    else {
      if (property.minimum !== undefined && property.maximum !== undefined && property.minimum > property.maximum) return undefined;
      let numeric = z.number();
      if (property.minimum !== undefined) numeric = numeric.min(property.minimum);
      if (property.maximum !== undefined) numeric = numeric.max(property.maximum);
      validator = property.type === 'integer' ? numeric.refine(Number.isInteger) : numeric;
    }
    fields.push({ name, multiple: property.type === 'array', choices });
    shape.push([name, required.includes(name) ? validator : validator.optional()]);
  }
  const validator = z.object(Object.fromEntries(shape));
  // JSON Schema permits unspecified properties by default; do not silently discard valid JSON.
  return { validator: additionalProperties === false ? validator.strict() : validator.passthrough(), fields };
}

/** Pure validation, called before the runtime records a candidate or sends an accept RPC. */
export function elicitationContent(schema: unknown, response: NativeInteractionResponse): Record<string, unknown> {
  const invalid = (message: string): never => { throw new AppError('INVALID_NATIVE_INTERACTION', message, 400); };
  const form = elicitationForm(schema);
  if (!form) return invalid('This schema must be answered in the native terminal');
  const selected = response.selectedIds ?? [];
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length) return invalid('Select each native option at most once');
  const available = new Set(elicitationOptions(form).map(option => option.id));
  if (selected.some(id => !available.has(id))) return invalid('A selected option is not available for this native form');
  const text = response.otherText?.trim();
  let content: Record<string, unknown>;
  if (text) {
    if (selected.length) return invalid('Submit either a JSON object or selected options, not both');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return invalid('Enter a valid JSON object for this native form'); }
    const record = asRecord(parsed);
    if (!record) return invalid('This native form requires a JSON object');
    content = record;
  } else {
    if (!selected.length) return invalid('Enter a JSON object or choose an answer for this native form');
    const entries: Array<[string, unknown]> = [];
    for (const field of form.fields) {
      const values = field.choices.flatMap((choice, index) => selected.includes(`${field.name}:${index}`) ? [choice.value] : []);
      if (!values.length) continue;
      if (!field.multiple && values.length !== 1) return invalid('Choose one option for each single-select native field');
      entries.push([field.name, field.multiple ? values : values[0]]);
    }
    content = Object.fromEntries(entries);
  }
  if (!form.validator.safeParse(content).success) return invalid('The answer does not satisfy the native form schema');
  return content;
}

function elicitationOptions(form: ElicitationForm): NativeInteraction['options'] {
  return form.fields.flatMap(field => field.choices.map((choice, index) => ({
    id: `${field.name}:${index}`, label: `${field.name}: ${choice.label}`, selected: false,
  })));
}

export function interactionFingerprint(response: NativeInteractionResponse): string {
  const payload = JSON.stringify({
    interactionId: response.interactionId,
    revision: response.revision,
    action: response.action,
    selectedIds: response.selectedIds ?? [],
    otherText: response.otherText ?? '',
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** The decision shown for a collaboration-mode change TRAE CLI asks for; `plan` is the proposed plan's text when leaving Plan mode. */
export function modeChangeInteraction(
  flavorId: string, key: string, params: Record<string, unknown>, supported: boolean, leavingPlan: boolean, plan: string | undefined,
): NativeInteraction {
  const prompts = asArray<Record<string, unknown>>(params.allowedPrompts).flatMap(entry => {
    const prompt = str(entry.prompt);
    return prompt ? [`${str(entry.tool) ?? 'Tool'}: ${prompt}`] : [];
  });
  const message = [
    str(params.reason),
    plan,
    prompts.length ? `Allowed without asking:\n${prompts.map(prompt => `- ${prompt}`).join('\n')}` : undefined,
  ].filter(Boolean).join('\n\n');
  const interaction: NativeInteraction = {
    id: `${flavorId}:${str(params.threadId) ?? 'thread'}:${key}`, revision: `1:${key}`, transport: 'protocol', requestId: key, request: params,
    kind: leavingPlan ? 'plan' : 'confirmation',
    title: supported ? leavingPlan ? 'Leave Plan mode and start working?' : 'Switch to Plan mode?' : 'Resolve mode change in the native terminal',
    ...(message ? { message } : {}),
    options: [],
    actions: supported ? [
      { id: 'approve', label: leavingPlan ? 'Start working' : 'Switch', tone: 'primary' },
      { id: 'deny', label: leavingPlan ? 'Keep planning' : 'Stay', tone: 'danger' },
      { id: 'cancel', label: 'Cancel' },
    ] : [],
  };
  return interaction;
}
