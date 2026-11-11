import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, normalize, resolve, sep } from 'node:path';

/**
 * The math page a native client renders formulas in, and the KaTeX assets it needs.
 *
 * The web client renders TeX itself (`remark-math` + `rehype-katex` in the browser). The mobile
 * clients cannot: Compose has no TeX engine, and shipping one for Android and iOS would mean two
 * more renderers that would drift from the browser's. Instead the server serves one page that uses
 * the same KaTeX build the web bundle uses, and the app shows it in a WebView sized to its content.
 *
 * The TeX travels in the URL *fragment*, which a browser never sends to the server: the page itself
 * is a constant, cacheable asset and the formula — which is assistant output — never reaches a
 * request log. Nothing here is behind the API's auth for the same reason: there is nothing to
 * protect, and a WebView cannot attach the device token to a document navigation.
 */

/** Same build the web client bundles, resolved from this package rather than copied into `dist`. */
const katexDist = (): string => dirname(createRequire(import.meta.url).resolve('katex/dist/katex.min.js'));

/**
 * The page's whole behaviour: read the fragment, render, and let the host measure the result.
 *
 * It is served from a URL rather than inlined so the document can stay under a strict
 * `script-src 'self'` policy with no `unsafe-inline` — the same CSP the workbench ships.
 */
const MATH_PAGE_JS = `(function () {
  var params = new URLSearchParams(location.hash.replace(/^#/, ''));
  var tex = params.get('tex') || '';
  var color = params.get('c');
  if (color) document.documentElement.style.color = color;
  var target = document.getElementById('formula');
  try {
    katex.render(tex, target, {
      displayMode: params.get('d') === '1',
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    });
  } catch (error) {
    // A formula KaTeX refuses is shown as written: the reader can still see what the agent meant.
    target.textContent = tex;
  }
  document.documentElement.setAttribute('data-riffet-math', 'ready');
})();
`;

/**
 * The document itself. Body type follows the app (a parameter-free 15px default), the background is
 * transparent so the WebView composites over the transcript's own surface, and the formula is a
 * single element the host can measure.
 */
const MATH_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/katex/katex.min.css">
<style>
  html,body{margin:0;padding:0;background:transparent}
  body{font-size:15px;line-height:1.5;color:#121417}
  #formula{display:inline-block;max-width:100%;overflow-x:auto;overflow-y:hidden}
  .katex-display{margin:0}
</style></head>
<body><span id="formula"></span>
<script src="/katex/katex.min.js"></script>
<script src="/katex/math-page.js"></script>
</body></html>
`;

/** Only what the page and KaTeX's stylesheet actually ask for. */
const MATH_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * Mount `/math`, `/katex/math-page.js` and `/katex/*`.
 *
 * The asset route resolves inside KaTeX's own `dist` directory and refuses anything that escapes it,
 * so the wildcard is a file server over one installed package and nothing else.
 */
export function registerMathAssets(app: FastifyInstance): void {
  app.get('/math', async (_request, reply) => {
    return await reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', CSP)
      .header('Cache-Control', 'no-cache')
      .send(MATH_PAGE_HTML);
  });

  app.get('/katex/math-page.js', async (_request, reply) => {
    return await reply
      .type('text/javascript; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .send(MATH_PAGE_JS);
  });

  app.get<{ Params: { '*': string } }>('/katex/*', async (request, reply) => {
    const root = katexDist();
    const requested = normalize(request.params['*'] ?? '');
    const path = resolve(join(root, requested));
    const type = MATH_TYPES[path.slice(path.lastIndexOf('.'))];
    if (!type || path !== root && !path.startsWith(root + sep)) {
      return await reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such KaTeX asset' } });
    }
    try {
      const body = await readFile(path);
      return await reply
        .type(type)
        // Versioned by the installed package, like the web bundle's own hashed assets.
        .header('Cache-Control', 'public, max-age=86400')
        .send(body);
    } catch {
      return await reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such KaTeX asset' } });
    }
  });
}
