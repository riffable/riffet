import { describe, expect, it } from 'vitest';
import { nativeModelCatalogFromVariants, normalizeNativeModelSelection } from './model-catalog.js';
import { decodeAvailableModels } from './model-parameters.js';

describe('normalizeNativeModelSelection', () => {
  const variants = [
    { value: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 High' },
    { value: 'claude-opus-5-5-high-fast', name: 'Claude Opus 5.5 High Fast' },
  ];

  it('rejects a saved model whose family is no longer available with an actionable error', () => {
    expect(() => normalizeNativeModelSelection('claude-opus-5-5-high-fast', [{ value: 'auto', name: 'Auto' }]))
      .toThrow(expect.objectContaining({
        code: 'INVALID_NATIVE_MODEL',
        statusCode: 400,
        message: expect.stringMatching(/claude-opus-5-5-high-fast.*choose another model/),
      }));
  });

  it('reports an unreadable catalog without claiming the selected model is unavailable', () => {
    expect(() => normalizeNativeModelSelection('claude-opus-5-5-high-fast', []))
      .toThrow(expect.objectContaining({ code: 'MODEL_CATALOG_UNAVAILABLE', statusCode: 503 }));
  });

  it('keeps Fast=false normalization for families without Fast', () => {
    const noFast = [{ value: 'gpt-5.6-luna-high', name: 'GPT-5.6 Luna High' }];
    expect(normalizeNativeModelSelection('gpt-5.6-luna[effort=custom]', noFast))
      .toBe('gpt-5.6-luna[effort=custom,fast=false]');
    expect(() => normalizeNativeModelSelection('gpt-5.6-luna[context=1m,effort=high,fast=true]', noFast))
      .toThrow('The native CLI does not support Fast for this model');
    expect(() => normalizeNativeModelSelection('gpt-5.6-luna[fast = true]', noFast))
      .toThrow('The native CLI does not support Fast for this model');
  });

  // An `AvailableModelsResponse` as Cursor sends it: Gemini has `context` with `reasoning_effort` and no Fast.
  const entries = [
    { value: 'gemini-4-neon-medium', name: 'Gemini 4 Neon Medium' },
    { value: 'gemini-4-neon-high', name: 'Gemini 4 Neon High' },
    { value: 'gemini-4-argon-high', name: 'Gemini 4 Argon High' },
    { value: 'gemini-4-argon-low', name: 'Gemini 4 Argon Low' },
  ];
  const neon = (effort: string, context: string, legacySlug?: string, defaultNonMax = false) => variant({ context, reasoning_effort: effort }, `gemini-4-neon[context=${context},reasoning_effort=${effort}]`, legacySlug, defaultNonMax);
  const response = message([
    [2, message([
      [1, 'gemini-4-neon'],
      [29, definition('context', 'Context', [['300k', '300K'], ['1m', '1M']])],
      [29, definition('reasoning_effort', 'Reasoning', [['medium', 'Medium'], ['high', 'High']])],
      [30, neon('medium', '300k', 'gemini-4-neon-medium', true)],
      [30, neon('high', '300k', 'gemini-4-neon-high')],
      [30, neon('high', '1m')],
    ])],
    [2, message([[1, 'gemini-4-argon']])],
  ]);
  const parameterized = decodeAvailableModels(response);

  it('offers only the context windows Cursor defines for a model', () => {
    const catalog = nativeModelCatalogFromVariants(entries, parameterized);
    expect(catalog.find((item) => item.value === 'gemini-4-neon')?.configOptions.find((option) => option.id === 'context')).toMatchObject({
      currentValue: '300k',
      // `1m` is launchable only with high effort, so both windows are offered.
      options: [{ value: '300k', name: '300K' }, { value: '1m', name: '1M' }],
    });
    expect(catalog.find((item) => item.value === 'gemini-4-argon')?.configOptions.some((option) => option.id === 'context')).toBe(false);
    expect(nativeModelCatalogFromVariants(entries).flatMap((item) => item.configOptions).some((option) => option.id === 'context')).toBe(false);
  });

  it('launches a context choice by the variant string Cursor lists', () => {
    expect(normalizeNativeModelSelection('gemini-4-neon[context=1m,effort=high]', entries, parameterized))
      .toBe('gemini-4-neon[context=1m,reasoning_effort=high]');
    expect(normalizeNativeModelSelection('gemini-4-neon-high[context=300k]', entries, parameterized))
      .toBe('gemini-4-neon[context=300k,reasoning_effort=high]');
    expect(normalizeNativeModelSelection('gemini-4-neon[context=1m,reasoning_effort=high]', entries, parameterized))
      .toBe('gemini-4-neon[context=1m,reasoning_effort=high]');
    expect(() => normalizeNativeModelSelection('gemini-4-neon[context=1m,effort=medium]', entries, parameterized))
      .toThrow(expect.objectContaining({ code: 'INVALID_NATIVE_MODEL' }));
  });

  it('drops a saved context window the model does not offer so the conversation still resumes', () => {
    expect(normalizeNativeModelSelection('gemini-4-neon[context=272k,effort=high,fast=false]', entries, parameterized)).toBe('gemini-4-neon-high');
    expect(normalizeNativeModelSelection('gemini-4-argon[context=300k,effort=high,fast=false]', entries, parameterized)).toBe('gemini-4-argon-high');
    expect(normalizeNativeModelSelection('gemini-4-neon[context=1m,effort=high]', entries)).toBe('gemini-4-neon-high');
  });
});

type Value = string | number | Uint8Array;
function varint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 0x7f) { bytes.push((value & 0x7f) | 0x80); value >>>= 7; }
  bytes.push(value);
  return bytes;
}
function message(fields: Array<[number, Value]>): Uint8Array {
  const bytes: number[] = [];
  for (const [number, value] of fields) {
    if (typeof value === 'number') { bytes.push(...varint(number * 8), ...varint(value)); continue; }
    const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    bytes.push(...varint(number * 8 + 2), ...varint(data.length), ...data);
  }
  return Uint8Array.from(bytes);
}
function definition(id: string, name: string, values: Array<[string, string]>): Uint8Array {
  const enumeration = message(values.map(([value, display]) => [1, message([[1, value], [2, display]])] as [number, Value]));
  return message([[1, id], [2, name], [4, message([[2, enumeration]])]]);
}
function variant(values: Record<string, string>, selector: string, legacySlug?: string, defaultNonMax = false): Uint8Array {
  return message([
    ...Object.entries(values).map(([id, value]) => [1, message([[1, id], [2, value]])] as [number, Value]),
    [9, selector],
    ...(legacySlug ? [[11, legacySlug] as [number, Value]] : []),
    ...(defaultNonMax ? [[5, 1] as [number, Value]] : []),
  ]);
}
