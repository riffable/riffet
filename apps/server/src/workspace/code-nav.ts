import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CodeDefinitions, CodeLocation, CodeReferences } from '../../../../packages/contracts/src/index.js';
import { resolveCliExecutable } from '../backends/shared/cli-resolve.js';
import { AppError } from '../errors.js';
import type { Candidates } from './file-index.js';
import { RESOURCE_FILE, RESOURCE_PATH, resourceReference, VALUE_TYPES, type ResourceReference } from './android-resources.js';
import { isModuleMarker } from './modules.js';
import { resolveScopedPath, toProjectRelative } from './scope.js';
import type { SymbolLookup } from './symbols/indexes.js';

// Search-based code navigation, as Sourcegraph's basic code intel and GitHub's search-based navigation
// do it: no compiler, a table of declaration patterns per language, and the order in which places are
// looked at doing the ranking. A monorepo of hundreds of thousands of files makes a full text scan cost
// ten seconds or more, so a definition is looked for where it most likely lives first (the file, what it
// imports, its directory) and only then in the whole project, with a time budget.

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEFINITIONS = 20;
const MAX_REFERENCES = 1000;
const MAX_TEXT = 500;
const MAX_LINE_LENGTH = 2000;
const NEIGHBOUR_IMPORTS = 150;
const NEIGHBOUR_SIBLINGS = 200;
const READ_CONCURRENCY = 16;
const DEFINITION_SCAN_MS = 25_000;
const MODULE_BUDGET_MS = 10_000;
const PROJECT_BUDGET_MS = 30_000;

// ── Languages ────────────────────────────────────────────────────────────────

type Group = 'kotlin' | 'java' | 'ts' | 'swift' | 'go' | 'python' | 'rust' | 'c' | 'dart' | 'ruby' | 'php' | 'csharp' | 'generic';
/** Files of one family are searched together: Kotlin and Java call each other, JavaScript and TypeScript too. */
type Family = 'jvm' | 'ts' | 'swift' | 'go' | 'python' | 'rust' | 'c' | 'dart' | 'ruby' | 'php' | 'csharp';

