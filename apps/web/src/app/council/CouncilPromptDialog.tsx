import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion, CouncilPrompts } from '@contracts';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { IconBookOpen } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Field, Select, Spinner } from '@/components/ui/controls';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { Tip } from '@/components/ui/tooltip';
import { useLingering, WAIT_GRACE_MS } from '@/app/session/sessionLayout';
import { LEAD_ROLES, seatName, useCouncilLabels } from './model';

function PromptText({ title, text }: { title?: string; text: string }) {
  return (
    <section className="min-w-0">
      {title && <h3 className="mb-2 text-sm font-medium text-fg">{title}</h3>}
      <div className="relative">
        <CopyButton text={text} className="absolute top-2 right-2" />
        <pre className="select-text whitespace-pre-wrap wrap-anywhere rounded-xl bg-subtle p-4 pr-14 font-mono text-sm leading-6 text-fg-2">{text}</pre>
      </div>
    </section>
  );
}

function PromptReader({ result, historical, hasRecord }: { result: CouncilPrompts; historical: boolean; hasRecord: boolean }) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-4">
      {result.prompt
        ? <PromptText title={historical ? t`发言提示词原文` : undefined} text={result.prompt} />
        : <p className="text-sm text-fg-3">{t`这次发言没有可读取的提示词原文。`}</p>}
      {result.record ? <PromptText title={t`结构化记录提示词`} text={result.record} />
        : hasRecord && <p className="text-sm text-fg-3">{t`这次结构化记录没有可读取的提示词原文。`}</p>}
    </div>
  );
}

type PromptChoice = { seatId: string; speechId?: string };
type PromptPage = { choice: PromptChoice } & ({ result: CouncilPrompts } | { error: string });

function PromptChoices({ discussion }: { discussion: CouncilDiscussion }) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const [choice, choose] = useState<PromptChoice>(() => ({
    seatId: (discussion.seats.find(seat => LEAD_ROLES.has(seat.role)) ?? discussion.seats[0])!.id,
  }));
  const [page, setPage] = useState<PromptPage>();
  const body = useRef<HTMLDivElement>(null);
  const requestedSpeech = discussion.speeches.find(speech => speech.id === choice.speechId);
  // A brief can include the roster or review document. Only keep it while those inputs are current.
  const briefs = useMemo(() => new Map<string, CouncilPrompts>(), [discussion.seats, discussion.topic, discussion.document]);
  useEffect(() => {
    const cached = !choice.speechId && briefs.get(choice.seatId);
    if (cached) {
      setPage({ choice, result: cached });
      return;
    }
    const controller = new AbortController();
    void api.councilPrompts(discussion.id, choice.seatId, choice.speechId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (!choice.speechId) briefs.set(choice.seatId, result);
      setPage({ choice, result });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setPage({ choice, error: errorMessage(error, t`无法读取提示词`) });
    });
    return () => controller.abort();
  }, [discussion.id, choice, requestedSpeech?.runId, requestedSpeech?.recordRunId, briefs, t]);

  // Commit the controls and their text together, so the previous prompt stays readable under its own label.
  const shown = page?.choice ?? choice;
  const speeches = useMemo(() => discussion.speeches.filter(speech => speech.seatId === shown.seatId), [discussion.speeches, shown.seatId]);
  const selected = speeches.find(speech => speech.id === shown.speechId);
  const pending = page?.choice !== choice;
  const showSpinner = useLingering(pending, WAIT_GRACE_MS);
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [shown.seatId, shown.speechId]);
  const seatOptions = useMemo(() => discussion.seats.map(seat => ({
    value: seat.id, label: `${labels.role(seat)} · ${seatName(seat, discussion.seats)}`,
  })), [discussion.seats, labels]);
  const sourceOptions = useMemo(() => [
    { value: '', label: t`当前角色设定` },
    ...speeches.map(speech => ({
      value: speech.id, label: `${labels.round(speech.round)} · ${labels.phase(discussion.format, speech.phase)}`,
    })),
  ], [speeches, discussion.format, labels, t]);
  return (
    <>
      <div className="grid shrink-0 gap-3 px-5 pb-4 sm:grid-cols-2">
        <Field label={t`席位`}>
          <Select label={t`席位`} value={shown.seatId} options={seatOptions} onChange={seatId => choose({ seatId })} />
        </Field>
        <Field label={<span className="inline-flex items-center gap-2">{t`提示词来源`}
          {showSpinner && <span role="status" aria-label={t`正在读取提示词`}><Spinner /></span>}
        </span>}>
          <Select label={t`提示词来源`} value={shown.speechId ?? ''} options={sourceOptions} onChange={speechId => choose({ seatId: shown.seatId, speechId: speechId || undefined })} />
        </Field>
      </div>
      <DialogBody ref={body} aria-busy={pending} className="flex-1 pb-5 [scrollbar-gutter:stable]">
        {page && ('error' in page
          ? <Notice tone="danger" action={<Button size="xs" busy={pending} onClick={() => choose({ ...shown })}>{t`重试`}</Button>}>{page.error}</Notice>
          : <PromptReader result={page.result} historical={Boolean(shown.speechId)} hasRecord={Boolean(selected?.recordRunId || selected?.directive)} />)}
      </DialogBody>
    </>
  );
}

export function CouncilPromptDialog({ discussion }: { discussion: CouncilDiscussion }) {
  const { t } = useLingui();
  return (
    <Dialog>
      <Tip label={t`查看协作提示词`}>
        <DialogTrigger asChild>
          <Button variant="quiet" size="icon-sm" className="max-md:size-11 no-hover:size-11" aria-label={t`查看协作提示词`}><IconBookOpen /></Button>
        </DialogTrigger>
      </Tip>
      <DialogContent size="content" mobileFullscreen className="md:h-144">
        <DialogHeader>
          <DialogTitle>{t`协作提示词`}</DialogTitle>
          <DialogDescription>{t`首次发言包含角色设定，后续回合补入该席位可见的新内容和本轮任务。`}</DialogDescription>
        </DialogHeader>
        <PromptChoices discussion={discussion} />
      </DialogContent>
    </Dialog>
  );
}
