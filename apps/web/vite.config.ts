import { defineConfig, type Plugin, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { lingui } from '@lingui/vite-plugin';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { get } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Script } from 'node:vm';
import { build as esbuild } from 'esbuild';
import type { BuildInfo } from '../../packages/contracts/src/update';
import { WORKBENCH_APPEARANCE_BUDGET } from '../../packages/contracts/src/budgets';

/** The public directory, read directly so the precache list does not depend on Vite's copy step. */
const publicDir = fileURLToPath(new URL('./public', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const devBackend = 'http://127.0.0.1:4317';

/** Personalize only Vite's workbench HTML, after its own SPA fallback has resolved the page. */
function workbenchDocument(): Plugin {
  return {
    name: 'riffet-workbench-document',
    apply: 'serve',
    configureServer(server) {
      return () => server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/index.html' || request.method !== 'GET'
          || request.headers['sec-fetch-mode'] !== 'navigate' || request.headers['sec-fetch-dest'] !== 'document'
          || !request.headers.host) return next();
        try {
          const proof = await new Promise<string | undefined>((resolve) => {
            get(`${devBackend}/__riffet/workbench-document-proof`, {
              headers: { host: request.headers.host, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
              signal: AbortSignal.timeout(WORKBENCH_APPEARANCE_BUDGET.proofMs),
            }, (reply) => {
              const value = reply.headers['x-riffet-workbench-document-proof'];
              resolve(reply.statusCode === 204 && typeof value === 'string' && /^[\w-]{43}$/.test(value) ? value : undefined);
              reply.resume();
            }).once('error', () => resolve(undefined));
          });
          if (!proof) return next();
          const html = await readFile(join(server.config.root, 'index.html'), 'utf8');
          const document = await server.transformIndexHtml('/index.html', html, request.originalUrl);
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'private, no-store',
            'Cross-Origin-Opener-Policy': 'same-origin',
          });
          response.end(document.replace(/<head(?:\s[^>]*)?>/i, head => `${head}<meta name="riffet-workbench-proof" content="${proof}">`));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

function webBuildInfo(command: string): BuildInfo {
  if (command === 'build') {
    const path = process.env.RIFFET_BUILD_INFO_FILE ?? join(repoRoot, '.riffet/build-info.json');
    return (JSON.parse(readFileSync(path, 'utf8')) as { build: BuildInfo }).build;
  }
  // A dev server has its own startup identity, without reusing an old release build record.
  return JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'scripts/build-info.mjs'), '--stdout'], { encoding: 'utf8', cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })).build;
}

/**
 * Bundles `src/sw.ts` as a self-contained classic script and injects the precache list.
 *
 * The worker needs the hashed asset names to serve a shell offline, but those names only exist once
 * Rollup has settled on the bundle. Bundling `sw.ts` in its own esbuild IIFE pass (rather than as a
 * second Rollup entry) guarantees shared modules like `service-worker-strategy.ts` are inlined
 * instead of split into an ESM chunk `import` that classic `serviceWorker.register('/sw.js')` rejects.
 * The cache name is derived from those emitted names and the public files' bytes, which makes it a
 * content version: a build whose output changed installs a new worker and a new cache; a build whose
 * output did not keeps the cache it already filled.
 */
/**
 * Kept out of the install-time download, not out of the cache: the worker still stores them
 * cache-first the first time they are used. The editor and terminal chunks are large and only load
 * when those views open, and every browser the app supports takes KaTeX's woff2, so its woff and ttf
 * copies would never be requested at all.
 */
function excludedFromPrecache(url: string): boolean {
  if (/^\/assets\/(editor|terminal)-[\w-]+\.js$/.test(url)) return true;
  // QA's pseudo-locale is never chosen in normal use.
  if (/^\/assets\/locale-pseudo-[\w-]+\.js$/.test(url)) return true;
  // The UI faces ship every script subset, but the browser only fetches the ones a page's text uses;
  // accented Latin (`latin-ext`, the largest Inter file) is as rare here as the other scripts.
  if (/^\/assets\/(inter|jetbrains-mono)-(cyrillic|greek|vietnamese|latin-ext)[\w-]*\.woff2$/.test(url)) return true;
  return /^\/assets\/KaTeX_[\w-]+\.(woff|ttf)$/.test(url);
}

