import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_API_VERSION, type Plugin } from '@riffet/plugin-api';
import { expect, it, vi } from 'vitest';
import { PluginRegistry } from '../plugins/registry.js';
import { Store } from '../store.js';
import { createAssistantWorkbenchQueries } from './workbench-queries.js';

it('projects workbench identity, plugin authorization and restart impact from committed state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riffet-workbench-queries-'));
  const store = new Store(':memory:');
  const groupId = 'acme.browser/browser';
  const status = vi.fn(async () => ({ state: 'ready' as const, message: 'private status details' }));
  const browser: Plugin = {
    manifest: {
      id: 'acme.browser', vendor: 'acme', name: 'Browser', title: { 'zh-Hans': '浏览器' }, apiVersion: PLUGIN_API_VERSION, defaultEnabled: true,
      contributes: { agentTools: [{ id: groupId, title: { en: 'Browser' }, toolPrefix: 'probe_' }] },
    },
    activate: () => ({
      status,
      agentTools: { [groupId]: { tools: [{ name: 'probe_open', description: 'Open', inputSchema: { type: 'object' } }], call: async () => ({ content: [] }) } },
    }),
  };
  const plugins = new PluginRegistry({ stateDir: directory, plugins: [browser] });
  try {
    await plugins.refresh();
    status.mockClear();
    const draft = store.createProject(join(directory, 'assistant'), 'Assistant');
    const main = store.createSession({ projectId: draft.id, kind: 'native', backendId: 'codex', model: 'configured' });
    store.updateProject(draft.id, { system: 'assistant', mainSessionId: main.id });
    const background = store.createSession({ projectId: draft.id, kind: 'native', backendId: 'codex', origin: { kind: 'assistant', job: 'delegation' } });
    const work = store.createProject(join(directory, 'work'), 'Work');
    const visible = store.createSession({ projectId: work.id, kind: 'native', title: 'Visible' });
    const queries = createAssistantWorkbenchQueries({
      store, ownerName: () => undefined, timeZone: () => 'Asia/Shanghai',
      nativeStatus: () => ({ phase: 'busy', model: 'reported' }),
      pluginSettings:(id,offset,limit)=>plugins.workbenchSettingFields(id,offset,limit),pluginInventory: () => plugins.workbenchInventory(),
      pluginToolGroups: session => plugins.agentToolGroups().filter(({ declaration }) => session.toolGroups?.some(id => id === declaration.id))
        .map(({ group, declaration }) => ({ id: declaration.id, tools: group.tools.map(tool => tool.name) })),
      restartability: () => ({
        restartable: false, draining: true,
        blockers: [
          { sessionId: visible.id, title: 'Visible', backendId: 'cursor', reason: 'turn' },
          { sessionId: background.id, title: 'Private background', backendId: 'codex', reason: 'background' },
        ],
      }),
    });

    expect(() => queries.identity(background.id)).toThrow('only available to the personal assistant main conversation');
    expect(queries.identity(main.id)).toMatchObject({
      owner: { name: null, timeZone: 'Asia/Shanghai', timeZoneSource: 'configured' },
      assistant: { role: 'main', backendId: 'codex', configuredModel: 'configured', runtimeModel: 'reported' },
    });
    expect(await queries.plugins(main.id, { query: '浏览器' })).toMatchObject({ plugins: [{ id: 'acme.browser', active: true }], total: 1 });
    expect(await queries.plugin(main.id, 'acme.browser')).toMatchObject({ toolGroups: [{ authorized: false, serverAvailable: false, reasons: ['not_authorized_for_session'] }] });
    store.updateSession(main.id, { toolGroups: [groupId] });
    expect(await queries.plugin(main.id, 'acme.browser')).toMatchObject({ toolGroups: [{ authorized: true, serverAvailable: true, cliLoaded: 'unknown', tools: ['probe_open'] }] });
    expect(status).not.toHaveBeenCalled();
    await plugins.update('acme.browser', { enablement: 'off' });
    expect(await queries.plugin(main.id, 'acme.browser')).toMatchObject({ plugin: { active: false, enablement: 'off' }, toolGroups: [{ authorized: true, serverAvailable: false, reasons: ['disabled'] }] });
    expect(queries.restartImpact(main.id)).toMatchObject({
      restartable: false, draining: true, hasHiddenBlockers: true, blockers: [{ sessionId: visible.id, reason: 'turn' }],
    });
  } finally {
    await plugins.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
