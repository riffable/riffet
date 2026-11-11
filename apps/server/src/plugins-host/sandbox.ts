import { execFile } from 'node:child_process';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { AppError } from '../errors.js';

// Operating-system isolation for the process an installed package runs in (docs/PLUGIN_ARCHITECTURE.md "执行位置").
// On macOS the process is started under a Seatbelt profile (`sandbox-exec`) that starts from
// `(deny default)`: it may execute the interpreter and nothing else, read its shim, its package and its own
// state directory, write only the latter, signal only itself, and open IP connections only when the
// package was granted `network`. The Node permission model stays on as a second layer.
// Nothing user-controlled is ever written into the profile text: every path is a `-D` parameter.

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const UNSAFE_ENV = 'RIFFET_UNSAFE_PLUGIN_PROCESS';

export interface SandboxPolicy {
  /** Real path of the interpreter, the one thing the process may execute. */
  node: string;
  /** Dynamic libraries the interpreter loads from outside the system (Homebrew builds link several). */
  libraries?: readonly string[];
  /** Real paths the process may read: the shim, the package, its state directory. */
  read: readonly string[];
  /** Real paths the process may write below: its state directory. */
  write: readonly string[];
  /** Outbound IP connections (the `network` grant). Unix sockets stay closed except the resolver's. */
  network: boolean;
  /** Loopback ports that stay closed even with `network`: the server's own, which a token-free server would answer to anyone. */
  withhold?: readonly number[];
}

/** Static facts about the machine, read-only: what Node asks of the kernel to start and to answer `os.*`. */
const SYSCTLS = [
  'hw.ncpu', 'hw.logicalcpu', 'hw.physicalcpu', 'hw.memsize', 'hw.pagesize_compat', 'hw.machine', 'hw.cputype', 'hw.cpusubtype', 'hw.cpufamily',
  'kern.ostype', 'kern.osrelease', 'kern.osversion', 'kern.osproductversion', 'kern.version', 'kern.hostname', 'kern.boottime',
];
const RESOLVER_SOCKET = '/private/var/run/mDNSResponder';

const quote = (value: string): string => JSON.stringify(value);

/**
 * `(allow <operations> (<kind> (param "PREFIX0")) ...)` for `count` paths, and nothing for none: a rule without
 * a filter allows the operation everywhere.
 */
const allow = (operations: string, kind: 'literal' | 'subpath', prefix: string, count: number): string[] =>
  count ? [`(allow ${operations} ${Array.from({ length: count }, (_, index) => `(${kind} (param ${quote(`${prefix}${index}`)}))`).join(' ')})`] : [];

/** Every directory above `paths` below `/`: `lstat` on them lets Node's `realpath` walk to a granted path. */
export function ancestors(paths: readonly string[]): string[] {
  const found = new Set<string>();
  for (const path of paths) for (let up = dirname(path); up !== '/' && up !== '.' && !found.has(up); up = dirname(up)) found.add(up);
  return [...found].sort();
}

/** The Seatbelt profile for a policy: constant text apart from how many paths each rule lists. */
export function sandboxProfile(policy: Pick<SandboxPolicy, 'read' | 'write' | 'network' | 'withhold'> & { libraries?: readonly string[] }): string {
  const above = ancestors([...policy.read, ...policy.write, ...(policy.libraries ?? [])]).length;
  return [
    '(version 1)',
    '(deny default)',
    '; The interpreter is the only thing this process may execute. dyld opens "/" while it starts; /dev/null is the OpenSSL configuration.',
    '(allow process-exec* (literal (param "NODE")))',
    '(allow file-read-data (literal "/") (literal "/dev/null"))',
    '; Reads: the shim, the package, its own state directory. The directories above them answer lstat only.',
    ...allow('file-read*', 'subpath', 'READ', policy.read.length),
    ...allow('file-read-metadata', 'literal', 'ABOVE', above),
    ...allow('file-read-data file-read-metadata file-map-executable', 'literal', 'LIB', policy.libraries?.length ?? 0),
    '; Writes: its own state directory.',
    ...allow('file-write*', 'subpath', 'WRITE', policy.write.length),
    '; Signals: itself.',
    '(allow signal (target self))',
    `(allow sysctl-read (sysctl-name ${SYSCTLS.map(quote).join(' ')}))`,
    ...(policy.network ? [
      '; Network: outbound IP, and the name resolver. No listening, no other unix sockets.',
      `(allow network-outbound (remote ip "*:*") (remote unix-socket (path-literal ${quote(RESOLVER_SOCKET)})))`,
      `(allow file-read-metadata (literal "/var") (literal ${quote(RESOLVER_SOCKET)}))`,
      // Later rules win: these ports are closed again on every host. `localhost` would not match an IPv4-mapped
      // IPv6 address (`::ffff:127.0.0.1`), which reaches a 127.0.0.1 listener all the same.
      ...[...new Set(policy.withhold ?? [])].filter(port => Number.isInteger(port) && port > 0 && port < 65536).map(port => `(deny network-outbound (remote ip "*:${port}"))`),
    ] : []),
    '',
  ].join('\n');
}

