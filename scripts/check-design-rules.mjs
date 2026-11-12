#!/usr/bin/env node
// Design rules that can be read off the source text (docs/design/macos-native.md 3, docs/THEMES.md 2.2):
//
//   loops       a looping animation (Swift repeatForever / repeatCount = .infinity / TimelineView(.animation),
//               Compose infinite transitions, CSS `infinite`, Tailwind animate-spin / animate-pulse /
//               animate-[… infinite]) says why with `motion-loop: <reason>` at the end of the statement's
//               first line or at most two lines above it (CSS: also just above the rule's selector);
//               loops are only for in-progress / loading indicators and the ambient brand mark.
//   web         no `text-[Npx]`, `rounded-[Npx]`, `z-[N]` or `-[#hex]` in apps/web/src tsx; use the tokens.
//   padding     Mac `.padding(N)` / `.padding(.edge, N)` per file may not grow past
//               scripts/design-rules-baseline.json; use `Space.*` (Theme/Controls.swift).
//   animation   Mac SwiftUI animations use `Motion.*` (Theme/Controls.swift), not a numeric curve.
//
// A deliberate exception carries `design-rules: allow <reason>` on the line or the line above.
//
//   node scripts/check-design-rules.mjs            exit 1 and list violations
//   node scripts/check-design-rules.mjs --update   lower the padding baseline (it never raises an entry)
//   node scripts/check-design-rules.mjs --update --add <path>   also record <path> at its current count
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baselinePath = join(root, 'scripts/design-rules-baseline.json');
const update = process.argv.includes('--update');
// Files to record at their current padding count; anything else not in the baseline must have none.
const added = new Set(process.argv.flatMap((arg, at, all) => (arg === '--add' && all[at + 1] ? [all[at + 1]] : [])));
if (added.size && !update) {
  console.error('design rules: --add only works with --update');
  process.exit(2);
}

// Files other work owns right now. Each entry is a debt, not a precedent.
// TODO: add `motion-loop:` markers (and a Reduce Motion stop) to these loops, then drop the entries.
const loopAllow = [
  'apps/macos/Riffet/Features/Canvas/',
  'apps/web/src/app/session/ComposerDock.tsx',
];
// TODO: migrate these to `Motion.*`, then drop the entries. The number is the most literals the file may keep.
const animationAllow = {
  'apps/macos/Riffet/Features/Canvas/Page/CanvasPage.swift': 3,
  'apps/macos/Riffet/Features/Conversation/ConversationView.swift': 4,
  'apps/macos/Riffet/Features/Workbench/WorkbenchView.swift': 5,
};

function* walk(directory, extensions) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (name === 'build' || name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* walk(path, extensions);
    else if (extensions.some((extension) => name.endsWith(extension))) yield path;
  }
}

const read = (file) => readFileSync(file, 'utf8').split('\n');
const rel = (file) => relative(root, file).split('\\').join('/');
const allowed = (lines, index) => lines[index].includes('design-rules: allow') || (lines[index - 1] ?? '').includes('design-rules: allow');
const problems = [];

// --- loops ---------------------------------------------------------------------------------------

