import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { listRiffetTmuxServers } from '../../apps/server/src/terminal/orphans.js';
import { gitEnvironment } from '../../apps/server/src/update/git.js';

const execFileAsync = promisify(execFile);

/**
 * Valid 1x1 solid red PNG (68 bytes), used as a deterministic fixture for image attachment tests.
 */
const RED_SQUARE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SCRUBBED_ALWAYS_EXACT_ENV_KEYS = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'RIFFET_STATE_DIR',
  'RIFFET_DEV_PLUGINS',
]);

const SCRUBBED_MOCK_ONLY_EXACT_ENV_KEYS = new Set([
  'TRAECLI_HOME',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'PI_CODING_AGENT_DIR',
  'DSH_CONFIG_DIR',
  'FACTORY_API_KEY',
  'FACTORY_HOME_OVERRIDE',
]);

const SCRUBBED_ENV_PREFIXES = [
  'CLAUDE_CODE_',
  'RIFFET_CLAUDE_HOOK_',
];

export interface EnvIsolationOptions {
  /** When true (`--live` mode), preserves user provider credentials/config dirs while still scrubbing nested session vars. */
  live?: boolean;
}

function shouldScrubEnvKey(key: string, options: EnvIsolationOptions = {}): boolean {
  if (SCRUBBED_ALWAYS_EXACT_ENV_KEYS.has(key)) return true;
  if (!options.live && SCRUBBED_MOCK_ONLY_EXACT_ENV_KEYS.has(key)) return true;
  return SCRUBBED_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

const activeCleanups = new Set<() => Promise<void> | void>();

/**
 * Registers an active resource cleanup callback (sandbox, mock hub, etc.) to be invoked on
 * process interruption (`SIGINT` / `SIGTERM`). Returns an unregister callback.
 */
export function registerActiveCleanup(fn: () => Promise<void> | void): () => void {
  activeCleanups.add(fn);
  return () => {
    activeCleanups.delete(fn);
  };
}

/** Runs all currently registered active cleanups (idempotent, reverse registration order). */
export async function runAllActiveCleanups(): Promise<void> {
  const fns = [...activeCleanups].reverse();
  activeCleanups.clear();
  for (const fn of fns) {
    try {
      await fn();
    } catch {
      // keep cleaning remaining resources
    }
  }
}

export interface CompatSandboxOptions {
  backend: string;
  /**
   * When true, creates the sandbox under `$HOME/.riffet-compat-<backend>-<rand>` instead of `tmpdir()`.
   * Needed by restart scenarios (`restart-idle` / `restart-mid-turn`) because `app.close()` kills tmux
   * servers whose stateDir lives inside the system temp directory.
   */
  persistentStateDir?: boolean;
  /** Leave temporary files intact on disk after `cleanup()` for post-mortem inspection. */
  keep?: boolean;
}

export interface CompatSandboxCleanupResult {
  leakedTmux: boolean;
}

export interface CompatSandbox {
  readonly backend: string;
  readonly root: string;
  readonly stateDir: string;
  readonly projectDir: string;
  readonly cliHome: string;
  readonly stubsDir: string;
  readonly imagePath: string;
  readonly skillPath: string;
  readonly agentPath: string;
  readonly persistentStateDir: boolean;
  readonly keep: boolean;
  /** Registers a cleanup hook (e.g. closing an in-process server) run before tmux/disk cleanup. */
  registerCleanup(fn: () => Promise<void> | void): void;
  /** Tracks a child process spawned by a scenario so `cleanup()` guarantees it is reaped. */
  trackChild(child: ChildProcess): void;
  /** Gracefully stops registered services, cleans isolated tmux & processes, and deletes the sandbox. */
  cleanup(): Promise<CompatSandboxCleanupResult>;
}

function canonicalizePath(targetPath: string): string {
  const abs = resolve(targetPath);
  try {
    return realpathSync(abs);
  } catch {
    // Walk up until an existing ancestor can be canonicalized so `/tmp` -> `/private/tmp` still resolves.
    const segments: string[] = [];
    let current = abs;
    while (true) {
      const parent = dirname(current);
      if (parent === current) return abs;
      segments.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
      if (existsSync(current)) {
        try {
          return join(realpathSync(current), ...segments);
        } catch {
          return abs;
        }
      }
    }
  }
}

function isSameOrInside(candidate: string, protectedRoot: string): boolean {
  const rel = relative(protectedRoot, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Production Riffet state directory that compat tooling must NEVER read, mutate, or delete.
 */
export function productionRiffetStateDir(home = homedir()): string {
  return resolve(join(home, '.local', 'share', 'riffet'));
}

/**
 * Absolute safety guard: throws immediately if `targetPath` points to or resides inside
 * `~/.local/share/riffet` (by raw or canonicalized path).
 */
export function assertIsolatedPath(targetPath: string, home = homedir()): void {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('Sandbox path must be a non-empty string');
  }
  const prodRaw = productionRiffetStateDir(home);
  const prodCanonical = canonicalizePath(prodRaw);
  const candidateRaw = resolve(targetPath);
  const candidateCanonical = canonicalizePath(candidateRaw);

  if (
    isSameOrInside(candidateRaw, prodRaw)
    || isSameOrInside(candidateCanonical, prodRaw)
    || isSameOrInside(candidateRaw, prodCanonical)
    || isSameOrInside(candidateCanonical, prodCanonical)
  ) {
    throw new Error(
      `Refusing unsafe path "${targetPath}": compat sandbox must never touch production state dir "${prodRaw}"`,
    );
  }
}

/**
 * Strips nested CLI session variables (and in mock mode, ambient provider/gateway/config-dir vars)
 * that interfere with launching fresh isolated CLIs.
 */
export function scrubNestedCliEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: EnvIsolationOptions = {},
): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (shouldScrubEnvKey(key, options)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Applies scrubbed + overridden env vars to `process.env` for an in-process server run and returns
 * a restore function that reverts `process.env` to its exact previous state.
 */
export function applyIsolatedProcessEnv(
  overrides: Record<string, string | undefined> = {},
  options: EnvIsolationOptions = {},
): () => void {
  const snapshot = new Map<string, string | undefined>();
  const touched = new Set<string>();

  for (const key of Object.keys(process.env)) {
    if (shouldScrubEnvKey(key, options)) {
      snapshot.set(key, process.env[key]);
      touched.add(key);
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!touched.has(key)) {
      snapshot.set(key, process.env[key]);
      touched.add(key);
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, previous] of snapshot) {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  };
}

/**
 * Creates a POSIX executable stub that traps `SIGTERM` and sleeps, used by `probe-timeout-recovery`
 * to prove that Riffet reaps hung CLI probes within its timeout budget instead of hanging forever.
 */
export async function createHangingStubExecutable(dir: string, name = 'hanging-cli-stub'): Promise<string> {
  assertIsolatedPath(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const scriptPath = join(dir, name);
  assertIsolatedPath(scriptPath);
  const content = [
    '#!/bin/sh',
    'trap "" TERM INT HUP',
    'sleep 120',
    'exit 0',
    '',
  ].join('\n');
  await writeFile(scriptPath, content, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function sanitizeSegment(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

async function initIsolatedGitProject(projectDir: string): Promise<{
  imagePath: string;
  skillPath: string;
  agentPath: string;
}> {
  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  const skillDir = join(projectDir, '.agents', 'skills', 'compat-skill');
  const claudeAgentsDir = join(projectDir, '.claude', 'agents');
  await mkdir(skillDir, { recursive: true, mode: 0o700 });
  await mkdir(claudeAgentsDir, { recursive: true, mode: 0o700 });

  const readmePath = join(projectDir, 'README.md');
  const notesPath = join(projectDir, 'notes.txt');
  const imagePath = join(projectDir, 'red-square.png');
  const skillPath = join(skillDir, 'SKILL.md');
  const agentPath = join(claudeAgentsDir, 'sleeper.md');

  await Promise.all([
    writeFile(readmePath, '# Riffet Compat Sandbox\n\nDeterministic test workspace for CLI TCK.\n', 'utf8'),
    writeFile(notesPath, 'alpha\nbeta\ngamma\n', 'utf8'),
    writeFile(imagePath, Buffer.from(RED_SQUARE_PNG_BASE64, 'base64')),
    writeFile(
      skillPath,
      [
        '---',
        'name: compat-skill',
        'description: Isolated skill fixture for Riffet CLI compat verification.',
        '---',
        '',
        '# Compat Skill',
        '',
        'Reply with COMPAT_SKILL_ACK when invoked.',
        '',
      ].join('\n'),
      'utf8',
    ),
    writeFile(
      agentPath,
      [
        '---',
        'name: sleeper',
        'description: Isolated subagent fixture for Riffet CLI compat verification.',
        '---',
        '',
        'Wait briefly and return the requested summary.',
        '',
      ].join('\n'),
      'utf8',
    ),
  ]);

  const gitOpts = { cwd: projectDir, env: gitEnvironment(), stdio: 'pipe' as const };
  execFileSync('git', ['init', '-q'], gitOpts);
  execFileSync('git', ['add', '.'], gitOpts);
  execFileSync(
    'git',
    [
      '-c', 'user.email=compat@example.invalid',
      '-c', 'user.name=compat',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgSign=false',
      'commit', '-q', '-m', 'init compat sandbox',
    ],
    gitOpts,
  );

  return { imagePath, skillPath, agentPath };
}

async function killIsolatedTmuxSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  if (!existsSync(socketPath)) return;
  await execFileAsync('tmux', ['-S', socketPath, 'kill-server'], { timeout: 3_000 }).catch(() => undefined);
}

async function findLeakedTmuxForStateDir(stateDir: string): Promise<number[]> {
  if (process.platform === 'win32') return [];
  const stateCanonical = canonicalizePath(stateDir);
  const socketRaw = join(stateDir, 'tmux.sock');
  const socketCanonical = canonicalizePath(socketRaw);
  const servers = await listRiffetTmuxServers().catch(() => []);
  const matched: number[] = [];
  for (const server of servers) {
    const srvSocket = canonicalizePath(server.socket);
    const srvState = server.stateDir ? canonicalizePath(server.stateDir) : undefined;
    if (
      srvSocket === socketCanonical
      || server.socket === socketRaw
      || srvState === stateCanonical
      || isSameOrInside(srvSocket, stateCanonical)
    ) {
      matched.push(server.pid);
    }
  }
  return matched;
}

function terminateChild(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return;
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // fall back to direct signal
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  const timer = setTimeout(() => {
    if (child.exitCode !== null) return;
    if (child.pid && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, 1_000);
  timer.unref?.();
}

/**
 * Creates an isolated sandbox with its own Riffet state directory, isolated Git project,
 * isolated CLI config root, and stub directory. Never touches `~/.local/share/riffet`.
 */
export async function createCompatSandbox(options: CompatSandboxOptions): Promise<CompatSandbox> {
  const safeBackend = sanitizeSegment(options.backend);
  const suffix = randomBytes(5).toString('hex');
  const persistentStateDir = Boolean(options.persistentStateDir);
  const keep = Boolean(options.keep);

  const root = persistentStateDir
    ? join(homedir(), `.riffet-compat-${safeBackend}-${suffix}`)
    : join(tmpdir(), `riffet-compat-${safeBackend}-${suffix}`);

  assertIsolatedPath(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = canonicalizePath(root);
  assertIsolatedPath(canonicalRoot);

  const stateDir = join(canonicalRoot, 'state');
  const projectDir = join(canonicalRoot, 'project');
  const cliHome = join(canonicalRoot, 'cli-home');
  const backendConfigDir = join(cliHome, safeBackend);
  const stubsDir = join(canonicalRoot, 'stubs');

  for (const dir of [stateDir, projectDir, cliHome, backendConfigDir, stubsDir]) {
    assertIsolatedPath(dir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  let files: { imagePath: string; skillPath: string; agentPath: string };
  try {
    files = await initIsolatedGitProject(projectDir);
  } catch (error) {
    await rm(canonicalRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const cleanupHooks: Array<() => Promise<void> | void> = [];
  const trackedChildren = new Set<ChildProcess>();
  let cleaned = false;
  let unregisterActive: (() => void) | undefined;

  const sandbox: CompatSandbox = {
    backend: options.backend,
    root: canonicalRoot,
    stateDir,
    projectDir,
    cliHome,
    stubsDir,
    imagePath: files.imagePath,
    skillPath: files.skillPath,
    agentPath: files.agentPath,
    persistentStateDir,
    keep,
    registerCleanup(fn) {
      cleanupHooks.push(fn);
    },
    trackChild(child) {
      trackedChildren.add(child);
      child.once('exit', () => {
        trackedChildren.delete(child);
      });
    },
    async cleanup() {
      unregisterActive?.();
      unregisterActive = undefined;
      if (cleaned) {
        const remaining = await findLeakedTmuxForStateDir(stateDir);
        return { leakedTmux: remaining.length > 0 };
      }
      cleaned = true;

      for (let i = cleanupHooks.length - 1; i >= 0; i--) {
        try {
          await cleanupHooks[i]!();
        } catch {
          // continue running remaining cleanup steps
        }
      }

      for (const child of trackedChildren) {
        terminateChild(child);
      }
      trackedChildren.clear();

      const socketPath = join(stateDir, 'tmux.sock');
      await killIsolatedTmuxSocket(socketPath);

      const leakedPids = await findLeakedTmuxForStateDir(stateDir);
      let leakedTmux = leakedPids.length > 0;
      if (leakedPids.length > 0) {
        for (const pid of leakedPids) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // already gone
          }
        }
        await killIsolatedTmuxSocket(socketPath);
        const afterForce = await findLeakedTmuxForStateDir(stateDir);
        for (const pid of afterForce) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
        // Keep `leakedTmux = true` if a tmux server survived graceful shutdown.
        leakedTmux = true;
      }

      if (!keep) {
        assertIsolatedPath(canonicalRoot);
        await rm(canonicalRoot, { recursive: true, force: true }).catch(() => undefined);
      }

      return { leakedTmux };
    },
  };

  unregisterActive = registerActiveCleanup(() => sandbox.cleanup().then(() => undefined));

  return sandbox;
}
