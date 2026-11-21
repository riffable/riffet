import { i18n, type Messages } from '@lingui/core';
import { plural, t } from '@lingui/core/macro';
import { createStore, useStore } from '../store';
import { readStored, writeStored } from '../utils';
import { bindFormatLocale, type AgePhrases } from './format';

/**
 * The interface language, kept on this device only — the same stance as `display-settings`: one
 * browser's language is not another's business. Switching applies in place, in every open tab.
 */
export type AppLocale = 'zh-Hans' | 'en';
/** Pseudo-localised English for QA: not offered in the picker, set by hand under `riffet.locale`. */
export type CatalogLocale = AppLocale | 'pseudo';

const SOURCE_LOCALE = 'zh-Hans' satisfies AppLocale;

/** The picker's choices, each named in its own language. */
export const localeOptions: { value: AppLocale; label: string }[] = [
  { value: 'zh-Hans', label: '中文' }, // i18n-ignore: a language is named in its own language
  { value: 'en', label: 'English' },
];

/**
 * The tag `<html lang>` and every `Intl` formatter use. zh-CN rather than zh-Hans keeps the Chinese
 * UI's dates, numbers and font fallback exactly as they were before there was a choice.
 */
const intlTags: Record<CatalogLocale, string> = { 'zh-Hans': 'zh-CN', en: 'en', pseudo: 'en' };

const KEY = 'riffet.locale';

function parseLocale(value: unknown): CatalogLocale | undefined {
  return value === 'zh-Hans' || value === 'en' || value === 'pseudo' ? value : undefined;
}

/*
 * The source catalog is bundled: a production build strips the source text from every message, so
 * without it the UI would show ids. The others load when first chosen.
 */
const sourceCatalogs = import.meta.glob<Messages>('../../locales/zh-Hans/*.po', { eager: true, import: 'messages' });
const otherCatalogs = import.meta.glob<Messages>(['../../locales/*/*.po', '!../../locales/zh-Hans/*.po'], { import: 'messages' });

const agePhrases: AgePhrases = {
  justNow: () => t`刚刚`,
  age: (unit, count) => {
    switch (unit) {
      case 'minute': return plural(count, { other: '# 分钟' });
      case 'hour': return plural(count, { other: '# 小时' });
      case 'day': return plural(count, { other: '# 天' });
      case 'month': return plural(count, { other: '# 个月' });
      case 'year': return plural(count, { other: '# 年' });
    }
  },
  ago: (unit, count) => {
    switch (unit) {
      case 'minute': return plural(count, { other: '# 分钟前' });
      case 'hour': return plural(count, { other: '# 小时前' });
      case 'day': return plural(count, { other: '# 天前' });
      case 'month': return plural(count, { other: '# 个月前' });
      case 'year': return plural(count, { other: '# 年前' });
    }
  },
};

const store = createStore<{ locale: CatalogLocale }>({ locale: SOURCE_LOCALE });
const loaded = new Set<CatalogLocale>([SOURCE_LOCALE]);
let latest = 0;

function apply(locale: CatalogLocale): void {
  const tag = intlTags[locale];
  i18n.activate(locale, [tag]);
  bindFormatLocale(tag, agePhrases);
  if (typeof document !== 'undefined') document.documentElement.lang = tag;
  store.set({ locale });
}

i18n.load(SOURCE_LOCALE, Object.assign({}, ...Object.values(sourceCatalogs)));
apply(SOURCE_LOCALE);

/**
 * Switches this tab to [locale], loading its catalogs first if this tab has not yet. The latest call
 * wins over one still loading; a failed load rejects and leaves the current language in place.
 */
export async function activateLocale(locale: CatalogLocale): Promise<void> {
  const call = ++latest;
  if (!loaded.has(locale)) {
    const prefix = `../../locales/${locale}/`;
    const parts = await Promise.all(Object.entries(otherCatalogs).filter(([path]) => path.startsWith(prefix)).map(([, load]) => load()));
    i18n.load(locale, Object.assign({}, ...parts));
    loaded.add(locale);
  }
  if (call === latest) apply(locale);
}

function preferredLocale(): CatalogLocale {
  const stored = parseLocale(readStored(KEY));
  if (stored) return stored;
  // Before the language followed the browser it was always Chinese: a browser that already used the workbench keeps
  // that, and only a first visit follows the browser.
  if (usedBefore()) { writeStored(KEY, SOURCE_LOCALE); return SOURCE_LOCALE; }
  return systemLocale();
}

function usedBefore(): boolean {
  try {
    for (let index = 0; index < localStorage.length; index += 1) if (localStorage.key(index)?.startsWith('riffet.')) return true;
  } catch { /* storage unavailable: a first visit */ }
  return false;
}

/** The first of the browser's languages this UI has a catalog for; the source language when none. */
function systemLocale(): AppLocale {
  for (const tag of typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]) {
    const language = tag?.toLowerCase().split('-')[0];
    if (language === 'zh') return 'zh-Hans';
    if (language === 'en') return 'en';
  }
  return SOURCE_LOCALE;
}

/**
 * The workbench's language: this device's choice, then any change made in another tab. Resolves once
 * it is active; a catalog that cannot load leaves the source language rather than holding up the UI.
 */
export function startLocale(): Promise<void> {
  window.addEventListener('storage', onStorage);
  return activateLocale(preferredLocale()).catch(() => {});
}

export function setLocale(locale: CatalogLocale): void {
  writeStored(KEY, locale);
  // A failed chunk load already prompts a refresh (see main.tsx); the choice is kept for that load.
  void activateLocale(locale).catch(() => {});
}

function onStorage(event: StorageEvent): void {
  if (event.key !== KEY && event.key !== null) return;
  void activateLocale(preferredLocale()).catch(() => {});
}

import.meta.hot?.dispose(() => {
  window.removeEventListener('storage', onStorage);
});

/** The active locale; it changes once a newly chosen catalog has loaded. */
export function useLocale(): CatalogLocale {
  return useStore(store, (state) => state.locale);
}