const MARKER = 'motion-loop:';
const loopSources = [
  { dirs: ['apps/macos/Riffet', 'apps/mobile/iosApp'], extensions: ['.swift'], test: /\brepeatForever\(|repeatCount\s*=\s*\.infinity|TimelineView\(\s*\.animation/ },
  { dirs: ['apps/mobile/shared/src', 'apps/mobile/client/src', 'apps/mobile/terminal/src'], extensions: ['.kt'], test: /\binfiniteRepeatable\(|\brememberInfiniteTransition\(/ },
  { dirs: ['apps/web/src'], extensions: ['.tsx', '.ts'], test: /\banimate-(spin|pulse)|animate-\[[^\]]*infinite|animation[^;'"]*\binfinite\b/ },
  { dirs: ['apps/web/src'], extensions: ['.css'], test: /(?:^|[\s{;])animation(?:-iteration-count)?\s*:[^;}]*\binfinite\b/, css: true },
];

/** Lines inside `motion-loop-begin` … `motion-loop-end`, for stylesheets with many keyframed parts. */
function blockMarked(lines) {
  const marked = new Set();
  let open = false;
  lines.forEach((line, index) => {
    if (line.includes('motion-loop-begin')) open = true;
    if (open) marked.add(index);
    if (line.includes('motion-loop-end')) open = false;
  });
  return marked;
}

// One marker covers the one statement it annotates: the line it ends, or the statement starting at most
// two lines below a comment-only marker. The statement runs on over its more deeply indented
// continuation lines and their closing bracket, up to LOOP_SPAN lines, so a marker above a function
// body does not cover every loop in it.
const LOOP_LEAD = 2;
const LOOP_SPAN = 8;
const indent = (line) => /^\s*/.exec(line)[0].length;
const commentOnly = (line) => /^\s*(?:\/\/|\/\*|\*|\{\s*\/\*|<!--|#)/.test(line);
function statementMarked(lines, index) {
  for (let marker = index; marker >= Math.max(0, index - LOOP_LEAD - LOOP_SPAN); marker -= 1) {
    if (!lines[marker].includes(MARKER)) continue;
    let start = marker;
    if (commentOnly(lines[marker])) {
      start = -1;
      for (let at = marker + 1; at <= Math.min(lines.length - 1, marker + LOOP_LEAD); at += 1) {
        if (lines[at].trim() && !commentOnly(lines[at])) { start = at; break; }
      }
      if (start < 0 || start > index) continue;
    }
    let end = start;
    while (end + 1 < lines.length && end + 1 - start < LOOP_SPAN && lines[end + 1].trim() && indent(lines[end + 1]) > indent(lines[start])) end += 1;
    if (end + 1 < lines.length && end + 1 - start < LOOP_SPAN && indent(lines[end + 1]) === indent(lines[start]) && /^\s*[)\]}]/.test(lines[end + 1])) end += 1;
    if (index <= end) return true;
  }
  return false;
}
function loopMarked(lines, index, css) {
  if (statementMarked(lines, index)) return true;
  if (!css) return false;
  // A comment just above the rule's selector covers the declarations of that rule only.
  for (let at = index; at >= Math.max(0, index - 40); at -= 1) {
    if (at < index && lines[at].includes('}')) return false;
    if (!lines[at].includes('{')) continue;
    for (let up = at - 1; up >= Math.max(0, at - LOOP_LEAD) && commentOnly(lines[up]); up -= 1) if (lines[up].includes(MARKER)) return true;
    return false;
  }
  return false;
}

for (const source of loopSources) {
  for (const dir of source.dirs) {
    for (const file of walk(join(root, dir), source.extensions)) {
      const path = rel(file);
      if (loopAllow.some((prefix) => path.startsWith(prefix))) continue;
      const lines = read(file);
      const block = blockMarked(lines);
      lines.forEach((line, index) => {
        if (!source.test.test(line) || block.has(index) || allowed(lines, index)) return;
        if (!loopMarked(lines, index, source.css)) {
          problems.push(`${path}:${index + 1}: unmarked loop — loops are only for in-progress/loading indicators and the brand mark; say which with \`${MARKER} <reason>\` and stop it under reduced motion`);
        }
      });
    }
  }
}

// --- web literals ----------------------------------------------------------------------------------

const webLiterals = [
  [/\btext-\[\d+(\.\d+)?px\]/, 'font size literal — use text-2xs … text-2xl'],
  [/\brounded(-[a-z]{1,2})?-\[\d+(\.\d+)?px\]/, 'radius literal — use rounded-xs … rounded-3xl'],
  [/\bz-\[\d+\]/, 'z-index literal — use the --z-* layers'],
  [/-\[#[0-9a-fA-F]{3,8}\]/, 'raw colour — use a theme role, or a named variable for a fixed non-app palette'],
];
for (const file of walk(join(root, 'apps/web/src'), ['.tsx'])) {
  const lines = read(file);
  lines.forEach((line, index) => {
    if (allowed(lines, index)) return;
    for (const [pattern, hint] of webLiterals) {
      if (pattern.test(line)) problems.push(`${rel(file)}:${index + 1}: ${hint}`);
    }
  });
}

// --- Mac padding ratchet and animation tiers -------------------------------------------------------

const macRoot = join(root, 'apps/macos/Riffet');
const PADDING = /\.padding\(\s*(?:\.[a-zA-Z]+\s*,\s*|\[[^\]]*\]\s*,\s*)?(\d+(?:\.\d+)?)\s*\)/g;
const ANIMATION = /\.(easeOut|easeIn|easeInOut|linear|snappy|smooth|spring|bouncy|interactiveSpring|interpolatingSpring|timingCurve)\([^)]*\d/;
const counts = {};
for (const file of walk(macRoot, ['.swift'])) {
  const path = rel(file);
  const lines = read(file);
  let padding = 0;
  let animations = 0;
  const animationHits = [];
  lines.forEach((line, index) => {
    if (allowed(lines, index)) return;
    for (const match of line.matchAll(PADDING)) if (Number(match[1]) > 1) padding += 1;
    if (path !== 'apps/macos/Riffet/Theme/Controls.swift' && ANIMATION.test(line) && !loopMarked(lines, index, false)) {
      animations += 1;
      animationHits.push(index + 1);
    }
  });
  if (padding > 0) counts[path] = padding;
  if (animations > (animationAllow[path] ?? 0)) {
    problems.push(...animationHits.map((at) => `${path}:${at}: numeric animation — use Motion.fast / Motion.standard / Motion.expressive (Theme/Controls.swift)`));
  }
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
if (update) {
  const next = {};
  for (const [path, count] of Object.entries(counts)) {
    if (path in baseline) next[path] = Math.min(baseline[path], count);
    else if (added.has(path)) next[path] = count;
  }
  for (const path of added) if (!(path in counts)) console.warn(`design rules: --add ${path}: no numeric paddings there, nothing recorded`);
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`design rules: padding baseline written (${Object.keys(sorted).length} files)`);
} else {
  for (const [path, count] of Object.entries(counts)) {
    const limit = baseline[path] ?? 0;
    if (count > limit) problems.push(`${path}: ${count} numeric paddings, baseline ${limit} — use Space.xxs … Space.xxl (Theme/Controls.swift)${path in baseline ? '' : '; a file new to the baseline starts at 0 (record a deliberate one with --update --add <path>)'}`);
  }
  const lowered = Object.entries(baseline).filter(([path, limit]) => (counts[path] ?? 0) < limit);
  if (lowered.length && !problems.length) console.log(`design rules: ${lowered.length} file(s) now below the padding baseline; run with --update to lock it in`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error('\ndesign rules: a deliberate exception carries `design-rules: allow <reason>` on the line.');
  process.exit(1);
}
console.log('design rules: ok');
