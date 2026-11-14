import { readStatsSearch, writeStatsSearch, type StatsUiState } from '@/lib/stats-query';

/**
 * The pages with an address of their own. A page covers the conversation, so its address does not
 * name one: a reload restores the conversation underneath from the stored selection.
 */
const PAGES = ['tasks', 'marks', 'stats', 'extensions', 'plugins', 'design'] as const;
export type AddressPage = (typeof PAGES)[number];

/**
 * What the address bar says, read once at startup and mirrored with `replaceState`:
 *
 * - `/c/<sessionId>`: a conversation; its project comes with it. `?mark=<markId>` locates a 收藏.
 * - `/p/<projectId>`: a project's new-conversation page.
 * - `/tasks`, `/marks`, `/extensions`, `/design`, `/stats?range=…`, `/plugins?id=<pluginId>`.
 *
 * Plugin ids always contain a dot, and the server answers a path with an extension as a file, so
 * the id is a query parameter rather than a path segment.
 */
export interface PageAddress {
  page?: AddressPage;
  sessionId?: string;
  projectId?: string;
  markId?: string;
  pluginId?: string;
  stats: StatsUiState;
}

export function readPageAddress(location: Pick<Location, 'pathname' | 'search'>): PageAddress {
  const [head, id] = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const search = new URLSearchParams(location.search);
  const address: PageAddress = { stats: readStatsSearch(location.search) };
  if (head === 'c' && id) {
    address.sessionId = id;
    const markId = search.get('mark');
    if (markId) address.markId = markId;
  } else if (head === 'p' && id) address.projectId = id;
  else if ((PAGES as readonly string[]).includes(head ?? '')) {
    address.page = head as AddressPage;
    const pluginId = head === 'plugins' ? search.get('id') : undefined;
    if (pluginId) address.pluginId = pluginId;
  }
  return address;
}

export function pageAddressUrl(address: Required<Pick<PageAddress, 'sessionId' | 'projectId' | 'pluginId' | 'stats'>> & Pick<PageAddress, 'page'>): string {
  const { page, sessionId, projectId, pluginId, stats } = address;
  if (page === 'plugins') return pluginId ? `/plugins?${new URLSearchParams({ id: pluginId })}` : '/plugins';
  if (page === 'stats') return `/stats${writeStatsSearch(stats)}`;
  if (page) return `/${page}`;
  if (sessionId) return `/c/${encodeURIComponent(sessionId)}`;
  if (projectId) return `/p/${encodeURIComponent(projectId)}`;
  return '/';
}
