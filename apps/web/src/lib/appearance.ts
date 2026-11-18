/**
 * Plugin appearance on this device (docs/THEMES.md "插件外观"): the catalog of what the enabled
 * plugins contribute, the device's selection, and the three ways it reaches the page.
 *
 * - A palette is painted through the same path custom themes use: a stylesheet block per
 *   `[data-theme="plugin-<hash>"]`, so `ThemeSwatch` and the terminal need no second mechanism.
 * - A font is loaded with `FontFace` from its content-addressed url and put on the existing
 *   `--font-sans` / `--font-mono` variables, ahead of the host's own stack.
 * - A background is a layer the workbench draws (`components/appearance-backdrop.tsx`).
 *
 * The selection never touches the built-in/custom theme choice in `lib/theme.ts`: with the plugin
 * palette out of effect the theme the user picked shows again. Like the theme library, the catalog
 * is cached for the first frame and the network only ever corrects it; a failed fetch keeps both
 * the cache and the selection.
 */

import { useSyncExternalStore } from 'react';
import {
  APPEARANCE_DEFAULT, validateCustomThemes,
  type AppearanceBackground, type AppearanceCatalog, type AppearanceFont, type AppearancePalette, type AppearanceSelection, type CustomCodeSyntax, type ThemeAnsi, type ThemeDesign, type ThemePalette,
} from '@contracts';
import { api } from './api';
import { effectiveAppearance, fontStack, paletteKey, parseSelection, type EffectiveAppearance } from './appearance-select';
import { APPEARANCE_PRUNE_MESSAGE } from './service-worker-strategy';
import { customThemeCss } from './theme-palette';
import { readStored, writeStored } from './utils';

const SELECTION_KEY = 'riffet.appearance.selection';
const CACHE_KEY = 'riffet.appearance.cache.v1';
/** Read by `public/theme-init.js` for the first frame: the palette in effect, as the sheet needs it. */
const FIRST_FRAME_KEY = 'riffet.appearance.palette.v1';
const STYLE_ID = 'riffet-plugin-themes';
/** The page of a frozen share has no workbench to decorate. */
const inert = import.meta.env.MODE === 'share';

interface PaletteData { palette: { light: ThemePalette; dark: ThemePalette }; ansi: ThemeAnsi; design?: ThemeDesign; syntax?: CustomCodeSyntax }
interface State { selection: AppearanceSelection; catalog?: AppearanceCatalog; palettes: Record<string, PaletteData> }

/** The painted palette in effect: what the theme runtime reads to paint, key caches and colour the terminal. */
export interface PluginPalette { key: string; revision: string; ansi: ThemeAnsi; hasSyntax?: boolean }

const listeners = new Set<() => void>();
let state: State = inert ? { selection: {}, palettes: {} } : readCache();
let effective: EffectiveAppearance = effectiveAppearance(state.selection, state.catalog);
let plugin: PluginPalette | undefined;
let background: AppearanceBackground | undefined;

function isCatalog(value: unknown): value is AppearanceCatalog {
  const catalog = value as Partial<AppearanceCatalog> | null;
  return Boolean(catalog && catalog.version === 1 && typeof catalog.revision === 'string'
    && Array.isArray(catalog.palettes) && Array.isArray(catalog.fonts) && Array.isArray(catalog.backgrounds) && Array.isArray(catalog.presets));
}

/** A palette document is a custom theme; the shape check is the same one the server applied. */
function readPalette(value: unknown): PaletteData | undefined {
  const checked = validateCustomThemes([value]);
  const theme = checked.themes[0];
  return theme
    ? {
      palette: theme.palette,
      ansi: theme.ansi,
      ...(theme.design ? { design: theme.design } : {}),
      ...(theme.syntax ? { syntax: theme.syntax } : {}),
    }
    : undefined;
}

function readCache(): State {
  const selection = parseSelection(readStored(SELECTION_KEY));
  try {
    const raw = readStored(CACHE_KEY);
    const cached = raw ? JSON.parse(raw) as { catalog?: unknown; palettes?: Record<string, unknown> } : undefined;
    if (cached && isCatalog(cached.catalog)) {
      const palettes: Record<string, PaletteData> = {};
      for (const [sha, value] of Object.entries(cached.palettes ?? {})) { const data = readPalette(value); if (data) palettes[sha] = data; }
      return { selection, catalog: cached.catalog, palettes };
    }
  } catch { /* an unreadable cache is no cache */ }
  return { selection, palettes: {} };
}

function writeCache(): void {
  if (!state.catalog) { writeStored(CACHE_KEY, undefined); return; }
  const palettes = Object.fromEntries(Object.entries(state.palettes).map(([sha, data]) => [sha, { id: 'custom-plugin-cache', name: 'cache', ...data }]));
  writeStored(CACHE_KEY, JSON.stringify({ catalog: state.catalog, palettes }));
}

// ── Effects ──────────────────────────────────────────────────────────────────

