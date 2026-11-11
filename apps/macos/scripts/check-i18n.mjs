// The Mac app's interface-language rules (docs/MACOS.md, 界面语言), checked against what the
// compiler recorded in the last Debug build: every string passed to a localizing API, with its
// file and position (SWIFT_EMIT_LOC_STRINGS writes one .stringsdata per source file).
// - Each target's Localizable.xcstrings holds exactly the keys its sources use: none missing, none
//   stale. `--sync` writes them, as Xcode does when it builds.
// - Files listed in i18n-baseline.json `migrated` translate every key they use into English and
//   have no Chinese literal outside a localizing API.
// - Elsewhere such literals may only shrink: `literals` holds the per-file count. `// i18n-ignore`
//   on the line, or on its own line above, exempts a literal that is not interface text.
// - InfoPlist and ServicesMenu catalogs cover the Chinese values of the built Info.plist (usage
//   descriptions, display names, NSServices menu items), in English, and nothing else.
//
//   node apps/macos/scripts/check-i18n.mjs [DerivedData]   verify (build.sh test runs it)
//   ... --sync                                            write new keys, drop stale ones
//   ... --update-baseline                                 record files that now have fewer literals
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const macos = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2).filter(arg => arg.startsWith('--')));
const derived = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? join(macos, 'build/DerivedData'));
const intermediates = join(derived, 'Build/Intermediates.noindex/Riffet.build/Debug');
const products = join(derived, 'Build/Products/Debug');
const baselinePath = join(macos, 'i18n-baseline.json');

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const IGNORE = /\/[/*]\s*i18n-ignore\b/;

// Each target, the folders it compiles, its catalogs and its built Info.plist.
const targets = [
  { name: 'Riffet', sources: ['Riffet', 'RiffetWidgets/Shared'], catalogs: 'Riffet/Resources', plist: 'Riffet.app/Contents/Info.plist' },
  { name: 'RiffetWidgets', sources: ['RiffetWidgets'], catalogs: 'RiffetWidgets', plist: 'Riffet.app/Contents/PlugIns/RiffetWidgets.appex/Contents/Info.plist' },
  { name: 'RiffetShare', sources: ['RiffetShare'], catalogs: 'RiffetShare', plist: 'Riffet.app/Contents/PlugIns/RiffetShare.appex/Contents/Info.plist' },
];

const problems = [];
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
const rel = path => relative(macos, path);

// --- What the compiler extracted ----------------------------------------------------------------

// table -> key -> [file:line] per target, the positions of extracted literals per source file, and
// when each file's record was written.
const extracted = new Map();
const positions = new Map();
const recorded = new Map();
for (const target of targets) {
  const objects = join(intermediates, `${target.name}.build/Objects-normal/arm64`);
  if (!existsSync(objects)) {
    console.error(`check-i18n: ${rel(objects)} is missing; build first (scripts/build.sh test).`);
    process.exit(1);
  }
  const tables = new Map();
  for (const name of readdirSync(objects).filter(name => name.endsWith('.stringsdata'))) {
    const data = readJSON(join(objects, name));
    // A file deleted since an earlier build leaves its record behind.
    if (!data.source || !existsSync(data.source)) continue;
    const file = rel(data.source);
    if (!target.sources.some(folder => file.startsWith(`${folder}/`))) continue;
    // Swift keeps an unchanged .stringsdata file's old timestamp even after recompiling its source.
    // The paired object proves that the extraction belongs to a current compilation too.
    const object = join(objects, name.replace(/\.stringsdata$/, '.o'));
    recorded.set(file, Math.max(statSync(join(objects, name)).mtimeMs, existsSync(object) ? statSync(object).mtimeMs : 0));
    for (const [table, entries] of Object.entries(data.tables ?? {})) {
      // App Shortcut phrases have their own catalog format; they are not interface text yet.
      if (table === 'AppShortcuts') continue;
      for (const entry of entries) {
        if (!tables.has(table)) tables.set(table, new Map());
        const uses = tables.get(table).get(entry.key) ?? [];
        uses.push(`${file}:${entry.location?.startingLine ?? 0}`);
        tables.get(table).set(entry.key, uses);
        if (entry.location) {
          if (!positions.has(file)) positions.set(file, new Set());
          positions.get(file).add(`${entry.location.startingLine}:${entry.location.startingColumn}`);
        }
      }
    }
  }
  extracted.set(target.name, tables);
}

if (flags.has('--sync')) sync();

// --- Catalogs -------------------------------------------------------------------------------------

const baseline = existsSync(baselinePath) ? readJSON(baselinePath) : { migrated: [], literals: {} };
const migrated = new Set(baseline.migrated);

/** True when [entry] has a finished English string, plural and device variants included. */
function english(entry) {
  const done = unit => unit?.stringUnit ? unit.stringUnit.state === 'translated' && unit.stringUnit.value !== '' : leaves(unit);
  const leaves = unit => !!unit?.variations && Object.values(unit.variations).every(cases => Object.values(cases).every(done));
  return done(entry?.localizations?.en);
}

/** Every English value in [unit], whether it is a plain string or plural/device variants. */
function englishValues(unit) {
  if (!unit) return [];
  if (unit.stringUnit) return [unit.stringUnit.value];
  return Object.values(unit.variations ?? {}).flatMap(cases => Object.values(cases).flatMap(englishValues));
}

for (const target of targets) {
  // A target whose code localizes nothing yet still keeps its Localizable catalog clean.
  const tables = new Map([['Localizable', new Map()], ...extracted.get(target.name)]);
  for (const [table, keys] of tables) {
    const path = join(macos, target.catalogs, `${table}.xcstrings`);
    if (!existsSync(path)) {
      problems.push(`${rel(path)} 不存在，${target.name} 的代码用到了 ${table} 表`);
      continue;
    }
    const strings = readJSON(path).strings;
    // An English value that still reads as Chinese means the source string was copied over the
    // translation: the key itself, or anything else with CJK, is never an English interface text.
    const chineseEnglish = Object.entries(strings).flatMap(([key, entry]) =>
      englishValues(entry?.localizations?.en)
        .filter(value => CJK.test(value) || (value === key && CJK.test(key)))
        .map(value => `${show(key)}  en: ${show(value)}`));
    if (chineseEnglish.length) problems.push(`${rel(path)} 有 ${chineseEnglish.length} 个英文值仍是中文：\n${list(chineseEnglish)}`);
    const missing = [...keys.keys()].filter(key => !(key in strings));
    const stale = Object.entries(strings)
      .filter(([key, entry]) => entry.extractionState === 'stale' || (entry.extractionState !== 'manual' && !keys.has(key)))
      .map(([key]) => key);
    if (missing.length) problems.push(`${rel(path)} 缺 ${missing.length} 个键（运行 check-i18n.mjs --sync）：\n${list(missing.map(key => `${show(key)}  ${keys.get(key)[0]}`))}`);
    if (stale.length) problems.push(`${rel(path)} 有 ${stale.length} 个代码已不用的键（运行 check-i18n.mjs --sync）：\n${list(stale.map(show))}`);
    const untranslated = [...keys]
      .filter(([key, uses]) => uses.some(use => migrated.has(use.split(':')[0])) && !english(strings[key]))
      .map(([key, uses]) => `${show(key)}  ${uses.find(use => migrated.has(use.split(':')[0]))}`);
    const manual = Object.entries(strings).filter(([, entry]) => entry.extractionState === 'manual' && !english(entry)).map(([key]) => show(key));
    if (untranslated.length) problems.push(`${rel(path)} 里已迁移文件用到的 ${untranslated.length} 个键没有英文：\n${list(untranslated)}`);
    if (manual.length) problems.push(`${rel(path)} 里手动添加的 ${manual.length} 个键没有英文：\n${list(manual)}`);
  }

  // The built Info.plist decides which of its strings show: usage descriptions, display names and
  // the Services menu. Its Chinese values must be in the catalogs, translated, and nothing else.
  const plistPath = join(products, target.plist);
  if (!existsSync(plistPath)) {
    problems.push(`${rel(plistPath)} 不存在；先构建`);
    continue;
  }
  const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' }));
  const services = (plist.NSServices ?? []).map(service => service.NSMenuItem?.default).filter(Boolean);
  const expected = {
    InfoPlist: new Map(Object.entries(plist).filter(([, value]) => typeof value === 'string' && CJK.test(value))),
    ServicesMenu: new Map(services.map(item => [item, item])),
  };
  for (const [table, wanted] of Object.entries(expected)) {
    const path = join(macos, target.catalogs, `${table}.xcstrings`);
    const strings = existsSync(path) ? readJSON(path).strings : null;
    if (!strings) {
      if (wanted.size) problems.push(`${rel(path)} 不存在，${target.plist} 里有 ${[...wanted.keys()].join('、')}`);
      continue;
    }
    for (const [key, value] of wanted) {
      if (!english(strings[key])) problems.push(`${rel(path)}：${key}（${value}）没有英文`);
    }
    for (const [key, entry] of Object.entries(strings)) {
      const source = entry.localizations?.['zh-Hans']?.stringUnit?.value;
      if (!wanted.has(key)) problems.push(`${rel(path)}：${key} 已不在 Info.plist 里`);
      else if (table === 'InfoPlist' && source !== undefined && source !== wanted.get(key)) {
        problems.push(`${rel(path)}：${key} 的中文与 Info.plist 不一致（${source} ≠ ${wanted.get(key)}）`);
      }
    }
  }
}

// --- Chinese literals outside a localizing API ----------------------------------------------------

/** Every string literal's start (line, UTF-8 column, as the compiler reports them) and whether its
 *  own text, not counting interpolated code, has CJK. Nested literals in interpolations count too. */
function literals(text) {
  const found = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const column = at => Buffer.byteLength(text.slice(lineStart, at)) + 1;
  const advance = () => {
    if (text[i] === '\n') { line += 1; lineStart = i + 1; }
    i += 1;
  };
  // Code until an unbalanced `)` (the end of an interpolation) or the end of the file.
  function code(interpolated) {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') advance(); continue; }
      if (c === '/' && text[i + 1] === '*') {
        let nesting = 0;
        do {
          if (text[i] === '/' && text[i + 1] === '*') { nesting += 1; advance(); }
          else if (text[i] === '*' && text[i + 1] === '/') { nesting -= 1; advance(); }
          advance();
        } while (nesting > 0 && i < text.length);
        continue;
      }
      const raw = /^#*/.exec(text.slice(i, i + 8))[0].length;
      if (text[i + raw] === '"') { string(raw); continue; }
      if (raw && text[i + raw] === '/') {
        // An extended regex literal: #/ … /#.
        const end = text.indexOf('/' + '#'.repeat(raw), i + raw + 1);
        while (i < (end < 0 ? text.length : end + raw + 1)) advance();
        continue;
      }
      if (c === '(') depth += 1;
      if (c === ')') {
        if (interpolated && depth === 0) { advance(); return; }
        depth -= 1;
      }
      advance();
    }
  }
  function string(hashes) {
    const start = { line, column: column(i), cjk: false };
    found.push(start);
    for (let n = 0; n < hashes; n += 1) advance();
    const multiline = text.startsWith('"""', i);
    const close = (multiline ? '"""' : '"') + '#'.repeat(hashes);
    const escape = '\\' + '#'.repeat(hashes);
    for (let n = multiline ? 3 : 1; n > 0; n -= 1) advance();
    while (i < text.length) {
      if (text.startsWith(close, i)) { for (let n = close.length; n > 0; n -= 1) advance(); return; }
      if (text.startsWith(escape, i)) {
        for (let n = escape.length; n > 0; n -= 1) advance();
        if (text[i] === '(') { advance(); code(true); } else advance();
        continue;
      }
      if (!multiline && text[i] === '\n') return;
      const char = String.fromCodePoint(text.codePointAt(i));
      if (CJK.test(char)) start.cjk = true;
      for (let n = char.length; n > 0; n -= 1) advance();
    }
  }
  code(false);
  return found;
}

