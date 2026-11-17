import type { ProjectContext } from '@riffet/plugin-api';
import { ownerOf, type WorkspaceHandler } from './workspaces.js';

// What the plugin knows of an Android project without running Gradle: where the Gradle builds are,
// which modules are applications, their build variants and application ids. It is read from the
// build scripts as text, so a configuration it cannot see (a convention plugin, a computed name)
// falls back to `debug`/`release` and to what the last build wrote in `output-metadata.json`.

export interface AppModule {
  /** Gradle path, `:app`; `:` for an application at the build's root. */
  path: string;
  /** Directory relative to the Gradle root, `''` for the root. */
  dir: string;
  variants: Variant[];
  /** The Gradle verb of the app's package where it is not `assemble` (an app built as a bundle). */
  verb?: 'assemble' | 'bundle';
  applicationId?: string;
}

export interface Variant {
  /** `debug`, `cnDebug`. */
  name: string;
  buildType: string;
  /** The directory AGP writes this variant's APK into, under `build/outputs/apk/`. */
  outputDir: string;
  applicationId?: string;
}

export interface GradleBuild {
  /** Project-relative, `''` when the project itself is the Gradle build. */
  root: string;
  wrapper: boolean;
  apps: AppModule[];
  /** The workspace handler that owns this build, if one is registered for it. */
  handler?: WorkspaceHandler;
}

