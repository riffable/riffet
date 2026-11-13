#!/usr/bin/env node
// Web animation state is read and awaited only through apps/web/src/lib/motion.ts; see "Web 动画约定"
// in AGENTS.md. A direct `getAnimations(` or an Animation's `.finished` in a call site once became a
// microtask loop that froze a tab. Text rules, so a deliberate exception carries a
// `web-motion: allow` comment on the line (with the reason next to it).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = join(root, 'apps/web/src');
// motion.ts is the one reader; view-transition.ts awaits a ViewTransition, which is not an Animation.
const exempt = new Set(['lib/motion.ts', 'lib/view-transition.ts'].map(path => join(source, path)));

const rules = [
  { name: 'getAnimations()', test: line => /\bgetAnimations\s*\(/.test(line), hint: 'use animationsOf / findAnimation / cancelAnimations from lib/motion' },
  { name: 'Animation .finished', test: line => /\.finished\b/.test(line), hint: 'use settled(...) or exit(...) from lib/motion' },
];

function* sourceFiles(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) yield path;
  }
}

const problems = [];
for (const file of sourceFiles(source)) {
  if (exempt.has(file)) continue;
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, '');
    if (line.includes('web-motion: allow') || code.trim().startsWith('*')) return;
    for (const rule of rules) {
      if (rule.test(code)) problems.push(`${relative(root, file)}:${index + 1}: ${rule.name} — ${rule.hint}`);
    }
  });
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('web motion: ok');
