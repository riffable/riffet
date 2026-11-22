/**
 * What a request that came through a link may reach on this server (docs/guide/multi-server.md §3.1). One table, by
 * route pattern, rather than an option on each of the ~330 route registrations. A route no rule matches is denied at
 * run time, and `links/links.test.ts` fails for every registered route the table does not classify. A new route under
 * a `serve` prefix inherits it: whoever adds one checks that it only touches the work object (guide §3.1).
 *
 * - `serve`: answered as for a local client; the answer only ever holds this server's data.
 * - `serve-local`: a list the entry server merges with its peers' (docs/SERVER-LINKS.md §5). Through a link it
 *   answers this server's own part, so merging never loops.
 * - `deny`: 403 `LINK_FORBIDDEN`. Everything that would let the peer weaken this server's control over itself (links,
 *   pairing, tokens, devices), every write to this machine's configuration (it is changed in this server's own web
 *   app, SERVER-LINKS.md §10), and the person's own and the entry's own services (classes B, C and D of the guide).
 */
export type LinkPolicy = 'serve' | 'serve-local' | 'deny';

interface Rule {
  /** A Fastify route pattern. With `prefix`, it also matches every route below it. */
  path: string;
  prefix?: true;
  /** Absent: every method. */
  methods?: readonly string[];
  policy: LinkPolicy;
}

const READ = ['GET', 'HEAD'] as const;

