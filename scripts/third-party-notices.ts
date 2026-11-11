import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The notices for every npm package dist/ ships: the runtime dependencies installed next to it, with
// their production dependency trees, and the packages bundled into its browser outputs. `pnpm build`
// collects the bundled files into a directory, one JSON array of file paths per output. Only npm
// packages are covered here; Swift and Kotlin packages and vendored assets are listed in NOTICE and
// in apps/macos/Riffet/Resources/Acknowledgements.md.
//
//   tsx scripts/third-party-notices.ts <runtime-package.json> <bundled-files-dir> <output.md>

interface Manifest {
  name: string;
  version: string;
  license?: string | { type?: string };
  licenses?: string | { type?: string }[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
interface Shipped { manifest: Manifest; directory: string; outputs: Set<string> }

const MODULES = `${sep}node_modules${sep}`;
// LICENSE, LICENCE.md, COPYING, NOTICE.txt, LICENSE-MIT, ThirdPartyNotices…; Apache-2.0 §4(d) needs NOTICE verbatim.
const LEGAL = /^(licen[cs]e|copying|notice|unlicense|third[-_]?party)/i;
const RUNTIME = 'node_modules';
// @viz-js/viz ships a MIT wrapper (its package.json declares MIT and the repository LICENSE carries
// Michael Daines's copyright) around a WebAssembly build of Graphviz. The build also includes code
// from Expat, whose MIT text is required. Its dist files state that they contain Graphviz in object
// code form, so the notices credit all three and include their texts: the wrapper and Expat MIT
// texts from the projects, and Graphviz's EPL-1.0 text (verbatim from https://spdx.org/licenses/EPL-1.0.txt).
const GRAPHVIZ = '@viz-js/viz';
const GRAPHVIZ_LICENSE = 'MIT (Viz.js wrapper), MIT (Expat), EPL-1.0 (Graphviz)';
const GRAPHVIZ_TEXTS: ReadonlyArray<readonly [string, string]> = [
  ['MIT (Viz.js wrapper)', 'viz-js.txt'],
  ['MIT (Expat)', 'Expat.txt'],
  ['EPL-1.0 (Graphviz)', 'EPL-1.0.txt'],
];
const LICENSE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'licenses');

// By name and version: pnpm installs one version once per set of peers it resolves against.
const packages = new Map<string, Shipped>();
const installed = new Set<string>();

function add(directory: string, output: string): Manifest {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest;
  const key = `${manifest.name}@${manifest.version}`;
  let entry = packages.get(key);
  if (!entry) packages.set(key, entry = { manifest, directory: realpathSync(directory), outputs: new Set() });
  entry.outputs.add(output);
  return manifest;
}

/** The package a bundled file belongs to: the path up to its last `node_modules/<name>`. */
function packageDirectory(file: string): string | undefined {
  const index = file.lastIndexOf(MODULES);
  if (index < 0) return undefined;
  const [first, second] = file.slice(index + MODULES.length).split(sep);
  return file.slice(0, index + MODULES.length) + (first!.startsWith('@') ? `${first}${sep}${second}` : first);
}

/** Node's lookup, which finds a dependency in both pnpm's and npm's layouts. */
function resolvePackage(name: string, from: string): string | undefined {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (directory === dirname(directory)) return undefined;
  }
}

function addInstalled(directory: string): void {
  const real = realpathSync(directory);
  if (installed.has(real)) return;
  installed.add(real);
  const manifest = add(real, RUNTIME);
  // npm installs non-optional peers too; optional dependencies exist only on matching platforms.
  const required = Object.keys(manifest.dependencies ?? {});
  for (const name of new Set([...required, ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])) {
    const dependency = resolvePackage(name, real);
    if (dependency) addInstalled(dependency);
    else if (required.includes(name) && !Object.hasOwn(manifest.optionalDependencies ?? {}, name)) throw new Error(`${manifest.name} depends on ${name}, which is not installed`);
  }
}

function licenseOf({ license, licenses }: Manifest): string | undefined {
  if (typeof license === 'string') return license;
  if (license?.type) return license.type;
  const types = typeof licenses === 'string' ? [licenses] : (licenses ?? []).map(({ type }) => type).filter(Boolean);
  return types.length ? types.join(' OR ') : undefined;
}

/** The license the notices credit a package with; see GRAPHVIZ. */
const licenseName = (manifest: Manifest): string | undefined =>
  manifest.name === GRAPHVIZ ? GRAPHVIZ_LICENSE : licenseOf(manifest);

const legal = (name: string) => LEGAL.test(name) && !/\.(?:[cm]?js|d\.ts|json|map)$/i.test(name);

