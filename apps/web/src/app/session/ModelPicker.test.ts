import type { ModelInfo, NativeBackendUsage } from '@contracts';
import { describe, expect, it } from 'vitest';
import { modelUsageAliases } from './model';
import { modelUsageStatus } from './ModelPicker';

const usage: NativeBackendUsage = {
  fetchedAt: '2026-11-26T07:45:50.812Z',
  models: {
    'gemini-4-hydrogen-high': { quota: { usedPercent: 0 } },
    'gemini-4-neon-high': { quota: { usedPercent: 25 } },
    'claude-opus-5-5-high': { quota: { usedPercent: 40 } },
    'claude-opus-5-5-medium': { quota: { usedPercent: 10 } },
  },
};

describe('modelUsageAliases and modelUsageStatus', () => {
  it('collects aliases, nativeVariants and non-default effort suffixes', () => {
    const item: ModelInfo = {
      value: 'gemini-4-hydrogen',
      name: 'Gemini 4 Hydrogen',
      configOptions: [{
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'medium',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      }],
      nativeVariants: [{ value: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' }],
      aliases: ['gemini-4-hydrogen', 'gemini-4-hydrogen-high'],
    };

    expect(modelUsageAliases(item)).toEqual([
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-xhigh',
      'gemini-4-hydrogen-low',
      'gemini-4-hydrogen-medium',
    ]);
  });

  it('matches exact model IDs first and falls back to variant aliases', () => {
    const hydrogen = {
      id: 'sg\u0000gemini-4-hydrogen',
      aliases: ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium'],
    };
    expect(modelUsageStatus(usage, hydrogen, 'sg')).toEqual({ quota: { usedPercent: 0 } });
    expect(modelUsageStatus(usage, hydrogen, 'other')).toBeUndefined();

    const neon = {
      id: 'sg\u0000gemini-4-neon',
      aliases: ['gemini-4-neon-low', 'gemini-4-neon-medium', 'gemini-4-neon-high'],
    };
    expect(modelUsageStatus(usage, neon, 'sg')).toEqual({ quota: { usedPercent: 25 } });
  });

  it('prefers the selected effort variant and picks the most constrained alias otherwise', () => {
    const opus = {
      id: 'sg\u0000claude-opus-5-5',
      aliases: ['claude-opus-5-5-medium', 'claude-opus-5-5-high'],
    };
    expect(modelUsageStatus(usage, opus, 'sg', 'medium', true)).toEqual({ quota: { usedPercent: 10 } });
    expect(modelUsageStatus(usage, opus, 'sg', 'medium', false)).toEqual({ quota: { usedPercent: 40 } });
  });
});
