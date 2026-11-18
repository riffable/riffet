import { ASSISTANT_QUERY_BUDGET, CODE_THEME_AUTO, isCustomCodeThemeId, isKnownCodeThemeId, WORKBENCH_APPEARANCE_BUDGET } from '@contracts';
import { settingsSections } from '../app/settings/settingsSections';
import { BUILTIN_CODE_THEMES } from './code-themes.generated';
import {
  densities, getDisplaySettings, MAX_TERMINAL_PADDING_HORIZONTAL, MAX_TERMINAL_PADDING_VERTICAL,
  readWorkbenchDisplaySettings, saveWorkbenchDisplaySettings, terminalFontSizes, textScales, type DisplaySettings,
} from './display-settings';
import { currentPlugins, localizedText } from './plugins';
import { currentWorkbenchAppearance, workbenchThemePreferences } from './theme';
import { currentThemeLibrary, themeOption, themeOptions } from './theme-library';
import { isRecord, reconnectDelay } from './utils';

let requestConnection: (() => Promise<string | undefined> | undefined) | undefined;
let documentProofUsed = false;

function takeInitialDocumentProof(): string | undefined {
  if (typeof window === 'undefined' || window.self !== window.top || import.meta.env.MODE === 'share') return undefined;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="riffet-workbench-proof"]');
  const proof = meta?.content;
  meta?.remove();
  return proof;
}

let initialDocumentProof = takeInitialDocumentProof();

/** A sign-in can reconnect in this document while an unused proof remains. */
export function needsWorkbenchDocumentReload(): boolean {
  return documentProofUsed && !initialDocumentProof;
}

/** Captures this workbench connection at send time, without following a later reconnect. */
export function workbenchAppearanceConnection(): Promise<string | undefined> | undefined {
  return requestConnection?.();
}

const displayKeys: ReadonlySet<string> = new Set<keyof DisplaySettings>(['textSize', 'density', 'terminalFontSize', 'terminalPaddingHorizontal', 'terminalPaddingVertical', 'codeTheme']);
const fontSizes: readonly number[] = terminalFontSizes;
const textSizes: readonly string[] = Object.keys(textScales);
const densityChoices: readonly string[] = densities;
const horizontal = { min: 0, max: MAX_TERMINAL_PADDING_HORIZONTAL };
const vertical = { min: 0, max: MAX_TERMINAL_PADDING_VERTICAL };
const padding = (value: unknown, max: number): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
const codeThemeAvailable = (value: unknown): boolean => typeof value === 'string' && (value === CODE_THEME_AUTO || isKnownCodeThemeId(value)
  || (isCustomCodeThemeId(value) && currentThemeLibrary().themes.some(theme => theme.id === value && Boolean(theme.syntax))));

function displayPatch(change: Record<string, unknown>): Partial<DisplaySettings> | undefined {
  const { textSize, density, terminalFontSize, terminalPaddingHorizontal, terminalPaddingVertical, codeTheme } = change;
  if ((textSize !== undefined && (typeof textSize !== 'string' || !textSizes.includes(textSize)))
    || (density !== undefined && (typeof density !== 'string' || !densityChoices.includes(density)))
    || (terminalFontSize !== undefined && (typeof terminalFontSize !== 'number' || !fontSizes.includes(terminalFontSize)))
    || (terminalPaddingHorizontal !== undefined && !padding(terminalPaddingHorizontal, horizontal.max))
    || (terminalPaddingVertical !== undefined && !padding(terminalPaddingVertical, vertical.max))
    || (codeTheme !== undefined && !codeThemeAvailable(codeTheme))) return undefined;
  return change as Partial<DisplaySettings>;
}

function applyDisplayPatch(patch: Partial<DisplaySettings>): () => boolean {
  const keys = Object.keys(patch) as Array<keyof DisplaySettings>;
  const before = readWorkbenchDisplaySettings();
  const saved = saveWorkbenchDisplaySettings(patch);
  const previous = Object.fromEntries(keys.map(key => [key, before[key]])) as Partial<DisplaySettings>;
  return () => {
    const current = readWorkbenchDisplaySettings();
    if (keys.some(key => current[key] !== saved[key]) || (previous.codeTheme !== undefined && !codeThemeAvailable(previous.codeTheme))) return false;
    saveWorkbenchDisplaySettings(previous);
    return true;
  };
}

