import { relative, isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkItemCommand, WorkItemEvidence } from '../../../../packages/contracts/src/index.js';

const MAX_COMMANDS = 30;
const MAX_FILES = 200;
const COMMAND_CHARS = 300;

interface ToolData {
  kind?: unknown; status?: unknown; title?: unknown; command?: unknown; exitCode?: unknown;
  rawInput?: unknown; locations?: unknown; content?: unknown; jobResult?: unknown;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The first text block of a tool result, where several CLIs put "Exit code N". */
function firstText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    const text = record(record(block)?.content)?.text;
    if (typeof text === 'string') return text;
  }
  return '';
}

/**
 * What one command came to, from what its CLI reported: Codex and TraeX give `exitCode`, Cursor a
 * job result; Claude Code starts a failed result with "Exit code N" and Antigravity says "exited with
 * code N". Anything else is the CLI's own success or failure.
 */
export function commandResult(data: ToolData): Pick<WorkItemCommand, 'result' | 'exitCode'> | undefined {
  const code = typeof data.exitCode === 'number' ? data.exitCode
    : typeof record(data.jobResult)?.exitCode === 'number' ? record(data.jobResult)!.exitCode as number
      : undefined;
  if (code !== undefined) return { result: code === 0 ? 'ok' : 'failed', exitCode: code };
  if (data.status === 'completed') return { result: 'ok' };
  if (data.status !== 'failed') return undefined;
  const said = /^Exit code (\d+)/.exec(firstText(data.content)) ?? /exited with code (\d+)/.exec(firstText(data.content));
  return said ? { result: 'failed', exitCode: Number(said[1]) } : { result: 'failed' };
}

function commandText(data: ToolData): string | undefined {
  const raw = typeof data.command === 'string' ? data.command
    : typeof record(data.rawInput)?.command === 'string' ? record(data.rawInput)!.command as string
      : typeof data.title === 'string' ? data.title : undefined;
  const text = raw?.trim();
  return text ? (text.length > COMMAND_CHARS ? `${text.slice(0, COMMAND_CHARS)}…` : text) : undefined;
}

/** Programs that only look: a command made of nothing else shows the reviewer nothing about the result. */
const LOOKING = new Set(['ls', 'cat', 'head', 'tail', 'less', 'grep', 'rg', 'ag', 'find', 'fd', 'tree', 'wc', 'pwd', 'cd', 'echo', 'printf', 'stat', 'file', 'which', 'type', 'nl', 'diff', 'true', 'sleep']);
const LOOKING_GIT = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'remote']);

/** Whether every step of [command] only reads (`ls && cat a`, `git status; git diff`, `sed -n 1,9p a`). */
export function onlyLooks(command: string): boolean {
  // Quoted text is an argument, never a step: `grep "a\|b" src | wc -l` is two steps.
  const bare = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, 'ARG');
  return bare.split(/&&|\|\||[;|\n]/).every((step) => {
    const words = step.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const program = words[0] ?? '';
    if (!program || program.startsWith('2>') || program.startsWith('>')) return true;
    // `git -C dir log`: the subcommand is the first word that is neither an option nor an option's value.
    if (program === 'git') return LOOKING_GIT.has(words.find((word, index) => index > 0 && !word.startsWith('-') && !['-C', '-c'].includes(words[index - 1]!)) ?? '');
    if (program === 'sed') return words.includes('-n') && !words.some((word) => word.startsWith('-i'));
    return LOOKING.has(program);
  });
}

function editedPaths(data: ToolData): string[] {
  const paths = new Set<string>();
  if (Array.isArray(data.locations)) for (const location of data.locations) { const path = record(location)?.path; if (typeof path === 'string') paths.add(path); }
  const input = record(data.rawInput);
  for (const key of ['file_path', 'path', 'filePath']) if (typeof input?.[key] === 'string') paths.add(input[key] as string);
  const changes = record(input?.changes);
  if (changes) for (const path of Object.keys(changes)) paths.add(path);
  return [...paths];
}

/**
 * The evidence of a submission (docs/TASK-BOARD.md §6), read from the conversations' own journals: each
 * tool call's start says what it was, its updates how it ended. Subagent lanes count as the conversation's
 * own work. Paths inside `cwd` are shown relative to it. An oversized event is kept as a preview, which
 * still has the scalar fields (status, exit code, command) this reads.
 */
export function collectEvidence(db: DatabaseSync, sessionIds: readonly string[], since: string, cwd?: string): WorkItemEvidence {
  const select = db.prepare(`SELECT session_id, at, payload FROM journal_events
      WHERE (session_id=? OR (session_id>? AND session_id<?)) AND kind IN ('tool_call','tool_call_update') AND at>=? ORDER BY session_id, seq`);
  const calls = new Map<string, { sessionId: string; at: string; data: ToolData }>();
  for (const sessionId of sessionIds) {
    const rows = select.all(sessionId, `${sessionId}#sub:`, `${sessionId}#sub;`, since) as Array<{ session_id: string; at: string; payload: string }>;
    for (const row of rows) {
      if (row.session_id.endsWith('#tail')) continue;
      let data: Record<string, unknown> | undefined;
      try { data = record(record(JSON.parse(row.payload))?.data); } catch { continue; }
      const id = typeof data?.toolCallId === 'string' ? `${row.session_id}\u0000${data.toolCallId}` : undefined;
      if (!data || !id) continue;
      const known = calls.get(id);
      // Updates carry only what changed: a field they leave out keeps what the start said.
      const fields = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null));
      if (known) Object.assign(known.data, fields);
      else calls.set(id, { sessionId, at: row.at, data: fields as ToolData });
    }
  }
  const files = new Set<string>();
  const latest = new Map<string, WorkItemCommand>();
  for (const call of [...calls.values()].sort((a, b) => a.at.localeCompare(b.at))) {
    const { data } = call;
    if (data.kind === 'edit') {
      for (const path of editedPaths(data)) {
        const shown = cwd && isAbsolute(path) && !relative(cwd, path).startsWith('..') ? relative(cwd, path) : path;
        if (files.size < MAX_FILES) files.add(shown);
      }
    } else if (data.kind === 'execute') {
      const command = commandText(data);
      const result = commandResult(data);
      if (!command || !result || onlyLooks(command)) continue;
      // A command run again replaces its earlier result: the latest one is what counts.
      latest.delete(command);
      latest.set(command, { command, ...result, sessionId: call.sessionId, at: call.at });
    }
  }
  return { files: [...files].sort(), commands: [...latest.values()].slice(-MAX_COMMANDS) };
}
