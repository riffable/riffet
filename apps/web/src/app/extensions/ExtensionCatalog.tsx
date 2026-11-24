import { memo, useLayoutEffect, useRef, useState } from 'react';
import type { SVGProps } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ExtensionRuntimeReport } from '@contracts';
import { IconChevronRight, IconFolder, IconLock, IconPackage, IconPuzzle, IconSearch, IconTrash2, IconX } from '@/components/icons';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge, EmptyState, Spinner } from '@/components/ui/controls';
import { useBackendLabel } from '@/lib/backends';
import { extensionScopes } from '@/lib/extensions';
import { cn } from '@/lib/utils';
import { extensionActions, extensionContextKey, extensionStatus, isRiffetSource, riffetActivationBadge, type ExtensionEntry } from './model';

// Keep this height in sync with .extensions-row in extensions.css.
const rowHeight = 76;

function RiffetSourceMark(props: SVGProps<SVGSVGElement>) {
  return <BrandMark forceDefault {...props} />;
}

const CatalogRow = memo(function CatalogRow({ entry, active, checked, batchMode, disabled, runtime, onOpen, onSelect, rowIndex, rowCount }: {
  entry: ExtensionEntry; active: boolean; checked: boolean; batchMode: boolean; disabled: boolean;
  runtime?: ExtensionRuntimeReport; rowIndex: number; rowCount: number; onOpen(key: string, trigger?: HTMLElement): void; onSelect(key: string): void;
}) {
  const { item } = entry;
  const { t } = useLingui();
  const label = useBackendLabel();
  const status = extensionStatus(entry, runtime);
  const description = item.description || (item.ownerPluginId ? entry.sourceLabel : '');
  const showStatus = status.tone === 'warning' || item.enabled === false;
  const activation = isRiffetSource(entry.context) ? riffetActivationBadge(item.activation) : undefined;
  const skillSource = item.kind !== 'skill'
    ? (item.scope === 'riffet' && !isRiffetSource(entry.context) ? extensionScopes.riffet : undefined)
    : item.ownerPluginId ? t`插件提供`
      : item.scope === 'riffet' ? (isRiffetSource(entry.context) ? undefined : extensionScopes.riffet) : item.scope === 'builtin' ? t`内置` : item.scope === 'project' ? t({ message: '项目级', context: 'extensions-scope-project' }) : undefined;
  // File ownership and native management are independent: a read-only Skill can still be toggled.
  const skillReadOnly = item.kind === 'skill' && Boolean(item.readOnlyReason) && !isRiffetSource(entry.context);
  const skillDeletable = item.kind === 'skill' && extensionActions(entry).includes('uninstall');
  const SourceIcon = item.ownerPluginId ? IconPuzzle : item.scope === 'riffet' ? RiffetSourceMark : item.scope === 'builtin' ? IconPackage : IconFolder;
  const sourceName = isRiffetSource(entry.context) ? 'Riffet' : label(entry.context.backendId);
  return <div role="listitem" aria-posinset={rowIndex} aria-setsize={rowCount} className={cn('extensions-row', active && 'is-active', checked && 'is-checked')}>
    {batchMode && <label className="flex h-full w-8 shrink-0 cursor-pointer items-center justify-center"><Checkbox checked={checked} disabled={disabled} aria-label={t`选择 ${item.name} · ${sourceName}`} onCheckedChange={() => onSelect(entry.key)} /></label>}
    <button type="button" disabled={disabled} className="extensions-open" onClick={event => onOpen(entry.key, event.currentTarget)} aria-expanded={active} aria-label={t`查看 ${item.name}`}>
      <span className="extensions-row-content">
        <span className="extensions-row-heading">
          <span className="truncate text-sm font-medium text-fg" title={item.name}>{item.name}</span>
          {(activation || skillSource || skillReadOnly || skillDeletable) && <span className="extensions-skill-badges">
            {activation && <Badge tone={activation.tone} className="rounded-full font-normal">{activation.label}</Badge>}
            {skillSource && <span title={entry.sourceLabel}><Badge className="rounded-full font-normal"><SourceIcon />{skillSource}</Badge></span>}
            {skillReadOnly && <span title={item.readOnlyReason}><Badge tone="warning" className="rounded-full font-normal"><IconLock /><Trans>文件只读</Trans></Badge></span>}
            {skillDeletable && <span title={item.managementNote}><Badge tone="accent" className="rounded-full font-normal"><IconTrash2 /><Trans>可删除</Trans></Badge></span>}
          </span>}
          {item.kind !== 'skill' && (item.scope === 'project' || item.scope === 'builtin') && <span className="extensions-row-scope">{extensionScopes[item.scope]}</span>}
          {showStatus && <span className={`extensions-status ${status.tone}`}><i />{status.label}</span>}
        </span>
        {description && <span className="extensions-description text-xs text-fg-3" title={description}>{description}</span>}
      </span>
      <IconChevronRight className="extensions-row-chevron size-3 shrink-0" />
    </button>
  </div>;
});

