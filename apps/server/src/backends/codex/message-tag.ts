/**
 * Prefix of the message id handed to a provider that echoes it as the user item's own `id`. The
 * TUI's messages carry ids too, so only this prefix marks a message the workbench sent.
 */
export const MESSAGE_ID_PREFIX = 'riffet-';
/** TRAE persists rich-input metadata even though turn/steer cannot accept a user message id. */
export const STEER_ELEMENT_PREFIX = 'riffet-steer:';

/** True for an id the workbench tagged a message with. */
export function isTaggedMessageId(id: string | undefined): id is string {
  return id !== undefined && id.startsWith(MESSAGE_ID_PREFIX);
}

/** The workbench command id inside a tagged message id; undefined when the id is not ours or empty. */
export function commandIdOfMessageId(id: string | undefined): string | undefined {
  return isTaggedMessageId(id) ? id.slice(MESSAGE_ID_PREFIX.length) || undefined : undefined;
}

/** The command id inside a steer placeholder, or undefined when the placeholder is not a steer marker. */
export function commandIdOfSteerPlaceholder(placeholder: string | undefined): string | undefined {
  return placeholder?.startsWith(STEER_ELEMENT_PREFIX) ? placeholder.slice(STEER_ELEMENT_PREFIX.length) : undefined;
}
