import type { ReactNode } from 'react';
import type { CodeOutlineItem } from '@contracts';
import type { CodeFileCommandName, CodeMenuAt, CodeSymbolAt, MenuEntry, PluginIconName } from '@riffet/plugin-web';
import { dirName, fileName } from './data';
import type { Messages } from './messages';

/*
 * The page's right-click menus, as the IDE's are: every surface that shows a file, a line or a symbol
 * offers the same groups in the same order, so a command is found in one place whichever surface the
 * reader is on. Navigation first (open, go to, find), then editing/file actions, then copy, then git
 * and folding submenus, then quoting to a conversation. Shortcuts are shown where the page has them.
 *
 * Every entry of a menu has an icon, as the app's menus do; the entries of a submenu have none (they are
 * variants of the row that opened it, and the same icon down a column says nothing).
 */

export type EditorCommand = CodeFileCommandName;

/** What the menus can do, from the page. */
export interface MenuActions {
  m: Messages;
  icon(name: PluginIconName): ReactNode;
  keys: {
    declaration: string; usages: string; text: string; find: string; back: string; line: string; foldAll: string; unfoldAll: string;
    save: string; undo: string; redo: string; comment: string; selectNext: string;
  };
  /** The project's folder on its server, for absolute paths. */
  root: string;
  hasGit: boolean;
  canQuote: boolean;
  canWrite: boolean;
  isEditing: boolean;
  isDirty(path: string): boolean;
  /** The open file is annotated with git blame. */
  annotating: boolean;
  /** The open file, and its package when the outline has read one. */
  active: string | undefined;
  activePackage: string | undefined;
  open(path: string, line?: number, column?: number): void;
  openToSide(path: string): void;
  locate(path: string): void;
  declaration(path: string, at: CodeSymbolAt): void;
  usages(path: string, word: string): void;
  findText(query: string): void;
  findInFolder(path: string): void;
  copy(text: string): void;
  /** Shows a commit in the bottom panel. */
  showCommit(hash: string, path?: string): void;
  closeAnnotations(): void;
  quote(path: string, line?: number): void;
  annotate(path: string): void;
  compare(path: string): void;
  editor(command: EditorCommand): void;
  newFile(folder: string): void;
  newFolder(folder: string): void;
  rename(path: string): void;
  remove(path: string): void;
}

const JVM_SOURCE = /\.(kt|kts|java)$/;
const sep: MenuEntry = { kind: 'separator' };
const item = (label: string, onSelect: () => void, extra: { icon?: ReactNode; shortcut?: string; disabled?: boolean; danger?: boolean } = {}): MenuEntry => ({ kind: 'item', label, onSelect, ...extra });
/** Drops a separator at either end or next to another, so optional groups can be left out freely. */
export function tidy(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'separator' && (!out.length || out.at(-1)!.kind === 'separator')) continue;
    out.push(entry);
  }
  while (out.at(-1)?.kind === 'separator') out.pop();
  return out;
}

/** The class a Kotlin or Java file is named for. */
const classOf = (path: string) => (JVM_SOURCE.test(path) ? fileName(path).replace(JVM_SOURCE, '') : undefined);

/** Copy Path/Reference ▸ — the forms the IDE offers, those that apply here. */
function copyMenu(a: MenuActions, path: string, extra: { line?: number; reference?: string } = {}): MenuEntry {
  const { m } = a;
  const absolute = `${a.root.replace(/\/$/, '')}/${path}`;
  const entries: MenuEntry[] = [
    item(m.copy.relative, () => a.copy(path || '.')),
    item(m.copy.absolute, () => a.copy(path ? absolute : a.root)),
    item(m.copy.name, () => a.copy(fileName(path) || fileName(a.root))),
  ];
  if (extra.line !== undefined) entries.push(item(m.copy.withLine, () => a.copy(`${path}:${extra.line}`)));
  if (extra.reference) entries.push(sep, item(m.copy.reference(extra.reference), () => a.copy(extra.reference!)));
  return { kind: 'submenu', label: m.copy.menu, icon: a.icon('link'), entries };
}

function gitMenu(a: MenuActions, path: string): MenuEntry {
  const { m } = a;
  return {
    kind: 'submenu', label: 'Git', icon: a.icon('git-branch'), disabled: !a.hasGit,
    entries: [
      a.annotating && path === a.active ? item(m.git.closeAnnotate, a.closeAnnotations) : item(m.git.annotate, () => a.annotate(path)),
      item(m.git.compare, () => a.compare(path)),
    ],
  };
}

