import type { NativeBackendId } from './agent-ids.js';

/** What a message's `{name}` placeholders are filled with. */
export type TextParams = Record<string, string | number>;
/**
 * Text a client words in its own language: `code` names the message in `i18n/errors/*.json`, which
 * every client's catalogs are generated from. Sits beside an older string field, which stays the
 * English fallback (or the Chinese a record stored before the field existed).
 */
export interface TextRef { code: string; params?: TextParams; }
/**
 * `message` is English, for developers and logs; clients show the text `code` names, filled with
 * `params` (docs/guide/architecture.md, 界面语言).
 */
export interface ApiError { error: { code: string; message: string; params?: TextParams; details?: unknown }; }
export interface CursorCliSettings {
  executable?: string;
  configDir?: string;
  apiEndpoint?: string;
  agentEndpoint?: string;
  disableAutoUpdate?: boolean;
  /** Read-only status of the server-saved key. */
  hasApiKey?: boolean;
}
export type CursorCliSettingsUpdate = Omit<CursorCliSettings, 'hasApiKey'> & { apiKey?: string | null; hasApiKey?: never };
export interface NativeBackendDefaults { profileId?: string; model?: string; mode?: string; approval?: string; }
export interface AppSettings {
  editorCommand?: string; defaultModel?: string; defaultMode?: string; notifications?: boolean; allowOutsideRead?: boolean; cursorCli?: CursorCliSettings;
  /** Server-side root for new task workspaces. An empty value restores the platform default. */
  taskWorkspaceRoot?: string;
  defaultBackendId?: NativeBackendId;
  nativeBackendDefaults?: Partial<Record<NativeBackendId, NativeBackendDefaults>>;
  /**
   * What Enter does in the composer, on every device signed in to this workbench: `'newline'`
   * (default) breaks the line and Cmd/Ctrl+Enter sends; `'send'` sends on Enter. Cmd/Ctrl+Enter
   * sends under both, so the setting can never leave the keyboard without a way to submit.
   */
  composerEnterBehavior?: 'newline' | 'send';
  /**
   * Where a new message goes while the agent is working. Unset means `'queue'`.
   * `'steer'` joins the current turn only when the backend exposes a live steer target;
   * otherwise the message follows the normal queue path.
   */
  composerRunningBehavior?: 'queue' | 'steer';
  /** Shows send later beside the composer's send button. Off unless set. */
  composerSendLater?: boolean;
  /**
   * Models the workbench calls itself, one per purpose, each picked from a gateway a backend profile
   * already holds credentials for, so no second key is stored. `title` names a conversation whose CLI
   * offers no title worth keeping; `handoff` condenses a conversation for the agent taking it over.
   * An unset purpose means the workbench does that job without a model, or not at all.
   */
  auxiliaryModels?: AuxiliaryModels;
  /**
   * Minutes a conversation's CLI may sit idle — no turn, nothing pending, nobody viewing it — before
   * its terminal and app-server are stopped. Reopening the conversation resumes it. Unset means
   * `DEFAULT_IDLE_RECLAIM_MINUTES`; 0 never reclaims for idleness.
   */
  idleReclaimMinutes?: number;
  /**
   * Most conversation CLIs kept running at once; past it the least recently active idle ones are
   * reclaimed first. Unset means `DEFAULT_MAX_LIVE_AGENTS`; 0 sets no limit.
   */
  maxLiveAgents?: number;
  quickChat?: QuickChatSettings;
}
export interface QuickChatSettings {
  /**
   * Days a quick chat may go without a new message before it is archived; unset means
   * `DEFAULT_QUICK_CHAT_RETENTION_DAYS`, 0 never. Pinned chats and chats holding a mark are kept.
   */
  retentionDays?: number;
  /** What a system entry (selected text, a share, a shortcut) opens: an overlay over the app in use, or the whole app. Unset is `sheet`. */
  openMode?: 'sheet' | 'page';
  /**
   * The instructions a chat can start with, offered as the chat backend's modes (`preset:<id>`).
   * `GET /api/settings` always carries the effective list; saving `null` restores the defaults.
   */
  presets?: QuickChatPreset[];
}
export interface QuickChatPreset { id: string; name: string; prompt: string }
export const DEFAULT_QUICK_CHAT_RETENTION_DAYS = 7;
export const DEFAULT_QUICK_CHAT_PRESETS: readonly QuickChatPreset[] = [
  { id: 'translate', name: '翻译', prompt: '翻译用户发来的内容：中文译成英文，其他语言译成简体中文。单个词或短语另给读音、词性和一个简短例句。只回复译文，不加评论。' },
  { id: 'explain', name: '解释', prompt: '用用户的语言简明解释用户发来的内容：先说它是什么，再说最要紧的一两点。不要开场白。' },
  { id: 'polish', name: '润色', prompt: '改写用户发来的文字，使其清楚自然，保持原有语言、意思和语气。只回复改写后的文字。' },
];
export const DEFAULT_IDLE_RECLAIM_MINUTES = 360;
export const DEFAULT_MAX_LIVE_AGENTS = 24;
/** A model behind one backend profile's gateway, as `AppSettings.auxiliaryModels` stores it. */
export interface AuxiliaryModelRef { backendId: NativeBackendId; profileId: string; model: string; }
/** One choice for an auxiliary model: a gateway model plus the profile name it is listed under. */
export interface AuxiliaryModelOption extends AuxiliaryModelRef { profileName: string; }
/** `chat` is the default model of a new quick chat; `summary` writes the one-sentence turn summaries of the canvas. */
export const AUXILIARY_MODEL_PURPOSES = ['title', 'handoff', 'chat', 'summary'] as const;
export type AuxiliaryModelPurpose = typeof AUXILIARY_MODEL_PURPOSES[number];
export type AuxiliaryModels = Partial<Record<AuxiliaryModelPurpose, AuxiliaryModelRef>>;
/** Only the purposes given change; `null` clears one. */
export type AuxiliaryModelsUpdate = Partial<Record<AuxiliaryModelPurpose, AuxiliaryModelRef | null>>;
/** Each field given replaces its own; `presets: null` restores the defaults. */
export type QuickChatSettingsUpdate = Omit<QuickChatSettings, 'presets'> & { presets?: QuickChatPreset[] | null };
export type AppSettingsUpdate = (Omit<Partial<AppSettings>, 'cursorCli' | 'auxiliaryModels' | 'quickChat'> & { cursorCli?: never; auxiliaryModels?: AuxiliaryModelsUpdate; quickChat?: QuickChatSettingsUpdate }) | { cursorCli: CursorCliSettingsUpdate };
