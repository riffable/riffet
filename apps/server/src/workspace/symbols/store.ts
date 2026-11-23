import type { DatabaseSync } from 'node:sqlite';
import type { CodeSymbolKind } from '../../../../../packages/contracts/src/index.js';
import { openSqliteDatabase } from '../../sqlite-storage.js';

/** Bumped when the tables or what is extracted into them change; an index of another version is dropped and rebuilt. */
const SCHEMA_VERSION = 8;

/** Files per posting chunk are `1 << CHUNK_BITS`; `parse-worker.mjs` writes with the same value. */
export const CHUNK_BITS = 8;
/** Identifiers shorter than this, and keywords, are not in the word index: a search for one of them cannot use it. Handed to the workers (`indexes.ts`), so there is one list. */
export const WORD_MIN_LENGTH = 3;
export const WORD_STOP: readonly string[] = [
  'abstract', 'annotation', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'companion', 'const', 'constructor', 'continue', 'data', 'default', 'double', 'else', 'enum',
  'extends', 'false', 'final', 'finally', 'float', 'for', 'fun', 'get', 'goto', 'implements', 'import', 'init', 'inner', 'instanceof', 'int', 'interface', 'internal', 'lateinit', 'long', 'native',
  'new', 'null', 'object', 'open', 'out', 'override', 'package', 'private', 'protected', 'public', 'return', 'sealed', 'set', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized',
  'this', 'throw', 'throws', 'transient', 'true', 'try', 'typealias', 'val', 'var', 'void', 'volatile', 'when', 'where', 'while',
];
const STOP = new Set(WORD_STOP);
/** Whether `word` is in the word index at all. */
export const isIndexedWord = (word: string): boolean => word.length >= WORD_MIN_LENGTH && !STOP.has(word);
/**
 * A word's 31-bit key in the postings (FNV-1a of the lower-cased word, so one lookup serves case-sensitive and
 * case-insensitive searches); `parse-worker.mjs` computes the same. Words sharing a key only add false candidates.
 */
export function wordHash(name: string): number {
  const word = name.toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < word.length; index++) hash = Math.imul(hash ^ word.charCodeAt(index), 0x01000193);
  return hash & 0x7fffffff;
}
const SOURCE_FILE = /\.(?:kt|kts|java)$/;

export const TYPE_KINDS: readonly CodeSymbolKind[] = ['class', 'interface', 'object', 'enum', 'annotation', 'typealias'];
const TYPE_LIST = TYPE_KINDS.map(kind => `'${kind}'`).join(',');
export const isTypeKind = (kind: string): boolean => (TYPE_KINDS as readonly string[]).includes(kind);

export interface ParsedSymbol { name: string; kind: CodeSymbolKind; container?: string; line: number; column: number; depth: number }
export interface ParsedFile { path: string; package?: string; imports?: string[]; symbols?: ParsedSymbol[]; failed?: boolean; skipped?: boolean }
export interface SymbolRow { name: string; kind: CodeSymbolKind; container: string | null; path: string; line: number; column: number; initials?: string }
export interface Declaration extends SymbolRow { package: string }

