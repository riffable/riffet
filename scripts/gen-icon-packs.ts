import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as phosphor from '@phosphor-icons/react';
import { DOMParser } from '@xmldom/xmldom';
import { toPath } from './svg-icon-path.js';
import { iconPackProblem, type IconGlyph, type IconPath } from '../packages/contracts/src/icon-pack.js';

// Semantic Riffet names, not library-specific names, are the plugin compatibility boundary.
const mapping: Record<string, string> = {
  Archive: 'Archive', ArchiveRestore: 'Archive', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft',
  ArrowRightLeft: 'ArrowsLeftRight', Bell: 'Bell', Bookmark: 'BookmarkSimple', Bot: 'Robot', Brain: 'Brain',
  Branch: 'GitBranch', Bug: 'Bug', Chart: 'ChartBar', Check: 'Check', ChevronDown: 'CaretDown',
  ChevronLeft: 'CaretLeft', ChevronRight: 'CaretRight', Circle: 'Circle', CircleAlert: 'WarningCircle',
  CircleCheck: 'CheckCircle', CircleDashed: 'CircleDashed', Clock: 'Clock', Close: 'X', Copy: 'Copy', Dices: 'DiceFive',
  Download: 'DownloadSimple', Ellipsis: 'DotsThree', Error: 'XCircle', ExternalLink: 'ArrowSquareOut',
  Eye: 'Eye', FilePenLine: 'NotePencil', FileText: 'FileText', Filter: 'Funnel', Folder: 'Folder', FolderOpen: 'FolderOpen',
  FolderPlus: 'FolderPlus', Globe: 'Globe', House: 'House', Image: 'Image', Info: 'Info', Keyboard: 'Keyboard', Layers: 'Stack',
  Link: 'Link', ListTodo: 'ListChecks', Menu: 'List', Message: 'ChatCircle', Mic: 'Microphone', MessageQuestion: 'ChatCircleDots',
  MessageSquarePlus: 'ChatCircleText', MessageSquarePlusFilled: 'ChatCircleText', Monitor: 'Monitor', Moon: 'Moon',
  OctagonX: 'WarningOctagon', Palette: 'Palette', Pencil: 'PencilSimple', Pin: 'PushPin', PinOff: 'PushPinSlash', Plus: 'Plus',
  Pointer: 'Cursor', Puzzle: 'PuzzlePiece', Refresh: 'ArrowClockwise', Repeat: 'Repeat', Reply: 'ArrowBendUpLeft',
  Search: 'MagnifyingGlass', Send: 'PaperPlaneRight', Settings: 'GearSix', SettingsFilled: 'GearSix', Shield: 'Shield',
  ShieldHalf: 'ShieldCheckered', Sliders: 'SlidersHorizontal', SquareTerminal: 'TerminalWindow', Star: 'Star', StarFilled: 'Star',
  Steer: 'ArrowBendUpRight', Stop: 'Square', Sun: 'Sun', Tag: 'Tag', Target: 'Target', Terminal: 'Terminal', Trash: 'Trash', User: 'User', Users: 'Users',
  Warning: 'Warning', Wrench: 'Wrench', Zap: 'Lightning',
};
/** SVG coordinates are kept at upstream precision, translated to a zero-origin viewport. */
function translatePath(d: string, dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return d;
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g)!;
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let command = '', result = '';
  for (let i = 0; i < tokens.length;) {
    if (/^[a-z]$/i.test(tokens[i]!)) {
      command = tokens[i++]!;
      result += command;
      if (command.toUpperCase() === 'Z') continue;
    }
    const count = arity[command.toUpperCase()]!;
    if (!count || i + count > tokens.length) throw new Error('Malformed SVG path');
    const values = tokens.slice(i, i + count).map(Number); i += count;
    if (values.some(v => !Number.isFinite(v))) throw new Error('Malformed SVG coordinates');
    if (command === command.toUpperCase()) {
      if (command === 'H') values[0]! += dx;
      else if (command === 'V') values[0]! += dy;
      else if (command === 'A') { values[5]! += dx; values[6]! += dy; }
      else for (let at = 0; at < count; at += 2) { values[at]! += dx; values[at + 1]! += dy; }
    }
    result += values.map(v => Math.round(v * 1000) / 1000).join(' ') + ' ';
  }
  return result.trim();
}

