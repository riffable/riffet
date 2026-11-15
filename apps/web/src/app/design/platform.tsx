import { Fragment } from 'react';
import { cn } from '@/lib/utils';
import { display, Frame, PAGE, Reveal, Token } from './specimen';

/** A platform part's title page: the styles it is drawn in, its name, and two lines on what it covers. */
export function PlatformCover({ name, styles, lines }: { name: string; styles: string[]; lines: [string, string] }) {
  return (
    <section className="bg-bg">
      <div className={cn(PAGE, 'flex flex-col items-center pb-16 pt-28 text-center max-md:pt-16')}>
        <Reveal>
          <span className="inline-flex h-7 items-center gap-2 rounded-full bg-fg/[0.05] px-3 text-xs text-fg-2">
            {styles.map((style, index) => <span key={style} className="flex items-center gap-2">{index > 0 && <span className="text-fg-4">·</span>}{style}</span>)}
          </span>
        </Reveal>
        <Reveal delay={80}><h1 className="mt-7 font-semibold leading-[1.05] tracking-tight text-fg" style={display(36, '6.4vw', 80)}>{name}</h1></Reveal>
        <Reveal delay={160}>
          <p className="mt-6 flex flex-col gap-1 text-lg md:text-xl">
            <span className="text-balance text-fg-2">{lines[0]}</span>
            <span className="text-balance text-fg-3">{lines[1]}</span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/** One side of the platform split: each rule beside the API that carries it. */
export function SplitColumn({ title, items }: { title: string; items: Array<[string, string]> }) {
  return (
    <div className="flex flex-col gap-4">
      <h4 className="text-sm font-medium text-fg">{title}</h4>
      <ul className="flex flex-col edge-b">
        {items.map(([rule, api]) => (
          <li key={rule} className="flex items-baseline justify-between gap-4 py-2.5 edge-t">
            <span className="text-sm text-fg-2">{rule}</span>
            <Token className="shrink-0 text-fg-3">{api}</Token>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The generators that write a platform's values: command, source, the file it writes. */
export function GeneratedList({ rows }: { rows: Array<[command: string, source: string, target: string]> }) {
  return (
    <Frame className="flex flex-col p-6 max-md:p-4">
      {rows.map(([command, source, target], index) => (
        <div key={command} className={cn('grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.6fr)] items-baseline gap-4 py-3 max-md:grid-cols-1 max-md:gap-1', index > 0 && 'edge-t')}>
          <Token>{command}</Token>
          <Token className="text-fg-3">{source}</Token>
          <Token className="break-all text-fg-2">{target}</Token>
        </div>
      ))}
    </Frame>
  );
}

/** A Web component, the platform component that draws the same thing, and what that one must hold to. */
export interface ComponentPair { web: string; native: string; note?: string; added?: boolean }

/** The Web and one platform side by side, by family; a pair marked `added` has no platform component yet. */
export function PairTable({ platform, families, addedLabel }: { platform: string; families: Array<{ title: string; pairs: ComponentPair[] }>; addedLabel: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] table-fixed border-collapse text-sm">
        <colgroup><col className="w-[30%]" /><col className="w-[34%]" /><col /></colgroup>
        <thead>
          <tr className="text-left font-mono text-2xs text-fg-4">
            <th className="pb-3 pr-4 font-normal">Web</th>
            <th className="pb-3 pr-4 font-normal">{platform}</th>
            <th className="pb-3 font-normal" />
          </tr>
        </thead>
        <tbody>
          {families.map((family, index) => (
            <Fragment key={family.title}>
              <tr><td colSpan={3} className={cn('pb-2 text-xs font-medium text-fg-3', index ? 'pt-8' : 'pt-2')}>{family.title}</td></tr>
              {family.pairs.map((pair) => (
                <tr key={pair.web} className="edge-t">
                  <td className="py-2.5 pr-4 align-top"><Token className="text-fg-2">{pair.web}</Token></td>
                  <td className="py-2.5 pr-4 align-top">
                    <span className="flex flex-wrap items-baseline gap-2">
                      <Token>{pair.native}</Token>
                      {pair.added && <span className="rounded-xs px-1 text-2xs text-fg-3 shadow-[inset_0_0_0_1px_var(--line-strong)]">{addedLabel}</span>}
                    </span>
                  </td>
                  <td className="py-2.5 align-top text-fg-3">{pair.note}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
