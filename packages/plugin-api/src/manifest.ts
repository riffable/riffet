import { z } from 'zod/v4';
import { PLUGIN_API_MIN_VERSION, PLUGIN_API_VERSION, type PluginManifest } from './index.js';
import {
  COMMAND_ICONS, COMMAND_MENUS, COMMAND_SCOPES, MODEL_USE_FALLBACKS, PLUGIN_CLIENTS, PLUGIN_ID, VIEW_INSTANCES, VIEW_LOCATIONS, isContributionOf,
  isAgentOfPlugin, isBuiltinBackendId, PLUGIN_CAPABILITIES,
  APPEARANCE_BACKGROUND_AREAS, APPEARANCE_BACKGROUND_FITS, APPEARANCE_FONT_ROLES, APPEARANCE_FONT_STYLES,
  type CommandDeclaration, type PluginDeclarations, type TaskProviderDeclaration, type ViewDeclaration,
} from '@riffet/contracts';
import { validRange } from './semver.js';

// Checks of what a manifest says, before any plugin code runs. Each returns the first problem as a
// sentence naming the offending field, or `undefined`; the registry turns it into a `rejected` entry.

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const KEYBINDING = /^(?:(?:Mod|Ctrl|Alt|Shift|Meta)\+)*(?:[A-Za-z0-9`\-=[\]\\;',./]|F\d{1,2}|Enter|Escape|Space|Tab|Backspace|Delete|Arrow(?:Up|Down|Left|Right))$/;
const SF_SYMBOL = /^[A-Za-z0-9.]{1,64}$/;
const CONDITION_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/;
const ACTIVATION_EVENTS = ['startup', 'command', 'model-source', 'task', 'view'] as const;
const CONDITION_KEYS = ['hasProject', 'hasSession', 'projectType', 'capability'] as const;
const SETTING_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const PARAM_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const PARAM_KINDS = ['text', 'boolean', 'choice'] as const;
const MAX_PARAMS = 16;
// A family name ends up in a CSS font stack on the web: no quotes, separators or braces can get through.
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const UNICODE_RANGE = /^U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?(?:, ?U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?)*$/;
const FONT_WEIGHT = /^(?:[1-9]\d{2}|1000)(?: (?:[1-9]\d{2}|1000))?$/;
/** A reference to a contribution of any plugin: `<pluginId>/<name>`. */
const CONTRIBUTION_REFERENCE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]{0,63}$/;

/** A model source's declared host: a lowercase hostname, optionally with a leading `*.` label and a `:port`. */
const SOURCE_HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/;
const MAX_SOURCE_HOSTS = 16;
const validSourceHost = (value: unknown): value is string => typeof value === 'string' && value.length <= 253 && SOURCE_HOST.test(value)
  && (!/:\d+$/.test(value) || Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535);

/** Whether `host` (`URL.host` form: lowercase, port only when not the scheme's default) is named by a declared entry. `*.x` matches any subdomain of `x`, not `x` itself; an entry without a port matches any port. */
export function hostMatchesDeclared(host: string, declared: readonly string[]): boolean {
  const [name = '', port] = host.split(/:(?=\d+$)/);
  return declared.some(entry => {
    const [pattern = '', declaredPort] = entry.split(/:(?=\d+$)/);
    if (declaredPort !== undefined && declaredPort !== port) return false;
    return pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1 : name === pattern;
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] | undefined => Array.isArray(value) ? value : undefined;

/** A path inside the package: relative, without `..`. Whether the file exists and stays inside is checked where it is read. */
export function isPackagePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\\\0]/.test(value) && !value.startsWith('/')
    && value.split('/').every(part => part !== '' && part !== '..');
}

function localized(value: unknown, path: string, max: number): string | undefined {
  if (!isRecord(value) || !Object.keys(value).length) return `${path} must map language tags to text`;
  for (const [tag, text] of Object.entries(value)) {
    if (!LANGUAGE_TAG.test(tag)) return `${path} has an invalid language tag "${tag}"`;
    if (typeof text !== 'string' || !text.trim() || text.length > max) return `${path}.${tag} must be text of up to ${max} characters`;
  }
  return undefined;
}

function condition(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'hasProject' || key === 'hasSession') { if (item !== true) return `${path}.${key} must be true`; }
    else if (key === 'projectType' || key === 'capability') { if (typeof item !== 'string' || !CONDITION_TOKEN.test(item)) return `${path}.${key} is invalid`; }
    else return `${path} has an unknown condition "${key}"`;
  }
  return undefined;
}

function oneOf<T extends string>(values: unknown, known: readonly T[], path: string, what: string): string | undefined {
  const items = list(values);
  if (!items?.length) return `${path} must list at least one ${what}`;
  for (const item of items) if (!known.includes(item as T)) return `${path} has an unknown ${what} "${String(item)}"`;
  if (new Set(items).size !== items.length) return `${path} repeats a ${what}`;
  return undefined;
}

function icon(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return `${path} must be an object`;
  if (value.svg !== undefined && !isPackagePath(value.svg)) return `${path}.svg must be a path inside the package`;
  if (value.sfSymbol !== undefined && !(typeof value.sfSymbol === 'string' && SF_SYMBOL.test(value.sfSymbol))) return `${path}.sfSymbol is invalid`;
  return undefined;
}

function view(pluginId: string, value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  if (!isContributionOf(pluginId, value.id)) return `${path}.id must be "${pluginId}/<name>"`;
  const problem = localized(value.title, `${path}.title`, 80) ?? icon(value.icon, `${path}.icon`);
  if (problem) return problem;
  const locations = oneOf(value.locations, VIEW_LOCATIONS, `${path}.locations`, 'location');
  if (locations) return locations;
  if (value.defaultLocation !== undefined && !(value.locations as unknown[]).includes(value.defaultLocation)) return `${path}.defaultLocation must be one of its locations`;
  if (value.settingsCategory !== undefined && value.settingsCategory !== 'agent' && value.settingsCategory !== 'providers') return `${path}.settingsCategory must be agent or providers`;
  const clients = oneOf(value.clients, PLUGIN_CLIENTS, `${path}.clients`, 'client');
  if (clients) return clients;
  if (!VIEW_INSTANCES.includes(value.instances as never)) return `${path}.instances must be single, per-session or per-project`;
  if (value.requires !== undefined && !(Array.isArray(value.requires) && value.requires.length <= 64 && value.requires.every(item => typeof item === 'string' && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(item)))) return `${path}.requires must list client capabilities`;
  if (value.renderer !== undefined) {
    const rendered = rendererSchema.safeParse(value.renderer);
    if (!rendered.success) return `${path}.renderer: ${rendered.error.issues[0]?.message}`;
    if (rendered.data.kind === 'tasks' && !isContributionOf(pluginId, rendered.data.provider)) return `${path}.renderer.provider must be owned by this plugin`;
    const commands = rendered.data.kind === 'form' ? [rendered.data.command] : rendered.data.kind === 'list' ? rendered.data.items.flatMap(item => item.command ? [item.command] : []) : rendered.data.kind === 'detail' ? (rendered.data.actions ?? []).map(item => item.command) : [];
    if (commands.some(command => !isContributionOf(pluginId, command))) return `${path}.renderer commands must be owned by this plugin`;
  }
  return value.when === undefined ? undefined : condition(value.when, `${path}.when`);
}

function taskProvider(pluginId: string, value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  if (!isContributionOf(pluginId, value.id)) return `${path}.id must be "${pluginId}/<name>"`;
  if (value.projectType !== undefined && !(typeof value.projectType === 'string' && CONDITION_TOKEN.test(value.projectType))) return `${path}.projectType is invalid`;
  return localized(value.title, `${path}.title`, 80);
}

const AVATAR_CREDIT_MAX = 300;

function avatarStyle(pluginId: string, value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  if (!isContributionOf(pluginId, value.id)) return `${path}.id must be "${pluginId}/<name>"`;
  if (value.credit !== undefined && !(typeof value.credit === 'string' && value.credit.length <= AVATAR_CREDIT_MAX)) return `${path}.credit must be text of up to ${AVATAR_CREDIT_MAX} characters`;
  if (value.needsName !== undefined && typeof value.needsName !== 'boolean') return `${path}.needsName must be true or false`;
  return localized(value.title, `${path}.title`, 80);
}

/** A tool group's names all start with its prefix, so two groups (and Riffet's own tools) cannot collide. */
const TOOL_PREFIX = /^[a-z][a-z0-9]{1,23}_$/;
/** Prefixes of Riffet's own tools and device tools. */
const RESERVED_TOOL_PREFIXES = ['device_', 'read_', 'schedule_', 'cancel_', 'list_', 'notify_', 'screen_', 'riffet_'];
function agentTools(pluginId: string, value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  if (!isContributionOf(pluginId, value.id)) return `${path}.id must be "${pluginId}/<name>"`;
  if (typeof value.toolPrefix !== 'string' || !TOOL_PREFIX.test(value.toolPrefix) || RESERVED_TOOL_PREFIXES.includes(value.toolPrefix)) return `${path}.toolPrefix must be lowercase, end with "_" and not be one of Riffet's own (${RESERVED_TOOL_PREFIXES.join(', ')})`;
  return localized(value.title, `${path}.title`, 80) ?? (value.description === undefined ? undefined : localized(value.description, `${path}.description`, 400)) ?? icon(value.icon, `${path}.icon`);
}

function channel(pluginId: string, value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  if (!isContributionOf(pluginId, value.id)) return `${path}.id must be "${pluginId}/<name>"`;
  return value.scope === 'session' ? undefined : `${path}.scope must be "session"`;
}

function modelUse(pluginId: string, value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  if (!isContributionOf(pluginId, value.id)) return `${path}.id must be "${pluginId}/<name>"`;
  const problem = localized(value.title, `${path}.title`, 40);
  if (problem) return problem;
  return value.fallback === undefined || MODEL_USE_FALLBACKS.includes(value.fallback as never) ? undefined : `${path}.fallback must be one of ${MODEL_USE_FALLBACKS.join(', ')}`;
}

/** The persisted backend id, not a `<pluginId>/<name>` contribution id: a built-in one (official `riffet` plugins only) or one under the plugin's own id. */
function agentBackend(pluginId: string, value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  const builtin = isBuiltinBackendId(value.id) && pluginId.startsWith('riffet.');
  if (!builtin && !isAgentOfPlugin(pluginId, value.id)) return `${path}.id must be "${pluginId}" or "${pluginId}.<name>" (lowercase, at most 64 characters)`;
  return localized(value.title, `${path}.title`, 80) ?? icon(value.icon, `${path}.icon`);
}

/** A list of fields a command takes, in the shape of a task action's parameters. */
function paramFields(value: unknown, path: string): string | undefined {
  const fields = list(value);
  if (!fields || fields.length > MAX_PARAMS) return `${path} must be a list of at most ${MAX_PARAMS} fields`;
  const keys = new Set<string>();
  for (const [index, field] of fields.entries()) {
    const at = `${path}[${index}]`;
    if (!isRecord(field) || typeof field.key !== 'string' || !PARAM_KEY.test(field.key)) return `${at}.key is invalid`;
    if (keys.has(field.key)) return `${at} repeats the key "${field.key}"`;
    keys.add(field.key);
    const problem = localized(field.label, `${at}.label`, 80);
    if (problem) return problem;
    if (!PARAM_KINDS.includes(field.kind as never)) return `${at}.kind must be text, boolean or choice`;
    if (field.kind === 'choice' && !(Array.isArray(field.options) && field.options.length > 0 && field.options.length <= 64 && field.options.every(option => typeof option === 'string' && option.length > 0 && option.length <= 256))) return `${at}.options must list 1 to 64 values`;
    if (field.default !== undefined && !(typeof field.default === 'string' || typeof field.default === 'boolean' || (typeof field.default === 'number' && Number.isFinite(field.default)))) return `${at}.default is invalid`;
    if (field.required !== undefined && typeof field.required !== 'boolean') return `${at}.required must be true or false`;
  }
  return undefined;
}

function command(pluginId: string, value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  if (!isContributionOf(pluginId, value.id)) return `${path}.id must be "${pluginId}/<name>"`;
  const problem = localized(value.title, `${path}.title`, 80);
  if (problem) return problem;
  if (value.keybinding !== undefined && !(typeof value.keybinding === 'string' && KEYBINDING.test(value.keybinding))) return `${path}.keybinding is invalid`;
  if (value.scope !== undefined && !COMMAND_SCOPES.includes(value.scope as never)) return `${path}.scope must be global, project or session`;
  const params = value.params === undefined ? undefined : paramFields(value.params, `${path}.params`);
  if (params) return params;
  if (value.menus !== undefined) {
    const menus = oneOf(value.menus, COMMAND_MENUS, `${path}.menus`, 'menu');
    if (menus) return menus;
    const needing = (value.menus as unknown[]).find(menu => menu === 'message' || menu === 'selection');
    if (needing && value.scope !== 'session') return `${path}.scope must be session for the ${String(needing)} menu`;
  }
  if (value.icon !== undefined && !COMMAND_ICONS.includes(value.icon as never)) return `${path}.icon must be one of ${COMMAND_ICONS.join(', ')}`;
  return value.when === undefined ? undefined : condition(value.when, `${path}.when`);
}

/** An appearance asset: under the package's `assets/` directory (the part of a built-in package a build ships), with an extension of the allowed kind. */
const assetPath = (value: unknown, extensions: RegExp): value is string => isPackagePath(value) && value.startsWith('assets/') && extensions.test(value);
const optionalReference = (value: unknown) => value === undefined || (typeof value === 'string' && CONTRIBUTION_REFERENCE.test(value));

function appearance(pluginId: string, value: unknown, seen: Set<string>): string | undefined {
  if (!isRecord(value)) return 'contributes.appearance must be an object';
  const claim = (item: unknown, path: string): string | undefined => {
    if (!isRecord(item)) return `${path} must be an object`;
    if (!isContributionOf(pluginId, item.id)) return `${path}.id must be "${pluginId}/<name>"`;
    if (seen.has(item.id)) return `contribution id "${item.id}" is declared twice`;
    seen.add(item.id);
    return localized(item.title, `${path}.title`, 80);
  };
  for (const kind of ['palettes', 'fonts', 'backgrounds', 'presets', 'iconPacks'] as const) {
    const items = value[kind];
    if (items === undefined) continue;
    if (!Array.isArray(items) || items.length > 64) return `contributes.appearance.${kind} must be a list of at most 64 items`;
    for (const [index, item] of items.entries()) {
      const path = `contributes.appearance.${kind}[${index}]`;
      const problem = claim(item, path);
      if (problem) return problem;
      const entry = item as Record<string, unknown>;
      if ((kind === 'palettes' || kind === 'iconPacks') && !assetPath(entry.asset, /\.json$/i)) return `${path}.asset must be a .json file under assets/`;
      if (kind === 'backgrounds') {
        if (!assetPath(entry.asset, /\.(?:png|jpe?g|webp)$/i)) return `${path}.asset must be a .png, .jpg or .webp file under assets/`;
        const areas = oneOf(entry.areas, APPEARANCE_BACKGROUND_AREAS, `${path}.areas`, 'area');
        if (areas) return areas;
        if (entry.opacity !== undefined && !(typeof entry.opacity === 'number' && entry.opacity >= 0 && entry.opacity <= 1)) return `${path}.opacity must be between 0 and 1`;
        if (entry.fit !== undefined && !APPEARANCE_BACKGROUND_FITS.includes(entry.fit as never)) return `${path}.fit must be cover or tile`;
      }
      if (kind === 'fonts') {
        if (!APPEARANCE_FONT_ROLES.includes(entry.role as never)) return `${path}.role must be ui or mono`;
        if (typeof entry.family !== 'string' || !FONT_FAMILY.test(entry.family)) return `${path}.family is invalid`;
        const files = list(entry.files);
        if (!files?.length || files.length > 16) return `${path}.files must list 1 to 16 font files`;
        for (const [at, file] of files.entries()) {
          if (!isRecord(file) || !assetPath(file.path, /\.woff2$/i)) return `${path}.files[${at}].path must be a .woff2 file under assets/`;
          if (file.weight !== undefined && !(typeof file.weight === 'string' && FONT_WEIGHT.test(file.weight))) return `${path}.files[${at}].weight is invalid`;
          if (file.style !== undefined && !APPEARANCE_FONT_STYLES.includes(file.style as never)) return `${path}.files[${at}].style must be normal or italic`;
          if (file.unicodeRange !== undefined && !(typeof file.unicodeRange === 'string' && file.unicodeRange.length <= 1024 && UNICODE_RANGE.test(file.unicodeRange))) return `${path}.files[${at}].unicodeRange is invalid`;
        }
        const fallback = list(entry.fallback);
        if (!fallback || fallback.length > 8 || fallback.some(name => typeof name !== 'string' || !FONT_FAMILY.test(name))) return `${path}.fallback must list up to 8 family names`;
      }
      if ((kind === 'fonts' || kind === 'backgrounds') && entry.license !== undefined && !(isRecord(entry.license) && typeof entry.license.redistributable === 'boolean')) return `${path}.license must be { "redistributable": true | false }`;
      if (kind === 'presets') {
        const fonts = entry.fonts;
        if (fonts !== undefined && (!isRecord(fonts) || Object.keys(fonts).some(key => key !== 'ui' && key !== 'mono'))) return `${path}.fonts may only name ui and mono`;
        if (![entry.palette, entry.background, ...(isRecord(fonts) ? [fonts.ui, fonts.mono] : [])].every(optionalReference)) return `${path} references a contribution by an invalid id`;
      }
    }
  }
  return undefined;
}

/** Keys this version does not know are ignored, so a plugin written for a newer host still loads. */
export function checkDeclarations(pluginId: string, declarations: unknown): string | undefined {
  if (declarations === undefined) return undefined;
  if (!isRecord(declarations)) return 'contributes must be an object';
  if (declarations.modelSources !== undefined) {
    if (!Array.isArray(declarations.modelSources) || declarations.modelSources.length > 64) return 'contributes.modelSources must be a list of at most 64 items';
    const sourceIds = new Set<string>();
    for (const item of declarations.modelSources) {
      if (!isRecord(item) || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(item.id)) return 'contributes.modelSources has an invalid source id';
      if (sourceIds.has(item.id)) return 'contributes.modelSources has a duplicate source id';
      sourceIds.add(item.id);
      if (item.role !== undefined && item.role !== 'source' && item.role !== 'adapter') return 'contributes.modelSources.role must be source or adapter';
      if (item.usage !== undefined && typeof item.usage !== 'boolean') return 'contributes.modelSources.usage must be a boolean';
      const problem = localized(item.title, 'contributes.modelSources.title', 80);
      if (problem) return problem;
      if (item.hosts !== undefined && (!Array.isArray(item.hosts) || item.hosts.length > MAX_SOURCE_HOSTS || !item.hosts.every(validSourceHost))) return 'contributes.modelSources.hosts must be at most 16 lowercase hostnames, each optionally with a leading "*." and a ":port"';
    }
  }
  if (declarations.sharePublisher !== undefined) {
    if (!isRecord(declarations.sharePublisher)) return 'contributes.sharePublisher must be an object';
    const problem = localized(declarations.sharePublisher.title, 'contributes.sharePublisher.title', 80);
    if (problem) return problem;
  }
  if (declarations.page !== undefined) {
    if (!isRecord(declarations.page)) return 'contributes.page must be an object';
    if (declarations.page.title !== undefined) { const problem = localized(declarations.page.title, 'contributes.page.title', 40); if (problem) return problem; }
  }
  if (declarations.actions !== undefined) {
    if (!Array.isArray(declarations.actions) || declarations.actions.length > 64) return 'contributes.actions must be a list of at most 64 actions';
    const ids = new Set<string>();
    for (const action of declarations.actions) {
      if (!isRecord(action) || typeof action.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(action.id) || typeof action.label !== 'string' || !action.label || !['run', 'device-flow'].includes(String(action.kind))) return 'contributes.actions has an invalid action';
      if (ids.has(action.id)) return 'contributes.actions has a duplicate action id';
      ids.add(action.id);
    }
  }
  const seen = new Set<string>();
  for (const [key, check] of [['views', view], ['commands', command], ['tasks', taskProvider], ['agentBackends', agentBackend], ['avatarStyles', avatarStyle], ['agentTools', agentTools], ['channels', channel], ['modelUses', modelUse]] as const) {
    const items = declarations[key];
    if (items === undefined) continue;
    if (!Array.isArray(items)) return `contributes.${key} must be an array`;
    for (const [index, item] of items.entries()) {
      const problem = check(pluginId, item, `contributes.${key}[${index}]`);
      if (problem) return problem;
      const id = (item as { id: string }).id;
      if (seen.has(id)) return `contribution id "${id}" is declared twice`;
      seen.add(id);
    }
  }
  // Validated above, so a view's renderer can only name a provider this package declares.
  for (const [index, item] of (list(declarations.views) ?? []).entries()) {
    const renderer = (item as ViewDeclaration).renderer;
    const provider = renderer?.kind === 'tasks' ? renderer.provider : undefined;
    if (provider !== undefined && !(list(declarations.tasks) as TaskProviderDeclaration[] | undefined)?.some(declared => declared.id === provider)) return `contributes.views[${index}].renderer.provider "${provider}" is not declared in contributes.tasks`;
    const commands = renderer?.kind === 'form' ? [renderer.command] : renderer?.kind === 'list' ? renderer.items.flatMap(item => item.command ? [item.command] : []) : renderer?.kind === 'detail' ? (renderer.actions ?? []).map(item => item.command) : [];
    if (commands.some(command => !(list(declarations.commands) as CommandDeclaration[] | undefined)?.some(declared => declared.id === command))) return `contributes.views[${index}].renderer references an undeclared command`;
  }
  return declarations.appearance === undefined ? undefined : appearance(pluginId, declarations.appearance, seen);
}

/** The ids a plugin declares, for the registry's check that no two plugins claim one. */
export function declaredIds(declarations: PluginDeclarations | undefined): string[] {
  const { palettes, fonts, backgrounds, presets, iconPacks } = declarations?.appearance ?? {};
  return [...(declarations?.views ?? []), ...(declarations?.commands ?? []), ...(declarations?.tasks ?? []), ...(declarations?.agentBackends ?? []), ...(declarations?.avatarStyles ?? []), ...(declarations?.agentTools ?? []), ...(declarations?.channels ?? []), ...(declarations?.modelUses ?? []), ...(palettes ?? []), ...(fonts ?? []), ...(backgrounds ?? []), ...(presets ?? []), ...(iconPacks ?? [])].map(item => item.id);
}

/** The members of a validated record that this version knows, in that order: whatever else a package wrote there is dropped. */
function pick<T extends object>(item: T, keys: readonly string[]): T {
  return Object.fromEntries(keys.filter(key => (item as Record<string, unknown>)[key] !== undefined).map(key => [key, (item as Record<string, unknown>)[key]])) as T;
}
const pickView = (view: ViewDeclaration): ViewDeclaration => ({
  ...pick(view, ['id', 'title', 'locations', 'defaultLocation', 'settingsCategory', 'clients', 'instances', 'requires']),
  ...(view.icon ? { icon: pick(view.icon, ['svg', 'sfSymbol']) } : {}),
  ...(view.when ? { when: pick(view.when, CONDITION_KEYS) } : {}),
  ...(view.renderer ? { renderer: rendererSchema.parse(view.renderer) as ViewDeclaration['renderer'] } : {}),
});

/** Only the kinds and members this version knows: what a client is told is what was validated. */
export function knownDeclarations(declarations: PluginDeclarations | undefined): PluginDeclarations | undefined {
  if (!declarations) return undefined;
  const { appearance } = declarations;
  const views = declarations.views?.map(pickView);
  const commands = declarations.commands?.map((item): CommandDeclaration => ({
    ...pick(item, ['id', 'title', 'keybinding', 'scope', 'icon']),
    ...(item.menus ? { menus: [...item.menus] } : {}),
    ...(item.when ? { when: pick(item.when, CONDITION_KEYS) } : {}),
    ...(item.params ? { params: item.params.map(field => pick(field, ['key', 'label', 'kind', 'options', 'default', 'required'])) } : {}),
  }));
  const tasks = declarations.tasks?.map(item => pick(item, ['id', 'title', 'projectType']));
  const agentBackends = declarations.agentBackends?.map(item => ({ ...pick(item, ['id', 'title']), ...(item.icon ? { icon: pick(item.icon, ['svg', 'sfSymbol']) } : {}) }));
  const avatarStyles = declarations.avatarStyles?.map(item => pick(item, ['id', 'title', 'credit', 'needsName']));
  const agentToolGroups = declarations.agentTools?.map(item => ({ ...pick(item, ['id', 'title', 'description', 'toolPrefix']), ...(item.icon ? { icon: pick(item.icon, ['svg', 'sfSymbol']) } : {}) }));
  const channels = declarations.channels?.map(item => pick(item, ['id', 'scope']));
  const modelUses = declarations.modelUses?.map(item => pick(item, ['id', 'title', 'fallback']));
  const { palettes, fonts, backgrounds, presets, iconPacks } = appearance ?? {};
  const known = { ...(iconPacks?.length ? { iconPacks } : {}), ...(palettes?.length ? { palettes } : {}), ...(fonts?.length ? { fonts } : {}), ...(backgrounds?.length ? { backgrounds } : {}), ...(presets?.length ? { presets } : {}) };
  const declared = { ...(declarations.actions ? { actions: declarations.actions.map(item => pick(item, ['id', 'label', 'kind'])) } : {}), ...(declarations.modelSources ? { modelSources: declarations.modelSources.map(item => pick(item, ['id', 'role', 'usage', 'title', 'protocols', 'backends', 'defaultEndpoint', 'overridable', 'loginAction', 'hint', 'hosts'])) } : {}), ...(declarations.sharePublisher ? { sharePublisher: pick(declarations.sharePublisher, ['title']) } : {}), ...(views?.length ? { views } : {}), ...(commands?.length ? { commands } : {}), ...(tasks?.length ? { tasks } : {}), ...(agentBackends?.length ? { agentBackends } : {}), ...(avatarStyles?.length ? { avatarStyles } : {}), ...(agentToolGroups?.length ? { agentTools: agentToolGroups } : {}), ...(channels?.length ? { channels } : {}), ...(modelUses?.length ? { modelUses } : {}), ...(declarations.page ? { page: pick(declarations.page, ['title']) } : {}), ...(Object.keys(known).length ? { appearance: known } : {}) };
  return Object.keys(declared).length ? declared : undefined;
}

/** The manifest members added after API v1 began, and `settings`, which a package written as JSON could get wrong. */
function checkManifestRules(manifest: PluginManifest): string | undefined {
  const raw: Record<string, unknown> = { ...manifest };
  if (raw.version !== undefined && !(typeof raw.version === 'string' && SEMVER.test(raw.version))) return 'version must be a semantic version';
  if (raw.title !== undefined) { const problem = localized(raw.title, 'title', 80); if (problem) return problem; }
  if (raw.description !== undefined) { const problem = localized(raw.description, 'description', 400); if (problem) return problem; }
  if (raw.settings !== undefined) {
    const settings = list(raw.settings);
    if (!settings) return 'settings must be an array';
    const keys = new Set<string>();
    for (const [index, field] of settings.entries()) {
      if (!isRecord(field) || typeof field.key !== 'string' || !SETTING_KEY.test(field.key) || typeof field.label !== 'string' || (field.kind !== 'text' && field.kind !== 'secret')) return `settings[${index}] must have a key, a label and a kind of text or secret`;
      if (keys.has(field.key)) return `settings[${index}] repeats the key "${field.key}"`;
      keys.add(field.key);
    }
  }
  if (raw.requires !== undefined) {
    const requires = list(raw.requires);
    if (!requires) return 'requires must be an array';
    const ids = new Set<string>();
    for (const [index, item] of requires.entries()) {
      if (!isRecord(item) || typeof item.id !== 'string' || !PLUGIN_ID.test(item.id) || (item.optional !== undefined && typeof item.optional !== 'boolean')) return `requires[${index}] must name a plugin id`;
      if (item.id === manifest.id) return 'an integration cannot require itself';
      if (ids.has(item.id)) return `requires lists ${item.id} twice`;
      ids.add(item.id);
    }
  }
  return checkDeclarations(manifest.id, raw.contributes);
}

// Shapes power editor completion and runtime validation. Namespace ownership and references are
// relational rules checked below, because JSON Schema cannot interpolate the root plugin id.
const localizedSchema = (max: number) => z.record(z.string().regex(LANGUAGE_TAG), z.string().min(1).max(max).refine(value => Boolean(value.trim()), 'must contain text')).refine(value => Object.keys(value).length > 0, 'must contain a language');
const pathSchema = z.string().min(1).max(256).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\u0000]+$/).refine(isPackagePath, 'must be a relative path inside the package');
const titleSchema = localizedSchema(80);
const conditionSchema = z.object({ hasProject: z.literal(true).optional(), hasSession: z.literal(true).optional(), projectType: z.string().regex(CONDITION_TOKEN).optional(), capability: z.string().regex(CONDITION_TOKEN).optional() }).strict();
const iconSchema = z.object({ svg: pathSchema.optional(), sfSymbol: z.string().regex(SF_SYMBOL).optional() });
const primitiveSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const paramsSchema = z.array(z.object({ key: z.string().regex(PARAM_KEY), label: titleSchema, kind: z.enum(PARAM_KINDS), options: z.array(z.string().min(1).max(256)).min(1).max(64).optional(), default: primitiveSchema.optional(), required: z.boolean().optional() })).max(MAX_PARAMS);
const actionSchema = z.object({ id: z.string().min(1).max(64), title: titleSchema, command: z.string().min(1), args: z.record(z.string(), primitiveSchema).optional() });
export const rendererSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tasks'), provider: z.string().min(1) }),
  z.object({ kind: z.literal('list'), items: z.array(z.object({ id: z.string().min(1).max(64), title: titleSchema, description: localizedSchema(400).optional(), command: z.string().min(1).optional(), args: z.record(z.string(), primitiveSchema).optional() })).max(200) }),
  z.object({ kind: z.literal('form'), command: z.string().min(1), fields: paramsSchema.optional(), submit: titleSchema.optional() }),
  z.object({ kind: z.literal('detail'), fields: z.array(z.object({ label: titleSchema, value: localizedSchema(4000) })).max(100), actions: z.array(actionSchema).max(16).optional() }),
]);
const viewSchema = z.object({ id: z.string(), title: titleSchema, icon: iconSchema.optional(), locations: z.array(z.enum(VIEW_LOCATIONS)).min(1), defaultLocation: z.enum(VIEW_LOCATIONS).optional(), settingsCategory: z.enum(['agent', 'providers']).optional(), clients: z.array(z.enum(PLUGIN_CLIENTS)).min(1), instances: z.enum(VIEW_INSTANCES), when: conditionSchema.optional(), renderer: rendererSchema.optional(), requires: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)).max(64).optional() }).passthrough();
const modelSourceSchema = z.object({ role: z.enum(['source', 'adapter']).optional(), usage: z.boolean().optional(), id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/), title: titleSchema, protocols: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)).min(1).max(8).optional(), backends: z.array(z.enum(['claude', 'codex'])).optional(), defaultEndpoint: z.url().refine(value => /^https?:/.test(value), 'must use http or https').optional(), overridable: z.array(z.enum(['apiEndpoint', 'apiKey'])).optional(), loginAction: z.string().max(64).optional(), hint: z.object({ text: z.string().max(2000), command: z.string().max(2000).optional() }).optional(), hosts: z.array(z.string().refine(validSourceHost, 'must be a lowercase hostname, optionally with a leading "*." and a ":port"')).max(MAX_SOURCE_HOSTS).optional() }).passthrough();
const licenseSchema = z.object({ redistributable: z.boolean() });
const contributionSchema = { id: z.string(), title: titleSchema };
const appearanceSchema = z.object({
  palettes: z.array(z.object({ ...contributionSchema, asset: pathSchema })).max(64).optional(),
  iconPacks: z.array(z.object({ ...contributionSchema, asset: pathSchema })).max(64).optional(),
  fonts: z.array(z.object({ ...contributionSchema, role: z.enum(APPEARANCE_FONT_ROLES), family: z.string().regex(FONT_FAMILY), files: z.array(z.object({ path: pathSchema, weight: z.string().regex(FONT_WEIGHT).optional(), style: z.enum(APPEARANCE_FONT_STYLES).optional(), unicodeRange: z.string().max(1024).regex(UNICODE_RANGE).optional() })).min(1).max(16), fallback: z.array(z.string().regex(FONT_FAMILY)).max(8), license: licenseSchema.optional() })).max(64).optional(),
  backgrounds: z.array(z.object({ ...contributionSchema, asset: pathSchema, areas: z.array(z.enum(APPEARANCE_BACKGROUND_AREAS)).min(1), opacity: z.number().min(0).max(1).optional(), fit: z.enum(APPEARANCE_BACKGROUND_FITS).optional(), license: licenseSchema.optional() })).max(64).optional(),
  presets: z.array(z.object({ ...contributionSchema, palette: z.string().optional(), fonts: z.object({ ui: z.string().optional(), mono: z.string().optional() }).strict().optional(), background: z.string().optional() })).max(64).optional(),
}).passthrough();
const declarationsSchema = z.object({
  modelSources: z.array(modelSourceSchema).max(64).optional(),
  actions: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/), label: z.string().min(1).max(200), kind: z.enum(['run', 'device-flow']) })).max(64).optional(),
  sharePublisher: z.object({ title: titleSchema }).optional(),
  views: z.array(viewSchema).optional(),
  commands: z.array(z.object({ ...contributionSchema, when: conditionSchema.optional(), keybinding: z.string().regex(KEYBINDING).optional(), scope: z.enum(COMMAND_SCOPES).optional(), params: paramsSchema.optional(), menus: z.array(z.enum(COMMAND_MENUS)).min(1).optional(), icon: z.enum(COMMAND_ICONS).optional() }).passthrough()).optional(),
  tasks: z.array(z.object({ ...contributionSchema, projectType: z.string().regex(CONDITION_TOKEN).optional() }).passthrough()).optional(),
  agentBackends: z.array(z.object({ ...contributionSchema, icon: iconSchema.optional() }).passthrough()).optional(),
  avatarStyles: z.array(z.object({ ...contributionSchema, credit: z.string().max(AVATAR_CREDIT_MAX).optional(), needsName: z.boolean().optional() }).passthrough()).max(64).optional(),
  agentTools: z.array(z.object({ ...contributionSchema, description: localizedSchema(400).optional(), toolPrefix: z.string().regex(/^[a-z][a-z0-9]{1,23}_$/), icon: iconSchema.optional() }).passthrough()).max(16).optional(),
  channels: z.array(z.object({ id: z.string(), scope: z.literal('session') }).passthrough()).max(16).optional(),
  page: z.object({ title: localizedSchema(40).optional() }).passthrough().optional(),
  modelUses: z.array(z.object({ ...contributionSchema, fallback: z.enum(MODEL_USE_FALLBACKS).optional() }).passthrough()).max(16).optional(),
  appearance: appearanceSchema.optional(),
}).passthrough();