function serviceWorkerPrecache(): Plugin {
  const swEntry = fileURLToPath(new URL('./src/sw.ts', import.meta.url));
  return {
    name: 'riffet-sw-precache',
    apply: 'build',
    async generateBundle(_options, bundle) {
      const emitted = Object.values(bundle)
        .map((file) => `/${file.fileName}`)
        // The worker is fetched by the browser's own update check, never by itself, and index.html
        // is covered by the `/` entry the server serves it at.
        .filter((url) => url !== '/sw.js' && url !== '/index.html' && !url.endsWith('.map'))
        .filter((url) => !excludedFromPrecache(url))
        .sort();
      const publicEntries = readdirSync(publicDir, { recursive: true, encoding: 'utf8' })
        .filter((entry) => statSync(join(publicDir, entry)).isFile())
        .sort();
      const publicFiles = publicEntries.map((entry) => `/${entry.split(sep).join('/')}`);
      const urls = [...new Set(['/', '/index.html', ...emitted, ...publicFiles])];
      // The name of a hashed asset already encodes its contents, but a public file (`theme-init.js`,
      // the manifest) keeps its name when it is edited. Folding those bytes into the version is what
      // keeps such an edit from being served out of the previous cache forever.
      const digest = createHash('sha256').update(urls.join('\n'));
      for (const entry of publicEntries) digest.update(entry).update(readFileSync(join(publicDir, entry)));
      const version = digest.digest('hex').slice(0, 8);
      const built = await esbuild({
        entryPoints: [swEntry],
        absWorkingDir: repoRoot,
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2023',
        minify: true,
        legalComments: 'none',
        metafile: true,
        tsconfig: join(repoRoot, 'tsconfig.json'),
      });
      const [output] = built.outputFiles;
      if (!output || built.outputFiles.length !== 1) {
        this.error('The service worker build must emit a single classic script');
      }
      const code = output.text
        .replace(/["']__RIFFET_PRECACHE__["']/g, () => JSON.stringify(urls))
        .replace(/["']__RIFFET_CACHE__["']/g, () => JSON.stringify(`riffet-shell-${version}`));
      // A placeholder left in the shipped worker would silently cache nothing, so fail the build.
      if (code.includes('__RIFFET_')) this.error('The service worker placeholders were not replaced');
      // Classic service workers reject ESM `import`/`export` statements and top-level `await`;
      // `vm.Script` compiles the bundle as a top-level classic script without executing it.
      try {
        new Script(code);
      } catch (error) {
        this.error(`The service worker output is not a valid classic script: ${(error as Error).message}`);
      }
      const directory = process.env.RIFFET_BUNDLED_PACKAGES_DIR;
      if (directory && built.metafile) {
        const deps = Object.keys(built.metafile.inputs)
          .filter((id) => !/^[^/]+:/.test(id))
          .map((id) => resolve(repoRoot, id))
          .filter((id) => /[\\/]node_modules[\\/]/.test(id));
        if (deps.length) {
          const target = join(directory, 'public.json');
          let existing: string[] = [];
          try { existing = JSON.parse(readFileSync(target, 'utf8')) as string[]; } catch { /* written below */ }
          writeFileSync(target, JSON.stringify([...new Set([...existing, ...deps])].sort()));
        }
      }
      // `sw.js` is a fixed, unhashed name on purpose: its URL is the service worker's identity and
      // the server revalidates it with an ETag, so a new build is always seen.
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code });
    },
  };
}

/** Reports the npm files this build ships to scripts/third-party-notices.ts (set by `pnpm build`). */
function bundledPackages(name: string): Plugin {
  return {
    name: 'riffet-bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const directory = process.env.RIFFET_BUNDLED_PACKAGES_DIR;
      if (!directory) return;
      // Fonts come with the stylesheet module that references them. Tailwind inlines its own and
      // `@import`ed CSS itself, so those files are only watched, never modules.
      const ids = [
        ...Object.values(bundle).flatMap((file) => (file.type === 'chunk' ? Object.keys(file.modules) : [])),
        ...this.getWatchFiles().filter((id) => id.endsWith('.css')),
      ].filter((id) => id.includes('/node_modules/'));
      writeFileSync(join(directory, `${name}.json`), JSON.stringify([...new Set(ids)].sort()));
    },
  };
}

export default defineConfig(({ command, mode }): UserConfig => {
  const share = mode === 'share';
  return ({
  define: { __RIFFET_WEB_BUILD__: JSON.stringify(webBuildInfo(command)) },
  root: share ? 'apps/web/share' : 'apps/web',
  base: share ? './' : '/',
  publicDir: share ? false : publicDir,
  // Lingui compiles `.po` imports and, natively, only the modules that import its macros.
  plugins: [react(), lingui({ macroTransform: true, configPath: fileURLToPath(new URL('./lingui.config.ts', import.meta.url)) }), tailwindcss(), bundledPackages(share ? 'share' : 'public'), ...(!share ? [serviceWorkerPrecache(), workbenchDocument()] : [])],
  // The code view's highlighting worker loads its grammars on demand, which needs module workers.
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      '@riffet/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      '@riffet/plugin-web': fileURLToPath(new URL('../../packages/plugin-web/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/diagram': {
        target: devBackend,
        changeOrigin: false,
      },
      '/content-preview': {
        target: devBackend,
        changeOrigin: false,
      },
      '/plugin-view': {
        target: devBackend,
        changeOrigin: false,
      },
      '/mermaid': {
        target: devBackend,
        changeOrigin: false,
      },
      // The sync engine reads the server's protocol version here; unproxied, it would get index.html and call the server outdated.
      '/health': {
        target: devBackend,
        changeOrigin: false,
      },
      '/api': {
        target: devBackend,
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: share ? '../../../dist/share' : '../../dist/public',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL(share ? './share/index.html' : './index.html', import.meta.url)),
      treeshake: {
        // micromark-extension-math's HTML compiler, which remark-math never calls, imports KaTeX at
        // the top level. KaTeX does not declare itself side-effect free, so without this that unused
        // import keeps it in the eagerly loaded markdown chunk and its lazy load in mathRenderer is moot.
        moduleSideEffects: (id) => !/\/node_modules\/katex\/.*\.m?js$/.test(id),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        manualChunks(id) {
          // One request per language rather than one per area; the source catalog stays in the entry.
          const catalog = /\/src\/locales\/([\w-]+)\/[\w-]+\.po$/.exec(id)?.[1];
          if (catalog && catalog !== 'zh-Hans') return `locale-${catalog}`;
          if (id.includes('/node_modules/@xterm/')) return 'terminal';
          if (id.includes('/node_modules/katex/') || id.includes('/node_modules/rehype-katex/')) return 'katex';
          if (id.includes('/node_modules/@codemirror/') || id.includes('/node_modules/@uiw/react-codemirror/')) return 'editor';
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) return 'react';
          if (id.includes('/node_modules/react-markdown/') || id.includes('/node_modules/remark-') || id.includes('/node_modules/micromark') || id.includes('/node_modules/mdast-') || id.includes('/node_modules/unified/')) return 'markdown';
        },
      },
    },
  },
});
});
