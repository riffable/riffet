import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecentSearches, readRecentSearches, rememberSearch, removeRecentSearch, reuseRecentSearch } from './recent-searches';

const storageKey = 'riffet.search.recent.v1';
const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
});

afterEach(() => vi.unstubAllGlobals());

describe('recent search storage', () => {
  it('keeps the most recent distinct terms and their search modes', () => {
    for (let index = 1; index <= 9; index++) rememberSearch(`term ${index}`, 'title');
    rememberSearch(' TERM 2 ', 'content');
    rememberSearch('   ', 'title');
    rememberSearch('a'.repeat(201), 'content');

    expect(readRecentSearches().map(({ query }) => query)).toEqual(['TERM 2', 'term 9', 'term 8', 'term 7', 'term 6', 'term 5', 'term 4', 'term 3']);
    expect(readRecentSearches()[0]?.mode).toBe('content');
  });

  it('applies changes to the latest persisted list and clears the stored data on request', () => {
    rememberSearch('deployment', 'content');
    readRecentSearches();
    storage.set(storageKey, JSON.stringify([{ query: 'alerts', mode: 'title' }, { query: 'deployment', mode: 'content' }]));

    expect(removeRecentSearch('deployment')).toEqual([{ query: 'alerts', mode: 'title' }]);
    expect(reuseRecentSearch('deployment')).toEqual({ searches: [{ query: 'alerts', mode: 'title' }] });
    expect(readRecentSearches()).toEqual([{ query: 'alerts', mode: 'title' }]);
    clearRecentSearches();
    expect(reuseRecentSearch('alerts')).toEqual({ searches: [] });
    expect(storage.has(storageKey)).toBe(false);
  });

  it('recovers from unusable stored data', () => {
    storage.set(storageKey, '{broken json');
    expect(readRecentSearches()).toEqual([]);
    expect(rememberSearch('alerts', 'title')).toEqual([{ query: 'alerts', mode: 'title' }]);
  });
});
