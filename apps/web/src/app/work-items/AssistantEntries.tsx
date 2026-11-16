import { useEffect, useState } from 'react';
import type { AssistantPack } from '@contracts';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useUi } from '../state/stores';

/**
 * The 个人助理's installed capability packs, one entry each, above its composer (docs/ASSISTANT.md §8.2). An entry
 * puts the pack's command at the start of the draft, so the message is answered with that pack's skill. Nothing
 * shows until a pack is added in Settings; read again as Settings closes, where packs are added.
 */
export function AssistantEntries({ onPick, className }: { onPick: (command: string) => void; className?: string }) {
  const settingsOpen = useUi((state) => state.settingsOpen);
  const [packs, setPacks] = useState<AssistantPack[]>([]);
  useEffect(() => {
    if (settingsOpen) return;
    let live = true;
    api.assistantPacks().then((value) => { if (live) setPacks(value.packs); }, () => undefined);
    return () => { live = false; };
  }, [settingsOpen]);
  const entries = packs.filter((pack): pack is AssistantPack & { entry: string } => pack.installed && Boolean(pack.entry));
  if (!entries.length) return null;
  return (
    <div className={cn('flex gap-1.5 overflow-x-auto [scrollbar-width:none]', className)}>
      {entries.map((pack) => (
        <Button key={pack.id} size="xs" variant="secondary" className="shrink-0 max-md:h-9" title={pack.description} onClick={() => onPick(`${pack.entry} `)}>
          {pack.title}
        </Button>
      ))}
    </div>
  );
}
