import { describe, expect, it } from 'vitest';
import { allowedRequestPath, assertDeclaredSettings, declaredSettings } from './access';

const access = { requests: ['/api/widgets/', 'widgets/', '/other/'], settings: ['widgetPrefs'] };

describe('plugin access', () => {
  it('lets a request through only under a declared /api/ prefix, however the path is spelled', () => {
    expect(allowedRequestPath('/api/widgets/models?x=1', access)).toBe('/api/widgets/models?x=1');
    for (const path of ['/api/settings', '/api/widgets/../settings', '/api/widgets/%2e%2e/settings', '//evil.example/api/widgets/', 'https://evil.example/api/widgets/', 'api/widgets/models', '/other/x']) {
      expect(() => allowedRequestPath(path, access), path).toThrow();
    }
    expect(() => allowedRequestPath('/api/widgets/models', undefined)).toThrow();
  });

  it('reads and writes only the declared settings keys', () => {
    expect(declaredSettings({ widgetPrefs: { executable: 'x' }, editorCommand: 'vim' }, access)).toEqual({ widgetPrefs: { executable: 'x' } });
    expect(() => assertDeclaredSettings({ widgetPrefs: {} }, access)).not.toThrow();
    expect(() => assertDeclaredSettings({ widgetPrefs: {}, editorCommand: 'vim' }, access)).toThrow();
  });
});
