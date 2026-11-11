import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { MAX_VISUALIZATION_BYTES, renderVisualization } from '../visualization.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'riffet-visualization-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const { app } = await createApp({ stateDir: join(root, 'state'), auth: false, cliPath: '/nonexistent/cursor-agent' });
  cleanups.push(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const auth = await app.inject({ url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
  const headers = { host: '127.0.0.1:4317', cookie: String(auth.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': auth.json().csrfToken as string };
  const project = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { cwd } });
  const id = project.json().id as string;
  const get = (path: string, extra = '') => app.inject({ url: `/api/projects/${id}/file/raw?path=${encodeURIComponent(path)}${extra}`, headers });
  return { root, cwd, app, id, get };
}

describe('visualization artifact previews', () => {
  it('wraps a fragment with producer utilities and local state, in a restricted response', async () => {
    const { cwd, get } = await boot();
    const source = '<div class="card"><button id="choose" class="btn">Choose</button></div><script>document.getElementById("choose").onclick=()=>document.body.dataset.chosen="yes";</script>';
    await writeFile(join(cwd, 'chart.html'), source);
    const response = await get('chart.html', '&render=visualize&scheme=dark');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain(source);
    expect(response.body).toContain('--font-size-base');
    expect(response.body).toContain('color-scheme:dark');
    expect(response.body).toContain('setWidgetState');
    expect(response.body).not.toContain('sendFollowUpMessage');
    expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts;');
    expect(response.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    // The preview runtime itself loads no CDN; the allowlist only admits what an artifact may
    // reference, so pin it rather than silently widening the sandbox when an asset is added.
    expect(response.headers['content-security-policy']).toContain(
      "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://esm.sh https://fonts.bunny.net https://fonts.googleapis.com https://fonts.gstatic.com https://unpkg.com;",
    );
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('serves a self-contained runtime without upstream identifiers or CDN scripts', async () => {
    const { cwd, get } = await boot();
    await writeFile(join(cwd, 'variants.html'), '<div class="viz-carousel"><div data-variant="A">A</div><div data-variant="B">B</div></div>');
    const response = await get('variants.html', '&render=visualize');
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('unpkg');
    expect(response.body).not.toContain('cdnjs');
    expect(response.body).not.toContain('openai/openai');
    expect(response.body).not.toContain('codex-');
    expect(response.body).toContain('riffet-visualization-tooltips');
    expect(response.body).toContain('riffet-visualization-tabs');
    expect(response.body).toContain('riffet-visualization-carousel');
    expect(response.body).toContain('data-tooltip-placement');
    expect(response.body).toContain('aria-describedby');
    expect(response.body).toContain('viz-carousel-controls');
    expect(response.body).toContain('viz-carousel-previous');
    expect(response.body).toContain('viz-carousel-next');
    expect(response.body).toContain('prefers-color-scheme');
  });

  it('preserves raw source and downloads byte for byte', async () => {
    const { cwd, get } = await boot();
    const source = '<div>Original HTML</div>\n';
    await writeFile(join(cwd, 'chart.html'), source);
    expect((await get('chart.html')).body).toBe(source);
    const downloaded = await get('chart.html', '&render=visualize&download=1');
    expect(downloaded.body).toBe(source);
    expect(downloaded.headers['content-disposition']).toContain('attachment;');
  });

  it('does not bypass project read scope or authentication', async () => {
    const { root, cwd, app, id, get } = await boot();
    await writeFile(join(root, 'outside.html'), '<div>Outside</div>');
    await symlink(join(root, 'outside.html'), join(cwd, 'escape.html'));
    expect((await get('../outside.html', '&render=visualize')).statusCode).toBe(403);
    expect((await get('escape.html', '&render=visualize')).statusCode).toBe(403);
    const unauthenticated = await app.inject({ url: `/api/projects/${id}/file/raw?path=chart.html&render=visualize`, headers: { host: '127.0.0.1:4317' } });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('reports unreadable, unsupported and oversized sources instead of blank previews', async () => {
    const { cwd, get } = await boot();
    expect((await get('missing.html', '&render=visualize')).statusCode).toBe(404);
    await writeFile(join(cwd, 'source.txt'), 'text');
    expect((await get('source.txt', '&render=visualize')).statusCode).toBe(415);
    await writeFile(join(cwd, 'too-big.html'), 'x'.repeat(MAX_VISUALIZATION_BYTES + 1));
    expect((await get('too-big.html', '&render=visualize')).statusCode).toBe(413);
  });

  it('escapes fragment titles and does not allow a theme query to inject HTML', async () => {
    const html = await renderVisualization('<div>Chart</div>', '<img src=x>', 'dark\"><script>bad()</script>');
    expect(html).toContain('<title>&lt;img src=x&gt;</title>');
    expect(html).toContain('color-scheme:light dark');
    expect(html).not.toContain('bad()');
  });

  it('adds utilities to complete documents without nesting a second HTML document', async () => {
    const source = '<!doctype html><html><head><title>Whole page</title></head><body><button>Choose</button></body></html>';
    const html = await renderVisualization(source, 'ignored', 'light');
    expect(html.match(/<html(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain('<title>Whole page</title>');
    expect(html).toContain('--font-size-base');
    expect(html).toContain('riffet-visualization-tabs');
  });

  it('does not corrupt inline scripts or comments that mention <head> or </body>', async () => {
    const source = '<!doctype html><html><head><script>const tpl = "<head></body>";</script></head><body><!-- </body> --><div id="app">ok</div></body></html>';
    const html = await renderVisualization(source, 'ignored', 'dark');
    expect(html).toContain('const tpl = "<head></body>";');
    expect(html).toContain('<!-- </body> --><div id="app">ok</div>');
    expect(html.indexOf('riffet-visualization-tabs')).toBeGreaterThan(html.indexOf('<div id="app">ok</div>'));
  });
});