/** First match wins, so narrower rules come before the prefix they carve out of. */
const RULES: readonly Rule[] = [
  // Control over this server itself.
  { path: '/api/auth', prefix: true, policy: 'deny' },
  { path: '/api/pairing', prefix: true, policy: 'deny' },
  { path: '/api/devices', prefix: true, policy: 'deny' },
  { path: '/api/links', prefix: true, policy: 'deny' },
  { path: '/api/servers', prefix: true, policy: 'deny' },
  { path: '/api/riffet-mcp', prefix: true, policy: 'deny' },

  // Merged lists: only this server's part.
  { path: '/api/bootstrap', methods: READ, policy: 'serve-local' },
  { path: '/api/lists/stream', methods: READ, policy: 'serve-local' },
  { path: '/api/sessions', methods: READ, policy: 'serve-local' },
  { path: '/api/terminals', methods: READ, policy: 'serve-local' },
  { path: '/api/projects', methods: READ, policy: 'serve-local' },
  { path: '/api/work-items', methods: READ, policy: 'serve-local' },
  { path: '/api/automations', methods: READ, policy: 'serve-local' },
  { path: '/api/automation-runs', methods: READ, policy: 'serve-local' },
  { path: '/api/marks', methods: READ, policy: 'serve-local' },
  { path: '/api/marks/facets', methods: READ, policy: 'serve-local' },
  { path: '/api/shares', methods: READ, policy: 'serve-local' },
  { path: '/api/search/messages', methods: READ, policy: 'serve-local' },

  // Work objects (class A): conversations, terminals, projects and what hangs off them.
  { path: '/api/sessions/:id/device-actions', policy: 'deny' },
  { path: '/api/sessions', prefix: true, policy: 'serve' },
  { path: '/api/v3/sessions', prefix: true, policy: 'serve' },
  { path: '/api/terminals', prefix: true, policy: 'serve' },
  { path: '/api/projects/:id/reveal', methods: ['POST'], policy: 'deny' },
  { path: '/api/projects/:id/open', policy: 'deny' },
  { path: '/api/projects', prefix: true, policy: 'serve' },
  { path: '/api/attachments', prefix: true, policy: 'serve' },
  { path: '/api/attempts', prefix: true, policy: 'serve' },
  { path: '/api/work-items', prefix: true, policy: 'serve' },
  { path: '/api/automations', prefix: true, policy: 'serve' },
  { path: '/api/marks', prefix: true, policy: 'serve' },
  { path: '/api/shares', prefix: true, policy: 'serve' },
  { path: '/api/tasks', prefix: true, policy: 'serve' },
  { path: '/api/folder-favorites', prefix: true, policy: 'serve' },
  { path: '/api/browse', policy: 'serve' },
  { path: '/api/remote/exec', methods: ['POST'], policy: 'serve' },
  { path: '/api/remote/shell', methods: READ, policy: 'serve' },
  { path: '/api/native/prewarm', prefix: true, policy: 'serve' },
  { path: '/api/file-sites', prefix: true, policy: 'serve' },

  // What a new conversation on this server is chosen from, and plugin views of its objects: read only.
  { path: '/api/backends', prefix: true, methods: READ, policy: 'serve' },
  { path: '/api/cursor/capabilities', methods: READ, policy: 'serve' },
  { path: '/api/cursor/models', methods: READ, policy: 'serve' },
  { path: '/api/agent-icons', prefix: true, methods: READ, policy: 'serve' },
  { path: '/api/view-icons', prefix: true, methods: READ, policy: 'serve' },
  { path: '/api/settings', methods: READ, policy: 'serve' },
  { path: '/api/task-workspaces/location', methods: READ, policy: 'serve' },
  { path: '/api/native/runtime/stats', methods: READ, policy: 'serve' },
  { path: '/api/integrations', methods: READ, policy: 'serve' },
  // A plugin's web bundle, for its view of an object on this server; its management pages stay behind.
  { path: '/api/integrations/:id/files/*', methods: READ, policy: 'serve' },
  { path: '/api/integrations/:id/commands/:name', methods: ['POST'], policy: 'serve' },
  { path: '/api/integrations/:id/queries/:name', methods: ['POST'], policy: 'serve' },
  { path: '/api/integrations/:id/channels/:name', methods: READ, policy: 'serve' },
  { path: '/health', methods: READ, policy: 'serve' },

  // Everything else on this server is configured in its own web app, or belongs to whoever uses the entry server.
  { path: '/api/backends', prefix: true, policy: 'deny' },
  { path: '/api/cursor', prefix: true, policy: 'deny' },
  { path: '/api/settings', prefix: true, policy: 'deny' },
  { path: '/api/integrations', prefix: true, policy: 'deny' },
  { path: '/api/auxiliary-models', prefix: true, policy: 'deny' },
  { path: '/api/service', prefix: true, policy: 'deny' },
  { path: '/api/system', prefix: true, policy: 'deny' },
  { path: '/api/update', prefix: true, policy: 'deny' },
  { path: '/api/doctor', prefix: true, policy: 'deny' },
  { path: '/api/owner', prefix: true, policy: 'deny' },
  { path: '/api/themes', prefix: true, policy: 'deny' },
  { path: '/api/appearance', prefix: true, policy: 'deny' },
  { path: '/api/workbench', prefix: true, policy: 'deny' },
  { path: '/api/assistant', prefix: true, policy: 'deny' },
  { path: '/api/channels', prefix: true, policy: 'deny' },
  { path: '/api/plugin-approvals', prefix: true, policy: 'deny' },
  { path: '/api/dictation', prefix: true, policy: 'deny' },
  { path: '/api/stats', prefix: true, policy: 'deny' },
  { path: '/api/council', prefix: true, policy: 'deny' },
  { path: '/api/external-sessions', prefix: true, policy: 'deny' },
  { path: '/api/pick-directory', prefix: true, policy: 'deny' },
  { path: '/api/client-logs', prefix: true, policy: 'deny' },
  { path: '/api/client-reports', prefix: true, policy: 'deny' },
  { path: '/api/client-jank', prefix: true, policy: 'deny' },
  // This server's web app and its documents are opened at this server's own address, never through the entry.
  { path: '*', policy: 'deny' },
  { path: '/__riffet', prefix: true, policy: 'deny' },
  { path: '/plugin-view', policy: 'deny' },
  { path: '/content-preview', policy: 'deny' },
  { path: '/diagram', policy: 'deny' },
  { path: '/math', policy: 'deny' },
  { path: '/mermaid', policy: 'deny' },
  { path: '/katex', prefix: true, policy: 'deny' },
];

/** The policy for a matched route pattern, or undefined when the table does not classify it (denied at run time). */
export function classifyLinkRoute(method: string, route: string): LinkPolicy | undefined {
  const verb = method.toUpperCase();
  for (const rule of RULES) {
    if (rule.methods && !rule.methods.includes(verb)) continue;
    if (route === rule.path || (rule.prefix && route.startsWith(rule.path.endsWith('/') ? rule.path : `${rule.path}/`))) return rule.policy;
  }
  return undefined;
}

/** What a link request gets: an unmatched route (a 404, or a route the table misses) is denied. */
export function linkPolicy(method: string, route: string | undefined): LinkPolicy {
  return (route && classifyLinkRoute(method, route)) || 'deny';
}
