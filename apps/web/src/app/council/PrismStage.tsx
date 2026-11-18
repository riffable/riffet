import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge, Spinner } from '@/components/ui/controls';
import { IconChevronRight } from '@/components/icons';
import { agentMarkStyle } from '@/lib/backends';
import { Markdown } from '../session/Markdown';
import { cn } from '@/lib/utils';

function highlightSnippet(text: string, snippet?: string) {
  if (!snippet) return <Markdown text={text} />;
  const idx = text.indexOf(snippet);
  if (idx < 0) return <Markdown text={text} />;
  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed text-fg">
      {text.slice(0, idx)}
      <mark className="rounded-xs bg-accent/15 px-1 text-fg">{snippet}</mark>
      {text.slice(idx + snippet.length)}
    </div>
  );
}

export function PrismStage({
  discussion,
  litQuoteId,
  liveStreams,
  onToggleContradiction,
  onAdvance,
}: {
  discussion: CouncilDiscussion;
  litQuoteId: string | null;
  liveStreams: Record<string, { text?: string; thought?: string }>;
  onToggleContradiction: (id: string) => void;
  onAdvance: () => void;
}) {
  const { t } = useLingui();
  const prism = discussion.prism;
  const [hoverClashId, setHoverClashId] = useState<string | null>(null);
  const [openThoughts, setOpenThoughts] = useState<Set<string>>(() => new Set());

  if (!prism) return null;

  const activeClashId = hoverClashId ?? litQuoteId;
  const participants = prism.participants ?? [];
  const contradictions = prism.contradictions ?? [];
  const gaps = prism.gaps ?? [];
  const activeClash = contradictions.find((c) => c.id === activeClashId);
  const involved = activeClash ? new Set([activeClash.leftModelId, activeClash.rightModelId]) : null;
  const running = discussion.status === 'running';

  const toggleThought = (id: string) => {
    setOpenThoughts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const modelById = (id: string) => participants.find((p) => p.id === id) ?? participants[0]!;
  const gridCols = participants.length === 2
    ? 'lg:grid-cols-2'
    : participants.length === 4
    ? 'lg:grid-cols-2 xl:grid-cols-4'
    : 'lg:grid-cols-3';

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      {/* Phase 1: Parallel sheet */}
      <div className={cn('grid grid-cols-1 divide-y divide-line overflow-hidden rounded-xl border border-line bg-bg lg:divide-x lg:divide-y-0', gridCols)}>
        {participants.map((p) => {
          const entry = prism.explore[p.id];
          const live = liveStreams[`explore-${p.id}`];
          const shownText = entry?.text || live?.text || '';
          const shownThought = entry?.thought || live?.thought;
          const isStreaming = Boolean(running && !entry?.text);
          const isInvolved = involved ? involved.has(p.id) : false;
          const isDim = Boolean(involved && !isInvolved);
          const thoughtOpen = openThoughts.has(p.id);

          return (
            <article
              key={p.id}
              className={cn(
                'flex flex-col gap-2.5 p-4 transition-opacity',
                isDim && 'opacity-35',
                isInvolved && 'bg-subtle/60',
              )}
            >
              <div className="flex items-center gap-2">
                <AgentLogo backend={p.backendId} size={13} style={agentMarkStyle(p.backendId)} />
                <span className="min-w-0 truncate text-sm font-medium text-fg">{p.model}</span>
                {isStreaming && <Spinner className="ml-auto" />}
              </div>
              <div className="border-b border-line pb-2 text-xs text-fg-3">
                {entry?.stance ?? <Trans>正在独立作答…</Trans>}
              </div>
              {shownThought && (
                <>
                  <button
                    type="button"
                    aria-expanded={thoughtOpen}
                    onClick={() => toggleThought(p.id)}
                    className="inline-flex w-fit items-center gap-1 text-xs text-fg-3 hover:text-fg"
                  >
                    <IconChevronRight className={cn('size-3.5 transition-transform', thoughtOpen && 'rotate-90')} />
                    <span><Trans>思考</Trans></span>
                  </button>
                  {thoughtOpen && (
                    <div className="border-l border-line-strong pl-2.5 text-xs leading-relaxed text-fg-3 select-text">
                      {shownThought}
                    </div>
                  )}
                </>
              )}
              {shownText ? (
                <div className="text-sm leading-6 text-fg select-text">
                  {isInvolved ? highlightSnippet(shownText, entry?.quoteSnippet) : <Markdown text={shownText} streaming={isStreaming} />}
                </div>
              ) : isStreaming ? (
                <span className="text-xs text-fg-4"><Trans>正在作答…</Trans></span>
              ) : null}
            </article>
          );
        })}
      </div>

      {/* Phase 2: Contradictions / Clashes */}
      {contradictions.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg"><Trans>分歧焦点</Trans></span>
            <span className="text-xs text-fg-3"><Trans>{prism.observer.model} 整理 · 悬停定位原文</Trans></span>
            <span className="flex-1" />
            {discussion.phaseIndex === 1 && discussion.status === 'paused' && (
              <Button size="sm" variant="primary" onClick={onAdvance}>
                <Trans>开始回应追问</Trans>
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-2.5">
            {contradictions.map((c) => {
              const lm = modelById(c.leftModelId);
              const rm = modelById(c.rightModelId);
              const isLit = activeClashId === c.id;

              return (
                <div
                  key={c.id}
                  onMouseEnter={() => setHoverClashId(c.id)}
                  onMouseLeave={() => setHoverClashId(null)}
                  className={cn(
                    'flex flex-col gap-2.5 rounded-xl border border-line bg-bg p-4 transition-colors',
                    isLit && 'border-line-strong bg-subtle/40',
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <Checkbox
                      checked={c.selected}
                      aria-label={t`保留追问`}
                      onCheckedChange={() => onToggleContradiction(c.id)}
                    />
                    <span className="text-sm font-medium text-fg">{c.title}</span>
                  </div>
                  <div className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-[1fr_24px_1fr]">
                    <div className="flex flex-col gap-1 rounded-lg bg-subtle px-3 py-2 text-xs leading-relaxed text-fg-2 select-text">
                      <div className="flex items-center gap-1.5 text-fg-3">
                        <AgentLogo backend={lm.backendId} size={12} style={agentMarkStyle(lm.backendId)} />
                        <span>{lm.model}</span>
                      </div>
                      <span>“{c.leftQuote}”</span>
                    </div>
                    <div className="hidden place-items-center text-xs text-fg-4 md:grid">vs</div>
                    <div className="flex flex-col gap-1 rounded-lg bg-subtle px-3 py-2 text-xs leading-relaxed text-fg-2 select-text">
                      <div className="flex items-center gap-1.5 text-fg-3">
                        <AgentLogo backend={rm.backendId} size={12} style={agentMarkStyle(rm.backendId)} />
                        <span>{rm.model}</span>
                      </div>
                      <span>“{c.rightQuote}”</span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 border-t border-line pt-2 text-xs leading-relaxed text-fg-2 select-text">
                    <Badge tone="warning"><Trans>追问</Trans></Badge>
                    <span className="min-w-0 flex-1">{c.question}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {gaps.length > 0 && (
            <div className="px-1 text-xs text-fg-3 select-text">
              <Trans>待补充：{gaps.join(' · ')}</Trans>
            </div>
          )}
        </section>
      )}

      {/* Phase 3: Deepen / Position shifts */}
      {Object.keys(prism.deepen ?? {}).length > 0 && (
        <section className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg"><Trans>回应追问</Trans></span>
            <span className="text-xs text-fg-3"><Trans>立场变化</Trans></span>
          </div>
          <div className={cn('grid grid-cols-1 divide-y divide-line overflow-hidden rounded-xl border border-line bg-bg lg:divide-x lg:divide-y-0', gridCols)}>
            {participants.map((p) => {
              const d = prism.deepen[p.id];
              const live = liveStreams[`deepen-${p.id}`];
              const shownText = d?.text || live?.text || '';
              const isStreaming = Boolean(running && !d?.text);
              return (
                <article key={p.id} className="flex flex-col gap-2.5 p-4">
                  <div className="flex items-center gap-2">
                    <AgentLogo backend={p.backendId} size={13} style={agentMarkStyle(p.backendId)} />
                    <span className="min-w-0 truncate text-sm font-medium text-fg">{p.model}</span>
                    {isStreaming && <Spinner className="ml-auto" />}
                  </div>
                  {d && (
                    <>
                      <div className="inline-flex w-fit items-center gap-1.5 rounded-md bg-subtle px-2 py-0.5 text-xs text-fg-3">
                        {d.shifted ? (
                          <>
                            <span className="text-fg-4 line-through">{d.oldStance}</span>
                            <span>→</span>
                            <span className="font-medium text-success">{d.newStance}</span>
                          </>
                        ) : (
                          <span>{d.newStance}</span>
                        )}
                      </div>
                      {shownText && (
                        <div className="text-sm leading-6 text-fg select-text">
                          <Markdown text={shownText} streaming={isStreaming} />
                        </div>
                      )}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* Phase 4: Verdict prose */}
      {prism.verdict && (
        <section className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success"><Trans>一致结论</Trans></Badge>
            <h2 className="text-base font-medium text-fg">{prism.verdict.headline}</h2>
            <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-fg-3">
              <AgentLogo backend={prism.observer.backendId} size={12} style={agentMarkStyle(prism.observer.backendId)} />
              <span>{prism.observer.model}</span>
            </span>
          </div>
          <div className="text-sm leading-6 text-fg select-text">
            <Markdown text={prism.verdict.analysis} />
          </div>
        </section>
      )}
    </div>
  );
}
