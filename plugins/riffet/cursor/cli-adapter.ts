import { homedir } from 'os';
import { join } from 'path';
import type { ApprovalMode } from '@contracts';
import { stripTerminalSequences, type CliVersionRange } from '@riffet/plugin-api/kit';
import { approvalArgs } from './cli-driver.js';

/**
 * cursor-agent's date versions carry a build id (`2026.10.01-e373342`). No release is known to
 * break the adapter; the newest verified is from docs/STEER.md.
 */
export const CURSOR_CLI_VERSIONS: CliVersionRange = { testedThrough: '2026.10.01' };

/** How the terminal driver launches cursor-agent and finds the file an accepted turn is appended to. */
export interface CursorAgentAdapter {
  readonly id: string;
  /** Composer-ready regex, printed once the input box accepts text. */
  readonly readyPattern: RegExp;
  /** The CLI's own working marker, present while a turn is executing. */
  readonly busyPattern: RegExp;
  /** The launch argv for the flags the caller owns; `hasStoredSession` says the caller already resumes the session explicitly. */
  buildArgs(input: {
    readonly resumePicker?: boolean;
    readonly hasStoredSession?: boolean;
    readonly mode?: string;
    readonly approval?: string;
    readonly model?: string;
    readonly initialPrompt?: string;
  }): string[];
  readonly initialPrompt: { readonly passesInitialPromptViaArgs: boolean; readonly requiredArgs: readonly string[] };
  readonly transcript: {
    transcriptPath(cwd: string, cursorSessionId: string): string;
    /** Substrings that must appear in a newly appended JSONL slice to count as a submit. */
    readonly submitMarkers: readonly string[];
    readonly turnEndMarker: string;
  };
}

/**
 * Translate an absolute cwd into the slug that cursor-agent uses inside `~/.cursor/projects/…`.
 * The CLI replaces slashes with dashes and drops the leading separator, so
 * `/srv/home/alice/project` becomes `srv-home-alice-project`. The slug is stable because
 * it only depends on the directory path, not on the OS user or shell.
 */
