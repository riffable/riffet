import { useLingui } from '@lingui/react/macro';
import { cn } from '@/lib/utils';
import { display, PAGE, Reveal } from '../specimen';
import { useStyleNote } from './notes';
import { STYLES } from './values';

/** The macOS part's title: what it covers, and the styles it is drawn in. */
export function MacCover() {
  const { t } = useLingui();
  const note = useStyleNote();
  return (
    <section className="bg-bg">
      <div className={cn(PAGE, 'flex flex-col items-center pb-16 pt-28 text-center max-md:pt-16')}>
        <Reveal>
          <span className="inline-flex h-7 items-center gap-2 rounded-full bg-fg/[0.05] px-3 text-xs text-fg-2">
            {STYLES.map((style, index) => <span key={style.id} className="flex items-center gap-2">{index > 0 && <span className="text-fg-4">·</span>}{note(style).title}</span>)}
          </span>
        </Reveal>
        <Reveal delay={80}><h1 className="mt-7 font-semibold leading-[1.05] tracking-tight text-fg" style={display(36, '6.4vw', 80)}>macOS</h1></Reveal>
        <Reveal delay={160}>
          <p className="mt-6 flex flex-col gap-1 text-lg md:text-xl">
            <span className="text-balance text-fg-2">{t`共用的基础与模式在 Mac 上的写法：用哪个组件、取什么值、哪里跟平台。`}</span>
            <span className="text-balance text-fg-3">{t`风格各有一节，数值与配方读自同一份定义。`}</span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}
