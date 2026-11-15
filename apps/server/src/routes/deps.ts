import type { ExternalSessions } from '../native/external-sessions.js';
import type { TerminalHolds } from '../native/terminal-hold.js';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AppSettings, NativeRunInput, Run, Session } from '../../../../packages/contracts/src/index.js';
import type { Auth } from '../auth.js';
import type { NativeBackendService } from '../backends/service.js';
import type { GitService } from '../git/index.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { ServiceMonitor } from '../monitor.js';
import type { NativeDispatcher } from '../native/dispatch.js';
import type { SessionLock } from '../agent-host/session-lock.js';
import type { OrchestrationService } from '../orchestration/service.js';
import type { SessionCommands } from '../orchestration/session-commands.js';
import type { SettingsService } from '../settings/index.js';
import type { TaskService } from '../tasks/service.js';
import type { Store } from '../store.js';
import type { TerminalService } from '../terminal/index.js';
import type { ThemeService } from '../themes/index.js';
import type { OwnerService } from '../owner/index.js';
import type { TitleService } from '../titles/service.js';
import type { WorkspaceService } from '../workspace/index.js';
import type { TaskWorkspaceService } from '../task-workspaces/index.js';
import type { RiffetMcpService } from '../riffet-mcp/service.js';
import type { NoticeLog } from '../riffet-mcp/notices.js';
import type { SessionReferenceService } from '../context-references/service.js';
import type { DeviceChannel } from '../riffet-mcp/devices.js';
import type { DeviceAdb } from '../riffet-mcp/adb.js';
import type { WorkItemService } from '../work-items/index.js';
import type { ChannelService } from '../channels/service.js';

export type NativeMessageBody = { commandId?: string; text: string; attachments?: Array<{id?:string}>; context?: Array<{path?:string;line?:number}>; references?: unknown; expectedConfigRevision?: number };

/** What `createApp` hands every route group: its services and the request helpers they share. */
export interface RouteDeps {
  /** IM channels: accounts, bound users and chats (docs/design/channels.md). */
  channels: ChannelService;
  stateDir: string;
  /** Tasks (docs/TASK-BOARD.md). */
  workItems: WorkItemService;
  contextReferences: SessionReferenceService;
  store: Store;
  auth: Auth;
  settings: SettingsService;
  taskWorkspaces: TaskWorkspaceService;
  themes: ThemeService;
  /** The owner's name and avatar (docs/OWNER.md). */
  owner: OwnerService;
  terminal: TerminalService;
  workspace: WorkspaceService;
  git: GitService;
  sessionLock: SessionLock;
  nativeBackends: NativeBackendService;
  /** Enabled built-in plugins and their contributions (docs/PLUGIN_ARCHITECTURE.md). */
  plugins: PluginRegistry;
  /** Project tasks (docs/TASKS.md). */
  tasks: TaskService;
  dispatch: NativeDispatcher;
  orchestration: OrchestrationService;
  titles: TitleService;
  /** Each conversation's Riffet MCP server (docs/DEVICES.md §2). */
  riffetMcp: RiffetMcpService;
  /** Paired devices' presence, calls and leases (docs/DEVICES.md §3). */
  devices: DeviceChannel;
  /** The optional adb shortcut for a paired Android phone on this Mac's adb. */
  adb: DeviceAdb;
  /** Agent notices, announced on the lists stream. */
  notices: NoticeLog;
  /** Open SSE responses; the server's `preClose` hook ends them. */
  streams: Set<ServerResponse>;
  monitor: ServiceMonitor;
  /** Admission of new commands and the archive/configuration fences that refuse them. */
  sessionCommands: SessionCommands;
  /** [headers] are the request's: one relayed by a proxy came from another machine. */
  allowOutsideRead(headers?: IncomingHttpHeaders): boolean;
  effectiveSettings(headers?: IncomingHttpHeaders): AppSettings;
  renameNative(session: Session): void;
  readNativeInput(body: NativeMessageBody, options?: { validateAttachments?: boolean }): Promise<NativeRunInput>;
  nativeRuns(id: string): Run[];
  /** Provider conversations stored on this machine, for import (docs/TERMINAL-SESSIONS.md). */
  externalSessions: ExternalSessions;
  /** Conversations handed to a terminal by `riffet resume`. */
  terminalHolds: TerminalHolds;
}
