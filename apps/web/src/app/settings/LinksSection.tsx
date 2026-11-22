import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { LINK_BUDGET, type LinkAuditEntry, type LinkInfo, type LinkInviteResult, type LinkSelfInfo, type LinkUpdateRequest } from '@contracts';
import { IconArrowLeft, IconArrowRight, IconChevronRight, IconCircleAlert, IconExternalLink, IconLaptop, IconLink, IconPencilLine, IconRefreshCw, IconServer, IconTerminal } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState, Field, Input, Spinner, StatusDot, Switch, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { cn, errorMessage, timeAgo } from '@/lib/utils';
import { formatServerPlatform } from '../useServerLabel';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

/**
 * 设置 › 互联 (docs/SERVER-LINKS.md §10): the servers linked with this one. Connection direction and permission
 * direction are independent: whichever machine can reach the other opens the tunnel, and each server decides
 * whether the other may operate it. The other server's own settings are changed in its own web app.
 */
export function LinksSection() {
  const { t } = useLingui();
  const [links, setLinks] = useState<LinkInfo[]>();
  const [self, setSelf] = useState<LinkSelfInfo>();
  const [error, setError] = useState('');
  // Kept apart from `error`, which the next successful reread clears.
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<'ssh' | 'invite' | 'join'>();
  const [editing, setEditing] = useState<LinkInfo>();

  useEffect(() => {
    const controller = new AbortController();
    const read = () => api.links(controller.signal)
      .then(({ links: list, self: selfInfo }) => { setLinks(list); if (selfInfo) setSelf(selfInfo); setError(''); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, t`无法读取互联的服务器`)); });
    void read();
    // A tunnel coming up or dropping shows while the page is open.
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void read(); }, LINK_BUDGET.settingsPollMs);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [revision]);

  const refresh = () => setRevision((value) => value + 1);
  const run = async (serverId: string, action: () => Promise<unknown>, failure: string) => {
    setBusy(serverId); setActionError('');
    try { await action(); } catch (reason) { setActionError(errorMessage(reason, failure)); } finally { setBusy(undefined); refresh(); }
  };
  const remove = async (link: LinkInfo) => {
    if (await confirmDialog({ title: t`与 ${link.name} 断开互联？`, description: t`两台服务器都会断开，之后要重新互联`, confirmLabel: t`断开`, destructive: true })) {
      await run(link.serverId, () => api.removeLink(link.serverId), t`无法断开互联`);
    }
  };

  if (!links) return error
    ? <EmptyState icon={<IconCircleAlert />} title={t`无法读取互联的服务器`} description={error}>
      <Button size="sm" onClick={refresh}><IconRefreshCw /><Trans>重试</Trans></Button>
    </EmptyState>
    : <div className="flex justify-center p-5"><Spinner /></div>;

  return <div className="flex flex-col gap-6">
    <FeedbackNotice scope="links" message={actionError || error} tone="danger" />
    {self && <SelfServerGroup self={self} busy={busy === 'self'} onSave={(name) => void run('self', () => api.updateSelfLinkName(name), t`无法保存服务器名称`)} />}
    {links.length === 0 && (
      <EmptyState
        icon={<IconLink />}
        title={t`没有互联的服务器`}
        description={t`由能连通对方的一台发起连接，连上后双向共用隧道，各自控制是否允许对方操作本机`}
      />
    )}
    {links.map((link) => <LinkGroup key={link.serverId} link={link} busy={busy === link.serverId}
      onInbound={(inbound) => void run(link.serverId, () => api.updateLink(link.serverId, { inbound }), t`无法保存`)}
      onEdit={() => setEditing(link)}
      onRemove={() => void remove(link)} />)}
    <SettingsGroup
      title={t`添加互联`}
      note={<Trans>连接方向只取决于网络可达性；想在 A 机器里选 B 机器的目录，只需在 B 开启「允许 A 操作这台电脑」</Trans>}
    >
      <SettingsRow
        title={t`经 SSH 互联`}
        description={t`无需开放端口；在能 SSH 到对方的机器运行（例如 Mac 连 devbox）`}
      >
        <Button size="sm" onClick={() => setDialog('ssh')}><IconTerminal /><Trans>生成命令</Trans></Button>
      </SettingsRow>
      <SettingsRow
        title={t`生成链接串`}
        description={t`在本机可被对方直连时使用（如 devbox），由另一台粘贴后双向可用`}
      >
        <Button size="sm" onClick={() => setDialog('invite')}><Trans>生成链接串</Trans></Button>
      </SettingsRow>
      <SettingsRow
        title={t`粘贴链接串`}
        description={t`在无法被直连的机器上使用（如 Mac），主动连向生成链接串的一方`}
      >
        <Button size="sm" onClick={() => setDialog('join')}><Trans>粘贴链接串</Trans></Button>
      </SettingsRow>
    </SettingsGroup>
    <SshLinkDialog open={dialog === 'ssh'} onOpenChange={(open) => setDialog(open ? 'ssh' : undefined)} />
    <InviteDialog open={dialog === 'invite'} onOpenChange={(open) => setDialog(open ? 'invite' : undefined)} />
    <JoinDialog open={dialog === 'join'} onOpenChange={(open) => setDialog(open ? 'join' : undefined)} onJoined={refresh} />
    <EditLinkDialog link={editing} onOpenChange={(open) => { if (!open) setEditing(undefined); }} onSaved={refresh} />
  </div>;
}

