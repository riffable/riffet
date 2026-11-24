/**
 * The AI-friendly engineering mechanism (docs/guide/aif.md): modules declared in their own AGENTS.md,
 * context handed out by changed path, checks picked by changed path, and fix attribution in CI.
 *
 *   pnpm aif modules                    list the declared modules
 *   pnpm aif context [path...]          rules, co-change hits, recordings and verify commands for the scope
 *   pnpm verify [path...] [--dry-run]   run the module, global and related checks for the scope
 *   pnpm check:modules [--update]       validate declarations, anchors and the file size ratchet
 *   pnpm aif commits <base>..<head>     CI: fix commits without `Missed:` fail (warn before MISSED_REQUIRED_FROM); warn without recordings
 *   pnpm aif hooks                      install the commit-msg hook that refuses a fix commit without `Missed:`
 *   pnpm aif coupling [--days 90]       file pairs in different modules that change together without importing each other
 *   pnpm aif sizes [--days 90]          fix share by file size per language, the hotspots, and the size exemptions
 *
 * A module is a directory whose AGENTS.md starts with front matter carrying `module:`. Its files are the
 * directory minus deeper modules. The scope is the paths given, else the working tree's changes (which
 * may include other sessions' edits in a shared checkout: pass paths to narrow it).
 *
 * File sizes (docs/guide/aif.md §5.1): a non-test source file in a module that is not in
 * scripts/aif-baseline.json may not pass LINE_LIMIT, and a file listed there may not grow past its
 * baseline entry (if an addition pushes it over, split first or grant a temporary `exempt` cap).
 * `--update` lowers entries and drops the ones back under the limit; `--update --add <path>` also
 * records <path> at its current size. A file kept large on purpose is listed under `exempt` with a
 * hard limit and the reason, which `sizes` prints for review.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'scripts/aif-baseline.json');
const LINE_LIMIT = 1000;
const BODY_LIMIT = 80;
const CONTEXT_TOKENS = 2000;
const SECTIONS = ['职责', '入口', '不变量', '外部行为', '排障'];
const MISSED = ['context', 'co-change', 'external', 'invariant', 'cross-platform', 'logic'];
/** Fix commits authored from this day on must carry `Missed:`; CI only warns about older ones, which cannot be reworded once pushed. */
const MISSED_REQUIRED_FROM = '2026-11-21';
const SOURCE = /\.(ts|tsx|mts|mjs|swift|kt)$/;
const TEST = /(\.test\.|\.spec\.|\/test\/|Test\.kt$|Tests?\.swift$|\/fixtures\/)/;
/** Trees where every source file must belong to a module (docs/guide/aif.md §5.1); more join as they are declared. */
const COVERED = ['apps/server/src/'];

/**
 * Global checks by changed path; what AGENTS.md's "改了什么跑什么" table said, in executable form. The
 * module-level ones live in each module's `verify`; the `gen:*:check` ones are derived from the
 * generator scripts (`generatorChecks`).
 */