interface Props {
  entries: ExtensionEntry[];
  selectedKey?: string;
  checked: Set<string>;
  batchMode: boolean;
  hasFilters: boolean;
  runtime: Record<string, ExtensionRuntimeReport>;
  loading: boolean;
  disabled: boolean;
  resetKey: string;
  onOpen(key: string, trigger?: HTMLElement): void;
  onSelect(key: string): void;
  onSelectAll(checked: boolean): void;
  onReset(): void;
  enableCount: number;
  disableCount: number;
  batchLoading: boolean;
  onBatch(enable: boolean): void;
  onClearSelection(): void;
}

export function ExtensionCatalog({ entries, selectedKey, checked, batchMode, hasFilters, runtime, loading, disabled, resetKey, onOpen, onSelect, onSelectAll, onReset, enableCount, disableCount, batchLoading, onBatch, onClearSelection }: Props) {
  const { t } = useLingui();
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const selectedCount = entries.reduce((count, entry) => count + Number(checked.has(entry.key)), 0);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setViewport(previous => ({ ...previous, top: 0 }));
  }, [resetKey]);
  // Keep the last surviving rows visible when a refreshed inventory becomes shorter.
  const start = Math.max(0, Math.min(Math.max(0, entries.length - 1), Math.floor(viewport.top / rowHeight) - 6));
  const end = Math.min(entries.length, start + Math.ceil(viewport.height / rowHeight) + 12);
  return <div className="extensions-table-wrap">
    <div className="extensions-table" aria-busy={loading}>
      {batchMode && <label className="extensions-table-head"><span className="flex h-full w-8 shrink-0 items-center justify-center"><Checkbox disabled={disabled || !entries.length} aria-label={t`选择本页全部扩展`} checked={entries.length > 0 && selectedCount === entries.length ? true : selectedCount > 0 ? 'indeterminate' : false} onCheckedChange={checked => onSelectAll(checked === true)} /></span><span><Trans>全选本页</Trans></span></label>}
      <div ref={scroller} className={cn('extensions-list-scroll', selectedCount > 0 && 'has-bulk-selection')} onScroll={event => { const top = event.currentTarget.scrollTop; setViewport(previous => ({ ...previous, top })); }}>
        {entries.length > 0 ? <div role="list" aria-label={t`扩展目录`} style={{ height: entries.length * rowHeight, position: 'relative' }}><div role="presentation" style={{ position: 'absolute', inset: '0 0 auto', transform: `translateY(${start * rowHeight}px)` }}>{entries.slice(start, end).map((entry, index) => <CatalogRow key={entry.key} entry={entry} rowIndex={start + index + 1} rowCount={entries.length} active={selectedKey === entry.key} checked={checked.has(entry.key)} batchMode={batchMode} runtime={runtime[extensionContextKey(entry.context)]} disabled={disabled} onOpen={onOpen} onSelect={onSelect} />)}</div></div>
          : loading ? <div className="flex items-center justify-center gap-2 py-14 text-sm text-fg-3"><Spinner /><Trans>正在读取扩展</Trans></div>
            : <EmptyState icon={<IconSearch />} title={t`没有匹配的扩展`}>{hasFilters && <Button variant="secondary" onClick={onReset}><Trans context="extensions-clear-filters">清除筛选</Trans></Button>}</EmptyState>}
      </div>
    </div>
    {selectedCount > 0 && <div className="extensions-bulk-bar"><Button variant="quiet" size="icon-xs" disabled={disabled} aria-label={t`取消选择`} onClick={onClearSelection}><IconX /></Button><span className="text-xs font-medium"><Trans>已选 {selectedCount} 项</Trans></span><span className="mx-1 h-4 w-px bg-line" />{batchLoading && <Spinner />}<Button size="sm" variant="ghost" disabled={disabled || batchLoading || !enableCount} onClick={() => onBatch(true)}><Trans>启用 {enableCount || ''}</Trans></Button><Button size="sm" variant="ghost" disabled={disabled || batchLoading || !disableCount} onClick={() => onBatch(false)}><Trans>停用 {disableCount || ''}</Trans></Button></div>}
  </div>;
}
