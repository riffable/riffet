import { useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion, CouncilInsightAnnotation } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge, Segmented, Spinner } from '@/components/ui/controls';
import { agentMarkStyle } from '@/lib/backends';
import { cn } from '@/lib/utils';

function renderPreviewParagraph(text: string, anns: CouncilInsightAnnotation[]): ReactNode {
  const checked = anns.filter((a) => a.checked);
  if (!checked.length) return text;
  let remaining = text;
  const parts: ReactNode[] = [];
  checked.forEach((a, i) => {
    const idx = a.before ? remaining.indexOf(a.before) : -1;
    if (idx >= 0) {
      if (idx > 0) parts.push(remaining.slice(0, idx));
      parts.push(
        <span key={`${a.id}-${i}`} className="mx-0.5">
          <span className="rounded-xs bg-diff-del px-1 line-through">{a.before}</span>{' '}
          <span className="rounded-xs bg-diff-add px-1">{a.after}</span>
        </span>,
      );
      remaining = remaining.slice(idx + a.before.length);
    } else {
      parts.push(<span key={`${a.id}-add-${i}`}> <span className="rounded-xs bg-diff-add px-1">{a.after}</span></span>);
    }
  });
  if (remaining) parts.push(remaining);
  return parts;
}

export function InsightStage({
  discussion,
  litParaId,
  onSelectPara,
  onToggleAnnotation,
  onAdvance,
}: {
  discussion: CouncilDiscussion;
  litParaId: string | null;
  onSelectPara: (para: string) => void;
  onToggleAnnotation: (id: string) => void;
  onAdvance: () => void;
}) {
  const { t } = useLingui();
  const insight = discussion.insight;
  const [docMode, setDocMode] = useState<'annotate' | 'preview'>('annotate');

  if (!insight) return null;

  const participants = insight.participants ?? [];
  const annotations = insight.annotations ?? [];
  const paragraphs = insight.paragraphs ?? [];
  const checkedCount = annotations.filter((a) => a.checked).length;
  const running = discussion.status === 'running';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {/* Reviewers strip */}
      <div className="flex flex-wrap items-center gap-2">
        {participants.map((p) => {
          const rev = insight.reviews[p.id];
          return (
            <span key={p.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-subtle px-2.5 py-1 text-xs text-fg-2">
              {!rev && running ? <Spinner /> : <AgentLogo backend={p.backendId} size={12} style={agentMarkStyle(p.backendId)} />}
              <span>{p.model}</span>
              {rev && <span className="text-fg-3"><Trans>· {rev.role}：{rev.summary}</Trans></span>}
            </span>
          );
        })}
        <span className="flex-1" />
        {annotations.length > 0 && (
          <span className="text-xs text-fg-3">
            <Trans>已采纳 {checkedCount} / {annotations.length}</Trans>
          </span>
        )}
      </div>

      {/* Document Sheet */}
      <section className="overflow-hidden rounded-xl border border-line bg-bg">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle px-4 py-2.5">
          <span className="font-mono text-xs text-fg-2">{insight.sourceTitle || t`文档草稿`}</span>
          <span className="flex-1" />
          {annotations.length > 0 ? (
            <Segmented
              size="xs"
              ariaLabel={t`文档视图`}
              value={docMode}
              onChange={setDocMode}
              options={[
                { value: 'annotate', label: t`原文批注` },
                { value: 'preview', label: t`修订预览 (${checkedCount})` },
              ]}
            />
          ) : discussion.phaseIndex === 0 && discussion.status === 'paused' ? (
            <Button size="xs" variant="primary" onClick={onAdvance}><Trans>开始审阅</Trans></Button>
          ) : null}
        </div>

        {insight.goal && (
          <div className="border-b border-line px-4 py-2.5 text-xs text-fg-2 select-text">
            <Trans>目标：{insight.goal}</Trans>
          </div>
        )}

        <div className="divide-y divide-line">
          {paragraphs.map((p) => {
            const anns = annotations.filter((a) => a.para === p.id);
            const hasChecked = anns.some((a) => a.checked);
            const isLit = litParaId === p.id;

            return (
              <div
                key={p.id}
                id={`council-para-${p.id}`}
                className={cn(
                  'relative transition-colors',
                  anns.length > 0 && (hasChecked ? 'border-l-2 border-l-success' : 'border-l-2 border-l-line-strong'),
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectPara(p.id)}
                  className={cn(
                    'flex w-full items-start gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-hover',
                    isLit && 'bg-accent/10',
                  )}
                >
                  <span className="w-6 shrink-0 font-mono text-xs leading-6 text-fg-4">{p.id}</span>
                  <div className="min-w-0 flex-1 text-sm leading-6 text-fg select-text">
                    {docMode === 'preview' ? renderPreviewParagraph(p.text, anns) : p.text}
                  </div>
                  {anns.length > 0 && (
                    <Badge tone={hasChecked ? 'success' : 'neutral'}>
                      <Trans>{anns.length} 条建议</Trans>
                    </Badge>
                  )}
                </button>

                {docMode === 'annotate' && isLit && anns.length > 0 && (
                  <div className="mx-4 mb-3.5 ml-13 flex flex-col gap-2">
                    {anns.map((a) => (
                      <div key={a.id} className="flex flex-col gap-2 rounded-lg border border-line bg-subtle p-3">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={a.checked}
                            aria-label={t`采纳修改`}
                            onCheckedChange={() => onToggleAnnotation(a.id)}
                          />
                          <Badge tone={a.task === 'correct' ? 'warning' : 'neutral'}>{a.taskLabel}</Badge>
                          <span className="text-sm font-medium text-fg">{a.title}</span>
                          <span className="ml-auto text-xs text-fg-3">{a.modelLabel}</span>
                        </div>
                        <div className="rounded-md bg-diff-del px-2 py-1 text-xs leading-relaxed text-fg select-text">- {a.before}</div>
                        <div className="rounded-md bg-diff-add px-2 py-1 text-xs leading-relaxed text-fg select-text">+ {a.after}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {insight.synthesis && (
        <div className="rounded-xl border border-line bg-subtle px-4 py-3 text-sm leading-relaxed text-fg-2 select-text">
          <Trans>汇总建议：{insight.synthesis}</Trans>
        </div>
      )}
    </div>
  );
}
