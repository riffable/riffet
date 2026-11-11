#!/usr/bin/env node
// Keeps the Compose Multiplatform and Android string catalogs in step: every key exists in the
// source locale (values/) and English (values-en/), with the same positional placeholders, and no
// English value is still Chinese. Run in CI.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const locales = ['values', 'values-en'];
// Each pair is checked independently: the shared Compose catalog, the Android host resources in
// `shared`, and the app module's own resources (when it has any).
const catalogs = [
  { label: 'compose', base: join(root, 'apps/mobile/shared/src/commonMain/composeResources') },
  { label: 'shared android', base: join(root, 'apps/mobile/shared/src/androidMain/res') },
  { label: 'android app', base: join(root, 'apps/mobile/androidApp/src/main/res') },
].filter(({ base }) => existsSync(join(base, 'values')));

const cjk = /[㐀-䶿一-鿿豈-﫿]/;

function parse(text, name) {
  const entries = new Map();
  const add = (key, value) => {
    if (entries.has(key)) {
      entries.set(key, { text: entries.get(key).text, file: `${entries.get(key).file}, ${name}`, duplicate: true });
    } else {
      entries.set(key, { text: value, file: name });
    }
  };
  for (const match of text.matchAll(/<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) add(match[1], match[2]);
  // `<plurals>` are keyed by name and quantity, so a missing translation of one form is caught.
  for (const match of text.matchAll(/<plurals\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/plurals>/g)) {
    for (const item of match[2].matchAll(/<item\s+quantity="([^"]+)"[^>]*>([\s\S]*?)<\/item>/g)) {
      add(`${match[1]}:${item[1]}`, item[2]);
    }
  }
  return entries;
}

function catalog(base, directory) {
  const path = join(base, directory);
  if (!existsSync(path)) return new Map();
  const entries = new Map();
  for (const name of readdirSync(path).filter(name => name.endsWith('.xml')).sort()) {
    for (const [key, value] of parse(readFileSync(join(path, name), 'utf8'), name)) {
      if (entries.has(key)) {
        entries.set(key, { text: entries.get(key).text, file: `${entries.get(key).file}, ${value.file}`, duplicate: true });
      } else {
        entries.set(key, value);
      }
    }
  }
  return entries;
}

const placeholders = text => [...text.matchAll(/%(\d+\$)?[sd]/g)].map(([match]) => match).sort();
const problems = [];
let total = 0;
for (const { label, base } of catalogs) {
  const catalogsByLocale = Object.fromEntries(locales.map(locale => [locale, catalog(base, locale)]));
  for (const [locale, entries] of Object.entries(catalogsByLocale)) {
    for (const [key, value] of entries) {
      if (value.duplicate) problems.push(`${label} ${locale}: ${key} is defined more than once (${value.file})`);
    }
  }
  const [source, english] = locales.map(locale => catalogsByLocale[locale]);
  total += source.size;
  // A catalog without `values-en` (the app module's brand-only resources) still gets the duplicate
  // check above, but there is no translation to compare it with.
  if (english.size === 0 && !existsSync(join(base, 'values-en'))) continue;
  for (const key of source.keys()) if (!english.has(key)) problems.push(`${label} values-en: missing ${key}`);
  for (const key of english.keys()) if (!source.has(key)) problems.push(`${label} values: missing ${key}`);
  for (const [key, value] of source) {
    const other = english.get(key);
    if (!other) continue;
    const left = placeholders(value.text).join(' '), right = placeholders(other.text).join(' ');
    if (left !== right) problems.push(`${label} ${key}: placeholders differ (${left || 'none'} vs ${right || 'none'})`);
  }
  for (const [key, value] of english) {
    // A language picker names each language in its own script, regardless of the interface locale.
    const endonym = key === 'settings_language_chinese' && value.text === '简体中文';
    if (cjk.test(value.text) && !endonym) problems.push(`${label} values-en: ${key} contains Chinese text`);
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`mobile strings: ${total} key(s) in ${locales.join(' and ')}.`);
