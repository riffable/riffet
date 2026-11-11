import { describe, expect, it } from 'vitest';
import { protectBareUrls } from './bareUrls';

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
