import type { AgentExtensionLayout } from '@riffet/plugin-api/experimental/agent';
import { cursorCommand, cursorConfigDirectory, cursorLaunchProfileOf } from '../cli-driver.js';

const SKILLS = ['.cursor/skills', '.agents/skills', '.claude/skills', '.codex/skills'];
const HOOKS = '{\n  "version": 1,\n  "hooks": {}\n}\n';

/**
 * Where cursor-agent keeps its skills, rules, commands, MCP servers, hooks and plugins. User-level
 * configuration is the profile's `configDir`, else the launch profile's, else the CLI's own directory.
 */
export const CURSOR_EXTENSION_LAYOUT: AgentExtensionLayout = {
  userRoot(config, configDir) {
    return configDir ?? cursorConfigDirectory(typeof config.executable === 'string' ? config.executable : 'cursor-agent');
  },
  applyEffect: 'Cursor may need a reload or a new session to apply this change.',
  configFiles: {
    user: [{ relative: 'mcp.json', kind: 'mcp' }, { relative: 'hooks.json', kind: 'hook' }, { relative: 'hooks/hooks.json', kind: 'hook' }, { relative: 'cli.json', kind: 'config' }, { relative: 'cli-config.json', kind: 'config' }],
    project: [{ relative: '.cursor/mcp.json', kind: 'mcp' }, { relative: '.cursor/hooks.json', kind: 'hook' }, { relative: '.cursor/hooks/hooks.json', kind: 'hook' }, { relative: '.cursor/cli.json', kind: 'config' }],
  },
  directories: {
    user: { skill: [], rule: ['rules'], command: [], plugin: ['plugins'] },
    project: { skill: SKILLS, rule: ['.cursor/rules'], command: ['.cursor/commands'], plugin: ['.cursor/plugins'] },
  },
  ruleFiles: { user: [], project: ['.cursorrules'] },
  create: {
    user: [
      { id: 'mcp', label: 'MCP configuration', kind: 'mcp', directory: '', fileName: 'mcp.json' },
      { id: 'hook', label: 'Hook configuration', kind: 'hook', directory: '', fileName: 'hooks.json', template: HOOKS },
    ],
    project: [
      { id: 'skill', label: 'Skill', kind: 'skill', directory: '.agents/skills' },
      { id: 'rule', label: 'Rule', kind: 'rule', directory: '.cursor/rules' },
      { id: 'command', label: 'Command', kind: 'command', directory: '.cursor/commands' },
      { id: 'mcp', label: 'MCP configuration', kind: 'mcp', directory: '.cursor', fileName: 'mcp.json' },
      { id: 'hook', label: 'Hook configuration', kind: 'hook', directory: '.cursor', fileName: 'hooks.json', template: HOOKS },
    ],
  },
  sharedRoot: {
    directories: { skill: SKILLS, command: ['.cursor/commands'] },
    create: [{ id: 'skill', label: 'Skill', kind: 'skill', directory: '.cursor/skills' }, { id: 'command', label: 'Command', kind: 'command', directory: '.cursor/commands' }],
  },
  skillsAlwaysEnabled: true,
  command(config, args) {
    return cursorCommand(cursorLaunchProfileOf(config), args, {}, { includeApiKey: false });
  },
};
