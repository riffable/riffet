/**
 * Lazy, per-line syntax highlighting for the file preview.
 *
 * The preview renders one DOM row per source line (with a sticky line-number
 * gutter), so highlighting is applied line by line. `refractor` (Prism with a
 * hast/virtual-DOM API) lets us split the highlighted tree at newline
 * boundaries while re-opening any token span that crosses a line — a plain
 * HTML string could not be split safely because block comments, template
 * literals and similar tokens contain raw newlines.
 *
 * Nothing here is imported eagerly: the highlighter and every grammar are
 * pulled in with dynamic `import()` on first use, so the initial bundle stays
 * untouched and the preview always has a plain-text fallback.
 */
import type { Syntax } from 'refractor/core';
import { TEXT_CACHE_BYTES } from '@contracts';
import { boundedCache } from './bounded-cache';
import { registerBounded } from './cache-registry';

type RefractorModule = typeof import('refractor/core');
type ToHtmlModule = typeof import('hast-util-to-html');

type HighlightTree = ReturnType<RefractorModule['refractor']['highlight']>;
type HighlightNode = HighlightTree['children'][number];
type HighlightElement = Extract<HighlightNode, { type: 'element' }>;

/** Prism language names, keyed by lower-cased file extension. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  svelte: 'markup',
  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  mdx: 'markdown',
  mdc: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
};

/** Lazy grammar loaders. Each dynamic import becomes its own chunk. */
const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: Syntax }>> = {
  markup: () => import('refractor/markup'),
  css: () => import('refractor/css'),
  less: () => import('refractor/less'),
  javascript: () => import('refractor/javascript'),
  jsx: () => import('refractor/jsx'),
  typescript: () => import('refractor/typescript'),
  tsx: () => import('refractor/tsx'),
  json: () => import('refractor/json'),
  json5: () => import('refractor/json5'),
  yaml: () => import('refractor/yaml'),
  toml: () => import('refractor/toml'),
  ini: () => import('refractor/ini'),
  bash: () => import('refractor/bash'),
  powershell: () => import('refractor/powershell'),
  sql: () => import('refractor/sql'),
  markdown: () => import('refractor/markdown'),
  python: () => import('refractor/python'),
  go: () => import('refractor/go'),
  rust: () => import('refractor/rust'),
  java: () => import('refractor/java'),
  kotlin: () => import('refractor/kotlin'),
  swift: () => import('refractor/swift'),
  c: () => import('refractor/c'),
  cpp: () => import('refractor/cpp'),
  csharp: () => import('refractor/csharp'),
  ruby: () => import('refractor/ruby'),
  php: () => import('refractor/php'),
  dart: () => import('refractor/dart'),
  scala: () => import('refractor/scala'),
  lua: () => import('refractor/lua'),
  r: () => import('refractor/r'),
  perl: () => import('refractor/perl'),
  objectivec: () => import('refractor/objectivec'),
  elixir: () => import('refractor/elixir'),
  erlang: () => import('refractor/erlang'),
  haskell: () => import('refractor/haskell'),
  clojure: () => import('refractor/clojure'),
  graphql: () => import('refractor/graphql'),
  protobuf: () => import('refractor/protobuf'),
  docker: () => import('refractor/docker'),
  makefile: () => import('refractor/makefile'),
  nginx: () => import('refractor/nginx'),
  apacheconf: () => import('refractor/apacheconf'),
  diff: () => import('refractor/diff'),
  regex: () => import('refractor/regex'),
};

/**
 * Prism language names an assistant may write in a fence info string, keyed by what they write.
 *
 * Deliberately separate from `LANGUAGE_BY_EXTENSION`: a fence says `ts`/`sh`/`yml`, a path says
 * `.ts`/`.sh`/`.yml`, and the two vocabularies only mostly overlap. Fence info strings are
 * assistant-authored, so this is a lookup on a frozen object rather than an index into anything
 * that inherits (`constructor`, `__proto__` and friends resolve to nothing here).
 */
