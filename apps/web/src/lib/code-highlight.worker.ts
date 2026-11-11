/// <reference lib="webworker" />
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemeRegistration } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * Tokenizes source for the code view off the main thread, with the TextMate grammars VS Code uses
 * (through Shiki), so a long file never stalls the panel. Colours are not decided here: each scope
 * maps to a `--code-*` variable, so the palette follows the theme without tokenizing again.
 */

type Grammar = { default: LanguageRegistration[] };
const LANGUAGES: Record<string, () => Promise<Grammar>> = {
  kotlin: () => import('shiki/langs/kotlin.mjs'), java: () => import('shiki/langs/java.mjs'), groovy: () => import('shiki/langs/groovy.mjs'),
  xml: () => import('shiki/langs/xml.mjs'), properties: () => import('shiki/langs/properties.mjs'), proto: () => import('shiki/langs/proto.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'), tsx: () => import('shiki/langs/tsx.mjs'), javascript: () => import('shiki/langs/javascript.mjs'), jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'), jsonc: () => import('shiki/langs/jsonc.mjs'), yaml: () => import('shiki/langs/yaml.mjs'), toml: () => import('shiki/langs/toml.mjs'), ini: () => import('shiki/langs/ini.mjs'),
  html: () => import('shiki/langs/html.mjs'), css: () => import('shiki/langs/css.mjs'), scss: () => import('shiki/langs/scss.mjs'), less: () => import('shiki/langs/less.mjs'), vue: () => import('shiki/langs/vue.mjs'), svelte: () => import('shiki/langs/svelte.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'), python: () => import('shiki/langs/python.mjs'), go: () => import('shiki/langs/go.mjs'), rust: () => import('shiki/langs/rust.mjs'), swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'), cpp: () => import('shiki/langs/cpp.mjs'), 'objective-c': () => import('shiki/langs/objective-c.mjs'), 'objective-cpp': () => import('shiki/langs/objective-cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'), ruby: () => import('shiki/langs/ruby.mjs'), php: () => import('shiki/langs/php.mjs'), dart: () => import('shiki/langs/dart.mjs'), scala: () => import('shiki/langs/scala.mjs'), lua: () => import('shiki/langs/lua.mjs'),
  sql: () => import('shiki/langs/sql.mjs'), markdown: () => import('shiki/langs/markdown.mjs'), graphql: () => import('shiki/langs/graphql.mjs'), dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'), cmake: () => import('shiki/langs/cmake.mjs'), diff: () => import('shiki/langs/diff.mjs'),
};

/** TextMate scopes by `--code-*` role; the first rule that matches a token's innermost scopes wins, as in VS Code. */
const ROLES: Array<[role: string, scopes: string[], italic?: boolean]> = [
  ['comment', ['comment', 'punctuation.definition.comment', 'string.comment'], true],
  ['annotation', ['entity.name.type.annotation', 'entity.name.type.annotation-site', 'storage.type.annotation', 'meta.annotation punctuation', 'punctuation.definition.annotation', 'meta.decorator', 'entity.name.function.decorator', 'punctuation.decorator']],
  ['escape', ['constant.character.escape', 'variable.string-escape', 'punctuation.definition.template-expression', 'punctuation.section.embedded']],
  ['string', ['string', 'markup.inline.raw', 'entity.other.attribute-value']],
  ['number', ['constant.numeric']],
  ['keyword', ['keyword', 'storage', 'constant.language', 'variable.language', 'support.type.primitive', 'keyword.type']],
  ['tag', ['entity.name.tag', 'punctuation.definition.tag']],
  ['attribute', ['entity.other.attribute-name', 'support.type.property-name', 'meta.object-literal.key']],
  // Package paths read as plain text; their own role keeps the member guess below off them.
  ['namespace', ['entity.name.package', 'entity.name.namespace', 'meta.import', 'meta.package', 'storage.modifier.import', 'storage.modifier.package', 'entity.name.type.package', 'support.other.namespace']],
  ['constant', ['variable.other.constant', 'variable.other.enummember', 'constant.other.enum', 'support.constant'], true],
  ['property', ['variable.other.property', 'variable.other.object.property', 'support.variable.property', 'variable.other.member', 'meta.object-literal.key entity.name']],
  // Java scopes reference types as `storage.type`; only primitives read as keywords there.
  ['type', ['storage.type.java', 'storage.type.generic.java', 'storage.type.object.array.java', 'storage.type.groovy', 'storage.type.cs', 'storage.type.dart']],
  ['keyword', ['storage.type.primitive', 'storage.type.primitive.array']],
  ['declaration', ['meta.method.identifier entity.name.function', 'entity.name.function.declaration', 'meta.definition.function entity.name.function', 'meta.definition.method entity.name.function', 'entity.name.function.member.definition']],
  ['type', ['entity.name.type.class', 'entity.name.type.interface', 'entity.name.type.enum', 'entity.name.type.object', 'entity.name.class', 'meta.class entity.name.type']],
  ['operator', ['keyword.operator', 'punctuation.separator', 'punctuation.terminator', 'punctuation.accessor', 'meta.brace', 'punctuation.section', 'punctuation.definition.block']],
  ['heading', ['markup.heading', 'entity.name.section']],
  ['link', ['markup.underline.link']],
];
// Operators and punctuation read as plain text in IDEs; their rule only keeps keywords' colour off `keyword.operator`.
const theme: ThemeRegistration = {
  name: 'riffet-code', type: 'light',
  colors: { 'editor.foreground': 'var(--code-fg)', 'editor.background': 'transparent' },
  tokenColors: ROLES.map(([role, scope, italic]) => ({ scope, settings: { foreground: `var(--code-${role === 'operator' ? 'fg' : role})`, ...(italic ? { fontStyle: 'italic' } : {}) } })),
};