function glyphFromSvg(svg: string): IconGlyph {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement!;
  const viewport = root.getAttribute('viewBox') ?? ['0', '0', root.getAttribute('width'), root.getAttribute('height')].join(' ');
  const [x, y, width, height] = viewport.split(/[ ,]+/).map(Number);
  const paths: IconPath[] = [];
  const walk = (element: typeof root, inherited: Record<string, string>) => {
    const attrs = { ...inherited };
    for (let i = 0; i < element.attributes.length; i++) { const a = element.attributes.item(i)!; attrs[a.name] = a.value; }
    if (attrs.transform) throw new Error('Flatten transforms before importing');
    if (element.tagName === 'svg' || element.tagName === 'g') {
      for (let n = element.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) walk(n as typeof root, attrs);
      return;
    }
    if (element.tagName === 'title') return;
    const fill = attrs.fill !== 'none';
    const strokeWidth = attrs.stroke && attrs.stroke !== 'none' ? Number(attrs['stroke-width'] ?? 1) : 0;
    if (!fill && !strokeWidth) return; // Upstream's transparent viewport rectangle.
    paths.push({ d: translatePath(toPath([element.tagName, attrs]), -x!, -y!), fill, strokeWidth,
      lineCap: (attrs['stroke-linecap'] ?? 'round') as IconPath['lineCap'],
      lineJoin: (attrs['stroke-linejoin'] ?? 'round') as IconPath['lineJoin'],
      fillRule: (attrs['fill-rule'] ?? 'nonzero') as IconPath['fillRule'],
    });
  };
  walk(root, {});
  return { width: width!, height: height!, paths };
}

const families: Record<string, Record<string, IconGlyph>> = { phosphor: {} };
for (const [key, name] of Object.entries(mapping)) {
  const component = phosphor[name as keyof typeof phosphor] as ComponentType<{ weight: string }>;
  if (!component) throw new Error('Missing Phosphor icon: ' + name);
  const svg = renderToStaticMarkup(createElement(component, { weight: key.endsWith('Filled') || key === 'Stop' ? 'fill' : 'regular' }));
  families.phosphor![key] = glyphFromSvg(svg);
}

