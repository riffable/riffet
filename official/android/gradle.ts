import type { PluginHost, ProjectContext, TaskActionSpec, TaskParamField, TaskParams, TaskPlan, TaskProvider } from '@riffet/plugin-api';
import { parseAndroidLog } from './diagnostics.js';
import { readyDevices } from './devices.js';
import { capitalize, gradleBuilds, join, moduleTask, type AppModule, type GradleBuild, type Variant } from './project.js';
import { CRASHES, INSTALL_AND_RUN, LOGCAT, SCREENSHOT, UNIT_TEST, scriptFile } from './scripts.js';
import { readerOf, registered, type Choice, type WorkspaceTarget } from './workspaces.js';

export const GRADLE_PROVIDER = 'riffet.android/gradle';
export const LOGCAT_PROVIDER = 'riffet.android/logcat';

// Two providers so that a log followed in its own view never holds the build's buttons: the host's
// view of a provider waits while one of its tasks runs. Every Gradle task shares one lock per
// project, since two builds share the build directory and the daemon.

export type ActionId = 'assemble' | 'installRun' | 'unitTest' | 'lint' | 'clean' | 'crashes' | 'screenshot' | 'logcat';

type LocalizedText = TaskActionSpec['title'];

// How the host draws an action. The vendored SDK predates these fields, which the host reads from
// each action and ignores where it does not know them.
type LogRule = { pattern: string; flags?: 'i'; tone: 'muted' | 'error' | 'warning' | 'success' | 'accent'; fold?: boolean };
export type ActionSpec = TaskActionSpec & {
  group?: LocalizedText;
  primary?: boolean;
  icon?: 'run' | 'build' | 'test' | 'inspect' | 'clean' | 'crash' | 'screenshot' | 'sync' | 'log';
  confirm?: LocalizedText;
  log?: { rules: LogRule[]; records?: LogRecords };
};
type LogRecords = { pattern: string; levels?: Array<{ value: string; tone?: LogRule['tone'] }>; columns?: string[] };

const CHECKS: LocalizedText = { 'zh-Hans': 'Verify', en: 'Verify' };
const DEVICE: LocalizedText = { 'zh-Hans': 'Device', en: 'Device' };
const PROJECT: LocalizedText = { 'zh-Hans': 'Project', en: 'Project' };

const rule = (pattern: string, tone: LogRule['tone'], fold?: boolean): LogRule => ({ pattern, tone, ...(fold ? { fold } : {}) });
const SCRIPT_NOTE = rule(String.raw`^riffet-android `, 'muted', true);
// The first rule that matches a line wins, so a failed task is an error before it is a task line.
export const GRADLE_LOG: { rules: LogRule[] } = { rules: [
  rule(String.raw`^> Task \S+ (UP-TO-DATE|NO-SOURCE|SKIPPED|FROM-CACHE)$`, 'muted', true),
  rule(String.raw`^(e: |ERROR: )|: error: |FAILED$|^FAILURE:|^BUILD FAILED`, 'error'),
  rule(String.raw`^> Task `, 'muted'),
  rule(String.raw`^w: |: warning: `, 'warning'),
  rule(String.raw`^BUILD SUCCESSFUL`, 'success'),
  SCRIPT_NOTE,
] };
/**
 * `threadtime`: `MM-DD HH:MM:SS.mmm  PID  TID L Tag: message`, as records the host draws in
 * columns and filters as Android Studio's Logcat does (`tag:`, `level:W`, `-tag:`, `message~:`).
 * The rules colour the lines that are not records, such as the follower's `--- package (pid) ---` marks.
 */
const LOGCAT_LOG: { rules: LogRule[]; records: LogRecords } = {
  // A host without records colours whole lines by these instead.
  rules: [
    rule(String.raw`^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+\d+\s+\d+ [FEA] `, 'error'),
    rule(String.raw`^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+\d+\s+\d+ W `, 'warning'),
    rule(String.raw`^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+\d+\s+\d+ [DV] `, 'muted'),
    rule(String.raw`^--- `, 'accent'),
    SCRIPT_NOTE,
  ],
  records: {
    pattern: String.raw`^\d\d-\d\d (?<time>\d\d:\d\d:\d\d\.\d+)\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<level>[VDIWEFA])\s+(?<tag>.*?)\s*: (?<message>.*)$`,
    levels: [
      { value: 'V', tone: 'muted' }, { value: 'D', tone: 'accent' }, { value: 'I', tone: 'success' },
      { value: 'W', tone: 'warning' }, { value: 'E', tone: 'error' }, { value: 'F', tone: 'error' }, { value: 'A', tone: 'error' },
    ],
    columns: ['time', 'pid', 'tid', 'tag'],
  },
};
const PRESENTATION: Record<ActionId, Pick<ActionSpec, 'group' | 'primary' | 'icon' | 'log'>> = {
  installRun: { primary: true, icon: 'run', log: GRADLE_LOG },
  assemble: { icon: 'build', log: GRADLE_LOG },
  unitTest: { group: CHECKS, icon: 'test', log: GRADLE_LOG },
  lint: { group: CHECKS, icon: 'inspect', log: GRADLE_LOG },
  crashes: { group: DEVICE, icon: 'crash', log: LOGCAT_LOG },
  screenshot: { group: DEVICE, icon: 'screenshot' },
  clean: { group: PROJECT, icon: 'clean', log: GRADLE_LOG },
  logcat: { primary: true, icon: 'log', log: LOGCAT_LOG },
};

