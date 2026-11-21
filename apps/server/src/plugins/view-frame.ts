import type { FastifyInstance } from 'fastify';
import { PLUGIN_FOCUS_SCRIPT } from '../../../../packages/plugin-web/src/base-style.js';
import { BRIDGE_INIT, BRIDGE_PORT, BRIDGE_READY, BRIDGE_VERSION } from '../../../../packages/plugin-web/src/bridge.js';

/**
 * The Content-Security-Policy of an isolated plugin view frame.
 *
 * Served as an HTTP document rather than `about:srcdoc` because browsers inherit the parent
 * workbench's `script-src 'self'` into `srcdoc` frames and block the frame's own inline script.
 * Serving this empty shell over HTTP gives it its own policy while keeping the workbench's
 * `script-src 'self'` untouched, and `sandbox allow-scripts` keeps its origin opaque.
 */
export function pluginViewFramePolicy(network: boolean): string {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'unsafe-inline' blob:",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    `connect-src ${network ? 'https:' : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/**
 * One-shot bootstrap script: listens for the embedding workbench's `BRIDGE_INIT` reply carrying
 * the MessagePort and the integrity-checked view script, applies locale/style, and runs the script.
 */
const FRAME_BOOTSTRAP_SCRIPT = `(() => {
  const port = new Promise((resolve) => {
    const initialize = ({ source, data, ports }) => {
      if (source !== window.parent || data?.type !== '${BRIDGE_INIT}' || data.version !== ${BRIDGE_VERSION} || !ports[0]) return;
      window.removeEventListener('message', initialize);
      resolve(ports[0]);
      const bootstrap = data.bootstrap;
      if (typeof bootstrap?.locale === 'string') document.documentElement.lang = bootstrap.locale;
      if (typeof bootstrap?.style === 'string') {
        const style = document.createElement('style');
        style.textContent = bootstrap.style;
        document.head.appendChild(style);
      }
      if (typeof bootstrap?.code === 'string') {
        const script = document.createElement('script');
        script.textContent = bootstrap.code;
        document.head.appendChild(script);
      }
    };
    window.addEventListener('message', initialize);
  });
  Object.defineProperty(window, '${BRIDGE_PORT}', { value: port });
  if (window.parent !== window) window.parent.postMessage({ type: '${BRIDGE_READY}', version: ${BRIDGE_VERSION} }, '*');
})();`;

const FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script>${PLUGIN_FOCUS_SCRIPT};\n${FRAME_BOOTSTRAP_SCRIPT}</script></body></html>`;

export function registerPluginViewFrame(app: FastifyInstance): void {
  app.get<{ Querystring: { network?: string } }>('/plugin-view', async (request, reply) => {
    const network = request.query.network === '1';
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', pluginViewFramePolicy(network))
      .header('Cache-Control', 'public, no-cache')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .send(FRAME_HTML);
  });
}
