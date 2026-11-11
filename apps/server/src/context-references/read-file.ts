import { open, stat } from 'node:fs/promises';
import { AppError } from '../errors.js';

/** Read a fixed committed prefix, checking the cap before allocation and verifying the file identity. */
export async function readContextFile(file: string, maxBytes: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat();
    if (before.size > maxBytes) throw new AppError('SESSION_REFERENCE_TOO_LARGE', 'The source history exceeds the scan limit', 413);
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(data, offset, Math.min(256 * 1024, data.length - offset), offset);
      if (!bytesRead) throw new AppError('SESSION_REFERENCE_UNAVAILABLE', 'The source history changed while reading', 409);
      offset += bytesRead;
    }
    const after = await handle.stat(), current = await stat(file);
    if (after.ino !== before.ino || after.dev !== before.dev || current.ino !== before.ino || current.dev !== before.dev
      || after.size < before.size || current.size < before.size || after.size === before.size && after.mtimeMs !== before.mtimeMs) {
      throw new AppError('SESSION_REFERENCE_UNAVAILABLE', 'The source history changed while reading', 409);
    }
    // A partial last JSONL row may be a concurrent append; only newline-committed records are read.
    const end = data.lastIndexOf(10);
    return data.subarray(0, end < 0 ? 0 : end + 1).toString('utf8');
  } finally { await handle.close(); }
}