function SelfServerGroup({ self, busy, onSave }: { self: LinkSelfInfo; busy: boolean; onSave: (name: string) => void }) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(self.name);
  useEffect(() => { if (!editing) setDraft(self.name); }, [self.name, editing]);
  const platform = formatServerPlatform(self.platform);

  const submit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === self.name) return;
    onSave(trimmed);
  };

  return <SettingsGroup title={t`这台服务器`}>
    <SettingsRow
      title={t`名称`}
      description={platform ? t`互联时向对端展示 · ${platform}` : t`互联时向对端展示`}
    >
      {editing ? (
        <div className="flex items-center gap-1.5">
          <Input
            value={draft}
            maxLength={LINK_BUDGET.nameChars}
            placeholder={self.defaultName}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
              if (event.key === 'Escape') { setDraft(self.name); setEditing(false); }
            }}
            className="h-8 w-44"
            autoFocus
          />
          <Button size="sm" disabled={busy} onClick={submit}><Trans>保存</Trans></Button>
          <Button size="sm" variant="ghost" onClick={() => { setDraft(self.name); setEditing(false); }}><Trans>取消</Trans></Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="max-w-48 truncate text-sm font-medium text-fg">{self.name}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}><IconPencilLine /><Trans>修改</Trans></Button>
        </div>
      )}
    </SettingsRow>
  </SettingsGroup>;
}

