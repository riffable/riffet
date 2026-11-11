import { AppError } from '../errors.js';
import { RIFFET_MCP_NAME } from '../riffet-mcp/service.js';

const MAX_ITEMS = 200;
const MAX_LENGTH = 200;

/**
 * A validated, de-duplicated `extensionsOff` list (docs/EXTENSIONS.md): `mcp:<name>` or `skill:<name>`.
 * Riffet's own MCP server is never switched off, so asking for it is dropped without an error.
 */
export function extensionsOffList(value: unknown, name = 'extensionsOff'): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new AppError('INVALID_EXTENSIONS_OFF', `${name} must list at most ${MAX_ITEMS} extensions`);
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(item)) throw new AppError('INVALID_EXTENSIONS_OFF', `${name} contains an invalid entry`);
    const colon = item.indexOf(':');
    const kind = item.slice(0, colon);
    if (colon < 0 || (kind !== 'mcp' && kind !== 'skill') || !item.slice(colon + 1).trim()) throw new AppError('INVALID_EXTENSIONS_OFF', `${name} entries must be mcp:<name> or skill:<name>`);
    if (item === `mcp:${RIFFET_MCP_NAME}`) continue;
    if (!items.includes(item)) items.push(item);
  }
  return items;
}

/** The entries a backend can apply (its `extensionToggles`); the stored list says only what the next launch does. */
export function applicableExtensionsOff(items: readonly string[], toggles: { mcp: boolean; skills: boolean } | undefined): string[] {
  return items.filter(item => (item.startsWith('mcp:') ? toggles?.mcp : toggles?.skills) === true);
}

/** The names of one kind in a conversation's `extensionsOff`. */
export function extensionsOffNames(items: readonly string[] | undefined, kind: 'mcp' | 'skill'): string[] {
  return (items ?? []).filter(item => item.startsWith(`${kind}:`)).map(item => item.slice(kind.length + 1));
}
