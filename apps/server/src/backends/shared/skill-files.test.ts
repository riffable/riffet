import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { frontMatter, scanCommandRoots, scanSkillRoots } from './skill-files.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-files-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('frontMatter', () => {
  it('reads flat keys, quoted values and folded descriptions', () => {
    expect(frontMatter('---\nname: "chart"\ndescription: >\n  Draws charts\n  of any kind\nuser-invocable: false\n---\nbody')).toEqual({
      name: 'chart', description: 'Draws charts of any kind', 'user-invocable': 'false',
    });
    expect(frontMatter('no header')).toEqual({});
  });
});

describe('scanSkillRoots', () => {
  it('lists skills in root order with the first root winning a name, and honours user-invocable', async () => {
    const project = tree({
      'skills/chart/SKILL.md': '---\nname: chart\ndescription: Project chart\n---\n',
      'skills/nested/deeper/SKILL.md': '---\ndescription: Named after its directory\n---\n',
      'skills/hidden/SKILL.md': '---\nname: hidden\nuser-invocable: false\n---\n',
    });
    const user = tree({ 'skills/chart/SKILL.md': '---\nname: chart\ndescription: User chart\n---\n', 'skills/extra/SKILL.md': '---\nname: extra\n---\n' });
    const items = await scanSkillRoots([join(project, 'skills'), join(user, 'skills'), join(user, 'missing')]);
    expect(items.map(item => [item.name, item.description])).toEqual([
      ['chart', 'Project chart'], ['deeper', 'Named after its directory'], ['extra', undefined],
    ]);
    expect(items[0]).toMatchObject({ kind: 'skill', path: join(project, 'skills/chart/SKILL.md') });
  });

  it('follows a symlinked skill directory', async () => {
    const shared = tree({ 'linked/SKILL.md': '---\nname: linked\n---\n' });
    const root = tree({});
    mkdirSync(join(root, 'skills'));
    symlinkSync(join(shared, 'linked'), join(root, 'skills', 'linked'));
    expect((await scanSkillRoots([join(root, 'skills')])).map(item => item.name)).toEqual(['linked']);
  });
});

describe('scanCommandRoots', () => {
  it('names top-level markdown commands by file and reads their hint', async () => {
    const root = tree({ 'commands/ship.md': '---\ndescription: Ship it\nargument-hint: <branch>\n---\n', 'commands/sub/skip.md': 'x', 'commands/notes.txt': 'x' });
    expect(await scanCommandRoots([join(root, 'commands')])).toEqual([
      { name: 'ship', kind: 'command', path: join(root, 'commands/ship.md'), description: 'Ship it', hint: '<branch>' },
    ]);
  });
});
