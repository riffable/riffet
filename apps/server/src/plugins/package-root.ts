import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where a built-in package keeps its files. A package that ships files (an appearance pack's
// `assets/`) lives at `plugins/<vendor>/<name>/` for the id `<vendor>.<name>`: in the repository
// when running from source, and in `dist/plugins/<vendor>/<name>/` in a build, where
// `scripts/build.ts` copies each included vendor's `assets/` directories. The built server, the App's
// bundled payload (which carries `dist/` whole) and a source checkout therefore all resolve one way.

const here = fileURLToPath(new URL('.', import.meta.url));
/** A bundle sits directly in `dist/`; source runs sit in `apps/server/src/plugins/`. */
const roots = [resolve(here, 'plugins'), resolve(here, '../../../../plugins')];

/** The directory of built-in package `id`, or `undefined` when this build carries none. */
export function builtinPackageRoot(id: string): string | undefined {
  const dot = id.indexOf('.');
  if (dot < 1) return undefined;
  for (const root of roots) {
    const directory = resolve(root, id.slice(0, dot), id.slice(dot + 1));
    if (existsSync(directory)) return directory;
  }
  return undefined;
}
