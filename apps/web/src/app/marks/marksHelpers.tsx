import { Fragment } from 'react';
import type { Mark, MarkColor } from '@contracts';

export type MarkTab = 'all' | 'message' | 'span' | 'image' | 'file' | 'orphaned';
export type MarkViewMode = 'grid' | 'list';

export const markBorderClass: Record<MarkColor, string> = {
  yellow: 'mark-border-yellow',
  green: 'mark-border-green',
  blue: 'mark-border-blue',
  red: 'mark-border-red',
};

export const markQuoteClass: Record<MarkColor, string> = {
  yellow: 'mark-quote-yellow',
  green: 'mark-quote-green',
  blue: 'mark-quote-blue',
  red: 'mark-quote-red',
};

/** Collapse markdown formatting down to readable prose for compact card/list previews. */
export function plainExcerpt(text: string): string {
  return text
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body: string) => ` ${body.trim()} `)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pick a compact preview slice of [text]. When [query] matches past the opening lines, slide the
 * window around the hit so search results explain themselves at a glance.
 */
export function excerptWindow(text: string, query: string, maxChars = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const q = query.trim().toLowerCase();
  if (!q) return `${clean.slice(0, maxChars).trimEnd()}…`;
  const hit = clean.toLowerCase().indexOf(q);
  if (hit < 0 || hit + q.length <= maxChars - 16) {
    return `${clean.slice(0, maxChars).trimEnd()}…`;
  }
  const lead = Math.max(0, hit - Math.floor(maxChars * 0.28));
  const slice = clean.slice(lead, lead + maxChars).trim();
  return `${lead > 0 ? '…' : ''}${slice}${lead + maxChars < clean.length ? '…' : ''}`;
}

/** Highlight occurrences of [query] inside [text] without altering surrounding text selection. */
export function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(target, cursor);
    if (idx < 0) {
      parts.push({ text: text.slice(cursor), hit: false });
      break;
    }
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), hit: false });
    parts.push({ text: text.slice(idx, idx + needle.length), hit: true });
    cursor = idx + needle.length;
  }
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-xs bg-warning-soft px-0.5 text-fg">
            {part.text}
          </mark>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/** Primary text shown on a card or list row for [mark], centered around [query] when searching. */
export function markPreviewText(mark: Mark, query: string): string {
  if (mark.kind === 'span') return excerptWindow(mark.quote?.exact ?? '', query, 220);
  if (mark.kind === 'file') return mark.asset?.path ?? mark.asset?.name ?? '';
  if (mark.kind === 'image') return mark.asset?.name ?? '';
  return excerptWindow(plainExcerpt(mark.snapshot.text), query, 220);
}

/** The text copied by the quick copy action. */
export function markCopyText(mark: Mark): string {
  if (mark.kind === 'span') return mark.quote?.exact ?? '';
  if (mark.kind === 'file') return mark.asset?.path ?? mark.asset?.name ?? '';
  return mark.snapshot.text;
}
