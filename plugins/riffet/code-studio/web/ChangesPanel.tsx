import { usePluginHost } from '@riffet/plugin-web';
import { fileName } from './data';
import type { Messages } from './messages';

/** A file against HEAD, as Git's Compare with HEAD shows it; `before` absent when HEAD has no such file. */
export interface Changes { path: string; before?: string | undefined; after?: string; loading: boolean; error?: string }

/**
 * Compare with HEAD in the bottom panel, where find results go: the file as committed against the file
 * on disk, with the app's diff view. A file HEAD lacks is said to be new rather than drawn as all added.
 */
export function ChangesPanel({ changes, messages: m, onOpen, onClose }: { changes: Changes; messages: Messages; onOpen(path: string): void; onClose(): void }) {
  const { ui } = usePluginHost();
  const X = ui.icon('x');
  const same = !changes.loading && !changes.error && changes.before !== undefined && changes.before === changes.after;
  return (
    <section aria-label={m.changes(fileName(changes.path))} className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 edge-b pl-3 pr-1.5 text-xs">
        <span className="min-w-0 truncate font-medium text-fg">{m.changes(fileName(changes.path))}</span>
        {changes.loading && <ui.Spinner className="size-3" />}
        <span className="flex-1" />
        <ui.Tip label={m.closePanel} kbd="Esc"><ui.Button size="icon-xs" variant="quiet" aria-label={m.closePanel} onClick={onClose}><X /></ui.Button></ui.Tip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
        {changes.error && <p className="px-1 py-2 text-xs text-danger" role="alert">{changes.error}</p>}
        {same && <p className="px-1 py-2 text-xs text-fg-3">{m.noChanges}</p>}
        {!changes.loading && !changes.error && changes.before === undefined && <p className="px-1 py-2 text-xs text-fg-3">{m.newFile}</p>}
        {!changes.loading && !changes.error && !same && changes.before !== undefined && changes.after !== undefined && (
          <ui.DiffView path={changes.path} before={changes.before} after={changes.after} remember={`code-studio:${changes.path}`} onOpenPath={onOpen} />
        )}
      </div>
    </section>
  );
}
