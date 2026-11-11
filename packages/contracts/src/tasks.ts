// Project tasks (docs/TASKS.md): a build or other command the server runs for a project, outliving
// any client. The server owns the process, the log and the result; a plugin's task provider only
// recognises projects, describes actions and plans the command.

import type { LocalizedText } from './plugins.js';

/**
 * `cancelling` lasts until the process is seen to exit. `unknown` is a task the server could not
 * follow across a restart: it is never rerun, and its log stays readable.
 */
export type TaskState = 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

/** A value an action takes; the provider declares the fields, the host checks them before planning. */
export type TaskParams = Record<string, string | number | boolean>;

export interface TaskParamField {
  key: string;
  label: LocalizedText;
  kind: 'text' | 'boolean' | 'choice';
  /** The values of a `choice`. */
  options?: string[];
  default?: string | number | boolean;
  required?: boolean;
}

/** The host's glyph for an action; a fixed set so that every client draws it in its own icon style. */
export type TaskActionIcon = 'run' | 'build' | 'test' | 'inspect' | 'clean' | 'crash' | 'screenshot' | 'sync' | 'log';

export type TaskLogTone = 'muted' | 'error' | 'warning' | 'success' | 'accent';

/** How a client draws the lines of a log: the first rule whose `pattern` (a JavaScript regular expression) matches a line wins. */
export interface TaskLogRule {
  pattern: string;
  /** Only `i`. */
  flags?: string;
  tone?: TaskLogTone;
  /** Consecutive folded lines are drawn as one row that opens on demand. */
  fold?: boolean;
}

/**
 * A log whose lines are records, as logcat's are: `pattern`'s named groups are a line's fields, and
 * a line it does not match is drawn as it is. The client shows the fields as columns and filters on
 * them with Android Studio's Logcat query (`tag:Foo -tag:Bar level:W message~:regex`). A `level`
 * group is the severity and a `message` group the text a bare word searches.
 */
export interface TaskLogRecords {
  pattern: string;
  /** Least to most severe; `level:W` keeps W and those after it. */
  levels?: Array<{ value: string; tone?: TaskLogTone }>;
  /** Fields drawn before the level and message, in order. */
  columns?: string[];
}

/** How an action is presented; a client that does not know a field draws the action as a plain button. */
export interface TaskActionPresentation {
  /** The section the action is listed under; actions without one form the first row. */
  group?: LocalizedText;
  /** The provider's main action, drawn prominent. */
  primary?: boolean;
  icon?: TaskActionIcon;
  /** Asked before every start: for an action whose effect the user has to accept each time. */
  confirm?: LocalizedText;
  /** Colours and folds of the action's log, and its fields when its lines are records. */
  log?: { rules: TaskLogRule[]; records?: TaskLogRecords };
}

/** What a task provider offers for one project. */
export interface TaskAction extends TaskActionPresentation {
  providerId: string;
  pluginId: string;
  id: string;
  title: LocalizedText;
  params?: TaskParamField[];
}

export interface TaskDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  /** Project-relative, `/`-separated. */
  file?: string;
  line?: number;
  column?: number;
}

export interface TaskArtifact {
  id: string;
  name: string;
  /** Project-relative, `/`-separated. */
  path: string;
  size: number;
  sha256: string;
}

export interface Task {
  id: string;
  /** The client's idempotency key: the same id with the same request returns this task. */
  requestId: string;
  projectId: string;
  pluginId: string;
  providerId: string;
  /** The plugin's version when the task started; its plan does not change afterwards. */
  providerVersion: string;
  actionId: string;
  /** The action's title when the task started. */
  title: LocalizedText;
  params: TaskParams;
  state: TaskState;
  exitCode?: number;
  /** ISO 8601. */
  startedAt: string;
  endedAt?: string;
  cancelRequestedAt?: string;
  /** Bytes of log written so far. */
  logSize: number;
  diagnostics?: TaskDiagnostic[];
  artifacts?: TaskArtifact[];
  /** Why the state is `unknown`. */
  unknownReason?: string;
  /** Why a finished task has no diagnostics although its provider reads them: the version that started it was no longer active. */
  diagnosticsNote?: string;
}

/** The bytes `[from, to)` of a task's log; `eof` is true once the task ended and `to` is its end. */
export interface TaskLogChunk { from: number; to: number; text: string; eof: boolean }

export interface TaskCreate {
  requestId: string;
  projectId: string;
  providerId: string;
  actionId: string;
  params?: TaskParams;
  /** The `fingerprint` of the plan a 409 `TASK_CONFIRM_REQUIRED` showed, sent back unchanged to approve running it. */
  confirm?: string;
}

/**
 * The `details` of 409 `TASK_CONFIRM_REQUIRED`: a plan from an installed package that has not run before. The client shows it and
 * posts the same request again with `confirm: fingerprint`; the approval is kept until the plugin's version changes, and a plan that
 * differs in file, args, cwd or env asks again.
 */
export interface TaskConfirmation {
  fingerprint: string;
  plan: { file: string; args: string[]; /** Project-relative; `.` is the project root. */ cwd: string; env: Record<string, string> };
}

export interface TasksResponse { tasks: Task[] }

/** The `task` event of `/api/lists/stream`, sent when a task starts, is asked to stop or ends. The client reads the task for the rest. */
export interface TaskEvent { id: string; projectId: string; state: TaskState }

/**
 * `projectTypes` are the types, such as `android`, of the providers that recognise the project: what
 * a view's `when.projectType` is matched against.
 */
export interface TaskActionsResponse { actions: TaskAction[]; projectTypes: string[] }
