import { CODE_THEME_ROLES, DEFAULT_THEME_GRADIENT_BLEND, THEME_ROLES, validateThemeLibrary, type CustomCodeSyntaxHalf, type CustomTheme, type ShareAppearance, type ThemeGradient, type ThemeGradientHalf } from '@contracts';
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

function codeSyntaxBlock(selector: string, half: CustomCodeSyntaxHalf, dark: boolean): string {
  const fgMix = dark ? 90 : 88;
  const commentMix = dark ? 85 : 80;
  return [
    `${selector} {`,
    `  --code-comment-style: ${(half.commentItalic ?? true) ? 'italic' : 'normal'};`,
    ...CODE_THEME_ROLES.map((role) => {
      const hex = half.colors[role];
      const target = role === 'comment'
        ? `color-mix(in oklab, ${hex} ${commentMix}%, var(--fg-3))`
        : `color-mix(in oklab, ${hex} ${fgMix}%, var(--fg))`;
      return `  --code-${role}: ${target};`;
    }),
    '}',
  ].join('\n');
}

export function canvasGradientCss(half: ThemeGradientHalf): string {
  const [c0, c1, c2] = half.colors;
  if (!c0 || !c1) return 'none';
  if (c2) {
    const perp = ((half.angle + 90) * Math.PI) / 180;
    const x = Math.round((50 + 45 * Math.sin(perp)) * 10) / 10;
    const y = Math.round((50 - 45 * Math.cos(perp)) * 10) / 10;
    return `radial-gradient(110% 110% at ${x}% ${y}%, ${c1} 0%, ${c1}00 72%), linear-gradient(${half.angle}deg, ${c0} 0%, ${c2} 100%)`;
  }
  return `linear-gradient(${half.angle}deg, ${c0} 0%, ${c1} 100%)`;
}

function cardBackgroundCss(gradient?: ThemeGradient): string {
  if (!gradient) return 'var(--bg)';
  const blend = Math.min(1, Math.max(0, gradient.blend ?? DEFAULT_THEME_GRADIENT_BLEND));
  if (blend <= 0) return 'var(--bg)';
  if (blend >= 1) return 'transparent';
  const opacityPct = Math.round((1 - blend) * 1000) / 10;
  return `color-mix(in srgb, var(--bg) ${opacityPct}%, transparent)`;
}

export function customThemeCss(themesToWrite: readonly CustomTheme[]): string {
  return themesToWrite.map((theme) => {
    const cardBg = cardBackgroundCss(theme.gradient);
    const block = (mode: 'light' | 'dark', selector: string) => [
      `${selector} {`,
      `  color-scheme: ${mode};`,
      ...THEME_ROLES.map((role) => `  --${role}: ${theme.palette[mode][role]};`),
      `  --bg-canvas-gradient: ${theme.gradient ? canvasGradientCss(theme.gradient[mode]) : 'none'};`,
      `  --bg-card: ${cardBg};`,
      '}',
    ].join('\n');
    const parts = [
      block('light', `[data-theme="${theme.id}"]:not(.dark)`),
      block('dark', `[data-theme="${theme.id}"].dark`),
    ];
    if (theme.syntax) {
      parts.push(
        codeSyntaxBlock(`[data-code-theme="${theme.id}"]:not(.dark)`, theme.syntax.light, false),
        codeSyntaxBlock(`[data-code-theme="${theme.id}"].dark`, theme.syntax.dark, true),
      );
    }
    return parts.join('\n\n');
  }).join('\n\n');
}

/** Applies the same role vocabulary for both the workbench and the frozen reader. */
export function applyThemeAppearance(themeId: string, resolved: 'light' | 'dark', codeThemeId?: string): void {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.dataset.theme = themeId;
  if (codeThemeId) root.dataset.codeTheme = codeThemeId;
  const surface = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (surface) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', surface);
}
