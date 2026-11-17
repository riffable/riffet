import type { FastifyInstance } from 'fastify';
import type { ReleaseNotes, UpdateCheck } from '../../../../packages/contracts/src/index.js';
import { availableTag, checkLatest, claimBackgroundCheck, readCachedCheck, releaseNotes, updateChannel, writeCachedCheck } from '../update/status.js';
import { SERVER_BUILD } from '../version.js';

// Only fixed messages cross the HTTP boundary: Git failures can include credential URLs
// and local paths. Users can diagnose their clone's authentication in the terminal.
const messages: Record<UpdateCheck['status'], string> = {
  available: '发现新的发布版本。',
  current: '当前是最新发布版本。',
  ahead: '当前版本高于远端最新发布版本，不会自动降级。',
  development: '当前是开发构建，请在终端确认源码后更新。',
  unavailable: '无法检查更新，请在服务器所在电脑确认源码目录、origin、网络和 Git 认证。',
  'no-releases': '远端尚无符合 vX.Y.Z 规则的发布 tag。',
  conflict: '发布 tag 对应的提交已变化，请在终端检查，不要覆盖现有 tag。',
};

/** Protected by the same app-level authentication hook as all private /api routes. */
export function registerUpdateRoutes(app: FastifyInstance, stateDir: string): void {
  let inflight: Promise<UpdateCheck> | undefined;
  const unavailable = (): UpdateCheck => ({ status: 'unavailable', current: SERVER_BUILD, latest: null, source: null, message: messages.unavailable });
  const safe = (result: UpdateCheck): UpdateCheck => ({
    status: result.status,
    current: SERVER_BUILD,
    latest: result.latest && { tag: result.latest.tag, version: result.latest.version, commit: result.latest.commit, objectId: result.latest.objectId },
    source: result.source && { tag: result.source.tag, commit: result.source.commit, dirty: result.source.dirty },
    message: messages[result.status],
    ...(result.latestVersion ? { latestVersion: result.latestVersion } : {}),
    ...(result.checkedAt ? { checkedAt: result.checkedAt } : {}),
  });
  /** One check at a time; its answer is what every client and the CLI read next. */
  const check = (): Promise<UpdateCheck> => {
    if (updateChannel() === 'none') return Promise.resolve(unavailable());
    // Share concurrent checks without caching a stale result as "up to date".
    inflight ??= checkLatest()
      .then(result => writeCachedCheck(stateDir, result))
      .then(safe)
      .catch(unavailable)
      .finally(() => { inflight = undefined; });
    return inflight;
  };

  /** Checks now: the "Check for updates" button. */
  app.get('/api/update', async () => check());

  /**
   * The last check, without waiting for the network: the sidebar and the About page read it on load.
   * An answer older than a day, or a failed one, starts a check for the next reader unless one is under way.
   */
  app.get('/api/update/status', async () => {
    const cached = readCachedCheck(stateDir);
    if ((!cached || cached.stale) && !inflight && claimBackgroundCheck(stateDir)) void check();
    return cached ? safe(cached.check) : null;
  });

  /** What the available release changes, from its CHANGELOG. */
  app.get<{ Querystring: { language?: string } }>('/api/update/notes', async (request): Promise<ReleaseNotes> => {
    const tag = availableTag(readCachedCheck(stateDir)?.check);
    if (!tag) return { notes: [], compareUrl: null };
    return releaseNotes(tag, String(request.query.language ?? 'en'));
  });
}
