import { memo, useState, type ReactNode } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconCompress } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { modeIconOf } from './ApprovalPicker';
import type { Choice, ContextUsage } from './model';

/** For a backend that names a mode without describing it. */
const modeDescriptions: Record<string, MessageDescriptor> = {
  agent: msg`自主读写文件、执行命令`,
  plan: msg`先出方案，确认后再动手`,
  ask: msg`只读问答，不修改文件`,
};

export const compactTokens = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(Math.round(value));

/**
 * Context-window gauge. Renders only what the agent actually reported; when nothing has
 * been reported yet there is no meter at all, which is why it is safe to show nothing
 * rather than an invented number.
 */
const contextLabels: Record<string, MessageDescriptor> = {
  system_prompt: msg`系统提示词`, tools: msg`工具定义`, rules: msg`规则`, skills: msg`Skills`, mcp: msg`MCP 与动态工具`,
  subagents: msg`子 Agent 定义`, summarized_conversation: msg`已压缩的对话`, conversation: msg`对话`,
  cached_input: msg`缓存输入`, cacheRead: msg`缓存读取`, cache_write: msg`缓存写入`, cacheWrite: msg`缓存写入`, reasoning_output: msg`思考输出`,
  systemPrompt: msg`系统提示词`, toolDefinitions: msg`工具定义`, developerMessages: msg`指令`, userMessages: msg`你的消息`,
  assistantMessages: msg`回复`, toolResponses: msg`工具结果`, otherMessages: msg`其他`,
};

function contextPartLabel(id: string, parts: readonly { id: string }[]): string | undefined {
  if (id === 'input') {
    const splitFromCache = parts.some((item) => ['cached_input', 'cacheRead', 'cacheWrite'].includes(item.id));
    return i18n._(splitFromCache ? msg`未缓存输入` : msg`输入`);
  }
  if (id === 'output') return i18n._(parts.some((item) => item.id === 'reasoning_output') ? msg`回复输出` : msg`输出`);
  return contextLabels[id] ? i18n._(contextLabels[id]!) : undefined;
}

