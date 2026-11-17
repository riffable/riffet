import { posix } from 'node:path';
import type { PluginHost, ProjectContext, TaskProvider } from '@riffet/plugin-api';
import { parseAndroidLog } from './diagnostics.js';
import { GRADLE_LOG, type ActionSpec } from './gradle.js';
import { gradleBuilds } from './project.js';
import { scriptFile } from './scripts.js';
import { ownerOf, readerOf } from './workspaces.js';

export const CONFIGS_PROVIDER = 'riffet.android/configs';

// The project's Android Studio run configurations (`.run/*.run.xml`, `.idea/runConfigurations/*.xml`, `.idea/workspace.xml`)
// as actions, grouped by their folder as Studio shows them. Shell Script and Gradle configurations are
// run as Studio runs them; other kinds need the IDE's module model and are left out.

type LocalizedText = Record<string, string>;
const term = (text: string): LocalizedText => ({ 'zh-Hans': text, en: text });
const OTHER = term('Other');
const MAX_FILE = 1024 * 1024;
const MAX_CONFIGS = 50;
const CACHE_MS = 10_000;
const DIRS = ['.run', '.idea/runConfigurations'];
const INTERPRETERS = new Set(['bash', 'zsh', 'sh']);

export interface RunConfiguration {
  id: string;
  name: string;
  folder?: string;
  /** Project-relative working directory, `''` for the root. */
  cwd: string;
  command: string[];
  /** Inline script text, run as a file by the interpreter in `command[0]`. */
  text?: string;
  env: Record<string, string>;
}

const unescape = (value: string): string => value
  .replace(/&#10;/g, '\n').replace(/&#13;/g, '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const attribute = (tag: string, name: string): string | undefined => {
  const value = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? undefined : unescape(value);
};

/** Shell words: quotes and backslashes as a shell reads them, no expansion. */
export function words(text: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && index + 1 < text.length) current += text[++index];
      else current += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === '\\' && index + 1 < text.length) { current += text[++index]; started = true; }
    else if (/\s/.test(char)) { if (started) result.push(current); current = ''; started = false; }
    else { current += char; started = true; }
  }
  if (started) result.push(current);
  return result;
}

/** `$PROJECT_DIR$` and paths under it as seen from `cwd`; `undefined` for a value with another IDE macro. */
function localize(value: string, cwd: string): string | undefined {
  const replaced = value.replace(/\$PROJECT_DIR\$(\/[^\s"']*)?/g, (_, rest: string | undefined) => {
    const target = rest ? rest.slice(1) : '';
    const relative = posix.relative(cwd || '.', target || '.') || '.';
    return relative.startsWith('.') ? relative : `./${relative}`;
  });
  return /\$[A-Z_]+\$/.test(replaced) ? undefined : replaced;
}

/** A project-relative directory from a configuration's working directory; `undefined` outside the project. */
function directory(value: string | undefined): string | undefined {
  if (!value || value === '$PROJECT_DIR$') return '';
  if (!value.startsWith('$PROJECT_DIR$/')) return undefined;
  const dir = posix.normalize(value.slice('$PROJECT_DIR$/'.length)).replace(/\/$/, '');
  return dir === '.' ? '' : dir.startsWith('..') ? undefined : dir;
}

function options(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of body.matchAll(/<option\b[^>]*\/?>/g)) {
    const name = attribute(match[0], 'name');
    const value = attribute(match[0], 'value');
    if (name && value !== undefined && !map.has(name)) map.set(name, value);
  }
  return map;
}

function envs(body: string): Record<string, string> {
  const env: Record<string, string> = {};
  const block = /<envs>([\s\S]*?)<\/envs>/.exec(body)?.[1] ?? '';
  for (const match of block.matchAll(/<env\b[^>]*\/?>/g)) {
    const name = attribute(match[0], 'name');
    const value = attribute(match[0], 'value');
    if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value !== undefined) env[name] = value;
  }
  return env;
}

