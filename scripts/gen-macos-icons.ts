import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as phosphor from '@phosphor-icons/react';
import { DOMParser } from '@xmldom/xmldom';
import { Path2D } from '@napi-rs/canvas';
import { toPath } from './svg-icon-path.js';

/**
 * Generates the macOS app's icon packs: one custom SF Symbol template per (pack, semantic key), in
 * `apps/macos/Riffet/Resources/Icons.xcassets`, so an `Image` drawn from a pack scales with `.font`,
 * sits on the text baseline and takes `foregroundStyle` exactly as `Image(systemName:)` does.
 *
 * - `apps/macos/scripts/icon-map.json` is the one hand-kept vocabulary: SF Symbol name -> semantic key.
 * - Android's keys and glyphs are read from its checked-in outputs (`LucideIcons.generated.kt`,
 *   `BuiltinIconPacks.generated.kt`), so both platforms draw the same pack from the same sources. A key the
 *   Android set lacks (`KEYS` below) takes its glyph by name from lucide-react and Phosphor.
 * - A pack without a glyph for a key uses lucide's, as Android does. `web` is the web app's own family: lucide at its 1.25 stroke.
 * - Custom symbols are filled outlines: stroked glyphs (lucide, tabler) are stroked and merged with Skia
 *   (`@napi-rs/canvas`'s Path2D, installed through pdfjs-dist) into one outline per glyph.
 *
 * `--check` fails when the output is stale. `--audit` lists SF Symbol names in the app's sources the map misses.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const macos = resolve(root, 'apps/macos');
const catalog = resolve(macos, 'Riffet/Resources/Icons.xcassets');
const swiftOut = resolve(macos, 'Riffet/Theme/IconSymbols.generated.swift');
const kotlinIcons = resolve(root, 'apps/mobile/shared/src/commonMain/kotlin/riffet/ui/icons');
const require = createRequire(resolve(root, 'package.json'));

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

const map = JSON.parse(readFileSync(resolve(macos, 'scripts/icon-map.json'), 'utf8')) as { system: string[]; ignore: string[]; symbols: Record<string, string> };

/** Android's pack ids and display names (`BuiltinIconPacks.titles`), then the web's own mix. */
const PACKS: [id: string, title: string][] = [
  ['lucide', 'Lucide'], ['phosphor', 'Phosphor'], ['tabler', 'Tabler'], ['material-symbols', 'Material Symbols'], ['fluent', 'Fluent'],
  ['octicons', 'Octicons'], ['mdi', 'Material Design Icons'], ['remix', 'Remix Icon'], ['web', 'Riffet'],
];

/** lucide-react glyph: its file name, or a spec. `fill` also fills the closed outline; `solid` fills the first element and cuts the rest out of it. */
type Lucide = string | { n: string; fill?: boolean; solid?: boolean };
interface Key { l?: Lucide; p?: string | null; web: Lucide }

/**
 * The keys. An Android key (the 83 in `RiffetIcons`) carries only its web glyph; its lucide and pack glyphs come
 * from the Kotlin outputs (`p` fills a pack gap there). A key new to the Mac names its glyph in lucide (`l`) and
 * Phosphor (`p`, regular weight; null when it has none), which are what the other packs then fall back on.
 * The web column is the lucide glyph `apps/web/src/components/icons.tsx` uses for the concept, at the web's stroke; filled only where the web fills (`…Filled` on-states, transport controls).
 */
