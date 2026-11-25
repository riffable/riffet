import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../../../packages/contracts/src/index.js';
import { Api } from './api.js';
import { accessToken, active, health, isLoopback, isWildcard, managerLabel, serverUrl, stateDir, type DaemonRecord, type Health } from './context.js';
import { currentStartupPhase, phaseLabel, startingServer } from './startup.js';
import { availableUpdate } from './update-notice.js';
import { MARK, duration, fields, hint, out, plural, printJson, printLines, tilde } from './ui.js';

/** Addresses other devices reach a wildcard listener on: IPv4 first, the usual LAN interfaces first. */
export function lanAddresses(): string[] {
  const rank = (name: string) => (/^(?:en|eth|wl)/.test(name) ? 0 : 1);
  return Object.entries(networkInterfaces())
    .sort(([a], [b]) => rank(a) - rank(b))
    .flatMap(([, entries]) => (entries ?? []).filter(item => !item.internal && item.family === 'IPv4' && !item.address.startsWith('169.254.')).map(item => item.address));
}

const urlFor = (host: string, port: number) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

/** Where other devices reach this server, or why they cannot. */
function networkUrls(record: DaemonRecord): string[] {
  if (isLoopback(record.host)) return [];
  if (!isWildcard(record.host)) return [urlFor(record.host, record.port)];
  return lanAddresses().slice(0, 3).map(address => urlFor(address, record.port));
}

const authenticated = (record: DaemonRecord) => !record.args.includes('--no-auth');

function versionLabel(state: Health | undefined): string {
  const build = state?.build;
  if (build?.tag && !build.dirty) return build.tag;
  const version = build?.version ?? state?.version ?? 'unknown version';
  const commit = build?.commit ? ` ${build.commit.slice(0, 7)}${build.dirty ? '+' : ''}` : '';
  return `${version}${out.dim(` dev${commit}`)}`;
}

interface SessionCounts { running: number; waiting: number; failed: number; total: number }

async function sessionCounts(record: DaemonRecord, dir: string): Promise<SessionCounts | undefined> {
  try {
    const api = await Api.login(record, accessToken(dir));
    const sessions = await api.call<Session[]>('GET', '/api/sessions', undefined, 3000);
    const live = sessions.filter(session => !session.archivedAt && session.state !== 'archived');
    const count = (...states: Session['state'][]) => live.filter(session => states.includes(session.state)).length;
    return { running: count('starting', 'running', 'cancelling'), waiting: count('waiting'), failed: count('failed'), total: live.length };
  } catch { return undefined; }
}

function describeSessions(counts: SessionCounts): string {
  const parts = [
    ...(counts.running ? [out.accent(`${counts.running} running`)] : []),
    ...(counts.waiting ? [out.warn(`${counts.waiting} waiting for you`)] : []),
    ...(counts.failed ? [out.fail(`${counts.failed} failed`)] : []),
  ];
  return `${parts.length ? parts.join(out.dim(' · ')) : 'idle'}${out.dim(` · ${plural(counts.total, 'conversation')}`)}`;
}

/**
 * The block `start`, `serve`, `open` and `status` print about a running server. `readyMs` titles it as
 * a fresh start, `already` as a start that found one running; `detail` adds what only `status` shows.
 */
export async function serverSummary(record: DaemonRecord, dir: string, options: { readyMs?: number; already?: boolean; detail?: boolean } = {}): Promise<string[]> {
  const state = await health(record);
  const uptime = duration(Date.now() - Date.parse(record.startedAt));
  const title = `${out.ok(MARK.running)} ${out.bold(out.accent('Riffet'))} ${out.bold(versionLabel(state))}`;
  const heading = options.readyMs !== undefined ? `${title} ${out.dim('ready in')} ${out.bold(`${options.readyMs} ms`)}`
    : options.already ? `${title} ${out.dim(`already running · up ${uptime}`)}`
    : `${title} ${out.dim(`· up ${uptime}`)}`;
  const network = networkUrls(record);
  const update = availableUpdate(dir, state?.build);
  const rows: Array<[string, string | undefined]> = [
    ['Local', out.url(serverUrl(record) + '/')],
    ...(network.length
      ? network.map((url, index): [string, string] => [index ? '' : 'Network', out.url(url + '/')])
      : [['Network', `${out.dim('off')}  ${out.dim(MARK.arrow)} ${out.cmd('riffet restart --host 0.0.0.0')}`] as [string, string]]),
    ['Access', authenticated(record) ? `token required${out.dim(' · riffet url --login')}` : `this computer only${out.dim(' · no token')}`],
  ];
  if (options.detail) {
    const counts = await sessionCounts(record, dir);
    if (counts) rows.push(['Sessions', describeSessions(counts)]);
    rows.push(['Managed', `${managerLabel(state?.managedBy) ?? 'unknown'}${out.dim(` · pid ${record.pid}`)}`]);
    rows.push(['State', tilde(dir)]);
  }
  if (update) rows.push(['Update', `${out.ok(update)} available  ${out.dim(MARK.arrow)} ${out.cmd('riffet update')}`]);
  const lines = [heading, '', ...fields(rows)];
  if (options.readyMs !== undefined && network.length) lines.push('', hint('`riffet pair` connects a phone or another computer', out));
  return lines;
}

export async function status(options: { stateDir: string; json?: boolean }): Promise<void> {
  const dir = stateDir(options.stateDir);
  const record = await active(dir);
  const starting = record ? undefined : startingServer(dir);
  const phase = starting && currentStartupPhase(join(dir, 'server.log'), starting.since);
  if (options.json) {
    if (!record) { printJson({ running: false, stateDir: dir, ...(starting ? { starting: { pid: starting.pid, since: new Date(starting.since).toISOString(), phase: phase ?? null } } : {}) }); return; }
    const state = await health(record);
    const counts = await sessionCounts(record, dir);
    printJson({
      running: true, pid: record.pid, version: state?.version ?? null, build: state?.build ?? null, startedAt: record.startedAt,
      url: serverUrl(record), host: record.host, port: record.port, network: networkUrls(record), auth: authenticated(record),
      managedBy: state?.managedBy ?? null, stateDir: dir, sessions: counts ?? null, update: availableUpdate(dir, state?.build) ?? null,
    });
    return;
  }
  if (starting) {
    printLines([`${out.accent(MARK.running)} ${out.bold('Riffet')} ${out.dim(`starting · ${phaseLabel(phase)} · ${duration(Date.now() - starting.since)}`)}`, '', ...fields([['Process', `pid ${starting.pid}`], ['State', tilde(dir)]]), '', hint('riffet logs -f', out)]);
    return;
  }
  if (!record) {
    printLines([`${out.dim(MARK.stopped)} ${out.bold('Riffet')} ${out.dim('is not running')}`, '', ...fields([['State', tilde(dir)]]), '', hint('riffet start', out)]);
    return;
  }
  printLines(await serverSummary(record, dir, { detail: true }));
}
