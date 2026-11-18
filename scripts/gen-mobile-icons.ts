import { num, toPath } from './svg-icon-path.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generates the Compose Multiplatform icon set from the web's own `lucide-react` dependency.
 *
 * Lucide ships each glyph as a list of SVG elements on a 24 x 24 grid. Hand-copying them into
 * Kotlin would drift on the next lucide bump, so the elements are read out of the installed package,
 * folded into one SVG path each, and emitted as `ImageVector`s. The generated file is committed (the
 * Gradle build then needs no Node), and `--check` lets CI fail when it is stale.
 *
 * `ICONS` is the one hand-kept fact: which lucide glyph stands behind each name `RiffetIcons` exposes.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOut = resolve(root, 'apps/mobile/shared/src/commonMain/kotlin/riffet/ui/icons/LucideIcons.generated.kt');
const outPath = resolve(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? defaultOut);
const packageName = process.argv.find((arg) => arg.startsWith('--package='))?.slice(10) ?? 'riffet.ui.icons';
const checkOnly = process.argv.includes('--check');

/**
 * Stroke in dp, constant at every rendered size like the web (`ConstantStrokePainter` reads it as dp, so
 * on a 24dp icon it is also the raw 24-grid width).
 */
const STROKE = 1.25;
/** A selected tab: the same glyph, heavier, since lucide has no filled forms. */
const HEAVY = 1.75;

interface Spec {
  /** The lucide glyph, by its file name. */
  icon: string;
  /** Stroke width on the 24 grid; defaults to [STROKE]. */
  stroke?: number;
  /** Also fill the closed outline, for a glyph whose meaning is a solid shape (a favourite star, the stop square). */
  filled?: boolean;
}

/**
 * Kotlin name -> lucide glyph, sorted by name. A name is the one `apps/web/src/components/icons.tsx`
 * (`Icon<Name>`) uses where that wraps lucide, otherwise the lucide glyph closest in meaning.
 */
const ICONS: Record<string, string | Spec> = {
  Archive: 'archive',
  ArchiveRestore: 'archive-restore',
  ArrowDown: 'arrow-down',
  ArrowLeft: 'arrow-left',
  ArrowRightLeft: 'arrow-right-left',
  Bell: 'bell',
  Bookmark: 'bookmark',
  Bot: 'bot',
  Brain: 'brain',
  Branch: 'git-branch',
  Bug: 'bug',
  Chart: 'chart-column',
  Check: 'check',
  ChevronDown: 'chevron-down',
  ChevronLeft: 'chevron-left',
  ChevronRight: 'chevron-right',
  Circle: 'circle',
  CircleAlert: 'circle-alert',
  CircleCheck: 'circle-check',
  CircleDashed: 'circle-dashed',
  Clock: 'clock',
  Close: 'x',
  Copy: 'copy',
  Dices: 'dices',
  Download: 'download',
  Ellipsis: 'ellipsis',
  Error: 'circle-x',
  ExternalLink: 'external-link',
  Eye: 'eye',
  FilePenLine: 'file-pen-line',
  FileText: 'file-text',
  Filter: 'funnel',
  Folder: 'folder',
  FolderOpen: 'folder-open',
  FolderPlus: 'folder-plus',
  Globe: 'globe',
  House: 'house',
  Image: 'image',
  Info: 'info',
  Keyboard: 'keyboard',
  Layers: 'layers',
  Link: 'link',
  ListTodo: 'list-todo',
  Message: 'message-square',
  MessageQuestion: 'message-circle-question-mark',
  MessageSquarePlus: 'message-square-plus',
  MessageSquarePlusFilled: { icon: 'message-square-plus', stroke: HEAVY },
  Mic: 'mic',
  Monitor: 'monitor',
  Moon: 'moon',
  OctagonX: 'octagon-x',
  Palette: 'palette',
  Pencil: 'pencil',
  Pin: 'pin',
  PinOff: 'pin-off',
  Plus: 'plus',
  Pointer: 'pointer',
  Puzzle: 'puzzle',
  Refresh: 'rotate-cw',
  Repeat: 'repeat',
  Reply: 'reply',
  Search: 'search',
  Send: 'send-horizontal',
  Settings: 'settings',
  SettingsFilled: { icon: 'settings', stroke: HEAVY },
  Shield: 'shield',
  ShieldHalf: 'shield-half',
  Sliders: 'sliders-horizontal',
  SquareTerminal: 'square-terminal',
  Star: 'star',
  StarFilled: { icon: 'star', filled: true },
  Steer: 'corner-up-right',
  Stop: { icon: 'square', filled: true },
  Sun: 'sun',
  Tag: 'tag',
  Target: 'target',
  Terminal: 'terminal',
  Trash: 'trash-2',
  User: 'user',
  Warning: 'triangle-alert',
  Wrench: 'wrench',
  Zap: 'zap',
};

