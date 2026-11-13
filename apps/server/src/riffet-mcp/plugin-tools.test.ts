import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_API_VERSION, type AgentToolContext, type Plugin } from '@riffet/plugin-api';
import { createApp } from '../app.js';

const MASTER = 'plugin-tools-test-master-token-with-more-than-24-characters';
const GROUP = 'acme.probe/probe';

// A plugin's tool group (docs/BROWSER.md §2) reaches only the conversations that selected it, and only while the plugin is on.
describe('plugin agent tools through Riffet MCP', () => {
  it('lists and runs a group for the conversation that selected it, and stops it when removed or turned off', async () => {
    const calls: AgentToolContext[] = [];
    const probe: Plugin = {
      manifest: {
        id: 'acme.probe', vendor: 'acme', name: 'probe', apiVersion: PLUGIN_API_VERSION, defaultEnabled: true,
        contributes: { agentTools: [{ id: GROUP, title: { en: 'Probe' }, toolPrefix: 'probe_' }] },
      },
      activate: () => ({ agentTools: { [GROUP]: {
        tools: [{ name: 'probe_echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
        call: async (context, _name, args) => { calls.push(context); return { content: [{ type: 'text', text: String(args.text) }] }; },
      } } }),
    };
    const dir = await mkdtemp(join(tmpdir(), 'riffet-plugin-tools-'));
    const booted = await createApp({ stateDir: dir, token: MASTER, cliPath: '/nonexistent/cursor-agent', plugins: [probe] });
    try {
      await booted.dispatch.close();
      await booted.plugins.refresh();
      const project = booted.store.createProject(dir, 'tools');
      const mcp = async (sessionId: string) => {
        const spec = booted.riffetMcp.server(sessionId)!;
        const token = (JSON.parse(await readFile(spec.args[spec.args.indexOf('--credential') + 1]!, 'utf8')) as { credential: string }).credential;
        return (method: string, params?: unknown) => booted.app.inject({ method: 'POST', url: '/api/riffet-mcp', headers: { authorization: `Bearer ${token}` }, payload: { method, params } }).then(response => response.json().result);
      };
      const chosen = booted.store.createSession({ projectId: project.id, kind: 'native', toolGroups: [GROUP] });
      const plain = booted.store.createSession({ projectId: project.id, kind: 'native', toolGroups: [] });
      const rpc = await mcp(chosen.id), other = await mcp(plain.id);

      expect(((await rpc('tools/list')).tools as Array<{ name: string }>).map(tool => tool.name)).toContain('probe_echo');
      expect(((await other('tools/list')).tools as Array<{ name: string }>).map(tool => tool.name)).not.toContain('probe_echo');
      expect((await rpc('tools/call', { name: 'probe_echo', arguments: { text: 'hi' } })).content[0].text).toBe('hi');
      expect(calls.map(call => [call.sessionId, call.projectId, call.projectPath])).toEqual([[chosen.id, project.id, project.cwd]]);
      // Another conversation cannot reach it, even by name.
      expect((await other('tools/call', { name: 'probe_echo', arguments: { text: 'x' } })).content[0].text).toContain('TOOL_NOT_AVAILABLE');

      await booted.plugins.update('acme.probe', { enablement: 'off' });
      expect(((await rpc('tools/list')).tools as Array<{ name: string }>).map(tool => tool.name)).not.toContain('probe_echo');
      expect((await rpc('tools/call', { name: 'probe_echo', arguments: { text: 'x' } })).content[0].text).toMatch(/TOOL_NOT_AVAILABLE.*turned off/);
      expect(calls).toHaveLength(1);
    } finally { await booted.app.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
