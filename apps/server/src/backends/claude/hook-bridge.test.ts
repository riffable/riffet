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
