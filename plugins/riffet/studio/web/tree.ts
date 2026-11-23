import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeModule, FileEntry } from '@contracts';
import { join, type CodeApi } from './data';

/*
 * The page's two trees. `project` is the folders as they are on disk. `modules` is the build's view, as
 * Android Studio's "Android" view lays a Gradle project out: modules nested by where they live, and in each
 * one its manifests, its source roots as packages (`com.example.app`, folders with a single folder inside
 * drawn as one row), its resources and its build scripts. Both load a folder only when it is opened.
 */

export type TreeMode = 'modules' | 'project';

export interface TreeNode {
  id: string;
  label: string;
  /** `group` is a folder that only leads to modules; `section` a heading inside a module (manifests, java, res). */
  kind: 'module' | 'group' | 'section' | 'dir' | 'file';
  /** The file or folder on disk; a section has none. */
  path?: string;
  /** Faint text after the label: the source set of a test root, the module's path. */
  hint?: string;
  /** Children known without a read: a module's nested modules, a group's modules. */
  fixed?: TreeNode[];
  /** A section whose children are read from these folders and shown together (a module's source roots, its res folders). */
  roots?: TreeNode[];
  /** Folders inside a source root are packages: a chain is joined with dots. */
  packages?: boolean;
}

export interface TreeRow { node: TreeNode; depth: number; open: boolean; loading: boolean; leaf: boolean }

type Loaded = TreeNode[] | 'loading' | { error: string };

const SOURCE_DIRS = ['java', 'kotlin'];
const BUILD_FILES = /^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|proguard-rules\.pro|consumer-rules\.pro|.*\.pro)$/;
/** A chain of single folders is read this deep before it is drawn as one row. */
const COMPACT_DEPTH = 12;

const sortEntries = (entries: FileEntry[]) => [...entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));

/** The modules nested by path: a folder holding several modules (or one module's parent) becomes a group, single-folder chains are joined. */
export function moduleTree(modules: readonly CodeModule[], rootName: string): TreeNode[] {
  interface Trie { children: Map<string, Trie>; module?: CodeModule }
  const root: Trie = { children: new Map() };
  for (const module of modules) {
    let at = root;
    for (const segment of module.path ? module.path.split('/') : []) {
      let next = at.children.get(segment);
      if (!next) { next = { children: new Map() }; at.children.set(segment, next); }
      at = next;
    }
    at.module = module;
  }
  const build = (trie: Trie, path: string, label: string): TreeNode => {
    // A folder that is not a module and leads to exactly one thing is folded into it.
    let node = trie, at = path, name = label;
    while (!node.module && node.children.size === 1) {
      const [segment, child] = [...node.children][0]!;
      at = join(at, segment);
      name = name ? `${name}/${segment}` : segment;
      node = child;
    }
    const children = [...node.children].sort(([a], [b]) => a.localeCompare(b)).map(([segment, child]) => build(child, join(at, segment), segment));
    if (node.module) {
      return { id: `m:${at}`, label: at ? node.module.name : rootName, kind: 'module', path: at, fixed: children, ...(name !== node.module.name && at ? { hint: name } : {}) };
    }
    return { id: `g:${at}`, label: name, kind: 'group', path: at, fixed: children };
  };
  const top = build(root, '', '');
  return top.kind === 'group' && !top.label ? top.fixed ?? [] : [top];
}

