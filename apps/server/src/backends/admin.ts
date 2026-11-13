import type { CapabilityReport, CommandObservation, CommandResult, ConfigFile, NativeBackendId, Project } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { assertTaskWorkspaceAvailable } from '../task-workspaces/identity.js';
import type { BackendCatalog } from './catalog.js';
import { NativeBackendRegistry } from './registry.js';
import type { NativeBackendDriver, NativeBackendHost, NativeBackendProfileConfig, NativePtyLaunchSpec } from './types.js';

/** Management of a CLI on this machine outside any conversation: its login, reports, commands and project configs. */
export class BackendAdmin {
  constructor(
    private readonly registry: NativeBackendRegistry,
    private readonly host: NativeBackendHost,
    private readonly catalog: BackendCatalog,
  ) {}

  /** The launch of the backend's own login, to be run as a `login` terminal in the project. */
  async loginLaunchSpec(backendId: NativeBackendId, project: Project): Promise<NativePtyLaunchSpec> {
    const driver = this.registry.require(backendId);
    if (!driver.admin?.loginLaunch) throw new AppError('NATIVE_LOGIN_UNSUPPORTED', `${driver.label} has no terminal login`, 409, { backendId });
    return await driver.admin.loginLaunch(this.host, project, this.catalog.validateProfile(backendId));
  }

  /** Whether the backend's shell commands are observed; a backend that cannot observe them says `unsupported`. */
  async commandObservation(backendId: NativeBackendId): Promise<CommandObservation> {
    const driver = this.registry.require(backendId);
    if (!driver.commandObservation) return { state: 'unsupported' };
    return await driver.commandObservation.state(this.host, this.catalog.validateProfile(backendId));
  }

  /** The user's trust of the hooks that observe the backend's commands, recorded in the CLI's own trust store. */
  async trustCommandObservation(backendId: NativeBackendId): Promise<CommandObservation> {
    const driver = this.forwarded(backendId, 'command observation', item => Boolean(item.commandObservation));
    return await driver.commandObservation!.trust(this.host, this.catalog.validateProfile(backendId));
  }

  // The legacy `/api/cursor/*` and `/api/native/runtime/stats` endpoints forward to the backend that had them
  // first, for its default profile. A backend without a driver is `NATIVE_BACKEND_UNAVAILABLE`, one without the operation 409.
  private forwarded(backendId: NativeBackendId, operation: string, has: (driver: NativeBackendDriver) => boolean): NativeBackendDriver {
    const driver = this.registry.require(backendId);
    if (!has(driver)) throw new AppError('NATIVE_OPERATION_UNSUPPORTED', `${driver.label} has no ${operation}`, 409, { backendId });
    return driver;
  }

  async capabilityReport(backendId: NativeBackendId): Promise<CapabilityReport> {
    const driver = this.forwarded(backendId, 'capability report', item => Boolean(item.admin?.capabilityReport));
    return await driver.admin!.capabilityReport!(this.host, this.catalog.validateProfile(backendId));
  }

  async runCommand(backendId: NativeBackendId, request: { operation: string; args?: string[]; cwd?: string }): Promise<CommandResult> {
    const driver = this.forwarded(backendId, 'management commands', item => Boolean(item.admin?.runCommand));
    return await driver.admin!.runCommand!(this.host, this.catalog.validateProfile(backendId), request);
  }

  async runtimeStats(backendId: NativeBackendId): Promise<Record<string, unknown>> {
    const driver = this.forwarded(backendId, 'runtime statistics', item => Boolean(item.admin?.runtimeStats));
    return await driver.admin!.runtimeStats!(this.host);
  }

  // Project config files belong to the backends that keep them (today the first one). An id is the driver's own
  // token, so a read or write is offered to each in turn until one knows it.
  private configDrivers(): Array<{ driver: NativeBackendDriver; configs: NonNullable<NativeBackendDriver['projectConfigs']> }> {
    return this.registry.list().flatMap(driver => driver.projectConfigs ? [{ driver, configs: driver.projectConfigs }] : []);
  }

  async projectConfigs(project: Project): Promise<ConfigFile[]> {
    // The core's own rule for a project directory, whichever backend reads it (a plugin has no way to ask).
    await assertTaskWorkspaceAvailable(project);
    const lists = await Promise.all(this.configDrivers().map(({ driver, configs }) => configs.list(this.host, project, this.catalog.validateProfile(driver.id))));
    return lists.flat();
  }

  /** What a read, write or create is answered while no installed backend keeps project configs: the list is then empty, and the rest are unavailable with the reason a plugin is off. */
  private noConfigKeeper(): AppError {
    const reason = this.registry.unavailable().map(item => item.reason).join('; ');
    return new AppError('NATIVE_BACKEND_UNAVAILABLE', reason ? `No installed backend keeps project config files: ${reason}` : 'No installed backend keeps project config files', 503, reason ? { backendId: this.registry.unavailable()[0]!.id, reason } : undefined);
  }

  private async withProjectConfig(operation: (entry: ReturnType<BackendAdmin['configDrivers']>[number], profile: NativeBackendProfileConfig) => Promise<ConfigFile>): Promise<ConfigFile> {
    let missing: AppError | undefined;
    if (!this.configDrivers().length) throw this.noConfigKeeper();
    for (const entry of this.configDrivers()) {
      try { return await operation(entry, this.catalog.validateProfile(entry.driver.id)); }
      catch (error) {
        if (!(error instanceof AppError) || error.code !== 'CONFIG_NOT_FOUND') throw error;
        missing ??= error;
      }
    }
    throw missing ?? new AppError('CONFIG_NOT_FOUND', 'Config does not exist', 404);
  }

  async readProjectConfig(project: Project, id: string): Promise<ConfigFile> {
    await assertTaskWorkspaceAvailable(project);
    return this.withProjectConfig(({ configs }, profile) => configs.read(this.host, project, profile, id));
  }

  async writeProjectConfig(project: Project, id: string, content: string, expectedHash: string): Promise<ConfigFile> {
    await assertTaskWorkspaceAvailable(project);
    return this.withProjectConfig(({ configs }, profile) => configs.write(this.host, project, profile, id, content, expectedHash));
  }

  async createProjectConfig(project: Project, input: { kind: ConfigFile['kind']; path: string; content: string }): Promise<ConfigFile> {
    await assertTaskWorkspaceAvailable(project);
    const entry = this.configDrivers()[0];
    if (!entry) throw this.noConfigKeeper();
    return await entry.configs.create(this.host, project, this.catalog.validateProfile(entry.driver.id), input);
  }
}