/** The configurations of one file that can run outside the IDE. */
export function parseConfigurations(xml: string): Array<Omit<RunConfiguration, 'id'>> {
  const found: Array<Omit<RunConfiguration, 'id'>> = [];
  // A self-closing `<configuration … />` has no body, and must not run on into the next one.
  for (const match of xml.matchAll(/<configuration\b([^>]*?)(?:\/>|>([\s\S]*?)<\/configuration>)/g)) {
    const head = match[1]!;
    const body = match[2] ?? '';
    const name = attribute(head, 'name');
    const type = attribute(head, 'type');
    if (!name || attribute(head, 'default') === 'true') continue;
    const folder = attribute(head, 'folderName');
    const option = options(body);
    const env = envs(body);
    if (type === 'ShConfigurationType') {
      const cwd = directory(option.get('SCRIPT_WORKING_DIRECTORY'));
      const interpreter = posix.basename(option.get('INTERPRETER_PATH') || '/bin/bash');
      if (cwd === undefined || !INTERPRETERS.has(interpreter)) continue;
      const interpreterOptions = words(option.get('INTERPRETER_OPTIONS') ?? '');
      const scriptOptions = words(option.get('SCRIPT_OPTIONS') ?? '').map(word => localize(word, cwd));
      if (scriptOptions.some(word => word === undefined)) continue;
      if (option.get('EXECUTE_SCRIPT_FILE') === 'false') {
        const text = option.get('SCRIPT_TEXT') ?? '';
        if (!text.trim()) continue;
        found.push({ name, ...(folder ? { folder } : {}), cwd, command: [interpreter, ...interpreterOptions], text, env });
        continue;
      }
      const script = localize(option.get('SCRIPT_PATH') ?? '', cwd);
      if (!script) continue;
      found.push({ name, ...(folder ? { folder } : {}), cwd, command: [interpreter, ...interpreterOptions, script, ...scriptOptions as string[]], env });
    } else if (type === 'GradleRunConfiguration') {
      const settings = /<ExternalSystemSettings>([\s\S]*?)<\/ExternalSystemSettings>/.exec(body)?.[1] ?? '';
      const setting = options(settings);
      const cwd = directory(setting.get('externalProjectPath'));
      const tasks = [...(/<option name="taskNames">([\s\S]*?)<\/option>/.exec(settings)?.[1] ?? '').matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map(item => unescape(item[1]!));
      const parameters = words(setting.get('scriptParameters') ?? '').map(word => localize(word, cwd ?? ''));
      if (cwd === undefined || !tasks.length || parameters.some(word => word === undefined)) continue;
      found.push({ name, ...(folder ? { folder } : {}), cwd, command: ['./gradlew', ...tasks, ...parameters as string[], '--console=plain'], env: { ...env, ...envs(settings) } });
    }
  }
  return found;
}

const cache = new Map<string, { at: number; value: Promise<RunConfiguration[]> }>();

export function runConfigurations(project: ProjectContext): Promise<RunConfiguration[]> {
  const hit = cache.get(project.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = read(project).catch(() => []);
  cache.set(project.id, { at: Date.now(), value });
  return value;
}

async function read(project: ProjectContext): Promise<RunConfiguration[]> {
  const configs: RunConfiguration[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  // Shared files first, then the ones only this checkout's Studio keeps (`workspace.xml`).
  const files: string[] = [];
  for (const dir of DIRS) for (const file of (await project.list(dir)).filter(name => name.endsWith('.xml')).sort()) files.push(`${dir}/${file}`);
  files.push('.idea/workspace.xml');
  {
    for (const file of files) {
      const xml = await project.readText(file, MAX_FILE);
      if (!xml) continue;
      for (const config of parseConfigurations(xml)) {
        // The same configuration may be both shared and stored in the IDE directory.
        if (names.has(config.name)) continue;
        names.add(config.name);
        const base = config.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 56) || 'config';
        let id = base;
        for (let index = 2; ids.has(id); index++) id = `${base}-${index}`;
        ids.add(id);
        configs.push({ id, ...config });
      }
    }
  }
  // Studio's folders, the Android ones first; loose configurations last.
  const rank = (config: RunConfiguration): number => (!config.folder ? 2 : /android/i.test(config.folder) ? 0 : 1);
  const folders = [...new Set(configs.map(config => config.folder ?? ''))];
  configs.sort((a, b) => rank(a) - rank(b) || folders.indexOf(a.folder ?? '') - folders.indexOf(b.folder ?? '') || a.name.localeCompare(b.name));
  return configs.slice(0, MAX_CONFIGS);
}

const icon = (name: string): ActionSpec['icon'] => (/clean|del(ete)?workspace/i.test(name) ? 'clean' : /test/i.test(name) ? 'test' : /lint/i.test(name) ? 'inspect' : 'run');

export function configsProvider(host: PluginHost): TaskProvider {
  return {
    id: CONFIGS_PROVIDER,
    async detect(project) {
      return (await runConfigurations(project)).length > 0;
    },
    async actions(project) {
      return (await runConfigurations(project)).map((config): ActionSpec => ({
        id: config.id, title: term(config.name), group: config.folder ? term(config.folder) : OTHER, icon: icon(config.name), log: GRADLE_LOG,
      }));
    },
    async plan(actionId, _params, project) {
      const config = (await runConfigurations(project)).find(item => item.id === actionId);
      if (!config) throw host.error('ANDROID_CONFIGURATION_UNKNOWN', `No run configuration ${actionId} in this project`, 409);
      const command = config.text ? [...config.command, await scriptFile(host, config.text)] : config.command;
      // A handler may wrap the command, as a remote build maps its paths back to the project.
      const roots = ['', ...(await gradleBuilds(project)).map(build => build.root)];
      let owner;
      for (const root of roots) if ((owner = await ownerOf(project, root))) break;
      const run = owner?.wrap ? await owner.wrap(command[0]!, command.slice(1), text => scriptFile(host, text)) : { file: command[0]!, args: command.slice(1) };
      return {
        ...run,
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(Object.keys(config.env).length ? { env: config.env } : {}),
        // Studio's configurations here build: one at a time with the other builds of the project.
        lock: 'gradle',
      };
    },
    diagnostics: readerOf(parseAndroidLog),
  };
}
