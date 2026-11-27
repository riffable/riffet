/**
 * Strips common Markdown syntax into clean readable prose for compact notification previews
 * and single-line list summaries where full rich-text rendering is not appropriate.
 */
export function plainMarkdownText(source: string, options?: { singleLine?: boolean }): string {
  const singleLine = options?.singleLine ?? false;
  const cleaned = source
    .replace(/\r\n?/g, '\n')
    // Fenced code blocks: drop the fence lines, keep the code body.
    .replace(/^```[^\n]*\n?([\s\S]*?)^```\s*$/gm, '$1')
    .replace(/^~~~[^\n]*\n?([\s\S]*?)^~~~\s*$/gm, '$1')
    // Images and links: keep human-readable label.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Reference-style links: [label][id]
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // Inline code backticks.
    .replace(/`([^`\n]+)`/g, '$1')
    // Bold / strikethrough markers.
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    // Emphasis asterisks (avoid eating bullet markers or multiplication with spaces).
    .replace(/(^|[\s([{"'「（【])\*([^*\n]+)\*(?=[\s)\]}"'」）】.,;:!?，。；：！？]|$)/g, '$1$2')
    // Per-line structural prefixes: headings, blockquotes, unordered bullets.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '');

  if (singleLine) {
    return cleaned.replace(/\s+/g, ' ').trim();
  }
  return cleaned
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
