import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { createStore, useStore } from './store';
import { readStored, writeStored } from './utils';
import { BRAND_BODY, BRAND_EYE, BRAND_TILE_TRANSFORM, BRAND_MANE } from './brand-geometry';

export { BRAND_BODY, BRAND_EYE, BRAND_MANE, BRAND_TEETH, BRAND_TILE_TRANSFORM, BRAND_VIEWBOX } from './brand-geometry';


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
