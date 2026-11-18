import { Trans, useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion, CouncilModelParticipant } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { Button } from '@/components/ui/button';
import { Badge, Spinner } from '@/components/ui/controls';
import { IconArrowRightLeft, IconCornerDownLeft } from '@/components/icons';
import { agentMarkStyle } from '@/lib/backends';
import { cn } from '@/lib/utils';
import { Markdown } from '../session/Markdown';

function SpeakerBadge({ model }: { model: CouncilModelParticipant }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <AgentLogo backend={model.backendId} size={13} style={agentMarkStyle(model.backendId)} />
      <span className="font-medium text-fg">{model.model}</span>
    </span>
  );
}

export function DebateStage({
  discussion,
  pulseTurnId,
  liveStreams,
  onSwapSides,
  onAdvance,
  onConclude,
  onFocusTurn,
  onExport,
}: {
  discussion: CouncilDiscussion;
  pulseTurnId: string | null;
  liveStreams: Record<string, { text?: string; thought?: string }>;
  onSwapSides: () => void;
  onAdvance: () => void;
  onConclude: () => void;
  onFocusTurn: (turnId: string) => void;
  onExport: (kind: 'task' | 'session') => void;
}) {
  const { t } = useLingui();
  const debate = discussion.debate;
  if (!debate) return null;

  const sides = debate.sides ?? [];
  const rounds = debate.rounds ?? [];
  const hostTurns = debate.hostTurns ?? [];
  const isBilateral = sides.length === 2;
  const rightSideId = isBilateral ? sides[1]?.id : undefined;
  const judge = debate.judgeModel;
  const running = discussion.status === 'running';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      {/* Matchup header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-subtle px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          {sides.map((side, sIdx) => (
            <div key={side.id} className="flex flex-wrap items-center gap-1.5">
              {sIdx > 0 && <span className="mr-1 text-fg-4">vs</span>}
              <span className="rounded-md bg-bg px-1.5 py-0.5 text-2xs font-medium text-fg-2 ring-1 ring-line-strong">{side.label}</span>
              {(side.models ?? []).map((m, i) => (
                <span key={`${m.id}-${i}`} className="inline-flex items-center gap-1.5 rounded-full bg-bg px-2 py-0.5 text-fg ring-1 ring-line">
                  <AgentLogo backend={m.backendId} size={12} style={agentMarkStyle(m.backendId)} />
                  <span>{m.model}</span>
                </span>
              ))}
            </div>
          ))}
        </div>

        {discussion.phaseIndex === 0 && !running && (
          <div className="flex items-center gap-2">
            {isBilateral && (
              <Button size="xs" variant="secondary" onClick={onSwapSides}>
                <IconArrowRightLeft />
                <span><Trans>互换</Trans></span>
              </Button>
            )}
            <Button size="xs" variant="primary" onClick={onAdvance}>
              <Trans>开始辩论</Trans>
            </Button>
          </div>
        )}
      </div>

      {/* Proposition */}
      <div className="px-1 text-sm leading-relaxed text-fg select-text">
        <span className="mr-2 text-xs text-fg-3"><Trans>命题</Trans></span>
        {debate.proposition}
      </div>

      {/* Dialogue stream */}
      <div className="flex flex-col gap-5">
        {rounds.map((r) => (
          <div key={r.num} className="flex flex-col gap-4">
            <div className="flex items-center gap-3 pt-1">
              <div className="h-px flex-1 bg-line" />
              <span className="text-xs font-medium text-fg-3">
                <Trans>第 {r.num} 轮 · {r.stage}</Trans>
              </span>
              <div className="h-px flex-1 bg-line" />
            </div>

            {(r.turns ?? []).map((turn) => {
              const isRight = isBilateral && turn.sideId === rightSideId;
              const isPulsing = pulseTurnId === turn.id;
              const liveText = liveStreams[turn.id]?.text;
              const shownText = turn.text || liveText || '';
              const isStreaming = Boolean(running && !turn.text);

              return (
                <div
                  key={turn.id}
                  id={`council-turn-${turn.id}`}
                  className={cn(
                    'flex max-w-[82%] flex-col gap-2 max-md:max-w-[92%]',
                    isRight ? 'items-end self-end' : 'items-start self-start',
                  )}
                >
                  <div className="flex items-center gap-1.5 px-1 text-xs text-fg-3">
                    {isRight ? (
                      <>
                        {isStreaming && <Spinner />}
                        <span>{turn.sideLabel}</span>
                        <SpeakerBadge model={turn.speaker} />
                      </>
                    ) : (
                      <>
                        <SpeakerBadge model={turn.speaker} />
                        <span>{turn.sideLabel}</span>
                        {isStreaming && <Spinner />}
                      </>
                    )}
                  </div>

                  {/* Main argument bubble */}
                  <div
                    className={cn(
                      'flex w-full flex-col gap-2.5 px-4 py-3 text-sm leading-6 text-fg select-text transition-shadow',
                      isRight ? 'rounded-2xl rounded-tr-xs bg-bubble' : 'rounded-2xl rounded-tl-xs border border-line bg-subtle',
                      isPulsing && 'ring-2 ring-accent',
                    )}
                  >
                    {turn.replyTo && (
                      <button
                        type="button"
                        onClick={() => onFocusTurn(turn.replyTo!.turnId)}
                        className="flex flex-col gap-1 rounded-lg bg-fg/[0.045] px-3 py-2 text-left text-xs leading-relaxed text-fg-2 transition-colors hover:bg-fg/[0.08]"
                      >
                        <div className="flex items-center gap-1.5 text-2xs text-fg-3">
                          <IconCornerDownLeft className="size-3 shrink-0" />
                          <span>{turn.replyTo.label}</span>
                          <Badge tone={turn.replyTo.status === 'direct' ? 'success' : turn.replyTo.status === 'dodged' ? 'danger' : 'neutral'}>
                            {turn.replyTo.status === 'direct' ? t`已正面回应` : turn.replyTo.status === 'dodged' ? t`未正面回应` : t`部分回应`}
                          </Badge>
                        </div>
                        <span>{turn.replyTo.quote}</span>
                      </button>
                    )}

                    {shownText ? (
                      <Markdown text={shownText} streaming={isStreaming} />
                    ) : isStreaming ? (
                      <span className="inline-flex items-center gap-2 text-xs text-fg-3">
                        <Spinner />
                        <span><Trans>正在整理发言…</Trans></span>
                      </span>
                    ) : (
                      <span className="text-xs text-fg-4"><Trans>未完成</Trans></span>
                    )}
                  </div>

                  {/* Cross-exam question as its own separate message */}
                  {turn.question && (
                    <div
                      className={cn(
                        'flex max-w-full flex-col gap-1 px-3.5 py-2.5 text-xs leading-relaxed text-fg-2 select-text',
                        isRight ? 'rounded-2xl rounded-tr-xs bg-bubble/70' : 'rounded-2xl rounded-tl-xs border border-line bg-bg',
                      )}
                    >
                      <div className="flex items-center gap-1.5 text-2xs font-medium text-fg-3">
                        <span>
                          {turn.question.targetLabel
                            ? <Trans>追问 {turn.question.targetLabel}</Trans>
                            : <Trans>追问</Trans>}
                        </span>
                        {turn.question.status === 'direct' && <Badge tone="success"><Trans>已回应</Trans></Badge>}
                      </div>
                      <span className="text-sm leading-6 text-fg">{turn.question.text}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {/* Host interjections */}
        {hostTurns.map((ht) => (
          <div key={ht.id} className="flex flex-col gap-4">
            <div className="self-center rounded-full border border-line-strong bg-bg px-4 py-1.5 text-xs text-fg-2 select-text">
              <Trans>主持人追问：{ht.prompt}</Trans>
            </div>
            {(ht.replies ?? []).map((reply, i) => {
              const isRight = isBilateral && reply.sideId === rightSideId;
              return (
                <div
                  key={`host-r-${i}`}
                  className={cn(
                    'flex max-w-[82%] flex-col gap-1.5 max-md:max-w-[92%]',
                    isRight ? 'items-end self-end' : 'items-start self-start',
                  )}
                >
                  <div className="flex items-center gap-1.5 px-1 text-xs text-fg-3">
                    {isRight ? (
                      <>
                        <span><Trans>{reply.sideLabel}补充</Trans></span>
                        <SpeakerBadge model={reply.speaker} />
                      </>
                    ) : (
                      <>
                        <SpeakerBadge model={reply.speaker} />
                        <span><Trans>{reply.sideLabel}补充</Trans></span>
                      </>
                    )}
                  </div>
                  <div
                    className={cn(
                      'px-4 py-3 text-sm leading-6 text-fg select-text',
                      isRight ? 'rounded-2xl rounded-tr-xs bg-bubble' : 'rounded-2xl rounded-tl-xs border border-line bg-subtle',
                    )}
                  >
                    <Markdown text={reply.text} />
                  </div>
                </div>
              );
            })}
          </div>
        ))}

        {!running && rounds.length > 0 && !debate.verdict && (
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <Button size="sm" variant="secondary" onClick={onAdvance}>
              <Trans>继续下一轮</Trans>
            </Button>
            <Button size="sm" variant="primary" onClick={onConclude}>
              <Trans>总结结论</Trans>
            </Button>
          </div>
        )}
      </div>

      {/* Verdict */}
      {debate.verdict && (
        <section className="flex flex-col gap-3 rounded-xl border border-line-strong bg-bg p-5">
          <div className="flex flex-wrap items-center gap-2">
            {judge && (
              <>
                <AgentLogo backend={judge.backendId} size={14} style={agentMarkStyle(judge.backendId)} />
                <span className="text-sm font-medium text-fg">{judge.model}</span>
              </>
            )}
            <Badge tone="warning">{debate.verdict.winner}</Badge>
          </div>
          <div className="text-sm leading-relaxed text-fg select-text">
            <Markdown text={debate.verdict.takeaway} />
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button size="sm" variant="secondary" disabled={running} onClick={onAdvance}>
              <Trans>继续交锋</Trans>
            </Button>
            <span className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => onExport('session')}><Trans>带入会话</Trans></Button>
            <Button size="sm" variant="primary" onClick={() => onExport('task')}><Trans>转为任务</Trans></Button>
          </div>
        </section>
      )}
    </div>
  );
}
