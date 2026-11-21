export * from './extensions.js';
export * from './update.js';
export * from './theme.js';
export * from './code-theme.js';
export * from './vscode-code-theme.js';
export * from './share.js';
export * from './sync.js';
export type * from './control.js';
export * from './model-selection.js';
export * from './owner.js';
export type * from './plugin-management.js';
export * from './plugin-page.js';
export type * from './plugins.js';
export type * from './plugin-packages.js';
export type * from './tasks.js';
export type * from './channels.js';
export type * from './appearance.js';
export { APPEARANCE_BACKGROUND_AREAS, APPEARANCE_BACKGROUND_FITS, APPEARANCE_DEFAULT, APPEARANCE_FONT_ROLES, APPEARANCE_FONT_STYLES, APPEARANCE_MAX_FONT_BYTES, APPEARANCE_MAX_IMAGE_BYTES, APPEARANCE_MAX_PALETTE_BYTES } from './appearance.js';
export { PLUGIN_CAPABILITIES, PLUGIN_SOURCE_BUILTIN, PLUGIN_WEB_API_VERSION } from './plugin-packages.js';
export { AGENT_ICON_ROUTE, VIEW_ICON_ROUTE, PLUGIN_CHANNEL_ROUTE, COMMAND_ICONS, COMMAND_MENUS, COMMAND_SCOPES, DECLARATION_SCOPES, MODEL_USE_FALLBACKS, PLUGIN_CLIENTS, PLUGIN_ID, ASSISTANT_PACK_NAME, VIEW_INSTANCES, VIEW_LOCATION_SCOPES, VIEW_LOCATIONS, isContributionOf, resolveLocalizedText } from './plugins.js';
export { NATIVE_BACKEND_IDS, compareAgentOrder, PLUGIN_AGENT_ID, PLUGIN_AGENT_ID_MAX, isAgentOfPlugin, isBuiltinBackendId, isNativeBackendId, isPluginAgentId } from './agent-ids.js';
export type { BuiltinBackendId, NativeBackendId, PluginAgentId } from './agent-ids.js';
export { isDoneUnseen, isRunningSession, isUnread, needsYou } from './session-attention.js';
export { ASSISTANT_BACKENDS, assistantChoice, isAssistantBackend, workItemAgentChoice, type AssistantChoice } from './assistant-choice.js';

export * from './protocol.js';
export * from './devices.js';
export * from './dictation.js';
export * from './council.js';
export type * from './agent-calls.js';
export type * from './session.js';
export type * from './run.js';
export * from './terminal.js';
export * from './budgets.js';
export type * from './servers.js';
export type * from './native.js';
export type * from './workspace.js';
export type * from './git.js';
export type * from './orchestration.js';
export * from './backends.js';
export * from './settings.js';
export * from './title-rules.js';
export * from './shortcuts.js';
export type * from './stats.js';
export type * from './folder-favorites.js';
export type * from './service-monitor.js';
export type * from './storage.js';
export type * from './marks.js';
export type * from './trace.js';
export * from './work-items.js';

export { samePromptText } from './prompt-match';

export * from './icon-pack.js';

// The design system's values (docs/design/system/foundations.md), for its specimen page.
export { DESKTOP_TEXT, MAC_MOTION, MOTION_DURATION, MOTION_EASING, SPACE } from './design-tokens.js';
export { MOBILE_BASE_DIMENSIONS, MOBILE_EASING, MOBILE_EXPRESSIVE_MOTION, MOBILE_IOS_TEXT, MOBILE_MOTION, MOBILE_RIFFET_MOTION, MOBILE_SHARED_MOTION, MOBILE_STYLE_DIMENSIONS } from './mobile-styles.js';
export { DESKTOP_STYLE_RECIPES, DESKTOP_STYLES } from './interface-styles.js';
export type { DesktopStyle, DesktopStyleLength, DesktopStyleRecipes } from './interface-styles.js';

export { satisfies, validRange } from './semver.js';
