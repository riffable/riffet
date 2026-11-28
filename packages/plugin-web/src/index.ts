// What a Worka plugin's web code may use (docs/design/plugin-system.md §4, docs/PLUGIN_ARCHITECTURE.md).
//
// A plugin's client entry (`plugins/<vendor>/<name>/web/**`) imports only this package,
// `@contracts` and npm packages. Everything else comes through `PluginHost`, which the web app
// implements in `apps/web/src/plugins/`: this package holds types and the React glue that reads the
// host from context, and imports nothing from the app. The surface is experimental until the
// official plugins have proven it (§12).
//
// The host is serialization-minded on purpose: results are plain data, there are no store objects
// and no raw `fetch` with the user's credentials, so the same calls can later cross a message
// bridge to an isolated view.

import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ComponentProps, type ComponentType, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import type { AppSettings, AppSettingsUpdate, ModelInfo, Run, Session, SyncLane, TimelinePage, TimelineRow, TurnOutlineV3 } from '@contracts';

// The message bridge of isolated views: protocol types and limits. The client a view bundles is `bridge-client.ts`.
export * from './bridge.js';
export { satisfies as satisfiesHostApi } from './compat.js';
// The base stylesheet the host writes into an isolated view's page.
export { PLUGIN_BASE_STYLE, PLUGIN_BASE_STYLE_VERSION, PLUGIN_FOCUS_SCRIPT } from './base-style.js';

/* ------------------------------------------------------------------ views */

/**
 * What a view is mounted for. The host keys an instance by `serviceId`, `projectId`, `sessionId` and
 * `instanceId`: another session or project is a new instance with new state, so a result that was
 * requested for the old one can never be drawn in the new one. `visible` is the only field that
 * changes within an instance.
 */
export interface ViewContext {
  /** The Riffet service this web page is connected to. */
  readonly serviceId: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  /** The project file a view located at `file` shows, relative to the project root; each file is its own instance. */
  readonly path?: string;
  /** Names this instance of the contribution, such as one canvas per session. */
  readonly instanceId: string;
  /** False while the host keeps the view mounted but out of sight; pause polling and animation then. */
  readonly visible: boolean;
  /** Aborts when the instance is destroyed or replaced. Pass it to every read and drop subscriptions with it. */
  readonly signal: AbortSignal;
}

/** What a session view's own composer takes when the view draws it in place. */
export interface ComposerSlotProps {
  autoFocus?: boolean;
  className?: string;
  /** After a message was handed to the conversation (sent, queued or steered), with its text. */
  onSent?(text: string): void;
}

export interface ViewProps {
  context: ViewContext;
  /**
   * The conversation's own composer, for a session view that lets the user write the next message in
   * place. It is the chat view's: the same draft, sending, steering and queueing. Absent where the
   * conversation takes no messages (archived, unavailable) and in views that are not per session.
   */
  composer?: ComponentType<ComposerSlotProps>;
  /**
   * Draws its children in the page header after the title, for a `main` view: what the page is showing,
   * such as the project it reads, as a quiet chooser. Absent elsewhere and from a host before 2026-11.
   */
  header?: ComponentType<{ children: ReactNode }>;
}

/** One contribution id (`<pluginId>/<name>`, as declared in the manifest) to the component that draws it. */
export interface WebPlugin {
  readonly views: Readonly<Record<string, ComponentType<ViewProps>>>;
  /**
   * The icon of a view where the host draws one beside its title, by name from `PluginIconName`.
   * Read as soon as the plugin is on, so keep the entry small and load the view itself lazily.
   */
  readonly icons?: Readonly<Record<string, PluginIconName>>;
  /** What the plugin's views may reach on the server; anything else is refused by the host. */
  readonly access?: PluginAccess;
}

/**
 * Declared by the entry itself, and enforced by the host on `PluginHost.request` and `PluginHost.settings`.
 * A built-in entry is trusted code, so this is a seatbelt and an inventory of what the plugin touches,
 * not a sandbox.
 */
export interface PluginAccess {
  // Server path prefixes the views may request, each starting with `/api/`, such as `/api/my-plugin/`;
  // `*` is one path segment, as in `/api/sessions/*/trace`.
  readonly requests?: readonly string[];
  /** Keys of `/api/settings` the views may read and write. */
  readonly settings?: readonly string[];
}

/** The client entry of a plugin: `export default defineWebPlugin({ views: { 'vendor.name/view': View } })`. */
export function defineWebPlugin(plugin: WebPlugin): WebPlugin {
  return plugin;
}

/* ------------------------------------------------------------------ host services */

/** A project as a view may read it. */
export interface PluginProject {
  id: string;
  name: string;
  cwd: string;
  worktree?: { branch: string };
  /** Set on a project the app keeps for itself (`quick-chat`, `assistant`, `task-workspace`), not one the user opened. */
  system?: string;
  archivedAt?: string;
}

