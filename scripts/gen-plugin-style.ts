import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_BASE_STYLE, PLUGIN_BASE_STYLE_VERSION } from '../packages/plugin-web/src/base-style.js';

/**
 * Writes the base stylesheet of isolated views (`packages/plugin-web/src/base-style.ts`) into the region
 * of `PluginPageDocument.swift` between the two markers, so the Mac page carries the same text as the
 * web page. `--check` fails when the committed Swift is stale, as `gen:styles` does.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, 'apps/macos/Riffet/Features/Inspector/PluginPageDocument.swift');
const BEGIN = '    // BEGIN GENERATED plugin-base-style (scripts/gen-plugin-style.ts)';
const END = '    // END GENERATED plugin-base-style';

if (PLUGIN_BASE_STYLE.includes('"""#')) throw new Error('gen:plugin-style: the stylesheet contains the Swift literal terminator');
const region = [
  BEGIN,
  '    /// `PLUGIN_BASE_STYLE` of packages/plugin-web: tokens and element rules, the same text as the web page.',
  `    static let baseStyleVersion = ${PLUGIN_BASE_STYLE_VERSION}`,
  '    static let baseStyle = #"""',
  PLUGIN_BASE_STYLE,
  '"""#',
  END,
].join('\n');

const current = readFileSync(file, 'utf8');
const start = current.indexOf(BEGIN);
const end = current.indexOf(END);
if (start < 0 || end < start) throw new Error(`gen:plugin-style: markers missing in ${file}`);
const next = current.slice(0, start) + region + current.slice(end + END.length);

if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('gen:plugin-style: PluginPageDocument.swift is stale; run `pnpm gen:plugin-style`.');
    process.exit(1);
  }
} else if (next !== current) {
  writeFileSync(file, next);
  console.log('wrote apps/macos/Riffet/Features/Inspector/PluginPageDocument.swift');
}
