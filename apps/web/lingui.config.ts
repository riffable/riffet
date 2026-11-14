import { defineConfig } from '@lingui/cli';
import babel from '@lingui/cli/api/extractors/babel';
import { formatter } from '@lingui/format-po';

/**
 * One catalog per feature area, so areas can be migrated side by side without two changes meeting in
 * the same file. Paths are relative to this directory; a directory covers everything under it.
 * `scripts/check-i18n.ts` holds every source file to exactly one area, since a file no area includes
 * is never extracted and would show bare message ids in a production build.
 */
export const areas: Record<string, string[]> = {
  common: ['src/components', 'src/lib'],
  workbench: ['src/app/plugins', 'src/*.{ts,tsx}', 'src/app/*.{ts,tsx}', 'src/app/state', 'src/app/tabs', 'src/plugins'],
  extensions: ['src/app/extensions'],
  marks: ['src/app/marks'],
  panels: ['src/app/panels'],
  session: ['src/app/session', 'src/sync', 'src/replay'],
  settings: ['src/app/settings', 'src/app/design'],
  shares: ['src/app/shares'],
  stats: ['src/app/stats'],
  tasks: ['src/app/tasks'],
  terminal: ['src/app/terminal'],
  share: ['src/share'],
};

// Origins without line numbers, so an edit above a message does not rewrite every catalog.
export const poFormat = formatter({ lineNumbers: false });

export default defineConfig({
  // The Chinese text in the source is the message; the other locales translate it.
  sourceLocale: 'zh-Hans',
  locales: ['zh-Hans', 'en', 'pseudo'],
  // QA only: the English with every letter accented, so text that bypasses the catalogs stands out.
  pseudoLocale: { locale: 'pseudo' },
  // A message without a translation shows the source text rather than its id.
  fallbackLocales: { pseudo: ['en'], default: 'zh-Hans' },
  format: poFormat,
  extractors: [
    babel,
    /*
     * The server's error texts, `i18n/errors/*.json`, are the `errors` catalog: code X is message
     * `error.X`. `pnpm gen:i18n` writes their text in every locale; extracting only lists the codes,
     * so the catalog checks know which messages exist. The id doubles as the message, which sorts the
     * catalog by code.
     */
    {
      match: (filename) => /[\\/]i18n[\\/]errors[\\/][^\\/]+\.json$/.test(filename),
      extract(filename, code, onMessageExtracted) {
        const lines = code.split('\n');
        for (const key of Object.keys(JSON.parse(code) as object)) {
          onMessageExtracted({ id: `error.${key}`, message: `error.${key}`, origin: [filename, lines.findIndex((line) => line.includes(`"${key}"`)) + 1] });
        }
      },
    },
  ],
  catalogs: [
    ...Object.entries(areas).map(([name, include]) => ({
      path: `<rootDir>/src/locales/{locale}/${name}`,
      include: include.map((path) => `<rootDir>/${path}`),
      exclude: ['**/*.test.ts', '**/*.d.ts'],
    })),
    { path: '<rootDir>/src/locales/{locale}/errors', include: ['<rootDir>/../../i18n/errors'] },
  ],
});
