import { useEffect, useState, type FormEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ChannelAccountInfo, ChannelDomain, ChannelRegistration, ChannelsState } from '@contracts';
import { Button } from '@/components/ui/button';
import { IconExternalLink, IconRefreshCw } from '@/components/icons';
import { Input, Segmented, Spinner } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/i18n/format';
import { errorMessage } from '@/lib/utils';
import { BindCodeView, CheckItem, useChannelHealth, type CheckState } from './shared';

/** `add` scans a new bot in; `reauthorize` scans an existing one again; `replace` retypes its credentials. */
export type AddBotMode = { kind: 'add' } | { kind: 'reauthorize'; account: ChannelAccountInfo } | { kind: 'replace'; account: ChannelAccountInfo };

type Step = { kind: 'scan' } | { kind: 'manual' } | { kind: 'progress'; accountId: string; manual: boolean };

/** Scan the QR, or type the credentials, then watch the new bot come up. Mounted afresh for each opening. */
export function AddBotDialog({ open, onOpenChange, mode, state, onChanged }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: AddBotMode;
  state?: ChannelsState;
  onChanged: () => void;
}) {
  const [step, setStep] = useState<Step>(mode.kind === 'replace' ? { kind: 'manual' } : { kind: 'scan' });
  const title = step.kind === 'manual' && mode.kind === 'replace' ? undefined : mode.kind === 'reauthorize' && step.kind === 'scan' ? <Trans>重新扫码授权</Trans> : <Trans>添加飞书机器人</Trans>;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{title ?? <Trans>更换凭据</Trans>}</DialogTitle></DialogHeader>
      {step.kind === 'scan' && <ScanStep open={open} account={mode.kind === 'reauthorize' ? mode.account : undefined} canType={mode.kind === 'add'} onClose={() => onOpenChange(false)} onType={() => setStep({ kind: 'manual' })} onDone={(accountId) => { onChanged(); setStep({ kind: 'progress', accountId, manual: false }); }} />}
      {step.kind === 'manual' && <ManualStep account={mode.kind === 'replace' ? mode.account : undefined} onClose={() => onOpenChange(false)} onSaved={(account) => { onChanged(); if (mode.kind === 'replace') onOpenChange(false); else setStep({ kind: 'progress', accountId: account.id, manual: true }); }} />}
      {step.kind === 'progress' && <ProgressStep accountId={step.accountId} manual={step.manual} state={state} onChanged={onChanged} onClose={() => onOpenChange(false)} />}
    </DialogContent>
  </Dialog>;
}

