import type { NativeBackendId } from './agent-ids.js';
import type { AssistantJob } from './session.js';
import type { WorkItemStatus } from './work-items.js';

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
export interface NativeBackendDefaults {
  profileId?: string; model?: string; mode?: string; approval?: string;
  /**
   * The model last picked on each provider, by profile id, with its parameters (`model[effort=high]`).
   * The server keeps it from the `profileId`/`model` pairs it is sent and ignores this field in a
   * save; switching to a provider without naming a model starts on its entry here.
   */
  profileModels?: Record<string, string>;
}
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
   * The model chosen for each use a plugin declares (`PluginDeclarations.modelUses`), by its declaration ID, from the
   * same list as `auxiliaryModels`. Kept while the plugin is off or uninstalled, so turning it on again keeps the choice.
   * An unset use falls back to what its declaration names.
   */
  pluginModels?: Record<string, AuxiliaryModelRef>;
  /**
   * Minutes a conversation's CLI may go unused, with nothing retaining it (docs/guide/performance.md
   * §3.10), before its terminal and app-server are stopped. The next message resumes it. Unset means
   * `AGENT_PROCESS_BUDGET.idleMinutes`; 0 never reclaims for idleness.
   */
  idleReclaimMinutes?: number;
  /**
   * Resident memory, in MiB, all conversation CLIs may hold together; past it the least recently used
   * ones nothing retains are stopped first. Unset means `AGENT_PROCESS_BUDGET.memoryBytes`; 0 sets no limit.
   */
  maxAgentMemoryMb?: number;
  quickChat?: QuickChatSettings;
  assistant?: AssistantSettings;
  workItems?: WorkItemSettings;
  /**
   * The destinations the sidebar shows as rows, in order, on every device; the rest sit under its
   * 更多 menu. Unset means `DEFAULT_SIDEBAR_PINNED`. Ids a client does not offer are kept and skipped.
   */
  sidebarPinned?: string[];
  /** 语音输入 (docs/VOICE.md §6), on every device. Unset, or no `recognizer`, means off. */
  voiceInput?: VoiceInputSettings;
}
/**
 * How dictation is transcribed: `recognizer` is `REMOTE_SPEECH_RECOGNIZER` for the service in `remote`, or the id of a
 * plugin that declares `contributes.speechRecognizer`. Kept while that plugin is off; dictation then reports why it cannot start.
 */
export interface VoiceInputSettings {
  recognizer?: string;
  /** A BCP-47 hint such as `zh` or `en`; unset lets the recognizer detect it. */
  language?: string;
  remote?: RemoteSpeechSettings;
}
/** An OpenAI-format `/v1/audio/transcriptions` service. The key is write-only: clients see `hasApiKey`. */
export interface RemoteSpeechSettings { baseUrl?: string; model?: string; hasApiKey?: boolean }
/** Each field given replaces its own; `null` clears it. `remote.apiKey` sets or (with `null`) removes the key. */
export interface VoiceInputSettingsUpdate {
  recognizer?: string | null;
  language?: string | null;
  remote?: { baseUrl?: string | null; model?: string | null; apiKey?: string | null };
}
/**
 * Pages the sidebar reaches, as `AppSettings.sidebarPinned` names them. 新会话 and 搜索内容 are
 * actions and always rows; 个人资料, 主题 and 设置 stay in the account menu. A client offers the ones
 * it has (`activity` is the Mac's).
 */
export const SIDEBAR_DESTINATIONS = ['assistant', 'tasks', 'automations', 'council', 'marks', 'plugins', 'extensions', 'stats', 'activity'] as const;
export type SidebarDestination = typeof SIDEBAR_DESTINATIONS[number];
export const DEFAULT_SIDEBAR_PINNED: readonly SidebarDestination[] = ['assistant', 'tasks', 'automations'];
/** The most ids `sidebarPinned` holds; past it the server refuses the list. */
export const SIDEBAR_PINNED_MAX = 32;
/**
 * The agent and model a client's 助理 composer starts with (docs/ASSISTANT.md §2), on every device.
 * Unset, it follows the composer's own choice. The 助理's instructions are the `AGENTS.md` of its
 * project (`/api/assistant/instructions`), not a setting.
 */
export interface AssistantSettings {
  backendId?: NativeBackendId; profileId?: string; model?: string;
  /** The owner's IANA time zone, as the client they last used reports it: the 助理 is told the time in it. Unset, the server's. */
  timeZone?: string;
  /** 跟进 (docs/ASSISTANT.md §7.2): the 助理 looks at a task's conversation once it stops. Off unless switched on: each look is a run the owner pays for. */
  supervision?: boolean;
  /** 记忆整理 (docs/ASSISTANT.md §7.4), nightly and before the main conversation is summarized. Unset means on. */
  consolidation?: boolean;
  /** Background runs started in any 24 hours; past it the rest wait. Unset, `ASSISTANT_BUDGET.dailyRuns`. */
  dailyRuns?: number;
  /**
   * 助理派发任务 (docs/TASK-BOARD.md §10): `edits` (unset) lets it start work that changes nothing; `all` leaves
   * every task it plans as a card the owner starts, which the server holds it to.
   */
  dispatch?: 'edits' | 'all';
}
/**
 * 任务看板's settings (docs/TASK-BOARD.md §10), on every device. `backendId`, `profileId` and `model` are what a new
 * task is given to; unset, the composer's default agent and that agent's defaults.
 */
