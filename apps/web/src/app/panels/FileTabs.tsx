import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconX } from '@/components/icons';
import { cn } from '@/lib/utils';
import { FileIcon, splitPath } from './fileVisuals';

export type TabOpenMode = 'preview' | 'keep';

interface State {
  projectId: string;
  /** Open tabs in display order. */
  tabs: string[];
  /** Most-recently-active order (newest first), for choosing the next tab after closing the active one. */
  order: string[];
  /** The single temporary preview tab: replaced in place by the next preview open until kept. */
  preview: string | undefined;
}

const empty = (projectId: string): State => ({ projectId, tabs: [], order: [], preview: undefined });
const renamePath = (path: string, from: string, to: string) => (
  path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path
);
const dedupe = (items: readonly string[]) => {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item) ? false : (seen.add(item), true)));
};

/**
 * The files currently open in the files panel, separate from `useRecentFiles` (which keeps
 * browser-persisted history for Quick Open and search). A single click opens a reusable preview tab
 * so browsing does not leave every touched file behind; double-clicking, editing, or jumping from
 * inside it keeps the tab.
 */
export function useFileTabs(projectId: string, drafts: readonly string[]) {
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [state, setState] = useState<State>(() => empty(projectId));
  const current = state.projectId === projectId ? state : empty(projectId);
  const stateRef = useRef(current);
  stateRef.current = current;

  const commit = useCallback((updater: (base: State) => State) => {
    const base = stateRef.current.projectId === projectId ? stateRef.current : empty(projectId);
    const next = updater(base);
    stateRef.current = next;
    setState(next);
    return next;
  }, [projectId]);

  const open = useCallback((path: string, mode: TabOpenMode = 'preview') => {
    commit((base) => {
      const has = base.tabs.includes(path);
      if (has) {
        return {
          ...base,
          order: [path, ...base.order.filter((item) => item !== path)],
          preview: mode === 'keep' && base.preview === path ? undefined : base.preview,
        };
      }
      const replaceable = base.preview !== undefined && base.tabs.includes(base.preview) && !draftsRef.current.includes(base.preview);
      if (mode === 'preview' && replaceable) {
        const replaced = base.preview!;
        return {
          ...base,
          tabs: base.tabs.map((tab) => (tab === replaced ? path : tab)),
          order: [path, ...base.order.filter((item) => item !== replaced && item !== path)],
          preview: path,
        };
      }
      return {
        ...base,
        tabs: [...base.tabs, path],
        order: [path, ...base.order.filter((item) => item !== path)],
        preview: mode === 'preview' ? path : base.preview,
      };
    });
  }, [commit]);

  const keep = useCallback((path: string) => {
    commit((base) => (base.preview === path ? { ...base, preview: undefined } : base));
  }, [commit]);

  /** Aligns a tab opened under an unnormalized path with the canonical path returned by the server. */
  const normalize = useCallback((from: string, to: string) => {
    if (from === to) return;
    commit((base) => {
      if (!base.tabs.includes(from)) return base;
      const alreadyKept = base.tabs.includes(to) && base.preview !== to;
      return {
        ...base,
        tabs: dedupe(base.tabs.map((tab) => (tab === from ? to : tab))),
        order: dedupe(base.order.map((tab) => (tab === from ? to : tab))),
        preview: base.preview === from ? (alreadyKept ? undefined : to) : base.preview,
      };
    });
  }, [commit]);

  /** Closes [path] and returns the most recently viewed remaining tab, if any. */
  const close = useCallback((path: string): string | undefined => {
    const next = commit((base) => ({
      ...base,
      tabs: base.tabs.filter((tab) => tab !== path),
      order: base.order.filter((tab) => tab !== path),
      preview: base.preview === path ? undefined : base.preview,
    }));
    return next.order[0];
  }, [commit]);

  /** Drops [path] when leaving a narrow-mode preview if it was never kept or edited. */
  const closePreview = useCallback((path: string) => {
    commit((base) => {
      if (base.preview !== path || draftsRef.current.includes(path)) return base;
      return {
        ...base,
        tabs: base.tabs.filter((tab) => tab !== path),
        order: base.order.filter((tab) => tab !== path),
        preview: undefined,
      };
    });
  }, [commit]);

  const move = useCallback((from: string, to: string) => {
    commit((base) => ({
      ...base,
      tabs: dedupe(base.tabs.map((tab) => renamePath(tab, from, to))),
      order: dedupe(base.order.map((tab) => renamePath(tab, from, to))),
      preview: base.preview ? renamePath(base.preview, from, to) : undefined,
    }));
  }, [commit]);

  const removeUnder = useCallback((removed: string): string | undefined => {
    const gone = (file: string) => file === removed || file.startsWith(`${removed}/`);
    const next = commit((base) => ({
      ...base,
      tabs: base.tabs.filter((tab) => !gone(tab)),
      order: base.order.filter((tab) => !gone(tab)),
      preview: base.preview && gone(base.preview) ? undefined : base.preview,
    }));
    return next.order[0];
  }, [commit]);

  return {
    tabs: current.tabs,
    preview: current.preview,
    open,
    keep,
    normalize,
    close,
    closePreview,
    move,
    removeUnder,
  };
}

/** The open files in the fullscreen files panel: italic while temporary, double-click to keep. */
export function EditorTabs({ files, active, preview, dirty, onOpen, onKeep, onClose }: {
  files: string[];
  active?: string | undefined;
  preview?: string | undefined;
  dirty: string[];
  onOpen: (path: string) => void;
  onKeep: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const { t } = useLingui();
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tab = [...(row.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find((element) => element.dataset.path === active);
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, files.length]);
  // Same-named files carry their folder, as VS Code's tabs do.
  const names = new Map<string, number>();
  for (const file of files) { const { name } = splitPath(file); names.set(name, (names.get(name) ?? 0) + 1); }
  return (
    <div ref={row} role="tablist" aria-label={t`打开的文件`} className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto edge-b px-1.5 scrollbar-none">
      {files.map((file) => {
        const { name, dir } = splitPath(file);
        const selected = file === active;
        const isDirty = dirty.includes(file);
        const isPreview = file === preview && !isDirty;
        return (
          <div
            key={file} data-path={file} role="tab" aria-selected={selected} title={file}
            onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(file); } }}
            onDoubleClick={() => onKeep(file)}
            className={cn('group/tab flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-xs', selected ? 'bg-active text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg')}
          >
            <button type="button" onClick={() => onOpen(file)} className="flex min-w-0 items-center gap-1.5 outline-none">
              <FileIcon entry={{ kind: 'file', name }} className="size-3.5" />
              <span className={cn('truncate', isPreview && 'italic')}>{name}</span>
              {(names.get(name) ?? 0) > 1 && <span className="truncate text-fg-4">{splitPath(dir).name}</span>}
            </button>
            {/* An unsaved file shows a dot where its close button is, until pointed at, as editors do. */}
            <button type="button" aria-label={isDirty ? t`关闭（有未保存的修改）` : t`关闭`} onClick={() => onClose(file)} className={cn('group/close grid size-4 shrink-0 place-items-center rounded text-fg-4 hover:bg-hover hover:text-fg', !selected && !isDirty && 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100')}>
              {isDirty ? <>
                <span className="size-2 rounded-full bg-fg-3 group-hover/tab:hidden group-focus-visible/close:hidden" />
                <IconX className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
              </> : <IconX className="size-3" />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
