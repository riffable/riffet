import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { PluginPage, PluginPageButton, PluginPageChange, PluginPageItem } from '@contracts';
import { IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input, Spinner, Switch } from '@/components/ui/controls';
import { Progress } from '@/components/ui/progress';
import { RadioGroup } from '@/components/ui/radio-group';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { errorMessage, cn } from '@/lib/utils';
import { SettingsGroup, SettingsRow } from '../settings/SettingsLayout';

/**
 * A plugin's own page (docs/PLUGIN_ARCHITECTURE.md「插件页」): what the plugin builds, drawn with the settings' controls.
 * Each change is saved at once and answered with the page read again; one change at a time.
 */
export function PluginPageView({ pluginId, disabled, onChanged }: { pluginId: string; disabled?: boolean; onChanged?: () => void }) {
  const { t, i18n } = useLingui();
  const locale = i18n.locale;
  const [page, setPage] = useState<PluginPage>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    setPage(undefined); setError(''); setMessage('');
    api.pluginPage(pluginId, locale, controller.signal)
      .then(answer => setPage(answer.page))
      .catch(e => { if (!controller.signal.aborted) setError(errorMessage(e, t({ message: '无法读取' }))); });
    return () => controller.abort();
  }, [pluginId, locale]);

  // State that changes on its own (a download): read again while the page asks for it.
  useEffect(() => {
    if (!page?.refreshMs) return;
    const timer = window.setTimeout(() => {
      if (busyRef.current) return;
      void api.pluginPage(pluginId, locale).then(answer => { if (alive.current && !busyRef.current) setPage(answer.page); }).catch(() => undefined);
    }, page.refreshMs);
    return () => window.clearTimeout(timer);
  }, [page, pluginId, locale]);

  const change = async (body: Omit<PluginPageChange, 'locale'>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const answer = await api.changePluginPage(pluginId, { ...body, locale });
      if (!alive.current) return;
      setPage(answer.page); setMessage(answer.message ?? '');
      onChanged?.();
    } catch (e) { if (alive.current) setError(errorMessage(e, t({ message: '操作失败' }))); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const set = (key: string, value: string | boolean | string[] | null) => change({ set: { key, value } });
  const press = async (button: PluginPageButton) => {
    if (button.confirm && !await confirmDialog({ title: button.confirm, description: button.confirmDetail, confirmLabel: button.label, destructive: button.destructive })) return;
    await change({ run: { action: button.action, ...(button.item !== undefined ? { item: button.item } : {}) } });
  };
  const locked = disabled || busy;

  if (!page) return error ? <p role="alert" className="text-sm text-danger">{error}</p> : <div className="flex justify-center p-6"><Spinner /></div>;
  return <div className="flex min-w-0 flex-col gap-6">
    {(error || message) && <p role={error ? 'alert' : 'status'} className={cn('text-sm', error ? 'text-danger' : 'text-fg-3')}>{error || message}</p>}
    {page.sections.map(section => <SettingsGroup key={section.id} title={section.title} note={section.footer}>
      {section.items.map((item, index) => <PageItem key={itemKey(item, index)} item={item} heading={section.title} locked={locked} set={set} press={press} />)}
    </SettingsGroup>)}
  </div>;
}

const itemKey = (item: PluginPageItem, index: number) => item.kind === 'row' || item.kind === 'meter' ? item.kind + ':' + item.id : item.kind === 'buttons' ? 'buttons:' + index : item.kind + ':' + item.key;

function PageButton({ button, locked, press }: { button: PluginPageButton; locked: boolean; press: (button: PluginPageButton) => void }) {
  return <Button type="button" size="xs" variant="secondary" disabled={locked || button.disabled} onClick={() => press(button)}>{button.label}</Button>;
}

/** `heading` is the section's title: a choice named the same does not say it again. */
function PageItem({ item, heading, locked, set, press }: { item: PluginPageItem; heading?: string; locked: boolean; set: (key: string, value: string | boolean | string[] | null) => void; press: (button: PluginPageButton) => void }) {
  switch (item.kind) {
    case 'choice': return <div className="flex flex-col py-2">
      {item.label !== heading && <span className="py-1.5 text-sm font-medium text-fg">{item.label}</span>}
      <RadioGroup<string>
        ariaLabel={item.label}
        value={item.value}
        // Not disabled while a change is saving: arrows select in a radio group, and disabling the
        // group would drop focus after the first step. Changes are ignored until it settles.
        busy={locked}
        onValueChange={value => { if (!locked && value !== item.value) set(item.key, value); }}
        options={item.options.map(option => ({
          value: option.value,
          label: option.label,
          disabled: option.disabled,
          trailing: (option.detail || option.button) && <>
            {option.detail && <span className="shrink-0 text-xs text-fg-3">{option.detail}</span>}
            {option.button && <PageButton button={option.button} locked={locked} press={press} />}
          </>,
        }))}
      />
    </div>;
    case 'toggle': return <SettingsRow title={item.label} description={item.detail}><Switch checked={item.on} disabled={locked} aria-label={item.label} onCheckedChange={on => set(item.key, on)} /></SettingsRow>;
    case 'text': return <TextItem item={item} locked={locked} set={set} />;
    case 'list': return <ListItem item={item} locked={locked} set={set} />;
    case 'row': return <SettingsRow title={item.label} description={item.detail}>
      <div className="flex items-center gap-3">
        {item.value && <span className="text-sm tabular-nums text-fg-2">{item.value}</span>}
        {item.buttons?.map((button, index) => <PageButton key={index} button={button} locked={locked} press={press} />)}
      </div>
    </SettingsRow>;
    case 'meter': return <MeterItem item={item} locked={locked} press={press} />;
    case 'buttons': return <div className="flex flex-wrap gap-2 py-3">{item.buttons.map((button, index) => <PageButton key={index} button={button} locked={locked} press={press} />)}</div>;
    default: return null;
  }
}

