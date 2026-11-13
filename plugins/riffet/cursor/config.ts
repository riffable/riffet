import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityReport, CommandResult } from '@contracts';
import { AppError, TMUX_MIN_VERSION, detectTailscale, runProcess, tmuxTooOld } from '@riffet/plugin-api/kit';
import { cursorCommand, cursorLaunchProfileOf, runCursor, type CursorLaunchProfile } from './cli-driver.js';

const REDACTED = '[REDACTED]';

/**
 * What the profile settings show for the default profile when nothing is stored: the values the launch
 * actually uses (the executable and directory the server resolves, endpoints, auto-update). `{}` for a
 * config the CLI could not be launched with.
 */
export function describeCursorProfile(config: Record<string, unknown>, launched?: CursorLaunchProfile): { executable?: string; configDir?: string; apiEndpoint?: string; agentEndpoint?: string; disableAutoUpdate?: boolean } {
  try {
    const profile = launched ?? cursorLaunchProfileOf(config);
    return {
      executable: profile.executable, configDir: profile.configDir,
      ...(profile.apiEndpoint ? { apiEndpoint: profile.apiEndpoint } : {}), ...(profile.agentEndpoint ? { agentEndpoint: profile.agentEndpoint } : {}),
      disableAutoUpdate: profile.disableAutoUpdate,
    };
  } catch { return {}; }
}

function scrubCliOutput(output: string): string {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(\b(?:token|secret|password|credential|api[_-]?key|authorization)\b\s*[:=]\s*)([^\s,;}]+)/gi, `$1${REDACTED}`)
    .replace(/(\bBearer\s+)[^\s,;}]+/gi, `$1${REDACTED}`)
    .replace(/(logged\s+in\s+as|email|user)\s*[:=]?\s*[^\s,;]+/gi, `$1 ${REDACTED}`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, REDACTED);
}

function reportedAuthenticated(value: unknown): boolean | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:authenticated|isAuthenticated|loggedIn|logged_in)$/i.test(key) && typeof item === 'boolean') return item;
    const nested = reportedAuthenticated(item);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function parseAvailableModels(output: string): string[] {
  const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  const ids = new Set<string>();
  for (const rawLine of output.replace(ANSI, '').split(/\r?\n/)) {
    let line = rawLine.trim().replace(/^(?:[-*•✓✔]\s*|\d+[.)]\s*)/, '');
    if (!line || /^(?:available models|models?:?|model id\s+-\s+model name|[-=\s]+)$/i.test(line)) continue;
    const separator = line.match(/\s+-\s+/);
    if (separator?.index !== undefined) line = line.slice(0, separator.index).trim();
    line = line.replace(/\s+\((?:current|default)\)$/i, '').trim();
    // Model IDs are single CLI tokens. Ignore status text and table headings
    // rather than accidentally presenting them as selectable models.
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/.test(line)) continue;
    ids.add(line);
    if (ids.size >= 100) break;
  }
  return [...ids];
}

function onlyOneLine(value: string): string { return value.trim().replace(/[\r\n]+/g, ' ').slice(0, 1000); }

