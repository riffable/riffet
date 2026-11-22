import { spawnSync } from 'node:child_process';
import WebSocket, { createWebSocketStream } from 'ws';
import type { LinkInfo, LinkInviteResult, LinkSelfInfo, LinkUpdateRequest } from '../../../../packages/contracts/src/index.js';
import { Api } from './api.js';
import { accessToken, requireActive, serverUrl, stateDir } from './context.js';
import { CliError, ago, columns, note, out, printJson, printLines, success } from './ui.js';

/**
 * `riffet link` (docs/SERVER-LINKS.md §7). `--allow-in` always means the same thing: the other server may operate
 * this one. It is off unless given, on every subcommand, because it hands the other machine this user's shell.
 * `riffet link ssh` turns it on for the remote side only: whoever runs it already has a shell there over SSH.
 */
interface Common { stateDir: string; json?: boolean }

async function api(dir: string): Promise<Api> {
  const resolved = stateDir(dir);
  return Api.login(await requireActive(resolved), accessToken(resolved));
}

export async function linkInvite(options: Common & { url?: string; allowIn?: boolean }) {
  const client = await api(options.stateDir);
  const invite = await client.call<LinkInviteResult>('POST', '/api/links/invites', { inbound: Boolean(options.allowIn), ...(options.url ? { url: options.url } : {}) });
  if (options.json) { printJson(invite); return; }
  printLines([invite.link, '']);
  note(`On the other server: riffet link join '<this string>'. It works once, for ${Math.round((invite.expiresAt - Date.now()) / 60_000)} minutes.`);
  if (!options.url) note('It has no address, so only `riffet link ssh` can use it; pass --url to join directly');
  note(options.allowIn ? 'The other server will be able to operate this one' : 'The other server will not be able to operate this one; pass --allow-in to let it');
}

export async function linkJoin(options: Common & { link: string; allowIn?: boolean }) {
  const client = await api(options.stateDir);
  const { link } = await client.call<{ link: LinkInfo }>('POST', '/api/links/join', { link: options.link, inbound: Boolean(options.allowIn) }, 30_000);
  if (options.json) { printJson(link); return; }
  success(`Linked with ${link.name}`);
  printLines(describe([link]));
}

/** Gets a link string from the other machine over SSH, then joins it with the tunnel running over SSH too. */
export async function linkSsh(options: Common & { host: string; allowIn?: boolean; remoteCommand?: string }) {
  const remote = options.remoteCommand?.trim() || 'riffet';
  if (options.host.startsWith('-')) throw new CliError('Give one SSH destination, such as devbox or me@devbox');
  // An interactive SSH login is fine here: only the daemon's later tunnels must run without prompts.
  const result = spawnSync('ssh', ['-T', '--', options.host, `${remote} link invite --json --allow-in`], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], timeout: 120_000 });
  if (result.error) throw new CliError(`Could not run ssh: ${result.error.message}`);
  if (result.status !== 0) throw new CliError(`ssh ${options.host} exited with ${result.status}`, [`ssh ${options.host} ${remote} status`, 'Pass --remote-command with the path of riffet there if it is not on PATH']);
  let invite: LinkInviteResult;
  try { invite = JSON.parse(result.stdout) as LinkInviteResult; } catch { throw new CliError(`${options.host} did not answer with a link string`); }
  const client = await api(options.stateDir);
  const { link } = await client.call<{ link: LinkInfo }>('POST', '/api/links/join', {
    link: invite.link, inbound: Boolean(options.allowIn), transport: 'ssh', sshHost: options.host,
    ...(options.remoteCommand ? { remoteCommand: remote } : {}),
  }, 60_000);
  if (options.json) { printJson(link); return; }
  success(`Linked with ${link.name} over SSH`);
  printLines(describe([link]));
  note('The tunnel reconnects without prompts, so SSH must log in with a key or agent the Riffet service can use');
}

export async function linkList(options: Common) {
  const client = await api(options.stateDir);
  const { links } = await client.call<{ links: LinkInfo[] }>('GET', '/api/links');
  if (options.json) { printJson(links); return; }
  if (!links.length) { note('No linked servers. Make a link string with `riffet link invite`, or `riffet link ssh <host>`'); return; }
  printLines(describe(links));
}

export async function linkRemove(options: Common & { server: string }) {
  const client = await api(options.stateDir);
  const { links } = await client.call<{ links: LinkInfo[] }>('GET', '/api/links');
  const target = links.find(link => link.serverId === options.server)
    ?? links.find(link => link.alias.toLowerCase() === options.server.toLowerCase())
    ?? links.filter(link => link.name === options.server).at(0);
  if (!target) throw new CliError(`No linked server named ${options.server}`, ['riffet link list']);
  await client.call('DELETE', `/api/links/${encodeURIComponent(target.serverId)}`);
  success(`Ended the link with ${target.name} on both servers`);
}

export async function linkRename(options: Common & { server: string; name?: string; alias?: string; note?: string }) {
  const client = await api(options.stateDir);
  const { links } = await client.call<{ links: LinkInfo[] }>('GET', '/api/links');
  const target = links.find(link => link.serverId === options.server)
    ?? links.find(link => link.alias.toLowerCase() === options.server.toLowerCase())
    ?? links.filter(link => link.name === options.server).at(0);
  if (!target) throw new CliError(`No linked server matching ${options.server}`, ['riffet link list']);
  const change: LinkUpdateRequest = {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.alias !== undefined ? { alias: options.alias } : {}),
    ...(options.note !== undefined ? { note: options.note } : {}),
  };
  const { link } = await client.call<{ link: LinkInfo }>('PATCH', `/api/links/${encodeURIComponent(target.serverId)}`, change);
  if (options.json) { printJson(link); return; }
  success(`Updated ${link.name} (${link.alias})`);
}

export async function linkSelfName(options: Common & { name: string }) {
  const client = await api(options.stateDir);
  const { self } = await client.call<{ self: LinkSelfInfo }>('PATCH', '/api/links/self', { name: options.name });
  if (options.json) { printJson(self); return; }
  success(`This server is now named ${self.name}`);
}

/**
 * Run by the other server over SSH: relays the tunnel between standard input and output and this machine's own
 * server, over loopback. Nothing else may be written to standard output.
 */
export async function linkStdio(options: { stateDir: string; role?: string; join?: string }) {
  const record = await requireActive(stateDir(options.stateDir));
  const url = new URL('/api/links/tunnel', serverUrl(record));
  url.protocol = 'ws:';
  url.searchParams.set('role', options.role === 'reverse' ? 'reverse' : 'primary');
  if (options.join) url.searchParams.set('join', options.join);
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  const stream = createWebSocketStream(socket);
  process.stdin.pipe(stream).pipe(process.stdout);
  await new Promise<void>(resolve => {
    stream.once('close', () => resolve());
    process.stdin.once('end', () => { stream.end(); });
  });
}

function describe(links: LinkInfo[]): string[] {
  const state = (link: LinkInfo) => link.state === 'online' ? out.ok('online') : link.state === 'removed' ? out.warn('ended by the other server') : out.dim(link.state);
  const direction = (link: LinkInfo) => [link.outbound ? 'you operate it' : '', link.inbound ? 'it operates you' : ''].filter(Boolean).join(', ') || out.dim('neither direction allowed');
  return columns(links.map(link => [
    out.bold(link.name),
    out.dim(link.alias),
    state(link),
    direction(link),
    out.dim(link.address ? `${link.transport} ${link.address}` : link.transport),
    out.dim(link.lastConnectedAt ? ago(link.lastConnectedAt) : ''),
  ]), { gap: 3 });
}
