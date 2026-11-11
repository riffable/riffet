import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { CapturedSessionReference } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { errorMessage, formatDateTime } from '@/lib/utils';
import { Markdown } from './Markdown';

/** The saved reference is independent of what the source conversation contains now. */
export function SessionReferences({ references, recipientSessionId, onOpenSession }: {
  references?: CapturedSessionReference[];
  recipientSessionId: string;
  onOpenSession?: (id: string) => void;
}) {
  const { t } = useLingui();
  const [selected, setSelected] = useState<CapturedSessionReference>();
  const [original, setOriginal] = useState<Array<{ role: string; text: string; at?: string; id?: string }>>();
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRevision = useRef(0);
  const referenceExcerpt = (excerpt: string) => {
    const requestPrefix = 'Request excerpt: ';
    const answerPrefix = 'Recent answer excerpt: ';
    if (excerpt.startsWith(requestPrefix)) {
      const content = excerpt.slice(requestPrefix.length);
      const divider = `\n${answerPrefix}`;
      const answer = content.indexOf(divider);
      return answer < 0
        ? t`提问节选：${content}`
        : `${t`提问节选：${content.slice(0, answer)}`}\n${t`最近回复节选：${content.slice(answer + divider.length)}`}`;
    }
    return excerpt.startsWith(answerPrefix) ? t`最近回复节选：${excerpt.slice(answerPrefix.length)}` : excerpt;
  };
  useEffect(() => () => { requestRevision.current += 1; }, []);
  if (!references?.length) return null;
  const read = async () => {
    if (!selected || loading) return;
    const revision = ++requestRevision.current;
    setLoading(true); setError('');
    try {
      const snapshot = await api.contextSnapshot(recipientSessionId, selected.snapshotRef);
      if (revision !== requestRevision.current) return;
      setOriginal(snapshot.messages); setPage(0);
    } catch (error) { if (revision === requestRevision.current) setError(errorMessage(error, t`会话暂时无法读取，请重试`)); }
    finally { if (revision === requestRevision.current) setLoading(false); }
  };
  return <>
    <div className="flex max-w-[82%] flex-wrap justify-end gap-1.5">
      {references.map(reference => <button key={reference.sessionId} type="button" onClick={() => { requestRevision.current += 1; setLoading(false); setSelected(reference); setOriginal(undefined); setError(''); }} className="inline-flex min-h-11 max-w-64 items-center gap-1.5 rounded-md bg-subtle px-2 text-xs text-fg-2 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus md:min-h-7">
        <AgentLogo backend={reference.backendId} size={12} /><span className="truncate">{reference.title}</span>
      </button>)}
    </div>
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) { requestRevision.current += 1; setLoading(false); setSelected(undefined); } }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{selected?.title}</DialogTitle></DialogHeader>
        <DialogBody className="flex max-h-[70dvh] flex-col gap-3 overflow-y-auto">
          {selected && <>
            <div className="text-xs text-fg-3"><Trans>引用于 {formatDateTime(selected.capturedAt)}</Trans>{selected.coverage.completeness === 'partial' && <> · <Trans>仅含部分历史</Trans></>}{selected.coverage.activeTurnIncomplete && <> · <Trans>引用时本轮尚未结束</Trans></>}</div>
            <p className="text-xs text-fg-3"><Trans>原文副本随本会话保存</Trans></p>
            <p className="text-xs text-fg-3"><Trans>仅保存提问和回答文字，不含工具记录和附件内容</Trans></p>
            <div className="flex gap-2"><Button size="xs" variant="quiet" disabled={loading} onClick={() => void read()}>{loading ? <Spinner /> : null}<Trans>查看引用时的记录</Trans></Button>{onOpenSession && <Button size="xs" variant="quiet" onClick={() => { requestRevision.current += 1; setLoading(false); onOpenSession(selected.sessionId); setSelected(undefined); }}><Trans>打开原会话</Trans></Button>}</div>
            {error && <p role="status" className="text-sm text-danger">{error}</p>}
            {original ? <>
              <div className="flex items-center gap-2 text-xs text-fg-3"><Button size="xs" variant="quiet" disabled={page === 0} onClick={() => setPage(current => current - 1)}><Trans>上一页</Trans></Button><span>{page + 1} / {Math.max(1, Math.ceil(original.length / 20))}</span><Button size="xs" variant="quiet" disabled={(page + 1) * 20 >= original.length} onClick={() => setPage(current => current + 1)}><Trans>下一页</Trans></Button></div>
              {original.slice(page * 20, (page + 1) * 20).map((message, index) => <div key={message.id ?? index} className="flex flex-col gap-1.5"><div className="text-xs text-fg-3">{page * 20 + index + 1} · {message.role === 'user' ? t`用户` : t`助手`}{message.at ? ` · ${formatDateTime(message.at)}` : ''}</div><div className="whitespace-pre-wrap break-words text-sm text-fg-2">{message.text}</div></div>)}
            </> : <Markdown text={referenceExcerpt(selected.excerpt)} />}
          </>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  </>;
}