let injectedCss = '';
/** Every catalog palette gets a block, so a card in the gallery can paint its own swatch. */
function injectPaletteCss(): void {
  const css = customThemeCss((state.catalog?.palettes ?? []).flatMap((palette) => {
    const data = state.palettes[palette.asset.sha256];
    return data ? [{ id: paletteKey(palette), name: palette.id, ...data }] : [];
  }));
  if (css === injectedCss) return;
  injectedCss = css;
  let style = document.getElementById(STYLE_ID);
  if (!style) { style = document.createElement('style'); style.id = STYLE_ID; document.head.append(style); }
  style.textContent = css;
}

/** What loading a font needs: a catalog font, or one frozen into a share. */
export type FontFaces = Pick<AppearanceFont, 'id' | 'fallback'> & { files: Array<Pick<AppearanceFont['files'][number], 'url' | 'sha256' | 'weight' | 'style' | 'unicodeRange'>> };

const loaded = new Map<string, { key: string; faces: FontFace[] }>();
const fontTurn = new Map<string, number>();
/** A font that failed to load, and the catalog revision it failed under: it is tried again when the catalog changes, not on every commit. */
const fontFailed = new Map<string, { key: string; revision: string | undefined }>();

/** Puts `font` on `variable`, or restores the host's stack. The old face stays until the new one has loaded; one that fails to load leaves the host's stack, not the old face. */
export async function applyFont(variable: '--font-sans' | '--font-mono', font: FontFaces | undefined): Promise<void> {
  const root = document.documentElement;
  const key = font ? `${font.id}:${font.files.map((file) => file.sha256).join(',')}` : undefined;
  const revision = state.catalog?.revision;
  if (loaded.get(variable)?.key === key) return;
  const missed = fontFailed.get(variable);
  if (key && missed?.key === key && missed.revision === revision) return;
  const turn = (fontTurn.get(variable) ?? 0) + 1;
  fontTurn.set(variable, turn);
  const previous = loaded.get(variable);
  const restoreDefault = () => {
    root.style.removeProperty(variable);
    previous?.faces.forEach((face) => document.fonts.delete(face));
    loaded.delete(variable);
  };
  if (!font || !key) {
    fontFailed.delete(variable);
    restoreDefault();
    return;
  }
  // A private family name: the declared one could be a face the page already uses.
  const family = `riffet-plugin-${[...key].reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0, 7).toString(16)}`;
  const faces = font.files.map((file) => new FontFace(family, `url(${JSON.stringify(file.url)}) format('woff2')`, {
    weight: file.weight ?? 'normal', style: file.style ?? 'normal', display: 'swap', ...(file.unicodeRange ? { unicodeRange: file.unicodeRange } : {}),
  }));
  let failed = false;
  try { await Promise.all(faces.map((face) => face.load())); } catch { failed = true; }
  // A later choice began while this one loaded; its result is the one that counts.
  if (fontTurn.get(variable) !== turn) return;
  if (failed) {
    fontFailed.set(variable, { key, revision });
    restoreDefault();
    return;
  }
  fontFailed.delete(variable);
  faces.forEach((face) => document.fonts.add(face));
  previous?.faces.forEach((face) => document.fonts.delete(face));
  root.style.removeProperty(variable);
  root.style.setProperty(variable, fontStack(family, font, getComputedStyle(root).getPropertyValue(variable)));
  loaded.set(variable, { key, faces });
}

function writeFirstFrame(): void {
  const data = effective.palette && state.palettes[effective.palette.asset.sha256];
  writeStored(FIRST_FRAME_KEY, data && effective.palette ? JSON.stringify({
    key: paletteKey(effective.palette),
    light: data.palette.light,
    dark: data.palette.dark,
    ...(data.syntax ? { syntax: data.syntax } : {}),
  }) : undefined);
}

/** Recomputes what is in effect from the state, applies it to the page, and tells subscribers. */
function commit(next: State): void {
  state = next;
  effective = effectiveAppearance(state.selection, state.catalog);
  const data = effective.palette && state.palettes[effective.palette.asset.sha256];
  const painted = effective.palette && data
    ? { key: paletteKey(effective.palette), revision: effective.palette.asset.sha256, ansi: data.ansi, hasSyntax: Boolean(data.syntax) }
    : undefined;
  // The same palette keeps its object, so what renders on it does not render again.
  if (painted?.key !== plugin?.key || painted?.revision !== plugin?.revision) plugin = painted;
  background = effective.background;
  if (!inert) {
    injectPaletteCss();
    writeFirstFrame();
    void applyFont('--font-sans', effective.uiFont);
    void applyFont('--font-mono', effective.monoFont);
  }
  for (const listener of [...listeners]) listener();
}

// ── Sync ─────────────────────────────────────────────────────────────────────

let syncing: Promise<void> | undefined;
let syncAgain = false;
/**
 * Fetches the catalog and the palettes it lists. A failure keeps the cache; only an answer can remove
 * what the cache held. A call made while a fetch is running may follow a change that fetch did not
 * see (a plugin turned on or off), so one more runs after it, and the call resolves when that has.
 */
