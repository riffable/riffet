import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rewriteVisualizationReferences, visualizationReferenceFromHref, type VisualizationReference } from '../../../../packages/timeline/src/index.js';
import type { ShareDraftProgress, ShareResource, ShareSnapshot } from '../../../../packages/contracts/src/share.js';
import type { Store } from '../store.js';
import type { WorkspaceService } from '../workspace/index.js';
import { AppError } from '../errors.js';
import { renderDiagramPage } from '../diagram-assets.js';
import { contentPreviewPage } from '../previews/content.js';
import { escapeHtml } from '../previews/document.js';
import { renderFilePreview } from '../previews/index.js';
import { previewKind } from '../previews/formats.js';
import { isWithin } from '../workspace/scope.js';
import { previewImageData, previewImageMimeType, readFileBounded } from '../workspace/index.js';
import { MAX_VISUALIZATION_BYTES } from '../visualization.js';
import { optimizeShareImage } from './images.js';

/** A conservative uncompressed limit also bounds the platform's compressed upload limit. */
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const SHARE_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' data: blob:; media-src 'self' data: blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const diagramAliases: Record<string, string[]> = {
  mermaid: ['mermaid', 'mmd'], dot: ['dot', 'graphviz', 'gv'], plantuml: ['plantuml', 'puml', 'uml', 'wsd'],
  d2: ['d2'], vega: ['vega', 'vega-lite', 'vegalite', 'vl'],
};
const imageExtensions: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/bmp': '.bmp',
};

interface MarkdownNode {
  type: string; url?: string; lang?: string; value?: string; alt?: string; identifier?: string;
  children?: MarkdownNode[]; position?: { start: { offset?: number }; end: { offset?: number } };
}
interface MarkdownImage { start: number; end: number; source: string; alt: string; definition?: string }

function isMarkdownFence(lang: string): boolean {
  const token = lang.trim().toLowerCase().split(/[\s:,]/, 1)[0] ?? '';
  if (/^(?:md|markdown|mdown|mkd|mdx|mdc)$/.test(token)) return true;
  return /^\d+:\d+:.+\.(?:md|markdown|mdown|mkd|mdx|mdc)$/i.test(lang.trim());
}

/** Use the same Markdown parser as the UI, including reference images and fenced code. */
function markdownReferences(text: string, depth = 0): { images: MarkdownImage[]; languages: string[]; visualizations: VisualizationReference[] } {
  const images: MarkdownImage[] = [], languages: string[] = [];
  const visualizations: VisualizationReference[] = [];
  const collect = () => (tree: MarkdownNode) => {
    const nodes: MarkdownNode[] = [];
    const visit = (node: MarkdownNode) => { nodes.push(node); node.children?.forEach(visit); };
    visit(tree);
    const definitions = new Map(nodes.filter(node => node.type === 'definition').map(node => [node.identifier, node.url]));
    const imageDefinitions = new Set(nodes.filter(node => node.type === 'imageReference').map(node => node.identifier));
    for (const node of nodes) {
      const visualization = node.type === 'link' ? visualizationReferenceFromHref(node.url) : undefined;
      if (visualization) visualizations.push(visualization);
      if (node.type === 'code' && node.lang) {
        const lang = node.lang.toLowerCase();
        languages.push(lang);
        if (depth < 2 && node.value && isMarkdownFence(node.lang)) {
          const nested = markdownReferences(node.value, depth + 1);
          languages.push(...nested.languages);
          visualizations.push(...nested.visualizations);
        }
      }
      const source = node.type === 'image' ? node.url : node.type === 'imageReference' ? definitions.get(node.identifier) : undefined;
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (source && start !== undefined && end !== undefined) images.push({ start, end, source, alt: node.alt ?? '' });
      if (node.type === 'definition' && imageDefinitions.has(node.identifier) && node.url && start !== undefined && end !== undefined) images.push({ start, end, source: node.url, alt: '', definition: node.identifier });
    }
  };
  renderToStaticMarkup(createElement(ReactMarkdown, { children: text, remarkPlugins: [remarkGfm, collect], components: { img: () => null } }));
  return { images, languages, visualizations };
}

