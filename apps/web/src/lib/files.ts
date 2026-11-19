import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { api, HttpError, withClientFeatures } from './api';
import { errorMessage } from './utils';
import { toast } from './toast';

/** The file as stored: opened in a tab when the browser can show it, otherwise downloaded. */
export function projectFileUrl(projectId: string, path: string, options: { download?: boolean } = {}): string {
  return withClientFeatures(`/api/projects/${encodeURIComponent(projectId)}/file/raw?path=${encodeURIComponent(path)}${options.download ? '&download=1' : ''}`);
}

export function projectArchiveUrl(projectId: string, path: string): string {
  return withClientFeatures(`/api/projects/${encodeURIComponent(projectId)}/archive?path=${encodeURIComponent(path)}`);
}

/** The server names the file; an empty `download` attribute keeps that name. */
export function startDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

export function downloadProjectFile(projectId: string, path: string): void {
  startDownload(projectFileUrl(projectId, path, { download: true }));
}

/** Checked first: a folder over the limits would otherwise download as an error page. */
export async function downloadProjectFolder(projectId: string, path: string): Promise<void> {
  try {
    await api.archiveInfo(projectId, path);
  } catch (error) {
    toast.error(error instanceof HttpError && error.code === 'ARCHIVE_TOO_LARGE' ? i18n._(msg`文件夹太大，无法打包下载（上限 2 万个文件或 2 GiB）`) : errorMessage(error, i18n._(msg`无法打包下载`)));
    return;
  }
  startDownload(projectArchiveUrl(projectId, path));
}

/** An HTML page opens with its folder as the site, so its links and assets resolve as they would on disk. */
export function openProjectFile(projectId: string, path: string): void {
  const url = projectFileUrl(projectId, path);
  window.open(/\.html?$/i.test(path) ? `${url}&render=site` : url, '_blank', 'noopener');
}

export function absolutePath(root: string | undefined, path: string): string {
  if (path.startsWith('/') || path === '~' || path.startsWith('~/') || !root) return path;
  return `${root.replace(/\/+$/, '')}/${path}`;
}

/** The Clipboard API is missing on plain-HTTP LAN addresses, which is how phones usually connect. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the selection copy */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  area.remove();
  return copied;
}

export async function copyWithToast(text: string, done?: string): Promise<void> {
  if (await copyText(text)) toast.success(done ?? i18n._(msg`已复制`));
  else toast.error(i18n._(msg`无法访问剪贴板`));
}
