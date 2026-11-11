import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogType } from '@lingui/cli/api';
import config, { poFormat } from '../apps/web/lingui.config';

/**
 * Generates every client's copy of the server's error texts from `i18n/errors/<domain>.json`
 * (docs/guide/architecture.md, 界面语言):
 * - the web's `errors` catalog, `apps/web/src/locales/{locale}/errors.po`, message `error.<CODE>`;
 * - the Kotlin shared client's `riffet/i18n/ErrorText.kt`.
 *
 * An entry is `"CODE": { "zh": "…", "en": "…" }` in the ICU subset both clients render: `{name}`,
 * `{name, select, …}` and `{name, plural, …}` (`=N`, `one`, `other`). `{message}` is the server's own
 * message, only for codes whose message is an external tool's output. Every code has to be thrown
 * by the host or declared in its public plugin API, so a catalog cannot outlive its protocol error
 * even when the publisher is distributed separately.
 *
 *   pnpm gen:i18n          write
 *   pnpm gen:i18n:check    verify (CI)
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(root, 'i18n/errors');
const web = resolve(root, 'apps/web');
const kotlinOut = resolve(root, 'apps/mobile/client/src/commonMain/kotlin/riffet/i18n/ErrorText.kt');
const checkOnly = process.argv.includes('--check');
const posix = (path: string) => path.split(sep).join('/');

interface Entry { code: string; file: string; zh: string; en: string }
const problems: string[] = [];
const entries: Entry[] = [];

/**
 * The argument names [text] uses, and for each `select` argument its branch keys. Throws on what the
 * Kotlin renderer does not implement, including ICU apostrophe quoting.
 */
