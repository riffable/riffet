import { withClientFeatures } from '@/lib/api';
import { createContext, useContext } from 'react';

/** Maps a file path an agent produced or read to a URL the browser can load; `undefined` outside a project. */
export type ImageSource = (path: string) => string | undefined;

export const ImageSourceContext = createContext<ImageSource>(() => undefined);

export const useImageSource = () => useContext(ImageSourceContext);

export function projectImageSource(projectId: string): ImageSource {
  return path => withClientFeatures(`/api/projects/${encodeURIComponent(projectId)}/file/image?path=${encodeURIComponent(path)}`);
}

const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };

/**
 * Markdown image targets that name a local file: absolute or relative paths and `file://` URLs.
 * Remote, data and app URLs stay as written. Markdown percent-encodes destinations (spaces,
 * non-ASCII names), so the path is decoded back to what is on disk.
 */
export function localImagePath(src: string): string | undefined {
  const value = src.trim();
  if (!value || value.startsWith('//') || value.startsWith('/api/') || value.startsWith('#') || value.startsWith('?')) return undefined;
  if (/^file:\/\//i.test(value)) {
    try { return decode(new URL(value).pathname) || undefined; } catch { return undefined; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  return decode(value);
}
