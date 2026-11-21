/**
 * Wire-protocol capabilities, advertised by `GET /health` and `GET /api/bootstrap`. A server that
 * predates v2 omits it, so clients treat a missing `protocol` as version 1 with no features.
 * - `list-etag`: `GET /api/sessions` and `GET /api/terminals` answer `If-None-Match` with 304, and
 *   the lists stream's `changed` event carries `{revision}`.
 * - `sync-v3`: conversations sync over `/api/v3/sessions/:id/…` (docs/SYNC-V3.md); the v2 native
 *   stream, snapshot and history routes are gone.
 * - `integrations-v1`: `/api/integrations` serves built-in plugin descriptors and actions.
 * - `quick-chat`: quick chats exist (`backendId: 'chat'` in the project marked `system: 'quick-chat'`).
 *   Only a client that names the feature in {@link CLIENT_FEATURES_HEADER} is shown them or their
 *   project: an older phone cannot decode the backend id, and a client without the UI would list the
 *   project as an ordinary one.
 * - `antigravity-agent`: the client can decode and operate Antigravity native sessions.
 * - `pi-agent`: the client can decode and operate pi native sessions and their backend catalog.
 * - `plugin-agents`: the client can decode an Agent id that is not built in (`PluginAgentId`: namespaced
 *   by the providing plugin). Only a client that names it is sent a session, run, catalog entry, event or
 *   setting carrying one; the others see what they saw before, as with `pi-agent`.
 * - `session-references-v1`: messages can reference immutable snapshots of other sessions.
 * - `session-delete-v1`: `GET /api/sessions/:id/deletion` and `DELETE /api/sessions/:id` remove an idle
 *   conversation with its side chats (docs/design/session-deletion.md); a deleted id answers `410 SESSION_DELETED`.
 * - `list-delta`: `GET /api/sessions?since=<revision>` answers with the sessions changed since (`SessionListDelta`),
 *   `GET /api/bootstrap` carries `revisions`, and the lists stream sends `changed` on connect and carries
 *   `terminals` (docs/LIST-SYNC.md).
 * - `list-stream-ws`: `GET /api/lists/stream` also accepts a WebSocket upgrade, carrying each lists
 *   event as a JSON text message with `event` and `data` fields.
 * - `server-links-v1`: the server links with others (docs/SERVER-LINKS.md). `GET /api/servers` lists them,
 *   `/api/servers/<serverId>/<path>` reaches a linked server's `/api/<path>`, `GET /api/bootstrap` carries `serverId`
 *   and `servers`, and the lists stream sends `servers` when one is added, removed, or comes up or down.
 */
export type ProtocolFeature = 'list-etag' | 'sync-v3' | 'integrations-v1' | 'quick-chat' | 'pi-agent' | 'antigravity-agent' | 'projectless-tasks' | 'plugin-agents' | 'session-references-v1' | 'session-delete-v1' | 'list-delta' | 'list-stream-ws' | 'file-write-v1' | 'server-links-v1';
export interface ProtocolInfo { version: number; features: ProtocolFeature[]; }
export const PROTOCOL_INFO: ProtocolInfo = { version: 3, features: ['list-etag', 'sync-v3', 'integrations-v1', 'quick-chat', 'pi-agent', 'antigravity-agent', 'projectless-tasks', 'plugin-agents', 'session-references-v1', 'session-delete-v1', 'list-delta', 'list-stream-ws', 'file-write-v1', 'server-links-v1'] };
/** Request header naming the features a client understands, comma-separated. */
export const CLIENT_FEATURES_HEADER = 'x-riffet-features';
// Shared HTTP contract. JSON request/response fields are kept stable across workers.
export const API = {
  projects: '/api/projects', sessions: '/api/sessions', terminals: '/api/terminals',
  capabilities: '/api/cursor/capabilities', backends: '/api/backends', settings: '/api/settings',
  stats: '/api/stats', marks: '/api/marks', themes: '/api/themes',
} as const;
