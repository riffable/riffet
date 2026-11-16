import { fileURLToPath } from 'node:url';
import { lingui } from '@lingui/vite-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  // Web modules that use Lingui macros or import `.po` catalogs, as the web build compiles them.
  plugins: [lingui({ macroTransform: true, configPath: fileURLToPath(new URL('./apps/web/lingui.config.ts', import.meta.url)) })],
  resolve: {
    alias: {
      '@contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@riffet/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@riffet/plugin-api/kit': fileURLToPath(new URL('./packages/plugin-api/src/kit/index.ts', import.meta.url)),
      '@riffet/plugin-api/experimental/agent': fileURLToPath(new URL('./packages/plugin-api/src/agent.ts', import.meta.url)),
      '@riffet/plugin-api': fileURLToPath(new URL('./packages/plugin-api/src/index.ts', import.meta.url)),
      '@riffet/plugin-web': fileURLToPath(new URL('./packages/plugin-web/src/index.ts', import.meta.url)),
      // So web modules that import via the `@/` alias are testable too.
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    setupFiles: ['./tests/setup-i18n.ts'],
    globalSetup: ['./tests/global-teardown.ts'],
    // Installed plugin packages run under macOS's sandbox; where there is none the suite accepts the documented gap so the packages still run.
    env: process.platform === 'darwin' ? {} : { RIFFET_UNSAFE_PLUGIN_PROCESS: '1' },
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'plugins/**/*.test.ts', 'official/**/*.test.ts', 'tests/**/*.test.ts'], exclude: ['apps/mobile/**', '**/node_modules/**', '**/build/**', '**/dist/**'], testTimeout: 20_000, hookTimeout: 20_000, pool: 'forks',
    // Codex recovery logs one diagnostic line per recovered thread; in production that is the audit
    // trail, in the suite it buries the actual failures.
    onConsoleLog: (log) => (log.startsWith('[codex-recovery]') ? false : undefined),
  },
});
