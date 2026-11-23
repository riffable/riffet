import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canReleaseDeferredProcessFold,
  captureReadingAnchor,
  decideProcessFold,
  readingAnchorTop,
  TRANSCRIPT_ATTR,
  type ProcessFoldMetrics,
  type ReadingAnchor,
} from './readingAnchor';

const metrics = (overrides: Partial<ProcessFoldMetrics> = {}): ProcessFoldMetrics => ({
  following: false,
  scrollTop: 300,
  collapsible: 520,
  boxTop: -200,
  boxBottom: 348,
  viewTop: 0,
  viewBottom: 800,
  ...overrides,
});

describe('process auto-fold policy invariants', () => {
  it('defers folding whenever an off-bottom reader views prose below or alongside the process block', () => {
    expect(decideProcessFold(metrics({ scrollTop: 0, boxTop: 100, boxBottom: 648 }))).toBe('defer');
    expect(decideProcessFold(metrics({ scrollTop: 300, boxTop: -200, boxBottom: 348 }))).toBe('defer');
    expect(decideProcessFold(metrics({ scrollTop: 519, boxTop: -419, boxBottom: 129 }))).toBe('defer');
    expect(decideProcessFold(metrics({ scrollTop: 1200, boxTop: -1100, boxBottom: -552 }))).toBe('defer');
  });

  it('folds synchronously when off-screen below or when following with enough scroll headroom', () => {
    expect(decideProcessFold(metrics({ following: false, scrollTop: 0, boxTop: 900, boxBottom: 1448 }))).toBe('instant');
    expect(decideProcessFold(metrics({ following: true, scrollTop: 520, boxTop: -420, boxBottom: 128 }))).toBe('instant');
    expect(decideProcessFold(metrics({ following: true, scrollTop: 1200, boxTop: -1100, boxBottom: -552 }))).toBe('instant');
  });

  it('animates when following a short turn or when the process fills the rest of the viewport', () => {
    expect(decideProcessFold(metrics({ following: true, scrollTop: 200, boxTop: -100, boxBottom: 448 }))).toBe('animate');
    expect(decideProcessFold(metrics({ following: false, scrollTop: 0, boxTop: 100, boxBottom: 900 }))).toBe('animate');
    expect(decideProcessFold(metrics({ following: false, scrollTop: 1200, boxTop: -100, boxBottom: 900 }))).toBe('animate');
  });

  it('releases deferred folds only once the block moves below the viewport or the reader returns to following', () => {
    const cases: ProcessFoldMetrics[] = [
      metrics({ following: false, scrollTop: 300, boxTop: -200, boxBottom: 348 }),
      metrics({ following: false, scrollTop: 900, boxTop: -800, boxBottom: -252 }),
      metrics({ following: false, scrollTop: 0, boxTop: 900, boxBottom: 1448 }),
      metrics({ following: true, scrollTop: 900, boxTop: -800, boxBottom: -252 }),
      metrics({ following: true, scrollTop: 200, boxTop: -100, boxBottom: 448 }),
    ];
    expect(canReleaseDeferredProcessFold(cases[0]!)).toBe(false);
    expect(canReleaseDeferredProcessFold(cases[1]!)).toBe(false);
    expect(canReleaseDeferredProcessFold(cases[2]!)).toBe(true);
    expect(canReleaseDeferredProcessFold(cases[3]!)).toBe(true);
    expect(canReleaseDeferredProcessFold(cases[4]!)).toBe(true);
    // An off-bottom release is always off-screen below, so it lands synchronously with 0px impact.
    expect(decideProcessFold(cases[2]!)).toBe('instant');
  });
});

interface StubRow {
  key: string;
  slot?: string;
  top: number;
  height: number;
  processClosed?: boolean;
}

function makeScroller(scrollTop: number, rows: StubRow[]): HTMLElement {
  const rowElements = rows.map((row) => ({
    dataset: { rowKey: row.key, ...(row.slot ? { rowSlot: row.slot } : {}) },
    getBoundingClientRect: () => ({ top: row.top, bottom: row.top + row.height, height: row.height }),
    querySelector: (selector: string) =>
      row.processClosed && selector === `[${TRANSCRIPT_ATTR.processOpen}="false"]` ? ({} as Element) : null,
    contains: () => false,
  }));
  return {
    scrollTop,
    getBoundingClientRect: () => ({ top: 0, bottom: 800, height: 800 }),
    querySelector: (selector: string) => {
      const keyMatch = new RegExp(`^\\[${TRANSCRIPT_ATTR.rowKey}="(.+)"\\]$`).exec(selector);
      if (keyMatch) return rowElements.find((row) => row.dataset.rowKey === keyMatch[1]) ?? null;
      const slotMatch = new RegExp(`^\\[${TRANSCRIPT_ATTR.rowSlot}="(.+)"\\]$`).exec(selector);
      if (slotMatch) return rowElements.find((row) => row.dataset.rowSlot === slotMatch[1]) ?? null;
      return null;
    },
  } as unknown as HTMLElement;
}

