import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CursorLive, type CursorUsageCapture } from './live.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('drains valid metadata around corrupt files and confines acknowledgements to its own regular files', () => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-usage-reader-'));
  roots.push(root);
  const live = new CursorLive(join(root, 'cursor-live'));
  mkdirSync(live.usageDir);
  const observation: CursorUsageCapture = {
    v: 1, nativeSessionId: 'example-chat', nativeTurnId: 'example-run', requestId: 'example-request',
    startedAt: 10, endedAt: 20, rawUsage: { inputTokens: 0, outputTokens: 4 },
  };
  const write = (value: unknown, dir = live.usageDir): string => {
    const bytes = JSON.stringify(value);
    const file = join(dir, `${createHash('sha256').update(bytes).digest('hex')}.json`);
    writeFileSync(file, bytes);
    return file;
  };
  const valid = write(observation);
  const outside = write(observation, root);
  const link = join(live.usageDir, `${'a'.repeat(64)}.json`);
  symlinkSync(outside, link);
  writeFileSync(join(live.usageDir, `${'b'.repeat(64)}.json`), '{broken');
  writeFileSync(join(live.usageDir, `${'c'.repeat(64)}.json`), ' '.repeat(20_000));
  write({ ...observation, prompt: 'body must never enter metadata' });
  write({ ...observation, rawUsage: { inputTokens: Number.MAX_SAFE_INTEGER + 1 } });
  write({ ...observation, rawUsage: { inputTokens: -1 } });
  expect(live.readUsage()).toEqual([{ file: valid, observation }]);
  live.ackUsage(outside);
  live.ackUsage(link);
  expect(existsSync(outside)).toBe(true);
  expect(existsSync(link)).toBe(true);
  live.ackUsage(valid);
  expect(existsSync(valid)).toBe(false);
  expect(live.readUsage()).toEqual([]);
  live.ackUsage(valid);
  live.close();
});
