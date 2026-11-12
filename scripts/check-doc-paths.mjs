#!/usr/bin/env node
// Keeps repo paths named in Markdown honest: a file that moved or was renamed must not leave a dead
// reference behind. Usage: `node scripts/check-doc-paths.mjs` (exit 1 on findings).
// Checks Markdown known to git (tracked, or new and not ignored; not ref/, CHANGELOG.md, third-party notices):
// - backtick spans that look like repo paths: they contain `/` and either start with a tracked
//   top-level entry or end in a source/doc extension; an optional `:line`, `:line-line` or `#anchor`
//   suffix is ignored; resolved from the repo root, and from the file's directory for `./` `../`.
//   Docs often abbreviate (`input/editor/keymap.ts` inside a package), so a path that does not start
//   with a top-level entry also passes when some tracked file ends with it;
// - Markdown links and images with relative targets, resolved from the file's directory.
// Skipped: fenced code blocks, URLs, `~/`, absolute paths, placeholders and globs (`…` `...` `<` `>`
// `*` `{` `$` or spaces; `foo/bar` style placeholders, env-var heads) and gitignored build outputs.
// Paths into other repositories, local scratch directories or removed files: wrap them in
// `<!-- doc-paths:off -->` ... `<!-- doc-paths:on -->` (on lines of their own, or around a span inside one
// line such as a table row), or mention `DSH` / `deepseek-harness` on the same line (the sibling checkout
// docs cite).
// Line numbers (`:N`) are not verified: they drift with every edit and would only add noise.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args, input) => execFileSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 1 << 28 });

const tracked = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
const topLevel = new Set(tracked.map((f) => f.split('/')[0]));
const EXCLUDED = /^(ref\/|CHANGELOG\.md$)|(^|\/)node_modules\/|(^|\/)(NOTICE|Acknowledgements|THIRD[-_ ]?PARTY|LICENSE)[^/]*$/i;
const docs = tracked.filter((f) => f.endsWith('.md') && !EXCLUDED.test(f) && existsSync(resolve(root, f)));

const EXT = /\.(?:ts|tsx|js|mjs|cjs|jsx|json|kt|kts|swift|md|yml|yaml|sh|css|html|toml|xml|gradle|properties|plist|xcstrings|sql|py|png|svg)$/;
// Placeholders (`foo/bar.kt`), env-var heads (`GRADLE_USER_HOME/...`), extension lists (`.js/.mjs`), non-ASCII.
const ILLUSTRATIVE = /(?:^|\/)(?:foo|bar|baz)(?:[/.]|$)|^[A-Z][A-Z0-9_]+\/|^\.\w+(?:\/\.?\w+)+$|[^\x00-\x7f]|^\.\/[^/]*$/;
const NOISE = /[…<>*{}$\s]|\.\.\.|^(?:[a-z][a-z0-9+.-]*:|~|\/|#)/i;

function normalize(raw) {
  return raw.replace(/#.*$/, '').replace(/(?::\d+(?:-\d+)?)(?:[,:]\d+(?:-\d+)?)*$/, '');
}

function candidates(file, target, fromBacktick) {
  const dir = posix.dirname(file);
  const out = [posix.normalize(posix.join(dir, target))];
  if (fromBacktick && !target.startsWith('./') && !target.startsWith('../')) out.unshift(posix.normalize(target));
  return out;
}

const pending = [];
for (const file of docs) {
  const lines = readFileSync(resolve(root, file), 'utf8').split('\n');
  let fence = null;
  let off = false;
  lines.forEach((text, i) => {
    // `visible` is the line with its switched-off spans blanked, so match offsets stay put.
    const wasOff = off;
    let visible = '';
    for (const part of text.split(/(doc-paths:(?:off|on))/)) {
      if (part === 'doc-paths:off') off = true;
      else if (part === 'doc-paths:on') off = false;
      visible += off || part.startsWith('doc-paths:') ? ' '.repeat(part.length) : part;
    }
    if ((wasOff && off) || /\bDSH\b|deepseek-harness/.test(text)) return;
    const marker = /^\s*(```+|~~~+)/.exec(text);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const consider = (raw, fromBacktick, at = 0) => {
      if (NOISE.test(raw)) return;
      // History notes name files that no longer exist: "(原 `old/path.ts`)", "曾位于 `docs/X.md`".
      if (fromBacktick && /(?:原|曾位于|曾经是|formerly|was)\s*$/i.test(visible.slice(0, at))) return;
      const target = normalize(raw);
      if (!target || (fromBacktick && (!target.includes('/') || ILLUSTRATIVE.test(target)))) return;
      if (fromBacktick) {
        const head = target.split('/')[0];
        if (head.startsWith('.') && !head.startsWith('..') && head !== '.' && !topLevel.has(head)) return;
        if (head.startsWith('@')) return;
        if (!(topLevel.has(head) || target.startsWith('./') || target.startsWith('../') || EXT.test(target))) return;
      }
      pending.push({ file, line: i + 1, raw, backtick: fromBacktick, relative: target.startsWith('./') || target.startsWith('../'), options: candidates(file, target.replace(/\/$/, ''), fromBacktick) });
    };
    for (const m of visible.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) consider(m[1], false, m.index);
    for (const m of visible.matchAll(/`([^`]+)`/g)) consider(m[1], true, m.index);
  });
}

const suffixes = new Set();
for (const f of tracked) for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) suffixes.add(f.slice(i + 1));
// Exact-case names from git, not the filesystem: macOS resolves `Docs/x.md` to `docs/x.md`, a Linux
// checkout does not. Directories count through the files under them.
const known = new Set(tracked);
for (const f of tracked) for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) known.add(f.slice(0, i));
const exists = (p) =>
  p.options.some((o) => !o.startsWith('..') && (o === '.' || known.has(o)) && existsSync(resolve(root, o))) ||
  (p.backtick && !p.relative && suffixes.has(p.options[0].replace(/\/$/, '')));
const missing = pending.filter((p) => !exists(p));
// A path that falls under a gitignored output (build/, dist/, ...) is not expected to exist.
// check-ignore exits 1 when none of its inputs is ignored.
const checkIgnore = (paths) => {
  try { return git(['check-ignore', '--no-index', '--stdin', '-z'], paths.join('\0') + '\0'); } catch (error) { if (error.status === 1) return ''; throw error; }
};
// Each path is also asked as a directory: a dir-only pattern (`*.xcodeproj/`) does not match a path that is absent.
const asDir = (path) => path.replace(/\/?$/, '/');
const ignored = new Set(missing.length ? checkIgnore(missing.flatMap((p) => [p.options[0], asDir(p.options[0])])).split('\0').filter(Boolean) : []);
const findings = missing.filter((p) => !ignored.has(p.options[0]) && !ignored.has(asDir(p.options[0])));

for (const f of findings) console.error(`${f.file}:${f.line}  missing ${f.raw}`);
if (findings.length) {
  console.error(`\n${findings.length} Markdown path reference(s) point at nothing.`);
  process.exit(1);
}
console.log(`Markdown paths OK (${docs.length} files).`);
