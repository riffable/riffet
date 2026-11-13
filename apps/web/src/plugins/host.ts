import type { AppSettings, Run, Session, SyncLane, TimelinePage, TurnOutlineV3 } from '@contracts';
import type { PluginAccess, PluginHost, SettingsPageService, ToolCall } from '@riffet/plugin-web';
import { IconWrench } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, Input, Spinner, StatusDot, Switch } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { api, request, withClientFeatures, type NativeSessionCreateResult } from '@/lib/api';
import { backendLabel, sessionBackend } from '@/lib/backends';
import { copyWithToast } from '@/lib/files';
import { toast } from '@/lib/toast';
import { errorMessage, newId } from '@/lib/utils';
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

const NO_SETTINGS_PAGE: SettingsPageService = { setDirty: () => undefined, setBusy: () => undefined };

/**
 * The app's side of the plugin SDK (`@riffet/plugin-web`): what a view may ask of the app, built on
 * the workbench's stores and API so no store, raw request or credential reaches plugin code. One
 * host serves one view instance; `sessionId` is the conversation it shows, which navigation
 * compares against.
 */
export function createPluginHost({ stores, pluginId, sessionId, locale, access, settingsPage = NO_SETTINGS_PAGE }: {
  stores: WorkbenchStores;
  /** The plugin the view belongs to; absent for the app's own views. */
  pluginId?: string | undefined;
  sessionId: string | undefined;
  locale: string;
  /** What the plugin declared (`WebPlugin.access`); without it `request` and `settings` refuse everything. */
  access?: PluginAccess | undefined;
  /** Set where the view is a page of the settings dialog. */
  settingsPage?: SettingsPageService;
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
        const result: NativeSessionCreateResult = await api.forkSession(id, { clientSessionId: newId(), commandId: newId(), runId, ...(note?.trim() ? { note: note.trim() } : {}) });
        if (result.project) lists.upsertProject(result.project);
        lists.upsertSession(result.session);
      },
      backendLabel: (session) => backendLabel(sessionBackend(session)),
      turnSummary: async (id, turn, { signal }: { signal?: AbortSignal } = {}) =>
        (await request<{ summary?: string }>(`/api/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn)}/summary`, { ...(signal ? { signal } : {}) })).summary,
      turnSummaries: summariesChosen,
      // Image loads cannot send the features header, so it travels in the URL.
      mediaUrl: (id, path) => withClientFeatures(`/api/sessions/${encodeURIComponent(id)}/media?path=${encodeURIComponent(path)}`),
      attachmentUrl: (id) => `/api/attachments/${encodeURIComponent(id)}`,
    },
    navigation: {
      openTurn: (target: Session, turn) => {
        if (target.id !== sessionId) handlers.selectSession(target);
        nav.set({ focusMessage: { sessionId: target.id, focus: { messageId: turn?.nativeId ?? '', ...(turn?.runId ? { runId: turn.runId } : {}) } } });
      },
      openPath: (path) => ui.preview(path),
      openSession: (id) => {
        const target = lists.get().sessions.find((item) => item.id === id);
        if (target) handlers.selectSession(target);
      },
      ...(pluginId ? { openPluginPage: () => { void nav.navigate(() => nav.openPlugins(pluginId, '', 'page')); } } : {}),
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
      Button, Spinner, Tip, Markdown, DiffView, SettingsGroup, SettingsRow, Input, Switch, StatusDot, Badge, ModelField,
      icon: pluginIcon,
      toolIcon: (kind) => toolIcons[kind] ?? IconWrench,
      copy: copyWithToast,
    },
  };
}
