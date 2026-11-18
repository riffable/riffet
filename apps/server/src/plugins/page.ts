// A plugin's page and README (docs/PLUGIN_ARCHITECTURE.md「插件页」). What a plugin answers reaches every client as it
// is, so the page is checked and trimmed here, for in-process and isolated packages alike: one malformed item must not
// break the details a user turns the plugin off from.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLUGIN_PAGE_EXTRA_KINDS, type PluginPage, type PluginPageButton, type PluginPageExtraKind, type PluginPageItem, type PluginPageOption, type PluginPageSection } from '../../../../packages/contracts/src/index.js';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const malformed = (what: string) => new Error(`the plugin's page has a malformed ${what}`);
const text = (value: unknown, max: number, what: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw malformed(what);
  return value.slice(0, max);
};
/** Absent, or empty, is no text. */
const optionalText = (value: unknown, max: number, what: string): string | undefined => value === undefined || value === null || (typeof value === 'string' && !value.trim()) ? undefined : text(value, max, what);
const list = (value: unknown, max: number, what: string): unknown[] => {
  if (!Array.isArray(value)) throw malformed(what);
  return value.slice(0, max);
};
const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

function button(raw: unknown): PluginPageButton {
  if (!isRecord(raw)) throw malformed('button');
  return defined({
    action: text(raw.action, 64, 'button'), label: text(raw.label, 80, 'button'), item: optionalText(raw.item, 512, 'button'),
    destructive: raw.destructive === true || undefined, confirm: optionalText(raw.confirm, 200, 'button'), confirmDetail: optionalText(raw.confirmDetail, 300, 'button'), disabled: raw.disabled === true || undefined,
  });
}

function option(raw: unknown): PluginPageOption {
  if (!isRecord(raw)) throw malformed('option');
  return defined({
    value: typeof raw.value === 'string' ? raw.value.slice(0, 512) : (() => { throw malformed('option'); })(),
    label: text(raw.label, 120, 'option'), detail: optionalText(raw.detail, 200, 'option'), disabled: raw.disabled === true || undefined,
    button: raw.button === undefined ? undefined : button(raw.button),
  });
}

/** `secret` is whether the item's key is a secret setting: its value is dropped and only whether one is saved is told. */
function item(raw: unknown, settings: ReadonlyMap<string, 'text' | 'secret'>, secretSet: (key: string) => boolean): PluginPageItem {
  if (!isRecord(raw)) throw malformed('item');
  const keyed = () => {
    const key = text(raw.key, 64, 'item');
    if (!settings.has(key)) throw new Error(`the plugin's page names "${key}", which is not one of its settings`);
    if (settings.get(key) === 'secret' && raw.kind !== 'text') throw new Error(`the plugin's page shows the secret "${key}" as a ${String(raw.kind)}`);
    return key;
  };
  const label = () => text(raw.label, 120, 'item');
  switch (raw.kind) {
    case 'choice': return { kind: 'choice', key: keyed(), label: label(), value: typeof raw.value === 'string' ? raw.value : '', options: list(raw.options, 16, 'choice').map(option) };
    case 'toggle': return defined({ kind: 'toggle' as const, key: keyed(), label: label(), on: raw.on === true, detail: optionalText(raw.detail, 200, 'toggle') });
    case 'text': {
      const key = keyed();
      const secret = settings.get(key) === 'secret';
      return defined({
        kind: 'text' as const, key, label: label(), placeholder: optionalText(raw.placeholder, 200, 'text'),
        ...(secret ? { secret: true, set: secretSet(key) } : { value: typeof raw.value === 'string' ? raw.value.slice(0, 4096) : undefined }),
      });
    }
    case 'list': return defined({ kind: 'list' as const, key: keyed(), label: label(), values: list(raw.values, 200, 'list').map(value => text(value, 512, 'list')), placeholder: optionalText(raw.placeholder, 200, 'list') });
    case 'row': return defined({
      kind: 'row' as const, id: text(raw.id, 200, 'row'), label: label(), value: optionalText(raw.value, 200, 'row'), detail: optionalText(raw.detail, 400, 'row'),
      buttons: raw.buttons === undefined ? undefined : list(raw.buttons, 4, 'row').map(button),
    });
    case 'meter': {
      if (typeof raw.percent !== 'number' || !Number.isFinite(raw.percent)) throw malformed('meter');
      if (raw.sense !== 'quota' && raw.sense !== 'progress') throw malformed('meter');
      return defined({
        kind: 'meter' as const, id: text(raw.id, 200, 'meter'), label: label(), percent: Math.min(100, Math.max(0, raw.percent)), sense: raw.sense,
        value: optionalText(raw.value, 200, 'meter'), detail: optionalText(raw.detail, 400, 'meter'),
        buttons: raw.buttons === undefined ? undefined : list(raw.buttons, 4, 'meter').map(button),
      });
    }
    case 'buttons': return { kind: 'buttons', buttons: list(raw.buttons, 8, 'buttons').map(button) };
    default: throw malformed(`item kind ${String(raw.kind)}`);
  }
}

