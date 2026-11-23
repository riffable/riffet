import { readStatsSearch, writeStatsSearch, type StatsUiState } from '@/lib/stats-query';

/** The design page's platforms: the shared system and the web's components, or how the Mac or Android draws them. */
export const DESIGN_PLATFORMS = ['web', 'macos', 'android'] as const;
export type DesignPlatform = (typeof DESIGN_PLATFORMS)[number];

/**
 * The pages with an address of their own. A page covers the conversation, so its address does not
 * name one: a reload restores the conversation underneath from the stored selection.
 */
const PAGES = ['tasks', 'automations', 'council', 'marks', 'stats', 'extensions', 'plugins', 'design', 'settings', 'view'] as const;
export type AddressPage = (typeof PAGES)[number];

/**
 * What the address bar says, read once at startup and mirrored with `replaceState`:
 *
 * - `/c/<sessionId>`: a conversation; its project comes with it. `?mark=<markId>` locates a 收藏.
 * - `/p/<projectId>`: a project's new-conversation page.
 * - `/tasks` (任务), `/automations` (自动化), `/marks`, `/extensions`, `/stats?range=…`, `/plugins?id=<pluginId>`, `/view?id=<viewId>`.
 * - `/design/<chapter>?platform=macos`: a chapter of the design system; no chapter is its overview.
 * - `/settings/<sectionId>`: the settings page at that section; `/settings` opens the default section.
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
  /** The `main` plugin view id (`/view?id=<pluginId>/<name>`). */
  mainViewId?: string;
  /** Which platform the design page shows; absent is the web. */
  designPlatform?: DesignPlatform;
  /** The design page's chapter; absent is the overview. */
  designChapter?: string;
  /** The settings section after `/settings/`; absent when `/settings` has no section segment. */
  settingsSection?: string;
  stats: StatsUiState;
}

export function readPageAddress(location: Pick<Location, 'pathname' | 'search'>): PageAddress {
  const [head, id, ...rest] = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const search = new URLSearchParams(location.search);
  const address: PageAddress = { stats: readStatsSearch(location.search) };
  if (head === 'c' && id) {
    address.sessionId = id;
    const markId = search.get('mark');
    if (markId) address.markId = markId;
  } else if (head === 'p' && id) address.projectId = id;
  else if ((PAGES as readonly string[]).includes(head ?? '')) {
    address.page = head as AddressPage;
    if (head === 'settings' && id) address.settingsSection = id;
    const pluginId = head === 'plugins' ? search.get('id') : undefined;
    if (pluginId) address.pluginId = pluginId;
    const mainViewId = head === 'view' ? search.get('id') : undefined;
    if (mainViewId) address.mainViewId = mainViewId;
    const platform = head === 'design' ? search.get('platform') : undefined;
    if (platform && platform !== 'web' && (DESIGN_PLATFORMS as readonly string[]).includes(platform)) address.designPlatform = platform as DesignPlatform;
    // A chapter is `<group>/<slug>`.
    if (head === 'design' && id) address.designChapter = [id, ...rest].join('/');
  }
  return address;
}

export function pageAddressUrl(address: Required<Pick<PageAddress, 'sessionId' | 'projectId' | 'pluginId' | 'stats'>> & Pick<PageAddress, 'page' | 'mainViewId' | 'designPlatform' | 'designChapter' | 'settingsSection'>): string {
  const { page, sessionId, projectId, pluginId, mainViewId, stats, designPlatform, designChapter, settingsSection } = address;
  if (page === 'view') return mainViewId ? `/view?${new URLSearchParams({ id: mainViewId })}` : '/';
  if (page === 'plugins') return pluginId ? `/plugins?${new URLSearchParams({ id: pluginId })}` : '/plugins';
  if (page === 'design') {
    const path = designChapter ? `/design/${designChapter.split('/').map(encodeURIComponent).join('/')}` : '/design';
    return designPlatform && designPlatform !== 'web' ? `${path}?${new URLSearchParams({ platform: designPlatform })}` : path;
  }
  if (page === 'settings') return settingsSection ? `/settings/${encodeURIComponent(settingsSection)}` : '/settings';
  if (page === 'stats') return `/stats${writeStatsSearch(stats)}`;
  if (page) return `/${page}`;
  if (sessionId) return `/c/${encodeURIComponent(sessionId)}`;
  if (projectId) return `/p/${encodeURIComponent(projectId)}`;
  return '/';
}
