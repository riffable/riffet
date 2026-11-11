import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { avatarSvgProblem } from './avatar-styles.js';
import { OwnerService } from './index.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function state(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'riffet-owner-')); directories.push(path); return path; }

const PNG = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, fill)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const upload = (type: string, bytes: Buffer) => ({ type, data: bytes.toString('base64') });
const files = (dir: string) => readdir(join(dir, 'owner')).catch(() => []);

describe('OwnerService', () => {
  it('starts empty and keeps the name trimmed, cleared, and bounded', async () => {
    const owner = new OwnerService({ stateDir: await state() });
    expect(owner.get()).toEqual({ revision: 0 });
    expect(owner.update({ name: '  Ada  ' })).toMatchObject({ revision: 1, name: 'Ada' });
    expect(owner.update({ name: '😀'.repeat(32) }).name).toHaveLength(64);
    for (const name of ['😀'.repeat(33), 'a\nb', 'a\u0000b', 'a\u2028b', 5 as never]) expect(() => owner.update({ name })).toThrow(expect.objectContaining({ code: 'INVALID_OWNER_NAME' }));
    expect(owner.update({ name: '   ' })).toEqual(expect.objectContaining({ revision: 3 }));
    expect(owner.get().name).toBeUndefined();
    expect(owner.update({ name: 'Ada' }).name).toBe('Ada');
    expect(owner.update({ name: null }).name).toBeUndefined();
  });

  it('accepts only images whose bytes match the declared type, within the size limit', async () => {
    const dir = await state();
    const owner = new OwnerService({ stateDir: dir });
    for (const input of [upload('image/jpeg', PNG(1)), upload('image/png', JPEG), upload('image/svg+xml', Buffer.from('<svg/>')), { type: 'image/png', data: '!!!!' }, { type: 'image/png', data: '' }, upload('image/webp', Buffer.from('RIFFxxxxWEBX'))])
      expect(() => owner.setAvatar(input)).toThrow(expect.objectContaining({ code: 'INVALID_OWNER_AVATAR' }));
    const huge = Buffer.concat([PNG(1), Buffer.alloc(1024 * 1024)]);
    expect(() => owner.setAvatar(upload('image/png', huge))).toThrow(expect.objectContaining({ code: 'OWNER_AVATAR_TOO_LARGE', statusCode: 413 }));
    expect(owner.get().revision).toBe(0);
    expect(await files(dir)).toEqual([]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
    expect(owner.setAvatar(upload('image/webp', webp)).avatar).toMatchObject({ type: 'image/webp', size: webp.length });
  });

  it('keeps replaced and removed avatars in history, and removal is idempotent', async () => {
    const dir = await state();
    const owner = new OwnerService({ stateDir: dir });
    const first = owner.setAvatar(upload('image/png', PNG(1)));
    expect(first.avatar?.url).toBe(`/api/owner/avatar/${first.avatar!.sha256}`);
    expect(first.history).toBeUndefined();
    expect(await files(dir)).toEqual([first.avatar!.sha256]);
    expect((await stat(join(dir, 'owner', first.avatar!.sha256))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'owner.json'))).mode & 0o777).toBe(0o600);
    const second = owner.setAvatar(upload('image/png', PNG(2)));
    expect(second.history?.map(item => item.sha256)).toEqual([first.avatar!.sha256]);
    expect(owner.avatar(first.avatar!.sha256)).toMatchObject({ type: 'image/png' });
    expect(() => owner.avatar('../x')).toThrow(expect.objectContaining({ statusCode: 404 }));
    const same = owner.setAvatar(upload('image/png', PNG(2)));
    expect(same.revision).toBe(second.revision + 1);
    expect(same.history).toEqual(second.history);
    const removed = owner.removeAvatar();
    expect(removed.avatar).toBeUndefined();
    expect(removed.history?.map(item => item.sha256)).toEqual([second.avatar!.sha256, first.avatar!.sha256]);
    expect((await files(dir)).sort()).toEqual([first.avatar!.sha256, second.avatar!.sha256].sort());
    expect(owner.removeAvatar().revision).toBe(removed.revision);
  });

  it('restores from history, swaps with the current avatar, and deletes one entry with its file', async () => {
    const dir = await state();
    const owner = new OwnerService({ stateDir: dir });
    const seen: number[] = [];
    owner.subscribe(info => seen.push(info.revision));
    const a = owner.setAvatar(upload('image/png', PNG(1))).avatar!;
    const b = owner.setAvatar(upload('image/png', PNG(2))).avatar!;
    const restored = owner.restoreAvatar({ sha256: a.sha256 });
    expect(restored.avatar?.sha256).toBe(a.sha256);
    expect(restored.history?.map(item => item.sha256)).toEqual([b.sha256]);
    for (const input of [{ sha256: a.sha256 }, { sha256: 'f'.repeat(64) }, null, {}]) expect(() => owner.restoreAvatar(input)).toThrow(expect.objectContaining({ code: 'OWNER_AVATAR_NOT_FOUND', statusCode: 404 }));
    expect(seen).toEqual([1, 2, 3]);
    expect(owner.removeHistory('f'.repeat(64)).revision).toBe(3);
    const dropped = owner.removeHistory(b.sha256);
    expect(dropped).toMatchObject({ revision: 4, avatar: { sha256: a.sha256 } });
    expect(dropped.history).toBeUndefined();
    expect(await files(dir)).toEqual([a.sha256]);
    expect(() => owner.avatar(b.sha256)).toThrow(expect.objectContaining({ code: 'OWNER_AVATAR_NOT_FOUND' }));
    expect(owner.removeHistory(b.sha256).revision).toBe(4);
  });

  it('keeps at most 12 earlier avatars, deleting the oldest file, and persists them', async () => {
    const dir = await state();
    const owner = new OwnerService({ stateDir: dir });
    const shas = Array.from({ length: 14 }, (_, index) => owner.setAvatar(upload('image/png', PNG(index + 1))).avatar!.sha256);
    const info = owner.get();
    expect(info.avatar?.sha256).toBe(shas[13]);
    expect(info.history?.map(item => item.sha256)).toEqual(shas.slice(1, 13).reverse());
    expect((await files(dir)).sort()).toEqual(shas.slice(1).sort());
    // Restoring the oldest kept entry moves the current one to the head; nothing is trimmed, so every file stays.
    owner.restoreAvatar({ sha256: shas[1] });
    expect((await files(dir)).length).toBe(13);
    const again = new OwnerService({ stateDir: dir }).get();
    expect(again.avatar?.sha256).toBe(shas[1]);
    expect(again.history?.[0]?.sha256).toBe(shas[13]);
    expect(again.history).toHaveLength(12);
  });

  it('survives a restart and tells subscribers about each change', async () => {
    const dir = await state();
    const owner = new OwnerService({ stateDir: dir });
    const seen: number[] = [];
    const stop = owner.subscribe(info => seen.push(info.revision));
    owner.update({ name: 'Ada' });
    const saved = owner.setAvatar(upload('image/jpeg', JPEG));
    stop();
    owner.update({ name: 'Grace' });
    expect(seen).toEqual([1, 2]);
    const again = new OwnerService({ stateDir: dir });
    expect(again.get()).toMatchObject({ revision: 3, name: 'Grace', avatar: saved.avatar });
    expect(again.avatar(saved.avatar!.sha256)).toMatchObject({ type: 'image/jpeg', size: JPEG.length });
  });

  describe('generated avatars', () => {
    // A deterministic stand-in for a plugin's styles: the picture is a function of the request.
    const draw = ({ seed, size, ink, paper, name }: { seed: string; size: number; ink: string; paper: string; name?: string }) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"><rect width="100" height="100" fill="${paper}"/><circle cx="50" cy="50" r="${10 + [...seed].length * 7}" fill="${ink}"/>${name ? `<text x="10" y="60" font-size="30">${name}</text>` : ''}</svg>`;
    const styles = [
      { owner: 'x.y', declaration: { id: 'x.y/dots', title: { en: 'Dots' } }, provider: { generate: draw } },
      { owner: 'x.y', declaration: { id: 'x.y/name', title: { en: 'Name' }, needsName: true }, provider: { generate: draw } },
    ];
    const source = { avatarStyles: () => styles };
    const make = async () => { const dir = await state(); return { dir, owner: new OwnerService({ stateDir: dir, avatarStyles: () => source }) }; };

    it('refuses unsafe SVG before it is drawn', () => {
      const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${inner}</svg>`;
      expect(avatarSvgProblem(wrap('<defs><circle id="a" r="1"/></defs><use href="#a" fill="url(#a)"/>'))).toBeUndefined();
      for (const bad of [
        wrap('<script>alert(1)</script>'), wrap('<foreignObject/>'), wrap('<image href="#a"/>'), wrap('<use xlink:href="file:///etc/passwd"/>'), wrap('<use href="http://x/y.svg#a"/>'),
        wrap('<rect style="fill:url(http://x/a.png)"/>'), wrap('<rect fill="url(&#117;rl)"/>'), wrap('<style>@import "http://x"</style>'), `<!DOCTYPE svg [<!ENTITY a "b">]>${wrap('')}`,
        wrap('x'.repeat(512 * 1024)), 'not svg', 5,
      ]) expect(avatarSvgProblem(bad), String(bad).slice(0, 40)).toBeTruthy();
    });

    it('stores a generated PNG like an upload, remembers its style and seed, and an upload forgets them', async () => {
      const { dir, owner } = await make();
      expect(owner.avatarStyles().map(style => style.id)).toEqual(['x.y/dots', 'x.y/name']);
      const generated = await owner.generateAvatar({ style: 'x.y/dots', seed: 'abc' });
      expect(generated.avatar).toMatchObject({ type: 'image/png', generated: { style: 'x.y/dots', seed: 'abc' } });
      const bytes = await readFile(join(dir, 'owner', generated.avatar!.sha256));
      expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(await files(dir)).toEqual([generated.avatar!.sha256]);
      expect(new OwnerService({ stateDir: dir }).get().avatar?.generated).toEqual({ style: 'x.y/dots', seed: 'abc' });
      const uploaded = owner.setAvatar(upload('image/png', PNG(1)));
      expect(uploaded.avatar?.generated).toBeUndefined();
      expect(new OwnerService({ stateDir: dir }).get().avatar?.generated).toBeUndefined();
      expect((await files(dir)).sort()).toEqual([generated.avatar!.sha256, uploaded.avatar!.sha256].sort());
      expect(uploaded.history?.[0]).toMatchObject({ sha256: generated.avatar!.sha256, generated: { style: 'x.y/dots', seed: 'abc' } });
      expect(owner.restoreAvatar({ sha256: generated.avatar!.sha256 }).avatar?.generated).toEqual({ style: 'x.y/dots', seed: 'abc' });
    });

    it('draws the same bytes for the same request, and asks a style that draws the name for one', async () => {
      const { owner } = await make();
      const a = await owner.previewAvatar('x.y/dots', { seed: 's1' });
      expect((await owner.previewAvatar('x.y/dots', { seed: 's1' })).equals(a)).toBe(true);
      expect((await owner.previewAvatar('x.y/dots', { seed: 'longer' })).equals(a)).toBe(false);
      await expect(owner.previewAvatar('x.y/name', { seed: 's1' })).rejects.toMatchObject({ code: 'OWNER_AVATAR_NEEDS_NAME', statusCode: 409 });
      owner.update({ name: '何' });
      const named = await owner.previewAvatar('x.y/name', { seed: 's1', ink: '#112233', paper: '#fafafa' });
      expect(named.equals(await owner.previewAvatar('x.y/name', { seed: 's1', ink: '#112233', paper: '#fafafa' }))).toBe(true);
      expect((await owner.generateAvatar({ style: 'x.y/name', seed: 's1' })).avatar?.generated).toEqual({ style: 'x.y/name', seed: 's1' });
    });

    it('rejects a bad request, an unknown style and a style that fails', async () => {
      const { owner } = await make();
      for (const request of [null, { style: 'x.y/dots' }, { style: 'x.y/dots', seed: '' }, { style: 'x.y/dots', seed: 'x'.repeat(65) }, { style: 'x.y/dots', seed: 'a\nb' }, { style: 'x.y/dots', seed: 'a', ink: 'red' }, { style: 'x.y/dots', seed: 'a', paper: '#fff' }])
        await expect(owner.generateAvatar(request)).rejects.toMatchObject({ code: 'INVALID_OWNER_AVATAR', statusCode: 400 });
      await expect(owner.generateAvatar({ style: 'x.y/none', seed: 'a' })).rejects.toMatchObject({ code: 'OWNER_AVATAR_STYLE_NOT_FOUND', statusCode: 404 });
      const failing = new OwnerService({ stateDir: await state(), avatarStyles: () => ({ avatarStyles: () => [{ owner: 'x.y', declaration: { id: 'x.y/bad', title: { en: 'Bad' } }, provider: { generate: () => '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>' } }] }) });
      await expect(failing.generateAvatar({ style: 'x.y/bad', seed: 'a' })).rejects.toMatchObject({ code: 'OWNER_AVATAR_STYLE_FAILED', statusCode: 502 });
      expect(failing.get().avatar).toBeUndefined();
    });
  });
});
