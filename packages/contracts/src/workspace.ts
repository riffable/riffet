export interface FileEntry { path: string; name: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: string; }
/**
 * `hash` is the version a save names as `expectedHash`. `editable` marks a whole UTF-8 text file inside
 * the project that the workbench may write (`apps/server/src/workspace/write.ts`).
 */
export interface FilePreview { path: string; content: string; hash: string; size: number; binary: boolean; truncated: boolean; image?: { mimeType: string }; render?: { kind: string }; editable?: boolean; }
/** A project file after a save or a creation: the version the next save names. */
export interface FileVersion { path: string; hash: string; size: number; }
/** A deletion kept for undo carries the id that restores it; one deleted for good carries none. */
export interface FileDeletion { path: string; restoreId?: string; }
export interface SearchHit { path: string; line: number; text: string; }
/**
 * A text search with its completeness (`GET /api/projects/:id/search?detail=1`; without `detail` the route returns the bare `hits`).
 * `more`: matches exist beyond this page. `incomplete`: the search did not cover everything it should, so fewer hits than
 * exist may be shown: `time` ran out of time, `budget` hit the file or byte limit of the walk without ripgrep, `error` ripgrep
 * failed (unreadable files). A search with neither flag found every match.
 */
export interface SearchResults { hits: SearchHit[]; more: boolean; incomplete?: 'time' | 'budget' | 'error'; }
/** A place in a project file that code navigation points at; `line` and `column` are 1-based, `text` is the line. */
export interface CodeLocation { path: string; line: number; column: number; text: string; }
/** Where a symbol may be declared, best guess first; empty when nothing was found. */
export interface CodeDefinitions { locations: CodeLocation[]; }
/** Lines that use a symbol; `complete` is false when the search stopped at its limit or time budget. */
export interface CodeReferences { locations: CodeLocation[]; complete: boolean; }
/** What a declaration is, as the code index (`apps/server/src/workspace/symbols/`) tells them apart. */
export type CodeSymbolKind = 'class' | 'interface' | 'object' | 'enum' | 'annotation' | 'typealias' | 'function' | 'property' | 'constructor';
/** A declaration found by the code index; `container` is the enclosing type, `package` the file's. */
export interface CodeSymbol { name: string; kind: CodeSymbolKind; path: string; line: number; column: number; container?: string; package?: string; }
/** One declaration of a file and the ones nested in it, as an outline shows them. */
export interface CodeOutlineItem { name: string; kind: CodeSymbolKind; line: number; column: number; children?: CodeOutlineItem[]; }
/** A file's declarations; empty for a language the index does not read. */
export interface CodeOutline { path: string; package?: string; items: CodeOutlineItem[]; }
/**
 * The code index of a project. `idle` has never been built; `building` counts `done` of `files`;
 * `ready` answers queries, and may be rebuilding changed files meanwhile (`done < files`).
 */
export interface CodeIndexStatus { state: 'idle' | 'building' | 'ready' | 'failed'; files: number; done: number; symbols: number; builtAt?: string; error?: string; }
export interface CodeSymbolResults { items: CodeSymbol[]; index: CodeIndexStatus; }
/** A directory that is a module of its build system (`build.gradle`, `package.json`...), project-relative; `''` is the root. */
export interface CodeModule { path: string; name: string; marker: string; }
export interface CodeModules { modules: CodeModule[]; }
/**
 * One uploaded attachment. Image dimensions are captured at upload time so a transcript can size
 * its thumbnail before the bytes arrive: without them an unloaded `<img>` has no intrinsic size
 * and the message would collapse to nothing, then jump once the image decodes.
 */
export interface Attachment { id: string; name: string; mimeType: string; size: number; path: string; width?: number; height?: number; }
