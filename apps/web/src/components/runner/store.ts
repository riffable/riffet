import { createStore, useStore } from '@/lib/store';

/**
 * Whether 黑马跑酷 is out beside the composer: opened from the palette, closed with Escape, its close
 * button, or when the room beside the composer runs out. Kept for the tab only; nothing about the
 * game is saved but the best score.
 */
const runner = createStore({ open: false });

/** Opens the strip and gives it the keys once it has drawn. */
export const openRunner = () => {
  runner.set({ open: true });
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-runner]')?.focus({ preventScroll: true })));
};
export const closeRunner = () => runner.set({ open: false });
export const useRunnerOpen = () => useStore(runner, (state) => state.open);
