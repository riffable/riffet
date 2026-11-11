import { createStore, useStore } from './store';
import { readStored, writeStored } from './utils';

/**
 * Reading width for the session column, kept on this device only — the same stance `display-settings`
 * takes, because one browser's window is not another's business.
 *
 * DeepSeek Harness is the reference for the gesture (a hover-revealed vertical bar beside the
 * transcript that is dragged left and right) and for the shape of the preference: one stored pixel
 * value, clamped on read rather than trusted, published as a CSS custom property so the layout never
 * re-renders while the pointer moves.
 */
const KEY = 'riffet.contentWidth';

/** The 920px column the session surfaces shipped with, now only the default. */
export const DEFAULT_CONTENT_WIDTH = 920;
/** Below this the transcript stops being prose; the value matches the reference's floor. */
export const MIN_CONTENT_WIDTH = 640;
/** Wide enough for a large display, narrow enough that a saved value stays a preference, not a layout. */
export const MAX_CONTENT_WIDTH = 1600;

export const contentWidthVar = '--content-width';

export function clampContentWidth(width: number): number {
  return Math.min(MAX_CONTENT_WIDTH, Math.max(MIN_CONTENT_WIDTH, Math.round(width)));
}

/**
 * Rebuild the preference from storage. Anything unrecognised — an older build's value, a
 * hand-edited one, a zero from a division gone wrong — falls back rather than throwing: a
 * width preference must never be able to break opening the workbench.
 */
export function parseContentWidth(raw: string): number {
  if (!raw) return DEFAULT_CONTENT_WIDTH;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? clampContentWidth(value) : DEFAULT_CONTENT_WIDTH;
}

const store = createStore({ width: parseContentWidth(readStored(KEY)) });

/**
 * Applied to the root element, never to a component: `--content-width` caps every session column at
 * once — transcript, composer, terminal drawer — so they can never disagree about the column they
 * share. A container narrower than the preference still wins, because the columns also carry
 * `w-full`: the stored value caps, it does not force.
 */
function apply(width: number): void {
  store.set({ width });
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(contentWidthVar, `${width}px`);
}

/**
 * Move the column now, persist later. A drag fires once per animation frame, and a preference is
 * only worth writing when the pointer is released — `localStorage` on every frame would turn a
 * gesture into a synchronous disk write.
 */
export function previewContentWidth(next: number): void {
  const clamped = clampContentWidth(next);
  if (clamped === store.get().width) return;
  apply(clamped);
}

/** Persist a width: the drag's release, or a programmatic change. */
export function setContentWidth(next: number): void {
  const clamped = clampContentWidth(next);
  writeStored(KEY, String(clamped));
  if (clamped === store.get().width) return;
  apply(clamped);
}

/** Abandon an uncommitted drag and go back to what was saved (the pointer was cancelled). */
export function discardContentWidthPreview(): void {
  const stored = parseContentWidth(readStored(KEY));
  if (stored === store.get().width) return;
  apply(stored);
}

/** Drop the preference and return to the shipped column width. */
export function resetContentWidth(): void {
  writeStored(KEY, undefined);
  if (store.get().width === DEFAULT_CONTENT_WIDTH) return;
  apply(DEFAULT_CONTENT_WIDTH);
}

/** Another tab's drag, so two windows on one machine do not disagree about the column. */
function onStorage(event: StorageEvent): void {
  if (event.key !== KEY && event.key !== null) return;
  apply(parseContentWidth(readStored(KEY)));
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onStorage);
  apply(store.get().width);
}
import.meta.hot?.dispose(() => {
  window.removeEventListener('storage', onStorage);
});

export function useContentWidth(): number {
  return useStore(store, (state) => state.width);
}
