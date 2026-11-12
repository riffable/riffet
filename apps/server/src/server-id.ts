import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * This server's own id, made once and kept in `<stateDir>/server-id`. Unlike `/health`'s `instanceId`, which
 * changes on every start, it outlives restarts, so a phone can tell which paired server a push came from.
 */
export function readServerId(stateDir: string): string {
  const path = join(stateDir, 'server-id');
  try {
    const saved = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(saved)) return saved;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const id = randomUUID();
  writeFileSync(path, `${id}\n`, { mode: 0o600 });
  return id;
}