export interface WorkItemSettings {
  /** A conversation started from the composer opens a task too. Unset means off. */
  composerSessions?: boolean;
  backendId?: NativeBackendId; profileId?: string; model?: string;
}
/** Each field given replaces its own; `null` clears it. */
export type WorkItemSettingsUpdate = { [K in keyof WorkItemSettings]?: WorkItemSettings[K] | null };
/** Each field given replaces its own; `null` clears it. */
export type AssistantSettingsUpdate = { [K in keyof AssistantSettings]?: AssistantSettings[K] | null };
/** What starts a delegation's run: a time, or a change the server watches for without the model. */
export type AssistantDelegationTrigger =
  | { kind: 'schedule'; cron: string; timeZone?: string }
  | { kind: 'github-release'; repo: string; everyMinutes?: number }
  | { kind: 'page'; url: string; everyMinutes?: number }
  | { kind: 'task-status'; workItemId: string; taskNumber: number; status: WorkItemStatus };
/**
 * Something the owner handed the 助理 to follow over time (docs/ASSISTANT.md §7.3). It ends on `until`,
 * or when the owner or the 助理 ends it. `cursor` holds a release tag, page digest, or last consumed task event id.
 */
export interface AssistantDelegation {
  id: string;
  goal: string;
  /** What is worth acting on, and what is worth telling the owner about. */
  attention: string;
  trigger: AssistantDelegationTrigger;
  until: string;
  state: 'active' | 'ended';
  endedReason?: 'expired' | 'owner' | 'assistant' | 'task-deleted';
  cursor?: string;
  lastCheckedAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}
/**
 * `GET /api/assistant/runs/usage`: the background runs of the last `days` days by job, with the tokens their
 * conversations reported; `started` counts the last 24 hours against `limit`, and `waiting` the runs held back by it.
 */
export interface AssistantRunUsage {
  days: number;
  jobs: Array<{ job: AssistantJob; runs: number; tokens: number }>;
  started: number;
  limit: number;
  waiting: number;
}
/**
 * A capability pack of the 助理 (docs/ASSISTANT.md §8.2): a plugin folder under its `packs/`, with a skill, the
 * memory topic it keeps, and the MCP servers it needs. `entry` is the command that starts its work (`/travel:plan`),
 * shown as an entry above the 助理's composer once installed. `builtIn` packs ship with Riffet and can be added or
 * removed; others were put there by the owner.
 */
export interface AssistantPack {
  id: string;
  title: string;
  description?: string;
  entry?: string;
  installed: boolean;
  builtIn: boolean;
}
/** `GET`/`PUT /api/assistant/instructions`; `custom` is false while the file holds Riffet's own text. A `PUT` of `null` restores it. */
export interface AssistantInstructions { text: string; custom: boolean; }
/** A file the 助理 made for the owner in its `files/` folder; `path` is relative to it. */
export interface AssistantFile { path: string; size: number; modifiedAt: string }
/** One topic file of the 助理's memory, as it wrote it. */
export interface AssistantMemoryEntry { name: string; text: string; modifiedAt: string; }
/**
 * What the 助理 remembers, for its owner to read (docs/ASSISTANT.md §2): its profile of them (`USER.md`), the
 * index it keeps, and the topic files beside the index, newest first. `updatedAt` is the latest change to any of them.
 */
export interface AssistantMemory { profile: string; index: string; entries: AssistantMemoryEntry[]; updatedAt?: string; }
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
/** How an auxiliary model is invoked: directly over HTTP, or by spawning a CLI child process. */
export type AuxiliaryModelTransport = 'http' | 'cli-process';
/** A model behind one backend profile's gateway, as `AppSettings.auxiliaryModels` stores it. */
export interface AuxiliaryModelRef { backendId: NativeBackendId; profileId: string; model: string; }
/** One choice for an auxiliary model: a gateway model plus the profile name it is listed under. */
export interface AuxiliaryModelOption extends AuxiliaryModelRef { profileName: string; transport?: AuxiliaryModelTransport; }
/** `default` is the fast fallback for bounded auxiliary tasks; `chat` is the default model of a new quick chat; `summary` writes the one-sentence turn summaries of the canvas. */
export const AUXILIARY_MODEL_PURPOSES = ['default', 'title', 'handoff', 'chat', 'summary'] as const;
export type AuxiliaryModelPurpose = typeof AUXILIARY_MODEL_PURPOSES[number];
export type AuxiliaryModels = Partial<Record<AuxiliaryModelPurpose, AuxiliaryModelRef>>;
/** Only the purposes given change; `null` clears one. */
export type AuxiliaryModelsUpdate = Partial<Record<AuxiliaryModelPurpose, AuxiliaryModelRef | null>>;
/** Each field given replaces its own; `presets: null` restores the defaults. */
export type QuickChatSettingsUpdate = Omit<QuickChatSettings, 'presets'> & { presets?: QuickChatPreset[] | null };
/** Only the uses given change; `null` clears one. */
export type PluginModelsUpdate = Record<string, AuxiliaryModelRef | null>;
export type AppSettingsUpdate = (Omit<Partial<AppSettings>, 'cursorCli' | 'auxiliaryModels' | 'pluginModels' | 'quickChat' | 'assistant' | 'workItems' | 'voiceInput'> & { cursorCli?: never; voiceInput?: VoiceInputSettingsUpdate; auxiliaryModels?: AuxiliaryModelsUpdate; pluginModels?: PluginModelsUpdate; quickChat?: QuickChatSettingsUpdate; assistant?: AssistantSettingsUpdate; workItems?: WorkItemSettingsUpdate }) | { cursorCli: CursorCliSettingsUpdate };