/** A bare command name: no path, no space. */
export const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_EXECUTABLES = 8;

export const manifestShape = z.object({
  $schema: z.string().optional(),
  id: z.string().regex(PLUGIN_ID).max(64), vendor: z.string().min(1), name: z.string().min(1), apiVersion: z.number().int(), defaultEnabled: z.union([z.boolean(), z.literal('auto')]), requiresTrustedHost: z.boolean().optional(),
  version: z.string().regex(SEMVER).optional(), title: titleSchema.optional(), description: localizedSchema(400).optional(),
  settings: z.array(z.object({ key: z.string().regex(SETTING_KEY), label: z.string(), kind: z.enum(['text', 'secret']) })).optional(),
  requires: z.array(z.object({ id: z.string().regex(PLUGIN_ID), optional: z.boolean().optional() })).optional(),
  hostApi: z.object({ server: z.string().optional(), web: z.string().optional(), agent: z.string().optional() }).passthrough().optional(),
  dataVersion: z.number().int().min(0).max(1_000_000).optional(), capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).max(PLUGIN_CAPABILITIES.length).optional(),
  executables: z.array(z.string().regex(EXECUTABLE_NAME)).max(MAX_EXECUTABLES).optional(),
  activation: z.array(z.enum(ACTIVATION_EVENTS)).min(1).max(5).optional(),
  entries: z.object({ server: pathSchema.optional(), web: pathSchema.optional() }).optional(),
  contributes: declarationsSchema.optional(),
}).passthrough();

