import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Token } from './specimen';

/** A column of the table: one interface style; `tag` is said under its name (the main or default style). */
export interface CompareColumn { id: string; title: string; tag?: string }

export interface CompareRow {
  label: ReactNode;
  /** Under the label, in the secondary colour. */
  hint?: ReactNode;
  /** One cell per column, in the columns' order. */
  cells: ReactNode[];
  /** Compared by these keys: rows whose styles agree are set back, so the differences stand out. */
  keys?: Array<string | number>;
}

/** One column per style, rows grouped under small headings, ruled like a table in a book. With one style, `head` false leaves out the row naming it. */
export function CompareTable({ columns, groups, head = true }: { columns: readonly CompareColumn[]; groups: Array<{ title?: string; note?: ReactNode; rows: CompareRow[] }>; head?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] table-fixed border-collapse text-sm">
        <colgroup>
          <col className={columns.length > 4 ? 'w-[24%]' : 'w-[34%]'} />
          {columns.map((column) => <col key={column.id} />)}
        </colgroup>
        {head && <thead>
          <tr>
            <th />
            {columns.map((column) => (
              <th key={column.id} className="pb-3 pr-4 text-left font-normal">
                <span className="flex flex-col"><span className="font-medium text-fg">{column.title}</span>{column.title !== column.id && <Token className="text-2xs text-fg-4">{column.id}</Token>}</span>
                {column.tag && <span className="text-2xs text-fg-3">{column.tag}</span>}
              </th>
            ))}
          </tr>
        </thead>}
        <tbody>
          {groups.map((group, groupIndex) => (
            <Fragment key={groupIndex}>
              {group.title && (
                <tr>
                  <td colSpan={columns.length + 1} className={cn('pb-2 text-xs font-medium text-fg-3', groupIndex ? 'pt-8' : 'pt-2')}>
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
