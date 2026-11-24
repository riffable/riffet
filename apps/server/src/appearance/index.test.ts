import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_ANSI_KEYS, THEME_ROLES, type AppearanceDeclarations } from '../../../../packages/contracts/src/index.js';
import { checkDeclarations, declaredIds, knownDeclarations } from '../plugins/declarations.js';
import { PluginRegistry } from '../plugins/registry.js';
import { AppearanceService } from './index.js';

const directories: string[] = [];
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory(): Promise<string> { const path = await realpath(await mkdtemp(join(tmpdir(), 'riffet-appearance-'))); directories.push(path); return path; }

const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const palette = (id = 'custom-pack-theme') => {
  const colors = (color: string) => Object.fromEntries(THEME_ROLES.map(role => [role, color]));
  const ansi = Array.from({ length: THEME_ANSI_KEYS.length }, () => '#112233');
  return { id, name: 'Pack', palette: { light: colors('#ffffff'), dark: colors('#000000') }, ansi: { light: ansi, dark: ansi } };
};

/** A package directory with a valid font, background and palette, plus whatever `extra` adds. */
async function pack(extra: Record<string, Buffer | string> = {}): Promise<string> {
  const root = await directory();
  await mkdir(join(root, 'assets'));
  const files: Record<string, Buffer | string> = { 'font.woff2': WOFF2, 'grain.png': PNG, 'theme.json': JSON.stringify(palette()), ...extra };
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, 'assets', name), content);
  return root;
}
const declarations = (assets: { font?: string; background?: string; palette?: string } = {}): AppearanceDeclarations => ({
  palettes: [{ id: 'acme.pack/theme', title: { en: 'Theme' }, asset: assets.palette ?? 'assets/theme.json' }],
  fonts: [{ id: 'acme.pack/font', title: { en: 'Font' }, role: 'ui', family: 'Acme', fallback: [], files: [{ path: assets.font ?? 'assets/font.woff2' }] }],
  backgrounds: [{ id: 'acme.pack/grain', title: { en: 'Grain' }, asset: assets.background ?? 'assets/grain.png', areas: ['workbench'] }],
  presets: [{ id: 'acme.pack/preset', title: { en: 'Preset' }, palette: 'acme.pack/theme' }],
});
const service = (root: string, appearance: AppearanceDeclarations, enabled = true) => new AppearanceService({ appearanceSources: () => (enabled ? [{ id: 'acme.pack', appearance, root }] : []) });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('appearance catalog', () => {
  it('keeps icon-pack declarations, serves bounded vectors, and withdraws disabled packages', async () => {
    const document = { version: 1, icons: { Plus: { width: 24, height: 24, paths: [{ d: 'M12 4v16M4 12h16', fill: false, strokeWidth: 2 }] } } };
    const bytes = Buffer.from(JSON.stringify(document));
    const root = await pack({ 'icons.json': bytes });
    const appearance: AppearanceDeclarations = { iconPacks: [{ id: 'acme.pack/icons', title: { en: 'Icons' }, asset: 'assets/icons.json' }] };
    expect(checkDeclarations('acme.pack', { appearance })).toBeUndefined();
    expect(knownDeclarations({ appearance })?.appearance?.iconPacks).toEqual(appearance.iconPacks);
    expect(declaredIds({ appearance })).toEqual(['acme.pack/icons']);
    const enabled = service(root, appearance);
    expect((await enabled.catalog()).iconPacks).toMatchObject([{ id: 'acme.pack/icons', asset: { sha256: sha(bytes), size: bytes.length } }]);
    expect((await enabled.asset('acme.pack', sha(bytes))).file).toBe(join(root, 'assets/icons.json'));
    expect(await enabled.problems({ id: 'acme.pack', root, appearance })).toEqual([]);
    expect((await service(root, appearance, false).catalog()).iconPacks).toEqual([]);
    await expect(service(root, appearance, false).asset('acme.pack', sha(bytes))).rejects.toMatchObject({ statusCode: 404 });
    for (const invalid of [
      { ...document, version: 2 },
      { version: 1, icons: { Plus: { width: 24, height: 24, paths: [{ d: '<svg onload=alert(1) />' }] } } },
      { version: 1, icons: { Plus: { width: 24, height: 24, paths: [{ d: 'M1e999 0' }] } } },
      { version: 1, icons: { Plus: { width: 24, height: 24, paths: Array(33).fill({ d: 'M0 0' }) } } },
    ]) {
      await writeFile(join(root, 'assets/icons.json'), JSON.stringify(invalid));
      expect((await service(root, appearance).catalog()).iconPacks).toEqual([]);
      expect(await service(root, appearance).problems({ id: 'acme.pack', root, appearance })).not.toEqual([]);
    }
    expect(checkDeclarations('acme.pack', { appearance: { iconPacks: [{ ...appearance.iconPacks![0], asset: '../icons.json' }] } })).toMatch(/under assets/);
    expect(checkDeclarations('acme.pack', { appearance: { ...appearance, palettes: appearance.iconPacks } })).toMatch(/declared twice/);
  });

  it('resolves each asset to a content-addressed url and serves exactly those bytes', async () => {
    const appearances = service(await pack(), declarations());
    const catalog = await appearances.catalog();
    expect(catalog.fonts[0]!.files[0]).toEqual({ url: `/api/appearance/assets/acme.pack/${sha(WOFF2)}`, sha256: sha(WOFF2), size: WOFF2.length, type: 'font/woff2' });
    expect(catalog.backgrounds[0]).toMatchObject({ opacity: 1, fit: 'cover', asset: { type: 'image/png', sha256: sha(PNG) } });
    expect(catalog.palettes[0]!.asset.type).toBe('application/json');
    expect(catalog.presets[0]).toMatchObject({ plugin: 'acme.pack', palette: 'acme.pack/theme' });
    expect((await appearances.asset('acme.pack', sha(PNG))).type).toBe('image/png');
    await expect(appearances.asset('acme.pack', sha(Buffer.from('other')))).rejects.toMatchObject({ code: 'APPEARANCE_ASSET_NOT_FOUND', statusCode: 404 });
    await expect(appearances.asset('other.pack', sha(PNG))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('leaves out what escapes the package, has the wrong type, is too large or is not a theme', async () => {
    const outside = await directory();
    await writeFile(join(outside, 'secret.png'), PNG);
    const root = await pack({ 'wrong.woff2': 'not a font', 'big.png': Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]), 'bad.json': JSON.stringify({ ...palette(), ansi: [] }) });
    await symlink(join(outside, 'secret.png'), join(root, 'assets', 'link.png'));
    const catalog = (assets: Parameters<typeof declarations>[0]) => service(root, declarations(assets)).catalog();
    expect((await catalog({ background: 'assets/link.png' })).backgrounds).toEqual([]);
    expect((await catalog({ background: 'assets/../../secret.png' })).backgrounds).toEqual([]);
    expect((await catalog({ background: 'assets/big.png' })).backgrounds).toEqual([]);
    expect((await catalog({ background: 'assets/theme.json' })).backgrounds).toEqual([]);
    expect((await catalog({ font: 'assets/wrong.woff2' })).fonts).toEqual([]);
    expect((await catalog({ palette: 'assets/bad.json' })).palettes).toEqual([]);
    expect(await catalog({})).toMatchObject({ palettes: [{}], fonts: [{}], backgrounds: [{}] });
  });

  it.skipIf(process.getuid?.() === 0)('drops only the item whose file cannot be read, and says so once', async () => {
    const root = await pack({ 'locked.png': PNG });
    await chmod(join(root, 'assets', 'locked.png'), 0o000);
    const appearances = service(root, { ...declarations(), backgrounds: [{ id: 'acme.pack/locked', title: { en: 'Locked' }, asset: 'assets/locked.png', areas: ['workbench'] }, ...declarations().backgrounds!] });
    for (let round = 0; round < 2; round++) expect((await appearances.catalog()).backgrounds.map(background => background.id)).toEqual(['acme.pack/grain']);
    expect((await appearances.catalog()).fonts).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('gives a palette that stands alone under the key clients paint it, and nothing for one that is not held', async () => {
    const design = { version: 1, styles: { ios: { variants: { settingsIcons: 'plain' }, colors: { light: { card: '#ABCDEF' } } } } };
    const bytes = Buffer.from(JSON.stringify({ ...palette(), design }));
    const appearances = service(await pack({ 'theme.json': bytes }), declarations());
    const key = `plugin-${sha(bytes).slice(0, 16)}`;
    expect(await appearances.palette(key)).toMatchObject({ id: `custom-plugin-${sha(bytes).slice(0, 16)}`, name: 'Pack', design: { ...design, styles: { ios: { ...design.styles.ios, colors: { light: { card: '#abcdef' } } } } } });
    expect(await appearances.palette('plugin-0000000000000000')).toBeUndefined();
    expect(await appearances.palette('custom-pack-theme')).toBeUndefined();
    expect(await service(await pack({ 'theme.json': bytes }), declarations(), false).palette(key)).toBeUndefined();
  });

  it('serves logos (raster and SVG) and extended background metadata, and drops invalid assets', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>');
    const darkPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)]);
    const bigLogo = Buffer.concat([PNG, Buffer.alloc(512 * 1024)]);
    const root = await pack({
      'logo.svg': svg,
      'logo-dark.png': darkPng,
      'bg-dark.png': darkPng,
      'big-logo.png': bigLogo,
      'bad-logo.svg': 'not an svg',
    });
    const appearance: AppearanceDeclarations = {
      backgrounds: [{
        id: 'acme.pack/wallpaper',
        title: { en: 'Wallpaper' },
        asset: 'assets/grain.png',
        darkAsset: 'assets/bg-dark.png',
        areas: ['workbench'],
        opacity: 0.9,
        fit: 'contain',
        placement: 'underlay',
        position: 'bottom-right',
        surfaceOpacity: 0.82,
      }],
      logos: [
        { id: 'acme.pack/logo', title: { en: 'Logo' }, asset: 'assets/logo.svg', darkAsset: 'assets/logo-dark.png' },
        { id: 'acme.pack/big', title: { en: 'Big' }, asset: 'assets/big-logo.png' },
        { id: 'acme.pack/bad', title: { en: 'Bad' }, asset: 'assets/bad-logo.svg' },
      ],
      presets: [{ id: 'acme.pack/full', title: { en: 'Full' }, background: 'acme.pack/wallpaper', logo: 'acme.pack/logo' }],
    };
    expect(checkDeclarations('acme.pack', { appearance })).toBeUndefined();
    expect(declaredIds({ appearance })).toEqual(['acme.pack/wallpaper', 'acme.pack/logo', 'acme.pack/big', 'acme.pack/bad', 'acme.pack/full']);
    const enabled = service(root, appearance);
    const catalog = await enabled.catalog();
    expect(catalog.backgrounds[0]).toMatchObject({
      id: 'acme.pack/wallpaper',
      fit: 'contain',
      placement: 'underlay',
      position: 'bottom-right',
      surfaceOpacity: 0.82,
      darkAsset: { type: 'image/png', sha256: sha(darkPng) },
    });
    expect(catalog.logos).toMatchObject([{
      id: 'acme.pack/logo',
      asset: { type: 'image/svg+xml', sha256: sha(svg) },
      darkAsset: { type: 'image/png', sha256: sha(darkPng) },
    }]);
    expect(catalog.presets[0]).toMatchObject({ logo: 'acme.pack/logo', background: 'acme.pack/wallpaper' });
    expect((await enabled.asset('acme.pack', sha(svg))).type).toBe('image/svg+xml');
    expect((await enabled.asset('acme.pack', sha(darkPng))).type).toBe('image/png');
    await expect(service(root, appearance, false).asset('acme.pack', sha(svg))).rejects.toMatchObject({ statusCode: 404 });
    expect(await enabled.problems({ id: 'acme.pack', root, appearance })).toHaveLength(2);
    expect(checkDeclarations('acme.pack', { appearance: { logos: [{ id: 'acme.pack/logo', title: { en: 'Logo' }, asset: 'assets/logo.woff2' }] } })).toMatch(/\.svg/);
    expect(checkDeclarations('acme.pack', { appearance: { backgrounds: [{ id: 'acme.pack/bg', title: { en: 'Bg' }, asset: 'assets/grain.png', areas: ['workbench'], placement: 'floating' as never }] } })).toMatch(/overlay or underlay/);
    expect(checkDeclarations('acme.pack', { appearance: { backgrounds: [{ id: 'acme.pack/bg', title: { en: 'Bg' }, asset: 'assets/grain.png', areas: ['workbench'], surfaceOpacity: 1.5 }] } })).toMatch(/surfaceOpacity/);
  });

  it('offers only what an enabled plugin declares', async () => {
    const root = await pack();
    const appearance = declarations();
    expect((await service(root, appearance, false).catalog()).fonts).toEqual([]);
    await expect(service(root, appearance, false).asset('acme.pack', sha(PNG))).rejects.toMatchObject({ statusCode: 404 });

    // Through the registry: a development package is a source while it is on and not once it is off.
    const state = await directory();
    await writeFile(join(root, 'riffet-plugin.json'), JSON.stringify({ id: 'acme.pack', vendor: 'Acme', name: 'Pack', apiVersion: 1, defaultEnabled: true, contributes: { appearance } }));
    const registry = new PluginRegistry({ stateDir: state, plugins: [], developmentPackages: [root] });
    await registry.refresh();
    expect((await new AppearanceService(registry).catalog()).fonts).toHaveLength(1);
    await registry.update('acme.pack', { enablement: 'off' });
    expect((await new AppearanceService(registry).catalog()).fonts).toEqual([]);
    await registry.close();
  });
});

