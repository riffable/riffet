#!/usr/bin/env node
// Every plugin extension point and static declaration has a public reference implementation
// (docs/PLUGINS.md「参考实现」). Checks that table against the source: each key of `Contributions`
// (packages/plugin-api/src/index.ts) and `PluginDeclarations` (packages/contracts/src/plugins.ts), and each
// value of `COMMAND_MENUS`, has a row; a row names directories that exist and use what the row says, or says
// why there is none yet ("暂无（…）"). Run by `pnpm check:plugins`.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = path => readFileSync(join(root, path), 'utf8');

/** Top-level member names of `export interface <name> { … }` in [source]. */
function members(source, name) {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`interface ${name} not found`);
  const names = [];
  let depth = 0;
  for (const line of source.slice(source.indexOf('{', start)).split('\n')) {
    if (depth === 1) {
      const member = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\??\s*[:(]/.exec(line);
      if (member) names.push(member[1]);
    }
    for (const char of line) { if (char === '{') depth += 1; else if (char === '}') depth -= 1; }
    if (depth <= 0) break;
  }
  return names;
}

const contracts = read('packages/contracts/src/plugins.ts');
const menus = [...(/COMMAND_MENUS = \[([^\]]*)\]/.exec(contracts)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(match => match[1]);
const required = new Set([
  ...members(read('packages/plugin-api/src/index.ts'), 'Contributions').filter(name => name !== 'dispose'),
  ...members(contracts, 'PluginDeclarations'),
  ...menus.map(menu => `commands.menus: ${menu}`),
]);

const guide = read('docs/PLUGINS.md');
const lines = guide.slice(guide.indexOf('### 参考实现')).split('\n');
const end = lines.findIndex((line, index) => index > 0 && /^#/.test(line));
const rows = (end < 0 ? lines : lines.slice(0, end)).filter(line => line.startsWith('| `'));
const problems = [];
if (!rows.length) problems.push('docs/PLUGINS.md has no「参考实现」table');

const files = directory => {
  const out = [];
  const walk = path => {
    for (const entry of readdirSync(path)) {
      if (['node_modules', 'dist', 'vendor', 'assets'].includes(entry)) continue;
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(?:ts|tsx|mjs|js|json)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
    }
  };
  walk(join(root, directory));
  return out;
};
const uses = (texts, key) => texts.some(text => new RegExp(`(?:^|[^\\w.])["']?${key}["']?\\s*\\??\\s*:`, 'm').test(text));

const covered = new Set();
for (const row of rows) {
  const [names, references] = row.split('|').slice(1, 3).map(cell => cell.trim());
  const keys = [...names.matchAll(/`([^`]+)`/g)].map(match => match[1]);
  for (const key of keys) covered.add(key);
  if (references.startsWith('暂无')) {
    if (!/^暂无（.+）$/.test(references)) problems.push(`${keys.join(', ')}: say why there is no reference, as 暂无（…）`);
    continue;
  }
  const directories = [...references.matchAll(/`([^`]+)`/g)].map(match => match[1]);
  if (!directories.length) { problems.push(`${keys.join(', ')}: names no reference directory`); continue; }
  const texts = [];
  for (const directory of directories) {
    if (!/^(?:plugins\/riffet|official|examples\/plugins)\/[^/]+$/.test(directory)) problems.push(`${directory}: a reference lives in plugins/riffet/, official/ or examples/plugins/`);
    else if (!existsSync(join(root, directory))) problems.push(`${directory}: does not exist`);
    else texts.push(...files(directory).map(file => readFileSync(file, 'utf8')));
  }
  for (const key of keys) {
    const menu = /^commands\.menus: (.+)$/.exec(key);
    const ok = menu ? uses(texts, 'menus') && texts.some(text => text.includes(`'${menu[1]}'`) || text.includes(`"${menu[1]}"`)) : uses(texts, key);
    if (!ok) problems.push(`${key}: none of ${directories.join(', ')} uses it`);
  }
}
for (const key of required) if (!covered.has(key)) problems.push(`${key}: no row in docs/PLUGINS.md「参考实现」`);
for (const key of covered) if (!required.has(key)) problems.push(`${key}: not an extension point or static declaration any more`);

if (problems.length) {
  console.error(`plugin references: ${problems.length} problem(s)\n${problems.map(line => `  ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`plugin references: every extension point has a reference (${required.size} keys, ${relative(root, join(root, 'docs/PLUGINS.md'))}).`);
