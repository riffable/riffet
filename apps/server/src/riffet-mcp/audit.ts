import { randomUUID } from 'node:crypto';
import type { RiffetDeviceAction, RiffetDeviceActionStep } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import type { StoredDeviceCall } from './devices.js';

const ACTIONS = 'riffet-mcp:device-actions';
/** Newest kept across all conversations. */
const MAX_ACTIONS = 500;

const text = (value: unknown, max = 500): string | undefined => typeof value === 'string' && value ? value.slice(0, max) : undefined;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * What conversations did on device screens (docs/DEVICES.md §3「审计」): one record per `screen.act`
 * or `app.launch` call that reached the device queue, whether the device answered or not. The
 * device's own gate is the safety boundary; this is the server's account of what was asked and done.
 */
export class DeviceAuditLog {
  constructor(private readonly store: Store) {}

  private read(): RiffetDeviceAction[] { return this.store.getSetting<RiffetDeviceAction[]>(ACTIONS, []); }

  add(action: Omit<RiffetDeviceAction, 'id' | 'createdAt'>): RiffetDeviceAction {
    const entry: RiffetDeviceAction = { id: randomUUID(), createdAt: new Date().toISOString(), ...action };
    this.store.setSetting(ACTIONS, [...this.read(), entry].slice(-MAX_ACTIONS));
    return entry;
  }

  /** Records a settled call. Steps are the device's results when it answered, else the requested actions. */
  record(kind: RiffetDeviceAction['kind'], call: StoredDeviceCall): RiffetDeviceAction {
    const outcome = call.receipt?.outcome;
    const result = outcome?.ok ? outcome.result : {};
    const args = record(call.args);
    const answered = Array.isArray(result.steps) ? result.steps.map(record) : undefined;
    const steps: RiffetDeviceActionStep[] = answered
      ? answered.map(step => ({ action: text(step.action, 40) ?? 'unknown', ...pick(step) }))
      : Array.isArray(args.steps) ? args.steps.map(step => ({ action: text(record(step).action, 40) ?? 'unknown' })) : [];
    const irreversible = answered?.find(step => text(step.category));
    const authorized = answered?.find(step => text(step.authorizedBy));
    const stopped = typeof result.stoppedAt === 'number' ? answered?.[result.stoppedAt] ?? answered?.findLast(step => step.ok === false) : undefined;
    const authorize = record(args.authorize);
    const pkg = text(result.package, 255) ?? text(result.app, 255) ?? text(authorize.app, 255) ?? text(args.package, 255);
    const category = text(irreversible?.category, 40) ?? (kind === 'authorize' ? text(authorize.action, 40) : undefined);
    const code = !outcome ? call.error?.code ?? 'DEVICE_UNREACHABLE' : !outcome.ok ? outcome.code : stopped ? text(stopped.code, 100) ?? 'DEVICE_FAILED' : undefined;
    return this.add({
      sessionId: call.sessionId, deviceId: call.deviceId, kind, ...(pkg ? { package: pkg } : {}), steps,
      ...(category ? { category } : {}), ...(authorized ? { authorizedBy: text(authorized.authorizedBy, 100)! } : {}),
      ok: !code, ...(code ? { code } : {}),
    });
  }

  /** The conversation's actions, newest first. */
  list(sessionId: string): RiffetDeviceAction[] { return this.read().filter(action => action.sessionId === sessionId).reverse(); }
}

function pick(step: Record<string, unknown>): Omit<RiffetDeviceActionStep, 'action'> {
  const target = text(step.target), effect = text(step.effect, 40), code = step.ok === false ? text(step.code, 100) : undefined;
  return { ...(target ? { target } : {}), ...(effect ? { effect } : {}), ...(code ? { code } : {}) };
}
