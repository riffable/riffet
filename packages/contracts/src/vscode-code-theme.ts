import { CODE_THEME_ROLES, type CodeThemePalette, type CodeThemeRole, type CustomCodeSyntax, type CustomCodeSyntaxHalf } from './code-theme.js';
import { colorToHex, parseColor, relativeLuminance } from './theme.js';

export interface ImportedCodeTheme {
  name?: string;
  /** Detected from VS Code `type` or `editor.background`, or undefined when ambiguous. */
  mode?: 'light' | 'dark';
  /** Present when the imported document supplied both halves directly. */
  syntax?: CustomCodeSyntax;
  /** Single-half palette extracted from a VS Code theme JSON or a Riffet half JSON. */
  half?: CustomCodeSyntaxHalf;
}

export type CodeThemeImportResult =
  | { ok: true; value: ImportedCodeTheme }
  | { ok: false; reason: 'invalid-json' | 'not-theme' };

/**
 * Strips JSONC `//` line comments, `/* ... *\/` block comments and trailing commas outside string
 * literals so standard VS Code theme files parse with `JSON.parse`.
 */
export function stripJsonCommentsAndTrailingCommas(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '/') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n' && raw[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Remove trailing commas outside strings: `,` followed only by whitespace and `}` or `]`.
  let cleaned = '';
  inString = false;
  escaped = false;
  for (let j = 0; j < out.length; j += 1) {
    const ch = out[j]!;
    if (inString) {
      cleaned += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k]!)) k += 1;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    cleaned += ch;
  }
  return cleaned;
}

const SCOPE_MATCHERS: ReadonlyArray<readonly [CodeThemeRole, readonly string[]]> = [
  ['comment', ['comment', 'punctuation.definition.comment', 'string.comment']],
  ['keyword', ['keyword', 'storage', 'storage.type', 'keyword.control', 'storage.modifier']],
  ['string', ['string', 'string.quoted', 'markup.inline.raw']],
  ['number', ['constant.numeric', 'number']],
  ['constant', ['constant.language', 'variable.other.constant', 'variable.other.enummember', 'support.constant', 'constant', 'variable.language']],
  ['declaration', ['entity.name.function', 'entity.name.function.declaration', 'support.function', 'meta.function-call', 'variable.function']],
  ['type', ['entity.name.type', 'entity.name.class', 'entity.name.type.class', 'support.type', 'support.class']],
  ['property', ['variable.other.property', 'variable.other.object.property', 'support.variable.property', 'variable.other.member', 'property']],
  ['namespace', ['entity.name.namespace', 'entity.name.type.module', 'support.module', 'entity.name.package', 'namespace', 'meta.import']],
  ['tag', ['entity.name.tag', 'meta.tag']],
  ['attribute', ['entity.other.attribute-name', 'support.type.property-name', 'meta.object-literal.key', 'meta.property-name', 'attribute.name']],
  ['annotation', ['storage.type.annotation', 'entity.name.function.decorator', 'meta.decorator', 'punctuation.definition.annotation', 'entity.name.type.annotation']],
  ['escape', ['constant.character.escape', 'variable.string-escape', 'punctuation.definition.template-expression']],
  ['heading', ['markup.heading', 'entity.name.section', 'heading.1.markdown', 'markup.heading.1']],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseColor(raw);
  return parsed ? colorToHex(parsed) : null;
}

function normalizeScopeList(scope: unknown): string[] {
  if (typeof scope === 'string') {
    return scope.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(scope)) {
    return scope.flatMap((item) => (typeof item === 'string' ? item.split(',').map((part) => part.trim()).filter(Boolean) : []));
  }
  return [];
}

function scopeMatches(ruleScopes: readonly string[], target: string): number {
  let best = 0;
  for (const scope of ruleScopes) {
    if (scope === target) best = Math.max(best, 3);
    else if (scope.startsWith(`${target}.`)) best = Math.max(best, 2);
    else if (target.startsWith(`${scope}.`)) best = Math.max(best, 1);
  }
  return best;
}

function parseDirectHalf(value: unknown): CustomCodeSyntaxHalf | null {
  if (!isRecord(value) || !isRecord(value.colors)) return null;
  const colors = {} as CodeThemePalette;
  for (const role of CODE_THEME_ROLES) {
    const color = normalizeColor(value.colors[role]);
    if (!color) return null;
    colors[role] = color;
  }
  return {
    colors,
    commentItalic: typeof value.commentItalic === 'boolean' ? value.commentItalic : true,
  };
}

