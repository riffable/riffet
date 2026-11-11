import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeBackendCapabilities, NativeBackendId, NativeBackendOption } from '@contracts';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/utils';
import { ApprovalPicker } from '../session/ApprovalPicker';
import { SettingsRow } from './SettingsLayout';

export function DefaultApprovalSetting({ backendId, profileId, value, disabled, onChange }: {
  backendId: NativeBackendId;
  profileId?: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useLingui();
  const [capabilities, setCapabilities] = useState<NativeBackendCapabilities>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setCapabilities(undefined);
    void api.backends().then((entries) => {
      if (!active) return;
      const entry = entries.find((item) => item.backendId === backendId);
      if (!entry) throw new Error(t`该 Agent 尚未配置提供商`);
      setCapabilities(entry.capabilities);
    }).catch((failure) => { if (active) setError(errorMessage(failure, t`无法加载审批模式，请重试`)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [backendId, profileId, retry]);
  const permissions = capabilities?.supportsPermissionSelection ? capabilities.permissions : [];
  const options: NativeBackendOption[] = [{ id: '', label: t`沿用 CLI 默认` }, ...permissions];
  return <SettingsRow title={t`默认审批模式`} description={error || t`已有会话保持原配置。`}>
    {loading ? <Spinner /> : error ? <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setRetry((current) => current + 1)}><Trans>重试</Trans></Button>
      : permissions.length ? <ApprovalPicker value={value} options={options} side="bottom" disabled={disabled} onChange={onChange} />
        : <span className="text-xs text-fg-3"><Trans>暂不支持选择</Trans></span>}
  </SettingsRow>;
}
