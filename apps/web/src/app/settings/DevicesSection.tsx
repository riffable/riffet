import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppSettings, DeviceInfo } from '@contracts';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { IconChevronRight, IconCircleAlert, IconGlobe, IconLaptop, IconRefreshCw, IconSmartphone } from '@/components/icons';
import { EmptyState, Spinner, StatusDot, Switch } from '@/components/ui/controls';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { formatDate } from '@/lib/i18n/format';
import { cn, errorMessage, timeAgo } from '@/lib/utils';
import { useStores } from '../state/stores';
import { PushKeySection } from './PushKeySection';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

const isPhone = (device: DeviceInfo) => device.platform === 'android' || device.platform === 'ios';

/** Unseen this long, a record is folded away: usually one left behind by re-pairing. */
const IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/** Online first, then the most recently seen. */
const byPresence = (a: DeviceInfo, b: DeviceInfo) => Number(b.online) - Number(a.online) || (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '');

/** 设备管理: everything paired with this server, browsers included. */
export function DevicesSection({ settings, onSaved }: { settings: AppSettings; onSaved: (settings: AppSettings, patch: Partial<AppSettings>) => void }) {
  const { t } = useLingui();
  const [devices, setDevices] = useState<DeviceInfo[]>();
  const [currentId, setCurrentId] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [idleOpen, setIdleOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const { lists } = useStores();
  // A phone coming online or going offline shows at once.
  useEffect(() => lists.onDevices(() => setRevision((value) => value + 1)), [lists]);
  useEffect(() => {
    const controller = new AbortController();
    api.devices(controller.signal)
      .then(({ devices: list, currentId: own }) => { setDevices([...list].sort(byPresence)); setCurrentId(own); setError(''); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, t`无法读取设备`)); });
    return () => controller.abort();
  }, [revision]);

  const insecureChat = async (enabled: boolean) => {
    setBusy(true); setError('');
    const patch = { allowInsecureChat: enabled };
    try { onSaved(await api.updateSettings(patch), patch); }
    catch (reason) { setError(errorMessage(reason, t`无法保存设置`)); }
    finally { setBusy(false); }
  };
  // Browsers reaching this server over plain HTTP from another machine (docs/TRANSPORT-SECURITY.md §4).
  const unencrypted = <SettingsGroup title={t({ message: '未加密连接', context: 'settings-insecure-connections-group' })}>
    <SettingsRow title={t`允许对话`} description={t`同一网络上的人可以冒充这个浏览器，并借 Agent 执行命令。`}>
      <Switch aria-label={t`允许未加密连接对话`} checked={settings.allowInsecureChat === true} disabled={busy} onCheckedChange={(value) => void insecureChat(value)} />
    </SettingsRow>
  </SettingsGroup>;

  const revoke = async (ids: readonly string[]) => {
    setBusy(true); setError('');
    try { await Promise.all(ids.map((id) => api.revokeDevice(id))); }
    catch (reason) { setError(errorMessage(reason, t`无法移除设备`)); }
    finally { setBusy(false); setRevision((value) => value + 1); }
  };

  const remove = async (device: DeviceInfo) => {
    const description = device.id === currentId ? t`移除后需要重新配对，这个浏览器会退出登录` : t`移除后需要重新配对`;
    if (await confirmDialog({ title: t`移除 ${device.name}？`, description, confirmLabel: t`移除`, destructive: true })) await revoke([device.id]);
  };

  if (!devices) return error
    ? <EmptyState icon={<IconCircleAlert />} title={t`无法读取设备`} description={error}>
      <Button size="sm" onClick={() => setRevision((value) => value + 1)}><IconRefreshCw /><Trans>重试</Trans></Button>
    </EmptyState>
    : <div className="flex justify-center p-5"><Spinner /></div>;

  if (!devices.length) return <div className="flex flex-col gap-6"><EmptyState icon={<IconSmartphone />} title={t`没有已配对的设备`} />{unencrypted}<PushKeySection /></div>;

  const now = Date.now();
  const idle = (device: DeviceInfo) => device.id !== currentId && !device.online && now - Date.parse(device.lastSeenAt ?? device.createdAt) > IDLE_MS;
  const active = devices.filter((device) => !idle(device));
  const folded = devices.filter(idle);
  // Two records under one name are told apart by when each was paired.
  const shared = new Set(devices.map((device) => device.name).filter((name, index, names) => names.indexOf(name) !== index));

  const removeIdle = async () => {
    if (await confirmDialog({ title: t`移除 ${folded.length} 台设备？`, description: t`移除后需要重新配对`, confirmLabel: t`移除`, destructive: true })) await revoke(folded.map((device) => device.id));
  };

  const row = (device: DeviceInfo) => {
    const Icon = isPhone(device) ? IconSmartphone : device.platform === 'mac' ? IconLaptop : IconGlobe;
    const status = [
      device.id === currentId ? t`这台设备` : '',
      device.online ? t`在线` : device.lastSeenAt ? t`最后在线 ${timeAgo(device.lastSeenAt)}` : '',
      shared.has(device.name) ? t`配对于 ${formatDate(device.createdAt, { month: 'numeric', day: 'numeric' })}` : '',
      isPhone(device) && device.allowControl ? t`允许 Agent 操作` : '',
      isPhone(device) && device.capabilities.includes('screen.observe') ? t`无障碍已开启` : '',
      device.push?.route === 'direct' ? t`后台推送` : device.push?.reason === 'failed' ? t`推送失败` : '',
    ].filter(Boolean).join(' · ');
    return <div key={device.id} className="flex items-center gap-3 py-3.5 max-md:py-3">
      <Icon className="size-4 shrink-0 text-fg-3" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-fg" title={device.name}>{device.name}</span>
        {status && <span className="flex items-center gap-1.5 text-xs text-fg-3">{device.online && <StatusDot tone="success" />}{status}</span>}
      </div>
      <Button size="sm" variant="danger-ghost" className="max-md:min-h-11" disabled={busy} onClick={() => void remove(device)}><Trans>移除</Trans></Button>
    </div>;
  };

  return <div className="flex flex-col gap-6">
    <FeedbackNotice scope="devices" message={error} tone="danger" />
    {active.length > 0 && <SettingsGroup>{active.map(row)}</SettingsGroup>}
    {folded.length > 0 && <section className="flex flex-col">
      <div className="mb-1 flex h-7 items-center justify-between">
        <button
          type="button"
          aria-expanded={idleOpen}
          className="-mx-1 flex items-center gap-1 rounded-md px-1 text-xs font-medium text-fg-3 outline-none hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => setIdleOpen((open) => !open)}
        >
          <IconChevronRight className={cn('size-3.5 transition-transform', idleOpen && 'rotate-90')} />
          <Trans>超过 7 天未使用 · {folded.length}</Trans>
        </button>
        <Button size="xs" variant="danger-ghost" disabled={busy} onClick={() => void removeIdle()}><Trans>全部移除</Trans></Button>
      </div>
      <Collapse open={idleOpen}><SettingsGroup>{folded.map(row)}</SettingsGroup></Collapse>
    </section>}
    {unencrypted}
    <PushKeySection />
  </div>;
}