describe('readingAnchorTop folding invariants', () => {
  const originalCSS = globalThis.CSS;
  beforeAll(() => {
    if (!globalThis.CSS?.escape) {
      Object.defineProperty(globalThis, 'CSS', { value: { escape: (value: string) => value }, configurable: true });
    }
  });
  afterAll(() => {
    if (originalCSS === undefined) delete (globalThis as { CSS?: unknown }).CSS;
    else Object.defineProperty(globalThis, 'CSS', { value: originalCSS, configurable: true });
  });

  it('compensates the exact fold height to keep visible prose stationary', () => {
    const anchor: ReadingAnchor = {
      scrollTop: 900,
      rows: [
        { key: 'turn-process:run:1', top: -800, height: 548, processOpen: true },
        { key: 'event:57:1', top: 120, height: 2200 },
      ],
    };
    const scroller = makeScroller(900, [
      { key: 'turn-process:run:1', top: -800, height: 28, processClosed: true },
      { key: 'event:57:1', top: -400, height: 2200 },
    ]);
    expect(readingAnchorTop(scroller, anchor)).toBe(380);
  });

  it('clamps to 0 instead of falling back to a folding in-viewport process header on underflow', () => {
    const anchor: ReadingAnchor = {
      scrollTop: 80,
      rows: [
        { key: 'turn-process:run:1', top: 20, height: 548, processOpen: true },
        { key: 'event:57:1', top: 568, height: 2200 },
      ],
    };
    const scroller = makeScroller(80, [
      { key: 'turn-process:run:1', top: 20, height: 28, processClosed: true },
      { key: 'event:57:1', top: 48, height: 2200 },
    ]);
    expect(readingAnchorTop(scroller, anchor)).toBe(0);
  });

  it('keeps anchor continuity via turn-scoped slot when a live draft row is replaced', () => {
    const anchor: ReadingAnchor = {
      scrollTop: 1200,
      rows: [
        { key: 'event:claude-live:1', slot: 'turn:1:assistant:0', top: -300, height: 1500 },
      ],
    };
    const scroller = makeScroller(1200, [
      { key: 'event:final:1', slot: 'turn:1:assistant:0', top: -820, height: 1500 },
    ]);
    expect(readingAnchorTop(scroller, anchor)).toBe(680);
  });

  it('captures the latest reply row even when display:none trailing notices sit after it', () => {
    const makeEl = (rect: { top: number; bottom: number; height: number }, rowKey?: string) => ({
      dataset: rowKey ? { rowKey } : {},
      children: [],
      getBoundingClientRect: () => rect,
      querySelector: () => null,
    });
    const hiddenNotice = () => makeEl({ top: 0, bottom: 0, height: 0 });
    // Exact Workbench column shape: 2 hidden notices at top, 40 rows, 1 hidden FeedbackNotice
    // after the last row (index 42, rect 0,0,0,0 <= bounds.top=60), and 1 trailing spacer.
    const children = [
      hiddenNotice(),
      hiddenNotice(),
      ...Array.from({ length: 39 }, (_, i) => makeEl({ top: -18000 + i * 400, bottom: -17600 + i * 400, height: 400 }, `row:${i}`)),
      makeEl({ top: -580, bottom: 2062, height: 2642 }, 'event:333:1'),
      hiddenNotice(),
      makeEl({ top: 2062, bottom: 2062, height: 0 }),
    ];
    const column = { children };
    const scroller = {
      scrollTop: 16694,
      getBoundingClientRect: () => ({ top: 60, bottom: 768, height: 708 }),
      querySelector: (selector: string) => selector === `:scope > [${TRANSCRIPT_ATTR.content}]` ? column : null,
    } as unknown as HTMLElement;

    const anchor = captureReadingAnchor(scroller);
    expect(anchor.rows.map((r) => r.key)).toEqual(['event:333:1']);
    expect(anchor.rows[0]?.top).toBe(-640);
  });

  it('reads from the dedicated [data-transcript-rows] container isolated from sibling notices', () => {
    const makeEl = (rect: { top: number; bottom: number; height: number }, rowKey?: string) => ({
      dataset: rowKey ? { rowKey } : {},
      children: [],
      getBoundingClientRect: () => rect,
      querySelector: () => null,
    });
    const rowsContainer = {
      children: [
        makeEl({ top: -1200, bottom: -800, height: 400 }, 'row:0'),
        makeEl({ top: -580, bottom: 2062, height: 2642 }, 'event:333:1'),
      ],
    };
    const scroller = {
      scrollTop: 16694,
      getBoundingClientRect: () => ({ top: 60, bottom: 768, height: 708 }),
      querySelector: (selector: string) => selector === `[${TRANSCRIPT_ATTR.rows}]` ? rowsContainer : null,
    } as unknown as HTMLElement;

    const anchor = captureReadingAnchor(scroller);
    expect(anchor.rows.map((r) => r.key)).toEqual(['event:333:1']);
    expect(anchor.rows[0]?.top).toBe(-640);
  });
});
