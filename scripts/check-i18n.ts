import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, matchesGlob, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { areas } from '../apps/web/lingui.config';

/**
 * The web UI's i18n rules (docs/guide/architecture.md, 界面语言):
 * - Chinese text outside a Lingui message may only shrink: `apps/web/i18n/baseline.json` holds the
 *   per-file count of string, template and JSX text literals that contain CJK, and a file may not
 *   exceed it. `// i18n-ignore` on the line, or on its own line above, exempts a literal that is not
 *   interface text.
 * - No translation at module top level: it would run once, in whatever locale was active then.
 * - Every source file belongs to exactly one catalog area, so nothing goes unextracted.
 * - The catalogs are what `pnpm i18n:extract` writes, and English translates every message.
 * - English catalogs are merged at runtime, so one `(msgid, msgctxt)` may not carry different
 *   translations in different areas: the catalog loaded last would silently win.
 *
 *   pnpm i18n:check                    verify
 *   pnpm i18n:check --update-baseline  record files that now have fewer literals
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(root, 'apps/web');
const baselinePath = resolve(web, 'i18n/baseline.json');
const config = resolve(web, 'lingui.config.ts');
const update = process.argv.includes('--update-baseline');

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const IGNORE = /\/[/*]\s*i18n-ignore\b/;
const CORE_MACRO = '@lingui/core/macro';
const REACT_MACRO = '@lingui/react/macro';
// Macros whose call translates on the spot, as opposed to `msg`, which only describes a message.
const TRANSLATING = new Set(['t', 'plural', 'select', 'selectOrdinal']);

const posix = (path: string) => path.split(sep).join('/');
const files = readdirSync(resolve(web, 'src'), { recursive: true, encoding: 'utf8' })
  .map((file) => `src/${posix(file)}`)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|d)\.ts$/.test(file) && !file.startsWith('src/locales/'))
  .sort();

interface Literal { line: number; text: string }
const counts: Record<string, number> = {};
const literals: Record<string, Literal[]> = {};
const problems: string[] = [];

for (const file of files) {
  const text = readFileSync(resolve(web, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split('\n');
  // Local names of Lingui macros: `t` from `useLingui()` is one too.
  const macros = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    if (from !== CORE_MACRO && from !== REACT_MACRO) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) macros.set(element.name.text, `${from}:${(element.propertyName ?? element.name).text}`);
  }
  const macroName = (node: ts.Node) => (ts.isIdentifier(node) ? macros.get(node.text) : undefined);
  const isI18nCall = (node: ts.Node) => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'i18n' && (node.name.text === '_' || node.name.text === 't');
  const atTopLevel = (node: ts.Node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isClassStaticBlockDeclaration(parent)) return true;
      if (ts.isPropertyDeclaration(parent) && parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) return true;
      if (ts.isFunctionLike(parent) || (ts.isPropertyDeclaration(parent) && ts.isClassLike(parent.parent))) return false;
    }
    return true;
  };
  const ignored = (node: ts.Node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    const above = lines[line - 1]?.trim() ?? '';
    return IGNORE.test(lines[line] ?? '') || (/^(\/\/|\/\*|\{\/\*)/.test(above) && IGNORE.test(above));
  };
  const record = (node: ts.Node, value: string) => {
    if (!CJK.test(value) || ignored(node)) return;
    counts[file] = (counts[file] ?? 0) + 1;
    (literals[file] ??= []).push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: value.trim().slice(0, 60) });
  };
  const visit = (node: ts.Node): void => {
    // `const { t } = useLingui()`
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer) && macroName(node.initializer.expression) === `${REACT_MACRO}:useLingui`) {
      for (const element of node.name.elements) if (ts.isIdentifier(element.name) && ((element.propertyName ?? element.name) as ts.Identifier).text === 't') macros.set(element.name.text, `${REACT_MACRO}:t`);
    }
    const tag = ts.isTaggedTemplateExpression(node) ? node.tag : ts.isCallExpression(node) ? node.expression : undefined;
    if (tag) {
      const macro = macroName(tag);
      const imported = macro?.slice(macro.lastIndexOf(':') + 1);
      if ((macro?.startsWith(CORE_MACRO) && imported && TRANSLATING.has(imported)) || isI18nCall(tag)) {
        if (atTopLevel(node)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          problems.push(`${file}:${line + 1}: translated at module top level; describe it with \`msg\` and translate with \`i18n._()\` where it is shown`);
        }
      }
      // Everything inside a macro or an `i18n._()` call is a message.
      if (macro || isI18nCall(tag)) return;
    }
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && macroName(ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) record(node, node.text);
    else if (ts.isTemplateExpression(node)) record(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(''));
    else if (ts.isJsxText(node)) record(node, node.text);
    // A template's own literal parts are counted with it; its expressions are still visited.
    if (ts.isTemplateExpression(node)) { for (const span of node.templateSpans) visit(span.expression); return; }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const owners = Object.entries(areas).filter(([, include]) => include.some((pattern) => (/[*?{[]/.test(pattern) ? matchesGlob(file, pattern) : file === pattern || file.startsWith(`${pattern}/`)))).map(([name]) => name);
  if (owners.length !== 1) problems.push(`${file}: ${owners.length ? `in more than one catalog area (${owners.join(', ')})` : 'in no catalog area'}; see \`areas\` in apps/web/lingui.config.ts`);
}

// Without a baseline, `--update-baseline` records the current counts as the first one.
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, number> : update ? { ...counts } : {};
const grown = files.filter((file) => (counts[file] ?? 0) > (baseline[file] ?? 0));
const shrunk = files.filter((file) => (counts[file] ?? 0) < (baseline[file] ?? 0));
for (const file of grown) {
  problems.push(`${file}: ${counts[file]} literals with Chinese text outside a Lingui message, baseline ${baseline[file] ?? 0}; wrap the new ones (or mark one that is not interface text with // i18n-ignore):`);
  for (const literal of literals[file] ?? []) problems.push(`    ${literal.line}: ${literal.text}`);
}

if (update) {
  if (grown.length) problems.push('The baseline only goes down; fix the files above first.');
  else writeFileSync(baselinePath, `${JSON.stringify(Object.fromEntries(files.filter((file) => counts[file]).map((file) => [file, counts[file]])), null, 2)}\n`);
}

// Lingui's own checks: the catalogs are what extract would write, and English is complete.
const cli = resolve(dirname(createRequire(import.meta.url).resolve('@lingui/cli')), 'lingui.js');
for (const args of [['check', 'sync', '--clean', '--verbose'], ['check', 'missing', '--locale', 'en', '--mode', 'catalog', '--verbose']]) {
  try { execFileSync(process.execPath, [cli, ...args, '--config', config], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    problems.push(`lingui ${args.join(' ')} failed${args[1] === 'sync' ? ' (run pnpm i18n:extract)' : ' (translate the messages in apps/web/src/locales/en)'}:\n${`${stdout}${stderr}`.trim()}`);
  }
}

// English catalogs are flat-merged at runtime (`apps/web/src/lib/i18n/index.ts`), so the same
// `(msgid, msgctxt)` must mean the same thing everywhere. A message without a context is keyed by
// the Chinese text alone: two areas that translate it differently need distinct Lingui contexts.
{
  const unescape = (raw: string) => raw.replace(/\\(.)/g, (_, char: string) => char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char);
  const entries: { area: string; msgctxt: string; msgid: string; msgstr: string }[] = [];
  for (const file of readdirSync(resolve(web, 'src/locales/en')).filter((name) => name.endsWith('.po')).sort()) {
    const area = file.replace(/\.po$/, '');
    let msgctxt: string | undefined;
    let msgid: string | undefined;
    let msgstr = '';
    let field: 'msgctxt' | 'msgid' | 'msgstr' | undefined;
    const flush = () => {
      if (msgid) entries.push({ area, msgctxt: msgctxt ?? '', msgid, msgstr });
      msgctxt = undefined; msgid = undefined; msgstr = ''; field = undefined;
    };
    for (const line of readFileSync(resolve(web, 'src/locales/en', file), 'utf8').split('\n')) {
      const text = line.trimEnd();
      if (!text.trim()) { flush(); continue; }
      if (text.startsWith('#')) continue;
      const match = /^(msgctxt|msgid|msgstr(?:\[\d+\])?)\s+"(.*)"$/.exec(text);
      if (match) {
        const key = match[1]!;
        const value = match[2]!;
        if (key === 'msgctxt') { flush(); msgctxt = unescape(value); field = 'msgctxt'; continue; }
        if (key === 'msgid') { if (msgid !== undefined) flush(); msgid = unescape(value); field = 'msgid'; continue; }
        // Singular `msgstr` or a plural form: both describe the same message's translation.
        if (msgstr) msgstr += '\u0000';
        msgstr += unescape(value); field = 'msgstr';
        continue;
      }
      if (text.startsWith('"') && field) {
        const chunk = unescape(text.slice(1, -1));
        if (field === 'msgctxt') msgctxt = (msgctxt ?? '') + chunk;
        else if (field === 'msgid') msgid = (msgid ?? '') + chunk;
        else msgstr += chunk;
      }
    }
    flush();
  }
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (!entry.msgid) continue; // the header
    const key = JSON.stringify([entry.msgid, entry.msgctxt || null]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const rows of groups.values()) {
    if (new Set(rows.map((row) => row.msgstr)).size <= 1) continue;
    const { msgid, msgctxt } = rows[0];
    const where = msgctxt ? `context "${msgctxt}"` : 'no context';
    const detail = rows.map((row) => `${row.area}=${JSON.stringify(row.msgstr)}`).join(', ');
    problems.push(`en catalogs translate ${JSON.stringify(msgid)} (${where}) differently: ${detail}; add a distinct Lingui context in each source area`);
  }
}

const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
const note = shrunk.length && !update ? `; ${shrunk.length} file(s) below the baseline, record them with pnpm i18n:check --update-baseline` : '';
console.log(`i18n: ${total} literal(s) with Chinese text outside Lingui messages in ${Object.keys(counts).length} file(s)${update ? ', baseline updated' : ''}${note}.`);
