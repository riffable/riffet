/**
 * The focus side of the composer: when a press on its own chrome must not move focus, and when the
 * visible viewport must stop tracking the keyboard.
 *
 * Both are the browser counterpart of the mobile client's focus model (docs/MOBILE.md, 「焦点：输入框、
 * 选区与「谁都不持有」」): a press on the input area's own surface keeps the field focused instead of
 * handing focus to `<body>`, and the height the keyboard occupies is not reclaimed while a finger is
 * down. The decisions are pure over plain descriptions, so they can be tested without a DOM.
 */

/** What a press landed on, reduced to the facts the focus rule reads. */
export interface PressTarget {
  /** The nearest control tag under the press, or the pressed element's own tag. */
  tag: string;
  /** Whether the press is inside anything that declares an ARIA role. */
  role: boolean;
  /** Whether the press is inside a text-editing host (input, textarea, contenteditable). */
  editable: boolean;
}

/** Tags that own their focus and press behavior. */
const interactiveTags = new Set(['a', 'area', 'button', 'input', 'label', 'option', 'select', 'summary', 'textarea']);

/**
 * The same tags as a selector. A press lands on a label, an icon or padding, so the control has to be
 * resolved through ancestors; `a` only matches when it is a link, since a bare anchor is not one.
 */
const controlSelector = [...interactiveTags].map((tag) => (tag === 'a' ? 'a[href]' : tag)).join(', ');
const textFieldSelector = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

/** Whether a press inside `element` would land in a text-editing host. */
export function isTextField(element: Element | null): boolean {
  return Boolean(element?.closest(textFieldSelector));
}

/** Reduce an element under the pointer to the plain facts the focus rule reads. */
export function pressTarget(element: Element | null): PressTarget {
  return {
    tag: (element?.closest(controlSelector) ?? element)?.tagName.toLowerCase() ?? '',
    role: Boolean(element?.closest('[role]')),
    editable: isTextField(element),
  };
}

/**
 * Whether a press on the target must be left alone. A control has to receive its own press — a button
 * must fire, a text field must place the caret — and a role marks a widget's own surface. Only the
 * inert chrome of the card is swallowed.
 */
const isInteractiveTarget = (target: PressTarget) => target.role || target.editable || interactiveTags.has(target.tag);

/**
 * Whether a press should swallow the browser's focus shift.
 *
 * Preventing the default is the only reliable way to keep a press on non-focusable chrome from moving
 * focus to `<body>`, which dismisses the keyboard on a phone. It costs the selection that press would
 * have started, so it only happens while a text field in the composer already holds focus — when
 * there is something to lose — and never on a control, whose own behavior must run unaltered.
 */
export function keepsComposerFocus(press: { target: PressTarget; composerFocused: boolean }): boolean {
  return press.composerFocused && !isInteractiveTarget(press.target);
}

/** One pointer event's effect on the set of pointers currently down. */
export type PointerPhase = 'down' | 'up' | 'cancel';

/** Pointer ids still down after `event`; `down` adds, `up` and `cancel` remove. */
export function pointersAfter(pointers: readonly number[], pointerId: number, phase: PointerPhase): number[] {
  const next = new Set(pointers);
  if (phase === 'down') next.add(pointerId);
  else next.delete(pointerId);
  return [...next];
}

/**
 * Whether the keyboard's height must be held back from the layout.
 *
 * A long press makes the keyboard collapse while the finger is still down; mirroring that into
 * `--app-height` drags the bottom-anchored transcript under the finger and deforms the selection. The
 * hold lasts while any pointer is down — a second finger must not end it — and lifts only once the
 * last one is up, at which point the caller applies the current height once.
 */
export function shouldHoldKeyboardHeight(pointers: readonly number[]): boolean {
  return pointers.length > 0;
}
