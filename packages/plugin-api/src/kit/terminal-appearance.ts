import type { TerminalAppearance } from '@riffet/contracts';
import { AppError } from './errors.js';

/**
 * Validates a client-reported appearance. An unknown one stays unknown: the pane then keeps tmux's
 * default colours, which every viewer paints with its own theme, instead of a guessed dark one.
 */
export function resolveTerminalAppearance(value?: TerminalAppearance): TerminalAppearance | undefined {
  if (!value) return undefined;
  const appearance = value;
  if (typeof appearance.foreground !== 'string' || typeof appearance.background !== 'string'
    || !/^#[0-9a-f]{6}$/i.test(appearance.foreground) || !/^#[0-9a-f]{6}$/i.test(appearance.background)) {
    throw new AppError('INVALID_TERMINAL_APPEARANCE', 'Terminal appearance requires two six-digit hexadecimal colors');
  }
  return { foreground: appearance.foreground.toLowerCase(), background: appearance.background.toLowerCase() };
}
