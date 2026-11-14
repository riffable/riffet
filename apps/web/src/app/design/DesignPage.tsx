import { memo, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Segmented } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { setThemeMode, useTheme, type ThemeMode } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { PageScaffold } from '../PageScaffold';
import { ArchitectureChapter } from './ArchitectureChapter';
import { ColorChapter } from './ColorChapter';
import { ComponentChapter } from './ComponentChapter';
import { ElevationChapter } from './ElevationChapter';
import { GLYPHS, IconChapter } from './IconChapter';
import { LayoutChapter } from './LayoutChapter';
import { MotionChapter } from './MotionChapter';
import { Contents, Cover, Pipeline, PrinciplesChapter, type ChapterEntry } from './Opening';
import { OverlayChapter } from './OverlayChapter';
import { SpaceChapter } from './SpaceChapter';
import { chapterAnchor, PaintRevision } from './specimen';
import { TypeChapter } from './TypeChapter';

/** The share of the scroller's height at which a chapter counts as the one being read. */
const READING_LINE = 0.35;

/** Memoised: the workbench re-renders with every session-list change, which says nothing new here. */
export const DesignPage = memo(function DesignPage({ sidebarCollapsed, onClose, onOpenSidebar, onExpandSidebar }: {
  sidebarCollapsed: boolean;
  onClose: () => void;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
}) {
  const { t } = useLingui();
  const theme = useTheme();
  const paint = `${theme.themeId}:${theme.resolved}:${theme.revision}:${theme.paletteKey ?? ''}`;
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState('');
  const chapters: ChapterEntry[] = [
    { id: 'principles', number: '01', title: t`原则` },
    { id: 'colors', number: '02', title: t`颜色` },
    { id: 'type', number: '03', title: t`文字` },
    { id: 'spacing', number: '04', title: t`间距与圆角` },
    { id: 'elevation', number: '05', title: t`层级` },
    { id: 'motion', number: '06', title: t`动效` },
    { id: 'icons', number: '07', title: t`图标` },
    { id: 'components', number: '08', title: t`组件` },
    { id: 'layout', number: '09', title: t`布局` },
    { id: 'overlays', number: '10', title: t`浮层` },
    { id: 'architecture', number: '11', title: t`架构` },
  ];
  const current = chapters.find((chapter) => chapter.id === active);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const line = box.top + box.height * READING_LINE;
      const reached = [...element.querySelectorAll<HTMLElement>('[data-design-chapter]')].findLast((chapter) => chapter.getBoundingClientRect().top <= line);
      setActive(reached?.id.replace(/^design-/, '') ?? '');
    };
    const schedule = () => { frame ||= requestAnimationFrame(read); };
    element.addEventListener('scroll', schedule, { passive: true });
    read();
    return () => { element.removeEventListener('scroll', schedule); cancelAnimationFrame(frame); };
  }, []);

  /** Scrolls this page's own scroller; `scrollIntoView` would also scroll the workbench around it. */
  const go = (id: string) => {
    const element = scroller.current;
    const target = document.getElementById(chapterAnchor(id));
    if (!element || !target) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const top = target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    element.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <PaintRevision.Provider value={paint}>
      <PageScaffold
        title={<Trans>设计规范</Trans>}
        meta={current && (
          <span key={current.id} className="min-w-0 truncate text-sm text-fg-3 animate-in fade-in-0 duration-[var(--duration-fast)] ease-[var(--ease-standard)] max-md:hidden">
            <span className="pr-2 text-fg-4">/</span><span className="font-mono text-xs text-fg-4">{current.number}</span> {current.title}
          </span>
        )}
        actions={(
          <Segmented<ThemeMode>
            size="xs"
            value={theme.mode}
            onChange={setThemeMode}
            ariaLabel={t`明暗`}
            options={[{ value: 'system', label: t`跟随系统` }, { value: 'light', label: t`浅色` }, { value: 'dark', label: t`深色` }]}
          />
        )}
        column="none"
        divided
        /* The chapter rail: one tick per chapter, the one being read drawn longer. */
        pinned={(
          <nav aria-label={t`章节`} className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col items-end max-lg:hidden">
            {chapters.map((chapter) => (
              <Tip key={chapter.id} label={`${chapter.number} ${chapter.title}`} side="left">
                <button type="button" aria-label={chapter.title} aria-current={active === chapter.id ? 'location' : undefined} onClick={() => go(chapter.id)} className="group flex h-5 w-8 items-center justify-end outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  <span className={cn('h-px transition-[width,background-color] duration-[var(--duration-base)] ease-[var(--ease-standard)]', active === chapter.id ? 'w-6 bg-fg' : 'w-3 bg-fg-4 group-hover:w-4 group-hover:bg-fg-3')} />
                </button>
              </Tip>
            ))}
          </nav>
        )}
        scrollRef={scroller}
        scrollerProps={{ 'data-design-scroller': true }}
        sidebarCollapsed={sidebarCollapsed}
        onClose={onClose}
        onOpenSidebar={onOpenSidebar}
        onExpandSidebar={onExpandSidebar}
      >
        <Cover onGo={go} />
        <Contents chapters={chapters} icons={GLYPHS.length} onGo={go} />
        <Pipeline />
        <PrinciplesChapter />
        <ColorChapter />
        <TypeChapter />
        <SpaceChapter />
        <ElevationChapter />
        <MotionChapter />
        <IconChapter />
        <ComponentChapter />
        <LayoutChapter />
        <OverlayChapter />
        <ArchitectureChapter />
        <footer className="flex items-center justify-between gap-6 bg-bg px-12 py-10 font-mono text-2xs text-fg-4 edge-t max-md:px-5">
          <span>docs/design/system</span>
          <span>Riffet Design System</span>
        </footer>
      </PageScaffold>
    </PaintRevision.Provider>
  );
});
