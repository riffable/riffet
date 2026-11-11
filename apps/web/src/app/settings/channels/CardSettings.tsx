import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ChannelAccountInfo, ChannelCardOptions } from '@contracts';
import { Button } from '@/components/ui/button';
import { IconArrowLeft, IconChevronDown, IconLoaderCircle, IconWrench } from '@/components/icons';
import { Segmented, Switch } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { SettingsGroup, SettingsRow } from '../SettingsLayout';
import { botName } from './shared';

const ALL_ON: ChannelCardOptions = { header: true, process: true, stopButton: true, footer: { model: true, changes: true, context: true, elapsed: true } };
const cardOf = (account: ChannelAccountInfo): ChannelCardOptions => ({ ...ALL_ON, ...account.card, footer: { ...ALL_ON.footer, ...account.card?.footer } });

/** One bot's reply card: a live preview of what the platform shows, and what goes on it. */
export function CardSettings({ account, busy, run, onBack }: {
  account: ChannelAccountInfo;
  busy: boolean;
  run: (action: () => Promise<unknown>, fallback: string) => Promise<void>;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const [card, setCard] = useState(() => cardOf(account));
  const [phase, setPhase] = useState<'running' | 'done'>('running');
  useEffect(() => setCard(cardOf(account)), [account]);

  const save = (patch: NonNullable<Parameters<typeof api.updateChannelAccount>[1]['card']>) => {
    const previous = card;
    setCard({ ...card, ...patch, footer: { ...card.footer, ...patch.footer } });
    return run(async () => {
      try { await api.updateChannelAccount(account.id, { card: patch }); }
      catch (reason) { setCard(previous); throw reason; }
    }, t`无法保存`);
  };
  const top = (key: 'header' | 'process' | 'stopButton', label: string, description?: string) => <SettingsRow title={label} description={description}>
    <Switch aria-label={label} checked={card[key]} disabled={busy} onCheckedChange={(value) => void save({ [key]: value })} />
  </SettingsRow>;
  const foot = (key: keyof ChannelCardOptions['footer'], label: string) => <SettingsRow title={label}>
    <Switch aria-label={label} checked={card.footer[key]} disabled={busy} onCheckedChange={(value) => void save({ footer: { [key]: value } })} />
  </SettingsRow>;

  const left = card.footer.model;
  const right = card.footer.changes || card.footer.context || card.footer.elapsed;
  const rightParts = [
    card.footer.changes && <span key="c"><span className="text-[#2ea121]">+12</span> <span className="text-[#f54a45]">−3</span></span>,
    card.footer.context && <span key="x"><Trans>上下文</Trans> 42%</span>,
    card.footer.elapsed && <span key="e">17s</span>,
  ].filter(Boolean);

  return <div className="flex flex-col gap-6">
    <Button size="sm" variant="quiet" className="-ml-2 self-start" onClick={onBack}><IconArrowLeft />{botName(account)}</Button>

    <div className="flex flex-col items-start gap-3">
      <Segmented ariaLabel={t`卡片`} value={phase} onChange={setPhase} options={[{ value: 'running', label: t`回复中` }, { value: 'done', label: t`已完成` }]} />
      <div className="flex w-full flex-col gap-3 rounded-xl bg-muted p-4 max-md:p-3">
        {card.process && <div className="flex flex-col gap-1 rounded-lg bg-white px-3 py-2 text-[#1f2329]">
          {phase === 'running'
            ? <span className="inline-flex items-center gap-1.5 text-sm"><IconLoaderCircle className="size-3.5 animate-spin text-[#646a73]" /><Trans>思考中</Trans></span>
            : <span className="inline-flex items-center gap-1 text-sm"><Trans>定位重定向问题</Trans><IconChevronDown className="size-3.5 text-[#646a73]" /></span>}
          <span className="inline-flex items-center gap-1.5 text-xs text-[#646a73]"><IconWrench className="size-3.5" /><Trans>已调用 2 次工具</Trans></span>
        </div>}
        <div className="flex flex-col overflow-hidden rounded-lg border border-[#dee0e3] bg-white text-[#1f2329]">
          {card.header && <div className="border-b border-[#dee0e3] px-3 py-2 text-sm font-semibold"><Trans>示例会话</Trans></div>}
          <p className="px-3 py-3 text-sm leading-relaxed">
            <Trans>已修复登录页的重定向问题，并补充了对应的回归用例。</Trans>
          </p>
          {phase === 'running'
            ? <div className="flex items-center justify-between gap-3 border-t border-[#dee0e3] px-3 py-2 text-xs text-[#646a73]">
              <span className="inline-flex items-center gap-1.5"><IconLoaderCircle className="size-3.5 animate-spin" /><Trans>处理中</Trans></span>
              {card.stopButton && <span className="text-[#1f2329]"><Trans>中断</Trans></span>}
            </div>
            : (left || right) && <div className={cn('flex items-center justify-between gap-3 border-t border-[#dee0e3] px-3 py-2 text-xs text-[#646a73]', !left && 'justify-end')}>
              {left && <span className="min-w-0 truncate">Opus 5.5 · fast · high</span>}
              {right && <span className="ml-auto flex shrink-0 gap-1 text-right">{rightParts.map((part, index) => <span key={index} className="flex gap-1">{index > 0 && '·'}{part}</span>)}</span>}
            </div>}
        </div>
      </div>
    </div>

    <SettingsGroup>
      {top('process', t`思考过程`, t`单独一条消息，展示思考与工具调用`)}
    </SettingsGroup>
    <SettingsGroup title={t`卡片`}>
      {top('header', t`标题栏`)}
      {top('stopButton', t`中断按钮`)}
    </SettingsGroup>
    <SettingsGroup title={t`页脚`} note={<Trans>新设置从下一条回复开始生效</Trans>}>
      {foot('model', t`模型`)}
      {foot('changes', t`改动行数`)}
      {foot('context', t`上下文占用`)}
      {foot('elapsed', t`用时`)}
    </SettingsGroup>
  </div>;
}
