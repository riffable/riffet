import type { ExtensionKind, NativeBackendId, Run } from '@contracts';
import { sameContextReference, type PromptContextReference } from '@/lib/api';
import { MOBILE_LAYOUT_QUERY } from '@/lib/use-media-query';
import { readStored, writeStored } from '@/lib/utils';
import type { PreviewTarget } from '../panels/sidebarViews';
import { createStore, resolve } from '@/lib/store';
import { STORAGE_KEYS } from './navStore';

export const DOCK_MIN = 160, DOCK_MAX = 560, DOCK_DEFAULT = 280;
/** The defaults are the widths the layout's breakpoints were drawn for. */
export const SIDEBAR_MIN = 208, SIDEBAR_MAX = 400, SIDEBAR_DEFAULT = 280;
export const PANEL_MIN = 320, PANEL_MAX = 720, PANEL_DEFAULT = 380;
/** Whatever width was stored, the sidebar never takes more of the window than this. */
const SIDEBAR_SHARE = 0.4;

/**
 * The narrowest window that docks the context panel beside the conversation (1200px, or 1024px with
 * the sidebar collapsed, at the default widths); every pixel either pane grows moves it as far.
 * Linear in both widths, so a limit for one pane is the window minus this with the other at 0.
 */
export function panelDockMinWidth(sidebarWidth: number | undefined, panelWidth: number) {
  return (sidebarWidth === undefined ? 1024 : 1200 + sidebarWidth - SIDEBAR_DEFAULT) + panelWidth - PANEL_DEFAULT;
}

/** The widest the sidebar can be dragged in the current window. */
export function sidebarMaxWidth() {
  return Math.min(SIDEBAR_MAX, Math.floor(window.innerWidth * SIDEBAR_SHARE));
}

/**
 * Pane widths reach the layout as CSS variables on the root, so a drag restyles the panes each
 * frame without rendering the workbench; the store only learns the width once the drag settles.
 */
export function paintPaneWidth(pane: 'sidebar' | 'panel', width: number) {
  const style = document.documentElement.style;
  if (pane === 'sidebar') style.setProperty('--sidebar-w', `min(${width}px, ${SIDEBAR_SHARE * 100}vw)`);
  else style.setProperty('--panel-w', `${width}px`);
}

/** Where a floating context panel sits in its container, and which container edges it stays attached to. */
export interface PanelFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** An attached edge keeps its inset when the container resizes; unattached frames are only clamped. */
  ax?: 'left' | 'right';
  ay?: 'top' | 'bottom';
}

const PANEL_FLOAT_KEY = 'riffet.panelFloat';

function storedFloat(): { panelFloating: boolean; panelFrame?: PanelFrame } {
  try {
    const value = JSON.parse(readStored(PANEL_FLOAT_KEY) || '{}') as { floating?: unknown; frame?: Partial<PanelFrame> };
    const frame = value.frame;
    const valid = frame && [frame.x, frame.y, frame.w, frame.h].every((n) => typeof n === 'number' && Number.isFinite(n));
    return {
      panelFloating: value.floating === true,
      ...(valid ? { panelFrame: {
        x: frame.x!, y: frame.y!, w: frame.w!, h: frame.h!,
        ...(frame.ax === 'left' || frame.ax === 'right' ? { ax: frame.ax } : {}),
        ...(frame.ay === 'top' || frame.ay === 'bottom' ? { ay: frame.ay } : {}),
      } } : {}),
    };
  } catch { return { panelFloating: false }; }
}

