import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Startup gates that live in a provider's own state instead of in any protocol request.
 *
 * Claude Code and Codex both decide "may this directory run code?" in a TUI dialog that is rendered
 * before any session exists, so no hook or JSON-RPC channel can answer it. Each CLI persists the
 * answer instead: Claude writes `projects[<cwd>].hasTrustDialogAccepted` into its global config,
 * Codex reads `projects."<cwd>".trust_level`. Recording the same state here is what lets the
 * workbench answer those gates in its own UI rather than sending the reader to a terminal.
 *
 * `RIFFET_CLI_TRUST=0` disables these workspace-trust answers for readers who would rather
 * answer the CLIs directly. Hook trust remains the provider's own decision in either case.
 */

export interface CliTrustResult {
  /** Absolute path of the provider state file involved. */
  path: string;
  /** False when the provider had already recorded this answer, so nothing was written. */
  changed: boolean;
  /** Set when the state could not be recorded; the caller keeps going and reports it instead. */
  error?: string;
}

export function cliTrustEnabled(): boolean {
  return process.env.RIFFET_CLI_TRUST !== '0';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The provider compares its own `process.cwd()`, which the kernel already resolved, so a project key
 * has to be the physical path. macOS makes this visible: a session under `/tmp` lands in
 * `~/.claude.json` as `/private/tmp`.
 */
export function canonicalCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** `CLAUDE_CONFIG_DIR` when the profile or the environment sets one; otherwise undefined. */
export function claudeConfigHome(explicit?: string): string | undefined {
  const value = explicit?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim();
  return value ? resolve(value) : undefined;
}

/** The directory Claude Code keeps transcripts, settings and hooks in (`~/.claude` by default). */
export function claudeConfigDir(home: string | undefined): string {
  return home ?? join(homedir(), '.claude');
}

/**
 * Claude Code derives both paths from one value: `join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')`
 * and `join(CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')`. The global config is
 * therefore a *sibling* of `~/.claude`, never a child of it.
 */
export function claudeGlobalConfigPath(home: string | undefined): string {
  return join(home ?? homedir(), '.claude.json');
}

export function claudeUserSettingsPath(home: string | undefined): string {
  return join(claudeConfigDir(home), 'settings.json');
}

function modeOf(target: string): number {
  try {
    const handle = openSync(target, 'r');
    try {
      return fstatSync(handle).mode & 0o777;
    } finally {
      closeSync(handle);
    }
  } catch {
    return 0o600;
  }
}

/** Replace a whole file at once, so a provider watching it never reads a half-written config. */
function replaceFile(target: string, contents: string, mode: number): void {
  const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
  const handle = openSync(temporary, 'w', mode);
  try {
    writeSync(handle, contents);
    // Claude Code watches this file and may read it from another process as soon as it changes.
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, target);
}

/**
 * Record that a human trusts `cwd` for Claude Code, the way accepting the startup dialog does.
 * Returns undefined when the reader disabled the write; otherwise always returns, with `error` set
 * when the provider state could not be read or replaced.
 */
export function ensureClaudeWorkspaceTrust(input: { configHome?: string; cwd: string }): CliTrustResult | undefined {
  if (!cliTrustEnabled()) return undefined;
  const path = claudeGlobalConfigPath(claudeConfigHome(input.configHome));
  const key = canonicalCwd(input.cwd);
  // `undefined` means the file does not exist yet, which is itself the state to compare against
  // before replacing it.
  let raw: string | undefined;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // A missing file is the normal first-run state; anything else is a real failure to report.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { path, changed: false, error: messageOf(error) };
  }
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw?.length ? raw : '{}') as unknown;
    if (!isRecord(parsed)) return { path, changed: false, error: 'Claude Code global config is not a JSON object' };
    config = parsed;
  } catch (error) {
    // Never replace a config that cannot be read: a live Claude Code may be mid-write.
    return { path, changed: false, error: `Claude Code global config could not be parsed: ${messageOf(error)}` };
  }
  const projects = isRecord(config.projects) ? config.projects : {};
  const record = isRecord(projects[key]) ? projects[key] : {};
  if (record.hasTrustDialogAccepted === true) return { path, changed: false };
  projects[key] = { ...record, hasTrustDialogAccepted: true };
  config.projects = projects;
  /**
   * The read above is a snapshot, and a live Claude Code (or a second workbench launch) may have
   * rewritten the same file since. Re-read and give up when the bytes moved: the reader then answers
   * the dialog in the terminal, which is what the untrusted path already offers, while replacing the
   * file would silently drop whatever the CLI just wrote.
   */
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { path, changed: false, error: messageOf(error) };
  }
  if (current !== raw) return { path, changed: false, error: 'Claude Code rewrote its global config while the workbench was reading it' };
  try {
    replaceFile(path, `${JSON.stringify(config, null, 2)}\n`, modeOf(path));
  } catch (error) {
    return { path, changed: false, error: messageOf(error) };
  }
  return { path, changed: true };
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/**
 * Codex args that supply workspace trust without touching `config.toml`.
 *
 * `projects."<path>".trust_level` is the key Codex's own directory-trust screen persists. The
 * `-c` override supplies that answer to this process without editing the provider's config file.
 * Hook trust is deliberately left to the CLI: it records trust for the exact hook definition's
 * hash, and asks again when the definition changes. The override stays before the subcommand
 * (`codex <these> app-server`, `codex <these> resume`).
 */
export function codexTrustArgs(cwd: string): string[] {
  if (!cliTrustEnabled()) return [];
  return ['-c', `projects.${tomlString(canonicalCwd(cwd))}.trust_level="trusted"`];
}