/** Non-structural package rules shared by the host and build tools. */
export function checkPackageFields(manifest: PluginManifest): string | undefined {
  const raw: Record<string, unknown> = { ...manifest };
  if (raw.hostApi !== undefined) {
    if (!isRecord(raw.hostApi)) return 'hostApi must be an object';
    for (const [key, range] of Object.entries(raw.hostApi)) if (['server', 'web', 'agent'].includes(key) && !validRange(range)) return `hostApi.${key} must be a semantic version range`;
  }
  if (raw.dataVersion !== undefined && !(Number.isInteger(raw.dataVersion) && (raw.dataVersion as number) >= 0 && (raw.dataVersion as number) <= 1_000_000)) return 'dataVersion must be a non-negative integer';
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities) || raw.capabilities.length > PLUGIN_CAPABILITIES.length) return 'capabilities must be a list of capability names';
    for (const capability of raw.capabilities) if (!PLUGIN_CAPABILITIES.includes(capability as never)) return `capabilities names an unknown capability "${String(capability)}"`;
    if (new Set(raw.capabilities).size !== raw.capabilities.length) return 'capabilities repeats a name';
  }
  if (raw.executables !== undefined) {
    if (!Array.isArray(raw.executables) || raw.executables.length > MAX_EXECUTABLES || raw.executables.some(name => typeof name !== 'string' || !EXECUTABLE_NAME.test(name))) return `executables must list at most ${MAX_EXECUTABLES} bare command names`;
    if (new Set(raw.executables).size !== raw.executables.length) return 'executables repeats a name';
  }
  // The names are what the user is shown when granting `process.exec`, so one without the other is a mistake.
  if (Boolean((raw.executables as unknown[] | undefined)?.length) !== Boolean((raw.capabilities as unknown[] | undefined)?.includes('process.exec'))) return 'executables and the process.exec capability go together';
  if (raw.activation !== undefined) {
    if (!Array.isArray(raw.activation) || !raw.activation.length || raw.activation.length > 5 || raw.activation.some(kind => !ACTIVATION_EVENTS.includes(kind as never))) return 'activation must list startup, command, model-source, task or view';
    if (new Set(raw.activation).size !== raw.activation.length) return 'activation repeats a kind';
    const declarations = manifest.contributes;
    const declared = { command: declarations?.commands?.length ? declarations.commands : declarations?.actions, 'model-source': declarations?.modelSources, task: declarations?.tasks, view: declarations?.views };
    for (const kind of raw.activation) if (kind !== 'startup' && !declared[kind as keyof typeof declared]?.length) return `activation ${String(kind)} needs a matching static contribution`;
    if (raw.activation.includes('model-source') && declarations?.modelSources?.some(source => !source.protocols?.length && !source.backends?.length)) return 'on-demand model sources must declare protocols or backends';
  }
  return undefined;
}

