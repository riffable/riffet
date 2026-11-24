// Parses Kotlin and Java files into their declarations for the code index (symbols/indexes.ts), and
// writes them into the project's index file itself. It runs as a child process (symbols/pool.ts) because
// tree-sitter's WebAssembly heap grows with every file it has seen and never shrinks, and because a
// monorepo's index is millions of rows: comparing, parsing and writing here keeps the rows, SQLite's
// commits and checkpoints off the server's event loop, which only hands out lists of paths and reads
// counts back, and an exit gives every byte back. Plain JavaScript, so the source tree and the built
// `dist/` run the same file without the server's loader. The tables are created by the main thread
// (store.ts#SymbolStore) before any task names the file.
import { createRequire } from 'node:module';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Run by `pool.ts` as a child process: tasks arrive over IPC, what they share in the environment.
const { treeSitter, grammars, fileBytes, wordMinLength, wordStop, chunkBits } = JSON.parse(process.env.RIFFET_PARSE_WORKER_DATA ?? '{}');
const SOURCE = /\.(?:kt|kts|java)$/;
const reply = (message) => process.send?.(message);
// The server went away (crashed or was killed): nothing is left to answer, and an orphan would keep its memory.
process.on('disconnect', () => process.exit(0));
const { Parser, Language } = createRequire(import.meta.url)(treeSitter);

let parsers;
async function load() {
  await Parser.init();
  const make = async (wasm) => { const parser = new Parser(); parser.setLanguage(await Language.load(wasm)); return parser; };
  return { kotlin: await make(grammars.kotlin), java: await make(grammars.java) };
}

const NAMES = new Set(['identifier', 'type_identifier', 'simple_identifier']);
const child = (node, ...types) => node.namedChildren.find(item => types.includes(item.type));
/** The first named child that is a plain name; a recovered parse can leave an empty one in its place. */
const nameOf = (node) => node.namedChildren.find(item => NAMES.has(item.type) && item.text);
const keywords = (node) => node.children.filter(item => !item.isNamed).map(item => item.type);

// ── Kotlin ───────────────────────────────────────────────────────────────────

function kotlinKind(node) {
  const words = keywords(node);
  if (words.includes('interface')) return 'interface';
  const modifiers = child(node, 'modifiers')?.text ?? '';
  if (/\benum\b/.test(modifiers)) return 'enum';
  if (/\bannotation\b/.test(modifiers)) return 'annotation';
  return 'class';
}

/** `fun Receiver.name()` parses the receiver and the name into one user_type when recovery kicks in. */
function kotlinFunctionName(node) {
  const direct = nameOf(node);
  if (direct) return direct;
  const type = child(node, 'user_type');
  return type ? [...type.namedChildren].reverse().find(item => NAMES.has(item.type) && item.text) : undefined;
}

function kotlinBody(node, depth, container, out) {
  for (const member of node.namedChildren) {
    switch (member.type) {
      case 'class_declaration': {
        const name = nameOf(member);
        if (!name) break;
        out.push(entry(name, kotlinKind(member), container, depth, undefined, member));
        for (const part of member.namedChildren) {
          if (part.type === 'class_body' || part.type === 'enum_class_body') kotlinBody(part, depth + 1, name.text, out);
          else if (part.type === 'primary_constructor') kotlinParameters(part, depth + 1, name.text, out);
        }
        break;
      }
      case 'object_declaration':
      case 'companion_object': {
        const name = nameOf(member);
        const label = name?.text ?? 'Companion';
        out.push(entry(name ?? member, 'object', container, depth, label, member));
        const body = child(member, 'class_body');
        if (body) kotlinBody(body, depth + 1, label, out);
        break;
      }
      case 'function_declaration': {
        const name = kotlinFunctionName(member);
        if (name) out.push(entry(name, 'function', container, depth, undefined, member));
        break;
      }
      case 'property_declaration':
        for (const part of member.namedChildren) {
          if (part.type === 'variable_declaration') { const name = nameOf(part); if (name) out.push(entry(name, 'property', container, depth)); }
          else if (part.type === 'multi_variable_declaration') for (const each of part.namedChildren) { const name = each.type === 'variable_declaration' ? nameOf(each) : undefined; if (name) out.push(entry(name, 'property', container, depth)); }
        }
        break;
      case 'type_alias': {
        const name = nameOf(member);
        if (name) out.push(entry(name, 'typealias', container, depth));
        break;
      }
      case 'secondary_constructor':
        if (container) out.push(entry(member, 'constructor', container, depth, container, member));
        break;
      case 'enum_entry': {
        const name = nameOf(member);
        if (name) out.push(entry(name, 'property', container, depth));
        const body = child(member, 'class_body');
        if (body) kotlinBody(body, depth + 1, name?.text ?? container, out);
        break;
      }
      default:
    }
  }
}

