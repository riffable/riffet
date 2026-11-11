import { describe, expect, it } from 'vitest';
import { avatars } from './index.js';

const ids = avatars.manifest.contributes!.avatarStyles!.map(style => style.id);
const provided = (avatars.activate as () => { avatarStyles: Record<string, { generate(request: unknown): string }> })().avatarStyles;
const request = { seed: 'abc', size: 128, ink: '#2b2a27', paper: '#efebe3' };

describe('riffet.avatars', () => {
  it('provides every style it declares, and nothing else', () => {
    expect(Object.keys(provided).sort()).toEqual([...ids].sort());
  });

  it('draws the same SVG for the same request, whatever has been drawn in between', () => {
    for (const id of ['riffet.avatars/notionists', 'riffet.avatars/seal']) {
      const first = provided[id]!.generate({ ...request, name: '何' });
      provided[id]!.generate({ ...request, seed: 'other', name: '李' });
      expect(provided[id]!.generate({ ...request, name: '何' })).toBe(first);
    }
  });

  it('paints a DiceBear style on the paper and draws the seal from the first character of the name only', () => {
    expect(provided['riffet.avatars/lorelei']!.generate(request)).toContain('efebe3');
    const seal = provided['riffet.avatars/seal']!.generate({ ...request, name: '<何&>' });
    expect(seal).toContain('&lt;');
    expect(seal).not.toContain('何');
    expect(() => provided['riffet.avatars/seal']!.generate(request)).toThrow();
  });
});
