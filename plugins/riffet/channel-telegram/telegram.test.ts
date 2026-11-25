import { describe, expect, it, vi } from 'vitest';
import type { ChannelContext, TurnView } from '@riffet/plugin-api';
import {
  describeTelegramError, TelegramApiError, sanitizeToken, type TelegramApi, type TelegramMessage,
} from './api.js';
import { markdownToHtml, packHtmlBlocks, renderNoticePages, renderTurnFinalPages } from './format.js';
import { TelegramPanelStore } from './panels.js';
import {
  handleCallbackQuery, handleStoppedGeneration, normalizeMessage, PendingOtherStore, stripBotMentions,
} from './polling.js';
import { createTurnSurface, TelegramLinkState } from './surface.js';

function fakeApi(): TelegramApi {
  return {
    call: vi.fn(),
    getMe: vi.fn(),
    getUpdates: vi.fn(),
    deleteWebhook: vi.fn(),
    setMyCommands: vi.fn(),
    sendMessage: vi.fn(async params => ({
      message_id: 900,
      chat: { id: Number(params.chat_id), type: 'private' as const },
      date: 0,
      text: params.text,
    })),
    editMessageText: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    sendMessageDraft: vi.fn(async () => true),
    answerCallbackQuery: vi.fn(async () => true),
    setMessageReaction: vi.fn(async () => true),
    sendChatAction: vi.fn(async () => true),
    downloadFile: vi.fn(async () => ({ data: Buffer.from('img'), filePath: 'photos/1.jpg', contentType: 'image/jpeg' })),
  };
}