function foldingMenu(a: MenuActions): MenuEntry {
  const { m } = a;
  return {
    kind: 'submenu', label: m.folding.menu, icon: a.icon('chevrons-down-up'),
    entries: [
      item(m.folding.fold, () => a.editor('fold'), { shortcut: a.keys.foldAll.replace(/⇧|Shift\+/, '') }),
      item(m.folding.unfold, () => a.editor('unfold'), { shortcut: a.keys.unfoldAll.replace(/⇧|Shift\+/, '') }),
      item(m.folding.foldAll, () => a.editor('foldAll'), { shortcut: a.keys.foldAll }),
      item(m.folding.unfoldAll, () => a.editor('unfoldAll'), { shortcut: a.keys.unfoldAll }),
    ],
  };
}

/** A file wherever it is listed: the tree, a tab, the path bar, a group of find results. */
export function fileMenu(a: MenuActions, path: string, options: { open?: 'preview' | 'tab' } = {}): MenuEntry[] {
  const { m } = a;
  const type = classOf(path);
  return tidy([
    options.open ? item(m.menu.open, () => a.open(path), { icon: a.icon('file') }) : undefined,
    item(m.menu.openToSide, () => a.openToSide(path), { icon: a.icon('columns-2') }),
    sep,
    type ? item(m.menu.usagesOf(type), () => a.usages(path, type), { icon: a.icon('list-tree'), shortcut: a.keys.usages }) : undefined,
    item(m.menu.findInFolder, () => a.findInFolder(dirName(path)), { icon: a.icon('folder-search'), shortcut: a.keys.text }),
    item(m.menu.selectInTree, () => a.locate(path), { icon: a.icon('target') }),
    sep,
    copyMenu(a, path, path === a.active && type && a.activePackage ? { reference: `${a.activePackage}.${type}` } : {}),
    gitMenu(a, path),
    sep,
    a.canQuote ? item(m.quoteFile, () => a.quote(path), { icon: a.icon('text-quote') }) : undefined,
    ...(a.canWrite ? [
      sep,
      item(m.fileOps.rename, () => a.rename(path), { icon: a.icon('pencil-line') }),
      item(m.fileOps.delete, () => a.remove(path), { icon: a.icon('trash-2'), danger: true }),
    ] : []),
  ].filter((entry): entry is MenuEntry => Boolean(entry)));
}

/** A folder, module or package in the tree or the path bar. */
export function folderMenu(a: MenuActions, path: string, extra: MenuEntry[] = []): MenuEntry[] {
  const { m } = a;
  return tidy([
    ...(a.canWrite ? [
      item(m.fileOps.newFile, () => a.newFile(path), { icon: a.icon('file-plus') }),
      item(m.fileOps.newFolder, () => a.newFolder(path), { icon: a.icon('folder-plus') }),
      sep,
    ] : []),
    item(m.menu.findInFolder, () => a.findInFolder(path), { icon: a.icon('folder-search'), shortcut: a.keys.text }),
    ...extra,
    sep,
    copyMenu(a, path),
    ...(a.canWrite && path ? [
      sep,
      item(m.fileOps.rename, () => a.rename(path), { icon: a.icon('pencil-line') }),
      item(m.fileOps.delete, () => a.remove(path), { icon: a.icon('trash-2'), danger: true }),
    ] : []),
  ]);
}

