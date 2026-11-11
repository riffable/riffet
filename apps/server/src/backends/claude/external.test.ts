import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { scanClaudeSessions } from './external.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (text: string, entrypoint = 'cli') => ({ type: 'user', cwd: '/work/a', gitBranch: 'main', entrypoint, message: { role: 'user', content: text } });

it('lists interactive sessions with the last rename as title and skips subagents, empty and sdk runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-external-'));
  roots.push(root);
  const project = join(root, 'projects', '-work-a');
  mkdirSync(join(project, ID(1), 'subagents'), { recursive: true });
  const write = (file: string, rows: unknown[]) => writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  write(join(project, `${ID(1)}.jsonl`), [user('fix the build'), { type: 'ai-title', aiTitle: 'Build fix' }, { type: 'custom-title', customTitle: 'Old' }, 'torn', { type: 'custom-title', customTitle: 'Renamed' }]);
  write(join(project, ID(1), 'subagents', `${ID(9)}.jsonl`), [user('subagent prompt')]);
  write(join(project, `${ID(2)}.jsonl`), [{ type: 'user', cwd: '/work/a', isMeta: true, message: { content: 'Caveat: x' } }]);
  write(join(project, `${ID(3)}.jsonl`), [user('print mode', 'sdk-cli')]);

  const options = { limit: 10, signal: new AbortController().signal };
  const interactive = await scanClaudeSessions(root, { ...options, includeNonInteractive: false });
  expect(interactive.map(entry => [entry.nativeSessionId, entry.title, entry.preview, entry.source])).toEqual([[ID(1), 'Renamed', 'fix the build', 'cli']]);
  const all = await scanClaudeSessions(root, { ...options, includeNonInteractive: true });
  expect(all.map(entry => entry.nativeSessionId).sort()).toEqual([ID(1), ID(3)]);
});