/** Shows the two independent permission directions across one tunnel so users can tell at a glance why a peer cannot be operated. */
function LinkDirectionSummary({ link }: { link: LinkInfo }) {
  const { t } = useLingui();
  return <div className="my-1 rounded-lg bg-subtle/60 px-3 py-2.5">
    <div className="flex items-center gap-3 max-sm:flex-col max-sm:items-stretch">
      <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-fg">
        <IconLaptop className="size-3.5 text-fg-3" />
        <span><Trans>这台电脑</Trans></span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 border-l border-line pl-3 max-sm:border-l-0 max-sm:border-t max-sm:pl-0 max-sm:pt-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <IconArrowRight className={cn('size-3.5 shrink-0', link.outbound ? 'text-success' : 'text-fg-4')} />
          <span className={cn(link.outbound ? 'text-fg-2' : 'text-fg-3')}>
            {link.outbound ? t`可浏览 ${link.name} 的目录并新建会话` : t`暂不能操作 ${link.name}`}
          </span>
          {!link.outbound && (
            <span className="text-fg-4">
              {link.webUrl
                ? <>· <a href={link.webUrl} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">{t`前往 ${link.name} 开启`}</a></>
                : t`· 需在 ${link.name} 的「设置 › 互联」开启`}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <IconArrowLeft className={cn('size-3.5 shrink-0', link.inbound ? 'text-success' : 'text-fg-4')} />
          <span className={cn(link.inbound ? 'text-fg-2' : 'text-fg-3')}>
            {link.inbound ? t`${link.name} 可浏览本机目录并新建会话` : t`${link.name} 不能操作这台电脑`}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-fg max-sm:hidden">
        <IconServer className="size-3.5 text-fg-3" />
        <span className="max-w-32 truncate">{link.name}</span>
      </div>
    </div>
  </div>;
}

function LinkGroup({ link, busy, onInbound, onEdit, onRemove }: { link: LinkInfo; busy: boolean; onInbound: (inbound: boolean) => void; onEdit: () => void; onRemove: () => void }) {
  const { t } = useLingui();
  const [auditOpen, setAuditOpen] = useState(false);
  const [audit, setAudit] = useState<LinkAuditEntry[]>();
  useEffect(() => {
    if (!auditOpen) return;
    const controller = new AbortController();
    api.linkAudit(link.serverId, controller.signal).then(({ entries }) => setAudit(entries)).catch(() => { if (!controller.signal.aborted) setAudit([]); });
    return () => controller.abort();
  }, [auditOpen, link.serverId]);

  const state = link.state === 'online' ? t`在线` : link.state === 'connecting' ? t`连接中` : link.state === 'removed' ? t`${link.name} 已断开互联` : t`离线`;
  const platform = formatServerPlatform(link.platform);
  const status = [
    state,
    link.alias,
    platform,
    link.version ?? '',
    link.state !== 'online' && link.state !== 'removed' && link.lastError ? link.lastError : '',
  ].filter(Boolean).join(' · ');

  return <SettingsGroup title={link.name}>
    <div className="flex items-center gap-3 py-3.5 max-md:flex-col max-md:items-stretch max-md:py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-xs text-fg-3">{link.state === 'online' && <StatusDot tone="success" />}<span className="truncate">{status}</span></span>
        {link.note && <span className="truncate text-xs text-fg-2">{link.note}</span>}
        {link.address && <span className="truncate font-mono text-xs text-fg-4">{link.transport === 'ssh' ? `ssh ${link.address}` : link.address}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {link.state !== 'removed' && <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}><IconPencilLine /><Trans>编辑</Trans></Button>}
        {link.webUrl && <Button size="sm" variant="ghost" asChild><a href={link.webUrl} target="_blank" rel="noreferrer"><IconExternalLink /><Trans>打开 {link.name} 的网页</Trans></a></Button>}
        <Button size="sm" variant="danger-ghost" className="max-md:min-h-11" disabled={busy} onClick={onRemove}>{link.state === 'removed' ? <Trans>移除</Trans> : <Trans>断开</Trans>}</Button>
      </div>
    </div>
    {link.state !== 'removed' && <div className="pb-2"><LinkDirectionSummary link={link} /></div>}
    {link.state !== 'removed' && <SettingsRow title={t`允许 ${link.name} 操作这台电脑`} description={t`开启后对方可浏览本机目录并新建会话；${link.name} 被他人控制时也会波及这台电脑`}>
      <Switch checked={link.inbound} disabled={busy} onCheckedChange={onInbound} aria-label={t`允许 ${link.name} 操作这台电脑`} />
    </SettingsRow>}
    {link.state !== 'removed' && <div className="flex flex-col py-2">
      <button type="button" aria-expanded={auditOpen} onClick={() => setAuditOpen((open) => !open)}
        className="-mx-1 flex h-8 items-center gap-1 self-start rounded-md px-1 text-xs font-medium text-fg-3 outline-none hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-focus">
        <IconChevronRight className={cn('size-3.5 transition-transform', auditOpen && 'rotate-90')} />
        <Trans>{link.name} 在这台电脑上的操作</Trans>
      </button>
      <Collapse open={auditOpen}>
        {audit === undefined ? <div className="flex justify-center py-3"><Spinner /></div>
          : audit.length === 0 ? <p className="py-2 text-xs text-fg-3"><Trans>没有记录</Trans></p>
            : <ul className="flex flex-col gap-1 py-2">{audit.map((entry, index) => <li key={`${entry.at}-${index}`} className="flex items-baseline gap-2 text-xs">
              <span className="w-14 shrink-0 font-mono text-fg-3">{entry.method}</span>
              <span className={cn('min-w-0 flex-1 truncate font-mono', entry.status >= 400 ? 'text-danger' : 'text-fg-2')}>{entry.path}</span>
              {entry.origin && <span className="shrink-0 truncate text-fg-3">{entry.origin}</span>}
              <span className="shrink-0 text-fg-4">{timeAgo(entry.at)}</span>
            </li>)}</ul>}
      </Collapse>
    </div>}
  </SettingsGroup>;
}

function InboundChoice({ inbound, onChange }: { inbound: boolean; onChange: (inbound: boolean) => void }) {
  const { t } = useLingui();
  return <label className="flex items-start justify-between gap-4">
    <span className="flex flex-col gap-0.5">
      <span className="text-sm font-medium text-fg"><Trans>允许对方操作这台电脑</Trans></span>
      <span className="text-xs text-fg-3"><Trans>开启后对方可浏览本机目录并新建会话；对方被他人控制时也会波及这台电脑</Trans></span>
    </span>
    <Switch checked={inbound} onCheckedChange={onChange} aria-label={t`允许对方操作这台电脑`} />
  </label>;
}

/** Formats one shell token safely when generating a copyable `riffet link ssh` command. */
function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function SshLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLingui();
  const [host, setHost] = useState('');
  const [remoteCommand, setRemoteCommand] = useState('');
  const [allowIn, setAllowIn] = useState(false);
  useEffect(() => { if (!open) { setHost(''); setRemoteCommand(''); setAllowIn(false); } }, [open]);

  const target = host.trim() || 'user@devbox';
  const parts = ['riffet', 'link', 'ssh', shellArg(target)];
  if (allowIn) parts.push('--allow-in');
  if (remoteCommand.trim()) parts.push('--remote-command', shellArg(remoteCommand.trim()));
  const command = parts.join(' ');

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="form">
      <DialogHeader><DialogTitle><Trans>经 SSH 互联</Trans></DialogTitle></DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <Field label={t`SSH 目标`} hint={t`填写要连向的远端主机（例如 devbox），在能 SSH 到它的机器终端执行下面命令`}>
          <Input value={host} onChange={(event) => setHost(event.target.value)} placeholder="user@devbox" className="font-mono" autoFocus />
        </Field>
        <Field label={t`远端 riffet 路径（可选）`} hint={t`仅在远端非交互 shell 找不到 riffet 时填写`}>
          <Input value={remoteCommand} onChange={(event) => setRemoteCommand(event.target.value)} placeholder="/usr/local/bin/riffet" className="font-mono" />
        </Field>
        <label className="flex items-start justify-between gap-4">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-fg"><Trans>允许远端操作发起命令的机器</Trans></span>
            <span className="text-xs text-fg-3"><Trans>例如在 Mac 上运行并开启此项后，就能在 devbox 的网页里选择 Mac 目录；远端被控制时也会波及本机</Trans></span>
          </span>
          <Switch checked={allowIn} onCheckedChange={setAllowIn} aria-label={t`允许远端操作发起命令的机器`} />
        </label>
        <Field label={t`终端命令`} hint={t`命令会默认开启「本机操作远端」；断线重连需要免交互 SSH（密钥或 ssh-agent）`}>
          <div className="flex items-center gap-1">
            <Input readOnly value={command} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
            <CopyButton text={command} />
          </div>
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)}><Trans>完成</Trans></Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** The address this page was opened at, unless it only works on this machine. */
function defaultAddress(): string {
  const { hostname, origin } = window.location;
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? '' : origin;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value.trim());
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  } catch { return false; }
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLingui();
  const [inbound, setInbound] = useState(false);
  const [url, setUrl] = useState(defaultAddress);
  const [invite, setInvite] = useState<LinkInviteResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) { setInvite(undefined); setError(''); setInbound(false); setUrl(defaultAddress()); } }, [open]);
  const loopbackWarning = isLoopbackUrl(url) ? t`另一台机器访问不到回环地址，请填内网/局域网 IP，或改用 SSH 互联` : undefined;
  const generate = async () => {
    setBusy(true); setError('');
    try { setInvite(await api.createLinkInvite({ inbound, url: url.trim() })); }
    catch (reason) { setError(errorMessage(reason, t`无法生成链接串`)); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="form">
      <DialogHeader><DialogTitle><Trans>生成链接串</Trans></DialogTitle></DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        {!invite && <Field label={t`另一台服务器连到这里用的地址`} error={loopbackWarning}>
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://192.0.2.20:4337" className="font-mono" autoFocus />
        </Field>}
        {!invite && <InboundChoice inbound={inbound} onChange={setInbound} />}
        {invite && <Field label={t`链接串`} hint={t`在另一台服务器的「设置 › 互联 › 粘贴链接串」中填入（5 分钟内有效，仅一次）。如需在这台电脑选择对方目录，记得在对方粘贴时开启授权开关`}>
          <div className="flex items-start gap-1">
            <Textarea readOnly value={invite.link} className="min-h-24 font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
            <CopyButton text={invite.link} />
          </div>
        </Field>}
        <FeedbackNotice scope="link-invite" message={error} tone="danger" />
      </DialogBody>
      <DialogFooter>
        {invite ? <Button onClick={() => onOpenChange(false)}><Trans>完成</Trans></Button>
          : <Button variant="primary" busy={busy} disabled={!url.trim()} onClick={() => void generate()}><Trans>生成链接串</Trans></Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function JoinDialog({ open, onOpenChange, onJoined }: { open: boolean; onOpenChange: (open: boolean) => void; onJoined: () => void }) {
  const { t } = useLingui();
  const [text, setText] = useState('');
  const [inbound, setInbound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) { setText(''); setError(''); setInbound(false); } }, [open]);
  const join = async () => {
    setBusy(true); setError('');
    try { await api.joinLink({ link: text.trim(), inbound }); onJoined(); onOpenChange(false); }
    catch (reason) { setError(errorMessage(reason, t`无法互联`)); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="form">
      <DialogHeader><DialogTitle><Trans>粘贴链接串</Trans></DialogTitle></DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <Field label={t`链接串`}>
          <Textarea value={text} onChange={(event) => setText(event.target.value)} className="min-h-24 font-mono text-xs" placeholder="riffet-link:v1:…" autoFocus />
        </Field>
        <InboundChoice inbound={inbound} onChange={setInbound} />
        <FeedbackNotice scope="link-join" message={error} tone="danger" />
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" busy={busy} disabled={!text.trim().startsWith('riffet-link:')} onClick={() => void join()}><Trans>互联</Trans></Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function EditLinkDialog({ link, onOpenChange, onSaved }: { link?: LinkInfo; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const { t } = useLingui();
  const [name, setName] = useState('');
  const [alias, setAlias] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!link) return;
    setName(link.name);
    setAlias(link.alias);
    setNote(link.note ?? '');
    setError('');
  }, [link]);

  const save = async () => {
    if (!link) return;
    setBusy(true); setError('');
    try {
      const change: LinkUpdateRequest = { name: name.trim(), alias: alias.trim(), note: note.trim() };
      await api.updateLink(link.serverId, change);
      onSaved();
      onOpenChange(false);
    } catch (reason) {
      setError(errorMessage(reason, t`无法保存`));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={Boolean(link)} onOpenChange={onOpenChange}>
    <DialogContent size="form">
      <DialogHeader><DialogTitle><Trans>编辑服务器</Trans></DialogTitle></DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <Field label={t`显示名称`} hint={link?.peerName ? t`对端自报：${link.peerName}；留空恢复对端名称` : t`仅在本机生效，重连后不会被覆盖`}>
          <Input value={name} maxLength={LINK_BUDGET.nameChars} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
        <Field label={t`短别名`} hint={t`本机唯一，用于多服务器标签与命令行寻址（小写字母、数字、. _ -）`}>
          <Input value={alias} maxLength={LINK_BUDGET.aliasChars} onChange={(event) => setAlias(event.target.value)} className="font-mono" />
        </Field>
        <Field label={t`备注`} hint={t`仅在本机显示，方便区分多台机器`}>
          <Input value={note} maxLength={LINK_BUDGET.noteChars} onChange={(event) => setNote(event.target.value)} placeholder={t`例如：iOS 构建机`} />
        </Field>
        <FeedbackNotice scope="link-edit" message={error} tone="danger" />
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}><Trans>取消</Trans></Button>
        <Button variant="primary" busy={busy} disabled={!alias.trim()} onClick={() => void save()}><Trans>保存</Trans></Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