const KEYS: Record<string, Key> = {
  // Android keys.
  Archive: { web: 'archive' }, ArchiveRestore: { web: 'archive-restore' }, ArrowDown: { web: 'arrow-down' }, ArrowLeft: { web: 'arrow-left' },
  ArrowRightLeft: { web: 'arrow-right-left' }, Bell: { web: 'bell' }, Bookmark: { web: 'bookmark' }, Bot: { web: 'bot' }, Brain: { web: 'brain' },
  Branch: { web: 'git-branch' }, Bug: { web: 'bug' }, Chart: { web: 'chart-column' }, Check: { web: 'check' }, ChevronDown: { web: 'chevron-down' },
  ChevronLeft: { web: 'chevron-left' }, ChevronRight: { web: 'chevron-right' }, Circle: { web: 'circle' }, CircleAlert: { web: 'circle-alert' },
  CircleCheck: { web: 'circle-check' }, CircleDashed: { web: 'circle-dashed' }, Clock: { web: 'clock' }, Close: { web: 'x' }, Copy: { web: 'copy' },
  Dices: { p: 'DiceFive', web: 'dices' }, Download: { web: 'download' }, Ellipsis: { web: 'ellipsis' }, Error: { web: 'circle-x' },
  ExternalLink: { web: 'external-link' }, Eye: { web: 'eye' }, FilePenLine: { web: 'file-pen-line' }, FileText: { web: 'file-text' },
  Filter: { web: 'list-filter' }, Folder: { web: 'folder' }, FolderOpen: { web: 'folder-open' }, FolderPlus: { web: 'folder-plus' }, Globe: { web: 'globe' },
  House: { web: 'house' }, Image: { web: 'image' }, Info: { web: 'info' }, Layers: { web: 'layers' }, Link: { web: 'link' },
  ListTodo: { web: 'list-todo' }, Message: { web: 'message-square' }, MessageQuestion: { web: 'message-circle-question' },
  MessageSquarePlus: { web: 'square-pen' }, MessageSquarePlusFilled: { web: 'square-pen' }, Monitor: { web: 'monitor' }, Moon: { web: 'moon' },
  OctagonX: { web: 'octagon-x' }, Palette: { web: 'palette' }, Pencil: { web: 'pencil' }, Pin: { web: 'pin' }, PinOff: { web: 'pin-off' },
  Plus: { web: 'plus' }, Pointer: { web: 'pointer' }, Puzzle: { web: 'blocks' }, Refresh: { web: 'refresh-cw' }, Repeat: { web: 'repeat' },
  Reply: { web: 'reply' }, Search: { web: 'search' }, Send: { web: 'send' }, Settings: { web: 'settings' },
  SettingsFilled: { web: 'settings' }, Shield: { web: 'shield' }, ShieldHalf: { web: 'shield-half' }, Sliders: { web: 'settings-2' },
  SquareTerminal: { web: 'square-terminal' }, Star: { web: 'star' }, StarFilled: { web: { n: 'star', fill: true } }, Steer: { web: 'corner-up-right' }, Stop: { web: { n: 'square', fill: true } },
  Sun: { web: 'sun' }, Tag: { web: 'tag' }, Target: { web: 'target' }, Terminal: { web: 'terminal' }, Trash: { web: 'trash-2' }, User: { p: 'User', web: 'user' },
  Warning: { web: 'triangle-alert' }, Wrench: { web: 'wrench' }, Zap: { web: 'zap' },

  // New to the Mac.
  Activity: { l: 'activity', p: 'Pulse', web: 'activity' },
  ListFilter: { l: 'list-filter', p: 'FunnelSimple', web: 'list-filter' },
  AlignLeft: { l: 'align-left', p: 'TextAlignLeft', web: 'align-left' },
  AppBadge: { l: 'badge', p: 'Seal', web: 'badge' },
  AppWindow: { l: 'app-window', p: 'AppWindow', web: 'app-window' },
  ArrowRight: { l: 'arrow-right', p: 'ArrowRight', web: 'arrow-right' },
  ArrowToTop: { l: 'arrow-up-to-line', p: 'ArrowLineUp', web: 'arrow-up-to-line' },
  ArrowUp: { l: 'arrow-up', p: 'ArrowUp', web: 'arrow-up' },
  ArrowUpDown: { l: 'arrow-up-down', p: 'ArrowsDownUp', web: 'arrow-up-down' },
  ArrowUpRight: { l: 'arrow-up-right', p: 'ArrowUpRight', web: 'arrow-up-right' },
  AtSign: { l: 'at-sign', p: 'At', web: 'at-sign' },
  BookmarkFilled: { l: { n: 'bookmark', fill: true }, p: 'BookmarkSimple', web: { n: 'bookmark', fill: true } },
  BookmarkMinus: { l: 'bookmark-minus', p: null, web: 'bookmark-minus' },
  Braces: { l: 'braces', p: 'BracketsCurly', web: 'braces' },
  Briefcase: { l: 'briefcase', p: 'Briefcase', web: 'briefcase' },
  Calendar: { l: 'calendar', p: 'CalendarBlank', web: 'calendar' },
  CalendarClock: { l: 'calendar-clock', p: null, web: 'clock' },
  ChartLine: { l: 'chart-line', p: 'ChartLine', web: 'chart-line' },
  ChevronUp: { l: 'chevron-up', p: 'CaretUp', web: 'chevron-up' },
  ChevronsUpDown: { l: 'chevrons-up-down', p: 'CaretUpDown', web: 'chevrons-up-down' },
  CircleArrowDown: { l: 'circle-arrow-down', p: 'ArrowCircleDown', web: 'circle-arrow-down' },
  CircleCheckFilled: { l: { n: 'circle-check', solid: true }, p: 'CheckCircle', web: { n: 'circle-check', solid: true } },
  CircleDot: { l: 'circle-dot', p: 'RadioButton', web: 'circle-dot' },
  CircleFilled: { l: { n: 'circle', fill: true }, p: 'Circle', web: { n: 'circle', fill: true } },
  CircleHalf: { l: 'contrast', p: 'CircleHalf', web: 'contrast' },
  CircleHelp: { l: 'circle-help', p: 'Question', web: 'circle-help' },
  CircleInProgress: { l: 'circle-dot-dashed', p: null, web: 'circle-dot-dashed' },
  CirclePlay: { l: 'circle-play', p: 'PlayCircle', web: 'circle-play' },
  CircleStop: { l: 'circle-stop', p: 'StopCircle', web: 'circle-stop' },
  CircleUser: { l: 'circle-user', p: 'UserCircle', web: 'circle-user' },
  ClockAlert: { l: 'clock-alert', p: null, web: 'clock-alert' },
  Code: { l: 'code', p: 'Code', web: 'code' },
  Columns2: { l: 'columns-2', p: 'Columns', web: 'columns-2' },
  Columns3: { l: 'columns-3', p: 'Columns', web: 'columns-3' },
  Command: { l: 'command', p: 'Command', web: 'command' },
  CopyPlus: { l: 'copy-plus', p: null, web: 'copy-plus' },
  CornerDownRight: { l: 'corner-down-right', p: 'ArrowElbowDownRight', web: 'corner-down-right' },
  Cpu: { l: 'cpu', p: 'Cpu', web: 'cpu' },
  Devices: { l: 'monitor-smartphone', p: 'Devices', web: 'monitor-smartphone' },
  Diff: { l: 'diff', p: 'GitDiff', web: 'git-compare' },
  File: { l: 'file', p: 'File', web: 'file' },
  FileSearch: { l: 'file-search', p: 'FileMagnifyingGlass', web: 'file-search' },
  FolderFilled: { l: { n: 'folder', fill: true }, p: 'Folder', web: { n: 'folder', fill: true } },
  Gauge: { l: 'gauge', p: 'Gauge', web: 'gauge' },
  GitMerge: { l: 'git-merge', p: 'GitMerge', web: 'git-merge' },
  GitPullRequest: { l: 'git-pull-request', p: 'GitPullRequest', web: 'git-pull-request' },
  Hammer: { l: 'hammer', p: 'Hammer', web: 'hammer' },
  Hand: { l: 'hand', p: 'Hand', web: 'hand' },
  HardDrive: { l: 'hard-drive', p: 'HardDrive', web: 'hard-drive' },
  HardDriveDownload: { l: 'hard-drive-download', p: 'HardDrive', web: 'hard-drive-download' },
  Highlighter: { l: 'highlighter', p: 'Highlighter', web: 'highlighter' },
  History: { l: 'history', p: 'ClockCounterClockwise', web: 'history' },
  Hook: { l: 'webhook', p: 'WebhooksLogo', web: 'webhook' },
  Inbox: { l: 'inbox', p: 'Tray', web: 'inbox' },
  Laptop: { l: 'laptop', p: 'Laptop', web: 'laptop' },
  LayoutGrid: { l: 'layout-grid', p: 'SquaresFour', web: 'layout-grid' },
  ListBullet: { l: 'list', p: 'ListBullets', web: 'list' },
  ListChecks: { l: 'list-checks', p: 'ListChecks', web: 'list-checks' },
  Lock: { l: 'lock', p: 'Lock', web: 'lock' },
  Maximize: { l: 'maximize-2', p: 'CornersOut', web: 'maximize' },
  MemoryStick: { l: 'memory-stick', p: 'Memory', web: 'memory-stick' },
  MessageSquareText: { l: 'message-square-text', p: 'ChatCircleText', web: 'message-square-text' },
  MessageWarning: { l: 'message-square-warning', p: null, web: 'message-square-warning' },
  Messages: { l: 'messages-square', p: 'Chats', web: 'messages-square' },
  Minimize: { l: 'minimize-2', p: 'CornersIn', web: 'minimize' },
  Minus: { l: 'minus', p: 'Minus', web: 'minus' },
  Network: { l: 'network', p: 'Network', web: 'network' },
  NoWrap: { l: 'arrow-right-to-line', p: 'ArrowLineRight', web: 'arrow-right-to-line' },
  Package: { l: 'package', p: 'Package', web: 'package' },
  PanelLeft: { l: 'panel-left', p: 'SidebarSimple', web: 'panel-left' },
  PanelRight: { l: 'panel-right', p: 'SidebarSimple!', web: 'panel-right' },
  Paperclip: { l: 'paperclip', p: 'Paperclip', web: 'paperclip' },
  PencilLine: { l: 'pencil-line', p: 'PencilLine', web: 'pencil-line' },
  Play: { l: 'play', p: 'Play', web: { n: 'play', fill: true } },
  Plug: { l: 'plug', p: 'Plugs', web: 'plug' },
  Power: { l: 'power', p: 'Power', web: 'power' },
  QrCode: { l: 'qr-code', p: 'QrCode', web: 'qr-code' },
  Quote: { l: 'quote', p: 'Quotes', web: 'quote' },
  Save: { l: 'save', p: 'FloppyDisk', web: 'save' },
  Scissors: { l: 'scissors', p: 'Scissors', web: 'scissors' },
  Server: { l: 'server', p: 'HardDrives', web: 'server' },
  Share: { l: 'share', p: 'Export', web: 'share' },
  ShieldCheck: { l: 'shield-check', p: 'ShieldCheck', web: 'shield-check' },
  ShieldOff: { l: 'shield-off', p: 'ShieldSlash', web: 'shield-off' },
  Sparkle: { l: 'sparkle', p: 'Sparkle', web: 'sparkle' },
  Sparkles: { l: 'sparkles', p: null, web: 'sparkles' },
  Square: { l: 'square', p: 'Square', web: 'square' },
  SquareCheck: { l: 'square-check', p: 'CheckSquare', web: 'square-check' },
  SquareCheckFilled: { l: { n: 'square-check', solid: true }, p: 'CheckSquare', web: { n: 'square-check', solid: true } },
  SquareMinusFilled: { l: { n: 'square-minus', solid: true }, p: 'MinusSquare', web: { n: 'square-minus', solid: true } },
  SquarePen: { l: 'square-pen', p: 'NotePencil', web: 'square-pen' },
  Stethoscope: { l: 'stethoscope', p: 'Stethoscope', web: 'stethoscope' },
  TextCursor: { l: 'text-cursor-input', p: 'Textbox', web: 'text-cursor-input' },
  TextSize: { l: 'a-large-small', p: 'TextAa', web: 'a-large-small' },
  Timer: { l: 'timer', p: 'Timer', web: 'timer' },
  Undo: { l: 'rotate-ccw', p: 'ArrowCounterClockwise', web: 'undo-2' },
  WandSparkles: { l: 'wand-sparkles', p: 'MagicWand', web: 'wand-sparkles' },
  WifiOff: { l: 'wifi-off', p: 'WifiSlash', web: 'wifi-off' },
  WrapText: { l: 'wrap-text', p: null, web: 'wrap-text' },
};