function operationArgs(operation: string, args: unknown): string[] {
  if (args !== undefined && (!Array.isArray(args) || args.some(value => typeof value !== 'string'))) throw new AppError('INVALID_ARGUMENTS', 'CLI args must be a string array');
  const values = (args ?? []) as string[];
  if (values.some(value => value.length > 255 || value.includes('\0') || /[\r\n]/.test(value))) throw new AppError('INVALID_ARGUMENTS', 'CLI arguments contain invalid values');
  const formatArgs = () => {
    if (!values.length) return [];
    if (values.length === 2 && values[0] === '--format' && ['json', 'text'].includes(values[1])) return values;
    throw new AppError('INVALID_ARGUMENTS', 'Only --format json|text is supported');
  };
  const identifier = (value: string) => value.length > 0 && value.length <= 255 && !value.startsWith('-') && !/[\0\r\n]/.test(value);
  const marketplaceUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      return ['https:', 'ssh:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch { return /^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(value); }
  };
  switch (operation) {
    case 'status': return ['status', ...formatArgs()];
    case 'about': return ['about', ...formatArgs()];
    case 'models': return values.length ? (() => { throw new AppError('INVALID_ARGUMENTS', 'models does not accept arguments'); })() : ['--list-models'];
    case 'team': return !values.length || (values.length === 1 && values[0] === 'list') ? ['team', 'list'] : values.length === 2 && values[0] === 'switch' && identifier(values[1]) ? ['team', 'switch', values[1]] : (() => { throw new AppError('INVALID_ARGUMENTS', 'team accepts list or switch <team>'); })();
    case 'team.list': return !values.length ? ['team', 'list'] : (() => { throw new AppError('INVALID_ARGUMENTS', 'team.list does not accept arguments'); })();
    case 'team.switch': return values.length === 1 && identifier(values[0]) ? ['team', 'switch', values[0]] : (() => { throw new AppError('INVALID_ARGUMENTS', 'team.switch requires one team name or ID'); })();
    case 'mcp':
    case 'mcp.list':
      if (!values.length || (values.length === 1 && values[0] === 'list')) return ['mcp', 'list'];
      if (values.length === 2 && values[0] === 'list-tools' && identifier(values[1])) return ['mcp', 'list-tools', values[1]];
      if (values.length === 2 && ['enable', 'disable'].includes(values[0]) && identifier(values[1])) return ['mcp', values[0], values[1]];
      throw new AppError('INVALID_ARGUMENTS', 'mcp accepts list, list-tools, enable, or disable with a server name');
    case 'mcp.list-tools': return values.length === 1 && identifier(values[0]) ? ['mcp', 'list-tools', values[0]] : (() => { throw new AppError('INVALID_ARGUMENTS', 'mcp.list-tools requires a server name'); })();
    case 'mcp.enable':
    case 'mcp.disable': return values.length === 1 && identifier(values[0]) ? ['mcp', operation.slice(4), values[0]] : (() => { throw new AppError('INVALID_ARGUMENTS', `${operation} requires a server name`); })();
    case 'mcp.login': throw new AppError('INTERACTIVE_OPERATION_REQUIRED', 'MCP login requires the persistent terminal interface');
    case 'plugin':
    case 'plugin.marketplace.list':
      if (!values.length || (values.length === 2 && values[0] === 'marketplace' && values[1] === 'list')) return ['plugin', 'marketplace', 'list'];
      if (values.length === 3 && values[0] === 'marketplace' && values[1] === 'add' && marketplaceUrl(values[2])) return ['plugin', 'marketplace', 'add', values[2]];
      if (values.length === 3 && values[0] === 'marketplace' && ['remove', 'update'].includes(values[1]) && identifier(values[2])) return ['plugin', 'marketplace', values[1], values[2]];
      throw new AppError('INVALID_ARGUMENTS', 'plugin marketplace accepts list, add <git URL>, remove <name>, or update <name>');
    case 'plugin.marketplace.add': return values.length === 1 && marketplaceUrl(values[0]) ? ['plugin', 'marketplace', 'add', values[0]] : (() => { throw new AppError('INVALID_ARGUMENTS', 'A public HTTPS or SSH Git URL is required'); })();
    case 'plugin.marketplace.remove':
    case 'plugin.marketplace.update': return values.length === 1 && identifier(values[0]) ? ['plugin', 'marketplace', operation.slice('plugin.marketplace.'.length), values[0]] : (() => { throw new AppError('INVALID_ARGUMENTS', `${operation} requires a marketplace name`); })();
    case 'cli.update':
    case 'update': return values.length ? (() => { throw new AppError('INVALID_ARGUMENTS', 'CLI update does not accept arguments'); })() : ['update'];
    default: throw new AppError('UNKNOWN_OPERATION', 'CLI operation is not in the safe command registry');
  }
}

/** One of the CLI's named management operations, run for the launch profile; `cwd` is an absolute project directory. */
export async function runCursorOperation(profile: CursorLaunchProfile, operation: string, args?: string[], cwd?: string): Promise<CommandResult> {
  const commandArgs = operationArgs(operation, args);
  const directory = cwd;
  let workingDirectory = process.cwd();
  if (directory) {
    if (!path.isAbsolute(directory)) throw new AppError('INVALID_CWD', 'CLI working directory must be absolute');
    try {
      const canonical = await realpath(directory);
      if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
      workingDirectory = canonical;
    } catch { throw new AppError('INVALID_CWD', 'CLI working directory is unavailable', 404); }
  }
  const timeoutMs = ['update', 'cli.update'].includes(operation) ? 120_000 : ['mcp', 'mcp.enable', 'mcp.disable', 'mcp.list-tools', 'plugin', 'plugin.marketplace.add', 'plugin.marketplace.remove', 'plugin.marketplace.update'].includes(operation) ? 60_000 : 15_000;
  const result = await runCursor(profile, commandArgs, { cwd: workingDirectory, timeoutMs, maxOutputBytes: 2 * 1024 * 1024 });
  return { code: result.code, stdout: scrubCliOutput(result.stdout), stderr: scrubCliOutput(result.stderr), ...(result.timedOut ? { timedOut: true } : {}), ...(result.truncated ? { truncated: true } : {}) };
}

