import type { AccessCapability } from '../../../../packages/contracts/src/index.js';

/**
 * What each API route requires of its caller (docs/TRANSPORT-SECURITY.md §6). One table by route pattern, like the link
 * policy (`links/policy.ts`), rather than an option on each route registration. A route no rule matches requires
 * `admin`, and `app.test.ts` fails for every registered route the table does not classify.
 *
 * - `read`: reading, and writes that only move the caller's own view (seen marks, pin order, client logs, its device report).
 * - `chat`: talking to agents and arranging work for them: messages, approvals, new sessions, tasks, automations.
 *   An agent runs commands, and an approval is a command allowed, so `chat` is not a boundary against code execution.
 * - `exec`: running or changing things on this machine without an agent: terminals, remote exec, file and Git writes.
 * - `admin`: this server's control and configuration: pairing, devices, links, settings, plugins, updates.
 * - `public`: authenticated by the route itself (login, pairing, the link tunnel, health); no capability applies.
 */
export type Capability = AccessCapability;
export type RouteAccess = Capability | 'public';
export const CAPABILITIES: readonly Capability[] = ['read', 'chat', 'exec', 'admin'];

interface Rule {
  /** A Fastify route pattern. With `prefix`, it also matches every route below it. */
  path: string;
  prefix?: true;
  /** Absent: every method. */
  methods?: readonly string[];
  access: RouteAccess;
}

const READ = ['GET', 'HEAD'] as const;

