import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  APPEARANCE_MAX_ICON_PACK_BYTES, iconPackProblem, APPEARANCE_MAX_FONT_BYTES, APPEARANCE_MAX_IMAGE_BYTES, APPEARANCE_MAX_PALETTE_BYTES, validateCustomThemes,
  type AppearanceAsset, type AppearanceCatalog, type AppearanceDeclarations, type CustomTheme, type ShareAppearance, type ShareFont,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { confined } from '../plugins/development.js';

type Kind = 'font' | 'image' | 'palette' | 'iconPack' | 'agentIcon';
interface Source { id: string; appearance: AppearanceDeclarations; root: string }
interface Resolved { file: string; sha256: string; size: number; type: string }

/** What an image's bytes must start with; a declared type or extension is never taken on trust. Shared with the owner's avatar. */
export const IMAGE_MAGIC: Record<'image/png' | 'image/jpeg' | 'image/webp', (head: Buffer) => boolean> = {
  'image/png': head => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': head => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  'image/webp': head => head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP',
};
/** The allow-list: what a package may ship as an appearance asset, and the largest each may be. */
const TYPES: Record<string, { kind: Kind; type: string; limit: number; magic?: (head: Buffer) => boolean }> = {
  '.woff2': { kind: 'font', type: 'font/woff2', limit: APPEARANCE_MAX_FONT_BYTES, magic: head => head.subarray(0, 4).toString('latin1') === 'wOF2' },
  '.png': { kind: 'image', type: 'image/png', limit: APPEARANCE_MAX_IMAGE_BYTES, magic: IMAGE_MAGIC['image/png'] },
  '.jpg': { kind: 'image', type: 'image/jpeg', limit: APPEARANCE_MAX_IMAGE_BYTES, magic: IMAGE_MAGIC['image/jpeg'] },
  '.jpeg': { kind: 'image', type: 'image/jpeg', limit: APPEARANCE_MAX_IMAGE_BYTES, magic: IMAGE_MAGIC['image/jpeg'] },
  '.webp': { kind: 'image', type: 'image/webp', limit: APPEARANCE_MAX_IMAGE_BYTES, magic: IMAGE_MAGIC['image/webp'] },
  '.json': { kind: 'palette', type: 'application/json', limit: APPEARANCE_MAX_PALETTE_BYTES },
};
/** An Agent icon is a mark, not artwork: a larger file is refused. */
const AGENT_ICON_MAX_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SHARE_EXTENSIONS: Record<string, string> = { 'font/woff2': '.woff2', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
/** What clients paint a plugin palette under: `plugin-` and the first 16 hex digits of its content hash (`paletteKey` in the web's `lib/appearance-select.ts`). */
const PALETTE_KEY = /^plugin-([0-9a-f]{16})$/;

const warned = new Set<string>();

/**
 * The catalog of what the enabled plugins contribute to appearance (docs/THEMES.md "插件外观"), and
 * the files behind it. A package declares paths; this resolves each to a content-addressed asset:
 * the real path must stay inside the package, the type must be on the allow-list and match the
 * file's own bytes, the size must be within the limit, and a palette must be a valid theme. An item
 * whose file fails any check is left out of the catalog, as if it were not declared.
 */
export class AppearanceService {
  /** By real path; a changed size, mtime or inode is read again, so an edited file gets its new hash. */
  private readonly resolved = new Map<string, { stamp: string; kind: Kind; result: Resolved | string }>();

  constructor(private readonly registry: {
    appearanceSources(): Source[];
    /** Other versions of an installed plugin that are still on disk, whose asset addresses stay valid. */
    retainedAppearanceSources?(pluginId: string): Promise<Source[]>;
    agentIconSources?(): Array<{ agentId: string; svg: string; root: string }>;
  }) {}

  async catalog(): Promise<AppearanceCatalog> {
    const body: Omit<AppearanceCatalog, 'revision'> = { version: 1, palettes: [], fonts: [], backgrounds: [], presets: [], iconPacks: [] };
    for (const source of this.registry.appearanceSources()) {
      const { palettes = [], fonts = [], backgrounds = [], presets = [], iconPacks = [] } = source.appearance;
      const asset = async (path: string, kind: Kind): Promise<AppearanceAsset | undefined> => {
        const found = await this.resolve(source, path, kind);
        return found && { url: `/api/appearance/assets/${source.id}/${found.sha256}`, sha256: found.sha256, size: found.size, type: found.type };
      };
      for (const pack of iconPacks) {
        const found = await asset(pack.asset, 'iconPack');
        if (found) body.iconPacks!.push({ id: pack.id, plugin: source.id, title: pack.title, asset: found });
      }
      for (const palette of palettes) {
        const found = await asset(palette.asset, 'palette');
        if (found) body.palettes.push({ id: palette.id, plugin: source.id, title: palette.title, asset: found });
      }
      for (const font of fonts) {
        const files = await Promise.all(font.files.map(async file => {
          const found = await asset(file.path, 'font');
          return found && { ...found, ...(file.weight ? { weight: file.weight } : {}), ...(file.style ? { style: file.style } : {}), ...(file.unicodeRange ? { unicodeRange: file.unicodeRange } : {}) };
        }));
        if (files.every(file => file)) body.fonts.push({ id: font.id, plugin: source.id, title: font.title, role: font.role, family: font.family, fallback: font.fallback, files: files as NonNullable<typeof files[number]>[] });
      }
      for (const background of backgrounds) {
        const found = await asset(background.asset, 'image');
        if (found) body.backgrounds.push({ id: background.id, plugin: source.id, title: background.title, asset: found, areas: background.areas, opacity: background.opacity ?? 1, fit: background.fit ?? 'cover' });
      }
      for (const preset of presets) body.presets.push({ ...preset, plugin: source.id });
    }
    return { ...body, revision: createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32) };
  }

  /**
   * Every asset `source` declares that the catalog would leave out, with the reason. An install and a pack refuse a package
   * that has any, so a broken newer version cannot replace a working one by dropping its contribution.
   */
  async problems(source: Source): Promise<string[]> {
    const { palettes = [], fonts = [], backgrounds = [], iconPacks = [] } = source.appearance;
    const declared: Array<[string, Kind]> = [
      ...palettes.map((item): [string, Kind] => [item.asset, 'palette']),
      ...iconPacks.map((item): [string, Kind] => [item.asset, 'iconPack']),
      ...fonts.flatMap(font => font.files.map((file): [string, Kind] => [file.path, 'font'])),
      ...backgrounds.map((item): [string, Kind] => [item.asset, 'image']),
    ];
    const found: string[] = [];
    for (const [path, kind] of declared) {
      const reasons: string[] = [];
      if (!await this.resolve(source, path, kind, reason => reasons.push(reason))) found.push(`${path}: ${reasons[0] ?? 'it cannot be used'}`);
    }
    return found;
  }

  /**
   * The palette clients paint under `key`, as a theme that stands alone (a `custom-` id derived from the key), or
   * nothing when no enabled plugin holds it now. A frozen share keeps this instead of a reference to the plugin.
   */
  async palette(key: string): Promise<CustomTheme | undefined> {
    const prefix = PALETTE_KEY.exec(key)?.[1];
    if (!prefix) return undefined;
    for (const source of this.registry.appearanceSources()) {
      for (const palette of source.appearance.palettes ?? []) {
        const found = await this.resolve(source, palette.asset, 'palette');
        if (!found?.sha256.startsWith(prefix)) continue;
        // Read again and compared: the file may have changed since it was inspected.
        const bytes = await readFile(found.file).catch(() => undefined);
        if (!bytes || createHash('sha256').update(bytes).digest('hex') !== found.sha256) continue;
        let document: unknown;
        try { document = JSON.parse(bytes.toString('utf8')); } catch { continue; }
        const theme = validateCustomThemes([document]).themes[0];
        if (theme) return { ...theme, id: `custom-plugin-${prefix}` };
      }
    }
    return undefined;
  }

  /**
   * The fonts and background of `request` (contribution ids of the enabled plugins) that a frozen share may carry, with the
   * files to put in the package at the package-relative addresses the result names (`./appearance/<sha256>.<ext>`). Only
   * a declaration that says `license.redistributable` is copied; any other, an id no plugin holds, and one whose file is
   * refused or changed since it was inspected are left out, and the share page uses its own font or background there.
   */
  async shareAssets(request: { uiFont?: string; monoFont?: string; background?: string }): Promise<Pick<ShareAppearance, 'fonts' | 'background'> & { files: Array<{ name: string; data: Buffer }> }> {
    const files = new Map<string, Buffer>();
    const read = async (source: Source, path: string, kind: Kind): Promise<{ url: string; sha256: string; name: string; data: Buffer } | undefined> => {
      const found = await this.resolve(source, path, kind);
      const extension = found && SHARE_EXTENSIONS[found.type];
      const data = found && extension ? await readFile(found.file).catch(() => undefined) : undefined;
      if (!found || !extension || !data || createHash('sha256').update(data).digest('hex') !== found.sha256) return undefined;
      const name = `appearance/${found.sha256}${extension}`;
      return { url: `./${name}`, sha256: found.sha256, name, data };
    };
    const result: Pick<ShareAppearance, 'fonts' | 'background'> = {};
    const sources = this.registry.appearanceSources();
    for (const [slot, id] of [['ui', request.uiFont], ['mono', request.monoFont]] as const) {
      for (const source of id ? sources : []) {
        const font = source.appearance.fonts?.find(item => item.id === id && item.role === slot && item.license?.redistributable === true);
        if (!font) continue;
        const loaded = await Promise.all(font.files.map(file => read(source, file.path, 'font')));
        if (loaded.every(item => item)) {
          loaded.forEach(item => files.set(item!.name, item!.data));
          (result.fonts ??= {})[slot] = { fallback: font.fallback, files: loaded.map((item, index) => {
            const file = font.files[index]!;
            return { url: item!.url, sha256: item!.sha256, ...(file.weight ? { weight: file.weight } : {}), ...(file.style ? { style: file.style } : {}), ...(file.unicodeRange ? { unicodeRange: file.unicodeRange } : {}) };
          }) } satisfies ShareFont;
        }
        break;
      }
    }
    for (const source of request.background ? sources : []) {
      const background = source.appearance.backgrounds?.find(item => item.id === request.background && item.areas.includes('workbench') && item.license?.redistributable === true);
      if (!background) continue;
      const image = await read(source, background.asset, 'image');
      if (image) {
        files.set(image.name, image.data);
        result.background = { url: image.url, opacity: background.opacity ?? 1, fit: background.fit ?? 'cover' };
      }
      break;
    }
    return { ...result, files: [...files].map(([name, data]) => ({ name, data })) };
  }

  /**
   * The file behind `/api/appearance/assets/:pluginId/:sha256`: only an asset an enabled plugin declares, and only while it still
   * has that hash. A version an upgrade replaced still counts while its files are installed, since a client may hold its address.
   */
  async asset(pluginId: string, sha256: string): Promise<Resolved> {
    const current = SHA256.test(sha256) ? this.registry.appearanceSources().find(item => item.id === pluginId) : undefined;
    const sources = current ? [current, ...await this.registry.retainedAppearanceSources?.(pluginId) ?? []] : [];
    for (const source of sources) {
      const { palettes = [], fonts = [], backgrounds = [], iconPacks = [] } = source.appearance;
      const declared: Array<[string, Kind]> = [
        ...palettes.map((item): [string, Kind] => [item.asset, 'palette']),
        ...iconPacks.map((item): [string, Kind] => [item.asset, 'iconPack']),
        ...fonts.flatMap(font => font.files.map((file): [string, Kind] => [file.path, 'font'])),
        ...backgrounds.map((item): [string, Kind] => [item.asset, 'image']),
      ];
      for (const [path, kind] of declared) {
        const found = await this.resolve(source, path, kind);
        if (found?.sha256 === sha256) return found;
      }
    }
    throw new AppError('APPEARANCE_ASSET_NOT_FOUND', 'The asset does not exist', 404);
  }

  /**
   * The SVG a package declares as the icon of one of its Agents (`AgentBackendDeclaration.icon.svg`), served
   * at `AGENT_ICON_ROUTE` whether or not the plugin is on, so a conversation of a disabled Agent keeps its mark.
   * Addressed by Agent id rather than by hash: the file is read again whenever it changes. Only the declared
   * path is reachable, and a client draws it as an image, which never runs the script an SVG could carry.
   */
  async agentIcon(agentId: string): Promise<Resolved> {
    const declared = this.registry.agentIconSources?.().find(item => item.agentId === agentId);
    const root = declared ? await realpath(declared.root).catch(() => undefined) : undefined;
    const file = root && declared ? await confined(root, declared.svg).catch(() => undefined) : undefined;
    if (file && extname(file).toLowerCase() === '.svg') {
      const info = await stat(file).catch(() => undefined);
      if (info && info.size <= AGENT_ICON_MAX_BYTES) {
        const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
        const cached = this.resolved.get(file);
        if (cached?.stamp === stamp && cached.kind === 'agentIcon') {
          if (typeof cached.result !== 'string') return cached.result;
          throw new AppError('AGENT_ICON_NOT_FOUND', 'The Agent declares no icon', 404);
        }
        const bytes = await readFile(file).catch(() => undefined);
        if (bytes) {
          if (bytes.length <= AGENT_ICON_MAX_BYTES && /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(bytes.subarray(0, 512).toString('utf8'))) {
            const result: Resolved = { file, size: bytes.length, type: 'image/svg+xml', sha256: createHash('sha256').update(bytes).digest('hex') };
            this.resolved.set(file, { stamp, kind: 'agentIcon', result });
            return result;
          }
          this.resolved.set(file, { stamp, kind: 'agentIcon', result: 'invalid svg' });
        }
      }
    }
    throw new AppError('AGENT_ICON_NOT_FOUND', 'The Agent declares no icon', 404);
  }

  private async resolve(source: Source, path: string, kind: Kind, refused?: (reason: string) => void): Promise<Resolved | undefined> {
    const fail = (reason: string): undefined => {
      refused?.(reason);
      const key = `${source.id}:${path}:${reason}`;
      if (!warned.has(key)) { warned.add(key); console.warn(`[riffet] appearance asset ${path} of ${source.id} is not served: ${reason}`); }
      return undefined;
    };
    // A file that cannot be read now (gone, unreadable, replaced between the checks) drops that item alone.
    try {
      const root = await realpath(source.root).catch(() => undefined);
      const file = root ? await confined(root, path) : undefined;
      if (!file) return fail('it is not a file inside the package');
      const extension = extname(file).toLowerCase();
      const rule = kind === 'iconPack' && extension === '.json'
        ? { kind, type: 'application/json', limit: APPEARANCE_MAX_ICON_PACK_BYTES }
        : TYPES[extension];
      if (!rule || rule.kind !== kind) return fail('its type is not allowed here');
      const info = await stat(file);
      if (info.size > rule.limit) return fail(`it is larger than ${rule.limit} bytes`);
      const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
      const cached = this.resolved.get(file);
      if (cached?.stamp === stamp && cached.kind === kind) return typeof cached.result === 'string' ? fail(cached.result) : cached.result;
      const result = await this.inspect(file, rule, info.size);
      this.resolved.set(file, { stamp, kind, result });
      return typeof result === 'string' ? fail(result) : result;
    } catch (error) {
      return fail(`it cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }

  /** The asset, or the reason it is refused. */
  private async inspect(file: string, rule: typeof TYPES[string], size: number): Promise<Resolved | string> {
    const bytes = await readFile(file);
    if (rule.magic && !rule.magic(bytes)) return `its content is not ${rule.type}`;
    if (bytes.length > rule.limit) return 'asset exceeds size limit';
    if (rule.kind === 'iconPack') {
      try { const problem = iconPackProblem(JSON.parse(bytes.toString('utf8'))); if (problem) return problem; }
      catch { return 'it is not valid JSON'; }
    }
    if (rule.kind === 'palette') {
      let theme: unknown;
      try { theme = JSON.parse(bytes.toString('utf8')); } catch { return 'it is not valid JSON'; }
      const issue = validateCustomThemes([theme]).issues[0];
      if (issue) return `it is not a theme: ${issue.path} ${issue.message}`;
    }
    return { file, size, type: rule.type, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}