/** What a module holds, as sections: read from its folder, `src/` and each source set. */
async function moduleContent(api: CodeApi, node: TreeNode, signal: AbortSignal): Promise<TreeNode[]> {
  const dir = node.path ?? '';
  const own = await api.list(dir, undefined, signal);
  const nested = node.fixed ?? [];
  const nestedPaths = new Set(nested.map((child) => child.path));
  const manifests: TreeNode[] = [], sources: TreeNode[] = [], resources: TreeNode[] = [], assets: TreeNode[] = [];
  if (own.entries.some((entry) => entry.kind === 'directory' && entry.name === 'src')) {
    const sets = (await api.list(join(dir, 'src'), undefined, signal)).entries.filter((entry) => entry.kind === 'directory');
    // `main` first, then the rest by name, as Studio orders source sets.
    sets.sort((a, b) => Number(b.name === 'main') - Number(a.name === 'main') || a.name.localeCompare(b.name));
    const listed = await Promise.all(sets.map(async (set) => ({ set: set.name, entries: (await api.list(join(dir, `src/${set.name}`), undefined, signal)).entries })));
    for (const { set, entries } of listed) {
      const base = join(dir, `src/${set}`);
      const hint = set === 'main' ? undefined : set;
      const tag = hint ? { hint } : {};
      for (const entry of entries) {
        const path = join(base, entry.name);
        if (entry.kind === 'file' && entry.name === 'AndroidManifest.xml') manifests.push({ id: `f:${path}`, label: entry.name, kind: 'file', path, ...tag });
        else if (entry.kind === 'directory' && SOURCE_DIRS.includes(entry.name)) sources.push({ id: `d:${path}`, label: entry.name, kind: 'dir', path, packages: true, ...tag });
        else if (entry.kind === 'directory' && entry.name === 'res') resources.push({ id: `d:${path}`, label: 'res', kind: 'dir', path, ...tag });
        else if (entry.kind === 'directory' && entry.name === 'assets') assets.push({ id: `d:${path}`, label: 'assets', kind: 'dir', path, ...tag });
      }
    }
  }
  const section = (name: string, children: TreeNode[]): TreeNode[] => (children.length ? [{ id: `s:${dir}:${name}`, label: name, kind: 'section', fixed: children }] : []);
  // Source roots and res folders of every source set are read together under one heading, each entry marked with its set.
  const merged = (name: string, roots: TreeNode[]): TreeNode[] => (roots.length ? [{ id: `s:${dir}:${name}`, label: name, kind: 'section', roots }] : []);
  const scripts = own.entries.filter((entry) => entry.kind === 'file' && BUILD_FILES.test(entry.name)).map((entry): TreeNode => ({ id: `f:${join(dir, entry.name)}`, label: entry.name, kind: 'file', path: join(dir, entry.name) }));
  // Folders that are neither sources nor nested modules, so nothing in the module is out of reach.
  const others = sortEntries(own.entries).filter((entry) => entry.kind === 'directory' && entry.name !== 'src' && entry.name !== 'build' && !entry.name.startsWith('.') && !nestedPaths.has(join(dir, entry.name)))
    .map((entry): TreeNode => ({ id: `d:${join(dir, entry.name)}`, label: entry.name, kind: 'dir', path: join(dir, entry.name) }));
  return [...section('manifests', manifests), ...merged('java', sources), ...merged('res', resources), ...assets, ...nested, ...others, ...scripts];
}

/** A folder's entries; in a package tree a folder holding only one folder is read through and joined. */
async function folderContent(api: CodeApi, node: TreeNode, signal: AbortSignal): Promise<TreeNode[]> {
  const listing = await api.list(node.path ?? '', undefined, signal);
  const out: TreeNode[] = [];
  for (const entry of sortEntries(listing.entries)) {
    const path = join(node.path ?? '', entry.name);
    if (entry.kind === 'file') { out.push({ id: `f:${path}`, label: entry.name, kind: 'file', path }); continue; }
    out.push({ id: `d:${path}`, label: entry.name, kind: 'dir', path, ...(node.packages ? { packages: true } : {}) });
  }
  return out;
}

/**
 * A section's roots read as one list, as Studio's "java" lists packages straight away: each root's entries,
 * a package chain folded into one row (`com.example.app`), marked with the root's source set when it is not `main`.
 */
async function rootsContent(api: CodeApi, roots: readonly TreeNode[], signal: AbortSignal): Promise<TreeNode[]> {
  const lists = await Promise.all(roots.map(async (root) => {
    const children = await folderContent(api, root, signal);
    const shown = await Promise.all(children.map(async (child) => (child.kind === 'dir' && child.packages ? (await compacted(api, child, signal)).node : child)));
    return shown.map((child) => (root.hint ? { ...child, id: `${child.id}@${root.hint}`, hint: root.hint } : child));
  }));
  return lists.flat();
}

/** Reads through a chain of single folders, so `com/example/app` opens as one row. */
async function compacted(api: CodeApi, node: TreeNode, signal: AbortSignal): Promise<{ node: TreeNode; children: TreeNode[] }> {
  let current = node;
  let children = await folderContent(api, current, signal);
  for (let depth = 0; depth < COMPACT_DEPTH && children.length === 1 && children[0]!.kind === 'dir'; depth++) {
    const only = children[0]!;
    current = { ...only, label: `${current.label}${current.packages ? '.' : '/'}${only.label}`, id: node.id };
    children = await folderContent(api, current, signal);
  }
  return { node: current, children };
}

/**
 * The tree's state: what is open, what has been read, and the rows to draw. Reads are dropped with the
 * project or mode they were made for.
 */