const LANGUAGE_BY_FENCE: Record<string, string> = {
  ts: 'typescript', typescript: 'typescript',
  tsx: 'tsx',
  js: 'javascript', javascript: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  json: 'json', jsonc: 'json', json5: 'json5',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', console: 'bash', shellscript: 'bash',
  ps1: 'powershell', powershell: 'powershell',
  py: 'python', python: 'python', python3: 'python',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin', kotlin: 'kotlin',
  swift: 'swift',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp', csharp: 'csharp', 'c#': 'csharp',
  rb: 'ruby', ruby: 'ruby',
  php: 'php',
  dart: 'dart',
  scala: 'scala',
  lua: 'lua',
  r: 'r',
  pl: 'perl', perl: 'perl',
  m: 'objectivec', mm: 'objectivec', objc: 'objectivec', objectivec: 'objectivec',
  ex: 'elixir', exs: 'elixir', elixir: 'elixir',
  erl: 'erlang', erlang: 'erlang',
  hs: 'haskell', haskell: 'haskell',
  clj: 'clojure', cljs: 'clojure', clojure: 'clojure',
  graphql: 'graphql', gql: 'graphql',
  proto: 'protobuf', protobuf: 'protobuf',
  dockerfile: 'docker', docker: 'docker',
  makefile: 'makefile', make: 'makefile', mk: 'makefile',
  nginx: 'nginx', apache: 'apacheconf', apacheconf: 'apacheconf',
  diff: 'diff', patch: 'diff',
  regex: 'regex', regexp: 'regex',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', mdc: 'markdown',
  sql: 'sql',
};

interface Highlighter {
  refractor: RefractorModule['refractor'];
  toHtml: ToHtmlModule['toHtml'];
}

let highlighterPromise: Promise<Highlighter | undefined> | undefined;
/** One in-flight registration per language, so concurrent calls load a grammar once. */
const languagePromises = new Map<string, Promise<boolean>>();

function loadHighlighter(): Promise<Highlighter | undefined> {
  highlighterPromise ??= Promise.all([import('refractor/core'), import('hast-util-to-html')])
    .then(([core, html]) => ({ refractor: core.refractor, toHtml: html.toHtml }))
    .catch(() => undefined);
  return highlighterPromise;
}

async function ensureLanguage(refractor: RefractorModule['refractor'], language: string): Promise<boolean> {
  if (refractor.registered(language)) return true;
  const loader = LANGUAGE_LOADERS[language];
  if (!loader) return false;
  let pending = languagePromises.get(language);
  if (!pending) {
    pending = loader()
      .then((grammar) => {
        // Another caller may have registered it while the import was in flight.
        if (!refractor.registered(language)) refractor.register(grammar.default);
        return true;
      })
      .catch(() => false)
      .finally(() => { languagePromises.delete(language); });
    languagePromises.set(language, pending);
  }
  return pending;
}

/**
 * Split a highlighted hast tree into one node list per source line.
 *
 * Element nodes are re-opened on every line they span, so a token whose text
 * contains a newline (block comment, template literal, multi-line string) keeps
 * balanced markup on each individual line.
 */
function splitLines(root: HighlightTree): HighlightNode[][] {
  const lines: HighlightNode[][] = [[]];
  let current = 0;

  const appendText = (value: string) => {
    const parts = value.split('\n');
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) {
        lines.push([]);
        current += 1;
      }
      const part = parts[index];
      if (part) lines[current].push({ type: 'text', value: part });
    }
  };

  const appendElement = (element: HighlightElement) => {
    const startLine = current;
    const startIndex = lines[startLine].length;
    for (const child of element.children) {
      if (child.type === 'text') appendText(child.value);
      else if (child.type === 'element') appendElement(child);
    }
    // Everything this element contributed on a line is contiguous, so wrap it.
    for (let line = startLine; line <= current; line++) {
      const slice = lines[line].splice(line === startLine ? startIndex : 0);
      if (slice.length) lines[line].push({ ...element, children: slice } as HighlightElement);
    }
  };

  for (const child of root.children) {
    if (child.type === 'text') appendText(child.value);
    else if (child.type === 'element') appendElement(child);
  }
  return lines;
}

