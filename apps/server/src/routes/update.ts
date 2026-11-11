import type { FastifyInstance } from 'fastify';
import type { UpdateCheck } from '../../../../packages/contracts/src/index.js';
import { checkForUpdates } from '../update.js';
import { checkNpmUpdate, isNpmInstall } from '../update-npm.js';
import { SERVER_BUILD, SOURCE_ROOT } from '../version.js';

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
export function registerUpdateRoutes(app: FastifyInstance): void {
  let inflight: Promise<UpdateCheck> | undefined;
  const unavailable = (): UpdateCheck => ({ status: 'unavailable', current: SERVER_BUILD, latest: null, source: null, message: messages.unavailable });
  // An npm install has no clone to inspect; it asks the registry instead.
  const npm = isNpmInstall();
  app.get('/api/update', async () => {
    if (!SOURCE_ROOT && !npm) return unavailable();
    // Share concurrent manual checks without caching a stale result as "up to date".
    if (!inflight) {
      inflight = (npm ? checkNpmUpdate(SERVER_BUILD) : checkForUpdates({ root: SOURCE_ROOT!, current: SERVER_BUILD })
        .then((result): UpdateCheck => ({
          status: result.status,
          current: SERVER_BUILD,
          latest: result.latest && { tag: result.latest.tag, version: result.latest.version, commit: result.latest.commit, objectId: result.latest.objectId },
          source: result.source && { tag: result.source.tag, commit: result.source.commit, dirty: result.source.dirty },
          message: messages[result.status],
        })))
        .catch(unavailable)
        .finally(() => { inflight = undefined; });
    }
    return inflight;
  });
}
