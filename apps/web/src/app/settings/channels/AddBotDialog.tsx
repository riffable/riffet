import { useEffect, useState, type FormEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ChannelAccountInfo, ChannelFieldSpec, ChannelProviderInfo, ChannelRegistration, ChannelsState } from '@contracts';
import { Button } from '@/components/ui/button';
import { IconChevronDown, IconChevronRight, IconExternalLink, IconRefreshCw } from '@/components/icons';
import { Field, Input, Segmented, Select, Spinner } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/i18n/format';
import { localizedText } from '@/lib/plugins';
import { cn, errorMessage } from '@/lib/utils';
import { BindCodeView, CheckItem, providerName, providerOf, useChannelHealth, type CheckState } from './shared';

/** `add` creates a new bot; `reauthorize` scans an existing one again; `replace` retypes its credentials. */
export type AddBotMode =
  | { kind: 'add'; providerKind?: string }
  | { kind: 'reauthorize'; account: ChannelAccountInfo }
  | { kind: 'replace'; account: ChannelAccountInfo; expandAdvanced?: boolean };

type Step =
  | { kind: 'pick' }
  | { kind: 'scan'; providerKind: string }
  | { kind: 'manual'; providerKind: string; account?: ChannelAccountInfo; expandAdvanced?: boolean }
  | { kind: 'progress'; providerKind: string; accountId: string; manual: boolean };

function initialStep(mode: AddBotMode, state: ChannelsState | undefined): Step {
  if (mode.kind === 'replace') return { kind: 'manual', providerKind: mode.account.kind, account: mode.account, expandAdvanced: mode.expandAdvanced };
  if (mode.kind === 'reauthorize') return { kind: 'scan', providerKind: mode.account.kind };
  const providers = state?.providers ?? [];
  const chosen = mode.providerKind
    ? providers.find((item) => item.id === mode.providerKind)
    : providers.length === 1 ? providers[0] : undefined;
  if (!chosen) return { kind: 'pick' };
  return chosen.register ? { kind: 'scan', providerKind: chosen.id } : { kind: 'manual', providerKind: chosen.id };
}

/** Pick a platform if multiple exist, scan the QR or fill credentials, then watch the new bot come up. Mounted afresh for each opening. */
export function AddBotDialog({ open, onOpenChange, mode, state, onChanged }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: AddBotMode;
  state?: ChannelsState;
  onChanged: () => void;
}) {
  const { i18n } = useLingui();
  const [step, setStep] = useState<Step>(() => initialStep(mode, state));
  const activeKind = step.kind === 'pick' ? undefined : step.providerKind;
  const provider = providerOf(state, activeKind);
  const platform = provider ? providerName(provider, i18n.locale, provider.id) : undefined;
  const editingAccount = step.kind === 'manual' ? step.account : undefined;
  const title = step.kind === 'manual' && (mode.kind === 'replace' || Boolean(editingAccount))
    ? <Trans>修改配置</Trans>
    : mode.kind === 'reauthorize' && step.kind === 'scan'
      ? <Trans>重新扫码授权</Trans>
      : platform
        ? <Trans>添加 {platform} 机器人</Trans>
        : <Trans>添加机器人</Trans>;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      {step.kind === 'pick' && <PickPlatformStep providers={state?.providers ?? []} onPick={(chosen) => setStep(chosen.register ? { kind: 'scan', providerKind: chosen.id } : { kind: 'manual', providerKind: chosen.id })} onClose={() => onOpenChange(false)} />}
      {step.kind === 'scan' && provider && <ScanStep open={open} provider={provider} account={mode.kind === 'reauthorize' ? mode.account : undefined} canType={mode.kind === 'add' && provider.fields.length > 0} onClose={() => onOpenChange(false)} onType={() => setStep({ kind: 'manual', providerKind: provider.id })} onDone={(accountId) => { onChanged(); setStep({ kind: 'progress', providerKind: provider.id, accountId, manual: false }); }} />}
      {step.kind === 'manual' && provider && <ManualStep provider={provider} account={editingAccount} expandAdvanced={step.expandAdvanced} onClose={() => onOpenChange(false)} onSaved={(account) => { onChanged(); if (mode.kind === 'replace') onOpenChange(false); else setStep({ kind: 'progress', providerKind: provider.id, accountId: account.id, manual: true }); }} />}
      {step.kind === 'progress' && <ProgressStep provider={provider} accountId={step.accountId} manual={step.manual} state={state} onChanged={onChanged} onEdit={(account) => setStep({ kind: 'manual', providerKind: account.kind, account, expandAdvanced: true })} onClose={() => onOpenChange(false)} />}
    </DialogContent>
  </Dialog>;
}

