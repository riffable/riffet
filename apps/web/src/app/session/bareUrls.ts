import { insideMath, mathRanges } from './dollarMath';
import { inLinkTarget, transformProse } from './markdownSource';

/**
 * Characters a URL keeps in prose: the ASCII URL syntax, plus the letters of a write-as-is path
 * (`/wiki/北京`). Punctuation, symbols and whitespace — including the ideographic space and NBSP —
 * end it, as does the `*` of an emphasis run that closes right after one. GFM reads all of them as
 * part of the link.
 */
const ASCII_URL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&()+,;=%]/;
const NON_ASCII_BREAK = /[\p{P}\p{S}\s]/u;
/** Punctuation GFM already trims from the end of an autolink literal. */
const TRAILING = new Set(['?', '!', '.', ',', ':', ';', '_', '~']);

/**
 * A bare URL as GFM reads it ends only at whitespace or `<`, so anything a writer puts directly
 * after one joins the link: `见 http://x/a，然后` links `，然后`, and `**http://x/a**（见）` swallows
 * the closing `**` — the opener stays literal and `**（见）` becomes part of the link. Both are how
 * Chinese prose is written, with no space before the punctuation.
 *
 * This gives those URLs a visible end by writing them as the explicit autolink `<…>`, which the
 * parser stops at `>`. The rendered link is the same, so only URLs that would otherwise run on are
 * rewritten — a URL followed by whitespace is left as it was. A `www.` link has no scheme to wrap,
 * so it becomes an ordinary link whose text is exactly what was written. Code spans and fences,
 * inline HTML and URLs already written as `<…>` are untouched.
 */
export function protectBareUrls(markdown: string): string {
  if (!markdown.includes('http://') && !markdown.includes('https://') && !markdown.includes('www.')) return markdown;
  return transformProse(markdown, protectSegment);
}

function protectSegment(text: string): string {
  const math = mathRanges(text);
  let out = '';
  let index = 0;
  while (index < text.length) {
    // An inline HTML tag or an explicit autolink already has an end; Markdown does not read inside.
    if (text[index] === '<' && /[A-Za-z/!?]/.test(text[index + 1] ?? '')) {
      const close = text.indexOf('>', index + 1);
      const end = close < 0 ? text.length : close + 1;
      out += text.slice(index, end);
      index = end;
      continue;
    }
    const start = urlStart(text, index);
    if (!start) {
      out += text[index];
      index += 1;
      continue;
    }
    const end = urlEnd(text, index, start);
    // A scheme with nothing after it is not a URL; a `www.` host is one on its own.
    if ((end <= start.afterScheme && start.kind === 'scheme') || end >= text.length || /\s/.test(text[end]!)) {
      out += text.slice(index, end);
      index = end;
      continue;
    }
    // GFM writes no autolink inside a link or a formula, and no link inside another link.
    if (inLinkTarget(text, index) || insideMath(math, index) || insideLabel(text, index)) {
      out += text.slice(index, end);
      index = end;
      continue;
    }
    const url = text.slice(index, end);
    out += start.kind === 'www' ? `[${url}](http://${url})` : `<${url}>`;
    index = end;
  }
  return out;
}

type BareUrlStart = { kind: 'scheme' | 'www'; afterScheme: number };

/** Whether the `[` still open at [start] closes into a link (`](…)` or `][…]`). */
function insideLabel(text: string, start: number): boolean {
  let depth = 0;
  for (let index = 0; index < start; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] === '[') depth += 1;
    else if (text[index] === ']' && depth > 0) depth -= 1;
  }
  if (depth === 0) return false;
  // URL characters include `]` and `(`, so a URL-only label can swallow the entire destination
  // during URL scanning. Find the label's own boundary, independently of the candidate URL end.
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] === '[') depth += 1;
    else if (text[index] === ']') {
      if (text[index + 1] === '(' || text[index + 1] === '[') return true;
      if (--depth === 0) return false;
    }
  }
  return false;
}

/** Where a bare URL starts at [index], and where its scheme (or `www.` host) ends. */
function urlStart(text: string, index: number): BareUrlStart | undefined {
  if (index > 0 && /[A-Za-z0-9]/.test(text[index - 1]!)) return undefined;
  if (text.startsWith('http://', index)) return { kind: 'scheme', afterScheme: index + 7 };
  if (text.startsWith('https://', index)) return { kind: 'scheme', afterScheme: index + 8 };
  if (!text.startsWith('www.', index)) return undefined;
  // GFM wants a dot in a `www.` host; a host is ASCII, so Chinese punctuation ends it.
  const host = /^www\.[A-Za-z0-9.-]*\.[A-Za-z0-9-]+/.exec(text.slice(index));
  return host ? { kind: 'www', afterScheme: index + host[0].length } : undefined;
}

/** The end of the URL starting at [index], after GFM's trailing punctuation is dropped. */
function urlEnd(text: string, index: number, start: BareUrlStart): number {
  let end = start.afterScheme;
  while (end < text.length) {
    const code = text.codePointAt(end)!;
    if (code < 0x80) {
      if (!ASCII_URL_CHAR.test(text[end]!)) break;
      end += 1;
      continue;
    }
    const character = String.fromCodePoint(code);
    if (NON_ASCII_BREAK.test(character)) break;
    end += character.length;
  }
  return trimEnd(text, index, end);
}

/** [end] with GFM's trailing punctuation (and unbalanced closing parens) dropped. */
function trimEnd(text: string, start: number, end: number): number {
  for (;;) {
    const char = text[end - 1];
    if (end <= start || char === undefined) return end;
    if (char === ')') {
      let open = 0;
      let close = 0;
      for (let index = start; index < end; index += 1) {
        if (text[index] === '(') open += 1;
        else if (text[index] === ')') close += 1;
      }
      if (close <= open) return end;
      end -= 1;
      continue;
    }
    if (!TRAILING.has(char)) return end;
    end -= 1;
  }
}
