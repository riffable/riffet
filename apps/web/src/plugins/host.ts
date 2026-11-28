import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { createElement } from 'react';
import type { AppSettings, Run, Session, SyncLane, TimelinePage, TurnOutlineV3 } from '@contracts';
import type { ButtonProps as PluginButtonProps, PluginAccess, PluginHost, SegmentedProps, SelectProps, SettingsPageService, ToolCall, WorkspaceService } from '@riffet/plugin-web';
import { IconWrench } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Field, Input, Segmented, Select, Spinner, StatusDot, Switch } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { Progress } from '@/components/ui/progress';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { Tip } from '@/components/ui/tooltip';
import { api, attachmentPath, HttpError, request, withClientFeatures, type ForkSessionResult } from '@/lib/api';
import { backendLabel, sessionBackend } from '@/lib/backends';
import { confirmDialog, promptDialog } from '@/lib/dialogs';
import { textOf } from '@/lib/errors';
import { copyWithToast } from '@/lib/files';
import { serverOfObject } from '@/lib/server-routing';
import { toast } from '@/lib/toast';
import { errorMessage, newId } from '@/lib/utils';
import { editorSessions } from '../app/panels/editorSessions';
import { fileDrafts } from '../app/panels/fileDrafts';
import { Markdown } from '../app/session/Markdown';
import { lineDiff } from '../app/session/lineDiff';
import { SettingsGroup, SettingsRow } from '../app/settings/SettingsLayout';
import { DiffView, toolIcons } from '../app/session/Timeline';
import { stripRoot, toolDiffStats, toolView } from '../app/session/toolView';
import type { WorkbenchStores } from '../app/state/stores';
import { timelineItem } from '../sync/rows';
import { allowedRequestPath, assertDeclaredSettings, declaredSettings } from './access';
import { pluginIcon } from './icons';
import { ModelField } from './ModelField';
import { CodeFile, FileIcon } from './CodeFile';
import { PluginContextMenu, PluginMenu, PluginPopover, PluginQuickPanel } from './PluginOverlays';
import { PluginProjectView, projectViewsHook } from './ProjectViews';
import { openDirectory } from './DirectoryRequest';

const NO_SETTINGS_PAGE: SettingsPageService = { setDirty: () => undefined, setBusy: () => undefined };

/**
 * The app's side of the plugin SDK (`@riffet/plugin-web`): what a view may ask of the app, built on
 * the workbench's stores and API so no store, raw request or credential reaches plugin code. One
 * host serves one view instance; `sessionId` is the conversation it shows, which navigation
 * compares against.
 */
/** The SDK's `accent` variant is deprecated and drawn as `primary`. */
function PluginButton({ variant, ...props }: PluginButtonProps) {
  return createElement(Button, { ...props, variant: variant === 'accent' ? 'primary' : variant });
}

function PluginSelect({ options, ...props }: SelectProps) {
  return createElement(Select, { ...props, options: [...options] });
}

function PluginSegmented({ options, ...props }: SegmentedProps) {
  return createElement(Segmented, { ...props, options: [...options] });
}

const joinRel = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const baseName = (path: string) => path.split('/').at(-1) ?? path;
const parentDir = (path: string) => path.split('/').slice(0, -1).join('/');
const reportWorkspaceError = (error: unknown, fallback: string) => {
  const translated = error instanceof HttpError && error.code ? textOf({ code: error.code, ...(error.params ? { params: error.params } : {}) }, error.message) : undefined;
  toast.error(translated ?? errorMessage(error, fallback));
};