function displayChoices() {
  const codeThemes = [
    { id: CODE_THEME_AUTO, name: CODE_THEME_AUTO },
    ...BUILTIN_CODE_THEMES.map(({ id, name }) => ({ id, name })),
    ...currentThemeLibrary().themes.filter(theme => theme.syntax).map(({ id, name }) => ({ id, name })),
  ];
  return {
    textSize: textSizes, density: densities, terminalFontSize: terminalFontSizes,
    terminalPaddingHorizontal: horizontal, terminalPaddingVertical: vertical,
    codeThemes: codeThemes.slice(0, WORKBENCH_APPEARANCE_BUDGET.themes),
  };
}

/** Settings destinations only. Reading the directory does not activate plugins or expose their values. */
function settingsPages() {
  const result = settingsSections.map(({ id, label, parent }) => ({ id: String(id), label, ...(parent ? { parent: String(parent) } : {}) }));
  for (const plugin of currentPlugins() ?? []) {
    if (plugin.rejected) continue;
    const { declared } = plugin;
    const title = localizedText(plugin.title) ?? plugin.name;
    if (declared?.page || plugin.settings.length) result.push({ id: plugin.id, label: title.slice(0, 100), parent: 'plugins' });
    for (const view of declared?.views ?? []) {
      if (!view.clients.includes('web') || !view.locations.includes('settings')) continue;
      result.push({ id: view.id, label: (localizedText(view.title) ?? view.id).slice(0, 100), parent: plugin.id });
      if (result.length >= ASSISTANT_QUERY_BUDGET.pageItems) break;
    }
    if (result.length >= ASSISTANT_QUERY_BUDGET.pageItems) break;
  }
  return result.slice(0, ASSISTANT_QUERY_BUDGET.pageItems);
}

function resultFor(change: unknown, history: { undo?: () => boolean }) {
  if (!isRecord(change)) return { error: 'unsupported' };
  const keys = Object.keys(change);
  const isUndo = keys.length === 1 && change.undo === true;
  const settingDisplay = keys.some(key => displayKeys.has(key));
  if (!isUndo && keys.some(key => settingDisplay ? !displayKeys.has(key) : key !== 'themeId' && key !== 'mode')) return { error: 'unsupported' };
  const { themeId, mode } = change;
  if (themeId !== undefined && (typeof themeId !== 'string' || !themeOption(themeId))) return { error: 'unsupported' };
  if (mode !== undefined && mode !== 'system' && mode !== 'light' && mode !== 'dark') return { error: 'unsupported' };
  const patch = settingDisplay ? displayPatch(change) : undefined;
  if (settingDisplay && !patch) return { error: 'unsupported' };
  try {
    if (isUndo) {
      if (!history.undo) return { error: 'unsupported' };
      if (!history.undo()) return { error: 'conflict' };
      delete history.undo;
    } else if (patch) {
      history.undo = applyDisplayPatch(patch);
    } else if (keys.length) {
      history.undo = workbenchThemePreferences({ themeId, mode });
    }
    const themes = themeOptions().slice(0, WORKBENCH_APPEARANCE_BUDGET.themes).map(({ id, name }) => ({ id, name }));
    return { result: { ...currentWorkbenchAppearance(), themes, display: getDisplaySettings(), ...(isUndo ? { undone: true } : {}),
      ...(!keys.length ? { displayOptions: displayChoices(), settingsPages: settingsPages() } : {}) } };
  } catch {
    return { error: 'unavailable' };
  }
}

