import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import type { NativeBackendHost } from '../types.js';

/** Backends whose TUI joins a shared app-server with `--remote <endpoint> … resume <thread>`. */
export const APP_SERVER_BACKEND_IDS: ReadonlySet<string> = new Set(['codex', 'traex']);

export interface CodexInvocation {
  cwd: string;
  threadId: string;
  endpoint: string;
}

/**
 * Read the identity from Codex's actual argv. These three values are enough to bind a TUI to the
 * exact Riffet conversation and remote app-server without persisting the remote address itself.
 */
export function codexInvocation(argv: readonly string[], cwd: string, threadId: string): CodexInvocation | undefined {
  if (!argv.length || !threadId || !cwd || !looksLikeCodex(argv)) return undefined;

  const remoteValues: string[] = [];
  const cdValues: string[] = [];
  const resumes: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--remote') {
      const value = argv[++index];
      if (value === undefined) return undefined;
      remoteValues.push(value);
    } else if (arg.startsWith('--remote=')) {
      remoteValues.push(arg.slice('--remote='.length));
    } else if (arg === '--cd') {
      const value = argv[++index];
      if (value === undefined) return undefined;
      cdValues.push(value);
    } else if (arg.startsWith('--cd=')) {
      cdValues.push(arg.slice('--cd='.length));
    } else if (arg === 'resume') {
      const value = argv[++index];
      if (value === undefined) return undefined;
      resumes.push(value);
    }
  }

  if (remoteValues.length !== 1 || cdValues.length !== 1 || resumes.length !== 1) return undefined;
  const endpoint = remoteValues[0]!;
  if (!isAppServerEndpoint(endpoint) || cdValues[0] !== cwd || resumes[0] !== threadId) return undefined;
  return { cwd, threadId, endpoint };
}

/** Opaque, secret-free tmux marker. The endpoint is hashed and never stored in tmux metadata. */
export function codexInvocationFingerprint(invocation: CodexInvocation): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, ...invocation })).digest('hex');
}

/** One deadline covers the process tree and its argv/cwd verification. */
const LOOKUP_BUDGET_MS = 5000;

/**
 * Finds the app-server endpoint used by the Codex TUI inside this conversation's own linked
 * terminal. It never starts, resumes, stops or signals Codex. Any doubt (another thread, a stale
 * launch marker, two endpoints) answers `undefined`.
 *
 * A pane still running the process Riffet launched with `expected` answers from its launch record
 * alone: one shared tmux read, rather than a process-tree scan per conversation that a busy tmux
 * server or event loop turns into a timeout once several run at once. Anything else is scanned, and
 * a pane whose own process the scan matched gets that record for its next check.
 */
export async function codexTerminalEndpoint(
  host: Pick<NativeBackendHost, 'getSession' | 'getProject' | 'terminal'>,
  sessionId: string, terminalId: string, threadId: string, cwd: string, expected?: string,
): Promise<string | undefined> {
  const linked = () => {
    const session = host.getSession(sessionId);
    return session.kind === 'native' && APP_SERVER_BACKEND_IDS.has(session.backendId ?? '')
      && session.nativeSessionId === threadId && session.terminalId === terminalId;
  };
  if (expected && isAppServerEndpoint(expected) && host.terminal.paneLaunchMarker) {
    try {
      if (linked() && resolve(cwd) === resolve(host.getProject(host.getSession(sessionId).projectId).cwd)) {
        const marker = await host.terminal.paneLaunchMarker(terminalId, sessionId);
        if (marker && marker === codexInvocationFingerprint({ cwd, threadId, endpoint: expected }) && linked()) return expected;
      }
    } catch { /* The scan below decides. */ }
  }
  const deadline = Date.now() + LOOKUP_BUDGET_MS;
  const inspect = host.terminal.inspectPane;
  if (!inspect) return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!linked() || resolve(cwd) !== resolve(host.getProject(host.getSession(sessionId).projectId).cwd)) return undefined;
    const processes = await Promise.race([
      inspect.call(host.terminal, terminalId, sessionId, {
        deadline,
        select: (argv, marker) => {
          const invocation = codexInvocation(argv, cwd, threadId);
          return Boolean(invocation && (!marker || marker === codexInvocationFingerprint(invocation)));
        },
      }),
      new Promise<undefined>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout(undefined), Math.max(1, deadline - Date.now()));
        timer.unref();
      }),
    ]);
    if (!processes || Date.now() >= deadline || !linked()) return undefined;
    const endpoints = new Set(processes.map(({ argv }) => codexInvocation(argv, cwd, threadId)?.endpoint).filter(Boolean));
    if (endpoints.size !== 1) return undefined;
    const endpoint = [...endpoints][0]!;
    const root = processes.find(item => item.root);
    const invocation = root && codexInvocation(root.argv, cwd, threadId);
    if (invocation && host.terminal.adoptPaneLaunch) {
      await host.terminal.adoptPaneLaunch(terminalId, sessionId, codexInvocationFingerprint(invocation), root.pid).catch(() => undefined);
    }
    return endpoint;
  } catch {
    // This is an advisory recovery hint. Permission errors, races, and stale tmux metadata
    // must not interfere with the session's normal recovery path.
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function looksLikeCodex(argv: readonly string[]): boolean {
  const executable = basename(argv[0] ?? '').toLowerCase();
  if (['codex', 'codex.exe', 'traex', 'traecli'].includes(executable)) return true;
  // Include npm's Node launcher form, but only when the executable itself is Node and its script
  // is the Codex launcher. An arbitrary process with a later argument named "codex" is not enough.
  const nodeExecutable = executable === 'node' || executable === 'node.exe';
  const launcher = basename(argv[1] ?? '').toLowerCase();
  return nodeExecutable && (launcher === 'codex' || launcher === 'codex.js');
}

/** A private app-server endpoint: an absolute Unix socket, or an authenticated loopback port. */
function isAppServerEndpoint(endpoint: string): boolean {
  if (/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(endpoint)) return true;
  return isAbsoluteUnixSocketEndpoint(endpoint);
}

function isAbsoluteUnixSocketEndpoint(endpoint: string): boolean {
  if (!endpoint.startsWith('unix://') || endpoint.includes('?') || endpoint.includes('#') || /[\0\r\n]/.test(endpoint)) return false;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'unix:' || parsed.hostname || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return false;
    return isAbsolute(decodeURIComponent(parsed.pathname));
  } catch { return false; }
}
