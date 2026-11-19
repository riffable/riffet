import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_SCENARIOS, parseRecording, replayRecording, scenarioProblems, stableRows } from './recording.js';

// The transcript and hook channels of the CLI, recorded together by `node --import tsx scripts/record-claude.ts <scenario>`
// against the CLI version their directory names and replayed through the driver. The expected rows and phases sit next
// to each recording and are rewritten with `-u` after a deliberate change or a re-record.

const root = join(import.meta.dirname, 'fixtures', 'transcript-hooks');
const versions = existsSync(root) ? readdirSync(root).sort() : [];

describe('claude transcript and hook recordings', () => {
  it('has a recording for every scenario of the newest recorded CLI version', () => {
    const newest = versions.at(-1);
    expect(newest, 'no recordings: run node --import tsx scripts/record-claude.ts all').toBeDefined();
    const recorded = readdirSync(join(root, newest!)).filter(file => file.endsWith('.jsonl')).map(file => file.slice(0, -'.jsonl'.length));
    expect(recorded.sort()).toEqual(Object.keys(CLAUDE_SCENARIOS).sort());
  });

  for (const version of versions) {
    for (const file of readdirSync(join(root, version)).filter(name => name.endsWith('.jsonl')).sort()) {
      const scenario = file.slice(0, -'.jsonl'.length);
      it(`${version} ${scenario}`, async () => {
        const recording = parseRecording(readFileSync(join(root, version, file), 'utf8'));
        const replay = await replayRecording(recording);
        try {
          expect(scenarioProblems(CLAUDE_SCENARIOS[scenario] ?? { prompts: recording.meta.prompts, approval: recording.meta.approval }, replay)).toEqual([]);
          await expect(JSON.stringify({ phases: replay.phases, ...(replay.stops?.length ? { stops: replay.stops } : {}), rows: stableRows(replay.rows), lanes: Object.fromEntries(Object.entries(replay.lanes).map(([lane, rows]) => [lane, stableRows(rows)])) }, null, 2) + '\n')
            .toMatchFileSnapshot(join(root, version, `${scenario}.rows.json`));
        } finally {
          await replay.dispose();
        }
      });
    }
  }
});
