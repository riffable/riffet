import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionDocument } from '../../../../packages/contracts/src/extensions.js';
import { AppError } from '../errors.js';
import { assertWithin, isWithin } from '../workspace/scope.js';
import {
  atomicWriteConfigDocument, hashConfigContent, MAX_CONFIG_DOCUMENT_BYTES,
  readConfigDocumentBytes, redactConfigDocument, restoreConfigDocumentSecrets,
  hasUnsupportedConfigSecrets,
} from '../settings/config-documents.js';
import type { ExtensionDocumentDescriptor } from './types.js';

function publicDocument(descriptor: ExtensionDocumentDescriptor, content: string, hash: string): ExtensionDocument {
  return {
    id: descriptor.id,
    path: descriptor.path,
    editable: descriptor.editable,
    ...(descriptor.reason ? { reason: descriptor.reason } : {}),
    content,
    hash,
    language: descriptor.language,
    applyEffect: descriptor.applyEffect,
    ...(['yaml', 'toml'].includes(descriptor.language) ? { validationNote: 'Riffet keeps this file as raw text and does not validate its syntax.' } : {}),
  };
}

function assertSafeRawSecrets(content: string): void {
  if (hasUnsupportedConfigSecrets(content)) throw new AppError('EXTENSION_NATIVE_EDITOR_REQUIRED', 'The file holds multi-line credentials that cannot be redacted and restored safely; use the native editor', 409);
}

function projectedContent(descriptor: ExtensionDocumentDescriptor, rawContent: string): string {
  if (descriptor.projection !== 'claudeMcpServers') return redactConfigDocument(rawContent);
  let parsed: unknown;
  try { parsed = JSON.parse(rawContent); }
  catch { throw new AppError('EXTENSION_PROJECTION_INVALID', 'Claude MCP config is not valid JSON', 409); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError('EXTENSION_PROJECTION_INVALID', 'Claude MCP config must be a JSON object', 409);
  const servers = (parsed as Record<string, unknown>).mcpServers;
  return redactConfigDocument(JSON.stringify({ mcpServers: servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {} }, null, 2));
}

function mergeProjection(descriptor: ExtensionDocumentDescriptor, original: string | undefined, submitted: string): string {
  if (descriptor.projection !== 'claudeMcpServers' || original === undefined) return submitted;
  let existing: unknown;
  let projection: unknown;
  try { existing = JSON.parse(original); projection = JSON.parse(submitted); }
  catch { throw new AppError('INVALID_EXTENSION_JSON', 'JSON must be valid before it can be saved'); }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing) || !projection || typeof projection !== 'object' || Array.isArray(projection)) {
    throw new AppError('INVALID_EXTENSION_JSON', 'Claude global MCP settings must be JSON objects');
  }
  const existingObject = existing as Record<string, unknown>;
  const submittedObject = projection as Record<string, unknown>;
  if (submittedObject.mcpServers !== undefined && (!submittedObject.mcpServers || typeof submittedObject.mcpServers !== 'object' || Array.isArray(submittedObject.mcpServers))) {
    throw new AppError('INVALID_EXTENSION_JSON', 'mcpServers must be a JSON object');
  }
  const priorServers = JSON.stringify({ mcpServers: existingObject.mcpServers ?? {} });
  const safeServers = JSON.parse(restoreConfigDocumentSecrets(priorServers, JSON.stringify({ mcpServers: submittedObject.mcpServers ?? {} }))) as { mcpServers?: unknown };
  existingObject.mcpServers = safeServers.mcpServers ?? {};
  return JSON.stringify(existingObject, null, 2) + '\n';
}

function assertDescriptorPath(descriptor: ExtensionDocumentDescriptor): void {
  const target = path.resolve(descriptor.absolutePath);
  const root = path.resolve(descriptor.root);
  assertWithin(root, target, 'EXTENSION_PATH_OUTSIDE_ROOT');
}

async function checkedExistingFile(descriptor: ExtensionDocumentDescriptor): Promise<{ raw: Buffer; symlink: boolean }> {
  assertDescriptorPath(descriptor);
  const root = await realpath(descriptor.root);
  const info = await lstat(descriptor.absolutePath);
  const symlink = info.isSymbolicLink();
  const target = await realpath(descriptor.absolutePath);
  assertWithin(root, target, 'EXTENSION_PATH_OUTSIDE_ROOT');
  if (!(await stat(target)).isFile()) throw new AppError('EXTENSION_NOT_FILE', 'Extension document is not a regular file', 409);
  const raw = await readConfigDocumentBytes(target, MAX_CONFIG_DOCUMENT_BYTES, 'EXTENSION_TOO_LARGE');
  return { raw, symlink };
}

export async function readExtensionFile(descriptor: ExtensionDocumentDescriptor): Promise<ExtensionDocument> {
  try {
    const { raw } = await checkedExistingFile(descriptor);
    const source = raw.toString('utf8');
    assertSafeRawSecrets(source);
    return publicDocument(descriptor, projectedContent(descriptor, source), hashConfigContent(raw));
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('EXTENSION_DOCUMENT_NOT_FOUND', 'Extension document no longer exists', 404);
    if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') throw new AppError('EXTENSION_DOCUMENT_UNREADABLE', 'Extension document cannot be read due to file permissions', 403);
    throw error;
  }
}

