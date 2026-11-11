import { describe, expect, it } from 'vitest';
import { normalizeCardAction, toCallbackResponse } from './actions.js';
import { normalizeMessageEvent, type NormalizeDeps } from './connection.js';
import { callbackValue, formSubmitName } from './cards.js';

const deps: NormalizeDeps = { account: 'acc', botOpenId: 'ou_bot', download: async () => ({ data: Buffer.from('x'), mimeType: 'image/png' }) };

function event(message: Record<string, unknown>, sender: Record<string, unknown> = { sender_id: { open_id: 'ou_user' }, sender_type: 'user' }) {
  return { schema: '2.0', event: { sender, message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: '@_user_1 hi' }), mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Riffet' }], ...message } } };
}

describe('feishu message events', () => {
  it('strips the bot mention, detects it by open_id and anchors on the message', () => {
    const message = normalizeMessageEvent(event({}), deps)!;
    expect(message).toMatchObject({ text: 'hi', mentionsBot: true, inThread: false, anchor: { messageId: 'om_1', inThread: false }, address: { chatType: 'group', threadKey: 'om_1' } });
  });

  it('keys a thread by root_id and aliases the topic id; a first topic message is also known by its own id', () => {
    const later = normalizeMessageEvent(event({ root_id: 'om_root', parent_id: 'om_p', thread_id: 'omt_1' }), deps)!;
    expect(later.address).toMatchObject({ threadKey: 'om_root', aliases: ['omt_1'] });
    expect(later.inThread).toBe(true);
    const first = normalizeMessageEvent(event({ thread_id: 'omt_1' }), deps)!;
    expect(first.address).toMatchObject({ threadKey: 'omt_1', aliases: ['om_1'] });
  });

  it('does not take a quote reply for a topic', () => {
    const quote = normalizeMessageEvent(event({ root_id: 'om_root', parent_id: 'om_root' }), deps)!;
    expect(quote.inThread).toBe(false);
    expect(quote.address.threadKey).toBe('om_root');
    expect(quote.address.aliases).toBeUndefined();
  });

  it('takes chat type from the event, not the id', () => {
    expect(normalizeMessageEvent(event({ chat_type: 'p2p', chat_id: 'oc_looks_like_a_group' }), deps)!.address.chatType).toBe('p2p');
  });

  it('ignores bots and the bot itself', () => {
    expect(normalizeMessageEvent(event({}, { sender_id: { open_id: 'ou_x' }, sender_type: 'app' }), deps)).toBeUndefined();
    expect(normalizeMessageEvent(event({}, { sender_id: { open_id: 'ou_bot' }, sender_type: 'user' }), deps)).toBeUndefined();
  });

  it('turns images and files into downloadable attachments', async () => {
    const image = normalizeMessageEvent(event({ message_type: 'image', content: JSON.stringify({ image_key: 'img_abcdef123' }), mentions: [] }), deps)!;
    expect(image.attachments).toHaveLength(1);
    expect(await image.attachments[0]!.download()).toMatchObject({ mimeType: 'image/png', name: expect.stringMatching(/\.png$/) });
    const file = normalizeMessageEvent(event({ message_type: 'file', content: JSON.stringify({ file_key: 'f1', file_name: 'a.pdf' }), mentions: [] }), deps)!;
    expect(file.attachments[0]).toMatchObject({ kind: 'file', name: 'a.pdf' });
  });
});

describe('feishu card callbacks', () => {
  const base = { header: { event_id: 'ev1' }, event: { operator: { open_id: 'ou_user' } } };

  it('reads a pressed button', () => {
    const action = normalizeCardAction({ ...base, event: { ...base.event, action: { value: callbackValue('r1', 'allow') } } }, 'acc')!;
    expect(action).toMatchObject({ eventId: 'ev1', operator: { id: 'ou_user' }, ref: 'r1', action: 'allow' });
  });

  it('reads a form submit from the button name and the form fields', () => {
    const action = normalizeCardAction({ ...base, event: { ...base.event, action: { name: formSubmitName('r2'), form_value: { pick: ['a', 'b'], other: ' text ' } } } }, 'acc')!;
    expect(action).toMatchObject({ ref: 'r2', action: 'answer', selectedIds: ['a', 'b'], otherText: 'text' });
  });

  it('reads a picker choice and answers with a toast and the card', () => {
    const action = normalizeCardAction({ ...base, event: { ...base.event, action: { value: callbackValue('r3', 'pick'), option: 'p1' } } }, 'acc')!;
    expect(action).toMatchObject({ ref: 'r3', action: 'pick', selectedIds: ['p1'] });
    const response = toCallbackResponse({ toast: { tone: 'success', text: 'ok' }, redraw: { kind: 'project-picker', ref: 'r3', projects: [{ id: 'p1', name: 'P' }], selectedId: 'p1', closed: true } });
    expect(response).toMatchObject({ toast: { type: 'success', content: 'ok' }, card: { type: 'raw', data: { schema: '2.0' } } });
  });

  it('reads a model select as the chosen value', () => {
    const action = normalizeCardAction({ ...base, event: { ...base.event, action: { value: callbackValue('r4', 'param:effort'), option: 'high' } } }, 'acc')!;
    expect(action).toMatchObject({ ref: 'r4', action: 'param:effort', selectedIds: ['high'] });
  });

  it('drops a callback without a ref or an operator', () => {
    expect(normalizeCardAction({ ...base, event: { ...base.event, action: { value: {} } } }, 'acc')).toBeUndefined();
    expect(normalizeCardAction({ header: { event_id: 'e' }, event: { action: { value: callbackValue('r', 'a') } } }, 'acc')).toBeUndefined();
  });
});
