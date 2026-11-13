import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import type { ActionStep } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { Entry, Flow } from './entry.js';

const MAX_FLOWS = 32;

/** What actions and device-code flows need of the registry. */
export interface FlowsPort {
  require(id: string): Entry;
  entry(id: string): Entry | undefined;
  events(entry: Entry): readonly string[];
  ensureContribution(kind: 'command' | 'model-source' | 'task' | 'view', contributionId: string): Promise<void>;
  ensureEntry(entry: Entry, trigger: string): Promise<void>;
  guarded<T>(entry: Entry, run: () => Promise<T>, failureCode?: string): Promise<T>;
}

export class Flows {
  private readonly flows = new Map<string, Flow>();

  constructor(private readonly port: FlowsPort) {}

  /** A plugin's flows end with its activation. */
  forget(id: string): void {
    for (const [flowId, flow] of this.flows) if (flow.pluginId === id) this.flows.delete(flowId);
  }

  async runAction(id: string, actionId: string): Promise<ActionStep> {
    const entry = this.port.require(id);
    if (!entry.active && entry.plugin.manifest.contributes?.actions?.some(action => action.id === actionId)) {
      const source = entry.plugin.manifest.contributes.modelSources?.find(source => source.loginAction === actionId);
      if (source && this.port.events(entry).includes('model-source')) await this.port.ensureContribution('model-source', source.id);
      else if (this.port.events(entry).includes('command')) await this.port.ensureEntry(entry, `command:action:${actionId}`);
    }
    const actions = entry.active?.contributions?.actions;
    if (!actions) {
      if (!entry.active) throw new AppError('INTEGRATION_DISABLED', 'This plugin is off', 409);
      throw new AppError('INTEGRATION_ACTION_NOT_FOUND', 'Unknown plugin action', 404);
    }
    const handler = Object.hasOwn(actions, actionId) ? actions[actionId] : undefined;
    if (!handler) throw new AppError('INTEGRATION_ACTION_NOT_FOUND', 'Unknown plugin action', 404);
    const activation = entry.active!;
    const outcome = await this.port.guarded(entry, () => handler.run());
    if (outcome.kind !== 'device-flow') return outcome;
    // Turned off while the login was starting: no flow is registered for an activation that ended.
    if (entry.active !== activation) throw new AppError('INTEGRATION_DISABLED', 'This plugin was turned off', 409);
    let uri: URL | undefined;
    try { uri = new URL(outcome.verificationUri); } catch { /* rejected below */ }
    if (!uri || (uri.protocol !== 'https:' && uri.protocol !== 'http:')) throw new AppError('INTEGRATION_ACTION_FAILED', 'The plugin returned an invalid verification address', 502);
    const now = Date.now();
    for (const [key, flow] of this.flows) if (flow.flow.expiresAt <= now) this.flows.delete(key);
    while (this.flows.size >= MAX_FLOWS) this.flows.delete(this.flows.keys().next().value!);
    const flowId = randomBytes(16).toString('hex');
    this.flows.set(flowId, { pluginId: id, flow: outcome, polling: false, activation });
    return {
      kind: 'show-code', flowId, verificationUri: outcome.verificationUri, ...(outcome.userCode ? { userCode: outcome.userCode } : {}),
      qrSvg: await QRCode.toString(outcome.verificationUri, { type: 'svg' }), intervalMs: outcome.intervalMs, expiresAt: outcome.expiresAt,
    };
  }

  /** One poll. A poll already in flight answers `pending`, so a completed login has its side effects once. */
  async pollFlow(id: string, flowId: string): Promise<ActionStep> {
    const record = this.flows.get(flowId);
    if (!record || record.pluginId !== id) throw new AppError('INTEGRATION_FLOW_NOT_FOUND', 'This sign-in is no longer pending', 404);
    if (this.port.entry(id)?.active !== record.activation) {
      this.flows.delete(flowId);
      throw new AppError('INTEGRATION_DISABLED', 'This plugin is off', 409);
    }
    if (Date.now() >= record.flow.expiresAt) {
      this.flows.delete(flowId);
      return { kind: 'failed', message: '验证码已过期，请重新发起' };
    }
    if (record.polling) return { kind: 'pending' };
    record.polling = true;
    try {
      const step = await this.port.guarded(this.port.require(id), () => record.flow.poll());
      if (step.kind !== 'pending' && step.kind !== 'slow_down') this.flows.delete(flowId);
      return step;
    } finally { record.polling = false; }
  }
}