/** A server whose conversations and projects the app lists: the one this page is served by, and the linked ones. */
export interface PluginServer {
  id: string;
  name: string;
  /** The user's short name for a linked server. */
  alias?: string;
  /** Set on the server this page is served by. */
  self?: true;
  online: boolean;
}

export interface SessionService {
  /** Every conversation the user can see, as the app holds them now. `subscribe` fires when this or `projects()` changes. */
  list(): readonly Session[];
  projects(): readonly PluginProject[];
  /** The servers `projects()` come from, this one first; `subscribe` fires when they change. Hosts without linked servers may omit it. */
  servers?(): readonly PluginServer[];
  /** The linked server a project or conversation lives on; `undefined` for this server's own. */
  serverOf?(objectId: string): string | undefined;
  subscribe(listener: () => void): () => void;
  /** The turns of one lane, in order. Rejects with an `AbortError` when `signal` aborts. */
  outline(sessionId: string, options?: { lane?: SyncLane; signal?: AbortSignal }): Promise<TurnOutlineV3[]>;
  runs(sessionId: string, options?: { signal?: AbortSignal }): Promise<Run[]>;
  /** One page of a lane's rows from position `from`. */
  timeline(sessionId: string, query: { lane: SyncLane; from: number; rows: number; budget: number }, options?: { signal?: AbortSignal }): Promise<TimelinePage>;
  /**
   * Starts a new conversation from a finished run. It is added to the sidebar; nothing is opened.
   * [note] is what the new conversation is asked to do next; without one it only confirms where it stands.
   */
  fork(sessionId: string, runId: string, options?: { note?: string }): Promise<void>;
  /** The agent's name, such as `Claude Code`. */
  backendLabel(session: Session): string;
  /**
   * One sentence on what a finished turn came to, written by the auxiliary model chosen for canvas
   * summaries. Written on the first request and kept, so asking again costs nothing. Undefined when no
   * model is chosen, the turn has not finished or has no answer, or writing failed.
   */
  turnSummary(sessionId: string, turn: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  /** Whether a model is chosen for canvas summaries; `subscribe` fires when this changes. */
  turnSummaries(): boolean;
  /** A URL for an image the conversation's own tool calls named (a screenshot an agent read or viewed). Serves nothing else. */
  mediaUrl(sessionId: string, path: string): string;
  /** A URL for an attachment of a message. */
  attachmentUrl(id: string): string;
  /**
   * Opens a folder as a project, as New Session's "choose another directory" does: the native chooser on the
   * entry server's own screen, else the app's folder browser (on `server`'s disk when one is named, with a
   * choice of server). A folder that is not a project yet becomes one. Resolves to the project's id, or
   * `undefined` when the reader cancels. Added 2026-11: absent from an older host.
   */
  openDirectory?(options?: { server?: string; initialPath?: string }): Promise<string | undefined>;
}

export interface NavigationService {
  /** Reads one turn of a conversation in the transcript, switching conversation first when it is another. */
  openTurn(session: Session, turn?: { runId?: string; nativeId?: string }): void;
  /** Previews a project file in the side panel. */
  openPath(path: string): void;
  openSession(sessionId: string): void;
  /** Opens this plugin's own page in its details (docs/PLUGIN_ARCHITECTURE.md「插件详情」). Absent from an older host. */
  openPluginPage?(): void;
  /**
   * Quotes a project file, or one line of it, into a conversation of that project: the one under the page
   * when it is of that project, else a new conversation's composer. False when the project is unknown.
   * Added 2026-11: absent from an older host.
   */
  quote?(projectId: string, reference: { path: string; line?: number; text?: string }): boolean;
}

export interface NotifyService {
  /** Tells the user, using the error's own message when it has one and `fallback` otherwise. */
  error(error: unknown, fallback: string): void;
  /** What `error` would say, for a plugin that shows it in place. */
  errorText(error: unknown, fallback: string): string;
  success(message: string): void;
}

export interface RequestOptions { signal?: AbortSignal }

/**
 * The server calls a plugin declared in `WebPlugin.access.requests`, made with the user's session, which the
 * plugin never sees. A path outside the declared prefixes rejects. A failed request rejects with an `Error`
 * that carries `status`, `code` and `details` as the server answered; `isUnavailable` reads one kind.
 */
export interface RequestService {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
}

/** The settings keys declared in `WebPlugin.access.settings`, shared with the rest of the app. */
export interface SettingsService {
  /** Only the declared keys. The same object is returned until one of them changes. */
  get(): Readonly<Partial<AppSettings>>;
  subscribe(listener: () => void): () => void;
  /** Saves `patch` (declared keys only) and folds the server's answer into the app's settings; resolves with the declared keys then. */
  update(patch: AppSettingsUpdate): Promise<Readonly<Partial<AppSettings>>>;
}

/** The settings page a view is shown in; every call does nothing for a view shown elsewhere, and both flags reset when the page unmounts. */
export interface SettingsPageService {
  /** Unsaved edits: the dialog asks before leaving the page or closing. */
  setDirty(dirty: boolean): void;
  /** A save is under way: the dialog holds off leaving. */
  setBusy(busy: boolean): void;
}

/** What `isUnavailable` reads from the server's 503 answer for an Agent whose plugin is off. */
export interface UnavailableInfo { backendId?: string; reason?: string }

/** The details of the server's refusal because an Agent's plugin is off (`NATIVE_BACKEND_UNAVAILABLE`, status 503); `undefined` for any other error. */
export function isUnavailable(error: unknown): UnavailableInfo | undefined {
  const failed = error as { status?: unknown; code?: unknown; details?: unknown } | null;
  if (!failed || typeof failed !== 'object' || failed.status !== 503 || failed.code !== 'NATIVE_BACKEND_UNAVAILABLE') return undefined;
  const details = failed.details && typeof failed.details === 'object' ? failed.details as { backendId?: unknown; reason?: unknown } : {};
  return {
    ...(typeof details.backendId === 'string' ? { backendId: details.backendId } : {}),
    ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
  };
}

/** A tool call of a timeline row, as the app's transcript reads it. */
export interface ToolCall {
  id: string;
  /** What the call says it does; for a shell call, the command. */
  title: string;
  /** The provider's category: `read`, `edit`, `execute`, `fetch`, `search`, `delete`, `move`, `question`, `agent`... */
  kind: string;
  status: string;
  command?: string;
  locations: ReadonlyArray<{ path: string; line?: number }>;
  contents: ReadonlyArray<Record<string, unknown>>;
  /** What the call was given, and the tool's name as the CLI reports it. */
  rawInput?: Record<string, unknown>;
  toolName?: string;
  /** Lines an edit, delete or move added and removed. */
  diff?: { added: number; removed: number };
}

export interface DiffLine { type: 'same' | 'add' | 'del' | 'gap'; text: string; oldNo?: number; newNo?: number }

export interface TimelineService {
  /** The tool call a `tool` row stands for, with paths under `root` made relative; `undefined` for a row of another kind. */
  toolCall(row: TimelineRow, sessionId: string, root?: string): ToolCall | undefined;
  /** `path` relative to `root`, as the transcript shows it. */
  relativePath(path: string, root?: string): string;
  /** Aligned lines of an edit with `context` unchanged lines around each hunk; `null` when the texts are too large to diff. */
  lineDiff(before: string, after: string, context: number): { lines: DiffLine[]; added: number; removed: number } | null;
}

/** The icons views may ask for. */
export type PluginIconName =
  | 'arrows-in-line-horizontal' | 'brain' | 'calendar-clock' | 'check' | 'chevron-down' | 'circle' | 'circle-alert' | 'circle-check'
  | 'copy' | 'folder' | 'folder-closed' | 'git-branch' | 'git-commit-horizontal' | 'git-compare' | 'git-fork' | 'globe' | 'graph' | 'info'
  | 'list-checks' | 'maximize' | 'message-circle-question' | 'messages-square' | 'minus' | 'paperclip' | 'pause' | 'play' | 'plus' | 'search'
  | 'sparkle' | 'sparkles' | 'square-arrow-out-up-right' | 'square-terminal' | 'target' | 'wrench' | 'x' | 'arrow-right-left'
  | 'chevron-right' | 'refresh-cw' | 'save' | 'activity' | 'file-code' | 'panel-right'
  | 'list-filter' | 'history' | 'chevrons-down-up' | 'case-sensitive' | 'whole-word' | 'regex'
  | 'arrow-left' | 'arrow-right' | 'panel-left' | 'package' | 'folder-dot' | 'folder-code' | 'folder-kanban' | 'folder-archive' | 'folder-cog' | 'text-quote' | 'server'
  | 'file' | 'file-search' | 'folder-search' | 'folder-open' | 'list-tree' | 'arrow-up-right' | 'link' | 'text-select' | 'pin' | 'minimize'
  | 'rotate-ccw' | 'copy-x' | 'arrow-right-to-line' | 'square-x' | 'chevrons-up-down' | 'hash'
  | 'file-plus' | 'folder-plus' | 'pencil-line' | 'trash-2' | 'undo-2' | 'lock' | 'wrap-text' | 'columns-2';

export type IconComponent = ComponentType<{ className?: string }>;

export interface ButtonProps extends ComponentProps<'button'> {
  /** `accent` is deprecated: it is accepted for older plugins and drawn as `primary`. */
  variant?: 'primary' | 'accent' | 'secondary' | 'ghost' | 'quiet' | 'danger' | 'danger-ghost' | 'link';
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'icon-xs' | 'icon-sm' | 'icon';
  /** In progress: the width is kept, a spinner shows in place and clicks are ignored. */
  busy?: boolean;
}

export interface TipProps {
  label: ReactNode;
  kbd?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
}

export interface MarkdownProps { text: string; className?: string }

export interface DiffViewProps {
  path?: string;
  before: string;
  after: string;
  /** Keeps whether the diff is expanded across renders. */
  remember?: string;
  onOpenPath?: (path: string) => void;
}

export interface SettingsGroupProps { title?: string; action?: ReactNode; note?: ReactNode; children: ReactNode }
export interface SettingsRowProps { title: ReactNode; description?: ReactNode; children: ReactNode }
export interface SwitchProps { checked?: boolean; onCheckedChange?: (checked: boolean) => void; disabled?: boolean; className?: string; 'aria-label'?: string }
export interface StatusDotProps { tone: 'success' | 'warning' | 'danger' | 'accent' | 'idle'; pulse?: boolean; shape?: 'dot' | 'ring'; label?: string; className?: string }
export interface BadgeProps { children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; className?: string; title?: string }

export interface SelectOption { value: string; label: string; icon?: ReactNode; disabled?: boolean }
/** A choice among several values, as a menu; three or fewer short values read better as `Segmented`. */
export interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onChange(value: string): void;
  /** The control's accessible name. */
  label: string;
  id?: string;
  /** Adds a hidden input so the value is part of a surrounding form's data. */
  name?: string;
  disabled?: boolean;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  className?: string;
}
export interface SegmentedOption { value: string; label: ReactNode; icon?: ReactNode; disabled?: boolean }
export interface SegmentedProps {
  value: string;
  options: readonly SegmentedOption[];
  onChange(value: string): void;
  size?: 'xs' | 'sm';
  className?: string;
  ariaLabel?: string;
}
/** A label above a control, with an optional line of hint under it. */
export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Shown under the control as an alert, and marks a single child control invalid. */
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}
/** A standing notice inside the view: a degraded state, a stale result. Operation results go through `notify`. */
export interface NoticeProps {
  tone?: 'neutral' | 'accent' | 'warning' | 'danger';
  /** Replaces the tone's glyph; `null` draws none. */
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  role?: 'status' | 'alert';
}
/** Nothing to show yet: what is missing, and at most one next step as `children`. */
export interface EmptyStateProps { icon?: ReactNode; title: ReactNode; description?: ReactNode; children?: ReactNode; className?: string }