/** First match wins, so narrower rules come before the prefix they carve out of. */
const RULES: readonly Rule[] = [
  // Authenticated by the route itself.
  { path: '/api/auth/status', methods: READ, access: 'public' },
  { path: '/api/auth/login', methods: ['POST'], access: 'public' },
  { path: '/api/devices/pair', methods: ['POST'], access: 'public' },
  { path: '/api/devices/prove', methods: ['POST'], access: 'public' },
  { path: '/api/links/tunnel', methods: READ, access: 'public' },
  { path: '/api/riffet-mcp', prefix: true, access: 'public' },
  { path: '/api/file-sites/*', methods: READ, access: 'public' },
  { path: '/api/shares/drafts/:id/files/*', methods: READ, access: 'read' },

  // Writes that only move the caller's own view.
  { path: '/api/auth/logout', methods: ['POST'], access: 'read' },
  { path: '/api/client-jank', methods: ['POST'], access: 'read' },
  { path: '/api/client-logs', methods: ['POST'], access: 'read' },
  { path: '/api/client-reports', methods: ['POST'], access: 'read' },
  { path: '/api/system/client-metrics', methods: ['POST'], access: 'read' },
  { path: '/api/sessions/seen', methods: ['POST'], access: 'read' },
  { path: '/api/sessions/:id/seen', methods: ['POST'], access: 'read' },
  { path: '/api/sessions/pin-order', methods: ['PUT'], access: 'read' },
  { path: '/api/browse', methods: ['POST'], access: 'read' },
  { path: '/api/search/messages', methods: READ, access: 'read' },

  // Control over this server itself.
  { path: '/api/auth', prefix: true, access: 'admin' },
  { path: '/api/pairing', prefix: true, access: 'admin' },
  // A paired phone answers the tools an agent called on it; the rest of `/me` is the device about itself.
  { path: '/api/devices/me/calls', prefix: true, access: 'chat' },
  { path: '/api/devices/me', prefix: true, access: 'read' },
  { path: '/api/devices', methods: READ, access: 'read' },
  { path: '/api/devices', prefix: true, access: 'admin' },
  { path: '/api/links', prefix: true, methods: READ, access: 'read' },
  { path: '/api/links', prefix: true, access: 'admin' },
  { path: '/api/servers', methods: READ, access: 'read' },
  // `/api/servers/:serverId/*` is judged by the path it forwards to (`app.ts`); this is only its fallback.
  { path: '/api/servers', prefix: true, access: 'admin' },
  { path: '/api/security', prefix: true, methods: READ, access: 'read' },
  { path: '/api/security', prefix: true, access: 'admin' },

  // Direct execution on this machine.
  { path: '/api/remote/exec', methods: ['POST'], access: 'exec' },
  { path: '/api/remote/shell', methods: READ, access: 'exec' },
  { path: '/api/terminals/:id/ws', methods: READ, access: 'exec' },
  { path: '/api/terminals', prefix: true, methods: READ, access: 'read' },
  { path: '/api/terminals', prefix: true, access: 'exec' },
  { path: '/api/sessions/:id/native/keys', methods: ['POST'], access: 'exec' },
  { path: '/api/sessions/:id/terminal-hold', access: 'exec' },
  { path: '/api/sessions/:id/release-cli', methods: ['POST'], access: 'exec' },
  { path: '/api/projects/:id/file', methods: ['PUT'], access: 'exec' },
  { path: '/api/projects/:id/file', prefix: true, methods: ['POST'], access: 'exec' },
  { path: '/api/projects/:id/git', prefix: true, methods: ['POST'], access: 'exec' },
  { path: '/api/projects/:id/checkpoints/:checkpointId/restore', methods: ['POST'], access: 'exec' },
  { path: '/api/projects/:id/worktree', prefix: true, methods: ['POST'], access: 'exec' },
  { path: '/api/projects/:id/worktrees', methods: ['POST', 'DELETE'], access: 'exec' },
  { path: '/api/projects/:id/worktree-projects', methods: ['POST'], access: 'exec' },
  { path: '/api/projects/:id/configs', prefix: true, methods: ['POST', 'PUT'], access: 'exec' },
  { path: '/api/projects/:id/configs', methods: ['POST'], access: 'exec' },
  { path: '/api/attempts/:id/adopt', methods: ['POST'], access: 'exec' },
  { path: '/api/attempts/:id/discard', methods: ['POST'], access: 'exec' },
  { path: '/api/cursor/command', methods: ['POST'], access: 'exec' },
  // Opens a window or a dialog on the machine the server runs on.
  { path: '/api/projects/:id/open', methods: ['POST'], access: 'exec' },
  { path: '/api/projects/:id/reveal', methods: ['POST'], access: 'exec' },
  { path: '/api/pick-directory', methods: ['POST'], access: 'exec' },

  // Configuration of this server and of the person's own tools.
  { path: '/api/settings', methods: READ, access: 'read' },
  { path: '/api/settings', prefix: true, access: 'admin' },
  { path: '/api/backends/:id/profiles', prefix: true, methods: ['POST', 'PATCH', 'DELETE'], access: 'admin' },
  { path: '/api/backends/:id/profiles', methods: ['POST'], access: 'admin' },
  { path: '/api/backends/:id/extensions', prefix: true, methods: ['POST', 'PUT', 'PATCH', 'DELETE'], access: 'admin' },
  { path: '/api/backends/:id/command-observation/trust', methods: ['POST'], access: 'admin' },
  { path: '/api/integrations/:id/commands/:name', methods: ['POST'], access: 'chat' },
  { path: '/api/integrations/:id/queries/:name', methods: ['POST'], access: 'read' },
  { path: '/api/integrations/:id/page', methods: ['POST'], access: 'chat' },
  { path: '/api/integrations/:id/flows/:flowId/poll', methods: ['POST'], access: 'chat' },
  { path: '/api/integrations', prefix: true, methods: READ, access: 'read' },
  { path: '/api/integrations', prefix: true, access: 'admin' },
  { path: '/api/integrations', access: 'admin' },
  { path: '/api/plugin-approvals', prefix: true, methods: READ, access: 'read' },
  { path: '/api/plugin-approvals', prefix: true, access: 'admin' },
  { path: '/api/auxiliary-models', prefix: true, methods: READ, access: 'read' },
  { path: '/api/auxiliary-models', prefix: true, access: 'admin' },
  { path: '/api/channels', prefix: true, methods: READ, access: 'read' },
  { path: '/api/channels', methods: READ, access: 'read' },
  { path: '/api/channels', prefix: true, access: 'admin' },
  { path: '/api/assistant', prefix: true, methods: READ, access: 'read' },
  { path: '/api/assistant/delegations/:id/end', methods: ['POST'], access: 'chat' },
  { path: '/api/assistant', prefix: true, access: 'admin' },
  { path: '/api/team', prefix: true, methods: READ, access: 'read' },
  { path: '/api/team', prefix: true, access: 'admin' },
  { path: '/api/owner', prefix: true, methods: READ, access: 'read' },
  { path: '/api/owner', methods: READ, access: 'read' },
  { path: '/api/owner', prefix: true, access: 'admin' },
  { path: '/api/owner', access: 'admin' },
  { path: '/api/themes', methods: READ, access: 'read' },
  { path: '/api/themes', access: 'admin' },
  { path: '/api/system', prefix: true, methods: READ, access: 'read' },
  { path: '/api/system', prefix: true, access: 'admin' },
  { path: '/api/service', prefix: true, methods: READ, access: 'read' },
  { path: '/api/service', prefix: true, access: 'admin' },
  { path: '/api/update', prefix: true, methods: READ, access: 'read' },
  { path: '/api/update', methods: READ, access: 'read' },
  { path: '/api/doctor', methods: READ, access: 'read' },

  // Talking to agents and arranging their work.
  { path: '/api/sessions', prefix: true, methods: READ, access: 'read' },
  { path: '/api/sessions', methods: READ, access: 'read' },
  { path: '/api/sessions', prefix: true, access: 'chat' },
  { path: '/api/sessions', access: 'chat' },
  { path: '/api/projects', prefix: true, methods: READ, access: 'read' },
  { path: '/api/projects', methods: READ, access: 'read' },
  { path: '/api/projects', prefix: true, access: 'chat' },
  { path: '/api/projects', access: 'chat' },
  { path: '/api/attempts', prefix: true, methods: READ, access: 'read' },
  { path: '/api/attempts', prefix: true, access: 'chat' },
  { path: '/api/attachments', prefix: true, methods: READ, access: 'read' },
  { path: '/api/attachments', access: 'chat' },
  { path: '/api/work-items', prefix: true, methods: READ, access: 'read' },
  { path: '/api/work-items', methods: READ, access: 'read' },
  { path: '/api/work-items', prefix: true, access: 'chat' },
  { path: '/api/work-items', access: 'chat' },
  { path: '/api/tasks', prefix: true, methods: READ, access: 'read' },
  { path: '/api/tasks', methods: READ, access: 'read' },
  { path: '/api/tasks', prefix: true, access: 'chat' },
  { path: '/api/tasks', access: 'chat' },
  { path: '/api/automations', prefix: true, methods: READ, access: 'read' },
  { path: '/api/automations', methods: READ, access: 'read' },
  { path: '/api/automations', prefix: true, access: 'chat' },
  { path: '/api/automations', access: 'chat' },
  { path: '/api/automation-runs', methods: READ, access: 'read' },
  { path: '/api/council', prefix: true, methods: READ, access: 'read' },
  { path: '/api/council', methods: READ, access: 'read' },
  { path: '/api/council', prefix: true, access: 'chat' },
  { path: '/api/council', access: 'chat' },
  { path: '/api/marks', prefix: true, methods: READ, access: 'read' },
  { path: '/api/marks', methods: READ, access: 'read' },
  { path: '/api/marks', prefix: true, access: 'chat' },
  { path: '/api/marks', access: 'chat' },
  { path: '/api/shares', prefix: true, methods: READ, access: 'read' },
  { path: '/api/shares', methods: READ, access: 'read' },
  { path: '/api/shares', prefix: true, access: 'chat' },
  { path: '/api/folder-favorites', prefix: true, methods: READ, access: 'read' },
  { path: '/api/folder-favorites', methods: READ, access: 'read' },
  { path: '/api/folder-favorites', prefix: true, access: 'chat' },
  { path: '/api/folder-favorites', access: 'chat' },
  { path: '/api/external-sessions', prefix: true, methods: READ, access: 'read' },
  { path: '/api/external-sessions', methods: READ, access: 'read' },
  { path: '/api/external-sessions', prefix: true, access: 'chat' },
  { path: '/api/native/prewarm', prefix: true, access: 'chat' },
  { path: '/api/native/prewarm', access: 'chat' },
  { path: '/api/backends', prefix: true, methods: READ, access: 'read' },
  { path: '/api/backends', methods: READ, access: 'read' },
  { path: '/api/backends/:id/model-probe', methods: ['POST'], access: 'chat' },
  // Speech becomes text in the composer.
  { path: '/api/dictation/ws', methods: READ, access: 'chat' },

  // Everything else that only reads.
  { path: '/api/bootstrap', methods: READ, access: 'read' },
  { path: '/api/lists/stream', methods: READ, access: 'read' },
  { path: '/api/v3/sessions', prefix: true, methods: READ, access: 'read' },
  { path: '/api/native', prefix: true, methods: READ, access: 'read' },
  { path: '/api/stats', prefix: true, methods: READ, access: 'read' },
  { path: '/api/cursor', prefix: true, methods: READ, access: 'read' },
  { path: '/api/extensions', prefix: true, methods: READ, access: 'read' },
  { path: '/api/appearance', prefix: true, methods: READ, access: 'read' },
  { path: '/api/appearance', methods: READ, access: 'read' },
  { path: '/api/workbench', prefix: true, methods: READ, access: 'read' },
  { path: '/api/task-workspaces', prefix: true, methods: READ, access: 'read' },
  { path: '/api/agent-icons', prefix: true, methods: READ, access: 'read' },
  { path: '/api/view-icons', prefix: true, methods: READ, access: 'read' },
];

