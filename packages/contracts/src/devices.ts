/**
 * A set of Riffet tools a conversation's CLI is given through the Riffet MCP server.
 * `riffet.core` is the workbench's own (wake-ups, notices, devices); `device:<id>` is reserved for
 * the capabilities a paired device declares.
 */
/**
 * `device:<id>`, `server:<serverId>` (explicit per-conversation remote machine access over a server link),
 * a plugin's agent tools `<pluginId>/<name>` (`PluginDeclarations.agentTools`, docs/BROWSER.md §2), or
 * `riffet.agents`: the conversation may call any Agent, not only the ones the owner @-mentioned (docs/AGENT-CALLS.md §3);
 * `riffet.sessions`: it may message any running conversation, not only the ones the owner @-referenced (docs/SESSION-MESSAGES.md §3).
 */
export type ToolGroupId = 'riffet.core' | typeof AGENT_CALL_TOOL_GROUP | typeof SESSION_MESSAGE_TOOL_GROUP | `device:${string}` | `server:${string}` | `${string}.${string}/${string}`;
export const AGENT_CALL_TOOL_GROUP = 'riffet.agents';
export const SESSION_MESSAGE_TOOL_GROUP = 'riffet.sessions';
export const RIFFET_TOOL_GROUPS = ['riffet.core'] as const satisfies readonly ToolGroupId[];
/**
 * A one-shot wake-up an agent scheduled for its own conversation (`schedule_wakeup`). It is marked
 * `fired` before the turn is sent, so it starts at most one turn; `failed` and `missed` carry `error`.
 */
export interface RiffetWakeup {
  id: string; sessionId: string; dueAt: string; note: string; createdAt: string;
  status: 'pending' | 'fired' | 'cancelled' | 'failed' | 'missed';
  firedAt?: string; runId?: string; error?: string;
}
/** Something an agent asked to show the user (`notify_user`); `wakeup` marks the workbench's own notice about a wake-up that could not run. */
export interface RiffetNotice {
  id: string;
  sessionId: string;
  title?: string;
  body: string;
  createdAt: string;
  source: 'agent' | 'wakeup' | 'plugin';
  /** ISO timestamp once the owner marked this inbox message as read. */
  readAt?: string;
  /** Optional display name of the sender (e.g. team member name or plugin name). */
  senderName?: string;
}

export interface InboxNoticeList { notices: RiffetNotice[] }

/*
 * The device channel (docs/DEVICES.md §3). A paired device reports what it can do, keeps its own
 * stream open to receive calls and leases, and answers each call over HTTP.
 */
export const DEVICE_PLATFORMS = ['android', 'ios', 'mac'] as const;
export type DevicePlatform = typeof DEVICE_PLATFORMS[number];
/** T0 first, then T1. A device reports only those it can serve right now. */
export const DEVICE_CAPABILITIES = ['notify', 'clipboard.read', 'clipboard.write', 'location', 'photo', 'open_url', 'alarm', 'screen.observe', 'screen.act', 'app.launch', 'riffet.appearance', 'window.capture'] as const;
export type DeviceCapability = typeof DEVICE_CAPABILITIES[number];
/** One paired client's own local workbench preferences. An empty request reads them. */
export interface DeviceAppearanceRequest {
  themeId?: string; mode?: 'system' | 'light' | 'dark'; interfaceStyle?: string;
}
export interface DeviceAppearanceResult {
  themeId: string; mode: 'system' | 'light' | 'dark'; interfaceStyle?: string; activePaletteId?: string;
  themes: Array<{ id: string; name: string }>;
  interfaceStyles?: Array<{ id: string; name: string }>;
}
/**
 * `PUT /api/devices/me`, sent by the device before it opens its stream and whenever any of it changes.
 * `installationId` is random, made once per app installation: pairing again from the same installation
 * replaces the earlier record instead of adding another.
 */
export interface DeviceReport {
  platform: DevicePlatform; appVersion: string; capabilities: DeviceCapability[]; allowControl: boolean; installationId?: string;
  /** Absent leaves the stored registration as it is; `null` removes it. */
  push?: DevicePushRegistration | null;
}
/**
 * APNs registration an iOS device sends in `PUT /api/devices/me`. `topic` is the app's bundle id. The Live
 * Activity tokens are optional: `activityStartToken` is the push-to-start token, `activityToken` the running
 * summary activity's own; a report without `activityToken` means no activity is running.
 */