function validateJson(content: string): void {
  try { JSON.parse(content); }
  catch { throw new AppError('INVALID_EXTENSION_JSON', 'JSON must be valid before it can be saved'); }
}

export async function rejectSymlinkPath(root: string, relativePath: string): Promise<void> {
  const rootReal = await realpath(root);
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  let current = rootReal;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new AppError('EXTENSION_SYMLINK_UNSUPPORTED', 'Shared symlink paths cannot be edited', 403);
      if (index < segments.length - 1 && !info.isDirectory()) throw new AppError('INVALID_EXTENSION_PATH', 'An extension path parent is not a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

export async function writeExtensionFile(descriptor: ExtensionDocumentDescriptor, input: { content: string; expectedHash: string }, stateDir: string): Promise<ExtensionDocument> {
  if (!descriptor.editable) throw new AppError('EXTENSION_READ_ONLY', descriptor.reason ?? 'This extension document is read-only', 403, undefined, descriptor.reason ? { subject: 'reason', reason: descriptor.reason } : undefined);
  if (typeof input?.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > MAX_CONFIG_DOCUMENT_BYTES) throw new AppError('INVALID_EXTENSION_DOCUMENT', 'Extension content is invalid or exceeds the 1 MB limit', 413);
  if (typeof input.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedHash)) throw new AppError('EXPECTED_HASH_REQUIRED', 'A SHA-256 expectedHash is required');
  assertDescriptorPath(descriptor);
  await rejectSymlinkPath(descriptor.root, descriptor.relativePath);
  let previous: Buffer | undefined;
  try {
    const info = await lstat(descriptor.absolutePath);
    if (info.isSymbolicLink()) throw new AppError('EXTENSION_SYMLINK_UNSUPPORTED', 'Shared symlink paths cannot be edited', 403);
    if (!info.isFile() || info.size > MAX_CONFIG_DOCUMENT_BYTES) throw new AppError('EXTENSION_TOO_LARGE', 'Extension document cannot be edited safely', 413);
    previous = await readConfigDocumentBytes(descriptor.absolutePath, MAX_CONFIG_DOCUMENT_BYTES, 'CONFIG_CONFLICT');
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('EXTENSION_DOCUMENT_NOT_FOUND', 'Extension document no longer exists', 404);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') throw new AppError('EXTENSION_DOCUMENT_UNWRITABLE', 'Extension document cannot be written due to file permissions', 403);
      throw error;
    }
  }
  const actualHash = hashConfigContent(previous ?? Buffer.alloc(0));
  if (actualHash !== input.expectedHash) throw new AppError('CONFIG_CONFLICT', 'Extension document changed since it was read; reload before editing', 409, { expectedHash: input.expectedHash, actualHash });
  let safeContent = input.content;
  if (previous) assertSafeRawSecrets(previous.toString('utf8'));
  assertSafeRawSecrets(safeContent);
  if (descriptor.projection === 'claudeMcpServers') safeContent = mergeProjection(descriptor, previous?.toString('utf8'), safeContent);
  else if (previous) safeContent = restoreConfigDocumentSecrets(previous.toString('utf8'), safeContent);
  if (descriptor.language === 'json') validateJson(safeContent);
  await atomicWriteConfigDocument({ stateDir, root: descriptor.root, filePath: descriptor.absolutePath, content: safeContent, previous, expectedHash: input.expectedHash, maxBytes: MAX_CONFIG_DOCUMENT_BYTES });
  return readExtensionFile(descriptor);
}

export async function createExtensionFile(descriptor: ExtensionDocumentDescriptor, content: string, stateDir: string): Promise<ExtensionDocument> {
  if (!descriptor.editable) throw new AppError('EXTENSION_READ_ONLY', descriptor.reason ?? 'This extension document is read-only', 403, undefined, descriptor.reason ? { subject: 'reason', reason: descriptor.reason } : undefined);
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_CONFIG_DOCUMENT_BYTES) throw new AppError('INVALID_EXTENSION_DOCUMENT', 'Extension content is invalid or exceeds the 1 MB limit', 413);
  assertSafeRawSecrets(content);
  assertDescriptorPath(descriptor);
  if (descriptor.language === 'json') validateJson(content);
  await mkdir(descriptor.root, { recursive: true, mode: 0o700 });
  await rejectSymlinkPath(descriptor.root, descriptor.relativePath);
  try { await lstat(descriptor.absolutePath); throw new AppError('EXTENSION_DOCUMENT_EXISTS', 'Extension document already exists; reload it before editing', 409); }
  catch (error) { if (error instanceof AppError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await atomicWriteConfigDocument({ stateDir, root: descriptor.root, filePath: descriptor.absolutePath, content, previous: undefined, expectedHash: hashConfigContent(''), maxBytes: MAX_CONFIG_DOCUMENT_BYTES });
  return readExtensionFile(descriptor);
}
