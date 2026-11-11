import { useEffect, useSyncExternalStore } from 'react';

/**
 * KaTeX, its rehype plugin and its stylesheet, loaded the first time an answer could contain TeX.
 * Together they are the largest part of the markdown renderer, and most conversations never use them.
 */
export interface MathModules {
  katex: typeof import('katex').default;
  rehypeKatex: typeof import('rehype-katex').default;
}

let modules: MathModules | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

export function loadMath(): Promise<void> {
  loading ??= Promise.all([import('katex'), import('rehype-katex'), import('katex/dist/katex.min.css')])
    .then(([katex, rehypeKatex]) => {
      modules = { katex: katex.default, rehypeKatex: rehypeKatex.default };
      for (const listener of listeners) listener();
    })
    // A failed chunk load (offline, mid-deploy) leaves the TeX as code; the next answer retries.
    .catch(() => { loading = undefined; });
  return loading;
}

/** A cheap superset of what remark-math parses: `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and math fences. */
export function mayContainMath(text: string): boolean {
  return text.includes('$') || text.includes('\\(') || text.includes('\\[') || /```\s*(?:math|latex|tex)\b/i.test(text);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => modules;

let requested = false;

/**
 * The loaded modules, starting the load when `needed`; undefined until they arrive.
 *
 * The first request goes out from the render that first sees TeX rather than from its effect, a
 * paint earlier; a failed load is retried from the effect, when `needed` turns on again.
 */
export function useMath(needed: boolean): MathModules | undefined {
  const loaded = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (needed && !requested) { requested = true; void loadMath(); }
  useEffect(() => { if (needed && !modules) void loadMath(); }, [needed]);
  return loaded;
}