function storedWidth(key: string, min: number, max: number, fallback: number) {
  const value = Number(readStored(key));
  return value ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/** A specific provider action requested when opening 设置 › 模型提供商 (e.g. from a plugin's page). */
export type ProviderSettingsTarget =
  | { kind: 'edit'; backendId: NativeBackendId; profileId: string; token: number }
  | { kind: 'add'; backendId?: NativeBackendId; modelSource: string; token: number };

export interface UiState {
  sidebarCollapsed: boolean;
  mobileSidebar: boolean;
  /** Explicit desktop override for the member page's in-page conversation list (`undefined` = auto). */
  memberSessionsOpen?: boolean;
  /** Mobile sheet for switching a member's conversations (main chat + incoming `@member` calls). */
  mobileMemberSessions: boolean;
  panelOpen: boolean;
  /** The context panel spans everything right of the sidebar, over the conversation. */
  panelFullscreen: boolean;
  /** The context panel floats over the conversation instead of docking beside it; a layout preference, not per conversation. */
  panelFloating: boolean;
  /** The floating panel's frame; unset until it has been moved, then it opens attached top-right. */
  panelFrame?: PanelFrame;
  previewTarget?: PreviewTarget;
  /** What the extensions page shows when it next opens from elsewhere, such as the 助理's home; `at` tells two requests apart. */
  extensionsFocus?: { projectId: string; backendId: NativeBackendId; kind: ExtensionKind; at: number };
  /** The side panel's view, by id; one that is not offered for the project shows the first that is. */
  panelTab: string;
  dockOpen: boolean;
  /** The 会话信息 popover in the header; a shortcut outside the header opens it too. */
  sessionInfoOpen: boolean;
  dockHeight: number;
  sidebarWidth: number;
  panelWidth: number;
  selectedTerminalId: string;
  /** A provider to open or pre-select for creation when 设置 › 模型提供商 mounts. */
  pendingProviderTarget?: ProviderSettingsTarget;
  paletteOpen: boolean;
  searchOpen: boolean;
  addProjectOpen: boolean;
  /** The picker for conversations started in a terminal; `projectId` narrows it to one project's directory. */
  importSession?: { projectId?: string };
  /** Fallback browser for hosts whose native folder chooser cannot be driven. */
  sessionDirectoryOpen: boolean;
  /** The server that `DirectoryPicker` opens on (`''` is the entry server; undefined falls back to the current project's). */
  sessionDirectoryServer?: string;
  references: PromptContextReference[];
  creating: boolean;
  creatingWorktree: boolean;
  startingNativeId?: string;
  nativeRunSeed?: { sessionId: string; run: Run };
}

type Toggle = boolean | ((value: boolean) => boolean);
const phone = () => window.matchMedia(MOBILE_LAYOUT_QUERY).matches;

/** Panels, overlays and the transient state of in-flight actions. */
export function createUiStore() {
  const store = createStore<UiState>({
    sidebarCollapsed: readStored(STORAGE_KEYS.sidebar) === '1',
    mobileSidebar: false,
    mobileMemberSessions: false,
    panelOpen: false,
    panelFullscreen: false,
    ...storedFloat(),
    panelTab: 'changes',
    dockOpen: false,
    sessionInfoOpen: false,
    dockHeight: Math.min(DOCK_MAX, Math.max(DOCK_MIN, Number(readStored(STORAGE_KEYS.dock)) || DOCK_DEFAULT)),
    sidebarWidth: storedWidth(STORAGE_KEYS.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT),
    panelWidth: storedWidth(STORAGE_KEYS.panelWidth, PANEL_MIN, PANEL_MAX, PANEL_DEFAULT),
    selectedTerminalId: '',
    paletteOpen: false,
    searchOpen: false,
    addProjectOpen: false,
    sessionDirectoryOpen: false,
    references: [],
    creating: false,
    creatingWorktree: false,
  });
  let previewToken = 0;
  let providerTargetToken = 0;
  let floatSaved = '';
  /**
   * The side panel belongs to a conversation: the view of each one that left it open, keyed by
   * session id ('' is the new-conversation page). Closing the panel or deleting the conversation
   * drops its entry, so this never outgrows the session list.
   */
  const panelBySession = new Map<string, string>();
  /**
   * Shells belong to a project, so the dock does too: it stays across that project's conversations
   * and comes back, on the same tab, when the reader returns. Closing the dock drops the entry.
   */
  const dockByProject = new Map<string, string>();
  store.subscribe(() => {
    const { panelFloating, panelFrame } = store.get();
    const next = panelFloating || panelFrame ? JSON.stringify({ floating: panelFloating, frame: panelFrame }) : '';
    if (next === floatSaved) return;
    floatSaved = next;
    writeStored(PANEL_FLOAT_KEY, next || undefined);
  });

  // Desktop panels can coexist. Phone surfaces are mutually exclusive. These are plain functions on
  // a stable object because file links and asynchronous terminal creation retain them across resizes.
  const actions = {
    setMobileSidebar(next: Toggle) {
      const value = resolve(next, store.get().mobileSidebar);
      store.set(value ? { mobileSidebar: true, panelOpen: false, dockOpen: false } : { mobileSidebar: false });
    },
    setPanelOpen(next: Toggle) {
      const value = resolve(next, store.get().panelOpen);
      store.set(value && phone() ? { panelOpen: true, mobileSidebar: false, dockOpen: false } : { panelOpen: value });
    },
    setDockOpen(next: Toggle) {
      const value = resolve(next, store.get().dockOpen);
      store.set(value && phone() ? { dockOpen: true, mobileSidebar: false, panelOpen: false } : { dockOpen: value });
    },
    setSidebarCollapsed(next: Toggle) { store.set({ sidebarCollapsed: resolve(next, store.get().sidebarCollapsed) }); },
    /** Leaving the phone layout closes the sidebar sheet; if both desktop panels were open, files win. */
    layoutChanged(desktop: boolean) {
      const { panelOpen } = store.get();
      store.set(!desktop && panelOpen ? { mobileSidebar: false, dockOpen: false } : { mobileSidebar: false });
    },
    /**
     * Moving from one conversation to another stores the panel with the one left and restores the
     * one entered. The new-conversation page hands an open panel to the conversation it creates.
     */
    switchSession(previous: string, next: string) {
      const { panelOpen, panelTab, creating } = store.get();
      if (panelOpen) panelBySession.set(previous, panelTab); else panelBySession.delete(previous);
      if (previous === '' && creating && panelOpen && !panelBySession.has(next)) {
        panelBySession.delete('');
        panelBySession.set(next, panelTab);
      }
      const tab = phone() ? undefined : panelBySession.get(next);
      store.set(tab ? { panelOpen: true, panelTab: tab } : { panelOpen: false });
    },
    /** Leaving a project stores its dock; the project entered shows its own, closed if never opened. */
    switchProject(previous: string, next: string) {
      const { dockOpen, selectedTerminalId } = store.get();
      if (dockOpen) dockByProject.set(previous, selectedTerminalId); else dockByProject.delete(previous);
      const tab = phone() ? undefined : dockByProject.get(next);
      store.set(tab === undefined ? { dockOpen: false } : { dockOpen: true, selectedTerminalId: tab });
    },
    /** Drops the panels of conversations that no longer exist. */
    keepSessionPanels(live: ReadonlySet<string>) {
      for (const id of panelBySession.keys()) if (id && !live.has(id)) panelBySession.delete(id);
    },
    /** Primary file affordance: reveal the file in the right-hand context panel instead of leaving the app. */
    preview(path: string, line?: number) {
      previewToken += 1;
      store.set({ previewTarget: { path, ...(line === undefined ? {} : { line }), token: previewToken }, panelTab: 'files' });
      actions.setPanelOpen(true);
    },
    addReference(reference: PromptContextReference) {
      store.set((current) => ({ references: current.references.some((item) => sameContextReference(item, reference)) ? current.references : [...current.references, reference] }));
    },
    setReferences(next: PromptContextReference[] | ((value: PromptContextReference[]) => PromptContextReference[])) { store.set({ references: resolve(next, store.get().references) }); },
    openSearch() { store.set({ searchOpen: true, paletteOpen: false, mobileSidebar: false }); },
    openImportSession(projectId?: string) { store.set({ importSession: projectId ? { projectId } : {}, paletteOpen: false, searchOpen: false, mobileSidebar: false }); },
    openPalette() { store.set({ paletteOpen: true, searchOpen: false, mobileSidebar: false }); },
    /** Records a provider target to open or pre-select when 设置 › 模型提供商 mounts. */
    setProviderTarget(target: { kind: 'edit'; backendId: NativeBackendId; profileId: string } | { kind: 'add'; backendId?: NativeBackendId; modelSource: string }) {
      providerTargetToken += 1;
      store.set({ pendingProviderTarget: { ...target, token: providerTargetToken } });
    },
    clearProviderTarget(token?: number) {
      store.set((current) => token === undefined || current.pendingProviderTarget?.token === token ? { pendingProviderTarget: undefined } : current);
    },
  };
  return { ...store, ...actions };
}

export type UiStore = ReturnType<typeof createUiStore>;
