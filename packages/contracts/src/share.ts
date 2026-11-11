import type { NativeBackendId, NativeJob, NativeWorkbenchEvent, Run, TextRef, WorkbenchEvent } from './index.js';
import type { CustomTheme } from './theme.js';
import type { AppearanceBackgroundFit } from './appearance.js';

export interface ShareModelInfo {
  model: string;
  reasoningEffort?: string;
  fast?: boolean;
  serviceTier?: string;
  source: 'history' | 'resolved';
}

export interface ShareAppearanceRequest {
  themeId: string;
  mode: 'system' | 'light' | 'dark';
  themeRevision?: string;
  /** Contribution ids of the plugin fonts and background in effect on the device. A share carries only the redistributable ones; a draft never echoes these back. */
  uiFont?: string;
  monoFont?: string;
  background?: string;
}

/** A plugin font frozen into the share package: `url` is package-relative, and `sha256` names the file. */
export interface ShareFont {
  fallback: string[];
  files: Array<{ url: string; sha256: string; weight?: string; style?: 'normal' | 'italic'; unicodeRange?: string }>;
}
export interface ShareBackground { url: string; opacity: number; fit: AppearanceBackgroundFit }

export interface ShareAppearance {
  themeId: string;
  mode: 'system' | 'light' | 'dark';
  customTheme?: CustomTheme;
  /** Redistributable plugin fonts and background that were in effect; without them the page uses its own. */
  fonts?: { ui?: ShareFont; mono?: ShareFont };
  background?: ShareBackground;
}

export interface ShareDraftRequest {
  selection?: ShareSelection;
  appearance?: ShareAppearanceRequest;
  /** Show the owner's name and avatar on the page; read from the owner profile when the draft is built. */
  author?: boolean;
}

/** A frozen reading copy. Provider configuration and untouched protocol payloads never belong here. */
export interface ShareSnapshot {
  format: 'riffet-share-v1';
  title: string;
  capturedAt: string;
  backendId: NativeBackendId;
  nativeChatId?: string;
  scope?: { mode: 'recent' | 'selected'; turnCount: number };
  /** Models of exported assistant messages, keyed by their original nativeId. */
  modelInfo?: Record<string, ShareModelInfo>;
  appearance?: ShareAppearance;
  /** The sharer as of the draft; `avatar` is package-relative. Absent when not shown or the owner has neither. */
  author?: { name?: string; avatar?: string };
  events: NativeWorkbenchEvent[];
  runs: Run[];
  subagents: Array<{ toolCallId: string; agentId: string; title?: string; prompt?: string; subagentType?: string; model?: string; events: WorkbenchEvent[] }>;
  jobs: NativeJob[];
  warnings: string[];
  /** Original resource reference -> frozen, package-relative resource. */
  resources: Record<string, ShareResource>;
  blobs: Record<string, string>;
  /** Diagram language -> package-relative isolated renderer page. */
  diagramPages: Record<string, string>;
  contentPage?: string;
}

export interface ShareResource {
  url: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  previewUrl?: string;
}

/** Where shares are published: the integration providing the publisher, and who can open its pages. */
export interface SharePublisherInfo { id: string; label: string; audience: string }

export interface ShareCapability {
  available: boolean;
  reason?: 'missing_cli' | 'unsupported_cli' | 'login_required' | 'permission_denied' | 'unavailable';
  message?: string;
  username?: string;
  profile?: string;
  /** Absent when no integration publishes shares; a draft is then a local preview only. */
  publisher?: SharePublisherInfo;
  /** The enabled publishers a new share can go to, in precedence order. Present only when there is more than one. */
  publishers?: SharePublisherInfo[];
}

export interface SessionShare {
  id: string;
  sessionId: string;
  title: string;
  alias: string;
  username: string;
  profile?: string;
  /** The integration that published it. Only that one, while it is the active publisher, can check or cancel it. */
  publisher?: string;
  url?: string;
  previewId?: string;
  deploymentId?: string;
  capturedAt?: string;
  expiresAt?: string;
  publishedHash?: string;
  /** Last successfully published choice; pending updates must not replace it. */
  appearance?: ShareAppearanceRequest;
  /** Last successfully published choice of showing the sharer. */
  author?: boolean;
  state: 'unpublished' | 'published' | 'removed';
  operation?: 'publishing' | 'removing' | 'uncertain';
  error?: string;
  errorRef?: TextRef;
  updatedAt: string;
}

export interface ShareDraft {
  id: string;
  sessionId: string;
  capturedAt: string;
  previewUrl: string;
  warnings: string[];
  /** When present, in step with `warnings`. */
  warningRefs?: TextRef[];
  bytes: number;
  appearance?: ShareAppearanceRequest;
  author?: boolean;
}

export interface ShareStatus {
  capability: ShareCapability;
  share: SessionShare | null;
  blocker?: { code: string; message: string; messageRef?: TextRef };
  actions: { preview: boolean; publish: boolean; remove: boolean; reconcile: boolean; retry: boolean };
}

export type ShareSelection =
  | { mode: 'all' }
  | { mode: 'recent'; count: number }
  | { mode: 'selected'; turnIds: string[]; nativeChatId?: string };

export interface ShareTurn { id: string; text: string; createdAt: string }
export interface ShareTurnCatalog { turns: ShareTurn[]; nativeChatId?: string }

export interface ShareDraftProgress {
  stage: 'auth' | 'history' | 'assets' | 'resources' | 'finalizing';
}

export type ShareDraftEvent =
  | { type: 'progress'; progress: ShareDraftProgress }
  | { type: 'ready'; draft: ShareDraft }
  | { type: 'error'; message: string; messageRef?: TextRef };