const EXTENSIONS: Record<Family, { exts: string[]; groups: Group[] }> = {
  jvm: { exts: ['kt', 'kts', 'java'], groups: ['kotlin', 'java'] },
  ts: { exts: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'], groups: ['ts'] },
  swift: { exts: ['swift'], groups: ['swift'] },
  go: { exts: ['go'], groups: ['go'] },
  python: { exts: ['py'], groups: ['python'] },
  rust: { exts: ['rs'], groups: ['rust'] },
  c: { exts: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm'], groups: ['c'] },
  dart: { exts: ['dart'], groups: ['dart'] },
  ruby: { exts: ['rb'], groups: ['ruby'] },
  php: { exts: ['php'], groups: ['php'] },
  csharp: { exts: ['cs'], groups: ['csharp'] },
};
const FAMILY_OF = new Map<string, Family>();
const GROUP_OF = new Map<string, Group>();
for (const [family, { exts, groups }] of Object.entries(EXTENSIONS) as Array<[Family, { exts: string[]; groups: Group[] }]>) {
  for (const ext of exts) {
    FAMILY_OF.set(ext, family);
    GROUP_OF.set(ext, family === 'jvm' ? (ext === 'java' ? 'java' : 'kotlin') : groups[0]!);
  }
}

// ── Declaration patterns ─────────────────────────────────────────────────────

// Patterns are written for the `regex` crate (ripgrep) and for JavaScript alike: no look-around, no
// back-references. `@@N@@` stands for the name sought.
const NAME = '@@N@@';
interface Rule { re: string; reject?: RegExp }
const ANN = String.raw`(?:@[\w.]+(?:\([^)]*\))?\s+)*`;
const KOTLIN_MODS = String.raw`(?:(?:public|private|protected|internal|abstract|open|final|override|sealed|data|inner|enum|annotation|value|inline|noinline|crossinline|fun|operator|infix|suspend|tailrec|external|expect|actual|const|lateinit|vararg|companion|reified)\s+)*`;
const JAVA_MODS = String.raw`(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|transient|volatile|strictfp|sealed|non-sealed)\s+)*`;
const JAVA_TYPE = String.raw`[\w$.]+(?:<[^;(){}=]*>)?(?:\[\])*`;
const NOT_A_DECLARATION = /^\s*(?:return|new|throw|else|case|yield|await|assert|do|goto|import|package|extends|implements|typedef|using|delete|sizeof|co_return|if|while|for|switch)\b/;
const SWIFT_MODS = String.raw`(?:(?:public|private|fileprivate|internal|open|final|static|class|override|mutating|nonmutating|lazy|weak|unowned|convenience|required|indirect|dynamic|nonisolated|prefix|postfix|infix|optional)\s+)*`;
const RUST_VIS = String.raw`(?:pub(?:\([^)]*\))?\s+)?`;
const TS_MODS = String.raw`(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set|declare|accessor)\s+)*`;
const DART_TYPE = String.raw`[\w$.]+(?:<[^;(){}=]*>)?\??`;
const CSHARP_MODS = String.raw`(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|virtual|override|async|unsafe|new|extern|const|volatile|required|file|ref)\s+)*`;
const CSHARP_TYPE = String.raw`[\w$.]+(?:<[^;(){}=]*>)?\??(?:\[[,\s]*\])*`;
const CSHARP_ATTR = String.raw`(?:\[[^\]]*\]\s*)*`;

const RULES: Record<Group, Rule[]> = {
  kotlin: [
    { re: String.raw`^\s*${ANN}${KOTLIN_MODS}(?:class|interface|object|typealias)\s+${NAME}` },
    { re: String.raw`^\s*${ANN}${KOTLIN_MODS}fun\s+(?:<[^>]*>\s*)?(?:[\w$<>?,.*\s]+\.)?${NAME}\s*[(<]` },
    { re: String.raw`^\s*${ANN}${KOTLIN_MODS}(?:val|var)\s+(?:<[^>]*>\s*)?(?:[\w$<>?,.*]+\.)?${NAME}` },
    { re: String.raw`(?:val|var)\s*\([^)]*${NAME}` },
    { re: String.raw`[(,]\s*${ANN}${KOTLIN_MODS}(?:(?:val|var)\s+)?${NAME}\s*:[^:]` },
    { re: String.raw`^\s*${ANN}${KOTLIN_MODS}(?:(?:val|var)\s+)?${NAME}\s*:\s*[\w(@]` },
    { re: String.raw`\{\s*(?:[\w$]+\s*(?::[^,>]+)?,\s*)*${NAME}\s*(?::[^,>]+)?(?:,[^>]*)?->` },
    { re: String.raw`for\s*\([^)]*${NAME}[^)]*\sin\s` },
  ],
  java: [
    { re: String.raw`^\s*${ANN}${JAVA_MODS}(?:class|interface|enum|record|@interface)\s+${NAME}` },
    { re: String.raw`^\s*${ANN}${JAVA_MODS}(?:<[^;(){}=]+>\s+)?${JAVA_TYPE}\s+${NAME}\s*\(`, reject: NOT_A_DECLARATION },
    { re: String.raw`^\s*${ANN}(?:(?:public|protected|private)\s+)+${NAME}\s*\(` },
    { re: String.raw`^\s*${ANN}${JAVA_MODS}${JAVA_TYPE}\s+${NAME}\s*(?:=|;|,|\)|:)`, reject: NOT_A_DECLARATION },
    { re: String.raw`[(,]\s*(?:final\s+)?${ANN}(?:final\s+)?${JAVA_TYPE}\s+${NAME}\s*[,)=:]`, reject: NOT_A_DECLARATION },
  ],
  ts: [
    { re: String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|namespace|module|enum|const\s+enum)\s+${NAME}` },
    { re: String.raw`^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var|using)\s+${NAME}` },
    { re: String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+[{\[][^=]*${NAME}` },
    { re: String.raw`^\s*${TS_MODS}\*?\s*${NAME}\s*[?!]?\s*(?:<[^>]*>\s*)?\(`, reject: /\)\s*;?\s*$|^\s*(?:return|await|new|throw|if|for|while|switch|else|yield|delete|typeof|void)\b/ },
    { re: String.raw`^\s*(?:(?:public|private|protected|static|readonly|abstract|override|declare|accessor)\s+)*${NAME}\s*[?!]?\s*:\s*[^=]` },
    { re: String.raw`^\s*(?:(?:public|private|protected|static|readonly|abstract|override|declare|accessor)\s+)+${NAME}\s*[?!]?\s*(?:=|;|$)` },
    { re: String.raw`^\s*${TS_MODS}${NAME}\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>` },
    { re: String.raw`[(,]\s*(?:(?:public|private|protected|readonly)\s+)*${NAME}\s*\??\s*:` },
    { re: String.raw`(?:^|[(,\s])${NAME}\s*=>` },
    { re: String.raw`\([^()]*${NAME}[^()]*\)\s*(?::\s*[^=;]+)?=>` },
    { re: String.raw`for\s*\(\s*(?:const|let|var)\s+${NAME}\s+(?:of|in)\b` },
    { re: String.raw`catch\s*\(\s*${NAME}\b` },
  ],
  swift: [
    { re: String.raw`^\s*${ANN}${SWIFT_MODS}(?:func|class|struct|enum|protocol|extension|typealias|actor|associatedtype|let|var|macro)\s+(?:\(\s*)?${NAME}` },
    { re: String.raw`(?:let|var)\s*\([^)]*${NAME}` },
    { re: String.raw`^\s*${ANN}${SWIFT_MODS}case\s+(?:[\w$]+(?:\([^)]*\))?\s*,\s*)*${NAME}` },
    { re: String.raw`\b(?:if|guard|while)\s+(?:let|var)\s+${NAME}` },
    { re: String.raw`\bfor\s+(?:let\s+)?${NAME}\b` },
    { re: String.raw`[(,]\s*(?:[\w$_]+\s+)?${NAME}\s*:\s*[\w\[(@]` },
    { re: String.raw`\{\s*(?:\[[^\]]*\]\s*)?\(?(?:[\w$_]+\s*,\s*)*${NAME}[^{}]*\bin\b` },
  ],
  go: [
    { re: String.raw`^\s*func\s+(?:\([^)]*\)\s*)?${NAME}\s*[\[(]` },
    { re: String.raw`^\s*type\s+${NAME}\b` },
    { re: String.raw`^\s*(?:var|const)\s+${NAME}\b` },
    { re: String.raw`^\s*(?:for\s+)?(?:[\w$]+\s*,\s*)*${NAME}(?:\s*,\s*[\w$]+)*\s*:=` },
    { re: String.raw`^\s+${NAME}(?:\s*,\s*[\w$]+)*\s+[*\[\w(.]` },
    { re: String.raw`[(,]\s*${NAME}(?:\s*,\s*[\w$]+)*\s+[*\[\w.(]` },
  ],
  python: [
    { re: String.raw`^\s*(?:async\s+)?def\s+${NAME}\b` },
    { re: String.raw`^\s*class\s+${NAME}\b` },
    { re: String.raw`^\s*(?:[\w$.]+\s*,\s*)*(?:self\.|cls\.)?${NAME}(?:\s*,\s*[\w$.]+)*\s*=[^=]` },
    { re: String.raw`^\s*(?:self\.|cls\.)?${NAME}\s*:\s*[^=]+=[^=]` },
    { re: String.raw`^\s*(?:async\s+)?def\s+[\w$]+\s*\([^)]*[(,*\s]${NAME}\s*[:=,)]` },
    { re: String.raw`^\s*(?:async\s+)?for\s+(?:[\w$]+\s*,\s*)*${NAME}\b` },
    { re: String.raw`^\s*(?:with|except)\b.*\sas\s+${NAME}\b` },
    { re: String.raw`\blambda\s+[^:]*\b${NAME}\b` },
    { re: String.raw`\b${NAME}\s*:=` },
  ],
  rust: [
    { re: String.raw`^\s*${RUST_VIS}(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?|default)\s+)*(?:fn|struct|enum|trait|type|static|mod|union|const)\s+(?:mut\s+)?${NAME}` },
    { re: String.raw`macro_rules!\s+${NAME}` },
    { re: String.raw`^\s*impl\b[^{]*\b${NAME}` },
    { re: String.raw`\blet\s+(?:mut\s+)?${NAME}` },
    { re: String.raw`\b(?:let|if let|while let)\s+[\w:]*\(\s*(?:mut\s+|ref\s+)?${NAME}` },
    { re: String.raw`[(,]\s*(?:pub\s+)?(?:mut\s+)?${NAME}\s*:[^:]` },
    { re: String.raw`^\s*${RUST_VIS}${NAME}\s*:[^:]` },
    { re: String.raw`\|[^|]*${NAME}[^|]*\|` },
    { re: String.raw`\bfor\s+(?:\(?[\w, ]*,\s*)?${NAME}\s+in\b` },
  ],
  c: [
    { re: String.raw`^\s*#\s*define\s+${NAME}\b` },
    { re: String.raw`^\s*(?:typedef\s+)?(?:struct|class|enum(?:\s+class|\s+struct)?|union|namespace)\s+(?:[\w$]+\s+)*${NAME}\b` },
    { re: String.raw`typedef\b[^;]*\b${NAME}\s*;` },
    { re: String.raw`^\s*\}\s*${NAME}\s*;` },
    { re: String.raw`\busing\s+${NAME}\s*=` },
    { re: String.raw`typedef\s+[^;(]*\(\s*\*\s*${NAME}\s*\)` },
    { re: String.raw`^\s*[A-Za-z_][\w:<>,*&\s]*[\s*&:]${NAME}\s*\(`, reject: NOT_A_DECLARATION },
    { re: String.raw`^\s*@(?:interface|implementation|protocol)\s+${NAME}\b` },
    { re: String.raw`^\s*[-+]\s*\([^)]*\)\s*(?:[\w$]+\s*:\s*\([^)]*\)\s*[\w$]+\s+)*${NAME}\b` },
    { re: String.raw`@property\b[^;]*\b${NAME}\s*;` },
    { re: String.raw`^\s*(?:(?:static|const|extern|volatile|unsigned|signed|inline|register)\s+)*[A-Za-z_][\w:<>,*&]*(?:\s+|\s*[*&]+\s*)${NAME}\s*(?:=|;|\[|,)`, reject: NOT_A_DECLARATION },
  ],
  dart: [
    { re: String.raw`^\s*(?:(?:abstract|sealed|base|final|interface|mixin|augment)\s+)*(?:class|mixin|enum|typedef|extension(?:\s+type)?)\s+${NAME}` },
    { re: String.raw`^\s*${ANN}(?:(?:static|external|abstract|final|const|late|factory)\s+)*${DART_TYPE}\s+${NAME}\s*(?:<[^;(){}=]*>)?\(`, reject: NOT_A_DECLARATION },
    { re: String.raw`^\s*(?:const\s+|factory\s+)?${NAME}(?:\.[\w$]+)?\s*\([^;]*\)\s*(?:\{|:|=>)` },
    { re: String.raw`\b(?:get|set)\s+${NAME}\b` },
    { re: String.raw`^\s*(?:(?:static|final|const|late|var|covariant)\s+)+(?:${DART_TYPE}\s+)?${NAME}\s*(?:=|;|,)` },
    { re: String.raw`^\s*${DART_TYPE}\s+${NAME}\s*(?:=|;)`, reject: NOT_A_DECLARATION },
    { re: String.raw`[(,{]\s*(?:required\s+)?(?:this\.|super\.|${DART_TYPE}\s+)${NAME}\s*[,)=}]` },
  ],
  ruby: [
    { re: String.raw`^\s*def\s+(?:self\.|[\w$]+\.)?${NAME}\b` },
    { re: String.raw`^\s*(?:class|module)\s+(?:[\w$]+::)*${NAME}\b` },
    { re: String.raw`^\s*(?:[\w@$.]+\s*,\s*)*(?:@@?|self\.)?${NAME}(?:\s*,\s*[\w@$.]+)*\s+(?:\|\|)?=[^=~>]` },
    { re: String.raw`attr_(?:reader|writer|accessor)\b[^#]*:${NAME}\b` },
    { re: String.raw`^\s*(?:alias_method\s+:|alias\s+:?)${NAME}\b` },
    { re: String.raw`(?:\{|\bdo)\s*\|[^|]*${NAME}[^|]*\|` },
  ],
  php: [
    { re: String.raw`^\s*(?:(?:abstract|final|static|public|private|protected|readonly)\s+)*function\s+&?${NAME}\b` },
    { re: String.raw`^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+${NAME}\b` },
    { re: String.raw`\bconst\s+${NAME}\b` },
    { re: String.raw`\bdefine\s*\(\s*['"]${NAME}['"]` },
    { re: String.raw`^\s*(?:(?:public|private|protected|static|readonly|var)\s+)+(?:\??[\w\\]+\s+)?\$${NAME}\b` },
    { re: String.raw`\$${NAME}\s*=[^=]` },
    { re: String.raw`function\s+&?[\w$]*\s*\([^)]*\$${NAME}\b` },
    { re: String.raw`(?:foreach|catch)\s*\([^)]*\$${NAME}\b` },
  ],
  csharp: [
    { re: String.raw`^\s*${CSHARP_ATTR}${CSHARP_MODS}(?:class|struct|interface|enum|record(?:\s+struct|\s+class)?|delegate\s+${CSHARP_TYPE})\s+${NAME}\b` },
    { re: String.raw`^\s*${CSHARP_ATTR}${CSHARP_MODS}${CSHARP_TYPE}\s+${NAME}\s*(?:<[^;(){}=]*>)?\s*\(`, reject: NOT_A_DECLARATION },
    { re: String.raw`^\s*${CSHARP_ATTR}(?:public|private|protected|internal|static)\s+${NAME}\s*\(` },
    { re: String.raw`^\s*${CSHARP_ATTR}${CSHARP_MODS}${CSHARP_TYPE}\s+${NAME}\s*(?:=>|=|;|,|\{|\))`, reject: NOT_A_DECLARATION },
    { re: String.raw`[(,]\s*(?:(?:ref|out|in|params|this)\s+)*${CSHARP_TYPE}\s+${NAME}\s*[,)=]`, reject: NOT_A_DECLARATION },
    { re: String.raw`foreach\s*\(\s*[\w$.<>?]+\s+${NAME}\s+in\b` },
  ],
  generic: [
    { re: String.raw`\b(?:function|def|class|func|fn|struct|interface|enum|type|const|let|var|val|trait|module|object)\s+${NAME}\b` },
  ],
};
const COMMENT: Record<Group, RegExp> = {
  kotlin: /^\s*(?:\/\/|\*|\/\*)/, java: /^\s*(?:\/\/|\*|\/\*)/, ts: /^\s*(?:\/\/|\*|\/\*)/, swift: /^\s*(?:\/\/|\*|\/\*)/, go: /^\s*(?:\/\/|\*|\/\*)/,
  rust: /^\s*(?:\/\/|\*|\/\*)/, c: /^\s*(?:\/\/|\*|\/\*)/, dart: /^\s*(?:\/\/|\*|\/\*)/, csharp: /^\s*(?:\/\/|\*|\/\*)/,
  python: /^\s*#/, ruby: /^\s*#/, php: /^\s*(?:\/\/|#|\*|\/\*)/, generic: /^\s*(?:\/\/|#\s|\*|\/\*)/,
};

