// The agent kit: pure helpers the core and the plugins share (docs/design/plugin-system.md §5.1).
// Each file keeps the behaviour it had in the core, whose old path re-exports it, so a plugin and
// the core run the same code and agree on it (`AppError` is one class, so `instanceof` holds across).
// No file here may import the core: structural types stand in for its hosts and requests.
export * from './activity.js';
export * from './attachments.js';
export * from './cli-check.js';
export * from './cli-resolve.js';
export * from './cli-version.js';
export * from './config-documents.js';
export * from './deferred-steer.js';
export * from './environment.js';
export * from './errors.js';
export * from './exec.js';
export * from './gateway.js';
export * from './hook-server.js';
export * from './machine.js';
export * from './query-directory.js';
// The title policy is the core's; a plugin reads a provider's title through these rules and no more.
export { PLACEHOLDER_TITLES, firstHumanMessage, firstMessageTitlePatch, isPlaceholderTitle, nativeTitlePatch, providerTitlePatch } from './session-title.js';
export * from './share-read.js';
export * from './skill-files.js';
export * from './slash-tokens.js';
export * from './stats.js';
export * from './terminal-appearance.js';
export * from './terminal-text.js';
export * from './tokens.js';
export * from './tool-images.js';
export * from './turn-metrics.js';
export * from './turn-tracker.js';
export * from './workspace.js';
