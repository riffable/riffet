#!/usr/bin/env node
// Draws the architecture figures in docs/assets/architecture/ (README and docs/guide/architecture.md embed them).
//   node scripts/gen-architecture.mjs                  write <figure>-{light,dark}.svg
//   node scripts/gen-architecture.mjs --preview <dir>  also write an HTML page per figure into <dir>, for screenshots
// The figures state facts about the code: when a module, protocol or table named here changes, change it here and
// regenerate. Every box is a subsystem, module, process, file or remote system under its real name.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs/assets/architecture');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const PALETTES = {
  light: { page: '#ffffff', host: '#f4f2ee', card: '#ffffff', cell: '#f4f2ee', hair: 'rgb(21 23 26 / 0.14)', bound: 'rgb(21 23 26 / 0.34)', ink: '#15171a', fg2: '#4c5158', fg3: '#6e737b', blue: '#3867f0' },
  dark: { page: '#0d1117', host: '#17181b', card: '#212226', cell: '#2b2c31', hair: 'rgb(255 255 255 / 0.12)', bound: 'rgb(255 255 255 / 0.30)', ink: '#f4f2ee', fg2: '#bfc2c8', fg3: '#8d929a', blue: '#5b8cff' },
};

const SANS = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, 'Segoe UI', sans-serif`;
const MONO = `ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace`;
const STROKE = 1.25;
const esc = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The drawing primitives of one figure in one palette. */
function pen(c) {
  const parts = [];
  const add = markup => { parts.push(markup); };
  const text = (x, y, value, { size = 11, weight = 400, fill = c.ink, anchor = 'start', mono = false, caps = false } = {}) =>
    add(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${mono ? ' class="m"' : ''}${caps ? ' letter-spacing="0.08em"' : ''}>${esc(value)}</text>`);
  /** A group or column label: small capitals, then an optional identifier in mono. */
  const label = (x, y, value, detail, anchor = 'start') => {
    add(`<text x="${x}" y="${y}" font-size="9.5" fill="${c.fg3}" text-anchor="${anchor}"><tspan font-weight="600" letter-spacing="0.08em">${esc(value)}</tspan>${detail ? `<tspan dx="8" class="m" font-size="10">${esc(detail)}</tspan>` : ''}</text>`);
  };
  const rect = (x, y, w, h, { fill = 'none', stroke = 'none', r = 6, dash = false } = {}) =>
    add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1"${dash ? ' stroke-dasharray="4 3"' : ''}/>`);
  const path = (d, stroke, dash = false) => add(`<path d="${d}" stroke="${stroke}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none"${dash ? ' stroke-dasharray="4 3.5"' : ''}/>`);
  const head = (x, y, dx, dy, stroke) => path(dx ? `M${x - dx * 5} ${y - 3.5}L${x} ${y}L${x - dx * 5} ${y + 3.5}` : `M${x - 3.5} ${y - dy * 5}L${x} ${y}L${x + 3.5} ${y - dy * 5}`, stroke);
  /** A straight edge; `ends` names which of its ends carry an arrowhead. */
  const edge = (x1, y1, x2, y2, stroke, { ends = 'end', dash = false } = {}) => {
    path(`M${x1} ${y1}L${x2} ${y2}`, stroke, dash);
    const [dx, dy] = [Math.sign(x2 - x1), Math.sign(y2 - y1)];
    if (ends === 'end' || ends === 'both') head(x2, y2, dx, dy, stroke);
    if (ends === 'both') head(x1, y1, -dx, -dy, stroke);
  };
  /** A process, file or remote system: a name and one line of kind. */
  const node = (x, y, w, h, title, sub, { mono = true, fill = c.card, size = mono ? 11 : 12, pad = 10 } = {}) => {
    rect(x, y, w, h, { fill, stroke: c.hair });
    text(x + pad, y + h / 2 - 2.5, title, { size, weight: 600, mono });
    if (sub) text(x + pad, y + h / 2 + 11, sub, { size: 10, fill: c.fg3 });
  };
  /** An edge label: the protocol or transport, then the interface. */
  const wire = (x, y, proto, rest) =>
    add(`<text x="${x}" y="${y}" font-size="10" class="m"><tspan font-weight="600" fill="${c.ink}">${esc(proto)}</tspan><tspan dx="6" fill="${c.fg2}">${esc(rest)}</tspan></text>`);
  /** A table: the data-store notation, ruled above and below. */
  const store = (x, y, w, h, title, sub) => {
    rect(x, y, w, h, { fill: c.card, r: 0 });
    path(`M${x} ${y}L${x + w} ${y}M${x} ${y + h}L${x + w} ${y + h}`, c.bound);
    if (title) text(x + 9, y + h / 2 - 2.5, title, { size: 10, weight: 600, mono: true });
    if (sub) text(x + 9, y + h / 2 + 11, sub, { size: 10, fill: c.fg3 });
  };
  /** A module inside the server: its path and the layer it belongs to. */
  const cell = (x, y, w, h, name, layer) => {
    rect(x, y, w, h, { fill: c.cell, r: 5 });
    text(x + 9, y + h / 2 - 2.5, name, { size: 10.5, weight: 500, mono: true });
    text(x + 9, y + h / 2 + 10.5, layer, { size: 9.5, fill: c.fg3 });
  };
  const mark = (x, y, scale) => add(`<g transform="translate(${x} ${y}) scale(${scale})">`
    + `<path d="M8.77 6.2Q6.51 6.56 5.15 8.55L7.76 8.17Q5.43 9.17 4.26 11.65L6.94 10.68Q4.72 12.24 3.82 15.1L6.42 13.42Z" fill="${c.blue}" stroke="${c.blue}" stroke-width="0.6" stroke-linejoin="round"/>`
    + `<path d="M6 21C5.6 14.4 6.6 9 8.8 5.8L9.4 2.6L11.2 5.4C14.4 6.6 17.4 8.4 20 10.8c1.3 1.2 0.7 3.4 -1 3.4c-1.4 0 -3 -0.3 -4.4 -0.6c-1.4 -0.3 -2.3 0.3 -2.4 1.6c-0.1 2 0.2 4 0.8 5.8ZM11.5 8.2a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z" fill="${c.ink}" fill-rule="evenodd"/>`
    + `<path d="M6 21C5.6 14.4 6.6 9 8.8 5.8L9.4 2.6L11.2 5.4C14.4 6.6 17.4 8.4 20 10.8c1.3 1.2 0.7 3.4 -1 3.4c-1.4 0 -3 -0.3 -4.4 -0.6c-1.4 -0.3 -2.3 0.3 -2.4 1.6c-0.1 2 0.2 4 0.8 5.8Z" fill="none" stroke="${c.ink}" stroke-width="1" stroke-linejoin="round"/></g>`);
  const tag = (x, y, id) => {
    rect(x, y - 10, 22, 14, { stroke: c.blue, r: 7 });
    text(x + 11, y + 0.5, id, { size: 9, weight: 600, fill: c.blue, anchor: 'middle', mono: true });
  };
  /** A subsystem: name, the principle it realizes, where it lives, what it does, and its core elements. */
  const unit = (x, y, w, h, { title, id, path, does = [], has = [], fill = c.card, stroke = c.hair }) => {
    rect(x, y, w, h, { fill, stroke, r: 7 });
    text(x + 12, y + 21, title, { size: 12.5, weight: 600 });
    if (id) tag(x + 12 + title.length * 6.9 + 8, y + 20, id);
    if (path) text(x + w - 12, y + 21, path, { size: 9.5, fill: c.fg3, anchor: 'end', mono: true });
    does.forEach((line, at) => text(x + 12, y + 38 + at * 14, line, { size: 10.5, fill: c.fg2 }));
    has.forEach((line, at) => text(x + 12, y + 42 + does.length * 14 + at * 14, line, { size: 10, fill: c.fg3, mono: true }));
  };
  const titleBlock = (W, title, id) => {
    mark(22, 19, 0.92);
    add(`<text x="50" y="37" font-size="14" fill="${c.ink}"><tspan font-weight="600">Riffet</tspan><tspan dx="8" fill="${c.fg2}">${esc(title)}</tspan></text>`);
    text(W - 24, 37, id, { size: 10, fill: c.fg3, anchor: 'end', mono: true });
    path(`M24 54L${W - 24} 54`, c.hair);
  };
  const svg = (W, H, name) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(name)}" font-family="${SANS}">
