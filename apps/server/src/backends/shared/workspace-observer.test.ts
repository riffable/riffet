import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readsOnly, WorkspaceObserver } from './workspace-observer.js';

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
    await observer.begin('outer', project, 'pnpm gen');
    await writeFile(join(project, 'one.txt'), '1\n');
    await observer.begin('inner', project, 'touch two.txt');
    await writeFile(join(project, 'two.txt'), '2\n');
    const inner = await observer.end('inner');
    await writeFile(join(project, 'three.txt'), '3\n');
    const outer = await observer.end('outer');
    expect(inner?.map(diff => diff.path)).toEqual([join(project, 'two.txt')]);
    expect(outer?.map(diff => diff.path)).toEqual([join(project, 'one.txt'), join(project, 'three.txt')]);
  });

  it('gives a file changed beside several commands to the one that names it, and to none when none does', async () => {
    const observer = new WorkspaceObserver(state);
    await observer.begin('writer', project, "python3 - <<'EOF'\nopen('docs/plan.md','w').write('x')\nEOF");
    await observer.begin('other', project, 'pnpm build');
    execFileSync('mkdir', ['-p', join(project, 'docs')]);
    await writeFile(join(project, 'docs', 'plan.md'), 'plan\n');
    await writeFile(join(project, 'stray.txt'), 'stray\n');
    // The command that names nothing ends first: it takes neither file, and the one it does not name waits for its writer.
    expect(await observer.end('other')).toEqual([]);
    await writeFile(join(project, 'late.txt'), 'late\n');
    expect((await observer.end('writer'))?.map(diff => diff.path)).toEqual([join(project, 'docs', 'plan.md'), join(project, 'late.txt')]);
  });

  it('observes nothing outside a git working tree', async () => {
    const observer = new WorkspaceObserver(state);
    await observer.begin('plain', base);
    expect(await observer.end('plain')).toBeUndefined();
  });

  it('prunes orphaned change logs and shadow repos of deleted git repositories while keeping active ones', async () => {
    const observer = new WorkspaceObserver(state);
    await observer.begin('c1', project);
    await writeFile(join(project, 'a.txt'), 'changed\n');
    const diffs = await observer.end('c1');
    observer.record('live-session', 'c1', diffs!);
    observer.record('dead-session', 'c1', diffs!);

    // Remove the origin repo so its shadow repo becomes orphaned after the age gate.
    await rm(project, { recursive: true, force: true });
    const stats = await observer.maintain(new Set(['live-session']), { minAgeMs: 0, nowMs: Date.now() + 10_000 });
    expect(stats.prunedChanges).toBe(1);
    expect(stats.prunedRepos).toBe(1);
    expect(new WorkspaceObserver(state).changes('live-session', 'c1')).toEqual(diffs);
    expect(new WorkspaceObserver(state).changes('dead-session', 'c1')).toBeUndefined();
  });
});

describe('readsOnly', () => {
  it('leaves only commands that cannot write the working tree unobserved', () => {
    const reads = [
      'git diff -U0 -- a.swift b.kt | grep "^[+-]" | grep -v "^+++\\|^---" | cut -c1-170',
      'cd apps/web && git -C . --no-pager log --oneline -5 2>/dev/null || true',
      "sed -n '1,40p' src/a.ts", 'rg -n "foo|bar" src 2>&1 | head', 'find . -name "*.ts" | wc -l',
      "GIT_PAGER=cat git show HEAD:README.md | awk '{print $1}'",
      'ps aux | grep -E "rm -rf|agent" | grep -v grep && ls -la ~/.x 2>/dev/null || echo "gone"', 'launchctl list | grep x', 'top -l 1 | head',
    ];
    const writes = [
      'git diff > out.patch', 'sed -i "" s/a/b/ f', 'sed "s/a/b/w out" f', 'cat a | tee b', 'echo $(touch x)', 'echo `touch x`',
      'git commit -m x', 'git diff --output=x', 'find . -delete', 'sort -o f f', 'uniq in out', 'npm test',
      `awk '{ print > "f" }' a`, 'cat <<EOF > f\nx\nEOF', 'ls &', 'ls; rm -rf x', 'bash -c "ls"', '(ls)', 'echo "x', 'rg --pre ./x foo', 'X=1 Y=2',
      'top', 'sysctl -w a=1', 'launchctl unload x.plist',
    ];
    expect(reads.filter(command => !readsOnly(command))).toEqual([]);
    expect(writes.filter(command => readsOnly(command))).toEqual([]);
  });
});
