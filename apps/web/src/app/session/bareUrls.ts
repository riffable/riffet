import { insideMath, mathRanges } from './dollarMath';
import { inLinkTarget, transformProse } from '../../../../../packages/timeline/src/markdownSource';

/**
 * Characters a URL keeps in prose: the ASCII URL syntax, plus the letters of a write-as-is path
 * (`/wiki/北京`). Punctuation, symbols and whitespace — including the ideographic space and NBSP —
 * end it, as does the `*` of an emphasis run that closes right after one. GFM reads all of them as
 * part of the link.
 */
const NON_ASCII_BREAK = /[\p{P}\p{S}\s]/u;
/** Punctuation GFM trims from the end of an autolink literal. */
const TRAILING = new Set(['?', '!', '.', ',', ':', ';', '_', '~']);
/** Characters allowed in the path, query or fragment of a bare URL. */
const ASCII_TAIL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&()+,;=%]/;
const USERINFO_CHAR = /[A-Za-z0-9\-._~%:+]/;

export interface BareUrlPart {
  text: string;
  href?: string;
}

/**
 * Splits plain text into literal runs and bare `http(s)://` / `www.` web links.
 * Used by user messages so pasted links are clickable without running full Markdown parsing.
 */
export function splitBareUrls(text: string): BareUrlPart[] {
  if (!hasBareUrlHint(text)) return [{ text }];
  const parts: BareUrlPart[] = [];
  let plain = 0;
  let index = 0;
  while (index < text.length) {
    const match = scanBareUrl(text, index);
    if (!match) {
      index += 1;
      continue;
    }
    if (plain < index) parts.push({ text: text.slice(plain, index) });
    parts.push({ text: text.slice(index, match.end), href: match.href });
    index = match.end;
    plain = index;
  }
  if (plain < text.length) parts.push({ text: text.slice(plain) });
  return parts.length ? parts : [{ text }];
}

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
  if (!hasBareUrlHint(markdown)) return markdown;
  return transformProse(markdown, protectSegment);
}

function hasBareUrlHint(text: string): boolean {
  return text.includes('://') || /www\./i.test(text);
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
    const match = scanBareUrl(text, index);
    if (!match) {
      out += text[index];
      index += 1;
      continue;
    }
    const { end, kind, href } = match;
    if (end >= text.length || /\s/.test(text[end]!)) {
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
    out += kind === 'www' ? `[${url}](${href})` : `<${url}>`;
    index = end;
  }
  return out;
}

type BareUrlMatch = { kind: 'scheme' | 'www'; end: number; href: string };

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

function isAsciiAlnum(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char);
}

function startsWithIgnoreCase(text: string, index: number, prefix: string): boolean {
  if (index + prefix.length > text.length) return false;
  return text.slice(index, index + prefix.length).toLowerCase() === prefix;
}

function isValidHostname(host: string): boolean {
  if (!host) return false;
  const labels = host.split('.');
  for (const label of labels) {
    if (!label) return false;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) return false;
  }
  return true;
}

function isValidWwwTld(label: string): boolean {
  if (label.length < 2) return false;
  return /^[A-Za-z]{2,}$/.test(label) || /^xn--[A-Za-z0-9]{2,}$/i.test(label);
}

/** Parses optional `:port` at [start]. Returns `undefined` if `:` is followed by an invalid port. */
function scanPort(text: string, start: number): number | undefined {
  if (text[start] !== ':') return start;
  let end = start + 1;
  while (end < text.length && /[0-9]/.test(text[end]!)) end += 1;
  // `https://example.com: 说明` — not a port, so leave `:` as prose.
  if (end === start + 1) return start;
  if (isAsciiAlnum(text[end])) return undefined;
  const digits = end - (start + 1);
  if (digits > 5) return undefined;
  const port = Number(text.slice(start + 1, end));
  if (port < 1 || port > 65535) return undefined;
  return end;
}