/** Engineering terms, the same in every language: they are what the build tools and Android Studio call them. */
const term = (text: string): LocalizedText => ({ 'zh-Hans': text, en: text });

const TITLES: Record<ActionId, LocalizedText> = {
  // Run builds, installs and launches the app on a device, as Android Studio's Run does; Build APK only packages it.
  installRun: term('Run'),
  assemble: term('Build APK'),
  unitTest: term('Unit Tests'),
  lint: term('Lint'),
  clean: term('Clean'),
  crashes: term('Crashes'),
  screenshot: term('Screenshot'),
  logcat: term('Logcat'),
};

/** Which choices an action takes; a choice with one option is left out and its value is the default. */
const USES: Record<ActionId, readonly Choice[]> = {
  assemble: ['root', 'module', 'variant'],
  installRun: ['root', 'module', 'variant', 'device'],
  unitTest: ['root', 'variant'],
  lint: ['root', 'module', 'variant'],
  clean: ['root'],
  crashes: ['root', 'module', 'variant', 'device'],
  screenshot: ['root', 'device'],
  logcat: ['root', 'module', 'variant', 'device'],
};

const ACTIONS: Record<string, readonly ActionId[]> = {
  [GRADLE_PROVIDER]: ['installRun', 'assemble', 'unitTest', 'lint', 'crashes', 'screenshot', 'clean'],
  [LOGCAT_PROVIDER]: ['logcat'],
};

const LABELS: Record<Choice, TaskParamField['label']> = {
  root: { 'zh-Hans': 'Gradle Build', en: 'Gradle Build' },
  module: { 'zh-Hans': 'App Module', en: 'App Module' },
  variant: { 'zh-Hans': 'Build Variant', en: 'Build Variant' },
  device: { 'zh-Hans': 'Device', en: 'Device' },
};

/** A Gradle project with an Android application, at the root or one or two directories down. */
async function detect(project: ProjectContext): Promise<boolean> {
  return (await gradleBuilds(project)).length > 0;
}

async function choices(host: PluginHost, project: ProjectContext): Promise<Record<Choice, string[]>> {
  const builds = await gradleBuilds(project);
  const app = builds[0]?.apps[0];
  return {
    root: builds.map(build => build.root || '.'),
    module: builds[0]?.apps.map(item => item.path) ?? [],
    variant: app?.variants.map(variant => variant.name) ?? [],
    device: await readyDevices(host),
  };
}

function field(key: Choice, options: string[]): TaskParamField | undefined {
  return options.length > 1 ? { key, label: LABELS[key], kind: 'choice', options, default: options[0]! } : undefined;
}

export interface Target { build: GradleBuild; app: AppModule; variant: Variant; project: ProjectContext; gradle: string; device?: string; env: Record<string, string> }

async function target(host: PluginHost, params: TaskParams, project: ProjectContext): Promise<Target> {
  const builds = await gradleBuilds(project);
  const build = builds.find(item => (item.root || '.') === params.root) ?? builds[0];
  const app = build?.apps.find(item => item.path === params.module) ?? build?.apps[0];
  const variant = app?.variants.find(item => item.name === params.variant) ?? app?.variants[0];
  if (!build || !app || !variant) throw host.error('ANDROID_PROJECT_UNREADABLE', 'No Android application module was found in this project', 409);
  // adb and the Android Gradle plugin's install both honour ANDROID_SERIAL.
  // With one device ready, name it anyway: an offline or unauthorised one next to it makes adb ask which.
  const ready = typeof params.device === 'string' ? undefined : await readyDevices(host);
  const device = typeof params.device === 'string' ? params.device : ready?.length === 1 ? ready[0] : undefined;
  return { build, app, variant, project, gradle: build.wrapper ? './gradlew' : 'gradle', ...(device ? { device } : {}), env: device ? { ANDROID_SERIAL: device } : {} };
}

const packageOf = (target: Target): string => target.variant.applicationId ?? target.app.applicationId ?? '';