function ScanStep({ open, account, canType, onClose, onType, onDone }: {
  open: boolean;
  account?: ChannelAccountInfo;
  canType: boolean;
  onClose: () => void;
  onType: () => void;
  onDone: (accountId: string) => void;
}) {
  const { t } = useLingui();
  const [registration, setRegistration] = useState<ChannelRegistration>();
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const appId = account?.appId;
  // One registration per attempt; leaving (close, manual form, done) cancels it unless it finished.
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let finished = false;
    let id: string | undefined;
    let timer: number | undefined;
    setRegistration(undefined); setExpired(false); setError('');
    const poll = async (registrationId: string) => {
      try {
        const next = await api.channelRegistration(registrationId);
        if (stopped) return;
        if (next.state === 'done' && next.accountId) { finished = true; onDone(next.accountId); return; }
        if (next.state === 'expired' || next.state === 'cancelled') { setExpired(true); return; }
        if (next.state === 'failed') { setError(next.error || t`授权失败`); setExpired(true); return; }
      } catch { /* a missed poll is retried */ }
      if (!stopped) timer = window.setTimeout(() => void poll(registrationId), 2000);
    };
    api.createChannelRegistration({ kind: 'feishu', ...(appId ? { appId } : {}) }).then((created) => {
      if (stopped) { void api.deleteChannelRegistration(created.id).catch(() => undefined); return; }
      id = created.id;
      setRegistration(created);
      timer = window.setTimeout(() => void poll(created.id), 2000);
    }).catch((reason) => { if (!stopped) setError(errorMessage(reason, t`无法生成二维码`)); });
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (id && !finished) void api.deleteChannelRegistration(id).catch(() => undefined);
    };
    // Not keyed by `onDone` or `t`: re-running on them would cancel the scan in progress.
  }, [open, appId, attempt]);
  useEffect(() => {
    if (!registration || expired) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(registration.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [registration, expired]);
  return <>
    <DialogBody className="flex flex-col items-center gap-3 pb-5">
      {error && <Notice tone="danger" className="w-full">{error}</Notice>}
      {registration ? <>
        <img alt={t`二维码`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(registration.qr)}`} className={`size-52 rounded-xl bg-white p-3 transition-opacity ${expired ? 'opacity-30' : ''}`} />
        <span className="text-sm text-fg"><Trans>用飞书扫码</Trans></span>
        <Button asChild variant="link" size="sm"><a href={registration.url} target="_blank" rel="noreferrer"><Trans>在浏览器中打开</Trans><IconExternalLink /></a></Button>
        <span role="status" className="text-xs text-fg-3">{expired ? t`已过期` : t`有效至 ${formatTime(registration.expiresAt)}`}</span>
        {expired && <Button variant="primary" onClick={() => setAttempt((value) => value + 1)}><IconRefreshCw /><Trans>重新生成</Trans></Button>}
      </> : error ? <Button onClick={() => setAttempt((value) => value + 1)}><IconRefreshCw /><Trans>重试</Trans></Button> : <Spinner className="my-16 size-5" />}
    </DialogBody>
    <DialogFooter className={canType ? 'justify-between' : undefined}>
      {canType && <Button variant="quiet" onClick={onType}><Trans>手动填写</Trans></Button>}
      <Button variant="ghost" onClick={onClose}><Trans>取消</Trans></Button>
    </DialogFooter>
  </>;
}

function ManualStep({ account, onClose, onSaved }: { account?: ChannelAccountInfo; onClose: () => void; onSaved: (account: ChannelAccountInfo) => void }) {
  const { t } = useLingui();
  const [appId, setAppId] = useState(account?.appId ?? '');
  const [appSecret, setAppSecret] = useState('');
  const [domain, setDomain] = useState<ChannelDomain>(account?.domain ?? 'feishu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const value = { appId: appId.trim(), appSecret: appSecret.trim(), domain };
      onSaved(account ? await api.updateChannelAccount(account.id, value) : await api.createChannelAccount({ kind: 'feishu', ...value, enabled: true }));
    } catch (reason) { setError(errorMessage(reason, t`无法保存`)); setBusy(false); }
  };
  return <form onSubmit={(event) => void submit(event)}>
    <DialogBody className="flex flex-col gap-3 pb-2">
      {error && <Notice tone="danger">{error}</Notice>}
      <Input autoFocus aria-label="App ID" placeholder="App ID" className="font-mono max-md:h-11" autoComplete="off" autoCapitalize="none" spellCheck={false} value={appId} disabled={busy || Boolean(account)} onChange={(event) => setAppId(event.target.value)} />
      <Input aria-label="App Secret" placeholder="App Secret" type="password" className="max-md:h-11" autoComplete="new-password" spellCheck={false} value={appSecret} disabled={busy} onChange={(event) => setAppSecret(event.target.value)} />
      <Segmented ariaLabel={t`域名`} value={domain} onChange={setDomain} options={[{ value: 'feishu', label: t`飞书` }, { value: 'lark', label: 'Lark' }]} />
    </DialogBody>
    <DialogFooter>
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}><Trans>取消</Trans></Button>
      <Button type="submit" variant="primary" disabled={busy || !appId.trim() || !appSecret.trim()}><Trans>保存</Trans></Button>
    </DialogFooter>
  </form>;
}

function ProgressStep({ accountId, manual, state, onChanged, onClose }: { accountId: string; manual: boolean; state?: ChannelsState; onChanged: () => void; onClose: () => void }) {
  const account = state?.accounts.find((item) => item.id === accountId);
  const bound = state?.identities.some((item) => item.account === accountId) ?? false;
  const connection = account?.status.state;
  const connected = connection === 'connected';
  const [settled, setSettled] = useState(false);
  const { health } = useChannelHealth(account, settled ? undefined : 3000);
  const needsLongConnection = connected && health?.needsLongConnection === true;
  const complete = connected && bound && !needsLongConnection;
  useEffect(() => { if (complete) setSettled(true); }, [complete]);
  // The server announces changes; a slow poll covers one that is missed.
  useEffect(() => {
    if (settled) return;
    const timer = window.setInterval(onChanged, 3000);
    return () => window.clearInterval(timer);
  }, [settled, onChanged]);
  const connectionState: CheckState = connected ? 'ok' : connection === 'error' || connection === 'disconnected' ? 'bad' : 'busy';
  return <>
    <DialogBody className="flex flex-col pb-2 [&>*+*]:edge-t">
      <CheckItem state="ok" title={manual ? <Trans>保存凭据</Trans> : <Trans>创建应用</Trans>} />
      <CheckItem state={connectionState} title={<Trans>连接飞书</Trans>} detail={connectionState === 'bad' ? account?.status.error : undefined} />
      {needsLongConnection && <CheckItem state="todo" title={<Trans>把事件订阅改为长连接</Trans>} action={account?.links.console && <Button asChild size="sm"><a href={account.links.console} target="_blank" rel="noreferrer"><Trans>打开开发者后台</Trans><IconExternalLink /></a></Button>} />}
      {(!manual || connected) && <CheckItem state={bound ? 'ok' : 'busy'} title={<Trans>绑定你的飞书账号</Trans>} />}
    </DialogBody>
    {manual && connected && !bound && <div className="px-5 pb-2"><BindCodeView accountId={accountId} /></div>}
    <DialogFooter>
      {complete && account?.links.open && <Button asChild><a href={account.links.open} target="_blank" rel="noreferrer"><Trans>在飞书中打开</Trans><IconExternalLink /></a></Button>}
      <Button variant={complete ? 'primary' : 'ghost'} onClick={onClose}><Trans>完成</Trans></Button>
    </DialogFooter>
  </>;
}
