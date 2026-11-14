import { useRef } from 'react';
import { Trans } from '@lingui/react/macro';
import { IconFolder } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { TaskConfirmation } from '@contracts';
import { commandLine } from '@/lib/tasks';

/**
 * The exact command an installed package's task is about to run for the first time. Approving it is
 * the user's decision alone: the server remembers it, so this keeps nothing.
 */
export function TaskConfirmDialog({ title, confirmation, onConfirm, onCancel }: {
  /** The plugin's title. */
  title: string;
  /** Open while there is one. */
  confirmation: TaskConfirmation | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // The content stays through the closing animation after `confirmation` is cleared.
  const last = useRef(confirmation);
  if (confirmation) last.current = confirmation;
  const plan = (confirmation ?? last.current)?.plan;
  return (
    <Dialog open={Boolean(confirmation)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription><Trans>首次运行这条命令</Trans></DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <pre className="max-h-48 select-all overflow-auto whitespace-pre-wrap break-all rounded-lg bg-subtle px-3 py-2 font-mono text-xs text-fg">{plan && commandLine(plan)}</pre>
          <div className="flex flex-col gap-1 font-mono text-xs text-fg-3">
            <p className="flex items-center gap-1.5"><IconFolder className="size-3.5 shrink-0" /><span className="min-w-0 break-all">{plan?.cwd || '.'}</span></p>
            {Object.entries(plan?.env ?? {}).map(([key, value]) => <p key={key} className="break-all">{key}={value}</p>)}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}><Trans>取消</Trans></Button>
          <Button variant="primary" onClick={onConfirm}><Trans>运行</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
