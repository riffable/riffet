import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion, CouncilInsightTask } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { Badge, Segmented } from '@/components/ui/controls';
import { Checkbox } from '@/components/ui/checkbox';
import { agentMarkStyle } from '@/lib/backends';
import { cn } from '@/lib/utils';

export function CouncilAside({
  discussion,
  litQuoteId,
  litParaId,
  onFocusTurn,
  onHighlightQuote,
  onHighlightPara,
  onToggleAnnotation,
}: {
  discussion: CouncilDiscussion;
  litQuoteId: string | null;
  litParaId: string | null;
  onFocusTurn: (turnId: string) => void;
  onHighlightQuote: (id: string) => void;
  onHighlightPara: (para: string) => void;
  onToggleAnnotation: (id: string) => void;
}) {
  const { t } = useLingui();
  const [filter, setFilter] = useState<'all' | CouncilInsightTask>('all');

  if (discussion.mode === 'debate' && discussion.debate) {
    const sides = discussion.debate.sides ?? [];
    const rounds = discussion.debate.rounds ?? [];
    const lastRound = rounds.at(-1);
    const questions = rounds.flatMap((r, rIdx) => {
      const list: Array<{ sideLabel: string; speaker: string; summary: string; text: string; status: string; targetTurnId: string }> = [];
      for (const turn of r.turns ?? []) {
        if (!turn.question) continue;
        const nextRound = rounds[rIdx + 1];
        const target = nextRound?.turns?.find(nt => nt.replyTo?.turnId === turn.id) ?? turn;
        list.push({
          sideLabel: turn.sideLabel,
          speaker: turn.speaker.model,
          summary: turn.question.summary,
          text: turn.question.text,
          status: turn.question.status,
          targetTurnId: target.id,
        });
      }
      return list;
    });

    return (
      <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-bg max-xl:hidden">
        <div className="flex h-12 shrink-0 items-center border-b border-line px-4 text-sm font-medium text-fg">
          <Trans>交锋记录</Trans>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          {lastRound?.summary && sides.map((side) => {
            const entry = lastRound.summary?.[side.id];
            if (!entry) return null;
            return (
              <div key={side.id} className="flex flex-col gap-1 border-b border-line pb-3">
                <span className="text-xs text-fg-3">{side.label}</span>
                <span className="text-sm text-fg">{entry.claim}</span>
                {entry.weakness && (
                  <span className="text-xs text-warning"><Trans>待补：{entry.weakness}</Trans></span>
                )}
              </div>
            );
          })}
          <div className="text-xs font-medium text-fg-3"><Trans>质询定位</Trans></div>
          <div className="flex flex-col gap-1">
            {questions.length === 0 ? (
              <p className="text-xs text-fg-4"><Trans>发言完成后将显示质询记录</Trans></p>
            ) : questions.map((q, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => onFocusTurn(q.targetTurnId)}
                className="flex flex-col gap-1 rounded-lg p-2 text-left transition-colors hover:bg-hover"
              >
                <div className="flex w-full items-center gap-1.5">
                  <span className="text-xs text-fg-3">{q.sideLabel} · {q.speaker}</span>
                  <span className="ml-auto">
                    <Badge tone={q.status === 'direct' ? 'success' : q.status === 'dodged' ? 'danger' : 'neutral'}>
                      {q.status === 'direct' ? t`已正面回应` : q.status === 'dodged' ? t`未正面回应` : t`待回应`}
                    </Badge>
                  </span>
                </div>
                <div className="text-sm font-medium text-fg">{q.summary}</div>
                <div className="text-xs leading-relaxed text-fg-2">{q.text}</div>
              </button>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  if (discussion.mode === 'prism' && discussion.prism) {
    const prism = discussion.prism;
    const participants = prism.participants ?? [];
    const contradictions = prism.contradictions ?? [];
    return (
      <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-bg max-xl:hidden">
        <div className="flex h-12 shrink-0 items-center border-b border-line px-4 text-sm font-medium text-fg">
          <Trans>各方立场</Trans>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          {participants.map((p) => {
            const exp = prism.explore[p.id];
            const dep = prism.deepen[p.id];
            return (
              <div key={p.id} className="flex flex-col gap-1 border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <AgentLogo backend={p.backendId} size={13} style={agentMarkStyle(p.backendId)} />
                  <span className="truncate text-sm font-medium text-fg">{p.model}</span>
                </div>
                <div className="text-xs text-fg-2">
                  {exp?.stance ?? t`等待作答`}
                  {dep?.shifted && (
                    <> → <span className="font-medium text-success">{dep.newStance}</span></>
                  )}
                </div>
              </div>
            );
          })}
          {contradictions.length > 0 && (
            <>
              <div className="text-xs font-medium text-fg-3"><Trans>分歧索引</Trans></div>
              <div className="flex flex-col gap-1">
                {contradictions.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onHighlightQuote(c.id)}
                    className={cn(
                      'flex flex-col gap-1 rounded-lg p-2 text-left transition-colors hover:bg-hover',
                      litQuoteId === c.id && 'bg-active',
                    )}
                  >
                    <div className="text-sm font-medium text-fg">{c.title}</div>
                    <div className="text-xs leading-relaxed text-fg-2">{c.question}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </aside>
    );
  }

  if (discussion.mode === 'insight' && discussion.insight) {
    const annotations = discussion.insight.annotations ?? [];
    const shown = annotations.filter((a) => filter === 'all' || a.task === filter);
    return (
      <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-bg max-xl:hidden">
        <div className="flex h-12 shrink-0 items-center border-b border-line px-4 text-sm font-medium text-fg">
          <Trans>修改建议 · {annotations.length}</Trans>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <Segmented
            size="xs"
            ariaLabel={t`筛选`}
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t`全部` },
              { value: 'correct', label: t`修改` },
              { value: 'augment', label: t`补充` },
              { value: 'diagnose', label: t`问题` },
              { value: 'restructure', label: t`结构` },
            ]}
          />
          <div className="flex flex-col gap-1">
            {shown.length === 0 ? (
              <p className="py-4 text-center text-xs text-fg-4"><Trans>暂无符合条件的建议</Trans></p>
            ) : shown.map((a) => (
              <div
                key={a.id}
                role="button"
                tabIndex={0}
                onClick={() => onHighlightPara(a.para)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onHighlightPara(a.para); } }}
                className={cn(
                  'flex cursor-pointer flex-col gap-1.5 rounded-lg p-2.5 text-left transition-colors hover:bg-hover',
                  litParaId === a.para && 'bg-active',
                )}
              >
                <div className="flex items-center gap-2">
                  <span onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={a.checked}
                      aria-label={t`选中`}
                      onCheckedChange={() => onToggleAnnotation(a.id)}
                    />
                  </span>
                  <Badge tone={a.task === 'correct' ? 'warning' : 'neutral'}>{a.taskLabel}</Badge>
                  <span className="font-mono text-xs text-fg-3">{a.para}</span>
                  <span className="ml-auto truncate text-xs text-fg-3">{a.modelLabel}</span>
                </div>
                <div className="text-sm font-medium text-fg">{a.title}</div>
              </div>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  return null;
}
