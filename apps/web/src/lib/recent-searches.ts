import { records, readStored, writeStored } from './utils';

export type SearchMode = 'title' | 'content';

export interface RecentSearch {
  query: string;
  mode: SearchMode;
}

export const RECENT_SEARCHES_KEY = 'riffet.search.recent.v1';
const MAX_ENTRIES = 8;
const MAX_QUERY_LENGTH = 200; // Matches the message search endpoint's query limit.

export function readRecentSearches(): RecentSearch[] {
  try {
    const entries = records(JSON.parse(readStored(RECENT_SEARCHES_KEY) || '[]'));
    const searches: RecentSearch[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (typeof entry.query !== 'string' || (entry.mode !== 'title' && entry.mode !== 'content')) continue;
      const query = entry.query.trim();
      const key = query.toLowerCase();
      if (!query || query.length > MAX_QUERY_LENGTH || seen.has(key)) continue;
      searches.push({ query, mode: entry.mode });
      seen.add(key);
      if (searches.length === MAX_ENTRIES) break;
    }
    return searches;
  } catch { return []; }
}

export function rememberSearch(query: string, mode: SearchMode): RecentSearch[] {
  // Read again when saving so a tab with an older list keeps changes from other tabs.
  const searches = readRecentSearches();
  const term = query.trim();
  if (!term || term.length > MAX_QUERY_LENGTH) return searches;
  const key = term.toLowerCase();
  return save([{ query: term, mode }, ...searches.filter(search => search.query.toLowerCase() !== key)].slice(0, MAX_ENTRIES));
}

export function removeRecentSearch(query: string): RecentSearch[] {
  const key = query.trim().toLowerCase();
  return save(readRecentSearches().filter(search => search.query.toLowerCase() !== key));
}

/** A chip from another tab may already have been removed or saved with a different mode. */
export function reuseRecentSearch(query: string): { searches: RecentSearch[]; entry?: RecentSearch } {
  const searches = readRecentSearches();
  const key = query.toLowerCase();
  const entry = searches.find(item => item.query.toLowerCase() === key);
  if (!entry) return { searches };
  if (entry === searches[0]) return { searches, entry };
  return { searches: save([entry, ...searches.filter(item => item !== entry)]), entry };
}

export function clearRecentSearches(): void {
  writeStored(RECENT_SEARCHES_KEY, undefined);
}

function save(searches: RecentSearch[]): RecentSearch[] {
  writeStored(RECENT_SEARCHES_KEY, searches.length ? JSON.stringify(searches) : undefined);
  return searches;
}
