// Independent plugin packages (docs/PLUGIN_ARCHITECTURE.md "独立包"): what the server reports about an
// installed package's versions, grants and compatibility. Built-in and development packages carry
// none of it.

/** The web plugin SDK version this build ships; a package's `hostApi.web` range is matched against it. */
export const PLUGIN_WEB_API_VERSION = 1;

/**
 * What a package may ask for, granted per version at install. The host enforces a capability where
 * it mediates the call (see docs/PLUGIN_ARCHITECTURE.md for which ones the operating system also enforces).
 */
export const PLUGIN_CAPABILITIES = ['models.provide', 'tasks.run', 'projects.read', 'sessions.read', 'network'] as const;
export type PluginCapability = typeof PLUGIN_CAPABILITIES[number];

/** Whether one entry of a package works with this host: `range` is the package's `hostApi` requirement. */
export interface PluginEntryCompatibility { range: string; ok: boolean }
export interface PluginCompatibility { server?: PluginEntryCompatibility; web?: PluginEntryCompatibility }

export interface InstalledPluginVersion {
  version: string;
  /** Where it came from, such as `upload:name.tgz` or `path:/abs/dir`. */
  source: string;
  /** `sha256-<hex>` over the package content: it proves the files are the ones installed, not who wrote them. */
  integrity: string;
  installedAt: string;
  /** What the user granted for this version. */
  capabilities: string[];
  /** Explicitly trusted by a local operator; server code runs with Riffet's permissions. Absent means isolated. */
  trusted?: boolean;
  selected: boolean;
}

export interface InstalledPluginInfo {
  versions: InstalledPluginVersion[];
  selected: string;
  /** The data version recorded in the plugin's data directory, when it declares one. */
  dataVersion?: number;
  /** Backups of the data directory kept by upgrades, such as `acme.demo.backup-v1`. */
  backups?: string[];
  /** Whether the plugin's data directory exists. */
  hasData: boolean;
}

/** `POST /api/integrations/install`: the reply when the request's `grant` did not equal the package's capabilities (409). */
export interface PluginGrantRequired {
  id: string;
  version: string;
  capabilities: string[];
  /** This package needs in-process host access; the declaration never grants it. */
  trustedRequired?: boolean;
  /** This request came directly from the service machine, where explicit trust is allowed. */
  trustedAllowed?: boolean;
}