function fakeContext(): ChannelContext {
  return {
    inbound: vi.fn(),
    action: vi.fn<ChannelContext['action']>(async () => ({ toast: { tone: 'success', text: 'ok' } })),
    status: vi.fn(),
    signal: new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

describe('channel-telegram formatting & splitting', () => {
  it('converts GFM markdown into safe Telegram HTML and redacts unsafe links', () => {
    const html = markdownToHtml([
      '# Heading',
      '',
      'Hello **bold** _italic_ ~~strike~~ `code` [ok](https://example.com) [bad](javascript:alert(1)).',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1 < 2 && 3 > 2;',
      '```',
    ].join('\n'));
    expect(html).toContain('<b>Heading</b>');
    expect(html).toContain('<b>bold</b> <i>italic</i> <s>strike</s> <code>code</code>');
    expect(html).toContain('<a href="https://example.com">ok</a> bad');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<pre>A | B');
    expect(html).toContain('<pre><code class="language-ts">const x = 1 &lt; 2 &amp;&amp; 3 &gt; 2;</code></pre>');
  });

  it('splits oversized code blocks across balanced <pre><code> chunks', () => {
    const bigCode = Array.from({ length: 120 }, (_, i) => `line_${i}_` + 'x'.repeat(40)).join('\n');
    const html = markdownToHtml(`\`\`\`js\n${bigCode}\n\`\`\``);
    const pages = packHtmlBlocks([html], 1000);
    expect(pages.length).toBeGreaterThan(3);
    for (const page of pages) {
      expect(page.startsWith('<pre><code class="language-js">')).toBe(true);
      expect(page.endsWith('</code></pre>')).toBe(true);
    }
  });

  it('renders turn header, expandable process, answer and footer according to card options', () => {
    const view: TurnView = {
      sessionId: 's1',
      runId: 'r1',
      title: 'Inspect API',
      status: 'completed',
      source: 'channel',
      steps: [{ id: '1', kind: 'tool', title: 'Read src/app.ts', text: '', state: 'done' }],
      answer: 'Done.',
      footer: { model: 'Opus', modelMarks: ['fast'], changes: { added: 3, removed: 1 }, contextPercent: 25, elapsedMs: 4200 },
      card: { header: true, process: true, stopButton: true, footer: { model: true, changes: true, context: true, elapsed: true } },
    };
    const pages = renderTurnFinalPages(view);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('<b>Inspect API</b>');
    expect(pages[0]).toContain('<blockquote expandable>过程 · 1 次工具调用\n✓ Read src/app.ts</blockquote>');
    expect(pages[0]).toContain('Done.');
    expect(pages[0]).toContain('<i><code>Opus</code> · fast · +3 −1 · 上下文 25% · 4s</i>');
  });

  it('formats status summaries, confirmations, and errors consistently in notices', () => {
    expect(renderNoticePages('项目：riffet\n会话：调试\n状态：空闲\n模型：codex · GPT-6')[0])
      .toBe('<b>状态</b>\n<b>项目</b>  <code>riffet</code>\n<b>会话</b>  调试\n<b>状态</b>  空闲\n<b>模型</b>  <code>codex · GPT-6</code>');
    expect(renderNoticePages('已绑定')[0]).toBe('✓ 已绑定');
    expect(renderNoticePages('没有发出去：服务暂时不可用')[0])
      .toBe('<blockquote><b>发送失败</b>\n服务暂时不可用</blockquote>');
  });

  it('strips bot token from error text and describes transport/auth errors clearly', () => {
    expect(sanitizeToken('POST https://api.telegram.org/bot123:SECRET/getMe failed', '123:SECRET'))
      .toBe('POST https://api.telegram.org/bot<redacted>/getMe failed');
    expect(describeTelegramError(new TelegramApiError('getMe', 401, 'Unauthorized'))).toContain('Bot Token 无效');
    expect(describeTelegramError(new TelegramApiError('getMe', 0, 'fetch failed: ETIMEDOUT'), { hasProxy: false })).toContain('代理地址');
    expect(describeTelegramError(new TelegramApiError('getMe', 0, 'Proxy CONNECT failed (502)'), { hasProxy: true })).toContain('代理服务器');
  });
});

describe('channel-telegram inbound normalization & reply chains', () => {
  it('strips @botUsername from commands and mentions without touching other bots', () => {
    expect(stripBotMentions('/model@my_bot opus', [{ type: 'bot_command', offset: 0, length: 13 }], 'My_Bot'))
      .toEqual({ text: '/model opus', mentionsBot: true });
    expect(stripBotMentions('/model@other_bot opus', [{ type: 'bot_command', offset: 0, length: 16 }], 'my_bot'))
      .toEqual({ text: '/model@other_bot opus', mentionsBot: false });
    expect(stripBotMentions('@my_bot hello there', [{ type: 'mention', offset: 0, length: 7 }], 'my_bot'))
      .toEqual({ text: 'hello there', mentionsBot: true });
  });

  it('maps private chats, private topics, forum topics, and multi-hop group reply chains', () => {
    const link = new TelegramLinkState();
    const api = fakeApi();
    const env = { accountId: 'telegram-1', bot: { id: 99, username: 'riffet_bot' }, api, link };

    // Regular private chat: flat (no threadKey)
    const dm: TelegramMessage = {
      message_id: 10,
      from: { id: 1, is_bot: false, first_name: 'Alice' },
      chat: { id: 1, type: 'private' },
      date: 1,
      text: 'hi',
    };
    const dmMsg = normalizeMessage(dm, env)!;
    expect(dmMsg.address).toEqual({ account: 'telegram-1', chatId: '1', chatType: 'p2p' });
    expect(dmMsg.mentionsBot).toBe(true);

    // Private chat with Bot API 9.3+ topic
    const dmTopic = normalizeMessage({ ...dm, message_id: 11, message_thread_id: 77 }, env)!;
    expect(dmTopic.address.threadKey).toBe('topic:77');
    expect(dmTopic.inThread).toBe(true);

    // Private chat deep-link `/start bind_<code>` normalizes into `/bind <code>`
    const dmStartBind = normalizeMessage({ ...dm, message_id: 12, text: '/start bind_AB12CD' }, env)!;
    expect(dmStartBind.text).toBe('/bind AB12CD');

    // Group reply chain: M100 -> bot M101 -> user M102 all collapse to reply:100
    const g1 = normalizeMessage({
      message_id: 100,
      from: { id: 2, is_bot: false, first_name: 'Bob' },
      chat: { id: -500, type: 'supergroup' },
      date: 1,
      text: '@riffet_bot start',
      entities: [{ type: 'mention', offset: 0, length: 11 }],
    }, env)!;
    expect(g1.address.threadKey).toBe('reply:100');
    expect(g1.mentionsBot).toBe(true);

    link.recordReplyRoot('-500', '101', '100');
    const g2 = normalizeMessage({
      message_id: 102,
      from: { id: 2, is_bot: false, first_name: 'Bob' },
      chat: { id: -500, type: 'supergroup' },
      date: 2,
      text: 'follow up',
      reply_to_message: {
        message_id: 101,
        from: { id: 99, is_bot: true, first_name: 'Riffet' },
        chat: { id: -500, type: 'supergroup' },
        date: 1,
        text: 'bot reply',
      },
    }, env)!;
    expect(g2.address.threadKey).toBe('reply:100');
    expect(g2.address.aliases).toContain('reply:101');
    expect(g2.mentionsBot).toBe(true);
  });
});

describe('channel-telegram panels, callback tokens & streaming', () => {
  it('keeps callback_data compact (<64 bytes) and routes multi-select + ForceReply allowOther', async () => {
    const panels = new TelegramPanelStore();
    const pendingOther = new PendingOtherStore();
    const api = fakeApi();
    const context = fakeContext();

    const rendered = panels.renderInteraction({
      kind: 'interaction',
      ref: 'very-long-interaction-reference-id-that-would-exceed-sixty-four-bytes-easily',
      interaction: {
        id: 'i1',
        revision: '1',
        kind: 'question',
        title: 'Pick targets',
        multiple: true,
        allowOther: true,
        options: [{ id: 'a', label: 'A', selected: false }, { id: 'b', label: 'B', selected: false }],
        actions: [{ id: 'submit', label: 'Submit', tone: 'primary' }],
      },
    });
    const rows = rendered.replyMarkup!.inline_keyboard;
    for (const row of rows) {
      for (const btn of row) {
        expect(Buffer.byteLength(btn.callback_data ?? '', 'utf8')).toBeLessThanOrEqual(64);
      }
    }

    const toggleA = rows[0]![0]!.callback_data!;
    const submitBtn = rows[2]![0]!.callback_data!;
    const otherBtn = rows[2]![1]!.callback_data!;
    const baseMsg: TelegramMessage = { message_id: 50, chat: { id: 7, type: 'private' }, date: 1 };

    // Toggle option A
    await handleCallbackQuery({
      query: { id: 'q1', from: { id: 7, is_bot: false, first_name: 'U' }, message: baseMsg, data: toggleA },
      accountId: 'telegram-1',
      api,
      panels,
      pendingOther,
      context,
    });
    expect(api.editMessageText).toHaveBeenCalledTimes(1);

    // Trigger ForceReply for allowOther
    await handleCallbackQuery({
      query: { id: 'q2', from: { id: 7, is_bot: false, first_name: 'U' }, message: baseMsg, data: otherBtn },
      accountId: 'telegram-1',
      api,
      panels,
      pendingOther,
      context,
    });
    expect(api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      reply_markup: expect.objectContaining({ force_reply: true }),
    }));
    const pending = pendingOther.consume('7', '7', 'custom answer');
    expect(pending).toMatchObject({ action: 'submit', selectedIds: ['a'] });

    // Submit multi-select directly
    await handleCallbackQuery({
      query: { id: 'q3', from: { id: 7, is_bot: false, first_name: 'U' }, message: baseMsg, data: submitBtn },
      accountId: 'telegram-1',
      api,
      panels,
      pendingOther,
      context,
    });
    expect(context.action).toHaveBeenCalledWith(expect.objectContaining({
      action: 'submit',
      selectedIds: ['a'],
    }));
  });

  it('downgrades from sendMessageDraft to editMessageText on unsupported method and routes native stop', async () => {
    const api = fakeApi();
    const panels = new TelegramPanelStore();
    const link = new TelegramLinkState();
    const context = fakeContext();

    // Case 1: draft supported + stopped_message_generation triggers core stop action
    const view: TurnView = {
      sessionId: 's1',
      runId: 'r1',
      title: 'Test',
      status: 'running',
      source: 'channel',
      steps: [],
      answer: 'Streaming...',
      footer: {},
      card: { header: false, process: false, stopButton: true, footer: { model: false, changes: false, context: false, elapsed: false } },
      stopRef: 'stop-ref-1',
    };
    const surface = createTurnSurface({
      api,
      panels,
      link,
      context,
      address: { account: 'telegram-1', chatId: '42', chatType: 'p2p' },
      initialView: view,
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(api.sendMessageDraft).toHaveBeenCalledTimes(1);
    const draftId = (vi.mocked(api.sendMessageDraft).mock.calls[0]![0]).draft_id;
    await handleStoppedGeneration({
      stopped: { draft_id: draftId, from: { id: 42, is_bot: false, first_name: 'U' } },
      updateId: 88,
      accountId: 'telegram-1',
      link,
      context,
    });
    expect(context.action).toHaveBeenCalledWith(expect.objectContaining({ ref: 'stop-ref-1', action: 'stop' }));
    await surface.finish({ ...view, status: 'completed', answer: 'Final answer', stopRef: undefined });
    expect(api.sendMessage).toHaveBeenCalled();

    // Case 2: sendMessageDraft returns 400 -> automatic fallback to sendMessage + editMessageText
    const api2 = fakeApi();
    vi.mocked(api2.sendMessageDraft).mockRejectedValueOnce(new TelegramApiError('sendMessageDraft', 400, 'method not found'));
    const link2 = new TelegramLinkState();
    const surface2 = createTurnSurface({
      api: api2,
      panels,
      link: link2,
      context,
      address: { account: 'telegram-1', chatId: '42', chatType: 'p2p' },
      initialView: view,
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(link2.draftSupported).toBe(false);
    expect(api2.sendMessage).toHaveBeenCalledTimes(1);
    await surface2.finish({ ...view, status: 'completed', answer: 'Done', stopRef: undefined });
    expect(api2.editMessageText).toHaveBeenCalled();
  });

  it('renders compact /model main view with expandable Agent/Model tabs and falls back when button style is rejected', async () => {
    const panels = new TelegramPanelStore();
    const pendingOther = new PendingOtherStore();
    const link = new TelegramLinkState();
    const api = fakeApi();
    const context = fakeContext();

    const main = panels.renderModelPicker({
      kind: 'model-picker',
      ref: 'm1',
      scope: 'chat',
      backend: { id: 'codex', name: 'Codex' },
      backends: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }],
      models: [{ id: 'gpt-1', name: 'GPT-1' }, { id: 'gpt-2', name: 'GPT-2' }],
      modelId: 'gpt-1',
      params: [
        { id: 'effort', label: '推理强度', value: 'max', options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }, { value: 'max', label: 'Max' }] },
        { id: 'fast', label: '速度', value: 'true', options: [{ value: 'false', label: '标准' }, { value: 'true', label: '快速' }] },
      ],
      summary: 'GPT-1 · fast · max',
    });
    // Compact main view: 1 selector row + 1 effort row + 1 speed row = 3 rows total
    expect(main.replyMarkup!.inline_keyboard).toHaveLength(3);
    expect(main.replyMarkup!.inline_keyboard[0]!.map(b => b.text)).toEqual(['Agent: Codex ▾', '模型: GPT-1 ▾']);
    expect(main.replyMarkup!.inline_keyboard[1]![2]).toMatchObject({ text: '✓ Max', style: 'primary' });

    // Opening the models sub-tab edits in place and retries without `style` if Telegram rejects it with 400
    vi.mocked(api.editMessageText).mockRejectedValueOnce(new TelegramApiError('editMessageText', 400, 'Bad Request: unexpected style'));
    const openModelsToken = main.replyMarkup!.inline_keyboard[0]![1]!.callback_data!;
    await handleCallbackQuery({
      query: { id: 'q-tab', from: { id: 7, is_bot: false, first_name: 'U' }, message: { message_id: 60, chat: { id: 7, type: 'private' }, date: 1 }, data: openModelsToken },
      accountId: 'telegram-1',
      api,
      panels,
      pendingOther,
      context,
      link,
    });
    expect(link.buttonStyleSupported).toBe(false);
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    const secondCallMarkup = vi.mocked(api.editMessageText).mock.calls[1]![0].reply_markup!;
    expect(secondCallMarkup.inline_keyboard.flat().every(btn => !('style' in btn))).toBe(true);
  });
});