const SETTINGS = ['settings.gradle.kts', 'settings.gradle'];
const BUILD_SCRIPTS = ['build.gradle.kts', 'build.gradle'];
/** Directories that hold a nested Gradle build in mixed repositories, searched one level deeper. */
const CONTAINERS = new Set(['android', 'apps', 'app', 'mobile', 'client', 'clients', 'platforms', 'packages']);
const SKIP = new Set(['node_modules', 'build', 'dist', 'out', 'ios', 'iosApp', 'Pods', 'vendor', 'target']);
const MAX_SCRIPT = 512 * 1024;
/** `id("com.android.application")`, `apply plugin: 'com.android.application'`, `alias(libs.plugins.android.application)`. */
const APPLICATION = /(?:plugin\s*:\s*|\bid\s*\(?\s*)["']com\.android\.application["']|libs\.plugins\.android[.-]?[aA]pplication\b/;
/** Directories of modules, whose children are searched for built APKs. */
const MODULE_CONTAINERS = new Set(['projects', 'apps', 'modules', 'android', 'samples', 'features', 'feature']);
const MODULE_PATH = /^:?[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const CACHE_MS = 10_000;

const join = (...parts: string[]): string => parts.filter(Boolean).join('/');
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const cache = new Map<string, { at: number; value: Promise<GradleBuild[]> }>();

/** The Gradle builds of a project, read again at most every few seconds (listing actions runs this each time). */
export function forgetBuilds(): void {
  cache.clear();
}

export function gradleBuilds(project: ProjectContext): Promise<GradleBuild[]> {
  const hit = cache.get(project.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = scan(project).catch(() => []);
  cache.set(project.id, { at: Date.now(), value });
  return value;
}

async function isBuild(project: ProjectContext, dir: string): Promise<boolean> {
  for (const name of [...SETTINGS, 'gradlew']) if (await project.exists(join(dir, name))) return true;
  return false;
}

async function scan(project: ProjectContext): Promise<GradleBuild[]> {
  if (await isBuild(project, '')) return [await readBuild(project, '')];
  const roots: string[] = [];
  for (const entry of await project.list('')) {
    if (entry.startsWith('.') || SKIP.has(entry) || entry.includes('.')) continue;
    if (await isBuild(project, entry)) { roots.push(entry); continue; }
    if (!CONTAINERS.has(entry)) continue;
    for (const inner of await project.list(entry)) {
      if (inner.startsWith('.') || SKIP.has(inner) || inner.includes('.')) continue;
      if (await isBuild(project, join(entry, inner))) roots.push(join(entry, inner));
    }
  }
  const builds = await Promise.all(roots.slice(0, 8).map(root => readBuild(project, root)));
  // A Gradle build with no Android application (a backend, a plugin) is not one this plugin serves.
  return builds.filter(build => build.apps.length > 0);
}

async function readScript(project: ProjectContext, dir: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    const text = await project.readText(join(dir, name), MAX_SCRIPT);
    if (text !== undefined) return stripComments(text);
  }
  return undefined;
}

async function readBuild(project: ProjectContext, root: string): Promise<GradleBuild> {
  const settings = await readScript(project, root, SETTINGS) ?? '';
  // By directory: the root, what the settings include, and what a settings plugin with a module list
  // of its own included, found by the APKs it built.
  const modules = new Map<string, string>([['', ':'], ...includedModules(settings).map(([path, dir]): [string, string] => [dir, path])]);
  for (const dir of await builtModuleDirs(project, root)) if (!modules.has(dir)) modules.set(dir, `:${dir.split('/').pop()}`);
  const apps: AppModule[] = [];
  for (const [dir, path] of modules) {
    const script = await readScript(project, join(root, dir), BUILD_SCRIPTS);
    const built = await builtVariants(project, join(root, dir));
    if (!built.length && !(script && appliesApplication(script))) continue;
    apps.push(appModule(path, dir, script ?? '', built));
  }
  // The usual names first, so the default is the one a developer means.
  const names = [/rootProject\.name\s*=\s*["']([^"']+)["']/.exec(settings)?.[1], project.name].filter(Boolean).map(item => item!.toLowerCase());
  const rank = (app: AppModule): number => (app.path === ':app' ? 0 : names.includes(app.path.slice(1).toLowerCase()) ? 1 : /app/i.test(app.path) ? 2 : 3);
  apps.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const wrapper = await project.exists(join(root, 'gradlew'));
  const handler = await ownerOf(project, root);
  if (!handler) return { root, wrapper, apps };
  // A failing handler keeps the apps found here.
  return { root, wrapper, handler, apps: handler.apps ? await handler.apps(project, root, apps).catch(() => apps) : apps };
}

/** The application plugin applied here, not only declared for subprojects (`apply false`) or asked about (`hasPlugin`). */
const appliesApplication = (script: string): boolean => script.split('\n').some(line => APPLICATION.test(line) && !/\bapply\s*\(?\s*false/.test(line));

/** Module directories one level down, or two under a directory of modules, that hold built APKs. */
async function builtModuleDirs(project: ProjectContext, root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await project.list(root)) {
    if (entry.startsWith('.') || SKIP.has(entry) || entry.includes('.')) continue;
    if (await project.exists(join(root, entry, 'build/outputs/apk'))) found.push(entry);
    else if (MODULE_CONTAINERS.has(entry)) {
      for (const inner of await project.list(join(root, entry))) {
        if (!inner.startsWith('.') && !inner.includes('.') && await project.exists(join(root, entry, inner, 'build/outputs/apk'))) found.push(join(entry, inner));
      }
    }
    if (found.length >= 32) break;
  }
  return found;
}

/** The variants a module has built, from `build/outputs/apk/<flavor>/<type>/output-metadata.json`: exact names and ids. */
async function builtVariants(project: ProjectContext, moduleDir: string): Promise<Variant[]> {
  const apk = join(moduleDir, 'build/outputs/apk');
  const dirs: string[] = [];
  for (const entry of await project.list(apk)) {
    if (await project.exists(join(apk, entry, 'output-metadata.json'))) dirs.push(entry);
    else for (const inner of await project.list(join(apk, entry))) if (await project.exists(join(apk, entry, inner, 'output-metadata.json'))) dirs.push(join(entry, inner));
    if (dirs.length >= 32) break;
  }
  const variants: Variant[] = [];
  for (const outputDir of dirs) {
    const text = await project.readText(join(apk, outputDir, 'output-metadata.json'), 64 * 1024).catch(() => undefined);
    const name = text ? /"variantName"\s*:\s*"([A-Za-z0-9]+)"/.exec(text)?.[1] : undefined;
    if (!name) continue;
    const applicationId = /"applicationId"\s*:\s*"([^"]+)"/.exec(text!)?.[1];
    variants.push({ name, buildType: outputDir.split('/').pop()!, outputDir, ...(applicationId && PACKAGE.test(applicationId) ? { applicationId } : {}) });
  }
  return variants;
}

/** `include(":a", ":b:c")`, `include ':a', ':b'`, with `project(":a").projectDir = file("x")` overrides. */
export function includedModules(settings: string): Array<[path: string, dir: string]> {
  const dirs = new Map<string, string>();
  for (const match of settings.matchAll(/project\(\s*["'](:[^"']+)["']\s*\)\.projectDir\s*=\s*(?:file\(\s*)?(?:new\s+File\([^,]+,\s*)?["']([^"']+)["']/g)) {
    dirs.set(normalizePath(match[1]!), match[2]!.replace(/^\.\//, '').replace(/\/$/, ''));
  }
  const found = new Map<string, string>();
  for (const call of settings.matchAll(/\binclude\b\s*\(?([^)\n]*)/g)) {
    for (const quoted of call[1]!.matchAll(/["']([^"']+)["']/g)) {
      const path = normalizePath(quoted[1]!);
      if (!MODULE_PATH.test(path) || found.has(path)) continue;
      const dir = dirs.get(path) ?? path.slice(1).replaceAll(':', '/');
      if (dir.split('/').includes('..') || dir.startsWith('/')) continue;
      found.set(path, dir);
    }
  }
  return [...found];
}

const normalizePath = (path: string): string => (path.startsWith(':') ? path : `:${path}`);

function appModule(path: string, dir: string, script: string, built: Variant[]): AppModule {
  const android = block(script, 'android') ?? script;
  const defaultConfig = block(android, 'defaultConfig') ?? '';
  const applicationId = stringValue(defaultConfig, 'applicationId') ?? stringValue(android, 'namespace');
  const buildTypes = childBlocks(block(android, 'buildTypes') ?? '');
  for (const name of ['release', 'debug']) if (!buildTypes.some(item => item.name === name)) buildTypes.unshift({ name, body: '' });
  const flavors = childBlocks(block(android, 'productFlavors') ?? '').map(item => ({ ...item, dimension: stringValue(item.body, 'dimension') }));
  const dimensions = quotedList(android, 'flavorDimensions');

  // Flavours combine one per dimension, in the order the dimensions are declared.
  let combos: Array<typeof flavors> = [[]];
  const groups = dimensions.length > 1 ? dimensions.map(name => flavors.filter(flavor => flavor.dimension === name)) : [flavors];
  for (const group of groups) if (group.length) combos = combos.flatMap(combo => group.map(flavor => [...combo, flavor]));

  const declared: Variant[] = [];
  for (const combo of combos) {
    const flavorName = combo.map((flavor, index) => (index ? capitalize(flavor.name) : flavor.name)).join('');
    for (const type of buildTypes) {
      const base = combo.reduce<string | undefined>((id, flavor) => stringValue(flavor.body, 'applicationId') ?? id, applicationId);
      const suffix = [...combo.map(flavor => stringValue(flavor.body, 'applicationIdSuffix') ?? ''), stringValue(type.body, 'applicationIdSuffix') ?? ''].join('');
      const id = base ? base + suffix : undefined;
      declared.push({
        name: flavorName ? flavorName + capitalize(type.name) : type.name,
        buildType: type.name,
        outputDir: flavorName ? `${flavorName}/${type.name}` : type.name,
        ...(id && PACKAGE.test(id) ? { applicationId: id } : {}),
      });
    }
  }
  // What was built is exact; a build that has flavours the script does not show makes the
  // unflavoured guesses wrong, so they are dropped.
  const flavoured = built.some(variant => variant.name !== variant.buildType);
  const variants = [...built, ...declared.filter(variant => !built.some(item => item.name === variant.name) && !(flavoured && !flavors.length))];
  // Debug variants first: they are what is built and run day to day.
  variants.sort((a, b) => Number(b.buildType === 'debug') - Number(a.buildType === 'debug'));
  const fallbackId = applicationId && PACKAGE.test(applicationId) ? applicationId : built.find(variant => variant.applicationId)?.applicationId;
  return { path, dir, variants, ...(fallbackId ? { applicationId: fallbackId } : {}) };
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}

/** The body of the first `name { ... }` block, matching braces. */
export function block(text: string, name: string): string | undefined {
  const start = new RegExp(`(?:^|[^A-Za-z0-9_.])${name}\\s*\\{`, 'm').exec(text);
  if (!start) return undefined;
  const open = start.index + start[0].length;
  let depth = 1;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(open, index);
  }
  return undefined;
}

/** The named blocks directly inside a container: `debug {`, `create("cn") {`, `getByName("release") {`. */
export function childBlocks(body: string): Array<{ name: string; body: string }> {
  const result: Array<{ name: string; body: string }> = [];
  let depth = 0;
  let after = 0;
  let open = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '{') {
      if (depth === 0) open = index;
      depth++;
    } else if (char === '}' && depth > 0 && --depth === 0) {
      // Only the last statement before `{` names the block.
      const header = body.slice(after, open).split(/[\n;]/).map(line => line.trim()).filter(Boolean).pop() ?? '';
      const name = blockName(header);
      if (name) result.push({ name, body: body.slice(open + 1, index) });
      after = index + 1;
    }
  }
  return result;
}

function blockName(header: string): string | undefined {
  const text = header.trim();
  const call = /(?:create|register|getByName|maybeCreate|named)\s*\(\s*["']([A-Za-z][A-Za-z0-9_]*)["']\s*\)$/.exec(text);
  const name = call?.[1] ?? /^([A-Za-z][A-Za-z0-9_]*)$/.exec(text)?.[1];
  return name && IDENTIFIER.test(name) && !['all', 'configureEach', 'withType', 'forEach'].includes(name) ? name : undefined;
}

/** `name = "value"`, `name "value"`, `name.set("value")`. */
function stringValue(text: string, name: string): string | undefined {
  return new RegExp(`(?:^|[^A-Za-z0-9_.])${name}\\s*(?:=|\\.set\\(|\\(|\\s)\\s*["']([^"'$]+)["']`, 'm').exec(text)?.[1];
}

/** Every string literal on the lines that set `name`: `flavorDimensions += listOf("a", "b")`. */
function quotedList(text: string, name: string): string[] {
  const values: string[] = [];
  for (const line of text.matchAll(new RegExp(`(?:^|[^A-Za-z0-9_.])${name}\\b[^\\n]*`, 'gm'))) {
    for (const quoted of line[0].matchAll(/["']([A-Za-z][A-Za-z0-9_]*)["']/g)) values.push(quoted[1]!);
  }
  return values;
}

/** The Gradle task of `verb` for one module and variant: `:app:assembleDebug`. */
export function moduleTask(app: AppModule, verb: string, variant: Variant): string {
  return `${app.path === ':' ? '' : app.path}:${verb}${capitalize(variant.name)}`;
}

export { capitalize, join };
