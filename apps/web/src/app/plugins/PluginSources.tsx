/** The plugin indexes this server reads: turn one off, remove it, or add another by address. */
import { useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { PluginMarketList, PluginSource } from '@contracts';
import { IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input, Switch } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { errorMessage } from '@/lib/utils';
import { sourceName } from './PluginMarket';

export function PluginSources({ sources, onChange, onClose }: { sources: PluginSource[]; onChange(market: PluginMarketList): void; onClose(): void }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  const run = async (action: () => Promise<PluginMarketList>, done?: () => void) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { onChange(await action()); done?.(); }
    catch (e) { setError(errorMessage(e, t({ message: '操作失败' }))); }
    finally { pending.current = false; setBusy(false); }
  };
  const remove = async (source: PluginSource) => {
    if (!await confirmDialog({ title: t`移除“${sourceName(source)}”？`, description: t({ message: '已安装的插件保留，不再收到更新。' }), confirmLabel: t({ message: '移除' }), destructive: true })) return;
    await run(() => api.removePluginSource(source.id));
  };
  const add = () => { const value = url.trim(); if (value) void run(() => api.addPluginSource(value), () => setUrl('')); };
  return <Dialog open onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <DialogContent mobileFullscreen size="content" className="max-h-[min(36rem,calc(var(--app-height,100dvh)-32px))]" aria-describedby={undefined}>
      <DialogHeader><DialogTitle><Trans>插件源</Trans></DialogTitle></DialogHeader>
      <DialogBody className="flex flex-col gap-4 py-4">
        <ul className="divide-y divide-line">{sources.map(source => <li key={source.id} className="flex min-h-14 items-center gap-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{sourceName(source)}</span>
            <span className="block truncate text-xs text-fg-3">{source.url}</span>
            {source.enabled && (source.error ? <span className="mt-0.5 block break-words text-xs text-danger">{source.error}</span> : source.plugins !== undefined && <span className="mt-0.5 block text-xs text-fg-4"><Trans>{source.plugins} 个插件</Trans></span>)}
          </span>
          <Switch checked={source.enabled} disabled={busy} aria-label={sourceName(source)} onCheckedChange={enabled => void run(() => api.setPluginSourceEnabled(source.id, enabled))} />
          {!source.builtin && !source.fixed && <Button size="icon-sm" variant="quiet" disabled={busy} aria-label={t`移除“${sourceName(source)}”`} onClick={() => void remove(source)}><IconTrash2 /></Button>}
        </li>)}</ul>
        <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); add(); }}>
          <div className="flex items-center gap-2">
            <Input className="min-w-0 flex-1" type="url" inputMode="url" value={url} disabled={busy} aria-label={t({ message: '索引地址' })} aria-invalid={Boolean(error)} placeholder="https://" onChange={event => { setUrl(event.target.value); setError(''); }} />
            <Button type="submit" variant="secondary" busy={busy} disabled={!url.trim()}><Trans>添加</Trans></Button>
          </div>
          {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
        </form>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