/** The access a matched route pattern requires, or undefined when the table does not classify it. */
export function classifyRoute(method: string, route: string): RouteAccess | undefined {
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  for (const rule of RULES) {
    if (rule.methods && !rule.methods.includes(verb)) continue;
    if (route === rule.path || (rule.prefix && route.startsWith(`${rule.path}/`))) return rule.access;
  }
  return undefined;
}

/** What an API route requires: an unmatched pattern requires `admin`, so a route added without a rule fails closed. */
export function routeAccess(method: string, route: string | undefined): RouteAccess {
  return (route && classifyRoute(method, route)) || 'admin';
}

/**
 * Maps concrete paths back to registered patterns, for a request whose real target is another path (a request
 * forwarded to a linked server is judged by the route it reaches there, which runs the same table). A static segment
 * beats a parameter, which beats a wildcard, as in Fastify's router.
 */
export class RoutePatterns {
  private readonly patterns: Array<{ method: string; pattern: string; segments: string[] }> = [];
  add(method: string, pattern: string) {
    if (!pattern.startsWith('/api/')) return;
    this.patterns.push({ method: method.toUpperCase(), pattern, segments: pattern.split('/') });
  }
  match(method: string, path: string): string | undefined {
    const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
    const parts = path.split('?')[0]!.split('/');
    let best: { pattern: string; score: number[] } | undefined;
    for (const candidate of this.patterns) {
      if (candidate.method !== verb) continue;
      const score = matchScore(candidate.segments, parts);
      if (!score) continue;
      if (!best || compareScores(score, best.score) > 0) best = { pattern: candidate.pattern, score };
    }
    return best?.pattern;
  }
}

function matchScore(segments: string[], parts: string[]): number[] | undefined {
  const score: number[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (segment === '*') { score.push(0); return parts.length > index ? score : undefined; }
    const part = parts[index];
    if (part === undefined) return undefined;
    if (segment.startsWith(':')) { if (!part) return undefined; score.push(1); continue; }
    if (segment !== part) return undefined;
    score.push(2);
  }
  return parts.length === segments.length ? score : undefined;
}

function compareScores(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}
