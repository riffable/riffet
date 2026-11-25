import { mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { ShareSnapshot } from '../../../../packages/contracts/src/share.js';
import { Store } from '../store.js';
import { WorkspaceService } from '../workspace/index.js';
import { buildSharePackage } from './package.js';

// A valid signature and IHDR, sufficient for the existing byte-checked image reader.
const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
describe('share package resource freezing', () => {
  let directory: string, projectDirectory: string, webAssetsDir: string, outputDir: string;
  let store: Store, workspace: WorkspaceService, sessionId: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'riffet-share-package-'));
    projectDirectory = path.join(directory, 'project');
    webAssetsDir = path.join(directory, 'web');
    outputDir = path.join(directory, 'draft');
    await mkdir(projectDirectory); await mkdir(webAssetsDir); await mkdir(path.join(directory, 'state'));
    await writeFile(path.join(webAssetsDir, 'index.html'), '<html><head><meta name="riffet-share-data" content="placeholder"></head><body></body></html>');
    await writeFile(path.join(webAssetsDir, 'share.js'), 'export {};');
    await writeFile(path.join(webAssetsDir, 'share.js.map'), 'private sources');
    await writeFile(path.join(webAssetsDir, 'sw.js'), 'workbench cache');
    store = new Store(path.join(directory, 'riffet.db'));
    const project = store.createProject(projectDirectory, 'project');
    sessionId = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex' }).id;
    workspace = new WorkspaceService({ stateDir: path.join(directory, 'state') });
  });
  afterEach(async () => { store.db.close(); await rm(directory, { recursive: true, force: true }); });

  const snapshot = (text: string): ShareSnapshot => ({
    format: 'riffet-share-v1', title: 'Share', capturedAt: '2026-10-23T00:00:00Z', backendId: 'codex',
    events: [{ sequence: 1, sessionId, nativeId: 'message', type: 'session/update', data: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, createdAt: '2026-10-23T00:00:00Z' }],
    runs: [], subagents: [], jobs: [], warnings: [], resources: {}, blobs: {}, diagramPages: {},
  });
  const build = (data: ShareSnapshot, allowOutsideRead = false) => buildSharePackage({ snapshot: data, sessionId, store, workspace, outputDir, webAssetsDir, allowOutsideRead });
  const exported = async (hash: string) => JSON.parse(await readFile(path.join(outputDir, 'data', `session-${hash}.json`), 'utf8')) as ShareSnapshot;

  it('includes frozen appearance in both the portable data and first-paint metadata', async () => {
    const original = snapshot('answer');
    original.appearance = { themeId: 'solarized', mode: 'dark' };
    const built = await build(original);
    expect((await exported(built.hash)).appearance).toEqual(original.appearance);
    const html = await readFile(path.join(outputDir, 'index.html'), 'utf8');
    expect(html).toContain('name="riffet-share-appearance"');
    expect(html).toContain('solarized');
    expect(html).not.toContain('name="riffet-share-preview"');
    await rm(outputDir, { recursive: true });
    const changed = await build({ ...original, appearance: { themeId: 'solarized', mode: 'light' } });
    expect(changed.hash).not.toBe(built.hash);
  });

  it('freezes only explicit images and attachments, rewrites opaque references, and leaves the original snapshot untouched', async () => {
    const imagePath = path.join(projectDirectory, 'screen.png');
    await writeFile(imagePath, png);
    await writeFile(path.join(projectDirectory, 'private.txt'), 'do not publish');
    const project = store.getProject(store.getSession(sessionId).projectId);
    const attachment = await workspace.upload(project, { name: 'notes.html', mimeType: 'text/html', dataBase64: Buffer.from('<p>notes</p>').toString('base64') });
    const screenshot = await workspace.upload(project, { name: 'upload.png', mimeType: 'image/png', dataBase64: png.toString('base64') });
    const original = snapshot(`![screen](<${imagePath}>)\n[private](private.txt)\n\`![code](missing.png)\`\n\n![reference][screen]\n\n[screen]: <${imagePath}>`);
    original.events[0]!.data.attachments = [
      { id: attachment.id, name: attachment.name },
      { id: screenshot.id, name: screenshot.name, type: 'image', path: 'expired-cli-copy.png' },
    ];
    original.events.push({ ...original.events[0]!, nativeId: 'tool-image', data: { content: [{ type: 'image', path: imagePath }] } });
    original.events.push({ ...original.events[0]!, nativeId: 'native-user-image', data: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Screenshot' }, attachments: [{ type: 'image', path: imagePath }, { type: 'image', path: 'missing.png' }] } });
    const { hash, warnings } = await build(original);
    const frozen = await exported(hash);
    expect(warnings).toEqual(['HTML 预览中的脚本不会执行', '部分图片不可用']);
    expect(JSON.stringify(frozen.resources)).not.toContain(imagePath);
    expect(frozen.events[0]!.data.content).toMatchObject({ text: expect.stringContaining('![screen](./attachments/') });
    expect(frozen.events[0]!.data.content).toMatchObject({ text: expect.stringContaining('[private](private.txt)') });
    expect(JSON.stringify(original.events)).toContain(imagePath);
    expect(JSON.stringify(frozen.events)).not.toContain(imagePath);
    expect(frozen.events[0]!.data.attachments).toContainEqual({ id: screenshot.id, name: screenshot.name, type: 'image' });
    expect(frozen.resources[screenshot.id]).toMatchObject({ name: screenshot.name, mimeType: 'image/png' });
    expect((frozen.events[1]!.data.content as Array<{ path: string }>)[0]!.path).toMatch(/^\.\/attachments\//);
    const nativeAttachments = frozen.events[2]!.data.attachments as Array<{ id: string; name: string; mimeType?: string; size?: number }>;
    expect(nativeAttachments[0]).toMatchObject({ id: expect.stringMatching(/^\.\/attachments\//), name: 'screen.png', mimeType: 'image/png', size: png.length });
    expect(frozen.resources[nativeAttachments[0]!.id]).toMatchObject({ name: 'screen.png', mimeType: 'image/png' });
    expect(nativeAttachments[1]).toMatchObject({ id: expect.stringMatching(/^\.\/attachments\//), name: 'missing.png' });
    expect(frozen.resources[nativeAttachments[1]!.id]).toBeUndefined();
    expect(await readdir(path.join(outputDir, 'attachments'))).toHaveLength(2);
    const resource = frozen.resources[attachment.id]!;
    expect(resource.url).toMatch(/\.bin$/);
    expect(resource.previewUrl).toMatch(/\.html$/);
    expect(await readFile(path.join(outputDir, resource.url), 'utf8')).toBe('<p>notes</p>');
    const preview = await readFile(path.join(outputDir, resource.previewUrl!), 'utf8');
    expect(preview).toContain('script-src &#39;sha256-');
    expect(preview).not.toContain("script-src &#39;unsafe-inline&#39;");
    await writeFile(imagePath, 'changed after export');
    const image = Object.values(frozen.resources).find(item => item.mimeType === 'image/png')!;
    expect(await readFile(path.join(outputDir, image.url))).toEqual(png);
    expect(await readdir(outputDir)).not.toContain('sw.js');
    expect(await readdir(outputDir)).not.toContain('share.js.map');
    expect(await readFile(path.join(outputDir, 'index.html'), 'utf8')).toContain(`./data/session-${hash}.json`);
  });

  it('keeps explicitly referenced attachment images inside exported Markdown previews', async () => {
    const project = store.getProject(store.getSession(sessionId).projectId);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>attached</text></svg>');
    const image = await workspace.upload(project, { name: 'picture.svg', mimeType: 'image/svg+xml', dataBase64: svg.toString('base64') });
    const document = await workspace.upload(project, { name: 'note.md', mimeType: 'text/markdown', dataBase64: Buffer.from(`![picture](attachment:${image.id})`).toString('base64') });
    const data = snapshot('answer');
    data.events[0]!.data.attachments = [{ id: document.id, name: document.name }];
    const { hash } = await build(data);
    const frozen = await exported(hash);
    const preview = await readFile(path.join(outputDir, frozen.resources[document.id]!.previewUrl!), 'utf8');
    expect(preview).toContain(`data:image/svg+xml;base64,${svg.toString('base64')}`);
    expect(preview).not.toContain(`attachment:${image.id}`);
  });

  it('blocks symlink escapes, non-image files disguised as images, and unrelated session blobs', async () => {
    await writeFile(path.join(directory, 'outside.png'), png);
    await symlink(path.join(directory, 'outside.png'), path.join(projectDirectory, 'escape.png'));
    await writeFile(path.join(projectDirectory, 'fake.png'), 'credential material');
    const secretBlob = store.journal.putSessionBlob('another-session', Buffer.from('private activity'));
    const ownedBlob = store.journal.putSessionBlob(sessionId, Buffer.from('visible activity'));
    const data = snapshot('![outside](escape.png)\n![fake](fake.png)\n![remote](https://example.invalid/p.png)\n[page](https://example.invalid/)');
    data.events.push({ ...data.events[0]!, nativeId: 'activity', data: { activity: { blobRef: secretBlob } } }, { ...data.events[0]!, nativeId: 'owned', data: { activity: { blobRef: ownedBlob } } });
    data.events.push({ ...data.events[0]!, nativeId: 'omitted-image', data: { content: [{ type: 'image', omitted: true }, { type: 'image', src: 'https://example.invalid/tool.png' }] } });
    const { hash, warnings } = await build(data, true);
    const frozen = await exported(hash);
    expect(warnings).toContain('部分图片不可用');
    expect(warnings).toContain('部分活动全文不可用');
    expect(warnings).toContain('外部图片未打包');
    expect(frozen.resources).toEqual({});
    expect(frozen.blobs).toEqual({ [ownedBlob]: 'visible activity' });
    expect(JSON.stringify(frozen)).not.toContain('private activity');
    expect(JSON.stringify(frozen)).not.toContain('https://example.invalid/p.png');
    expect(JSON.stringify(frozen)).not.toContain('https://example.invalid/tool.png');
    expect(JSON.stringify(frozen)).toContain('[page](https://example.invalid/)');
  });

  it('collects Markdown resources only where the shared timeline renders Markdown', async () => {
    await writeFile(path.join(projectDirectory, 'screen.png'), png);
    const plain = '![missing](missing.png)\n![remote](https://example.invalid/example.png)\n```html\n<p>source example</p>\n```';
    const blobRef = store.journal.putSessionBlob(sessionId, Buffer.from(plain));
    const data = snapshot('Answer');
    data.events.push(
      { ...data.events[0]!, nativeId: 'user', type: 'user_message_chunk', data: { content: { type: 'text', text: plain } } },
      { ...data.events[0]!, nativeId: 'stdout', type: 'tool_call_update', data: { content: [{ type: 'content', content: { type: 'text', text: plain } }], rawInput: { text: plain }, rawOutput: { text: plain } } },
      { ...data.events[0]!, nativeId: 'markdown', type: 'tool_call_update', data: { content: [{ type: 'markdown', text: '![screen](screen.png)\n```mermaid\ngraph LR; A-->B\n```' }, { type: 'content', content: { type: 'image', path: 'screen.png' } }] } },
      { ...data.events[0]!, nativeId: 'activity', type: 'activity', data: { activity: { blobRef, detail: plain, output: plain } } },
      { ...data.events[0]!, nativeId: 'shell-notice', type: 'task_notification', data: { kind: 'shell', detail: plain } },
      { ...data.events[0]!, nativeId: 'subagent-notice', type: 'task_notification', data: { kind: 'subagent', detail: '![screen](screen.png)' } },
    );
    const { hash, warnings } = await build(data);
    const frozen = await exported(hash);
    expect(warnings).toEqual([]);
    expect(frozen.events[1]!.data.content).toEqual({ type: 'text', text: plain });
    expect(frozen.events[2]!.data).toEqual(data.events[2]!.data);
    expect(frozen.blobs[blobRef]).toBe(plain);
    expect(frozen.events[4]!.data).toEqual(data.events[4]!.data);
    expect(frozen.events[5]!.data.detail).toBe(plain);
    expect(frozen.events[6]!.data.detail).toContain('![screen](./attachments/');
    const content = frozen.events[3]!.data.content as Array<Record<string, unknown>>;
    expect(content[0]!.text).toContain('![screen](./attachments/');
    expect((content[1]!.content as { path: string }).path).toMatch(/^\.\/attachments\//);
    expect(frozen.diagramPages.mermaid).toBe('./previews/mermaid.html');
    expect(frozen.contentPage).toBeUndefined();
  });

  it('freezes native inline images as bounded, byte-checked resources with short names', async () => {
    const source = `data:image/png;base64,${png.toString('base64')}`;
    const data = snapshot(`![Screenshot](${source})`);
    data.events[0]!.data.attachments = [{ type: 'image', id: source, path: source }];
    data.events.push({ ...data.events[0]!, nativeId: 'tool-inline-image', data: { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] } });
    const { hash, warnings } = await build(data);
    const frozen = await exported(hash);
    const attachments = frozen.events[0]!.data.attachments as Array<{ id: string; name: string }>;
    expect(warnings).toEqual([]);
    expect(attachments).toEqual([{ type: 'image', id: expect.stringMatching(/^\.\/attachments\/.+\.png$/), name: '图片.png', mimeType: 'image/png', size: png.length }]);
    expect(await readFile(path.join(outputDir, frozen.resources[attachments[0]!.id]!.url))).toEqual(png);
    expect(JSON.stringify(frozen.events)).not.toContain('base64');
    expect((frozen.events[1]!.data.content as Array<{ path: string }>)[0]!.path).toBe(attachments[0]!.id);
    expect(await readdir(path.join(outputDir, 'attachments'))).toHaveLength(1);
  });

  it('freezes explicit visualization output within the file boundary and keeps source examples inert', async () => {
    const html = '<h1>Result</h1><script>window.privateCode = true</script>';
    await writeFile(path.join(projectDirectory, 'chart.html'), html);
    await writeFile(path.join(directory, 'outside.html'), 'private outside output');
    await symlink(path.join(directory, 'outside.html'), path.join(projectDirectory, 'escape.html'));
    const reference = (file: string) => `\uE200visualize\uE202${JSON.stringify({ path: file })}\uE201`;
    const { hash, warnings } = await build(snapshot(`${reference('chart.html')}\n\n${reference('escape.html')}\n\n\`\`\`text\n${reference('example.html')}\n\`\`\`\n\n\`\`\`htm\n<h2>Preview</h2>\n\`\`\``));
    const frozen = await exported(hash);
    expect(warnings).toEqual(['HTML 预览中的脚本不会执行', '部分可视化预览不可用']);
    const resource = frozen.resources['chart.html']!;
    expect(await readFile(path.join(outputDir, resource.url), 'utf8')).toBe(html);
    const preview = await readFile(path.join(outputDir, resource.previewUrl!), 'utf8');
    expect(preview).toContain('script-src &#39;sha256-');
    expect(preview).not.toContain("script-src &#39;unsafe-inline&#39;");
    expect(frozen.resources['escape.html']).toBeUndefined();
    expect(frozen.resources['example.html']).toBeUndefined();
    expect(frozen.contentPage).toBe('./previews/content.html');
    expect(JSON.stringify(frozen)).not.toContain('private outside output');
  });

  it('compresses only exported image copies, keeps tall screenshots and transparency, and reuses identical images', async () => {
    const original = await sharp({ create: { width: 2304, height: 4608, channels: 4, background: { r: 80, g: 120, b: 180, alpha: 0.5 } } }).png({ compressionLevel: 1 }).toBuffer();
    const imagePath = path.join(projectDirectory, 'tall.png');
    await writeFile(imagePath, original);
    const project = store.getProject(store.getSession(sessionId).projectId);
    const attachment = await workspace.upload(project, { name: 'tall.png', mimeType: 'image/png', dataBase64: original.toString('base64') });
    const jpeg = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#bbaadd' } }).jpeg({ quality: 100 }).toBuffer();
    await writeFile(path.join(projectDirectory, 'photo.jpg'), jpeg);
    const data = snapshot('![tall](tall.png)\n![photo](photo.jpg)');
    data.events[0]!.data.attachments = [{ id: attachment.id, name: 'tall.png' }];
    const { hash, warnings } = await build(data);
    const frozen = await exported(hash);
    const resource = frozen.resources[attachment.id]!;
    const copy = await readFile(path.join(outputDir, resource.url));
    const metadata = await sharp(copy).metadata();
    expect(warnings).toEqual([]);
    expect(resource).toMatchObject({ name: 'tall.png', mimeType: 'image/png', width: 2048, height: 4096, size: copy.length });
    expect(copy.length).toBeLessThan(original.length);
    expect(metadata).toMatchObject({ width: 2048, height: 4096, hasAlpha: true });
    expect(await readFile(imagePath)).toEqual(original);
    expect((await workspace.readAttachment(attachment.id)).data).toEqual(original);
    const photo = Object.values(frozen.resources).find(item => item.name === 'photo.jpg')!;
    const photoCopy = await readFile(path.join(outputDir, photo.url));
    expect(photo).toMatchObject({ mimeType: 'image/jpeg', width: 320, height: 180, size: photoCopy.length });
    expect(photoCopy.length).toBeLessThanOrEqual(jpeg.length);
    expect(await readFile(path.join(projectDirectory, 'photo.jpg'))).toEqual(jpeg);
    expect(await readdir(path.join(outputDir, 'attachments'))).toHaveLength(2);
  });

  it('preserves animated image bytes rather than exporting only the first frame', async () => {
    const frame = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff0000' } }).png().toBuffer();
    const second = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#0000ff' } }).png().toBuffer();
    const gif = await sharp([frame, second], { join: { animated: true } }).gif({ delay: [20, 20] }).toBuffer();
    expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2);
    await writeFile(path.join(projectDirectory, 'animation.gif'), gif);
    // The APNG animation control chunk must be detected even when the decoder ignores it.
    const control = Buffer.from('000000086163544c000000020000000000000000', 'hex');
    control.writeUInt32BE(crc32(control.subarray(4, -4)), control.length - 4);
    const animated = Buffer.concat([frame.subarray(0, 33), control, frame.subarray(33)]);
    await writeFile(path.join(projectDirectory, 'animation.png'), animated);
    const { hash, warnings } = await build(snapshot('![gif](animation.gif)\n![apng](animation.png)'));
    const frozen = await exported(hash);
    expect(warnings).toEqual([]);
    for (const [name, original] of [['animation.gif', gif], ['animation.png', animated]] as const) {
      const resource = Object.values(frozen.resources).find(item => item.name === name)!;
      expect(await readFile(path.join(outputDir, resource.url))).toEqual(original);
    }
  });

  it('rejects malformed, oversized or MIME-mismatched inline image data without leaking it into names', async () => {
    const data = snapshot('Screenshot');
    data.events[0]!.data.attachments = [
      { type: 'image', path: `data:image/jpeg;base64,${png.toString('base64')}` },
      { type: 'image', path: 'data:image/png;base64,not valid base64', name: 'incorrect-base64-name-fragment' },
      { type: 'image', path: `data:image/png;base64,${'A'.repeat(32 * 1024 * 1024 + 12)}` },
    ];
    const { hash, warnings } = await build(data);
    const frozen = await exported(hash);
    expect(warnings).toEqual(['部分图片不可用']);
    expect(frozen.resources).toEqual({});
    expect((frozen.events[0]!.data.attachments as Array<{ name: string }>).every(item => item.name === '图片')).toBe(true);
    expect(JSON.stringify(frozen.events)).not.toContain('base64');
  });

  it('reads native Riffet attachment paths through the attachment boundary without exposing other state files', async () => {
    const project = store.getProject(store.getSession(sessionId).projectId);
    const attachment = await workspace.upload(project, { name: 'screenshot.png', mimeType: 'image/png', dataBase64: png.toString('base64') });
    const forbidden = path.join(directory, 'state', `${attachment.id}.bin`);
    await writeFile(forbidden, png);
    const data = snapshot('Screenshot');
    data.events[0]!.data.attachments = [{ type: 'image', id: attachment.path, path: attachment.path }, { type: 'image', path: forbidden }];
    const { hash, warnings } = await build(data, true);
    const frozen = await exported(hash);
    const attachments = frozen.events[0]!.data.attachments as Array<{ id: string; name: string }>;
    expect(warnings).toEqual(['部分图片不可用']);
    expect(attachments[0]!.name).toBe('screenshot.png');
    expect(frozen.resources[attachments[0]!.id]).toMatchObject({ name: 'screenshot.png', mimeType: 'image/png', size: png.length });
    expect(frozen.resources[attachments[1]!.id]).toBeUndefined();
    expect(JSON.stringify(frozen.events)).not.toContain(attachment.path);
    expect(await readdir(path.join(outputDir, 'attachments'))).toHaveLength(1);
  });

  it('rejects a symlink in the prebuilt assets and refuses to reuse a populated draft directory', async () => {
    await symlink(path.join(directory, 'riffet.db'), path.join(webAssetsDir, 'leak'));
    await expect(build(snapshot('hello'))).rejects.toMatchObject({ code: 'SHARE_ASSETS_UNSAFE' });
    await writeFile(path.join(outputDir, 'existing'), 'existing');
    await expect(build(snapshot('hello'))).rejects.toMatchObject({ code: 'SHARE_DIRECTORY_UNSAFE' });
  });

  it('keeps SVG images in an opaque data URL and enforces the upload budget before reading oversized assets', async () => {
    await writeFile(path.join(projectDirectory, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const { hash } = await build(snapshot('![vector](vector.svg)'));
    const frozen = await exported(hash);
    expect(Object.values(frozen.resources)[0]!.url).toMatch(/^data:image\/svg\+xml;base64,/);
    expect((await readdir(outputDir)).includes('attachments')).toBe(false);
    outputDir = path.join(directory, 'large-draft');
    const oversized = path.join(webAssetsDir, 'oversized.js');
    await writeFile(oversized, '');
    await truncate(oversized, 50 * 1024 * 1024 + 1);
    await expect(build(snapshot('small transcript'))).rejects.toMatchObject({ code: 'SHARE_TOO_LARGE' });
  });
});