// ---------------------------------------------------------------------------------------------
// Glyph sources
// ---------------------------------------------------------------------------------------------

/** One drawn element: filled, stroked, or (`cut`) stroked and subtracted from what is drawn. */
interface Part { d: string; fill: boolean; stroke: number; cap: number; join: number; evenodd: boolean; cut?: boolean }
interface Glyph { w: number; h: number; parts: Part[]; mirror?: boolean }

const CAP: Record<string, number> = { butt: 0, round: 1, square: 2 };
const JOIN: Record<string, number> = { miter: 0, round: 1, bevel: 2 };
/** Android's lucide stroke (`gen-mobile-icons.ts` STROKE). */
const ANDROID_STROKE = 1.75;
/**
 * The web draws lucide at a constant 1.25 screen px (`icons-base.tsx` STROKE_WIDTH with
 * `non-scaling-stroke`). A symbol's stroke scales with it, so the web's line is matched at a 16pt
 * box (BOX: a 12.7pt font), between the sidebar's 12pt and the toolbar's 13pt: 1.25 × 24 / 16.
 */
const WEB_STROKE = 1.875;

function kotlinFile(name: string): string {
  return readFileSync(join(kotlinIcons, name), 'utf8');
}

function androidLucide(): Record<string, Glyph> {
  const source = kotlinFile('LucideIcons.generated.kt');
  const glyphs: Record<string, Glyph> = {};
  for (const m of source.matchAll(/lucide\(\s*"(\w+)",\s*"([^"]*)",((?:\s*\w+ = (?:[\d.]+f|true),)*)/g)) {
    const stroke = Number(/strokeWidth = ([\d.]+)f/.exec(m[3]!)?.[1] ?? ANDROID_STROKE);
    glyphs[m[1]!] = { w: 24, h: 24, parts: [{ d: m[2]!, fill: /filled = true/.test(m[3]!), stroke, cap: 1, join: 1, evenodd: false }] };
  }
  if (!Object.keys(glyphs).length) throw new Error('No glyphs found in LucideIcons.generated.kt');
  return glyphs;
}