export interface ModelFieldProps {
  /** The selection: a model id, with its options when it has any. Empty for none. */
  value: string;
  models: readonly ModelInfo[];
  /** Ids to list while `models` is empty. */
  fallbackIds?: readonly string[];
  /** Shown while nothing is selected. */
  placeholder?: string;
  disabled?: boolean;
  onChange(value: string): void;
  /** Called each time the list opens, to read the models again. */
  onOpen?(): void;
}

/** Indentation style of an editor buffer: spaces (2 or 4) or tabs. */
export interface CodeIndent { kind: 'spaces' | 'tabs'; size: 2 | 4 }
/** Commands a caller can run on a `CodeFile`. */
export type CodeFileCommandName =
  | 'find' | 'fold' | 'unfold' | 'foldAll' | 'unfoldAll' | 'selectAll'
  | 'undo' | 'redo' | 'comment' | 'duplicateLine' | 'deleteLine' | 'moveLineUp' | 'moveLineDown' | 'selectNextOccurrence'
  | 'save' | 'revert';
/** Current editing state of a `CodeFile`, reported to its caller for toolbar & status bar UI. */
export interface CodeFileEditState {
  path: string;
  editable: boolean;
  editing: boolean;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  truncated: boolean;
  lineEnding: 'LF' | 'CRLF';
  indent: CodeIndent;
  selections: number;
  selectedChars: number;
}
/** An identifier in a shown file; `line` and `column` are 1-based. */
export interface CodeSymbolAt { word: string; line: number; column: number }
/** A place to show in a file: scrolled to the middle and flashed, or with `restore` put back at the top; a new `token` shows it again. */
export interface CodeFileTarget { line: number; column?: number; restore?: boolean; token: number }
/**
 * A project file read as the files panel reads it: the host loads it, highlights text, draws images
 * and says when it cannot be shown. With `editable`, UTF-8 text files within the edit budget are
 * editable in place using the host's shared draft pool and optimistic-hash save conflict merge.
 * ⌘-click (Ctrl-click) on an identifier and the context menu hand it to `onSymbol` with the pointer,
 * for the view to resolve.
 */