function createWorkspaceService(lists: WorkbenchStores['lists']): WorkspaceService {
  // Stable per-project array snapshots for `useSyncExternalStore`.
  const dirtyCache = new Map<string, readonly string[]>();
  const dirtyPaths = (projectId: string): readonly string[] => {
    const next = fileDrafts.pathsOf(projectId);
    const prev = dirtyCache.get(projectId);
    if (prev && prev.length === next.length && prev.every((item, idx) => item === next[idx])) return prev;
    dirtyCache.set(projectId, next);
    return next;
  };

  return {
    canWrite: () => lists.get().fileWrites,
    subscribe: (listener) => {
      let writable = lists.get().fileWrites;
      const offLists = lists.subscribe(() => {
        const next = lists.get().fileWrites;
        if (next === writable) return;
        writable = next;
        listener();
      });
      const offDrafts = fileDrafts.subscribe(listener);
      return () => { offLists(); offDrafts(); };
    },
    dirtyPaths,
    confirmDiscard: async (projectId, paths) => {
      const dirty = paths.filter((path) => Boolean(fileDrafts.get(projectId, path)));
      if (!dirty.length) return true;
      const confirmed = await confirmDialog({
        title: dirty.length === 1 ? i18n._(msg`放弃未保存的修改？`) : i18n._(msg`放弃 ${dirty.length} 个文件的未保存修改？`),
        ...(dirty.length === 1 ? { description: dirty[0]! } : {}),
        confirmLabel: i18n._(msg`放弃修改`),
        destructive: true,
      });
      if (confirmed) for (const path of dirty) fileDrafts.drop(projectId, path);
      return confirmed;
    },
    saveAll: async (projectId, paths) => {
      const targets = paths ? paths.filter((path) => Boolean(fileDrafts.get(projectId, path))) : fileDrafts.pathsOf(projectId);
      let saved = 0;
      const conflicts: string[] = [];
      for (const path of targets) {
        const kept = fileDrafts.get(projectId, path);
        if (!kept) continue;
        try {
          const version = await api.saveFile(projectId, path, kept.text, kept.base);
          const now = fileDrafts.get(projectId, path);
          if (now && now.text !== kept.text) fileDrafts.set(projectId, path, { base: version.hash, text: now.text });
          else fileDrafts.drop(projectId, path);
          fileDrafts.notifySaved(projectId, version, kept.text);
          saved += 1;
        } catch (error) {
          if (error instanceof HttpError && error.code === 'FILE_CHANGED') conflicts.push(path);
          else reportWorkspaceError(error, i18n._(msg`无法保存文件`));
        }
      }
      if (conflicts.length) toast.error(i18n._(msg`${conflicts.length} 个文件在磁盘上已被修改，请打开并合并`));
      return { saved, conflicts };
    },
    create: async (projectId, kind, folder) => {
      const name = (await promptDialog({ title: kind === 'file' ? i18n._(msg`新建文件`) : i18n._(msg`新建文件夹`), confirmLabel: i18n._(msg`新建`) }))?.trim();
      if (!name) return undefined;
      const target = joinRel(folder, name.replace(/^\/+|\/+$/g, ''));
      try { await api.createFile(projectId, target, kind); }
      catch (error) { reportWorkspaceError(error, i18n._(msg`无法新建`)); return undefined; }
      return target;
    },
    rename: async (projectId, from) => {
      const name = (await promptDialog({ title: i18n._(msg`重命名`), initial: baseName(from), confirmLabel: i18n._(msg`重命名`) }))?.trim();
      if (!name || name === baseName(from)) return undefined;
      const to = joinRel(parentDir(from), name.replace(/^\/+|\/+$/g, ''));
      try { await api.moveFile(projectId, from, to); }
      catch (error) { reportWorkspaceError(error, i18n._(msg`无法重命名`)); return undefined; }
      fileDrafts.move(projectId, from, to);
      editorSessions.move(projectId, from, to);
      return to;
    },
    remove: async (projectId, path, options) => {
      if (fileDrafts.heldUnder(projectId, path)) {
        const name = baseName(path);
        if (!await confirmDialog({ title: i18n._(msg`删除「${name}」？`), description: i18n._(msg`未保存的修改会丢失，撤销删除也不会恢复它们。`), confirmLabel: i18n._(msg`删除`), destructive: true })) return false;
      }
      let restoreId: string | undefined;
      try { restoreId = (await api.deleteFile(projectId, path)).restoreId; }
      catch (error) {
        if (!(error instanceof HttpError && error.code === 'DELETE_UNRECOVERABLE')) { reportWorkspaceError(error, i18n._(msg`无法删除`)); return false; }
        const name = baseName(path);
        if (!await confirmDialog({ title: i18n._(msg`永久删除「${name}」？`), description: i18n._(msg`它太大，删除后无法撤销。`), confirmLabel: i18n._(msg`永久删除`), destructive: true })) return false;
        try { await api.deleteFile(projectId, path, true); }
        catch (again) { reportWorkspaceError(again, i18n._(msg`无法删除`)); return false; }
      }
      fileDrafts.dropUnder(projectId, path);
      editorSessions.dropUnder(projectId, path);
      if (restoreId) {
        const id = restoreId;
        const name = baseName(path);
        toast.success(i18n._(msg`已删除「${name}」`), { action: { label: i18n._(msg`撤销`), onClick: () => {
          void api.restoreFile(projectId, id).then(() => options?.onRestored?.(), (error) => reportWorkspaceError(error, i18n._(msg`无法撤销删除`)));
        } } });
      }
      return true;
    },
  };
}

