/** The plugin index as the server reads it (docs/PLUGINS.md「插件市场」): browsing it here, installing through the page's grant dialog. */
import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { PluginMarketEntry, PluginMarketList, PluginSource } from '@contracts';
import { IconExternalLink } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Spinner } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { localizedText } from '@/lib/plugins';
import { Markdown } from '../session/Markdown';
import { ExecutableNote, ModelSourceNote, capabilityLabel } from './PluginGrantDialog';
import { Mark } from './PluginMark';

/** The index's own name, else its address's host; the public index is Riffet. */
export function sourceName(source: PluginSource): string {
  if (source.name) return source.name;
  if (source.builtin) return 'Riffet';
  try { return new URL(source.url).host; } catch { return source.url; }
}

function ReadFailure({ title, detail, onRetry }: { title: string; detail?: string; onRetry(): void }) {
  return <div role="alert" className="flex items-center gap-3 rounded-lg border border-line p-3"><span className="min-w-0 flex-1"><span className="block break-words text-sm">{title}</span>{detail && <span className="mt-1 block break-words text-xs text-fg-3">{detail}</span>}</span><Button size="xs" variant="secondary" onClick={onRetry}><Trans>重试</Trans></Button></div>;
}

export function PluginMarket({ market, error, query, busy, onInstall, onRetry, sourceFilter }: {
  market?: PluginMarketList;
  error: string;
  query: string;
  busy: boolean;
  /** A source id, or `all`. */
  sourceFilter: string;
  onInstall(entry: PluginMarketEntry): void;
  onRetry(): void;
}) {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState<PluginMarketEntry>();
  useEffect(() => { if (busy) setOpen(undefined); }, [busy]);
  const label = (entry: PluginMarketEntry) => localizedText(entry.title, [i18n.locale]) ?? entry.id;
  const about = (entry: PluginMarketEntry) => localizedText(entry.description, [i18n.locale]);
  const needle = query.toLocaleLowerCase();
  const enabled = (market?.sources ?? []).filter(source => source.enabled);
  const several = enabled.length > 1;
  const names = new Map((market?.sources ?? []).map(source => [source.id, sourceName(source)]));
  const chosen = several && enabled.some(source => source.id === sourceFilter) ? sourceFilter : 'all';
  const visible = (market?.plugins ?? []).filter(entry => (chosen === 'all' || entry.sourceId === chosen) && (!needle || [label(entry), entry.id, entry.vendor, about(entry) ?? ''].join(' ').toLocaleLowerCase().includes(needle)));
  const failed = enabled.filter(source => source.error);
  const action = (entry: PluginMarketEntry, primary = false) => entry.installed?.sameSource && entry.update
    ? <Button size={primary ? undefined : 'sm'} variant={primary ? 'primary' : 'secondary'} disabled={busy} onClick={() => onInstall(entry)}><Trans>更新</Trans></Button>
    : entry.installed ? <span className="text-xs text-fg-3"><Trans>已安装</Trans></span>
    : !entry.compatible ? <span className="text-xs text-fg-3"><Trans>不兼容</Trans></span>
    : <Button size={primary ? undefined : 'sm'} variant={primary ? 'primary' : 'secondary'} disabled={busy} onClick={() => onInstall(entry)}><Trans>安装</Trans></Button>;

  if (error) return <ReadFailure title={t({ message: '无法读取插件目录' })} detail={error} onRetry={onRetry} />;
  if (!market) return <div className="flex justify-center p-6"><Spinner /></div>;
  return <>
    {failed.map(source => <ReadFailure key={source.id} title={sourceName(source)} detail={source.error} onRetry={onRetry} />)}
    {visible.length === 0
      ? <EmptyState title={query ? t({ message: '没有匹配的插件' }) : t({ message: '没有插件' })} />
      : <div className="divide-y divide-line">{visible.map(entry =>
        <div key={entry.sourceId + '/' + entry.id} className="flex min-h-18 items-center gap-3 py-3">
          <button type="button" className="group flex min-w-0 flex-1 items-center gap-3 text-left" aria-haspopup="dialog" onClick={() => setOpen(entry)}>
            <Mark has={key => entry.contributes.includes(key)} />
            <span className="min-w-0 flex-1">
              <span className="break-words text-sm font-medium group-hover:text-accent">{label(entry)}</span>
              {about(entry) && <span className="mt-1 line-clamp-2 break-words text-xs text-fg-3">{about(entry)}</span>}
              <span className="mt-1 block break-words text-xs text-fg-4">{[entry.vendor, 'v' + entry.version, several ? names.get(entry.sourceId) : undefined].filter(Boolean).join(' · ')}</span>
            </span>
          </button>
          {action(entry)}
        </div>)}</div>}
    <Dialog open={Boolean(open)} onOpenChange={value => { if (!value) setOpen(undefined); }}>
      <DialogContent mobileFullscreen size="content" className="max-h-[min(42rem,calc(var(--app-height,100dvh)-32px))]" aria-describedby={undefined}>
        {open && <>
          <DialogHeader><div className="flex min-w-0 items-center gap-3"><Mark has={key => open.contributes.includes(key)} /><div className="min-w-0"><DialogTitle>{label(open)}</DialogTitle><p className="mt-1 text-xs text-fg-3">{[open.vendor, 'v' + open.version, open.date, open.license, several ? names.get(open.sourceId) : undefined].filter(Boolean).join(' · ')}</p></div></div></DialogHeader>
          <DialogBody className="flex flex-col gap-5 py-5">
            {about(open) && <p className="whitespace-pre-wrap break-words text-sm text-fg-2">{about(open)}</p>}
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-fg-3"><Trans>权限</Trans></h3>
              {open.capabilities.length || open.trustedRequired
                ? <div className="flex flex-wrap gap-2">{open.capabilities.map(capability => <Badge key={capability} className="h-auto min-h-5 whitespace-normal py-1">{capabilityLabel(capability)}</Badge>)}{open.trustedRequired && <Badge className="h-auto min-h-5 whitespace-normal py-1"><Trans>以服务器进程的权限运行</Trans></Badge>}</div>
                : <p className="text-sm text-fg-2"><Trans>无</Trans></p>}
              {open.capabilities.includes('models.provide') && <ModelSourceNote sources={open.modelSources} />}
              {open.capabilities.includes('process.exec') && <ExecutableNote names={open.executables} />}
            </section>
            {open.readme && <Markdown className="min-w-0 border-t border-line pt-5 text-sm" text={open.readme} />}
          </DialogBody>
          <DialogFooter>
            <div className="mr-auto flex flex-wrap gap-1">
              {open.page && <Button size="sm" variant="quiet" asChild><a href={open.page} target="_blank" rel="noopener noreferrer"><IconExternalLink /><Trans>在网页中查看</Trans></a></Button>}
              {open.source && <Button size="sm" variant="quiet" asChild><a href={open.source} target="_blank" rel="noopener noreferrer"><IconExternalLink /><Trans>源码</Trans></a></Button>}
            </div>
            {action(open, true)}
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  </>;
}