function scanBareUrl(text: string, index: number): BareUrlMatch | undefined {
  const prev = index > 0 ? text[index - 1] : undefined;
  if (startsWithIgnoreCase(text, index, 'http://') || startsWithIgnoreCase(text, index, 'https://')) {
    if (prev !== undefined && /[A-Za-z0-9_]/.test(prev)) return undefined;
    const isHttps = startsWithIgnoreCase(text, index, 'https://');
    const schemeLen = isHttps ? 8 : 7;
    const normalizedScheme = isHttps ? 'https://' : 'http://';
    const authStart = index + schemeLen;
    // Optional `userinfo@` before host.
    let hostStart = authStart;
    let probe = authStart;
    while (probe < text.length && USERINFO_CHAR.test(text[probe]!)) probe += 1;
    if (probe > authStart && text[probe] === '@') hostStart = probe + 1;
    let hostEnd = hostStart;
    if (text[hostStart] === '[') {
      let close = hostStart + 1;
      let hasColon = false;
      while (close < text.length && /[0-9A-Fa-f:.]/.test(text[close]!)) {
        if (text[close] === ':') hasColon = true;
        close += 1;
      }
      if (!hasColon || close <= hostStart + 2 || text[close] !== ']') return undefined;
      hostEnd = close + 1;
    } else {
      let scanEnd = hostStart;
      while (scanEnd < text.length && /[A-Za-z0-9.-]/.test(text[scanEnd]!)) scanEnd += 1;
      let trimmedEnd = scanEnd;
      if (text[scanEnd] === '/' && trimmedEnd > hostStart && text[trimmedEnd - 1] === '.') {
        trimmedEnd -= 1;
      } else {
        while (trimmedEnd > hostStart && text[trimmedEnd - 1] === '.') trimmedEnd -= 1;
        scanEnd = trimmedEnd;
      }
      if (!isValidHostname(text.slice(hostStart, trimmedEnd))) return undefined;
      hostEnd = scanEnd;
    }
    const authEnd = scanPort(text, hostEnd);
    if (authEnd === undefined) return undefined;
    const next = text[authEnd];
    const end = next === '/' || next === '?' || next === '#' ? scanTail(text, authEnd) : authEnd;
    return { kind: 'scheme', end, href: normalizedScheme + text.slice(authStart, end) };
  }

  if (startsWithIgnoreCase(text, index, 'www.')) {
    if (prev !== undefined && /[A-Za-z0-9._/\-@]/.test(prev)) return undefined;
    let scanEnd = index;
    while (scanEnd < text.length && /[A-Za-z0-9.-]/.test(text[scanEnd]!)) scanEnd += 1;
    let trimmedEnd = scanEnd;
    if (text[scanEnd] === '/' && trimmedEnd > index && text[trimmedEnd - 1] === '.') {
      trimmedEnd -= 1;
    } else {
      while (trimmedEnd > index && text[trimmedEnd - 1] === '.') trimmedEnd -= 1;
      scanEnd = trimmedEnd;
    }
    const host = text.slice(index, trimmedEnd);
    const labels = host.split('.');
    if (labels.length < 3 || !isValidHostname(host) || !isValidWwwTld(labels[labels.length - 1]!)) return undefined;
    const authEnd = scanPort(text, scanEnd);
    if (authEnd === undefined) return undefined;
    const next = text[authEnd];
    const end = next === '/' || next === '?' || next === '#' ? scanTail(text, authEnd) : authEnd;
    return { kind: 'www', end, href: `http://${text.slice(index, end)}` };
  }

  return undefined;
}

/** Scans path/query/fragment from [from], stopping on prose punctuation or unmatched `)` / `]`. */
function scanTail(text: string, from: number): number {
  let end = from;
  let parenDepth = 0;
  let bracketDepth = 0;
  while (end < text.length) {
    const code = text.codePointAt(end)!;
    if (code < 0x80) {
      const char = text[end]!;
      if (char === '(') { parenDepth += 1; end += 1; continue; }
      if (char === ')') { if (parenDepth === 0) break; parenDepth -= 1; end += 1; continue; }
      if (char === '[') { bracketDepth += 1; end += 1; continue; }
      if (char === ']') { if (bracketDepth === 0) break; bracketDepth -= 1; end += 1; continue; }
      if (!ASCII_TAIL_CHAR.test(char)) break;
      end += 1;
      continue;
    }
    const character = String.fromCodePoint(code);
    if (NON_ASCII_BREAK.test(character)) break;
    end += character.length;
  }
  return trimTail(text, from, end);
}

/** Drops GFM trailing punctuation and unclosed trailing `(` / `[` from the scanned tail. */
function trimTail(text: string, start: number, end: number): number {
  for (;;) {
    if (end <= start) return start;
    const char = text[end - 1]!;
    if (TRAILING.has(char)) {
      end -= 1;
      continue;
    }
    if ((char === '(' || char === '[') && hasUnclosedOpen(text, start, end, char, char === '(' ? ')' : ']')) {
      end -= 1;
      continue;
    }
    return end;
  }
}

function hasUnclosedOpen(text: string, start: number, end: number, open: string, close: string): boolean {
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close && depth > 0) depth -= 1;
  }
  return depth > 0;
}
