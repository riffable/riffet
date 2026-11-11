import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { displayWidth, forbidden, redactions } from '../scripts/terminal-fixture-guards';

const fixtures = fileURLToPath(new URL('../apps/mobile/terminal/fixtures/tmux', import.meta.url));
const scenarios = readdirSync(fixtures, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

describe('checked-in terminal fixtures', () => {
  it('contain no third-party text or machine path', () => {
    for (const scenario of scenarios) {
      for (const file of ['stream.bin', 'chunks.json', 'expected.json']) {
        // latin1 maps bytes one-to-one, so the binary stream can be searched with the same rules.
        const text = readFileSync(join(fixtures, scenario, file), 'latin1');
        for (const pattern of forbidden) expect(pattern.test(text), `${scenario}/${file} matches ${pattern}`).toBe(false);
      }
    }
  });

  it('have chunks that cover the recorded stream exactly', () => {
    for (const scenario of scenarios) {
      const size = readFileSync(join(fixtures, scenario, 'stream.bin')).length;
      const chunks = JSON.parse(readFileSync(join(fixtures, scenario, 'chunks.json'), 'utf8')) as Array<{ t: number; offset: number; length: number }>;
      let offset = 0;
      for (const [index, chunk] of chunks.entries()) {
        expect(chunk.offset, `${scenario} chunk ${index} offset`).toBe(offset);
        expect(chunk.length, `${scenario} chunk ${index} length`).toBeGreaterThan(0);
        if (index) expect(chunk.t, `${scenario} chunk ${index} time`).toBeGreaterThanOrEqual(chunks[index - 1]!.t);
        offset += chunk.length;
      }
      expect(offset, `${scenario} coverage`).toBe(size);
    }
  });

  it('use redactions that preserve byte length and display width', () => {
    for (const [from, to] of redactions) {
      expect(Buffer.byteLength(to), `${from} byte length`).toBe(Buffer.byteLength(from));
      expect(displayWidth(to), `${from} display width`).toBe(displayWidth(from));
    }
  });
});