function androidPacks(): Record<string, Record<string, Glyph>> {
  const source = kotlinFile('BuiltinIconPacks.generated.kt');
  const packs: Record<string, Record<string, Glyph>> = {};
  let current: Record<string, Glyph> | undefined;
  for (const line of source.split('\n')) {
    const start = /^    val (\w+) by lazy \{ IconPackDocument/.exec(line);
    if (start) { current = packs[start[1] === 'material' ? 'material-symbols' : start[1]!] = {}; continue; }
    const glyph = /^\s+"(\w+)" to IconGlyph\(([\d.]+)f, ([\d.]+)f, listOf\((.*)\)\),?$/.exec(line);
    if (!glyph || !current) continue;
    const parts: Part[] = [...glyph[4]!.matchAll(/IconPath\(d = "([^"]*)", fill = (true|false), strokeWidth = ([\d.]+)f, lineCap = "(\w+)", lineJoin = "(\w+)", fillRule = "(\w+)"\)/g)]
      .map(p => ({ d: p[1]!, fill: p[2] === 'true', stroke: Number(p[3]), cap: CAP[p[4]!]!, join: JOIN[p[5]!]!, evenodd: p[6] === 'evenodd' }));
    current[glyph[1]!] = { w: Number(glyph[2]), h: Number(glyph[3]), parts };
  }
  return packs;
}

/** lucide-react's own element list for a glyph, as the Android generator reads it. */
function lucideNodes(name: string): [string, Record<string, string | number>][] {
  const lucideRoot = dirname(require.resolve('lucide-react/package.json'));
  const file = resolve(lucideRoot, 'dist/esm/icons', name + '.js');
  if (!existsSync(file)) throw new Error('lucide-react has no glyph "' + name + '"');
  const source = readFileSync(file, 'utf8');
  const alias = /export \{ default \} from '\.\/([\w-]+)\.js'/.exec(source);
  if (alias) return lucideNodes(alias[1]!);
  const match = source.match(/const __iconNode = (\[[\s\S]*?\]);\s*\nconst /);
  if (!match) throw new Error('Cannot find __iconNode in ' + file);
  return Function('return ' + match[1])() as [string, Record<string, string | number>][];
}

function lucideGlyph(spec: Lucide, stroke: number): Glyph {
  const { n, fill = false, solid = false } = typeof spec === 'string' ? { n: spec } : spec;
  const nodes = lucideNodes(n);
  const part = (node: (typeof nodes)[number], extra: Partial<Part>): Part => ({ d: toPath(node), fill: false, stroke, cap: 1, join: 1, evenodd: false, ...extra });
  if (solid) return { w: 24, h: 24, parts: nodes.map((node, i) => i === 0 ? part(node, { fill: true }) : part(node, { cut: true })) };
  return { w: 24, h: 24, parts: nodes.map(node => part(node, { fill })) };
}

/** An SVG string -> parts, for the Phosphor components rendered to markup. */
function glyphFromSvg(svg: string, mirror = false): Glyph {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement!;
  const [x, y, w, h] = root.getAttribute('viewBox')!.split(/[ ,]+/).map(Number);
  if (x !== 0 || y !== 0) throw new Error('Unexpected viewBox origin');
  const parts: Part[] = [];
  const walk = (element: typeof root, inherited: Record<string, string>) => {
    const attrs = { ...inherited };
    for (let i = 0; i < element.attributes.length; i++) { const a = element.attributes.item(i)!; attrs[a.name] = a.value; }
    if (element.tagName === 'svg' || element.tagName === 'g') {
      for (let n = element.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) walk(n as typeof root, attrs);
      return;
    }
    if (!['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'].includes(element.tagName)) return;
    if (attrs.transform) throw new Error('Flatten transforms before importing');
    const fill = attrs.fill !== 'none';
    const stroke = attrs.stroke && attrs.stroke !== 'none' ? Number(attrs['stroke-width'] ?? 1) : 0;
    if (!fill && !stroke) return;
    parts.push({ d: toPath([element.tagName, attrs]), fill, stroke, cap: CAP[attrs['stroke-linecap'] ?? 'butt']!, join: JOIN[attrs['stroke-linejoin'] ?? 'miter']!, evenodd: attrs['fill-rule'] === 'evenodd' });
  };
  walk(root, {});
  return { w: w!, h: h!, parts, mirror };
}

function phosphorGlyph(spec: string, weight: 'regular' | 'fill'): Glyph {
  const mirror = spec.endsWith('!');
  const component = (phosphor as unknown as Record<string, ComponentType<{ weight: string }> | undefined>)[spec.replace('!', '')];
  if (!component) throw new Error('Phosphor has no icon ' + spec);
  return glyphFromSvg(renderToStaticMarkup(createElement(component, { weight })), mirror);
}

// ---------------------------------------------------------------------------------------------
// Resolving every key in every pack
// ---------------------------------------------------------------------------------------------

const lucideAndroid = androidLucide();
const packsAndroid = androidPacks();

function resolveGlyphs(): Record<string, Record<string, Glyph>> {
  const lucideGlyphs: Record<string, Glyph> = {};
  const out: Record<string, Record<string, Glyph>> = Object.fromEntries(PACKS.map(([id]) => [id, {}]));
  for (const [key, spec] of Object.entries(KEYS)) {
    const android = lucideAndroid[key];
    const lucide = android ?? (spec.l ? lucideGlyph(spec.l, ANDROID_STROKE) : undefined);
    if (!lucide) throw new Error('Key ' + key + ' has neither an Android glyph nor a lucide name');
    lucideGlyphs[key] = lucide;
    out.lucide![key] = lucide;
    for (const [id] of PACKS) {
      if (id === 'lucide' || id === 'web') continue;
      let glyph: Glyph | undefined;
      if (id === 'phosphor') {
        // Android's Phosphor glyph where it has one; the Mac's selected forms are Phosphor's fill weight, the rest its regular.
        const filled = /Filled$/.test(key);
        glyph = (!filled && packsAndroid.phosphor?.[key]) || (typeof spec.p === 'string' ? phosphorGlyph(spec.p, filled ? 'fill' : 'regular') : undefined);
      } else if (android) glyph = packsAndroid[id]?.[key];
      out[id]![key] = glyph ?? lucide;
    }
    out.web![key] = lucideGlyph(spec.web, WEB_STROKE);
  }
  return out;
}

/** Keys whose glyph in a pack is lucide's only because that pack (or its Android snapshot) has none. */
function fallbacks(glyphs: Record<string, Record<string, Glyph>>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [id] of PACKS) {
    if (id === 'lucide' || id === 'web') continue;
    result[id] = Object.keys(KEYS).filter(key => glyphs[id]![key] === glyphs.lucide![key]).sort();
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Geometry: filled outlines, sized like an SF Symbol
// ---------------------------------------------------------------------------------------------

const UNION = 2;
const DIFFERENCE = 0;

const NUM = String.raw`(-?(?:\d*\.\d+|\d+))`;
const MOVE_MOVE = new RegExp(String.raw`M\s*${NUM}[ ,]*${NUM}\s*(?:M|m\s*${NUM}[ ,]*${NUM})`, 'g');

/**
 * A move straight after a move (`M17 6m-2 0a...`, Tabler's circles, or the `M0 0` the Android generator puts before a leading `m`) is
 * a zero-length subpath, which Skia strokes as a round dot. Merge the two moves so no dot is drawn.
 */
function dropEmptyMoves(d: string): string {
  return d.replace(MOVE_MOVE, (match, x: string, y: string, dx: string | undefined, dy: string | undefined, at: number, whole: string) => {
    if (dx === undefined) return 'M';
    // What followed a relative `m`'s first pair were relative line-tos.
    const more = /^\s*[-.\d]/.test(whole.slice(at + match.length));
    return `M${Number(x) + Number(dx)} ${Number(y) + Number(dy)}` + (more ? 'l' : '');
  });
}

function partShape(part: Part) {
  const d = dropEmptyMoves(part.d);
  const pieces = [];
  if (part.fill) {
    const filled = new Path2D(d);
    if (part.evenodd) filled.setFillType(1);
    pieces.push(filled.simplify());
  }
  if (part.stroke > 0) pieces.push(new Path2D(d).stroke({ width: part.stroke, cap: part.cap, join: part.join, miterLimit: 4 } as never));
  return pieces.reduce((a, b) => a.op(b, UNION));
}

/** The glyph as one region in its own box units: no overlaps, so even-odd and nonzero agree. */
function outline(glyph: Glyph) {
  const unite = (parts: Part[]) => parts.map(partShape).reduce((a, b) => a.op(b, UNION));
  const drawn = glyph.parts.filter(part => !part.cut);
  if (!drawn.length) throw new Error('Glyph draws nothing');
  let shape = unite(drawn);
  const cuts = glyph.parts.filter(part => part.cut);
  if (cuts.length) shape = shape.op(unite(cuts), DIFFERENCE);
  return shape.simplify();
}

type Pt = [number, number];
/** How far (template units, 100 per em) a merged curve may stray from the quadratics it replaces. */
const CURVE_TOLERANCE = 0.1;

const quadAt = (p0: Pt, c: Pt, p1: Pt, t: number): Pt => [(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1]];

function distanceToPolyline(p: Pt, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const [ax, ay] = poly[i]!, [bx, by] = poly[i + 1]!;
    const dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
  }
  return best;
}

/** One quadratic through `from`..the last end of `run`, if it stays within tolerance of every original. */
function fitQuad(from: Pt, run: { c: string; n: number[] }[]): number[] | undefined {
  const quads = run.map((seg, i) => ({ p0: i ? ([run[i - 1]!.n.at(-2)!, run[i - 1]!.n.at(-1)!] as Pt) : from, c: [seg.n[0]!, seg.n[1]!] as Pt, p1: [seg.n[2]!, seg.n[3]!] as Pt }));
  const first = quads[0]!, last = quads.at(-1)!;
  const d0: Pt = [first.c[0] - first.p0[0], first.c[1] - first.p0[1]];
  const d1: Pt = [last.p1[0] - last.c[0], last.p1[1] - last.c[1]];
  const cross = d0[0] * d1[1] - d0[1] * d1[0];
  const chord = Math.hypot(last.p1[0] - from[0], last.p1[1] - from[1]);
  if (!chord) return undefined;
  let control: Pt;
  if (Math.abs(cross) < 0.02 * Math.hypot(...d0) * Math.hypot(...d1)) {
    // Tangents (nearly) parallel: a straight stretch, drawn as a line the quadratic degenerates to.
    control = [(from[0] + last.p1[0]) / 2, (from[1] + last.p1[1]) / 2];
  } else {
    const t = ((last.p1[0] - from[0]) * d1[1] - (last.p1[1] - from[1]) * d1[0]) / cross;
    const u = (d0[0] * (last.p1[1] - from[1]) - d0[1] * (last.p1[0] - from[0])) / cross;
    if (t <= 0 || u <= 0) return undefined;
    control = [from[0] + t * d0[0], from[1] + t * d0[1]];
    if (Math.hypot(control[0] - from[0], control[1] - from[1]) > 2 * chord) return undefined;
  }
  const poly = Array.from({ length: 33 }, (_, i) => quadAt(from, control, last.p1, i / 32));
  for (const q of quads) for (const at of [0.25, 0.5, 0.75]) if (distanceToPolyline(quadAt(q.p0, q.c, q.p1, at), poly) > CURVE_TOLERANCE) return undefined;
  return [...control, ...last.p1];
}

/** Skia flattens round caps and joins into dozens of quadratics a hundredth of an em long; merge each run back to the few that draw the same arc. */
function mergeQuads(start: Pt, segs: { c: string; n: number[] }[]): { c: string; n: number[] }[] {
  const out: { c: string; n: number[] }[] = [];
  let cursor = start;
  for (let i = 0; i < segs.length;) {
    let seg = segs[i]!, next = i + 1;
    if (seg.c === 'Q') {
      for (let j = i + 2; j <= segs.length && segs[j - 1]!.c === 'Q'; j++) {
        const fit = fitQuad(cursor, segs.slice(i, j));
        if (!fit) break;
        seg = { c: 'Q', n: fit }; next = j;
      }
    }
    out.push(seg);
    cursor = [seg.n.at(-2)!, seg.n.at(-1)!];
    i = next;
  }
  return out;
}

interface Contour { start: [number, number]; segs: { c: string; n: number[] }[] }

/**
 * Skia's boolean ops leave contours of arbitrary direction (and `asWinding` mishandles an island's own hole), which an even-odd reader
 * draws right and a nonzero one (the symbol format) fills in. Set the direction from nesting depth: outer contours one way, holes the other.
 */
function windingPath(svg: string): string {
  const contours: Contour[] = [];
  for (const [, command, args] of svg.matchAll(/([MLQCZ])([^MLQCZ]*)/g)) {
    const n = (args ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (command === 'M') contours.push({ start: [n[0]!, n[1]!], segs: [] });
    else if (command !== 'Z') contours.at(-1)!.segs.push({ c: command!, n });
  }
  const polygon = (c: Contour): [number, number][] => [c.start, ...c.segs.flatMap(seg => Array.from({ length: seg.n.length / 2 }, (_, i) => [seg.n[2 * i]!, seg.n[2 * i + 1]!] as [number, number]))];
  const area = (poly: [number, number][]) => poly.reduce((sum, [x, y], i) => { const [nx, ny] = poly[(i + 1) % poly.length]!; return sum + (x * ny - nx * y); }, 0) / 2;
  const inside = ([x, y]: [number, number], poly: [number, number][]) => poly.reduce((hit, [ax, ay], i) => {
    const [bx, by] = poly[(i + 1) % poly.length]!;
    return (ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax ? !hit : hit;
  }, false);
  const polys = contours.map(polygon);
  const reverse = (c: Contour): Contour => {
    const points: [number, number][] = [c.start, ...c.segs.map(seg => [seg.n.at(-2)!, seg.n.at(-1)!] as [number, number])];
    return {
      start: points.at(-1)!,
      segs: c.segs.map((seg, i) => ({ c: seg.c, n: [...(seg.c === 'C' ? [seg.n[2]!, seg.n[3]!, seg.n[0]!, seg.n[1]!] : seg.c === 'Q' ? [seg.n[0]!, seg.n[1]!] : []), ...points[i]!] })).reverse(),
    };
  };
  return contours.map((contour, i) => {
    const depth = polys.filter((poly, j) => j !== i && inside(contour.start, poly)).length;
    const clockwise = area(polys[i]!) > 0;
    const oriented = (depth % 2 === 0) === clockwise ? contour : reverse(contour);
    const fixed = { start: oriented.start, segs: mergeQuads(oriented.start, oriented.segs) };
    return `M${fixed.start.join(' ')}` + fixed.segs.map(seg => seg.c + seg.n.join(' ')).join('') + 'Z';
  }).join('');
}

/** SF Symbol geometry at a 100 pt font, in the template's units: baseline-to-capline, and what a 24-unit box becomes. */
const CAP_HEIGHT = 70.459;
/** 24 lucide units = 126, so a circle of 20 units is 105 against SF's `circle` at 99.5, and a folder 105 x 84 against `folder` 112 x 90. */
const BOX = 126;
/** The space SF Symbols leave either side of the drawn shape (circle 9, plus 12, chevron 12.5). */
const BEARING = 11;

interface Placed { d: string; width: number }

/** Scales the 24-unit box to BOX, centres its middle on half the cap height above the baseline, trims the advance to the ink plus bearings. */
function place(glyph: Glyph): Placed {
  const scale = BOX / Math.max(glyph.w, glyph.h);
  const base = outline(glyph);
  const flip = glyph.mirror ? { a: -scale, b: 0, c: 0, d: scale, e: glyph.w * scale, f: 0 } : { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 };
  const scaled = base.transform(flip);
  const [left, , right] = scaled.getBounds();
  const shifted = scaled.transform({ a: 1, b: 0, c: 0, d: 1, e: BEARING - left!, f: -(glyph.h * scale) / 2 - CAP_HEIGHT / 2 });
  const rounded = windingPath(shifted.toSVGString()).replace(/-?\d+\.\d+/g, n => String(Math.round(Number(n) * 10) / 10)).replace(/-0(?![\d.])/g, '0');
  if (!/^[Mm]/.test(rounded)) throw new Error('Empty outline');
  return { d: rounded, width: Math.round((right! - left! + 2 * BEARING) * 10) / 10 };
}

const BASELINE_M = 1126;
const CENTER_X = 1650;


function template(name: string, placed: Placed): string {
  const x = Math.round((CENTER_X - placed.width / 2) * 10) / 10;
  const line = (id: string, x1: number, y1: number, x2: number, y2: number) => ` <line id="${id}" stroke="#27AAE1" stroke-width="0.5" x1="${x1}" x2="${x2}" y1="${y1}" y2="${y2}"/>`;
  const edge = (id: string, at: number) => line(id, at, BASELINE_M - 210, at, BASELINE_M + 40);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!--Generated by scripts/gen-macos-icons.ts: ${name}-->`,
    '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="3300" height="2200">',
    '<g id="Guides">',
    ...([['S', 696], ['M', BASELINE_M], ['L', 1556]] as const).flatMap(([size, base]) => [
      line(`Baseline-${size}`, 263, base, 3036, base),
      line(`Capline-${size}`, 263, Math.round((base - CAP_HEIGHT) * 1000) / 1000, 3036, Math.round((base - CAP_HEIGHT) * 1000) / 1000),
    ]),
    edge('left-margin-Regular-M', x),
    edge('right-margin-Regular-M', Math.round((x + placed.width) * 10) / 10),
    '</g>',
    '<g id="Symbols">',
    ` <g id="Regular-M" transform="matrix(1 0 0 1 ${x} ${BASELINE_M})">`,
    `  <path d="${placed.d}"/>`,
    ' </g>',
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const info = { author: 'xcode', version: 1 };
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

function swiftSource(): string {
  const keys = Object.entries(map.symbols).sort(([a], [b]) => (a < b ? -1 : 1));
  return [
    '// Generated by scripts/gen-macos-icons.ts from apps/macos/scripts/icon-map.json. Do not edit by hand.',
    '',
    'enum IconSymbols {',
    '    /// SF Symbol name -> semantic key; `<pack>.<key>` is the symbol image in Icons.xcassets.',
    '    static let keys: [String: String] = [',
    ...keys.map(([sf, key]) => `        ${JSON.stringify(sf)}: ${JSON.stringify(key)},`),
    '    ]',
    '',
    '    /// The packs in Icons.xcassets: id and display name (the names Android shows, then the web\'s own).',
    '    static let packs: [(id: String, title: String)] = [',
    ...PACKS.map(([id, title]) => `        (${JSON.stringify(id)}, ${JSON.stringify(title)}),`),
    '    ]',
    '}',
    '',
  ].join('\n');
}

function generate(): { files: Map<string, string>; glyphs: Record<string, Record<string, Glyph>> } {
  for (const [sf, key] of Object.entries(map.symbols)) if (!KEYS[key]) throw new Error(`icon-map.json: ${sf} -> unknown key ${key}`);
  const used = new Set(Object.values(map.symbols));
  const glyphs = resolveGlyphs();
  const files = new Map<string, string>();
  files.set(join(catalog, 'Contents.json'), json({ info }));
  for (const [id] of PACKS) {
    files.set(join(catalog, id, 'Contents.json'), json({ info }));
    for (const key of Object.keys(KEYS)) {
      // Android keys the Mac does not draw are not shipped.
      if (!used.has(key)) continue;
      const name = `${id}.${key}`;
      const dir = join(catalog, id, `${name}.symbolset`);
      files.set(join(dir, 'Contents.json'), json({ info, symbols: [{ filename: `${name}.svg`, idiom: 'universal' }] }));
      files.set(join(dir, `${name}.svg`), template(name, place(glyphs[id]![key]!)));
    }
  }
  files.set(swiftOut, swiftSource());
  return { files, glyphs };
}

function onDisk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(entry => entry !== '.DS_Store').flatMap(entry => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? onDisk(path) : [path];
  });
}

if (process.argv.includes('--audit')) {
  const plist = '/System/Library/CoreServices/CoreGlyphs.bundle/Contents/Resources/name_availability.plist';
  const { execFileSync } = await import('node:child_process');
  const names = new Set(Object.keys((JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })) as { symbols: object }).symbols));
  const sources = execFileSync('grep', ['-rhoE', '--include=*.swift', '"[a-z][a-z0-9]*(\\.[a-z0-9]+)*"', resolve(macos, 'Riffet')], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const missing = [...new Set(sources.split('\n').map(s => s.slice(1, -1)))].filter(s => names.has(s) && !(s in map.symbols) && !map.system.includes(s) && !map.ignore.includes(s));
  if (missing.length) { console.error('gen:mac-icons: SF Symbol names in the sources that icon-map.json misses:\n  ' + missing.join('\n  ')); process.exit(1); }
  console.log('gen:mac-icons: every SF Symbol name in the sources is mapped, system or ignored.');
} else {
  const { files, glyphs } = generate();
  if (process.argv.includes('--check')) {
    const stale = [...files].filter(([path, content]) => !existsSync(path) || readFileSync(path, 'utf8') !== content).map(([path]) => path);
    const extra = onDisk(catalog).filter(path => !files.has(path));
    if (stale.length || extra.length) {
      console.error('gen:mac-icons: ' + [...stale, ...extra].length + ' stale or extra files (first: ' + relative(root, [...stale, ...extra][0]!) + '). Run `pnpm gen:mac-icons` and commit the result.');
      process.exit(1);
    }
    console.log('gen:mac-icons: up to date (' + files.size + ' files).');
  } else {
    for (const path of onDisk(catalog)) if (!files.has(path)) rmSync(path);
    for (const dir of readdirSync(catalog).map(pack => join(catalog, pack)).filter(path => statSync(path).isDirectory())) {
      for (const set of readdirSync(dir)) if (set.endsWith('.symbolset') && onDisk(join(dir, set)).length === 0) rmSync(join(dir, set), { recursive: true });
    }
    for (const [path, content] of files) { mkdirSync(dirname(path), { recursive: true }); if (!existsSync(path) || readFileSync(path, 'utf8') !== content) writeFileSync(path, content); }
    const fallen = fallbacks(glyphs);
    const used = new Set(Object.values(map.symbols));
    console.log(`gen:mac-icons: ${Object.keys(map.symbols).length} SF names, ${used.size} keys, ${PACKS.length} packs, ${files.size} files.`);
    for (const [id, keys] of Object.entries(fallen)) console.log(`  ${id}: ${keys.filter(k => used.has(k)).length}/${used.size} keys draw lucide`);
  }
}