function formatContextShare(tokens: number, base: number): string {
  const pct = (tokens / Math.max(1, base)) * 100;
  return tokens > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

export const ContextMeter = memo(function ContextMeter({ usage, onCompact, compacting = false, compactDisabled = false }: {
  usage: ContextUsage;
  onCompact?: () => Promise<boolean> | boolean;
  compacting?: boolean;
  compactDisabled?: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const ratio = Math.min(1, Math.max(0, usage.used / usage.size));
  const percent = Math.round(usage.used / usage.size * 100);
  const title = t`上下文用量`;
  // The ring alone, in the toolbar's own ink until the window runs short; the figures live in the
  // tooltip and the popover, so the row never carries a number that changes every turn.
  const color = ratio >= 0.9 ? 'var(--danger)' : ratio >= 0.75 ? 'var(--warning)' : 'currentColor';
  const cost = usage.cost ? ` · ${usage.cost.currency} ${usage.cost.amount.toFixed(2)}` : '';
  const limitLabel = usage.limitKind === 'compaction' ? t`自动压缩阈值` : t`上下文长度`;
  const label = `${title} ${percent}% · ${compactTokens(usage.used)} / ${limitLabel} ${compactTokens(usage.size)} tokens${cost}`;
  // 2πr for r = 6, so the dash length maps directly onto the ratio.
  const circumference = 2 * Math.PI * 6;
  const parts = usage.breakdown?.filter((item) => item.tokens > 0) ?? [];
  const breakdownTotal = parts.reduce((total, item) => total + item.tokens, 0);
  const breakdownBase = usage.breakdownEstimated
    ? Math.max(1, breakdownTotal)
    : Math.max(1, usage.size, usage.used, breakdownTotal);
  const compactBusy = compacting || submitting;
  const compactBlocked = compactDisabled || usage.used <= 0;
  const handleCompact = async () => {
    if (!onCompact || compactBusy || compactBlocked) return;
    setSubmitting(true);
    try {
      const ok = await onCompact();
      if (ok) setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label={`${title} ${percent}%`} side="top">
        <PopoverTrigger
          aria-label={label}
          // The same square as the toolbar's other glyph buttons, so the meter sits one footer gap
          // from the model name exactly as the attach and approval buttons sit from each other.
          className="grid size-11 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus aria-expanded:bg-hover aria-expanded:text-fg md:size-7"
        >
          <svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="var(--line-strong)" strokeWidth="2" />
            <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={`${ratio * circumference} ${circumference}`} />
          </svg>
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        side="top"
        align="start"
        className="w-72 p-3"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
      >
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium text-fg">{title} <span className="tabular-nums text-fg-3">{percent}%</span></span>
          <span className="tabular-nums text-fg-3">{compactTokens(usage.used)} / {compactTokens(usage.size)}</span>
        </div>
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-line">
          {parts.length && !usage.breakdownEstimated
            ? parts.map((item, index) => <span key={item.id} className="h-full shrink-0" style={{ width: `${ratio * item.tokens / Math.max(1, usage.used, breakdownTotal) * 100}%`, background: color, opacity: 1 - index * (0.7 / parts.length) }} />)
            : <span className="h-full" style={{ width: `${ratio * 100}%`, background: color }} />}
        </div>
        {usage.limitKind === 'compaction' && <div className="mt-2 text-xs text-fg-3"><Trans>自动压缩阈值：{compactTokens(usage.size)} tokens；按最近一次模型响应计量</Trans></div>}
        {parts.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5 text-xs">
            {usage.breakdownEstimated && <li className="text-fg-3"><Trans>内容估算 · ~{compactTokens(breakdownTotal)}</Trans></li>}
            {parts.map((item) => (
              <li key={item.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-fg-2">{contextPartLabel(item.id, parts) ?? item.label}</span>
                <span className="tabular-nums text-fg-3">{usage.breakdownEstimated ? '~' : ''}{compactTokens(item.tokens)}</span>
                <span className="w-10 text-right tabular-nums text-fg-3">{formatContextShare(item.tokens, breakdownBase)}</span>
              </li>
            ))}
          </ul>
        )}
        {usage.cost && <div className="mt-2 text-xs text-fg-3"><Trans>费用 {usage.cost.currency} {usage.cost.amount.toFixed(2)}</Trans></div>}
        {onCompact && (
          <div className="mt-2.5 border-t border-line pt-1.5">
            <div className="-mx-1.5 -mb-1 flex">
              <Button
                size="xs"
                variant="ghost"
                className="h-7 flex-1 justify-start px-1.5 font-normal text-fg-2 hover:text-fg no-hover:min-h-11"
                busy={compactBusy}
                disabled={!compactBusy && compactBlocked}
                onClick={() => void handleCompact()}
              >
                <IconCompress className="size-3.5 text-fg-3" />
                <Trans>压缩上下文</Trans>
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});

const fallbackModes: Choice[] = [
  { id: 'agent', label: 'Agent' },
  { id: 'plan', label: 'Plan' },
  { id: 'ask', label: 'Ask' },
];

export function ModePicker({ modes, value, onChange, disabled, className }: { modes: Choice[]; value?: string; onChange: (id: string) => void; disabled?: boolean; className?: string }) {
  const { t } = useLingui();
  const list = modes.length ? modes : fallbackModes;
  const current = list.find((mode) => mode.id === value) ?? list[0];
  const Icon = modeIconOf(current?.id ?? '');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={disabled} className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-sm font-medium text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 data-[state=open]:bg-hover data-[state=open]:text-fg", className)}>
        <Icon className="size-3.5" />
        <span>{current?.label ?? t`模式`}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="w-64">
        <DropdownMenuLabel>{t`模式`}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current?.id} onValueChange={onChange}>
          {list.map((mode) => {
            const fallback = modeDescriptions[mode.id];
            const ItemIcon = modeIconOf(mode.id);
            return (
              <DropdownMenuRadioItem key={mode.id} value={mode.id} className="h-auto items-start py-2">
                <ItemIcon className="mt-0.5" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">{mode.label}</span>
                  <span className="text-xs text-fg-3">{mode.description ?? (fallback ? i18n._(fallback) : mode.id)}</span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ComposerMobileSettings({
  open,
  onOpenChange,
  isMobile,
  compact,
  holdInFooter,
  toggleEntrance,
  disabled,
  pickersDisabled,
  pickersBlockedReason,
  modelsIssue,
  modelsLoading,
  settingsSummary,
  mobileSettingsPrefix,
  usage,
  onCompact,
  compacting,
  compactDisabled,
  toolbar,
  toolsPicker,
  startPickers,
  hasModelPicker,
  renderModelPicker,
  endPickers,
  hasMobileSettings,
  modelLeadsRow,
  fullscreenToggle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isMobile: boolean;
  compact: boolean;
  holdInFooter: boolean;
  toggleEntrance?: string;
  disabled?: boolean;
  pickersDisabled?: boolean;
  pickersBlockedReason?: string;
  modelsIssue: string;
  modelsLoading?: boolean;
  settingsSummary: string;
  mobileSettingsPrefix?: ReactNode;
  usage?: ContextUsage;
  onCompact?: () => Promise<boolean> | boolean;
  compacting?: boolean;
  compactDisabled?: boolean;
  toolbar?: ReactNode;
  toolsPicker?: ReactNode;
  startPickers?: ReactNode;
  hasModelPicker: boolean;
  renderModelPicker: () => ReactNode;
  endPickers?: ReactNode;
  hasMobileSettings: boolean;
  modelLeadsRow: boolean;
  fullscreenToggle: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Shrinkable, or a backend that names a permission in a whole sentence pushes the
          model and send controls off the row instead of truncating itself. */}
      <div className="hidden min-w-0 items-center gap-1 md:flex">
        {!isMobile && toolbar}
        {/* Fixed icons first, then the model; a control that comes and goes (fullscreen) waits by send. */}
        {modelLeadsRow && hasModelPicker && <span className="inline-flex min-w-0">{renderModelPicker()}</span>}
        {!modelLeadsRow && fullscreenToggle}
      </div>
      {hasMobileSettings && <>
        {isMobile && usage && !compact && !holdInFooter && <ContextMeter usage={usage} onCompact={onCompact} compacting={compacting} compactDisabled={compactDisabled} />}
        <DialogTrigger asChild>
          <button type="button" aria-label={t`发送设置`} aria-description={modelsIssue || undefined} aria-busy={modelsLoading || undefined} title={modelsIssue || undefined} disabled={disabled} className={cn('inline-flex h-11 min-w-0 max-w-none flex-1 items-center gap-1 rounded-full px-2 text-sm font-medium text-fg-2 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:hidden md:flex-initial', modelsIssue && 'text-danger', compact || holdInFooter ? 'hidden' : toggleEntrance)}>
            {mobileSettingsPrefix}
            <span className="min-w-0 truncate">{settingsSummary}</span>
            {modelsIssue && <StatusDot tone="warning" />}
            {modelsLoading && <Spinner className="size-3 shrink-0 text-fg-4" />}
          </button>
        </DialogTrigger>
        <DialogContent mobileSheet aria-describedby={undefined} className="max-h-[min(78dvh,560px)] w-full max-w-none rounded-b-none rounded-t-2xl p-0 md:hidden">
          <DialogHeader className="shrink-0 px-4 pb-3 pt-4 pr-14">
            <DialogTitle className="text-base"><Trans>发送设置</Trans></DialogTitle>
          </DialogHeader>
          {pickersDisabled && pickersBlockedReason && (
            <p className="shrink-0 px-4 pb-3 -mt-1 text-xs text-warning">{pickersBlockedReason}</p>
          )}
          <div className="min-h-0 overflow-y-auto px-4 pb-6">
            {isMobile && toolbar && <section className="flex flex-col gap-2 edge-t py-3">
              <h4 className="text-xs font-medium text-fg-3"><Trans>权限</Trans></h4>
              <div className="[&>button]:!h-11 [&>button]:!w-full [&>button]:!justify-between [&>button]:!rounded-xl [&>button]:!border [&>button]:!border-line-strong [&>button]:!px-3 [&>button]:!text-base">{toolbar}</div>
            </section>}
            {isMobile && toolsPicker && <section className="flex flex-col gap-2 edge-t py-3">
              <h4 className="text-xs font-medium text-fg-3"><Trans>技能与工具</Trans></h4>
              <div className="[&>button]:!h-11 [&>button]:!w-full [&>button]:!justify-between [&>button]:!rounded-xl [&>button]:!border [&>button]:!border-line-strong [&>button]:!px-3 [&>button]:!text-base">{toolsPicker}</div>
            </section>}
            {isMobile && startPickers && <section className="flex flex-col gap-2 edge-t py-3">
              <h4 className="text-xs font-medium text-fg-3">Agent</h4>
              <div className="min-w-0">{startPickers}</div>
            </section>}
            {isMobile && hasModelPicker && <section className="flex flex-col gap-2 edge-t py-3">
              <h4 className="text-xs font-medium text-fg-3"><Trans>模型与参数</Trans></h4>
              {renderModelPicker()}
            </section>}
            {isMobile && endPickers && <section className="flex flex-col gap-2 edge-t py-3">
              <h4 className="text-xs font-medium text-fg-3"><Trans>模型与参数</Trans></h4>
              <div className="min-w-0">{endPickers}</div>
            </section>}
          </div>
        </DialogContent>
      </>}
    </Dialog>
  );
}
