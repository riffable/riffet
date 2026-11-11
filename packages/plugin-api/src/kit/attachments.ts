import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Attachment, NativeRunInput } from '@riffet/contracts';

/** Preserve the upload's filename and extension for tools that infer a format from its path. */
export async function materializeAttachment(attachment: Attachment, data: Buffer, options: { durable?: boolean } = {}): Promise<string> {
  // Codex/TRAE retain this path in native history, so their named copy must survive OS temp cleanup.
  const directory = options.durable
    ? join(dirname(attachment.path), 'materialized', attachment.id)
    : join(tmpdir(), 'riffet-attachments', attachment.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, basename(attachment.name) || 'attachment');
  await writeFile(target, data, { mode: 0o600 });
  return target;
}

/** Materialize the workbench's opaque attachment ids for CLI providers that consume file paths. */
export async function materializeNativeInput(host: { readAttachment(id: string): Promise<{ attachment: Attachment; data: Buffer }> }, input: NativeRunInput): Promise<{ text: string; attachmentPaths: string[] }> {
  const extras = input.context.map(item => `@${item.path}${item.line ? `:${item.line}` : ''}`);
  const attachmentPaths: string[] = [];
  for (const id of input.attachmentIds) {
    const { attachment, data } = await host.readAttachment(id);
    const target = await materializeAttachment(attachment, data);
    attachmentPaths.push(target);
    extras.push(target);
  }
  return { text: [input.text, ...(extras.length ? ['', ...extras] : [])].join('\n'), attachmentPaths };
}
