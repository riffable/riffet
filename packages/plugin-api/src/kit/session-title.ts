import type { Session, SessionTitleSource } from '@riffet/contracts';

/**
 * One title rule for every CLI.
 *
 * A conversation is named after its first human message the moment it is accepted, so it is never
 * "New conversation" while the first turn runs. That name is a stand-in: once a model-written title
 * arrives it replaces the first message once. A CLI's own name — Codex's thread name, Claude Code's
 * `ai-title`, Cursor's chat name — is still the CLI's choice, so the workbench's title model, when
 * the reader configured one, replaces it once more; the title model's answer then stays. A
 * provider's weak label (a resume-picker guess, DSH's ~10-character summary cut mid-sentence) only
 * fills a session that has no name at all, and a title the reader typed is final.
 *
 * The rules are pure so the wiring in each backend stays a one-liner and the policy is testable
 * without a store, a CLI, or a transcript.
 */

/** Titles the workbench itself generates when it does not know better. */
export const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set(['untitled', 'terminal', 'new conversation', 'new agent', 'agent 会话']);

export function isPlaceholderTitle(title: string | undefined): boolean {
  const value = (title ?? '').trim();
  return value === '' || PLACEHOLDER_TITLES.has(value.toLowerCase());
}

/**
 * How much of a message becomes the stored title. Long enough to recognize a conversation in the
 * header on a wide window, short enough that the sidebar's own clipping does the rest — the number
 * the web client used before the server owned the rule.
 */
export const SESSION_TITLE_LIMIT = 48;

/**
 * The first line of a human message, collapsed to one line and capped. `undefined` when the message
 * has no text to name anything with.
 *
 * The first line is not always the first *words*: a leading Markdown marker (`#`, `>`, `- `, `1. `)
 * is dropped so a pasted list is not named after its bullet, and a code fence is skipped entirely —
 * a message that opens with ```` ```ts ```` used to name the conversation `` ```ts ``, which says
 * nothing about it. A slash command is dropped the same way, because the argument is the request and
 * the command is how it was sent; a bare command with no argument has nothing to offer and the next
 * line speaks instead. What survives is unwrapped from the emphasis and backticks around it.
 */
export function titleFromMessage(text: string | undefined): string | undefined {
  const title = messageTitleLine(text);
  return title && title.length > SESSION_TITLE_LIMIT ? `${title.slice(0, SESSION_TITLE_LIMIT)}…` : title;
}

