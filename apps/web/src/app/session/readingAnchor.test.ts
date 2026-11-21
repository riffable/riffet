import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canReleaseDeferredProcessFold,
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
  it('defers folding when a non-following reader views prose below with insufficient scroll room', () => {
    expect(decideProcessFold(metrics({ scrollTop: 0, boxTop: 100, boxBottom: 648 }))).toBe('defer');
    expect(decideProcessFold(metrics({ scrollTop: 300, boxTop: -200, boxBottom: 348 }))).toBe('defer');
    expect(decideProcessFold(metrics({ scrollTop: 519, boxTop: -419, boxBottom: 129 }))).toBe('defer');
  });

  it('folds synchronously as soon as scrollTop can absorb the exact collapsible height', () => {
    expect(decideProcessFold(metrics({ scrollTop: 520, boxTop: -420, boxBottom: 128 }))).toBe('instant');
    expect(decideProcessFold(metrics({ scrollTop: 1200, boxTop: -1100, boxBottom: -552 }))).toBe('instant');
  });

  it('animates when following a short turn or when the process fills the rest of the viewport', () => {
    expect(decideProcessFold(metrics({ following: true, scrollTop: 200, boxTop: -100, boxBottom: 448 }))).toBe('animate');
    expect(decideProcessFold(metrics({ following: false, scrollTop: 0, boxTop: 100, boxBottom: 900 }))).toBe('animate');
  });

  it('always lands deferred folds off-screen as an instant single-commit fold', () => {
    const cases: ProcessFoldMetrics[] = [
      metrics({ scrollTop: 300, boxTop: -200, boxBottom: 348 }),
      metrics({ scrollTop: 520, boxTop: -420, boxBottom: 128 }),
      metrics({ scrollTop: 650, boxTop: -550, boxBottom: 0 }),
      metrics({ scrollTop: 900, boxTop: -800, boxBottom: -252 }),
      metrics({ scrollTop: 0, boxTop: 900, boxBottom: 1448 }),
    ];
    expect(canReleaseDeferredProcessFold(cases[0]!)).toBe(false);
    expect(canReleaseDeferredProcessFold(cases[1]!)).toBe(false);
    expect(canReleaseDeferredProcessFold(cases[2]!)).toBe(true);
    expect(canReleaseDeferredProcessFold(cases[3]!)).toBe(true);
    expect(canReleaseDeferredProcessFold(cases[4]!)).toBe(true);
    for (const sample of cases) {
      if (canReleaseDeferredProcessFold(sample)) {
        expect(decideProcessFold(sample)).toBe('instant');
      }
    }
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
});
