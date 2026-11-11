import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { createStore, useStore } from './store';
import { readStored, writeStored } from './utils';

/**
 * The brand mark on a 24-unit grid: the mane, drawn first with a 0.6 round-join stroke, then the
 * horse's head with a 1 stroke, the eye a hole in it. Copied from `scripts/gen-brand.ts`, which
 * draws every shipped icon file from the same geometry. The mark's optical centre is (12.6, 11.8),
 * not the grid's, so a 24-unit box that shows it centred starts at `BRAND_VIEWBOX`.
 */
export const BRAND_MANE = 'M8.77 6.2Q6.51 6.56 5.15 8.55L7.76 8.17Q5.43 9.17 4.26 11.65L6.94 10.68Q4.72 12.24 3.82 15.1L6.42 13.42Z';
export const BRAND_BODY = 'M6 21C5.6 14.4 6.6 9 8.8 5.8L9.4 2.6L11.2 5.4C14.4 6.6 17.4 8.4 20 10.8c1.3 1.2 0.7 3.4 -1 3.4c-1.4 0 -3 -0.3 -4.4 -0.6c-1.4 -0.3 -2.3 0.3 -2.4 1.6c-0.1 2 0.2 4 0.8 5.8Z';
/** Appended to `BRAND_BODY` and filled even-odd, the eye is a hole. */
export const BRAND_EYE = 'M11.5 8.2a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z';
export const BRAND_VIEWBOX = '0.6 -0.2 24 24';
/** The mark's scale in a 32-unit tile (favicon, picker): the horse is 64% of the tile tall. */
export const BRAND_TILE_TRANSFORM = 'translate(2.64 3.49) scale(1.06)';

/**
 * The app-icon accents of `scripts/gen-brand.ts`, on the dark tile. The ids are shared with the
 * macOS, iOS and Android pickers; each device chooses for itself, like the theme. In the browser the
 * choice reaches the tab icon only: an installed web app keeps the manifest's icon.
 */
export const appIcons = [
  { id: 'blue', get name() { return i18n._(msg`蓝色`); }, accent: '#5b8cff' },
  { id: 'purple', get name() { return i18n._(msg`紫色`); }, accent: '#a78bfa' },
  { id: 'magenta', get name() { return i18n._(msg`品红`); }, accent: '#e879f9' },
  { id: 'pink', get name() { return i18n._(msg`粉色`); }, accent: '#f472b6' },
  { id: 'red', get name() { return i18n._(msg`红色`); }, accent: '#f87171' },
  { id: 'orange', get name() { return i18n._(msg`橙色`); }, accent: '#f5a142' },
  { id: 'yellow', get name() { return i18n._(msg`黄色`); }, accent: '#facc15' },
  { id: 'lime', get name() { return i18n._(msg`青柠`); }, accent: '#a3e635' },
  { id: 'green', get name() { return i18n._(msg`绿色`); }, accent: '#3fcf8e' },
  { id: 'cyan', get name() { return i18n._(msg`青色`); }, accent: '#22d3ee' },
  { id: 'graphite', get name() { return i18n._(msg`石墨`); }, accent: '#9aa0a8' },
  { id: 'white', get name() { return i18n._(msg`白色`); }, accent: '#f4f4f2' },
] as const;

export type AppIconId = (typeof appIcons)[number]['id'];

/** The icon's fixed colours, whatever the page theme: it is a picture of the app icon. */
export const APP_ICON_TILE = { tile: '#15171a', front: '#ffffff' } as const;

const KEY = 'riffet.app-icon';
const DEFAULT_ICON: AppIconId = 'blue';

const parse = (raw: string): AppIconId => appIcons.find((icon) => icon.id === raw)?.id ?? DEFAULT_ICON;

const store = createStore<{ id: AppIconId }>({ id: parse(readStored(KEY)) });

/** `public/favicon.svg` with another accent on the mane. */
function faviconSvg(accent: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${APP_ICON_TILE.tile}"/>`
    + `<g transform="${BRAND_TILE_TRANSFORM}"><path d="${BRAND_MANE}" fill="${accent}" stroke="${accent}" stroke-width=".6" stroke-linejoin="round"/>`
    + `<path d="${BRAND_BODY}${BRAND_EYE}" fill="${APP_ICON_TILE.front}" fill-rule="evenodd"/>`
    + `<path d="${BRAND_BODY}" fill="none" stroke="${APP_ICON_TILE.front}" stroke-linejoin="round"/></g></svg>`;
}

/**
 * The default keeps the static file; another accent becomes a data: URL, which also stays clear of
 * the service worker's cache-first `/favicon.svg`.
 */
function apply(): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const icon = appIcons.find((entry) => entry.id === store.get().id);
  if (!link || !icon) return;
  link.href = icon.id === DEFAULT_ICON ? '/favicon.svg' : `data:image/svg+xml,${encodeURIComponent(faviconSvg(icon.accent))}`;
}

export function setAppIcon(id: AppIconId): void {
  writeStored(KEY, id === DEFAULT_ICON ? undefined : id);
  store.set({ id });
  apply();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== KEY && event.key !== null) return;
  store.set({ id: parse(readStored(KEY)) });
  apply();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onStorage);
  apply();
}
import.meta.hot?.dispose(() => {
  window.removeEventListener('storage', onStorage);
});

export function useAppIcon(): AppIconId {
  return useStore(store, (state) => state.id);
}
