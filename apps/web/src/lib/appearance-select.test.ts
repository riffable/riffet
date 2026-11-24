import { describe, expect, it } from 'vitest';
import { APPEARANCE_DEFAULT, type AppearanceCatalog } from '@contracts';
import { effectiveAppearance, parseSelection } from './appearance-select';

const asset = (name: string) => ({ url: `/api/appearance/assets/acme.pack/${name}`, sha256: name.padEnd(64, '0'), size: 1, type: 'application/json' });
const catalog: AppearanceCatalog = {
  version: 1, revision: 'r',
  palettes: [{ id: 'acme.pack/dusk', plugin: 'acme.pack', title: { en: 'Dusk' }, asset: asset('a') }, { id: 'acme.pack/dawn', plugin: 'acme.pack', title: { en: 'Dawn' }, asset: asset('b') }],
  fonts: [{ id: 'acme.pack/serif', plugin: 'acme.pack', title: { en: 'Serif' }, role: 'ui', family: 'Serif', fallback: [], files: [] }],
  backgrounds: [],
  logos: [{ id: 'acme.pack/mark', plugin: 'acme.pack', title: { en: 'Mark' }, asset: asset('c') }, { id: 'acme.pack/alt', plugin: 'acme.pack', title: { en: 'Alt' }, asset: asset('d') }],
  presets: [{ id: 'acme.pack/night', plugin: 'acme.pack', title: { en: 'Night' }, palette: 'acme.pack/dusk', fonts: { ui: 'acme.pack/serif' }, logo: 'acme.pack/mark' }],
};

describe('effective appearance', () => {
  it('takes the preset, lets a single choice win over it, and treats the default as the host', () => {
    expect(effectiveAppearance({ preset: 'acme.pack/night' }, catalog)).toMatchObject({ palette: { id: 'acme.pack/dusk' }, uiFont: { id: 'acme.pack/serif' }, logo: { id: 'acme.pack/mark' } });
    expect(effectiveAppearance({ preset: 'acme.pack/night', palette: 'acme.pack/dawn', logo: 'acme.pack/alt' }, catalog)).toMatchObject({ palette: { id: 'acme.pack/dawn' }, logo: { id: 'acme.pack/alt' } });
    expect(effectiveAppearance({ preset: 'acme.pack/night', palette: APPEARANCE_DEFAULT, logo: APPEARANCE_DEFAULT }, catalog)).toMatchObject({ palette: undefined, logo: undefined });
  });

  it('shows the default for a reference the catalog lacks, without rewriting what was stored', () => {
    const stored = JSON.stringify({ preset: 'gone.pack/night', palette: 'gone.pack/dusk' });
    expect(effectiveAppearance(parseSelection(stored), catalog)).toEqual({});
    expect(effectiveAppearance(parseSelection(stored), undefined)).toEqual({});
    expect(parseSelection(stored)).toEqual({ preset: 'gone.pack/night', palette: 'gone.pack/dusk' });
    expect(parseSelection('{"palette":3,"x":"y"}')).toEqual({});
  });
});
