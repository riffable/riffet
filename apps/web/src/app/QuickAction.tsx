import type { ReactNode } from 'react';

/** A card-sized action on a new-conversation page: an icon, a title, a short note. */
export function QuickAction({ icon, title, note, onClick, disabled }: { icon: ReactNode; title: string; note?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="group/action flex min-w-0 items-center gap-3 rounded-xl border border-line bg-elevated px-3.5 py-3 text-left transition-[border-color,background-color] hover:border-line-strong hover:bg-subtle disabled:opacity-50">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-fg-2 [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-fg">{title}</span>
        {note && <span className="truncate text-xs text-fg-3">{note}</span>}
      </span>
    </button>
  );
}
