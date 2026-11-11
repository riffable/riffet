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

/** Overall budget for one lookup; the terminal caps each command inside it. */
const LOOKUP_BUDGET_MS = 4000;

/**
 * Finds the app-server endpoint used by the Codex TUI inside this conversation's own linked
 * terminal. It only observes the pane's process tree; it never starts, resumes, stops or signals
 * Codex. Any doubt (another thread, a stale launch marker, two endpoints) answers `undefined`.
 */
export async function codexTerminalEndpoint(
  host: Pick<NativeBackendHost, 'getSession' | 'getProject' | 'terminal'>,
  sessionId: string, terminalId: string, threadId: string, cwd: string,
): Promise<string | undefined> {
  const deadline = Date.now() + LOOKUP_BUDGET_MS;
  const inspect = host.terminal.inspectPane;
  if (!inspect) return undefined;
  try {
    const linked = () => {
      const session = host.getSession(sessionId);
      return session.kind === 'native' && APP_SERVER_BACKEND_IDS.has(session.backendId ?? '')
        && session.nativeSessionId === threadId && session.terminalId === terminalId;
    };
    if (!linked() || resolve(cwd) !== resolve(host.getProject(host.getSession(sessionId).projectId).cwd)) return undefined;
    const processes = await inspect.call(host.terminal, terminalId, sessionId, {
      deadline,
      select: (argv, marker) => {
        const invocation = codexInvocation(argv, cwd, threadId);
        return Boolean(invocation && (!marker || marker === codexInvocationFingerprint(invocation)));
      },
    });
    if (!processes || !linked()) return undefined;
    const endpoints = new Set(processes.map(({ argv }) => codexInvocation(argv, cwd, threadId)?.endpoint).filter(Boolean));
    return endpoints.size === 1 ? [...endpoints][0] : undefined;
  } catch {
    // This is an advisory recovery hint. Permission errors, races, and stale tmux metadata
    // must not interfere with the session's normal recovery path.
    return undefined;
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