const escape = (word: string) => word.replace(/\$/g, '\\$');
/** The name as a whole word: `\b` cannot stand next to `$`, which a name may begin or end with. */
const namePattern = (word: string) => `${word.startsWith('$') ? '' : '\\b'}${escape(word)}${word.endsWith('$') ? '' : '\\b'}`;
const wordRegex = (word: string) => new RegExp(`(?<![\\w$])${escape(word)}(?![\\w$])`);

interface Matcher { word: string; bare: string; rules: Array<{ re: RegExp; reject?: RegExp }>; comment: RegExp; column: RegExp }
const matchers = new Map<string, Matcher>();

function matcher(group: Group, word: string): Matcher {
  const key = `${group}\0${word}`;
  let found = matchers.get(key);
  if (!found) {
    if (matchers.size > 200) matchers.clear();
    // A PHP variable is written `$name`: the patterns carry the sigil themselves.
    const bare = group === 'php' ? word.replace(/^\$/, '') || word : word;
    const name = namePattern(bare);
    found = { word, bare, rules: RULES[group].map(rule => ({ re: new RegExp(rule.re.replaceAll(NAME, () => name)), reject: rule.reject })), comment: COMMENT[group], column: wordRegex(bare) };
    matchers.set(key, found);
  }
  return found;
}

interface Declaration { location: CodeLocation; rule: number }

/** Declarations of the matcher's word in `text`, in file order; `rule` is the index of the pattern that matched, the primary kind of declaration first. */
function declarationsOf(text: string, file: string, m: Matcher): Declaration[] {
  if (!text.includes(m.bare)) return [];
  const found: Declaration[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.length > MAX_LINE_LENGTH || !line.includes(m.bare) || m.comment.test(line)) continue;
    const rule = m.rules.findIndex(candidate => candidate.re.test(line) && !candidate.reject?.test(line));
    if (rule < 0) continue;
    found.push({ location: { path: file, line: index + 1, column: (m.column.exec(line)?.index ?? 0) + 1, text: clip(line) }, rule });
  }
  return found;
}

export const declarations = (text: string, file: string, word: string, group: Group): CodeLocation[] => declarationsOf(text, file, matcher(group, word)).map(item => item.location);

const clip = (line: string) => line.replace(/\r$/, '').slice(0, MAX_TEXT);
const extOf = (file: string) => path.posix.extname(file).slice(1).toLowerCase();
const groupOf = (file: string): Group => GROUP_OF.get(extOf(file)) ?? 'generic';
const dirOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf('/')));
const isCapitalised = (word: string) => /^[A-Z]/.test(word);

function commonDirs(a: string, b: string): number {
  const left = dirOf(a).split('/');
  const right = dirOf(b).split('/');
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return shared;
}
/** Closer to `from` first (more leading directories in common), then the shorter path. */
const nearest = (from: string) => (a: string, b: string) => commonDirs(b, from) - commonDirs(a, from) || a.length - b.length || (a < b ? -1 : 1);

async function pool<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const at = next++; results[at] = await work(items[at]!); }
  }));
  return results;
}

// ── Project access ───────────────────────────────────────────────────────────

interface Names { files: Map<string, number[]>; dirs: Map<string, number[]> }
const namesOf = new WeakMap<Candidates, Names>();

function names(list: Candidates): Names {
  let found = namesOf.get(list);
  if (!found) {
    found = { files: new Map(), dirs: new Map() };
    for (let index = 0; index < list.paths.length; index++) {
      const table = index < list.dirStart ? found.files : found.dirs;
      const name = list.names[index]!;
      const bucket = table.get(name);
      if (bucket) bucket.push(index); else table.set(name, [index]);
    }
    namesOf.set(list, found);
  }
  return found;
}

