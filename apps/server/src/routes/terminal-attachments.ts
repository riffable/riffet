import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { TerminalAttachmentPaste, TerminalPasteResult } from '../../../../packages/contracts/src/index.js';
import { materializeAttachment } from '../backends/attachments.js';
import { AppError, requireString } from '../errors.js';
import { isAgentTerminal } from '../terminal/kinds.js';
import type { RouteDeps } from './deps.js';

/** Saved before writing to tmux: a restart must never replay an unacknowledged paste. */
interface PasteReceipt {
  terminalId: string;
  fingerprint: string;
  attachmentIds: string[];
  status: 'pending' | 'completed' | 'unknown';
  createdAt: string;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function readPaste(value: TerminalAttachmentPaste): TerminalAttachmentPaste {
  const clientId = requireString(value?.clientId, 'clientId', 200);
  const requestId = requireString(value?.requestId, 'requestId', 200);
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0
    || !Array.isArray(value.attachmentIds) || !value.attachmentIds.length || value.attachmentIds.length > 20
    || value.attachmentIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id))
    || (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 120 * 1024 || /\x00|\x1b/.test(value.text)))) {
    throw new AppError('INVALID_TERMINAL_INPUT', 'Invalid terminal attachment paste');
  }
  return { clientId, epoch: value.epoch, requestId, attachmentIds: [...new Set(value.attachmentIds)], text: value.text ?? '' };
}

/** Uploads stay in the existing workspace API; only the final paste carries terminal authority. */
export function registerTerminalAttachmentRoutes(app: FastifyInstance, { store, terminal, workspace, auth }: RouteDeps): void {
  const executing = new Map<string, { fingerprint: string; result: Promise<TerminalPasteResult> }>();
  app.post<{ Params: { id: string }; Body: TerminalAttachmentPaste }>('/api/terminals/:id/paste-attachments', async request => {
    const input = readPaste(request.body);
    const id = request.params.id;
    store.getTerminal(id);
    const key = `terminal-paste:${id}:${hash(input.requestId)}`;
    const fingerprint = hash(JSON.stringify(input));
    const assertSame = (previous: { fingerprint: string }) => {
      if (previous.fingerprint !== fingerprint) throw new AppError('INVALID_TERMINAL_INPUT', 'This paste request id was already used for different input', 409);
    };
    const running = executing.get(key);
    if (running) { assertSame(running); return running.result; }
    const saved = store.getSetting<PasteReceipt | undefined>(key, undefined);
    if (saved) {
      assertSame(saved);
      return { requestId: input.requestId, status: saved.status === 'completed' ? 'completed' : 'unknown' } satisfies TerminalPasteResult;
    }

    const perform = async (): Promise<TerminalPasteResult> => {
      const current = await terminal.get(id);
      if (current.state !== 'running' || current.ownerId !== input.clientId || current.epoch !== input.epoch) {
        throw new AppError('TERMINAL_LEASE_REQUIRED', 'Terminal control changed before the paste', 409);
      }
      // Prepare outside the input transaction. The lease is checked again immediately before write.
      const paths: string[] = [];
      for (const attachmentId of input.attachmentIds) {
        const { attachment, data } = await workspace.readAttachment(attachmentId);
        if (/[\x00-\x1f\x7f]/.test(attachment.name)) throw new AppError('INVALID_ATTACHMENT', 'Attachment names cannot contain terminal control characters');
        const path = await materializeAttachment(attachment, data, { durable: true });
        if (/[\x00-\x1f\x7f]/.test(path)) throw new AppError('INVALID_ATTACHMENT', 'Attachment paths cannot contain terminal control characters');
        paths.push(path);
      }
      // Shells need literal path arguments. Native agent prompts already consume file paths as text.
      const references = paths.map(path => isAgentTerminal(current)
        ? path : `'${path.replaceAll("'", "'\\''")}'`).join(' ');
      const text = input.text ? `${input.text} ${references}` : references;
      if (text.length > 128 * 1024) throw new AppError('INPUT_TOO_LARGE', 'Paste at most 128 KiB at once');
      auth.authenticate(request);
      const latest = store.getTerminal(id);
      if (latest.state !== 'running' || latest.ownerId !== input.clientId || latest.epoch !== input.epoch) {
        throw new AppError('TERMINAL_LEASE_REQUIRED', 'Terminal control changed while preparing attachments', 409);
      }
      const receipt: PasteReceipt = { terminalId: id, fingerprint, attachmentIds: input.attachmentIds, status: 'pending', createdAt: new Date().toISOString() };
      let attempted = false;
      try {
        await terminal.pasteAttachmentsWithLease(id, input.clientId, input.epoch, text, () => { auth.authenticate(request); }, () => {
          store.setSetting(key, receipt);
          attempted = true;
        });
        store.setSetting(key, { ...receipt, status: 'completed' });
        return { requestId: input.requestId, status: 'completed' };
      } catch (error) {
        if (!attempted) throw error;
        // tmux may have consumed the paste before its acknowledgement was lost. Do not retry it.
        store.setSetting(key, { ...receipt, status: 'unknown' });
        return { requestId: input.requestId, status: 'unknown' };
      }
    };
    const result = perform();
    executing.set(key, { fingerprint, result });
    try { return await result; }
    finally { executing.delete(key); }
  });
}
