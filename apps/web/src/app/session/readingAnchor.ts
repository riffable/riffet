import { COLLAPSE_STATE_ATTR } from '@/components/ui/collapse';
import { findQuote, QUOTE_CONTEXT, rangeAt } from './textQuote';

/**
 * Shared DOM contract between `TranscriptView`, `useTranscriptScroll`, `TurnProcess`, `Collapse`,
 * and `readingAnchor`. Keep these names in one place so a rename or wrapper change fails typecheck
 * instead of silently breaking scroll anchoring.
 */
export const TRANSCRIPT_ATTR = {
  scroll: 'data-transcript-scroll',
  following: 'data-transcript-following',
  content: 'data-content-column',
  rows: 'data-transcript-rows',
  rowKey: 'data-row-key',
  rowSlot: 'data-row-slot',
  processOpen: 'data-process-open',
  processBody: 'data-process-body',
  collapseState: COLLAPSE_STATE_ATTR,
} as const;

export interface ProcessFoldMetrics {
  following: boolean;
  scrollTop: number;
  collapsible: number;
  boxTop: number;
  boxBottom: number;
  viewTop: number;
  viewBottom: number;
}

export type ProcessFoldAction = 'instant' | 'defer' | 'animate';

/**
 * Single source of truth for how an automatic `TurnProcess` fold lands:
 * - `instant`: off-screen below (zero effect on the viewport), or following with enough `scrollTop`
 *   to absorb the collapsed height in one commit;
 * - `defer`: reader is not following and is reading prose below (or alongside) this process block —
 *   keep the block's height untouched so visible prose never relies on scrollTop compensation at
 *   turn end, and release once the reader returns to following or scrolls above the block;
 * - `animate`: process fills the rest of the viewport (no prose below), or the reader is following
 *   at the end of a short turn.
 */
export function decideProcessFold(metrics: ProcessFoldMetrics): ProcessFoldAction {
  if (metrics.boxTop >= metrics.viewBottom) return 'instant';
  if (metrics.boxTop >= metrics.viewTop && metrics.boxBottom >= metrics.viewBottom) return 'animate';
  if (!metrics.following && metrics.boxBottom < metrics.viewBottom - 1) return 'defer';
  if (metrics.following && metrics.scrollTop >= metrics.collapsible) return 'instant';
  return 'animate';
}

/**
 * Whether a deferred automatic fold can now release without disturbing an off-bottom reader:
 * - off-screen below (`boxTop >= viewBottom`): physically zero effect on visible prose (`instant`);
 * - reader returned to following (`following === true`): view stays pinned to the end.
 */
export function canReleaseDeferredProcessFold(metrics: ProcessFoldMetrics): boolean {
  if (metrics.boxTop >= metrics.viewBottom) return true;
  return metrics.following;
}

/** A visible leaf block inside a row that starts above the viewport. */
export interface BlockAnchor {
  element: Element;
  top: number;
  /** Plain-text quote sampled from this block alone, used only on the cold path when the DOM node is replaced. */
  quote?: { exact: string; prefix: string; suffix: string };
}

/**
 * A semantic reading position survives prepends, message updates, draft-to-final replacements and
 * delayed image/math layout. A row starting above the view also names the visible blocks inside it,
 * so growth or reflow earlier in the same long message does not move the words being read.
 */
export interface ReadingAnchor {
  rows: { key: string; slot?: string; top: number; height?: number; processOpen?: boolean; blocks?: BlockAnchor[] }[];
  scrollTop: number;
}

/** Blocks a reading anchor does not look inside: text runs, media and fences. */
const LEAF = 'p,h1,h2,h3,h4,h5,h6,pre,table,img,picture,video,canvas,svg,iframe,hr,math,.katex-display';
const MAX_DEPTH = 12;
/** Up to this many visible leaf blocks are sampled per tall row so a non-text block (such as a box-drawing table) falls through to the next prose block. */
const MAX_BLOCK_ANCHORS = 4;
const MAX_QUOTE_EXACT = 48;
const MIN_QUOTE_CHARS = 4;
/** Leading unordered bullet markers that TUI drafts keep in paragraph text while real Markdown moves them into `::marker`. */
const LEADING_BULLET = /^\s*[•·▪▸◦\-*+]\s+/;

/**
 * Binary-search the first index in [children] whose eligible in-flow element has `bottom > line`.
 * Children that are not laid out (`display: none`, e.g. `empty:hidden` notices whose rect is
 * `0,0,0,0` even when `line > 0`) or out-of-flow overlays have no valid flow position; skipping
 * them when picking a pivot preserves monotonicity without turning the lookup into a linear scan.
 */