function PickPlatformStep({ providers, onPick, onClose }: { providers: ChannelProviderInfo[]; onPick: (provider: ChannelProviderInfo) => void; onClose: () => void }) {
  const { i18n } = useLingui();
  return <>
    <DialogBody className="flex flex-col pb-2 [&>*+*]:edge-t">
      {providers.map((provider) => {
        const summary = localizedText(provider.hints?.summary, [i18n.locale]);
        return <button key={provider.id} type="button" onClick={() => onPick(provider)} className="-mx-5 flex min-h-14 items-center justify-between gap-3 px-5 py-2.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-fg">{providerName(provider, i18n.locale, provider.id)}</span>
            {summary && <span className="truncate text-xs text-fg-3">{summary}</span>}
          </span>
          <IconChevronRight className="size-4 shrink-0 text-fg-4" />
        </button>;
      })}
    </DialogBody>
    <DialogFooter>
      <Button variant="ghost" onClick={onClose}><Trans>取消</Trans></Button>
    </DialogFooter>
  </>;
}

function ScanStep({ open, provider, account, canType, onClose, onType, onDone }: {
  open: boolean;
  provider: ChannelProviderInfo;
  account?: ChannelAccountInfo;
  canType: boolean;
  onClose: () => void;
  onType: () => void;
  onDone: (accountId: string) => void;
}) {
  const { t, i18n } = useLingui();
  const [registration, setRegistration] = useState<ChannelRegistration>();
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const externalId = account?.identity?.value || account?.appId || undefined;
  const platform = providerName(provider, i18n.locale, provider.id);
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
    api.createChannelRegistration({ kind: provider.id, ...(externalId ? { externalId } : {}) }).then((created) => {
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
  }, [open, provider.id, externalId, attempt]);
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
        <span className="text-sm text-fg"><Trans>用 {platform} 扫码</Trans></span>
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

function initialValues(fields: ChannelFieldSpec[], account?: ChannelAccountInfo): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind === 'secret') values[field.key] = '';
    else values[field.key] = account?.config?.[field.key] ?? field.defaultValue ?? '';
  }
  return values;
}

function ManualStep({ provider, account, expandAdvanced, onClose, onSaved }: {
  provider: ChannelProviderInfo;
  account?: ChannelAccountInfo;
  expandAdvanced?: boolean;
  onClose: () => void;
  onSaved: (account: ChannelAccountInfo) => void;
}) {
  const { t, i18n } = useLingui();
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(provider.fields, account));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const primaryFields = provider.fields.filter((field) => !field.advanced);
  const advancedFields = provider.fields.filter((field) => field.advanced);
  const hasAdvancedValue = advancedFields.some((field) => Boolean((account?.config?.[field.key] ?? '').trim()));
  const [showAdvanced, setShowAdvanced] = useState(Boolean(expandAdvanced || hasAdvancedValue));

  const setValue = (key: string, next: string) => setValues((current) => ({ ...current, [key]: next }));
  const firstEditableKey = primaryFields.find((field) => !(account && field.immutable))?.key
    ?? provider.fields.find((field) => !(account && field.immutable))?.key;
  const ready = provider.fields.every((field) => {
    const trimmed = (values[field.key] ?? '').trim();
    if (!field.required) return true;
    // Replacing credentials lets untouched secrets stay blank unless no secret was stored.
    if (account && field.kind === 'secret' && account.secretSet) return true;
    return trimmed.length > 0;
  }) && (!account || provider.fields.some((field) => {
    const trimmed = (values[field.key] ?? '').trim();
    if (field.kind === 'secret') return trimmed.length > 0;
    return trimmed !== (account.config?.[field.key] ?? '');
  }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const config: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      for (const field of provider.fields) {
        const trimmed = (values[field.key] ?? '').trim();
        if (field.kind === 'secret') {
          if (trimmed) secrets[field.key] = trimmed;
        } else if (!(account && field.immutable)) {
          config[field.key] = trimmed;
        }
      }
      const payload = {
        ...(Object.keys(config).length ? { config } : {}),
        ...(Object.keys(secrets).length ? { secrets } : {}),
      };
      onSaved(account
        ? await api.updateChannelAccount(account.id, payload)
        : await api.createChannelAccount({ kind: provider.id, ...payload, enabled: true }));
    } catch (reason) {
      setError(errorMessage(reason, t`无法保存`));
      setBusy(false);
    }
  };

  const renderField = (field: ChannelFieldSpec) => {
    const label = localizedText(field.label, [i18n.locale]) ?? field.key;
    const placeholder = localizedText(field.placeholder, [i18n.locale]) ?? (account && field.kind === 'secret' ? t`留空保持不变` : label);
    const value = values[field.key] ?? '';
    const disabled = busy || Boolean(account && field.immutable);
    if (field.kind === 'select' && field.options?.length) {
      const options = field.options.map((option) => ({ value: option.value, label: localizedText(option.label, [i18n.locale]) ?? option.value }));
      return <Field key={field.key} label={label}>
        {options.length <= 3
          ? <Segmented ariaLabel={label} value={value} onChange={(next) => setValue(field.key, next)} options={options} />
          : <Select label={label} value={value} disabled={disabled} onChange={(next) => setValue(field.key, next)} options={options} />}
      </Field>;
    }
    return <Field key={field.key} label={label}>
      <Input
        autoFocus={field.key === firstEditableKey}
        aria-label={label}
        placeholder={placeholder}
        type={field.kind === 'secret' ? 'password' : 'text'}
        className={cn('max-md:h-11', field.mono && 'font-mono')}
        autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(field.key, event.target.value)}
      />
    </Field>;
  };

  const sourceHint = localizedText(provider.hints?.credentialSource, [i18n.locale]);
  const sourceLinkLabel = localizedText(provider.hints?.credentialLinkLabel, [i18n.locale]);

  return <form onSubmit={(event) => void submit(event)}>
    <DialogBody className="flex flex-col gap-3 pb-2">
      {error && <Notice tone="danger">{error}</Notice>}
      {sourceHint && <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-fg-3">
        <span>{sourceHint}</span>
        {provider.hints?.credentialUrl && sourceLinkLabel && (
          <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
            <a href={provider.hints.credentialUrl} target="_blank" rel="noreferrer">{sourceLinkLabel}<IconExternalLink /></a>
          </Button>
        )}
      </div>}
      {primaryFields.map(renderField)}
      {advancedFields.length > 0 && <div className="flex flex-col gap-3 pt-1">
        <button
          type="button"
          onClick={() => setShowAdvanced((open) => !open)}
          className="flex items-center gap-1.5 self-start text-xs text-fg-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {showAdvanced ? <IconChevronDown className="size-3.5" /> : <IconChevronRight className="size-3.5" />}
          <Trans>代理与自定义地址</Trans>
        </button>
        {showAdvanced && advancedFields.map(renderField)}
      </div>}
    </DialogBody>
    <DialogFooter>
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}><Trans>取消</Trans></Button>
      <Button type="submit" variant="primary" disabled={busy || !ready}><Trans>保存</Trans></Button>
    </DialogFooter>
  </form>;
}

