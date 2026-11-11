import type { ModelInfo } from '@contracts';
import { describe,expect,it } from 'vitest';
import { backendSelection } from './backends';
import { catalogSelection, parseSelection } from './models';

const select = (id: string, name: string, category: string, current: string, values: Array<[string, string]>) => ({
  id, name, category, type: 'select' as const, currentValue: current,
  options: values.map(([value, label]) => ({ value, name: label })),
});

const opus: ModelInfo = {
  value: 'claude-opus-5-5',
  name: 'Claude Opus 5.5',
  configOptions: [
    select('effort', 'Effort', 'thought_level', 'default', [['default', 'Default'], ['low', 'Low'], ['high', 'High']]),
    select('thinking', 'Thinking', 'model_config', 'false', [['false', 'Off'], ['true', 'On']]),
    select('fast', 'Fast', 'model_config', 'false', [['false', 'Off'], ['true', 'On']]),
    select('context', 'Context', 'model_config', '300k', [['300k', '300K'], ['1m', '1M'], ['max', 'MAX']]),
  ],
  nativeVariants: [
    { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { value: 'claude-opus-5-5-high-fast', name: 'Claude Opus 5.5 High Fast' },
  ],
};
const catalog = [opus];

const actualShapeOpus: ModelInfo = {
  value: 'claude-opus-5-5',
  name: 'Claude Opus 5.5',
  configOptions: [
    select('effort', 'Effort', 'thought_level', 'medium', [
      ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'xhigh'], ['max', 'Max'],
    ]),
    select('fast', 'Fast', 'model_config', 'false', [['false', 'Off'], ['true', 'On']]),
    select('context', 'Context', 'model_config', '300k', [['300k', '300K'], ['1m', '1M'], ['max', 'MAX']]),
  ],
  // This mirrors the CLI catalog shape: there is no bare id or thinking control.
  nativeVariants: [
    { value: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 Low' },
    { value: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 High' },
    { value: 'claude-opus-5-5-high-fast', name: 'Claude Opus 5.5 High Fast' },
  ],
};

describe('Variant-grouped selection restoration and submission', () => {
  it('restores a saved high-fast variant without turning the visible context default into a CLI override', () => {
    const restored = backendSelection('acme.agent', catalog, 'claude-opus-5-5-high-fast');
    const parsed = parseSelection(restored);

    expect(parsed).toEqual({
      model: 'claude-opus-5-5',
      params: { effort: 'high', thinking: 'false', fast: 'true' },
    });
    expect(catalogSelection(catalog, parsed.model, parsed.params)).toBe('claude-opus-5-5-high-fast');
  });

  it('restores and submits high-fast against a catalog without a bare variant or Thinking option', () => {
    const actualCatalog = [actualShapeOpus];
    const restored = backendSelection('acme.agent', actualCatalog, 'claude-opus-5-5-high-fast');
    const parsed = parseSelection(restored);

    expect(catalogSelection(actualCatalog, parsed.model, parsed.params)).toBe('claude-opus-5-5-high-fast');
    expect(catalogSelection(actualCatalog, parsed.model, {
      context: '300k', effort: 'high', fast: 'true',
    })).toBe('claude-opus-5-5[context=300k,effort=high,fast=true]');
  });
});

describe('Claude native context restoration and submission', () => {
  it('restores native 1M suffixes without losing explicit effort, Fast or a context reset', () => {
    const claudeCatalog: ModelInfo[] = [{
      value: opus.value,
      name: 'Opus 5.5',
      configOptions: [
        select('effort', 'Effort', 'thought_level', 'default', [['default', '默认'], ['high', 'High']]),
        select('fast', 'Fast', 'model_config', 'default', [['default', '默认'], ['false', '关闭'], ['true', '开启']]),
        select('context', '上下文', 'model_config', 'default', [['default', '默认'], ['1m', '1M']]),
      ],
    }];
    for (const suffix of ['[1m]', '[1M][1m]']) {
      const parsed = parseSelection(backendSelection('claude', claudeCatalog, `${opus.value}${suffix}[effort=high,fast=true]`));
      expect(parsed).toEqual({ model: opus.value, params: { context: '1m', effort: 'high', fast: 'true' } });
      expect(parseSelection(catalogSelection(claudeCatalog, parsed.model, parsed.params))).toEqual(parsed);
    }
    const reset = `${opus.value}[1m][context=default,fast=false]`;
    expect(parseSelection(backendSelection('claude', claudeCatalog, reset)).params).toEqual({ context: 'default', effort: 'default', fast: 'false' });
    expect(backendSelection('droid', claudeCatalog, reset)).toBe(reset);
    expect(backendSelection('claude', [], reset)).toBe(reset);
  });
});
