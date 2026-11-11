import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ClientLogs, CLIENT_LOG_MAX_BYTES } from './clientLogs.js';

const dirs: string[] = [];
const logs = async (keep?: number) => {
  const dir = await mkdtemp(join(tmpdir(), 'riffet-client-logs-'));
  dirs.push(dir);
  return new ClientLogs(join(dir, 'client-logs'), keep);
};
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('ClientLogs', () => {
  it('writes the log under a stamped, sanitised name', async () => {
    const store = await logs();
    const saved = await store.save('../riffet-log-10-6_1733-49.txt', 'line\n');
    expect(basename(saved.path)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_riffet-log-10-6_1733-49\.txt$/);
    expect(saved.path.startsWith(store.dir)).toBe(true);
    expect(await readFile(saved.path, 'utf8')).toBe('line\n');
    expect(saved.bytes).toBe(5);
  });

  it('keeps only the newest uploads', async () => {
    const store = await logs(2);
    for (const name of ['a', 'b', 'c']) {
      await store.save(name, name);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const files = (await readdir(store.dir)).sort();
    expect(files).toHaveLength(2);
    expect(files.map((file) => file.slice(-5))).toEqual(['b.txt', 'c.txt']);
  });

  it('rejects empty and oversized logs, counting bytes rather than characters', async () => {
    const store = await logs();
    await expect(store.save('x', '')).rejects.toMatchObject({ code: 'INVALID_LOG' });
    await expect(store.save('x', 'a'.repeat(CLIENT_LOG_MAX_BYTES + 1))).rejects.toMatchObject({ code: 'LOG_TOO_LARGE' });
    await expect(store.save('x', '日'.repeat(CLIENT_LOG_MAX_BYTES / 3 + 1))).rejects.toMatchObject({ code: 'LOG_TOO_LARGE' });
  });

  it('never overwrites an upload made in the same millisecond', async () => {
    const store = await logs();
    const saved = await Promise.all(['first', 'second'].map((content) => store.save('same', content)));
    expect(new Set(saved.map((item) => item.path)).size).toBe(2);
    expect((await Promise.all(saved.map((item) => readFile(item.path, 'utf8')))).sort()).toEqual(['first', 'second']);
  });
});