/** Files `<stem>.<ext>` for the extensions, by exact stem, from the file list. */
function stemMatches(list: Candidates, stem: string, exts: readonly string[]): string[] {
  const table = names(list).files;
  const found: string[] = [];
  for (const ext of exts) for (const index of table.get(`${stem.toLowerCase()}.${ext}`) ?? []) {
    const file = list.paths[index]!;
    if (file.slice(file.lastIndexOf('/') + 1, file.lastIndexOf('.')) === stem) found.push(file);
  }
  return found;
}

/** One request's view of a project: its file list, and reads that never leave it. */
export class CodeNav {
  private readonly allowed = new Map<string, Promise<boolean>>();
  private listing?: Promise<Candidates | undefined>;

  /** `signal` ends the request's scans, for a client that went away. */
  /** `symbols` is the project's declaration index, when there is one: it narrows definitions and references once it is ready. */
  constructor(readonly root: string, private readonly paths: () => Promise<Candidates | undefined>, readonly signal?: AbortSignal, readonly symbols?: SymbolLookup) {}

  list(): Promise<Candidates | undefined> { return this.listing ??= this.paths().catch(() => undefined); }

  /** Whether a project-relative path stays inside the project, symlinks resolved. */
  ok(file: string): Promise<boolean> {
    let found = this.allowed.get(file);
    if (!found) {
      found = !file || file.startsWith('/') || file.split('/').includes('..') ? Promise.resolve(false) : resolveScopedPath(this.root, file).then(() => true, () => false);
      this.allowed.set(file, found);
    }
    return found;
  }

  async text(file: string): Promise<string | undefined> {
    if (!(await this.ok(file))) return undefined;
    try {
      const absolute = path.join(this.root, file);
      const info = await stat(absolute);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
      const data = await readFile(absolute);
      return data.subarray(0, 8000).includes(0) ? undefined : data.toString('utf8');
    } catch { return undefined; }
  }

  async isFile(file: string): Promise<boolean> {
    try { return (await this.ok(file)) && (await stat(path.join(this.root, file))).isFile(); } catch { return false; }
  }

  /** The regular files directly in a directory, project-relative. */
  async files(dir: string): Promise<string[]> {
    try {
      return (await readdir(path.join(this.root, dir), { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => (dir ? `${dir}/${entry.name}` : entry.name)).sort();
    } catch { return []; }
  }
}

// ── ripgrep ──────────────────────────────────────────────────────────────────

const ripgrep = (): string | undefined => {
  const resolution = resolveCliExecutable({ command: 'rg' });
  return resolution.resolved ? resolution.executable : undefined;
};

interface Scan { hits: CodeLocation[]; complete: boolean }

/**
 * ripgrep over `base` (a project-relative directory, '' for the project) with `pattern` args; each line
 * goes through `accept`, which may turn it into a location. Stops at `limit` accepted lines or the
 * budget, and says so in `complete`. `undefined` when ripgrep is not installed.
 */
function ripgrepScan(root: string, base: string, patternArgs: string[], globs: string[], accept: (file: string, line: number, text: string) => CodeLocation | undefined, limit: number, budgetMs: number, signal?: AbortSignal): Promise<Scan | undefined> {
  const rg = ripgrep();
  if (!rg) return Promise.resolve(undefined);
  if (signal?.aborted) return Promise.resolve({ hits: [], complete: false });
  return new Promise((resolve) => {
    const hits: CodeLocation[] = [];
    const child = spawn(rg, [
      '--no-config', '--null', '--line-number', '--no-heading', '--color', 'never', '--case-sensitive', '--max-filesize', '2M', '--max-columns', '1000', '--max-columns-preview',
      '--hidden', '--glob', '!.git', '--no-messages', ...globs.flatMap(glob => ['--glob', glob]), ...patternArgs, '--', base || '.',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    let done = false;
    const stop = () => finish(false);
    const finish = (complete: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      child.kill('SIGTERM');
      resolve({ hits, complete });
    };
    const timer = setTimeout(stop, budgetMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while (!done && (end = buffer.indexOf('\n')) >= 0) {
        const entry = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const nul = entry.indexOf('\0');
        const colon = entry.indexOf(':', nul + 1);
        if (nul < 0 || colon < 0) continue;
        const file = entry.slice(0, nul).replace(/^\.\//, '');
        const hit = accept(file, Number(entry.slice(nul + 1, colon)), entry.slice(colon + 1));
        if (hit) hits.push(hit);
        if (hits.length >= limit) finish(false);
      }
    });
    child.on('close', () => finish(true));
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(undefined); } });
  });
}

const globsOf = (family: Family | undefined) => (family ? EXTENSIONS[family].exts.map(ext => `*.${ext}`) : []);

// ── Definitions ──────────────────────────────────────────────────────────────

/** Without `column` the first whole-word occurrence of `word` on `line` is used. */
export interface DefinitionQuery { path: string; line: number; column?: number; word: string }
export interface ReferenceQuery { path: string; word: string; scope: 'module' | 'project' }

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function symbol(word: unknown): string {
  if (typeof word !== 'string' || word.length > 200 || !IDENTIFIER.test(word)) throw new AppError('INVALID_SYMBOL', 'Symbol must be an identifier of at most 200 characters');
  return word;
}
function position(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new AppError('INVALID_POSITION', `${name} must be a positive integer`);
  return value;
}
async function projectFile(nav: CodeNav, input: string): Promise<string> {
  return toProjectRelative(nav.root, await resolveScopedPath(nav.root, input));
}

/** Locations deduplicated by line, inside the project, best first. */
async function pack(nav: CodeNav, found: CodeLocation[]): Promise<CodeDefinitions> {
  const seen = new Set<string>();
  const locations: CodeLocation[] = [];
  for (const location of found) {
    const key = `${location.path}:${location.line}`;
    if (seen.has(key) || !(await nav.ok(location.path))) continue;
    seen.add(key);
    locations.push(location);
    if (locations.length >= MAX_DEFINITIONS) break;
  }
  return { locations };
}

export async function findDefinitions(nav: CodeNav, query: DefinitionQuery): Promise<CodeDefinitions> {
  const word = symbol(query.word);
  const line = position(query.line, 'line');
  const file = await projectFile(nav, query.path);
  const text = await nav.text(file);
  if (text === undefined) throw new AppError('FILE_NOT_FOUND', 'File does not exist or cannot be read', 404);
  let column: number;
  if (query.column === undefined) {
    const at = wordRegex(word).exec(text.split('\n')[line - 1] ?? '');
    if (!at) throw new AppError('WORD_NOT_ON_LINE', `\`${word}\` does not occur on line ${line} of ${query.path}`, 404);
    column = at.index + 1;
  } else column = position(query.column, 'column');
  const ext = extOf(file);
  const group = GROUP_OF.get(ext) ?? 'generic';
  const family = FAMILY_OF.get(ext);

  const source = text.split('\n')[line - 1] ?? '';
  const before = source.slice(0, column - 1);

  // 0. `R.string.name` in code, `@string/name` in a layout: an Android resource, found by name in the resource index.
  const reference = RESOURCE_FILE.has(ext) ? resourceReference(before, source.slice(column - 1 + word.length), word) : undefined;
  if (reference) {
    if (reference === 'system') return { locations: [] };
    const defined = await indexedResources(nav, file, reference);
    if (defined) return pack(nav, defined);
  }

  // 1. The file itself. A name after a dot is a member of something else, so what is nearest above does not shadow it.
  const own = declarationsOf(text, file, matcher(group, word)).map(item => item.location);
  // `user.name` names a member of something else; `this.name` one of this file's classes.
  const member = /\.\s*$/.test(before) && !/\b(?:this|self|super)\s*\??\.\s*$/.test(before);
  const here = own.filter(item => item.line === line);
  const others = own.filter(item => item.line !== line);
  const above = member ? [] : others.filter(item => item.line <= line).reverse().slice(0, 1);
  const ownRanked = [...above, ...others.filter(item => !above.includes(item)), ...here];
  if (own.length && !member) return pack(nav, ownRanked);
  // A member's own-file matches come after what the imports and the neighbourhood find, and stand in
  // for them when those find nothing, before any scan.
  if (!family) return pack(nav, ownRanked);

  // 2. Where the file says it comes from.
  const imported = family === 'jvm' ? await jvmDefinitions(nav, file, text, word)
    : family === 'ts' ? await tsDefinitions(nav, file, text, word)
      : family === 'python' ? await pythonDefinitions(nav, file, text, word) : [];
  if (imported.length) return pack(nav, [...imported, ...ownRanked]);
  if (family !== 'jvm' && isCapitalised(word)) {
    const list = await nav.list();
    const byName = list ? stemMatches(list, word, EXTENSIONS[family].exts).filter(item => item !== file).sort(nearest(file)).slice(0, 8) : [];
    const named = await locate(nav, byName, word, true);
    if (named.length) return pack(nav, named);
  }

  // 3. The neighbourhood: what the file imports, then its directory. Overrides alone only restate a
  // declaration made elsewhere, so the search goes on for it and keeps them in case it finds none.
  const near = await neighbourhood(nav, file, text, family, word);
  if (near.some(item => !overrides(item))) return pack(nav, [...near, ...ownRanked]);
  if (ownRanked.length) return pack(nav, [...ownRanked, ...near]);
  const restated = [...near];

  // 4a. The declaration index, once built, answers by name without a scan. It holds every tracked Kotlin and
  // Java file the scan below would read, so a name it does not know is declared outside the project (a
  // library class): the scan would spend its whole budget finding nothing.
  // Files changed since the index last looked are read for the name too; when git cannot say which, the index does not get to say "none".
  const changed = family === 'jvm' ? await nav.symbols?.changedSince(nav.root) : undefined;
  if (changed) {
    const indexed = await indexedDefinitions(nav, file, word, restated, changed);
    if (indexed?.length) return pack(nav, [...indexed, ...restated]);
    if (indexed) return pack(nav, restated);
  }

  // 4b. The module, then the whole project.
  const deadline = Date.now() + DEFINITION_SCAN_MS;
  const patterns = EXTENSIONS[family].groups.flatMap(name => RULES[name].map(rule => rule.re.replaceAll(NAME, () => namePattern(matcher(name, word).bare))));
  const accept = (hit: string, number: number, line: string): CodeLocation | undefined => {
    if (hit === file || (restated.length && overrides({ path: hit, line: number, column: 1, text: line }))) return undefined;
    const m = matcher(groupOf(hit), word);
    if (line.length > MAX_LINE_LENGTH || m.comment.test(line) || !m.rules.some(rule => rule.re.test(line) && !rule.reject?.test(line))) return undefined;
    return { path: hit, line: number, column: (m.column.exec(line)?.index ?? 0) + 1, text: clip(line) };
  };
  const moduleDir = await moduleDirectory(nav, file);
  for (const base of moduleDir ? [moduleDir, ''] : ['']) {
    if (nav.signal?.aborted) break;
    const scan = await ripgrepScan(nav.root, base, patterns.flatMap(pattern => ['-e', pattern]), globsOf(family), accept, 50, Math.max(1000, deadline - Date.now()), nav.signal);
    const hits = (scan?.hits ?? []).sort((a, b) => overrides(a) - overrides(b) || nearest(file)(a.path, b.path) || a.line - b.line);
    if (hits.some(item => !overrides(item))) return pack(nav, [...hits, ...restated]);
    if (hits.length && !restated.length) restated.push(...hits);
  }
  return pack(nav, restated);
}

// ── Android resources ────────────────────────────────────────────────────────

/** What `worker#resourcesOf` would find for `type` / `name` in these files, line by line and good enough for the few files a working tree has changed. */
async function freshResources(nav: CodeNav, files: readonly string[], type: string, name: string): Promise<Array<{ path: string; line: number }>> {
  const found: Array<{ path: string; line: number }> = [];
  for (const item of files) {
    const m = RESOURCE_PATH.exec(item)!;
    const directory = m[1]!.split('-')[0]!;
    if (directory !== 'values' && directory === type && m[2]!.split('.')[0] === name && await nav.isFile(item)) found.push({ path: item, line: 1 });
    if (!m[2]!.endsWith('.xml')) continue;
    const lines = (await nav.text(item))?.split('\n') ?? [];
    const at = lines.findIndex((line) => {
      if (type === 'id' && [...line.matchAll(/@\+id\/([\w.]+)/g)].some(hit => hit[1]!.replace(/[.:]/g, '_') === name)) return true;
      const tag = directory === 'values' ? /<([\w-]+)\b[^>]*?\bname\s*=\s*"([^"]*)"/.exec(line) : null;
      return Boolean(tag && tag[2]!.replace(/[.:]/g, '_') === name && (tag[1] === 'item' ? /\btype\s*=\s*"([\w-]+)"/.exec(line)?.[1] : VALUE_TYPES[tag[1]!]) === type);
    });
    if (at >= 0) found.push({ path: item, line: at + 1 });
  }
  return found;
}

