import { describe,expect,it } from 'vitest';
import {
parseVisualizationReferenceLine,
visualizationReferenceFromHref,
visualizationReferenceHref
} from './visualizationReferences';

const marker = (value: unknown) => `\uE200visualize\uE202${JSON.stringify(value)}\uE201`;

describe('visualization reference protocol', () => {

  it('round-trips validated references through an encoded Markdown destination', () => {
    const reference = { path: '/tmp/a (b).html', title: '标题 (wide)', mode: 'wide' as const };
    expect(visualizationReferenceFromHref(visualizationReferenceHref(reference))).toEqual(reference);
    expect(visualizationReferenceFromHref('https://example.com/a.html')).toBeUndefined();
  });

  it('rejects partial, malformed, oversized, remote, and non-HTML payloads', () => {
    for (const value of [
      '\uE200visualize\uE202{"path":"/tmp/a.html"}',
      `${marker({ path: '/tmp/a.html' })} trailing`,
      '\uE200visualize\uE202{bad}\uE201',
      marker({ path: '' }),
      marker({ path: '//host/share.html' }),
      marker({ path: 'https://example.com/page.html' }),
      marker({ path: 'data:text/html,/page.html' }),
      marker({ path: 'riffet://preview/page.html' }),
      marker({ path: '/tmp/page.md' }),
      marker({ path: `/tmp/${'a'.repeat(8192)}.html` }),
      marker({ path: 'foo\u0001bar.html' }),
    ]) expect(parseVisualizationReferenceLine(value)).toBeUndefined();
    expect(parseVisualizationReferenceLine(`\uE200visualize\uE202{"path":"${'a'.repeat(16_384)}.html"}\uE201`)).toBeUndefined();
    expect(parseVisualizationReferenceLine(`    ${marker({ path: 'four-spaces.html' })}`)).toBeUndefined();
  });
});
