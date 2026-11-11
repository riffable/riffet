import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { assertWithin } from './workspace.js';

const REDACTED = '[REDACTED]';
export const MAX_CONFIG_DOCUMENT_BYTES = 1024 * 1024;
const SECRET_KEY = /(?:secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const fileWriteLocks = new Map<string, Promise<void>>();

export async function withConfigFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(filePath);
  const key = path.basename(resolved) === 'SKILL.md.riffet-disabled' ? path.join(path.dirname(resolved), 'SKILL.md') : resolved;
  const previous = fileWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => hold);
  fileWriteLocks.set(key, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (fileWriteLocks.get(key) === tail) fileWriteLocks.delete(key);
  }
}

export function hashConfigContent(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function redactText(content: string): string {
  if (hasUnsupportedConfigSecrets(content)) return '[REDACTED: multiline credentials require the native editor]';
  return content
    .replace(/((?:["'][^"']*(?:secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key)[^"']*["']|(?:secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key))\s*[:=]\s*)(["'])(.*?)(\2)/gi, `$1$2${REDACTED}$4`)
    .replace(/((?:["'][^"']*(?:secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key)[^"']*["']|(?:secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key))\s*[:=][ \t]*)([^\s,"';}][^\s,;}]*)/gi, `$1${REDACTED}`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, `$1${REDACTED}`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, REDACTED);
}

/** Raw formats cannot safely round-trip multiline secret values without a native parser. */
export function hasUnsupportedConfigSecrets(content: string): boolean {
  try { JSON.parse(content); return false; } catch { /* JSON uses the recursive projection. */ }
  if (/-----BEGIN[^\r\n]*PRIVATE KEY-----/.test(content)) return true;
  return content.split(/\r?\n/).some(line => {
    const field = line.match(/^\s*(?:-\s*)?([\w.\-"']+)\s*[:=][ \t]*(.*)$/);
    if (!field || !SECRET_KEY.test(field[1])) return false;
    const value = field[2].trim();
    if (!value || /^(?:[|>][+\-\d]*\s*(?:#.*)?$|"""|'''|\[|\{)/.test(value)) return true;
    if (value.startsWith('"')) return !/^"(?:[^"\\]|\\.)*"/.test(value);
    if (value.startsWith("'")) return !/^'[^']*'/.test(value);
    return /\s/.test(value.split(/\s+#/)[0].trim());
  });
}

export function redactSensitiveText(content: string): string { return redactText(content); }

function redactJson(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) {
    if (typeof value === 'string' && value.length) return REDACTED;
    if (Array.isArray(value)) return value.map(item => redactJson(item, key));
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(value)) result[childKey] = redactJson(child, key);
      return result;
    }
  }
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(item => redactJson(item));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) result[childKey] = redactJson(child, childKey);
    return result;
  }
  return value;
}

/** Preserve the existing settings editor's redaction format. Other text formats use conservative token redaction. */
export function redactConfigDocument(content: string): string {
  try { return JSON.stringify(redactJson(JSON.parse(content)), null, 2); }
  catch { return redactText(content); }
}

function restoreJsonSecrets(original: unknown, submitted: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key) && submitted === REDACTED) return original;
  if (typeof original === 'string' && typeof submitted === 'string') return mergeRedactedText(original, submitted);
  const sensitiveParent = SECRET_KEY.test(key);
  if (Array.isArray(submitted) && Array.isArray(original)) return submitted.map((value, index) => restoreJsonSecrets(original[index], value, sensitiveParent ? key : ''));
  if (submitted && original && typeof submitted === 'object' && typeof original === 'object' && !Array.isArray(submitted) && !Array.isArray(original)) {
    const result: Record<string, unknown> = { ...(submitted as Record<string, unknown>) };
    for (const [childKey, value] of Object.entries(result)) {
      if (childKey in (original as Record<string, unknown>)) result[childKey] = restoreJsonSecrets((original as Record<string, unknown>)[childKey], value, sensitiveParent ? key : childKey);
    }
    return result;
  }
  return submitted;
}

function mergeRedactedText(original: string, submitted: string): string {
  if (submitted === '[REDACTED: multiline credentials require the native editor]' && hasUnsupportedConfigSecrets(original)) return original;
  const pattern = /(?:"([^"]*(?:secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key)[^"]*)"|'([^']*(?:secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key)[^']*)'|((?:secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key)))\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;}]+))/gi;
  const values = new Map<string, string[]>();
  for (const match of original.matchAll(pattern)) {
    const name = (match[1] ?? match[2] ?? match[3]).toLowerCase();
    const previous = values.get(name) ?? [];
    previous.push(match[4] ?? match[5] ?? match[6] ?? '');
    values.set(name, previous);
  }
  const seen = new Map<string, number>();
  let result = submitted.replace(pattern, (all, quotedName?: string, singleQuotedName?: string, plainName?: string, doubleValue?: string, singleValue?: string, plainValue?: string) => {
    const rawName = quotedName ?? singleQuotedName ?? plainName ?? '';
    const name = rawName.toLowerCase();
    const value = doubleValue ?? singleValue ?? plainValue;
    if (value !== REDACTED) return all;
    const offset = seen.get(name) ?? 0;
    seen.set(name, offset + 1);
    const prior = values.get(name)?.[offset];
    return prior === undefined ? all : all.replace(REDACTED, prior);
  });
  const bearerValues = [...original.matchAll(/\bBearer\s+([^\s,;}]+)/gi)].map(match => match[1]);
  let bearerIndex = 0;
  result = result.replace(/\b(Bearer\s+)\[REDACTED\]/gi, (all, prefix: string) => `${prefix}${bearerValues[bearerIndex++] ?? REDACTED}`);
  const rawTokens = [...original.matchAll(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g)].map(match => match[0]);
  let tokenIndex = 0;
  return result.replace(/\[REDACTED\]/g, marker => rawTokens[tokenIndex++] ?? marker);
}

/** Put a previously redacted view back together without replacing untouched secret values. */
export function restoreConfigDocumentSecrets(original: string, submitted: string): string {
  try {
    const existing = JSON.parse(original) as unknown;
    const next = JSON.parse(submitted) as unknown;
    return JSON.stringify(restoreJsonSecrets(existing, next), null, 2) + '\n';
  } catch { return mergeRedactedText(original, submitted); }
}

export async function readConfigDocumentBytes(filePath: string, maxBytes = MAX_CONFIG_DOCUMENT_BYTES, sizeError = 'CONFIG_TOO_LARGE'): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw new AppError('CONFIG_NOT_FILE', 'Config is not a regular file', 409);
    const sizeStatus = sizeError.includes('TOO_LARGE') ? 413 : 409;
    if (initial.size > maxBytes) throw new AppError(sizeError, 'Config exceeds the read limit', sizeStatus);
    const data = Buffer.alloc(initial.size + 1);
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const part = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    const final = await handle.stat();
    if (bytesRead > maxBytes || final.size > maxBytes) throw new AppError(sizeError, 'Config exceeds the read limit', sizeStatus);
    if (bytesRead !== final.size) throw new AppError('CONFIG_CONFLICT', 'Config changed while it was being read; reload before editing', 409);
    return data.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** Atomic, hash-guarded file replacement shared by settings and the extension document editor. */
export async function atomicWriteConfigDocument(input: {
  stateDir: string;
  root: string;
  filePath: string;
  content: string;
  previous: Buffer | undefined;
  expectedHash: string;
  maxBytes?: number;
}): Promise<void> {
  const maxBytes = input.maxBytes ?? MAX_CONFIG_DOCUMENT_BYTES;
  if (Buffer.byteLength(input.content, 'utf8') > maxBytes) throw new AppError('INVALID_CONFIG', 'Config content exceeds the write limit', 413);
  const folder = path.dirname(input.filePath);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(input.root);
  const realFolder = await realpath(folder);
  assertWithin(realRoot, realFolder);
  let mode = 0o600;
  try {
    const existing = await lstat(input.filePath);
    if (existing.isSymbolicLink()) throw new AppError('CONFIG_SYMLINK_UNSUPPORTED', 'Config symlinks cannot be edited', 409);
    mode = existing.mode & 0o777;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temp = path.join(folder, `.${path.basename(input.filePath)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, 'wx', mode);
    try { await handle.writeFile(input.content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await chmod(temp, mode);
    const checkFolder = await realpath(folder);
    assertWithin(realRoot, checkFolder);
    const targetInside = path.join(checkFolder, path.basename(input.filePath));
    assertWithin(realRoot, targetInside);
    await withConfigFileLock(targetInside, async () => {
      let current: Buffer | undefined;
      try {
        const currentInfo = await lstat(targetInside);
        if (currentInfo.isSymbolicLink() || !currentInfo.isFile() || currentInfo.size > maxBytes) throw new AppError('CONFIG_CONFLICT', 'Config changed while saving; reload before editing', 409);
        current = await readConfigDocumentBytes(targetInside, maxBytes, 'CONFIG_CONFLICT');
      } catch (error) {
        if (error instanceof AppError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const actualHash = hashConfigContent(current ?? Buffer.alloc(0));
      if ((current === undefined) !== (input.previous === undefined) || actualHash !== input.expectedHash) throw new AppError('CONFIG_CONFLICT', 'Config changed while saving; reload before editing', 409, { expectedHash: input.expectedHash, actualHash });
      if (input.previous) {
        const backupFolder = path.join(input.stateDir, 'config-backups', hashConfigContent(input.filePath).slice(0, 32));
        await mkdir(backupFolder, { recursive: true, mode: 0o700 });
        const backupPath = path.join(backupFolder, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.bak`);
        await writeFile(backupPath, input.previous, { mode: 0o600, flag: 'wx' });
        await rename(temp, targetInside);
      } else {
        try { await link(temp, targetInside); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('CONFIG_CONFLICT', 'Config was created while saving; reload before editing', 409);
          throw error;
        }
      }
    });
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}
