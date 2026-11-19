import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as codexConfig from './config.js';
import { CODEX_SCENARIOS, parseRecording, recordingHarness, replayFactory, stableRows } from './recording.js';

// Recorded App Server traffic replayed through the driver (docs/guide/aif.md §5.4). Each recording
// was made by `pnpm record codex <scenario>` against the CLI version its directory names; the
// expected rows sit next to it and are rewritten with `-u` after a deliberate change or a re-record.

const root = join(import.meta.dirname, 'fixtures/app-server');
const versions = existsSync(root) ? readdirSync(root).sort() : [];

afterEach(() => { vi.restoreAllMocks(); });

describe('codex app-server recordings', () => {
  it('has a recording for every scenario of the newest recorded CLI version', () => {
    const newest = versions.at(-1);
    expect(newest, 'no recordings: run pnpm record codex all').toBeDefined();
    const recorded = readdirSync(join(root, newest!)).filter(file => file.endsWith('.jsonl')).map(file => file.slice(0, -'.jsonl'.length));
    expect(recorded.sort()).toEqual(Object.keys(CODEX_SCENARIOS).sort());
  });

  for (const version of versions) {
    for (const file of readdirSync(join(root, version)).filter(name => name.endsWith('.jsonl')).sort()) {
      const scenario = file.slice(0, -'.jsonl'.length);
      it(`${version} ${scenario}`, async () => {
        const recording = parseRecording(readFileSync(join(root, version, file), 'utf8'));
        vi.spyOn(codexConfig, 'probeAppServer').mockResolvedValue(recording.meta.probe);
        const replay = replayFactory(recording);
        const h = recordingHarness({ factory: replay.factory, cwd: '/workspace/project', executable: 'codex', approval: recording.meta.approval });
        try {
          for (const prompt of recording.meta.prompts) {
            await h.send(prompt);
            await h.idle(5_000, replay.drained);
          }
          await expect(JSON.stringify(stableRows(await h.rows()), null, 2) + '\n')
            .toMatchFileSnapshot(join(root, version, `${scenario}.rows.json`));
        } finally {
          await h.dispose();
        }
      });
    }
  }
});