/** The authenticated top-level workbench holds one command channel for its document. */
export function connectWorkbenchAppearance(): () => void {
  if (window.self !== window.top || import.meta.env.MODE === 'share') return () => {};
  const url = new URL('/api/workbench/appearance', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let proof: string | undefined;
  let proofSubmitted = false;
  let active = true;
  let suspended = false;
  let requested = false;
  let retry: number | undefined;
  let attempts = 0;
  let connection: Promise<string | undefined> | undefined;
  let close: (() => void) | undefined;

  const connect = () => {
    if (!active || suspended || !proof || close) return;
    let socket: WebSocket;
    try { socket = new WebSocket(url); } catch { return; }
    let resolveConnection!: (id: string | undefined) => void;
    const ready = new Promise<string | undefined>(resolve => { resolveConnection = resolve; });
    connection = ready;
    const handshakeTimeout = window.setTimeout(() => {
      disposeSocket();
      socket.close();
    }, WORKBENCH_APPEARANCE_BUDGET.proofMs);
    const receipts = new Map<string, string>();
    const history: { undo?: () => boolean } = {};
    let accepted = false;

    socket.addEventListener('open', () => {
      if (connection !== ready || !proof || !active || suspended || socket.readyState !== WebSocket.OPEN) return socket.close();
      proofSubmitted = true;
      socket.send(JSON.stringify({ documentProof: proof }));
    });
    socket.addEventListener('message', (event) => {
      if (connection !== ready || !active || suspended || typeof event.data !== 'string' || socket.readyState !== WebSocket.OPEN) return;
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!isRecord(message)) return;
      if (!accepted) {
        if (typeof message.connectionId !== 'string' || typeof message.nextDocumentProof !== 'string') return;
        accepted = true;
        proof = message.nextDocumentProof;
        proofSubmitted = false;
        attempts = 0;
        window.clearTimeout(handshakeTimeout);
        resolveConnection(message.connectionId);
        return;
      }
      const { callId, deadline, change } = message;
      if (typeof callId !== 'string' || typeof deadline !== 'string') return;
      const previous = receipts.get(callId);
      if (previous) return socket.send(previous);
      if (!(Date.parse(deadline) > Date.now())) return;
      const receipt = JSON.stringify({ callId, ...resultFor(change, history) });
      receipts.set(callId, receipt);
      if (receipts.size > WORKBENCH_APPEARANCE_BUDGET.receiptsPerConnection) {
        const oldest = receipts.keys().next().value;
        if (oldest !== undefined) receipts.delete(oldest);
      }
      socket.send(receipt);
    });
    const disposeSocket = () => {
      window.clearTimeout(handshakeTimeout);
      if (connection === ready) connection = undefined;
      resolveConnection(undefined);
      receipts.clear();
      delete history.undo;
    };
    const retire = () => { disposeSocket(); socket.close(); };
    close = retire;
    socket.addEventListener('close', (event) => {
      disposeSocket();
      if (close !== retire) return;
      close = undefined;
      // An open socket doesn't mean the server received the proof. A rejected or already
      // spent proof needs a fresh document. A transport failure can retry on the next send.
      if (!accepted && event.code === 1008) proof = undefined;
      if (accepted && active && !suspended && proof) retry = window.setTimeout(connect, reconnectDelay(++attempts));
    });
  };
  const onRequest = () => {
    requested = true;
    if (!connection) {
      window.clearTimeout(retry);
      connect();
    }
    return connection;
  };
  // The real authenticated mount takes ownership after StrictMode's trial effect is cleaned up.
  queueMicrotask(() => {
    if (!active || !initialDocumentProof) return;
    proof = initialDocumentProof;
    initialDocumentProof = undefined;
    documentProofUsed = true;
    requestConnection = onRequest;
  });
  const dispose = () => {
    active = false;
    // The handshake authorizes every socket independently. A proven document
    // can retain an unused proof when its authenticated component remounts.
    if (proof && !proofSubmitted) initialDocumentProof = proof;
    proof = undefined;
    if (requestConnection === onRequest) requestConnection = undefined;
    window.clearTimeout(retry);
    close?.();
  };
  const pageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) return dispose();
    suspended = true;
    window.clearTimeout(retry);
    close?.();
    close = undefined;
  };
  const pageShow = () => {
    if (!suspended) return;
    suspended = false;
    if (requested) connect();
  };
  window.addEventListener('pagehide', pageHide);
  window.addEventListener('pageshow', pageShow);
  return () => {
    window.removeEventListener('pagehide', pageHide);
    window.removeEventListener('pageshow', pageShow);
    dispose();
  };
}
