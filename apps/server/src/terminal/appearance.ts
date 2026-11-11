import type { IncomingHttpHeaders } from 'node:http';
import { TERMINAL_APPEARANCE_HEADER, type TerminalAppearance } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { resolveTerminalAppearance } from '../../../../packages/plugin-api/src/kit/terminal-appearance.js';
import type { Store } from '../store.js';

export { resolveTerminalAppearance };

export function readTerminalAppearance(headers?: IncomingHttpHeaders): TerminalAppearance | undefined {
  const value = headers?.[TERMINAL_APPEARANCE_HEADER];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6};#[0-9a-f]{6}$/i.test(value)) {
    throw new AppError('INVALID_TERMINAL_APPEARANCE', 'Terminal appearance requires two six-digit hexadecimal colors');
  }
  const [foreground, background] = value.split(';');
  return resolveTerminalAppearance({ foreground, background });
}

/** Records the next launch's preference; a running terminal keeps its process appearance. */
export function recordTerminalAppearance(store: Store, id: string, headers?: IncomingHttpHeaders) {
  const appearance = readTerminalAppearance(headers);
  const session = store.getSession(id);
  if (!appearance || sameTerminalAppearance(session.terminalAppearance, appearance)) return session;
  return store.updateSession(id, { terminalAppearance: appearance });
}

export function sameTerminalAppearance(a?: TerminalAppearance, b?: TerminalAppearance): boolean {
  return a?.foreground === b?.foreground && a?.background === b?.background;
}
