import { useEffect, useRef } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconArrowDown, IconArrowUp, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface Props {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  resultIndex: number;
  resultCount: number;
  onQueryChange: (value: string) => void;
  onToggleCaseSensitive: () => void;
  onToggleRegex: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function TerminalSearchBar({
  query, caseSensitive, regex, resultIndex, resultCount,
  onQueryChange, onToggleCaseSensitive, onToggleRegex, onNext, onPrevious, onClose,
}: Props) {
  const { t } = useLingui();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const counter = !query ? '' : resultCount === 0 ? '0/0' : resultIndex >= 0 ? `${resultIndex + 1}/${resultCount}` : `${resultCount}+`;

  return (
    <div
      role="search"
      aria-label={t`在终端中查找`}
      className="absolute top-2 right-3 z-10 flex items-center gap-1 rounded-lg border border-line bg-elevated p-1 shadow-md"
    >
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
          else if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) onPrevious(); else onNext(); }
        }}
        placeholder={t`查找`}
        aria-label={t`查找内容`}
        className="h-7 w-44 border-0 bg-transparent px-2 text-xs shadow-none focus-visible:ring-0"
      />
      {counter && (
        <span className={cn('px-1 text-xs tabular-nums', resultCount === 0 ? 'text-danger' : 'text-fg-3')}>
          {counter}
        </span>
      )}
      <Tip label={t`区分大小写`}>
        <Button
          size="icon-xs"
          variant={caseSensitive ? 'secondary' : 'quiet'}
          aria-label={t`区分大小写`}
          aria-pressed={caseSensitive}
          onClick={onToggleCaseSensitive}
          className="font-mono text-xs"
        >Aa</Button>
      </Tip>
      <Tip label={t`正则表达式`}>
        <Button
          size="icon-xs"
          variant={regex ? 'secondary' : 'quiet'}
          aria-label={t`正则表达式`}
          aria-pressed={regex}
          onClick={onToggleRegex}
          className="font-mono text-xs"
        >.*</Button>
      </Tip>
      <Tip label={t`上一个匹配`}>
        <Button size="icon-xs" variant="quiet" aria-label={t`上一个匹配`} disabled={!query} onClick={onPrevious}>
          <IconArrowUp />
        </Button>
      </Tip>
      <Tip label={t`下一个匹配`}>
        <Button size="icon-xs" variant="quiet" aria-label={t`下一个匹配`} disabled={!query} onClick={onNext}>
          <IconArrowDown />
        </Button>
      </Tip>
      <Tip label={t({ message: '关闭查找', context: 'terminal-search' })}>
        <Button size="icon-xs" variant="quiet" aria-label={t({ message: '关闭查找', context: 'terminal-search' })} onClick={onClose}>
          <IconX />
        </Button>
      </Tip>
    </div>
  );
}
