import path from 'node:path';
import type { AppSettings, CursorCliSettings, NativeBackendId, NativeBackendProfileSettings } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { atomicWritePrivateFile, readPrivateSettingsFile, validateApiKey } from './private-file.js';

const BACKEND = 'cursor';
const PROFILE = 'default';
const DEFAULT_NAME = 'Cursor CLI';
const SETTING_KEYS = ['executable', 'configDir', 'apiEndpoint', 'agentEndpoint', 'disableAutoUpdate'] as const;

export interface StoredCursorCli { settings: CursorCliSettings; apiKey?: string; exists: boolean }

/**
 * Cursor was the only backend before there were several, so what it stored keeps its place: the private
 * `cursor-cli.json` (the legacy `settings.json.cursorCli` is read until the file exists), `AppSettings.cursorCli`
 * with `hasApiKey`, the top-level `defaultModel`/`defaultMode`, and the built-in profile `default` that
 * maps onto them. Further Cursor profiles are stored like any other backend's; only `default` is handled
 * here. This holds the structure of that data only; whether the CLI can launch with it is the driver's
 * `validateProfileConfig`, asked before a save.
 */
export class CursorSettingsCompat {
  readonly path: string;

  constructor(private readonly options: { stateDir: string; cliPath?: string; validateProfileConfig?(backendId: NativeBackendId, config: Record<string, unknown>): void }) {
    this.path = path.join(options.stateDir, 'cursor-cli.json');
  }