async function plan(host: PluginHost, action: ActionId, target: Target, params: TaskParams): Promise<TaskPlan> {
  const { build, app, variant, gradle, env } = target;
  const cwd = build.root ? { cwd: build.root } : {};
  const moduleDir = join(build.root, app.dir);
  const script = async (text: string, ...args: string[]): Promise<Pick<TaskPlan, 'file' | 'args'>> => ({ file: 'sh', args: [await scriptFile(host, text), ...args] });
  const own = await build.handler?.plan?.(action, workspaceTarget(host, target, params));
  if (own) return own;
  switch (action) {
    case 'assemble':
      return { file: gradle, args: [moduleTask(app, 'assemble', variant), '--console=plain'], ...cwd, lock: 'gradle', artifacts: [join(moduleDir, 'build/outputs/apk', variant.outputDir, '*.apk')] };
    case 'installRun':
      return { ...await script(INSTALL_AND_RUN, gradle, moduleTask(app, 'install', variant), join(app.dir, 'build/outputs/apk', variant.outputDir, 'output-metadata.json'), packageOf(target)), ...cwd, env, lock: 'gradle' };
    case 'unitTest':
      // Unqualified, so every module that has the variant runs its tests.
      return { ...await script(UNIT_TEST, gradle, `test${capitalize(variant.name)}UnitTest`), ...cwd, lock: 'gradle' };
    case 'lint':
      return { file: gradle, args: [moduleTask(app, 'lint', variant), '--console=plain'], ...cwd, lock: 'gradle', artifacts: [join(moduleDir, 'build/reports/lint-results-*.html')] };
    case 'clean':
      return { file: gradle, args: ['clean', '--console=plain'], ...cwd, lock: 'gradle' };
    case 'crashes':
      return { ...await script(CRASHES, packageOf(target)), ...cwd, env };
    case 'screenshot':
      return { ...await script(SCREENSHOT), ...cwd, env, artifacts: [join(build.root, 'build/riffet/screen-*.png')] };
    case 'logcat': {
      const pkg = packageOf(target);
      if (!pkg) throw host.error('ANDROID_PACKAGE_UNKNOWN', `The application id of ${app.path} is not in its build script; build it once so it can be read from the output`, 409);
      return { ...await script(LOGCAT, pkg), ...cwd, env, lock: 'logcat' };
    }
  }
}

const workspaceTarget = (host: PluginHost, target: Target, params: TaskParams): WorkspaceTarget => ({
  project: target.project, root: target.build.root, app: target.app, variant: target.variant, gradle: target.gradle,
  ...(target.device ? { device: target.device } : {}), env: target.env, params,
  script: async (text, ...args) => ({ file: 'sh', args: [await scriptFile(host, text), ...args] }),
});

function provider(host: PluginHost, id: string): TaskProvider {
  const offered = ACTIONS[id]!;
  return {
    id,
    detect,
    async actions(project) {
      const [builds, options] = await Promise.all([gradleBuilds(project), choices(host, project)]);
      // An action a handler removes is left out when every build is owned by a handler that removes it.
      const available = (action: ActionId): boolean => builds.length === 0 || builds.some(build => !build.handler?.removes?.includes(action));
      const listed = offered.filter(available).map((action): ActionSpec => {
        const params = USES[action].map(key => field(key, options[key])).filter((item): item is TaskParamField => Boolean(item));
        return { id: action, title: TITLES[action], ...PRESENTATION[action], ...(params.length ? { params } : {}) };
      });
      if (id !== GRADLE_PROVIDER) return listed;
      const extra: ActionSpec[] = [];
      for (const handler of new Set(builds.flatMap(build => build.handler ?? []))) {
        const owned = builds.filter(build => build.handler === handler).map(build => ({ root: build.root, apps: build.apps }));
        // A handler that fails to list its actions adds none; the others still show.
        extra.push(...(await Promise.resolve(handler.actions?.({ project, builds: owned, field: key => field(key, options[key]) })).catch(() => undefined) ?? []) as ActionSpec[]);
      }
      return [...listed, ...extra];
    },
    async plan(actionId, params, project) {
      const extras = id === GRADLE_PROVIDER ? registered().flatMap(handler => handler.extra ?? []) : [];
      if (!offered.includes(actionId as ActionId) && !extras.includes(actionId)) throw new Error(`Unknown action ${actionId}`);
      const found = await target(host, params, project);
      const owner = found.build.handler;
      if (owner ? owner.removes?.includes(actionId) || (extras.includes(actionId) && !owner.extra?.includes(actionId)) : extras.includes(actionId)) {
        throw host.error('ANDROID_ACTION_UNAVAILABLE', 'This action is not available for this build', 409);
      }
      const planned = await plan(host, actionId as ActionId, found, params);
      if (!planned) throw new Error(`Unknown action ${actionId}`);
      return planned;
    },
    diagnostics: readerOf(parseAndroidLog),
  };
}

export const gradleProvider = (host: PluginHost): TaskProvider => provider(host, GRADLE_PROVIDER);
export const logcatProvider = (host: PluginHost): TaskProvider => provider(host, LOGCAT_PROVIDER);