function detectMode(doc: Record<string, unknown>): 'light' | 'dark' | undefined {
  if (doc.type === 'light' || doc.type === 'hcLight') return 'light';
  if (doc.type === 'dark' || doc.type === 'hcDark') return 'dark';
  if (isRecord(doc.colors)) {
    const bg = normalizeColor(doc.colors['editor.background']);
    const parsed = bg ? parseColor(bg) : null;
    if (parsed) return relativeLuminance(parsed) < 0.25 ? 'dark' : 'light';
  }
  return undefined;
}

/**
 * Parses a VS Code / Shiki JSON(C) theme or a Riffet syntax snippet into 14 syntax roles.
 */
export function importCodeThemeJson(raw: string): CodeThemeImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(raw));
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'not-theme' };

  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined;

  // 1. Direct Riffet syntax object (`{ light: ..., dark: ... }` or `{ colors: ... }`).
  const directLight = parseDirectHalf(parsed.light);
  const directDark = parseDirectHalf(parsed.dark);
  if (directLight && directDark) {
    return { ok: true, value: { ...(name ? { name } : {}), syntax: { light: directLight, dark: directDark } } };
  }
  const directSingle = parseDirectHalf(parsed);
  if (directSingle) {
    const mode = detectMode(parsed);
    return { ok: true, value: { ...(name ? { name } : {}), ...(mode ? { mode } : {}), half: directSingle } };
  }

  // 2. VS Code / TextMate theme (`tokenColors` or `settings` array).
  const rawRules = Array.isArray(parsed.tokenColors)
    ? parsed.tokenColors
    : Array.isArray(parsed.settings)
      ? parsed.settings
      : null;
  if (!rawRules) return { ok: false, reason: 'not-theme' };

  const rules: Array<{ scopes: string[]; foreground?: string; fontStyle?: string }> = [];
  for (const item of rawRules) {
    if (!isRecord(item) || !isRecord(item.settings)) continue;
    const foreground = normalizeColor(item.settings.foreground);
    const fontStyle = typeof item.settings.fontStyle === 'string' ? item.settings.fontStyle : undefined;
    const scopes = normalizeScopeList(item.scope);
    if (scopes.length && (foreground || fontStyle !== undefined)) {
      rules.push({ scopes, ...(foreground ? { foreground } : {}), ...(fontStyle !== undefined ? { fontStyle } : {}) });
    }
  }

  const mode = detectMode(parsed);
  const editorFg = isRecord(parsed.colors) ? normalizeColor(parsed.colors['editor.foreground']) : null;
  const fallbackFg = editorFg ?? (mode === 'dark' ? '#d2d4d7' : '#2a2c2e');

  const picked: Partial<Record<CodeThemeRole, string>> = {};
  let commentItalic = true;
  let matchedCount = 0;

  for (const [role, targets] of SCOPE_MATCHERS) {
    let bestScore = 0;
    let bestColor: string | undefined;
    let bestStyle: string | undefined;
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex]!;
      const priorityBonus = (targets.length - targetIndex) * 10;
      for (const rule of rules) {
        const match = scopeMatches(rule.scopes, target);
        if (!match) continue;
        const score = priorityBonus + match;
        if (rule.foreground && score > bestScore) {
          bestScore = score;
          bestColor = rule.foreground;
          bestStyle = rule.fontStyle;
        } else if (role === 'comment' && rule.fontStyle !== undefined && score >= bestScore) {
          bestStyle = rule.fontStyle;
        }
      }
    }
    if (bestColor) {
      picked[role] = bestColor;
      matchedCount += 1;
    }
    if (role === 'comment' && bestStyle !== undefined) {
      commentItalic = bestStyle.toLowerCase().includes('italic');
    }
  }

  if (matchedCount === 0) return { ok: false, reason: 'not-theme' };

  const pick = (...candidates: Array<CodeThemeRole>): string => {
    for (const role of candidates) {
      const value = picked[role];
      if (value) return value;
    }
    return fallbackFg;
  };

  const colors: CodeThemePalette = {
    comment: picked.comment ?? (mode === 'dark' ? '#7a7e85' : '#8c8c8c'),
    keyword: pick('keyword'),
    string: pick('string'),
    number: pick('number', 'constant'),
    constant: pick('constant', 'number', 'keyword'),
    declaration: pick('declaration', 'constant'),
    type: pick('type', 'declaration'),
    property: pick('property', 'attribute', 'constant'),
    namespace: pick('namespace', 'type'),
    tag: pick('tag', 'keyword'),
    attribute: pick('attribute', 'property', 'tag'),
    annotation: pick('annotation', 'keyword', 'type'),
    escape: pick('escape', 'constant', 'string'),
    heading: pick('heading', 'keyword', 'constant'),
  };

  return {
    ok: true,
    value: {
      ...(name ? { name } : {}),
      ...(mode ? { mode } : {}),
      half: { colors, commentItalic },
    },
  };
}