export interface DevicePushRegistration { token: string; topic: string; environment: 'production' | 'sandbox'; activityStartToken?: string; activityToken?: string; }
/**
 * How the server reaches a device in the background: `direct` pushes to APNs with the owner's key. `none` says
 * why not: the server holds no key, the device registered no token, or APNs refused the last push (`detail`).
 */
export interface DevicePushRoute { route: 'direct' | 'none'; reason?: 'no_key' | 'no_token' | 'failed'; detail?: string; }
/** `GET /api/devices`. A device that never reported has no capabilities and does not allow control. */
export interface DeviceInfo {
  id: string; name: string; platform?: DevicePlatform; appVersion?: string; createdAt: string; lastSeenAt?: string;
  /** Whether the device's stream is open now. */
  online: boolean; capabilities: DeviceCapability[]; allowControl: boolean;
  /** Present for iOS devices and any device that registered for push. */
  push?: DevicePushRoute;
  /** Six digits from this server's and the device's certificates, for a device paired over TLS; the app shows the same. */
  verificationCode?: string;
}
/**
 * `GET /api/settings/push`: the APNs auth key this server pushes with. The key itself is never returned.
 * `status` is `invalid` once APNs refused a token signed with it.
 */
export interface PushKeyStatus { configured: boolean; keyId?: string; teamId?: string; status?: 'ok' | 'invalid'; detail?: string; }
/** `PUT /api/settings/push`: `key` is the `.p8` file's PEM text. */
export interface PushKeyInput { keyId: string; teamId: string; key: string; }
/** A request for a device, the stream's `call` event. `deadline` is when the server stops waiting. */
export interface DeviceCall { callId: string; sessionId: string; capability: DeviceCapability; args: Record<string, unknown>; deadline: string; createdAt: string; }
/** The device's answer to a call (`POST /api/devices/me/calls/:callId/result`). */
export type DeviceCallOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message?: string };
/** What the server kept of the first answer; a repeated answer receives the same receipt. */
export interface DeviceCallReceipt { callId: string; outcome: DeviceCallOutcome; receivedAt: string; }
/** A file a device attached to a call's result (`result.fileIds`). */
export interface DeviceFile { fileId: string; name: string; mimeType: string; size: number; }
/** The stream's `lease` event: be connected shortly before `at`. Its id is the wake-up's. */
export interface DeviceLease { id: string; sessionId: string; at: string; reason: string; }
/**
 * `GET /api/devices/me/adb?package=<id>`: whether this phone is also connected to the server's Mac over adb.
 * `ready` means an adb entry in state `device` carries this installation's id file; `unauthorized` that none
 * matched but one is waiting for the USB-debugging prompt to be accepted; `no-adb` that the Mac has no adb.
 */
export interface DeviceAdbStatus { state: 'ready' | 'unauthorized' | 'absent' | 'no-adb'; }
/**
 * `POST /api/devices/me/adb/grant` `{ packageName }`: `WRITE_SECURE_SETTINGS` was granted over adb;
 * `restrictedSettings` is whether Android 13+ restricted settings were also allowed (`unsupported` on older systems).
 * A refused grant is 409 `ADB_GRANT_FAILED`, an unavailable phone 409 `ADB_UNAVAILABLE`.
 */
export interface DeviceAdbGrant { restrictedSettings: 'allowed' | 'unsupported'; }
/** One step of a recorded device action: `target` is the text of the control acted on, `code` a failed step's error. */
export interface RiffetDeviceActionStep { action: string; target?: string; effect?: string; code?: string; }
/**
 * `GET /api/sessions/:id/device-actions`: what a conversation did on a device's screen (`screen.act`,
 * `app.launch`), one record per call that reached the device. `category` and `authorizedBy` come from
 * the first irreversible step; `code` is why the call or its failing step did not succeed.
 */
export interface RiffetDeviceAction {
  id: string; sessionId: string; deviceId: string; createdAt: string;
  kind: 'act' | 'launch' | 'authorize'; package?: string; steps: RiffetDeviceActionStep[];
  category?: string; authorizedBy?: string; ok: boolean; code?: string;
}

/** What a caller may do on a server (docs/TRANSPORT-SECURITY.md §6). `chat` lets agents run commands, so it is not a boundary. */
export type AccessCapability = 'read' | 'chat' | 'exec' | 'admin';
/** The caller's own access, in bootstrap: whether its connection is encrypted, and what it may do over it. */
export interface ClientAccess { secure: boolean; capabilities: AccessCapability[] }
