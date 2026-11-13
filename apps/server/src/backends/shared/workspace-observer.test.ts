import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceObserver } from './workspace-observer.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });

describe('WorkspaceObserver', () => {
  let base: string;
  let project: string;
  let state: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'riffet-observer-'));
    project = join(base, 'project');
    state = join(base, 'state');
    execFileSync('mkdir', ['-p', project]);
    git(project, 'init', '-q');
    await writeFile(join(project, 'a.txt'), 'one\ntwo\nthree\n');
    await writeFile(join(project, '.gitignore'), 'ignored/\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-qm', 'init');
  });

  afterEach(() => rm(base, { recursive: true, force: true }));

  it('reports what a command changed, leaves the project repository alone, and keeps the result', async () => {
    const indexBefore = await readFile(join(project, '.git', 'index'));
    const observer = new WorkspaceObserver(state);
    await observer.begin('call-1', project);
    await writeFile(join(project, 'a.txt'), 'one\nTWO\nthree\n');
    await writeFile(join(project, 'new.txt'), 'fresh\n');
    execFileSync('mkdir', ['-p', join(project, 'ignored')]);
    await writeFile(join(project, 'ignored', 'x.txt'), 'x\n');
    const diffs = await observer.end('call-1');
    expect(diffs?.map(diff => [diff.path, diff.oldText, diff.newText])).toEqual([
      [join(project, 'a.txt'), 'one\ntwo\nthree', 'one\nTWO\nthree'],
      [join(project, 'new.txt'), '', 'fresh'],
    ]);
    expect(diffs?.every(diff => diff.observed)).toBe(true);
    // Before `git status`, which refreshes the index on its own.
    expect(await readFile(join(project, '.git', 'index'))).toEqual(indexBefore);
    expect(git(project, 'status', '--porcelain')).toBe(' M a.txt\n?? new.txt\n');

    observer.record('session', 'call-1', diffs!);
    expect(new WorkspaceObserver(state).changes('session', 'call-1')).toEqual(diffs);
  });

  it('splits changes between overlapping commands, ending in either order, without losing or repeating any', async () => {
    const observer = new WorkspaceObserver(state);
    await observer.begin('outer', project);
    await writeFile(join(project, 'one.txt'), '1\n');
    await observer.begin('inner', project);
    await writeFile(join(project, 'two.txt'), '2\n');
    const inner = await observer.end('inner');
    await writeFile(join(project, 'three.txt'), '3\n');
    const outer = await observer.end('outer');
    expect(inner?.map(diff => diff.path)).toEqual([join(project, 'two.txt')]);
    expect(outer?.map(diff => diff.path)).toEqual([join(project, 'one.txt'), join(project, 'three.txt')]);
  });

  it('observes nothing outside a git working tree', async () => {
    const observer = new WorkspaceObserver(state);
    await observer.begin('plain', base);
    expect(await observer.end('plain')).toBeUndefined();
  });
});
