import { THEME_ROLES, validateThemeLibrary, type CustomTheme, type ShareAppearance } from '@contracts';
import { DEFAULT_THEME_ID, isKnownTheme, parseThemeMode } from './themes';

/** Frozen data is validated independently of the workbench's theme cache and network. */
export function readShareAppearance(): ShareAppearance {
  try {
    const value = JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="riffet-share-appearance"]')?.content ?? '{}') as Partial<ShareAppearance>;
    const checked = validateThemeLibrary({ version: 1, revision: 'frozen', themes: value.customTheme ? [value.customTheme] : [] });
    const customTheme = checked.library?.themes[0];
    const themeId = typeof value.themeId === 'string' && (isKnownTheme(value.themeId) || customTheme?.id === value.themeId) ? value.themeId : DEFAULT_THEME_ID;
    return { themeId, mode: parseThemeMode(value.mode), ...(customTheme?.id === themeId ? { customTheme } : {}) };
  } catch { return { themeId: DEFAULT_THEME_ID, mode: 'system' }; }
}

export function customThemeCss(themesToWrite: readonly CustomTheme[]): string {
  return themesToWrite.map((theme) => {
    const block = (mode: 'light' | 'dark', selector: string) => [
      `${selector} {`,
      `  color-scheme: ${mode};`,
      ...THEME_ROLES.map((role) => `  --${role}: ${theme.palette[mode][role]};`),
      '}',
    ].join('\n');
    return `${block('light', `[data-theme="${theme.id}"]:not(.dark)`)}\n\n${block('dark', `[data-theme="${theme.id}"].dark`)}`;
  }).join('\n\n');
}

/** Applies the same role vocabulary for both the workbench and the frozen reader. */
export function applyThemeAppearance(themeId: string, resolved: 'light' | 'dark'): void {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.dataset.theme = themeId;
  const surface = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (surface) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', surface);
}