const GLOBAL_CHECKS: { when: RegExp; run: string }[] = [
  { when: /\.(ts|tsx|mts)$/, run: 'pnpm typecheck' },
  { when: /^apps\/server\/src\//, run: 'pnpm check:layers' },
  { when: /^apps\/(web|macos|mobile)\//, run: 'pnpm check:design' },
  { when: /^apps\/web\/src\//, run: 'pnpm check:servers' },
  { when: /^apps\/(web|macos|mobile|server)\//, run: 'pnpm check:perf' },
  { when: /^apps\/web\//, run: 'pnpm check:motion' },
  { when: /^apps\/web\/src\/.*\.tsx$/, run: 'pnpm check:a11y' },
  { when: /^apps\/web\/src\/.*\.tsx?$/, run: 'pnpm i18n:check' },
  { when: /^apps\/mobile\//, run: 'pnpm check:mobile-strings' },
  { when: /^apps\/mobile\/.*\.kt$/, run: 'pnpm check:compose' },
  { when: /^(packages\/plugin|plugins\/|apps\/server\/src\/plugins)/, run: 'pnpm check:plugins' },
  { when: /\.md$/, run: 'pnpm check:docs' },
  { when: /(^|\/)AGENTS\.md$|^scripts\/aif/, run: 'pnpm check:modules' },
];

type CoChange = { when: string; with: string[]; reason: string };
type Module = {
  id: string;
  dir: string;
  doc: string;
  body: string;
  bodyStart: number;
  verify: string[];
  coChange: CoChange[];
  recordings?: string;
};

const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
const tracked = () => git('ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean);
const fail = (problems: string[]) => {
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
};

function frontMatter(text: string): { data: Record<string, unknown>; body: string; bodyStart: number } | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return null;
  return { data: (parseYaml(match[1]) ?? {}) as Record<string, unknown>, body: text.slice(match[0].length), bodyStart: match[0].split('\n').length };
}

function loadModules(files = tracked()): { modules: Module[]; problems: string[] } {
  const modules: Module[] = [];
  const problems: string[] = [];
  for (const doc of files.filter((file) => file.endsWith('/AGENTS.md') && existsSync(join(root, file)))) {
    const parsed = frontMatter(readFileSync(join(root, doc), 'utf8'));
    if (!parsed || parsed.data.module === undefined) continue;
    const { data } = parsed;
    const list = (value: unknown, key: string): string[] => {
      if (value === undefined) return [];
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
      problems.push(`${doc}: \`${key}\` must be a list of strings`);
      return [];
    };
    const coChange = (Array.isArray(data['co-change']) ? data['co-change'] : data['co-change'] === undefined ? [] : null) as unknown[] | null;
    if (!coChange) problems.push(`${doc}: \`co-change\` must be a list`);
    const rules: CoChange[] = [];
    for (const rule of coChange ?? []) {
      const { when, with: also, reason } = (rule ?? {}) as Record<string, unknown>;
      if (typeof when !== 'string' || !Array.isArray(also) || !also.every((item) => typeof item === 'string') || typeof reason !== 'string') {
        problems.push(`${doc}: each \`co-change\` entry needs \`when\` (path), \`with\` (paths) and \`reason\``);
        continue;
      }
      rules.push({ when, with: also, reason });
    }
    if (typeof data.module !== 'string' || !/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/.test(data.module)) problems.push(`${doc}: \`module\` must be a dotted lowercase id`);
    if (data.layer !== undefined) problems.push(`${doc}: \`layer\` is read from LAYERS in scripts/check-layers.mjs; remove it here`);
    modules.push({
      id: String(data.module),
      dir: posix.dirname(doc),
      doc,
      body: parsed.body,
      bodyStart: parsed.bodyStart,
      verify: list(data.verify, 'verify'),
      coChange: rules,
      recordings: typeof data.recordings === 'string' ? data.recordings : undefined,
    });
  }
  modules.sort((a, b) => b.dir.length - a.dir.length);
  return { modules, problems };
}

/**
 * The server's layers, read from the one place they are declared (`LAYERS` in scripts/check-layers.mjs)
 * rather than repeated in module docs. Empty when that literal cannot be read.
 */
function serverLayers(): [string, string[]][] {
  const text = readFileSync(join(root, 'scripts/check-layers.mjs'), 'utf8');
  const literal = /^const LAYERS = (\[[\s\S]*?\n\]);/m.exec(text)?.[1];
  try { return literal ? JSON.parse(literal.replace(/'/g, '"').replace(/,(\s*\])/g, '$1')) : []; } catch { return []; }
}

/** The layer of a server module directory: an exact entry, then a `dir/*` entry, then the nearest enclosing entry. */
function layerOf(dir: string, layers = serverLayers()): string | undefined {
  const prefix = 'apps/server/src/';
  if (!dir.startsWith(prefix)) return undefined;
  const path = dir.slice(prefix.length);
  const find = (match: (entry: string) => boolean) => layers.find(([, entries]) => entries.some(match))?.[0];
  return find((entry) => entry === path)
    ?? find((entry) => entry.endsWith('/*') && posix.dirname(path) === entry.slice(0, -2))
    ?? [...path.split('/').keys()].reverse().map((at) => path.split('/').slice(0, at).join('/')).filter(Boolean).map((parent) => find((entry) => entry === parent)).find(Boolean);
}

const shellQuote = (value: string) => (/^[\w./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/**
 * `gen:*:check` scripts and the paths each one depends on: its script, the repo files it imports
 * (transitively within scripts/; a whole package for a file in packages/) and the repo paths written in it, which
 * are its inputs and outputs. Derived on every run, so a new generator needs no entry here.
 */
function generatorChecks(): { run: string; watch: string[] }[] {
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
  const out: { run: string; watch: string[] }[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (!/^gen:.*:check$/.test(name)) continue;
    const watch = new Set<string>();
    const queue = [...command.matchAll(/scripts\/[\w.-]+\.(?:ts|mjs)/g)].map((match) => match[0]);
    for (let file; (file = queue.shift()); ) {
      if (watch.has(file) || !existsSync(join(root, file))) continue;
      watch.add(file);
      const text = readFileSync(join(root, file), 'utf8');
      for (const [, spec] of text.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
        const target = posix.normalize(posix.join(posix.dirname(file), spec!));
        const candidates = [target, target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}.mjs`, `${target}/index.ts`];
        const found = candidates.find((candidate) => existsSync(join(root, candidate)) && statSync(join(root, candidate)).isFile());
        if (!found || found.startsWith('..')) continue;
        // A package's files import one another freely: any change in it may change what is generated.
        if (found.startsWith('packages/')) watch.add(`${found.split('/').slice(0, 2).join('/')}/`);
        else queue.push(found);
      }
      for (const [, path] of text.matchAll(/['`]((?:apps|packages|scripts|docs|i18n|plugins)\/[^'`*$<>{}\s]+)['`]/g)) watch.add(path!);
    }
    out.push({ run: `pnpm ${name}`, watch: [...watch] });
  }
  return out;
}

const touches = (file: string, watch: string) => file === watch || file.startsWith(watch.endsWith('/') ? watch : `${watch}/`);

/** The deepest module containing `file`. */
const moduleOf = (modules: Module[], file: string) => modules.find((module) => file.startsWith(`${module.dir}/`));

/** Every AGENTS.md between the repo root (exclusive) and `file`, outermost first. */
function guidesFor(file: string, docs: Set<string>): string[] {
  const out: string[] = [];
  for (let dir = posix.dirname(file); dir !== '.' && dir !== ''; dir = posix.dirname(dir)) if (docs.has(`${dir}/AGENTS.md`)) out.unshift(`${dir}/AGENTS.md`);
  return out;
}

/** `path#symbol` → repo path and symbol; paths starting with a top-level entry are repo-relative, others module-relative. */
function anchor(ref: string, base: string): { path: string; symbol?: string } {
  const [path, symbol] = ref.split('#');
  const repoRelative = /^(apps|packages|scripts|docs|plugins)\//.test(path);
  return { path: repoRelative ? path : normalize(join(base, path)).split('\\').join('/'), symbol };
}

const symbolPattern = (symbol: string) => new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

function anchorProblem(ref: string, base: string): string | null {
  const { path, symbol } = anchor(ref, base);
  if (!existsSync(join(root, path))) return `\`${ref}\`: ${path} does not exist`;
  if (symbol && statSync(join(root, path)).isFile() && !symbolPattern(symbol).test(readFileSync(join(root, path), 'utf8'))) return `\`${ref}\`: ${symbol} not found in ${path}`;
  return null;
}

/**
 * Anchors in a module body: backticked `file#symbol`, and backticked paths that name a source file or
 * end in `/` (a directory). Protocol method names such as `thread/turns/list` are neither.
 */
const bodyAnchors = (body: string) => [
  ...[...body.matchAll(/`([^`\s]+#[A-Za-z_$][\w$]*)`/g)].map((match) => match[1]!),
  ...[...body.matchAll(/`([\w.-]+(?:\/[\w.-]+)*(?:\.(?:ts|tsx|mts|mjs|swift|kt|json|md)|\/))`/g)].map((match) => match[1]!),
];

function scope(paths: string[]): { files: string[]; note?: string } {
  if (paths.length) {
    const all = tracked();
    const files = paths.flatMap((path) => {
      const clean = relative(root, resolve(process.cwd(), path)).split('\\').join('/').replace(/\/$/, '');
      return existsSync(join(root, clean)) && statSync(join(root, clean)).isDirectory() ? all.filter((file) => file.startsWith(`${clean}/`)) : [clean];
    });
    return { files: [...new Set(files)] };
  }
  // -z: paths are verbatim (no quoting or escapes); a rename is followed by its original path, kept too.
  const fields = git('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0');
  const files: string[] = [];
  for (let at = 0; at < fields.length; at++) {
    const entry = fields[at]!;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (/^[RC]/.test(entry)) files.push(fields[++at]!);
  }
  return { files, note: '范围取自工作区的全部改动，可能包含其他会话的修改；传入路径可以缩小范围。' };
}

/** Lines changed in `file` against HEAD, plus hunk headers; the whole file when it is new. */
function changedText(file: string): string {
  try {
    const diff = git('diff', 'HEAD', '-U0', '--', file);
    if (diff) return diff.split('\n').filter((line) => /^(@@|[+-])/.test(line)).join('\n');
  } catch {}
  return existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '';
}

function coChangeHits(modules: Module[], files: string[]) {
  const inScope = new Set(files);
  const hits: { module: Module; rule: CoChange; missing: string[] }[] = [];
  for (const module of modules) {
    for (const rule of module.coChange) {
      const when = anchor(rule.when, module.dir);
      if (!inScope.has(when.path)) continue;
      if (when.symbol && !symbolPattern(when.symbol).test(changedText(when.path))) continue;
      const missing = rule.with.map((ref) => anchor(ref, module.dir).path).filter((path) => !inScope.has(path));
      if (missing.length === rule.with.length) hits.push({ module, rule, missing });
    }
  }
  return hits;
}

function recordingSummary(module: Module): string | null {
  if (!module.recordings) return null;
  const dir = `${module.dir}/${module.recordings}`;
  const files = tracked().filter((file) => file.startsWith(`${dir}/`));
  const cells = new Map<string, Set<string>>();
  for (const file of files) {
    const [channel, version] = file.slice(dir.length + 1).split('/');
    if (!version) continue;
    if (!cells.has(channel)) cells.set(channel, new Set());
    cells.get(channel)!.add(version);
  }
  if (!cells.size) return `录制数据：${dir}/（空）`;
  return `录制数据：${dir}/ — ${[...cells].map(([channel, versions]) => `${channel} ${[...versions].sort().join(', ')}`).join('；')}`;
}

/** A rough token count: CJK characters count one each, the rest one per four characters. */
const tokens = (text: string) => {
  const cjk = text.match(/[\u3000-\u9fff\uff00-\uffef]/g)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
};

function context(paths: string[]) {
  const { modules, problems } = loadModules();
  if (problems.length) fail(problems);
  const { files, note } = scope(paths);
  if (!files.length) return console.log('范围内没有文件。');
  const docs = new Set(tracked().filter((file) => file.endsWith('AGENTS.md')));
  const touched = new Map<Module, string[]>();
  const guides = new Set<string>();
  for (const file of files) {
    const module = moduleOf(modules, file);
    if (module) touched.set(module, [...(touched.get(module) ?? []), file]);
    // Directory guides and enclosing modules' docs are named, not printed: the module itself is printed in full.
    for (const guide of guidesFor(file, docs)) if (guide !== module?.doc) guides.add(guide);
  }
  const hits = coChangeHits(modules, files);
  const out: string[] = [];
  if (note) out.push(`> ${note}`, '');
  for (const [module] of touched) guides.delete(module.doc);
  if (guides.size) out.push(`目录规则与上级模块（开工前读）：${[...guides].join('、')}`, '');
  const full = [...touched].map(([module, own]) => [`# ${module.id}（${module.doc}，范围内 ${own.length} 个文件）`, module.body.trim(), recordingSummary(module), module.verify.length ? `验证：${module.verify.join('；')}` : null].filter(Boolean).join('\n\n'));
  const brief = [...touched].map(([module, own]) => [
    `# ${module.id}（${module.doc}，范围内 ${own.length} 个文件）`,
    ...module.body.split('\n').filter((line) => /^##\s/.test(line) || /^\s*-\s/.test(line)).map((line) => line.replace(/^(\s*-\s[^：:。]{0,60}).*$/, '$1…')),
    recordingSummary(module),
    module.verify.length ? `验证：${module.verify.join('；')}` : null,
  ].filter(Boolean).join('\n'));
  const tail: string[] = [];
  for (const { module, rule, missing } of hits) tail.push(`同改：改了 \`${rule.when}\`（${module.id}），还没动 ${missing.map((path) => `\`${path}\``).join('、')}。${rule.reason}`);
  const unowned = files.filter((file) => SOURCE.test(file) && !moduleOf(modules, file));
  if (unowned.length) tail.push(`未归属模块的源文件 ${unowned.length} 个（模块尚未覆盖，按目录规则处理）。`);
  // The cap covers everything printed; the co-change and coverage lines are kept, the module text shrinks.
  const budget = CONTEXT_TOKENS - tokens([...out, ...tail].join('\n'));
  const headings = [...touched].map(([module, own]) => [`# ${module.id}（${module.doc}，范围内 ${own.length} 个文件）`, ...module.body.split('\n').filter((line) => /^##\s/.test(line)), module.verify.length ? `验证：${module.verify.join('；')}` : null].filter(Boolean).join('\n'));
  const bodyText = [full, brief, headings].map((parts) => parts.join('\n\n')).find((text) => tokens(text) <= budget);
  out.push(bodyText ?? headings.join('\n\n'));
  if (bodyText !== full.join('\n\n')) out.push('', `（模块说明超过 ${CONTEXT_TOKENS} token，已缩短；全文见模块文档。）`);
  if (tail.length) out.push('', ...tail);
  console.log(out.join('\n').trim());
}

function verify(args: string[]) {
  const dryRun = args.includes('--dry-run');
  const paths = args.filter((arg) => arg !== '--dry-run');
  const { modules, problems } = loadModules();
  if (problems.length) fail(problems);
  const { files, note } = scope(paths);
  if (note) console.log(`> ${note}`);
  if (!files.length) return console.log('范围内没有文件。');
  const commands: string[] = [];
  const add = (command: string) => !commands.includes(command) && commands.push(command);
  for (const module of new Set(files.map((file) => moduleOf(modules, file)).filter((m): m is Module => !!m))) module.verify.forEach(add);
  for (const check of GLOBAL_CHECKS) if (files.some((file) => check.when.test(file))) add(check.run);
  for (const check of generatorChecks()) if (files.some((file) => check.watch.some((watch) => touches(file, watch)))) add(check.run);
  const related = files.filter((file) => /\.(ts|tsx|mts)$/.test(file) && existsSync(join(root, file)) && !/^(apps\/(macos|mobile))\//.test(file));
  if (related.length) add(`npx vitest related --run --passWithNoTests ${related.map(shellQuote).join(' ')}`);
  const hits = coChangeHits(modules, files);
  for (const { module, rule, missing } of hits) console.log(`warning: 同改：改了 ${rule.when}（${module.id}），还没动 ${missing.join('、')}。${rule.reason}`);
  if (dryRun) return console.log(commands.join('\n'));
  const failed: string[] = [];
  for (const command of commands) {
    console.log(`\n$ ${command}`);
    const result = spawnSync(command, { cwd: root, shell: true, stdio: 'inherit' });
    if (result.status !== 0) failed.push(command);
  }
  console.log(failed.length ? `\n${failed.length} 项失败：\n${failed.map((command) => `  ${command}`).join('\n')}` : `\n${commands.length} 项通过。`);
  process.exit(failed.length ? 1 : 0);
}

function check(args: string[]) {
  const update = args.includes('--update');
  const added = new Set(args.flatMap((arg, at, all) => (arg === '--add' && all[at + 1] ? [all[at + 1]] : [])));
  const files = tracked();
  const { modules, problems } = loadModules(files);
  const ids = new Map<string, string>();
  for (const module of modules) {
    if (ids.has(module.id)) problems.push(`${module.doc}: module id ${module.id} is also declared in ${ids.get(module.id)}`);
    ids.set(module.id, module.doc);
    const headings = [...module.body.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]);
    if (headings.join('|') !== SECTIONS.join('|')) problems.push(`${module.doc}: sections must be exactly ## ${SECTIONS.join(' / ## ')} in that order (found: ${headings.join(', ') || 'none'})`);
    const bodyLines = module.body.trim().split('\n').length;
    if (bodyLines > BODY_LIMIT) problems.push(`${module.doc}: body is ${bodyLines} lines, the limit is ${BODY_LIMIT}`);
    for (const ref of bodyAnchors(module.body)) {
      const problem = anchorProblem(ref, module.dir);
      if (problem) problems.push(`${module.doc}: ${problem}`);
    }
    for (const rule of module.coChange) for (const ref of [rule.when, ...rule.with]) {
      const problem = anchorProblem(ref, module.dir);
      if (problem) problems.push(`${module.doc}: co-change ${problem}`);
    }
    if (module.recordings && !existsSync(join(root, module.dir, module.recordings))) problems.push(`${module.doc}: recordings directory ${module.dir}/${module.recordings} does not exist`);
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
    for (const command of module.verify) {
      const script = /^pnpm (?:run )?([\w:-]+)/.exec(command)?.[1];
      if (script && !scripts[script]) problems.push(`${module.doc}: verify runs pnpm ${script}, which package.json does not define`);
      for (const token of command.split(/\s+/).filter((token) => /^(apps|packages|scripts)\//.test(token))) if (!existsSync(join(root, token))) problems.push(`${module.doc}: verify names ${token}, which does not exist`);
    }
  }
  for (const file of files) {
    if (COVERED.some((prefix) => file.startsWith(prefix)) && SOURCE.test(file) && !TEST.test(file) && !moduleOf(modules, file)) problems.push(`${file}: belongs to no module; declare one in an enclosing directory's AGENTS.md`);
  }
  const baseline = readBaseline();
  for (const [file, entry] of Object.entries(baseline.exempt)) {
    if (!(entry.limit > LINE_LIMIT) || !entry.reason?.trim()) problems.push(`scripts/aif-baseline.json: the exemption of ${file} needs a limit above ${LINE_LIMIT} and a reason`);
  }
  const sizes = new Map<string, number>();
  for (const file of files) {
    if (!SOURCE.test(file) || TEST.test(file) || !moduleOf(modules, file) || !existsSync(join(root, file))) continue;
    const text = readFileSync(join(root, file), 'utf8');
    sizes.set(file, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
  }
  const over: string[] = [];
  for (const [file, lines] of sizes) {
    const exempt = baseline.exempt[file];
    const recorded = baseline.lines[file];
    if (exempt) {
      if (lines > exempt.limit) over.push(`${file}: ${lines} lines, its exemption allows ${exempt.limit}`);
    } else if (recorded !== undefined) {
      if (lines > recorded && !(update && added.has(file))) {
        over.push(`${file}: ${lines} lines, ${lines - recorded} past its baseline of ${recorded}; split it before growing further`);
      }
    } else if (lines > LINE_LIMIT && !(update && added.has(file))) over.push(`${file}: ${lines} lines, the limit for a file not in scripts/aif-baseline.json is ${LINE_LIMIT}`);
  }
  if (update) {
    const next: Record<string, number> = {};
    for (const [file, allowed] of Object.entries(baseline.lines)) {
      const lines = sizes.get(file);
      if (lines !== undefined && lines > LINE_LIMIT) next[file] = added.has(file) ? lines : Math.min(allowed, lines);
    }
    for (const file of added) if ((sizes.get(file) ?? 0) > LINE_LIMIT) next[file] = sizes.get(file)!;
    const exempt = Object.keys(baseline.exempt).length ? { exempt: baseline.exempt } : {};
    writeFileSync(baselinePath, `${JSON.stringify({ lines: Object.fromEntries(Object.entries(next).sort()), ...exempt }, null, 2)}\n`);
  }
  problems.push(...over);
  if (problems.length) {
    console.error(`modules: ${problems.length} problem(s)`);
    fail(problems);
  }
  console.log(`modules OK (${modules.length} module(s), ${sizes.size} source file(s) under the size ratchet).`);
}

/** The `Missed:` trailer of a fix commit's message and what is wrong with it; nothing for any other commit. */
function missedOf(message: string): { missed?: string; problem?: string } | undefined {
  const [subject = '', ...body] = message.split('\n');
  if (!/^fix(\(|:|!)/.test(subject)) return undefined;
  const missed = body.map((line) => /^Missed:\s*(.+?)\s*$/i.exec(line)?.[1]).find(Boolean);
  if (!missed) return { problem: `no \`Missed:\` trailer (${MISSED.join(' | ')}); see docs/guide/aif.md §5.6.` };
  if (!missed.split(/[,\s]+/).every((value) => MISSED.includes(value))) return { missed, problem: `\`Missed: ${missed}\` is not one of ${MISSED.join(', ')}.` };
  return { missed };
}

function commits(range: string) {
  if (!range) fail(['usage: pnpm aif commits <base>..<head>']);
  const { modules } = loadModules();
  const say = (level: 'warning' | 'error', message: string) => console.log(process.env.GITHUB_ACTIONS ? `::${level} title=AIF::${message}` : `${level}: ${message}`);
  const warn = (message: string) => say('warning', message);
  const shas = git('log', '--no-merges', '--format=%H', range).split('\n').filter(Boolean);
  let fixes = 0, refused = 0;
  for (const sha of shas) {
    const message = git('log', '-1', '--format=%B', sha);
    const [subject] = message.split('\n');
    const fix = missedOf(message);
    if (!fix) continue;
    fixes++;
    const short = `${sha.slice(0, 9)} ${subject}`;
    const missed = fix.missed;
    // The author date survives a rebase, so a commit made before the rule is not held to it afterwards.
    const required = git('log', '-1', '--format=%aI', sha).slice(0, 10) >= MISSED_REQUIRED_FROM;
    if (fix.problem) { say(required ? 'error' : 'warning', `${short}: ${fix.problem}`); if (required) refused++; }
    const changed = git('show', '--name-only', '--format=', sha).split('\n').filter(Boolean);
    for (const module of modules.filter((m) => m.recordings)) {
      const recordings = `${module.dir}/${module.recordings}/`;
      const parsing = changed.filter((file) => file.startsWith(`${module.dir}/`) && SOURCE.test(file) && !TEST.test(file));
      if (parsing.length && !changed.some((file) => file.startsWith(recordings)) && (!missed || /external/.test(missed))) {
        warn(`${short}: changes ${module.id} (${parsing.length} source file(s)) without touching ${recordings}; a fix to how CLI output is read needs a recording (docs/guide/aif.md §5.4), ignore this otherwise.`);
      }
    }
  }
  console.log(`${shas.length} commit(s) in ${range}, ${fixes} fix(es) checked.`);
  if (refused) process.exit(1);
}

/** The commit-msg hook: refuses a fix commit whose message has no valid `Missed:` trailer. */
function commitMsg(file: string) {
  if (!file) fail(['usage: pnpm aif commit-msg <message file>']);
  // Git strips comment lines and everything under the scissors line after this hook has run.
  const text = readFileSync(file, 'utf8').split(/^# -+ >8 -+$/m)[0]!;
  const fix = missedOf(text.split('\n').filter((line) => !line.startsWith('#')).join('\n').trimStart());
  if (fix?.problem) fail([`commit refused: ${fix.problem}`]);
}

const HOOK = `#!/bin/sh
# Installed by \`pnpm aif hooks\` (docs/guide/aif.md §5.6): a fix commit says what was missing.
[ -x node_modules/.bin/tsx ] || exit 0
exec node_modules/.bin/tsx scripts/aif.ts commit-msg "$1"
`;

/**
 * Writes `.git/hooks/commit-msg`, then asks the hook git would really run to judge a fix commit with no trailer:
 * with `core.hooksPath` set (a company-wide hook directory), ours runs only if the hook there calls it.
 */
function installHooks() {
  const hooks = resolve(root, git('rev-parse', '--git-common-dir').trim(), 'hooks');
  const target = join(hooks, 'commit-msg');
  if (existsSync(target) && readFileSync(target, 'utf8') !== HOOK && !readFileSync(target, 'utf8').includes('pnpm aif hooks')) {
    fail([`${relative(root, target)} already exists and is not ours; call \`node_modules/.bin/tsx scripts/aif.ts commit-msg "$1"\` from it.`]);
  }
  mkdirSync(hooks, { recursive: true });
  writeFileSync(target, HOOK);
  chmodSync(target, 0o755);
  let effective = hooks;
  try { effective = resolve(root, git('config', '--type=path', '--get', 'core.hooksPath').trim()); } catch { /* unset: git runs .git/hooks */ }
  const probe = join(mkdtempSync(join(tmpdir(), 'aif-hook-')), 'message');
  writeFileSync(probe, 'fix: probe\n');
  const run = existsSync(join(effective, 'commit-msg')) ? spawnSync(join(effective, 'commit-msg'), [probe], { cwd: root, encoding: 'utf8' }) : undefined;
  rmSync(dirname(probe), { recursive: true, force: true });
  console.log(`installed ${relative(root, target)}`);
  if (run && run.status !== 0 && /Missed/.test(`${run.stdout}${run.stderr}`)) console.log('in effect: a fix commit without `Missed:` is refused.');
  else fail([`not in effect: core.hooksPath is ${effective}, and its commit-msg hook does not call .git/hooks/commit-msg. Call it from there, or unset core.hooksPath for this repository.`]);
}

/** The relative imports of a source file, resolved to repo paths (extension-less and `.js` specifiers included). */
function importsOf(file: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(join(root, file))) return out;
  for (const [, spec] of readFileSync(join(root, file), 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = posix.normalize(posix.join(posix.dirname(file), spec!));
    out.add(target.replace(/\.(js|mjs)$/, ''));
  }
  return out;
}

/**
 * Change coupling (docs/guide/aif.md §5.2): source files in different modules (or areas outside the
 * modules) changed by the same commits while neither imports the other. Commits touching more than
 * 30 source files are left out: a sweep says nothing about a pair.
 */
function coupling(args: string[]) {
  const days = Number(args[args.indexOf('--days') + 1]) || 90;
  const { modules } = loadModules();
  const ownerOf = (file: string) => moduleOf(modules, file)?.id ?? file.split('/').slice(0, file.startsWith('apps/') ? 2 : 1).join('/');
  const log = git('log', `--since=${days}.days`, '--no-merges', '--format=@@%h', '--name-only');
  const changes = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const block of log.split('@@').slice(1)) {
    const files = [...new Set(block.split('\n').slice(1).filter((file) => SOURCE.test(file) && !TEST.test(file) && existsSync(join(root, file))))];
    if (files.length < 2 || files.length > 30) continue;
    for (const file of files) changes.set(file, (changes.get(file) ?? 0) + 1);
    for (let a = 0; a < files.length; a++) for (let b = a + 1; b < files.length; b++) {
      if (ownerOf(files[a]!) === ownerOf(files[b]!)) continue;
      const key = [files[a], files[b]].sort().join('\0');
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  const rows = [...pairs].map(([key, together]) => {
    const [a, b] = key.split('\0') as [string, string];
    const strength = together / Math.min(changes.get(a)!, changes.get(b)!);
    return { a, b, together, strength };
  }).filter((row) => row.together >= 3 && row.strength >= 0.5)
    .filter((row) => !importsOf(row.a).has(row.b.replace(/\.(ts|tsx|mts|mjs)$/, '')) && !importsOf(row.b).has(row.a.replace(/\.(ts|tsx|mts|mjs)$/, '')))
    .sort((x, y) => y.together * y.strength - x.together * x.strength).slice(0, 25);
  console.log(`变更耦合（近 ${days} 天，跨模块，互不导入，共同修改 ≥ 3 次且占较少一方的一半以上）：`);
  for (const row of rows) console.log(`${String(row.together).padStart(3)}× ${(row.strength * 100).toFixed(0).padStart(3)}%  ${row.a} [${ownerOf(row.a)}]  ↔  ${row.b} [${ownerOf(row.b)}]`);
  if (!rows.length) console.log('（无）');
  console.log('\n跨端契约（服务端 ↔ 客户端）的耦合是预期的；其余每一对先找原因：能从结构上消除就消除，消除不了写成同改规则，找不到原因就复核模块边界。');
}

interface Baseline { lines: Record<string, number>; exempt: Record<string, { limit: number; reason: string }> }
function readBaseline(): Baseline {
  const read = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) as Partial<Baseline> : {};
  return { lines: read.lines ?? {}, exempt: read.exempt ?? {} };
}

/**
 * Whether size goes with rework here, per language, so LINE_LIMIT stays a measured line rather than a
 * guess: for files changed at least three times in the window, the share of fix commits by size bucket.
 * It is a correlation (the large files are also the central ones), read as a trend. Then the hotspots,
 * changes × lines, which decide what to split, and the exemptions with their reasons.
 */
function sizes(args: string[]) {
  const days = Number(args[args.indexOf('--days') + 1]) || 90;
  const log = git('log', `--since=${days}.days`, '--no-merges', '--format=@@%s', '--name-only');
  const touched = new Map<string, { changes: number; fixes: number }>();
  for (const block of log.split('@@').slice(1)) {
    const [subject = '', ...files] = block.split('\n');
    const fix = /^fix[(!:]/.test(subject);
    for (const file of new Set(files)) {
      if (!SOURCE.test(file) || TEST.test(file) || !existsSync(join(root, file))) continue;
      const entry = touched.get(file) ?? { changes: 0, fixes: 0 };
      entry.changes += 1; entry.fixes += fix ? 1 : 0;
      touched.set(file, entry);
    }
  }
  const rows = [...touched].filter(([, entry]) => entry.changes >= 3).map(([file, entry]) => {
    const text = readFileSync(join(root, file), 'utf8');
    return { file, lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), ...entry, language: /\.swift$/.test(file) ? 'Swift' : /\.kt$/.test(file) ? 'Kotlin' : 'TypeScript' };
  });
  const buckets: Array<[string, number, number]> = [['< 300', 0, 300], [`300–${LINE_LIMIT}`, 300, LINE_LIMIT], [`${LINE_LIMIT}–1500`, LINE_LIMIT, 1500], ['≥ 1500', 1500, Infinity]];
  console.log(`文件大小与修复比例（近 ${days} 天，改动 ≥ 3 次的非测试文件；相关不等于因果）：`);
  for (const language of ['TypeScript', 'Swift', 'Kotlin']) {
    const own = rows.filter((row) => row.language === language);
    if (!own.length) continue;
    console.log(`  ${language}`);
    for (const [label, low, high] of buckets) {
      const group = own.filter((row) => row.lines >= low && row.lines < high);
      if (!group.length) continue;
      const share = group.reduce((sum, row) => sum + row.fixes, 0) / group.reduce((sum, row) => sum + row.changes, 0);
      console.log(`    ${label.padEnd(9)} ${String(group.length).padStart(4)} 个文件  修复占比 ${(share * 100).toFixed(0).padStart(3)}%`);
    }
  }
  console.log('\n热点（改动次数 × 行数，前 15；拆分按这里排，而不是按行数）：');
  for (const row of [...rows].sort((a, b) => b.changes * b.lines - a.changes * a.lines).slice(0, 15)) {
    console.log(`  ${String(row.changes).padStart(3)} 次  ${String(row.fixes).padStart(3)} fix  ${String(row.lines).padStart(5)} 行  ${row.file}`);
  }
  const { exempt } = readBaseline();
  console.log('\n豁免（复核原因是否仍成立）：');
  for (const [file, entry] of Object.entries(exempt)) console.log(`  ${file}（上限 ${entry.limit}）：${entry.reason}`);
  if (!Object.keys(exempt).length) console.log('  （无）');
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'modules') {
  const { modules, problems } = loadModules();
  if (problems.length) fail(problems);
  const layers = serverLayers();
  for (const module of [...modules].sort((a, b) => a.id.localeCompare(b.id))) {
    const layer = layerOf(module.dir, layers);
    console.log(`${module.id.padEnd(32)} ${module.dir}${layer ? `  [${layer}]` : ''}`);
  }
} else if (command === 'context') context(rest);
else if (command === 'verify') verify(rest);
else if (command === 'check') check(rest);
else if (command === 'commits') commits(rest[0]);
else if (command === 'commit-msg') commitMsg(rest[0]);
else if (command === 'hooks') installHooks();
else if (command === 'coupling') coupling(rest);
else if (command === 'sizes') sizes(rest);
else {
  console.error('usage: tsx scripts/aif.ts modules | context [path...] | verify [path...] [--dry-run] | check [--update [--add <path>]] | commits <base>..<head> | hooks | coupling [--days N] | sizes [--days N]');
  process.exit(2);
}
