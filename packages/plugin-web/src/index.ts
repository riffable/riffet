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

import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import type { AppSettings, AppSettingsUpdate, ModelInfo, Run, Session, SyncLane, TimelinePage, TimelineRow, TurnOutlineV3 } from '@contracts';

// The message bridge of isolated views: protocol types and limits. The client a view bundles is `bridge-client.ts`.
export * from './bridge.js';
export { satisfies as satisfiesHostApi } from './compat.js';
// The base stylesheet the host writes into an isolated view's page.
export { PLUGIN_BASE_STYLE, PLUGIN_BASE_STYLE_VERSION } from './base-style.js';

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
  /** Server path prefixes the views may request, each starting with `/api/`, such as `/api/my-plugin/`. */
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
}

export interface SessionService {
  /** Every conversation the user can see, as the app holds them now. `subscribe` fires when this or `projects()` changes. */
  list(): readonly Session[];
  projects(): readonly PluginProject[];
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
}

export interface NavigationService {
  /** Reads one turn of a conversation in the transcript, switching conversation first when it is another. */
  openTurn(session: Session, turn?: { runId?: string; nativeId?: string }): void;
  /** Previews a project file in the side panel. */
  openPath(path: string): void;
  openSession(sessionId: string): void;
  /** Opens this plugin's own page in its details (docs/PLUGIN_ARCHITECTURE.md「插件详情」). Absent from an older host. */
  openPluginPage?(): void;
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
  | 'chevron-right' | 'refresh-cw' | 'save';

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
  icon(name: PluginIconName): IconComponent;
  /** The icon of a tool kind (`read`, `execute`...); a wrench for one it does not know. */
  toolIcon(kind: string): IconComponent;
  /** Copies `text` and tells the user it was copied. */
  copy(text: string): Promise<void>;
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
}

/* ------------------------------------------------------------------ glue */

export const PluginHostContext = createContext<PluginHost | undefined>(undefined);

export function usePluginHost(): PluginHost {
  const host = useContext(PluginHostContext);
  if (!host) throw new Error('usePluginHost() was called outside a plugin view');
  return host;
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
