import { useLingui } from '@lingui/react/macro';
import { IconArrowUp } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { useAvailableUpdate } from '@/lib/update';
import { cn } from '@/lib/utils';

/**
 * The sidebar footer's right end while a newer release exists: the version with an upward arrow. Once
 * About has shown that version it shrinks to the arrow alone, and it goes away with the update.
 */
export function UpdateNotice({ version, seen, onOpen }: { version: string; seen: boolean; onOpen: () => void }) {
  const { t } = useLingui();
  const label = t`新版本 ${version} 可用`;
  return (
    <Tip label={label} side="top">
      <Button size={seen ? 'icon-sm' : 'sm'} variant="quiet" aria-label={label} onClick={onOpen} className={cn('text-accent hover:text-accent', !seen && 'gap-1 px-2 tabular-nums')}>
        <IconArrowUp />
        {!seen && <span>{version.replace(/^v/, '')}</span>}
      </Button>
    </Tip>
  );
}

export function SidebarUpdateButton({ onOpen }: { onOpen: () => void }) {
  const { version, seen } = useAvailableUpdate();
  if (!version) return null;
  return <div className="ml-auto"><UpdateNotice version={version} seen={seen} onOpen={onOpen} /></div>;
}