/** `class A(val x: Int)` declares the property x. */
function kotlinParameters(node, depth, container, out) {
  const list = child(node, 'class_parameters');
  for (const parameter of list?.namedChildren ?? []) {
    if (parameter.type !== 'class_parameter' || !keywords(parameter).some(word => word === 'val' || word === 'var')) continue;
    const name = nameOf(parameter);
    if (name) out.push(entry(name, 'property', container, depth));
  }
}

function kotlinFile(root) {
  let pkg = '';
  const imports = [];
  const symbols = [];
  for (const node of root.namedChildren) {
    if (node.type === 'package_header') pkg = child(node, 'qualified_identifier', 'identifier')?.text ?? '';
    else if (node.type === 'import') {
      const name = child(node, 'qualified_identifier', 'identifier')?.text;
      if (name) imports.push(keywords(node).includes('*') ? `${name}.*` : name);
    }
  }
  kotlinBody(root, 0, undefined, symbols);
  return { package: pkg, imports, symbols };
}

// ── Java ─────────────────────────────────────────────────────────────────────

const JAVA_TYPES = { class_declaration: 'class', interface_declaration: 'interface', enum_declaration: 'enum', record_declaration: 'class', annotation_type_declaration: 'annotation' };

/** Java names the declaration in its `name` field: the first identifier of a method is its return type (`View onCreateView()`). */
const javaName = (node) => node.childForFieldName('name') ?? nameOf(node);

function javaBody(node, depth, container, out) {
  for (const member of node.namedChildren) {
    const kind = JAVA_TYPES[member.type];
    if (kind) {
      const name = javaName(member);
      if (!name) continue;
      out.push(entry(name, kind, container, depth, undefined, member));
      for (const part of member.namedChildren) if (/_body$/.test(part.type)) javaBody(part, depth + 1, name.text, out);
      continue;
    }
    switch (member.type) {
      case 'method_declaration':
      case 'annotation_type_element_declaration': {
        const name = javaName(member);
        if (name) out.push(entry(name, 'function', container, depth, undefined, member));
        break;
      }
      case 'constructor_declaration':
      case 'compact_constructor_declaration': {
        const name = javaName(member);
        if (name) out.push(entry(name, 'constructor', container, depth, undefined, member));
        break;
      }
      case 'field_declaration':
      case 'constant_declaration':
        for (const part of member.namedChildren) if (part.type === 'variable_declarator') { const name = javaName(part); if (name) out.push(entry(name, 'property', container, depth)); }
        break;
      case 'enum_constant': {
        const name = javaName(member);
        if (name) out.push(entry(name, 'property', container, depth));
        break;
      }
      case 'enum_body_declarations':
        javaBody(member, depth, container, out);
        break;
      default:
    }
  }
}

function javaFile(root) {
  let pkg = '';
  const imports = [];
  const symbols = [];
  for (const node of root.namedChildren) {
    if (node.type === 'package_declaration') pkg = child(node, 'scoped_identifier', 'identifier')?.text ?? '';
    else if (node.type === 'import_declaration') {
      const name = child(node, 'scoped_identifier', 'identifier')?.text;
      if (name) imports.push(node.namedChildren.some(item => item.type === 'asterisk') ? `${name}.*` : name);
    }
  }
  javaBody(root, 0, undefined, symbols);
  return { package: pkg, imports, symbols };
}

