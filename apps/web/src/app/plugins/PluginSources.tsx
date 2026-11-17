/** Adding a plugin index, and the head of one source's listing: its address, count and menu (turn off, copy, remove). */
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { PluginMarketList, PluginSource } from '@contracts';
import { IconCopy, IconEllipsis, IconPlus, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { copyWithToast } from '@/lib/files';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { sourceName } from './PluginMarket';

/** The server reads the address once before saving it; one it cannot read is refused, and the reason stays under the field. */
export function AddPluginSourceDialog({ open, knownIds, onOpenChange, onAdded }: { open: boolean; /** The sources before this one, to find which is new. */ knownIds: string[]; onOpenChange(open: boolean): void; onAdded(market: PluginMarketList, source?: PluginSource): void }) {
  const { t } = useLingui();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const close = (next: boolean) => { if (busy) return; if (!next) { setUrl(''); setError(''); } onOpenChange(next); };
  const submit = async () => {
    const value = url.trim();
    if (!value || busy) return;
    setBusy(true); setError('');
    try {
      const market = await api.addPluginSource(value);
      onAdded(market, market.sources.find(source => !knownIds.includes(source.id)) ?? market.sources.find(source => source.url === value));
      setUrl(''); onOpenChange(false);
    } catch (e) { setError(errorMessage(e, t({ message: '操作失败' }))); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent mobileSheet aria-describedby={undefined}>
        <form className="flex min-h-0 flex-col" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <DialogHeader><DialogTitle><Trans>添加插件源</Trans></DialogTitle></DialogHeader>
          <DialogBody className="flex flex-col gap-4 pt-1">
            <Field label={t({ message: '索引地址' })} error={error}>
              <Input className="font-mono max-md:h-11" type="url" inputMode="url" autoFocus value={url} disabled={busy} placeholder="https://…/index.json" onChange={event => { setUrl(event.target.value); setError(''); }} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => close(false)}><Trans context="workbench-cancel-action">取消</Trans></Button>
            <Button type="submit" variant="primary" disabled={!url.trim()} busy={busy}><IconPlus /><Trans>添加</Trans></Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One source's menu: turning it on or off, copying its address, removing it (not the built-in one, nor one the service fixes). */
export function PluginSourceMenu({ source, disabled, onChange, onRemoved }: { source: PluginSource; disabled: boolean; onChange(market: PluginMarketList): void; onRemoved(): void }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<PluginMarketList>, done?: () => void) => {
    if (busy) return;
    setBusy(true);
    try { onChange(await action()); done?.(); }
    catch (e) { toast.error(errorMessage(e, t({ message: '操作失败' }))); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!await confirmDialog({ title: t`移除“${sourceName(source)}”？`, description: t({ message: '已安装的插件保留，不再收到更新。' }), confirmLabel: t({ message: '移除' }), destructive: true })) return;
    await run(() => api.removePluginSource(source.id), onRemoved);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" disabled={disabled || busy} aria-label={sourceName(source) + ' · ' + t({ message: '更多操作' })}><IconEllipsis /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void run(() => api.setPluginSourceEnabled(source.id, !source.enabled))}>{source.enabled ? <Trans>停用插件源</Trans> : <Trans>启用插件源</Trans>}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyWithToast(source.url)}><IconCopy /><Trans>复制地址</Trans></DropdownMenuItem>
        {!source.builtin && !source.fixed && <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="danger" onSelect={() => void remove()}><IconTrash2 /><Trans>移除</Trans></DropdownMenuItem>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Turning a source on from its own (empty) listing. */
export function EnablePluginSource({ source, disabled, onChange }: { source: PluginSource; disabled: boolean; onChange(market: PluginMarketList): void }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    try { onChange(await api.setPluginSourceEnabled(source.id, true)); }
    catch (e) { toast.error(errorMessage(e, t({ message: '操作失败' }))); }
    finally { setBusy(false); }
  };
  return <Button size="sm" variant="secondary" disabled={disabled} busy={busy} onClick={() => void enable()}><Trans>启用插件源</Trans></Button>;
}
