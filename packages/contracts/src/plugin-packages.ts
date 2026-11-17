// Independent plugin packages (docs/PLUGIN_ARCHITECTURE.md "独立包"): what the server reports about an
// installed package's versions, grants and compatibility. Built-in and development packages carry
// none of it.

/** The web plugin SDK version this build ships; a package's `hostApi.web` range is matched against it. */
export const PLUGIN_WEB_API_VERSION = 1;

/**
 * What a package may ask for, granted per version at install. The host enforces a capability where
 * it mediates the call (see docs/PLUGIN_ARCHITECTURE.md for which ones the operating system also enforces).
 */
export const PLUGIN_CAPABILITIES = ['models.provide', 'tasks.run', 'projects.read', 'sessions.read', 'network', 'process.exec'] as const;
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
  /** The package's declared model sources. `hosts` are the only addresses an isolated package's source may send requests and the profile's key to, besides one the user typed; a source without it is not limited. */
  modelSources?: Array<{ id: string; hosts?: string[] }>;
  /** With `process.exec`: the commands the package runs on this machine, outside the sandbox, as the user who runs Riffet. */
  executables?: string[];
}

/** The id of the public plugin index, the source every server starts with. */
export const PLUGIN_SOURCE_BUILTIN = 'riffet';

/**
 * A plugin index this server reads (docs/PLUGINS.md「插件市场」). Sources are kept in plugins.json, so
 * every client of the server sees the same ones. Adding a source decides what can be found, not what
 * runs: each install is still confirmed with its grant.
 *
 * `POST /api/integrations/sources` `{ url }` reads the index once and saves it (an address that cannot
 * be read is refused); `PATCH /api/integrations/sources/:id` `{ enabled }`; `DELETE /api/integrations/sources/:id`
 * (not the built-in one). Each replies with the `PluginMarketList`.
 */
export interface PluginSource {
  /** Derived from the address, so adding the same address again gives the same id and installs pinned to it find it again. */
  id: string;
  url: string;
  /** The index's own `name`, as last read; clients fall back to the address's host. */
  name?: string;
  /** The public index: it can be turned off, not removed. */
  builtin?: boolean;
  /** The address is set by the service's `RIFFET_PLUGIN_INDEX` and cannot be changed here. */
  fixed?: boolean;
  enabled: boolean;
  /** How many packages it lists that this server could install, as last read. */
  plugins?: number;
  /** Why the last read failed; the other sources are listed regardless. */
  error?: string;
}

/**
 * `GET /api/integrations/market/:id?version=&source=`: a release in a plugin index, before it is
 * installed. Shaped like a grant request so the same confirmation serves both; installing it is
 * `POST /api/integrations/install` with `{ market: { source, id, version }, grant, trusted? }`.
 * An installed package stays with the source it came from: installing the same id from another
 * source is refused (409 `PLUGIN_SOURCE_CONFLICT`) until it is uninstalled.
 */
export interface PluginMarketOffer extends PluginGrantRequired {
  title?: Record<string, string>;
  sourceId: string;
}

/** One package in a plugin index, at the newest release this server can run (or the newest, when none can). The same id may be listed once per source. */
export interface PluginMarketEntry {
  /** The source listing it. */
  sourceId: string;
  /** Installed on this server: the selected version, and whether it came from this source. Only an entry from the same source offers updates. */
  installed?: { version: string; sameSource: boolean };
  /** With `installed.sameSource`: this entry's version is newer than the installed one and runs on this server. */
  update?: boolean;
  id: string;
  vendor: string;
  title?: Record<string, string>;
  description?: Record<string, string>;
  version: string;
  date?: string;
  size?: number;
  license?: string;
  /** Where its source is published. */
  source?: string;
  /** Its page on the browse page the index declares (`page`, relative to the index), as `<page>#/<id>`; absent when the index declares none. */
  page?: string;
  /** The package's README as Markdown, links made absolute. */
  readme?: string;
  /** The manifest's `contributes` keys, such as `appearance` or `modelSources`. */
  contributes: string[];
  capabilities: string[];
  /** As in a grant request. */
  modelSources?: PluginGrantRequired['modelSources'];
  executables?: string[];
  trustedRequired?: boolean;
  /** Whether some release declares a server host API this server provides. */
  compatible: boolean;
}

/** `GET /api/integrations/market`: every enabled plugin index as this server reads it, built-in plugins left out. */
export interface PluginMarketList {
  plugins: PluginMarketEntry[];
  /** All sources, enabled or not, the built-in one first. */
  sources: PluginSource[];
  /** This request came directly from the service machine, where explicit trust is allowed. */
  trustedAllowed: boolean;
}
