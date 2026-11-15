#!/usr/bin/env node
// Flags Compose patterns that made Android pages remount or recompose every frame (each one cost a
// real regression; see "Compose 约定" in apps/mobile/AGENTS.md), and page structure the mobile page
// spec retired (docs/design/system/mobile.md §2.4). Text rules, so a deliberate exception carries a
// `compose-pitfalls: allow` comment on the line (with the reason next to it).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sources = ['apps/mobile/shared/src', 'apps/mobile/client/src', 'apps/mobile/terminal/src'].map(path => join(root, path));

// Values that change at most with the theme, the window or the host: invalidating the whole subtree
// is the intended cost. Anything that flips with navigation, scrolling or motion is
// `compositionLocalOf`, so only its readers recompose.
const staticLocals = new Set([
  'LocalAppearanceResources', 'LocalComposerDrafts', 'LocalDialogAction', 'LocalFileAccess', 'LocalFocusCoordinator',
  'LocalInteractionDrafts', 'LocalInterfaceStyle', 'LocalMarkActions', 'LocalMaterial', 'LocalNativeFeatures',
  'LocalPageBack', 'LocalPageBackDispatcher', 'LocalPageChromeInsets', 'LocalPageDepth', 'LocalPickerHost',
  'LocalPickerNavigationPanel', 'LocalQuote', 'LocalRestoreNativeRun', 'LocalRunRecoveryStore',
  'LocalSessionReferenceOpen', 'LocalSessionReferenceStore', 'LocalSettingsSearchTarget', 'LocalSubagentOpen',
  'LocalTabChrome', 'LocalTabContentBottomPadding', 'LocalTabMenu', 'LocalTerminalOpen', 'LocalVisualHostResumed',
  'LocalRiffetMotion', 'LocalRiffetSnackbar', 'LocalRiffetSurfaces', 'LocalRiffetWindowInfo', 'LocalRiffetColors',
  'LocalRiffetTypography', 'LocalRiffetDarkTheme', 'LocalRiffetThemeEntry',
]);

const rules = [
  {
    // `visualWorkActive` short-circuited its CompositionLocal reads; a pushed page then remounted
    // everything its caller composed after it, so images flashed their empty frame.
    name: 'short-circuited composable read',
    test: line => /(&&|\|\|)\s*!?\(?\s*[\w.]*(visualWorkActive|remember\w*)\(/.test(line),
    hint: 'call it unconditionally into a val, then combine the booleans',
  },
  {
    // A layout position in State, read while composing: every frame of a page sliding over the
    // layout recomposed and remeasured all of it.
    name: 'window position stored from onGloballyPositioned',
    test: line => /onGloballyPositioned\s*\{[^}]*=\s*(it|\w+)\.(positionIn\w+|boundsIn\w+)\(\)/.test(line),
    hint: 'use it in layout or drawing, or track it only when needed (see trackForFolds)',
  },
  {
    // A transcript row that parsed its markdown after its first frame drew plain text, then the
    // parsed blocks at another height: the followed list jumped on every page open.
    name: 'transcript row content derived after its first frame',
    files: /\/ui\/timeline\//,
    test: line => /withContext\(\s*Dispatchers\.|produceState\s*[(<]/.test(line),
    hint: 'derive it before the row composes (the presenter hook, see prepareTranscriptMarkdown) or reserve its final size',
  },
  {
    // 「启用 [启用]」: a row's title next to a button repeating it or showing the current value. A
    // settings row is a navigation, switch, choice or action row instead.
    name: 'settings row holding a button',
    test: (line, lines, index) => /\bSettingsButton\(/.test(line)
      && lines.slice(Math.max(0, index - 3), index + 1).some(previous => /\bSettingsRow\(/.test(previous)),
    hint: 'use SettingsActionRow, SettingsChoiceRow, SettingsNavigationRow or SettingsSwitchRow (mobile.md §2.4)',
  },
  {
    name: 'SettingsButtonsRow',
    test: line => /\bSettingsButtonsRow\(/.test(line) && !/fun\s+SettingsButtonsRow/.test(line),
    hint: 'one action per row: SettingsActionRow, with any result in a Snackbar (mobile.md §2.4)',
  },
  {
    name: 'staticCompositionLocalOf outside the allowlist',
    test: line => {
      const match = line.match(/val\s+(\w+)\s*(?::[^=]+)?=\s*staticCompositionLocalOf/);
      return match != null && !staticLocals.has(match[1]);
    },
    hint: 'use compositionLocalOf unless it only changes with the theme, window or host; then add it to the allowlist',
  },
];

function* kotlinFiles(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'build') yield* kotlinFiles(path);
    } else if (name.endsWith('.kt')) yield path;
  }
}

const problems = [];
for (const source of sources) {
  for (const file of kotlinFiles(source)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '');
      if (line.includes('compose-pitfalls: allow') || code.trim().startsWith('*')) return;
      // A declaration split after `=` keeps its initializer on the next line.
      const joined = /=\s*$/.test(code) ? code + (lines[index + 1] ?? '') : code;
      for (const rule of rules) {
        if (rule.files && !rule.files.test(file)) continue;
        if (rule.test(joined, lines, index)) problems.push(`${relative(root, file)}:${index + 1}: ${rule.name} — ${rule.hint}`);
      }
    });
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('compose pitfalls: ok');
