#!/usr/bin/env node
// Requests to a server go through one request layer that picks the target server (docs/guide/multi-server.md §3.2):
// the entry server's API is `/api/<rest>`, a linked server's is `/api/servers/<serverId>/<rest>`. Business code in
// apps/web/src does not build `/api/...` paths or open sockets and streams itself. Per file, these counts may not
// grow past scripts/servers-baseline.json (a file new to it starts at 0):
//
//   apiPath   a quoted or template string starting with `/api/` (or `/api` before the closing quote or `${`), and any
//             use of the `API` constant from @contracts (`API.marks`, `${API.marks}/…`)
//   socket    `new WebSocket(` and `new EventSource(`
//
// The request layer (apps/web/src/lib/api.ts, apps/web/src/lib/server-routing.ts) and tests are not scanned.
// A deliberate exception carries `servers-rules: allow <reason>` on the line or the line above.
//
//   node scripts/check-servers.mjs            exit 1 and list violations
//   node scripts/check-servers.mjs --update   lower the baselines (they never raise an entry)
//   node scripts/check-servers.mjs --init     write the first baseline from the current counts (only if none exists)
//   node scripts/check-servers.mjs --list     print the current counts per rule and the top files
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baselinePath = join(root, 'scripts/servers-baseline.json');
const update = process.argv.includes('--update');
const init = process.argv.includes('--init');
const list = process.argv.includes('--list');
if (init && existsSync(baselinePath)) {
  console.error('servers rules: a baseline exists; use --update to lower it');
  process.exit(2);
}

const SOURCE = 'apps/web/src';
const SKIP_DIR = /(^|\/)(node_modules|build|dist|generated)(\/|$)/;
const SKIP_FILE = /(\.test\.tsx?|\.spec\.tsx?|\.generated\.ts)$/;
const EXEMPT = new Set(['apps/web/src/lib/api.ts', 'apps/web/src/lib/server-routing.ts']);

const RATCHETS = {
  apiPath: {
    // Strings only: a regex such as /^\/api\// has no quote before `/api`.
    test: (line) => /['"`]\/api(?:\/|['"`]|\$\{)|\bAPI\.\w+/.test(line),
    hint: 'hand-built /api path — route through the request layer in apps/web/src/lib/api.ts (multi-server.md §3.2)',
  },
  socket: {
    test: (line) => /\bnew\s+(WebSocket|EventSource)\s*\(/.test(line),
    hint: 'socket or stream opened outside the request layer — route through apps/web/src/lib/api.ts (multi-server.md §3.2)',
  },
};

const allowed = (lines, index) => [lines[index], lines[index - 1] ?? ''].some((line) => line.includes('servers-rules: allow'));

// Blank out comments, keeping line breaks and strings (a `//` inside a string or `://` in a URL is not a comment).
function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j += 1;
        else if (c !== '`' && text[j] === '\n') break;
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && n === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j += 1;
      out += text.slice(i, j).replace(/[^\n]/g, (ch, k) => (text.slice(i, j).includes('servers-rules: allow') ? ch : ' '));
      i = j;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const j = end < 0 ? text.length : end + 2;
      out += text.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(root, path);
    if (SKIP_DIR.test(rel)) continue;
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(name) && !SKIP_FILE.test(name) && !EXEMPT.has(rel)) yield rel;
  }
}

const counts = Object.fromEntries(Object.keys(RATCHETS).map((kind) => [kind, {}]));
const hits = Object.fromEntries(Object.keys(RATCHETS).map((kind) => [kind, {}]));

for (const path of [...walk(join(root, SOURCE))].sort()) {
  const raw = readFileSync(join(root, path), 'utf8');
  const original = raw.split('\n');
  const lines = stripComments(raw).split('\n');
  for (const [kind, rule] of Object.entries(RATCHETS)) {
    lines.forEach((line, index) => {
      if (!rule.test(line) || allowed(original, index)) return;
      counts[kind][path] = (counts[kind][path] ?? 0) + 1;
      (hits[kind][path] ??= []).push(index + 1);
    });
  }
}

if (list) {
  const totals = Object.entries(counts).map(([kind, byPath]) => `${kind} ${Object.values(byPath).reduce((a, b) => a + b, 0)}`);
  console.log(`servers rules: ${totals.join(', ')}`);
  const perFile = {};
  for (const byPath of Object.values(counts)) for (const [path, count] of Object.entries(byPath)) perFile[path] = (perFile[path] ?? 0) + count;
  for (const [path, count] of Object.entries(perFile).sort(([, a], [, b]) => b - a).slice(0, 10)) console.log(`${String(count).padStart(4)}  ${path}`);
  process.exit(0);
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
const sorted = (byPath) => Object.fromEntries(Object.entries(byPath).sort(([a], [b]) => a.localeCompare(b)));
if (update || init) {
  const next = {};
  for (const kind of Object.keys(RATCHETS)) {
    const recorded = baseline[kind] ?? {};
    const kept = {};
    for (const [path, count] of Object.entries(counts[kind])) {
      if (init) kept[path] = count;
      else if (path in recorded) kept[path] = Math.min(recorded[path], count);
    }
    next[kind] = sorted(kept);
  }
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`servers rules: baselines written (${Object.entries(next).map(([kind, byPath]) => `${kind} ${Object.keys(byPath).length}`).join(', ')} files)`);
} else {
  const problems = [];
  let lowered = 0;
  for (const [kind, { hint }] of Object.entries(RATCHETS)) {
    const recorded = baseline[kind] ?? {};
    for (const [path, count] of Object.entries(counts[kind])) {
      const limit = recorded[path] ?? 0;
      if (count > limit) problems.push(`${path}:${hits[kind][path].join(',')}: ${kind}: ${hint}; ${count} here, baseline ${limit}${path in recorded ? '' : ' (a file new to the baseline starts at 0)'}`);
    }
    lowered += Object.entries(recorded).filter(([path, limit]) => (counts[kind][path] ?? 0) < limit).length;
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error('\nservers rules: route the request through the request layer in apps/web/src/lib/api.ts (docs/guide/multi-server.md §3.2); a deliberate exception carries `servers-rules: allow <reason>` on the line or the line above.');
    process.exit(1);
  }
  if (lowered) console.log(`servers rules: ${lowered} baseline entr${lowered === 1 ? 'y is' : 'ies are'} now higher than needed; run with --update to lock it in`);
}
console.log('servers rules: ok');