/** A right-click in the code (or on a line number). */
export function codeMenu(a: MenuActions, path: string, at: CodeMenuAt, scope: readonly CodeOutlineItem[]): MenuEntry[] {
  const { m } = a;
  const symbol = at.symbol;
  // On a declaration's own name the reference is its qualified name, as the IDE's Copy Reference gives.
  const declared = symbol && scope.at(-1)?.name === symbol.word && scope.at(-1)?.line === symbol.line ? scope : undefined;
  const reference = declared && a.activePackage !== undefined ? [a.activePackage, ...declared.map((entry) => entry.name)].filter(Boolean).join('.') : undefined;
  const selected = at.selection?.trim();
  const query = selected && !selected.includes('\n') ? selected : symbol?.word;
  const dirty = a.isDirty(path);
  return tidy([
    symbol && item(m.menu.declaration, () => a.declaration(path, symbol), { icon: a.icon('arrow-up-right'), shortcut: a.keys.declaration }),
    symbol && item(m.menu.usages, () => a.usages(path, symbol.word), { icon: a.icon('list-tree'), shortcut: a.keys.usages }),
    sep,
    query ? item(m.menu.findText(query.length > 40 ? `${query.slice(0, 40)}…` : query), () => a.findText(query), { icon: a.icon('search'), shortcut: a.keys.text }) : undefined,
    item(m.menu.findInFile, () => a.editor('find'), { icon: a.icon('file-search'), shortcut: a.keys.find }),
    ...(a.isEditing ? [
      sep,
      item(m.menu.undo, () => a.editor('undo'), { icon: a.icon('undo-2'), shortcut: a.keys.undo }),
      item(m.menu.redo, () => a.editor('redo'), { icon: a.icon('rotate-ccw'), shortcut: a.keys.redo }),
      item(m.menu.comment, () => a.editor('comment'), { icon: a.icon('pencil-line'), shortcut: a.keys.comment }),
      item(m.menu.selectNext, () => a.editor('selectNextOccurrence'), { icon: a.icon('text-select'), shortcut: a.keys.selectNext }),
      ...(dirty ? [
        sep,
        item(m.menu.save, () => a.editor('save'), { icon: a.icon('save'), shortcut: a.keys.save }),
        item(m.menu.revert, () => a.editor('revert'), { icon: a.icon('rotate-ccw') }),
      ] : []),
    ] : []),
    sep,
    at.selection ? item(m.menu.copy, () => a.copy(at.selection!), { icon: a.icon('copy') }) : undefined,
    copyMenu(a, path, { line: at.line, ...(reference ? { reference } : {}) }),
    item(m.menu.selectAll, () => a.editor('selectAll'), { icon: a.icon('text-select') }),
    sep,
    foldingMenu(a),
    gitMenu(a, path),
    sep,
    a.canQuote ? item(m.menu.quoteLine, () => a.quote(path, at.line), { icon: a.icon('text-quote') }) : undefined,
  ].filter((entry): entry is MenuEntry => Boolean(entry)));
}

/** A declaration in the structure or the path bar. */
export function declarationMenu(a: MenuActions, path: string, declaration: CodeOutlineItem, chain: readonly CodeOutlineItem[]): MenuEntry[] {
  const { m } = a;
  const reference = a.activePackage !== undefined ? [a.activePackage, ...chain.map((entry) => entry.name)].filter(Boolean).join('.') : declaration.name;
  return tidy([
    item(m.menu.goTo, () => a.open(path, declaration.line, declaration.column), { icon: a.icon('arrow-up-right') }),
    item(m.menu.usages, () => a.usages(path, declaration.name), { icon: a.icon('list-tree'), shortcut: a.keys.usages }),
    item(m.menu.findText(declaration.name), () => a.findText(declaration.name), { icon: a.icon('search') }),
    sep,
    item(m.copy.reference(reference), () => a.copy(reference), { icon: a.icon('copy') }),
    item(m.copy.withLine, () => a.copy(`${path}:${declaration.line}`), { icon: a.icon('link') }),
    sep,
    a.canQuote ? item(m.menu.quoteLine, () => a.quote(path, declaration.line), { icon: a.icon('text-quote') }) : undefined,
  ].filter((entry): entry is MenuEntry => Boolean(entry)));
}

/** One line of find results. */
export function lineMenu(a: MenuActions, path: string, line: number, text: string, keep: () => void): MenuEntry[] {
  const { m } = a;
  return tidy([
    item(m.menu.open, () => a.open(path, line), { icon: a.icon('file') }),
    item(m.menu.openInTab, keep, { icon: a.icon('pin') }),
    sep,
    item(m.menu.copyLine, () => a.copy(text.trim()), { icon: a.icon('copy') }),
    copyMenu(a, path, { line }),
    sep,
    a.canQuote ? item(m.menu.quoteLine, () => a.quote(path, line), { icon: a.icon('text-quote') }) : undefined,
  ].filter((entry): entry is MenuEntry => Boolean(entry)));
}

/** A right-click in the blame column: the line's commit. */
export function blameMenu(a: MenuActions, path: string, hash: string): MenuEntry[] {
  const { m } = a;
  return [
    item(m.git.showCommit, () => a.showCommit(hash, path), { icon: a.icon('git-commit-horizontal') }),
    item(m.menu.copyRevision, () => a.copy(hash), { icon: a.icon('copy') }),
    sep,
    item(m.git.closeAnnotate, a.closeAnnotations, { icon: a.icon('x') }),
  ];
}
