import * as React from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconSearch, IconX } from '@/components/icons';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Input } from './controls';

/**
 * The list filter: `Input` with a leading search icon. A trailing hint (a shortcut `Kbd`) shows while
 * empty, a clear button once there is text. Escape clears the text; on an empty field it blurs and the
 * event goes on to whatever surface owns it.
 */
export function SearchField({ value, onChange, placeholder, 'aria-label': ariaLabel, hint, size = 'md', className, inputClassName, onKeyDown, ref, disabled, ...props }: Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'size' | 'type'> & {
  value: string;
  onChange: (value: string) => void;
  'aria-label': string;
  /** Shown at the trailing edge while the field is empty. */
  hint?: React.ReactNode;
  size?: 'md' | 'lg';
  inputClassName?: string;
}) {
  const { t } = useLingui();
  const input = React.useRef<HTMLInputElement | null>(null);
  const setRef = (node: HTMLInputElement | null) => {
    input.current = node;
    if (typeof ref === 'function') ref(node); else if (ref) ref.current = node;
  };
  return (
    <div className={cn('relative min-w-0', className)}>
      <Input
        ref={setRef}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        className={cn('pl-8 pr-8', size === 'lg' && 'h-9', inputClassName)}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          onKeyDown?.(event);
          if (event.defaultPrevented || event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (value) { event.preventDefault(); onChange(''); } else event.currentTarget.blur();
        }}
        {...props}
      />
      <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-4" />
      <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">
        {value && !disabled
          // The button unmounts once the text is gone, so focus goes back to the field.
          ? <Button variant="quiet" size="icon-xs" aria-label={t`清除搜索`} onClick={() => { onChange(''); input.current?.focus(); }} className="no-hover:size-8"><IconX /></Button>
          : hint}
      </span>
    </div>
  );
}
