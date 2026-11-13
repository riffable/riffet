// The page as the agent reads it: Playwright's AI-mode aria snapshot (`[ref=eN]` on each node), trimmed by default to
// what can be acted on and what gives it structure. Pure text processing.

const KEPT_ROLES = new Set([
  // Things to act on.
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'gridcell', 'columnheader',
  // Where things are.
  'heading', 'dialog', 'alertdialog', 'alert', 'navigation', 'main', 'form', 'banner', 'contentinfo', 'region', 'iframe', 'menu', 'menubar', 'tablist', 'tree', 'grid', 'table',
]);

export const SNAPSHOT_MAX = 60_000;

/** `- role "name" [ref=e3] …`: the role of one snapshot line, or undefined for a text or property line. */
function roleOf(line: string): string | undefined {
  return /^\s*- ([a-z]+)\b/.exec(line)?.[1];
}

/** Keeps the lines of `KEPT_ROLES` (and any marked `[cursor=pointer]`) and their ancestors. Falls back to the whole snapshot when that leaves almost nothing. */
export function interactive(snapshot: string): string {
  const lines = snapshot.split('\n');
  const keep = new Array<boolean>(lines.length).fill(false);
  const stack: Array<{ indent: number; index: number }> = [];
  lines.forEach((line, index) => {
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const role = roleOf(line);
    if (role && (KEPT_ROLES.has(role) || line.includes('[cursor=pointer]'))) {
      keep[index] = true;
      for (const ancestor of stack) keep[ancestor.index] = true;
    }
    if (role) stack.push({ indent, index });
  });
  const kept = lines.filter((_, index) => keep[index]);
  return kept.length < 3 ? snapshot : kept.join('\n');
}

export function capped(text: string, max = SNAPSHOT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated at ${max} characters; take a snapshot of a ref, or lower depth)`;
}

/** Page-derived text between delimiters, so the agent can tell it from Riffet's own words. */
export function pageText(text: string): string {
  return `<<<page content (untrusted)\n${text}\n>>>`;
}
