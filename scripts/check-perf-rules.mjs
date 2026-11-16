#!/usr/bin/env node
// Resource rules that can be read off the source text (docs/guide/performance.md §3):
//
//   nscacheLimit       a Swift file that creates an NSCache sets countLimit or totalCostLimit (§3.1). Hard rule.
//   ratchets           per file, these counts may not grow past scripts/perf-rules-baseline.json (a file new to it
//                      starts at 0):
//     unboundedChannel   Kotlin Channel.UNLIMITED: queue at most STREAM_QUEUE_FRAMES and resync on overflow (§3.2)
//     byteLiteral        a hand-written megabyte size (`N * 1024 * 1024`, `N * MIB`, `N << 20`): take it from
//                        packages/contracts/src/budgets.ts (§2)
//     moduleCollection   Web/server module-level `new Map()` / `new Set()` that grows at runtime: bound it or clear it
//                        when its owner goes (§3.1)
//     staticDictionary   Swift `static var x = [:]`: the same, for Mac and iPhone
//
// A deliberate exception carries `perf-rules: allow <reason>` on the line or the line above.
//
//   node scripts/check-perf-rules.mjs            exit 1 and list violations
//   node scripts/check-perf-rules.mjs --update   lower the baselines (they never raise an entry)
//   node scripts/check-perf-rules.mjs --update --add <path>   also record <path> at its current counts
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baselinePath = join(root, 'scripts/perf-rules-baseline.json');
const update = process.argv.includes('--update');
const added = new Set(process.argv.flatMap((arg, at, all) => (arg === '--add' && all[at + 1] ? [all[at + 1]] : [])));
if (added.size && !update) {
  console.error('perf rules: --add only works with --update');
  process.exit(2);
}

const SOURCES = [
  'apps/server/src', 'apps/web/src', 'apps/macos/Riffet', 'apps/mobile/iosApp/Riffet',
  'apps/mobile/client/src', 'apps/mobile/shared/src', 'apps/mobile/androidApp/src', 'apps/mobile/terminal/src',
  'packages/contracts/src', 'packages/timeline/src', 'packages/plugin-api/src', 'plugins',
];
const SKIP_DIR = /(^|\/)(node_modules|build|dist|\.gradle|generated|test|commonTest|androidTest|jvmTest|iosTest|macosTest|RiffetTests)(\/|$)/;
const SKIP_FILE = /(\.test\.tsx?|\.spec\.tsx?|Test\.kt|Tests\.swift|\.generated\.ts)$/;
const EXEMPT = new Set(['packages/contracts/src/budgets.ts']);

const RATCHETS = {
  unboundedChannel: {
    lang: /\.kt$/,
    test: (line) => /Channel\.UNLIMITED|\(\s*UNLIMITED\s*\)/.test(line),
    hint: 'Channel.UNLIMITED — queue at most STREAM_QUEUE_FRAMES and resync on overflow (performance.md §3.2)',
  },
  byteLiteral: {
    lang: /\.(tsx?|mjs|swift|kt)$/,
    test: (line) => /\b\d+(\.\d+)?\s*\*\s*1024\s*\*\s*1024\b|\b[\d_]+L?\s*\*\s*MIB\b|\b\d+\s*<<\s*20\b/.test(line),
    hint: 'hand-written megabyte size — take it from packages/contracts/src/budgets.ts (performance.md §2)',
  },
  moduleCollection: {
    lang: /\.tsx?$/,
    test: (line) => /^(export\s+)?(const|let)\s+\w+(\s*:\s*[^=]+)?\s*=\s*new\s+(Map|Set)\s*(<[^(]*>)?\(\s*\)/.test(line),
    hint: 'module-level Map/Set that grows at runtime — bound it or clear it with its owner (performance.md §3.1)',
  },
  staticDictionary: {
    lang: /\.swift$/,
    test: (line) => /\bstatic\s+(private\s+)?var\s+\w+\s*(:\s*\[[^\]]+:[^\]]+\])?\s*=\s*\[:\]/.test(line),
    hint: 'static mutable dictionary — bound it or clear it with its owner (performance.md §3.1)',
  },
};

const allowed = (lines, index) => [lines[index], lines[index - 1] ?? ''].some((line) => line.includes('perf-rules: allow'));

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(root, path);
    if (SKIP_DIR.test(rel)) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (/\.(tsx?|mjs|swift|kt)$/.test(name) && !SKIP_FILE.test(name) && !EXEMPT.has(rel)) yield rel;
  }
}

const counts = Object.fromEntries(Object.keys(RATCHETS).map((kind) => [kind, {}]));
const hits = Object.fromEntries(Object.keys(RATCHETS).map((kind) => [kind, {}]));
const problems = [];

for (const path of [...new Set(SOURCES.flatMap((dir) => [...walk(join(root, dir))]))].sort()) {
  const text = readFileSync(join(root, path), 'utf8');
  const lines = text.split('\n');
  if (path.endsWith('.swift') && /\bNSCache\s*</.test(text) && !/\b(countLimit|totalCostLimit)\b/.test(text)) {
    const at = lines.findIndex((line) => /\bNSCache\s*</.test(line));
    if (!allowed(lines, at)) problems.push(`${path}:${at + 1}: NSCache without countLimit or totalCostLimit (performance.md §3.1)`);
  }
  for (const [kind, rule] of Object.entries(RATCHETS)) {
    if (!rule.lang.test(path)) continue;
    lines.forEach((line, index) => {
      if (!rule.test(line) || allowed(lines, index)) return;
      counts[kind][path] = (counts[kind][path] ?? 0) + 1;
      (hits[kind][path] ??= []).push(index + 1);
    });
  }
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
if (update) {
  const first = !existsSync(baselinePath);
  const next = {};
  for (const kind of Object.keys(RATCHETS)) {
    const recorded = baseline[kind] ?? {};
    const kept = {};
    for (const [path, count] of Object.entries(counts[kind])) {
      if (path in recorded) kept[path] = Math.min(recorded[path], count);
      else if (first || added.has(path)) kept[path] = count;
    }
    next[kind] = Object.fromEntries(Object.entries(kept).sort(([a], [b]) => a.localeCompare(b)));
  }
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`perf rules: baselines written (${Object.entries(next).map(([kind, byPath]) => `${kind} ${Object.keys(byPath).length}`).join(', ')} files)`);
} else {
  let lowered = 0;
  for (const [kind, { hint }] of Object.entries(RATCHETS)) {
    const recorded = baseline[kind] ?? {};
    for (const [path, count] of Object.entries(counts[kind])) {
      const limit = recorded[path] ?? 0;
      if (count > limit) problems.push(`${path}:${hits[kind][path].join(',')}: ${hint}; ${count} here, baseline ${limit}${path in recorded ? '' : ' (a file new to the baseline starts at 0)'}`);
    }
    lowered += Object.entries(recorded).filter(([path, limit]) => (counts[kind][path] ?? 0) < limit).length;
  }
  if (lowered && !problems.length) console.log(`perf rules: ${lowered} baseline entr${lowered === 1 ? 'y is' : 'ies are'} now higher than needed; run with --update to lock it in`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error('\nperf rules: a deliberate exception carries `perf-rules: allow <reason>` on the line or the line above.');
  process.exit(1);
}
console.log('perf rules: ok');