/** A row with a bar under it (docs/design/system/plugins.md §6.4): a download under way, or how much of a quota is left. */
function MeterItem({ item, locked, press }: { item: Extract<PluginPageItem, { kind: 'meter' }>; locked: boolean; press: (button: PluginPageButton) => void }) {
  const { t } = useLingui();
  const left = Math.round(100 - item.percent);
  const figure = item.value ?? (item.sense === 'progress' ? `${Math.round(item.percent)}%` : t`剩余 ${left}%`);
  const tone = item.sense === 'quota' ? (left <= 0 ? 'danger' : left < 20 ? 'warning' : 'accent') : 'accent';
  return <div className="flex flex-col gap-2 py-3.5">
    <div className="flex items-center justify-between gap-6 max-md:flex-col max-md:items-stretch max-md:gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-fg">{item.label}</span>
        {item.detail && <span className="text-xs text-fg-3">{item.detail}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-sm tabular-nums text-fg-2">{figure}</span>
        {item.buttons?.map((button, index) => <PageButton key={index} button={button} locked={locked} press={press} />)}
      </div>
    </div>
    <Progress value={(item.sense === 'quota' ? left : item.percent) / 100} tone={tone} role={item.sense === 'progress' ? 'progressbar' : 'meter'} label={item.label} />
  </div>;
}

/** Saved on Enter or when focus leaves, if it changed. */
function TextItem({ item, locked, set }: { item: Extract<PluginPageItem, { kind: 'text' }>; locked: boolean; set: (key: string, value: string | null) => void }) {
  const { t } = useLingui();
  const saved = item.value ?? '';
  const [draft, setDraft] = useState(item.secret ? '' : saved);
  useEffect(() => { if (!item.secret) setDraft(saved); }, [saved, item.secret]);
  const commit = () => {
    const value = draft.trim();
    if (item.secret ? !value : value === saved.trim()) return;
    set(item.key, value || null);
    if (item.secret) setDraft('');
  };
  return <SettingsRow title={item.label}>
    <div className="flex w-80 max-w-full items-center gap-2 max-md:w-full">
      <Input type={item.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} disabled={locked} value={draft} aria-label={item.label}
        placeholder={item.secret && item.set ? t({ message: '已设置' }) : item.placeholder}
        onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
      {item.secret && item.set && <Button type="button" size="xs" variant="secondary" disabled={locked} onClick={() => set(item.key, null)}><Trans>清除</Trans></Button>}
    </div>
  </SettingsRow>;
}

/** The list is sent whole after each addition or removal. */
function ListItem({ item, locked, set }: { item: Extract<PluginPageItem, { kind: 'list' }>; locked: boolean; set: (key: string, value: string[]) => void }) {
  const { t } = useLingui();
  const [draft, setDraft] = useState('');
  const add = () => {
    const values = draft.split(/[\s,]+/).map(value => value.trim()).filter(value => value && !item.values.includes(value));
    if (!values.length) { setDraft(''); return; }
    set(item.key, [...item.values, ...values]); setDraft('');
  };
  return <div className="flex flex-col gap-2 py-3.5">
    <span className="text-sm font-medium text-fg">{item.label}</span>
    {item.values.length > 0 && <ul className="flex flex-wrap gap-1.5">
      {item.values.map(value => <li key={value} className="flex h-7 items-center gap-1 rounded-md bg-hover pl-2.5 pr-1 text-sm text-fg">
        <span className="max-w-60 truncate">{value}</span>
        <Button type="button" size="icon-xs" variant="quiet" disabled={locked} aria-label={t({ message: `移除 ${value}` })} onClick={() => set(item.key, item.values.filter(other => other !== value))}><IconX /></Button>
      </li>)}
    </ul>}
    <Input className="w-80 max-w-full max-md:w-full" autoComplete="off" spellCheck={false} disabled={locked} value={draft} placeholder={item.placeholder} aria-label={item.label}
      onChange={e => setDraft(e.target.value)} onBlur={add} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
  </div>;
}
