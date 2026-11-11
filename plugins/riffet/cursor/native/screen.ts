import type { NativeStatus } from '@contracts';
import { CURSOR_AGENT_BUSY_PATTERN } from '../cli-adapter.js';

export interface ScreenState extends Omit<NativeStatus, 'phase'> {
  phase: 'busy' | 'idle' | 'attention';
  /** Whether the status/workspace footer is on screen; it is absent while the CLI is still booting. */
  footer: boolean;
  /**
   * The pane shows a subagent's own transcript (opened from the TUI) instead of the conversation.
   * Its footer hides the prompt bar and the busy hint, so the phase is only `working` or unknown.
   */
  subview?: { working: boolean };
  /** The error the CLI printed under the footer when a turn failed on Cursor's side; see [cliError]. */
  error?: string;
}

/**
 * The subagent view's last line, wrapped or not:
 *
 *     ⠠⠛ Working
 *     Subagent · <first words of its prompt>  ·  esc to go back
 *
 * and, once the subagent is done:
 *
 *     This subagent's live transcript is no longer available.
 *     esc to go back
 */
const SUBVIEW_TITLE = /^\s*Subagent\s+·/;
const SUBVIEW_BACK = /(?:·|^)\s*esc to go back\s*$/i;
const SUBVIEW_GONE = /^\s*This subagent's live transcript is no longer available\b/;
const SUBVIEW_WORKING = /^\s*[\u2800-\u28ff]+\s+Working\b/;

function parseSubview(tail: readonly string[]): ScreenState['subview'] {
  if (!SUBVIEW_BACK.test(tail.at(-1) ?? '')) return undefined;
  if (SUBVIEW_GONE.test(tail.at(-2) ?? '')) return { working: false };
  // A long prompt in a narrow pane wraps the title over several lines.
  const title = tail.findLastIndex(line => SUBVIEW_TITLE.test(line));
  if (title < 0) return undefined;
  return { working: tail.slice(Math.max(0, title - 3), title).some(line => SUBVIEW_WORKING.test(line)) };
}

/**
 * A turn that fails on Cursor's side (a gateway timeout, a dropped stream) ends with the prompt bar
 * back and the reason printed under the workspace line, wrapped over a few lines:
 *
 *     /path/to/project · main
 *     Error: Something went wrong. Please try again.
 *     [deadline_exceeded] bidi_append_deadline_exceeded: append seqno=0 (33932 bytes) exceeded 60518ms
 *     deadline
 *
 * Without it the turn just looks finished, with the answer missing.
 */
const CLI_ERROR = /^\s*Error:\s/;
const CLI_ERROR_LINES = 4;

function cliError(below: readonly string[]): string | undefined {
  const start = below.findIndex(line => CLI_ERROR.test(line));
  if (start < 0) return undefined;
  const text = below.slice(start, start + CLI_ERROR_LINES).map(line => line.trim()).join(' ').replace(/^Error:\s*/, '');
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

const WORKSPACE_LINE = /^\s{1,4}[~/]/;
const PROMPT_BAR = /^\s*→(\s|$)/;

/**
 * The spinner the CLI keeps right above the prompt bar while a turn is on, a tip line at most
 * between them:
 *
 *      ⠘⠆ Working
 *      ⠰⠳ Running  66 tokens
 *     → Add a follow-up                      ctrl+c to stop
 *
 * `ctrl+c to stop` alone does not say a turn is on: it is the prompt bar's placeholder, so it is
 * gone whenever the bar holds a draft, and it only appears once the request is in flight, a second
 * or more after the spinner. That earlier moment is a turn too: the CLI takes no prompt in it.
 */
const SPINNER_LINE = /^\s*[\u2800-\u28ff]{1,3}\s+\S/;

/** Whether the lines just above the prompt bar at [bar] carry the CLI's spinner. */
function spinnerAbove(tail: readonly string[], bar: number): boolean {
  return bar >= 0 && tail.slice(Math.max(0, bar - 3), bar).some(line => SPINNER_LINE.test(line));
}

/**
 * For about two seconds after a Ctrl+C the CLI prints this in place of the model and workspace
 * lines, while the prompt bar and the busy hint above it stay as they were:
 *
 *     → Add a follow-up                      ctrl+c to stop
 *     Press Ctrl+C again to exit
 *
 * Another Ctrl+C while it shows quits the CLI.
 */
const EXIT_HINT = /^\s*Press Ctrl\+C again to exit\s*$/i;

function exitHintPhase(tail: readonly string[]): ScreenState['phase'] | undefined {
  if (!EXIT_HINT.test(tail.at(-1) ?? '')) return undefined;
  const above = tail.slice(Math.max(0, tail.length - 7), -1);
  const bar = above.findLastIndex(line => PROMPT_BAR.test(line));
  if (bar < 0) return undefined;
  return above.some(line => CURSOR_AGENT_BUSY_PATTERN.test(line)) || spinnerAbove(above, bar) ? 'busy' : 'idle';
}

/**
 * The status line's index in [tail]: the line above the workspace line. A failed turn's error sits
 * below the footer and can wrap onto a path, which looks like a workspace line too, so a footer
 * right above an `Error:` line (with the prompt bar over it) wins over a lower look-alike.
 */
function statusLine(tail: readonly string[]): number {
  const error = tail.findLastIndex(line => CLI_ERROR.test(line));
  if (error >= 2 && WORKSPACE_LINE.test(tail[error - 1]!) && !/^\s*→/.test(tail[error - 2]!)
    && tail.slice(Math.max(0, error - 8), error - 2).some(line => PROMPT_BAR.test(line))) return error - 2;
  for (let index = tail.length - 2; index >= 0; index -= 1) {
    if (WORKSPACE_LINE.test(tail[index + 1]!) && !/^\s*→/.test(tail[index]!)) return index;
  }
  return -1;
}

/**
 * Reads the Cursor CLI's footer from a plain `capture-pane`. Only the bottom of the screen is
 * considered so transcript text that happens to contain the same words cannot flip the state:
 *
 *     → Add a follow-up                      ctrl+c to stop   ← prompt bar (+ hint while working)
 *     Claude Opus 5.5 300K High · 7.4%       Run Everything   ← model · context   permission
 *     /path/to/project · main                                 ← workspace line
 *
 * When a dialog (question, approval, picker) takes over, the prompt bar disappears; that is
 * the "attention" phase in which the user has to answer in the terminal itself. Pickers mark
 * their current row with the same `→`, so the prompt bar only counts right above the footer.
 */
export function parseScreen(text: string): ScreenState {
  const lines = text.split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim());
  const tail = lines.slice(-14);
  const status = statusLine(tail);
  if (status < 0) {
    // No footer to read the model or approval from, so those keep their last known values.
    const hinted = exitHintPhase(tail);
    if (hinted) return { phase: hinted, footer: false };
    const subview = parseSubview(tail);
    return { phase: 'attention', footer: false, ...(subview ? { subview } : {}) };
  }
  const [left, right] = tail[status]!.trim().split(/\s{3,}/);
  const model = left?.replace(/\s·\s\d+(?:\.\d+)?%(?:\s·.*)?$/, '').trim();
  const permission = right?.trim();
  const floor = Math.max(0, status - 6);
  const bar = tail.slice(floor, status).findLastIndex((line) => PROMPT_BAR.test(line));
  const busy = tail.slice(0, status).some((line) => CURSOR_AGENT_BUSY_PATTERN.test(line)) || spinnerAbove(tail, bar < 0 ? -1 : floor + bar);
  const error = cliError(tail.slice(status + 2));
  return { phase: busy ? 'busy' : bar >= 0 ? 'idle' : 'attention', footer: true, ...(model ? { model } : {}), ...(permission ? { permission } : {}), ...(error ? { error } : {}) };
}

