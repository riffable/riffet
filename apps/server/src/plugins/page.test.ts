import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_API_VERSION, listSetting, type Plugin } from '@riffet/plugin-api';
import { createApp } from '../app.js';

// A plugin's page (docs/PLUGIN_ARCHITECTURE.md「插件页」) is the plugin's own answer, but a secret never leaves the server and a
// change goes through the plugin's declared settings.
describe('plugin page', () => {
  it('keeps secrets on the server, saves changes as settings and is gone while the plugin is off', async () => {
    const pressed: string[] = [];
    const probe: Plugin = {
      manifest: {
        id: 'acme.probe', vendor: 'acme', name: 'probe', apiVersion: PLUGIN_API_VERSION, defaultEnabled: true,
        settings: [{ key: 'sites', label: 'Sites', kind: 'text' }, { key: 'token', label: 'Token', kind: 'secret' }],
        contributes: { page: {} },
      },
      activate: host => ({ page: {
        read: () => ({ sections: [{ id: 'main', items: [
          { kind: 'list', key: 'sites', label: 'Sites', values: listSetting(host.settings().sites) },
          // A plugin that echoes a secret does not leak it.
          { kind: 'text', key: 'token', label: 'Token', value: 'leaked' },
        ] }] }),
        run: async (_context, action, item) => { pressed.push(`${action}:${item}`); return { message: 'cleared' }; },
      } }),
    };
    const dir = await mkdtemp(join(tmpdir(), 'riffet-plugin-page-'));
    const booted = await createApp({ stateDir: dir, auth: false, cliPath: '/nonexistent/cursor-agent', plugins: [probe] });
    try {
      await booted.dispatch.close();
      await booted.plugins.refresh();
      const status = await booted.app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
      const headers = { host: '127.0.0.1:4317', cookie: String(status.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (status.json() as { csrfToken: string }).csrfToken };
      const page = (method: 'GET' | 'POST', payload?: object) => booted.app.inject({ method, url: '/api/integrations/acme.probe/page', headers, ...(payload ? { payload } : {}) });

      await page('POST', { set: { key: 'token', value: 'secret-value' } });
      const saved = await page('POST', { set: { key: 'sites', value: ['a.com', ' b.com', 'a.com'] } });
      expect(saved.body).not.toContain('secret-value');
      expect(saved.body).not.toContain('leaked');
      expect(saved.json().page.sections[0].items).toEqual([
        { kind: 'list', key: 'sites', label: 'Sites', values: ['a.com', 'b.com'] },
        { kind: 'text', key: 'token', label: 'Token', secret: true, set: true },
      ]);
      expect((await page('POST', { set: { key: 'undeclared', value: 'x' } })).statusCode).toBe(400);
      expect((await page('POST', { run: { action: 'clear', item: 'p1' } })).json().message).toBe('cleared');
      expect(pressed).toEqual(['clear:p1']);

      await booted.plugins.update('acme.probe', { enablement: 'off' });
      expect((await page('GET')).statusCode).toBe(409);
      expect((await page('POST', { run: { action: 'clear' } })).statusCode).toBe(409);
      expect(pressed).toHaveLength(1);
    } finally { await booted.app.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