/** Its license files, with those one directory down: pdf.js keeps its fonts', cmaps' and decoders' there. */
function legalFiles(directory: string, manifest: Manifest): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && legal(entry.name)) files.push(entry.name);
    else if (entry.isDirectory() && entry.name !== 'node_modules') {
      for (const nested of readdirSync(join(directory, entry.name), { withFileTypes: true })) if (nested.isFile() && legal(nested.name)) files.push(`${entry.name}/${nested.name}`);
    }
  }
  const referenced = /^SEE LICEN[CS]E IN (.+)$/i.exec(licenseOf(manifest) ?? '')?.[1]?.trim();
  if (referenced && !files.includes(referenced) && existsSync(join(directory, referenced))) files.push(referenced);
  return files.sort();
}

/** Without a license file, the README's license section (sharp's libvips builds list their libraries there). */
function readmeLicense(directory: string): string | undefined {
  const readme = readdirSync(directory).find(name => /^readme\.md$/i.test(name));
  if (!readme) return undefined;
  const lines = readFileSync(join(directory, readme), 'utf8').split(/\r?\n/);
  const level = (line: string) => /^(#{1,6})\s/.exec(line)?.[1]!.length;
  const start = lines.findIndex(line => level(line) && /^#+\s+licen[cs]/i.test(line));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && (level(line) ?? 7) <= level(lines[start]!)!);
  return lines.slice(start, end < 0 ? undefined : end).join('\n').trim();
}

function fenced(name: string, text: string): string {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(([run]) => run.length + 1)));
  return `${name}:\n\n${fence}text\n${text}\n${fence}`;
}

function legalText(entry: Shipped): string {
  if (entry.manifest.name === GRAPHVIZ) {
    return GRAPHVIZ_TEXTS
      .map(([label, file]) => fenced(label, readFileSync(join(LICENSE_DIRECTORY, file), 'utf8').replace(/\r\n?/g, '\n').trimEnd()))
      .join('\n\n');
  }
  const { directory, manifest } = entry;
  const texts = new Map<string, string>();
  for (const name of legalFiles(directory, manifest)) {
    const text = readFileSync(join(directory, name), 'utf8').replace(/\r\n?/g, '\n').trimEnd();
    if (![...texts.values()].includes(text)) texts.set(name, text);
  }
  if (!texts.size) {
    const section = readmeLicense(directory);
    if (section) texts.set('README.md (license section)', section);
  }
  return [...texts].map(([name, text]) => fenced(name, text)).join('\n\n');
}

function notices(runtimeManifest: string, bundledDirectory: string): string {
  const runtime = JSON.parse(readFileSync(runtimeManifest, 'utf8')) as { version: string; dependencies: Record<string, string> };
  for (const name of Object.keys(runtime.dependencies)) {
    const directory = resolvePackage(name, process.cwd());
    if (!directory) throw new Error(`Runtime dependency ${name} is not installed`);
    addInstalled(directory);
  }
  for (const list of readdirSync(bundledDirectory).filter(name => name.endsWith('.json')).sort()) {
    const output = basename(list, '.json');
    for (const id of JSON.parse(readFileSync(join(bundledDirectory, list), 'utf8')) as string[]) {
      // Rollup's virtual helpers start with \0; esbuild names non-file inputs `namespace:path`.
      const path = id.replace(/^\0/, '');
      if (/^[^/]+:/.test(path)) continue;
      const directory = packageDirectory(resolve(path));
      if (directory) add(directory, output);
    }
  }
  const label = ({ manifest }: Shipped) => `${manifest.name} ${manifest.version}`;
  const shipped = [...packages.values()].sort((a, b) => (label(a) < label(b) ? -1 : 1));
  const groups = new Map<string, Shipped[]>();
  for (const entry of shipped) {
    const text = legalText(entry);
    groups.set(text, [...groups.get(text) ?? [], entry]);
  }
  return [
    '# Third-party notices',
    `Riffet ${runtime.version} includes the npm packages below. "Shipped in" names the directory under dist/ a package is bundled into, or ${RUNTIME} for the runtime dependencies installed next to dist/. Generated by scripts/third-party-notices.ts.`,
    ['| Package | Version | License | Shipped in |', '| --- | --- | --- | --- |', ...shipped.map(({ manifest, outputs }) => `| ${manifest.name} | ${manifest.version} | ${(licenseName(manifest) ?? 'Not declared; see its text').replace(/\|/g, '\\|')} | ${[...outputs].sort().join(', ')} |`)].join('\n'),
    '## License texts',
    ...[...groups].map(([text, entries]) => `### ${entries.map(label).join(', ')}\n\n${text || 'The package contains no license file; its license is the one listed above.'}`),
  ].join('\n\n') + '\n';
}

const [runtimeManifest, bundledDirectory, output, ...rest] = process.argv.slice(2);
if (!output || rest.length) throw new Error('Usage: tsx scripts/third-party-notices.ts <runtime-package.json> <bundled-files-dir> <output.md>');
writeFileSync(output, notices(runtimeManifest!, bundledDirectory!));
