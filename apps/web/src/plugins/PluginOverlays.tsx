import { useEffect, useRef } from 'react';
import type { ContextMenuProps, MenuEntry, MenuProps, PopoverProps, QuickPanelProps } from '@riffet/plugin-web';
import { Spinner, UnderlineTabs } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, MenuSub } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { QuickInput, quickListClass, quickListTallClass } from '../app/SessionSearchDialog';

type RadioEntry = Extract<MenuEntry, { kind: 'radio' }>;

/** The entries, with each run of `radio` entries gathered into one group. */
function groups(entries: readonly MenuEntry[]): Array<Exclude<MenuEntry, RadioEntry> | RadioEntry[]> {
  const out: Array<Exclude<MenuEntry, RadioEntry> | RadioEntry[]> = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (entry.kind === 'radio') { if (Array.isArray(last)) last.push(entry); else out.push([entry]); } else out.push(entry);
  }
  return out;
}

function entryOf(entry: Exclude<MenuEntry, RadioEntry>, key: number) {
  switch (entry.kind) {
    case 'separator': return <DropdownMenuSeparator key={key} />;
    case 'label': return <DropdownMenuLabel key={key}>{entry.label}</DropdownMenuLabel>;
    case 'submenu': return <MenuSub key={key} icon={entry.icon} label={entry.label} disabled={entry.disabled} className="min-w-48">{menuEntries(entry.entries)}</MenuSub>;
    case 'check': return <DropdownMenuCheckboxItem key={key} checked={entry.checked} disabled={entry.disabled} onCheckedChange={(value) => entry.onCheckedChange(value === true)}>{entry.icon}{entry.label}</DropdownMenuCheckboxItem>;
    default: return (
      <DropdownMenuItem key={key} disabled={entry.disabled} variant={entry.danger ? 'danger' : undefined} onSelect={entry.onSelect}>
        {entry.icon}{entry.label}{entry.shortcut && <span className="ml-auto pl-4 text-2xs text-fg-4">{entry.shortcut}</span>}
      </DropdownMenuItem>
    );
  }
}

function menuEntries(entries: readonly MenuEntry[]) {
  return groups(entries).map((group, index) => Array.isArray(group) ? (
    // A run of `radio` entries is one choice: its checked entry is the group's value.
    <DropdownMenuRadioGroup key={index} value={String(group.findIndex((entry) => entry.checked))}>
      {group.map((entry, at) => <DropdownMenuRadioItem key={at} value={String(at)} disabled={entry.disabled} onSelect={entry.onSelect}>{entry.icon}{entry.label}</DropdownMenuRadioItem>)}
    </DropdownMenuRadioGroup>
  ) : entryOf(group, index));
}

/** `UiKit.Menu`: the app's dropdown menu over a list of entries, so a plugin's menu is the app's. */
export function PluginMenu({ trigger, tip, entries, align = 'start', mobileSheet, onOpenChange }: MenuProps) {
  const opener = <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>;
  return (
    <DropdownMenu {...(onOpenChange ? { onOpenChange } : {})}>
      {tip ? <Tip label={tip}>{opener}</Tip> : opener}
      <DropdownMenuContent align={align} className="min-w-48" {...(mobileSheet === false ? { mobileSheet: false } : {})}>
        {menuEntries(entries)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `UiKit.Popover`: the app's popover on a trigger; the plugin sizes and pads the panel. */
export function PluginPopover({ trigger, tip, children, align = 'start', side = 'bottom', className, onOpenChange }: PopoverProps) {
  const opener = <PopoverTrigger asChild>{trigger}</PopoverTrigger>;
  return (
    <Popover {...(onOpenChange ? { onOpenChange } : {})}>
      {tip ? <Tip label={tip}>{opener}</Tip> : opener}
      <PopoverContent align={align} side={side} className={className}>{children}</PopoverContent>
    </Popover>
  );
}

/** `UiKit.ContextMenu`: the same menu at the pointer, anchored as the tab bar's right-click menu is (`TabBar.tsx`). */
export function PluginContextMenu({ at, entries, onClose }: ContextMenuProps) {
  if (!at) return null;
  return (
    <DropdownMenu open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at.x, top: at.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={0} className="min-w-52" mobileSheet={false}>
        {menuEntries(entries)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `UiKit.QuickPanel`: the search dialog of ⌘P and ⌘K (`QuickOpen.tsx`), with the list drawn by the plugin. */
export function PluginQuickPanel({ open, onOpenChange, title, query, onQueryChange, placeholder, onKeyDown, busy, focusToken, tabs, tab, onTabChange, tools, trailing, listId, activeId, listLabel, children, preview }: QuickPanelProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open && focusToken) { input.current?.focus(); input.current?.select(); } }, [open, focusToken]);
  const scoped = Boolean(tabs?.length || tools);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="content"
        className="top-[12%] max-h-[calc(88dvh-16px)] translate-y-0 gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); input.current?.select(); }}
        onEscapeKeyDown={(event) => { if (event.isComposing || event.keyCode === 229) event.preventDefault(); }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <QuickInput
          inputRef={input}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          trailing={<>{trailing}{busy && <Spinner />}</>}
        />
        {scoped && (
          <div className="flex h-10 shrink-0 items-center gap-3 edge-b px-3">
            {tabs?.length ? <UnderlineTabs value={tab ?? tabs[0]!.value} onChange={(value) => onTabChange?.(value)} ariaLabel={title} options={tabs.map((item) => ({ value: item.value, label: item.label }))} /> : null}
            {tools && <div className="ml-auto flex min-w-0 items-center gap-1">{tools}</div>}
          </div>
        )}
        {preview ? (
          // The same total height with or without a preview: the list gives up the lower part to it.
          <div className={cn(scoped ? quickListClass : quickListTallClass, 'flex flex-col overflow-hidden p-0')}>
            <div id={listId} role="listbox" aria-label={listLabel} className="min-h-0 flex-[1_1_45%] overflow-y-auto p-2">{children}</div>
            <div className="min-h-0 flex-[1_1_55%] overflow-hidden edge-t">{preview}</div>
          </div>
        ) : (
          <div id={listId} role="listbox" aria-label={listLabel} aria-busy={busy} className={scoped ? quickListClass : quickListTallClass}>{children}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