/** `span` is the whole declaration, for a type or a function: an outline marks the one a line falls in by where it ends. */
function entry(at, kind, container, depth, name = at.text, span) {
  const position = at.startPosition;
  const end = span ? span.endPosition.row + 1 : undefined;
  return { name, kind, ...(container ? { container } : {}), line: position.row + 1, column: position.column + 1, depth, ...(end && end > position.row + 1 ? { end } : {}) };
}

// ── Words ────────────────────────────────────────────────────────────────────

const stopWords = new Set(wordStop);
/** Same function as `store.ts#wordHash`: the key a search looks a word up by. */
function wordHash(name) {
  const word = name.toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < word.length; index++) hash = Math.imul(hash ^ word.charCodeAt(index), 0x01000193);
  return hash & 0x7fffffff;
}
/** The keys of the identifiers in `text`, comments and strings included: a search narrowed by them may read a file for nothing, never miss one. */
function wordsOf(text) {
  const found = new Set();
  for (const token of new Set(text.match(/[A-Za-z_$][\w$]*/g))) {
    // `"$name"` of a Kotlin template and `Outer$Inner` hold words that a search (ripgrep's -w too) finds on their own.
    for (const word of token.includes('$') ? [token, ...token.split('$')] : [token]) if (word.length >= wordMinLength && !stopWords.has(word)) found.add(wordHash(word));
  }
  return found;
}

// ── Android resources ────────────────────────────────────────────────────────

/** `res/<directory>/<file>`: deeper paths are not resources. */
const RESOURCE_PATH = /(?:^|\/)res\/([^/]+)\/([^/.][^/]*)$/;
const VALUE_TYPES = { string: 'string', color: 'color', dimen: 'dimen', style: 'style', integer: 'integer', bool: 'bool', array: 'array', 'string-array': 'array', 'integer-array': 'array', plurals: 'plurals', attr: 'attr', 'declare-styleable': 'styleable', drawable: 'drawable', fraction: 'fraction', item: undefined };
/** Elements whose children are not resources of their own (`<item>` of a style, an array, plurals). */
const CONTAINERS = new Set(['style', 'array', 'string-array', 'integer-array', 'plurals', 'declare-styleable']);
/** The name as `R` spells it: `Theme.App` is `Theme_App`, `android:textSize` is `android_textSize`. */
const rName = (name) => name.replace(/[.:]/g, '_');

/** Resources an `.xml` under `res/` defines: the `values` elements, and every `@+id/x` anywhere. Line by line, no XML parser. */
function xmlResources(text, values, add) {
  let comment = false;
  let container;
  let styleable = '';
  let pending;
  const finish = (tag, attrs, line) => {
    const selfClosing = /\/\s*$/.test(attrs);
    const name = /\bname\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    if (container === 'declare-styleable') {
      if (tag === 'attr' && name) {
        add('styleable', `${styleable}_${rName(name)}`, line);
        if (/\bformat\s*=/.test(attrs) && !name.includes(':')) add('attr', rName(name), line);
      }
      return;
    }
    if (container || !(tag in VALUE_TYPES) || !name) return;
    const type = tag === 'item' ? /\btype\s*=\s*"([\w-]+)"/.exec(attrs)?.[1] : VALUE_TYPES[tag];
    if (type) add(type, rName(name), line);
    if (CONTAINERS.has(tag) && !selfClosing) { container = tag; styleable = rName(name); }
  };
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    if (comment) { const end = line.indexOf('-->'); if (end < 0) continue; line = line.slice(end + 3); comment = false; }
    line = line.replace(/<!--.*?-->/g, '');
    const open = line.indexOf('<!--');
    if (open >= 0) { comment = true; line = line.slice(0, open); }
    for (const m of line.matchAll(/@\+id\/([\w.]+)/g)) add('id', rName(m[1]), index + 1);
    if (!values) continue;
    // A start tag may continue on the next lines until its `>`.
    if (pending) {
      const end = line.indexOf('>');
      pending.attrs += ` ${end < 0 ? line : line.slice(0, end)}`;
      if (end < 0) continue;
      finish(pending.tag, pending.attrs, pending.line);
      pending = undefined;
      line = line.slice(end + 1);
    }
    for (const m of line.matchAll(/<(\/)?([\w-]+)([^>]*)(>?)/g)) {
      if (m[1]) { if (m[2] === container) container = undefined; continue; }
      if (m[4]) finish(m[2], m[3], index + 1); else pending = { tag: m[2], attrs: m[3], line: index + 1 };
    }
  }
}

