import WebSocket from 'ws';
import { LINK_BUDGET, type RemoteExecResult, type ServerInfo } from '../../../../packages/contracts/src/index.js';
import { Api } from './api.js';
import { accessToken, requireActive, stateDir } from './context.js';
import { CliError, columns, note, out, printJson, printLines } from './ui.js';

interface Common { stateDir: string; json?: boolean }

async function api(dir: string): Promise<Api> {
  const resolved = stateDir(dir);
  return Api.login(await requireActive(resolved), accessToken(resolved));
}

function formatPlatform(platform?: { os: string; arch: string }): string {
  if (!platform) return '';
  const os = platform.os === 'darwin' ? 'macOS' : platform.os === 'linux' ? 'Linux' : platform.os === 'win32' ? 'Windows' : platform.os;
  return platform.arch ? `${os}/${platform.arch}` : os;
}

/**
 * Resolves a human target string (`alias`, `serverId` or unique prefix, or exact display name)
 * to one linked server, failing with actionable candidates on ambiguity.
 */
export function resolveLinkedServer(servers: readonly ServerInfo[], target: string): ServerInfo {
  const peers = servers.filter(item => !item.self);
  const needle = target.trim();
  const lower = needle.toLowerCase();
  const byAlias = peers.find(item => item.alias?.toLowerCase() === lower);
  if (byAlias) return byAlias;
  const byId = peers.find(item => item.id.toLowerCase() === lower);
  if (byId) return byId;
  const byPrefix = peers.filter(item => item.id.toLowerCase().startsWith(lower));
  if (byPrefix.length === 1) return byPrefix[0]!;
  if (byPrefix.length > 1) {
    throw new CliError(`Ambiguous server prefix "${target}"`, byPrefix.map(item => `${item.alias ?? item.id.slice(0, 8)} (${item.name})`));
  }
  const byName = peers.filter(item => item.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new CliError(`Multiple linked servers are named "${target}"; use its alias instead`, byName.map(item => `riffet ssh ${item.alias ?? item.id}`));
  }
  const hints = peers.length
    ? ['Available servers:', ...peers.map(item => `  ${item.alias ?? item.id.slice(0, 8)}  ${item.name}`)]
    : ['riffet link list'];
  throw new CliError(`No linked server matching "${target}"`, hints);
}

export async function sshList(options: Common): Promise<void> {
  const client = await api(options.stateDir);
  const { servers } = await client.call<{ servers: ServerInfo[] }>('GET', '/api/servers');
  const peers = servers.filter(item => !item.self);
  if (options.json) { printJson(peers); return; }
  if (!peers.length) { note('No linked servers. Link one with `riffet link ssh <host>` or `riffet link invite`'); return; }
  printLines(columns(peers.map(server => [
    out.bold(server.alias ?? server.id.slice(0, 8)),
    server.name,
    server.online ? out.ok('online') : out.dim('offline'),
    server.outbound ? out.ok('allowed') : out.warn('not allowed'),
    out.dim(formatPlatform(server.platform)),
    out.dim(server.note ?? ''),
  ]), { gap: 3 }));
}

export async function sshRun(options: Common & { target: string; command: string[]; cwd?: string; timeout?: string }): Promise<number> {
  const client = await api(options.stateDir);
  const { servers } = await client.call<{ servers: ServerInfo[] }>('GET', '/api/servers');
  const server = resolveLinkedServer(servers, options.target);
  if (!server.online) throw new CliError(`${server.name} (${server.alias ?? server.id}) is offline`, ['riffet link list']);
  if (!server.outbound) throw new CliError(`${server.name} does not allow this server to operate it`, [`Enable inbound permission on ${server.name} in Settings -> Links`]);

  const command = options.command.join(' ').trim();
  if (command) {
    const parsedTimeout = options.timeout !== undefined ? Number(options.timeout) : undefined;
    if (parsedTimeout !== undefined && (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0)) {
      throw new CliError('--timeout must be a positive number of seconds');
    }
    const timeoutMs = parsedTimeout !== undefined
      ? Math.min(LINK_BUDGET.execTimeoutMaxMs, Math.max(1_000, Math.round(parsedTimeout * 1_000)))
      : LINK_BUDGET.execTimeoutDefaultMs;
    const result = await client.call<RemoteExecResult>(
      'POST',
      `/api/servers/${encodeURIComponent(server.id)}/remote/exec`,
      { command, ...(options.cwd ? { cwd: options.cwd } : {}), timeoutMs },
      timeoutMs + 10_000,
    );
    if (options.json) { printJson(result); return result.exitCode ?? (result.timedOut ? 124 : 1); }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.truncated) process.stderr.write(`\n${out.warn('[riffet ssh] Output truncated at limit')}\n`);
    if (result.timedOut) process.stderr.write(`\n${out.warn('[riffet ssh] Command timed out')}\n`);
    return result.exitCode ?? (result.timedOut ? 124 : 1);
  }

  return interactiveShell(client, server, options.cwd);
}

async function interactiveShell(client: Api, server: ServerInfo, cwd?: string): Promise<number> {
  const url = new URL(`/api/servers/${encodeURIComponent(server.id)}/remote/shell`, client.base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (cwd) url.searchParams.set('cwd', cwd);
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 36;
  url.searchParams.set('cols', String(cols));
  url.searchParams.set('rows', String(rows));

  const socket = new WebSocket(url, { headers: { ...client.authHeaders(), origin: client.base } });
  const tty = Boolean(process.stdin.isTTY);
  let exitCode = 0;

  return new Promise<number>((resolveCode, reject) => {
    let settled = false;
    const restore = () => {
      if (tty && process.stdin.isRaw) {
        try { process.stdin.setRawMode(false); } catch { /* Ignore. */ }
      }
      process.stdin.pause();
      process.stdin.off('data', onStdin);
      process.stdout.off('resize', onResize);
    };
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      restore();
      resolveCode(code);
    };
    const onStdin = (chunk: Buffer) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: chunk.toString('utf8') }));
    };
    const onResize = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns || 120, rows: process.stdout.rows || 36 }));
      }
    };

    socket.once('open', () => {
      if (tty) {
        try { process.stdin.setRawMode(true); } catch { /* Ignore. */ }
      }
      process.stdin.resume();
      process.stdin.on('data', onStdin);
      process.stdout.on('resize', onResize);
    });

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; data?: string; exitCode?: number; message?: string };
        if (msg.type === 'output' && typeof msg.data === 'string') process.stdout.write(msg.data);
        else if (msg.type === 'error' && typeof msg.message === 'string') process.stderr.write(`${msg.message}\n`);
        else if (msg.type === 'exit' && typeof msg.exitCode === 'number') exitCode = msg.exitCode;
      } catch { /* Ignore malformed frames. */ }
    });

    socket.once('close', () => done(exitCode));
    socket.once('error', (error) => {
      if (settled) return;
      settled = true;
      restore();
      reject(new CliError(`Could not open shell on ${server.name}: ${error.message}`));
    });
  });
}
