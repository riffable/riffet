import type { AgentCapabilities, AgentExtensionLayout } from '@riffet/plugin-api/experimental/agent';
import { parseAgyProfile } from './config.js';

export const COMMANDS = ['model', 'mode', 'mcp', 'skills', 'plugins', 'hooks', 'clear', 'resume', 'rewind', 'help'];

export function capabilities(): AgentCapabilities {
  return {
    modes: [
      { id: 'agent', label: 'Agent' },
      { id: 'plan', label: 'Plan' },
      { id: 'accept-edits', label: 'Accept edits' },
      { id: 'auto', label: 'Auto' },
    ],
    permissions: [
      { id: 'request-review', label: 'Ask each time' },
      { id: 'strict', label: 'Strict' },
      { id: 'proceed-in-sandbox', label: 'Sandbox' },
      { id: 'always-proceed', label: 'Run everything' },
    ],
    interactionTransport: 'both',
    supportsResume: true,
    supportsInterrupt: true,
    supportsTargetedStop: false,
    supportsHistory: true,
    supportsModelSelection: true,
    supportsModeSelection: true,
    supportsPermissionSelection: true,
    supportsTerminal: true,
    requiresLiveTerminal: true,
    supportsRiffetTools: true,
    supportsSessionReferences: true,
    consumesProtocols: ['google-generative-ai'],
    slashCommands: COMMANDS.map(name => ({ name })),
  };
}

export function extensionLayout(): AgentExtensionLayout {
  return {
    userRoot: config => parseAgyProfile(config).sourceDir,
    applyEffect: 'User customizations are copied when a new Antigravity conversation is created.',
    configFiles: {
      user: [
        { relative: 'config/mcp_config.json', kind: 'mcp' },
        { relative: 'config/hooks.json', kind: 'hook' },
        { relative: 'antigravity-cli/settings.json', kind: 'config' },
      ],
      project: [{ relative: '.gemini/settings.json', kind: 'config' }],
    },
    directories: {
      user: {
        skill: ['config/skills', 'antigravity-cli/skills', 'skills'],
        rule: ['config/rules'],
        command: [],
        plugin: ['config/plugins'],
      },
      project: { skill: ['.agents/skills'], rule: ['.agents/rules'], command: [], plugin: ['.agents/plugins'] },
    },
    ruleFiles: { user: ['AGENTS.md', 'GEMINI.md'], project: ['AGENTS.md', 'GEMINI.md'] },
    create: { user: [], project: [] },
  };
}
