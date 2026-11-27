#!/usr/bin/env node
// Design rules that can be read off the source text (docs/design/macos-native.md 3, docs/THEMES.md 2.2):
//
//   loops       a looping animation (Swift repeatForever / repeatCount = .infinity / TimelineView(.animation),
//               Compose infinite transitions, CSS `infinite`, Tailwind animate-spin / animate-pulse /
//               animate-[… infinite]) says why with `motion-loop: <reason>` at the end of the statement's
//               first line or at most two lines above it (CSS: also just above the rule's selector);
//               loops are only for in-progress / loading indicators and the ambient brand mark.
//   repaint     Web keyframes do not animate `background-position`, and no looping `animate-*` sits on an
//               element inside an <svg>: both repaint the page every frame (docs/guide/web-performance.md §2.12).
//   web         no `text-[Npx]`, `rounded-[Npx]`, `z-[N]` or `-[#hex]` in apps/web/src tsx; use the tokens.
//   ratchets    per file, these counts may not grow past scripts/design-rules-baseline.json (a file new
//               to it starts at 0); the values come from docs/design/system/foundations.md:
//                 padding   Mac and iPhone `.padding(N)` / `.padding(.edge, N)` — use `Space.*` (Mac) / `RiffetMetrics`
//                 radius    Mac and iPhone `cornerRadius: N` / `cornerRadius = N` — use `Radius.*` / `style.radii` / `RiffetMetrics`
//                 fontSize  Mac `S(N)`, `.riffet(size: N)`, `style.font(N)` and Mac/iPhone `.system(size: N)` — use the
//                           style's text sizes (`style.text`) / `riffetFont(_:)`
//   shadow      Mac and iPhone drop shadows come from the elevation tiers: SwiftUI `.elevation(_:)`, AppKit layers
//               `Elevation.apply(to:dark:)` (Theme/AnchoredPopup.swift); the iPhone's from `RiffetMetrics`. Only the
//               theme layer and files that draw content (a theme preview, an exported image) write their own.
//   animation   Mac SwiftUI animations use `Motion.*` (Theme/Controls.swift), not a numeric curve.
//
// A deliberate exception carries `design-rules: allow <reason>` on the line or the line above.
//
//   node scripts/check-design-rules.mjs            exit 1 and list violations
//   node scripts/check-design-rules.mjs --update   lower the baselines (they never raise an entry)
//   node scripts/check-design-rules.mjs --update --add <path>   also record <path> at its current counts
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

// --- compositor-only loops (Web) -------------------------------------------------------------------
// A loop that animates `background-position`, or a transform on an element inside an <svg>, is
// repainted on the main thread every frame (docs/guide/web-performance.md §2.12); move a child or
// the <svg> itself by transform instead.

