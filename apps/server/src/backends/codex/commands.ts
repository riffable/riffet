import type { NativeSlashItem } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';

export type CodexNativeCommand =
  | { type: 'compact' }
  | {
    type: 'review';
    target:
      | { type: 'uncommittedChanges' }
      | { type: 'custom'; instructions: string }
      | { type: 'baseBranch'; branch: string }
      | { type: 'commit'; sha: string; title?: string };
  };

export function codexNativeSlashItems(): NativeSlashItem[] {
  return [
    { name: 'compact', kind: 'command', description: 'Compact conversation context' },
    { name: 'review', kind: 'command', description: 'Review changes' },
  ];
}

/** Only a complete leading command token is native; paths and inline mentions stay text. */
export function parseCodexNativeCommand(text: string): CodexNativeCommand | undefined {
  const match = /^\s*\/(compact|review)(?=\s|$)/.exec(text);
  if (!match) return undefined;
  const instructions = text.slice(match[0].length).trim();
  if (match[1] === 'compact') {
    if (instructions) throw new AppError('NATIVE_COMMAND_ARGUMENTS', 'Use /compact without arguments.', 400);
    return { type: 'compact' };
  }
  return {
    type: 'review',
    target: instructions ? { type: 'custom', instructions } : { type: 'uncommittedChanges' },
  };
}
