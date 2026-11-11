import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { latestPlanBody, PlanFileWriter, planFileName } from './plan-files.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'riffet-plans-'));
  directories.push(value);
  return value;
}

function planEvent(text: string, kind = 'plan'): NativeWorkbenchEvent {
  return {
    sequence: 1, sessionId: 'session', type: 'tool_call', createdAt: new Date().toISOString(), nativeId: `n-${text.length}`,
    data: { sessionUpdate: 'tool_call', toolName: 'Plan', kind, title: 'Proposed plan', content: [{ type: 'markdown', text }] },
  } as NativeWorkbenchEvent;
}

describe('latestPlanBody', () => {
  it('takes the newest plan body in the batch', () => {
    expect(latestPlanBody([planEvent('第一版计划'), planEvent('第二版计划')])).toBe('第二版计划');
  });

  it('ignores anything that is not a plan carrying Markdown', () => {
    expect(latestPlanBody([])).toBeUndefined();
    expect(latestPlanBody([planEvent('命令输出', 'execute')])).toBeUndefined();
    expect(latestPlanBody([planEvent('   ')])).toBeUndefined();
    const noBody = { ...planEvent('x'), data: { sessionUpdate: 'tool_call', kind: 'plan', content: [{ type: 'content', text: '不是 markdown' }] } } as NativeWorkbenchEvent;
    expect(latestPlanBody([noBody])).toBeUndefined();
  });
});

describe('planFileName', () => {
  const at = new Date('2026-10-11T08:30:00.000Z');

  it('claims the file for the workbench and keeps the listing readable', () => {
    expect(planFileName('0199aaaa-bbbb', '重做统计页面', at, 'zq41')).toBe('riffet-0199aaaa-2026-10-11T08-30-00-000-zq41-重做统计页面.md');
  });

  it('orders two plans written in the same millisecond by which came first', () => {
    // Distinct names stop the second write from landing on the first file and losing an entry. But
    // they also have to be *ordered*: pruning deletes the lowest-sorting name and the newest plan is
    // the highest, so a tiebreaker that merely differs would delete the newer of a same-millisecond
    // pair and call the older one current.
    const names = Array.from({ length: 50 }, () => planFileName('0199aaaa', '同一毫秒', at));
    expect(new Set(names).size).toBe(50);
    expect(names).toEqual([...names].sort());
  });

  it('never lets a title escape the filename', () => {
    // A title is a label here, not a round trip: separators and control characters are dropped
    // rather than escaped, so no title can reach outside the directory or collide with a neighbour.
    for (const hostile of ['../../etc/passwd', 'a/b\\c', 'plan ', '....', '!!!']) {
      const name = planFileName('0199aaaa-bbbb', hostile, at, 'zq41');
      expect(name.startsWith('riffet-0199aaaa-')).toBe(true);
      expect(name).not.toMatch(/[/\\]/);
      expect(name.endsWith('.md')).toBe(true);
    }
  });

  it('sorts chronologically by name, so pruning drops the oldest', () => {
    // Different milliseconds must sort by time whatever the tiebreaker and the title happen to be.
    const early = planFileName('0199aaaa', '旧名字', new Date('2026-10-11T08:00:00.000Z'), 'zzzz');
    const late = planFileName('0199aaaa', 'a-renamed-conversation', new Date('2026-10-11T09:00:00.000Z'), '0000');
    expect([late, early].sort()).toEqual([early, late]);
  });
});

describe('PlanFileWriter', () => {
  const writer = (dir: string, title?: string) => new PlanFileWriter({ directory: dir, title: () => title ?? '重做统计页面' });

  it('mirrors the plan as Markdown, naming the conversation it came from', async () => {
    const dir = await directory();
    const path = await writer(dir).record('0199aaaa-bbbb', [planEvent('## 步骤\n\n1. 拆样式\n2. 重建页面')]);
    expect(path).toBeDefined();
    const text = await readFile(path!, 'utf8');
    expect(text).toContain('<!-- riffet plan mirror · conversation 0199aaaa-bbbb -->');
    expect(text).toContain('# 重做统计页面');
    expect(text).toContain('1. 拆样式');
  });

  it('writes an unchanged plan only once, and a changed one again', async () => {
    const dir = await directory();
    const instance = writer(dir);
    expect(await instance.record('s1', [planEvent('同一份计划')])).toBeDefined();
    expect(await instance.record('s1', [planEvent('同一份计划')])).toBeUndefined();
    expect(await instance.record('s1', [planEvent('改过的计划')])).toBeDefined();
    // `forget` is what a reopened conversation uses to write its plan again.
    instance.forget('s1');
    expect(await instance.record('s1', [planEvent('改过的计划')])).toBeDefined();
  });

  it('keeps only the newest few plans of one conversation, and never touches a neighbour', async () => {
    const dir = await directory();
    // Claude Code's own plans share this directory. They must survive untouched.
    await writeFile(join(dir, 'async-spinning-lollipop.md'), 'claude 自己的计划', 'utf8');
    const instance = writer(dir);
    for (let index = 0; index < 8; index += 1) {
      await instance.record('0199aaaa-bbbb', [planEvent(`计划版本 ${index}`)]);
    }
    const names = (await readdir(dir)).sort();
    expect(names).toContain('async-spinning-lollipop.md');
    const mine = names.filter(name => name.startsWith('riffet-'));
    expect(mine).toHaveLength(5);
    expect(await readFile(join(dir, mine.at(-1)!), 'utf8')).toContain('计划版本 7');
  });

  it('stays quiet when there is nothing to write or the directory cannot be used', async () => {
    const dir = await directory();
    expect(await writer(dir).record('s1', [])).toBeUndefined();
    // A path that cannot be a directory: the mirror fails and the caller never hears about it.
    const blocked = join(dir, 'a-file');
    await writeFile(blocked, 'not a directory', 'utf8');
    const broken = new PlanFileWriter({ directory: join(blocked, 'plans'), title: () => 'x' });
    expect(await broken.record('s1', [planEvent('计划')])).toBeUndefined();
  });

  it('survives a title lookup that throws', async () => {
    const dir = await directory();
    const instance = new PlanFileWriter({ directory: dir, title: () => { throw new Error('session is gone'); } });
    const path = await instance.record('s1', [planEvent('计划正文')]);
    expect(path).toBeDefined();
    expect(await readFile(path!, 'utf8')).toContain('# Plan');
  });

  it('leaves no temp file behind', async () => {
    const dir = await directory();
    await writer(dir).record('s1', [planEvent('计划')]);
    expect((await readdir(dir)).filter(name => name.includes('.tmp'))).toEqual([]);
  });
});