/** The resources one file under `res/` defines: its own name unless it is in `values`, and what an `.xml` in it declares. */
function resourcesOf(root, file) {
  const m = RESOURCE_PATH.exec(file);
  if (!m) return [];
  const type = m[1].split('-')[0];
  const found = new Map();
  const add = (kind, name, line) => { const key = `${kind}\0${name}`; if (!found.has(key)) found.set(key, { type: kind, name, line }); };
  if (type !== 'values') add(type, m[2].split('.')[0], 1);
  if (m[2].endsWith('.xml')) {
    try {
      const absolute = join(root, file);
      if (statSync(absolute).size <= fileBytes) xmlResources(readFileSync(absolute, 'utf8'), type === 'values', add);
    } catch { /* unreadable: the file's own name still counts */ }
  }
  return [...found.values()];
}

// ── Tasks ────────────────────────────────────────────────────────────────────

async function parseFile(root, file, withWords = false) {
  const absolute = join(root, file);
  let data;
  try {
    const info = statSync(absolute);
    if (!info.isFile() || info.size > fileBytes) return { path: file, skipped: true };
    data = readFileSync(absolute);
  } catch { return { path: file, skipped: true }; }
  if (data.subarray(0, 8000).includes(0)) return { path: file, skipped: true };
  parsers ??= await load();
  const text = data.toString('utf8');
  const words = withWords ? wordsOf(text) : undefined;
  const tree = (file.endsWith('.java') ? parsers.java : parsers.kotlin).parse(text);
  if (!tree) return { path: file, failed: true, words };
  try {
    const result = file.endsWith('.java') ? javaFile(tree.rootNode) : kotlinFile(tree.rootNode);
    return { path: file, ...result, failed: tree.rootNode.hasError, words };
  } finally { tree.delete(); }
}

// ── The index file ───────────────────────────────────────────────────────────

const isUpper = (code) => code >= 65 && code <= 90;
const isLower = (code) => code >= 97 && code <= 122;
const isDigit = (code) => code >= 48 && code <= 57;
const isSeparator = (code) => code === 47 || code === 95 || code === 45 || code === 46 || code === 32;
/** Lower-case first letters of a name's words (`FeedFragment` is `ff`), as `file-index.ts#wordStarts` splits words. */
function initialsOf(name) {
  let initials = '';
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    const previous = index ? name.charCodeAt(index - 1) : -1;
    const start = index === 0 || isSeparator(previous) || (isUpper(code) && (isLower(previous) || isDigit(previous))) || (isDigit(code) && !isDigit(previous));
    if (start && /[A-Za-z0-9$]/.test(name[index])) initials += name[index].toLowerCase();
  }
  return initials;
}

const TYPE_KINDS = new Set(['class', 'interface', 'object', 'enum', 'annotation', 'typealias']);
/** The lower-case tails of a name from each later word start (`FeedFragment` gives `fragment`), so a search for the middle of a type name is a range read. */
function laterWords(name) {
  const tails = [];
  for (let index = 1; index < name.length; index++) {
    const code = name.charCodeAt(index);
    const previous = name.charCodeAt(index - 1);
    if (isSeparator(previous) || (isUpper(code) && (isLower(previous) || isDigit(previous))) || (isDigit(code) && !isDigit(previous))) tails.push(name.slice(index).toLowerCase());
  }
  return tails;
}

