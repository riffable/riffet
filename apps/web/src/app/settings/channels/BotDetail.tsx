import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ChannelAccountInfo, ChannelChat, ChannelHealth, ChannelsState } from '@contracts';
import { Button } from '@/components/ui/button';
import { IconArrowLeft, IconCopy, IconEllipsis, IconExternalLink, IconKey, IconMessagesSquare, IconRefreshCw, IconRotateCcw, IconTrash2, IconUser } from '@/components/icons';
import { Select, Switch } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { copyWithToast } from '@/lib/files';
import { formatDate } from '@/lib/i18n/format';
import { useLists } from '../../state/stores';
import { SettingsGroup, SettingsLinkRow, SettingsRow } from '../SettingsLayout';
import type { AddBotMode } from './AddBotDialog';
import { BindCodeView, BotAvatar, botName, CheckItem, useChannelHealth } from './shared';

const external = (href: string | undefined) => href ? { href, target: '_blank', rel: 'noreferrer' } : undefined;

/** One bot: what is left to set up, who may use it, and the chats it serves. */
export function BotDetail({ account, state, busy, run, onBack, onOpenCard, onDialog }: {
  account: ChannelAccountInfo;
  state: ChannelsState;
  busy: boolean;
  run: (action: () => Promise<unknown>, fallback: string) => Promise<void>;
  onBack: () => void;
  onOpenCard: () => void;
  onDialog: (mode: AddBotMode) => void;
}) {
  const { t } = useLingui();
  const projects = useLists((current) => current.projects);
  const { health, loading, refresh } = useChannelHealth(account);
  const [bindOpen, setBindOpen] = useState(false);
  const identities = state.identities.filter((item) => item.account === account.id);
  const chats = state.chats.filter((item) => item.account === account.id);
  const open = external(account.links.open);
  const consoleLink = external(account.links.console);

  const remove = async () => {
    if (await confirmDialog({ title: t`删除 ${botName(account)}？`, description: t`飞书里的应用不会被删除`, confirmLabel: t`删除`, destructive: true })) {
      await run(async () => { await api.deleteChannelAccount(account.id); onBack(); }, t`无法删除`);
    }
  };
  const unbind = async (id: string, name: string) => {
    if (await confirmDialog({ title: t`解绑 ${name}？`, confirmLabel: t`解绑`, destructive: true })) await run(() => api.deleteChannelIdentity(id), t`无法解绑`);
  };
  const removeChat = async (chat: ChannelChat) => {
    const name = chat.name || chat.chatId;
    if (await confirmDialog({ title: t`移除 ${name}？`, description: t`这个聊天里的会话绑定一并忘记`, confirmLabel: t`移除`, destructive: true })) await run(() => api.deleteChannelChat(chat.key), t`无法移除聊天`);
  };

  return <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-3">
      <Button size="sm" variant="quiet" className="-ml-2 self-start" onClick={onBack}><IconArrowLeft /><Trans>机器人</Trans></Button>
      <div className="flex items-center gap-3 max-md:flex-wrap">
        <BotAvatar account={account} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-semibold text-fg" title={botName(account)}>{botName(account)}</span>
          <span className="flex items-center gap-1 text-xs text-fg-3">
            <span className="select-text truncate font-mono">{account.appId}</span>
            <Button size="icon-xs" variant="quiet" aria-label={t`复制 App ID`} onClick={() => void copyWithToast(account.appId)}><IconCopy /></Button>
            <span>· {account.domain === 'lark' ? 'Lark' : t`飞书`}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {open && <Button asChild variant="secondary"><a {...open}><Trans>在飞书中打开</Trans><IconExternalLink /></a></Button>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon" variant="quiet" aria-label={t`更多`} disabled={busy}><IconEllipsis /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {state.providers.some((provider) => provider.id === account.kind && provider.register) && <DropdownMenuItem onSelect={() => onDialog({ kind: 'reauthorize', account })}><IconRotateCcw /><Trans>重新扫码授权</Trans></DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => onDialog({ kind: 'replace', account })}><IconKey /><Trans>更换凭据</Trans></DropdownMenuItem>
              {consoleLink && <DropdownMenuItem asChild><a {...consoleLink}><IconExternalLink /><Trans>打开开发者后台</Trans></a></DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="danger" onSelect={() => void remove()}><IconTrash2 /><Trans>删除</Trans></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>

    {health && <Checklist account={account} health={health} loading={loading} onRefresh={() => void refresh()} />}

    <SettingsGroup>
      <SettingsRow title={t`启用`}>
        <Switch aria-label={t`启用`} checked={account.enabled} disabled={busy} onCheckedChange={(enabled) => void run(() => api.updateChannelAccount(account.id, { enabled }), t`无法保存`)} />
      </SettingsRow>
      <SettingsLinkRow title={t`卡片`} onClick={onOpenCard} />
    </SettingsGroup>

    <SettingsGroup title={t`可以使用的人`} action={<Button size="xs" variant="ghost" disabled={busy} onClick={() => setBindOpen(true)}><Trans>添加</Trans></Button>}>
      {identities.length === 0 && <div className="py-3.5 text-sm text-fg-3"><Trans>还没有人</Trans></div>}
      {identities.map((identity) => {
        const name = identity.name || identity.userId;
        return <div key={identity.id} className="flex items-center gap-3 py-3.5 max-md:py-3">
          <IconUser className="size-4 shrink-0 text-fg-3" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-fg" title={name}>{name}</span>
            <span className="text-xs text-fg-3">{formatDate(identity.boundAt, { year: 'numeric', month: 'numeric', day: 'numeric' })}</span>
          </div>
          <Button size="sm" variant="danger-ghost" className="max-md:min-h-11" disabled={busy} onClick={() => void unbind(identity.id, name)}><Trans>解绑</Trans></Button>
        </div>;
      })}
    </SettingsGroup>

    {chats.length > 0 && <SettingsGroup title={t`聊天`}>
      {chats.map((chat) => {
        const Icon = chat.chatType === 'group' ? IconMessagesSquare : IconUser;
        const name = chat.name || chat.chatId;
        return <div key={chat.key} className="flex items-center gap-3 py-3 max-md:flex-wrap">
          <Icon className="size-4 shrink-0 text-fg-3" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg max-md:basis-2/3" title={name}>{name}</span>
          <div className="flex items-center gap-3 max-md:w-full">
            {chat.chatType === 'group' && <label className="flex items-center gap-2 text-xs text-fg-3">
              <Trans>整群一个会话</Trans>
              <Switch aria-label={t`整群一个会话`} checked={chat.flat} disabled={busy} onCheckedChange={(flat) => void run(() => api.updateChannelChat(chat.key, { flat }), t`无法保存`)} />
            </label>}
            <Select label={t`项目`} className="w-40 max-md:flex-1" value={chat.projectId ?? ''} disabled={busy} onChange={(projectId) => void run(() => api.updateChannelChat(chat.key, { projectId: projectId || null }), t`无法保存`)}
              options={[{ value: '', label: '—' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" aria-label={t`更多`} disabled={busy}><IconEllipsis /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="danger" onSelect={() => void removeChat(chat)}><IconTrash2 /><Trans>移除</Trans></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>;
      })}
    </SettingsGroup>}

    <SettingsGroup title={t`命令`} note={<Trans>其他以 / 开头的消息原样发给会话</Trans>}>
      {[
        ['/new', t`开始新会话`],
        ['/stop', t`停止进行中的回合`],
        ['/project', t`切换这个聊天的项目`],
        ['/model', t`切换模型、推理强度、上下文窗口和速度`],
        ['/status', t`查看项目、会话和模型`],
        ['/flat on|off', t`群里共用一个会话，或按话题分会话`],
        [t`/bind <码>`, t`用这里生成的绑定码绑定账号，只在私聊`],
        ['/help', t`在飞书里列出这些命令`],
      ].map(([usage, description]) => <div key={usage} className="flex items-baseline gap-4 py-2.5 max-md:flex-col max-md:gap-0.5">
        <code className="w-32 shrink-0 font-mono text-xs text-fg">{usage}</code>
        <span className="min-w-0 text-sm text-fg-2">{description}</span>
      </div>)}
    </SettingsGroup>

    <Dialog open={bindOpen} onOpenChange={setBindOpen}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle><Trans>可以使用的人</Trans></DialogTitle></DialogHeader>
        <DialogBody className="pb-5">{bindOpen && <BindCodeView accountId={account.id} />}</DialogBody>
      </DialogContent>
    </Dialog>
  </div>;
}

/** The server's live self-check; hidden once everything passes. */
function Checklist({ account, health, loading, onRefresh }: { account: ChannelAccountInfo; health: ChannelHealth; loading: boolean; onRefresh: () => void }) {
  const { t } = useLingui();
  const missing = health.missingScopes ?? [];
  const lastEventAt = health.lastEventAt ?? account.status.lastEventAt;
  const grant = external(health.grantUrl);
  const consoleLink = external(account.links.console);
  const connection = account.status.state;
  const connectionState = health.connected ? 'ok' : connection === 'connecting' ? 'busy' : account.enabled ? 'bad' : 'todo';
  if (health.connected && health.activated !== false && missing.length === 0 && lastEventAt && !health.needsLongConnection) return null;
  return <SettingsGroup title={t`待完成`} action={<Button size="icon-xs" variant="quiet" aria-label={t`重新检查`} onClick={onRefresh} busy={loading}><IconRefreshCw /></Button>}>
    <CheckItem state={connectionState} title={<Trans>连接飞书</Trans>} detail={connectionState === 'bad' ? account.status.error : undefined} />
    {health.activated !== undefined && <CheckItem state={health.activated ? 'ok' : 'bad'} title={<Trans>启用机器人</Trans>} />}
    {health.missingScopes !== undefined && <CheckItem
      state={missing.length ? 'bad' : 'ok'}
      title={<Trans>开通权限</Trans>}
      detail={missing.length ? <span className="select-text font-mono">{missing.join(' ')}</span> : undefined}
      action={missing.length > 0 && grant && <Button asChild size="sm"><a {...grant}><Trans>去申请</Trans><IconExternalLink /></a></Button>}
    />}
    {health.needsLongConnection && <CheckItem state="bad" title={<Trans>把事件订阅改为长连接</Trans>} action={consoleLink && <Button asChild size="sm"><a {...consoleLink}><Trans>打开开发者后台</Trans><IconExternalLink /></a></Button>} />}
    <CheckItem state={lastEventAt ? 'ok' : 'todo'} title={<Trans>收到第一条消息</Trans>} detail={lastEventAt ? undefined : t`在飞书私聊机器人发一条消息`} />
  </SettingsGroup>;
}