function firstIndexPast(
  children: ArrayLike<Element>,
  line: number,
  measureBottom: (element: Element) => number | undefined,
): number {
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    let probe = middle;
    let bottom = measureBottom(children[probe]!);
    if (bottom === undefined) {
      let left = middle - 1;
      let right = middle + 1;
      while (left >= low || right < high) {
        if (left >= low) {
          bottom = measureBottom(children[left]!);
          if (bottom !== undefined) { probe = left; break; }
          left -= 1;
        }
        if (right < high) {
          bottom = measureBottom(children[right]!);
          if (bottom !== undefined) { probe = right; break; }
          right += 1;
        }
      }
      if (bottom === undefined) return high;
    }
    if (bottom <= line) low = probe + 1;
    else high = probe;
  }
  return low;
}

function measureFlowChildBottom(element: Element): number | undefined {
  const rect = element.getBoundingClientRect();
  if (rect.height === 0) return undefined;
  const style = getComputedStyle(element);
  if (style.position === 'absolute' || style.position === 'fixed') return undefined;
  return rect.bottom;
}

function measureRowBottom(element: Element): number | undefined {
  const row = element as HTMLElement;
  if (!row.dataset?.rowKey) return undefined;
  const rect = row.getBoundingClientRect();
  return rect.height > 0 ? rect.bottom : undefined;
}

/**
 * The innermost block of [row] at or just below [line] (a viewport y), before [limit]: down through
 * the first child whose bottom is past the line, until a leaf or a child laid out inline. Children
 * stack in block flow, so the first one past the line is found by bisecting their bottoms.
 */
function blockAt(row: Element, line: number, limit: number): Element | undefined {
  let block: Element | undefined;
  let parent = row;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const children = parent.children;
    const low = firstIndexPast(children, line, measureFlowChildBottom);
    let next: Element | undefined;
    for (let index = low; index < children.length; index += 1) {
      const child = children[index]!;
      const rect = child.getBoundingClientRect();
      if (rect.height === 0 || rect.bottom <= line) continue;
      if (rect.top >= limit) break;
      const style = getComputedStyle(child);
      if (style.position === 'absolute' || style.position === 'fixed') continue;
      // Inline content is part of its parent's text, which is the block.
      if (!style.display.startsWith('inline')) next = child;
      break;
    }
    if (!next) break;
    block = next;
    if (next.matches(LEAF)) break;
    parent = next;
  }
  return block;
}

function firstContentLine(text: string | null | undefined): string {
  if (!text) return '';
  for (const raw of text.split('\n')) {
    const cleaned = raw.replace(LEADING_BULLET, '').trim();
    if (cleaned) return cleaned;
  }
  return '';
}

function lastContentChars(text: string | null | undefined, limit: number): string {
  if (!text) return '';
  const cleaned = text.trim();
  return cleaned.length > limit ? cleaned.slice(-limit) : cleaned;
}

/** Visible leaf blocks of [row] from [top] downward, with lightweight per-block text quotes. */
function captureBlocks(row: Element, top: number, bottom: number): BlockAnchor[] | undefined {
  const entries: { element: Element; top: number; line: string }[] = [];
  let cursor = top;
  for (let count = 0; count < MAX_BLOCK_ANCHORS && cursor < bottom; count += 1) {
    const element = blockAt(row, cursor, bottom);
    if (!element || entries.some((entry) => entry.element === element)) break;
    const rect = element.getBoundingClientRect();
    entries.push({ element, top: rect.top - top, line: firstContentLine(element.textContent) });
    const next = Math.max(cursor + 1, rect.bottom + 1);
    if (next <= cursor) break;
    cursor = next;
  }
  if (!entries.length) return undefined;
  return entries.map((entry, index) => {
    if (entry.line.length < MIN_QUOTE_CHARS) return { element: entry.element, top: entry.top };
    const exact = entry.line.slice(0, MAX_QUOTE_EXACT);
    const rest = entry.line.slice(MAX_QUOTE_EXACT, MAX_QUOTE_EXACT + QUOTE_CONTEXT);
    const suffix = rest || (entries[index + 1]?.line.slice(0, QUOTE_CONTEXT) ?? '');
    const prefix = lastContentChars(entries[index - 1]?.element.textContent, QUOTE_CONTEXT);
    return { element: entry.element, top: entry.top, quote: { exact, prefix, suffix } };
  });
}

