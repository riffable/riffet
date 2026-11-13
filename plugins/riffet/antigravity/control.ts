import { setTimeout as delay } from 'node:timers/promises';
import type { AgentContext, AgentHost, AgentStopOptions } from '@riffet/plugin-api/experimental/agent';
import { required } from './lifecycle.js';
import { changed, loadContext, owned, type Hub } from './runtime.js';
import { refresh } from './poll.js';
import { mapAgySnapshot } from './transcript.js';

export async function runtimeAction(
  hub: Hub,
  host: AgentHost,
  context: AgentContext,
  request: { action: string; revision: string },
): Promise<void> {
  if (request.action !== 'stop-current') throw host.error('RUNTIME_ACTION_UNKNOWN', 'Unknown Antigravity runtime action', 400);
  await host.withSessionLock(context.session.id, async () => {
    if (host.view.session(context.session.id)?.terminalHold) {
      throw host.error('SESSION_IN_TERMINAL', 'The conversation is controlled from its terminal', 409);
    }
    const runtime = await required(hub, host, await loadContext(host, context.session.id));
    if (request.revision !== runtime.status.runtimeControl?.revision) {
      throw host.error('RUNTIME_ACTION_STALE', 'The Antigravity runtime changed', 409);
    }
    await interrupt(hub, host, context);
  });
}

export async function interrupt(hub: Hub, host: AgentHost, context: AgentContext, options: AgentStopOptions = {}) {
  if (options.clearPrompt) throw host.error('CLEAR_INPUT_UNSUPPORTED', 'Clear the Antigravity draft in the terminal', 409);
  if (options.expectedStop) {
    throw host.error('TARGETED_STOP_UNSUPPORTED', 'Antigravity cannot atomically stop a specified execution', 409);
  }
  const runtime = await required(hub, host, context);
  const id = host.view.session(context.session.id)?.nativeSessionId;
  if (!id) return;
  runtime.cancelling = true;
  try {
    await host.terminals.interact(runtime.launch.terminalId, async control => {
      await owned(runtime);
      runtime.snapshot = await runtime.rpc!.snapshot(id);
      const execution = mapAgySnapshot(runtime.snapshot).turns.findLast(turn => !turn.status)?.id;
      runtime.stream?.abort();
      await runtime.rpc!.call('CancelCascadeInvocation', { cascadeId: id, killBackgroundTasks: true });
      // Cancellation acknowledgement may precede the executor's durable end. The pane stays
      // exclusive until that evidence arrives; no queued Riffet input can start in between.
      for (let attempt = 0; attempt < 30; attempt++) {
        runtime.snapshot = await runtime.rpc!.snapshot(id);
        const turns = mapAgySnapshot(runtime.snapshot).turns;
        const active = turns.findLast(turn => !turn.status)?.id;
        if (active && active !== execution) break;
        if (!active && runtime.snapshot.status === 'CASCADE_RUN_STATUS_IDLE') {
          const screen = await control.screen();
          if (/esc to cancel/i.test(screen ?? '')) await control.keys(['Escape']);
          break;
        }
        await delay(100);
      }
    });
  } finally {
    runtime.cancelling = false;
  }
  await refresh(hub, runtime);
  changed(hub, runtime);
}
