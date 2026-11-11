import { describe, expect, it } from 'vitest';
import { chordOf, registerKeybindings } from './pluginKeybindings';

describe('plugin keybindings', () => {
  it('keeps a free binding and drops one a host shortcut or an earlier plugin holds', () => {
    const { chords, rejected } = registerKeybindings([
      { id: 'acme.a/build', keybinding: 'Alt+Shift+B' },
      { id: 'acme.a/search', keybinding: 'Mod+K' },
      { id: 'acme.a/tab', keybinding: 'Alt+3' },
      { id: 'acme.b/other', keybinding: 'alt+shift+b' },
      { id: 'acme.b/bare', keybinding: 'B' },
    ], false);
    expect([...chords]).toEqual([['alt+shift+KeyB', 'acme.a/build']]);
    expect(rejected.map(({ id, reason }) => [id, reason])).toEqual([['acme.a/search', 'host'], ['acme.a/tab', 'host'], ['acme.b/other', 'plugin'], ['acme.b/bare', 'invalid']]);
    expect(chordOf({ ctrlKey: false, altKey: true, shiftKey: true, metaKey: false, code: 'KeyB' })).toBe('alt+shift+KeyB');
  });
});
