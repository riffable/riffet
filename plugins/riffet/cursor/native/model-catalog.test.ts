import { describe, expect, it } from 'vitest';
import { nativeModelCatalogFromVariants, normalizeNativeModelSelection } from './model-catalog.js';

describe('normalizeNativeModelSelection', () => {
  const variants = [
    { value: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 High' },
    { value: 'claude-opus-5-5-high-fast', name: 'Claude Opus 5.5 High Fast' },
  ];

  it('repairs the parameter order of a saved Web selection before Cursor starts', () => {
    expect(normalizeNativeModelSelection('claude-opus-5-5[effort=high,fast=true,context=300k]', variants))
      .toBe('claude-opus-5-5[context=300k,effort=high,fast=true]');
  });

  it('rejects a saved model whose family is no longer available with an actionable error', () => {
    expect(() => normalizeNativeModelSelection('claude-opus-5-5-high-fast', [{ value: 'auto', name: 'Auto' }]))
      .toThrow(expect.objectContaining({
        code: 'INVALID_NATIVE_MODEL',
        statusCode: 400,
        message: expect.stringMatching(/claude-opus-5-5-high-fast.*choose another model/),
      }));
  });

  it('preserves exact listed variants and accepts parameters absent from the flat catalog', () => {
    expect(normalizeNativeModelSelection('claude-opus-5-5-high-fast', variants)).toBe('claude-opus-5-5-high-fast');
    expect(normalizeNativeModelSelection('claude-opus-5-5[context=max,effort=high,fast=true]', variants))
      .toBe('claude-opus-5-5[context=max,effort=high,fast=true]');
  });

  it('reports an unreadable catalog without claiming the selected model is unavailable', () => {
    expect(() => normalizeNativeModelSelection('claude-opus-5-5-high-fast', []))
      .toThrow(expect.objectContaining({ code: 'MODEL_CATALOG_UNAVAILABLE', statusCode: 503 }));
  });

  it('keeps Fast=false normalization for families without Fast', () => {
    const noFast = [{ value: 'gpt-5.6-luna-high', name: 'GPT-5.6 Luna High' }];
    expect(normalizeNativeModelSelection('gpt-5.6-luna[effort=high,context=1m]', noFast))
      .toBe('gpt-5.6-luna[context=1m,effort=high,fast=false]');
    expect(() => normalizeNativeModelSelection('gpt-5.6-luna[context=1m,effort=high,fast=true]', noFast))
      .toThrow('The native CLI does not support Fast for this model');
  });

  it('exposes the context selector for named families and hides it for opaque routers', () => {
    const entries = [
      { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
      { value: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen High' },
      { value: 'composer-2.5', name: 'Composer 2.5' },
      { value: 'grok-4', name: 'Grok 4' },
      { value: 'auto', name: 'Auto' },
      { value: 'auto-smart', name: 'Auto Smart' },
      { value: 'default', name: 'Default' },
      { value: 'cheetah', name: 'Cheetah' },
    ];
    const catalog = nativeModelCatalogFromVariants(entries);
    for (const id of ['gemini-4-hydrogen', 'composer-2.5', 'grok-4']) {
      expect(catalog.find((item) => item.value === id)?.configOptions.find((option) => option.id === 'context')).toMatchObject({
        currentValue: '300k',
        options: [{ value: '300k', name: '300K' }, { value: '1m', name: '1M' }, { value: 'max', name: 'MAX' }],
      });
    }
    for (const id of ['auto', 'auto-smart', 'default', 'cheetah']) {
      expect(catalog.find((item) => item.value === id)?.configOptions.find((option) => option.id === 'context')).toBeUndefined();
    }
    expect(normalizeNativeModelSelection('gemini-4-hydrogen[effort=high,context=1m]', entries))
      .toBe('gemini-4-hydrogen[context=1m,effort=high,fast=false]');
  });
});