let open;
/** One connection per worker, to the index file the last task named. */
function database(file) {
  if (open?.file === file) return open;
  open?.db.close();
  // Other workers write the same file: a writer waits its turn rather than failing. The file is a cache
  // a rebuild replaces, so commits are not synced.
  const db = new DatabaseSync(file, { timeout: 120_000 });
  db.exec('PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY');
  open = {
    file, db,
    stamp: db.prepare('SELECT size, mtimeMs FROM files WHERE path=?'),
    putFile: db.prepare('INSERT INTO files(path,size,mtimeMs,package,bad,unread) VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtimeMs=excluded.mtimeMs,package=excluded.package,bad=excluded.bad,unread=excluded.unread RETURNING id'),
    dropResources: db.prepare('DELETE FROM resources WHERE file=?'),
    putResource: db.prepare('INSERT INTO resources(type,name,file,line) VALUES(?,?,?,?)'),
    putPosting: db.prepare('INSERT OR IGNORE INTO postings(chunk,word,bits) VALUES(?,?,?)'),
    dropSymbols: db.prepare('DELETE FROM symbols WHERE file=?'),
    dropImports: db.prepare('DELETE FROM imports WHERE file=?'),
    dropWords: db.prepare('DELETE FROM type_words WHERE file=?'),
    putWord: db.prepare('INSERT INTO type_words(word,symbol,file) VALUES(?,?,?)'),
    putSymbol: db.prepare('INSERT INTO symbols(file,name,lower_name,initials,kind,container,line,column) VALUES(?,?,?,?,?,?,?,?)'),
    putImport: db.prepare('INSERT INTO imports(file,fqn) VALUES(?,?)'),
    addTotal: db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+? WHERE key='symbols'"),
    total: db.prepare("SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key='symbols'"),
  };
  return open;
}

/** Runs `work` in one write transaction; `BEGIN IMMEDIATE` takes the write lock first, so the read-then-write of the total cannot interleave with another worker's. */
function writing(index, work) {
  index.db.exec('BEGIN IMMEDIATE');
  try { const result = work(); index.db.exec('COMMIT'); return result; } catch (error) { index.db.exec('ROLLBACK'); throw error; }
}

/** Files whose size or modification time differ from what the index holds, or all of them when `force`. */
function changedOf(index, root, files, force) {
  const changed = [];
  for (const file of files) {
    let info;
    try { info = lstatSync(join(root, file)); } catch { continue; }
    // A link is not read through: it may point outside the project.
    if (!info.isFile()) continue;
    const had = force ? undefined : index.stamp.get(file);
    if (!had || had.size !== info.size || had.mtimeMs !== info.mtimeMs) changed.push({ file, size: info.size, mtimeMs: info.mtimeMs });
  }
  return changed;
}

