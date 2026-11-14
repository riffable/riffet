import { Fragment, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { DesktopStyle } from '@contracts';
import { cn } from '@/lib/utils';
import { Token } from '../specimen';
import { useStyleNote } from './notes';

export interface CompareRow {
  label: ReactNode;
  /** Under the label, in the secondary colour. */
  hint?: ReactNode;
  /** One cell per style, in the styles' order. */
  cells: ReactNode[];
  /** Compared by these keys: rows whose styles agree are set back, so the differences stand out. */
  keys?: Array<string | number>;
}

/** One column per style, rows grouped under small headings, ruled like a table in a book. */
export function CompareTable({ styles, groups }: { styles: readonly DesktopStyle[]; groups: Array<{ title?: string; note?: ReactNode; rows: CompareRow[] }> }) {
  const { t } = useLingui();
  const note = useStyleNote();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] table-fixed border-collapse text-sm">
        <colgroup>
          <col className="w-[34%]" />
          {styles.map((style) => <col key={style.id} />)}
        </colgroup>
        <thead>
          <tr>
            <th />
            {styles.map((style) => {
              const { title, primary } = note(style);
              return (
                <th key={style.id} className="pb-3 pr-4 text-left font-normal">
                  <span className="flex items-baseline gap-2"><span className="font-medium text-fg">{title}</span><Token className="text-2xs text-fg-4">{style.id}</Token></span>
                  {primary && <span className="text-2xs text-fg-3">{t`主风格`}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {groups.map((group, groupIndex) => (
            <Fragment key={groupIndex}>
              {group.title && (
                <tr>
                  <td colSpan={styles.length + 1} className={cn('pb-2 text-xs font-medium text-fg-3', groupIndex ? 'pt-8' : 'pt-2')}>
                    {group.title}{group.note && <span className="ml-3 font-normal text-fg-4">{group.note}</span>}
                  </td>
                </tr>
              )}
              {group.rows.map((row, rowIndex) => {
                const same = row.keys ? new Set(row.keys.map(String)).size <= 1 : false;
                return (
                  <tr key={rowIndex} className="edge-t">
                    <td className="py-2.5 pr-4 align-top">
                      <span className="flex flex-col gap-0.5">
                        <span className="text-fg-2">{row.label}</span>
                        {row.hint && <span className="text-xs text-fg-4">{row.hint}</span>}
                      </span>
                    </td>
                    {row.cells.map((cell, cellIndex) => <td key={cellIndex} className={cn('py-2.5 pr-4 align-top', same ? 'text-fg-4' : 'text-fg')}>{cell}</td>)}
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