let highlighter: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<boolean>>();

async function ready(language: string): Promise<HighlighterCore | undefined> {
  const loader = LANGUAGES[language];
  if (!loader) return undefined;
  highlighter ??= createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  const core = await highlighter;
  let loaded = loading.get(language);
  if (!loaded) { loaded = loader().then((grammar) => core.loadLanguage(...grammar.default)).then(() => true, () => false); loading.set(language, loaded); }
  return (await loaded) ? core : undefined;
}

/**
 * Languages whose grammars leave members and constants unscoped. In them an identifier after a dot
 * that is not called reads as a property, and an all-caps one as a constant, as an IDE colours
 * them from its model; the guess is wrong only for the odd call written across a line break.
 */
const MEMBERS = new Set(['kotlin', 'java', 'groovy', 'scala', 'dart', 'swift', 'csharp', 'go']);
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const CONSTANT = /^[A-Z][A-Z0-9]*_[A-Z0-9_]*$|^[A-Z]{2,}[0-9]*$/;

function memberRole(code: string, from: number, to: number): 'property' | 'constant' | undefined {
  const word = code.slice(from, to);
  if (CONSTANT.test(word)) return 'constant';
  if (code[from - 1] !== '.' || code[from - 2] === '.' || !/[a-z_]/.test(word[0]!)) return undefined;
  let next = to;
  while (code[next] === ' ') next++;
  return code[next] === '(' || code[next] === '{' || code[next] === '<' ? undefined : 'property';
}

export interface TokensRequest { id: number; code: string; language: string }
/** `ranges` holds `from, to, style` triples over the source; `styles[style]` is `colour|italic`. */
export interface TokensResponse { id: number; ranges?: Uint32Array; styles?: string[] }

self.onmessage = async (event: MessageEvent<TokensRequest>) => {
  const { id, code, language } = event.data;
  try {
    const core = await ready(language);
    if (!core) { self.postMessage({ id } satisfies TokensResponse); return; }
    // A minified line past this stays plain instead of holding the worker.
    const lines = core.codeToTokensBase(code, { lang: language, theme: 'riffet-code', tokenizeMaxLineLength: 4000 });
    const styles: string[] = [];
    const index = new Map<string, number>();
    const out: number[] = [];
    const members = MEMBERS.has(language);
    const styleOf = (color: string, italic: boolean) => {
      const key = `${color}|${italic ? 'i' : ''}`;
      let style = index.get(key);
      if (style === undefined) { style = styles.length; styles.push(key); index.set(key, style); }
      return style;
    };
    // Offsets are into the whole source.
    for (const line of lines) {
      for (const token of line) {
        const color = token.color && token.color !== 'var(--code-fg)' ? token.color : '';
        const italic = Boolean(token.fontStyle && token.fontStyle & 1);
        if (!color && !italic) {
          if (!members) continue;
          for (const match of token.content.matchAll(IDENTIFIER)) {
            const from = token.offset + match.index;
            const role = memberRole(code, from, from + match[0].length);
            if (role) out.push(from, from + match[0].length, styleOf(`var(--code-${role})`, role === 'constant'));
          }
          continue;
        }
        out.push(token.offset, token.offset + token.content.length, styleOf(color, italic));
      }
    }
    const ranges = Uint32Array.from(out);
    self.postMessage({ id, ranges, styles } satisfies TokensResponse, [ranges.buffer]);
  } catch {
    self.postMessage({ id } satisfies TokensResponse);
  }
};
