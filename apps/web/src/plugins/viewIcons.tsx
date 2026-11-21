import { PLUGIN_VIEW_ICON_BUDGET, VIEW_ICON_ROUTE } from '@contracts';
import type { IconComponent, PluginIconName } from '@riffet/plugin-web';
import { createElement, useEffect, useSyncExternalStore } from 'react';
import { registerCache } from '@/lib/cache-registry';
import { cn, readStored, writeStored } from '@/lib/utils';
import { pluginIcon } from './icons';

/**
 * The icon a plugin view declares as `icon.svg` (`VIEW_ICON_ROUTE`). Only the geometry is kept, from a short list
 * of shapes and attributes, and drawn as a 24×24 outline with the app's own stroke (`.lucide`, 1.25px at any size)
 * in the text colour: the file is never inserted as markup, and a plugin's glyph sits among the app's own.
 * Outlines are kept in local storage so the sidebar draws them on the first frame; the server revalidates them.
 */

type Shape = [tag: string, attributes: Record<string, string>];

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;
const ATTRIBUTES: Record<string, Record<string, RegExp>> = {
  path: { d: /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]{1,4000}$/ },
  line: { x1: NUMBER, y1: NUMBER, x2: NUMBER, y2: NUMBER },
  rect: { x: NUMBER, y: NUMBER, width: NUMBER, height: NUMBER, rx: NUMBER, ry: NUMBER },
  circle: { cx: NUMBER, cy: NUMBER, r: NUMBER },
  ellipse: { cx: NUMBER, cy: NUMBER, rx: NUMBER, ry: NUMBER },
  polyline: { points: /^[0-9eE.,\s-]{1,4000}$/ },
  polygon: { points: /^[0-9eE.,\s-]{1,4000}$/ },
};

/** The shapes of a 24×24 outline, or undefined when the file is not one: another view box, a transform, too many shapes. */
export function outlineShapes(text: string): Shape[] | undefined {
  if (typeof DOMParser === 'undefined') return undefined;
  const root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  if (root.localName !== 'svg') return undefined;
  const box = root.getAttribute('viewBox');
  if (box !== null && box.trim().split(/[\s,]+/).join(' ') !== '0 0 24 24') return undefined;
  const shapes: Shape[] = [];
  const walk = (parent: Element): boolean => {
    for (const node of Array.from(parent.children)) {
      if (node.localName === 'g') {
        if (node.hasAttribute('transform') || !walk(node)) return false;
        continue;
      }
      const allowed = ATTRIBUTES[node.localName];
      if (!allowed) continue;
      const attributes: Record<string, string> = {};
      for (const [name, pattern] of Object.entries(allowed)) {
        const value = node.getAttribute(name);
        if (value !== null && pattern.test(value)) attributes[name] = value;
      }
      if (node.hasAttribute('transform') || shapes.length >= PLUGIN_VIEW_ICON_BUDGET.shapes) return false;
      shapes.push([node.localName, attributes]);
    }
    return true;
  };
  return walk(root) && shapes.length ? shapes : undefined;
}

// Retained across reloads; a sign-out clears it with the other caches.
const STORE_KEY = 'riffet.plugins.view-icons.v1:';
const storeKey = () => STORE_KEY + (globalThis.location?.origin ?? '');

// perf-rules: allow bounded at PLUGIN_VIEW_ICON_BUDGET.entries, oldest dropped first
const outlines = new Map<string, Shape[] | null>(readKept());
// perf-rules: allow one id per declared view, read once per page load
const loading = new Set<string>();
const listeners = new Set<() => void>();
// After a clear every mounted glyph reads its outline again instead of staying empty.
registerCache('plugin-view-icons', { size: () => outlines.size, limit: PLUGIN_VIEW_ICON_BUDGET.entries, clear: () => {
  outlines.clear();
  loading.clear();
  writeStored(storeKey(), undefined);
  for (const listener of listeners) listener();
} });

function readKept(): Array<[string, Shape[]]> {
  try {
    const parsed: unknown = JSON.parse(readStored(storeKey()) || '[]');
    return Array.isArray(parsed) ? parsed.filter((entry): entry is [string, Shape[]] => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])).slice(-PLUGIN_VIEW_ICON_BUDGET.entries) : [];
  } catch { return []; }
}

function keep(viewId: string, shapes: Shape[] | null): void {
  outlines.delete(viewId);
  while (outlines.size >= PLUGIN_VIEW_ICON_BUDGET.entries) outlines.delete(outlines.keys().next().value!);
  outlines.set(viewId, shapes);
  writeStored(storeKey(), JSON.stringify([...outlines].filter(([, value]) => value)));
  for (const listener of listeners) listener();
}

/** Reads the outline once per page load: a kept one draws at once and is replaced if the file changed. */
function load(viewId: string): void {
  if (loading.has(viewId)) return;
  loading.add(viewId);
  void fetch(VIEW_ICON_ROUTE(viewId), { credentials: 'same-origin' })
    .then(async (response) => (response.ok ? outlineShapes(await response.text()) ?? null : null))
    .catch(() => (outlines.get(viewId) === undefined ? null : outlines.get(viewId)!))
    .then((shapes) => { if (JSON.stringify(shapes) !== JSON.stringify(outlines.get(viewId))) keep(viewId, shapes); });
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

// perf-rules: allow one component per declared view id, as many as the views a server declares
const components = new Map<string, IconComponent>();

/** The glyph of a view: its declared outline when it has one that loaded, else the named icon. */
export function viewIcon(view: { id: string; icon: PluginIconName; iconSvg?: boolean }): IconComponent {
  if (!view.iconSvg) return pluginIcon(view.icon);
  const key = `${view.id}\0${view.icon}`;
  let component = components.get(key);
  if (!component) {
    const Fallback = pluginIcon(view.icon);
    component = function ViewIcon({ className }: { className?: string }) {
      const shapes = useSyncExternalStore(subscribe, () => outlines.get(view.id));
      useEffect(() => { if (shapes === undefined) load(view.id); }, [shapes]);
      // Until the first read answers, an empty glyph holds the slot so the fallback does not flash.
      if (shapes === null) return <Fallback className={className} />;
      return (
        <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={cn('lucide', className)}>
          {shapes?.map(([tag, attributes], index) => createElement(tag, { key: index, ...attributes }))}
        </svg>
      );
    };
    components.set(key, component);
  }
  return component;
}