function closestBlock(node: Node, row: HTMLElement): Element | undefined {
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current && current !== row) {
    if (current.matches(LEAF) || current.tagName === 'LI') return current;
    const display = getComputedStyle(current).display;
    if (!display.startsWith('inline') && display !== 'contents') return current;
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Cold path: when a tall row was replaced or re-parsed so its old DOM nodes detached, locate one of
 * the saved visible blocks by text quote. Blocks whose top edge was inside the viewport go first so
 * height changes above the viewport edge (such as paragraphs turning into headings or lists) never
 * leak into the restored offset.
 */
function reanchorByQuote(row: HTMLElement, saved: ReadingAnchor['rows'][number]): number | undefined {
  const blocks = saved.blocks;
  if (!blocks?.length || row.querySelector(`[${TRANSCRIPT_ATTR.processOpen}="false"]`)) return undefined;
  const body = row.querySelector<HTMLElement>('[data-mark-ids], .md') ?? row;
  const bodyText = body.textContent ?? '';
  if (!bodyText) return undefined;
  const ordered = [...blocks.filter((block) => block.top >= -1), ...blocks.filter((block) => block.top < -1)];
  for (const candidate of ordered) {
    if (!candidate.quote) continue;
    const ratio = saved.height && saved.height > 0 ? Math.max(0, Math.min(1, (candidate.top - saved.top) / saved.height)) : 0;
    const hint = Math.round(bodyText.length * ratio);
    const found = findQuote(bodyText, { ...candidate.quote, start: hint, end: hint + candidate.quote.exact.length });
    if (!found) continue;
    const range = rangeAt(body, found.start, found.end);
    if (!range) continue;
    const matched = closestBlock(range.startContainer, row);
    if (matched?.closest(`[${TRANSCRIPT_ATTR.processOpen}="false"]`)) continue;
    const rect = (matched ?? range).getBoundingClientRect();
    if (rect.height === 0) continue;
    return rect.top - candidate.top;
  }
  return undefined;
}

/**
 * The transcript's rows in order: the dedicated `[data-transcript-rows]` list (falling back to the
 * content column for standalone callers). Rows stack top to bottom without sibling notices or
 * overlays, so their edges are monotonic and bisecting stays O(log N).
 */
function columnChildren(scroller: HTMLElement): HTMLCollection | undefined {
  return (
    scroller.querySelector(`:scope > * > [${TRANSCRIPT_ATTR.rows}]`)
    ?? scroller.querySelector(`[${TRANSCRIPT_ATTR.rows}]`)
    ?? scroller.querySelector(`:scope > [${TRANSCRIPT_ATTR.content}]`)
  )?.children;
}

/** The row with [key], without collecting every row first. */
export function findRow(scroller: HTMLElement, key: string): HTMLElement | undefined {
  return scroller.querySelector<HTMLElement>(`[${TRANSCRIPT_ATTR.rowKey}="${CSS.escape(key)}"]`) ?? undefined;
}

/** Deterministic turn-slot fallback when a provisional draft row is replaced by its committed row. */
function findRowBySlot(scroller: HTMLElement, slot: string): HTMLElement | undefined {
  return scroller.querySelector<HTMLElement>(`[${TRANSCRIPT_ATTR.rowSlot}="${CSS.escape(slot)}"]`) ?? undefined;
}

function resolveRow(scroller: HTMLElement, saved: Pick<ReadingAnchor['rows'][number], 'key' | 'slot'>): HTMLElement | undefined {
  return findRow(scroller, saved.key) ?? (saved.slot ? findRowBySlot(scroller, saved.slot) : undefined);
}

/**
 * [fallback] answers when no row is mounted at the viewport — a windowed list the reader just
 * jumped through, where the position is only known from the list's own index.
 */
export function captureReadingAnchor(scroller: HTMLElement, fallback?: () => ReadingAnchor | undefined): ReadingAnchor {
  const bounds = scroller.getBoundingClientRect();
  const children = columnChildren(scroller);
  const rows: ReadingAnchor['rows'] = [];
  if (!children) return { rows, scrollTop: scroller.scrollTop };
  const collectVisible = (startIndex: number) => {
    for (let index = startIndex; index < children.length; index += 1) {
      const row = children[index] as HTMLElement;
      if (!row.dataset?.rowKey) continue;
      const rect = row.getBoundingClientRect();
      if (rect.height === 0) continue;
      if (rect.bottom <= bounds.top) continue;
      if (rect.top >= bounds.bottom) break;
      const process = row.querySelector<HTMLElement>(`[${TRANSCRIPT_ATTR.processOpen}]`);
      const processCollapse = process?.querySelector<HTMLElement>(`:scope > [${TRANSCRIPT_ATTR.collapseState}]`);
      const processOpen = process
        ? process.getAttribute(TRANSCRIPT_ATTR.processOpen) === 'true'
          || (processCollapse !== null && processCollapse !== undefined && processCollapse.getAttribute(TRANSCRIPT_ATTR.collapseState) !== 'closed')
        : undefined;
      const foldingProcess = rect.top < bounds.top && process?.getAttribute(TRANSCRIPT_ATTR.processOpen) === 'false';
      // Only a row that starts above the view has something above the reader that could grow.
      const blocks = !rows.length && rect.top < bounds.top && !foldingProcess ? captureBlocks(row, bounds.top, bounds.bottom) : undefined;
      const slot = row.dataset.rowSlot;
      rows.push({
        key: row.dataset.rowKey,
        ...(slot ? { slot } : {}),
        top: rect.top - bounds.top,
        height: rect.height,
        ...(processOpen !== undefined ? { processOpen } : {}),
        ...(blocks ? { blocks } : {}),
      });
    }
  };
  // The first laid-out row whose bottom is below the viewport's top edge.
  const low = firstIndexPast(children, bounds.top, measureRowBottom);
  // Capture every row visible in the viewport (binary-searched from the top edge, stopped at the
  // bottom edge) so a folding process block and the prose row below it are never missed behind
  // several short rows at the top of the screen.
  collectVisible(low);
  // Invariant guard: if bisection ever returned empty while rows exist above `low` (for example
  // from unexpected non-monotonic layout), fall back to a linear pass instead of silently dropping
  // the reading anchor. Skip the scan when the reader has genuinely scrolled past the last row
  // (e.g. viewing a tall interaction card below `[data-transcript-rows]`).
  if (!rows.length && low > 0) {
    let pastLastRow = false;
    if (low === children.length) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const bottom = measureRowBottom(children[index]!);
        if (bottom !== undefined) { pastLastRow = bottom <= bounds.top; break; }
      }
    }
    if (!pastLastRow) {
      collectVisible(0);
      if (rows.length && import.meta.env?.DEV) {
        console.warn('[riffet] captureReadingAnchor bisection missed visible rows; recovered via linear scan', { low, count: children.length });
      }
    }
  }
  if (!rows.length) return fallback?.() ?? { rows, scrollTop: scroller.scrollTop };
  return { rows, scrollTop: scroller.scrollTop };
}