// Selected original SVGs are committed, so regeneration and CI need no network or new dependency.
const sourceMapping = JSON.parse(readFileSync('scripts/icon-sources/mapping.json', 'utf8')) as Record<string, [string, string]>;
const sourceDir = process.argv.find(arg => arg.startsWith('--import-sources='))?.slice('--import-sources='.length);
interface Snapshot { source: string; revision: string; icons: Record<string, { file: string; svg: string }> }
for (const [family, column] of [['tabler', 0], ['material', 1]] as const) {
  const snapshotPath = 'scripts/icon-sources/' + family + '.json';
  let snapshot: Snapshot;
  if (sourceDir) {
    snapshot = { source: family === 'tabler' ? 'https://github.com/tabler/tabler-icons' : 'https://github.com/google/material-design-icons',
      revision: family === 'tabler' ? JSON.parse(readFileSync(resolve(sourceDir, 'tabler/package.json'), 'utf8')).version : readFileSync(resolve(sourceDir, 'material/commit.txt'), 'utf8').trim(), icons: {} };
    for (const [key, slugs] of Object.entries(sourceMapping)) {
      const selected = key.endsWith('Filled') || key === 'Stop';
      const file = family === 'tabler'
        ? 'icons/' + (selected && existsSync(resolve(sourceDir, family, 'icons/filled', slugs[column] + '.svg')) ? 'filled/' : 'outline/') + slugs[column] + '.svg'
        : slugs[column] + (selected ? '_fill1' : '') + '_24px.svg';
      snapshot.icons[key] = { file, svg: readFileSync(resolve(sourceDir, family, file), 'utf8') };
    }
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
  } else snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot;
  families[family] = Object.fromEntries(Object.entries(snapshot.icons).map(([key, source]) => {
    if (!source.file.includes(sourceMapping[key]![column])) throw new Error('Stale source mapping: ' + key);
    const glyph = glyphFromSvg(source.svg);
    // Tabler has no filled message-plus: keep its official shape and strengthen the selected stroke.
    if (family === 'tabler' && key.endsWith('Filled') && source.file.includes('/outline/')) glyph.paths.forEach(path => { path.strokeWidth = 2.5; });
    return [key, glyph];
  }));
}
for (const family of ['fluent', 'octicons', 'mdi', 'remix']) {
  const snapshotPath = 'scripts/icon-sources/' + family + '.json';
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot;
  if (sourceDir && existsSync(resolve(sourceDir, family))) {
    for (const icon of Object.values(snapshot.icons)) icon.svg = readFileSync(resolve(sourceDir, family, icon.file), 'utf8');
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
  }
  families[family] = Object.fromEntries(Object.entries(snapshot.icons).map(([key, icon]) => [key, glyphFromSvg(icon.svg)]));
}
const sourceKeys = [...readFileSync('scripts/gen-mobile-icons.ts', 'utf8').matchAll(/^  (\w+): (?:'|\{ icon:)/gm)].map(m => m[1]!);
for (const [family, icons] of Object.entries(families)) {
  const problem = iconPackProblem({ version: 1, icons }); if (problem) throw new Error(family + ': ' + problem);
  if ([...sourceKeys, 'Menu'].some(key => !icons[key])) throw new Error(family + ' mapping is missing Riffet glyphs');
}
const out = 'apps/mobile/shared/src/commonMain/kotlin/riffet/ui/icons/BuiltinIconPacks.generated.kt';
const titles = { lucide: 'Lucide', phosphor: 'Phosphor', tabler: 'Tabler', 'material-symbols': 'Material Symbols', fluent: 'Fluent', octicons: 'Octicons', mdi: 'Material Design Icons', remix: 'Remix Icon' };
const generated = '// Generated by scripts/gen-icon-packs.ts. Original SVGs and pinned revisions: scripts/icon-sources/.\n'
  + '// Licenses: shared/NOTICE and shared/icon-licenses/.\n'
  + 'package riffet.ui.icons\n\nimport androidx.compose.ui.graphics.vector.ImageVector\nimport riffet.contracts.IconGlyph\nimport riffet.contracts.IconPath\nimport riffet.contracts.IconPackDocument\n\ninternal object BuiltinIconPacks {\n'
  + '    val titles = mapOf(' + Object.entries(titles).map(([id, title]) => '"' + id + '" to "' + title + '"').join(', ') + ')\n'
  + '    fun forId(id: String): Map<String, ImageVector>? = when (id) {\n        "lucide" -> emptyMap()\n'
  + Object.keys(families).map(family => '        "' + (family === 'material' ? 'material-symbols' : family) + '" -> ' + family + '\n').join('')
  + '        else -> null\n    }\n\n'
  + Object.entries(families).map(([family, icons]) => '    val ' + family + ' by lazy { IconPackDocument(icons = mapOf(\n'
    + Object.entries(icons).map(([key, glyph]) => '        "' + key + '" to IconGlyph(' + glyph.width + 'f, ' + glyph.height + 'f, listOf(' + glyph.paths.map(p => 'IconPath(d = "' + p.d + '", fill = ' + p.fill + ', strokeWidth = ' + p.strokeWidth + 'f, lineCap = "' + p.lineCap + '", lineJoin = "' + p.lineJoin + '", fillRule = "' + p.fillRule + '")').join(', ') + ')),').join('\n')
    + '\n    )).vectors("' + family + '") }\n').join('\n') + '}\n';
const outputs: [string, string][] = [[out, generated]];
const licenseResources = 'apps/mobile/shared/src/commonMain/composeResources/files/licenses/';
for (const family of ['phosphor', 'tabler', 'material', 'fluent', 'octicons', 'mdi', 'remix']) {
  outputs.push([licenseResources + family + '.txt', readFileSync('apps/mobile/shared/icon-licenses/' + family + '.txt', 'utf8')]);
}
outputs.push([licenseResources + 'NOTICE.txt', readFileSync('apps/mobile/shared/NOTICE', 'utf8')]);
for (const [path, content] of outputs) {
  if (process.argv.includes('--check')) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) throw new Error('Stale icon pack resource: ' + path);
  } else writeFileSync(path, content);
}
