import { useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconRotateCcw, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/controls';
import { ShortcutRecorder } from '@/components/ui/shortcut-recorder';
import { Tip } from '@/components/ui/tooltip';
import { isApplePlatform } from '@/lib/platform';
import { hostShortcuts, shortcutGroups, shortcutName, type HostShortcut } from '../hostShortcuts';
import {
  familyCaps, findConflict, recordedBinding, resetAllBindings, resetBinding, setBinding, shortcutCaps, suspendShortcuts, turnOff,
  keybindingCaps, useShortcutOverrides, type ChordConflict,
} from '../shortcuts';
import { SettingsGroup as Group } from './SettingsLayout';

interface Notice { id: HostShortcut['id']; binding: string; conflict: ChordConflict }

const Caps = ({ caps }: { caps: readonly string[] }) => <span className="flex shrink-0 items-center gap-1">{caps.map((cap, index) => <Kbd key={index}>{cap}</Kbd>)}</span>;

/** The keys of the workbench, each rebindable by recording; the keys that are one rule (tab 1–9, view 1–3) are listed as they are. */
export function ShortcutSettings() {
  const { t, i18n } = useLingui();
  const overrides = useShortcutOverrides();
  const [notice, setNotice] = useState<Notice>();
  const release = useRef<(() => void) | undefined>(undefined);
  const customized = Object.keys(overrides).length > 0;

  const capture = (id: HostShortcut['id']) => (event: KeyboardEvent): boolean => {
    const binding = recordedBinding(event, isApplePlatform);
    if (!binding) return false;
    const conflict = findConflict(binding, id, overrides);
    if (conflict) setNotice({ id, binding, conflict });
    else { setBinding(id, binding); setNotice(undefined); }
    return true;
  };

  const row = (shortcut: HostShortcut) => {
    const { id } = shortcut;
    const name = i18n._(shortcut.label);
    const overridden = id in overrides;
    const caps = shortcut.customizable ? shortcutCaps(id, 0, overrides) : familyCaps(id, overrides);
    const shown = notice?.id === id ? notice : undefined;
    const holder = shown?.conflict.kind === 'shortcut' ? shown.conflict : undefined;
    const holderName = holder ? i18n._(shortcutName(holder.id)) : '';
    return (
      <div key={id} className="py-2.5">
        <div className="flex items-center justify-between gap-6">
          <span className="min-w-0 text-sm text-fg">{name}</span>
          <span className="flex shrink-0 items-center gap-1">
            {shortcut.customizable ? <>
              {overridden && <Tip label={t`恢复默认`}><Button size="icon-xs" variant="quiet" aria-label={t`恢复默认`} onClick={() => { resetBinding(id); setNotice(undefined); }}><IconRotateCcw /></Button></Tip>}
              {caps.length > 0 && <Tip label={t`停用快捷键`}><Button size="icon-xs" variant="quiet" aria-label={t`停用快捷键`} onClick={() => { turnOff(id); setNotice(undefined); }}><IconX /></Button></Tip>}
              <ShortcutRecorder caps={caps} off={t`未设置`} prompt={t`按下组合键`} label={name} onCapture={capture(id)} onActiveChange={(active) => { if (active) { setNotice(undefined); release.current = suspendShortcuts(); } else release.current?.(); }} />
            </> : <Caps caps={caps} />}
          </span>
        </div>
        {shown && (
          <div role="status" className="mt-1.5 flex items-center justify-between gap-3 text-xs text-fg-3">
            <span className="flex min-w-0 items-center gap-2">
              <Caps caps={keybindingCaps(shown.binding, isApplePlatform)} />
              {holder ? <Trans>已用于「{holderName}」</Trans> : <Trans>这个组合归浏览器所有</Trans>}
            </span>
            <span className="flex shrink-0 gap-1">
              <Button size="xs" variant="ghost" onClick={() => setNotice(undefined)}><Trans>取消</Trans></Button>
              {holder?.customizable && <Button size="xs" variant="secondary" onClick={() => { setBinding(id, shown.binding, holder.id); setNotice(undefined); }}><Trans>替换</Trans></Button>}
            </span>
          </div>
        )}
      </div>
    );
  };

  return <>
    {shortcutGroups.map(({ group, title }, index) => (
      <Group
        key={group}
        title={index === 0 ? t`快捷键` : i18n._(title)}
        action={index === 0 && customized ? <Button size="xs" variant="ghost" onClick={() => { resetAllBindings(); setNotice(undefined); }}><Trans>全部恢复默认</Trans></Button> : undefined}
      >
        {hostShortcuts.filter((shortcut) => shortcut.group === group).map(row)}
      </Group>
    ))}
  </>;
}