export interface CodeFileProps {
  projectId: string;
  path: string;
  target?: CodeFileTarget | undefined;
  /** Added 2026-11: enables IDE editing (shared drafts, ⌘S save, conflict merge, multi-cursor, auto-brackets). */
  editable?: boolean;
  /** Added 2026-11: locks editing into read-only caret mode while `editable` is true. */
  readOnly?: boolean;
  /** Added 2026-11: watches the project's Git status stream and window focus to follow disk edits. */
  watching?: boolean;
  /** Added 2026-11: soft-wraps long lines inside the viewport. */
  wordWrap?: boolean;
  /** Added 2026-11: overrides detected indentation for this file. */
  indent?: CodeIndent | undefined;
  /** Added 2026-11: preserves CodeMirror undo history, folds and selections across unmounts under this key. */
  stateKey?: string | undefined;
  /** Added 2026-11: reports editing, dirty, conflict, line ending, indent and selection summary. */
  onEditState?(state: CodeFileEditState): void;
  /** Added 2026-11: called after a save succeeds (single file or Save All). */
  onSaved?(path: string): void;
  /** Added 2026-11: called when ⌘⇧S (Ctrl+Shift+S) is pressed while editing. */
  onSaveAll?(): void;
  /** `usages` (added 2026-11) comes from ⌥F7 or ⇧F12 at the caret, with `onCaret`. */
  onSymbol?(at: CodeSymbolAt, intent: 'definition' | 'usages' | 'menu', point: { x: number; y: number }): void;
  /** The first line in view, as the reader scrolls. */
  onTopLine?(line: number): void;
  /** A line number was clicked. */
  onLine?(line: { path: string; line: number; text: string }): void;
  /** Added 2026-11; an older host ignores these. The first and last line in view, as the reader scrolls. */
  onViewport?(first: number, last: number): void;
  /** The file as committed: lines changed since are marked beside the line numbers. */
  baseline?: string | undefined;
  /** Who last changed which lines, drawn as a column before the line numbers (`GitBlame` has this shape). */
  blame?: CodeBlameView | undefined;
  /** A commit in the blame column was clicked. */
  onBlameCommit?(hash: string): void;
  /**
   * Added 2026-11. With it the file has a caret, as an IDE's read-only editor does: the keyboard moves
   * through the text, the word at the caret is marked where else it appears, brackets pair up, and F12 /
   * ⌥F7 hand the identifier at the caret to `onSymbol`. Called with the caret's 1-based line and column.
   */
  onCaret?(line: number, column: number): void;
  /** Added 2026-11: blocks fold at braces, block comments and runs of imports, with a gutter of chevrons. */
  folding?: boolean;
  /**
   * Added 2026-11. With it every right-click in the text or on the line numbers is the view's, for its own
   * menu (the browser's never shows): the caret moves to the click unless it is inside the selection.
   */
  onMenu?(at: CodeMenuAt, point: { x: number; y: number }): void;
  /** Added 2026-11: runs a command in the file, as a menu entry does; a new `token` runs it again. */
  command?: { name: CodeFileCommandName; token: number } | undefined;
}
/**
 * A right-click in a `CodeFile`: where the caret went, the identifier there, the selected text it was inside, or a line number (`gutter`).
 * `blame` (added 2026-11) is the commit of the line when the click was in the blame column (not for lines not committed yet).
 */
