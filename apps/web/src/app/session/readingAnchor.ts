/**
 * A semantic reading position survives prepends, message updates and delayed image layout. The row
 * at the top of the view also names the block inside it there (a paragraph, a picture, a fence), so
 * a picture or a formula growing earlier in the same long message does not move the words being read.
 */
export interface ReadingAnchor {
  rows: { key: string; top: number; processOpen?: boolean; block?: { element: Element; top: number } }[];
  scrollTop: number;
}

/** Blocks a reading anchor does not look inside: text runs, media and fences. */
const LEAF = 'p,h1,h2,h3,h4,h5,h6,pre,table,img,picture,video,canvas,svg,iframe,hr,math,.katex-display';
const MAX_DEPTH = 12;

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
    const block = !rows.length && rect.top < bounds.top && !foldingProcess ? blockAt(row, bounds.top, bounds.bottom) : undefined;
    rows.push({
      key: row.dataset.rowKey,
      top: rect.top - bounds.top,
      ...(processOpen !== undefined ? { processOpen } : {}),
      ...(block ? { block: { element: block, top: block.getBoundingClientRect().top - bounds.top } } : {}),
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
    // The block, while the row still holds it; a re-rendered message falls back to the row.
    const block = saved.block && saved.block.element.isConnected && row.contains(saved.block.element) && !saved.block.element.closest('[data-process-open="false"]') ? saved.block : undefined;
    const top = block ? block.element.getBoundingClientRect().top - block.top : row.getBoundingClientRect().top - saved.top;
    return scroller.scrollTop + top - bounds.top;
  };
  // When an automatically folding process block sits above visible prose (even if the prompt or
  // process header is still visible near the top of the viewport), prefer anchoring on the prose
  // row below it whenever there is room above to absorb the collapse.
  for (let index = 0; index + 1 < anchor.rows.length; index += 1) {
    const saved = anchor.rows[index]!;
    if (!saved.processOpen) continue;
    const row = findRow(scroller, saved.key);
    if (!row?.querySelector('[data-process-open="false"]')) continue;
    for (let next = index + 1; next < anchor.rows.length; next += 1) {
      const below = anchor.rows[next]!;
      const belowRow = findRow(scroller, below.key);
      if (!belowRow) continue;
      const target = targetOf(below, belowRow);
      if (target >= -0.5) return Math.max(0, target);
      break;
    }
  }
  let foldedTop: number | undefined;
  for (let index = 0; index < anchor.rows.length; index += 1) {
    const saved = anchor.rows[index]!;
    const row = findRow(scroller, saved.key);
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