describe('appearance declarations', () => {
  it('accept a valid pack and refuse ids outside the plugin, paths outside assets/ and unknown kinds', () => {
    expect(checkDeclarations('acme.pack', { appearance: declarations() })).toBeUndefined();
    const bad = (change: (value: AppearanceDeclarations) => void) => { const value = declarations(); change(value); return checkDeclarations('acme.pack', { appearance: value }); };
    expect(bad(value => { value.palettes![0]!.id = 'other.pack/theme'; })).toMatch(/must be "acme.pack\/<name>"/);
    expect(bad(value => { value.backgrounds![0]!.asset = '../grain.png'; })).toMatch(/under assets\//);
    expect(bad(value => { value.backgrounds![0]!.asset = 'assets/grain.svg'; })).toMatch(/\.png, \.jpg or \.webp/);
    expect(bad(value => { value.fonts![0]!.files[0]!.path = 'assets/font.ttf'; })).toMatch(/\.woff2/);
    expect(bad(value => { value.fonts![0]!.family = 'Acme"; } body {'; })).toMatch(/family is invalid/);
    expect(bad(value => { (value.backgrounds![0] as { areas: string[] }).areas = ['sidebar']; })).toMatch(/unknown area/);
    expect(bad(value => { value.presets![0]!.palette = 'not-a-reference'; })).toMatch(/invalid id/);
    expect(bad(value => { value.fonts![0]!.license = { redistributable: true }; })).toBeUndefined();
    expect(bad(value => { (value.backgrounds![0] as { license: unknown }).license = { redistributable: 'yes' }; })).toMatch(/license must be/);
    expect(bad(value => { value.presets![0]!.id = 'acme.pack/theme'; })).toMatch(/declared twice/);
  });
});

describe('plugin Agents', () => {
  const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>';
  const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: { en: 'Agent' }, ...extra });

  it('accepts a built-in id only from an official plugin, and any other id only under the plugin id', () => {
    expect(checkDeclarations('riffet.cursor', { agentBackends: [agent('cursor')] })).toBeUndefined();
    expect(checkDeclarations('acme.agent', { agentBackends: [agent('acme.agent'), agent('acme.agent.fast')] })).toBeUndefined();
    expect(checkDeclarations('acme.agent', { agentBackends: [agent('cursor')] })).toMatch(/must be "acme.agent"/);
    expect(checkDeclarations('acme.agent', { agentBackends: [agent('other.agent')] })).toMatch(/must be "acme.agent"/);
    expect(checkDeclarations('acme.agent', { agentBackends: [agent('acme.agent.' + 'x'.repeat(60))] })).toMatch(/at most 64/);
    expect(checkDeclarations('acme.agent', { agentBackends: [agent('Acme.Agent')] })).toMatch(/lowercase/);
  });

  it('serves only the declared SVG of an Agent, whether or not its plugin is on', async () => {
    const root = await directory();
    await writeFile(join(root, 'mark.svg'), SVG);
    await writeFile(join(root, 'other.svg'), SVG);
    await writeFile(join(root, 'fake.svg'), 'not an svg');
    const sources = [{ agentId: 'acme.agent', svg: 'mark.svg', root }, { agentId: 'acme.agent.fake', svg: 'fake.svg', root }, { agentId: 'acme.agent.up', svg: '../mark.svg', root }];
    const icons = new AppearanceService({ appearanceSources: () => [], agentIconSources: () => sources });
    expect(await icons.agentIcon('acme.agent')).toMatchObject({ type: 'image/svg+xml', sha256: sha(Buffer.from(SVG)) });
    const updatedSvg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><path d="M0 0h12v12z"/></svg>';
    await writeFile(join(root, 'mark.svg'), updatedSvg);
    expect(await icons.agentIcon('acme.agent')).toMatchObject({ type: 'image/svg+xml', sha256: sha(Buffer.from(updatedSvg)) });
    for (const id of ['acme.agent.fake', 'acme.agent.up', 'acme.agent.other', 'cursor']) await expect(icons.agentIcon(id)).rejects.toMatchObject({ code: 'AGENT_ICON_NOT_FOUND', statusCode: 404 });
  });
});