function localImagePath(source: string): string | undefined {
  if (!source || source.startsWith('//') || /^[#?]/.test(source)) return undefined;
  if (/^file:\/\//i.test(source)) {
    try { const url = new URL(source); return !url.hostname || url.hostname === 'localhost' ? decodeURIComponent(url.pathname) : undefined; }
    catch { return undefined; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('/api/')) return undefined;
  try { return decodeURIComponent(source); } catch { return source; }
}

function isolatedPage(page: { html: string; csp: string }): string {
  // A static host cannot provide a sandbox response header. Hash only the trusted generator's
  // own scripts, so contentPreviewPage's dynamic user scripts and inline handlers cannot run
  // even when somebody navigates to this file outside the sandboxed reading iframe.
  const scripts = [...page.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map(match => `'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`);
  const csp = page.csp.replace(/script-src\s+[^;]+/i, `script-src ${scripts.join(' ') || "'none'"} 'wasm-unsafe-eval' blob:`);
  return page.html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><meta name="referrer" content="no-referrer">`);
}

export interface SharePackageOptions {
  snapshot: ShareSnapshot;
  sessionId: string;
  store: Pick<Store, 'getSession' | 'getProject' | 'journal'>;
  workspace: Pick<WorkspaceService, 'readAttachment' | 'readPreviewImage' | 'rawFile'>;
  outputDir: string;
  webAssetsDir: string;
  /** Plugin font and background files the snapshot's appearance refers to, and the sharer's avatar, by package-relative name. */
  appearanceFiles?: Array<{ name: string; data: Buffer }>;
  allowOutsideRead?: boolean;
  generatedImageHomes?: readonly string[];
  onProgress?: (progress: ShareDraftProgress) => void;
  signal?: AbortSignal;
}

/** Assemble a frozen, portable reading copy. No provider or network operation belongs here. */
export async function buildSharePackage(options: SharePackageOptions): Promise<{ hash: string; bytes: number; warnings: string[] }> {
  const { store, sessionId, workspace, outputDir, webAssetsDir } = options;
  const snapshot = structuredClone(options.snapshot);
  const session = store.getSession(sessionId);
  const project = store.getProject(session.projectId);
  const warnings = new Set(snapshot.warnings);
  snapshot.resources = Object.create(null) as Record<string, ShareResource>;
  snapshot.blobs = Object.create(null) as Record<string, string>;
  snapshot.diagramPages = Object.create(null) as Record<string, string>;
  delete snapshot.contentPage;
  let bytes = 0;
  const files = new Map<string, string>();
  const requireCapacity = (size: number) => {
    if (bytes + size > MAX_PACKAGE_BYTES) throw new AppError('SHARE_TOO_LARGE', 'The share exceeds 50 MB', 413);
  };
  const put = async (name: string, data: string | Buffer) => {
    options.signal?.throwIfAborted();
    if (files.has(name)) return;
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    requireCapacity(content.length);
    await mkdir(path.dirname(path.join(outputDir, name)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(outputDir, name), content, { flag: 'wx', mode: 0o600 });
    bytes += content.length;
    files.set(name, digest(content));
  };
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  if ((await lstat(outputDir)).isSymbolicLink() || (await readdir(outputDir)).length) throw new AppError('SHARE_DIRECTORY_UNSAFE', 'The share directory must be empty', 500);
  let index = '';
  const copyAssets = async (directory: string, prefix = ''): Promise<void> => {
    if ((await lstat(directory)).isSymbolicLink()) throw new AppError('SHARE_ASSETS_UNSAFE', 'Share assets cannot contain symbolic links', 500);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new AppError('SHARE_ASSETS_UNSAFE', 'Share assets cannot contain symbolic links', 500);
      if (/\.map$|(?:^|\/)(?:sw|service-worker|registerSW)(?:[.-]|$)/i.test(name)) continue;
      if (entry.isDirectory()) await copyAssets(path.join(directory, entry.name), `${name}/`);
      else if (entry.isFile()) {
        const info = await lstat(path.join(directory, entry.name));
        requireCapacity(info.size);
        const data = await readFile(path.join(directory, entry.name));
        if (name === 'index.html') index = data.toString('utf8');
        else await put(name, data);
      }
    }
  };
  options.onProgress?.({ stage: 'assets' });
  await copyAssets(webAssetsDir);
  if (!index) throw new AppError('SHARE_ASSETS_UNAVAILABLE', 'The share page has not been built', 503);
  for (const file of options.appearanceFiles ?? []) await put(file.name, file.data);
  options.onProgress?.({ stage: 'resources' });

  const optimizedImages = new Map<string, ReturnType<typeof optimizeShareImage>>();
  const freeze = async (data: Buffer, metadata: Omit<ShareResource, 'url' | 'size'>): Promise<ShareResource> => {
    // All image entry points share this cache, including duplicate native data URLs and paths.
    // Keep the existing byte-level MIME boundary before passing uploads to an image codec.
    if (metadata.mimeType.startsWith('image/') && previewImageMimeType(data) === metadata.mimeType) {
      const key = `${metadata.mimeType}:${digest(data)}`;
      let optimized = optimizedImages.get(key);
      if (!optimized) { optimized = optimizeShareImage(data, metadata.mimeType); optimizedImages.set(key, optimized); }
      const image = await optimized;
      data = image.data;
      if (image.width && image.height) metadata = { ...metadata, width: image.width, height: image.height };
    }
    // Executable uploads never get an HTML/XML extension on the shared origin. An SVG image
    // stays in a data URL, whose opaque origin also isolates direct navigation.
    let url: string;
    if (metadata.mimeType === 'image/svg+xml') url = `data:image/svg+xml;base64,${data.toString('base64')}`;
    else {
      url = `./attachments/${digest(data)}${imageExtensions[metadata.mimeType] ?? '.bin'}`;
      await put(url.slice(2), data);
    }
    return { ...metadata, url, size: data.length };
  };
  const attachmentIds = new Set<string>();
  const blobRefs = new Set<string>();
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(scan); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.attachmentIds)) for (const id of record.attachmentIds) if (typeof id === 'string') attachmentIds.add(id);
    if (Array.isArray(record.attachments)) for (const item of record.attachments) {
      if (!item || typeof item !== 'object') continue;
      const attachment = item as Record<string, unknown>;
      // Native images may use their source URL/path as an id. Only Riffet attachment ids
      // belong to the attachment store; image sources are frozen by rewrite below.
      if (typeof attachment.id === 'string' && /^[a-f0-9-]{36}$/i.test(attachment.id)) attachmentIds.add(attachment.id);
    }
    if (typeof record.blobRef === 'string') blobRefs.add(record.blobRef);
    Object.values(record).forEach(scan);
  };
  scan(snapshot.events); scan(snapshot.runs); scan(snapshot.subagents);
  for (const ref of blobRefs) {
    const blob = store.journal.sessionBlob(sessionId, ref);
    if (!blob || blob.size > MAX_BLOB_BYTES || !blob.type.startsWith('text/')) { warnings.add('部分活动全文不可用'); continue; }
    snapshot.blobs[ref] = blob.bytes().toString('utf8');
  }
  for (const id of attachmentIds) {
    try {
      const { attachment, data } = await workspace.readAttachment(id);
      const resource = await freeze(data, { name: path.basename(attachment.name.replace(/\\/g, '/')), mimeType: attachment.mimeType,
        ...(attachment.width && attachment.height ? { width: attachment.width, height: attachment.height } : {}) });
      if (previewKind(attachment.name, data) && !attachment.mimeType.startsWith('image/')) {
        try {
          const previewUrl = `./previews/attachment-${digest(Buffer.concat([Buffer.from(attachment.name + '\0'), data]))}.html`;
          await put(previewUrl.slice(2), isolatedPage(await renderFilePreview(data, attachment.name, { scheme: snapshot.appearance?.mode === 'dark' ? 'dark' : 'light' }, async source => {
            if (!/^attachment:[a-f0-9-]{36}$/i.test(source)) throw new Error('Attachment image references require an attachment id');
            return previewImageData((await workspace.readAttachment(source.slice('attachment:'.length))).data);
          })));
          resource.previewUrl = previewUrl;
          if (previewKind(attachment.name, data) === 'html') warnings.add('HTML 预览中的脚本不会执行');
        } catch (error) {
          if (error instanceof AppError && error.code === 'SHARE_TOO_LARGE') throw error;
          warnings.add('部分附件预览不可用');
        }
      }
      snapshot.resources[id] = resource;
    } catch (error) {
      if (error instanceof AppError && error.code === 'SHARE_TOO_LARGE') throw error;
      warnings.add('部分附件不可用');
    }
  }

  const languages = new Set<string>();
  // Match the shared timeline's Markdown boundaries. User prompts, terminal/file output,
  // raw tool input and activity blobs are plain text even when they contain Markdown syntax.
  const markdownFields = new WeakMap<object, string>();
  for (const event of [...snapshot.events, ...snapshot.subagents.flatMap(child => child.events)]) {
    const data = event.data;
    const update = typeof data.sessionUpdate === 'string' ? data.sessionUpdate : event.type;
    if (update === 'agent_message_chunk' || update === 'agent_thought_chunk') {
      const content = data.content && typeof data.content === 'object' && !Array.isArray(data.content) ? data.content as Record<string, unknown> : undefined;
      if (content && typeof content.text === 'string') markdownFields.set(content, 'text');
      else if (typeof data.text === 'string') markdownFields.set(data, 'text');
    } else if ((update === 'tool_call' || update === 'tool_call_update') && Array.isArray(data.content)) {
      for (const block of data.content) if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'markdown') markdownFields.set(block, 'text');
    } else if (update === 'task_notification' && data.kind === 'subagent') markdownFields.set(data, 'detail');
  }
  const images = new Map<string, Promise<string>>();
  const visualizations = new Set<string>();
  const freezeVisualization = async (reference: VisualizationReference): Promise<void> => {
    if (visualizations.has(reference.path)) return;
    visualizations.add(reference.path);
    try {
      let local = reference.path;
      if (path.isAbsolute(local) && isWithin(path.resolve(project.cwd), path.resolve(local))) local = path.relative(project.cwd, local);
      const file = await workspace.rawFile(project, local, { allowOutside: options.allowOutsideRead === true });
      if (!file.contentType.startsWith('text/html')) throw new Error('Invalid visualization');
      const data = await readFileBounded(file.path, MAX_VISUALIZATION_BYTES);
      const resource = await freeze(data, { name: file.name, mimeType: 'text/html' });
      resource.previewUrl = `./previews/visualization-${digest(data)}.html`;
      // Reuse the inert HTML preview; never publish arbitrary scripts on the share origin.
      await put(resource.previewUrl.slice(2), isolatedPage(await renderFilePreview(data, file.name)));
      snapshot.resources[reference.path] = resource;
      warnings.add('HTML 预览中的脚本不会执行');
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof AppError && error.code === 'SHARE_TOO_LARGE') throw error;
      warnings.add('部分可视化预览不可用');
    }
  };
  const freezeImage = (source: string): Promise<string> => {
    let pending = images.get(source);
    if (!pending) {
      pending = (async () => {
        const reference = `./attachments/image-${digest(source).slice(0, 24)}`;
        if (/^(?:https?:)?\/\//i.test(source)) {
          warnings.add('外部图片未打包');
          return reference;
        }
        try {
          const attachmentId = /^\/api\/attachments\/([^/?#]+)/.exec(source)?.[1];
          let resource: ShareResource | undefined;
          if (/^data:/i.test(source)) {
            const comma = source.indexOf(',');
            const mimeType = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(source.slice(0, comma))?.[1]?.toLowerCase();
            const encoded = source.slice(comma + 1);
            if (!mimeType || !imageExtensions[mimeType] || encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) throw new Error('Invalid image data URL');
            const data = Buffer.from(encoded, 'base64');
            if (data.length > MAX_IMAGE_BYTES || data.toString('base64') !== encoded || previewImageMimeType(data) !== mimeType) throw new Error('Invalid image data');
            resource = await freeze(data, { name: `图片${imageExtensions[mimeType]}`, mimeType });
          } else if (attachmentId) {
            const { attachment, data } = await workspace.readAttachment(decodeURIComponent(attachmentId));
            resource = await freeze(data, { name: path.basename(attachment.name), mimeType: attachment.mimeType });
          } else {
            let local = localImagePath(source);
            if (source.startsWith('/api/projects/')) {
              const url = new URL(source, 'http://riffet.invalid');
              if (url.pathname !== `/api/projects/${encodeURIComponent(project.id)}/file/image`) throw new Error('Unrelated project image');
              local = url.searchParams.get('path') ?? undefined;
            }
            if (local === undefined) return source;
            // Native inputs retain Riffet's attachment file path. Resolve only a known
            // attachment id and require its metadata to name this exact file; the ordinary
            // workspace reader must continue rejecting arbitrary files in the state directory.
            const nativeAttachmentId = path.isAbsolute(local) ? /^([0-9a-f-]{36})\.bin$/i.exec(path.basename(local))?.[1] : undefined;
            if (nativeAttachmentId) {
              const owned = await workspace.readAttachment(nativeAttachmentId).catch(() => undefined);
              if (owned && path.resolve(owned.attachment.path) === path.resolve(local)) {
                resource = await freeze(owned.data, { name: path.basename(owned.attachment.name), mimeType: owned.attachment.mimeType,
                  ...(owned.attachment.width && owned.attachment.height ? { width: owned.attachment.width, height: owned.attachment.height } : {}) });
              }
            }
            if (!resource) {
              // macOS's /var -> /private/var alias must not turn a project-local image into
              // an outside read. The workspace reader still checks the canonical target.
              if (path.isAbsolute(local) && isWithin(path.resolve(project.cwd), path.resolve(local))) local = path.relative(project.cwd, local);
              const { data, mimeType } = await workspace.readPreviewImage(project, local, { allowOutside: options.allowOutsideRead === true, ...(options.generatedImageHomes ? { generatedImageHomes: options.generatedImageHomes } : {}) });
              resource = await freeze(data, { name: path.basename(local), mimeType });
            }
          }
          const rewritten = resource.url.startsWith('./') ? resource.url : reference;
          snapshot.resources[rewritten] = resource;
          return rewritten;
        } catch (error) {
          if (error instanceof AppError && error.code === 'SHARE_TOO_LARGE') throw error;
          warnings.add('部分图片不可用');
          return reference;
        }
      })();
      images.set(source, pending);
    }
    return pending;
  };
  const rewrite = async (value: unknown): Promise<void> => {
    options.signal?.throwIfAborted();
    if (Array.isArray(value)) { for (const child of value) await rewrite(child); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.type === 'image') {
      if (record.omitted === true && typeof record.path !== 'string' && typeof record.src !== 'string' && typeof record.data !== 'string') warnings.add('部分图片不可用');
      if (typeof record.path === 'string') record.path = await freezeImage(record.path);
      if (typeof record.src === 'string') record.src = await freezeImage(record.src);
      if (typeof record.data === 'string' && typeof record.mimeType === 'string') {
        record.path = await freezeImage(`data:${record.mimeType};base64,${record.data}`);
        delete record.data;
      }
      const reference = typeof record.path === 'string' ? record.path : typeof record.src === 'string' ? record.src : undefined;
      const resource = reference ? snapshot.resources[reference] : undefined;
      if (resource) {
        record.mimeType = resource.mimeType;
        record.size = resource.size;
        if (resource.width && resource.height) { record.width = resource.width; record.height = resource.height; }
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'attachments' && Array.isArray(child)) {
        const attachments: unknown[] = [];
        for (const item of child) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) { attachments.push(item); continue; }
          const attachment = item as Record<string, unknown>;
          // A frozen upload already has its bytes. Its CLI path can point to an expired or different copy.
          if (typeof attachment.id === 'string' && attachmentIds.has(attachment.id) && snapshot.resources[attachment.id]) {
            delete attachment.path;
            delete attachment.src;
            delete attachment.data;
          }
          const source = typeof attachment.path === 'string' ? attachment.path : typeof attachment.src === 'string' ? attachment.src
            : typeof attachment.data === 'string' && typeof attachment.mimeType === 'string' ? `data:${attachment.mimeType};base64,${attachment.data}`
            : typeof attachment.id === 'string' && (/^data:/i.test(attachment.id) || path.isAbsolute(attachment.id)) ? attachment.id : undefined;
          if (!source || (attachment.type !== 'image' && !(typeof attachment.mimeType === 'string' && attachment.mimeType.startsWith('image/')))) {
            await rewrite(attachment); attachments.push(attachment); continue;
          }
          const reference = await freezeImage(source);
          const resource = snapshot.resources[reference];
          const name = resource?.name ?? (/^data:/i.test(source) ? '图片' : typeof attachment.name === 'string' && attachment.name ? path.basename(attachment.name.replace(/\\/g, '/')).slice(0, 120) : path.basename(localImagePath(source) ?? '') || '图片');
          attachments.push({ type: 'image', id: reference, name,
            ...(resource ? { mimeType: resource.mimeType, size: resource.size,
              ...(resource.width && resource.height ? { width: resource.width, height: resource.height } : {}) } : {}) });
        }
        record[key] = attachments;
      } else if (typeof child === 'string' && markdownFields.get(record) === key) {
        let rewritten = rewriteVisualizationReferences(child, '交互预览');
        const refs = markdownReferences(rewritten);
        refs.languages.forEach(language => languages.add(language));
        for (const reference of refs.visualizations) await freezeVisualization(reference);
        for (const image of refs.images.sort((a, b) => b.start - a.start)) {
          if (localImagePath(image.source) === undefined && !image.source.startsWith('/api/attachments/') && !image.source.startsWith('/api/projects/') && !/^(?:https?:)?\/\//i.test(image.source) && !/^data:/i.test(image.source)) continue;
          const url = await freezeImage(image.source);
          const replacement = image.definition ? `[${image.definition}]: ${url}` : `![${image.alt.replace(/[\\\[\]]/g, '\\$&')}](${url})`;
          rewritten = rewritten.slice(0, image.start) + replacement + rewritten.slice(image.end);
        }
        record[key] = rewritten;
      } else await rewrite(child);
    }
  };
  await rewrite(snapshot.events); await rewrite(snapshot.runs); await rewrite(snapshot.subagents); await rewrite(snapshot.jobs);
  for (const [engine, aliases] of Object.entries(diagramAliases)) if (aliases.some(alias => languages.has(alias))) {
    const url = `./previews/${engine}.html`;
    await put(url.slice(2), isolatedPage(await renderDiagramPage(engine)));
    for (const alias of aliases) snapshot.diagramPages[alias] = url;
  }
  if (languages.has('html') || languages.has('htm') || languages.has('svg')) {
    snapshot.contentPage = './previews/content.html';
    await put('previews/content.html', isolatedPage(contentPreviewPage()));
    if (languages.has('html') || languages.has('htm')) warnings.add('HTML 预览中的脚本不会执行');
  }
  options.onProgress?.({ stage: 'finalizing' });
  snapshot.warnings = [...warnings];
  const eventText = (event: ShareSnapshot['events'][number]): string => {
    const content = event.data.content as { text?: unknown } | undefined;
    const raw = typeof content?.text === 'string' ? content.text : typeof event.data.text === 'string' ? event.data.text : '';
    return raw.replace(/\s+/g, ' ').trim();
  };
  const descriptionText = snapshot.events
    .filter(event => {
      const kind = typeof event.data.sessionUpdate === 'string' ? event.data.sessionUpdate : event.type;
      return kind === 'user_message_chunk' || kind === 'agent_message_chunk';
    })
    .map(eventText)
    .find(Boolean);
  const description = (descriptionText || snapshot.title).slice(0, 160) || 'Riffet';
  const pageTitle = `${snapshot.title} · Riffet`;
  index = index.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(pageTitle)}</title>`);
  const shareMeta = `<meta name="description" content="${escapeHtml(description)}"><meta property="og:type" content="article"><meta property="og:title" content="${escapeHtml(pageTitle)}"><meta property="og:description" content="${escapeHtml(description)}"><meta name="twitter:card" content="summary">`;
  const appearanceMeta = `<meta name="riffet-share-appearance" content="${escapeHtml(JSON.stringify(snapshot.appearance ?? { themeId: 'riffet', mode: 'system' }))}">`;
  index = index.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${shareMeta}${appearanceMeta}`);
  const data = JSON.stringify(snapshot);
  const hash = digest(JSON.stringify([...files].sort()) + index + data);
  const dataUrl = `./data/session-${hash}.json`;
  const meta = `<meta name="riffet-share-data" content="${dataUrl}">`;
  index = /<meta\s+[^>]*name=["']riffet-share-data["'][^>]*>/i.test(index)
    ? index.replace(/<meta\s+[^>]*name=["']riffet-share-data["'][^>]*>/i, meta)
    : index.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${meta}`);
  index = index.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<meta http-equiv="Content-Security-Policy" content="${escapeHtml(SHARE_PAGE_CSP)}"><meta name="referrer" content="no-referrer">`);
  await put(dataUrl.slice(2), data);
  await put('index.html', index);
  return { hash, bytes, warnings: snapshot.warnings };
}
