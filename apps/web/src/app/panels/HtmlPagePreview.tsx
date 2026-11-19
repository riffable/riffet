import { useEffect, useRef, useState } from 'react';
import { projectFileUrl } from '@/lib/files';

const SITE_PAGE = /\/api\/file-sites\/([^/]+)\/(.*)$/;

const folderOf = (file: string) => { const slash = file.lastIndexOf('/'); return slash < 0 ? '' : file.slice(0, slash); };

/**
 * The token and project path of a page the frame reports, for a site rooted at `site`'s folder; the
 * server resolves a folder to its index.html the same way. A path that is not a plain descent into
 * that folder is not a page of the site, whatever the page claims.
 */
function sitePage(site: string, pathname: string): { token: string; page: string } | undefined {
  const match = SITE_PAGE.exec(pathname);
  if (!match) return undefined;
  let parts: string[];
  try { parts = match[2]!.split('/').map(decodeURIComponent); } catch { return undefined; }
  if (parts.at(-1) === '') parts[parts.length - 1] = 'index.html';
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('/'))) return undefined;
  const folder = folderOf(site);
  return { token: match[1]!, page: folder ? `${folder}/${parts.join('/')}` : parts.join('/') };
}

/** `page` relative to the folder of `site`, the way the mint's `page` parameter takes it. */
function withinSite(site: string, page: string): string | undefined {
  const folder = folderOf(site);
  if (!folder) return page;
  return page.startsWith(`${folder}/`) ? page.slice(folder.length + 1) : undefined;
}

/**
 * A project HTML page served with the folder of `site` as the site, so its links, styles and
 * scripts resolve the way they do in a browser. A link followed inside reports its page through
 * `onNavigate`; the frame reloads `path` under the same root when `path` moves somewhere the page
 * did not go itself, when the open page's `version` changes, or when `reload` is bumped. A new
 * `site` is a new preview: key the element by it.
 */
export function HtmlPagePreview({ projectId, site, path, version, reload = 0, title, onNavigate }: { projectId: string; site: string; path: string; version?: string; reload?: number; title: string; onNavigate: (path: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [load, setLoad] = useState({ page: path, count: 0 });
  /** The page the frame shows now, as far as it has said. */
  const showing = useRef(path);
  /** The content version last seen for a page, so a link followed is not taken for an edit. */
  const seen = useRef({ path, version });
  /** The page last reopened because its token expired; a second expiry in a row is left on screen. */
  const renewed = useRef<string | undefined>(undefined);
  /** The token of this load, from its first report: the server's script runs before any of the page's. */
  const token = useRef<string | undefined>(undefined);
  const open = (page: string) => { showing.current = page; token.current = undefined; setLoad((current) => ({ page, count: current.count + 1 })); };
  useEffect(() => {
    const edited = seen.current.path === path && seen.current.version !== version;
    seen.current = { path, version };
    if (path !== showing.current || edited) open(path);
  }, [path, version]);
  const reloaded = useRef(reload);
  useEffect(() => {
    if (reload === reloaded.current) return;
    reloaded.current = reload;
    open(showing.current);
  }, [reload]);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as { type?: unknown; path?: unknown; status?: unknown } | null;
      if (data?.type !== 'riffet-file-site' || typeof data.path !== 'string') return;
      const reported = sitePage(site, data.path);
      if (!reported) return;
      token.current ??= reported.token;
      if (reported.token !== token.current) return;
      const { page } = reported;
      if (data.status === 401) {
        if (renewed.current === page) return;
        renewed.current = page;
        open(page);
      } else if (data.status === 200) {
        renewed.current = undefined;
        if (page === showing.current) return;
        showing.current = page;
      } else return; // a missing page: the frame says so, the header keeps the last page that loaded
      if (page !== path) navigate.current(page);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [site, path]);
  const relative = load.page === site ? undefined : withinSite(site, load.page);
  const src = `${projectFileUrl(projectId, site)}&render=site${relative ? `&page=${encodeURIComponent(relative)}` : ''}`;
  return <iframe ref={frame} key={load.count} title={title} src={src} sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-bg" />;
}
