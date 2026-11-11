import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { Project, Session } from '../../../packages/contracts/src/index.js';
import { localServerUrl, type PairingDaemon } from './cli-pairing.js';

interface Launch { command: string; args: string[]; env?: Record<string, string>; secretEnv?: Record<string, string>; cwd: string }

class Api {
  private constructor(private readonly base: string, private readonly headers: Record<string, string>) {}

  static async login(record: PairingDaemon, token: string): Promise<Api> {
    const base = localServerUrl(record);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(3000) });
    if (!login.ok) throw new Error(`Could not authenticate with the running server (HTTP ${login.status}); check the selected --state-dir.`);
    const { csrfToken } = await login.json() as { csrfToken?: unknown };
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value?.startsWith('cw_session='));
    if (typeof csrfToken !== 'string' || !cookie) throw new Error('The running server did not return a login session.');
    return new Api(base, { cookie, 'x-csrf-token': csrfToken });
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.base + path, {
      method, headers: { ...this.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
    });
    const value = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
    if (!response.ok) throw new Error(value?.error?.message ?? `HTTP ${response.status}`);
    return value as T;
  }
}

const here = () => { try { return realpathSync(process.cwd()); } catch { return process.cwd(); } };

function match(sessions: Session[], target: string): Session {
  const exact = sessions.find(session => session.id === target || session.nativeSessionId === target);
  if (exact) return exact;
  const lower = target.toLowerCase();
  const named = sessions.filter(session => session.title.toLowerCase().includes(lower) || session.id.startsWith(target) || session.nativeSessionId?.startsWith(target));
  if (named.length === 1) return named[0]!;
  if (!named.length) throw new Error(`No conversation matches "${target}".`);
  throw new Error(`"${target}" matches ${named.length} conversations; use its id.\n${named.slice(0, 10).map(session => `  ${session.id}  ${session.title}`).join('\n')}`);
}

async function pick(sessions: Session[], projects: Map<string, Project>, all: boolean): Promise<Session> {
  const cwd = here();
  const candidates = sessions.filter(session => all || projects.get(session.projectId)?.cwd === cwd).slice(0, 30);
  if (!candidates.length) throw new Error(all ? 'There are no conversations to continue.' : 'No conversation runs in this directory; pass an id, or --all.');
  candidates.forEach((session, index) => {
    const where = all ? `  ${projects.get(session.projectId)?.name ?? ''}` : '';
    console.log(`${String(index + 1).padStart(2)}  ${session.title}${where}  · ${session.backendId ?? ''}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = Number.parseInt((await rl.question('Continue which? ')).trim(), 10);
    const chosen = candidates[answer - 1];
    if (!chosen) throw new Error('Nothing chosen.');
    return chosen;
  } finally { rl.close(); }
}

/**
 * `riffet resume`: hands a Riffet conversation to this terminal as its only writer, runs the provider's
 * own CLI on it here, and hands it back when that CLI exits (docs/TERMINAL-SESSIONS.md).
 */
export async function resumeInTerminal(record: PairingDaemon, token: string, options: { target?: string; all?: boolean }): Promise<number> {
  const api = await Api.login(record, token);
  const [sessions, projects] = await Promise.all([api.call<Session[]>('GET', '/api/sessions'), api.call<Project[]>('GET', '/api/projects')]);
  const usable = sessions.filter(session => session.kind === 'native' && !session.archivedAt)
    .sort((a, b) => Date.parse(b.lastActivityAt ?? b.updatedAt) - Date.parse(a.lastActivityAt ?? a.updatedAt));
  const byId = new Map(projects.map(project => [project.id, project]));
  const session = options.target ? match(usable, options.target) : await pick(usable, byId, Boolean(options.all));
  const { launch, token: holdToken } = await api.call<{ session: Session; launch: Launch; token: string }>('POST', `/api/sessions/${encodeURIComponent(session.id)}/terminal-hold`);
  const path = `/api/sessions/${encodeURIComponent(session.id)}/terminal-hold`;
  // `force` only for a hold this process never named a CLI for: the server reads one without a pid as still starting.
  const release = async (force = false) => { await api.call('DELETE', path + (force ? '?force=1' : '')).catch(() => undefined); };
  console.log(`Continuing "${session.title}" here; Riffet follows it until this exits.`);
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { ...process.env, ...launch.env, ...launch.secretEnv }, stdio: 'inherit' });
  // Listened for before anything is awaited: a CLI that exits at once must still end the wait.
  const exited = new Promise<number>(resolve => child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1))));
  const started = new Promise<boolean>(resolve => { child.once('spawn', () => resolve(true)); child.once('error', () => resolve(false)); });
  // Ctrl+C belongs to the CLI in the foreground; this process only waits for it.
  const ignore = () => undefined;
  process.on('SIGINT', ignore);
  try {
    if (!await started || !child.pid) { await release(true); throw new Error(`Could not start ${launch.command}.`); }
    try {
      await api.call('PATCH', path, { pid: child.pid, token: holdToken });
    } catch (error) {
      // Unnamed, the hold would lapse while this CLI still writes; stop it rather than leave two writers.
      child.kill('SIGTERM');
      await exited;
      await release(true);
      throw error;
    }
    const code = await exited;
    await release();
    return code;
  } finally { process.off('SIGINT', ignore); }
}
