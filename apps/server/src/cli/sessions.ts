import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { Project, Session } from '../../../../packages/contracts/src/index.js';
import { Api } from './api.js';
import { accessToken, requireActive, stateDir, type DaemonRecord } from './context.js';
import { Cancelled, CliError, MARK, UsageError, ago, columns, err, interactive, note, out, printJson, printLines, truncate, type Paint } from './ui.js';

interface Launch { command: string; args: string[]; env?: Record<string, string>; secretEnv?: Record<string, string>; cwd: string }

const here = () => { try { return realpathSync(process.cwd()); } catch { return process.cwd(); } };
const activityOf = (session: Session) => Date.parse(session.lastActivityAt ?? session.updatedAt);

interface Listing { api: Api; sessions: Session[]; projects: Map<string, Project>; scoped: boolean }

/**
 * Native conversations, newest first: this directory's project unless `all`, falling back to every
 * project when this directory has none.
 */
async function load(record: DaemonRecord, token: string, all: boolean): Promise<Listing> {
  const api = await Api.login(record, token);
  const [sessions, projects] = await Promise.all([api.call<Session[]>('GET', '/api/sessions'), api.call<Project[]>('GET', '/api/projects')]);
  const usable = sessions.filter(session => session.kind === 'native' && !session.archivedAt).sort((a, b) => activityOf(b) - activityOf(a));
  const byId = new Map(projects.map(project => [project.id, project]));
  if (all) return { api, sessions: usable, projects: byId, scoped: false };
  const cwd = here();
  const local = usable.filter(session => byId.get(session.projectId)?.cwd === cwd);
  return local.length ? { api, sessions: local, projects: byId, scoped: true } : { api, sessions: usable, projects: byId, scoped: false };
}

/** A state as one colored mark: what needs the reader stands out, idle conversations recede. */
function stateMark(session: Session, p: Paint = out): string {
  switch (session.state) {
    case 'running': case 'starting': case 'cancelling': return p.accent(MARK.running);
    case 'waiting': return p.warn(MARK.running);
    case 'failed': case 'interrupted': return p.fail(MARK.running);
    default: return p.dim(MARK.stopped);
  }
}

const agentOf = (session: Session) => session.backendId ?? 'cursor';
const titleOf = (session: Session) => (session.displayTitle ?? session.title).trim() || 'Untitled';

function match(sessions: Session[], target: string): Session[] {
  const exact = sessions.filter(session => session.id === target || session.nativeSessionId === target);
  if (exact.length) return exact;
  const lower = target.toLowerCase();
  return sessions.filter(session => session.title.toLowerCase().includes(lower) || Boolean(session.displayTitle?.toLowerCase().includes(lower)) || session.id.startsWith(target) || session.nativeSessionId?.startsWith(target));
}

/** `riffet ls`. */
export async function list(options: { stateDir: string; all?: boolean; limit?: string; json?: boolean }): Promise<void> {
  const limit = options.limit === undefined ? 20 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit takes a positive whole number');
  const dir = stateDir(options.stateDir);
  const { sessions, projects, scoped } = await load(await requireActive(dir), accessToken(dir), Boolean(options.all));
  const shown = sessions.slice(0, limit);
  if (options.json) {
    printJson(shown.map(session => ({
      id: session.id, title: titleOf(session), state: session.state, agent: agentOf(session), model: session.model ?? null,
      project: projects.get(session.projectId)?.name ?? null, cwd: projects.get(session.projectId)?.cwd ?? null,
      nativeSessionId: session.nativeSessionId ?? null, lastActivityAt: session.lastActivityAt ?? session.updatedAt,
    })));
    return;
  }
  if (!shown.length) { note('No conversations yet'); return; }
  const titleCells = Math.max(24, Math.min(56, (process.stdout.columns ?? 100) - 60));
  printLines(columns(shown.map(session => [
    stateMark(session),
    out.dim(session.id.slice(0, 8)),
    truncate(titleOf(session), titleCells),
    ...(scoped ? [] : [out.dim(truncate(projects.get(session.projectId)?.name ?? '', 18))]),
    out.tag(agentOf(session)),
    out.dim(ago(session.lastActivityAt ?? session.updatedAt)),
  ])));
  const more = sessions.length - shown.length;
  if (more > 0 || scoped) note(`${more > 0 ? `${more} more · ` : ''}${scoped ? '`riffet ls --all` for every project' : '`riffet ls --limit <n>`'}`);
}