/** The CLI is back at its own prompt (or busy at it): the footer is on screen. What `NativeInteractions` takes as an answer completed. */
export function promptSettled(text: string): boolean {
  const screen = parseScreen(text);
  return screen.footer && (screen.phase === 'idle' || screen.phase === 'busy');
}

/**
 * The CLI's own follow-up queue, drawn above the spinner while a turn runs:
 *
 *     ┌─ follow-ups ──────────────────────────────────────┐
 *     │○ make it a blue button instead · steering         │
 *     │ enter interrupt and send · ↑ select/edit · esc cancel │
 *     └───────────────────────────────────────────────────┘
 *
 * A prompt submitted while the CLI is processing lands here. Enter on an empty prompt bar then
 * escalates it: `steer` hands it to the running turn at its next tool call, `interrupt and send`
 * stops the turn and sends it, `send now` (no steering on the account) does that straight away.
 */
export interface FollowUps {
  /** The queued messages' visible text, joined; long ones are cut short with `…`. */
  text: string;
  /** What the next Enter on an empty prompt bar does to the first of them. */
  next?: 'steer' | 'interrupt' | 'send';
}

const FOLLOW_UPS_TOP = /^\s*┌─ follow-ups\b/;
const FOLLOW_UPS_BOTTOM = /^\s*└/;
const FOLLOW_UPS_HINT = /\benter (steer|interrupt and send|send now)\b|↑ to edit|editing · enter done/;

function followUps(lines: readonly string[]): FollowUps | undefined {
  const top = lines.findLastIndex(line => FOLLOW_UPS_TOP.test(line));
  if (top < 0) return undefined;
  const bottom = lines.findIndex((line, index) => index > top && FOLLOW_UPS_BOTTOM.test(line));
  // Only a box still standing over the prompt bar is the live queue, not one scrolled into history.
  if (bottom < 0 || !lines.slice(bottom + 1).some(line => PROMPT_BAR.test(line))) return undefined;
  const inner = lines.slice(top + 1, bottom).map(line => line.replace(/^\s*│/, '').replace(/│\s*$/, '').trim());
  const hint = inner.find(line => FOLLOW_UPS_HINT.test(line));
  const action = hint?.match(/\benter (steer|interrupt and send|send now)\b/)?.[1];
  const text = inner.filter(line => line !== hint).join(' ').replace(/^[○›]\s*/, '').trim();
  return { text, ...(action ? { next: action === 'steer' ? 'steer' : action === 'send now' ? 'send' : 'interrupt' } : {}) };
}

/** What a key would do to the CLI right now, read from the bottom of the screen like [parseScreen]. */
export interface TurnControls {
  /**
   * `ctrl+c to stop` is on the prompt bar: the CLI is processing and a Ctrl+C cancels the turn.
   * Before that hint (the moment after a submit) a Ctrl+C cancels nothing and only arms the exit.
   */
  stoppable: boolean;
  /** The CLI waits for a second Ctrl+C to quit; one now would close it. */
  exitArmed: boolean;
  followUps?: FollowUps;
}

export function turnControls(text: string): TurnControls {
  const lines = text.split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim());
  const tail = lines.slice(-14);
  const exitArmed = EXIT_HINT.test(tail.at(-1) ?? '');
  const bar = tail.findLastIndex(line => PROMPT_BAR.test(line));
  const queue = followUps(lines.slice(-40));
  return { stoppable: !exitArmed && bar >= 0 && CURSOR_AGENT_BUSY_PATTERN.test(tail[bar]!), exitArmed, ...(queue ? { followUps: queue } : {}) };
}
