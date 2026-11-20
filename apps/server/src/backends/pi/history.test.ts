import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findPiTranscript, forkPiTranscript, readPiTranscript } from './history.js';

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

  it('forks a pi session JSONL cleanly and truncates through a target turn when requested', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-pi-fork-'));
    dirs.push(dir);
    const sessions = join(dir, 'sessions');
    const sourceRepo = join(dir, 'repo-a');
    const targetRepo = join(dir, 'repo-b');
    mkdirSync(sessions, { recursive: true });
    mkdirSync(sourceRepo, { recursive: true });
    mkdirSync(targetRepo, { recursive: true });
    process.env.PI_CODING_AGENT_SESSION_DIR = sessions;

    const entries = [
      { type: 'session', version: 3, id: 'pi-src', timestamp: '2026-10-12T00:00:00.000Z', cwd: sourceRepo },
      { id: 'u1', parentId: null, type: 'message', timestamp: '2026-10-12T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'first turn' }] } },
      { id: 'a1', parentId: 'u1', type: 'message', timestamp: '2026-10-12T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } },
      { id: 'u2', parentId: 'a1', type: 'message', timestamp: '2026-10-12T00:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: 'second turn' }] } },
      { id: 'a2', parentId: 'u2', type: 'message', timestamp: '2026-10-12T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'second reply' }] } },
    ];
    writeFileSync(join(sessions, '2026-10-12T00-00-00-000Z_pi-src.jsonl'), entries.map(item => JSON.stringify(item)).join('\n') + '\n');

    const fullFork = await forkPiTranscript('pi-src', sourceRepo, targetRepo);
    expect(fullFork).toBeDefined();
    const fullRead = await readPiTranscript(fullFork!.path, fullFork!.nativeSessionId);
    expect(fullRead.chain.map(entry => entry.id)).toEqual(['u1', 'a1', 'u2', 'a2']);

    const midFork = await forkPiTranscript('pi-src', sourceRepo, targetRepo, { upToNativeTurnId: 'u1' });
    expect(midFork).toBeDefined();
    const midRead = await readPiTranscript(midFork!.path, midFork!.nativeSessionId);
    expect(midRead.chain.map(entry => entry.id)).toEqual(['u1', 'a1']);
    await expect(findPiTranscript(midFork!.nativeSessionId, targetRepo)).resolves.toBe(midFork!.path);
  });
});
