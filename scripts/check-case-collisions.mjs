#!/usr/bin/env node
/**
 * Fails when two tracked paths differ only by letter case. Such a pair checks out as one file on a
 * case-insensitive volume (the default on macOS), and an extension-less import between them then
 * resolves to whichever the resolver probes first.
 */
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
// Directories collide too, and so does a module whose extension-less specifier matches another's.
const paths = new Set();
for (const file of files) {
  const parts = file.split('/');
  for (let index = 1; index <= parts.length; index += 1) paths.add(parts.slice(0, index).join('/'));
  const stem = file.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  if (stem !== file) paths.add(`${stem}.<module>`);
}

const seen = new Map();
const collisions = new Map();
for (const path of paths) {
  const key = path.toLowerCase();
  const other = seen.get(key);
  if (other === undefined) { seen.set(key, path); continue; }
  if (other === path) continue;
  const group = collisions.get(key) ?? new Set([other]);
  group.add(path);
  collisions.set(key, group);
}

if (collisions.size) {
  console.error('Paths that differ only by case:');
  for (const group of collisions.values()) console.error(`  ${[...group].map((path) => path.replace(/\.<module>$/, '.{ts,tsx,js,…}')).join('  <->  ')}`);
  process.exit(1);
}
console.log(`No case collisions among ${files.length} tracked files.`);
