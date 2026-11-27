import { describe, expect, it } from 'vitest';
import { protectBareUrls, splitBareUrls } from './bareUrls';

describe('bare URL boundaries', () => {
  it('ends a URL where Chinese prose does, so the punctuation stays text', () => {
    expect(protectBareUrls('见 http://127.0.0.1:4311，然后继续')).toBe('见 <http://127.0.0.1:4311>，然后继续');
    expect(protectBareUrls('**http://x.dev/a**（见）')).toBe('**<http://x.dev/a>**（见）');
    expect(protectBareUrls('地址是 https://zh.wikipedia.org/wiki/北京。')).toBe('地址是 <https://zh.wikipedia.org/wiki/北京>。');
  });

  it('gives a www link the same end, keeping its text', () => {
    expect(protectBareUrls('见 www.x.dev/a，然后')).toBe('见 [www.x.dev/a](http://www.x.dev/a)，然后');
    expect(protectBareUrls('见 www.x.dev，然后')).toBe('见 [www.x.dev](http://www.x.dev)，然后');
    expect(protectBareUrls('见 www.x，然后')).toBe('见 www.x，然后');
  });

  it('leaves alone what already has a boundary', () => {
    expect(protectBareUrls('http://x.dev/a 后面有空格')).toBe('http://x.dev/a 后面有空格');
    expect(protectBareUrls('<http://x.dev/a>（见）')).toBe('<http://x.dev/a>（见）');
    expect(protectBareUrls('[label](<http://x.dev/a>)')).toBe('[label](<http://x.dev/a>)');
  });

  it('never rewrites code', () => {
    expect(protectBareUrls('`http://x.dev/a，`')).toBe('`http://x.dev/a，`');
    expect(protectBareUrls('```\nhttp://x.dev/a，\n```')).toBe('```\nhttp://x.dev/a，\n```');
    expect(protectBareUrls('> ```\n> http://x.dev/a，\n> ```')).toBe('> ```\n> http://x.dev/a，\n> ```');
    expect(protectBareUrls('<a href="http://x.dev/a，">x</a>')).toBe('<a href="http://x.dev/a，">x</a>');
  });

  it('leaves a link label free of a nested link', () => {
    expect(protectBareUrls('[见 http://x.dev/a，说明](https://y.dev)')).toBe('[见 http://x.dev/a，说明](https://y.dev)');
    expect(protectBareUrls('[注意：见 http://x.dev/a，然后]')).toBe('[注意：见 <http://x.dev/a>，然后]');
  });

  it('leaves destinations, definitions and formulas as they are', () => {
    expect(protectBareUrls('[label](http://x.dev/a，)')).toBe('[label](http://x.dev/a，)');
    expect(protectBareUrls('[ref]: http://x.dev/a，')).toBe('[ref]: http://x.dev/a，');
    expect(protectBareUrls('$http://x.dev/a，$')).toBe('$http://x.dev/a，$');
  });
});

describe('splitBareUrls', () => {
  const links = (text: string) => splitBareUrls(text).filter(p => p.href).map(p => [p.text, p.href]);

  it('extracts URLs with query strings, commas, Chinese punctuation and multiple links', () => {
    const sample = '看一下，\nhttps://example.com/wiki/Abc123?t=1795504601857,\nhttps://example.com/docx/Def456?t=1795504633404, 讨论一下';
    expect(links(sample)).toEqual([
      ['https://example.com/wiki/Abc123?t=1795504601857', 'https://example.com/wiki/Abc123?t=1795504601857'],
      ['https://example.com/docx/Def456?t=1795504633404', 'https://example.com/docx/Def456?t=1795504633404'],
    ]);
    expect(splitBareUrls('访问https://example.com看看效果')).toEqual([
      { text: '访问' },
      { text: 'https://example.com', href: 'https://example.com' },
      { text: '看看效果' },
    ]);
    expect(links('坐标 https://maps.example.com/@39.9,116.4,12z, 以及 https://example.com/a?token=abc==')).toEqual([
      ['https://maps.example.com/@39.9,116.4,12z', 'https://maps.example.com/@39.9,116.4,12z'],
      ['https://example.com/a?token=abc==', 'https://example.com/a?token=abc=='],
    ]);
  });

  it('handles localhost, IPv4, IPv6, userinfo, ports and case-insensitive schemes', () => {
    expect(links('http://localhost:3000/api http://[::1]:8080/health http://user:pass@127.0.0.1:4337/x')).toEqual([
      ['http://localhost:3000/api', 'http://localhost:3000/api'],
      ['http://[::1]:8080/health', 'http://[::1]:8080/health'],
      ['http://user:pass@127.0.0.1:4337/x', 'http://user:pass@127.0.0.1:4337/x'],
    ]);
    expect(links('HTTPS://Example.COM/Path WWW.example.com/docs')).toEqual([
      ['HTTPS://Example.COM/Path', 'https://Example.COM/Path'],
      ['WWW.example.com/docs', 'http://WWW.example.com/docs'],
    ]);
    expect(links('地址 https://example.com: 说明')).toEqual([
      ['https://example.com', 'https://example.com'],
    ]);
    expect(links('https://example.com.: 说明, http://example.com,a@example.com')).toEqual([
      ['https://example.com', 'https://example.com'],
      ['http://example.com', 'http://example.com'],
    ]);
  });

  it('stops cleanly at surrounding parens, brackets, quotes and keeps balanced pairs', () => {
    expect(links('(https://a.com/x)和(https://b.com/y)')).toEqual([
      ['https://a.com/x', 'https://a.com/x'],
      ['https://b.com/y', 'https://b.com/y'],
    ]);
    expect(links('[https://a.com/x](https://b.com/y)')).toEqual([
      ['https://a.com/x', 'https://a.com/x'],
      ['https://b.com/y', 'https://b.com/y'],
    ]);
    expect(links('(see https://en.wikipedia.org/wiki/Swift_(programming_language)).')).toEqual([
      ['https://en.wikipedia.org/wiki/Swift_(programming_language)', 'https://en.wikipedia.org/wiki/Swift_(programming_language)'],
    ]);
    expect(links('[https://example.com/api?filter[a]=1], "https://example.com/q", <https://example.com/r>')).toEqual([
      ['https://example.com/api?filter[a]=1', 'https://example.com/api?filter[a]=1'],
      ['https://example.com/q', 'https://example.com/q'],
      ['https://example.com/r', 'https://example.com/r'],
    ]);
  });

  it('rejects malformed hosts, bad ports, mid-word prefixes, non-http schemes and emails', () => {
    for (const text of [
      '把http://改成https://',
      'http:// https:///foo https://. https://a..b.com https://-a.com',
      'http://localhost:99999 http://localhost:0 http://localhost:80abc',
      'xhttp://a.com foo_https://a.com a.www.a.com path/www.a.com user@www.example.com',
      'www.x www.foo.1 www..com',
      'javascript:alert(1) file:///etc/passwd ftp://a.com mailto:a@example.com user@example.com',
    ]) {
      expect(links(text), text).toEqual([]);
    }
  });
});
