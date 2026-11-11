import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginLogEntry } from '../../../../packages/contracts/src/plugin-management.js';

const MAX_BYTES = 128 * 1024;
const MAX_ENTRIES = 256;
const MAX_MESSAGE = 6000;

/** A bounded journal outside plugin data: isolated code cannot read or alter the host's log. */
export class PluginLogs {
  private readonly directory: string;
  constructor(stateDir: string, private readonly secrets: (id: string) => readonly string[]) {
    this.directory = join(stateDir, 'plugin-logs');
  }

  redact(id: string, value: string): string {
    let result = value;
    for (const secret of this.secrets(id).filter(Boolean).sort((a, b) => b.length - a.length)) {
      if (secret.length < 3) result = result.replace(new RegExp(`(?<![A-Za-z0-9])${secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'g'), '[redacted]');
      else result = result.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
    }
    return result.replace(/(\b(?:Bearer|Basic)\s+)\S+/gi, '$1[redacted]').replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
  }

  append(entry: Omit<PluginLogEntry, 'at'>): void {
    const record = { ...entry, at: new Date().toISOString(), message: this.redact(entry.pluginId, entry.message).slice(0, MAX_MESSAGE) };
    const line = `${JSON.stringify(record)}\n`;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const file = join(this.directory, `${entry.pluginId}.jsonl`);
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) + Buffer.byteLength(line) > MAX_BYTES) {
        try { unlinkSync(`${file}.1`); } catch { /* No previous rotation. */ }
        renameSync(file, `${file}.1`);
      }
      const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, line); } finally { closeSync(fd); }
    } catch { /* Logs never prevent activation or recovery. */ }
  }

  read(id: string): PluginLogEntry[] {
    const lines: PluginLogEntry[] = [];
    for (const suffix of ['.jsonl.1', '.jsonl']) {
      try {
        const fd = openSync(join(this.directory, `${id}${suffix}`), constants.O_RDONLY | constants.O_NOFOLLOW);
        let text: string;
        try {
          const size = fstatSync(fd).size;
          const bytes = Buffer.alloc(Math.min(size, MAX_BYTES));
          const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - MAX_BYTES));
          text = bytes.subarray(0, count).toString('utf8');
        } finally { closeSync(fd); }
        for (const line of text.split('\n')) {
          try {
            const item = JSON.parse(line) as PluginLogEntry;
            if (item.pluginId === id && typeof item.message === 'string') lines.push({ ...item, message: this.redact(id, item.message).slice(0, MAX_MESSAGE) });
          } catch { /* A crash may leave a partial last line. */ }
        }
      } catch { /* No log yet. */ }
    }
    return lines.slice(-MAX_ENTRIES);
  }
}