export interface CodeMenuAt { line: number; column: number; symbol?: CodeSymbolAt; selection?: string; gutter?: boolean; blame?: string }
/** Consecutive lines from one commit, and the commits by hash; a hash of zeros is lines not committed yet. */
export interface CodeBlameView {
  ranges: ReadonlyArray<{ start: number; count: number; hash: string }>;
  commits: Readonly<Record<string, { author: string; date: string; summary: string }>>;
}
/** Semantic tree-node kind for `UiKit.FileIcon` (JetBrains New UI / Zed duotone icon set). */
export type FileIconKind = 'file' | 'folder' | 'module' | 'group' | 'source' | 'resources' | 'assets' | 'manifest' | 'package';
/** The files panel's icon for a file name, folder or module tree node. */
export interface FileIconProps { name: string; directory?: boolean; open?: boolean; kind?: FileIconKind; className?: string }

/** One entry of a `Menu`: a command, a choice of one (`radio`, ticked when current), an on/off option, a line, or a group's caption. */
export type MenuEntry =
  | { kind: 'item'; label: string; icon?: ReactNode; shortcut?: string; disabled?: boolean; danger?: boolean; onSelect(): void }
  | { kind: 'radio'; label: string; icon?: ReactNode; checked: boolean; disabled?: boolean; onSelect(): void }
  | { kind: 'check'; label: string; icon?: ReactNode; checked: boolean; disabled?: boolean; onCheckedChange(checked: boolean): void }
  | { kind: 'separator' }
  | { kind: 'label'; label: string }
  /** Added 2026-11: a row that opens more entries beside it; an older host leaves it out. */
  | { kind: 'submenu'; label: string; icon?: ReactNode; disabled?: boolean; entries: readonly MenuEntry[] };
