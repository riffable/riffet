import { useLingui } from '@lingui/react/macro';
import { IconCheck, IconCopy } from '@/components/icons';
import { copyText } from '@/lib/files';
import { useFeedbackPulse } from '@/lib/feedback';
import { cn } from '@/lib/utils';

export function CopyButton({ text, className, label, size = 'sm' }: { text: string; className?: string; label?: string; size?: 'sm' | 'xs' }) {
  const { t } = useLingui();
  const shownLabel = label ?? t`复制`;
  const copied = useFeedbackPulse<HTMLButtonElement>(text);
  const iconClass = size === 'xs' ? 'size-3' : 'size-3.5';
  return (
    <button
      type="button"
      ref={copied.ref}
      aria-label={shownLabel}
      title={shownLabel}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1 rounded-md text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg no-hover:size-11 no-hover:px-0',
        size === 'xs' ? 'size-6' : 'h-6 px-1.5',
        className,
      )}
      onClick={() => {
        void copyText(text).then((done) => {
          if (!done) return;
          copied.show();
        });
      }}
    >
      {copied.shown ? <IconCheck className={cn(iconClass, 'text-success')} /> : <IconCopy className={iconClass} />}
    </button>
  );
}
