/**
 * Keep `:focus-visible` rings for real keyboard navigation, but not for a bare modifier press.
 *
 * A browser treats *any* key event as keyboard interaction, including a modifier on its own. So
 * holding ⇧⌘ to take a screenshot — or just resting a finger on ⌘ before choosing a menu — makes
 * whatever the pointer last focused suddenly match `:focus-visible` and paint its ring, which reads
 * as a random highlight on a button nobody is keyboard-navigating.
 *
 * The policy marks the element a pointer focused and clears that mark as soon as a non-modifier key
 * arrives. `styles/index.css` uses the mark to suppress the ring, so ⇧⌘ stays quiet while Tab,
 * arrows, Enter and typing keep the rings they need.
 *
 * Focus a script moves after a press is marked too. A popover's trigger keeps the caret in the
 * composer (`keepTypingFocus`), then Radix focuses the popover's first item; a text field always
 * matches `:focus-visible`, and the browser carries that onto whatever a script focuses next, so a
 * click would otherwise open the list with its first row ringed as if keyboard-selected.
 */
import { isTextField } from './tap-focus';

const MODIFIER_KEYS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'AltGraph', 'CapsLock']);

/** Elements a pointer can focus; the mark only has to cover what paints a ring. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [role="button"], [role="menuitem"], [role="option"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"]';

export function installFocusRingPolicy(target: Window = window): () => void {
  const marked = new Set<Element>();
  // Whether the last interaction was a pointer press rather than a navigating key.
  let pointer = false;
  const mark = (element: Element) => {
    element.setAttribute('data-pointer-focus', '');
    marked.add(element);
  };
  const clear = () => {
    for (const element of marked) element.removeAttribute('data-pointer-focus');
    marked.clear();
  };
  const onPointerDown = (event: Event) => {
    clear();
    pointer = true;
    const node = event.target;
    const focusable = node instanceof Element ? node.closest(FOCUSABLE) : null;
    if (focusable) mark(focusable);
  };
  const onFocusIn = (event: FocusEvent) => {
    const node = event.target;
    if (pointer && node instanceof Element && node.matches(FOCUSABLE) && !isTextField(node)) mark(node);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Only plain keys navigate: a bare modifier, or a key held with a command modifier (⇧⌘A for a
    // screenshot, ⌘C for a copy) is a shortcut and must leave the mark alone.
    if (MODIFIER_KEYS.has(event.key)) return;
    // A shortcut is still keyboard use: a surface it opens rings its first item.
    pointer = false;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    clear();
  };
  target.addEventListener('pointerdown', onPointerDown, true);
  target.addEventListener('focusin', onFocusIn, true);
  target.addEventListener('keydown', onKeyDown, true);
  return () => {
    target.removeEventListener('pointerdown', onPointerDown, true);
    target.removeEventListener('focusin', onFocusIn, true);
    target.removeEventListener('keydown', onKeyDown, true);
    clear();
  };
}
