import { findQuote, QUOTE_CONTEXT, rangeAt } from './textQuote';

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
 * The innermost block of [row] at or just below [line] (a viewport y), before [limit]: down through
 * the first child whose bottom is past the line, until a leaf or a child laid out inline. Children
 * stack in block flow, so the first one past the line is found by bisecting their bottoms.
 */
function blockAt(row: Element, line: number, limit: number): Element | undefined {
  let block: Element | undefined;
  let parent = row;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const children = parent.children;
    let low = 0;
    let high = children.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (children[middle]!.getBoundingClientRect().bottom <= line) low = middle + 1;
      else high = middle;
    }
    let next: Element | undefined;
    for (let index = low; index < children.length; index += 1) {
      const child = children[index]!;
      const rect = child.getBoundingClientRect();
      if (rect.top >= limit) break;
      if (rect.height === 0 || rect.bottom <= line) continue;
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
  if (!blocks?.length || row.querySelector('[data-process-open="false"]')) return undefined;
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
    if (matched?.closest('[data-process-open="false"]')) continue;
    const rect = (matched ?? range).getBoundingClientRect();
    if (rect.height === 0) continue;
    return rect.top - candidate.top;
  }
  return undefined;
}

/**
 * The transcript's rows in order: the column's direct children, of which the rows are the ones
 * carrying a key. They stack top to bottom, so their edges only grow, which is what lets a lookup
 * bisect them instead of measuring every one from the first.
 */
function columnChildren(scroller: HTMLElement): HTMLCollection | undefined {
  return scroller.querySelector(':scope > [data-content-column]')?.children;
}

/** The row with [key], without collecting every row first. */
export function findRow(scroller: HTMLElement, key: string): HTMLElement | undefined {
  return scroller.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`) ?? undefined;
}

/** Deterministic turn-slot fallback when a provisional draft row is replaced by its committed row. */
function findRowBySlot(scroller: HTMLElement, slot: string): HTMLElement | undefined {
  return scroller.querySelector<HTMLElement>(`[data-row-slot="${CSS.escape(slot)}"]`) ?? undefined;
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
  // The first child whose bottom is below the viewport's top edge.
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (children[middle]!.getBoundingClientRect().bottom <= bounds.top) low = middle + 1;
    else high = middle;
  }
  // Capture every row visible in the viewport (binary-searched from the top edge, stopped at the
  // bottom edge) so a folding process block and the prose row below it are never missed behind
  // several short rows at the top of the screen.
  for (let index = low; index < children.length; index += 1) {
    const row = children[index] as HTMLElement;
    const rect = row.getBoundingClientRect();
    if (rect.top >= bounds.bottom) break;
    if (rect.height === 0 || !row.dataset.rowKey) continue;
    const process = row.querySelector<HTMLElement>('[data-process-open]');
    const processCollapse = process?.querySelector<HTMLElement>(':scope > [data-collapse-state]');
    const processOpen = process
      ? process.getAttribute('data-process-open') === 'true'
        || (processCollapse !== null && processCollapse !== undefined && processCollapse.dataset.collapseState !== 'closed')
      : undefined;
    const foldingProcess = rect.top < bounds.top && process?.getAttribute('data-process-open') === 'false';
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
  if (!rows.length) return fallback?.() ?? { rows, scrollTop: scroller.scrollTop };
  return { rows, scrollTop: scroller.scrollTop };
}

/**
 * [locate] gives the content-space top of a row that is not mounted, for a windowed list: the
 * anchor still names where the reader was, and the list's index knows where that row would be.
 */
export function readingAnchorTop(scroller: HTMLElement, anchor: ReadingAnchor, locate?: (key: string) => number | undefined): number {
  const bounds = scroller.getBoundingClientRect();
  const targetOf = (saved: ReadingAnchor['rows'][number], row: HTMLElement) => {
    // Hot path: keep the exact DOM block while still connected; cold path re-locates by text quote
    // when a draft row is replaced or Markdown re-parses the message, then falls back to the row.
    const primary = saved.blocks?.[0];
    const connected = primary && primary.element.isConnected && row.contains(primary.element) && !primary.element.closest('[data-process-open="false"]') ? primary : undefined;
    const top = connected
      ? connected.element.getBoundingClientRect().top - connected.top
      : (reanchorByQuote(row, saved) ?? (row.getBoundingClientRect().top - saved.top));
    return scroller.scrollTop + top - bounds.top;
  };
  // When an automatically folding process block sits above visible prose (even if the prompt or
  // process header is still visible near the top of the viewport), prefer anchoring on the prose
  // row below it whenever there is room above to absorb the collapse.
  for (let index = 0; index + 1 < anchor.rows.length; index += 1) {
    const saved = anchor.rows[index]!;
    if (!saved.processOpen) continue;
    const row = resolveRow(scroller, saved);
    if (!row?.querySelector('[data-process-open="false"]')) continue;
    for (let next = index + 1; next < anchor.rows.length; next += 1) {
      const below = anchor.rows[next]!;
      const belowRow = resolveRow(scroller, below);
      if (!belowRow) continue;
      const target = targetOf(below, belowRow);
      if (target >= -0.5) return Math.max(0, target);
      break;
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
    if (saved.top < 0 && saved.processOpen && row.querySelector('[data-process-open="false"]')) {
      foldedTop ??= scroller.scrollTop + row.getBoundingClientRect().top - bounds.top;
      if (index + 1 < anchor.rows.length) continue;
      return foldedTop;
    }
    return targetOf(saved, row);
  }
  if (foldedTop !== undefined) return foldedTop;
  const first = anchor.rows[0];
  const at = first && locate ? locate(first.key) : undefined;
  return at !== undefined ? at - first!.top : anchor.scrollTop;
}
