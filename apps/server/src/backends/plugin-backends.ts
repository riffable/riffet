import type { AgentBackend } from '@riffet/plugin-api/experimental/agent';
import type { NativeBackendId } from '../../../../packages/contracts/src/index.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { PluginBackendDriver, type WorkspaceObserver } from './plugin-backend.js';
import type { NativeBackendRegistry } from './registry.js';
import type { NativeBackendService } from './service.js';

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Keeps the backend registry in step with the enabled plugins: a plugin's Agent backends are registered
 * when it is turned on and withdrawn when it is turned off, with nothing else naming which backends
 * exist. Withdrawing is immediate for new requests (`NATIVE_BACKEND_UNAVAILABLE`, with the plugin's
 * state as the reason); what the plugin holds for running sessions is then released as observation only.
 *
 * Registering is also where a returning backend meets what waited for it: readers that followed its
 * sessions while it was away get a watch on the new driver (`attachBackend`), and the backend is told to
 * `start`. The host a withdrawn driver gave its plugin is revoked once the plugin's activation has been
 * released, not before, since releasing it may still need the host.
 */
export class PluginBackends {
  private readonly mounted = new Map<NativeBackendId, { backend: AgentBackend; driver: PluginBackendDriver }>();
  /** Withdrawn drivers whose plugin is still being released. */
  private readonly withdrawn = new Map<AgentBackend, PluginBackendDriver>();
  private stop?: () => void;
  private stopEnded?: () => void;

  constructor(private readonly options: {
    plugins: Pick<PluginRegistry, 'agentBackends' | 'declaredAgentBackends' | 'agentBackendPending' | 'onChange' | 'onEnded'>;
    registry: NativeBackendRegistry;
    service: Pick<NativeBackendService, 'host' | 'detachBackend' | 'attachBackend' | 'catalog'>;
    /** What shell commands change in the working tree, for a backend that reports it (`backends/shared/workspace-observer.ts`). */
    workspaceObserver?: WorkspaceObserver;
  }) {}

  /** Mounts what is enabled now and follows changes until `close`. */
  start(): void {
    const { plugins, registry } = this.options;
    registry.describeUnavailable(id => plugins.declaredAgentBackends().find(declared => declared.id === id && !declared.enabled)?.reason, {
      pending: id => plugins.agentBackendPending(id),
      withheld: () => plugins.declaredAgentBackends().flatMap(declared => !declared.enabled && declared.reason ? [{ id: declared.id as NativeBackendId, reason: declared.reason }] : []),
    });
    this.stopEnded ??= plugins.onEnded(contributions => {
      for (const backend of contributions?.agentBackends ?? []) {
        const driver = this.withdrawn.get(backend);
        this.withdrawn.delete(backend);
        driver?.revoke();
      }
    });
    this.sync();
    this.stop ??= plugins.onChange(() => this.sync());
  }

  /** Stops following changes. Mounted drivers stay: closing the plugins (after this) still releases their plugins through the host. */
  close(): void {
    this.stop?.();
    this.stop = undefined;
  }

  private sync(): void {
    const { plugins, registry, service } = this.options;
    const wanted = new Map<NativeBackendId, { owner: string; backend: AgentBackend }>(plugins.agentBackends().map(({ owner, backend }) => [backend.id, { owner, backend }]));
    // Withdraw first, so a plugin that was turned off and on again is replaced by its new activation.
    for (const [id, item] of [...this.mounted]) {
      if (wanted.get(id)?.backend === item.backend) continue;
      this.mounted.delete(id);
      if (registry.unregister(id) !== item.driver) continue;
      this.withdrawn.set(item.backend, item.driver);
      service.detachBackend(id);
      void item.driver.detachAll(service.host).catch(() => undefined);
    }
    for (const [id, { owner, backend }] of wanted) {
      if (this.mounted.has(id)) continue;
      let driver: PluginBackendDriver;
      try {
        driver = new PluginBackendDriver(backend, owner, this.options.workspaceObserver);
        registry.register(driver, owner);
        this.mounted.set(id, { backend, driver });
      } catch (error) {
        console.warn(`[riffet] agent backend ${id} of ${owner} was not registered: ${describe(error)}`);
        continue;
      }
      // Whatever followed this backend's sessions while it was away is attached to the driver now.
      try { service.attachBackend(id); }
      catch (error) { console.warn(`[riffet] agent backend ${id}: readers were not re-attached: ${describe(error)}`); }
      if (driver.start) {
        void Promise.resolve()
          .then(() => driver.start!(service.host, service.catalog.validateProfile(id)))
          .catch((error: unknown) => console.warn(`[riffet] agent backend ${id} did not start: ${describe(error)}`));
      }
    }
  }
}
