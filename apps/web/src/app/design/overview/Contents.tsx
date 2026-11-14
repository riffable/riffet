import { useLingui } from '@lingui/react/macro';
import { cn } from '@/lib/utils';
import type { CatalogGroup } from '../catalog';
import { PAGE, Reveal } from '../specimen';

/** The contents, set like a book's: one band per layer, its definition, then its chapters. */
export function Contents({ groups, onGo }: { groups: CatalogGroup[]; onGo: (id: string) => void }) {
  const { t } = useLingui();
  return (
    <section className="bg-bg">
      <nav aria-label={t({ message: '目录', context: 'design-contents' })} className={cn(PAGE, 'flex flex-col pb-32')}>
        {groups.map((group) => (
          <Reveal key={group.id}>
            <div className="grid grid-cols-12 gap-x-6 gap-y-5 py-10 edge-t">
              <div className="col-span-12 flex flex-col gap-2 md:col-span-3">
                <span className="font-mono text-xs tabular-nums text-fg-4">{group.number}</span>
                <h2 className="text-xl font-semibold tracking-tight text-fg">{group.title}</h2>
                <p className="text-sm text-fg-3">{group.definition}</p>
              </div>
              <ul className="col-span-12 grid gap-x-6 sm:grid-cols-2 md:col-span-9 lg:grid-cols-3">
                {group.chapters.map((chapter) => (
                  <li key={chapter.id}>
                    <button
                      type="button"
                      onClick={() => onGo(chapter.id)}
                      className="group -mx-3 flex w-[calc(100%+1.5rem)] items-baseline gap-3 rounded-lg px-3 py-3 text-left outline-none transition-colors duration-[var(--duration-base)] hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <span className="w-5 shrink-0 font-mono text-2xs tabular-nums text-fg-4">{chapter.number}</span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-base text-fg">{chapter.title}</span>
                        <span className="text-sm text-fg-3">{chapter.summary}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        ))}
      </nav>
    </section>
  );
}
