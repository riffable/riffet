import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { NativeInteraction, NativeInteractionResponse, NativeRunInput } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import type { NativeBackendHost } from '../types.js';
import {
  IMAGE_MEDIA_TYPES,
  MAX_INLINE_IMAGE_BYTES,
  str,
  type PiConversation,
  type PiPendingUi,
  type RecordValue,
} from './runtime-shared.js';

export function handlePiUiRequest(state: PiConversation, frame: RecordValue, emitStatus: (state: PiConversation) => void): void {
  const requestId = str(frame.id);
  const method = str(frame.method);
  if (!requestId || !method) return;
  if (method === 'notify') {
    const message = str(frame.message);
    if (message) {
      state.notice = message;
      state.noticeLevel = frame.notifyType === 'error' ? 'error' : frame.notifyType === 'warning' ? 'warning' : 'info';
      emitStatus(state);
    }
    return;
  }
  const interaction = piUiInteraction(requestId, method, frame);
  if (!interaction) return;
  const proc = state.proc;
  if (!proc || proc.exited) {
    void proc?.rpc.send({ type: 'extension_ui_response', id: requestId, cancelled: true }).catch(() => undefined);
    return;
  }
  const pending: PiPendingUi = { requestId, method, interaction, resolve: answer => proc.rpc.send({ type: 'extension_ui_response', id: requestId, ...answer }) };
  if (interaction.expiresAt) {
    pending.timer = setTimeout(() => {
      const index = state.pending.indexOf(pending);
      if (index < 0) return;
      state.pending.splice(index, 1);
      void pending.resolve({ cancelled: true }).catch(() => undefined);
      emitStatus(state);
    }, Math.max(0, Date.parse(interaction.expiresAt) - Date.now()));
    pending.timer.unref();
  }
  state.pending.push(pending);
  emitStatus(state);
}

export function piUiInteraction(requestId: string, method: string, frame: RecordValue): NativeInteraction | undefined {
  const base = {
    id: `pi:${requestId}`,
    revision: `${requestId}:0`,
    transport: 'protocol' as const,
    requestId,
    ...(typeof frame.timeout === 'number' && frame.timeout > 0 ? { expiresAt: new Date(Date.now() + frame.timeout).toISOString() } : {}),
  };
  const title = str(frame.title);
  if (method === 'confirm') {
    return {
      ...base,
      kind: 'confirmation',
      title: title ?? 'Confirm',
      ...(str(frame.message) ? { message: str(frame.message) } : {}),
      options: [],
      actions: [{ id: 'confirm', label: 'Confirm', tone: 'primary' }, { id: 'cancel', label: 'Cancel', tone: 'danger' }],
    };
  }
  if (method === 'select') {
    const options = Array.isArray(frame.options) ? frame.options.flatMap(item => str(item) ?? []) : [];
    return {
      ...base,
      kind: 'choice',
      title: title ?? 'Choose',
      ...(str(frame.message) ? { message: str(frame.message) } : {}),
      options: options.map((label, index) => ({ id: `option:${index}`, label, selected: false })),
      actions: [{ id: 'answer', label: 'Choose', tone: 'primary' }, { id: 'cancel', label: 'Cancel', tone: 'danger' }],
    };
  }
  if (method === 'input' || method === 'editor') {
    return {
      ...base,
      kind: 'question',
      title: title ?? 'Input',
      ...(str(frame.placeholder) ? { message: str(frame.placeholder) } : {}),
      options: [],
      allowOther: true,
      ...(str(frame.prefill) ? { otherValue: str(frame.prefill), otherSelected: true } : {}),
      actions: [{ id: 'answer', label: 'Submit', tone: 'primary' }, { id: 'cancel', label: 'Cancel', tone: 'danger' }],
    };
  }
  return undefined;
}

export function piAnswerFor(pending: PiPendingUi, response: NativeInteractionResponse): RecordValue {
  if (response.action === 'cancel') return { cancelled: true };
  if (pending.method === 'confirm') return { confirmed: true };
  if (pending.method === 'select') {
    const selected = response.selectedIds ?? [];
    const option = pending.interaction.options.find(item => item.id === selected[0]);
    if (selected.length !== 1 || !option) throw new AppError('INVALID_INTERACTION_RESPONSE', 'Choose one available pi option.', 400);
    return { value: option.label };
  }
  return { value: response.otherText ?? '' };
}

export async function materializePiInput(host: NativeBackendHost, input: NativeRunInput): Promise<{ text: string; images: Array<{ type: 'image'; data: string; mimeType: string }> }> {
  const extras = input.context.map(item => `@${item.path}${item.line ? `:${item.line}` : ''}`);
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const id of input.attachmentIds) {
    const { attachment, data } = await host.readAttachment(id);
    const mimeType = attachment.mimeType.toLowerCase();
    if (IMAGE_MEDIA_TYPES.has(mimeType) && data.length <= MAX_INLINE_IMAGE_BYTES) {
      images.push({ type: 'image', data: data.toString('base64'), mimeType });
      continue;
    }
    // pi reads files through its own tools; anything it cannot take as an image is handed over as a path.
    const directory = join(tmpdir(), 'riffet-attachments', attachment.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, basename(attachment.name) || 'attachment');
    await writeFile(target, data, { mode: 0o600 });
    extras.push(target);
  }
  return { text: [input.text, ...(extras.length ? ['', ...extras] : [])].join('\n'), images };
}