const counts = {};
const offenders = {};
const files = [...new Set(targets.flatMap(target => target.sources))]
  .flatMap(folder => readdirSync(join(macos, folder), { recursive: true, encoding: 'utf8' }).map(file => `${folder}/${file}`))
  .filter(file => file.endsWith('.swift'));
const unbuilt = [];
for (const file of [...new Set(files)].sort()) {
  // Positions from an older compile of the file would not line up with its text.
  if (!recorded.has(file) || statSync(join(macos, file)).mtimeMs > recorded.get(file)) {
    unbuilt.push(file);
    continue;
  }
  const text = readFileSync(join(macos, file), 'utf8');
  const lines = text.split('\n');
  const localized = positions.get(file) ?? new Set();
  const hits = literals(text).filter(literal =>
    literal.cjk &&
    !localized.has(`${literal.line}:${literal.column}`) &&
    !IGNORE.test(lines[literal.line - 1]) &&
    !/^\s*\/\/\s*i18n-ignore\b/.test(lines[literal.line - 2] ?? ''));
  if (!hits.length) continue;
  counts[file] = hits.length;
  offenders[file] = hits.map(hit => `${file}:${hit.line}  ${lines[hit.line - 1].trim()}`);
}

if (unbuilt.length) problems.push(`上次构建之后改过、还没编译的文件（先跑 scripts/build.sh test）：\n${list(unbuilt)}`);
for (const file of migrated) {
  if (!existsSync(join(macos, file))) problems.push(`i18n-baseline.json 的 migrated 里 ${file} 不存在`);
  else if (counts[file]) problems.push(`已迁移的 ${file} 有 ${counts[file]} 处中文没有经过本地化 API：\n${list(offenders[file])}`);
}
for (const [file, count] of Object.entries(counts)) {
  if (migrated.has(file)) continue;
  const allowed = baseline.literals[file] ?? 0;
  if (count > allowed) problems.push(`${file} 有 ${count} 处中文没有经过本地化 API，基线 ${allowed}；用 String(localized:) / LocalizedStringResource，或给非界面文字加 // i18n-ignore：\n${list(offenders[file])}`);
}