/**
 * Resolve a Prism language name from a file path. Extension-based, pure, and
 * free of any dynamic import so it is safe to unit-test in a Node environment.
 */
export function languageForPath(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()];
}

/**
 * Highlight `code` and return one HTML string per source line, in order.
 * Returns `undefined` when no highlighting is available (unknown language,
 * load failure, or any thrown error) so the caller can render plain text.
 */
export async function highlightLines(code: string, language: string | undefined): Promise<string[] | undefined> {
  if (!language) return undefined;
  try {
    const highlighter = await loadHighlighter();
    if (!highlighter) return undefined;
    if (!(await ensureLanguage(highlighter.refractor, language))) return undefined;
    const nodes = splitLines(highlighter.refractor.highlight(code, language));
    return nodes.map((children) => highlighter.toHtml({ type: 'root', children }));
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Prism grammar for a fence info string (` ```ts title="a.ts" `, ` ```bash`).
 *
 * Only the first token is a language — everything after it belongs to a code-block title some
 * other renderer understands — and an unknown token resolves to nothing, which is how a fence
 * marked ```` ```text ```` or ```` ```output ```` keeps its plain-text rendering.
 */
export function languageForFence(info: string): string | undefined {
  const token = info.trim().toLowerCase().split(/[\s:,]/, 1)[0];
  if (!token) return undefined;
  return LANGUAGE_BY_FENCE[token];
}

/**
 * Longest fence highlighted on the main thread; a longer one stays plain monospace. Refractor plus
 * `toHtml` cost about 0.3 ms per KB here (6,000 lines of TypeScript, 650 KB: 200 ms), more on a
 * phone, and the work cannot yield; 100 KB keeps one fence near a frame or two of work.
 */
const HIGHLIGHT_MAX_CHARS = 100_000;

/**
 * Highlight a whole block and return its inner HTML, or `undefined` for the plain-text fallback.
 *
 * The HTML is `hast-util-to-html`'s output over `refractor`'s tree: text nodes are entity-escaped
 * there, so nothing the assistant writes can escape into markup. One string per code block is what
 * a chat fence wants — the per-line variant above exists for the preview's line-numbered gutter.
 */
export async function highlightCode(code: string, language: string | undefined): Promise<string | undefined> {
  if (!language || code.length > HIGHLIGHT_MAX_CHARS) return undefined;
  const cached = cachedHighlight(code, language);
  if (cached !== undefined) return cached;
  try {
    const highlighter = await loadHighlighter();
    if (!highlighter) return undefined;
    if (!(await ensureLanguage(highlighter.refractor, language))) return undefined;
    const html = highlighter.toHtml(highlighter.refractor.highlight(code, language));
    const key = `${language}\u0000${code}`;
    if (!codeCache.has(key)) codeCache.set(key, html);
    return html;
  } catch {
    return undefined;
  }
}

/**
 * Highlighted blocks by `language\0code`. A transcript row the window unmounts and mounts again
 * builds a new fence, and without this it would tokenize from scratch behind a plain-text frame.
 * Bounded by count and by total length, the HTML being several times the size of its source; only
 * successes are kept, so a grammar that failed to load is tried again.
 */
/** A quarter of the web's text-cache budget; weight counts string length, two bytes each at worst. */
const CODE_CACHE_BYTES = TEXT_CACHE_BYTES.web / 4 / 2;
const codeCache = boundedCache<string, string>({ limit: 256, maxWeight: CODE_CACHE_BYTES, weigh: (key, html) => key.length + html.length });
registerBounded('highlighted-code', codeCache, 256, CODE_CACHE_BYTES);

/** What `highlightCode` already produced for this exact text, synchronously, so a fence can paint it on mount. */
export function cachedHighlight(code: string, language: string | undefined): string | undefined {
  return language ? codeCache.get(`${language}\u0000${code}`) : undefined;
}
