import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODE_THEME_ROLES, importCodeThemeJson, THEME_ANSI_KEYS, THEME_ROLES, type CodeThemePalette, type CustomCodeSyntax, type CustomTheme, type ThemeGradient, type ThemePalette, type ThemeDesign } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { changeSharedTheme } from './assistant.js';
import { ThemeService, themeLibraryRevision } from './index.js';

const directories: string[] = [];
function service(): { themes: ThemeService; stateDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), 'riffet-themes-'));
  directories.push(stateDir);
  return { themes: new ThemeService({ stateDir }), stateDir };
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function theme(id = 'custom-test-theme-1', name = 'Test theme'): CustomTheme {
  const palette = (color: string) => Object.fromEntries(THEME_ROLES.map(role => [role, color])) as ThemePalette;
  const ansi = Array.from({ length: THEME_ANSI_KEYS.length }, (_, index) => `#${index.toString(16).repeat(6)}`);
  return { id, name, palette: { light: palette('#ffffff'), dark: palette('#101010') }, ansi: { light: ansi, dark: [...ansi].reverse() } };
}

function rejection(action: () => unknown): AppError {
  try { action(); } catch (error) { if (error instanceof AppError) return error; throw error; }
  throw new Error('Expected the call to throw');
}

describe('ThemeService', () => {
  it('edits only the named shared colour, retries idempotently and preserves concurrent library changes', async () => {
    const { themes } = service();
    const original = theme();
    const initial = await themes.replaceLibrary({expectedRevision:themes.getLibrary().revision,themes:[original]});
    const patch = {sourceTurn:'fixture',themeId:original.id,mode:'dark' as const,role:'accent' as const,color:'#348caa',expectedRevision:initial.revision};
    await expect(changeSharedTheme(themes, patch, () => { throw new AppError('WORKBENCH_UNAVAILABLE', 'The workbench disconnected'); }))
      .rejects.toMatchObject({ code: 'WORKBENCH_UNAVAILABLE' });
    expect(themes.getLibrary().revision).toBe(initial.revision);
    const saved = await changeSharedTheme(themes, patch);
    expect(saved.changed).toBe(true);
    expect(await changeSharedTheme(themes,patch)).toMatchObject({changed:false, revision:saved.revision});
    await expect(changeSharedTheme(themes,{...patch,role:'fg'})).rejects.toMatchObject({code:'THEME_CONFLICT'});
    expect(themes.getLibrary().themes[0]).toEqual({...original,palette:{...original.palette,dark:{...original.palette.dark,accent:patch.color}}});
  });

  it('preserves the legacy revision when a theme has no design overrides', () => {
    // Captured before design was added; existing libraries must retain their revision.
    expect(themeLibraryRevision([theme()])).toBe('6be0d9043499d3767f15f3a4c4339e34');
  });

  it('persists design overrides and canonicalizes nested maps for idempotent retries', async () => {
    const { themes, stateDir } = service();
    const revision = themes.getLibrary().revision;
    const design: ThemeDesign = {
      version: 1,
      tokens: {
        typography: { buttonSmall: { family: 'system', weight: 500, lineHeight: 21, size: 15 } },
        dimensions: { menuMaxWidth: 360, controlHeight: 48, menuMinWidth: 200 },
        motion: { pressOpacity: 0.4, short: 120 },
        colors: { dark: { card: '#121212' }, light: { primaryAction: '#ABCDEF80' } },
        variants: { settingsIcons: 'plain' },
      },
      styles: {
        ios: { typography: { input: { size: 17 } }, variants: { navigation: 'floating' } },
        expressive: { motion: { spatialDamping: 0.7 } },
        miuix: { dimensions: { rowHeight: 56 } },
        fluent: { colors: { dark: { input: '#123456' } } },
      },
    };
    const saved = await themes.replaceLibrary({ expectedRevision: revision, themes: [{ ...theme(), design }] });
    const normalized = {
      ...design,
      tokens: {
        ...design.tokens,
        typography: { buttonSmall: { size: 15, lineHeight: 21, weight: 500, family: 'system' as const } },
        dimensions: { controlHeight: 48, menuMinWidth: 200, menuMaxWidth: 360 },
        motion: { short: 120, pressOpacity: 0.4 },
        colors: { light: { primaryAction: '#abcdef80' }, dark: { card: '#121212' } },
      },
    };
    expect(saved.themes[0]?.design).toEqual(normalized);
    expect(new ThemeService({ stateDir }).getLibrary()).toEqual(saved);
    expect(JSON.parse(readFileSync(join(stateDir, 'themes.json'), 'utf8')).themes[0].design).toEqual(normalized);
    // Key order, empty patches and colour case do not create a new revision.
    const reordered: ThemeDesign = {
      styles: {
        fluent: design.styles!.fluent, miuix: design.styles!.miuix, expressive: design.styles!.expressive,
        material3: {}, ios: { variants: { navigation: 'floating' }, typography: { input: { size: 17 } } },
      },
      tokens: { ...normalized.tokens, typography: { caption: {}, ...normalized.tokens.typography } },
      version: 1,
    };
    expect(await themes.replaceLibrary({ expectedRevision: revision, themes: [{ ...theme(), design: reordered }] })).toEqual(saved);
    const error = await themes.replaceLibrary({ expectedRevision: revision, themes: [theme()] }).catch(value => value);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('THEME_CONFLICT');
  });

  it('rejects malformed design fields without changing persistence', async () => {
    const { themes, stateDir } = service();
    const saved = await themes.replaceLibrary({ expectedRevision: themes.getLibrary().revision, themes: [theme()] });
    const before = readFileSync(join(stateDir, 'themes.json'), 'utf8');
    const invalid: unknown[] = [
      null, { version: 2 }, { tokens: {} }, { version: 1, script: 'alert(1)' },
      { version: 1, styles: { android: {} } }, { version: 1, tokens: null },
      { version: 1, tokens: { dimensions: { controlHeight: 47 } } },
      { version: 1, tokens: { dimensions: { menuMinWidth: 400, menuMaxWidth: 200 } } },
      { version: 1, tokens: { dimensions: { drawerWidth: '304' } } },
      { version: 1, tokens: { motion: { short: Infinity } } },
      { version: 1, tokens: { motion: { pressOpacity: 0 } } },
      { version: 1, tokens: { typography: { input: { family: 'url(evil)' } } } },
      { version: 1, tokens: { typography: { input: { weight: 500.5 } } } },
      { version: 1, tokens: { typography: { input: { size: 17, lineHeight: 12 } } } },
      { version: 1, tokens: { colors: { light: { card: 'red' } } } },
      { version: 1, tokens: { variants: { settingsIcons: 'glass' } } },
      { version: 1, tokens: { variants: Object.fromEntries([['__proto__', 'plain']]) } },
    ];
    for (const design of invalid) {
      const error = await themes.replaceLibrary({ expectedRevision: saved.revision, themes: [{ ...theme(), design } as CustomTheme] }).catch(value => value);
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe('INVALID_THEMES');
      expect(error.details.issues[0].path).toContain('design');
    }
    expect(themes.getLibrary()).toEqual(saved);
    expect(readFileSync(join(stateDir, 'themes.json'), 'utf8')).toBe(before);
  });

  it('starts empty with a stable revision, and round-trips a saved library across restarts', async () => {
    const { themes, stateDir } = service();
    expect(themes.getLibrary()).toEqual({ version: 1, revision: expect.any(String), themes: [] });
    const empty = themes.getLibrary().revision;

    const saved = await themes.replaceLibrary({ expectedRevision: empty, themes: [theme()] });
    expect(saved.themes).toHaveLength(1);
    expect(saved.revision).not.toBe(empty);
    expect(new ThemeService({ stateDir }).getLibrary()).toEqual(saved);
  });

  it('rejects an invalid theme without touching the stored library', async () => {
    const { themes } = service();
    const current = themes.getLibrary();
    const broken = { ...theme(), palette: { ...theme().palette, light: { ...theme().palette.light, bg: 'red' } } };
    const error = await themes.replaceLibrary({ expectedRevision: current.revision, themes: [broken as CustomTheme] }).catch(value => value);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_THEMES');
    expect(themes.getLibrary()).toEqual(current);
  });

  it('conflicts on a stale revision and treats the same content as an idempotent retry', async () => {
    const { themes } = service();
    const first = await themes.replaceLibrary({ expectedRevision: themes.getLibrary().revision, themes: [theme()] });
    const second = await themes.replaceLibrary({ expectedRevision: first.revision, themes: [theme('custom-test-theme-2', 'Another')] });
    expect(second.themes.map(item => item.id)).toEqual(['custom-test-theme-2']);

    const conflict = await themes.replaceLibrary({ expectedRevision: first.revision, themes: [theme('custom-test-theme-3')] }).catch(value => value);
    expect(conflict).toBeInstanceOf(AppError);
    expect((conflict as AppError).code).toBe('THEME_CONFLICT');
    expect((conflict as AppError).statusCode).toBe(409);
    expect((conflict as AppError).details).toEqual({ revision: second.revision });

    // The save already landed; a retry with the revision we held before it must succeed.
    expect(await themes.replaceLibrary({ expectedRevision: first.revision, themes: [theme('custom-test-theme-2', 'Another')] })).toEqual(second);
  });

  it('reports a corrupt file and never overwrites it', async () => {
    const { themes, stateDir } = service();
    const file = join(stateDir, 'themes.json');
    writeFileSync(file, '{ not json');
    expect(rejection(() => themes.getLibrary()).code).toBe('THEME_STORAGE_CORRUPT');
    const error = await themes.replaceLibrary({ expectedRevision: 'anything', themes: [theme()] }).catch(value => value);
    expect((error as AppError).code).toBe('THEME_STORAGE_CORRUPT');
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('persists and canonicalizes optional custom code syntax and rejects invalid syntax shapes', async () => {
    const { themes, stateDir } = service();
    const revision = themes.getLibrary().revision;
    const makeColors = (hex: string) => Object.fromEntries(CODE_THEME_ROLES.map((role) => [role, hex])) as CodeThemePalette;
    const syntax: CustomCodeSyntax = {
      light: { colors: makeColors('#0033B3'), commentItalic: false },
      dark: { colors: makeColors('#CF8E6D') },
    };
    const saved = await themes.replaceLibrary({ expectedRevision: revision, themes: [{ ...theme(), syntax }] });
    expect(saved.themes[0]?.syntax).toEqual({
      light: { colors: makeColors('#0033b3'), commentItalic: false },
      dark: { colors: makeColors('#cf8e6d'), commentItalic: true },
    });
    expect(new ThemeService({ stateDir }).getLibrary()).toEqual(saved);

    // Reordered keys and hex casing keep the same revision (idempotent retry).
    const reorderedDark = Object.fromEntries([...CODE_THEME_ROLES].reverse().map((role) => [role, '#cf8e6d'])) as CodeThemePalette;
    const retried = await themes.replaceLibrary({
      expectedRevision: revision,
      themes: [{ ...theme(), syntax: { dark: { commentItalic: true, colors: reorderedDark }, light: syntax.light } }],
    });
    expect(retried).toEqual(saved);

    const invalidSyntaxes: unknown[] = [
      null,
      { light: { colors: makeColors('#0033b3') } },
      { light: { colors: { comment: '#0033b3' } }, dark: { colors: makeColors('#cf8e6d') } },
      { light: { colors: { ...makeColors('#0033b3'), comment: 'red' } }, dark: { colors: makeColors('#cf8e6d') } },
      { light: { colors: makeColors('#0033b3'), commentItalic: 'yes' }, dark: { colors: makeColors('#cf8e6d') } },
    ];
    for (const bad of invalidSyntaxes) {
      const err = await themes.replaceLibrary({ expectedRevision: saved.revision, themes: [{ ...theme(), syntax: bad } as CustomTheme] }).catch((v) => v);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_THEMES');
    }
  });

  it('persists and canonicalizes optional canvas gradient and rejects invalid shapes', async () => {
    const { themes, stateDir } = service();
    const revision = themes.getLibrary().revision;
    const gradient: ThemeGradient = {
      light: { colors: ['#D8E8FC', '#F8DCE8', '#DCF2E2'], angle: 135.04 },
      dark: { colors: ['#1E2640', '#38203A', '#1B332C'], angle: 360 },
      blend: 0.2504,
    };
    const saved = await themes.replaceLibrary({ expectedRevision: revision, themes: [{ ...theme(), gradient }] });
    expect(saved.themes[0]?.gradient).toEqual({
      light: { colors: ['#d8e8fc', '#f8dce8', '#dcf2e2'], angle: 135 },
      dark: { colors: ['#1e2640', '#38203a', '#1b332c'], angle: 0 },
      blend: 0.25,
    });
    expect(new ThemeService({ stateDir }).getLibrary()).toEqual(saved);

    // Equivalent angle / hex casing keeps the same revision (idempotent retry).
    const retried = await themes.replaceLibrary({
      expectedRevision: revision,
      themes: [{
        ...theme(),
        gradient: {
          blend: 0.25,
          dark: { angle: 0, colors: ['#1e2640', '#38203a', '#1b332c'] },
          light: { angle: 135, colors: ['#d8e8fc', '#f8dce8', '#dcf2e2'] },
        },
      }],
    });
    expect(retried).toEqual(saved);

    const invalidGradients: unknown[] = [
      null,
      { light: { colors: ['#ffffff', '#000000'], angle: 90 } },
      { light: { colors: ['#ffffff'], angle: 90 }, dark: { colors: ['#000000', '#111111'], angle: 90 } },
      { light: { colors: ['#ffffff', '#000000', '#111111', '#222222'], angle: 90 }, dark: { colors: ['#000000', '#111111'], angle: 90 } },
      { light: { colors: ['#ffffff', '#00000080'], angle: 90 }, dark: { colors: ['#000000', '#111111'], angle: 90 } },
      { light: { colors: ['#ffffff', '#000000'], angle: -10 }, dark: { colors: ['#000000', '#111111'], angle: 90 } },
      { light: { colors: ['#ffffff', '#000000'], angle: 90, extra: 1 }, dark: { colors: ['#000000', '#111111'], angle: 90 } },
      { light: { colors: ['#ffffff', '#000000'], angle: 90 }, dark: { colors: ['#000000', '#111111'], angle: 90 }, blend: -0.1 },
      { light: { colors: ['#ffffff', '#000000'], angle: 90 }, dark: { colors: ['#000000', '#111111'], angle: 90 }, blend: 1.1 },
    ];
    for (const bad of invalidGradients) {
      const err = await themes.replaceLibrary({ expectedRevision: saved.revision, themes: [{ ...theme(), gradient: bad } as CustomTheme] }).catch((v) => v);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_THEMES');
    }
  });

  it('imports VS Code JSONC themes into Riffet syntax roles', () => {
    const imported = importCodeThemeJson(`{
      // JSONC comment
      "name": "Sample Dark",
      "type": "dark",
      "colors": { "editor.foreground": "#e6edf3", "editor.background": "#0d1117" },
      "tokenColors": [
        { "scope": ["comment", "punctuation.definition.comment"], "settings": { "foreground": "#8b949e", "fontStyle": "italic" } },
        { "scope": "keyword", "settings": { "foreground": "#ff7b72" } },
        { "scope": "string", "settings": { "foreground": "#a5d6ff" } },
        { "scope": "constant.numeric", "settings": { "foreground": "#79c0ff" } },
      ],
    }`);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.mode).toBe('dark');
    expect(imported.value.half?.commentItalic).toBe(true);
    expect(imported.value.half?.colors.comment).toBe('#8b949e');
    expect(imported.value.half?.colors.keyword).toBe('#ff7b72');
    expect(imported.value.half?.colors.string).toBe('#a5d6ff');
    expect(imported.value.half?.colors.number).toBe('#79c0ff');
  });
});
