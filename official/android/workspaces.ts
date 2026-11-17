import type { DiagnosticsContext, PluginService, ProjectContext, TaskActionSpec, TaskDiagnostic, TaskParamField, TaskParams, TaskPlan } from '@riffet/plugin-api';
import { forgetBuilds, type AppModule, type Variant } from './project.js';

// The `workspaces` service: another trusted plugin takes over how a kind of workspace builds, for
// instance one whose builds run on a remote system. The first registered handler whose `detect`
// holds for a Gradle build owns it; without handlers every build is planned as this plugin does.

export type Choice = 'root' | 'module' | 'variant' | 'device';
export type DiagnosticsParser = (log: string, context: DiagnosticsContext) => TaskDiagnostic[] | Promise<TaskDiagnostic[]>;
type ActionSpec = TaskActionSpec & Record<string, unknown>;

/** A Gradle build the handler owns, with the apps offered for it. */
export interface WorkspaceBuild { root: string; apps: AppModule[] }

/** The target of an action, as this plugin resolves it from the request. */
export interface WorkspaceTarget {
  project: ProjectContext;
  /** Project-relative, `''` for the project itself. */
  root: string;
  app: AppModule;
  variant: Variant;
  /** `./gradlew` or `gradle`. */
  gradle: string;
  device?: string;
  /** `ANDROID_SERIAL` of the chosen device. */
  env: Record<string, string>;
  /** `sh <script file> <args>` for a script of the handler, run in the Gradle root. */
  script(text: string, ...args: string[]): Promise<Pick<TaskPlan, 'file' | 'args'>>;
  params: TaskParams;
}

export interface WorkspaceActionsContext {
  project: ProjectContext;
  /** The builds of the project this handler owns. */
  builds: readonly WorkspaceBuild[];
  /** The parameter field of a choice (`root`, `module`, `variant`, `device`), or `undefined` when it has a single option. */
  field(choice: Choice): TaskParamField | undefined;
}

export interface WorkspaceHandler {
  id: string;
  /** Marker files only: it runs for every Gradle build and is read again every few seconds. */
  detect(project: ProjectContext, root: string): Promise<boolean>;
  /** The apps and variants to offer for an owned build instead of `found`. */
  apps?(project: ProjectContext, root: string, found: AppModule[]): Promise<AppModule[]>;
  /** Actions of this plugin that an owned build does not offer. */
  removes?: readonly string[];
  /** Ids of the extra actions `actions` may list, so a request for one on another build is refused as unavailable. */
  extra?: readonly string[];
  /** Extra actions of the `riffet.android/gradle` provider, listed once for the project. */
  actions?(context: WorkspaceActionsContext): Promise<ActionSpec[]>;
  /** The plan of an extra action, or of this plugin's own action to plan differently; `undefined` keeps the default plan. */
  plan?(actionId: string, target: WorkspaceTarget): Promise<TaskPlan | undefined>;
  /** Reads a log after, or instead of, `parse`, this plugin's own reader. Applied to every log, so it must leave logs it does not recognise alone. */
  diagnostics?(log: string, context: DiagnosticsContext, parse: DiagnosticsParser): TaskDiagnostic[] | Promise<TaskDiagnostic[]>;
  /** Wraps the command of a run configuration of an owned project. */
  wrap?(file: string, args: string[], script: (text: string) => Promise<string>): Promise<{ file: string; args: string[] }>;
}

export interface WorkspacesService extends PluginService {
  version: '1.0.0';
  register(handler: WorkspaceHandler): () => void;
}

const handlers: WorkspaceHandler[] = [];

export const workspaces: WorkspacesService = {
  version: '1.0.0',
  register(handler) {
    handlers.push(handler);
    forgetBuilds();
    return () => { const index = handlers.indexOf(handler); if (index >= 0) handlers.splice(index, 1); forgetBuilds(); };
  },
};

export const registered = (): readonly WorkspaceHandler[] => handlers;

/** The handler that owns the Gradle build at `root`. */
export async function ownerOf(project: ProjectContext, root: string): Promise<WorkspaceHandler | undefined> {
  for (const handler of [...handlers]) {
    try { if (await handler.detect(project, root)) return handler; } catch { /* a failing handler owns nothing */ }
  }
  return undefined;
}

/** `parse`, read again by each handler that has a reader of its own. */
export function readerOf(parse: DiagnosticsParser): DiagnosticsParser {
  return async (log, context) => {
    let read = parse;
    for (const handler of [...handlers]) {
      if (!handler.diagnostics) continue;
      const inner = read;
      const own = handler.diagnostics.bind(handler);
      // A handler whose reader fails leaves the log to the readers before it.
      read = async (text, ctx) => { try { return await own(text, ctx, inner); } catch { return inner(text, ctx); } };
    }
    return read(log, context);
  };
}
