import { DESKTOP_STYLE, DESKTOP_TEXT, type DesktopStyle, type DesktopStyleLength } from '@contracts';
import type { CompareColumn } from '../compare';

/** What the macOS chapters draw from: the one style in `packages/contracts/src/interface-styles.ts`. */
export const STYLE: DesktopStyle = DESKTOP_STYLE;

/** The Mac draws one style: a value table's single column, its heading left out. */
export const COLUMNS: readonly CompareColumn[] = [{ id: 'riffet', title: 'Riffet' }];

/**
 * A style length in points: a number as written, or the web token it names. A text token is read
 * from the desktop ladder, since the painted one carries the reader's text scale and the Mac applies
 * its own; any other token is read as painted.
 */
export function points(value: DesktopStyleLength): number {
  if (typeof value === 'number') return value;
  const step = /^--text-(.+)$/.exec(value)?.[1];
  if (step && step in DESKTOP_TEXT) return DESKTOP_TEXT[step as keyof typeof DESKTOP_TEXT][0];
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(value)) || 0;
}

/** The typefaces as CSS stacks: `system` is the Mac's own face; a bundled family falls back to it. */
const STACKS: Record<string, string> = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif',
  'system-mono': '"SF Mono", ui-monospace, Menlo, "PingFang SC", monospace',
  Inter: '"Inter Variable", "Inter", -apple-system, "PingFang SC", sans-serif',
  'JetBrains Mono': '"JetBrains Mono Variable", "JetBrains Mono", "SF Mono", ui-monospace, monospace',
};
export const fontStack = (family: string, mono = false) => STACKS[mono && family === 'system' ? 'system-mono' : family] ?? `"${family}", ${mono ? STACKS['system-mono'] : STACKS.system}`;

/**
 * The Mac's sizes that are not style tokens, as the app sets them (docs/design/system/macos.md).
 * They are written in Swift; each names its source, and a change there is copied here.
 */
export const MAC = {
  /** `Features/Workbench/WorkbenchView.swift`, `CustomWorkbench.swift`. */
  sidebar: { min: 210, max: 400 },
  /** The session column's floor, which the sidebar folds away to keep. */
  mainMin: 420,
  /** Right panel: at least 300, at most the window less the session's floor. */
  panelMin: 300,
  terminal: { min: 140, default: 240 },
  /** `Column.width` (`Theme/Controls.swift`), the reader's preference (`App/Preferences.swift`). */
  reading: { min: 640, max: 1600, default: 760, gutter: 28 },
  /** The inset around the content card. */
  cardInset: 8,
  /** `Features/Settings/SettingsView.swift`. */
  settings: { sidebar: { min: 200, ideal: 228, max: 270 }, window: { min: [820, 600], ideal: [880, 780] } },
  /** `Theme/DrawnMenu.swift` (`MenuMetric`). */
  menu: { pad: 4, row: 32, subtitleRow: 44, header: 28, minWidth: 176, maxWidth: 360 },
  /** The page skeleton and the sheet widths, the same numbers as the web (macos.md §3.2, §4.2). */
  page: { document: 768, board: 1200, inline: 32, top: 40, bottom: 64 },
  sheet: { inset: 20, widths: [420, 512, 768, 1080] as const },
} as const;
