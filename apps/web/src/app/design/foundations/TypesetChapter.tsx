import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconCheck, IconX } from '@/components/icons';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Plate, Token } from '../specimen';

/** A rule as a pair: the way it is set, and the way it is not. */
export function Rule({ title, good, bad, struck = true, className }: { title: ReactNode; good: ReactNode; bad: ReactNode; struck?: boolean; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-5 edge-t pt-4', className)}>
      <span className="text-sm text-fg-3">{title}</span>
      <div className="flex min-w-0 items-start gap-3 text-lg text-fg"><IconCheck className="mt-1.5 size-4 shrink-0 text-fg-3" /><div className="min-w-0 flex-1">{good}</div></div>
      <div className="flex min-w-0 items-start gap-3 text-lg text-fg-4"><IconX className="mt-1.5 size-4 shrink-0" /><div className={cn('min-w-0 flex-1', struck && 'line-through decoration-1')}>{bad}</div></div>
    </div>
  );
}

/** A fixed measure, so truncation and wrapping have something to run out of. */
function Measure({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex w-60 max-w-full items-center rounded-lg bg-elevated px-2.5 py-1.5 text-sm text-fg shadow-[0_0_0_1px_var(--line)]', className)}>{children}</div>;
}

const FILE = 'TypesetChapter.tsx';
const DIRECTORY = 'apps/web/src/app/design/foundations/';
const URL_TEXT = 'https://github.com/riffable/riffet/pull/128/files?diff=split&w=1';

/** A path cut in the middle: the head gives way, the file name stays. */
function MiddlePath() {
  return (
    <Tip label={DIRECTORY + FILE} side="top">
      <span className="flex min-w-0 flex-1 font-mono text-sm text-fg"><span className="truncate">{DIRECTORY}</span><span className="shrink-0">{FILE}</span></span>
    </Tip>
  );
}

const DIGITS = ['1,111', '8,888', '2,046', '11,711', '100'];

function Column({ label, className }: { label: string; className?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <Token className="text-fg-3">{label}</Token>
      <div className={cn('flex w-28 flex-col items-end gap-1 text-2xl text-fg', className)}>
        {DIGITS.map((digits) => <span key={digits}>{digits}</span>)}
      </div>
    </div>
  );
}

export function TypesetChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`排版`} lede={t`中西文混排遵循 W3C《中文排版需求》。文案里的标点、数字、截断和换行按下面的写法处理。`} tone="canvas" source="docs/design/system/foundations.md">
      <Plate number={1} title={t`中英混排`} note={t`中文与拉丁字母、数字之间加一个半角空格；紧挨全角标点的一侧不加。`}>
        <div className="grid gap-x-8 gap-y-10 md:grid-cols-3">
          <Rule title={t`中文与英文`} good={t`运行 Codex，改了文件`} bad={t`运行Codex，改了文件`} />
          <Rule title={t`中文与数字`} good={t`改了 3 个文件`} bad={t`改了3个文件`} />
          <Rule title={t`全角标点旁`} good={t`先运行 Codex，再提交。`} bad={t`先运行 Codex ，再提交 。`} />
        </div>
      </Plate>
      <Plate number={2} title={t`标点与间隔号`} note={t`中文用全角标点；并列的元信息用前后带空格的间隔号分开；省略号是单字符。`}>
        <div className="grid gap-x-8 gap-y-10 md:grid-cols-3">
          <Rule title={t`并列的元信息`} good={t`已处理 · 1m 41s`} bad={t`已处理 | 1m 41s`} />
          <Rule title={t`省略`} good={t`正在读取…`} bad={t`正在读取...`} />
          <Rule title={t`语气`} good={t`已保存`} bad={t`已保存！`} />
        </div>
      </Plate>
      <Plate number={3} title={t`等宽数字`} note={t`会变化的数字和表格列用等宽数字，位数对齐，数值变化时不抖动。`}>
        <Frame className="flex flex-wrap gap-x-16 gap-y-8 p-10 max-md:gap-x-8 max-md:p-6">
          <Column label="tabular-nums" className="tabular-nums" />
          <Column label="proportional-nums" className="[font-variant-numeric:proportional-nums] text-fg-3" />
        </Frame>
      </Plate>
      <Plate number={4} title={t`截断`} note={t`单行标签截尾；路径截中间，保留文件名；截断的文字在悬停时给出全文。`}>
        <div className="grid gap-x-8 gap-y-10 md:grid-cols-2">
          <Rule
            title={t`单行标签`}
            good={<Tip label={t`修复设置页弹窗关闭后焦点回到页面顶部的问题`} side="top"><Measure><span className="truncate">{t`修复设置页弹窗关闭后焦点回到页面顶部的问题`}</span></Measure></Tip>}
            bad={<Measure className="overflow-hidden"><span className="whitespace-nowrap">{t`修复设置页弹窗关闭后焦点回到页面顶部的问题`}</span></Measure>}
          />
          <Rule
            title={t`路径`}
            good={<Measure><MiddlePath /></Measure>}
            bad={<Measure><span className="truncate font-mono">{DIRECTORY + FILE}</span></Measure>}
          />
        </div>
      </Plate>
      <Plate number={5} title={t`换行`} note={t`长 URL、路径、无空格的英文串允许在任意处断行。`}>
        <div className="grid gap-x-8 gap-y-10 md:grid-cols-2">
          <Rule title={<Token className="text-fg-3">overflow-wrap: anywhere</Token>} good={<Measure className="font-mono"><span className="[overflow-wrap:anywhere]">{URL_TEXT}</span></Measure>} bad={<Measure className="overflow-hidden font-mono"><span className="whitespace-nowrap">{URL_TEXT}</span></Measure>} />
        </div>
      </Plate>
      <Plate number={6} title={t`行高`} note={t`多行中文段落不低于 1.5 倍；单行控件的文字在容器里垂直居中。`}>
        <div className="grid gap-x-8 gap-y-10 md:grid-cols-2">
          <Rule
            struck={false}
            title={<Token className="text-fg-3">text-base · 14 / 23</Token>}
            good={<p className="max-w-72 text-base text-fg">{t`焦点在弹窗关闭后回到了页面顶部。改为回到打开弹窗的按钮，并补上 Esc 的处理。`}</p>}
            bad={<p className="max-w-72 text-base leading-tight">{t`焦点在弹窗关闭后回到了页面顶部。改为回到打开弹窗的按钮，并补上 Esc 的处理。`}</p>}
          />
          <Rule
            struck={false}
            title={<Token className="text-fg-3">h-8 · items-center</Token>}
            good={<span className="inline-flex h-8 items-center rounded-lg bg-fg/[0.07] px-3 text-sm font-medium text-fg">{t`保存`}</span>}
            bad={<span className="inline-flex h-8 items-start rounded-lg bg-fg/[0.07] px-3 text-sm font-medium">{t`保存`}</span>}
          />
        </div>
      </Plate>
      <Plate number={7} title={t`选中`} note={t`内容可以选中复制；界面文字和元信息不可选，光标保持箭头。`}>
        <div className="grid gap-6 md:grid-cols-2">
          <Frame className="flex flex-col gap-4 p-8 max-md:p-5">
            <Token className="text-fg-3">select-text · cursor-text</Token>
            <p className="cursor-text select-text font-mono text-sm text-fg">ENOENT: no such file or directory, open &apos;package.json&apos;</p>
            <span className="text-xs text-fg-3">{t`正文、代码、错误原因`}</span>
          </Frame>
          <Frame className="flex flex-col gap-4 p-8 max-md:p-5">
            <Token className="text-fg-3">select-none · cursor-default</Token>
            <p className="cursor-default select-none text-sm text-fg">{t`会话信息`} <span className="text-xs text-fg-3">· 12:40</span></p>
            <span className="text-xs text-fg-3">{t`标签、元信息、按钮文字`}</span>
          </Frame>
        </div>
      </Plate>
    </Chapter>
  );
}