<style>.m{font-family:${MONO}}</style>
<rect width="${W}" height="${H}" fill="${c.page}"/>
${parts.join('\n')}
</svg>
`;
  return { add, text, label, rect, path, head, edge, node, cell, wire, store, tag, unit, titleBlock, svg };
}

const RELEASE = `riffet ${manifest.version} · Node.js ${manifest.engines.node.replace('>=', '≥ ').replace(/\.\d+$/, '')}`;

/** Figure 1: the processes, files and remote systems of one deployment, and the interface on every edge. */
function runtime(mode) {
  const c = PALETTES[mode];
  const p = pen(c);
  const [W, H] = [1376, 912];
  p.titleBlock(W, 'Runtime view', `fig. 7 · processes, files, interfaces · ${RELEASE}`);

  const row = at => 170 + at * 54;
  const LEFT = { x: 24, w: 192 };
  const HOST = { x: 416, y: 68, w: 936, h: 722 };
  const SERVER = { x: 432, y: 98, w: 476, h: 593 };
  const STRIP = 150;
  const PROC = { x: 1118, w: 200 };
  const LANE = 1335;

  // Host and server process.
  p.rect(HOST.x, HOST.y, HOST.w, HOST.h, { fill: c.host, stroke: c.hair, r: 12 });
  p.label(SERVER.x, 88, 'HOST', 'macOS | Linux · one OS user');
  p.rect(SERVER.x, SERVER.y, SERVER.w, SERVER.h, { fill: c.card, stroke: c.hair, r: 8 });
  p.text(SERVER.x + 12, 119, 'riffet serve', { size: 13, weight: 600, mono: true });
  p.text(SERVER.x + SERVER.w - 12, 119, 'Node.js · Fastify 5 · HTTP/1.1 · 127.0.0.1:4337', { size: 10, fill: c.fg3, anchor: 'end', mono: true });
  p.path(`M${SERVER.x} 128L${SERVER.x + SERVER.w} 128`, c.hair);
  const [CORE_L, CORE_R] = [SERVER.x + STRIP, SERVER.x + SERVER.w - STRIP];
  p.path(`M${CORE_L} 128L${CORE_L} ${SERVER.y + SERVER.h}`, c.hair);
  p.path(`M${CORE_R} 128L${CORE_R} ${SERVER.y + SERVER.h}`, c.hair);
  p.label(SERVER.x + 12, 143.5, 'NETWORK-FACING');
  p.label(CORE_L + 12, 143.5, 'KERNEL');
  p.label(CORE_R + 12, 143.5, 'PROCESS-FACING');

  const cellAt = (x, at, name, layer) => p.cell(x + 6, row(at) - 19, STRIP - 12, 38, name, layer);
  [[0, 'routes/*', 'surfaces'], [1, 'routes/sync.ts', 'surfaces'], [2, 'routes/terminals.ts', 'surfaces'], [3, 'discovery.ts', 'base'],
    [5, 'riffet/feishu', 'channel · built-in plugin'], [6, 'push/apns.ts', 'features'], [7, 'auxiliary/gateway', 'kernel'], [8, 'update', 'features']]
    .forEach(([at, name, layer]) => cellAt(SERVER.x, at, name, layer));
  [[0, 'backends/claude', 'driver'], [1, 'riffet/cursor', 'driver · built-in plugin'], [2, 'backends/codex', 'driver · flavor traex'], [3, 'backends/droid', 'driver'],
    [4, 'backends/pi', 'driver'], [5, 'backends/dsh', 'driver'], [6, 'backends/chat', 'driver'], [7, 'plugins-host/', 'features'],
    [8, 'riffet-mcp/', 'features'], [9, 'hook-server.ts', 'plugin-api kit']]
    .forEach(([at, name, layer]) => cellAt(CORE_R, at, name, layer));

  // Kernel column.
  const cx = CORE_L + 12;
  let y = 174;
  for (const [name, role] of [['native/', 'run queue · admission · dispatch'], ['journal/', 'append-only event log'], ['timeline/', 'fold of events into rows'],
    ['sync/', 'transcript ingest · SSE fan-out'], ['terminal/', 'tmux control-mode client'], ['store.ts', 'node:sqlite DatabaseSync']]) {
    p.text(cx, y, name, { size: 10.5, weight: 500, mono: true });
    p.text(cx, y + 13, role, { size: 9.5, fill: c.fg3 });
    y += 32;
  }
  const section = (top, name, lines) => {
    p.path(`M${CORE_L} ${top}L${CORE_R} ${top}`, c.hair);
    p.label(cx, top + 17.5, name);
    lines.forEach((line, at) => p.text(cx, top + 35 + at * 14, line, { size: 10, fill: c.fg2, mono: true }));
  };
  section(370, 'FEATURES', ['orchestration/  tasks/', 'stats/  search/  shares/', 'git/  workspace/  plugins/', 'previews/  extensions/  …']);
  section(464, 'KIT · BASE', ['backends/shared/  adapters/', 'auth.ts  pairing.ts  exec.ts']);
  p.path(`M${CORE_L} 530L${CORE_R} 530`, c.hair);
  p.label(cx, 547.5, 'WORKER THREADS');
  [['riffet-exec', 'tmux, ps, lsof, pgrep off the loop'], ['riffet-wal', 'WAL checkpoint'], ['previews/browser-pdf.ts', 'PDF preview render']].forEach(([name, role], at) => {
    p.text(cx, 567 + at * 33, name, { size: 10.5, weight: 500, mono: true });
    p.text(cx, 580 + at * 33, role, { size: 9.5, fill: c.fg3 });
  });

  // Clients.
  p.rect(16, 110, LEFT.w + 16, 252, { stroke: c.bound, r: 10, dash: true });
  p.label(LEFT.x + 2, 127, 'CLIENTS');
  [['Web', 'React 19 · apps/web/src/sync'], ['macOS', 'SwiftUI + AppKit · RiffetKit'], ['iOS', 'SwiftUI · RiffetKit'], ['Android', 'Compose :shared · :client']]
    .forEach(([name, stack], at) => p.node(LEFT.x, 138 + at * 55, LEFT.w, 44, name, stack, { mono: false }));
  const GAP_L = [LEFT.x + LEFT.w + 8, SERVER.x];
  const leftEdge = (at, stroke, ends, proto, upper, lower, dash) => {
    const y = row(at);
    if (ends === 'out') p.edge(GAP_L[1], y, GAP_L[0], y, stroke, { dash });
    else p.edge(GAP_L[0], y, GAP_L[1], y, stroke, { ends: ends === 'both' ? 'both' : 'end', dash });
    p.wire(GAP_L[0] + 10, y - 7, proto, upper);
    if (lower) p.text(GAP_L[0] + 10, y + 15, lower, { size: 10, fill: c.fg3, mono: true });
  };
  leftEdge(0, c.ink, 'in', 'HTTP', 'JSON /api/*', 'cookie + CSRF | Bearer wkn_…');
  leftEdge(1, c.blue, 'out', 'SSE', '/api/v3/sessions/:id/sync', 'Last-Event-ID <gen>:<seq>');
  leftEdge(2, c.ink, 'both', 'WS', '/api/terminals/:id/ws', 'pane bytes · ≤ 256 KiB a message');
  leftEdge(3, c.blue, 'out', 'mDNS', '_riffet._tcp', 'wildcard bind only', true);

  // External services the server dials.
  p.rect(16, row(5) - 48, LEFT.w + 16, row(8) - row(5) + 76, { stroke: c.bound, r: 10, dash: true });
  p.label(LEFT.x + 2, row(5) - 31, 'EXTERNAL SERVICES');
  [[5, 'Feishu / Lark', 'Open Platform · bot'], [6, 'APNs', 'api.push.apple.com'], [7, 'Model gateway', 'configured base URL'], [8, 'npm registry', 'registry.npmjs.org']]
    .forEach(([at, name, sub]) => p.node(LEFT.x, row(at) - 19, LEFT.w, 38, name, sub, { mono: false }));
  leftEdge(5, c.ink, 'out', 'WSS', 'Lark.WSClient · events in', 'HTTPS REST out');
  leftEdge(6, c.ink, 'out', 'HTTP/2', 'POST /3/device/<token>', 'ES256 JWT from apns-key.json');
  leftEdge(7, c.ink, 'out', 'HTTPS', 'messages | responses', '| chat/completions');
  leftEdge(8, c.ink, 'out', 'HTTPS', 'GET /riffet/latest', 'update check');

  // Agent CLI and helper processes.
  const GAP_R = [SERVER.x + SERVER.w, PROC.x];
  p.label(PROC.x - 8, 106, 'AGENT CLI PROCESSES');
  p.rect(PROC.x - 8, 116, PROC.w + 16, row(1) + 27 - 116, { stroke: c.bound, r: 10, dash: true });
  p.text(PROC.x + 2, 137, 'tmux -S <state>/tmux.sock', { size: 10, fill: c.fg3, mono: true });
  const proc = (at, title, sub) => p.node(PROC.x, row(at) - 19, PROC.w, 38, title, sub);
  /** A driver's two channels: what it writes to the process and what it reads back. */
  const duplex = (at, write, read) => {
    const y = row(at);
    p.edge(GAP_R[0], y - 6, GAP_R[1], y - 6, c.ink);
    p.edge(GAP_R[1], y + 6, GAP_R[0], y + 6, c.blue);
    p.wire(GAP_R[0] + 10, y - 12.5, ...write);
    p.wire(GAP_R[0] + 10, y + 20, ...read);
  };
  const inbound = (at, upper, lower) => {
    const y = row(at);
    p.edge(GAP_R[1], y, GAP_R[0], y, c.ink);
    p.wire(GAP_R[0] + 10, y - 7, ...upper);
    p.text(GAP_R[0] + 10, y + 15, lower, { size: 10, fill: c.fg3, mono: true });
  };
  proc(0, 'claude', 'TUI in a tmux pane');
  proc(1, 'cursor-agent', 'TUI in a tmux pane');
  proc(2, 'codex | traex  app-server', 'detached · unix socket | ws loopback');
  proc(3, 'droid exec', 'child · one per conversation');
  proc(4, 'pi --mode rpc', 'child');
  proc(5, 'dsh', 'child · bridge dials back with a token');
  duplex(0, ['tmux', 'paste-buffer, send-keys'], ['file', '<id>.jsonl by byte offset']);
  duplex(1, ['tmux', 'paste-buffer, send-keys'], ['file', 'store.db (ro), live tap']);
  duplex(2, ['JSON-RPC', 'turn/start, turn/steer'], ['JSON-RPC', 'notifications']);
  duplex(3, ['stdin', 'JSON-RPC lines'], ['stdout', 'session_notification']);
  duplex(4, ['stdin', 'JSONL commands'], ['stdout', 'JSONL events']);
  duplex(5, ['tcp', '127.0.0.1 · JSON-RPC'], ['tcp', 'notifications']);
  p.text(GAP_R[0] + 10, row(6) + 3.5, 'in-process · no child', { size: 10, fill: c.fg3 });
  p.label(PROC.x - 8, row(6) + 3.5, 'HELPER PROCESSES');
  proc(7, 'plugin runtime', 'child per package · sandbox-exec');
  proc(8, 'riffet-mcp.mjs', 'MCP on stdio · spawned by the CLI');
  proc(9, 'hook-cli.mjs', 'per claude hook event · fails open');
  duplex(7, ['stdin', 'JSON lines · protocol 1'], ['stdout', 'JSON lines']);
  inbound(8, ['HTTP', 'POST /api/riffet-mcp'], 'Bearer wkm_… per conversation');
  inbound(9, ['HTTP', 'POST /hook on 127.0.0.1'], 'ephemeral port · Bearer');

  // Files.
  const FILES = SERVER.y + SERVER.h + 39;
  p.edge(SERVER.x + 28, SERVER.y + SERVER.h, SERVER.x + 28, FILES, c.ink, { ends: 'both' });
  p.text(SERVER.x + 40, FILES - 16, 'node:sqlite · fs', { size: 10, fill: c.fg2, mono: true });
  p.label(SERVER.x + SERVER.w, FILES - 16, 'FILES', undefined, 'end');
  p.node(SERVER.x, FILES, 232, 44, 'workbench.db', 'SQLite · WAL');
  p.node(SERVER.x + 244, FILES, 232, 44, '~/.local/share/riffet/', 'devices.json · daemon.json · server.log');
  p.node(PROC.x - 190, FILES, 178, 44, 'project working trees', 'cwd of each CLI · git');
  p.node(PROC.x, FILES, PROC.w, 44, 'CLI-owned state', '~/.claude · ~/.codex · ~/.cursor');

  // What the CLIs call on their own.
  for (let at = 0; at <= 5; at += 1) p.path(`M${PROC.x + PROC.w} ${row(at)}L${LANE} ${row(at)}`, c.ink);
  const BELOW = HOST.y + HOST.h + 20;
  p.edge(LANE, row(0), LANE, BELOW, c.ink);
  p.node(PROC.x, BELOW, HOST.x + HOST.w - PROC.x, 40, 'Model provider APIs', 'HTTPS · credentials held by each CLI', { mono: false });

  // Legend and notes.
  let lx = 24;
  const legend = (draw, value, width) => { draw(lx); p.text(lx + 34, BELOW + 23.5, value, { size: 10.5, fill: c.fg2 }); lx += width; };
  legend(x => p.edge(x, BELOW + 20, x + 26, BELOW + 20, c.ink), 'request: initiator → responder', 210);
  legend(x => p.edge(x, BELOW + 20, x + 26, BELOW + 20, c.blue), 'stream or read: direction of data', 218);
  legend(x => p.rect(x, BELOW + 13, 26, 14, { stroke: c.bound, r: 4, dash: true }), 'boundary', 96);
  legend(x => p.rect(x, BELOW + 13, 26, 14, { fill: c.cell, r: 3, stroke: c.hair }), 'module and its layer', 148);
  legend(x => p.rect(x, BELOW + 13, 26, 14, { fill: c.card, stroke: c.hair, r: 3 }), 'process, file or remote system', 0);
  [
    'riffet serve speaks HTTP/1.1 without TLS and binds 127.0.0.1 by default; a reverse proxy terminates TLS for remote access.',
    'Imports inside the server go one way: surfaces → features | drivers → kit → kernel → base, enforced by pnpm check:layers.',
    'RiffetKit is the KMP :client module built as a static framework: session state, cache, Ktor transport, SSE.',
  ].forEach((note, at) => p.text(24, BELOW + 54 + at * 16, note, { size: 10.5, fill: c.fg3 }));

  return p.svg(W, H, 'Riffet runtime view');
}

/** Figure 2: one message from a client to the CLI, and the CLI's output back to every client. */
function dataPath(mode) {
  const c = PALETTES[mode];
  const p = pen(c);
  const [W, H] = [1364, 656];
  p.titleBlock(W, 'Session core', `fig. 2 · subsystem · ${RELEASE}`);

  const col = at => 410 + at * 152;
  const [NODE, MID] = [132, 66];
  const ROW = { a: 122, b: 206, c: 300, d: 384 };
  const SERVER = { x: 396, y: 68, w: 768, h: 372 };
  const CLIENT = { x: 24, w: 144 };
  const CLI = { x: 1220, w: 120 };

  p.rect(SERVER.x, SERVER.y, SERVER.w, SERVER.h, { fill: c.host, stroke: c.hair, r: 12 });
  p.label(col(0), 89, 'PROCESS', 'riffet serve');
  p.label(col(4) + NODE, 89, 'WRITE PATH ABOVE · READ PATH BELOW', undefined, 'end');

  const node = (at, top, title, sub, h = 44) => p.node(col(at), top, NODE, h, title, sub, { size: 10, pad: 9 });
  // Write path.
  node(0, ROW.a, 'routes/native.ts', '202 · keyed by commandId');
  node(1, ROW.a, 'admission()', 'native/lane.ts · S3');
  node(2, ROW.a, 'NativeDispatcher', 'execute() · observe()');
  node(3, ROW.a, 'commitDispatchFence', 'binding persisted · S1');
  node(4, ROW.a, 'NativeBackendDriver', 'send() · steer()');
  for (let at = 0; at < 4; at += 1) p.edge(col(at) + NODE, ROW.a + 22, col(at + 1), ROW.a + 22, c.ink);

  // Between the paths: the run queue and what listens to the journal.
  p.store(col(0), ROW.b, NODE * 2 + 20, 40, 'runs · run_facts', 'the queue: one row per message');
  node(2, ROW.b, 'DispatchFeed', 'receipts · turn ends', 40);
  node(3, ROW.b, 'stats/ledger.ts', 'tool_calls · usage_steps', 40);
  node(4, ROW.b, 'LiveTranscriptIndex', 'message_index · FTS5', 40);
  const up = (x, from, to, stroke, name) => { p.edge(x, from, x, to, stroke); if (name) p.text(x + 8, (from + to) / 2 + 3.5, name, { size: 10, fill: c.fg2, mono: true }); };
  up(col(0) + MID, ROW.a + 44, ROW.b, c.ink, 'acceptNativeRun()');
  up(col(1) + MID, ROW.b, ROW.a + 44, c.blue, 'queued runs');
  up(col(2) + MID, ROW.b, ROW.a + 44, c.blue, 'observe()');

  // Read path.
  node(4, ROW.c, 'TranscriptSource', 'pull() · watch() · drain()');
  node(3, ROW.c, 'TranscriptIngest', 'sync/ingest.ts');
  node(2, ROW.c, 'Journal', 'seq · generation');
  node(1, ROW.c, 'TimelineService', 'LaneFold → rows');
  node(0, ROW.c, 'SyncConnection', 'SSE frames · gzip');
  for (let at = 4; at > 0; at -= 1) p.edge(col(at), ROW.c + 22, col(at - 1) + NODE, ROW.c + 22, c.blue);
  const BUS = 273;
  p.path(`M${col(2) + MID} ${ROW.c}L${col(2) + MID} ${BUS}L${col(4) + MID} ${BUS}`, c.blue);
  for (const at of [2, 3, 4]) p.edge(col(at) + MID, BUS, col(at) + MID, ROW.b + 40, c.blue);
  p.text(col(2) + MID + 8, BUS + 15, 'JournalFeed', { size: 10, fill: c.fg2, mono: true });

  // Tables the read path owns.
  p.store(col(1), ROW.d, NODE, 40, 'timeline_rows', '_turns · _heads');
  p.store(col(2), ROW.d, NODE, 40, 'journal_events', 'journal_heads · blobs');
  up(col(1) + MID, ROW.c + 44, ROW.d, c.ink, 'upsert');
  up(col(2) + MID, ROW.c + 44, ROW.d, c.ink, 'append');
  p.text(col(3), ROW.d + 17, 'journal_events: append-only, seq contiguous per session.', { size: 10, fill: c.fg3 });
  p.text(col(3), ROW.d + 31, 'A lane that starts over gets a new generation; clients reset.', { size: 10, fill: c.fg3 });

  // Client.
  p.rect(CLIENT.x, ROW.a, CLIENT.w, ROW.c + 44 - ROW.a, { fill: c.card, stroke: c.hair });
  p.text(CLIENT.x + 10, ROW.a + 21, 'Client', { size: 12, weight: 600 });
  [['SessionSync', c.ink], ['apps/web/src/sync', c.fg3], [':client ui/state', c.fg3]].forEach(([line, fill], at) => p.text(CLIENT.x + 10, ROW.a + 42 + at * 14, line, { size: 10, fill, mono: true }));
  [['cache', c.ink], ['IndexedDB | files', c.fg3]].forEach(([line, fill], at) => p.text(CLIENT.x + 10, ROW.c + 16 + at * 14, line, { size: 10, fill, mono: true }));
  const GAP = [CLIENT.x + CLIENT.w, col(0)];
  p.edge(GAP[0], ROW.a + 22, GAP[1], ROW.a + 22, c.ink);
  p.text(GAP[0] + 10, ROW.a + 15, 'POST /api/sessions/:id/native/send', { size: 10, fill: c.fg2, mono: true });
  p.text(GAP[0] + 10, ROW.a + 37, '{ commandId, … } → 202 Run', { size: 10, fill: c.fg3, mono: true });
  p.edge(GAP[1], ROW.c + 22, GAP[0], ROW.c + 22, c.blue);
  p.wire(GAP[0] + 10, ROW.c + 15, 'SSE', '/api/v3/sessions/:id/sync');
  p.text(GAP[0] + 10, ROW.c + 37, 'hello · rows · status · caughtUp', { size: 10, fill: c.fg3, mono: true });
  p.text(GAP[0] + 10, ROW.c + 51, 'resume: Last-Event-ID <gen>:<seq>', { size: 10, fill: c.fg3, mono: true });

  // Agent CLI.
  p.rect(CLI.x, ROW.a, CLI.w, ROW.c + 44 - ROW.a, { fill: c.card, stroke: c.hair });
  p.text(CLI.x + 10, ROW.a + 21, 'Agent CLI', { size: 12, weight: 600 });
  p.text(CLI.x + 10, ROW.a + 36, 'see fig. 3', { size: 10, fill: c.fg3 });
  p.edge(col(4) + NODE, ROW.a + 22, CLI.x, ROW.a + 22, c.ink);
  p.edge(CLI.x, ROW.c + 22, col(4) + NODE, ROW.c + 22, c.blue);
  p.text(col(4) + NODE + 35, ROW.a + 15, 'input', { size: 10, fill: c.fg2, mono: true, anchor: 'middle' });
  p.text(col(4) + NODE + 35, ROW.c + 15, 'transcript', { size: 10, fill: c.fg2, mono: true, anchor: 'middle' });

  // Delivery states, under the component that advances each.
  const CHIP = 468;
  p.label(24, CHIP + 12, 'RUN.DELIVERY');
  p.text(24, CHIP + 30, 'packages/contracts/src/run.ts', { size: 10, fill: c.fg3, mono: true });
  p.text(24, CHIP + 44, 'docs/DELIVERY.md §3', { size: 10, fill: c.fg3, mono: true });
  const chip = (x, top, name) => { p.rect(x, top, NODE, 26, { fill: c.card, stroke: c.hair, r: 13 }); p.text(x + NODE / 2, top + 17, name, { size: 10.5, weight: 500, mono: true, anchor: 'middle' }); };
  ['queued', 'preparing', 'dispatching', 'input_sent', 'observed'].forEach((name, at) => {
    chip(col(at), CHIP, name);
    if (at) p.edge(col(at - 1) + NODE, CHIP + 13, col(at), CHIP + 13, c.ink);
  });
  const signal = (at, value) => p.text(col(at), CHIP + 42, value, { size: 10, fill: c.fg3 });
  signal(0, 'until admission is clear');
  signal(1, 'until the fence is committed');
  signal(2, 'until a receipt: transcript echo | hook with commandId');
  signal(4, 'until the turn ends');
  chip(col(3), CHIP + 60, 'uncertain');
  p.edge(col(3) + 120, CHIP + 26, col(3) + 120, CHIP + 60, c.ink);
  p.path(`M${col(3) + NODE} ${CHIP + 73}L${col(4) + 120} ${CHIP + 73}`, c.blue);
  p.edge(col(4) + 120, CHIP + 73, col(4) + 120, CHIP + 26, c.blue);
  p.text(col(4) + 8, CHIP + 68, 'late receipt', { size: 10, fill: c.fg2, mono: true });
  p.text(col(3) - 10, CHIP + 70, 'receipt window ended | CLI exited during the write', { size: 10, fill: c.fg3, anchor: 'end' });
  p.text(col(3) - 10, CHIP + 84, 'no rewrite (S1); holds the queue until resolved', { size: 10, fill: c.fg3, anchor: 'end' });
  p.text(col(0), CHIP + 112, 'failed | cancelled are final. preparing → failed after 3 min of CLI_BUSY.', { size: 10, fill: c.fg3 });

  // Legend.
  let lx = 24;
  const legend = (draw, value, width) => { draw(lx); p.text(lx + 34, 631.5, value, { size: 10.5, fill: c.fg2 }); lx += width; };
  legend(x => p.edge(x, 628, x + 26, 628, c.ink), 'call or write', 118);
  legend(x => p.edge(x, 628, x + 26, 628, c.blue), 'event or read: direction of data', 208);
  legend(x => p.store(x, 621, 26, 14), 'table in workbench.db', 156);
  legend(x => p.rect(x, 621, 26, 14, { fill: c.card, stroke: c.hair, r: 3 }), 'class, function or module', 176);
  p.text(lx, 631.5, 'S1 at most one write per message · S3 one turn at a time (docs/DELIVERY.md §2)', { size: 10.5, fill: c.fg3 });

  return p.svg(W, H, 'Riffet session data path');
}

/** Figure 1: the subsystems Riffet is made of, what each is responsible for, and how they relate. */
function system(mode) {
  const c = PALETTES[mode];
  const p = pen(c);
  const [W, H] = [1200, 1000];
  p.titleBlock(W, 'System architecture', `fig. 1 · logical view · ${RELEASE}`);

  const { tag, unit } = p;
  const flow = (x, from, to, stroke, name, note) => {
    p.edge(x, from, x, to, stroke);
    const mid = (from + to) / 2 + (Math.min(from, to) > 600 ? 14 : 0);
    if (name) p.text(x + 10, mid + (note ? -2 : 3.5), name, { size: 10.5, weight: 600, fill: stroke === c.blue ? c.blue : c.ink });
    if (note) p.text(x + 10, mid + 11, note, { size: 10, fill: c.fg3 });
  };

  const SIDE = { left: 40, right: 960, w: 200 };
  const SPINE = { x: 260, w: 680 };
  const [CMD, OBS] = [420, 742];

  // Clients.
  unit(SPINE.x, 72, SPINE.w, 58, { title: 'Clients', path: 'Web · macOS · iOS · Android', does: ['Render rows, keep a replica and a cache of them, send commands.'] });
  flow(CMD, 130, 204, c.ink, 'commands', 'idempotent by command id');
  flow(OBS, 204, 130, c.blue, 'rows', 'resumable from a cursor');

  // Server.
  p.rect(24, 152, 1152, 542, { stroke: c.bound, r: 12, dash: true });
  p.label(SIDE.left, 174, 'RIFFET SERVER', 'one process · one user');
  tag(SIDE.left + 248, 174, 'P6');
  p.rect(SIDE.left, 204, 1120, 58, { fill: c.host, stroke: c.hair, r: 7 });
  unit(SIDE.left, 204, 1120, 58, { title: 'Access', path: 'auth · pairing · routes/ · channels/', fill: 'none', stroke: 'none',
    does: ['Authenticates devices, terminates client transports, and adapts chat channels to the same commands and rows.'] });
  p.text(SIDE.left + 1108, 242, 'Device · token · pairing · HTTP · SSE · WebSocket · channel', { size: 10, fill: c.fg3, anchor: 'end', mono: true });
  p.edge(CMD, 262, CMD, 322, c.ink);
  p.edge(OBS, 322, OBS, 262, c.blue);

  // Session core.
  p.rect(SPINE.x, 286, SPINE.w, 252, { fill: c.host, stroke: c.hair, r: 9 });
  p.label(SPINE.x + 16, 308, 'SESSION CORE');
  tag(SPINE.x + 112, 308, 'P2');
  p.text(SPINE.x + SPINE.w - 16, 308, 'the same model for every agent', { size: 10, fill: c.fg3, anchor: 'end' });
  unit(276, 322, 224, 200, { title: 'Delivery', id: 'P3', path: 'native/', does: ['Carries one message into the', 'agent and tracks it to a receipt.'], has: ['Run · queue · admission', 'dispatch fence · receipt', '', 'at most one write per message', 'one turn at a time', 'a held queue states its reason'] });
  unit(560, 322, 364, 56, { title: 'Sync', id: 'P5', path: 'sync/', does: ['Streams rows to each client from its cursor.'], has: [] });
  unit(560, 394, 364, 56, { title: 'Timeline', id: 'P5', path: 'timeline/', does: ['Folds events into the rows every client renders.'], has: [] });
  unit(560, 466, 364, 56, { title: 'Journal', id: 'P4', path: 'journal/', does: ['Records what the agent did: append-only, ordered per session.'], has: [] });
  p.edge(OBS, 466, OBS, 450, c.blue);
  p.edge(OBS, 394, OBS, 378, c.blue);
  p.edge(560, 494, 500, 494, c.blue);
  p.text(530, 487, 'receipt', { size: 10, fill: c.blue, anchor: 'middle', weight: 600 });

  // Around the core.
  unit(SIDE.left, 286, SIDE.w, 118, { title: 'Automation', path: 'orchestration/', does: ['Issues commands without a person:', 'schedules, tasks, hand-offs.'], has: ['Task · Automation', 'wake-up · handoff · review'] });
  p.edge(SIDE.left + SIDE.w, 345, 276, 345, c.ink);
  unit(SIDE.left, 420, SIDE.w, 262, { title: 'Platform', path: 'store.ts · …', does: ['Runs the server on one machine', 'with no external service.'], has: ['Store: one SQLite file', 'settings', 'process execution', 'worker threads', 'service lifecycle', 'diagnostics · update'] });
  unit(SIDE.right, 286, SIDE.w, 118, { title: 'Workspace', path: 'workspace/ · git/', does: ['Serves the directories agents', 'work in.'], has: ['Project · files · git', 'working tree · preview'] });
  unit(SIDE.right, 420, SIDE.w, 118, { title: 'Derived views', path: 'stats/ · …', does: ['Read models built from the', 'journal as it grows.'], has: ['usage · search index · title', 'summary · share · push'] });
  p.edge(924, 494, SIDE.right, 494, c.blue);

  // Agent integration.
  p.rect(SPINE.x, 562, SPINE.w, 120, { fill: c.host, stroke: c.hair, r: 9 });
  p.label(SPINE.x + 16, 584, 'AGENT INTEGRATION');
  p.text(CMD + 20, 584, 'one driver per agent, one contract for all', { size: 10, fill: c.fg3 });
  unit(276, 596, 224, 70, { title: 'Input', path: 'driver', does: ['send · steer · interrupt · respond'], has: ['terminal host | RPC call'] });
  unit(560, 596, 364, 70, { title: 'Observation', path: 'driver', does: ['transcript source · status · interaction · capabilities'], has: ['transcript file | protocol stream | hooks | MCP tools'] });
  p.edge(CMD, 522, CMD, 596, c.ink);
  p.edge(OBS, 596, OBS, 522, c.blue);
  unit(SIDE.right, 562, SIDE.w, 120, { title: 'Extension', id: 'P7', path: 'plugins-host/', does: ['Loads plugins at declared', 'extension points.'], has: ['driver · model source', 'task provider · publisher', 'view · command · channel'] });
  p.edge(SIDE.right, 622, SPINE.x + SPINE.w, 622, c.fg2, { dash: true });

  // Agent CLI.
  flow(CMD, 666, 752, c.ink, 'input', 'through the CLI’s own interface');
  flow(OBS, 752, 666, c.blue, 'events', 'transcript, protocol stream, hooks');
  unit(SPINE.x, 752, SPINE.w, 58, { title: 'Agent CLI', id: 'P1', path: 'terminal-driven · protocol-driven · in-process', does: ['A vendor program on the same host. It keeps its own credentials and calls its model provider itself.'] });

  // Legend.
  let lx = 24;
  const legend = (draw, value, width) => { draw(lx); p.text(lx + 34, 839.5, value, { size: 10.5, fill: c.fg2 }); lx += width; };
  legend(x => p.edge(x, 836, x + 26, 836, c.ink), 'command', 104);
  legend(x => p.edge(x, 836, x + 26, 836, c.blue), 'event or row', 122);
  legend(x => p.edge(x, 836, x + 26, 836, c.fg2, { dash: true }), 'contributes implementations', 204);
  legend(x => tag(x + 2, 840, 'Pn'), 'principle realized here', 168);
  p.text(lx, 839.5, 'Position follows the flow of a message. Import direction is the layering view (fig. 6).', { size: 10.5, fill: c.fg3 });

  // Principles.
  p.path(`M24 858L${W - 24} 858`, c.hair);
  p.label(24, 879, 'DESIGN PRINCIPLES');
  [
    ['P1', 'The vendor CLI is the agent.', 'Riffet drives the installed program through its own interface and does not reimplement it.'],
    ['P2', 'One session model.', 'Differences between agents end at the driver contract; nothing above it names a vendor.'],
    ['P3', 'Commands and observations are separate paths.', 'A message is delivered when its receipt is observed, not when it was written.'],
    ['P4', 'The journal is the source of truth.', 'Timeline, status, usage and search are projections of it.'],
    ['P5', 'The server folds, clients render.', 'Every client resumes from a cursor and receives the same rows.'],
    ['P6', 'Single node.', 'One process, one database file, one user; no external service is required.'],
    ['P7', 'Dependencies point inward.', 'Surfaces and drivers depend on the core, never the reverse; optional capability arrives as a plugin.'],
  ].forEach(([id, rule, detail], at) => {
    const y = 899 + at * 14.5;
    p.text(24, y, id, { size: 10, weight: 600, fill: c.blue, mono: true });
    p.add(`<text x="52" y="${y}" font-size="10.5"><tspan font-weight="600" fill="${c.ink}">${esc(rule)}</tspan><tspan dx="6" fill="${c.fg3}">${esc(detail)}</tspan></text>`);
  });

  return p.svg(W, H, 'Riffet system architecture');
}

/** Figure 3: the driver contract, the ways an agent is driven, and the mechanisms drivers share. */
function agentIntegration(mode) {
  const c = PALETTES[mode];
  const p = pen(c);
  const { unit } = p;
  const [W, H] = [1200, 806];
  p.titleBlock(W, 'Agent integration', `fig. 3 · subsystem · ${RELEASE}`);
  const cellX = at => 40 + at * 227;
  const CELL = 212;

  // What the core hands over and takes back.
  p.node(cellX(1), 72, CELL, 40, 'Delivery', 'session core', { mono: false });
  p.node(cellX(2), 72, CELL, 40, 'Journal', 'session core, through TranscriptIngest', { mono: false });

  // The contract.
  p.rect(24, 150, 1152, 142, { fill: c.host, stroke: c.hair, r: 9 });
  p.label(40, 172, 'DRIVER CONTRACT', 'NativeBackendDriver');
  p.tag(274, 172, 'P2');
  p.text(1160, 172, 'implemented once per agent · backends/types.ts', { size: 10, fill: c.fg3, anchor: 'end', mono: true });
  [
    ['Lifecycle', 'Find the CLI, open or resume.', ['available · openOrResume', 'dispose · close']],
    ['Input', 'Write a message, stop a turn.', ['send · steer', 'interrupt · respond']],
    ['Observation', 'Expose output and live state.', ['transcript · status', 'interaction · subscribe']],
    ['Configuration', 'Profiles, models and modes.', ['profiles · configure', 'listModels · usage']],
    ['Declared facts', 'What the core may assume.', ['traits', 'capabilities']],
  ].forEach(([title, does, has], at) => unit(cellX(at), 184, CELL, 78, { title, does: [does], has }));
  p.edge(cellX(1) + CELL / 2, 112, cellX(1) + CELL / 2, 184, c.ink);
  p.edge(cellX(2) + CELL / 2, 184, cellX(2) + CELL / 2, 112, c.blue);
  p.text(40, 281, 'optional groups   extensions · external · stored · admin · projectConfigs', { size: 10, fill: c.fg3, mono: true });

  // Integration modes.
  const MODE = { y: 332, w: 370, h: 156 };
  const modeX = at => 24 + at * 391;
  [
    ['Terminal-driven', 'The CLI runs as a TUI in a terminal pane.', [['transport', 'tmux pane on a private socket'], ['input', 'paste, then Enter once the prompt shows the text'], ['observe', 'transcript file by offset · hooks · screen'], ['agents', 'Claude Code · Cursor']]],
    ['Protocol-driven', 'The CLI exposes a machine interface.', [['transport', 'unix socket | stdio | loopback TCP'], ['input', 'request: start turn, steer, interrupt'], ['observe', 'notifications on the same connection'], ['agents', 'Codex · TRAE · Droid · pi · DeepSeek Harness']]],
    ['In-process', 'No CLI: the server holds the conversation.', [['transport', 'HTTPS to a configured model gateway'], ['input', 'gateway request'], ['observe', 'transcript file the server writes'], ['agents', 'chat']]],
  ].forEach(([title, summary, rows], at) => {
    const x = modeX(at);
    p.rect(x, MODE.y, MODE.w, MODE.h, { fill: c.card, stroke: c.hair, r: 7 });
    p.text(x + 14, MODE.y + 23, title, { size: 12.5, weight: 600 });
    p.text(x + 14, MODE.y + 40, summary, { size: 10.5, fill: c.fg2 });
    p.path(`M${x + 14} ${MODE.y + 52}L${x + MODE.w - 14} ${MODE.y + 52}`, c.hair);
    rows.forEach(([key, value], row) => {
      p.text(x + 14, MODE.y + 73 + row * 20, key, { size: 9.5, fill: c.fg3, mono: true });
      p.text(x + 84, MODE.y + 73 + row * 20, value, { size: 10.5 });
    });
    p.edge(x + MODE.w / 2, MODE.y, x + MODE.w / 2, 292, c.fg2, { dash: true });
    if (at < 2) p.edge(x + MODE.w / 2, MODE.y + MODE.h, x + MODE.w / 2, 526, c.fg2, { dash: true });
  });

  // Mechanisms.
  p.rect(24, 526, 1152, 116, { fill: c.host, stroke: c.hair, r: 9 });
  p.label(40, 548, 'SHARED MECHANISMS', 'backends/shared · terminal/ · agent-host/ · riffet-mcp/');
  [
    ['Terminal host', ['tmux on a private socket: panes', 'for TUIs and for user shells']],
    ['Process and RPC', ['child and detached processes;', 'JSON-RPC and JSONL framing']],
    ['Hook bridge', ['CLI hooks posted to a loopback', 'listener; fails open']],
    ['Tool bridge', ['MCP server the CLI spawns; tools', 'call back with a per-session key']],
    ['Interaction', ['permission prompts and questions', 'as one model, protocol or screen']],
  ].forEach(([title, does], at) => unit(cellX(at), 560, CELL, 66, { title, does }));

  // The agent.
  p.edge(540, 642, 540, 686, c.ink);
  p.edge(660, 686, 660, 642, c.blue);
  p.text(530, 668, 'input', { size: 10.5, weight: 600, anchor: 'end' });
  p.text(670, 668, 'events', { size: 10.5, weight: 600, fill: c.blue });
  unit(24, 686, 1152, 56, { title: 'Agent CLI', id: 'P1', path: 'claude · cursor-agent · codex · traex · droid · pi · dsh',
    does: ['A vendor program on the same host, started and observed through the mechanisms above. It calls its model provider itself.'] });

  let lx = 24;
  const legend = (draw, value, width) => { draw(lx); p.text(lx + 34, 775.5, value, { size: 10.5, fill: c.fg2 }); lx += width; };
  legend(x => p.edge(x, 772, x + 26, 772, c.ink), 'command', 104);
  legend(x => p.edge(x, 772, x + 26, 772, c.blue), 'event', 84);
  legend(x => p.edge(x, 772, x + 26, 772, c.fg2, { dash: true }), 'implements, or uses', 160);
  p.text(lx, 775.5, 'A plugin driver implements the same contract through PluginBackendDriver and a restricted AgentHost (fig. 5).', { size: 10.5, fill: c.fg3 });
  return p.svg(W, H, 'Riffet agent integration');
}

/** Figure 4: what a client is made of in each implementation, and what the server's edge does. */
function accessClients(mode) {
  const c = PALETTES[mode];
  const p = pen(c);
  const { unit } = p;
  const [W, H] = [1200, 836];
  p.titleBlock(W, 'Access and clients', `fig. 4 · subsystem · ${RELEASE}`);

  // Clients: one anatomy, two implementations.
  p.rect(24, 68, 1152, 378, { stroke: c.bound, r: 12, dash: true });
  p.label(40, 90, 'CLIENTS', 'one anatomy, two implementations');
  const [WEB, KMP] = [{ x: 246, w: 274 }, { x: 536, w: 624 }];
  p.text(WEB.x, 116, 'Web', { size: 12, weight: 600 });
  p.text(KMP.x, 116, 'Kotlin Multiplatform', { size: 12, weight: 600 });
  p.text(KMP.x + KMP.w, 116, 'Android · iOS · macOS (RiffetKit framework through SKIE)', { size: 10, fill: c.fg3, anchor: 'end', mono: true });
  const slot = (x, y, w, value) => { p.rect(x, y, w, 36, { fill: c.card, stroke: c.hair, r: 5 }); p.text(x + 10, y + 22, value, { size: 10, fill: c.fg2, mono: true }); };
  [
    ['UI', 'platform-native presentation', 'React 19 · apps/web', ['Compose · :shared', 'SwiftUI · iosApp', 'SwiftUI + AppKit · apps/macos']],
    ['Session state', 'what a screen shows of a session', 'stores · useSyncExternalStore', ':client · SessionStore · SessionComposer'],
    ['Sync engine', 'replica of rows, resumed from a cursor', 'sync/session.ts · lane.ts · rows.ts', ':client · SessionSync.kt'],
    ['Timeline rules', 'row identity, order and merge', 'packages/timeline, shared with the server', ':core · SyncRows.kt, a second implementation'],
    ['Cache', 'rows kept across launches', 'IndexedDB · sync/cache.ts', ':client · files'],
    ['Transport', 'requests, streams, sockets', 'fetch · EventSource · WebSocket', 'Ktor · OkHttp on Android, Darwin on Apple'],
    ['Wire types', 'the contract in each language', 'packages/contracts · TypeScript', ':contracts · Kotlin DTOs checked against generated fixtures'],
  ].forEach(([name, role, web, kmp], at) => {
    const y = 128 + at * 44;
    p.text(40, y + 15, name, { size: 11.5, weight: 600 });
    p.text(40, y + 29, role, { size: 10, fill: c.fg3 });
    slot(WEB.x, y, WEB.w, web);
    if (Array.isArray(kmp)) kmp.forEach((value, part) => slot(KMP.x + part * 213.5, y, 197, value));
    else slot(KMP.x, y, KMP.w, kmp);
  });

  // The wire.
  const wire = (x, stroke, ends, name, note) => {
    if (ends === 'up') p.edge(x, 536, x, 446, stroke); else p.edge(x, 446, x, 536, stroke, { ends: ends === 'both' ? 'both' : 'end' });
    p.text(x + 10, 488, name, { size: 10.5, weight: 600, fill: stroke });
    p.text(x + 10, 502, note, { size: 10, fill: c.fg3, mono: true });
  };
  wire(120, c.ink, 'down', 'commands and queries', 'HTTP JSON · idempotent by commandId');
  wire(500, c.blue, 'up', 'rows and live state', 'SSE · cursor <generation>:<seq>');
  wire(880, c.ink, 'both', 'terminal bytes', 'WebSocket');

  // Access.
  p.rect(24, 536, 1152, 148, { fill: c.host, stroke: c.hair, r: 9 });
  p.label(40, 558, 'ACCESS', 'riffet serve');
  const cellX = at => 40 + at * 227;
  [
    ['Identity', 'auth.ts', ['browser: signed cookie + CSRF', 'device: revocable bearer token', 'revocation closes open streams']],
    ['Pairing', 'pairing.ts', ['one-time code with a short TTL', 'pair, then prove possession', 'devices stored in devices.json']],
    ['Discovery', 'discovery.ts', ['mDNS service _riffet._tcp', 'only on a wildcard bind', 'off with --no-mdns']],
    ['Transports', 'routes/', ['HTTP JSON: commands, queries', 'SSE: rows, lists, device events', 'WebSocket: terminals, channels']],
    ['Channels', 'channels/', ['a chat platform as a client', 'binding: chat to session', 'rows projected to messages']],
  ].forEach(([title, path, does], at) => unit(cellX(at), 570, 212, 98, { title, path, does }));
  p.edge(540, 684, 540, 726, c.ink);
  p.edge(660, 726, 660, 684, c.blue);
  unit(24, 726, 1152, 44, { title: 'Session core', path: 'fig. 2', does: [] });
  p.text(140, 747, 'Delivery takes the commands; Sync supplies the rows.', { size: 10.5, fill: c.fg2 });

  let lx = 24;
  const legend = (draw, value, width) => { draw(lx); p.text(lx + 34, 803.5, value, { size: 10.5, fill: c.fg2 }); lx += width; };
  legend(x => p.edge(x, 800, x + 26, 800, c.ink), 'request', 96);
  legend(x => p.edge(x, 800, x + 26, 800, c.blue), 'stream', 90);
  p.text(lx, 803.5, 'Wire contract: packages/contracts (zod) generates JSON Schema snapshots and Kotlin / Swift fixtures; pnpm gen:contracts:check runs in CI.', { size: 10.5, fill: c.fg3 });
  return p.svg(W, H, 'Riffet access and clients');
}

/** Figure 5: what a plugin is, where it runs, and which subsystem each extension point extends. */
function extension(mode) {
  const c = PALETTES[mode];
  const p = pen(c);
  const { unit } = p;
  const [W, H] = [1200, 664];
  p.titleBlock(W, 'Extension', `fig. 5 · subsystem · ${RELEASE}`);

  // Plugin, host, execution.
  const TOP = { y: 72, h: 190 };
  unit(24, TOP.y, 280, TOP.h, { title: 'Plugin', id: 'P7', path: '@riffet/plugin-api' });
  [['manifest', 'id, apiVersion, settings, contributes'], ['detect()', 'optional availability probe'], ['activate()', 'returns its contributions']].forEach(([key, value], at) => {
    p.text(36, TOP.y + 44 + at * 30, key, { size: 10.5, weight: 500, mono: true });
    p.text(36, TOP.y + 57 + at * 30, value, { size: 10, fill: c.fg3 });
  });
  p.text(36, TOP.y + 148, 'PLUGIN_API_VERSION 1', { size: 10, fill: c.fg2, mono: true });
  p.text(36, TOP.y + 162, 'additive changes only', { size: 10, fill: c.fg3 });

  unit(368, TOP.y, 400, TOP.h, { title: 'Plugin host', path: 'plugins-host/ · plugins/',
    does: ['Registry and lifecycle: discover, enable, activate, deactivate.', 'Trust is recorded by the host; a package cannot assert it.', 'Sources: plugin index, local package, development directory.'] });
  p.text(380, TOP.y + 104, 'PluginHost', { size: 10.5, weight: 500, mono: true });
  p.text(380, TOP.y + 118, 'the only way a plugin reaches the server:', { size: 10, fill: c.fg3 });
  p.text(380, TOP.y + 134, 'child process · CLI lookup · model catalog', { size: 10, fill: c.fg2, mono: true });
  p.text(380, TOP.y + 148, 'private state directory · secrets', { size: 10, fill: c.fg2, mono: true });

  unit(832, TOP.y, 344, TOP.h, { title: 'Execution', path: 'process.ts · sandbox.ts' });
  p.cell(844, TOP.y + 32, 320, 50, '', '');
  p.text(854, TOP.y + 51, 'In process', { size: 11.5, weight: 600 });
  p.text(854, TOP.y + 68, 'built-in, development and explicitly trusted packages', { size: 10, fill: c.fg2 });
  p.cell(844, TOP.y + 90, 320, 88, '', '');
  p.text(854, TOP.y + 109, 'Isolated process', { size: 11.5, weight: 600 });
  ['installed packages, by default', 'Node permission model inside a macOS Seatbelt sandbox', 'JSON lines on stdio, protocol 1', 'no OS sandbox: refused unless the operator opts in']
    .forEach((line, at) => p.text(854, TOP.y + 126 + at * 14, line, { size: 10, fill: c.fg2 }));
  const link = (from, to, name) => { p.edge(from, TOP.y + 95, to, TOP.y + 95, c.fg2); p.text((from + to) / 2, TOP.y + 88, name, { size: 10, fill: c.fg3, anchor: 'middle' }); };
  link(304, 368, 'loaded by');
  link(768, 832, 'runs in');

  // Extension points.
  p.rect(24, 298, 1152, 272, { fill: c.host, stroke: c.hair, r: 9 });
  p.label(40, 320, 'EXTENSION POINTS', 'by the subsystem they extend (fig. 1)');
  const colX = at => 40 + at * 283;
  [
    ['Agent integration', [['agentBackends', 'a driver for another agent (experimental)'], ['modelSources', 'endpoints, credentials, model catalog'], ['runtimeHooks', 'a process attached to an agent runtime'], ['agentTools  ◆', 'tools served to agents over Riffet MCP']]],
    ['Automation · Derived views', [['taskProviders', 'detect, list and describe project tasks'], ['sharePublisher', 'where a shared session is published']]],
    ['Clients · Access', [['contributes.views', 'web views added to the workbench'], ['commands', 'commands, with optional key bindings'], ['channels  ◆', 'one WebSocket per session'], ['page · actions', 'the plugin’s own page and settings actions'], ['avatarStyles', 'deterministic SVG avatars']]],
    ['Platform', [['settings', 'declared in the manifest, stored by the host'], ['status', 'state shown in settings'], ['doctorChecks', 'rows in riffet doctor']]],
  ].forEach(([target, points], at) => {
    const x = colX(at);
    p.rect(x, 334, 268, 220, { fill: c.card, stroke: c.hair, r: 7 });
    p.text(x + 12, 355, target, { size: 11.5, weight: 600 });
    p.path(`M${x + 12} 366L${x + 256} 366`, c.hair);
    points.forEach(([name, role], row) => {
      p.text(x + 12, 386 + row * 34, name, { size: 10.5, weight: 500, mono: true });
      p.text(x + 12, 399 + row * 34, role, { size: 10, fill: c.fg3 });
    });
  });

  p.text(24, 598, '◆  in-process packages only', { size: 10.5, fill: c.fg2 });
  p.text(24, 618, 'Built-in plugins live in plugins/riffet/; the Cursor driver is one of them. A plugin never receives the store, the HTTP server or the terminal service.', { size: 10.5, fill: c.fg3 });
  p.text(24, 634, 'Command ids, queueing, delivery records, the journal and session ownership stay in the core for plugin drivers as well.', { size: 10.5, fill: c.fg3 });
  return p.svg(W, H, 'Riffet extension');
}

/** Figure 6: which code may import which. */
function layers(mode) {
  const c = PALETTES[mode];
  const p = pen(c);
  const [W, H] = [1200, 724];
  p.titleBlock(W, 'Layering', `fig. 6 · development view · ${RELEASE}`);

  const STACK = { x: 24, w: 780 };
  const band = (x, y, w, name, kind, role, modules) => {
    p.rect(x, y, w, 60, { fill: kind === 'open' ? c.host : c.card, stroke: c.hair, r: 7 });
    p.text(x + 14, y + 24, name, { size: 12.5, weight: 600 });
    p.text(x + 14 + name.length * 7 + 10, y + 24, kind, { size: 9.5, fill: c.fg3, mono: true });
    p.text(x + w - 14, y + 24, role, { size: 10.5, fill: c.fg3, anchor: 'end' });
    p.text(x + 14, y + 45, modules, { size: 10, fill: c.fg2, mono: true });
  };
  p.label(STACK.x, 86, 'APPS/SERVER/SRC', 'scripts/check-layers.mjs');
  const top = at => 98 + at * 70;
  band(STACK.x, top(0), STACK.w, 'root', 'open', 'the only place that knows every module', 'app.ts · index.ts · cli*.ts · doctor.ts');
  band(STACK.x, top(1), STACK.w, 'surfaces', 'closed', 'protocol translation', 'routes/ · channels/');
  band(STACK.x, top(2), 250, 'drivers', 'closed', 'one agent each', 'backends/<name>/');
  band(STACK.x + 262, top(2), STACK.w - 262, 'features', 'closed', 'one capability each', 'git · workspace · orchestration · tasks · stats · search · plugins-host · …');
  band(STACK.x, top(3), STACK.w, 'kit', 'open', 'mechanisms drivers share: subprocess, hooks, waiting', 'backends/shared/ · adapters/');
  band(STACK.x, top(4), STACK.w, 'kernel', 'open', 'the read and write spine of a session; names no concrete backend', 'store.ts · journal · timeline · sync · native · backends/*.ts · terminal · agent-host · settings · auxiliary');
  band(STACK.x, top(5), STACK.w, 'base', 'open', 'knows nothing of sessions', 'errors · environment · exec · auth · pairing · discovery · metrics · prompts · …');
  p.edge(STACK.x + STACK.w + 22, top(0), STACK.x + STACK.w + 22, top(5) + 60, c.ink);

  // Rules.
  const RULES = STACK.x + STACK.w + 46;
  p.label(RULES, 86, 'RULES');
  p.tag(RULES + 46, 86, 'P7');
  [
    ['imports', ['A file imports its own module and', 'modules of lower layers.']],
    ['open', ['Modules of the layer may import', 'each other.']],
    ['closed', ['No imports between sibling modules.', 'What they need from each other is', 'passed in by app.ts.']],
    ['check', ['pnpm check:layers runs in CI. Module', 'pairs that cross a layer are counted;', 'the count in layers-baseline.json may', 'only go down.']],
  ].reduce((y, [key, lines]) => {
    p.text(RULES, y, key, { size: 10.5, weight: 500, mono: true });
    lines.forEach((line, at) => p.text(RULES, y + 15 + at * 14, line, { size: 10.5, fill: c.fg2 }));
    return y + 15 + lines.length * 14 + 14;
  }, 112);

  // Packages.
  const GRID = { y: 560, label: 220, col: 150 };
  p.path(`M24 ${GRID.y - 24}L${W - 24} ${GRID.y - 24}`, c.hair);
  p.label(24, GRID.y - 2, 'WORKSPACE', 'who imports which shared package');
  const packages = ['packages/contracts', 'packages/timeline', 'packages/plugin-api', 'packages/plugin-web'];
  packages.forEach((name, at) => p.text(24 + GRID.label + at * GRID.col + GRID.col / 2, GRID.y + 22, name, { size: 10, fill: c.fg2, mono: true, anchor: 'middle' }));
  [
    ['apps/server', [1, 1, 1, 0]],
    ['apps/web', [1, 1, 0, 1]],
    ['plugins/riffet/*', [1, 0, 1, 1]],
    ['apps/mobile', ['fixtures', 0, 0, 0]],
  ].forEach(([name, uses], row) => {
    const y = GRID.y + 44 + row * 24;
    p.path(`M24 ${y - 15}L${24 + GRID.label + 4 * GRID.col} ${y - 15}`, c.hair);
    p.text(24, y, name, { size: 10.5, weight: 500, mono: true });
    uses.forEach((use, at) => {
      const x = 24 + GRID.label + at * GRID.col + GRID.col / 2;
      if (use === 1) p.add(`<circle cx="${x}" cy="${y - 3.5}" r="3.5" fill="${c.ink}"/>`);
      else if (use) p.text(x, y, use, { size: 10, fill: c.fg2, anchor: 'middle', mono: true });
    });
  });
  const NOTES = 24 + GRID.label + 4 * GRID.col + 36;
  ['apps/server and apps/web do not import each other.', 'apps/mobile :contracts: hand-written Kotlin DTOs,', 'checked against fixtures from packages/contracts.', 'apps/macos links apps/mobile :client as RiffetKit.', 'Plugins reach the server through packages/plugin-api.']
    .forEach((line, at) => p.text(NOTES, GRID.y + 22 + at * 16, line, { size: 10.5, fill: c.fg3 }));
  return p.svg(W, H, 'Riffet layering');
}

const FIGURES = { system, 'session-core': dataPath, 'agent-integration': agentIntegration, 'access-clients': accessClients, extension, layers, runtime };
mkdirSync(out, { recursive: true });
const preview = process.argv.includes('--preview') ? resolve(process.argv[process.argv.indexOf('--preview') + 1] ?? '.') : undefined;
if (preview) mkdirSync(preview, { recursive: true });
for (const [name, draw] of Object.entries(FIGURES)) {
  for (const mode of Object.keys(PALETTES)) {
    const file = join(out, `${name}-${mode}.svg`);
    writeFileSync(file, draw(mode));
    if (preview) writeFileSync(join(preview, `${name}-${mode}.html`), `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:${PALETTES[mode].page}}img{display:block}</style><img src="${relative(preview, file)}">`);
  }
}
console.log(`wrote ${Object.keys(FIGURES).length * 2} figures to ${relative(root, out)}`);
