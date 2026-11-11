import { describe, expect, it } from 'vitest';
import { commandIdOfMessageId, commandIdOfSteerPlaceholder, isTaggedMessageId } from './message-tag.js';

describe('Codex message tags', () => {
  it('reads only the workbench prefix', () => {
    expect(isTaggedMessageId('riffet-command-1')).toBe(true);
    expect(commandIdOfMessageId('riffet-command-1')).toBe('command-1');
    expect(commandIdOfSteerPlaceholder('riffet-steer:command-1')).toBe('command-1');
    expect(commandIdOfMessageId('riffet-')).toBeUndefined();
    expect(commandIdOfMessageId('tui-1')).toBeUndefined();
    expect(commandIdOfSteerPlaceholder('[Image #1]')).toBeUndefined();
  });
});