function messageTitleLine(text: string | undefined): string | undefined {
  const lines = (text ?? '').split('\n').map((part) => part.trim());
  const fenced: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!;
    if (!line) continue;
    // A fence opens a block whose content is code, not a description of it. Skip to its close, but
    // keep the first line inside: a message that is *only* code still has to be named something,
    // and the code reads better than the fence that wrapped it.
    const fence = /^(?:```+|~~~+)/.exec(line);
    if (fence) {
      const marker = fence[0]!.slice(0, 3);
      const closing = lines.findIndex((other, at) => at > index && other.startsWith(marker));
      fenced.push(...lines.slice(index + 1, closing < 0 ? lines.length : closing).filter(Boolean));
      index = closing < 0 ? lines.length : closing;
      continue;
    }
    const title = cleanMessageLine(line);
    if (title) return title;
  }
  for (const line of fenced) {
    const title = cleanMessageLine(line);
    if (title) return title;
  }
  return undefined;
}

/**
 * The slash commands a message may open with. A closed list on purpose: every CLI here has a
 * handful, while `/tmp`, `/etc` and `/usr` are ordinary words at the start of a sentence, and no
 * regex can tell those apart. A command this list does not know simply names the conversation the
 * way any other first line would — the old title, not a wrong one.
 */
const KNOWN_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  'plan', 'clear', 'compact', 'review', 'resume', 'model', 'init', 'cost', 'config', 'context',
  'agents', 'help', 'exit', 'quit', 'login', 'logout', 'status', 'doctor', 'memory', 'vim',
  'terminal-setup', 'add-dir', 'hooks', 'mcp', 'ide', 'install-github-app', 'bug', 'pr-comments',
  'release-notes', 'todos', 'export', 'new', 'diff', 'undo', 'redo', 'arc', 'aif-workflow',
]);

/** Wrapping emphasis or quotes, removed only as a matched pair so a title is never left unbalanced. */
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [['**', '**'], ['__', '__'], ['*', '*'], ['_', '_'], ['`', '`'], ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['《', '》']];

function cleanMessageLine(raw: string): string | undefined {
  let line = raw.replace(/^(?:#{1,6}|>|[-*+]|\d{1,2}[.)])\s+/u, '');
  // `/plan do the thing` is a request and the argument is what it asks for; `/clear` is only a
  // command, so it names nothing and the next line speaks instead.
  //
  // A command is told from a path by what follows the word: a slash command is one word, so a
  // second slash (`/tmp/foo`) rules it out — but `/tmp 下的文件乱了` is a sentence about a
  // directory and looks exactly like a command, so the name has to be one the CLIs actually
  // offer. Guessing from shape alone renamed that message "下的文件乱了".
  const slash = /^\/([a-z][\w-]*(?::[\w-]+)?)(?:\s+(.*))?$/i.exec(line);
  if (slash && KNOWN_SLASH_COMMANDS.has(slash[1]!.toLowerCase().split(':')[0]!)) line = (slash[2] ?? '').trim();
  let value = line.replace(/\s+/gu, ' ').trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const [open, close] of WRAPPERS) {
      if (value.length > open.length + close.length && value.startsWith(open) && value.endsWith(close)) {
        value = value.slice(open.length, -close.length).trim();
        changed = true;
      }
    }
  }
  if (!value) return undefined;
  return value;
}

/** The source flags, named so call sites and tests read the same. */
export const TITLE_FROM_PROMPT: SessionTitleSource = 'prompt';
export const TITLE_FROM_PROVIDER: SessionTitleSource = 'provider';
export const TITLE_FROM_AGENT: SessionTitleSource = 'agent';
export const TITLE_FROM_GENERATED: SessionTitleSource = 'generated';
export const TITLE_FROM_USER: SessionTitleSource = 'user';

type TitlePatch = Pick<Session, 'title' | 'titleSource'>;

/** Sources no message-derived rule may replace. */
function settled(source: SessionTitleSource | undefined): boolean {
  return source === TITLE_FROM_USER || source === TITLE_FROM_GENERATED || source === TITLE_FROM_AGENT || source === TITLE_FROM_PROMPT;
}

/**
 * Shared core. `allowUnmarked` decides what an old row written before provenance existed means:
 * the transcript rule reads it as the provider's label (worth replacing once the real first message
 * is known), the accepted-message rule reads it as a name someone chose (leave it alone).
 */
function patchFromMessage(
  session: Pick<Session, 'title' | 'titleSource'>,
  text: string | undefined,
  allowUnmarked: boolean,
): TitlePatch | undefined {
  if (settled(session.titleSource)) return undefined;
  if (!allowUnmarked && session.titleSource === undefined && !isPlaceholderTitle(session.title)) return undefined;
  const title = titleFromMessage(text);
  if (!title || title === session.title) return undefined;
  return { title, titleSource: TITLE_FROM_PROMPT };
}

/**
 * Names a session after the message a client just accepted. This is the first message for every new
 * conversation, and the only rule a later message follows is "leave the name alone": a session that
 * already has one keeps it.
 */
export function acceptedTitlePatch(session: Pick<Session, 'title' | 'titleSource'>, text: string | undefined): TitlePatch | undefined {
  return patchFromMessage(session, text, false);
}

/**
 * Names a session after the first human message of its transcript, which is where a resumed
 * conversation finally learns what it is about — including the rows a provider named before this
 * rule existed.
 */
export function firstMessageTitlePatch(session: Pick<Session, 'title' | 'titleSource'>, text: string | undefined): TitlePatch | undefined {
  // Older servers promoted the CLI's first-message label to a final generated title. Recover its
  // provenance only with the actual first message; a reader's explicit rename is always final.
  if ((session.titleSource === TITLE_FROM_GENERATED || session.titleSource === TITLE_FROM_AGENT) && isPromptTitle(session.title, text)) {
    return { title: titleFromMessage(text)!, titleSource: TITLE_FROM_PROMPT };
  }
  return patchFromMessage(session, text, true);
}

/**
 * The patch that adopts a provider's weak label, or `undefined`. It only fills a session that is
 * still unnamed, so it can never replace a title a human message, a model or the reader produced —
 * which is also why every backend can call it as often as its stream repeats itself.
 */
export function providerTitlePatch(session: Pick<Session, 'title' | 'titleSource'>, title: string | undefined): TitlePatch | undefined {
  if (settled(session.titleSource)) return undefined;
  if (!isPlaceholderTitle(session.title)) return undefined;
  const value = (title ?? '').trim().replace(/\s+/gu, ' ');
  if (!value || value === session.title) return undefined;
  // Capped like the other two rules, ellipsis included: a terminal title can be a whole command
  // line, and a title cut mid-word with no mark reads as the provider's own wording.
  const capped = value.length > PROVIDER_TITLE_LIMIT ? `${value.slice(0, PROVIDER_TITLE_LIMIT)}…` : value;
  if (capped === session.title) return undefined;
  return { title: capped, titleSource: TITLE_FROM_PROVIDER };
}

/** Longest provider label kept. Generous: a CLI's own name for a thread is usually already short. */
export const PROVIDER_TITLE_LIMIT = 200;

/** Longest model-written title kept. Models asked for a short title still sometimes write a sentence. */
export const GENERATED_TITLE_LIMIT = 60;

/**
 * A model's answer reduced to a title: first line, no wrapping quotes or Markdown, no trailing
 * sentence punctuation, capped. `undefined` when nothing usable is left.
 */
export function cleanGeneratedTitle(text: string | undefined): string | undefined {
  const value = generatedTitleLine(text);
  return value && value.length > GENERATED_TITLE_LIMIT ? `${value.slice(0, GENERATED_TITLE_LIMIT)}…` : value;
}

function generatedTitleLine(text: string | undefined): string | undefined {
  const line = (text ?? '').split('\n').map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  const trailing = /[。．.!！?？,，;；:：、]+$/u;
  const value = line
    .replace(/^(?:title|标题)\s*[:：]\s*/iu, '')
    .replace(/^[#>*\s]+|[*\s]+$/gu, '')
    .replace(trailing, '')
    .replace(/^["'“”‘’「『《`]+|["'“”‘’」』》`]+$/gu, '')
    .replace(trailing, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!value) return undefined;
  return value;
}

/**
 * A verbatim first-message label, including TRAE's 36-character fallback and an explicitly clipped
 * label. A short shared prefix alone is not evidence: "Fix login" can be a real summary of a longer
 * request beginning with those words.
 */
export function isPromptTitle(title: string | undefined, message: string | undefined): boolean {
  const line = messageTitleLine(message);
  const value = generatedTitleLine(title);
  if (!line || !value) return false;
  const prompt = generatedTitleLine(line) ?? line;
  const rawLine = (message ?? '').split('\n').map(part => part.trim()).find(Boolean)!;
  const rawPrompt = generatedTitleLine(rawLine);
  const prefix = value.replace(/(?:…|\.{3})$/u, '').trimEnd();
  if (!prefix) return false;
  if (prefix === prompt || prefix === rawPrompt) return true;
  // Compare after cleaning both sides: an older server may already have stripped punctuation
  // from the 36th character, so the stored fallback can now be shorter than 36 characters.
  if (value === generatedTitleLine([...line].slice(0, 36).join(''))
    || value === generatedTitleLine([...rawLine].slice(0, 36).join(''))) return true;
  return /(?:…|\.{3})\s*$/u.test(title ?? '') && (prompt.startsWith(prefix) || Boolean(rawPrompt?.startsWith(prefix)));
}

/** A generic CLI name may still be its first-message fallback rather than a model's summary. */
export function nativeTitlePatch(session: Pick<Session, 'title' | 'titleSource'>, title: string | undefined, message: string | undefined): TitlePatch | undefined {
  if (message === undefined) return providerTitlePatch(session, title);
  if (isPromptTitle(title, message)) return firstMessageTitlePatch(session, message);
  return agentTitlePatch(session, title, message);
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Whether a title reads in the language of the message it stands in for. Only the case that shows
 * up in practice is checked: Cursor names a Chinese conversation in English ("Agent Title
 * Strategy"), and a title the reader cannot skim in their own language is worse than their words.
 */
export function sameScript(title: string, message: string): boolean {
  return !CJK.test(message) || CJK.test(title);
}

/**
 * The patch that adopts the workbench title model's answer, or `undefined`. It upgrades the
 * first-message stand-in (checking it is in the same language), a CLI's own name, a provider's
 * label, or a placeholder — once: a conversation that already carries a generated title keeps it,
 * and the reader's title is final. Pass the full first `message` when it is at hand: the stand-in
 * is clipped, and the language may only show after the cut.
 *
 * A name already there is checked for language too, not just the stand-in. Cursor names a Chinese
 * conversation in English, and that is the case worth replacing; but when the model's answer is the
 * one in the wrong language, the CLI's name is the better of the two and stays.
 */
export function generatedTitlePatch(session: Pick<Session, 'title' | 'titleSource'>, title: string | undefined, message?: string): TitlePatch | undefined {
  return modelTitlePatch(session, title, message, TITLE_FROM_GENERATED);
}

/**
 * The patch that adopts a name the CLI's own model wrote (Codex's thread name, Claude Code's
 * `ai-title`, Cursor's chat name), or `undefined`. Same rules as `generatedTitlePatch`, except that
 * it never replaces another CLI name and is marked so the title model may still replace it: a CLI
 * names a conversation in two or three generic words ("网页设计改进"), and a reader who configured a
 * title model asked for that model's titles.
 */
export function agentTitlePatch(session: Pick<Session, 'title' | 'titleSource'>, title: string | undefined, message?: string): TitlePatch | undefined {
  if (session.titleSource === TITLE_FROM_AGENT) return undefined;
  return modelTitlePatch(session, title, message, TITLE_FROM_AGENT);
}

function modelTitlePatch(session: Pick<Session, 'title' | 'titleSource'>, title: string | undefined, message: string | undefined, source: SessionTitleSource): TitlePatch | undefined {
  if (session.titleSource === TITLE_FROM_USER) return undefined;
  const recoveredPrompt = (session.titleSource === TITLE_FROM_GENERATED || session.titleSource === TITLE_FROM_AGENT) && isPromptTitle(session.title, message);
  if (session.titleSource === TITLE_FROM_GENERATED && !recoveredPrompt) return undefined;
  const legacyPrompt = session.titleSource === undefined && message !== undefined && session.title === titleFromMessage(message);
  if (session.titleSource === undefined && !isPlaceholderTitle(session.title) && !legacyPrompt) return undefined;
  const value = cleanGeneratedTitle(title);
  if (!value || isPlaceholderTitle(value)) return undefined;
  const named = session.titleSource === TITLE_FROM_PROMPT || session.titleSource === TITLE_FROM_PROVIDER || session.titleSource === TITLE_FROM_AGENT || legacyPrompt || recoveredPrompt;
  if (named && message !== undefined && !sameScript(value, `${session.title}\n${message}`)) return undefined;
  if (session.titleSource === TITLE_FROM_PROMPT && message === undefined && !sameScript(value, session.title)) return undefined;
  return { title: value, titleSource: source };
}

/** The first human message in a batch of projected transcript events, if it carries text. */
export function firstHumanMessage(events: readonly { type: string; data: Record<string, unknown> }[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'user_message_chunk') continue;
    const content = event.data.content;
    const text = content && typeof content === 'object' ? (content as { text?: unknown }).text : undefined;
    if (typeof text === 'string' && text.trim()) return text;
  }
  return undefined;
}
