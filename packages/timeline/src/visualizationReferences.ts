import { closesFence, fenceRun, type Fence } from './markdownSource.js';

export interface VisualizationReference {
  path: string;
  title?: string;
  mode?: 'wide';
}

const HREF_PREFIX = 'riffet-visualize:';
const MAX_JSON_LENGTH = 16_384;
const MAX_PATH_LENGTH = 8192;
const PATH_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function normalizedReference(value: unknown): VisualizationReference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const path = record.path;
  if (typeof path !== 'string') return undefined;
  const localPath = path.trim();
  if (!localPath || localPath.length > MAX_PATH_LENGTH || [...localPath].some((character) => character.charCodeAt(0) < 32)) return undefined;
  // Relative project paths and absolute local paths are valid; URI schemes and protocol-relative
  // paths can never be handed to the project-file renderer.
  if (localPath.startsWith('//') || PATH_SCHEME.test(localPath)) return undefined;
  if (!/\.html?$/i.test(localPath)) return undefined;
  const reference: VisualizationReference = { path: localPath };
  if (typeof record.title === 'string') {
    const title = record.title.trim();
    if (title && title.length <= 250) reference.title = title;
  }
  if (record.mode === 'wide') reference.mode = 'wide';
  return reference;
}

/** Parses one complete standalone protocol line. Partial, malformed, and unsafe values stay text. */
export function parseVisualizationReferenceLine(line: string): VisualizationReference | undefined {
  const match = /^( {0,3})\uE200visualize\uE202(\{[\s\S]*\})\uE201[ \t\r]*$/.exec(line);
  if (!match || match[2]!.length > MAX_JSON_LENGTH) return undefined;
  try {
    const value: unknown = JSON.parse(match[2]!);
    return normalizedReference(value);
  } catch {
    return undefined;
  }
}

/** Encodes validated references into a private Markdown link handled by MarkdownLink. */
export function visualizationReferenceHref(reference: VisualizationReference): string {
  const json = JSON.stringify(reference);
  const encoded = encodeURIComponent(json).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${HREF_PREFIX}${encoded}`;
}

/** Returns a reference only for the internal link form produced by the line parser. */
export function visualizationReferenceFromHref(href: string | undefined): VisualizationReference | undefined {
  if (!href?.startsWith(HREF_PREFIX)) return undefined;
  try {
    const json = decodeURIComponent(href.slice(HREF_PREFIX.length));
    if (json.length > MAX_JSON_LENGTH) return undefined;
    const value: unknown = JSON.parse(json);
    return normalizedReference(value);
  } catch {
    return undefined;
  }
}

/**
 * Rewrites only complete protocol lines outside Markdown code into an encoded link. All other
 * source bytes, including definitions, math, and malformed streaming prefixes, pass through.
 * [label] is the link text; the server bundles this module too, so it cannot use a compile-time
 * Lingui macro here.
 */
export function rewriteVisualizationReferences(markdown: string, label: string): string {
  if (!markdown.includes('\uE200visualize\uE202')) return markdown;
  const lines = markdown.split('\n');
  const output: string[] = [];
  let fence: Fence | undefined;
  let inlineBackticks: number | undefined;

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      output.push(rawLine);
      continue;
    }

    // Blank lines end the Markdown paragraph in which a multiline inline-code span can exist.
    if (/^[ \t]*$/.test(line)) inlineBackticks = undefined;
    const opener = fenceRun(line);
    if (!inlineBackticks && opener) {
      fence = { char: opener.char, size: opener.size };
      output.push(rawLine);
      continue;
    }

    const reference = inlineBackticks === undefined ? parseVisualizationReferenceLine(line) : undefined;
    if (reference) {
      const leading = /^ {0,3}/.exec(line)![0];
      output.push(`${leading}[${label}](${visualizationReferenceHref(reference)})${rawLine.endsWith('\r') ? '\r' : ''}`);
      // A valid protocol is opaque data; Markdown punctuation in its JSON must not affect later lines.
      continue;
    }

    let index = 0;
    while (index < line.length) {
      if (line[index] !== '`') { index += 1; continue; }
      let slashCount = 0;
      for (let previous = index - 1; previous >= 0 && line[previous] === '\\'; previous -= 1) slashCount += 1;
      let end = index + 1;
      while (line[end] === '`') end += 1;
      if (slashCount % 2 === 0) {
        const size = end - index;
        if (inlineBackticks === undefined) inlineBackticks = size;
        else if (inlineBackticks === size) inlineBackticks = undefined;
      }
      index = end;
    }
    output.push(rawLine);
  }
  return output.join('\n');
}
