import { emptyComposer } from './composer.js';
import { resync } from './poll.js';
import { changed, detach, idle, loadContext, nativeStatus, owned, type Hub, type Runtime } from './runtime.js';

export function queueConfiguration(hub: Hub, runtime: Runtime): void {
  if (runtime.applying || runtime.stopped || !runtime.host.view.session(runtime.context.session.id)?.configPending) return;
  runtime.applying = true;
  void runtime.host
    .withSessionLock(
      runtime.context.session.id,
      async () => {
        if (runtime.stopped || runtime.conflict) return;
        const context = await loadContext(runtime.host, runtime.context.session.id);
        if (
          context.session.terminalHold ||
          !context.session.configPending ||
          context.session.configRevision === runtime.launch.configRevision
        ) {
          return;
        }
        const id = context.session.nativeSessionId;
        if (!idle(runtime, await nativeStatus(runtime)) || runtime.status.connection?.state !== 'connected') return;
        // Look at the draft without the interaction lock: while it is held the reader's own keystrokes are
        // refused, and this runs on every idle tick until they clear the draft.
        const blocked = emptyComposer(await runtime.host.terminals.screen(runtime.launch.terminalId, { fresh: true }))
          ? undefined
          : ('draft' as const);
        if (runtime.configBlocked !== blocked) {
          runtime.configBlocked = blocked;
          changed(hub, runtime);
        }
        if (blocked) return;
        // A message typed into agy whose USER_INPUT has not been seen yet would die with the process: the bridge
        // can report idle before agy records the input.
        const runs = await runtime.host.runs.find(context.session.id, { unfinished: true });
        if (runs.some(run => run.nativeInputBoundary && !run.nativeMessageId)) return;
        // Only now the full read, which the idle check below is made against; a draft can hold this for hours.
        if (id && runtime.rpc) await resync(hub, runtime, id);
        if (!idle(runtime, await nativeStatus(runtime))) return;
        await runtime.host.terminals.interact(runtime.launch.terminalId, async control => {
          await owned(runtime);
          if (!emptyComposer(await control.screen())) return;
          const fresh = await nativeStatus(runtime);
          if (!idle(runtime, fresh) || (id && fresh?.conversation_id !== id)) return;
          await runtime.host.terminals.stop(runtime.launch.terminalId);
          detach(hub, context.session.id);
        });
        if (runtime.stopped) await hub.reopen(runtime.host, await loadContext(runtime.host, context.session.id));
      },
      { detached: true },
    )
    .catch(() => {})
    .finally(() => {
      runtime.applying = false;
    });
}