/** Whether `cursor-agent status --format json` says the CLI is signed in; an unreadable status counts as signed out. */
function statusAuthenticated(status: { code: number | null; stdout: string; stderr: string }): boolean {
  const statusText = `${status.stdout}\n${status.stderr}`;
  const explicitLoggedOut = /not\s+(?:logged\s+in|authenticated)|unauthenticated|logged[_ -]?out|login required/i.test(statusText);
  let jsonAuth: boolean | undefined;
  try { jsonAuth = reportedAuthenticated(JSON.parse(status.stdout)); } catch { /* Fall back to the CLI's text status. */ }
  return status.code === 0 && !explicitLoggedOut && (jsonAuth ?? /logged\s+in|authenticated|"(?:email|user|team)"\s*:/i.test(statusText));
}

/** Whether the CLI's own account is signed out. A custom provider signs in through its gateway, not the CLI, so it never needs it. */
export async function cursorNeedsLogin(profile: CursorLaunchProfile): Promise<boolean> {
  if (cursorCommand(profile, []).custom) return false;
  return !statusAuthenticated(await runCursor(profile, ['status', '--format', 'json'], { cwd: process.cwd(), timeoutMs: 7000, maxOutputBytes: 64 * 1024 }));
}

/** What this machine can do for the Cursor CLI: its version, sign-in, models, and the tools around it. */
export async function cursorCapabilityReport(profile: CursorLaunchProfile): Promise<CapabilityReport> {
  const checkedAt = new Date().toISOString();
  const warnings: string[] = [];
  const cwd = process.cwd();
  const [version, help, status, models, tmux, tailscale] = await Promise.all([
    runCursor(profile, ['--version'], { cwd, timeoutMs: 5000, maxOutputBytes: 16 * 1024 }),
    runCursor(profile, ['--help'], { cwd, timeoutMs: 7000, maxOutputBytes: 128 * 1024 }),
    runCursor(profile, ['status', '--format', 'json'], { cwd, timeoutMs: 7000, maxOutputBytes: 64 * 1024 }),
    runCursor(profile, ['--list-models'], { cwd, timeoutMs: 7000, maxOutputBytes: 256 * 1024 }),
    runProcess('tmux', ['-V'], { cwd, timeoutMs: 3000, maxOutputBytes: 16 * 1024 }),
    detectTailscale(cwd),
  ]);
  const cliAvailable = version.code === 0;
  const customGateway = cursorCommand(profile, []).custom;
  const cliVersion = cliAvailable ? onlyOneLine(scrubCliOutput(version.stdout || version.stderr)) : undefined;
  if (!cliAvailable) warnings.push('Cursor Agent CLI could not be probed.');
  const modelIds = parseAvailableModels(models.stdout);
  const authenticated = customGateway
    ? cliAvailable && models.code === 0 && !models.timedOut
    : statusAuthenticated(status);
  if (cliAvailable && !authenticated) warnings.push(customGateway ? 'Custom Cursor provider readiness could not be determined.' : 'Cursor Agent CLI is not authenticated or its status could not be determined.');
  if (models.code !== 0 || models.timedOut) warnings.push('Available model list could not be read.');
  const tmuxOld = tmux.code === 0 && tmuxTooOld(tmux.stdout);
  if (tmux.code !== 0) warnings.push('tmux was not found or could not be started.');
  else if (tmuxOld) warnings.push(`${onlyOneLine(tmux.stdout)} is too old: terminals need tmux ${TMUX_MIN_VERSION} or newer.`);
  return {
    cliPath: profile.executable,
    ...(cliVersion ? { cliVersion } : {}),
    authenticated,
    ...(cliAvailable ? { authMessage: customGateway ? (authenticated ? 'Custom Cursor provider responded to the model probe.' : 'Custom Cursor provider readiness could not be determined.') : authenticated ? 'Cursor CLI is authenticated.' : 'Cursor CLI authentication is unavailable.' } : {}),
    tmux: tmux.code === 0 && !tmuxOld,
    nativePersistence: /(?:^|\s)persist(?:\s|$)/m.test(help.stdout) ? 'Cursor CLI persist command is available.' : 'Cursor CLI persist command was not detected.',
    models: modelIds,
    tailscale,
    checkedAt,
    warnings,
  };
}