export function cursorAgentProjectSlug(cwd: string): string {
  return cwd.replace(/^\/+/, '').replace(/\//g, '-');
}

/**
 * Resolve the per-session JSONL that cursor-agent appends every accepted user turn to. The
 * dispatcher polls this file size + tail content for a Phase-2 submit confirmation that is
 * stronger than the TUI screen echo: the CLI only writes here after the agent has accepted the
 * prompt, so a size growth plus a user-text marker is proof that the message is in flight.
 */
export function cursorAgentTranscriptPath(cwd: string, cursorSessionId: string): string {
  return join(homedir(), '.cursor', 'projects', cursorAgentProjectSlug(cwd), 'agent-transcripts', cursorSessionId, `${cursorSessionId}.jsonl`);
}

export const CURSOR_AGENT_READY_PATTERN = /→\s+(?:Add a follow-up|Plan, search, build anything)/;
// The prompt bar itself while empty: cursor-agent replaces the placeholder completely once any
// character is entered, whereas status hints (e.g. `ctrl+r to review changed files`) can sit on
// separate rows below it without making the composer non-empty.
const CURSOR_PROMPT_EMPTY_LINE = /^\s*→\s+(?:Add a follow-up(?:\s+—\s+\/plan to review and build)?|Plan, search, build anything)(?:\s+ctrl\+c to stop)?\s*$/;
const CURSOR_IMAGE_PLACEHOLDER_PATTERN = /\[Image #\d+\]/;
const ATTACHMENT_PATH_LINE = /^\s*\/[^\s/]+\/\S+\s*$/;
// The footer prints the active model and a running percentage while a turn is in flight. The
// `ctrl+c to stop` hint is appended on busy frames and is a stable marker across versions.
export const CURSOR_AGENT_BUSY_PATTERN = /ctrl\+c\s+to\s+stop/i;

/** Only explicit CLI failures before its first prompt belong to the startup error notice. */
export function cursorAgentStartupError(output: string): string | undefined {
  // OSC/DCS strings must go before lines are matched, not after: tmux's client brackets pane text
  // with `ESC P … ESC \`, and `stripVTControlCharacters` keeps the payload while dropping the
  // introducer, gluing it to the front of the line so the anchored match below never fires.
  const text = stripTerminalSequences(output);
  if (CURSOR_AGENT_READY_PATTERN.test(text) || CURSOR_AGENT_BUSY_PATTERN.test(text)) return undefined;
  const line = text.split('\n').map(line => line.trim()).find(line =>
    /^(?:Cannot\b|Unable to\b|Failed\b|(?:\w*Error)(?:\s*\[[^\]]+\])?:|error:|Unauthorized\b|Forbidden\b|Not authenticated\b|Authentication (?:failed|required)\b)/i.test(line));
  if (!line) return undefined;
  // The model error appends the entire catalog. Keep the actual rejection, not pages of ids.
  const reason = line.split(/\s+Available models:/i)[0]!.slice(0, 800);
  return `Cursor 启动失败：${reason}${/^Cannot use this model:/i.test(reason) ? ' 请在模型菜单中重新选择可用模型后重试。' : ''}`;
}

/**
 * How much of a prompt is compared against the prompt bar. Long enough that a match cannot be a
 * coincidence, short enough that a narrow pane's wrap still shows it.
 */
const PROMPT_BAR_PROMPT_CHARS = 16;

/**
 * The prompt bar lines: the `→` line and any continuation lines above the model/permission footer.
 *
 * Only the bar counts, and it is found the way `native/screen.ts` finds it: the last `→` line above
 * the footer, because pickers mark their current row with the same character further up the frame.
 */
function cursorPromptBarLines(screen: string): string[] | undefined {
  const lines = screen.split('\n').map(line => line.replace(/\s+$/, '')).filter(line => line.trim());
  const tail = lines.slice(-14);
  let footer = -1;
  for (let index = tail.length - 2; index >= 0; index -= 1) {
    if (/^\s{1,4}(?:~(?=$|\s|\/)|\/(?![/*])\S)/.test(tail[index + 1]!) && !/^\s*→/.test(tail[index]!)) { footer = index; break; }
  }
  if (footer < 0) return undefined;
  const floor = Math.max(0, footer - 8);
  for (let index = footer - 1; index >= floor; index -= 1) {
    if (/^\s*→/.test(tail[index]!)) return tail.slice(index, footer);
  }
  return undefined;
}

/**
 * The prompt bar: the `→` line the CLI keeps just above its model/permission footer.
 *
 * It carries the placeholder while empty and the reader's own draft while one is pending. A prompt
 * the CLI has taken leaves it immediately — measured at +50 ms on 2026.09.28 — so the bar is the
 * honest answer to "did that write land?", the same question Claude Code's composer answers.
 */
export function cursorPromptBar(screen: string): string | undefined {
  return cursorPromptBarLines(screen)?.[0];
}

/** Whether the prompt bar itself currently shows cursor-agent's empty placeholder. */
export function cursorPromptBarEmpty(screen: string): boolean {
  const bar = cursorPromptBar(screen);
  return bar !== undefined && CURSOR_PROMPT_EMPTY_LINE.test(bar);
}

/**
 * Whether the prompt bar still holds a prompt that was written into it.
 *
 * The bar keeps the placeholder — `→ Add a follow-up` — while nothing is pending, so text where the
 * placeholder belongs is text the CLI never took. Whitespace is ignored on both sides: the bar
 * re-wraps long drafts to the pane width and places continuation lines (such as attachment paths)
 * below the `→` row. A draft taller than the bar's few rows is scrolled to its end, so the visible
 * rows then show a later stretch of the prompt rather than its opening.
 */
export function cursorComposerHoldsPrompt(screen: string, text: string): boolean {
  const barLines = cursorPromptBarLines(screen);
  const prompt = text.replace(/\s+/g, '');
  if (!barLines || !prompt) return false;
  const firstShown = barLines[0]!.replace(/^\s*→/, '').replace(/\s+/g, '');
  const fullShown = [barLines[0]!.replace(/^\s*→/, ''), ...barLines.slice(1)].join('').replace(/\s+/g, '');
  if (fullShown.includes(prompt.slice(0, PROMPT_BAR_PROMPT_CHARS))) return true;
  if (firstShown.length >= PROMPT_BAR_PROMPT_CHARS && prompt.includes(firstShown)) return true;
  if (barLines.slice(1).some(line => {
    const compact = line.replace(/\s+/g, '');
    return compact.length >= PROMPT_BAR_PROMPT_CHARS && prompt.includes(compact);
  })) return true;
  if (CURSOR_IMAGE_PLACEHOLDER_PATTERN.test(barLines.join('\n'))) {
    const lines = text.split(/\r?\n/);
    if (lines.some(line => ATTACHMENT_PATH_LINE.test(line))) {
      const own = lines.filter(line => !ATTACHMENT_PATH_LINE.test(line)).join('').replace(/\s+/g, '').slice(0, PROMPT_BAR_PROMPT_CHARS);
      return own.length === 0 || fullShown.includes(own);
    }
  }
  return false;
}

/** The single source of truth for how the Cursor plugin launches cursor-agent. */
export const cursorAgentAdapter: CursorAgentAdapter = {
  id: 'cursor-agent',
  readyPattern: CURSOR_AGENT_READY_PATTERN,
  busyPattern: CURSOR_AGENT_BUSY_PATTERN,
  initialPrompt: {
    passesInitialPromptViaArgs: true,
    // `--trust` lets the CLI read the positional argv without first prompting for a Yes/No; the
    // runtime adds it unconditionally today.
    requiredArgs: ['--trust'],
  },
  buildArgs({ resumePicker, hasStoredSession, mode, approval, model, initialPrompt }) {
    return [
      // A bare `--resume` opens the CLI's own picker. It is only useful when no stored id
      // exists; with one, TerminalService has already emitted `--resume <id>`.
      ...(resumePicker && !hasStoredSession ? ['--resume'] : []),
      '--trust',
      ...(mode === 'plan' || mode === 'ask' ? ['--mode', mode] : []),
      ...approvalArgs(approval as ApprovalMode | undefined),
      // The picker lets the user choose a session whose model is already recorded; forcing one
      // here would override it.
      ...(model && !resumePicker ? ['--model', model] : []),
      // cursor-agent treats everything after flags as the positional [prompt...]; one token
      // keeps the full composer text (including newlines) intact. `--` is a defence against any
      // future flag with the same leading dash as the user's content.
      ...(initialPrompt ? ['--', initialPrompt] : []),
    ];
  },
  transcript: {
    transcriptPath: cursorAgentTranscriptPath,
    // Each accepted turn appends a user-role JSON line whose content wraps the prompt in a
    // `<user_query>` sentinel after the timestamp. Matching the sentinel is the cheapest way to
    // distinguish a user turn from the agent's own JSON lines.
    // Match only the user-authored JSONL line prefix — avoids false positives on agent lines
    // that quote the user's query back in their response. The exact prefix is cursor-agent's
    // transcript writer contract (see `plans/replicated-gathering-hammock.md` fact-check).
    submitMarkers: ['"role":"user","message":{"content":[{"type":"text","text":"'],
    turnEndMarker: '"type":"turn_ended"',
  },
};
