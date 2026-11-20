import { afterEach, describe, expect, it } from 'vitest';
import type { TitleRule } from '../../../../packages/contracts/src/index.js';
import { Store } from '../store.js';

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function setup(rules: TitleRule[]) {
  const store = new Store(':memory:');
  stores.push(store);
  let current = rules;
  store.configureTitleRules(() => ({ rules: current, timeZone: 'UTC' }));
  return { store, setRules: (next: TitleRule[]) => { current = next; return store.refreshDisplayTitles(); } };
}

/** 会话标题规则 (docs/SESSION-TITLES.md): `displayTitle` is derived in the store, and the stored title is never rewritten. */
describe('session title rules', () => {
  it('derives the display title from the stored one and ignores what a writer passes for it', () => {
    const { store } = setup([{ id: 'work', match: { directories: ['/srv/work'] }, template: '[{{project}}] {{title}}' }]);
    const inside = store.createProject('/srv/work/api', 'api');
    const outside = store.createProject('/srv/other', 'other');
    const created = store.createSession({ projectId: inside.id, kind: 'native', displayTitle: 'forged' });
    expect(created).toMatchObject({ title: 'New conversation', displayTitle: '[api] New conversation' });
    const named = store.updateSession(created.id, { title: 'Fix login', titleSource: 'prompt' });
    expect(named).toMatchObject({ title: 'Fix login', displayTitle: '[api] Fix login' });
    expect(store.updateSession(named.id, { title: 'Fix logout', displayTitle: 'forged' })).toMatchObject({ title: 'Fix logout', displayTitle: '[api] Fix logout' });
    expect(store.createSession({ projectId: outside.id, kind: 'native' }).displayTitle).toBeUndefined();
  });

  it('leaves a title the owner typed alone unless the rule covers every title', () => {
    const { store, setRules } = setup([{ id: 'auto', match: {}, template: 'fixed' }]);
    const project = store.createProject('/srv/work', 'work');
    const typed = store.createSession({ projectId: project.id, kind: 'native', title: 'Mine' });
    expect(typed.titleSource).toBe('user');
    expect(typed.displayTitle).toBeUndefined();
    expect(setRules([{ id: 'all', match: {}, template: 'fixed', scope: 'all' }])).toBe(1);
    expect(store.getSession(typed.id)).toMatchObject({ title: 'Mine', displayTitle: 'fixed' });
    expect(setRules([])).toBe(1);
    expect(store.getSession(typed.id).displayTitle).toBeUndefined();
  });

  it('matches a worktree by the directory of the project it came from', () => {
    const { store } = setup([{ id: 'work', match: { directories: ['/srv/work'] }, template: '{{project}}: {{title}}' }]);
    const origin = store.createProject('/srv/work/api', 'api');
    const worktree = store.createProject('/tmp/worktrees/api-x', 'api (x)', { originProjectId: origin.id, branch: 'x' });
    expect(store.createSession({ projectId: worktree.id, kind: 'native' }).displayTitle).toBe('api: New conversation');
  });

  it('never renames the 助理\'s conversations', () => {
    const { store } = setup([{ id: 'all', match: {}, template: 'fixed', scope: 'all' }]);
    const project = store.createProject('/srv/assistant', 'assistant');
    store.updateProject(project.id, { system: 'assistant' });
    expect(store.createSession({ projectId: project.id, kind: 'native' }).displayTitle).toBeUndefined();
  });
});