if (flags.has('--update-baseline')) {
  // Counts only go down; a file over its count stays a failure. The first run records them all.
  const first = !existsSync(baselinePath);
  const next = Object.fromEntries(Object.entries(counts)
    .filter(([file]) => !migrated.has(file) && (first || file in baseline.literals))
    .map(([file, count]) => [file, first ? count : Math.min(count, baseline.literals[file])]));
  writeFileSync(baselinePath, `${JSON.stringify({ migrated: [...migrated].sort(), literals: next }, null, 2)}\n`);
  console.log(`check-i18n: wrote ${rel(baselinePath)}`);
}

function sync() {
  for (const target of targets) {
    for (const table of new Set(['Localizable', ...extracted.get(target.name).keys()])) {
      const path = join(macos, target.catalogs, `${table}.xcstrings`);
      if (!existsSync(path)) continue;
      const objects = join(intermediates, `${target.name}.build/Objects-normal/arm64`);
      const records = readdirSync(objects).filter(name => name.endsWith('.stringsdata')).map(name => join(objects, name))
        .filter(record => {
          const source = readJSON(record).source;
          return source && existsSync(source) && target.sources.some(folder => rel(source).startsWith(`${folder}/`));
        });
      if (!records.length) continue;
      execFileSync('xcrun', ['xcstringstool', 'sync', path, '--stringsdata', ...records], { stdio: 'inherit' });
      // xcstringstool keeps a translated key the code no longer uses, marked stale. Drop it, but
      // print the English so a reworded key can take it over.
      const catalog = readJSON(path);
      const stale = Object.keys(catalog.strings).filter(key => catalog.strings[key].extractionState === 'stale');
      for (const key of stale) {
        const value = catalog.strings[key].localizations?.en?.stringUnit?.value;
        console.log(`check-i18n: removed stale ${show(key)}${value ? ` (en: ${show(value)})` : ''}`);
        delete catalog.strings[key];
      }
      if (stale.length) writeFileSync(path, xcode(catalog));
    }
  }
}