export function checkedPage(raw: unknown, settings: ReadonlyMap<string, 'text' | 'secret'>, secretSet: (key: string) => boolean): PluginPage {
  if (!isRecord(raw)) throw malformed('answer');
  const ids = new Set<string>();
  const sections = list(raw.sections, 32, 'section list').map((section): PluginPageSection => {
    if (!isRecord(section)) throw malformed('section');
    const id = text(section.id, 64, 'section');
    if (ids.has(id)) throw malformed(`section id ${id}`);
    ids.add(id);
    return defined({ id, title: optionalText(section.title, 80, 'section'), footer: optionalText(section.footer, 400, 'section'), items: list(section.items, 200, 'section').map(entry => item(entry, settings, secretSet)) });
  });
  const refreshMs = typeof raw.refreshMs === 'number' && Number.isFinite(raw.refreshMs) ? Math.min(Math.max(Math.round(raw.refreshMs), 500), 60_000) : undefined;
  return defined({ sections, refreshMs });
}

/**
 * The page as a client that draws only `kinds` beyond the six every client has reads it (docs/design/system/plugins.md §6.4):
 * a `meter` it cannot draw becomes a row with its figure as the value.
 */
export function pageForClient(page: PluginPage, kinds: ReadonlySet<PluginPageExtraKind>, locale: string | undefined): PluginPage {
  if (kinds.has('meter')) return page;
  const zh = (locale ?? '').toLowerCase().startsWith('zh');
  const figure = (percent: number, sense: 'quota' | 'progress') => {
    const shown = Math.round(sense === 'quota' ? 100 - percent : percent);
    return sense === 'progress' ? `${shown}%` : zh ? `剩余 ${shown}%` : `${shown}% left`;
  };
  return {
    ...page,
    sections: page.sections.map(section => ({
      ...section,
      items: section.items.map((entry): PluginPageItem => entry.kind !== 'meter' ? entry : defined({
        kind: 'row' as const, id: entry.id, label: entry.label, value: entry.value ? `${entry.value} · ${figure(entry.percent, entry.sense)}` : figure(entry.percent, entry.sense),
        detail: entry.detail, buttons: entry.buttons,
      })),
    })),
  };
}

/** The extra kinds a client listed in `PLUGIN_PAGE_KINDS_PARAM`; unknown names are ignored. */
export function clientKinds(raw: unknown): Set<PluginPageExtraKind> {
  const names = typeof raw === 'string' ? raw.split(',').map(name => name.trim()) : [];
  return new Set(PLUGIN_PAGE_EXTRA_KINDS.filter(kind => names.includes(kind)));
}

/** How a page's value is kept in the settings: a toggle as `true`/`false`, a list as a JSON array. `null` clears. */
export function settingValue(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.length <= 200 && value.every(item => typeof item === 'string')) {
    const items = [...new Set(value.map(item => item.trim()).filter(Boolean))];
    return items.length ? JSON.stringify(items) : null;
  }
  throw new Error('a page value is text, true or false, a list of text, or null');
}

/** The tags to try for `locale`, nearest first: `zh-Hans-CN` → `zh-Hans-CN`, `zh-Hans`, `zh`. */
function tags(locale: string | undefined): string[] {
  const parts = (locale ?? '').replaceAll('_', '-').split('-').filter(Boolean);
  return parts.map((_, index) => parts.slice(0, parts.length - index).join('-'));
}

const README_BYTES = 256 * 1024;

/** `README.<tag>.md` nearest `locale`, else `README.md`, from a package's root. */
export async function packageReadme(root: string, locale: string | undefined): Promise<string | undefined> {
  const nearest = tags(locale);
  if (nearest.at(-1)?.toLowerCase() === 'zh' && !nearest.some(tag => tag.toLowerCase() === 'zh-hans')) nearest.splice(-1, 0, 'zh-Hans');
  for (const name of [...nearest.map(tag => `README.${tag}.md`), 'README.md', 'readme.md']) {
    try {
      const bytes = await readFile(join(root, name));
      return bytes.subarray(0, README_BYTES).toString('utf8');
    } catch { /* the next one */ }
  }
  return undefined;
}
