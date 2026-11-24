import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { alignListFences } from './listFences';

function parseTypes(markdown: string) {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown);
  return tree.children.map((node) => node.type);
}

describe('alignListFences', () => {
  it('indents unindented code citation fences inside nested lists and keeps following items nested', () => {
    const input = [
      '2. 12:26:53.419 (seq 1136) — 发截图触发 stop',
      '   - cursor-agent 写入:',
      '     ```text',
      '     seq 1136',
      '     ```',
      '   - 而 LaneFold 收到 meta.turn_ended 时会直接删除该回合的全部 draft 实体：',
      '```577:581:apps/server/src/timeline/fold.ts',
      '    } else if (row.kind === "meta.turn_ended") {',
      '        this.removeEntity(nativeId, entity);',
      '    }',
      '```',
      '   - 同时 `transcript-source.ts` 主动丢弃 draft：',
      '```739:761:plugins/riffet/cursor/backend/transcript-source.ts',
      'if (status === "completed") return false;',
      '```',
    ].join('\n');

    const aligned = alignListFences(input);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(aligned) as {
      children: Array<{
        type: string;
        children: Array<{
          children: Array<{
            type: string;
            children?: Array<{ children: Array<{ type: string; value?: string }> }>;
          }>;
        }>;
      }>;
    };

    expect(tree.children.map((c) => c.type)).toEqual(['list']);
    const outerItem = tree.children[0]!.children[0]!;
    const nestedList = outerItem.children[1]!;
    expect(nestedList.type).toBe('list');
    const nestedItems = nestedList.children!;
    expect(nestedItems).toHaveLength(3);
    expect(nestedItems[1]!.children.map((c) => c.type)).toEqual(['paragraph', 'code']);
    expect(nestedItems[2]!.children.map((c) => c.type)).toEqual(['paragraph', 'code']);
    const foldCode = nestedItems[1]!.children[1]!;
    expect(foldCode.value).toBe('    } else if (row.kind === "meta.turn_ended") {\n        this.removeEntity(nativeId, entity);\n    }');
  });

  it('fixes under-indented fences inside wider numbered lists (e.g. 10.)', () => {
    const input = [
      '10. Tenth item',
      '  ```ts',
      '  const x = 1;',
      '  ```',
      '11. Eleventh item',
    ].join('\n');

    const aligned = alignListFences(input);
    expect(parseTypes(aligned)).toEqual(['list']);
  });

  it('keeps genuine top-level fences after a list at column 0', () => {
    const input = [
      '- First item',
      '- Second item',
      '',
      '```ts',
      'const topLevel = true;',
      '```',
      '',
      '- Another list later',
    ].join('\n');

    const aligned = alignListFences(input);
    expect(aligned).toBe(input);
    expect(parseTypes(aligned)).toEqual(['list', 'code', 'list']);
  });

  it('does not carry a colon from an earlier code block onto a later top-level fence', () => {
    const input = [
      '- Item with code:',
      '  ```ts',
      '  const inside = 1;',
      '  ```',
      '',
      '```ts',
      'const outside = 2;',
      '```',
    ].join('\n');

    expect(alignListFences(input)).toBe(input);
    expect(parseTypes(alignListFences(input))).toEqual(['list', 'code']);
  });

  it('keeps citations separated by 2+ blank lines at column 0', () => {
    const input = [
      '- Item one',
      '',
      '',
      '```10:20:src/top.ts',
      'const outside = true;',
      '```',
    ].join('\n');

    expect(alignListFences(input)).toBe(input);
    expect(parseTypes(alignListFences(input))).toEqual(['list', 'code']);
  });

  it('does not treat a standalone ordered list starting at 1. after a top-level block as continuation', () => {
    const input = [
      '1. Old first',
      '2. Old second',
      '',
      '```ts',
      'const outside = true;',
      '```',
      '',
      '1. New first',
    ].join('\n');

    expect(alignListFences(input)).toBe(input);
    expect(parseTypes(alignListFences(input))).toEqual(['list', 'code', 'list']);
  });

  it('indents unclosed streaming citation fences inside a list immediately', () => {
    const input = [
      '1. Item one:',
      '```10:20:src/app.ts',
      'const partial = 1;',
    ].join('\n');

    const aligned = alignListFences(input);
    expect(parseTypes(aligned)).toEqual(['list']);
  });

  it('preserves outer list indentation when a fence intentionally closes only a nested list', () => {
    const input = [
      '- Outer',
      '  - Inner',
      '',
      '  ```ts',
      '  const outerScoped = true;',
      '  ```',
    ].join('\n');

    expect(alignListFences(input)).toBe(input);
  });

  it('ignores list-like text inside top-level code fences', () => {
    const input = [
      '```markdown',
      '1. not a real list:',
      '```10:20:foo.ts',
      'code',
      '```',
      '```',
    ].join('\n');

    expect(alignListFences(input)).toBe(input);
  });

  it('keeps blank-separated col-0 citations inside nested list items even when ending with a period or at the end of a list', () => {
    const input = [
      '1. **多条排队消息**',
      '   - 原因：这里以句号结尾，没有冒号。',
      '',
      '```194:251:apps/web/src/app/session/ComposerDock.tsx',
      'const expandable = runs.length > 1;',
      '```',
      '',
      '2. **单条排队消息**',
      '   - 桌面端详情',
      '     - 4 行文本说明',
      '   - 原因：最后一项后面还有全局注记。',
      '',
      '```877:890:apps/web/src/app/terminal/NativeSession.tsx',
      'const editQueued = useCallback(() => {}, []);',
      '```',
      '',
      '*(注：仅在无附件时正常。)*',
    ].join('\n');

    const aligned = alignListFences(input);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(aligned) as {
      children: Array<{
        type: string;
        children?: Array<{
          children: Array<{
            type: string;
            children?: Array<{ children: Array<{ type: string }> }>;
          }>;
        }>;
      }>;
    };

    expect(tree.children.map((c) => c.type)).toEqual(['list', 'paragraph']);
    const listItems = tree.children[0]!.children!;
    expect(listItems).toHaveLength(2);
    const firstNested = listItems[0]!.children[1]!;
    expect(firstNested.type).toBe('list');
    expect(firstNested.children![0]!.children.map((c) => c.type)).toEqual(['paragraph', 'code']);
    const secondNested = listItems[1]!.children[1]!;
    expect(secondNested.type).toBe('list');
    expect(secondNested.children![1]!.children.map((c) => c.type)).toEqual(['paragraph', 'code']);
  });

  it('keeps consecutive blank-separated col-0 citations inside the same nested list item', () => {
    const input = [
      '1. Outer item',
      '   - Nested bullet ending with period.',
      '',
      '```79:86:apps/web/src/app/session/fileAccess.ts',
      'first();',
      '```',
      '',
      '```117:121:apps/web/src/app/session/fileAccess.ts',
      'second();',
      '```',
    ].join('\n');

    const aligned = alignListFences(input);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(aligned) as {
      children: Array<{
        type: string;
        children?: Array<{
          children: Array<{
            type: string;
            children?: Array<{ children: Array<{ type: string }> }>;
          }>;
        }>;
      }>;
    };

    expect(tree.children.map((c) => c.type)).toEqual(['list']);
    const nested = tree.children[0]!.children![0]!.children[1]!;
    expect(nested.children![0]!.children.map((c) => c.type)).toEqual(['paragraph', 'code', 'code']);
  });

  it('keeps a col-0 citation inside a list item when followed by an indented continuation paragraph', () => {
    const input = [
      '1. **Item title**',
      '',
      '```140:159:apps/web/src/app/session/readingAnchor.ts',
      'const x = 1;',
      '```',
      '',
      '   Continuation paragraph belonging to item 1.',
    ].join('\n');

    const aligned = alignListFences(input);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(aligned) as {
      children: Array<{
        type: string;
        children?: Array<{ children: Array<{ type: string }> }>;
      }>;
    };

    expect(tree.children.map((c) => c.type)).toEqual(['list']);
    expect(tree.children[0]!.children![0]!.children.map((c) => c.type)).toEqual(['paragraph', 'code', 'paragraph']);
  });

  it('keeps a col-0 citation inside a top-level bullet ending with a period before a heading', () => {
    const input = [
      '### 1. 刚点发送时：为什么先出现在内容区域',
      '- 发送前会话处于未恢复状态。',
      '- `useSessionTranscript` 直接显示在**内容区域**。',
      '',
      '```83:99:apps/web/src/app/session/useSessionTranscript.ts',
      'for (const entry of control.inbox) {',
      '  if (entry.placement !== "queued") continue;',
      '}',
      '```',
      '',
      '### 2. 紧接着：为什么又跳回「排队」',
    ].join('\n');

    const aligned = alignListFences(input);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(aligned) as {
      children: Array<{
        type: string;
        children?: Array<{ children: Array<{ type: string }> }>;
      }>;
    };

    expect(tree.children.map((c) => c.type)).toEqual(['heading', 'list', 'heading']);
    const items = tree.children[1]!.children!;
    expect(items).toHaveLength(2);
    expect(items[1]!.children.map((c) => c.type)).toEqual(['paragraph', 'code']);
  });

  it('preserves leading tabs inside indented code blocks verbatim', () => {
    const input = [
      '- Makefile target:',
      '',
      '```1:3:Makefile',
      'all:',
      '\techo ok',
      '```',
    ].join('\n');

    const aligned = alignListFences(input);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(aligned) as {
      children: Array<{
        children?: Array<{ children: Array<{ type: string; value?: string }> }>;
      }>;
    };
    const code = tree.children[0]!.children![0]!.children[1]!;
    expect(code.type).toBe('code');
    expect(code.value).toBe('all:\n\techo ok');
  });
});
