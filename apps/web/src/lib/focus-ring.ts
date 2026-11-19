/**
 * A focus ring answers "where did my Tab go?" — so it shows only on an element a navigating key
 * (Tab, an arrow, Home/End, Page Up/Down) moved focus onto.
 *
 * The browser's own `:focus-visible` is looser: once *any* key is pressed, whatever is focused may
 * start matching. Click a button and press Esc, click the game and press Space, hold ⇧⌘ for a
 * screenshot, or let a script move focus after a shortcut (a popover focusing its first item, the
 * palette handing focus to what it opened), and a ring appears on something nobody navigated to.
 *
 * The policy marks every element that gets focus some other way — a press, a script, a shortcut —
 * and `styles/index.css` uses the mark to suppress the ring. Typing or playing on a focused element
 * never brings its ring back; tabbing onto it again does.
 */
import { isTextField } from './tap-focus';

const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const MARK = 'data-pointer-focus';

/** Elements a pointer can focus; the mark only has to cover what paints a ring. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [role="button"], [role="menuitem"], [role="option"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"]';

export function installFocusRingPolicy(target: Window = window): () => void {
  // Whether the key being handled right now moves focus. Roving lists move it inside their keydown
  // handler and Tab moves it as the keydown's default action, both before the key comes back up.
  let navigating = false;
  const onPointerDown = (event: Event) => {
    navigating = false;
    // A press on an element that already has focus fires no focusin, so mark it here too.
    const focusable = event.target instanceof Element ? event.target.closest(FOCUSABLE) : null;
    if (focusable) focusable.setAttribute(MARK, '');
  };
  const onFocusIn = (event: FocusEvent) => {
    const node = event.target;
    if (!(node instanceof Element) || isTextField(node)) return;
    if (navigating) node.removeAttribute(MARK);
    else node.setAttribute(MARK, '');
  };
  const onKeyDown = (event: KeyboardEvent) => {
    navigating = NAVIGATION_KEYS.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey;
  };
  const onKeyUp = () => { navigating = false; };
  target.addEventListener('pointerdown', onPointerDown, true);
  target.addEventListener('focusin', onFocusIn, true);
  target.addEventListener('keydown', onKeyDown, true);
  target.addEventListener('keyup', onKeyUp, true);
  return () => {
    target.removeEventListener('pointerdown', onPointerDown, true);
    target.removeEventListener('focusin', onFocusIn, true);
    target.removeEventListener('keydown', onKeyDown, true);
    target.removeEventListener('keyup', onKeyUp, true);
    for (const element of target.document.querySelectorAll(`[${MARK}]`)) element.removeAttribute(MARK);
  };
}
