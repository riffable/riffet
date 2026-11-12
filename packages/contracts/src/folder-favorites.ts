/**
 * A folder bookmarked on the server, shared by every device signed in to it. Without `projectId` it
 * is a host directory for the directory pickers, home page and add-project menus, and `path` is
 * absolute and canonical (symlinks resolved). With `projectId` it belongs to that project's files
 * panel and `path` is relative to the project's root (`/`-separated, never empty, no `..`).
 */
export interface FolderFavorite {
  id: string;
  path: string;
  /** Shown instead of the folder's name when set. */
  label?: string;
  projectId?: string;
  /** Ascending; new favorites go last. */
  sort: number;
  createdAt: string;
  /** Set when a project is opened at this folder, or a client reports using it. */
  lastUsedAt?: string;
  /** Whether the folder still exists, checked when the list is read. */
  exists: boolean;
}
/** `GET /api/folder-favorites[?projectId=]` and `PUT /api/folder-favorites/order`. */
export interface FolderFavoritesResponse { favorites: FolderFavorite[]; }
/** `POST /api/folder-favorites`: idempotent, an existing favorite for the same folder is returned. */
export interface CreateFolderFavoriteRequest { path: string; label?: string; projectId?: string; }
/** `PATCH /api/folder-favorites/:id`: `label: null` clears it, `used: true` stamps `lastUsedAt`. */
export interface UpdateFolderFavoriteRequest { label?: string | null; used?: true; }
/** `PUT /api/folder-favorites/order`: the favorites of one scope, in their new order. */
export interface ReorderFolderFavoritesRequest { ids: string[]; projectId?: string; }
