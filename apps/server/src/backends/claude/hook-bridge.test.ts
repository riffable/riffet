import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeHookBridge } from './hook-bridge.js';

type Dispatch = (payload: Record<string, unknown>, deliveryId: string, signal: AbortSignal) => Promise<Record<string, unknown> | void>;
const dispatchOf = (bridge: ClaudeHookBridge) => (payload: Record<string, unknown>) => (bridge as unknown as { dispatch: Dispatch }).dispatch(payload, 'd', new AbortController().signal);

describe('Claude hook bridge for a conversation with no runtime', () => {
  it('brings the conversation up for a state-changing hook, and lets a session that is not ours through unanswered', async () => {
    const bridge = new ClaudeHookBridge();
    const asked: string[] = [];
    bridge.setWake(async sessionId => {
      asked.push(sessionId);
      if (sessionId !== 'ours') return false;
      setTimeout(() => bridge.register('ours', async payload => ({ routed: payload.hook_event_name })), 20);
      return true;
    });
    const dispatch = dispatchOf(bridge);
    expect(await dispatch({ session_id: 'ours', hook_event_name: 'UserPromptSubmit' })).toEqual({ routed: 'UserPromptSubmit' });
    expect(await dispatch({ session_id: 'theirs', hook_event_name: 'Stop' })).toEqual({});
    // A foreign id is remembered for a while rather than looked up on every hook; a hook that changes nothing wakes nobody.
    expect(await dispatch({ session_id: 'theirs', hook_event_name: 'Stop' })).toEqual({});
    expect(await dispatch({ session_id: 'quiet', hook_event_name: 'Notification' })).toEqual({});
    expect(asked).toEqual(['ours', 'theirs']);
  });

  it('sends a session the CLI moved to (`/clear`) to the runtime of the conversation that launched it', async () => {
    const bridge = new ClaudeHookBridge();
    const unregister = bridge.register('before', async payload => ({ routed: payload.session_id }), 'conversation');
    const dispatch = dispatchOf(bridge);
    expect(await dispatch({ session_id: 'after', hook_event_name: 'SessionStart', riffet_owner: 'conversation' })).toEqual({ routed: 'after' });
    expect(await dispatch({ session_id: 'after', hook_event_name: 'SessionStart', riffet_owner: 'another' })).toEqual({});
    unregister();
    expect(await dispatch({ session_id: 'after', hook_event_name: 'SessionStart', riffet_owner: 'conversation' })).toEqual({});
  });

  it('hands a warm CLI\'s SessionStart to the conversation that takes it, and its later sessions too', async () => {
    const bridge = new ClaudeHookBridge();
    const dispatch = dispatchOf(bridge);
    const held = bridge.hold('warm');
    const start = { session_id: 'warm', hook_event_name: 'SessionStart', transcript_path: '/t/warm.jsonl', riffet_owner: 'warm' };
    // Before a conversation takes it, its hooks are answered with nothing.
    expect(await dispatch(start)).toEqual({});
    await held.started;
    const seen: unknown[] = [];
    const unregister = bridge.register('warm', async payload => { seen.push(payload); return { routed: payload.session_id }; }, ['conversation', 'warm']);
    await expect.poll(() => seen).toEqual([start]);
    // Its owner is its own first id: a session it moves to (`/clear`) still reaches the conversation.
    expect(await dispatch({ session_id: 'after', hook_event_name: 'SessionStart', riffet_owner: 'warm' })).toEqual({ routed: 'after' });
    // Releasing the hold after the conversation registered leaves the conversation's route alone.
    held.release();
    expect(await dispatch({ session_id: 'warm', hook_event_name: 'Stop' })).toEqual({ routed: 'warm' });
    // The conversation goes on under the new id, keeping the first among its ids; a second `/clear` still finds it.
    unregister();
    bridge.register('after', async payload => ({ moved: payload.session_id }), ['conversation', 'after', 'warm']);
    expect(await dispatch({ session_id: 'later', hook_event_name: 'SessionStart', riffet_owner: 'warm' })).toEqual({ moved: 'later' });
  });

  it('publishes its descriptor again when it is started after a close', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'claude-bridge-'));
    const bridge = new ClaudeHookBridge({ stateDir });
    try {
      await bridge.start();
      expect(existsSync(bridge.descriptorPath!)).toBe(true);
      await bridge.close();
      expect(existsSync(bridge.descriptorPath!)).toBe(false);
      await bridge.start();
      expect(existsSync(bridge.descriptorPath!)).toBe(true);
    } finally { await bridge.close(); await rm(stateDir, { recursive: true, force: true }); }
  });
});