/** What goes between `sandbox-exec` and the interpreter's own flags: `-D` parameters, `-p <profile>`, then the interpreter. */
export function sandboxArguments(policy: SandboxPolicy): string[] {
  const libraries = [...(policy.libraries ?? [])];
  const values: Array<[string, string]> = [
    ['NODE', policy.node],
    ...policy.read.map((path, index): [string, string] => [`READ${index}`, path]),
    ...policy.write.map((path, index): [string, string] => [`WRITE${index}`, path]),
    ...libraries.map((path, index): [string, string] => [`LIB${index}`, path]),
    ...ancestors([...policy.read, ...policy.write, ...libraries]).map((path, index): [string, string] => [`ABOVE${index}`, path]),
  ];
  return [...values.flatMap(([name, value]) => ['-D', `${name}=${value}`]), '-p', sandboxProfile({ ...policy, libraries }), policy.node];
}

// ── The interpreter's own libraries ──────────────────────────────────────────

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const CPU_TYPES: Record<string, number> = { arm64: 0x0100000c, x64: 0x01000007 };
/** Load-command numbers as `readUInt32LE` reports them: LC_REQ_DYLD (0x80000000) is part of the number. */
const required = (command: number): number => (command | 0x80000000) >>> 0;
const LC_DEPENDENCIES = new Set([0xc, required(0x18), required(0x1f), 0x20, required(0x23)]);
const LC_RPATH = required(0x1c);
const MAX_LIBRARIES = 128;
/** In the dyld shared cache, never opened as files. */
const isSystemLibrary = (path: string): boolean => path.startsWith('/usr/lib/') || path.startsWith('/System/');

async function loadCommands(file: string): Promise<{ dependencies: string[]; rpaths: string[] } | undefined> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const read = async (length: number, position: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    let base = 0;
    const first = await read(8, 0);
    if (first.length === 8 && first.readUInt32BE(0) === FAT_MAGIC) {
      const count = Math.min(first.readUInt32BE(4), 8);
      const table = await read(count * 20, 8);
      let found: number | undefined;
      for (let index = 0; index < count; index++) if (table.readUInt32BE(index * 20) === CPU_TYPES[process.arch]) found = table.readUInt32BE(index * 20 + 8);
      if (found === undefined) return undefined;
      base = found;
    }
    const header = await read(32, base);
    if (header.length < 32 || header.readUInt32LE(0) !== MH_MAGIC_64) return undefined;
    const count = header.readUInt32LE(16);
    const size = header.readUInt32LE(20);
    if (size > 1024 * 1024) return undefined;
    const body = await read(size, base + 32);
    const dependencies: string[] = [];
    const rpaths: string[] = [];
    let offset = 0;
    for (let index = 0; index < count && offset + 8 <= body.length; index++) {
      const command = body.readUInt32LE(offset);
      const length = body.readUInt32LE(offset + 4);
      if (length < 8 || offset + length > body.length) break;
      if (LC_DEPENDENCIES.has(command) || command === LC_RPATH) {
        const start = offset + body.readUInt32LE(offset + 8);
        const end = body.indexOf(0, start);
        const text = body.toString('utf8', start, end < 0 || end > offset + length ? offset + length : end);
        (command === LC_RPATH ? rpaths : dependencies).push(text);
      }
      offset += length;
    }
    return { dependencies, rpaths };
  } finally { await handle.close(); }
}

/** The real path of `path`, collecting every symbolic link met on the way. */
async function followLinks(path: string, links: Set<string>): Promise<string> {
  let resolved = '/';
  const queue = path.split('/').filter(Boolean);
  for (let hops = 0; queue.length;) {
    const next = join(resolved, queue.shift()!);
    if (!(await lstat(next)).isSymbolicLink()) { resolved = next; continue; }
    if (++hops > 40) throw new Error('too many symbolic links');
    links.add(next);
    const target = await readlink(next);
    if (isAbsolute(target)) resolved = '/';
    queue.unshift(...target.split('/').filter(Boolean));
  }
  return resolved;
}

