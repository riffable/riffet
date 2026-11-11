import { isNativeBackendId, type NativeBackendId } from '../../../../packages/contracts/src/index.js';
import type { NativeBackendDriver } from './types.js';
import { AppError } from '../errors.js';

/**
 * The drivers a request can reach. The core registers its own at start; an enabled plugin's are
 * registered and withdrawn as it is turned on and off (`PluginBackends`). A backend that is not
 * registered fails `require` with `NATIVE_BACKEND_UNAVAILABLE`, naming why when it is known.
 */
export class NativeBackendRegistry {
  private readonly drivers = new Map<NativeBackendId, NativeBackendDriver>();
  /** The plugin that provides a driver; absent for the core's own, which are never withdrawn. */
  private readonly owners = new Map<NativeBackendId, string>();
  /** Why a backend that has no driver cannot be used, asked when a request for it fails. */
  private explain: (id: NativeBackendId) => string | undefined = () => undefined;
  private awaited: (id: NativeBackendId) => boolean = () => false;
  private withheld: () => Array<{ id: NativeBackendId; reason: string }> = () => [];

  register(driver: NativeBackendDriver, owner?: string): this {
    if (this.drivers.has(driver.id)) throw new AppError('DUPLICATE_NATIVE_BACKEND', `Native backend ${driver.id} is already registered`, 500);
    this.drivers.set(driver.id, driver);
    if (owner) this.owners.set(driver.id, owner);
    return this;
  }

  /** Withdraws a plugin's driver, so new requests fail at once. The driver is returned for its caller to detach; a core driver is left in place. */
  unregister(id: NativeBackendId): NativeBackendDriver | undefined {
    const driver = this.drivers.get(id);
    if (!driver || !this.owners.has(id)) return undefined;
    this.drivers.delete(id);
    this.owners.delete(id);
    return driver;
  }

  /**
   * Says why a backend without a driver is unavailable (its plugin is off or failed), for the error a request gets.
   * `pending` says its plugin may still provide it (being started, or not evaluated yet), and `withheld` lists the
   * backends plugins declare that have no driver now.
   */
  describeUnavailable(explain: (id: NativeBackendId) => string | undefined, more: { pending?: (id: NativeBackendId) => boolean; withheld?: () => Array<{ id: NativeBackendId; reason: string }> } = {}): void {
    this.explain = explain;
    this.awaited = more.pending ?? (() => false);
    this.withheld = more.withheld ?? (() => []);
  }

  /** Whether a backend without a driver is still on its way, so work queued for it waits (bounded by its plugin's activation) instead of failing. */
  isPending(id: NativeBackendId): boolean { return !this.drivers.has(id) && this.awaited(id); }

  /** The backends plugins declare that have no driver, with why, for answers that name what is missing. */
  unavailable(): Array<{ id: NativeBackendId; reason: string }> { return this.withheld(); }

  get(id: NativeBackendId): NativeBackendDriver | undefined { return this.drivers.get(id); }

  /** Whether the core itself provides this backend. */
  isCore(id: NativeBackendId): boolean { return this.drivers.has(id) && !this.owners.has(id); }

  /** The plugin that provides this backend, if one does. */
  ownerOf(id: NativeBackendId): string | undefined { return this.owners.get(id); }

  require(id: NativeBackendId): NativeBackendDriver {
    const driver = this.get(id);
    if (!driver) {
      const reason = this.explain(id);
      throw new AppError('NATIVE_BACKEND_UNAVAILABLE', reason ? `Native backend ${id} is not available: ${reason}` : `Native backend ${id} is not installed`, 503, { backendId: id, ...(reason ? { reason } : {}) });
    }
    return driver;
  }

  list(): NativeBackendDriver[] { return [...this.drivers.values()]; }
}

/** A built-in id or a well-formed plugin Agent id. Whether anything provides it is `NativeBackendRegistry.require`'s question. */
export { isNativeBackendId };
