import { describe, expect, it } from 'vitest';
import { normalizeNativeModelSelection } from './model-catalog.js';

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
});
