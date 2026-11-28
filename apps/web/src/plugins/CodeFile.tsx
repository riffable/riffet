import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { FilePreview } from '@contracts';
import type { CodeFileCommandName, CodeFileProps, FileIconProps } from '@riffet/plugin-web';
import { IconDownload, IconFile, IconImage, IconRefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, Spinner } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { api, HttpError, isFileReference, projectImageUrl } from '@/lib/api';
import { downloadProjectFile } from '@/lib/files';
import { errorMessage, formatBytes } from '@/lib/utils';
import { useLists } from '../app/state/stores';
import { detectIndent, detectLineEnding } from '../app/panels/codeEditing';
import type { CodeCommand, CodeCommandName, CodeSelectionStats } from '../app/panels/CodeView';
import { useDraftsGuard } from '../app/panels/fileDrafts';
import { FileIcon as PanelFileIcon } from '../app/panels/fileVisuals';
import { useFileEditing } from '../app/panels/useFileEditing';
import { ZoomPanImage } from '../app/session/ZoomPanImage';

const CodeView = lazy(() => import('../app/panels/CodeView').then((module) => ({ default: module.CodeView })));

type Loaded = { state: 'loading' } | { state: 'ready'; preview: FilePreview } | { state: 'missing' } | { state: 'failed'; message: string };

const isViewCommand = (name: CodeFileCommandName): name is CodeCommandName => name !== 'save' && name !== 'revert';

/**
 * `UiKit.CodeFile`: a project file read (and optionally edited) the way the files panel handles it,
 * for a plugin view that lays out its own surface (`plugins/riffet/code-studio`). When `editable` is
 * set and the server supports `file-write-v1`, it shares the host's draft pool, optimistic-hash
 * save, conflict merge (`unifiedMergeView`) and beforeunload guard.
 */
