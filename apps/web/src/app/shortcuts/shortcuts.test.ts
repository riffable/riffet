import { describe, expect, it } from 'vitest';
import { registerKeybindings } from '../pluginKeybindings';
import { recordedBinding } from './chords';
import { effectiveBindings, findConflict, hostChordBindings, withBindings } from './index';

describe('shortcut table on the web', () => {
  it('reports a held or browser-owned chord, and lets a rebinding free the old one for plugins', () => {
    expect(findConflict('Mod+B', 'search', {}, false)).toEqual({ kind: 'shortcut', id: 'toggleSidebar', customizable: true });
    expect(findConflict('Alt+3', 'search', {}, false)).toEqual({ kind: 'shortcut', id: 'tabGoTo', customizable: false });
    expect(findConflict('Mod+T', 'search', {}, false)).toEqual({ kind: 'reserved' });
    expect(findConflict('Mod+K', 'search', {}, false)).toBeUndefined();

    const moved = withBindings({}, 'search', ['Alt+Shift+K'], false);
    expect(effectiveBindings('search', moved, false)).toEqual(['Alt+Shift+K']);
    expect(hostChordBindings(false, moved)).not.toContain('Mod+K');
    const commands = [{ id: 'a/free', keybinding: 'Mod+K' }, { id: 'a/held', keybinding: 'Alt+Shift+K' }];
    expect(registerKeybindings(commands, false, moved).rejected.map((item) => item.id)).toEqual(['a/held']);
    expect(withBindings(moved, 'search', ['Mod+K'], false)).toEqual({});
  });

  it('records only usable chords', () => {
    const press = (code: string, extra: Partial<KeyboardEvent> = {}) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code, ...extra });
    expect(recordedBinding(press('KeyK', { metaKey: true }), true)).toBe('Mod+K');
    expect(recordedBinding(press('KeyK', { ctrlKey: true }), true)).toBe('Ctrl+K');
    expect(recordedBinding(press('KeyK', { ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+K');
    expect(recordedBinding(press('KeyK'), false)).toBeUndefined();
    expect(recordedBinding(press('ShiftLeft', { shiftKey: true, altKey: true }), false)).toBeUndefined();
  });
});