/** `undefined` while the index cannot tell (not ready, or it has no such resource: a library's, or not Android code), so the ordinary search goes on. */
async function indexedResources(nav: CodeNav, file: string, { type, name }: ResourceReference): Promise<CodeLocation[] | undefined> {
  const indexedRows = nav.symbols?.resources(nav.root, type, name);
  const changed = indexedRows ? await nav.symbols?.changedSince(nav.root) : undefined;
  if (!indexedRows || !changed) return undefined;
  // Resource files changed since the index last looked: their rows are replaced by what the files say now.
  const fresh = changed.filter(item => RESOURCE_PATH.test(item));
  const stale = new Set(fresh);
  const rows = [...indexedRows.filter(row => !stale.has(row.path)), ...await freshResources(nav, fresh, type, name)];
  if (!rows.length) return undefined;
  // The default directory (`values`, `layout`) before its qualified variants (`values-night`), then the nearest.
  const qualified = (item: { path: string }) => Number(dirOf(item.path).split('/').pop()!.includes('-'));
  const order = nearest(file);
  const found: CodeLocation[] = [];
  for (const row of rows.sort((a, b) => qualified(a) - qualified(b) || order(a.path, b.path) || a.line - b.line).slice(0, MAX_DEFINITIONS)) {
    const lineText = row.path.endsWith('.xml') ? (await nav.text(row.path))?.split('\n')[row.line - 1] ?? '' : '';
    found.push({ path: row.path, line: row.line, column: Math.max(1, lineText.indexOf(name.split('_')[0]!) + 1), text: clip(lineText) });
  }
  return found;
}

/** Declarations of `word` the index knows, nearest to `file` first, overrides after the declaration they restate; `undefined` while there is no ready index. */
async function indexedDefinitions(nav: CodeNav, file: string, word: string, restated: CodeLocation[], changed: readonly string[]): Promise<CodeLocation[] | undefined> {
  const found = nav.symbols?.declarations(nav.root, word);
  if (!found) return undefined;
  // What the index holds for a changed file is out of date: its declarations are read from the file instead.
  const fresh = changed.filter(item => item !== file && FAMILY_OF.get(extOf(item)) === 'jvm');
  const stale = new Set(fresh);
  const order = nearest(file);
  const rows = found.filter(row => row.path !== file && !stale.has(row.path)).sort((a, b) => order(a.path, b.path) || a.line - b.line).slice(0, MAX_DEFINITIONS * 2);
  const locations: CodeLocation[] = [];
  const read = await pool(fresh, READ_CONCURRENCY, async (item) => {
    const content = await nav.text(item);
    return content?.includes(word) ? declarationsOf(content, item, matcher(groupOf(item), word)).map(entry => entry.location) : [];
  });
  locations.push(...read.flat().sort((a, b) => order(a.path, b.path) || a.line - b.line));
  for (const row of rows) {
    const line = (await nav.text(row.path))?.split('\n')[row.line - 1];
    if (line === undefined) continue;
    locations.push({ path: row.path, line: row.line, column: row.column, text: clip(line) });
  }
  const own = locations.filter(item => !overrides(item));
  // Overrides alone only restate a declaration made elsewhere: keep them for when nothing better turns up.
  if (!own.length) { if (!restated.length) restated.push(...locations); return []; }
  return [...own, ...locations.filter(overrides)];
}