function ProgressStep({ provider, accountId, manual, state, onChanged, onEdit, onClose }: {
  provider?: ChannelProviderInfo;
  accountId: string;
  manual: boolean;
  state?: ChannelsState;
  onChanged: () => void;
  onEdit: (account: ChannelAccountInfo) => void;
  onClose: () => void;
}) {
  const { i18n } = useLingui();
  const account = state?.accounts.find((item) => item.id === accountId);
  const bound = state?.identities.some((item) => item.account === accountId) ?? false;
  const connection = account?.status.state;
  const connected = connection === 'connected';
  const [settled, setSettled] = useState(false);
  const { health } = useChannelHealth(account, settled ? undefined : 3000);
  const manualStepText = localizedText(provider?.hints?.manualSetupStep, [i18n.locale]);
  const needsManualStep = connected && health?.needsLongConnection === true && Boolean(manualStepText);
  const complete = connected && bound && !needsManualStep;
  const platform = providerName(provider, i18n.locale, account?.kind);
  useEffect(() => { if (complete) setSettled(true); }, [complete]);
  // The server announces changes; a slow poll covers one that is missed.
  useEffect(() => {
    if (settled) return;
    const timer = window.setInterval(onChanged, 3000);
    return () => window.clearInterval(timer);
  }, [settled, onChanged]);
  const connectionState: CheckState = connected ? 'ok' : connection === 'error' || connection === 'disconnected' ? 'bad' : 'busy';
  const canEdit = Boolean(account && (provider?.fields.length ?? 0) > 0);
  return <>
    <DialogBody className="flex flex-col pb-2 [&>*+*]:edge-t">
      <CheckItem state="ok" title={manual ? <Trans>保存凭据</Trans> : <Trans>创建应用</Trans>} />
      <CheckItem
        state={connectionState}
        title={<Trans>连接 {platform}</Trans>}
        detail={connectionState === 'bad' ? account?.status.error : undefined}
        action={connectionState === 'bad' && canEdit && account && <Button size="sm" onClick={() => onEdit(account)}><Trans>修改配置</Trans></Button>}
      />
      {needsManualStep && manualStepText && <CheckItem state="todo" title={manualStepText} action={account?.links.console && <Button asChild size="sm"><a href={account.links.console} target="_blank" rel="noreferrer"><Trans>打开开发者后台</Trans><IconExternalLink /></a></Button>} />}
      {(!manual || connected) && <CheckItem state={bound ? 'ok' : 'busy'} title={<Trans>绑定你的 {platform} 账号</Trans>} />}
    </DialogBody>
    {manual && connected && !bound && <div className="px-5 pb-2"><BindCodeView accountId={accountId} platformName={platform} openUrl={account?.links.open} /></div>}
    <DialogFooter>
      {complete && account?.links.open && <Button asChild><a href={account.links.open} target="_blank" rel="noreferrer"><Trans>在 {platform} 中打开</Trans><IconExternalLink /></a></Button>}
      <Button variant={complete ? 'primary' : 'ghost'} onClick={onClose}><Trans>完成</Trans></Button>
    </DialogFooter>
  </>;
}
