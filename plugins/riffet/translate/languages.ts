// The languages 翻译 offers, each named in itself on the page and in English to the model.

export interface Language { tag: string; name: string; english: string }

export const LANGUAGES: readonly Language[] = [
  { tag: 'zh-Hans', name: '简体中文', english: 'Simplified Chinese' },
  { tag: 'zh-Hant', name: '繁體中文', english: 'Traditional Chinese' },
  { tag: 'en', name: 'English', english: 'English' },
  { tag: 'ja', name: '日本語', english: 'Japanese' },
  { tag: 'ko', name: '한국어', english: 'Korean' },
  { tag: 'fr', name: 'Français', english: 'French' },
  { tag: 'de', name: 'Deutsch', english: 'German' },
  { tag: 'es', name: 'Español', english: 'Spanish' },
  { tag: 'pt', name: 'Português', english: 'Portuguese' },
  { tag: 'ru', name: 'Русский', english: 'Russian' },
];

export const AUTO = 'auto';

const byTag = (tag: string): Language | undefined => LANGUAGES.find(language => language.tag === tag);

/** The offered language closest to a client's BCP-47 tag; English when none is. */
export function languageOfLocale(locale: string | undefined): Language {
  const lower = (locale ?? '').toLowerCase();
  if (lower.startsWith('zh')) return byTag(/hant|-tw|-hk|-mo/.test(lower) ? 'zh-Hant' : 'zh-Hans')!;
  return byTag(lower.split('-')[0] ?? '') ?? byTag('en')!;
}

/** What a translation goes into: the saved choice, or the client's language under `auto`. */
export function targetLanguage(saved: string | undefined, locale: string | undefined): Language {
  return (saved && saved !== AUTO ? byTag(saved) : undefined) ?? languageOfLocale(locale);
}

/** Where a message already in the target language goes instead. */
export const fallbackLanguage = (target: Language): Language => byTag(target.tag === 'en' ? 'zh-Hans' : 'en')!;
