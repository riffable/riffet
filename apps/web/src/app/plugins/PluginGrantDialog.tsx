/** What a package asks for before it is installed: the grant is per version and is what the user confirms here. */
import { useEffect, useId, useRef, useState } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { PluginCapability, PluginGrantRequired } from '@contracts';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const capabilityLabels: Record<PluginCapability, MessageDescriptor> = {
  'models.provide': msg`提供模型源`,
  'tasks.run': msg`运行项目命令（每条新命令先确认）`,
  'projects.read': msg`读取项目文件`,
  'sessions.read': msg`读取会话内容`,
  network: msg`访问网络`,
};

/** An id this build does not know is shown as it is: the server may be newer than the page. */
export const capabilityLabel = (id: string) => id in capabilityLabels ? i18n._(capabilityLabels[id as PluginCapability]) : id;

export function PluginGrantDialog({ request, busy, onConfirm, onCancel }: {
  request?: PluginGrantRequired;
  busy: boolean;
  onConfirm: (trusted: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [trusted, setTrusted] = useState(false);
  const trustDescriptionId = useId();
  useEffect(() => setTrusted(false), [request]);
  // The content stays through the closing animation after `request` is cleared.
  const last = useRef(request);
  if (request) last.current = request;
  const shown = request ?? last.current;
  const id = shown?.id ?? '';
  const trustUnavailable = shown?.trustedRequired && shown.trustedAllowed !== true;
  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t`安装 ${id}`}</DialogTitle>
          <DialogDescription className="font-mono">{shown?.version}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {Boolean(shown?.capabilities.length) && <ul className="flex flex-col gap-1.5 text-sm text-fg">
            {shown?.capabilities.map((capability) => <li key={capability}>{capabilityLabel(capability)}</li>)}
          </ul>}
          {shown?.trustedAllowed && <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" className="size-4 shrink-0 accent-accent" checked={trusted} disabled={busy} required={shown.trustedRequired === true} aria-describedby={trustDescriptionId} onChange={event => setTrusted(event.target.checked)} />
              <Trans>信任此插件</Trans>
            </label>
            <p id={trustDescriptionId} className="text-xs text-fg-3"><Trans>允许插件使用 Riffet 的文件、网络和进程权限</Trans></p>
          </div>}
          {trustUnavailable && <p className="text-sm text-fg"><Trans>请在服务器所在设备上安装此插件</Trans></p>}
          <p className="text-xs text-fg-3"><Trans>安装到当前连接的服务器</Trans></p>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}><Trans>取消</Trans></Button>
          <Button size="sm" variant="primary" disabled={busy || Boolean(trustUnavailable) || Boolean(shown?.trustedRequired && !trusted)} onClick={() => onConfirm(trusted)}>{busy && <Spinner />}<Trans>安装</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