const REPAINTED = 'repainted every frame; animate transform or opacity on an element of its own (web-performance.md §2.12)';
const braces = (line) => (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
for (const file of walk(join(root, 'apps/web/src'), ['.css'])) {
  const lines = read(file);
  let depth = 0; // > 0 inside an @keyframes block
  lines.forEach((line, index) => {
    const inside = depth > 0 || /@keyframes\b/.test(line);
    depth = inside ? Math.max(0, depth + braces(line)) : 0;
    if (inside && /\bbackground-position\b/.test(line) && !allowed(lines, index)) problems.push(`${rel(file)}:${index + 1}: keyframes animate background-position — ${REPAINTED}`);
  });
}
const SVG_CHILD_LOOP = /<(?:g|path|circle|rect|line|polyline|polygon|ellipse|use)\b[^>]*\banimate-(?:spin|pulse|\[)/;
for (const file of walk(join(root, 'apps/web/src'), ['.tsx'])) {
  const lines = read(file);
  lines.forEach((line, index) => {
    if (SVG_CHILD_LOOP.test(line) && !allowed(lines, index)) problems.push(`${rel(file)}:${index + 1}: looping animation on an element inside an <svg> — ${REPAINTED}`);
  });
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

// --- Mac and iPhone ratchets, shadows and animation tiers ------------------------------------------

const macRoot = join(root, 'apps/macos/Riffet');
const iosRoot = join(root, 'apps/mobile/iosApp/Riffet');
const number = String.raw`(\d+(?:\.\d+)?)`;
const ANIMATION = /\.(easeOut|easeIn|easeInOut|linear|snappy|smooth|spring|bouncy|interactiveSpring|interpolatingSpring|timingCurve)\([^)]*\d/;
const RATCHETS = {
  padding: {
    patterns: [new RegExp(String.raw`\.padding\(\s*(?:\.[a-zA-Z]+\s*,\s*|\[[^\]]*\]\s*,\s*)?${number}\s*\)`, 'g')],
    min: 1,
    hint: 'numeric paddings — use Space.xxs … Space.xxl (Mac Theme/Controls.swift) or RiffetMetrics (iPhone)',
  },
  radius: {
    patterns: [new RegExp(String.raw`cornerRadius\s*[:=]\s*${number}\b`, 'g')],
    min: 0,
    hint: 'numeric corner radii — use Radius.* / style.radii (Mac) or RiffetMetrics (iPhone)',
  },
  fontSize: {
    patterns: [new RegExp(String.raw`\bS\(\s*${number}\s*\)`, 'g'), new RegExp(String.raw`\.riffet\(size:\s*${number}`, 'g'), new RegExp(String.raw`\bstyle\.font\(\s*${number}`, 'g'), new RegExp(String.raw`\.system\(size:\s*${number}`, 'g')],
    min: 0,
    hint: 'numeric text or icon sizes — use the style\'s text sizes (style.text) on the Mac, riffetFont(_:) on the iPhone',
  },
};
const SWIFTUI_SHADOW = /\.shadow\(\s*color:/;
const LAYER_SHADOW = /\bshadow(?:Radius|Opacity)\s*=\s*\d/;
// The elevation layer itself, and files whose shadows belong to what they draw rather than to the chrome.
const shadowAllow = [
  'apps/macos/Riffet/Theme/',
  'apps/macos/Riffet/Features/Settings/ThemeCanvasView.swift',
  'apps/macos/Riffet/Features/Share/ShareCard.swift',
  'apps/mobile/iosApp/Riffet/Design/RiffetDesign.swift',
];
const GENERATED = /\.generated\.swift$|\/InterfaceStyles\.swift$/;
const counts = Object.fromEntries(Object.keys(RATCHETS).map((kind) => [kind, {}]));
for (const file of [...walk(macRoot, ['.swift']), ...walk(iosRoot, ['.swift'])]) {
  const path = rel(file);
  if (GENERATED.test(path)) continue;
  const mac = path.startsWith('apps/macos/');
  const lines = read(file);
  let animations = 0;
  const animationHits = [];
  lines.forEach((line, index) => {
    if (allowed(lines, index)) return;
    for (const [kind, { patterns, min }] of Object.entries(RATCHETS)) {
      for (const pattern of patterns) {
        for (const match of line.matchAll(pattern)) if (Number(match[1]) > min) counts[kind][path] = (counts[kind][path] ?? 0) + 1;
      }
    }
    if (!shadowAllow.some((prefix) => path.startsWith(prefix)) && (SWIFTUI_SHADOW.test(line) || LAYER_SHADOW.test(line))) {
      problems.push(`${path}:${index + 1}: hand-written shadow — use .elevation(_:) / Elevation.apply(to:dark:) (Mac) or RiffetMetrics' floating shadow (iPhone)`);
    }
    if (mac && path !== 'apps/macos/Riffet/Theme/Controls.swift' && ANIMATION.test(line) && !loopMarked(lines, index, false)) {
      animations += 1;
      animationHits.push(index + 1);
    }
  });
  if (animations > (animationAllow[path] ?? 0)) {
    problems.push(...animationHits.map((at) => `${path}:${at}: numeric animation — use Motion.fast / Motion.standard / Motion.expressive (Theme/Controls.swift)`));
  }
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
if (update) {
  const next = {};
  for (const kind of Object.keys(RATCHETS)) {
    const recorded = baseline[kind] ?? {};
    const kept = {};
    for (const [path, count] of Object.entries(counts[kind])) {
      if (path in recorded) kept[path] = Math.min(recorded[path], count);
      else if (added.has(path)) kept[path] = count;
    }
    next[kind] = Object.fromEntries(Object.entries(kept).sort(([a], [b]) => a.localeCompare(b)));
  }
  for (const path of added) if (!Object.values(counts).some((byPath) => path in byPath)) console.warn(`design rules: --add ${path}: no numeric values there, nothing recorded`);
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`design rules: baselines written (${Object.entries(next).map(([kind, byPath]) => `${kind} ${Object.keys(byPath).length}`).join(', ')} files)`);
} else {
  let lowered = 0;
  for (const [kind, { hint }] of Object.entries(RATCHETS)) {
    const recorded = baseline[kind] ?? {};
    for (const [path, count] of Object.entries(counts[kind])) {
      const limit = recorded[path] ?? 0;
      if (count > limit) problems.push(`${path}: ${count} ${hint}; baseline ${limit}${path in recorded ? '' : ' — a file new to the baseline starts at 0 (record a deliberate one with --update --add <path>)'}`);
    }
    lowered += Object.entries(recorded).filter(([path, limit]) => (counts[kind][path] ?? 0) < limit).length;
  }
  if (lowered && !problems.length) console.log(`design rules: ${lowered} baseline entr${lowered === 1 ? 'y is' : 'ies are'} now higher than needed; run with --update to lock it in`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error('\ndesign rules: a deliberate exception carries `design-rules: allow <reason>` on the line.');
  process.exit(1);
}
console.log('design rules: ok');