export function createPluginHost({ stores, pluginId, sessionId, locale, access, settingsPage = NO_SETTINGS_PAGE, openPath }: {
  stores: WorkbenchStores;
  /** The plugin the view belongs to; absent for the app's own views. */
  pluginId?: string | undefined;
  sessionId: string | undefined;
  locale: string;
  /** What the plugin declared (`WebPlugin.access`); without it `request` and `settings` refuse everything. */
  access?: PluginAccess | undefined;
  /** Set where the view is a page of the settings dialog. */
  settingsPage?: SettingsPageService;
  /** Where `navigation.openPath` goes when the view is drawn inside a page that reads files itself (`ProjectFileOpener`). */
  openPath?: ((path: string) => void) | undefined;
}): PluginHost {
  const { lists, nav, ui, handlers, settings: settingsStore } = stores;
  // One snapshot object until a declared key changes, as `useSyncExternalStore` needs.
  let source: AppSettings | undefined;
  let snapshot: Partial<AppSettings> = {};
  const readSettings = (): Partial<AppSettings> => {
    const current = settingsStore.current();
    if (current === source) return snapshot;
    source = current;
    const next = declaredSettings(current, access);
    const keys = Object.keys(next) as Array<keyof AppSettings>;
    if (keys.length !== Object.keys(snapshot).length || keys.some((key) => !Object.is(next[key], snapshot[key]))) snapshot = next;
    return snapshot;
  };
  const summariesChosen = () => Boolean(settingsStore.current().auxiliaryModels?.summary);
  return {
    locale,
    sessions: {
      list: () => lists.get().sessions,
      projects: () => lists.get().projects,
      servers: () => lists.get().servers,
      serverOf: serverOfObject,
      subscribe: (listener) => {
        let summaries = summariesChosen();
        const offLists = lists.subscribe(listener);
        const offSettings = settingsStore.subscribe(() => {
          const next = summariesChosen();
          if (next === summaries) return;
          summaries = next;
          listener();
        });
        return () => { offLists(); offSettings(); };
      },
      outline: async (id, { lane = 'main', signal }: { lane?: SyncLane; signal?: AbortSignal } = {}) =>
        (await request<{ turns: TurnOutlineV3[] }>(`/api/v3/sessions/${encodeURIComponent(id)}/outline?lane=${encodeURIComponent(lane)}`, { ...(signal ? { signal } : {}) })).turns,
      runs: (id, { signal }: { signal?: AbortSignal } = {}) => request<Run[]>(`/api/sessions/${encodeURIComponent(id)}/runs`, { ...(signal ? { signal } : {}) }),
      timeline: (id, { lane, from, rows, budget }, { signal }: { signal?: AbortSignal } = {}) => {
        const query = new URLSearchParams({ lane, from: String(from), rows: String(rows), budget: String(budget) });
        return request<TimelinePage>(`/api/v3/sessions/${encodeURIComponent(id)}/timeline?${query.toString()}`, { ...(signal ? { signal } : {}) });
      },
      // A fork is the user's act: it is not cancelled with the view that asked for it.
      fork: async (id, runId, { note }: { note?: string } = {}) => {
        const result: ForkSessionResult = await api.forkSession(id, { clientSessionId: newId(), commandId: newId(), runId, ...(note?.trim() ? { note: note.trim() } : {}) });
        if (result.project) lists.upsertProject(result.project);
        lists.upsertSession(result.session);
      },
      backendLabel: (session) => backendLabel(sessionBackend(session)),
      turnSummary: async (id, turn, { signal }: { signal?: AbortSignal } = {}) =>
        (await request<{ summary?: string }>(`/api/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn)}/summary`, { ...(signal ? { signal } : {}) })).summary,
      turnSummaries: summariesChosen,
      // Image loads cannot send the features header, so it travels in the URL.
      mediaUrl: (id, path) => withClientFeatures(`/api/sessions/${encodeURIComponent(id)}/media?path=${encodeURIComponent(path)}`),
      attachmentUrl: (id) => attachmentPath(id, sessionId),
      openDirectory: (options = {}) => openDirectory(lists, { ...options, prompt: i18n._(msg`选择要打开的目录`), failed: i18n._(msg`无法打开目录`) }),
    },
    navigation: {
      openTurn: (target: Session, turn) => {
        if (target.id !== sessionId) handlers.selectSession(target);
        nav.set({ focusMessage: { sessionId: target.id, focus: { messageId: turn?.nativeId ?? '', ...(turn?.runId ? { runId: turn.runId } : {}) } } });
      },
      openPath: (path) => (openPath ? openPath(path) : ui.preview(path)),
      openSession: (id) => {
        const target = lists.get().sessions.find((item) => item.id === id);
        if (target) handlers.selectSession(target);
      },
      ...(pluginId ? { openPluginPage: () => { void nav.navigate(() => nav.openPlugins(pluginId, '', 'page')); } } : {}),
      quote: (projectId, reference) => handlers.quoteInProject(projectId, { path: reference.path, ...(reference.line !== undefined ? { line: reference.line } : {}), ...(reference.text !== undefined ? { text: reference.text } : {}) }),
    },
    notify: { error: (error, fallback) => toast.error(errorMessage(error, fallback)), errorText: errorMessage, success: (message) => toast.success(message) },
    request: {
      get: (path, { signal }: { signal?: AbortSignal } = {}) => request(allowedRequestPath(path, access), { ...(signal ? { signal } : {}) }),
      post: (path, body, { signal }: { signal?: AbortSignal } = {}) =>
        request(allowedRequestPath(path, access), { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) }),
    },
    settings: {
      get: readSettings,
      subscribe: settingsStore.subscribe,
      update: async (patch) => {
        assertDeclaredSettings(patch, access);
        const saved = await api.updateSettings(patch);
        // Folded in as the dialog's own sections do, so the rest of the app sees the change.
        settingsStore.applySaved(saved, patch as Partial<AppSettings>);
        return readSettings();
      },
    },
    settingsPage,
    timeline: {
      toolCall: (row, id, root): ToolCall | undefined => {
        const item = timelineItem(row, id);
        if (!item) return undefined;
        const view = toolView(item.event, root);
        const data = item.event.data;
        const rawInput = typeof data.rawInput === 'object' && data.rawInput ? data.rawInput as Record<string, unknown> : undefined;
        const toolName = typeof data.toolName === 'string' ? data.toolName : typeof data.name === 'string' ? data.name : undefined;
        const diff = ['edit', 'delete', 'move'].includes(view.kind) ? toolDiffStats(view) : undefined;
        return {
          id: view.id, title: view.title, kind: view.kind, status: view.status, locations: view.locations, contents: view.contents,
          ...(view.command ? { command: view.command } : {}), ...(rawInput ? { rawInput } : {}), ...(toolName ? { toolName } : {}),
          ...(diff ? { diff: { added: diff.added, removed: diff.removed } } : {}),
        };
      },
      relativePath: stripRoot,
      lineDiff: (before, after, context) => lineDiff(before, after, context),
    },
    ui: {
      Button: PluginButton, Spinner, Tip, Markdown, DiffView, SettingsGroup, SettingsRow, Input, Switch, StatusDot, Badge, Select: PluginSelect, Segmented: PluginSegmented, Field, Notice, EmptyState, ModelField, CodeFile, FileIcon, Menu: PluginMenu, QuickPanel: PluginQuickPanel, ContextMenu: PluginContextMenu, ResizeHandle, Popover: PluginPopover, Progress, ProjectView: PluginProjectView,
      icon: pluginIcon,
      toolIcon: (kind) => toolIcons[kind] ?? IconWrench,
      copy: copyWithToast,
    },
    workspace: createWorkspaceService(lists),
    useProjectViews: projectViewsHook(pluginId),
  };
}
