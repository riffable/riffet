#!/usr/bin/env node
// Accessibility rules that can be read off the source text of apps/web/src tsx
// (docs/design/system/foundations.md 10.1). Parsed with the TypeScript compiler API.
//
//   icon-button   a <button> / <Button> whose only children are icon components has no `aria-label`,
//                 `aria-labelledby` or `title` (a `Tip` does not name it). Skipped: `asChild`, `aria-hidden`, spread props.
//   img-alt       an <img> without `alt` (alt="" is fine for decoration). Skipped: spread props.
//   tabindex      a positive `tabIndex`.
//
// Per file and rule, counts may not grow past scripts/a11y-baseline.json (a file new to it starts at 0).
// A deliberate exception carries `design-rules: allow <reason>` on the opening tag's line or the line above.
//
//   node scripts/check-a11y.mjs            exit 1 and list violations
//   node scripts/check-a11y.mjs --update   lower the baseline (it never raises an entry)
//   node scripts/check-a11y.mjs --update --add <path>   also record <path> at its current counts
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baselinePath = join(root, 'scripts/a11y-baseline.json');
const update = process.argv.includes('--update');
const added = new Set(process.argv.flatMap((arg, at, all) => (arg === '--add' && all[at + 1] ? [all[at + 1]] : [])));
if (added.size && !update) {
  console.error('a11y: --add only works with --update');
  process.exit(2);
}

const HINTS = {
  'icon-button': 'icon-only button without a name — add aria-label (and wrap in Tip)',
  'img-alt': '<img> without alt — describe it, or alt="" when decorative',
  tabindex: 'positive tabIndex — use 0 or -1 so the tab order follows the layout',
};
const NAME_PROPS = ['aria-label', 'aria-labelledby', 'title'];

function* walk(directory) {
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) yield path;
  }
}

const rel = (file) => relative(root, file).split('\\').join('/');
const attrName = (attribute) => attribute.name.getText();

/** Findings as [rule, 1-based line] for one source file. */
export function scan(text, fileName = 'x.tsx') {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split('\n');
  const found = [];
  const report = (rule, node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if (lines[line].includes('design-rules: allow') || (lines[line - 1] ?? '').includes('design-rules: allow')) return;
    found.push([rule, line + 1]);
  };
  const isIcon = (child) => {
    const tag = ts.isJsxSelfClosingElement(child) ? child.tagName.getText() : ts.isJsxElement(child) ? child.openingElement.tagName.getText() : '';
    return /^Icon[A-Z]/.test(tag);
  };
  const visit = (node) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
    if (opening) {
      const tag = opening.tagName.getText();
      const attributes = opening.attributes.properties;
      const names = new Set();
      let spread = false;
      for (const attribute of attributes) {
        if (ts.isJsxSpreadAttribute(attribute)) spread = true;
        else names.add(attrName(attribute));
      }
      if (names.has('tabIndex')) {
        const attribute = attributes.find((a) => ts.isJsxAttribute(a) && attrName(a) === 'tabIndex');
        const initializer = attribute.initializer;
        const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : initializer;
        const value = expression ? Number(expression.getText().replace(/^["']|["']$/g, '')) : NaN;
        if (value > 0) report('tabindex', opening);
      }
      if (tag === 'img' && !spread && !names.has('alt')) report('img-alt', opening);
      if ((tag === 'button' || tag === 'Button') && ts.isJsxElement(node) && !spread && !names.has('asChild') && !names.has('aria-hidden') && !NAME_PROPS.some((n) => names.has(n))) {
        const children = node.children.filter((child) => !(ts.isJsxText(child) && !child.text.trim()));
        if (children.length > 0 && children.every(isIcon)) report('icon-button', opening);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const counts = {};
  const where = {};
  for (const file of walk(join(root, 'apps/web/src'))) {
    const path = rel(file);
    for (const [rule, line] of scan(readFileSync(file, 'utf8'), file)) {
      counts[path] ??= {};
      counts[path][rule] = (counts[path][rule] ?? 0) + 1;
      (where[`${path}|${rule}`] ??= []).push(line);
    }
  }
  if (process.argv.includes('--list')) {
    for (const [key, at] of Object.entries(where)) { const [path, rule] = key.split('|'); for (const line of at) console.log(`${rule}\t${path}:${line}`); }
    process.exit(0);
  }
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  if (update) {
    const next = {};
    for (const [path, byRule] of Object.entries(counts)) {
      for (const [rule, count] of Object.entries(byRule)) {
        const recorded = baseline[path]?.[rule];
        const keep = recorded !== undefined ? Math.min(recorded, count) : added.has(path) ? count : undefined;
        if (keep) (next[path] ??= {})[rule] = keep;
      }
    }
    const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`a11y: baseline written (${Object.keys(sorted).length} files)`);
    process.exit(0);
  }
  const problems = [];
  let lowered = 0;
  for (const [path, byRule] of Object.entries(counts)) {
    for (const [rule, count] of Object.entries(byRule)) {
      const limit = baseline[path]?.[rule] ?? 0;
      if (count > limit) {
        problems.push(`${path}: ${count} ${HINTS[rule]} [${rule}] (lines ${where[`${path}|${rule}`].join(', ')}); baseline ${limit}${limit || baseline[path]?.[rule] !== undefined ? '' : ' — a file new to the baseline starts at 0 (record a deliberate one with --update --add <path>)'}`);
      }
    }
  }
  for (const [path, byRule] of Object.entries(baseline)) {
    for (const [rule, limit] of Object.entries(byRule)) if ((counts[path]?.[rule] ?? 0) < limit) lowered += 1;
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error('\na11y: a deliberate exception carries `design-rules: allow <reason>` on the opening tag\'s line or the line above.');
    process.exit(1);
  }
  if (lowered) console.log(`a11y: ${lowered} baseline entr${lowered === 1 ? 'y is' : 'ies are'} now higher than needed; run with --update to lock it in`);
  console.log('a11y: ok');
}
