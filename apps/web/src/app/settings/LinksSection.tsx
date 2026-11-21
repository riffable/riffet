import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { LINK_BUDGET, type LinkAuditEntry, type LinkInfo, type LinkInviteResult } from '@contracts';
import { IconChevronRight, IconCircleAlert, IconExternalLink, IconLink, IconRefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState, Field, Input, Spinner, StatusDot, Switch, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { cn, errorMessage, timeAgo } from '@/lib/utils';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

/**
 * 设置 › 互联 (docs/SERVER-LINKS.md §10): the servers linked with this one. Each server decides only whether the
 * other may operate it, so each link shows one switch. The other server's own settings are changed in its own web app.
 */
export function LinksSection() {
  const { t } = useLingui();
  const [links, setLinks] = useState<LinkInfo[]>();
  const [error, setError] = useState('');
  // Kept apart from `error`, which the next successful reread clears.
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<'invite' | 'join'>();

  useEffect(() => {
    const controller = new AbortController();
    const read = () => api.links(controller.signal)
      .then(({ links: list }) => { setLinks(list); setError(''); })
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
    {links.length === 0 && <EmptyState icon={<IconLink />} title={t`没有互联的服务器`} />}
    {links.map((link) => <LinkGroup key={link.serverId} link={link} busy={busy === link.serverId}
      onInbound={(inbound) => void run(link.serverId, () => api.updateLink(link.serverId, inbound), t`无法保存`)}
      onRemove={() => void remove(link)} />)}
    <SettingsGroup title={t`添加互联`} note={<Trans>也可以在这台机器上运行 <code className="font-mono">riffet link ssh 主机</code>，隧道经 SSH 建立</Trans>}>
      <SettingsRow title={t`邀请另一台服务器`}>
        <Button size="sm" onClick={() => setDialog('invite')}><Trans>生成链接串</Trans></Button>
      </SettingsRow>
      <SettingsRow title={t`加入另一台服务器`}>
        <Button size="sm" onClick={() => setDialog('join')}><Trans>粘贴链接串</Trans></Button>
      </SettingsRow>
    </SettingsGroup>
    <InviteDialog open={dialog === 'invite'} onOpenChange={(open) => setDialog(open ? 'invite' : undefined)} />
    <JoinDialog open={dialog === 'join'} onOpenChange={(open) => setDialog(open ? 'join' : undefined)} onJoined={refresh} />
  </div>;
}

function LinkGroup({ link, busy, onInbound, onRemove }: { link: LinkInfo; busy: boolean; onInbound: (inbound: boolean) => void; onRemove: () => void }) {
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
  const status = [
    state,
    link.state === 'removed' ? '' : link.outbound ? t`可以操作 ${link.name}` : t`${link.name} 未允许这台电脑操作它`,
    link.version ?? '',
    link.state !== 'online' && link.state !== 'removed' && link.lastError ? link.lastError : '',
  ].filter(Boolean).join(' · ');

  return <SettingsGroup title={link.name}>
    <div className="flex items-center gap-3 py-3.5 max-md:flex-col max-md:items-stretch max-md:py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-xs text-fg-3">{link.state === 'online' && <StatusDot tone="success" />}<span className="truncate">{status}</span></span>
        {link.address && <span className="truncate font-mono text-xs text-fg-4">{link.transport === 'ssh' ? `ssh ${link.address}` : link.address}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {link.webUrl && <Button size="sm" variant="ghost" asChild><a href={link.webUrl} target="_blank" rel="noreferrer"><IconExternalLink /><Trans>打开 {link.name} 的网页</Trans></a></Button>}
        <Button size="sm" variant="danger-ghost" className="max-md:min-h-11" disabled={busy} onClick={onRemove}>{link.state === 'removed' ? <Trans>移除</Trans> : <Trans>断开</Trans>}</Button>
      </div>
    </div>
    {link.state !== 'removed' && <SettingsRow title={t`允许 ${link.name} 操作这台电脑`} description={t`${link.name} 被他人控制时，对方也能操作这台电脑`}>
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
      <span className="text-xs text-fg-3"><Trans>对方被他人控制时，也能操作这台电脑</Trans></span>
    </span>
    <Switch checked={inbound} onCheckedChange={onChange} aria-label={t`允许对方操作这台电脑`} />
  </label>;
}

/** The address this page was opened at, unless it only works on this machine. */
function defaultAddress(): string {
  const { hostname, origin } = window.location;
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? '' : origin;
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLingui();
  const [inbound, setInbound] = useState(false);
  const [url, setUrl] = useState(defaultAddress);
  const [invite, setInvite] = useState<LinkInviteResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) { setInvite(undefined); setError(''); setInbound(false); setUrl(defaultAddress()); } }, [open]);
  const generate = async () => {
    setBusy(true); setError('');
    try { setInvite(await api.createLinkInvite({ inbound, url: url.trim() })); }
    catch (reason) { setError(errorMessage(reason, t`无法生成链接串`)); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="form">
      <DialogHeader><DialogTitle><Trans>邀请另一台服务器</Trans></DialogTitle></DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        {!invite && <Field label={t`另一台服务器连到这里用的地址`}>
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://192.168.1.20:4337" className="font-mono" autoFocus />
        </Field>}
        {!invite && <InboundChoice inbound={inbound} onChange={setInbound} />}
        {invite && <Field label={t`链接串`} hint={t`在另一台服务器的「设置 › 互联」粘贴。5 分钟内有效，只能用一次`}>
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
      <DialogHeader><DialogTitle><Trans>加入另一台服务器</Trans></DialogTitle></DialogHeader>
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