async function indexFiles(task) {
  const index = database(task.db);
  const changed = changedOf(index, task.root, task.files, task.force);
  const parsed = [];
  for (const item of changed) {
    // `markBad`: a file that took a worker down with it is recorded unparsed, so the next build does not retry it until it changes.
    if (task.markBad) { parsed.push({ ...item, result: { path: item.file, failed: true } }); continue; }
    if (!SOURCE.test(item.file)) { parsed.push({ ...item, result: { path: item.file }, resources: resourcesOf(task.root, item.file) }); continue; }
    try { parsed.push({ ...item, result: await parseFile(task.root, item.file, true) }); } catch { parsed.push({ ...item, result: { path: item.file, failed: true } }); }
  }
  const postings = new Map();
  const total = writing(index, () => {
    let delta = 0;
    for (const { size, mtimeMs, result, resources } of parsed) {
      // A source file whose words were not read (too large, unreadable, a worker died on it) is a candidate of every word search.
      const unread = SOURCE.test(result.path) && !result.words ? 1 : 0;
      const id = Number(index.putFile.get(result.path, size, mtimeMs, result.package ?? '', result.failed ? 1 : 0, unread).id);
      index.dropResources.run(id);
      for (const resource of resources ?? []) index.putResource.run(resource.type, resource.name, id, resource.line);
      // Words are only added: what a changed file no longer says stays in its chunk as a false candidate, until a full rebuild.
      for (const word of result.words ?? []) {
        const key = (id >> chunkBits) * 2 ** 31 + word;
        const offset = id & ((1 << chunkBits) - 1);
        const offsets = postings.get(key);
        if (offsets) offsets.push(offset); else postings.set(key, [offset]);
      }
      delta -= Number(index.dropSymbols.run(id).changes);
      index.dropImports.run(id);
      index.dropWords.run(id);
      for (const symbol of result.symbols ?? []) {
        const row = index.putSymbol.run(id, symbol.name, symbol.name.toLowerCase(), initialsOf(symbol.name), symbol.kind, symbol.container ?? null, symbol.line, symbol.column).lastInsertRowid;
        if (TYPE_KINDS.has(symbol.kind)) for (const word of laterWords(symbol.name)) index.putWord.run(word, row, id);
        delta++;
      }
      for (const fqn of new Set(result.imports ?? [])) index.putImport.run(id, fqn);
    }
    // Sorted by chunk: the rows of a batch land next to each other in the table.
    for (const key of [...postings.keys()].sort((a, b) => a - b)) {
      const offsets = postings.get(key);
      const chunk = Math.floor(key / 2 ** 31);
      // A list of one-byte offsets, or the chunk's bitmap once the list would be as long; the two are told apart by length.
      let bits;
      if (offsets.length < (1 << chunkBits) / 8) bits = Uint8Array.from(offsets.sort((a, b) => a - b));
      else { bits = new Uint8Array((1 << chunkBits) / 8); for (const offset of offsets) bits[offset >> 3] |= 1 << (offset & 7); }
      index.putPosting.run(chunk, key - chunk * 2 ** 31, bits);
    }
    if (delta) index.addTotal.run(delta);
    return Number(index.total.get()?.n ?? 0);
  });
  return { checked: task.files.length, changed: changed.length, symbols: total };
}

/** Drops what the index holds for files no longer in the project. */
function sweep(task) {
  const index = database(task.db);
  // A full rebuild starts the word index over; until each file is read again it counts as unread, so a search made meanwhile (or after a stop) reads it instead.
  if (task.reset) writing(index, () => { index.db.exec('DELETE FROM postings; UPDATE files SET unread=1, size=-1'); });
  const present = new Set(task.present);
  const gone = [];
  for (const row of index.db.prepare('SELECT id, path FROM files').iterate()) if (!present.has(row.path)) gone.push(row.id);
  if (!gone.length) return { removed: 0 };
  const dropFile = index.db.prepare('DELETE FROM files WHERE id=?');
  writing(index, () => {
    let delta = 0;
    for (const id of gone) { delta -= Number(index.dropSymbols.run(id).changes); index.dropImports.run(id); index.dropWords.run(id); index.dropResources.run(id); dropFile.run(id); }
    if (delta) index.addTotal.run(delta);
  });
  return { removed: gone.length };
}

process.on('message', async (task) => {
  try {
    if (task.type === 'index') { reply({ id: task.id, ...(await indexFiles(task)) }); return; }
    if (task.type === 'sweep') { reply({ id: task.id, ...sweep(task) }); return; }
    // After a build: the planner's statistics, which on a fresh index of millions of rows take most of a second to gather.
    if (task.type === 'optimize') { database(task.db).db.exec('PRAGMA optimize=0x10002'); reply({ id: task.id }); return; }
    // `parse`: one file's declarations returned, not written, for an outline.
    const results = [];
    for (const file of task.files) {
      try { results.push(await parseFile(task.root, file)); } catch { results.push({ path: file, failed: true, symbols: [], imports: [] }); }
    }
    reply({ id: task.id, results });
  } catch (error) {
    reply({ id: task.id, error: String(error?.message ?? error) });
  }
});

process.on('exit', () => { try { open?.db.close(); } catch { /* closed */ } });
