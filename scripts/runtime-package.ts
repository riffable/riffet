import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import type { Metafile } from 'esbuild';

// esbuild cannot see what the server resolves by path at runtime: KaTeX's build and fonts (the math
// page and preview styles), pdf.js cmaps and standard fonts served to the PDF preview, and the lazily
// required HEIC decoder. `tsx` (source runs only) and DSH's packages (from DSH's own install) stay out.
const RESOLVED = ['katex', 'pdfjs-dist', 'heic-decode'];

const packageName = (specifier: string): string => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

/** The version npm actually installed, not the range (or URL) package.json pins. */
function installedVersion(modules: string, name: string): string {
  const manifest = JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error(`Installed package ${name} does not declare a version`);
  return manifest.version;
}

/** A tarball, Git or local specifier: it already identifies one build and is the only installable form. */
const remoteSpecifier = (specifier: string): boolean => /^(?:https?|git\+[^:]+|git|github|file|link|workspace):/i.test(specifier);

/** The production dependencies `dist/` loads (it is bundled with `packages: 'external'`), at their installed versions. */
export function runtimePackage(metafile: Metafile, root: { version: string; dependencies: Record<string, string> }, modules = 'node_modules') {
  const names = new Set(RESOLVED);
  for (const { imports } of Object.values(metafile.outputs)) for (const { path, external } of imports) {
    if (!external || path.startsWith('node:') || builtinModules.includes(path)) continue;
    const name = packageName(path);
    names.add(name);
  }
  const missing = [...names].filter(name => !Object.hasOwn(root.dependencies, name));
  if (missing.length) throw new Error(`dist/ loads ${missing.join(', ')} at runtime, but package.json does not list ${missing.length > 1 ? 'them' : 'it'} in dependencies`);
  const dependencies = Object.fromEntries([...names].sort().map(name => {
    const installed = installedVersion(modules, name);
    const pinned = root.dependencies[name]!;
    // A URL dependency names one tarball; replacing it with the bare version would make the
    // payload's `npm install` fail, because that version is not on the public registry. There is no
    // lockfile in the payload, so the URL is the pin; every registry dependency is its exact
    // installed version instead of the range package.json declares.
    return [name, remoteSpecifier(pinned) ? pinned : installed];
  }));
  return { name: 'riffet-server', private: true, type: 'module', version: root.version, dependencies };
}
