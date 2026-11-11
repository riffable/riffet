import type { ModelInfo } from '@contracts';
import { describe,expect,it } from 'vitest';
import { catalogSelection,parseSelection } from './models';

const select = (id: string, name: string, category: string, current: string, values: Array<[string, string]>) => ({
  id, name, category, type: 'select' as const, currentValue: current,
  options: values.map(([value, label]) => ({ value, name: label })),
});

/** A Claude family with effort, thinking, Fast and the three context windows a variant-grouped catalog documents. */
const opus: ModelInfo = {
  value: 'claude-opus-5-5',
  name: 'Claude Opus 5.5',
  configOptions: [
    select('effort', 'Effort', 'thought_level', 'default', [
      ['default', 'Default'], ['none', 'Off'], ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'],
      ['high', 'High'], ['xhigh', 'xhigh'], ['extra-high', 'xhigh'], ['max', 'Max'],
    ]),
    select('thinking', 'Thinking', 'model_config', 'true', [['false', 'Off'], ['true', 'On']]),
    select('fast', 'Fast', 'model_config', 'false', [['false', 'Off'], ['true', 'On']]),
    select('context', 'Context', 'model_config', '300k', [['300k', '300K'], ['1m', '1M'], ['max', 'MAX']]),
  ],
  nativeVariants: [
    { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { value: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 High' },
    { value: 'claude-opus-5-5-max', name: 'Claude Opus 5.5 Max' },
    { value: 'claude-opus-5-5-fast', name: 'Claude Opus 5.5 Fast' },
  ],
};
const catalog = [opus];

describe('catalogSelection with native variant families', () => {
  it('keeps the flat CLI id while only suffix dimensions change', () => {
    const next = catalogSelection(catalog, 'claude-opus-5-5', { effort: 'high', thinking: 'false', fast: 'false' }, 'effort');
    expect(next).toBe('claude-opus-5-5-high');
  });

  it('falls back to the parameterized family form for the context window', () => {
    // The flat id cannot carry `context`, so returning it would make Max a no-op in the UI.
    const next = catalogSelection(catalog, 'claude-opus-5-5', { effort: 'high', thinking: 'false', fast: 'false', context: 'max' }, 'context');
    expect(next).toBe('claude-opus-5-5[context=max,effort=high,fast=false,thinking=false]');
    expect(parseSelection(next).params.context).toBe('max');
  });
});