/** The app's dropdown menu, opened by `trigger` (one element that takes a ref, such as a `Button`). */
export interface MenuProps {
  trigger: ReactElement;
  /** The trigger's tooltip, for an icon button. */
  tip?: string;
  entries: readonly MenuEntry[];
  align?: 'start' | 'center' | 'end';
  /** Narrow menus that must stay by their trigger on a phone; otherwise a phone shows the menu as a bottom sheet. */
  mobileSheet?: boolean;
  /** Added 2026-11: told when the menu opens or closes, to read what it lists only when it is opened. */
  onOpenChange?(open: boolean): void;
}
/** The app's popover: a small panel opened by `trigger` (one element that takes a ref), for detail a menu cannot hold. */
export interface PopoverProps {
  trigger: ReactElement;
  /** The trigger's tooltip, for an icon button. */
  tip?: string;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Width and padding of the panel; it has none of its own. */
  className?: string;
  onOpenChange?(open: boolean): void;
}
/** A determinate bar, `value` 0–1: how much of some work is done. */
export interface ProgressProps { value: number; label: string; className?: string }
/** A per-project view another plugin offers (one of the side panel's plugin views: a build, a log), as `useProjectViews` lists it. */
export interface ProjectViewInfo { id: string; title: string; icon: IconComponent }
/**
 * One of those views, drawn in the asking page (a tool window). Its instance and state are the side panel's for
 * that project. `visible: false` pauses it; `onOpenFile` takes the files it opens (a build error's file and line),
 * which otherwise go to the side panel's file preview. A path may be absolute.
 */
export interface ProjectViewProps { projectId: string; viewId: string; visible?: boolean; onOpenFile?(path: string, line?: number): void }
/**
 * The drag strip on a resizable pane's edge (the app's own, as the sidebar and file tree use): arrows
 * step it from the keyboard, double click resets. Place it absolutely on the edge inside the pane.
 */
export interface ResizeHandleProps {
  /** `x` sizes a column from its side edge, `y` a row from its top or bottom edge. */
  axis: 'x' | 'y';
  value: number;
  min: number;
  max: number;
  /** 1 when moving right (or down) grows the pane, -1 when moving left (or up) does. */
  grow: 1 | -1;
  label: string;
  /** Every frame of a drag; without it each frame goes to `onChange`. */
  onPreview?(value: number): void;
  /** The settled value: a released drag or a key press. */
  onChange(value: number): void;
  onReset?(): void;
  className?: string;
}
/** The app's menu at a point, for a right-click: open while `at` is set, `onClose` when it is dismissed or an entry is chosen. */
export interface ContextMenuProps {
  at: { x: number; y: number } | undefined;
  entries: readonly MenuEntry[];
  onClose(): void;
}
/**
 * The app's search dialog, as ⌘P and ⌘K open it: a query row, an optional row of scopes, and a list
 * area of fixed height (switching scope does not resize it). The plugin draws the list; options carry
 * `role="option"` and ids, and `activeId` names the current one, so focus stays in the query.
 */
export interface QuickPanelProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The dialog's accessible name. */
  title: string;
  query: string;
  onQueryChange(query: string): void;
  placeholder: string;
  onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
  busy?: boolean;
  /** Changes to put the caret back in the query (a shortcut asked for the dialog again). */
  focusToken?: number;
  /** Scope tabs under the query; `Tab` handling is the plugin's. */
  tabs?: readonly { value: string; label: string }[];
  tab?: string;
  onTabChange?(tab: string): void;
  /** At the end of the tabs row: options such as match case, a scope, a hint. */
  tools?: ReactNode;
  /** At the end of the query row, before the close button. */
  trailing?: ReactNode;
  listId: string;
  activeId?: string;
  listLabel: string;
  /** The list area, scrolled by the host. */
  children: ReactNode;
  /** Under the list, at a fixed share of its height: a preview of the current option. */
  preview?: ReactNode;
}

/** The host's own components, so a plugin looks like the app and ships none of its own chrome. */
export interface UiKit {
  Button: ComponentType<ButtonProps>;
  Spinner: ComponentType<{ className?: string }>;
  Tip: ComponentType<TipProps>;
  Markdown: ComponentType<MarkdownProps>;
  DiffView: ComponentType<DiffViewProps>;
  /** The settings look: a titled card of rows, each a title (and one line under it) with its control at the end. */
  SettingsGroup: ComponentType<SettingsGroupProps>;
  SettingsRow: ComponentType<SettingsRowProps>;
  Input: ComponentType<ComponentProps<'input'>>;
  Switch: ComponentType<SwitchProps>;
  StatusDot: ComponentType<StatusDotProps>;
  Badge: ComponentType<BadgeProps>;
  /**
   * Added after web API 1 without a version bump, so a host from before 2026-11 lacks them: test
   * for the member (`if (ui.Select)`) and fall back. `Button`'s `busy` is likewise ignored there.
   */
  Select?: ComponentType<SelectProps>;
  Segmented?: ComponentType<SegmentedProps>;
  Field?: ComponentType<FieldProps>;
  Notice?: ComponentType<NoticeProps>;
  EmptyState?: ComponentType<EmptyStateProps>;
  /** Chooses a model, and its options, from a list. */
  ModelField: ComponentType<ModelFieldProps>;
  /** Added 2026-11 (see `Select`): a project file, and a file's icon. Test for the member before use. */
  CodeFile?: ComponentType<CodeFileProps>;
  FileIcon?: ComponentType<FileIconProps>;
  /** Added 2026-11 (see `Select`): the app's dropdown menu and its search dialog. Test for the member before use. */
  Menu?: ComponentType<MenuProps>;
  QuickPanel?: ComponentType<QuickPanelProps>;
  /** Added 2026-11 (see `Select`): the app's menu at the pointer, and its pane resize handle. Test for the member before use. */
  ContextMenu?: ComponentType<ContextMenuProps>;
  ResizeHandle?: ComponentType<ResizeHandleProps>;
  /** Added 2026-11 (see `Select`): the app's popover and progress bar. Test for the member before use. */
  Popover?: ComponentType<PopoverProps>;
  Progress?: ComponentType<ProgressProps>;
  /** Added 2026-11 (see `Select`): another plugin's per-project view (from `useProjectViews`), hosted as a tool window. Test for the member before use. */
  ProjectView?: ComponentType<ProjectViewProps>;
  icon(name: PluginIconName): IconComponent;
  /** The icon of a tool kind (`read`, `execute`...); a wrench for one it does not know. */
  toolIcon(kind: string): IconComponent;
  /** Copies `text` and tells the user it was copied. */
  copy(text: string): Promise<void>;
}

