import { useContext } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconPanelLeft } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { useShortcutHint } from './shortcuts';
import { cn } from '@/lib/utils';
import { SidebarPeekTrigger } from './use-sidebar-peek';

/** Shown at the top-left of the work area while the desktop sidebar is collapsed; hovering it peeks the sidebar. */
export function ExpandSidebarButton({ className, onClick }: { className?: string; onClick?: () => void }) {
  const { t } = useLingui();
  const hint = useShortcutHint('toggleSidebar');
  const peek = useContext(SidebarPeekTrigger);
  return (
    <Tip label={t`展开侧边栏`} kbd={hint}>
      <Button size="icon-sm" variant="quiet" className={cn('hidden md:inline-flex', className)} aria-label={t`展开侧边栏`} onClick={onClick} {...peek}><IconPanelLeft /></Button>
    </Tip>
  );
}