/** An override restates a declaration made elsewhere: it comes after the declaration itself. */
const overrides = (location: CodeLocation) => Number(/\boverride\b|@Override\b/.test(location.text));

/** Declarations of `word` in each file; a file with none counts as its first line when `fallback` (the file is the class). */
async function locate(nav: CodeNav, files: readonly string[], word: string, fallback: boolean, max = 8): Promise<CodeLocation[]> {
  const found: CodeLocation[] = [];
  for (const file of files.slice(0, max)) {
    const text = await nav.text(file);
    if (text === undefined) continue;
    const here = declarationsOf(text, file, matcher(groupOf(file), word)).sort((a, b) => a.rule - b.rule || a.location.line - b.location.line).slice(0, 5);
    if (here.length) found.push(...here.map(item => item.location));
    else if (fallback) found.push({ path: file, line: 1, column: 1, text: clip(text.slice(0, text.indexOf('\n') < 0 ? MAX_TEXT : text.indexOf('\n'))) });
  }
  return found;
}

// ── Kotlin and Java ──────────────────────────────────────────────────────────

export interface JvmImport { fqn: string; star: boolean; alias?: string }

export function parseJvmImports(text: string): JvmImport[] {
  const found: JvmImport[] = [];
  for (const m of text.matchAll(/^[ \t]*import[ \t]+(?:static[ \t]+)?([\w$.]+?)(\.\*)?(?:[ \t]+as[ \t]+([\w$]+))?[ \t]*;?[ \t]*(?:\/\/.*)?$/gm)) found.push({ fqn: m[1]!, star: Boolean(m[2]), ...(m[3] ? { alias: m[3] } : {}) });
  return found;
}

const tail = (fqn: string) => fqn.slice(fqn.lastIndexOf('.') + 1);

/** The files for class `stem` of package `pkg`: by the directory convention, else by the package line of same-named files. */
async function classFiles(nav: CodeNav, from: string, pkg: string, stem: string, loose = true): Promise<string[]> {
  const list = await nav.list();
  if (!list) return [];
  const candidates = stemMatches(list, stem, EXTENSIONS.jvm.exts);
  if (!candidates.length) return [];
  const directory = pkg.replace(/\./g, '/');
  const strict = pkg ? candidates.filter(file => { const dir = dirOf(file); return dir === directory || dir.endsWith(`/${directory}`); }) : candidates;
  if (strict.length || !loose) return strict.sort(nearest(from));
  const declared = new RegExp(`^\\s*package\\s+${pkg.replace(/\./g, '\\.')}\\b`, 'm');
  const found: string[] = [];
  for (const file of candidates.slice(0, 12)) if (declared.test((await nav.text(file))?.slice(0, 4000) ?? '')) found.push(file);
  return found.sort(nearest(from));
}

/** Files in the directories that hold package `pkg`, for what is declared at the top level of a package rather than in a class of its own. */
async function packageFiles(nav: CodeNav, pkg: string): Promise<string[]> {
  const list = await nav.list();
  if (!list || !pkg) return [];
  const directory = pkg.replace(/\./g, '/');
  const dirs = (names(list).dirs.get(tail(pkg).toLowerCase()) ?? []).map(index => list.paths[index]!).filter(dir => dir === directory || dir.endsWith(`/${directory}`)).slice(0, 6);
  const files = (await Promise.all(dirs.map(dir => nav.files(dir)))).flat();
  return files.filter(file => EXTENSIONS.jvm.exts.includes(extOf(file))).slice(0, 300);
}

/** An imported name: its class, or a member of the class it is imported from, or a top-level declaration of its package. */
async function jvmResolve(nav: CodeNav, from: string, fqn: string): Promise<CodeLocation[]> {
  const segments = fqn.split('.');
  const name = segments.at(-1)!;
  for (let k = segments.length; k >= 1; k--) {
    const segment = segments[k - 1]!;
    if (!isCapitalised(segment)) continue;
    const files = await classFiles(nav, from, segments.slice(0, k - 1).join('.'), segment);
    const found = files.length ? await locate(nav, files, name, k === segments.length) : [];
    if (found.length) return found;
  }
  return locate(nav, await packageFiles(nav, segments.slice(0, -1).join('.')), name, false, 300);
}

async function jvmDefinitions(nav: CodeNav, file: string, text: string, word: string): Promise<CodeLocation[]> {
  const imports = parseJvmImports(text);
  for (const item of imports) {
    if (item.star || (item.alias ?? tail(item.fqn)) !== word) continue;
    const found = await jvmResolve(nav, file, item.fqn);
    if (found.length) return found;
  }
  const list = await nav.list();
  if (isCapitalised(word)) {
    const named = list ? stemMatches(list, word, EXTENSIONS.jvm.exts).filter(item => item !== file) : [];
    const samePackage = await locate(nav, named.filter(item => dirOf(item) === dirOf(file)), word, true);
    if (samePackage.length) return samePackage;
  }
  // `import a.b.*` is a package, or a class whose members (`import a.b.C.*`) are meant.
  for (const item of imports.filter(candidate => candidate.star).slice(0, 30)) {
    const last = tail(item.fqn);
    const found = isCapitalised(last)
      ? await locate(nav, await classFiles(nav, file, item.fqn.slice(0, Math.max(0, item.fqn.length - last.length - 1)), last), word, false)
      : isCapitalised(word) ? await locate(nav, await classFiles(nav, file, item.fqn, word), word, true) : [];
    if (found.length) return found;
  }
  if (isCapitalised(word) && list) {
    const anywhere = stemMatches(list, word, EXTENSIONS.jvm.exts).filter(item => item !== file).sort(nearest(file));
    return locate(nav, anywhere, word, true);
  }
  return [];
}

// ── TypeScript and JavaScript ────────────────────────────────────────────────

export interface TsBinding { local: string; imported: string; spec: string; reexport: boolean }

