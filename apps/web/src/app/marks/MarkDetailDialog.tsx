import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { API, type Mark, type MarkColor } from '@contracts';
import {
  IconCopy,
  IconCornerUpRight,
  IconFileText,
  IconImageDown,
  IconTrash2,
} from '@/components/icons';
import { AgentLogo } from '@/components/AgentLogo';
import { Button } from '@/components/ui/button';
import { Badge, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { api } from '@/lib/api';
import { agentMarkStyle, useBackendLabel } from '@/lib/backends';
import { copyWithToast } from '@/lib/files';
import { cn, formatDateTime } from '@/lib/utils';
import { ImageViewer } from '../session/ImageViewer';
import { Markdown } from '../session/Markdown';
import { isComposingKey } from '../session/composerKeyboard';
import { MARK_COLORS, markColorLabels, markSwatch } from '../session/marks';
import { markBorderClass, markCopyText, markQuoteClass } from './marksHelpers';

export function MarkDetailDialog({
  mark,
  projectName,
  locating,
  onOpenChange,
  onOpen,
  onOpenFile,
  onShare,
  onLocate,
  onNote,
  onColor,
  onDelete,
}: {
  mark: Mark | undefined;
  projectName: string;
  locating: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: () => void;
  onOpenFile: () => void;
  onShare: () => void;
  onLocate: () => void;
  onNote: (note: string | null) => void;
  onColor: (color: MarkColor) => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useLingui();
  const labelOf = useBackendLabel();
  const [draft, setDraft] = useState(mark?.note ?? '');
  const suppressBlurSave = useRef(false);

  useEffect(() => {
    setDraft(mark?.note ?? '');
    suppressBlurSave.current = false;
  }, [mark?.id, mark?.note]);

  const kindText = mark?.kind === 'span'
    ? t({ message: '高亮', context: 'marks-highlights-tab' })
    : mark?.kind === 'image'
    ? t({ message: '图片', context: 'marks-images-tab' })
    : mark?.kind === 'file'
    ? t({ message: '文件', context: 'marks-files-tab' })
    : t({ message: '回复', context: 'marks-replies-tab' });

  const commitNote = useCallback(() => {
    if (!mark || suppressBlurSave.current) return;
    const next = draft.trim();
    if (next !== (mark.note ?? '')) onNote(next || null);
  }, [mark, draft, onNote]);

  const color = mark?.color ?? 'yellow';
  const canShare = mark?.kind === 'message' || mark?.kind === 'span';

  return (
    <Dialog open={Boolean(mark)} onOpenChange={onOpenChange}>
      <DialogContent size="content" mobileFullscreen aria-describedby={undefined}>
        {mark && (
          <>
            <DialogHeader className="border-b border-line pb-3">
              <DialogTitle className="text-base font-medium leading-snug">
                {mark.snapshot.sessionTitle || t`未命名会话`}
              </DialogTitle>
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-fg-3">
                <Badge>{kindText}</Badge>
                <span>{projectName}</span>
                {mark.backendId && (
                  <span className="inline-flex items-center gap-1">
                    <AgentLogo backend={mark.backendId} size={13} style={agentMarkStyle(mark.backendId)} />
                    <span>{labelOf(mark.backendId)}</span>
                  </span>
                )}
                <time dateTime={mark.createdAt} className="tabular-nums text-fg-4">
                  {formatDateTime(mark.createdAt)}
                </time>
              </div>
            </DialogHeader>

            <DialogBody className="flex flex-1 flex-col gap-5 py-5">
              {mark.state === 'orphaned' && (
                <Notice
                  tone="warning"
                  action={(
                    <Button size="xs" variant="secondary" busy={locating} onClick={onLocate}>
                      <Trans>重新定位</Trans>
                    </Button>
                  )}
                >
                  <Trans>原会话已删除或原文发生偏移，此处保留完整快照。</Trans>
                </Notice>
              )}

              {mark.kind === 'message' && (
                <Markdown text={mark.snapshot.text} className="min-w-0 select-text text-sm" />
              )}

              {mark.kind === 'span' && (
                <div className="flex flex-col gap-2.5">
                  {mark.quote?.prefix && (
                    <p className="select-text text-sm leading-relaxed text-fg-3">
                      {mark.quote.prefix}
                    </p>
                  )}
                  <blockquote
                    className={cn(
                      'select-text rounded-r-lg border-l-2 py-2.5 pl-4 pr-3 text-sm leading-relaxed text-fg',
                      markBorderClass[color],
                      markQuoteClass[color],
                    )}
                  >
                    {mark.quote?.exact.trim()}
                  </blockquote>
                  {mark.quote?.suffix && (
                    <p className="select-text text-sm leading-relaxed text-fg-3">
                      {mark.quote.suffix}
                    </p>
                  )}
                </div>
              )}

              {mark.kind === 'image' && (
                <div className="flex flex-col gap-2">
                  <ImageViewer
                    src={`${API.marks}/${encodeURIComponent(mark.id)}/asset`}
                    name={mark.asset?.name ?? t({ message: '图片', context: 'marks-image-name' })}
                  >
                    <button
                      type="button"
                      aria-label={t`查看大图`}
                      className="block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-xl border border-line bg-subtle"
                    >
                      <img
                        src={`${API.marks}/${encodeURIComponent(mark.id)}/asset`}
                        alt={mark.asset?.name ?? t({ message: '图片', context: 'marks-image-name' })}
                        className="max-h-96 max-w-full object-contain"
                      />
                    </button>
                  </ImageViewer>
                  {mark.asset?.path && (
                    <span className="truncate font-mono text-xs text-fg-3">
                      {mark.asset.path}
                    </span>
                  )}
                </div>
              )}

              {mark.kind === 'file' && (
                <div className="flex min-w-0 items-center gap-3 rounded-xl bg-subtle px-4 py-3">
                  <IconFileText className="size-4 shrink-0 text-fg-3" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-sm font-medium text-fg">{mark.asset?.name}</span>
                    {mark.asset?.path && (
                      <span className="truncate font-mono text-xs text-fg-3">
                        {mark.asset.path}
                      </span>
                    )}
                  </div>
                  {mark.asset?.detail && (
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums text-fg-3">
                      {mark.asset.detail.split(' ').map((part, index) => (
                        <span
                          key={index}
                          className={part.startsWith('+') ? 'text-success' : part.startsWith('−') ? 'text-danger' : undefined}
                        >
                          {part}
                        </span>
                      ))}
                    </span>
                  )}
                  {mark.asset?.path && (
                    <Button size="xs" variant="secondary" onClick={onOpenFile}>
                      <Trans>打开文件</Trans>
                    </Button>
                  )}
                </div>
              )}

              {mark.kind === 'span' && (
                <div className="flex flex-col gap-2 border-t border-line pt-4">
                  <span className="text-xs font-medium text-fg-3"><Trans>高亮颜色</Trans></span>
                  <div className="flex flex-wrap items-center gap-2">
                    {MARK_COLORS.map((option) => (
                      <Button
                        key={option}
                        size="xs"
                        variant={color === option ? 'secondary' : 'quiet'}
                        aria-pressed={color === option}
                        className={cn(color === option && 'ring-1 ring-line-strong')}
                        onClick={() => onColor(option)}
                      >
                        <span aria-hidden className={cn('size-2 rounded-full', markSwatch[option])} />
                        {i18n._(markColorLabels[option])}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-2 border-t border-line pt-4">
                <span className="text-xs font-medium text-fg-3"><Trans>备注</Trans></span>
                <Textarea
                  value={draft}
                  rows={2}
                  placeholder={t`写点什么，方便以后找到它…`}
                  aria-label={t`备注`}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commitNote}
                  onKeyDown={(event) => {
                    if (isComposingKey(event.nativeEvent)) return;
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      commitNote();
                    }
                  }}
                  className="min-h-16 resize-y rounded-lg bg-subtle py-2 text-sm leading-6"
                />
              </div>
            </DialogBody>

            <DialogFooter className="justify-between border-t border-line pt-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {mark.kind !== 'image' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void copyWithToast(markCopyText(mark))}
                  >
                    <IconCopy />
                    {mark.kind === 'file' ? <Trans>复制路径</Trans> : <Trans>复制内容</Trans>}
                  </Button>
                )}
                {canShare && (
                  <Button size="sm" variant="secondary" onClick={onShare}>
                    <IconImageDown />
                    <Trans>导出图片</Trans>
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger-ghost"
                  onPointerDown={() => { suppressBlurSave.current = true; }}
                  onPointerLeave={() => { suppressBlurSave.current = false; }}
                  onClick={() => { suppressBlurSave.current = true; onDelete(); }}
                >
                  <IconTrash2 />
                  <Trans context="marks-delete-action">删除</Trans>
                </Button>
              </div>
              <Button size="sm" variant="primary" onClick={onOpen}>
                <IconCornerUpRight />
                <Trans>前往原会话</Trans>
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
