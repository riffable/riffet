import { z } from 'zod/v4';
import { SETTING_DEFAULTS, type AppSettings } from '../../../../packages/contracts/src/settings.js';
import { defineRead, defineSettingCommand } from '../assistant-capability.js';
import { AppError } from '../errors.js';
import type { SettingsService } from './index.js';

/** Adding a server setting requires deciding where an owner should manage it. */
const locations = {
  editorCommand: 'files', defaultModel: 'backends', defaultMode: 'backends', notifications: 'notifications',
  allowOutsideRead: 'files', allowInsecureChat: 'devices', cursorCli: 'backends', taskWorkspaceRoot: 'files', defaultBackendId: 'backends',
  nativeBackendDefaults: 'backends', composerEnterBehavior: 'interaction', composerRunningBehavior: 'interaction',
  composerSendLater: 'interaction', auxiliaryModels: 'auxiliary', pluginModels: 'auxiliary', idleReclaimMinutes: 'service',
  maxAgentMemoryMb: 'service', quickChat: 'quickchat', assistant: 'assistant', workItems: 'workitems',
  sidebarPinned: 'sidebar', teamMemberOrder: 'sidebar', voiceInput: 'interaction', titleRules: 'titles', terminal: 'terminal',
} satisfies Record<keyof AppSettings, string>;

function settingSummary(id: keyof AppSettings, saved: AppSettings): Record<string,unknown> {
  switch (id) {
    case 'cursorCli': return { credentialConfigured: saved.cursorCli?.hasApiKey === true };
    case 'voiceInput': return { recognizer: saved.voiceInput?.recognizer ?? null, credentialConfigured: saved.voiceInput?.remote?.hasApiKey === true };
    case 'assistant': return { backendId: saved.assistant?.backendId ?? null, model: saved.assistant?.model ?? null, timeZone: saved.assistant?.timeZone ?? null };
    case 'workItems': return { backendId: saved.workItems?.backendId ?? null, model: saved.workItems?.model ?? null, composerSessions: saved.workItems?.composerSessions === true, verifier: saved.workItems?.verifier?.backendId ?? null };
    case 'terminal': return { defaultShell: saved.terminal?.defaultShell ?? null, shellIntegration: saved.terminal?.shellIntegration !== false, profiles: saved.terminal?.profiles?.length ?? 0 };
    case 'defaultBackendId': case 'defaultModel': case 'defaultMode': case 'idleReclaimMinutes': case 'maxAgentMemoryMb':
      return { configuredValue: saved[id] ?? null };
    case 'notifications': return { enabled: saved.notifications === true };
    case 'allowOutsideRead': return { configuredValue: saved.allowOutsideRead ?? null };
    default: return { configured: saved[id] !== undefined };
  }
}

// These setters already validate and persist through SettingsService. Other settings retain their domain-specific UI.
const writable = {
  composerEnterBehavior: { options: ['newline', 'send'], initial: SETTING_DEFAULTS.composerEnterBehavior },
  composerRunningBehavior: { options: ['queue', 'steer'], initial: SETTING_DEFAULTS.composerRunningBehavior },
  composerSendLater: { options: [false, true], initial: SETTING_DEFAULTS.composerSendLater },
} as const;
const writableId = z.string().min(1).max(100).describe('A writable setting ID from settings.catalog.');
const primitive = z.union([z.string().max(100), z.boolean()]);
export const instanceSettingArgs = z.strictObject({
  sourceTurn: z.string().min(1).max(64),
  setting: writableId, value: primitive, expectedValue: primitive.describe('Current effective value from settings.catalog, to avoid overwriting a concurrent edit.'),
});
type Writable = keyof typeof writable;
function editable(key: string): key is Writable { return Object.hasOwn(writable, key); }

/** The safe projection deliberately excludes paths, launch commands, credentials, and complete provider/plugin configs. */
export function instanceSettingsRead(settings: Pick<SettingsService, 'getSettings'>) {
  return defineRead('settings.catalog', 'Find a Riffet instance setting, its settings page, scope and allowed actions. Editable options include their current value. Provider credentials and permission rules are managed in Settings.',
    ['setting', 'settings', 'preference', 'preferences', '设置', '输入', '通知', '权限', '配置', '参数', '凭据'],
    z.strictObject({ section: z.string().max(80).optional() }), (_id, {section}) => {
      const saved = settings.getSettings();
      const entries = Object.entries(locations).filter(([, page]) => !section || section === page).map(([id, page]) => ({
        id, section: page, scope: 'instance',
        ...(editable(id) ? { action: 'setting_set', allowedValues: writable[id].options,
          value: saved[id] ?? writable[id].initial, takesEffect: 'when the client next reads settings' }
          : id === 'defaultBackendId' || id === 'nativeBackendDefaults'
            ? { action: 'agent_defaults_set', read: 'settings.agent_defaults', ownerConfirmationRequired: true }
            : { action: 'open_settings', ...settingSummary(id as keyof AppSettings, saved) }),
      }));
      return { settings: entries, observedAt: new Date().toISOString() };
    });
}

export function changeInstanceSetting(service: Pick<SettingsService,'setSettings'|'getSettings'>, args: z.output<typeof instanceSettingArgs>) {
  const { setting, value, expectedValue } = args;
  if (!editable(setting)) throw new AppError('TOOL_NOT_AVAILABLE', 'This setting is managed in the Riffet settings page.',403);
  const allowed: readonly (string | boolean)[] = writable[setting].options;
  if (!allowed.includes(value) || !allowed.includes(expectedValue)) throw new AppError('INVALID_ARGUMENT','Use a listed value for this setting.');
  const current = service.getSettings()[setting] ?? writable[setting].initial;
  if (current === value) return { setting, value: current, scope: 'instance', changed: false };
  if (current !== expectedValue) throw new AppError('SETTINGS_CONFLICT', 'The owner changed this setting. Read it again before editing.', 409);
  const persisted = service.setSettings({ [setting]: value });
  return { setting, value: persisted[setting], scope: 'instance', changed: true, takesEffect: 'when the client next reads settings' };
}

export const instanceSettingCommand = (service: SettingsService) => defineSettingCommand('setting_set',
  'Change a listed reversible instance-wide preference when the owner explicitly requests that scope. Read settings.catalog to obtain its current value and accepted options. All clients use the saved value when they next read settings.',
  instanceSettingArgs, args => changeInstanceSetting(service, args));
