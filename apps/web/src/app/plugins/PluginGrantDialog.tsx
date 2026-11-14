/** What a package asks for before it is installed: the grant is per version and is what the user confirms here. */
import { useEffect, useId, useRef, useState } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { PluginCapability, PluginGrantRequired } from '@contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const capabilityLabels: Record<PluginCapability, MessageDescriptor> = {
  'models.provide': msg`提供模型源`,
  'tasks.run': msg`运行项目命令（每条新命令先确认）`,
  'projects.read': msg`读取项目文件`,
  'sessions.read': msg`读取所在项目的会话内容，可由插件界面发出`,
  network: msg`访问网络`,
  'process.exec': msg`以你的身份运行本机命令`,
};

/** An id this build does not know is shown as it is: the server may be newer than the page. */
export const capabilityLabel = (id: string) => id in capabilityLabels ? i18n._(capabilityLabels[id as PluginCapability]) : id;

/** Where an isolated package's model source sends requests and the profile's key: the hosts it declares, or any address it names. */
export function ModelSourceNote({ sources }: { sources?: PluginGrantRequired['modelSources'] }) {
  const hosts = sources?.length && sources.every(source => source.hosts?.length) ? [...new Set(sources.flatMap(source => source.hosts ?? []))] : [];
  return <p className="text-xs text-fg-3">{hosts.length ? <><Trans>模型请求与密钥发往</Trans> <span className="font-mono">{hosts.join(', ')}</span></> : <Trans>模型请求与密钥发往插件指定的地址</Trans>}</p>;
}

/** The commands `process.exec` runs outside the sandbox, as the user. */
export function ExecutableNote({ names }: { names?: string[] }) {
  return names?.length ? <p className="text-xs text-fg-3"><span className="font-mono">{names.join(', ')}</span></p> : null;
}

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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`安装 ${id}`}</DialogTitle>
          <DialogDescription className="font-mono">{shown?.version}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {Boolean(shown?.capabilities.length) && <ul className="flex flex-col gap-1.5 text-sm text-fg">
            {shown?.capabilities.map((capability) => <li key={capability} className="flex flex-col gap-0.5">{capabilityLabel(capability)}{capability === 'models.provide' && <ModelSourceNote sources={shown.modelSources} />}{capability === 'process.exec' && <ExecutableNote names={shown.executables} />}</li>)}
          </ul>}
          {shown?.trustedAllowed && <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm text-fg">
              <Checkbox checked={trusted} disabled={busy} required={shown.trustedRequired === true} aria-describedby={trustDescriptionId} onCheckedChange={checked => setTrusted(checked === true)} />
              <Trans>信任此插件</Trans>
            </label>
            <p id={trustDescriptionId} className="text-xs text-fg-3"><Trans>允许插件使用 Riffet 的文件、网络和进程权限</Trans></p>
          </div>}
          {trustUnavailable && <p className="text-sm text-fg"><Trans>请在服务器所在设备上安装此插件</Trans></p>}
          <p className="text-xs text-fg-3"><Trans>安装到当前连接的服务器</Trans></p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onCancel}><Trans>取消</Trans></Button>
          <Button variant="primary" busy={busy} disabled={Boolean(trustUnavailable) || Boolean(shown?.trustedRequired && !trusted)} onClick={() => onConfirm(trusted)}><Trans>安装</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
