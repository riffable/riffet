import type { NativeBackendId, TextRef } from './index.js';

export type ExtensionKind = 'skill' | 'mcp' | 'plugin' | 'hook' | 'rule' | 'command' | 'config';
export type ExtensionScope = 'user' | 'project' | 'managed' | 'builtin';
export type ExtensionRuntimeState = 'unknown' | 'loaded' | 'error' | 'pending';
export type ExtensionAction = 'enable' | 'disable' | 'install' | 'update' | 'uninstall' | 'reload' | 'login';

export interface ExtensionManagementCapabilities {
  actions: ExtensionAction[];
  kinds: Partial<Record<ExtensionKind, ExtensionAction[]>>;
  installScopes?: Array<'user' | 'project'>;
  reason?: string;
}

export interface ExtensionActionRequest {
  action: ExtensionAction;
  itemId?: string;
  /** Provider-native identifier, e.g. plugin@marketplace or an MCP server id. */
  target?: string;
  scope?: 'user' | 'project';
  /** Current Skill manifest hash, required for file lifecycle operations. */
  expectedHash?: string;
}

export interface ExtensionActionResult {
  success: boolean;
  output?: string;
  authorizationUrl?: string;
  applyEffect: string;
  applyEffectRef?: TextRef;
  diagnostics?: string[];
}

export interface ExtensionRuntimeEntry {
  sessionId: string;
  kind: ExtensionKind;
  name: string;
  sourcePath?: string;
  enabled?: boolean;
  state: ExtensionRuntimeState;
  message?: string;
  tools?: string[];
}

export interface ExtensionRuntimeReport {
  entries: ExtensionRuntimeEntry[];
  diagnostics: string[];
  checkedAt: string;
}

export interface ExtensionContext {
  backendId: NativeBackendId;
  profileId: string;
  projectId?: string;
}

export interface ExtensionItem {
  /** Stable, opaque identifier. It is scoped to a backend profile and source path. */
  id: string;
  kind: ExtensionKind;
  name: string;
  description?: string;
  scope: ExtensionScope;
  sourcePath?: string;
  ownerPluginId?: string;
  /** Provider-native identifier for native management actions. */
  nativeId?: string;
  enabled?: boolean;
  /** File discovery cannot establish that an agent loaded or connected to an item. */
  runtimeState: ExtensionRuntimeState;
  readOnlyReason?: string;
  documentId?: string;
  actions?: ExtensionAction[];
  /** Describes the scope of the available management actions. */
  managementNote?: string;
}

export interface ExtensionFile {
  id: string;
  path: string;
  editable: boolean;
  reason?: string;
}

export interface ExtensionDetail {
  item: ExtensionItem;
  files: ExtensionFile[];
}

export interface ExtensionDocument extends ExtensionFile {
  content: string;
  hash: string;
  language: 'json' | 'toml' | 'yaml' | 'markdown' | 'text';
  /** Describes when edits become visible to the native agent. */
  applyEffect: string;
  applyEffectRef?: TextRef;
  /** Raw YAML/TOML is intentionally not parsed by riffet; this explains that limit to the editor. */
  validationNote?: string;
}

export interface ExtensionCreateTarget {
  id: string;
  label: string;
  kind: 'skill' | 'rule' | 'command' | 'mcp' | 'hook';
  scope: 'user' | 'project';
  /** Normalized, root-relative directory in which a new document may be created. */
  directory: string;
  /** File name expected by the selected kind, when fixed by the agent. */
  fileName?: string;
  /** Agent-native initial content; clients should prefer this over generic templates. */
  template?: string;
}

export interface ExtensionInventory {
  backendId: NativeBackendId;
  profileId: string;
  items: ExtensionItem[];
  diagnostics: string[];
  createTargets: ExtensionCreateTarget[];
  checkedAt: string;
}
