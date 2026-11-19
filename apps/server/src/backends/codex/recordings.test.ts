import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as codexConfig from './config.js';
import { CODEX_SCENARIOS, hookProblems, parseRecording, recordingHarness, replayFactory, runScenario, stable, stableRows } from './recording.js';
import { lastRolloutCompaction } from './rollout-records.js';
import { parseRolloutPlan } from './rollout-plan.js';
import { parseRolloutContext, parseRolloutUsage } from './rollout-usage.js';
import { projectShareRollout } from './share-read.js';

// Recorded App Server traffic replayed through the driver (docs/guide/aif.md §5.4). Each recording
// was made by `pnpm record codex <scenario>` against the CLI version its directory names; the
// expected rows sit next to it and are rewritten with `-u` after a deliberate change or a re-record.

const root = join(import.meta.dirname, 'fixtures/app-server');
const versions = existsSync(root) ? readdirSync(root).sort() : [];
const rolloutRoot = join(import.meta.dirname, 'fixtures/rollout');
const rolloutVersions = existsSync(rolloutRoot) ? readdirSync(rolloutRoot).sort() : [];

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
          await runScenario(h, CODEX_SCENARIOS[scenario] ?? { prompts: recording.meta.prompts, approval: recording.meta.approval }, { replay });
          await expect(JSON.stringify(stableRows(await h.rows()), null, 2) + '\n')
            .toMatchFileSnapshot(join(root, version, `${scenario}.rows.json`));
          // The hook channel, recorded alongside: what observation.ts relies on still holds.
          expect(hookProblems(recording)).toEqual([]);
        } finally {
          await h.dispose();
        }
      });
    }
  }
});

// The rollout file the CLI wrote during the same recording, read by the parsers that work on it.
describe('codex rollout recordings', () => {
  it('has a rollout for every scenario of the newest recorded CLI version', () => {
    const newest = rolloutVersions.at(-1);
    expect(newest, 'no rollout recordings: run pnpm record codex all').toBeDefined();
    const recorded = readdirSync(join(rolloutRoot, newest!)).filter(file => file.endsWith('.jsonl')).map(file => file.slice(0, -'.jsonl'.length));
    expect(recorded.sort()).toEqual(Object.keys(CODEX_SCENARIOS).sort());
  });

  for (const version of rolloutVersions) {
    for (const file of readdirSync(join(rolloutRoot, version)).filter(name => name.endsWith('.jsonl')).sort()) {
      const scenario = file.slice(0, -'.jsonl'.length);
      it(`${version} ${scenario}`, async () => {
        const content = readFileSync(join(rolloutRoot, version, file), 'utf8');
        const meta = JSON.parse(content.split('\n')[0]!) as { type?: string; payload?: { id?: string } };
        const threadId = meta.type === 'session_meta' ? String(meta.payload?.id) : 'thread';
        const parsed = {
          usage: parseRolloutUsage(content, threadId, true),
          context: parseRolloutContext(content) ?? null,
          plan: parseRolloutPlan(content) ?? null,
          compaction: lastRolloutCompaction(content) ?? null,
          share: projectShareRollout(content, 'recording-session', threadId),
        };
        await expect(JSON.stringify(stable(parsed), null, 2) + '\n')
          .toMatchFileSnapshot(join(rolloutRoot, version, `${scenario}.parsed.json`));
      });
    }
  }
});
