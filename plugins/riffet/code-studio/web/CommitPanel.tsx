import { useEffect, useState } from 'react';
import type { GitCommitDetail } from '@contracts';
import { usePluginHost } from '@riffet/plugin-web';
import { cn } from './cn';
import { type CodeApi, dirName, fileName } from './data';
import type { Messages } from './messages';

type File = GitCommitDetail['files'][number];
type Diff = { path: string; before?: string; after?: string; loading: boolean; error?: string };

const STATUS_TONE: Record<string, string> = { A: 'text-success', D: 'text-danger', R: 'text-accent' };

/**
 * A commit in the bottom panel, as the IDE's Git log shows one a blame line was clicked on: its message,
 * author and date, the files it changed, and the chosen file's change in it with the app's diff view. The
 * file the reader came from is chosen first when the commit changed it.
 */
export function CommitPanel({ api, hash, from, messages: m, onOpen, onClose }: { api: CodeApi; hash: string; from?: string | undefined; messages: Messages; onOpen(path: string): void; onClose(): void }) {
  const host = usePluginHost();
  const { ui } = host;
  const [detail, setDetail] = useState<{ hash: string; commit?: GitCommitDetail; error?: string }>();
  const [chosen, setChosen] = useState<string>();
  const [diff, setDiff] = useState<Diff>();

  useEffect(() => {
    const controller = new AbortController();
    setDetail({ hash });
    setChosen(undefined);
    api.commit(hash, controller.signal).then((commit) => {
      setDetail({ hash, commit });
      setChosen((commit.files.find((file) => file.path === from) ?? commit.files[0])?.path);
    }, (error: unknown) => { if (!controller.signal.aborted) setDetail({ hash, error: host.notify.errorText(error, m.loadFailed) }); });
    return () => controller.abort();
  }, [api, hash, from]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = detail?.hash === hash ? detail.commit : undefined;
  const file = commit?.files.find((item) => item.path === chosen);
  useEffect(() => {
    if (!commit || !file) { setDiff(undefined); return; }
    const controller = new AbortController();
    const parent = commit.parents[0];
    setDiff({ path: file.path, loading: true });
    // Each side as committed: the parent's (under its old name for a rename) and this commit's.
    type Side = { text?: string; binary?: boolean; truncated?: boolean };
    const side = (path: string, rev: string | undefined, absent: boolean): Promise<Side> => (absent || !rev ? Promise.resolve({ text: '' }) : api.fileAt(path, rev, controller.signal));
    Promise.all([side(file.originalPath ?? file.path, parent, file.status.startsWith('A')), side(file.path, commit.hash, file.status.startsWith('D'))]).then(([before, after]) => {
      if (controller.signal.aborted) return;
      const unreadable = [before, after].some((part) => part.binary || part.truncated);
      setDiff(unreadable ? { path: file.path, loading: false, error: m.commit.binary } : { path: file.path, loading: false, before: before.text ?? '', after: after.text ?? '' });
    }, (error: unknown) => { if (!controller.signal.aborted) setDiff({ path: file.path, loading: false, error: host.notify.errorText(error, m.loadFailed) }); });
    return () => controller.abort();
  }, [api, commit, file]); // eslint-disable-line react-hooks/exhaustive-deps

  const X = ui.icon('x');
  const Copy = ui.icon('copy');
  const short = hash.slice(0, 10);
  const shownFiles = commit?.files ?? [];
  return (
    <section aria-label={m.commit.title(short)} className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 edge-b pl-3 pr-1.5 text-xs">
        <span className="min-w-0 truncate font-medium text-fg">{commit?.subject ?? m.commit.title(short)}</span>
        {!commit && !detail?.error && <ui.Spinner className="size-3" />}
        <span className="flex-1" />
        <ui.Tip label={m.commit.copyHash}>
          <button type="button" onClick={() => { void ui.copy(hash); }} className="flex items-center gap-1 rounded px-1 font-mono text-2xs text-fg-3 hover:bg-hover hover:text-fg">
            {short}<Copy className="size-3" />
          </button>
        </ui.Tip>
        <ui.Tip label={m.closePanel} kbd="Esc"><ui.Button size="icon-xs" variant="quiet" aria-label={m.closePanel} onClick={onClose}><X /></ui.Button></ui.Tip>
      </div>
      {detail?.error ? <p className="px-3 py-2 text-xs text-danger" role="alert">{detail.error}</p> : (
        <div className="flex min-h-0 flex-1" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
          <div className="flex w-[38%] min-w-56 max-w-md shrink-0 flex-col edge-r">
            {commit && (
              <div className="grid shrink-0 gap-1 edge-b px-3 py-2 text-xs">
                <div className="flex min-w-0 items-center gap-2 text-fg-3">
                  <span className="truncate text-fg-2">{commit.author}</span>
                  <span className="shrink-0 tabular-nums">{commit.date.slice(0, 16).replace('T', ' ')}</span>
                </div>
                {commit.body.trim() && <p className="max-h-24 overflow-auto whitespace-pre-wrap text-fg-2">{commit.body.trim()}</p>}
                <span className="text-fg-4">{commit.filesTotal ? m.commit.filesOf(shownFiles.length, commit.filesTotal) : m.commit.files(shownFiles.length)}</span>
              </div>
            )}
            <ul aria-label={m.commit.files(shownFiles.length)} className="min-h-0 flex-1 overflow-auto p-1">
              {shownFiles.map((item: File) => {
                const letter = item.status.charAt(0);
                return (
                  <li key={item.path}>
                    <button
                      type="button" aria-current={item.path === chosen || undefined}
                      // Double click opens the file as it is now, as a double click in the IDE's change list does.
                      onClick={() => setChosen(item.path)} onDoubleClick={() => { if (letter !== 'D') onOpen(item.path); }}
                      className={cn('flex h-6 w-full cursor-default items-center gap-2 rounded px-2 text-left text-xs hover:bg-hover', item.path === chosen && 'bg-active')}
                      title={item.originalPath ? `${item.originalPath} → ${item.path}` : item.path}
                    >
                    <span aria-label={m.commit.status[letter] ?? letter} className={cn('w-2.5 shrink-0 font-mono text-2xs', STATUS_TONE[letter] ?? 'text-fg-3')}>{letter}</span>
                    <span className="shrink-0 text-fg-2">{fileName(item.path)}</span>
                    <span className="min-w-0 flex-1 truncate text-fg-4">{dirName(item.path)}</span>
                    {(item.added !== undefined || item.removed !== undefined) && (
                      <span className="shrink-0 tabular-nums text-2xs"><span className="text-success">+{item.added ?? 0}</span> <span className="text-danger">−{item.removed ?? 0}</span></span>
                    )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="min-w-0 flex-1 overflow-auto p-2">
            {diff?.loading && <div className="flex justify-center py-4"><ui.Spinner /></div>}
            {diff?.error && <p className="px-1 py-2 text-xs text-fg-3">{diff.error}</p>}
            {diff && !diff.loading && !diff.error && diff.before !== undefined && diff.after !== undefined && (
              <ui.DiffView path={diff.path} before={diff.before} after={diff.after} remember={`code-studio:${hash}:${diff.path}`} onOpenPath={onOpen} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
