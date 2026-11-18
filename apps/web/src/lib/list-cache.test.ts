import { describe,expect,it } from 'vitest';
import type { Bootstrap } from './api';
import { boundedLists, parseCachedLists,serializeCachedLists } from './list-cache';

const bootstrap = (overrides: Partial<Bootstrap> = {}): Bootstrap => ({
  projects: [{ id: 'project-1' }],
  sessions: [{ id: 'session-1' }],
  terminals: [],
  settings: { defaultBackendId: 'codex' },
  csrfToken: 'live-token',
  ...overrides,
} as unknown as Bootstrap);

describe('list cache', () => {

  it('never writes the CSRF token to disk, and hands back an empty one to be replaced', () => {
    const raw = serializeCachedLists(bootstrap(), 1);
    expect(raw).not.toContain('live-token');
    expect(parseCachedLists(raw)?.bootstrap.csrfToken).toBe('');
  });

  it('preserves negotiated task capabilities through an offline reload', () => {
    const protocol = { version: 3, features: ['projectless-tasks'] };
    const cached = parseCachedLists(serializeCachedLists(bootstrap({ protocol }), 1));
    expect(cached?.bootstrap.protocol).toEqual(protocol);
  });

  it('drops malformed or absent storage instead of failing startup', () => {
    expect(parseCachedLists('{not json')).toBeUndefined();
    expect(parseCachedLists('')).toBeUndefined();
    expect(parseCachedLists('null')).toBeUndefined();
  });

  it('keeps open and session-linked work item summaries across reloads', () => {
    const data = bootstrap({
      sessions: [{ id: 'session-1', workItemId: 'w-done-linked' }] as Bootstrap['sessions'],
      workItemSummaries: [
        { id: 'w-doing', number: 1, status: 'doing' },
        { id: 'w-done-linked', number: 2, status: 'done' },
        { id: 'w-done-orphan', number: 3, status: 'done' },
      ],
    });
    const bounded = boundedLists(data);
    expect(bounded.workItemSummaries).toEqual([
      { id: 'w-doing', number: 1, status: 'doing' },
      { id: 'w-done-linked', number: 2, status: 'done' },
    ]);
    expect(parseCachedLists(serializeCachedLists(bounded, 1))?.bootstrap.workItemSummaries).toEqual(bounded.workItemSummaries);
  });
});
