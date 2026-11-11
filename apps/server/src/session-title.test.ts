import { describe, expect, it } from 'vitest';
import {
  acceptedTitlePatch,
  firstMessageTitlePatch,
  generatedTitlePatch,
  providerTitlePatch,
} from './session-title.js';

describe('the accepted-message rule', () => {
  it('names a conversation nobody has named', () => {
    expect(acceptedTitlePatch({ title: 'New conversation' }, '远端有更新，你拉取一下，然后 git push'))
      .toEqual({ title: '远端有更新，你拉取一下，然后 git push', titleSource: 'prompt' });
  });

  it('leaves a name someone chose alone, including one written before provenance existed', () => {
    expect(acceptedTitlePatch({ title: '我的会话', titleSource: 'user' }, '再说一句')).toBeUndefined();
    expect(acceptedTitlePatch({ title: '理解一下未提交代码的改动…' }, '再改一下')).toBeUndefined();
  });
});

describe('the transcript rule', () => {
  it('never overrides a reader or a first message', () => {
    expect(firstMessageTitlePatch({ title: '我的会话', titleSource: 'user' }, '随便一条')).toBeUndefined();
    expect(firstMessageTitlePatch({ title: '第一条', titleSource: 'prompt' }, '重放的历史')).toBeUndefined();
  });
});

describe('the generated rule', () => {
  it('upgrades the first-message stand-in once, then keeps the generated title', () => {
    const named = { title: '帮我看一下统计页面，现在 web 的样式着实需要优化', titleSource: 'prompt' as const };
    expect(generatedTitlePatch(named, '优化统计页面样式')).toEqual({ title: '优化统计页面样式', titleSource: 'generated' });
    expect(generatedTitlePatch({ title: '优化统计页面样式', titleSource: 'generated' }, '统计页面重设计')).toBeUndefined();
  });

  it('is not overridden by the message rules', () => {
    expect(acceptedTitlePatch({ title: '优化统计页面样式', titleSource: 'generated' }, '下一条')).toBeUndefined();
    expect(firstMessageTitlePatch({ title: '优化统计页面样式', titleSource: 'generated' }, '重放的第一条')).toBeUndefined();
    expect(providerTitlePatch({ title: '优化统计页面样式', titleSource: 'generated' }, 'DSH 的短标题')).toBeUndefined();
  });
});