export const manifestSchema = manifestShape.superRefine((value, context) => {
  const problem = apiVersionProblem(value.apiVersion) ?? checkManifestRules(value as PluginManifest) ?? checkPackageFields(value as PluginManifest);
  if (problem) context.addIssue({ code: 'custom', message: problem });
});

/**
 * Why a manifest's `apiVersion` is outside what this host loads, if it is. `min` and `current` default to the
 * SDK's constants; they are parameters so the range logic can be exercised with other bounds.
 */
export function apiVersionProblem(version: unknown, min: number = PLUGIN_API_MIN_VERSION, current: number = PLUGIN_API_VERSION): string | undefined {
  if (typeof version !== 'number' || !Number.isInteger(version)) return 'apiVersion must be an integer';
  if (version > current) return `written for plugin API v${version}; this Riffet provides up to v${current}`;
  if (version < min) return `written for plugin API v${version}; this Riffet no longer loads v${version} packages (it loads v${min} to v${current})`;
  return undefined;
}

export interface LoadedManifest {
  /** The manifest as this host reads it: what it does not know is left out. The same object when nothing was. */
  manifest: PluginManifest;
  /** One sentence per value left out. */
  notes: string[];
  /** Ids of the views and commands left out. */
  skipped: string[];
}

const rendererCommands = (renderer: Record<string, unknown>): unknown[] => renderer.kind === 'form' ? [renderer.command]
  : renderer.kind === 'list' ? (list(renderer.items) ?? []).flatMap(item => isRecord(item) && item.command !== undefined ? [item.command] : [])
  : renderer.kind === 'detail' ? (list(renderer.actions) ?? []).flatMap(item => isRecord(item) ? [item.command] : []) : [];