/**
 * The dynamic libraries `node` loads from files, transitively: none for the official builds (everything is in
 * the system's shared cache), a dozen for Homebrew's. Their real paths, so the profile can list each one
 * instead of a whole prefix.
 */
export async function interpreterLibraries(node: string): Promise<string[]> {
  const found = new Set<string>();
  const visit = async (image: string, executable: string, inherited: readonly string[]): Promise<void> => {
    const commands = await loadCommands(image);
    if (!commands) return;
    const loader = dirname(image);
    const expand = (path: string): string => path.replace(/^@executable_path/, executable).replace(/^@loader_path/, loader);
    const rpaths = [...commands.rpaths.map(expand), ...inherited];
    for (const name of commands.dependencies) {
      if (isSystemLibrary(name)) continue;
      const candidates = name.startsWith('@rpath/') ? rpaths.map(path => join(path, name.slice(7))) : [expand(name)];
      for (const candidate of candidates) {
        if (!isAbsolute(candidate)) continue;
        const links = new Set<string>();
        const real = await followLinks(candidate, links).catch(() => undefined);
        if (!real) continue;
        // dyld opens the path as written, and every link on the way (Homebrew's opt/ and the versioned names are links) is checked too.
        if (!found.has(real) && found.size < MAX_LIBRARIES) { found.add(real); for (const link of links) found.add(link); await visit(real, executable, rpaths); }
        break;
      }
    }
  };
  await visit(node, dirname(node), []);
  return [...found].sort();
}

// ── Whether the machine can isolate ──────────────────────────────────────────

export type Isolation =
  | { kind: 'os'; node: string; libraries: readonly string[] }
  | { kind: 'none'; warning: string };

let support: Promise<{ ok: true; node: string; libraries: readonly string[] } | { ok: false; reason: string }> | undefined;

async function probe(): Promise<NonNullable<Awaited<typeof support>>> {
  if (process.platform !== 'darwin') return { ok: false, reason: `no operating-system isolation is implemented for ${process.platform}` };
  let node: string;
  let libraries: string[];
  try { node = await realpath(process.execPath); libraries = await interpreterLibraries(node); }
  catch (error) { return { ok: false, reason: `the Node binary could not be inspected (${error instanceof Error ? error.message : String(error)})` }; }
  // Actually apply the profile once: a missing binary, a profile this macOS rejects, or a server already inside a sandbox all show up here.
  const args = [...sandboxArguments({ node, libraries, read: [], write: [], network: false }), '-e', 'process.exit(0)'];
  return new Promise(done => {
    execFile(SANDBOX_EXEC, args, { timeout: 10_000, env: { OPENSSL_CONF: '/dev/null' }, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) return done({ ok: true, node, libraries });
      const detail = (stderr.trim().split('\n')[0] ?? '').slice(0, 200) || error.message;
      done({ ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? `${SANDBOX_EXEC} is not available` : `${SANDBOX_EXEC} could not run Node (${detail})` });
    });
  });
}

/** Runs once per server: the answer cannot change while it runs. */
export function sandboxSupport(): ReturnType<typeof probe> { return (support ??= probe()); }

/**
 * Decides how an installed package may run. With operating-system isolation it always does. Without it the
 * package is refused, unless `RIFFET_UNSAFE_PLUGIN_PROCESS=1` says to run it with only Node's permission model,
 * which does not stop network use or signals (the caller shows the warning for as long as it runs).
 */
export async function requireIsolation(env: NodeJS.ProcessEnv = process.env, available: ReturnType<typeof sandboxSupport> = sandboxSupport()): Promise<Isolation> {
  const result = await available;
  if (result.ok) return { kind: 'os', node: result.node, libraries: result.libraries };
  if (env[UNSAFE_ENV] === '1') return { kind: 'none', warning: `Running without operating-system isolation (${result.reason}); ${UNSAFE_ENV}=1 allows it. The package can use the network and signal other processes.` };
  throw new AppError('PLUGIN_ISOLATION_UNAVAILABLE', `Installed packages need operating-system isolation, and ${result.reason}. Set ${UNSAFE_ENV}=1 to run them with only Node's permission model, which does not restrict the network or signals.`, 409);
}