  read(legacy?: CursorCliSettings): StoredCursorCli {
    const text = readPrivateSettingsFile(this.path);
    if (text === undefined) return { settings: this.validate(legacy ?? {}), exists: false };
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw corrupt(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw corrupt();
    const record = parsed as Record<string, unknown>;
    for (const key of Object.keys(record)) if (key !== 'apiKey' && !(SETTING_KEYS as readonly string[]).includes(key)) throw corrupt();
    const { apiKey, ...rawSettings } = record;
    return { settings: this.validate(rawSettings), ...(apiKey === undefined ? {} : { apiKey: validateApiKey(apiKey) }), exists: true };
  }

  validate(raw: unknown): CursorCliSettings {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('INVALID_SETTINGS', 'cursorCli must be an object');
    const values = raw as Record<string, unknown>;
    for (const key of Object.keys(values)) if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new AppError('INVALID_SETTINGS', `Unknown cursor CLI setting: ${key}`);
    const result: CursorCliSettings = {};
    for (const key of ['executable', 'configDir', 'apiEndpoint', 'agentEndpoint'] as const) {
      const value = values[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length > 8192 || /[\0\r\n]/.test(value)) throw new AppError('INVALID_SETTINGS', `cursorCli.${key} is invalid`);
      const trimmed = value.trim(); if (trimmed) result[key] = trimmed;
    }
    if (values.disableAutoUpdate !== undefined) {
      if (typeof values.disableAutoUpdate !== 'boolean') throw new AppError('INVALID_SETTINGS', 'cursorCli.disableAutoUpdate must be a boolean');
      result.disableAutoUpdate = values.disableAutoUpdate;
    }
    return result;
  }

  /** What the driver is handed as the default profile's config: the stored settings, the key, and the executable the server was started with. */
  config(stored: StoredCursorCli): Record<string, unknown> {
    return { ...stored.settings, ...(stored.apiKey ? { apiKey: stored.apiKey } : {}), ...(this.options.cliPath ? { cliPath: this.options.cliPath } : {}) };
  }

  /** `settings` with `cursorCli` as clients read it (no key, `hasApiKey` instead); nothing when nothing is stored. */
  expose(settings: AppSettings, legacy?: CursorCliSettings): AppSettings {
    const stored = this.read(legacy);
    if (!Object.keys(stored.settings).length && !stored.apiKey) return settings;
    return { ...settings, cursorCli: { ...stored.settings, hasApiKey: stored.apiKey !== undefined } };
  }

  /** A save of `cursorCli`: the stored settings with the request merged over them, validated in structure and then by the driver. */
  update(raw: unknown, stored: StoredCursorCli): StoredCursorCli {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('INVALID_SETTINGS', 'cursorCli must be an object');
    const cursor = { ...(raw as Record<string, unknown>) };
    if (Object.prototype.hasOwnProperty.call(cursor, 'hasApiKey')) throw new AppError('INVALID_SETTINGS', 'cursorCli.hasApiKey is read-only');
    let apiKey = stored.apiKey;
    if (Object.prototype.hasOwnProperty.call(cursor, 'apiKey')) {
      apiKey = cursor.apiKey === null ? undefined : validateApiKey(cursor.apiKey);
      delete cursor.apiKey;
    }
    const next: StoredCursorCli = { settings: this.validate({ ...stored.settings, ...cursor }), ...(apiKey ? { apiKey } : {}), exists: true };
    this.options.validateProfileConfig?.(BACKEND, this.config(next));
    return next;
  }

  write(next: StoredCursorCli): void {
    atomicWritePrivateFile(this.path, JSON.stringify({ ...next.settings, ...(next.apiKey ? { apiKey: next.apiKey } : {}) }, null, 2) + '\n');
  }

  /** The two kinds of setting live in two files, so one request carries one kind. */
  assertAlone(input: Record<string, unknown>): void {
    if (input.cursorCli !== undefined && Object.keys(input).some(key => key !== 'cursorCli')) throw new AppError('INVALID_SETTINGS', 'Save Cursor CLI settings and workbench settings in separate requests');
  }

  /** The top-level `defaultModel`/`defaultMode` are Cursor's own defaults: they follow into `nativeBackendDefaults` unless that names one. */
  mirrorDefaults(input: Record<string, unknown>, next: AppSettings): void {
    if (input.defaultModel === undefined && input.defaultMode === undefined) return;
    const requested = input.nativeBackendDefaults && typeof input.nativeBackendDefaults === 'object' && !Array.isArray(input.nativeBackendDefaults)
      ? (input.nativeBackendDefaults as Record<string, unknown>)[BACKEND] as Record<string, unknown> | undefined
      : undefined;
    const cursor = { ...(next.nativeBackendDefaults?.cursor ?? {}) };
    if (input.defaultModel !== undefined && requested?.model === undefined) cursor.model = next.defaultModel;
    if (input.defaultMode !== undefined && requested?.mode === undefined) cursor.mode = next.defaultMode;
    next.nativeBackendDefaults = { ...(next.nativeBackendDefaults ?? {}), cursor };
  }

  // The built-in profile list item and its saves.

  /** The profile a backend uses when settings name none. */
  defaultProfileId(backendId: NativeBackendId): string | undefined { return backendId === BACKEND ? PROFILE : undefined; }

  /** Puts the built-in profile, made from `cursorCli`, first in a listing that has no stored profile of that id. */
  addDefaultProfile(backendId: NativeBackendId, profiles: NativeBackendProfileSettings[], saved: AppSettings, defaultProfileId: string | undefined): void {
    if (backendId !== BACKEND || profiles.some(profile => profile.id === PROFILE)) return;
    const { hasApiKey, ...cli } = saved.cursorCli ?? {};
    // The new-session model is the default provider's; once another provider is the default, the built-in keeps only what it remembered.
    const defaults = saved.nativeBackendDefaults?.cursor;
    const defaultModel = !defaults?.profileId || defaults.profileId === PROFILE ? defaults?.model ?? saved.defaultModel : defaults.profileModels?.[PROFILE];
    profiles.unshift({ id: PROFILE, backendId, name: DEFAULT_NAME, ...cli, ...(defaultModel ? { defaultModel } : {}), hasApiKey: Boolean(hasApiKey), isDefault: defaultProfileId === PROFILE });
  }

  /** The built-in profile's config, when `profileId` names it. */
  profileConfig(backendId: NativeBackendId, profileId: string, legacy: () => CursorCliSettings | undefined): Record<string, unknown> | undefined {
    return backendId === BACKEND && profileId === PROFILE ? this.config(this.read(legacy())) : undefined;
  }

  refuseDelete(backendId: NativeBackendId, profileId: string): void {
    if (backendId === BACKEND && profileId === PROFILE) throw new AppError('INVALID_BACKEND_PROFILE', 'The built-in Cursor profile cannot be removed');
  }

  /** `cursorCli` has no room for a curated model list. */
  refuseCuratedModels(backendId: NativeBackendId, profileId: string, values: Record<string, unknown>): void {
    if (backendId === BACKEND && profileId === PROFILE && values.enabledModels !== undefined) throw new AppError('INVALID_BACKEND_PROFILE', 'The built-in Cursor profile does not support a curated model list');
  }

  /** What a save of the built-in profile changes (`cursorCli`, and the default model); undefined for any other profile. */
  profileUpdate(backendId: NativeBackendId, profileId: string, create: boolean, values: Record<string, unknown>, current: () => CursorCliSettings | undefined): { cursorCli: Record<string, unknown>; defaultModel?: string } | undefined {
    if (backendId !== BACKEND || profileId !== PROFILE) return undefined;
    if (create) throw new AppError('NATIVE_PROFILE_EXISTS', 'Cursor default profile already exists', 409);
    // `cursorCli` keeps no name, so a rename would be dropped without a word.
    if (typeof values.name === 'string' && values.name.trim() && values.name.trim() !== DEFAULT_NAME) throw new AppError('INVALID_BACKEND_PROFILE', 'The built-in Cursor profile cannot be renamed');
    const next: Record<string, unknown> = { ...(current() ?? {}) }; delete next.hasApiKey;
    // An agent endpoint equal to the API endpoint follows it, as the Cursor provider page saved the pair.
    const linked = (next.agentEndpoint ?? '') === (next.apiEndpoint ?? '');
    for (const key of ['executable', 'configDir', 'apiEndpoint', 'agentEndpoint', 'disableAutoUpdate'] as const) {
      if (values[key] === undefined) continue;
      next[key] = values[key] === null ? '' : values[key];
    }
    if (values.apiEndpoint !== undefined && values.agentEndpoint === undefined && linked) next.agentEndpoint = next.apiEndpoint;
    if (Object.prototype.hasOwnProperty.call(values, 'apiKey')) next.apiKey = values.apiKey;
    return { cursorCli: next, ...(values.defaultModel !== undefined ? { defaultModel: typeof values.defaultModel === 'string' ? values.defaultModel.trim() : '' } : {}) };
  }
}

const corrupt = () => new AppError('CURSOR_CLI_SETTINGS_CORRUPT', 'Private Cursor CLI settings are unavailable or invalid', 500);
