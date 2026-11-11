import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalThemesJson, MAX_THEME_LIBRARY_BYTES, validateCustomThemes, validateThemeLibrary,
  type CustomTheme, type ThemeLibrary, type ThemeLibraryUpdate,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';

/**
 * The contract measures compact JSON, but the file is written pretty-printed for hand editing,
 * which roughly doubles it. Leave room for that before calling a file "not a library we wrote";
 * the parsed document is still validated against the compact limit.
 */
const MAX_FILE_BYTES = MAX_THEME_LIBRARY_BYTES * 3 + 4 * 1024;

/**
 * The shared theme library: every device sees the same custom themes, while which theme *this*
 * device shows stays a local preference.
 *
 * It lives in its own `themes.json` rather than in `settings.json`. Settings are a strict-whitelist
 * document copied on every request, and an older server would reject a key it does not know; the
 * theme library is larger, has its own revision semantics, and is read by three clients.
 *
 * `revision` is a content hash, not a counter: retrying the same save is idempotent even after a
 * network failure, and two clients editing at once produce a deterministic conflict instead of a
 * last-writer-wins merge nobody asked for.
 */
export class ThemeService {
  private readonly file: string;
  /** Writes are serialized so two concurrent PUTs cannot interleave their read-modify-write. */
  private queue: Promise<unknown> = Promise.resolve();
  private cached?: { stamp: string; library: ThemeLibrary };

  constructor(options: { stateDir: string }) {
    if (!options?.stateDir || !path.isAbsolute(options.stateDir)) throw new AppError('INVALID_STATE_DIR', 'stateDir must be an absolute path');
    this.file = path.join(path.resolve(options.stateDir), 'themes.json');
  }

  getLibrary(): ThemeLibrary {
    return structuredClone(this.load());
  }

  async replaceLibrary(input: ThemeLibraryUpdate): Promise<ThemeLibrary> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INVALID_THEMES', 'Theme library update must be an object');
    if (typeof input.expectedRevision !== 'string' || !input.expectedRevision) throw new AppError('INVALID_THEMES', 'expectedRevision is required');
    const checked = validateCustomThemes((input as { themes?: unknown }).themes);
    if (checked.issues.length) {
      throw new AppError('INVALID_THEMES', checked.issues[0]!.message, 400, { issues: checked.issues.slice(0, 50) });
    }
    const revision = themeLibraryRevision(checked.themes);
    const replace = this.queue.then(() => {
      const current = this.load();
      // The stored library already is this content: a retry after an ambiguous response succeeds.
      if (current.revision === revision) return current;
      if (current.revision !== input.expectedRevision) {
        throw new AppError('THEME_CONFLICT', 'The theme library changed since it was read', 409, { revision: current.revision });
      }
      const library: ThemeLibrary = { version: 1, revision, themes: checked.themes };
      this.write(library);
      return library;
    });
    this.queue = replace.catch(() => undefined);
    return replace;
  }

  private stamp(): string {
    try {
      const info = statSync(this.file);
      return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    } catch {
      return 'absent';
    }
  }

  private load(): ThemeLibrary {
    const stamp = this.stamp();
    if (this.cached?.stamp === stamp) return this.cached.library;
    const library = this.read();
    this.cached = { stamp, library };
    return library;
  }

  private read(): ThemeLibrary {
    let text: string;
    try {
      const info = statSync(this.file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw corrupt();
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLibrary();
      if (error instanceof AppError) throw error;
      throw new AppError('THEME_STORAGE_UNAVAILABLE', 'Theme library could not be read', 500);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw corrupt(); }
    const validated = validateThemeLibrary(parsed);
    if (!validated.library) throw corrupt(validated.issues.map(issue => `${issue.path || 'themes'} ${issue.message}`).slice(0, 20));
    // The revision is derived from content, so a hand-edited file cannot claim a revision its themes
    // do not have. Corruption is reported rather than overwritten: the file may be the only copy.
    return { version: 1, revision: themeLibraryRevision(validated.library.themes), themes: validated.library.themes };
  }

  private write(library: ThemeLibrary): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(library, null, 2) + '\n');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
    } catch {
      if (fd !== undefined) try { closeSync(fd); } catch { /* close after a failed write */ }
      try { unlinkSync(temp); } catch { /* the temp file may not exist */ }
      throw new AppError('THEME_WRITE_FAILED', 'Theme library could not be saved', 500);
    }
    // The next read must come from disk, not from the snapshot the failed or replaced write saw.
    this.cached = undefined;
  }
}

/** `sha256` of the canonical document, truncated to a revision-sized token. */
export function themeLibraryRevision(themes: CustomTheme[]): string {
  return createHash('sha256').update(canonicalThemesJson(themes)).digest('hex').slice(0, 32);
}

function emptyLibrary(): ThemeLibrary {
  return { version: 1, revision: themeLibraryRevision([]), themes: [] };
}

function corrupt(issues?: string[]): AppError {
  return new AppError('THEME_STORAGE_CORRUPT', 'Theme library file is invalid', 500, issues?.length ? { issues } : undefined);
}