/**
 * What a host reads of a manifest written for another version: a value this version does not know leaves out
 * that one item (an unknown view location, client, renderer or `when` key; an unknown activation event) and
 * says so, instead of refusing the package. Values it does know are not touched, so whatever is malformed is
 * still found by `checkManifest`; capabilities are not handled here either, since a permission the host cannot
 * enforce must not be granted. A plugin whose activation events are all unknown is left with none, so it is
 * not started at launch.
 */
export function loadableManifest(manifest: PluginManifest): LoadedManifest {
  const notes: string[] = [];
  const skipped: string[] = [];
  const raw = manifest as unknown as Record<string, unknown>;
  const unknownKey = (when: unknown) => isRecord(when) ? Object.keys(when).find(key => !CONDITION_KEYS.includes(key as never)) : undefined;
  const declarations = isRecord(raw.contributes) ? raw.contributes : undefined;
  let contributes = declarations;
  let commands = list(declarations?.commands);
  let views = list(declarations?.views);
  const [commandsBefore, viewsBefore] = [commands?.length ?? 0, views?.length ?? 0];
  if (commands) commands = commands.flatMap(item => {
    if (!isRecord(item) || !isContributionOf(manifest.id, item.id)) return [item];
    const id = item.id;
    const key = unknownKey(item.when);
    if (key !== undefined) { notes.push(`command "${id}" skipped: unknown condition "${key}"`); skipped.push(id); return []; }
    let next: Record<string, unknown> = item;
    // A command meant for menus this host does not have is not offered in the palette instead: it would run without the context the menu gives it.
    const menus = list(item.menus);
    const unknownMenus = menus?.filter(value => !(COMMAND_MENUS as readonly unknown[]).includes(value));
    if (menus && unknownMenus?.length) {
      if (unknownMenus.length === menus.length) { notes.push(`command "${id}" skipped: unknown menu "${String(unknownMenus[0])}"`); skipped.push(id); return []; }
      for (const value of unknownMenus) notes.push(`command "${id}": unknown menu "${String(value)}" ignored`);
      next = { ...next, menus: menus.filter(value => !unknownMenus.includes(value)) };
    }
    if (item.icon !== undefined && !(COMMAND_ICONS as readonly unknown[]).includes(item.icon)) {
      notes.push(`command "${id}": unknown icon "${String(item.icon)}" ignored`);
      const { icon: _, ...rest } = next;
      next = rest;
    }
    return [next];
  });
  if (views) views = views.flatMap(item => {
    if (!isRecord(item) || !isContributionOf(manifest.id, item.id)) return [item];
    const id = item.id;
    const skip = (reason: string) => { notes.push(`view "${id}" skipped: ${reason}`); skipped.push(id); return []; };
    let next: Record<string, unknown> = item;
    let narrowed = false;
    for (const [field, known, what] of [['locations', VIEW_LOCATIONS, 'location'], ['clients', PLUGIN_CLIENTS, 'client']] as const) {
      const values = list(item[field]);
      const unknown = values?.filter(value => !(known as readonly unknown[]).includes(value));
      if (!values || !unknown?.length) continue;
      if (unknown.length === values.length) return skip(`unknown ${what} "${String(unknown[0])}"`);
      for (const value of unknown) notes.push(`view "${id}": unknown ${what} "${String(value)}" ignored`);
      next = { ...next, [field]: values.filter(value => !unknown.includes(value)) };
      narrowed = true;
    }
    if (narrowed && typeof next.defaultLocation === 'string' && !(VIEW_LOCATIONS as readonly string[]).includes(next.defaultLocation)) { const { defaultLocation: _, ...rest } = next; next = rest; }
    const renderer = isRecord(item.renderer) ? item.renderer : undefined;
    if (renderer && typeof renderer.kind === 'string' && !rendererSchema.options.some(option => option.shape.kind.value === renderer.kind)) return skip(`unknown renderer "${renderer.kind}"`);
    const key = unknownKey(item.when);
    if (key !== undefined) return skip(`unknown condition "${key}"`);
    const lost = renderer ? rendererCommands(renderer).find(command => typeof command === 'string' && skipped.includes(command)) : undefined;
    return lost !== undefined ? skip(`its command "${String(lost)}" was skipped`) : [next];
  });
  if (declarations && (commands?.length !== commandsBefore || views?.length !== viewsBefore || notes.length)) {
    contributes = { ...declarations, ...(commands ? { commands } : {}), ...(views ? { views } : {}) };
  }
  let activation = list(raw.activation);
  if (activation) {
    const known = activation.filter(event => (ACTIVATION_EVENTS as readonly unknown[]).includes(event));
    for (const event of activation) if (!known.includes(event)) notes.push(`activation event "${String(event)}" is not known to this Riffet`);
    // An event that waits on a contribution is dropped when every one of its contributions was skipped.
    const emptied = (event: string, before: number, after: number | undefined, extra = 0) => before > 0 && !(after ?? 0) && !extra && known.includes(event);
    const lost = [
      ...(emptied('command', commandsBefore, commands?.length, list(declarations?.actions)?.length ?? 0) ? ['command'] : []),
      ...(emptied('view', viewsBefore, views?.length) ? ['view'] : []),
    ];
    for (const event of lost) notes.push(`activation event "${event}" dropped: all its contributions were skipped`);
    const kept = known.filter(event => !lost.includes(event as string));
    activation = kept.length === activation.length ? undefined : kept;
  }
  if (!notes.length) return { manifest, notes, skipped };
  return { manifest: { ...manifest, ...(contributes !== declarations ? { contributes: contributes as PluginManifest['contributes'] } : {}), ...(activation ? { activation: activation as PluginManifest['activation'] } : {}) }, notes, skipped };
}

