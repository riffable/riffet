import { z } from 'zod/v4';
import { ASSISTANT_QUERY_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { resolveLocalizedText } from '../../../../packages/contracts/src/plugins.js';
import { THEME_ROLES, WEB_BUILTIN_THEMES } from '../../../../packages/contracts/src/theme.js';
import type { AppearanceCatalog } from '../../../../packages/contracts/src/appearance.js';
import { defineRead, defineSettingCommand } from '../assistant-capability.js';
import { AppError } from '../errors.js';
import type { ThemeService } from './index.js';

const themeId = z.string().regex(/^custom-[a-z0-9-]{8,64}$/);
export const sharedThemeArgs = z.strictObject({
  sourceTurn: z.string().min(1).max(64),
  themeId,
  expectedRevision: z.string().min(1).max(128),
  mode: z.enum(['light','dark']), role: z.enum(THEME_ROLES), color: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/),
});

export const webThemeRead = (service: ThemeService, readAppearanceCatalog: () => Promise<Pick<AppearanceCatalog, 'palettes'>>) => defineRead('settings.web_themes',
  'List built-in Web themes, this instance’s shared themes and available palettes from enabled plugins. This read works without a connected tab. Current selection, the active plugin palette and writes use the bound workbench appearance tools.',
  ['riffet', 'web', 'theme', 'themes', 'palette', '主题', '配色', '可选', '内置', '外观'], z.strictObject({
    locale: z.string().trim().min(1).max(64).optional().describe('Language tag for plugin palette names, such as zh-Hans or en.'),
    pluginOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Pass nextPluginOffset to get more plugin palettes.'),
  }), async (_sessionId, { locale, pluginOffset = 0 }) => {
    const { palettes } = await readAppearanceCatalog();
    const end = pluginOffset + ASSISTANT_QUERY_BUDGET.pageItems;
    return {
      scope: 'riffet-web',
      builtinThemes: WEB_BUILTIN_THEMES.map(({ id, name }) => ({ id, name })),
      sharedThemes: service.getLibrary().themes.map(({ id, name }) => ({ id, name })),
      pluginPalettes: palettes.slice(pluginOffset, end).map(({ id, title }) => ({
        id, name: (resolveLocalizedText(title, locale ? [locale] : []) ?? id).slice(0, 100),
      })),
      ...(end < palettes.length ? { nextPluginOffset: end } : {}),
    };
  });

export const sharedThemeRead = (service: ThemeService) => defineRead('settings.shared_themes',
  'List custom themes shared by this Riffet instance and their current library revision, or read one custom theme’s palette. Selecting a theme on a client is a separate operation.',
  ['theme', 'palette', 'color', 'shared', '主题', '共享', '颜色', '强调色'], z.strictObject({themeId: themeId.optional()}), (_id,{themeId}) => {
    const library = service.getLibrary();
    if (!themeId) return { revision: library.revision, scope: 'instance', themes: library.themes.map(({id,name})=>({id,name})) };
    const theme = library.themes.find(item=>item.id===themeId);
    if (!theme) throw new AppError('THEME_NOT_FOUND','Unknown shared theme',404);
    return { revision: library.revision, scope: 'instance', theme: {id:theme.id,name:theme.name,palette:theme.palette} };
  });

export async function changeSharedTheme(service: ThemeService, request: z.output<typeof sharedThemeArgs>, beforeWrite?: () => void) {
  const {themeId,mode,role,color,expectedRevision} = request;
  const library = service.getLibrary();
  const theme = library.themes.find(item=>item.id===themeId);
  if (!theme) throw new AppError('THEME_NOT_FOUND','Unknown shared theme',404);
  if (theme.palette[mode][role].toLowerCase() === color.toLowerCase()) return {scope:'instance',themeId,mode,role,color,revision:library.revision,changed:false};
  // replaceLibrary alone rejects true conflicts in its serialized write. Keep the caller's revision.
  theme.palette[mode][role] = color;
  const updated = await service.replaceLibrary({ expectedRevision, themes: library.themes }, beforeWrite);
  return {scope:'instance',themeId,mode,role,color,revision:updated.revision,changed:true};
}

export const sharedThemeCommand = (service: ThemeService) => defineSettingCommand('shared_theme_update',
  'Edit one colour role of an existing custom theme shared by every client using it. The owner must explicitly ask to edit the shared theme. For ambiguous scope ask first. Supply the revision from settings.shared_themes; explain conflicts to the owner before retrying.',
  sharedThemeArgs, (args, turn) => changeSharedTheme(service, args, turn().assertCurrent));