/**
 * Shared project-file write operations and unsaved draft pool (`file-write-v1`), shared with the
 * files panel so unsaved edits, conflict checks and trash-undo stay in one place.
 */
export interface WorkspaceService {
  /** Whether the server supports project file writes (`file-write-v1`). */
  canWrite(): boolean;
  subscribe(listener: () => void): () => void;
  /** Relative paths of `projectId` currently holding unsaved edits. */
  dirtyPaths(projectId: string): readonly string[];
  /** Asks before discarding unsaved edits on `paths`; resolves true if clean or confirmed (dropping drafts). */
  confirmDiscard(projectId: string, paths: readonly string[]): Promise<boolean>;
  /** Saves every non-conflicting unsaved file in `projectId` (or the given `paths`); returns saved count and conflicted paths. */
  saveAll(projectId: string, paths?: readonly string[]): Promise<{ saved: number; conflicts: string[] }>;
  /** Prompts for a name and creates a file or directory under `folder`; returns the created relative path, or undefined. */
  create(projectId: string, kind: 'file' | 'directory', folder: string): Promise<string | undefined>;
  /** Prompts for a new name and renames `from`, carrying unsaved edits and editor history along. */
  rename(projectId: string, from: string): Promise<string | undefined>;
  /** Deletes `path` (with 24h undo toast when recoverable, or permanent confirmation when too large). */
  remove(projectId: string, path: string, options?: { onRestored?: () => void }): Promise<boolean>;
}

export interface PluginHost {
  /** The app's language as a BCP-47 tag, such as `zh-Hans` or `en`; changes when the user switches. */
  readonly locale: string;
  readonly sessions: SessionService;
  readonly navigation: NavigationService;
  readonly notify: NotifyService;
  readonly request: RequestService;
  readonly settings: SettingsService;
  readonly settingsPage: SettingsPageService;
  readonly timeline: TimelineService;
  readonly ui: UiKit;
  /** Added 2026-11, absent on an older host: shared file drafts and write operations (`file-write-v1`). */
  readonly workspace?: WorkspaceService;
  /**
   * Added 2026-11, absent on an older host: a hook (call it as one, through `useProjectViews`) listing the plugin
   * views offered for a project outside a conversation, other than the asking plugin's own, judged as the side
   * panel judges them (the project's type, the views the reader hid there).
   */
  readonly useProjectViews?: (projectId: string | undefined) => readonly ProjectViewInfo[];
}

/* ------------------------------------------------------------------ glue */

export const PluginHostContext = createContext<PluginHost | undefined>(undefined);

export function usePluginHost(): PluginHost {
  const host = useContext(PluginHostContext);
  if (!host) throw new Error('usePluginHost() was called outside a plugin view');
  return host;
}

const NO_PROJECT_VIEWS: readonly ProjectViewInfo[] = [];

/** Other plugins' per-project views for `projectId` (`PluginHost.useProjectViews`); none on a host without it. */
export function useProjectViews(projectId: string | undefined): readonly ProjectViewInfo[] {
  const host = usePluginHost();
  // The member is fixed for the host's lifetime, so the hooks run in the same order on every render.
  return host.useProjectViews ? host.useProjectViews(projectId) : NO_PROJECT_VIEWS;
}

/** Every conversation, and re-renders when one changes. */
export function useSessions(): readonly Session[] {
  const { sessions } = usePluginHost();
  return useSyncExternalStore(sessions.subscribe, sessions.list);
}

export function useProjects(): readonly PluginProject[] {
  const { sessions } = usePluginHost();
  return useSyncExternalStore(sessions.subscribe, sessions.projects);
}

const NO_SERVERS: readonly PluginServer[] = [];
const noServers = () => NO_SERVERS;

/** The servers projects come from (`SessionService.servers`), empty on a host that does not list them. */
export function useServers(): readonly PluginServer[] {
  const { sessions } = usePluginHost();
  return useSyncExternalStore(sessions.subscribe, sessions.servers ?? noServers);
}

