import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODE_INDEX_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { CodeNav, findDefinitions, findReferences } from './code-nav.js';
import { FileIndex } from './file-index.js';
import { WorkspaceService } from './index.js';
import { SymbolIndexes } from './symbols/indexes.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await sleep(50); }

describe('code index', () => {
  it('builds, answers, updates incrementally and outlines a file', async () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'riffet-symbols-')));
    dirs.push(base);
    const root = path.join(base, 'project');
    mkdirSync(path.join(root, 'app/feed'), { recursive: true });
    writeFileSync(path.join(root, 'app/feed/FeedFragment.kt'), 'package a.feed\nimport a.base.Base\nclass FeedFragment : Base() {\n  fun onCreate() {}\n  companion object { const val TAG = "x" }\n}\n');
    writeFileSync(path.join(root, 'app/feed/Base.java'), 'package a.base;\npublic class Base { void onCreate() {} }\n');
    mkdirSync(path.join(root, 'app/res/layout'), { recursive: true });
    mkdirSync(path.join(root, 'app/res/values'), { recursive: true });
    mkdirSync(path.join(root, 'app/res/values-night'), { recursive: true });
    writeFileSync(path.join(root, 'app/res/layout/feed.xml'), '<LinearLayout xmlns:android="x">\n  <TextView android:id="@+id/title" android:text="@string/app_name" />\n</LinearLayout>\n');
    writeFileSync(path.join(root, 'app/res/values/strings.xml'), '<resources>\n  <string name="app_name">A</string>\n  <style name="Theme.App"><item name="android:x">1</item></style>\n</resources>\n');
    writeFileSync(path.join(root, 'app/res/values-night/strings.xml'), '<resources>\n  <string name="app_name">B</string>\n</resources>\n');
    writeFileSync(path.join(root, 'app/feed/User.kt'), 'package a.feed\nclass User(val zanyField: Int) {\n  fun render() = R.layout.feed + R.string.app_name + R.id.title\n  fun other() = android.R.string.ok\n}\n');
    mkdirSync(path.join(root, 'other'), { recursive: true });
    writeFileSync(path.join(root, 'other/Caller.kt'), 'package a.other\nfun call(x: Any) { x.hashCode() }\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], { cwd: root });
    const files = new FileIndex();
    const indexes = new SymbolIndexes({ stateDir: path.join(base, 'state'), paths: dir => files.paths(dir), untracked: dir => files.untracked(dir) }, { ...CODE_INDEX_BUDGET, changedTtlMs: 0 });
    try {
      // Asking builds nothing; a watch builds, and dropping it stops the build where it is.
      expect(indexes.search(root, 'FeedFragment', { types: true, limit: 10 })).toMatchObject({ items: [], index: { state: 'idle' } });
      indexes.watch(root, 'page', true);
      indexes.watch(root, 'page', false);
      await sleep(500);
      expect(indexes.status(root).state).toBe('idle');
      // Another page still watching keeps it going.
      indexes.watch(root, 'page', true);
      indexes.watch(root, 'other', true);
      indexes.watch(root, 'page', false);
      await sleep(300);
      expect(indexes.status(root).state).not.toBe('idle');
      await until(() => indexes.status(root).state === 'ready');
      expect(indexes.status(root)).toMatchObject({ state: 'ready', files: 7 });

      const top = (q: string, types = false) => indexes.search(root, q, { types, limit: 10 }).items;
      expect(top('FeedFragment', true)[0]).toMatchObject({ name: 'FeedFragment', kind: 'class', path: 'app/feed/FeedFragment.kt', line: 3, package: 'a.feed' });
      expect(top('ff', true)[0]?.name).toBe('FeedFragment');
      expect(top('oncreate').map(item => item.path).sort()).toEqual(['app/feed/Base.java', 'app/feed/FeedFragment.kt']);
      expect(top('fee', true).map(item => item.name)).toEqual(['FeedFragment']);

      // A member is searched through the word index, not the project: only files that contain the word are read.
      const nav = new CodeNav(root, () => files.paths(root), undefined, indexes);
      const uses = (word: string) => findReferences(nav, { path: path.join(root, 'app/feed/Base.java'), word, scope: 'project' }).then(r => ({ ...r, paths: r.locations.map(item => item.path).sort() }));
      expect(await uses('onCreate')).toMatchObject({ complete: true, paths: ['app/feed/Base.java', 'app/feed/FeedFragment.kt'] });
      expect(await uses('zanyField')).toMatchObject({ complete: true, paths: ['app/feed/User.kt'] });
      expect((await uses('noSuchMember')).locations).toEqual([]);

      // Files edited after the index's last check are read too: a method added to Base.java and called from Caller.kt is found before any recheck.
      writeFileSync(path.join(root, 'app/feed/Base.java'), 'package a.base;\npublic class Base {\n  void onCreate() {}\n  void brandNew() {}\n}\n');
      writeFileSync(path.join(root, 'other/Caller.kt'), 'package a.other\nfun call(x: Any) { x.hashCode(); brandNew() }\n');
      expect(await uses('brandNew')).toMatchObject({ complete: true, paths: ['app/feed/Base.java', 'other/Caller.kt'] });
      const callerLine = 'fun call(x: Any) { x.hashCode(); brandNew() }';
      const fresh = await findDefinitions(nav, { path: path.join(root, 'other/Caller.kt'), line: 2, column: callerLine.indexOf('brandNew') + 1, word: 'brandNew' });
      expect(fresh.locations.map(item => `${item.path}:${item.line}`)).toEqual(['app/feed/Base.java:4']);
      writeFileSync(path.join(root, 'app/feed/Base.java'), 'package a.base;\npublic class Base { void onCreate() {} }\n');
      writeFileSync(path.join(root, 'other/Caller.kt'), 'package a.other\nfun call(x: Any) { x.hashCode() }\n');

      // Android resources: code and layouts jump to the file or the value, the default directory first.
      const jump = (file: string, needle: string, word: string) => {
        const rows = readFileSync(path.join(root, file), 'utf8').split('\n');
        const row = rows.findIndex(text => text.includes(needle));
        const column = rows[row]!.indexOf(needle) + needle.lastIndexOf(word) + 1;
        return findDefinitions(nav, { path: path.join(root, file), line: row + 1, column, word }).then(r => r.locations.map(item => `${item.path}:${item.line}`));
      };
      expect(await jump('app/feed/User.kt', 'R.layout.feed', 'feed')).toEqual(['app/res/layout/feed.xml:1']);
      expect(await jump('app/feed/User.kt', 'R.string.app_name', 'app_name')).toEqual(['app/res/values/strings.xml:2', 'app/res/values-night/strings.xml:2']);
      expect(await jump('app/feed/User.kt', 'R.id.title', 'title')).toEqual(['app/res/layout/feed.xml:2']);
      expect(await jump('app/feed/User.kt', 'android.R.string.ok', 'ok')).toEqual([]);
      expect(await jump('app/res/layout/feed.xml', '@string/app_name', 'app_name')).toEqual(['app/res/values/strings.xml:2', 'app/res/values-night/strings.xml:2']);

      // A changed file is read again, a new one added.
      await sleep(20);
      writeFileSync(path.join(root, 'app/feed/Base.java'), 'package a.base;\npublic class Base { void onCreate() {} void renamed() {} }\n');
      writeFileSync(path.join(root, 'app/feed/Extra.kt'), 'package a.feed\nobject Extra\n');
      execFileSync('git', ['add', '-A'], { cwd: root });
      indexes.rebuild(root);
      await until(() => indexes.status(root).files === 8 && indexes.status(root).done === 8);
      await until(() => top('renamed').length > 0);
      expect(top('renamed')[0]).toMatchObject({ kind: 'function', container: 'Base' });
      expect(top('Extra', true)[0]?.kind).toBe('object');
      // The changed file's new word is found by the next search, and a rebuilt index keeps its words.
      writeFileSync(path.join(root, 'app/feed/Base.java'), 'package a.base;\npublic class Base { void onCreate() {} void renamed() {} void freshlyAdded() { renamed(); } }\n');
      indexes.rebuild(root);
      await until(() => indexes.wordFiles(root, 'freshlyAdded', '')?.length === 1);
      expect(await uses('freshlyAdded')).toMatchObject({ paths: ['app/feed/Base.java'] });

      const outline = await indexes.outline(path.join(root, 'app/feed/FeedFragment.kt'), 'app/feed/FeedFragment.kt');
      expect(outline.package).toBe('a.feed');
      expect(outline.items).toMatchObject([{ name: 'FeedFragment', kind: 'class', children: [{ name: 'onCreate', kind: 'function' }, { name: 'Companion', kind: 'object', children: [{ name: 'TAG' }] }] }]);

    } finally { await indexes.close(); }
  }, 30_000);

  it('answers a whole-word search from the word index, case-insensitively, including files changed since the last check', async () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'riffet-wordsearch-')));
    dirs.push(base);
    const root = path.join(base, 'project');
    mkdirSync(path.join(root, 'app'), { recursive: true });
    writeFileSync(path.join(root, 'app/A.kt'), 'class A { val mFollowType = 1\n val mFollowTypes = 2 }\n');
    writeFileSync(path.join(root, 'app/B.kt'), 'class B { fun other() {} }\n');
    writeFileSync(path.join(root, 'notes.md'), 'mFollowType in docs\n');
    writeFileSync(path.join(root, 'app/C.kt'), 'fun s() = "$templated"\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], { cwd: root });
    const workspace = new WorkspaceService({ stateDir: path.join(base, 'state') });
    try {
      await workspace.watchCodeIndex(root, 'page', true);
      await until(() => (workspace as unknown as { symbols: SymbolIndexes }).symbols.status(root).state === 'ready');
      const find = async (q: string, extra: object = {}) => (await workspace.search(root, { q, word: true, include: '*.kt,*.java', ...extra })).hits.map(hit => `${hit.path}:${hit.line}`);
      expect(await find('mfollowtype')).toEqual(['app/A.kt:1']);
      expect(await find('mfollowtype', { caseSensitive: true })).toEqual([]);
      // A word inside a Kotlin string template is a word on its own, as ripgrep's -w sees it.
      expect(await find('templated')).toEqual(['app/C.kt:1']);
      writeFileSync(path.join(root, 'app/B.kt'), 'class B { fun other() = MFOLLOWTYPE }\n');
      await sleep(CODE_INDEX_BUDGET.changedTtlMs + 200);
      expect(await find('mFollowType', { caseSensitive: true })).toEqual(['app/A.kt:1']);
      expect(await find('MFOLLOWTYPE', { caseSensitive: true })).toEqual(['app/B.kt:1']);
      expect((await find('mfollowtype')).sort()).toEqual(['app/A.kt:1', 'app/B.kt:1']);
    } finally { await workspace.close(); }
  }, 30_000);
});