export function CodeFile({
  projectId, path, target, command, editable = false, readOnly = false, watching = false, wordWrap = false, indent, stateKey,
  onEditState, onSaved, onSaveAll, onSymbol, onMenu, onTopLine, onLine, onViewport, onCaret, folding, baseline, blame, onBlameCommit,
}: CodeFileProps) {
  const { t } = useLingui();
  const fileWrites = useLists((state) => state.fileWrites);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const [selectionStats, setSelectionStats] = useState<CodeSelectionStats>({ line: 1, column: 1, selections: 1, selectedChars: 0 });

  useEffect(() => {
    let live = true;
    setLoaded({ state: 'loading' });
    setImageFailed(false);
    setSelectionStats({ line: 1, column: 1, selections: 1, selectedChars: 0 });
    api.preview(projectId, path).then(
      (preview) => { if (live) setLoaded({ state: 'ready', preview }); },
      (error: unknown) => {
        if (!live) return;
        setLoaded(error instanceof HttpError && error.status === 404 ? { state: 'missing' } : { state: 'failed', message: errorMessage(error, t`无法打开文件`) });
      },
    );
    return () => { live = false; };
  }, [projectId, path, attempt, t]);

  const preview = loaded.state === 'ready' ? loaded.preview : undefined;
  const onPreview = useCallback((next: FilePreview) => {
    setLoaded((current) => (current.state === 'ready' && current.preview.path === next.path ? { state: 'ready', preview: next } : current));
  }, []);

  const writable = Boolean(editable && fileWrites && !readOnly);
  const edit = useFileEditing({
    projectId,
    preview,
    onPreview,
    writable,
    watching: Boolean(editable && watching && preview && !preview.binary),
    defaultEditing: writable,
    ...(onSaved ? { onSaved } : {}),
  });
  useDraftsGuard();

  const editRef = useRef(edit);
  editRef.current = edit;
  const handledCommand = useRef(0);
  useEffect(() => {
    if (!command || command.token === handledCommand.current) return;
    if (command.name === 'save') {
      handledCommand.current = command.token;
      void editRef.current.save(editRef.current.conflict);
    } else if (command.name === 'revert') {
      handledCommand.current = command.token;
      void editRef.current.takeDisk();
    }
  }, [command]);

  const viewCommand: CodeCommand | undefined = useMemo(
    () => (command && isViewCommand(command.name) ? { name: command.name, token: command.token } : undefined),
    [command],
  );

  const detectedIndent = useMemo(
    () => (preview && !preview.binary && !preview.image ? detectIndent(preview.content, preview.path) : { kind: 'spaces' as const, size: 2 as const }),
    [preview?.path, preview?.hash], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const effectiveIndent = indent ?? detectedIndent;
  const lineEnding = useMemo(
    () => (preview && !preview.binary && !preview.image ? detectLineEnding(preview.content) : 'LF'),
    [preview?.path, preview?.hash], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onEditStateRef = useRef(onEditState);
  onEditStateRef.current = onEditState;
  useEffect(() => {
    if (!preview || !onEditStateRef.current) return;
    onEditStateRef.current({
      path: preview.path,
      editable: Boolean(editable && fileWrites && preview.editable),
      editing: edit.editing,
      dirty: edit.dirty,
      saving: edit.saving,
      conflict: edit.conflict,
      truncated: Boolean(preview.truncated),
      lineEnding,
      indent: effectiveIndent,
      selections: selectionStats.selections,
      selectedChars: selectionStats.selectedChars,
    });
  }, [
    preview?.path, preview?.editable, preview?.truncated, editable, fileWrites,
    edit.editing, edit.dirty, edit.saving, edit.conflict,
    lineEnding, effectiveIndent.kind, effectiveIndent.size,
    selectionStats.selections, selectionStats.selectedChars,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loaded.state === 'loading') return <div className="flex flex-1 justify-center py-10"><Spinner /></div>;
  if (loaded.state === 'missing') return <EmptyState className="flex-1" title={t`文件不存在`} />;
  if (loaded.state === 'failed') {
    return <EmptyState className="flex-1" title={loaded.message}><Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}><IconRefreshCw /><Trans>重试</Trans></Button></EmptyState>;
  }
  const ready = loaded.preview;
  if (ready.image) {
    if (imageFailed) return <EmptyState className="flex-1" icon={<IconImage />} title={t`图片无法加载`} />;
    const src = projectImageUrl(projectId, ready.path, ready.hash);
    return <ZoomPanImage src={src} alt={ready.path.split('/').at(-1) ?? ready.path} className="min-h-0 flex-1 bg-subtle/30" onError={() => setImageFailed(true)} />;
  }
  if (ready.binary) {
    return (
      <EmptyState className="flex-1" icon={<IconFile />} title={t`二进制文件`} description={formatBytes(ready.size)}>
        <Button variant="secondary" onClick={() => downloadProjectFile(projectId, ready.path)}><IconDownload /><Trans>下载</Trans></Button>
      </EmptyState>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {editable && edit.conflict && (
        <Notice tone="warning" className="mx-3 mt-2 shrink-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span><Trans>这个文件在你编辑时被改过</Trans></span>
            <div className="flex flex-wrap items-center gap-1">
              <Button size="xs" variant="secondary" aria-pressed={edit.comparing} onClick={() => edit.setComparing((value) => !value)}>
                {edit.comparing ? <Trans>收起比较</Trans> : <Trans>比较</Trans>}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => void edit.takeDisk()}><Trans>用磁盘上的版本</Trans></Button>
              <Button size="xs" variant="primary" busy={edit.saving} onClick={() => void edit.save(true)}><Trans>覆盖保存</Trans></Button>
            </div>
          </div>
        </Notice>
      )}
      <Suspense fallback={<div className="flex flex-1 justify-center py-10"><Spinner /></div>}>
        <CodeView
          preview={ready}
          {...(editable ? { text: edit.text ?? ready.content, editing: edit.editing, original: edit.original } : {})}
          target={target}
          baseline={baseline}
          blame={blame}
          caret={Boolean(onCaret)}
          wordWrap={wordWrap}
          indent={effectiveIndent}
          {...(stateKey ? { stateKey } : {})}
          command={viewCommand}
          {...(onMenu ? { onMenu } : {})}
          folding={Boolean(folding)}
          {...(onCaret ? { onCaret } : {})}
          onSelectionStats={setSelectionStats}
          {...(onViewport ? { onViewport } : {})}
          {...(onBlameCommit ? { onBlameCommit } : {})}
          onReference={(reference) => { if (isFileReference(reference) && reference.line !== undefined) onLine?.({ path: reference.path, line: reference.line, text: reference.text ?? '' }); }}
          {...(onSymbol ? { onSymbol } : {})}
          {...(onTopLine ? { onTopLine } : {})}
          {...(editable ? {
            onChange: edit.change,
            onSave: () => void edit.save(),
            ...(onSaveAll ? { onSaveAll } : {}),
            ...(writable ? {} : { onEscape: edit.escape }),
          } : {})}
        />
      </Suspense>
      {ready.truncated && <div className="shrink-0 edge-t px-4 py-1.5 text-xs text-fg-3"><Trans>文件过大，仅显示前一部分</Trans></div>}
    </div>
  );
}

export function FileIcon({ name, directory, open, kind, className }: FileIconProps) {
  return (
    <PanelFileIcon
      entry={{ name, kind: directory ? 'directory' : 'file' }}
      {...(open !== undefined ? { open } : {})}
      {...(kind !== undefined ? { kind } : {})}
      {...(className ? { className } : {})}
    />
  );
}
