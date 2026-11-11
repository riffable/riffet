import type { ExtensionCreateTarget, ExtensionDetail, ExtensionInventory, ExtensionItem, ExtensionFile } from '../../../../packages/contracts/src/extensions.js';
import type { Project } from '../../../../packages/contracts/src/index.js';
import type { AgentExtensionLayout } from '@riffet/plugin-api';
import type { NativeBackendProfileConfig } from '../backends/types.js';

/** Internal request context. Profile configuration never crosses the HTTP boundary. */
export interface ExtensionContext {
  /** Extensions belong to an agent CLI; a quick chat has none. */
  backendId: Exclude<NativeBackendProfileConfig['backendId'], 'chat'>;
  profile: NativeBackendProfileConfig;
  project?: Project;
  /** The backend's own declaration of where its extensions live; absent for the backends whose rows `discovery.ts` still holds. */
  layout?: AgentExtensionLayout;
}

export interface ExtensionDocumentDescriptor extends ExtensionFile {
  absolutePath: string;
  root: string;
  relativePath: string;
  scope: 'user' | 'project' | 'managed' | 'builtin';
  language: 'json' | 'toml' | 'yaml' | 'markdown' | 'text';
  itemId?: string;
  applyEffect: string;
  projection?: 'claudeMcpServers';
}

export interface ExtensionSnapshot {
  inventory: ExtensionInventory;
  items: Map<string, ExtensionItem>;
  details: Map<string, ExtensionDetail>;
  documents: Map<string, ExtensionDocumentDescriptor>;
  createTargets: Map<string, { contract: ExtensionCreateTarget; root: string }>;
}