export function syncAppearance(): Promise<void> {
  if (inert) return Promise.resolve();
  if (syncing) syncAgain = true;
  syncing ??= (async () => {
    try {
      do {
        syncAgain = false;
        await fetchCatalog();
      } while (syncAgain);
    } finally { syncing = undefined; }
  })();
  return syncing;
}

/** Tells the service worker which assets are still listed, so it drops the rest of its appearance cache. No worker, or a refused post, changes nothing. */
function pruneAssetCache(catalog: AppearanceCatalog): void {
  try {
    const urls = [
      ...catalog.palettes.map((item) => item.asset.url),
      ...catalog.fonts.flatMap((font) => font.files.map((file) => file.url)),
      ...catalog.backgrounds.map((item) => item.asset.url),
    ];
    navigator.serviceWorker?.controller?.postMessage({ type: APPEARANCE_PRUNE_MESSAGE, urls });
  } catch { /* the cache only grows until the next catalog */ }
}

async function fetchCatalog(): Promise<void> {
  try {
    const catalog = await api.appearance();
    if (!isCatalog(catalog)) return;
    const palettes: Record<string, PaletteData> = {};
    await Promise.all(catalog.palettes.map(async (palette) => {
      const known = state.palettes[palette.asset.sha256];
      if (known) { palettes[palette.asset.sha256] = known; return; }
      try {
        const response = await fetch(palette.asset.url, { credentials: 'same-origin' });
        const data = response.ok ? readPalette(await response.json()) : undefined;
        if (data) palettes[palette.asset.sha256] = data;
      } catch { /* offline: the palette stays out until the next sync */ }
    }));
    commit({ ...state, catalog, palettes });
    writeCache();
    pruneAssetCache(catalog);
  } catch { /* the cache and the selection stay as they are */ }
}

// ── Selection ────────────────────────────────────────────────────────────────

type Slot = 'palette' | 'uiFont' | 'monoFont' | 'background';

function select(selection: AppearanceSelection, persist = writeStored): void {
  persist(SELECTION_KEY, Object.keys(selection).length ? JSON.stringify(selection) : undefined);
  commit({ ...state, selection });
}

/** Choosing a preset starts from it: the single choices made before are cleared so it takes effect. */
export function selectPreset(id: string | undefined): void {
  select(id === undefined ? {} : { preset: id });
}

/** One slot's own choice, which wins over the preset; `APPEARANCE_DEFAULT` is the host's even when the preset names one. */
export function selectAppearanceItem(slot: Slot, id: string): void {
  select({ ...state.selection, [slot]: id });
}

/**
 * The user picked a built-in or custom theme: it replaces the plugin palette instead of sitting under it,
 * including one whose plugin is off right now, so turning it back on does not paint over the newer pick.
 */
export function releasePluginPalette(persist?: typeof writeStored): void {
  // An acknowledged command must merge with the saved selection even if a
  // change from another tab is still waiting for its storage event here.
  const selection = persist ? parseSelection(window.localStorage.getItem(SELECTION_KEY) ?? '') : state.selection;
  const { palette, preset } = selection;
  if (palette !== APPEARANCE_DEFAULT && (palette !== undefined || preset !== undefined)) {
    select({ ...selection, palette: APPEARANCE_DEFAULT }, persist);
  } else if (persist) {
    commit({ ...state, selection });
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function activePluginPalette(): PluginPalette | undefined { return plugin; }
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface AppearanceView { catalog?: AppearanceCatalog; selection: AppearanceSelection; effective: EffectiveAppearance }
let view: AppearanceView = { selection: state.selection, effective, ...(state.catalog ? { catalog: state.catalog } : {}) };
subscribeAppearance(() => { view = { selection: state.selection, effective, ...(state.catalog ? { catalog: state.catalog } : {}) }; });

export function useAppearance(): AppearanceView {
  return useSyncExternalStore(subscribeAppearance, () => view);
}

export function useAppearanceBackground(): AppearanceBackground | undefined {
  return useSyncExternalStore(subscribeAppearance, () => background);
}

/** The palettes a gallery lists beside the themes, with the key each one is painted under. */
export function palettesOf(catalog: AppearanceCatalog | undefined): Array<{ palette: AppearancePalette; key: string }> {
  return (catalog?.palettes ?? []).filter((palette) => state.palettes[palette.asset.sha256]).map((palette) => ({ palette, key: paletteKey(palette) }));
}

/** The colours of a catalog palette by the key it is painted under, for starting a custom theme from it. */
export function pluginPaletteColors(key: string): PaletteData | undefined {
  const palette = state.catalog?.palettes.find((item) => paletteKey(item) === key);
  return palette && state.palettes[palette.asset.sha256];
}

function onStorage(event: StorageEvent): void {
  if (inert || (event.key !== SELECTION_KEY && event.key !== CACHE_KEY && event.key !== null)) return;
  try { if (event.storageArea !== window.localStorage) return; } catch { return; }
  commit(readCache());
}

if (!inert) {
  window.addEventListener('storage', onStorage);
  commit(state);
}
import.meta.hot?.dispose(() => { window.removeEventListener('storage', onStorage); listeners.clear(); });
