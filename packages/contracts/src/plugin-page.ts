// A plugin's own page in its details (docs/PLUGIN_ARCHITECTURE.md「插件页」): settings, what the plugin knows and
// what it can do, built by the plugin at run time and drawn by each client with its own controls. The plugin writes
// no interface code, so the page is the same on the web, the Mac and the phones.
//
// Every keyed item names one of the manifest's `settings`; a change is saved there, the same value
// `PluginHost.settings()` reads. Texts are in the language the client asked for (`locale`).

/** A button. `item` goes back to the plugin with `action`, e.g. which project's data to clear. */
export interface PluginPageButton {
  action: string;
  label: string;
  item?: string;
  /** Drawn as destructive. */
  destructive?: boolean;
  /** Asked first, with this as the question. */
  confirm?: string;
  /** One line under the question: what cannot be undone. */
  confirmDetail?: string;
  disabled?: boolean;
}

export interface PluginPageOption {
  value: string;
  label: string;
  /** What the plugin found, e.g. 已安装 or 未找到. */
  detail?: string;
  disabled?: boolean;
  /** Shown with the option, e.g. downloading what it needs. */
  button?: PluginPageButton;
}

export type PluginPageItem =
  /** One of `options`, saved to `key`. */
  | { kind: 'choice'; key: string; label: string; value: string; options: PluginPageOption[] }
  /** Saved as `true` or `false`. */
  | { kind: 'toggle'; key: string; label: string; on: boolean; detail?: string }
  /** Saved when the user is done typing. A secret's value never leaves the server; `set` says whether one is saved. */
  | { kind: 'text'; key: string; label: string; value?: string; placeholder?: string; secret?: boolean; set?: boolean }
  /** Saved as a JSON array of strings (`listSetting` in the plugin API reads it). */
  | { kind: 'list'; key: string; label: string; values: string[]; placeholder?: string }
  /** Read only: something the plugin knows, with what can be done to it. */
  | { kind: 'row'; id: string; label: string; value?: string; detail?: string; buttons?: PluginPageButton[] }
  /**
   * A bounded amount or a progress, drawn with a bar under the label. `percent` is 0–100: of the allowance used when `sense`
   * is `quota`, done when it is `progress`. `value` replaces the figure the client writes (n%, or 剩余 n%), e.g. `1.2 GB / 5 GB`.
   * Drawn only by clients that list `meter` in `PLUGIN_PAGE_KINDS_PARAM`; the others get a `row`.
   */
  | { kind: 'meter'; id: string; label: string; percent: number; sense: 'quota' | 'progress'; value?: string; detail?: string; buttons?: PluginPageButton[] }
  | { kind: 'buttons'; buttons: PluginPageButton[] };

/**
 * Kinds a client draws beyond the six every client has (`choice`, `toggle`, `text`, `list`, `row`, `buttons`), sent as this
 * query parameter of the page's GET and POST, comma separated. The server turns the kinds a client did not list into rows.
 */
export const PLUGIN_PAGE_KINDS_PARAM = 'kinds';
export const PLUGIN_PAGE_EXTRA_KINDS = ['meter'] as const;
export type PluginPageExtraKind = typeof PLUGIN_PAGE_EXTRA_KINDS[number];

export interface PluginPageSection {
  id: string;
  title?: string;
  /** One line under the section, only for what the user cannot see from the items. */
  footer?: string;
  items: PluginPageItem[];
}

export interface PluginPage {
  sections: PluginPageSection[];
  /** While shown, read again after this many milliseconds: for state that changes on its own, such as a download. */
  refreshMs?: number;
}

/** `GET /api/integrations/:id/page?locale=`, and the answer to a change. `message` is the plugin's word on what a button did. */
export interface PluginPageResponse { page: PluginPage; message?: string }

/** `POST /api/integrations/:id/page`: one change, `set` or `run`. A list is sent whole. `null` clears the setting. */
export interface PluginPageChange {
  locale?: string;
  set?: { key: string; value: string | boolean | string[] | null };
  run?: { action: string; item?: string };
}

/** `GET /api/integrations/:id/readme?locale=`: the package's README in that language, or the nearest one. Absent when it has none. */
export interface PluginReadmeResponse { readme?: string }