const NO_DIRTY: readonly string[] = [];
const noopSubscribe = () => () => undefined;
const falseFn = () => false;

/** Relative paths of `projectId` currently holding unsaved edits (`PluginHost.workspace`), empty on older hosts. */
export function useDirtyPaths(projectId: string | undefined): readonly string[] {
  const { workspace } = usePluginHost();
  const subscribe = workspace?.subscribe ?? noopSubscribe;
  const getSnapshot = useMemo(
    () => (workspace && projectId ? () => workspace.dirtyPaths(projectId) : () => NO_DIRTY),
    [workspace, projectId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Whether the connected server supports project file writes (`file-write-v1`), false on older hosts. */
export function useCanWrite(): boolean {
  const { workspace } = usePluginHost();
  return useSyncExternalStore(workspace?.subscribe ?? noopSubscribe, workspace?.canWrite ?? falseFn);
}

/** The declared settings keys, and re-renders when one changes. */
export function useSettings(): Readonly<Partial<AppSettings>> {
  const { settings } = usePluginHost();
  return useSyncExternalStore(settings.subscribe, settings.get);
}

export function Button(props: ButtonProps) {
  return createElement(usePluginHost().ui.Button, props);
}

export function Spinner(props: { className?: string }) {
  return createElement(usePluginHost().ui.Spinner, props);
}

export function Tip(props: TipProps) {
  return createElement(usePluginHost().ui.Tip, props);
}

export function Markdown(props: MarkdownProps) {
  return createElement(usePluginHost().ui.Markdown, props);
}

export function DiffView(props: DiffViewProps) {
  return createElement(usePluginHost().ui.DiffView, props);
}

export function SettingsGroup(props: SettingsGroupProps) {
  return createElement(usePluginHost().ui.SettingsGroup, props);
}

export function SettingsRow(props: SettingsRowProps) {
  return createElement(usePluginHost().ui.SettingsRow, props);
}

export function Input(props: ComponentProps<'input'>) {
  return createElement(usePluginHost().ui.Input, props);
}

export function Switch(props: SwitchProps) {
  return createElement(usePluginHost().ui.Switch, props);
}

export function StatusDot(props: StatusDotProps) {
  return createElement(usePluginHost().ui.StatusDot, props);
}

export function Badge(props: BadgeProps) {
  return createElement(usePluginHost().ui.Badge, props);
}

// A host from before these members renders nothing for the pickers and plain text for the rest,
// so an older Riffet shows the plugin's content without its styling instead of failing to render.
export function Select(props: SelectProps) {
  const component = usePluginHost().ui.Select;
  return component ? createElement(component, props) : null;
}

export function Segmented(props: SegmentedProps) {
  const component = usePluginHost().ui.Segmented;
  return component ? createElement(component, props) : null;
}

export function Field(props: FieldProps) {
  const component = usePluginHost().ui.Field;
  return component ? createElement(component, props) : createElement('label', { className: props.className }, props.label, props.children, props.error ?? props.hint);
}

export function Notice(props: NoticeProps) {
  const component = usePluginHost().ui.Notice;
  return component ? createElement(component, props) : createElement('div', { className: props.className, role: 'status' }, props.children, props.action);
}

export function EmptyState(props: EmptyStateProps) {
  const component = usePluginHost().ui.EmptyState;
  return component ? createElement(component, props) : createElement('div', { className: props.className }, props.title, props.description, props.children);
}

export function ModelField(props: ModelFieldProps) {
  return createElement(usePluginHost().ui.ModelField, props);
}

export function Icon({ name, ...props }: { name: PluginIconName; className?: string }) {
  return createElement(usePluginHost().ui.icon(name), props);
}

export function ToolIcon({ kind, ...props }: { kind: string; className?: string }) {
  return createElement(usePluginHost().ui.toolIcon(kind), props);
}

/* ------------------------------------------------------------------ text */

/** A plugin's own UI text by language. `zh-Hans` and `en` are required: they are the fallbacks. */
export type MessageCatalogs<T> = { 'zh-Hans': T; en: T } & Record<string, T>;

/** The catalog for `locale`: its exact tag, then its language, then `zh-Hans`, the source language. Plugin text never goes into the app's own catalogs. */
export function localize<T>(catalogs: MessageCatalogs<T>, locale: string): T {
  const table = new Map(Object.entries(catalogs).map(([tag, catalog]) => [tag.toLowerCase(), catalog]));
  const tag = locale.toLowerCase().replaceAll('_', '-');
  for (let length = tag.split('-').length; length > 0; length -= 1) {
    const found = table.get(tag.split('-').slice(0, length).join('-'));
    if (found !== undefined) return found;
  }
  return catalogs['zh-Hans'];
}

/** The plugin's catalog in the app's language; define the catalogs once at module level. */
export function useMessages<T>(catalogs: MessageCatalogs<T>): T {
  const { locale } = usePluginHost();
  return useMemo(() => localize(catalogs, locale), [catalogs, locale]);
}
