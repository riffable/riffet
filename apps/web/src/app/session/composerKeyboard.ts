/**
 * Composer keyboard policy: the one place that decides what a keystroke means.
 *
 * The gesture vocabulary is borrowed from DeepSeek Harness's composer keymap, where plain Enter and
 * the Send button are deliberately the *same* gesture and Cmd/Ctrl+Enter is its accelerated form.
 * Keeping that shape matters more than it looks: it is why the Send button can never disagree with
 * the keyboard, and why an IME's Enter can be told apart from a real one by its modifiers rather
 * than by guessing.
 *
 * Two smaller rules come from the same source:
 *
 * - Shift+Enter is a line break, always, and is never consumed — the textarea's own default already
 *   inserts a newline, so the policy stays out of the way (`pass`).
 * - Enter held with Alt, AltGr, Ctrl+Cmd, Shift+Cmd or Shift+Ctrl is somebody else's shortcut.
 *   Those fall through (`accelerated`) instead of being swallowed.
 */
import { SETTING_DEFAULTS } from '@contracts';
import { isApplePlatform } from '@/lib/platform';

/** What Enter does in the composer. Account-level (`AppSettings.composerEnterBehavior`). */
export type EnterKeyBehavior = 'newline' | 'send';

/** The default, and the answer for a value the server never stored or a build that predates it. */
export const DEFAULT_ENTER_KEY_BEHAVIOR: EnterKeyBehavior = SETTING_DEFAULTS.composerEnterBehavior;

/** Read an untrusted setting value: anything that is not a known behaviour means the default. */
export function readEnterKeyBehavior(value: unknown): EnterKeyBehavior {
  return value === 'send' || value === 'newline' ? value : DEFAULT_ENTER_KEY_BEHAVIOR;
}

/**
 * The modifier signature of one Enter keydown.
 *
 * Every field is required rather than defaulted: a caller that forgets one would silently turn an
 * IME's candidate Enter into a send, which is precisely the failure this type exists to prevent.
 */
export interface EnterGesture {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  /** The event's own composition flag; `keyCode === 229` is folded in by {@link isComposingKey}. */
  readonly composing: boolean;
  /** Set while a key is held down; a repeat must not fire a second send. */
  readonly repeat?: boolean;
}

/** The three Enter gestures the composer distinguishes, plus the modifier combos it must not touch. */
export type EnterGestureKind = 'plainEnter' | 'modifiedEnter' | 'shiftEnter' | 'accelerated';

/** What the composer should do about one Enter. */
export type EnterResolution =
  /** Send the draft (queued while the agent is running, exactly like the Send button). */
  | 'send'
  /** There is nothing to send; consume the keystroke so nothing appears to happen silently. */
  | 'blocked'
  /** Leave the event alone: the browser's own default (a line break) is the answer. */
  | 'pass';

/** One key event, reduced to what the policy needs. */
export interface EnterEvent {
  readonly kind: EnterGestureKind;
  readonly composing: boolean;
  readonly repeat: boolean;
  /** Whether the draft has anything to send (trimmed). */
  readonly hasDraft: boolean;
}

/** The decision, as two things `onKeyDown` needs: whether to preventDefault, and what to do. */
export interface EnterOutcome {
  readonly preventDefault: boolean;
  readonly action: EnterResolution;
}

/**
 * Whether this event is an IME's Enter rather than the user's.
 *
 * `isComposing` is the standard signal; `keyCode === 229` is the legacy one engines still emit for
 * composition keys. Both are required: some Windows IMEs report only the second, and Safari reports
 * a late keydown after `compositionend` — that window is handled by the caller, because only the
 * caller owns the element whose `compositionend` it comes from.
 */
export function isComposingKey(event: { readonly isComposing?: boolean; readonly keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/**
 * Classify one Enter keydown.
 *
 * Order is the whole policy: someone else's shortcut first, then Shift+Enter's line break, then the
 * IME's candidate Enter, and only then this composer's own gestures.
 */
export function classifyEnterGesture(gesture: EnterGesture): EnterGestureKind {
  // Alt/AltGr/combinations belong to the OS, the browser, or an application shortcut.
  if (gesture.altKey || (gesture.ctrlKey && gesture.metaKey) || (gesture.shiftKey && (gesture.ctrlKey || gesture.metaKey))) return 'accelerated';
  if (gesture.shiftKey) return 'shiftEnter';
  // Exactly one command modifier, never both: Ctrl+Cmd+Enter is a shortcut, not an accelerated send.
  if (gesture.metaKey !== gesture.ctrlKey) return 'modifiedEnter';
  return 'plainEnter';
}

/**
 * Resolve one Enter into an action.
 *
 * `modifiedEnter` (Cmd/Ctrl+Enter) sends under **both** behaviors. That is the point of the setting
 * being a preference rather than a mode: a user who switches Enter to "newline" still has one
 * gesture that always sends, so no state can leave them unable to submit from the keyboard.
 */
export function resolveEnter(event: EnterEvent, behavior: EnterKeyBehavior): EnterOutcome {
  // An IME's Enter picks a candidate. Consume it — the browser owns the gesture — but never send,
  // and never break the line (the IME is mid-word).
  if (event.composing) return { preventDefault: false, action: 'blocked' };
  // A held-down Enter must not machine-gun sends. The first repeat is already one too many.
  if (event.repeat) return { preventDefault: true, action: 'blocked' };
  if (event.kind === 'accelerated') return { preventDefault: false, action: 'pass' };
  // Shift+Enter is a line break; the textarea's own default is that line break.
  if (event.kind === 'shiftEnter') return { preventDefault: false, action: 'pass' };
  // A send gesture on an empty draft does nothing, running or not: every submit path refuses an
  // empty prompt, and interrupting is the Stop button's job. The key is still consumed, so Enter
  // does not quietly become a newline in a composer whose setting says Enter sends.
  const sends = event.kind === 'modifiedEnter' || behavior === 'send';
  if (!sends) return { preventDefault: false, action: 'pass' };
  return { preventDefault: true, action: event.hasDraft ? 'send' : 'blocked' };
}

/**
 * Which overlay Escape should close, outermost rule first.
 *
 * Escape is layered rather than broadcast: an open menu closes before the fullscreen editor exits,
 * and with neither open the key is left to the browser.
 */
export type EscapeLayer = 'menu' | 'fullscreen' | 'pass';

export function resolveEscapeLayer(state: { readonly menuOpen: boolean; readonly fullscreen: boolean }): EscapeLayer {
  if (state.menuOpen) return 'menu';
  if (state.fullscreen) return 'fullscreen';
  return 'pass';
}

/**
 * The key the Send button should advertise, which must be the key that actually sends.
 *
 * Under `'send'` the button's gesture is Enter; under `'newline'` the only gesture that sends from
 * the keyboard is Cmd/Ctrl+Enter — so the button says `⌘↵` (`Ctrl+↵` off Apple platforms),
 * matching the shortcut that works.
 */
export function primaryEnterHint(behavior: EnterKeyBehavior, apple = isApplePlatform): string {
  if (behavior === 'send') return '↵';
  return apple ? '⌘↵' : 'Ctrl+↵';
}