/** JSON as Xcode writes a catalog, so a rewrite only shows the entries that changed. */
function xcode(value, indent = '') {
  if (Array.isArray(value)) return `[\n${value.map(item => `${indent}  ${xcode(item, `${indent}  `)}`).join(',\n')}\n${indent}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value);
  if (!keys.length) return `{\n\n${indent}}`;
  return `{\n${keys.map(key => `${indent}  ${JSON.stringify(key)} : ${xcode(value[key], `${indent}  `)}`).join(',\n')}\n${indent}}`;
}

function show(key) {
  return JSON.stringify(key);
}

function list(items, limit = 30) {
  const shown = items.slice(0, limit).map(item => `  ${item}`);
  if (items.length > limit) shown.push(`  …另 ${items.length - limit} 处`);
  return shown.join('\n');
}

if (problems.length) {
  console.error(`${problems.join('\n\n')}\n\ncheck-i18n: 界面语言规则未通过（docs/MACOS.md「界面语言」）。`);
  process.exit(1);
}
const total = Object.entries(counts).filter(([file]) => !migrated.has(file)).reduce((sum, [, count]) => sum + count, 0);
console.log(`check-i18n: ok（${migrated.size} 个已迁移文件，其余 ${Object.keys(counts).length} 个文件共 ${total} 处中文待迁移）`);