export function useTree(api: CodeApi | undefined, roots: TreeNode[] | undefined, onError: (message: string) => void) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState<Map<string, Loaded>>(() => new Map());
  /** A folded chain replaces its first node: the row shows the joined label and reads from the last folder. */
  const [folded, setFolded] = useState<Map<string, TreeNode>>(() => new Map());
  const controller = useRef<AbortController>(new AbortController());

  useEffect(() => {
    controller.current.abort();
    controller.current = new AbortController();
    setLoaded(new Map());
    setFolded(new Map());
    // A single root starts open, as a project view does.
    setOpen(new Set(roots?.length === 1 ? [roots[0]!.id] : []));
  }, [api, roots]);

  /** What has been read, as of now: `reveal` walks down through reads it awaits, ahead of the next render. */
  const known = useRef(new Map<string, { node: TreeNode; children: TreeNode[] }>());
  useEffect(() => { known.current = new Map(); }, [api, roots]);

  /** Reads a node's children once; the same promise answers whoever asks again. */
  const reads = useRef(new Map<string, Promise<TreeNode[] | undefined>>());
  useEffect(() => { reads.current = new Map(); }, [api, roots]);
  const load = useCallback((node: TreeNode): Promise<TreeNode[] | undefined> => {
    if (!api || node.kind === 'file' || node.kind === 'group' || (node.kind === 'section' && !node.roots)) return Promise.resolve(node.fixed);
    const pending = reads.current.get(node.id);
    if (pending) return pending;
    const signal = controller.current.signal;
    setLoaded((previous) => new Map(previous).set(node.id, 'loading'));
    const read = node.kind === 'module' ? moduleContent(api, node, signal).then((children) => ({ node, children }))
      : node.roots ? rootsContent(api, node.roots, signal).then((children) => ({ node, children }))
        : compacted(api, node, signal);
    const done = read.then(({ node: shown, children }) => {
      if (signal.aborted) return undefined;
      known.current.set(node.id, { node: shown, children });
      if (shown !== node) setFolded((previous) => new Map(previous).set(node.id, shown));
      setLoaded((previous) => new Map(previous).set(node.id, children));
      return children;
    }, (error: unknown) => {
      reads.current.delete(node.id);
      if (signal.aborted) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      setLoaded((previous) => new Map(previous).set(node.id, { error: message }));
      onError(message);
      return undefined;
    });
    reads.current.set(node.id, done);
    return done;
  }, [api, onError]);

  /**
   * Opens the way down to a file, as Studio's "Select Opened File" does: at each level the entry that holds
   * the path (a folder above it, a module containing it, a section whose roots do) is opened and read,
   * until the file's own row. False when the file is not in this tree.
   */
  const reveal = useCallback(async (path: string): Promise<boolean> => {
    const holds = (node: TreeNode): number => {
      if (node.path !== undefined) return node.path === path ? Infinity : !node.path || path.startsWith(`${node.path}/`) ? node.path.length + 1 : -1;
      return Math.max(-1, ...[...(node.roots ?? []), ...(node.fixed ?? [])].map(holds));
    };
    const opened: string[] = [];
    let level: readonly TreeNode[] = roots ?? [];
    for (let depth = 0; depth < 64; depth++) {
      let best: TreeNode | undefined, score = -1;
      for (const child of level) { const shown = known.current.get(child.id)?.node ?? child; const at = holds(shown); if (at > score) { best = shown; score = at; } }
      if (!best || score < 0) break;
      if (best.kind === 'file') { setOpen((previous) => new Set([...previous, ...opened])); return true; }
      opened.push(best.id);
      const children = best.fixed && best.kind !== 'module' ? best.fixed : known.current.get(best.id)?.children ?? await load(best);
      if (!children) break;
      level = children;
    }
    setOpen((previous) => new Set([...previous, ...opened]));
    return false;
  }, [roots, load]);

  const toggle = useCallback((node: TreeNode) => {
    const opening = !open.has(node.id);
    if (opening && !loaded.has(node.id)) void load(node);
    setOpen((previous) => {
      const next = new Set(previous);
      if (opening) next.add(node.id); else next.delete(node.id);
      return next;
    });
  }, [load, loaded, open]);

  // The single root that starts open is read as soon as it is known.
  useEffect(() => {
    const only = roots?.length === 1 ? roots[0] : undefined;
    if (only && !loaded.has(only.id) && open.has(only.id)) void load(only);
  }, [roots, open, loaded, load]);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (nodes: readonly TreeNode[], depth: number) => {
      for (const original of nodes) {
        const node = folded.get(original.id) ?? original;
        const isOpen = open.has(node.id);
        const state = loaded.get(node.id);
        const leaf = node.kind === 'file';
        out.push({ node, depth, open: isOpen && !leaf, loading: isOpen && state === 'loading', leaf });
        if (!isOpen || leaf) continue;
        if (node.fixed && node.kind !== 'module') walk(node.fixed, depth + 1);
        else if (Array.isArray(state)) walk(state, depth + 1);
      }
    };
    walk(roots ?? [], 0);
    return out;
  }, [roots, open, loaded, folded]);

  /** Closes everything but a single root, as the project view's "collapse all" does. */
  const collapse = useCallback(() => setOpen(new Set(roots?.length === 1 ? [roots[0]!.id] : [])), [roots]);

  return { rows, toggle, reveal, collapse };
}
