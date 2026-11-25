import { useEffect } from 'react';
import { useLingui } from '@lingui/react/macro';
import { toast } from '@/lib/toast';
import { useStores } from './state/stores';
import type { SettingsSection } from './settings/settingsSections';

/** A device paired or a server linked while the workbench is open shows at once, so one the owner did not add is noticed. */
export function useSecurityAlerts(openSettingsAt: (section: SettingsSection) => void) {
  const { t } = useLingui();
  const { lists } = useStores();
  useEffect(() => lists.onSecurity((event) => {
    const name = event.subject ?? '';
    if (event.kind === 'device-paired') toast.info(t`新设备已配对：${name}`, { action: { label: t`查看`, onClick: () => openSettingsAt('devices') } });
    else if (event.kind === 'link-added') toast.info(t`新的互联服务器：${name}`, { action: { label: t`查看`, onClick: () => openSettingsAt('links') } });
  }), [lists, openSettingsAt, t]);
}
