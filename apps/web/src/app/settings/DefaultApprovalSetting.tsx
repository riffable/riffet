import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeBackendCapabilities, NativeBackendId, NativeBackendOption } from '@contracts';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/utils';
import { ApprovalPicker } from '../session/ApprovalPicker';
import { SettingsRow } from './SettingsLayout';

export function DefaultApprovalSetting({ backendId, capabilities: offeredCapabilities, value, disabled, onChange }: {
  backendId: NativeBackendId;
  profileId?: string;
  /** Already read by the containing Agent page; the fallback also works outside StoresContext. */
  capabilities?: NativeBackendCapabilities;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useLingui();
  const supplied = offeredCapabilities?.backendId === backendId ? offeredCapabilities : undefined;
  const [read, setRead] = useState<{ backendId: NativeBackendId; capabilities?: NativeBackendCapabilities; loading: boolean; error: string }>();
  const [retry, setRetry] = useState(0);
  const current = read?.backendId === backendId ? read : undefined;
  const capabilities = supplied ?? current?.capabilities;
  const loading = !capabilities && (!current || current.loading);
  const error = capabilities ? '' : current?.error ?? '';
  useEffect(() => {
    let active = true;
    if (supplied) {
      setRead({ backendId, capabilities: supplied, loading: false, error: '' });
      return () => { active = false; };
    }
    setRead((previous) => ({ backendId, capabilities: previous?.backendId === backendId ? previous.capabilities : undefined, loading: true, error: '' }));
    void api.backends().then((entries) => {
      if (!active) return;
      const entry = entries.find((item) => item.backendId === backendId);
      if (!entry) throw new Error(t`该 Agent 尚未配置提供商`);
      setRead({ backendId, capabilities: entry.capabilities, loading: false, error: '' });
    }).catch((failure) => {
      if (active) setRead((previous) => ({ backendId, capabilities: previous?.backendId === backendId ? previous.capabilities : undefined, loading: false, error: errorMessage(failure, t`无法加载审批模式，请重试`) }));
    });
    return () => { active = false; };
  }, [backendId, supplied, retry]);
  const permissions = capabilities?.supportsPermissionSelection ? capabilities.permissions : [];
  const options: NativeBackendOption[] = [{ id: '', label: t`沿用 CLI 默认` }, ...permissions];
  return <SettingsRow title={t`默认审批模式`} description={error || t`已有会话保持原配置。`}>
    {loading ? <Spinner /> : error ? <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setRetry((current) => current + 1)}><Trans>重试</Trans></Button>
      : permissions.length ? <ApprovalPicker value={value} options={options} side="bottom" disabled={disabled} onChange={onChange} />
        : <span className="text-xs text-fg-3"><Trans>暂不支持选择</Trans></span>}
  </SettingsRow>;
}