function icuShape(text: string): { names: Set<string>; selects: Map<string, string> } {
  const names = new Set<string>();
  const selects = new Map<string, string>();
  let at = 0;
  const fail = (why: string): never => { throw new Error(`${why} at offset ${at}`); };
  const message = (nested: boolean): void => {
    while (at < text.length) {
      const char = text[at]!;
      if (char === '}') { if (nested) return; fail('unbalanced }'); }
      if (char === "'" && /['{}#]/.test(text[at + 1] ?? '')) fail('ICU quoting is not supported');
      if (char === '{') argument();
      else at++;
    }
    if (nested) fail('unclosed {');
  };
  const argument = (): void => {
    at++;
    const head = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:,\s*(select|plural)\s*,)?\s*/.exec(text.slice(at)) ?? fail('expected an argument name');
    const [matched, name, kind] = head;
    names.add(name!);
    at += matched.length;
    if (kind) {
      const keys: string[] = [];
      for (let branch; (branch = /^\s*(=\d+|[A-Za-z][A-Za-z0-9_]*)\s*\{/.exec(text.slice(at)));) {
        const key = branch[1]!;
        if (kind === 'plural' && !/^(=\d+|one|other)$/.test(key)) fail(`plural category ${key} is not supported; use =N, one or other`);
        keys.push(key);
        at += branch[0].length;
        message(true);
        at++;
      }
      if (!keys.includes('other')) fail(`${kind} without an other branch`);
      if (kind === 'select') selects.set(name!, [...keys].sort().join(' '));
      at += /^\s*/.exec(text.slice(at))![0].length;
    }
    if (text[at] !== '}') fail('expected }');
    at++;
  };
  message(false);
  return { names, selects };
}

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((value) => b.has(value));

for (const name of readdirSync(sourceDir).filter((file) => file.endsWith('.json')).sort()) {
  const file = resolve(sourceDir, name);
  const where = posix(relative(root, file));
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { problems.push(`${where}: ${(error as Error).message}`); continue; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) { problems.push(`${where}: expected an object of codes`); continue; }
  for (const [code, value] of Object.entries(data)) {
    const text = value as { zh?: unknown; en?: unknown };
    const other = entries.find((entry) => entry.code === code);
    if (!/^[A-Z][A-Z0-9_]*$/.test(code)) problems.push(`${where}: ${code} is not an error code`);
    else if (other) problems.push(`${where}: ${code} is already in ${posix(relative(root, other.file))}`);
    else if (!text || typeof text.zh !== 'string' || !text.zh.trim() || typeof text.en !== 'string' || !text.en.trim() || Object.keys(text).some((key) => key !== 'zh' && key !== 'en')) problems.push(`${where}: ${code} needs exactly a non-empty zh and en`);
    else {
      try {
        const zh = icuShape(text.zh);
        const en = icuShape(text.en);
        if (!same(zh.names, en.names)) problems.push(`${where}: ${code} has {${[...zh.names].join(', ')}} in zh but {${[...en.names].join(', ')}} in en`);
        for (const [argument, keys] of zh.selects) if (en.selects.get(argument) !== keys) problems.push(`${where}: ${code} selects ${argument} on different keys in zh and en`);
        entries.push({ code, file, zh: text.zh, en: text.en });
      } catch (error) { problems.push(`${where}: ${code}: ${(error as Error).message}`); }
    }
  }
}

// Host errors and public plugin error contracts, including implementations distributed separately.
const thrown = new Set<string>();
const collect = (dir: string) => {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, item.name);
    if (item.isDirectory()) { if (item.name !== 'node_modules') collect(path); }
    else if (/\.ts$/.test(item.name) && !/\.(test|d)\.ts$/.test(item.name)) for (const match of readFileSync(path, 'utf8').matchAll(/['"`]([A-Z][A-Z0-9_]+)['"`]/g)) thrown.add(match[1]!);
  }
};
collect(resolve(root, 'apps/server/src'));
collect(resolve(root, 'plugins'));
collect(resolve(root, 'packages/plugin-api/src'));
for (const entry of entries) if (!thrown.has(entry.code)) problems.push(`${posix(relative(root, entry.file))}: ${entry.code} is neither used by the host nor declared in packages/plugin-api; remove it`);

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const collator = new Intl.Collator('en-US');
entries.sort((a, b) => collator.compare(`error.${a.code}`, `error.${b.code}`));

const outputs = new Map<string, string>();

// The same catalog `lingui extract` would write for the `errors` catalog, with every locale's text.
for (const locale of config.locales ?? []) {
  const filename = resolve(web, `src/locales/${locale}/errors.po`);
  const messages: CatalogType = Object.fromEntries(entries.map((entry) => [`error.${entry.code}`, {
    message: `error.${entry.code}`,
    origin: [[posix(relative(web, entry.file))]],
    comments: [],
    placeholders: {},
    translation: locale === config.sourceLocale ? entry.zh : locale === 'en' ? entry.en : '',
  }]));
  const existing = existsSync(filename) ? readFileSync(filename, 'utf8') : undefined;
  outputs.set(filename, await poFormat.serialize(messages, { locale, sourceLocale: config.sourceLocale!, filename, existing }));
}

const kotlin = (value: string) => `"${value.replace(/[\\"$]/g, (char) => `\\${char}`).replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
outputs.set(kotlinOut, [
  '// Generated by scripts/gen-i18n.ts from i18n/errors/*.json; edit those and run `pnpm gen:i18n`.',
  'package riffet.i18n',
  '',
  '/** The server\'s error texts by code, in ICU message syntax; [L10n.errorText] renders them. */',
  'internal object ErrorText {',
  ...(['zhHans', 'en'] as const).flatMap((locale, index) => [
    ...(index ? [''] : []),
    `    val ${locale}: Map<String, String> = mapOf(`,
    ...entries.map((entry) => `        ${kotlin(entry.code)} to ${kotlin(locale === 'en' ? entry.en : entry.zh)},`),
    '    )',
  ]),
  '}',
  '',
].join('\n'));

const stale = [...outputs].filter(([path, text]) => !existsSync(path) || readFileSync(path, 'utf8') !== text).map(([path]) => path);
if (checkOnly) {
  if (stale.length) {
    console.error(`Stale i18n output (run pnpm gen:i18n):\n${stale.map((path) => `  ${posix(relative(root, path))}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`i18n: ${entries.length} error code(s) are current.`);
} else {
  for (const path of stale) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, outputs.get(path)!);
  }
  console.log(`i18n: ${entries.length} error code(s); ${stale.length ? `wrote ${stale.map((path) => posix(relative(root, path))).join(', ')}` : 'nothing changed'}.`);
}
