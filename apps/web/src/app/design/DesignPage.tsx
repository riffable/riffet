import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowLeft, IconArrowRight, IconChevronDown } from '@/components/icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Segmented, UnderlineTabs } from '@/components/ui/controls';
import { useDisplaySettings } from '@/lib/display-settings';
import { setThemeMode, useTheme, type ThemeMode } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { PageScaffold } from '../PageScaffold';
import type { DesignPlatform } from '../state/page-url';
import { useNav, useStores } from '../state/stores';
import { useDesignCatalog, type CatalogChapter, type CatalogGroup } from './catalog';
import { useAndroidStyleNote } from './android/notes';
import { ANDROID_STYLES } from './android/values';
import { PlatformCover } from './platform';
import { Cover } from './overview/Opening';
import { Contents } from './overview/Contents';
import { ChapterPlaceContext, PaintRevision } from './specimen';

/** The share of the scroller's height at which a section counts as the one being read. */
const READING_LINE = 0.3;

interface Section { key: string; label: string; title: string }

/** The contents column: the index, then each group's chapters; the open chapter lists its sections. */
function Aside({ groups, current, sections, section, onGo, onSection }: {
  groups: CatalogGroup[];
  current?: CatalogChapter;
  sections: Section[];
  section: string;
  onGo: (id: string) => void;
  onSection: (key: string) => void;
}) {
  const { t } = useLingui();
  const row = 'flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus';
  return (
    <nav aria-label={t({ message: '目录', context: 'design-contents' })} className="hidden w-56 shrink-0 flex-col overflow-y-auto edge-r bg-sidebar p-2 pb-10 lg:flex">
      <button type="button" aria-current={current ? undefined : 'page'} onClick={() => onGo('')} className={cn(row, 'mb-2', current ? 'text-fg-2 hover:bg-hover hover:text-fg' : 'bg-active text-fg')}>{t({ message: '目录', context: 'design-contents' })}</button>
      {groups.map((group) => (
        <div key={group.id} className="mb-3 flex flex-col gap-px">
          <h3 className="px-2.5 pb-1 pt-2 text-2xs font-medium text-fg-4">{group.title}</h3>
          {group.chapters.map((chapter) => {
            const open = chapter.id === current?.id;
            return (
              <div key={chapter.id} className="flex flex-col">
                <button type="button" aria-current={open ? 'page' : undefined} onClick={() => onGo(chapter.id)} className={cn(row, open ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg')}>
                  <span className="w-4 shrink-0 font-mono text-2xs tabular-nums text-fg-4">{chapter.number}</span>
                  <span className="min-w-0 truncate">{chapter.title}</span>
                </button>
                {open && sections.length > 0 && (
                  <div className="my-1 flex flex-col">
                    {sections.map((item) => (
                      <button key={item.key} type="button" onClick={() => onSection(item.key)} className={cn('flex min-h-7 items-center rounded-md pl-9 pr-2.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus', section === item.key ? 'text-fg' : 'text-fg-3 hover:text-fg-2')}>
                        <span className="min-w-0 truncate">{item.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Below the width that fits the contents column, the chapters are a menu beside the title. */
function ChapterMenu({ groups, current, onGo }: { groups: CatalogGroup[]; current?: CatalogChapter; onGo: (id: string) => void }) {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="ml-1 flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-sm text-fg-2 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus lg:hidden no-hover:min-h-11">
        <span className="min-w-0 truncate">{current ? current.title : t({ message: '目录', context: 'design-contents' })}</span>
        <IconChevronDown className="size-3.5 shrink-0 text-fg-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-[min(70dvh,560px)] w-64 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onGo('')}>{t({ message: '目录', context: 'design-contents' })}</DropdownMenuItem>
        {groups.map((group) => (
          <DropdownMenuGroup key={group.id}>
            <DropdownMenuLabel>{group.title}</DropdownMenuLabel>
            {group.chapters.map((chapter) => (
              <DropdownMenuItem key={chapter.id} onSelect={() => onGo(chapter.id)} className={cn(chapter.id === current?.id && 'bg-active')}>
                <span className="w-4 shrink-0 font-mono text-2xs tabular-nums text-fg-4">{chapter.number}</span>{chapter.title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The chapters either side of this one. */
function Pager({ previous, next, onGo }: { previous?: CatalogChapter; next?: CatalogChapter; onGo: (id: string) => void }) {
  const { t } = useLingui();
  const card = 'group flex min-h-20 flex-1 flex-col justify-center gap-1 rounded-xl px-5 outline-none transition-colors duration-[var(--duration-base)] hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus';
  return (
    <nav aria-label={t`翻页`} className="mx-auto flex w-full max-w-[1200px] gap-4 px-12 pb-16 max-md:flex-col max-md:px-5">
      {previous ? (
        <button type="button" onClick={() => onGo(previous.id)} className={cn(card, 'items-start text-left')}>
          <span className="flex items-center gap-1.5 text-xs text-fg-3"><IconArrowLeft className="size-3.5" />{t`上一章`}</span>
          <span className="text-base text-fg">{previous.title}</span>
        </button>
      ) : <span className="flex-1 max-md:hidden" />}
      {next && (
        <button type="button" onClick={() => onGo(next.id)} className={cn(card, 'items-end text-right')}>
          <span className="flex items-center gap-1.5 text-xs text-fg-3">{t`下一章`}<IconArrowRight className="size-3.5" /></span>
          <span className="text-base text-fg">{next.title}</span>
        </button>
      )}
    </nav>
  );
}

/** Memoised: the workbench re-renders with every session-list change, which says nothing new here. */
/** A platform part's title page, with its styles' names. */
function PlatformTitle({ platform }: { platform: Exclude<DesignPlatform, 'web'> }) {
  const { t } = useLingui();
  const android = useAndroidStyleNote();
  return platform === 'macos'
    ? <PlatformCover name="macOS" styles={['Riffet']} lines={[t`共用的基础与模式在 Mac 上的写法：用哪个组件、取什么值、哪里跟平台。`, t`数值读自同一份定义。`]} />
    : <PlatformCover name="Android" styles={ANDROID_STYLES.map((style) => android(style).title)} lines={[t`共用的基础与模式在 Android 上的写法：用哪个组件、取什么值、哪里跟平台。`, t`风格各有一节，尺寸与动效读自同一份定义。`]} />;
}

export const DesignPage = memo(function DesignPage({ sidebarCollapsed, mobileBack, onClose, onOpenSidebar, onExpandSidebar }: {
  sidebarCollapsed: boolean;
  mobileBack?: { label: string; onBack: () => void };
  onClose: () => void;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
}) {
  const { t } = useLingui();
  const theme = useTheme();
  const { codeTheme } = useDisplaySettings();
  const paint = `${theme.themeId}:${theme.resolved}:${theme.revision}:${theme.paletteKey ?? ''}:${codeTheme}`;
  const scroller = useRef<HTMLDivElement>(null);
  const { nav } = useStores();
  const platform = useNav((state) => state.designPlatform);
  const chapterId = useNav((state) => state.designChapter);
  const catalogs: Record<DesignPlatform, CatalogGroup[]> = { web: useDesignCatalog('web'), macos: useDesignCatalog('macos'), android: useDesignCatalog('android') };
  const groups = catalogs[platform];
  const chapters = groups.flatMap((group) => group.chapters);
  const index = chapters.findIndex((chapter) => chapter.id === chapterId);
  const current = index >= 0 ? chapters[index] : undefined;
  const group = groups.find((item) => item.id === current?.group);
  const [sections, setSections] = useState<Section[]>([]);
  const [section, setSection] = useState('');

  const go = (id: string) => nav.set({ designChapter: id });
  /** Another platform keeps the chapter when it has one of the same name, and starts from its index otherwise. */
  const switchPlatform = (next: DesignPlatform) => {
    if (next === platform) return;
    const kept = catalogs[next].some((item) => item.chapters.some((chapter) => chapter.id === chapterId));
    nav.set({ designPlatform: next, designChapter: kept ? chapterId : '' });
  };

  // A new chapter starts at its top.
  useLayoutEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [platform, current?.id]);

  // The open chapter's sections, and the one being read.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const found = [...element.querySelectorAll<HTMLElement>('[data-design-section]')];
    setSections(found.map((node) => ({ key: node.id, label: node.dataset.designSection ?? '', title: node.dataset.title ?? '' })));
    let frame = 0;
    const read = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const line = box.top + box.height * READING_LINE;
      setSection(found.findLast((node) => node.getBoundingClientRect().top <= line)?.id ?? found[0]?.id ?? '');
    };
    const schedule = () => { frame ||= requestAnimationFrame(read); };
    element.addEventListener('scroll', schedule, { passive: true });
    read();
    return () => { element.removeEventListener('scroll', schedule); cancelAnimationFrame(frame); };
  }, [platform, current?.id]);

  /** Scrolls this page's own scroller; `scrollIntoView` would also scroll the workbench around it. */
  const goSection = (key: string) => {
    const element = scroller.current;
    const target = document.getElementById(key);
    if (!element || !target) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const top = target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop - 32;
    element.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
  };

  const Render = current?.render;
  return (
    <PaintRevision.Provider value={paint}>
      <PageScaffold
        title={<Trans>设计规范</Trans>}
        meta={(
          <>
            <UnderlineTabs<DesignPlatform> className="ml-2 h-full max-md:ml-0" value={platform} onChange={switchPlatform} ariaLabel={t`平台`} options={[{ value: 'web', label: 'Web' }, { value: 'macos', label: 'macOS' }, { value: 'android', label: 'Android' }]} />
            <ChapterMenu groups={groups} current={current} onGo={go} />
          </>
        )}
        actions={(
          <Segmented<ThemeMode>
            // Phones have the platform tabs and the chapter menu beside the title; light and dark stay in Settings.
            className="max-md:hidden"
            size="xs"
            value={theme.mode}
            onChange={setThemeMode}
            ariaLabel={t`明暗`}
            options={[{ value: 'system', label: t`跟随系统` }, { value: 'light', label: t`浅色` }, { value: 'dark', label: t`深色` }]}
          />
        )}
        column="none"
        divided
        mobileBack={mobileBack}
        aside={<Aside groups={groups} current={current} sections={sections} section={section} onGo={go} onSection={goSection} />}
        scrollRef={scroller}
        scrollerProps={{ 'data-design-scroller': true }}
        sidebarCollapsed={sidebarCollapsed}
        onClose={onClose}
        onOpenSidebar={onOpenSidebar}
        onExpandSidebar={onExpandSidebar}
      >
        {current && Render && group ? (
          <div key={`${platform}:${current.id}`} className="flex min-h-full flex-col">
            <ChapterPlaceContext.Provider value={{ number: current.number, group: group.title }}>
              <div className="flex-1"><Render /></div>
            </ChapterPlaceContext.Provider>
            <div className="bg-bg pt-10 edge-t">
              <Pager previous={chapters[index - 1]} next={chapters[index + 1]} onGo={go} />
            </div>
          </div>
        ) : (
          <div key={platform}>
            {platform === 'web' ? <Cover onGo={go} /> : <PlatformTitle platform={platform} />}
            <Contents groups={groups} onGo={go} />
          </div>
        )}
        <footer className="flex items-center justify-between gap-6 bg-bg px-12 py-10 font-mono text-2xs text-fg-4 edge-t max-md:px-5">
          <span>docs/design/system</span>
          <span>Riffet Design System</span>
        </footer>
      </PageScaffold>
    </PaintRevision.Provider>
  );
});
