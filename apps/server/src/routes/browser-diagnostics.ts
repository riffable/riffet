import type { FastifyInstance } from 'fastify';
import { ClientLogs } from '../clientLogs.js';
import { AppError } from '../errors.js';

const REPORT_BODY_LIMIT = 64 * 1024;
const JANK_BODY_LIMIT = 512 * 1024;
const MAX_REPORTS = 5;
const REPORTS_PER_MINUTE = 6;
const field = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : undefined;

/** Keeps only the crash fields worth reading, each bounded; the upload is unauthenticated. */
function crashReport(item: unknown) {
  if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'crash') return undefined;
  const { age, url, user_agent: userAgent, body } = item as Record<string, unknown>;
  const detail = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  return {
    type: 'crash',
    age: typeof age === 'number' && Number.isFinite(age) ? age : undefined,
    url: field(url, 200)?.replace(/[?#].*/, ''),
    userAgent: field(userAgent, 300),
    reason: field(detail.reason, 32),
    stack: field(detail.stack, 16_000),
    isTopLevel: typeof detail.is_top_level === 'boolean' ? detail.is_top_level : undefined,
    visibilityState: field(detail.visibility_state, 16),
  };
}

/**
 * What a tab can tell the server about its own hangs. Chrome uploads crash reports (an unresponsive
 * page the user exited, with its JS call stack) from the browser process, with no cookie or CSRF
 * token, so that route is public and bounded instead; the jank batch comes from the page itself.
 */
export function registerBrowserDiagnosticsRoutes(app: FastifyInstance, dir: string): void {
  const crashes = new ClientLogs(dir, 20, '.crash.json');
  const janks = new ClientLogs(dir, 20, '.jank.json');
  let windowStart = 0, accepted = 0;
  // Registered in its own scope so the extra content type exists for this route only.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/reports+json', { parseAs: 'string', bodyLimit: REPORT_BODY_LIMIT }, (_request, body, done) => {
      try { done(null, JSON.parse(body as string)); } catch { done(new AppError('INVALID_REPORT', 'Reports must be JSON', 400), undefined); }
    });
    scope.post<{ Body: unknown }>('/api/client-reports', { bodyLimit: REPORT_BODY_LIMIT }, async (request, reply) => {
      const now = Date.now();
      if (now - windowStart >= 60_000) { windowStart = now; accepted = 0; }
      if (accepted >= REPORTS_PER_MINUTE) return reply.code(429).send();
      if (!Array.isArray(request.body)) throw new AppError('INVALID_REPORT', 'Reports must be an array', 400);
      const reports = request.body.slice(0, MAX_REPORTS).map(crashReport).filter((report) => report !== undefined);
      if (!reports.length) return reply.code(204).send();
      accepted += 1;
      try {
        const { path } = await crashes.save('', JSON.stringify(reports, null, 2));
        const first = reports[0]!;
        // The service runs with Fastify's logger off; its own diagnostics go to the console, like loop-health.
        console.warn('[riffet] browser crash report received', { reason: first.reason, top: first.stack?.split('\n').find((line) => line.trim())?.trim().slice(0, 200), file: path });
      } catch (error) {
        console.warn('[riffet] browser crash report could not be saved', error instanceof Error ? error.message : String(error));
      }
      return reply.code(204).send();
    });
  });
  app.post<{ Body: unknown }>('/api/client-jank', { bodyLimit: JANK_BODY_LIMIT }, async (request, reply) => {
    await janks.save('', JSON.stringify(request.body));
    return reply.code(204).send();
  });
}