/** In a terminal, a searchable list; elsewhere the caller has to name the conversation. */
async function pick(listing: Listing, initial?: string): Promise<Session> {
  const { autocomplete, isCancel } = await import('@clack/prompts');
  // The prompt draws its own selection marks, so a conversation's state is a word in the hint, not another mark.
  const stateWord = (session: Session) => ({ running: 'running', starting: 'running', cancelling: 'running', waiting: 'waiting for you', failed: 'failed', interrupted: 'interrupted' } as Partial<Record<Session['state'], string>>)[session.state];
  const label = (session: Session) => truncate(titleOf(session), 60);
  const hintOf = (session: Session) => [stateWord(session), listing.scoped ? undefined : listing.projects.get(session.projectId)?.name, agentOf(session), ago(session.lastActivityAt ?? session.updatedAt)].filter(Boolean).join(' · ');
  const haystack = new Map(listing.sessions.map(session => [session.id, `${session.displayTitle ?? ''} ${session.title} ${listing.projects.get(session.projectId)?.name ?? ''} ${agentOf(session)} ${session.id}`.toLowerCase()]));
  const chosen = await autocomplete({
    message: listing.scoped ? 'Continue which conversation in this project?' : 'Continue which conversation?',
    options: listing.sessions.slice(0, 200).map(session => ({ value: session.id, label: label(session), hint: hintOf(session) })),
    placeholder: 'Type to filter',
    maxItems: 10,
    output: process.stderr,
    ...(initial ? { initialUserInput: initial } : {}),
    filter: (search, option) => search.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.get(option.value as string)?.includes(word) ?? false),
  });
  if (isCancel(chosen)) throw new Cancelled();
  return listing.sessions.find(session => session.id === chosen)!;
}

/**
 * `riffet resume`: hands a Riffet conversation to this terminal as its only writer, runs the provider's
 * own CLI on it here, and hands it back when that CLI exits (docs/TERMINAL-SESSIONS.md).
 */
export async function resume(options: { stateDir: string; all?: boolean }, target?: string): Promise<number> {
  const dir = stateDir(options.stateDir);
  const record = await requireActive(dir);
  const listing = await load(record, accessToken(dir), Boolean(options.all) || Boolean(target));
  if (!listing.sessions.length) throw new CliError('There are no conversations to continue');
  let session: Session;
  const candidates = target ? match(listing.sessions, target) : listing.sessions;
  if (target && !candidates.length) throw new CliError(`No conversation matches "${target}"`, ['riffet ls --all']);
  if (candidates.length === 1 && target) session = candidates[0]!;
  else if (interactive()) session = await pick(target ? { ...listing, sessions: candidates } : listing);
  else throw new UsageError(target ? `"${target}" matches ${candidates.length} conversations; give its id` : 'Name the conversation to continue', ['riffet ls']);
  return handOver(listing.api, session);
}

async function handOver(api: Api, session: Session): Promise<number> {
  const path = `/api/sessions/${encodeURIComponent(session.id)}/terminal-hold`;
  const { launch, token: holdToken } = await api.call<{ session: Session; launch: Launch; token: string }>('POST', path);
  // `force` only for a hold this process never named a CLI for: the server reads one without a pid as still starting.
  const release = async (force = false) => { await api.call('DELETE', path + (force ? '?force=1' : '')).catch(() => undefined); };
  process.stderr.write(`${err.accent(MARK.arrow)} ${err.bold(titleOf(session))} ${err.dim(`· ${agentOf(session)} · Riffet follows it until this exits · riffet resume ${session.id.slice(0, 8)}`)}\n`);
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { ...process.env, ...launch.env, ...launch.secretEnv }, stdio: 'inherit' });
  // Listened for before anything is awaited: a CLI that exits at once must still end the wait.
  const exited = new Promise<number>(resolve => child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1))));
  const started = new Promise<boolean>(resolve => { child.once('spawn', () => resolve(true)); child.once('error', () => resolve(false)); });
  // Ctrl+C belongs to the CLI in the foreground; this process only waits for it.
  const ignore = () => undefined;
  process.on('SIGINT', ignore);
  try {
    if (!await started || !child.pid) { await release(true); throw new CliError(`Could not start ${launch.command}`, ['riffet doctor']); }
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
    process.stderr.write(`${err.ok(MARK.ok)} ${err.dim('Back in Riffet:')} ${titleOf(session)}\n`);
    return code;
  } finally { process.off('SIGINT', ignore); }
}
