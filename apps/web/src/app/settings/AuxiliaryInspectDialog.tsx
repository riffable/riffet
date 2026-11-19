import { useCallback, useEffect, useState } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AuxiliaryCallLogEntry, AuxiliaryInspectResponse, AuxiliaryJobKind } from '@contracts';
import { IconChevronDown, IconCircleAlert, IconInfoOutline, IconRefreshCw, IconTriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Badge, EmptyState, Spinner, UnderlineTabs } from '@/components/ui/controls';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { formatDuration, formatTimestamp } from '@/lib/stats-format';
import { cn, errorMessage } from '@/lib/utils';

type InspectTab = 'rules' | 'logs';

const KIND_LABELS: Record<AuxiliaryJobKind, MessageDescriptor> = {
  title: msg`会话标题`,
  summary: msg`画布摘要`,
  handoff: msg`交接摘要`,
  plugin: msg`翻译/插件`,
  chat: msg`快速对话`,
  probe: msg`接口测速`,
};

function logStatusBadge(item: AuxiliaryCallLogEntry): { tone: 'success' | 'warning' | 'neutral' | 'danger'; label: string } {
  if (item.ok) return { tone: 'success', label: i18n._(msg`成功`) };
  if (item.errorCode === 'SKIPPED_RULE') return { tone: 'warning', label: i18n._(msg`规则拦截`) };
  if (item.errorCode === 'SKIPPED_RENAMED') return { tone: 'neutral', label: i18n._(msg`已跳过`) };
  return { tone: 'danger', label: i18n._(msg`失败`) };
}

export function AuxiliaryInspectDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const [tab, setTab] = useState<InspectTab>('rules');
  const [data, setData] = useState<AuxiliaryInspectResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    void api.inspectAuxiliaryModels(signal)
      .then((res) => { if (!signal?.aborted) { setData(res); setLoading(false); } })
      .catch((cause) => { if (!signal?.aborted) { setError(errorMessage(cause, t`无法读取辅助模型详情`)); setLoading(false); } });
  }, [t]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, open]);

  const togglePrompt = (id: string) => {
    setExpandedPrompts((current) => ({ ...current, [id]: !current[id] }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="content" mobileFullscreen>
        <DialogHeader>
          <DialogTitle><Trans>辅助模型规则与调用</Trans></DialogTitle>
          <DialogDescription><Trans>查看各辅助用途的触发时机、系统 Prompt 与最近实际调用结果。</Trans></DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 overflow-hidden">
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 edge-b">
            <UnderlineTabs
              ariaLabel={t`详情视图`}
              value={tab}
              onChange={setTab}
              options={[
                { value: 'rules', label: t`触发时机与 Prompt` },
                { value: 'logs', label: t`最近调用 (${data?.recent.length ?? 0})` },
              ]}
            />
            <Button size="xs" variant="ghost" busy={loading} onClick={() => load()}>
              <IconRefreshCw />
              <Trans>刷新</Trans>
            </Button>
          </div>

          <div className="h-[min(480px,56dvh)] min-h-0 overflow-y-auto pr-1">
            {error ? (
              <div className="flex h-full items-center justify-center px-4">
                <p role="alert" className="flex items-center gap-2 text-sm text-danger">
                  <IconCircleAlert className="size-4 shrink-0" />
                  {error}
                </p>
              </div>
            ) : loading && !data ? (
              <div className="flex h-full items-center justify-center">
                <Spinner className="size-5" />
              </div>
            ) : data && tab === 'rules' ? (
              <div className="divide-y divide-line rounded-xl border border-line bg-bg">
                {data.jobs.map((job) => {
                  const expanded = Boolean(expandedPrompts[job.id]);
                  const promptId = `aux-prompt-${job.id}`;
                  return (
                    <section key={job.id} className="flex flex-col gap-2.5 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <h3 className="text-sm font-medium text-fg">{job.title}</h3>
                          {job.effectiveModel ? (
                            <Badge tone={job.fallbackFrom === 'default' ? 'accent' : 'neutral'}>
                              {job.fallbackFrom === 'default' ? t`跟随默认 · ${job.effectiveModel}` : job.effectiveModel}
                            </Badge>
                          ) : (
                            <Badge tone="neutral">{t`未配置`}</Badge>
                          )}
                        </div>
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-expanded={expanded}
                          aria-controls={promptId}
                          onClick={() => togglePrompt(job.id)}
                        >
                          <Trans>Prompt</Trans>
                          <IconChevronDown className={cn('transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)]', expanded && 'rotate-180')} />
                        </Button>
                      </div>
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                        <dt className="whitespace-nowrap text-fg-3"><Trans>触发时机</Trans></dt>
                        <dd className="leading-relaxed text-fg-2">{job.trigger}</dd>
                        <dt className="whitespace-nowrap text-fg-3"><Trans>约束规则</Trans></dt>
                        <dd className="leading-relaxed text-fg-2">{job.rules}</dd>
                      </dl>
                      <Collapse open={expanded} id={promptId}>
                        <div className="mt-1 overflow-hidden rounded-lg border border-line bg-subtle">
                          <div className="flex h-8 items-center justify-between border-b border-line bg-muted/60 px-3">
                            <span className="font-mono text-2xs font-medium text-fg-3">System Prompt</span>
                            <CopyButton size="xs" text={job.prompt} />
                          </div>
                          <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-fg-2">
                            {job.prompt}
                          </pre>
                        </div>
                      </Collapse>
                    </section>
                  );
                })}
              </div>
            ) : data && tab === 'logs' ? (
              data.recent.length === 0 ? (
                <EmptyState className="h-full" icon={<IconInfoOutline />} title={t`还没有辅助模型调用记录`} />
              ) : (
                <div className="divide-y divide-line rounded-xl border border-line bg-bg">
                  {data.recent.map((item: AuxiliaryCallLogEntry) => {
                    const status = logStatusBadge(item);
                    return (
                      <div key={item.id} className="flex flex-col gap-1.5 px-4 py-3 text-xs">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <Badge tone={status.tone} title={item.errorCode ?? undefined}>{status.label}</Badge>
                            <span className="font-medium text-fg">{i18n._(KIND_LABELS[item.kind])}</span>
                            <span className="truncate text-fg-2">{item.profileName} · {item.model}</span>
                            {item.transport === 'cli-process' && <Badge tone="neutral">CLI</Badge>}
                            {item.thinkingDetected && item.kind !== 'chat' && (
                              <span className="inline-flex items-center gap-1 text-warning">
                                <IconTriangleAlert className="size-3" />
                                <Trans>未关思考</Trans>
                              </span>
                            )}
                          </div>
                          <span className="shrink-0 tabular-nums text-fg-4">{formatTimestamp(item.at)}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums text-fg-3">
                          <span><Trans>鉴权 {formatDuration(item.authMs)}</Trans></span>
                          {item.ttftMs !== null && <span>TTFT {formatDuration(item.ttftMs)}</span>}
                          <span><Trans>总耗时 {formatDuration(item.durationMs)}</Trans></span>
                        </div>
                        {item.detail && <p className="break-words text-fg-2">{item.detail}</p>}
                      </div>
                    );
                  })}
                </div>
              )
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t`关闭`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
