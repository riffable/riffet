import type { FastifyInstance } from 'fastify';
import type { ThemeLibraryUpdate } from '../../../../packages/contracts/src/index.js';
import type { RouteDeps } from './deps.js';

/** The shared custom-theme library. Authentication is the global `onRequest` hook's job. */
export function registerThemeRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/themes', async () => deps.themes.getLibrary());
  // The editor sends the whole library, so the body is a library-sized document rather than a patch.
  app.put<{ Body: ThemeLibraryUpdate }>('/api/themes', { bodyLimit: 512 * 1024 }, async (request) => deps.themes.replaceLibrary(request.body));
}
