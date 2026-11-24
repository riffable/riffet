import { afterEach, describe, expect, it } from 'vitest';
import { type NativeTurnTarget, type NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { Store } from '../../store.js';
import { AppError } from '../../errors.js';
import type { NativeBackendHost, NativeBackendSendRequest } from '../types.js';
import { DeferredSteerInputs, parseSteerContexts } from './deferred-steer.js';

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function harness() {
  const store = new Store(':memory:'); stores.push(store);
  const project = store.createProject('/tmp/riffet-deferred-steer-test', 'test');
  const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', nativeSessionId: 'chat', mode: 'agent' });
  const target = { nativeSessionId: 'chat', turnId: 'generation-1' };
  let active: NativeTurnTarget | undefined = target;
  const events: NativeWorkbenchEvent[] = [];
  const host = {
    getSession: (id: string) => store.getSession(id),
    findRunsByNativeTurn: (id: string, nativeSessionId: string, turnId: string) => store.findRunsByNativeTurn(id, nativeSessionId, turnId),
    emitEvent: (_id: string, event: NativeWorkbenchEvent) => events.push(event),
  } as unknown as NativeBackendHost;
  const controller = () => new DeferredSteerInputs(host, { backendId: 'cursor', sessionId: session.id, currentTarget: () => active });
  const inputs = controller();
  const enqueue = (commandId: string, text = '使用中文解释', onFence?: () => void) => {
    const run = store.acceptNativeRun(session.id, commandId, { text, attachmentIds: [], context: [] }, { mode: 'agent' }, undefined, { target });
    store.transitionNativeRun(run.id, ['queued'], { delivery: 'preparing' });
    const request = { session, project, profile: { id: 'default', backendId: 'cursor', name: 'default', config: {} }, commandId, runId: run.id,
      input: run.native!.input, config: run.native!.config, target, commitDispatchFence: (binding) => {
        onFence?.();
        if (store.getSession(session.id).archivedAt) throw new AppError('ARCHIVED_SESSION', 'archived', 409);
        const fenced = store.transitionNativeRun(run.id, ['preparing'], { ...binding, delivery: 'dispatching' });
        if (!fenced) throw new AppError('RUN_CANCELLED', 'cancelled', 409);
        return fenced;
      } } satisfies NativeBackendSendRequest & { target: NativeTurnTarget };
    inputs.enqueue(request, text);
    return run;
  };
  return { store, session, target, inputs, events, enqueue, controller, setActive: (next?: NativeTurnTarget) => { active = next; } };
}

describe('deferred native hook input', () => {
  it('fences once at the matching boundary and requires the full persisted carrier in a native receipt', () => {
    const h = harness(), run = h.enqueue('command-1');
    expect(h.store.getRun(run.id).native?.renderedText).toBeUndefined();
    const carrier = h.inputs.claim(h.target)!;
    expect(parseSteerContexts(carrier)).toMatchObject([{ commandId: 'command-1', target: h.target, text: '使用中文解释' }]);
    expect(h.inputs.claim(h.target)).toBeUndefined();
    expect(h.events.map(event => event.type)).toEqual(['native_input_submitted']);
    expect(h.inputs.receiptEvents('使用中文解释', 'tool-1', 'now')).toEqual([]);
    expect(h.inputs.receiptEvents(carrier.replace('使用中文解释', 'different'), 'tool-1', 'now')).toEqual([]);
    const receipt = h.inputs.receiptEvents(`real tool output\n${carrier}`, 'tool-1', 'now');
    expect(receipt).toMatchObject([{ type: 'native_input_receipt', runId: run.id, nativeTurnId: h.target.turnId,
      data: { content: { text: '使用中文解释' }, sourceNativeId: 'tool-1' } }]);
    expect(h.inputs.receiptEvents(carrier, 'tool-1', 'now')).toEqual(receipt);
    expect(h.controller().receiptEvents(carrier, 'tool-1', 'now')).toEqual(receipt);
    h.store.transitionNativeRun(run.id, ['dispatching'], { delivery: 'observed', stage: 'acknowledged', nativeMessageId: receipt[0]!.nativeId }, { state: 'completed' });
    expect(h.controller().receiptEvents(carrier, 'tool-1', 'now')).toEqual([]);
    expect(h.controller().receiptEvents(carrier, 'tool-1', 'now', { includeAcknowledged: true })).toEqual(receipt);
    const other = harness(); other.enqueue('command-1'); other.inputs.claim(other.target);
    expect(other.inputs.receiptEvents(carrier, 'tool-1', 'now')).toEqual([]);
  });

  it('does not let a cancelled or archived pending input consume the hook output of another valid input', () => {
    const h = harness();
    const cancelled = h.enqueue('cancelled'); h.enqueue('valid');
    h.store.transitionNativeRun(cancelled.id, ['preparing'], { delivery: 'cancelled' }, { state: 'cancelled' });
    const context = h.inputs.claim(h.target)!;
    expect(parseSteerContexts(context).map(item => item.commandId)).toEqual(['valid']);
    expect(h.events.map(event => event.type)).toEqual(['native_input_rejected', 'native_input_submitted']);
    const archived = h.enqueue('archived'); h.store.updateSession(h.session.id, { archivedAt: new Date().toISOString() });
    expect(h.inputs.claim(h.target)).toBeUndefined();
    expect(h.store.getRun(archived.id).native?.renderedText).toBeUndefined();
  });

  it('bounds each hook response without dropping inputs that did not fit', () => {
    const h = harness(); h.enqueue('first', 'a'.repeat(5000)); h.enqueue('second', 'b'.repeat(5000));
    const first = h.inputs.claim(h.target)!, second = h.inputs.claim(h.target)!;
    expect(first.length).toBeLessThanOrEqual(8000); expect(second.length).toBeLessThanOrEqual(8000);
    expect(parseSteerContexts(first).map(item => item.commandId)).toEqual(['first']);
    expect(parseSteerContexts(second).map(item => item.commandId)).toEqual(['second']);
    expect(() => h.enqueue('too-large', 'a'.repeat(8000))).toThrow('The steer message is too long');
  });

  it('recovers a durable owner outcome after restart but does not settle from an uncertain owner', () => {
    const h = harness();
    const owner = h.store.acceptNativeRun(h.session.id, 'owner', { text: 'task', attachmentIds: [], context: [] }, { mode: 'agent' });
    h.store.transitionNativeRun(owner.id, ['queued'], { delivery: 'uncertain', nativeTurnId: h.target.turnId, nativeMessageId: 'original-user' }, { state: 'interrupted' });
    h.enqueue('steer'); const carrier = h.inputs.claim(h.target)!;
    expect(h.controller().receiptEvents(carrier, 'tool', 'now').map(event => event.type)).toEqual(['native_input_receipt']);
    h.store.transitionNativeRun(owner.id, ['uncertain'], { delivery: 'observed', stage: 'completed' }, { state: 'completed' });
    expect(h.controller().receiptEvents(carrier, 'tool', 'now').map(event => event.type)).toEqual(['native_input_receipt', 'run_completed']);
    h.store.transitionNativeRun(owner.id, ['observed'], { delivery: 'failed', stage: 'provider_failed' }, { state: 'failed', error: 'native failure' });
    expect(h.controller().receiptEvents(carrier, 'tool', 'now').at(-1)).toMatchObject({ type: 'run_failed', data: { error: 'native failure' } });
  });
});
