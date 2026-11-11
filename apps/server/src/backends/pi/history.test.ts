import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findPiTranscript } from './history.js';

const dirs: string[] = [];
const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
});

describe('pi transcript location', () => {
  it('reads the session-dir override before the profile agent directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-pi-history-'));
    dirs.push(dir);
    const sessions = join(dir, 'env-sessions');
    const agent = join(dir, 'agent');
    mkdirSync(sessions, { recursive: true });
    mkdirSync(join(agent, 'sessions'), { recursive: true });
    const file = join(sessions, '2026-10-12T00-00-00-000Z_s1.jsonl');
    writeFileSync(file, `${JSON.stringify({
      type: 'session', version: 3, id: 's1', timestamp: '2026-10-12T00:00:00.000Z', cwd: '/repo',
    })}\n`);
    const agentFile = join(agent, 'sessions', '2026-10-12T00-00-00-000Z_s1.jsonl');
    writeFileSync(agentFile, `${JSON.stringify({
      type: 'session', version: 3, id: 's1', timestamp: '2026-10-12T00:00:00.000Z', cwd: '/repo',
    })}\n`);

    process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
    await expect(findPiTranscript('s1', '/repo', agent)).resolves.toBe(file);
  });
});
