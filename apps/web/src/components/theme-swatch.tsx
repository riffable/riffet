import { cn } from '@/lib/utils';

/**
 * Both halves of a theme, painted by the theme itself.
 *
 * The palette blocks in `styles/index.css` are keyed on `[data-theme="<id>"]` rather than on `:root`,
 * so an element carrying that attribute resolves `--bg` / `--accent` to that theme's values — even
 * when it is a light tile sitting inside a dark page, because `.dark` lives on `<html>` and not on
 * this element. That is the whole reason a swatch can exist without a second copy of every palette
 * in TypeScript, and why adding a theme to the stylesheet is enough for it to preview correctly
 * everywhere this component is used.
 */
export function ThemeSwatch({ id, className }: { id: string; className?: string }) {
  const half = (dark: boolean) => (
    <span data-theme={id} className={cn('grid flex-1 place-items-center bg-bg', dark && 'dark')}>
      <span className="size-1.5 rounded-full bg-accent" />
    </span>
  );
  return (
    <span aria-hidden className={cn('flex h-6 w-9 shrink-0 overflow-hidden rounded-md border border-line', className)}>
      {half(false)}
      {half(true)}
    </span>
  );
}
