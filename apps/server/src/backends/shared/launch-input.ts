import type { Session, TerminalAppearance } from '../../../../../packages/contracts/src/index.js';
import type { NativeBackendHost } from '../types.js';

/**
 * The session fields that shape how an agent CLI is launched or which tools it starts with: the one
 * list a prewarmed process is matched against (docs/PLUGIN_ARCHITECTURE.md, 预热). A field added here
 * fails to compile in every backend's warm key (`LaunchKeyParts`) until that backend states what it
 * does with it, so a warm process can no longer be handed to a conversation it was not started for.
 */
export interface SessionLaunchInput {
  model: string | undefined;
  approval: string | undefined;
  appearance: TerminalAppearance | undefined;
  /** The Riffet MCP tool signature for this conversation; '' when there is none. */
  tools: string;
  extensionsOff: Session['extensionsOff'];
}

export function sessionLaunchInput(host: NativeBackendHost, session: Session): SessionLaunchInput {
  return {
    model: session.model,
    approval: session.approval,
    appearance: session.terminalAppearance,
    tools: host.riffetMcp?.signature?.(session.id) ?? '',
    extensionsOff: session.extensionsOff,
  };
}

/** A field a backend's launch does not read, with the reason, in place of the value it would key on. */
export const notKeyed = (reason: string) => ({ notKeyed: reason }) as const;

/** What a backend keys a warm process on: every launch field, used or `notKeyed`. */
export type LaunchKeyParts = { [Field in keyof SessionLaunchInput]: unknown };