/** What a module imports, and what it re-exports from elsewhere (`export { a as b } from`, `export * from`). */
export function parseTsImports(text: string): { bindings: TsBinding[]; stars: string[] } {
  const head = text.slice(0, 200_000);
  const bindings: TsBinding[] = [];
  const stars: string[] = [];
  const collect = (clause: string, spec: string, reexport: boolean) => {
    const braces = /\{([^}]*)\}/.exec(clause);
    const rest = clause.replace(/\{[^}]*\}/, '').trim();
    const namespace = /\*\s+as\s+([\w$]+)/.exec(rest);
    if (namespace) bindings.push({ local: namespace[1]!, imported: '*', spec, reexport });
    else if (!reexport) { const fallback = /^([\w$]+)\s*,?$/.exec(rest.replace(/^type\s+(?=[\w$]+\s*,?$)/, '')); if (fallback) bindings.push({ local: fallback[1]!, imported: 'default', spec, reexport }); }
    for (const piece of braces?.[1]?.split(',') ?? []) {
      const m = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(piece.trim());
      if (m) bindings.push({ local: m[2] ?? m[1]!, imported: m[1]!, spec, reexport });
    }
  };
  for (const m of head.matchAll(/\bimport\s+(?:type\s+)?([\w$*\s,{}]+?)\s*from\s*(['"])([^'"\n]+)\2/g)) collect(m[1]!, m[3]!, false);
  for (const m of head.matchAll(/\bexport\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g)) {
    if (m[1] === '*') stars.push(m[3]!); else collect(m[1]!, m[3]!, true);
  }
  return { bindings, stars };
}

const TS_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];

/** A relative module specifier as the file it names; packages and path aliases are not resolved. */
async function resolveTsSpec(nav: CodeNav, from: string, spec: string): Promise<string | undefined> {
  if (!spec.startsWith('.')) return undefined;
  const base = path.posix.join(dirOf(from), spec);
  if (base.startsWith('..')) return undefined;
  const candidates: string[] = [];
  const emitted = /\.(?:js|jsx|mjs|cjs)$/.exec(base);
  // TypeScript's ESM imports name the emitted `.js` file; the source is the `.ts` beside it.
  if (emitted) for (const ext of ['ts', 'tsx', 'mts', 'cts']) candidates.push(`${base.slice(0, -emitted[0].length)}.${ext}`);
  candidates.push(base, ...TS_EXTENSIONS.map(ext => `${base}.${ext}`), ...TS_EXTENSIONS.map(ext => `${base}/index.${ext}`));
  for (const candidate of candidates) if (await nav.isFile(candidate)) return candidate;
  return undefined;
}

async function tsExport(nav: CodeNav, file: string, name: string, depth: number): Promise<CodeLocation[]> {
  const text = await nav.text(file);
  if (text === undefined) return [];
  let found: CodeLocation[];
  if (name === 'default') {
    found = [];
    text.split('\n').forEach((line, index) => { if (/^\s*export\s+default\b/.test(line)) found.push({ path: file, line: index + 1, column: 1, text: clip(line) }); });
  } else {
    found = declarationsOf(text, file, matcher('ts', name)).sort((a, b) => Number(!/^\s*export\b/.test(a.location.text)) - Number(!/^\s*export\b/.test(b.location.text)) || a.rule - b.rule || a.location.line - b.location.line).map(item => item.location);
  }
  if (found.length || depth > 0) return found.slice(0, 3);
  // One level of re-exports.
  const { bindings, stars } = parseTsImports(text);
  for (const binding of bindings) {
    if (!binding.reexport || binding.local !== name) continue;
    const next = await resolveTsSpec(nav, file, binding.spec);
    const hit = next ? await tsExport(nav, next, binding.imported, depth + 1) : [];
    if (hit.length) return hit;
  }
  for (const spec of stars.slice(0, 5)) {
    const next = await resolveTsSpec(nav, file, spec);
    const hit = next ? await tsExport(nav, next, name, depth + 1) : [];
    if (hit.length) return hit;
  }
  return [];
}

async function tsDefinitions(nav: CodeNav, file: string, text: string, word: string): Promise<CodeLocation[]> {
  for (const binding of parseTsImports(text).bindings) {
    if (binding.local !== word || binding.reexport) continue;
    const resolved = await resolveTsSpec(nav, file, binding.spec);
    if (!resolved) continue;
    if (binding.imported === '*') return [{ path: resolved, line: 1, column: 1, text: '' }];
    const found = await tsExport(nav, resolved, binding.imported, 0);
    if (found.length) return found;
  }
  return [];
}

// ── Python ───────────────────────────────────────────────────────────────────

interface PyImport { dots: number; module: string; names: Array<{ name: string; local: string }> }

function parsePythonImports(text: string): PyImport[] {
  const found: PyImport[] = [];
  const entry = (piece: string) => { const m = /^([\w$.]+)(?:\s+as\s+([\w$]+))?$/.exec(piece.trim()); return m ? { name: m[1]!, local: m[2] ?? m[1]! } : undefined; };
  for (const m of text.slice(0, 200_000).matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm)) {
    const list = m[3]!.replace(/[()]/g, '').replace(/#[^\n]*/g, '');
    found.push({ dots: m[1]!.length, module: m[2]!, names: list.split(',').map(entry).filter((item): item is { name: string; local: string } => Boolean(item)) });
  }
  for (const m of text.slice(0, 200_000).matchAll(/^[ \t]*import[ \t]+([^\n]+)/gm)) {
    for (const piece of m[1]!.replace(/#.*/, '').split(',')) {
      const item = entry(piece);
      // `import a.b` binds `a`; `import a.b as c` binds `c` to the module a.b.
      if (item) found.push({ dots: 0, module: item.local === item.name ? item.name.split('.')[0]! : item.name, names: [{ name: '', local: item.local === item.name ? item.name.split('.')[0]! : item.local }] });
    }
  }
  return found;
}

/** A module as the file that holds it: `a/b.py` or `a/b/__init__.py`, beside the file for a relative import, else anywhere in the project. */
async function pythonModule(nav: CodeNav, from: string, dots: number, module: string): Promise<string[]> {
  const relative = module.replace(/\./g, '/');
  if (dots) {
    let dir = dirOf(from);
    for (let up = 1; up < dots; up++) dir = dirOf(dir);
    const base = path.posix.join(dir, relative);
    return (await Promise.all([`${base}.py`, `${base}/__init__.py`].map(async file => ((await nav.isFile(file)) ? file : undefined)))).filter((file): file is string => Boolean(file));
  }
  const list = await nav.list();
  if (!list || !relative) return [];
  const table = names(list).files;
  const last = relative.slice(relative.lastIndexOf('/') + 1).toLowerCase();
  const paths = [...(table.get(`${last}.py`) ?? []), ...(table.get('__init__.py') ?? [])].map(index => list.paths[index]!);
  return paths.filter(file => file === `${relative}.py` || file.endsWith(`/${relative}.py`) || file === `${relative}/__init__.py` || file.endsWith(`/${relative}/__init__.py`)).sort(nearest(from)).slice(0, 6);
}

async function pythonDefinitions(nav: CodeNav, file: string, text: string, word: string): Promise<CodeLocation[]> {
  for (const item of parsePythonImports(text)) {
    for (const { name, local } of item.names) {
      if (local !== word) continue;
      const modules = await pythonModule(nav, file, item.dots, item.module);
      const found = name ? await locate(nav, modules, name, false) : [];
      if (found.length) return found;
      // `from a import b` where b is a module of the package a; `import a.b as c`.
      const submodule = await pythonModule(nav, file, item.dots, name ? `${item.module}${item.module ? '.' : ''}${name}` : item.module);
      if (submodule.length) return submodule.slice(0, 3).map(module => ({ path: module, line: 1, column: 1, text: '' }));
    }
  }
  return [];
}

// ── Neighbourhood ────────────────────────────────────────────────────────────

/** The files a file imports, in the project. */
async function importedFiles(nav: CodeNav, file: string, text: string, family: Family): Promise<string[]> {
  const found = new Set<string>();
  if (family === 'jvm') {
    for (const item of parseJvmImports(text).filter(candidate => !candidate.star).slice(0, 400)) {
      const segments = item.fqn.split('.');
      for (let k = segments.length; k >= 1; k--) {
        if (!isCapitalised(segments[k - 1]!)) continue;
        const files = await classFiles(nav, file, segments.slice(0, k - 1).join('.'), segments[k - 1]!, false);
        if (files.length) { found.add(files[0]!); break; }
      }
      if (found.size >= NEIGHBOUR_IMPORTS) break;
    }
  } else if (family === 'ts') {
    const { bindings, stars } = parseTsImports(text);
    for (const spec of new Set([...bindings.map(item => item.spec), ...stars])) {
      const target = await resolveTsSpec(nav, file, spec);
      if (target) found.add(target);
      if (found.size >= NEIGHBOUR_IMPORTS) break;
    }
  } else if (family === 'python') {
    for (const item of parsePythonImports(text).slice(0, 100)) for (const target of await pythonModule(nav, file, item.dots, item.module)) found.add(target);
  }
  found.delete(file);
  return [...found];
}

async function neighbourhood(nav: CodeNav, file: string, text: string, family: Family, word: string): Promise<CodeLocation[]> {
  const imported = await importedFiles(nav, file, text, family);
  const exts = new Set(EXTENSIONS[family].exts);
  const known = new Set(imported);
  const siblings = (await nav.files(dirOf(file))).filter(item => item !== file && !known.has(item) && exts.has(extOf(item))).slice(0, NEIGHBOUR_SIBLINGS);
  const found = await pool([...imported, ...siblings], READ_CONCURRENCY, async (other) => {
    const content = await nav.text(other);
    return content === undefined ? [] : declarationsOf(content, other, matcher(groupOf(other), word)).sort((a, b) => a.rule - b.rule || a.location.line - b.location.line).slice(0, 5).map(item => item.location);
  });
  // What the file imports is where a member it calls most likely lives, before its neighbours.
  const rank = (location: CodeLocation) => (known.has(location.path) ? 0 : 1);
  return found.flat().sort((a, b) => overrides(a) - overrides(b) || rank(a) - rank(b) || nearest(file)(a.path, b.path) || a.line - b.line);
}

// ── References ───────────────────────────────────────────────────────────────

/** The nearest directory above `file` that is a module of its build system, else the file's own directory. */
async function moduleDirectory(nav: CodeNav, file: string): Promise<string> {
  const start = dirOf(file);
  for (let dir = start; ; dir = dirOf(dir)) {
    const entries = await readdir(path.join(nav.root, dir)).catch(() => [] as string[]);
    if (entries.some(isModuleMarker)) return dir;
    if (!dir) return start;
  }
}

/** Without ripgrep: the module's files from the project's list, read in a bounded number and time. */
async function listedScan(nav: CodeNav, base: string, family: Family | undefined, accept: (file: string, line: number, text: string) => CodeLocation | undefined, limit: number, budgetMs: number): Promise<Scan | undefined> {
  const list = await nav.list();
  if (!list) return undefined;
  const exts = family ? new Set(EXTENSIONS[family].exts) : undefined;
  const files = list.paths.slice(0, list.dirStart).filter(item => (!base || item.startsWith(`${base}/`)) && (!exts || exts.has(extOf(item))));
  const deadline = Date.now() + budgetMs;
  const hits: CodeLocation[] = [];
  let complete = files.length <= 5000;
  await pool(files.slice(0, 5000), READ_CONCURRENCY, async (item) => {
    if (hits.length >= limit || Date.now() > deadline) { complete = false; return; }
    const content = await nav.text(item);
    content?.split('\n').forEach((line, index) => { const hit = hits.length < limit && line.length <= MAX_LINE_LENGTH ? accept(item, index + 1, line) : undefined; if (hit) hits.push(hit); });
  });
  return { hits, complete: complete && hits.length < limit };
}

/**
 * Members, constants and any other name: the files the word index says contain the word, read for it. The
 * index is a superset by construction (comments and strings count, words of changed files are only added), so
 * the lines found are the ones the project-wide scan finds in the files the index knows. `undefined` when the
 * index cannot narrow: not ready, the word too short or a keyword, or more candidates than `referenceFiles`.
 */
async function indexedWordScan(nav: CodeNav, file: string, word: string, within: string, changed: readonly string[], accept: (file: string, line: number, text: string) => CodeLocation | undefined, limit: number, deadline: number): Promise<Scan | undefined> {
  const files = nav.symbols?.wordFiles(nav.root, word, within);
  if (!files) return undefined;
  const all = new Set(files);
  for (const item of changed) if (FAMILY_OF.get(extOf(item)) === 'jvm' && (!within || item.startsWith(`${within}/`))) all.add(item);
  all.delete(file);
  return readCandidates(nav, [...all].sort(nearest(file)), word, accept, limit, deadline);
}

async function readCandidates(nav: CodeNav, inside: readonly string[], word: string, accept: (file: string, line: number, text: string) => CodeLocation | undefined, limit: number, deadline: number): Promise<Scan> {
  const hits: CodeLocation[] = [];
  let complete = true;
  await pool(inside, READ_CONCURRENCY, async (item) => {
    if (nav.signal?.aborted || hits.length >= limit || Date.now() > deadline) { complete = false; return; }
    const content = await nav.text(item);
    if (!content?.includes(word)) return;
    content.split('\n').forEach((line, index) => { const hit = hits.length < limit && line.length <= MAX_LINE_LENGTH ? accept(item, index + 1, line) : undefined; if (hit) hits.push(hit); });
  });
  return { hits, complete: complete && hits.length < limit };
}

export async function findReferences(nav: CodeNav, query: ReferenceQuery): Promise<CodeReferences> {
  const word = symbol(query.word);
  if (query.scope !== 'module' && query.scope !== 'project') throw new AppError('INVALID_SCOPE', 'Scope must be module or project');
  const file = await projectFile(nav, query.path);
  const family = FAMILY_OF.get(extOf(file));
  const pattern = wordRegex(word);
  const accept = (hit: string, number: number, line: string): CodeLocation | undefined => {
    const m = pattern.exec(line);
    return m ? { path: hit, line: number, column: m.index + 1, text: clip(line) } : undefined;
  };
  const found = new Map<string, CodeLocation>();
  const add = (location: CodeLocation) => { const key = `${location.path}:${location.line}`; if (!found.has(key) && found.size < MAX_REFERENCES) found.set(key, location); };
  // The file under the cursor always makes the list, whatever ripgrep reaches first.
  (await nav.text(file))?.split('\n').forEach((line, index) => { const hit = line.length <= MAX_LINE_LENGTH ? accept(file, index + 1, line) : undefined; if (hit) add(hit); });

  const moduleDir = await moduleDirectory(nav, file);
  const deadline = Date.now() + (query.scope === 'module' ? MODULE_BUDGET_MS : PROJECT_BUDGET_MS);
  const bases = query.scope === 'module' ? [moduleDir] : moduleDir ? [moduleDir, ''] : [''];
  let complete = true;
  // A name can only be used in files that contain it: read those the word index names, not the project. Types too: narrowing by
  // imports misses `Outer.Inner` through `import Outer` and fully qualified uses.
  const within = query.scope === 'module' ? moduleDir : '';
  // The index is as of its last check: files changed since are read too, and without a list of them (no git, too many) it is not used.
  const changed = family === 'jvm' ? await nav.symbols?.changedSince(nav.root) : undefined;
  const narrowed = changed
    ? await indexedWordScan(nav, file, word, within, changed, accept, MAX_REFERENCES + found.size, deadline)
    : undefined;
  if (narrowed) { narrowed.hits.forEach(add); complete = narrowed.complete && found.size < MAX_REFERENCES; }
  else for (const base of bases) {
    const budget = deadline - Date.now();
    if (budget <= 0) { complete = false; break; }
    const limit = MAX_REFERENCES + found.size;
    const scan = await ripgrepScan(nav.root, base, ['--fixed-strings', '--word-regexp', '-e', word], globsOf(family), accept, limit, budget, nav.signal)
      ?? await listedScan(nav, base, family, accept, limit, budget);
    if (!scan) { complete = false; break; }
    scan.hits.forEach(add);
    if (!scan.complete) complete = false;
    if (found.size >= MAX_REFERENCES) { complete = false; break; }
  }

  const everything = [...found.values()];
  const allowed = new Set<string>();
  await pool([...new Set(everything.map(item => item.path))], 32, async (item) => { if (await nav.ok(item)) allowed.add(item); });
  const order = nearest(file);
  const locations = everything.filter(item => allowed.has(item.path)).sort((a, b) =>
    Number(b.path === file) - Number(a.path === file) || (a.path === b.path ? 0 : order(a.path, b.path)) || a.line - b.line);
  return { locations, complete };
}
