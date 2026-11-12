export interface FileEntry { path: string; name: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: string; }
export interface FilePreview { path: string; content: string; hash: string; size: number; binary: boolean; truncated: boolean; image?: { mimeType: string }; render?: { kind: string }; }
export interface SearchHit { path: string; line: number; text: string; }
/** A place in a project file that code navigation points at; `line` and `column` are 1-based, `text` is the line. */
export interface CodeLocation { path: string; line: number; column: number; text: string; }
/** Where a symbol may be declared, best guess first; empty when nothing was found. */
export interface CodeDefinitions { locations: CodeLocation[]; }
/** Lines that use a symbol; `complete` is false when the search stopped at its limit or time budget. */
export interface CodeReferences { locations: CodeLocation[]; complete: boolean; }
/**
 * One uploaded attachment. Image dimensions are captured at upload time so a transcript can size
 * its thumbnail before the bytes arrive: without them an unloaded `<img>` has no intrinsic size
 * and the message would collapse to nothing, then jump once the image decodes.
 */
export interface Attachment { id: string; name: string; mimeType: string; size: number; path: string; width?: number; height?: number; }
