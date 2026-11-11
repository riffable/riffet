import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { ExtensionCreateTarget, ExtensionKind } from '@contracts';

export const extensionKinds: Record<ExtensionKind, string> = {
  skill: 'Skills', mcp: 'MCP', plugin: 'Plugins', hook: 'Hooks', rule: 'Rules', command: 'Commands',
  get config() { return i18n._(msg`配置文件`); },
};
export const extensionScopes = {
  get user() { return i18n._(msg({ message: '用户级', context: 'common-scope-user' })); },
  get project() { return i18n._(msg({ message: '项目级', context: 'common-scope-project' })); },
  get managed() { return i18n._(msg`外部维护`); },
  get builtin() { return i18n._(msg`内置`); },
};

export function extensionTemplate(target: ExtensionCreateTarget): string {
  if (target.template !== undefined) return target.template;
  if (target.kind === 'skill') return `---\nname: my-skill\ndescription: ${i18n._(msg`描述适用场景`)}\n---\n\n${i18n._(msg`在这里编写操作说明。`)}\n`;
  if (target.kind === 'mcp') return '{\n  "mcpServers": {}\n}\n';
  if (target.kind === 'hook') return '{}\n';
  return `# ${i18n._(msg`操作说明`)}\n\n`;
}

export function extensionNewPath(target: ExtensionCreateTarget): string {
  return [target.directory, target.kind === 'skill' ? 'my-skill/SKILL.md' : target.fileName ?? (target.kind === 'rule' ? 'my-rule.md' : 'my-command.md')].filter(Boolean).join('/');
}
