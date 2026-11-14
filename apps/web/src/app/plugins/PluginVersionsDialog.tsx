/** The versions of one installed package: which one runs, the others kept beside it, and its data. */
import { useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import type { PluginDescriptor } from '@contracts';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { localizedText, replacePlugin, replacePlugins } from '@/lib/plugins';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';

/** `upload:name.tgz` and `path:/abs/dir` read as the file name or the path. */
const sourceLabel = (source: string) => source.replace(/^(?:upload|path):/, '');

export function PluginVersionsDialog({ plugin, onClose, onChanged }: {
  plugin?: PluginDescriptor;
  onClose: () => void;
  /** After the server accepted a change: the catalogs and the appearance follow what the plugin provides. */
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  // The content stays through the closing animation after the package is gone from the list.
  const last = useRef(plugin);
  if (plugin) last.current = plugin;
  const shown = plugin ?? last.current;
  const installed = shown?.installed;
  const title = shown ? localizedText(shown.title, [i18n.locale]) ?? shown.name : '';

  const run = async (action: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    try { await action(); onChanged(); }
    catch (reason) { toast.error(errorMessage(reason, fallback)); }
    finally { setBusy(false); }
  };

  const select = (version: string) => run(async () => replacePlugin(await api.selectPluginVersion(shown!.id, version)), t`无法切换版本`);
  const uninstall = (version: string) => run(async () => replacePlugins((await api.uninstallPluginVersion(shown!.id, version)).integrations), t`无法卸载`);
  const deleteData = async () => {
    if (busy || !await confirmDialog({
      title: t`删除「${title}」的数据？`,
      description: t`删除后无法恢复`,
      confirmLabel: t({ message: '删除', context: 'settings-delete-action' }),
      destructive: true,
    })) return;
    await run(async () => replacePlugins((await api.deletePluginData(shown!.id)).integrations), t`无法删除数据`);
  };

  return (
    <Dialog open={Boolean(plugin)} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <DialogBody className="flex flex-col pb-5">
          <ul className="flex flex-col [&>*+*]:edge-t">
            {installed?.versions.map((entry) => {
              const source = sourceLabel(entry.source);
              return (
                <li key={entry.version} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-fg">
                      {entry.version}
                      {entry.selected && !shown?.rejected && <StatusDot tone="success" label={t`使用中`} />}
                    </span>
                    <span className="truncate text-xs text-fg-3" title={source}>{source}</span><code className="break-all text-2xs text-fg-4">{entry.integrity}</code>
                    {entry.trusted && <span className="text-xs text-fg-3"><Trans>以服务器进程的权限运行</Trans></span>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {(!entry.selected || shown?.rejected) && <Button size="xs" variant="secondary" disabled={busy} onClick={() => void select(entry.version)}><Trans>使用</Trans></Button>}
                    {(!entry.selected || installed.versions.length === 1) && <Button size="xs" variant="danger-ghost" disabled={busy} onClick={() => void uninstall(entry.version)}><Trans>卸载</Trans></Button>}
                  </div>
                </li>
              );
            })}
          </ul>
          {installed?.hasData && (
            <div className="edge-t flex items-center py-2.5">
              <Button size="xs" variant="danger-ghost" disabled={busy} onClick={() => void deleteData()}><Trans>删除数据</Trans></Button>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