const names = Object.keys(ICONS);
const unsorted = names.find((name, index) => index > 0 && names[index - 1]! >= name);
if (unsorted) throw new Error(`ICONS must be sorted by name and unique; "${unsorted}" is out of place`);

const require = createRequire(resolve(root, 'package.json'));
const lucideRoot = dirname(require.resolve('lucide-react/package.json'));
const lucide = JSON.parse(readFileSync(resolve(lucideRoot, 'package.json'), 'utf8')) as { version: string };
const iconsDir = resolve(lucideRoot, 'dist/esm/icons');

type Attrs = Record<string, string | number>;
type Node = [tag: string, attrs: Attrs];

function loadNodes(icon: string): Node[] {
  const file = resolve(iconsDir, `${icon}.js`);
  let source: string;
  try { source = readFileSync(file, 'utf8'); } catch { throw new Error(`lucide-react ${lucide.version} has no glyph "${icon}" (${file})`); }
  const match = source.match(/const __iconNode = (\[[\s\S]*?\]);\s*\nconst /);
  if (!match) throw new Error(`Cannot find __iconNode in ${file}`);
  return Function(`return ${match[1]}`)() as Node[];
}

function kotlinNumber(value: number): string {
  const text = String(value);
  return `${text.includes('.') ? text : `${text}.0`}f`;
}

const entries = names.map((name) => {
  const spec: Spec = typeof ICONS[name] === 'string' ? { icon: ICONS[name] as string } : ICONS[name] as Spec;
  const pathData = loadNodes(spec.icon).map(toPath).join('');
  const extra = [
    spec.stroke !== undefined ? `strokeWidth = ${kotlinNumber(spec.stroke)}` : '',
    spec.filled ? 'filled = true' : '',
  ].filter(Boolean).join(', ');
  return [
    `    /** lucide \`${spec.icon}\`${spec.filled ? ', filled' : ''}${spec.stroke !== undefined ? `, stroke ${num(spec.stroke)}` : ''}. */`,
    `    val ${name}: ImageVector by lazy {`,
    `        lucide(`,
    `            "${name}",`,
    `            "${pathData}",`,
    ...(extra ? [`            ${extra},`] : []),
    `        )`,
    `    }`,
  ].join('\n');
});

const generated = `// Generated by scripts/gen-mobile-icons.ts from lucide-react ${lucide.version}.
// Do not edit by hand: change the mapping in the script and re-run \`pnpm gen:icons\`.
//
// The path data is Lucide's (https://lucide.dev), ISC licence:
//
//   Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
//   All other copyright (c) for Lucide are held by Lucide Contributors 2022.
//
//   Permission to use, copy, modify, and/or distribute this software for any purpose with or without
//   fee is hereby granted, provided that the above copyright notice and this permission notice appear
//   in all copies.
//
//   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
//   SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
//   AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
//   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
//   NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
//   OF THIS SOFTWARE.
//
// Changes from the SVG assets: every element is folded into one path (circles, rects and polylines
// become arcs and lines) and drawn as a stroke on a 24-unit grid, so \`Icon(tint = …)\` recolours it.
package ${packageName}

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

private fun lucide(name: String, pathData: String, strokeWidth: Float = ${kotlinNumber(STROKE)}, filled: Boolean = false): ImageVector =
    ImageVector.Builder("Lucide$name", 24.dp, 24.dp, 24f, 24f)
        .addPath(
            pathData = addPathNodes(pathData),
            fill = if (filled) SolidColor(Color.Black) else null,
            stroke = SolidColor(Color.Black),
            strokeLineWidth = strokeWidth,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        )
        .build()

/** Created on first use: a screen touches a handful of these, not all ${names.length}. */
internal object LucideIcons {
${entries.join('\n\n')}
}
`;

if (checkOnly) {
  let current = '';
  try { current = readFileSync(outPath, 'utf8'); } catch { /* reported as stale below */ }
  if (current !== generated) {
    console.error(`gen:icons: ${outPath} is stale. Run \`pnpm gen:icons\` and commit the result.`);
    process.exit(1);
  }
  console.log(`gen:icons: ${outPath} is up to date.`);
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, generated);
  console.log(`gen:icons: wrote ${outPath} (${names.length} icons, lucide-react ${lucide.version})`);
}
