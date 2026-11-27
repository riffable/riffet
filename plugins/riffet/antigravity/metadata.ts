import type { AgentCapabilities, AgentExtensionLayout } from '@riffet/plugin-api/experimental/agent';
import { parseAgyProfile } from './config.js';

export const COMMANDS = ['model', 'mode', 'mcp', 'skills', 'plugins', 'hooks', 'clear', 'resume', 'rewind', 'help'];

export function capabilities(): AgentCapabilities {
  return {
    modes: [
      { id: 'agent', label: 'Agent', description: 'Asks before each file edit' },
      { id: 'plan', label: 'Plan', description: 'Investigates read-only and proposes a plan before changing anything' },
      { id: 'accept-edits', label: 'Accept edits', description: 'Edits files in the workspace without asking' },
      { id: 'auto', label: 'Auto', description: 'Edits without asking; another model reviews commands that leave the sandbox' },
    ],
    // agy keeps file edits under the mode above; these govern terminal commands and other tools.
    permissions: [
      { id: 'request-review', label: 'Ask each time', description: 'Asks before each command' },
      { id: 'strict', label: 'Strict' },
      { id: 'proceed-in-sandbox', label: 'Sandbox', description: 'Runs commands in a sandbox without asking; file edits follow the mode' },
      { id: 'always-proceed', label: 'Run everything', description: 'Runs edits, commands and MCP tools without asking' },
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
    profileFields: { executablePlaceholder: 'agy', configDir: false, sourceDir: 'config', disableAutoUpdate: true },
    slashCommands: [],
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