/**
 * [locate] gives the content-space top of a row that is not mounted, for a windowed list: the
 * anchor still names where the reader was, and the list's index knows where that row would be.
 * Undefined when none of the anchor's rows is left anywhere: what the reader was reading is gone.
 */
export function readingAnchorTop(scroller: HTMLElement, anchor: ReadingAnchor, locate?: (key: string) => number | undefined): number | undefined {
  const bounds = scroller.getBoundingClientRect();
  const targetOf = (saved: ReadingAnchor['rows'][number], row: HTMLElement) => {
    // Hot path: keep the exact DOM block while still connected; cold path re-locates by text quote
    // when a draft row is replaced or Markdown re-parses the message, then falls back to the row.
    const primary = saved.blocks?.[0];
    const connected = primary && primary.element.isConnected && row.contains(primary.element) && !primary.element.closest(`[${TRANSCRIPT_ATTR.processOpen}="false"]`) ? primary : undefined;
    const top = connected
      ? connected.element.getBoundingClientRect().top - connected.top
      : (reanchorByQuote(row, saved) ?? (row.getBoundingClientRect().top - saved.top));
    return scroller.scrollTop + top - bounds.top;
  };
  // When an automatically folding process block sits above visible prose (even if the prompt or
  // process header is still visible near the top of the viewport), prefer anchoring on the prose
  // row below it, clamping to 0 rather than falling back to the folding process header itself.
  for (let index = 0; index + 1 < anchor.rows.length; index += 1) {
    const saved = anchor.rows[index]!;
    if (!saved.processOpen) continue;
    const row = resolveRow(scroller, saved);
    if (!row?.querySelector(`[${TRANSCRIPT_ATTR.processOpen}="false"]`)) continue;
    for (let next = index + 1; next < anchor.rows.length; next += 1) {
      const below = anchor.rows[next]!;
      const belowRow = resolveRow(scroller, below);
      if (!belowRow) continue;
      return Math.max(0, targetOf(below, belowRow));
    }
  }
  let foldedTop: number | undefined;
  for (let index = 0; index < anchor.rows.length; index += 1) {
    const saved = anchor.rows[index]!;
    const row = resolveRow(scroller, saved);
    if (!row) continue;
    // A process block that was open (or mid-fold) when captured, whose header is above the viewport
    // and that has now folded away, collapses into that off-screen header; the row below it is what
    // remains stable on screen for the reader.
    if (saved.top < 0 && saved.processOpen && row.querySelector(`[${TRANSCRIPT_ATTR.processOpen}="false"]`)) {
      foldedTop ??= scroller.scrollTop + row.getBoundingClientRect().top - bounds.top;
      if (index + 1 < anchor.rows.length) continue;
      return foldedTop;
    }
    return targetOf(saved, row);
  }
  if (foldedTop !== undefined) return foldedTop;
  const first = anchor.rows[0];
  const at = first && locate ? locate(first.key) : undefined;
  return at !== undefined ? at - first!.top : undefined;
}
