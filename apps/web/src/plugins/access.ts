import type { PluginAccess } from '@riffet/plugin-web';

/*
 * What `WebPlugin.access` allows, judged by the host. A seatbelt for trusted entries and an inventory
 * of what each touches: a request outside the declared prefixes, or a settings key outside the
 * declared keys, is refused before it leaves the page.
 */

const BASE = 'http://plugin.invalid';

// A declared prefix as a pattern: `*` stands for exactly one path segment (`/api/sessions/*/trace`), everything else is literal.
const escapeRegExp = (text: string): string => text.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
const prefixPattern = (prefix: string): RegExp => new RegExp('^' + prefix.split('*').map(escapeRegExp).join('[^/]+'));

/** The path and query to send, or a refusal: it must stay on this server and, once `..` and encoded dots are resolved, under a declared `/api/` prefix. */
export function allowedRequestPath(path: string, access: PluginAccess | undefined): string {
  const prefixes = (access?.requests ?? []).filter((prefix) => prefix.startsWith('/api/')).map(prefixPattern);
  const url = path.startsWith('/') ? new URL(path, BASE) : undefined;
  if (!url || url.origin !== BASE || !prefixes.some((prefix) => prefix.test(url.pathname))) throw new Error(`Plugin request outside its declared access: ${path}`);
  return url.pathname + url.search;
}

/** The entries of `source` under the declared keys; the keys of `patch` are checked, not dropped. */
export function declaredSettings<T extends object>(source: T, access: PluginAccess | undefined): Partial<T> {
  const keys = new Set(access?.settings ?? []);
  return Object.fromEntries(Object.entries(source).filter(([key]) => keys.has(key))) as Partial<T>;
}

export function assertDeclaredSettings(patch: object, access: PluginAccess | undefined): void {
  const keys = new Set(access?.settings ?? []);
  const outside = Object.keys(patch).find((key) => !keys.has(key));
  if (outside !== undefined) throw new Error(`Plugin setting outside its declared access: ${outside}`);
}
