import { useLingui } from '@lingui/react/macro';
import { IconCheck, IconCopy } from '@/components/icons';
import { copyText } from '@/lib/files';
import { useFeedbackPulse } from '@/lib/feedback';
import { cn } from '@/lib/utils';

export function CopyButton({ text, className, label }: { text: string; className?: string; label?: string }) {
  const { t } = useLingui();
  const shownLabel = label ?? t`复制`;
  const copied = useFeedbackPulse<HTMLButtonElement>(text);
  return (
    <button
      type="button"
      ref={copied.ref}
      aria-label={shownLabel}
      title={shownLabel}
      className={cn('inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg no-hover:size-11 no-hover:justify-center no-hover:px-0', className)}
      onClick={() => {
        void copyText(text).then((done) => {
          if (!done) return;
          copied.show();
        });
      }}
    >
      {copied.shown ? <IconCheck className="size-3.5 text-success" /> : <IconCopy className="size-3.5" />}
    </button>
  );
}