/** The first string after every string that starts with `prefix`, for a range scan over an index. */
const after = (prefix: string): string => `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;

/**
 * One project's index file, as the main thread sees it: the tables, and the reads behind searches and
 * navigation. Rows are written only by the parse workers (`parse-worker.mjs`), which also keep the
 * declaration total in `meta`, so nothing of a build's millions of rows passes through the event loop.
 */
export class SymbolStore {
  private readonly db: DatabaseSync;

  constructor(readonly file: string) {
    this.db = openSqliteDatabase(file, { timeout: 5000 });
    // A cache a rebuild replaces: no fsync per commit. Checkpoints run on whichever connection commits, which is a worker's.
    this.db.exec('PRAGMA synchronous=OFF');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version !== SCHEMA_VERSION) {
      this.db.exec('DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS imports; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS type_words; DROP TABLE IF EXISTS postings; DROP TABLE IF EXISTS resources;');
    }
    // Paths are stored once, in `files`: a monorepo has millions of declarations and imports, and a path
    // repeated on each would make the file several times the size of the source it indexes.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, mtimeMs REAL NOT NULL, package TEXT NOT NULL DEFAULT '', bad INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS files_unread ON files(id) WHERE unread=1;
      CREATE INDEX IF NOT EXISTS files_package ON files(package);
      CREATE TABLE IF NOT EXISTS symbols (file INTEGER NOT NULL, name TEXT NOT NULL, lower_name TEXT NOT NULL, initials TEXT NOT NULL, kind TEXT NOT NULL, container TEXT, line INTEGER NOT NULL, column INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS symbols_lower ON symbols(lower_name);
      CREATE INDEX IF NOT EXISTS symbols_initials ON symbols(initials);
      CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file);
      CREATE TABLE IF NOT EXISTS imports (file INTEGER NOT NULL, fqn TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS imports_file ON imports(file);
      CREATE INDEX IF NOT EXISTS imports_fqn ON imports(fqn);
      CREATE TABLE IF NOT EXISTS type_words (word TEXT NOT NULL, symbol INTEGER NOT NULL, file INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS type_words_word ON type_words(word);
      CREATE INDEX IF NOT EXISTS type_words_file ON type_words(file);
      CREATE TABLE IF NOT EXISTS postings (chunk INTEGER NOT NULL, word INTEGER NOT NULL, bits BLOB NOT NULL, PRIMARY KEY (chunk, word, bits)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS resources (type TEXT NOT NULL, name TEXT NOT NULL, file INTEGER NOT NULL, line INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS resources_name ON resources(type, name);
      CREATE INDEX IF NOT EXISTS resources_file ON resources(file);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta(key,value) VALUES('symbols','0');
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
  }

  meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  /** The declaration total, kept in `meta` by the workers that write rows: counting four million rows costs seconds. */
  counts(): { files: number; symbols: number; bad: number } {
    const files = this.db.prepare('SELECT count(*) AS n, coalesce(sum(bad),0) AS bad FROM files').get() as { n: number; bad: number };
    return { files: files.n, symbols: Number(this.meta('symbols') ?? 0), bad: files.bad };
  }

  /** Candidate rows for a lower-case query, by tier: the name itself, names it starts, names whose initials it starts, type names with a later word it starts. */
  candidates(lower: string, types: boolean, limit: number, want: number): { exact: SymbolRow[]; prefix: SymbolRow[]; initials: SymbolRow[]; contains: SymbolRow[] } {
    const from = 'FROM symbols s JOIN files f ON f.id=s.file';
    const columns = 's.name AS name,s.kind AS kind,s.container AS container,f.path AS path,s.line AS line,s.column AS column,s.initials AS initials';
    const kinds = types ? ` AND s.kind IN (${TYPE_LIST})` : '';
    const read = (sql: string, ...args: Array<string | number>) => this.db.prepare(sql).all(...args) as unknown as SymbolRow[];
    const exact = read(`SELECT ${columns} ${from} WHERE s.lower_name=?${kinds} LIMIT ?`, lower, limit);
    const prefix = read(`SELECT ${columns} ${from} WHERE s.lower_name>=? AND s.lower_name<?${kinds} LIMIT ?`, lower, after(lower), limit);
    const initials = /^[a-z0-9$]+$/.test(lower) && lower.length > 1 ? read(`SELECT ${columns} ${from} WHERE s.initials>=? AND s.initials<?${kinds} LIMIT ?`, lower, after(lower), limit) : [];
    // A later word of a type name (`fragment` in `FeedFragment`), read from the word table rather than by scanning
    // millions of names on the event loop; members are found by their start only. Only while the other tiers left room.
    const room = want - exact.length - prefix.length - initials.length;
    const contains = room > 0 && lower.length > 1 ? read(`SELECT ${columns} FROM type_words w JOIN symbols s ON s.rowid=w.symbol JOIN files f ON f.id=s.file WHERE w.word>=? AND w.word<? LIMIT ?`, lower, after(lower), limit) : [];
    return { exact, prefix, initials, contains };
  }

  packageOf(path: string): string | undefined {
    return (this.db.prepare('SELECT package FROM files WHERE path=?').get(path) as { package: string } | undefined)?.package || undefined;
  }

  /** Declarations named exactly `name` (case-sensitive), constructors left out. */
  declarations(name: string, limit: number): Declaration[] {
    return this.db.prepare(`SELECT s.name AS name,s.kind AS kind,s.container AS container,f.path AS path,s.line AS line,s.column AS column,f.package AS package
      FROM symbols s JOIN files f ON f.id=s.file WHERE s.lower_name=? AND s.name=? AND s.kind<>'constructor' LIMIT ?`).all(name.toLowerCase(), name, limit) as unknown as Declaration[];
  }

  /**
   * Source files that may contain `word`, from the word index: the files whose postings hold it, plus every
   * file whose words were not read (too large, unreadable). A superset, never short of a file the index has
   * seen. `within` limits it to a directory. `undefined` when the word is not indexed or there are more than
   * `limit` files: the caller scans the project instead.
   *
   * Postings are keyed by chunk first, so a batch of files is written next to each other; the price is that a
   * word is probed in every chunk (about one per 256 files, a few milliseconds for the biggest monorepo).
   */
  wordFiles(word: string, within: string, limit: number): string[] | undefined {
    if (!isIndexedWord(word)) return undefined;
    const hash = wordHash(word);
    const top = Number((this.db.prepare('SELECT coalesce(max(id),0) AS n FROM files').get() as { n: number }).n);
    const ids = new Set<number>();
    const probe = this.db.prepare('SELECT bits FROM postings WHERE chunk=? AND word=?');
    for (let chunk = 0; chunk <= top >> CHUNK_BITS; chunk++) {
      for (const row of probe.all(chunk, hash) as Array<{ bits: Uint8Array }>) {
        const base = chunk << CHUNK_BITS;
        const bits = row.bits;
        if (bits.length === 1 << (CHUNK_BITS - 3)) { for (let at = 0; at < bits.length; at++) for (let bit = 0, byte = bits[at]!; byte; bit++, byte >>= 1) if (byte & 1) ids.add(base + at * 8 + bit); }
        else for (const offset of bits) ids.add(base + offset);
      }
    }
    for (const row of this.db.prepare('SELECT id FROM files WHERE unread=1').all() as Array<{ id: number }>) ids.add(row.id);
    let among = ids;
    if (within) {
      among = new Set();
      const prefix = `${within}/`;
      for (const row of this.db.prepare('SELECT id FROM files WHERE path>=? AND path<?').all(prefix, after(prefix)) as Array<{ id: number }>) if (ids.has(row.id)) among.add(row.id);
    }
    if (among.size > limit) return undefined;
    const path = this.db.prepare('SELECT path FROM files WHERE id=?');
    const found: string[] = [];
    for (const id of among) { const row = path.get(id) as { path: string } | undefined; if (row && SOURCE_FILE.test(row.path)) found.push(row.path); }
    return found;
  }

  /** Where Android resource `type` / `name` (the name as `R` spells it) is defined, in every resource directory that has it. */
  resources(type: string, name: string, limit: number): Array<{ path: string; line: number }> {
    return this.db.prepare('SELECT f.path AS path, r.line AS line FROM resources r JOIN files f ON f.id=r.file WHERE r.type=? AND r.name=? LIMIT ?').all(type, name, limit) as unknown as Array<{ path: string; line: number }>;
  }

  /** Statistics are gathered by a worker after each build (`optimize` task), not here on the event loop. */
  close(): void {
    this.db.close();
  }
}