/**
 * The one validation of a manifest. `author` (the default, used by `check` and `pack`) refuses every value this
 * SDK does not know: there the tool and the SDK are one version, so an unknown value is a typo. `load` (the
 * host) first leaves out what `loadableManifest` says it does not know, then applies the same rules.
 */
export function checkManifest(manifest: PluginManifest, mode: 'author' | 'load' = 'author'): string | undefined {
  const versionProblem = apiVersionProblem(manifest.apiVersion);
  if (versionProblem) return versionProblem;
  let checked = mode === 'load' ? loadableManifest(manifest).manifest : manifest;
  // Every event unknown to this host leaves a plugin with none, which `activation` itself does not allow.
  if (checked !== manifest && checked.activation && !checked.activation.length && manifest.activation?.length) { const { activation: _, ...rest } = checked; checked = rest as PluginManifest; }
  const existing = checkManifestRules(checked) ?? checkPackageFields(checked);
  if (existing) return existing;
  const result = manifestSchema.safeParse(checked);
  if (result.success) return undefined;
  const issue = result.error.issues[0]!;
  return `${issue.path.length ? issue.path.join('.') + ': ' : ''}${issue.message}`;
}

export const manifestJsonSchema = {
  ...z.toJSONSchema(manifestShape.required({ version: true }), { unrepresentable: 'any', io: 'input' }),
  $id: 'urn:riffet:plugin-manifest:1',
  title: 'Riffet Plugin Manifest v1',
  $comment: 'Namespace ownership, duplicate identities and declared references are additionally checked by @riffet/plugin-api/manifest.',
};
