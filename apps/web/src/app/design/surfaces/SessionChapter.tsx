import { useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { Run } from '@contracts';
import { IconFileText, IconGitBranch, IconSquareTerminal } from '@/components/icons';
import { Kbd, Spinner } from '@/components/ui/controls';
import { Button } from '@/components/ui/button';
import { RowOutcome } from '@/app/session/Activities';
import { MIN_CONTENT_WIDTH, MAX_CONTENT_WIDTH, DEFAULT_CONTENT_WIDTH } from '@/lib/content-width';
import { COLUMN_GUTTER_TOTAL, WIDTH_HANDLE_GAP, WIDTH_HANDLE_WIDTH } from '@/app/session/ContentWidthHandle';
import { Markdown } from '@/app/session/Markdown';
import { SESSION_ASIDE_MIN_WIDTH } from '@/app/session/sessionLayout';
import { AssistantMessage, BackgroundWorkIndicator, CodeBlock, DiffView, Disclosure, MessageFooter, StatusRow, ThoughtRow, UserMessage, WorkingIndicator } from '@/app/session/Timeline';
import { TurnProcess } from '@/app/session/TurnProcess';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Matrix, PaintRevision, Plate, Specimen, useRootValue, Value } from '../specimen';
import { AttachmentChip, ComposerCard, TriggerMenu } from './ComposerFigure';
import { Dim, Legend, Line, Mark } from './wire';

/** The reading column's text measure: the cap less the padding at 768 and up (`md:px-12` on both sides). */
const COLUMN_PADDING = 48;

/** A value read from the painted page once it has settled, for figures whose content mounts in effects. */
function useMeasured<T>(read: (root: HTMLElement) => T): [RefObject<HTMLDivElement | null>, T | undefined] {
  const ref = useRef<HTMLDivElement | null>(null);
  const revision = useContext(PaintRevision);
  const [value, setValue] = useState<T>();
  useEffect(() => {
    const timer = window.setTimeout(() => { if (ref.current) setValue(read(ref.current)); }, 400);
    return () => window.clearTimeout(timer);
  }, [revision]);
  return [ref, value];
}

function Structure() {
  const { t } = useLingui();
  const width = useRootValue('--content-width');
  const turn = useRootValue('--timeline-gap-turn');
  const answer = useRootValue('--timeline-gap-answer');
  const block = useRootValue('--timeline-gap-block');
  const tight = useRootValue('--timeline-gap-tight');
  const px = (value: string) => parseFloat(value) || 0;
  const reading = 89;
  return (
    <div className="flex flex-col gap-8">
      <Frame className="p-4 max-md:p-2">
        <div className="relative flex h-[27rem] flex-col overflow-hidden rounded-xl bg-bg shadow-[0_0_0_1px_var(--line)]">
          <div className="relative flex h-9 shrink-0 items-center gap-3 px-4">
            <Mark n={1} className="left-1 top-1" />
            <Line w="w-24" className="bg-fg-4" />
            <Line w="w-12" />
            <span className="ml-auto flex gap-2"><Line w="w-8" /><Line w="w-8" /></span>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="relative flex min-w-0 flex-1 flex-col">
              <div className="relative min-h-0 flex-1 overflow-hidden">
                <div className="relative mx-auto flex h-full flex-col gap-5 px-[5.2%] pt-6 outline-dashed outline-1 outline-line-strong" style={{ width: `${reading}%` }}>
                  <Mark n={2} className="-top-0.5 left-1" />
                  <Mark n={3} className="left-[1%] top-1/2" />
                  <Mark n={5} className="-right-2 top-12" />
                  <span aria-hidden className="absolute -left-4 top-1/3 h-16 w-1 rounded-full bg-line-strong" />
                  <Mark n={4} className="-left-8 top-1/3" />
                  <div className="flex justify-end"><span className="h-8 w-2/5 rounded-3xl bg-bubble" /></div>
                  <div className="flex flex-col gap-2"><Line /><Line w="w-5/6" /><Line w="w-2/3" /></div>
                  <div className="flex flex-col gap-1.5">
                    <span className="flex items-center gap-2"><span className="size-3 rounded-sm bg-line-strong" /><Line w="w-1/3" /></span>
                    <span className="flex items-center gap-2"><span className="size-3 rounded-sm bg-line-strong" /><Line w="w-1/2" /></span>
                  </div>
                  <div className="flex flex-col gap-2"><Line /><Line w="w-3/4" /></div>
                </div>
              </div>
              <div className="relative mx-auto w-full pb-4" style={{ width: `${reading}%` }}>
                <Mark n={6} className="-left-2 -top-2" />
                <div className="mx-[5.2%] h-16 rounded-2xl bg-elevated shadow-composer" />
              </div>
            </div>
            <div className="relative hidden w-[19%] shrink-0 flex-col gap-3 edge-l p-3 md:flex">
              <Mark n={7} className="left-1 top-1" />
              <Line w="w-2/3" className="mt-4" /><Line w="w-1/2" /><Line w="w-3/4" />
            </div>
          </div>
        </div>
      </Frame>
      <Legend items={[
        { n: 1, name: t`页头`, value: t`桌面 52，手机 48`, source: 'Header.tsx' },
        { n: 2, name: t`阅读列`, value: `${Number.parseFloat(width) || DEFAULT_CONTENT_WIDTH} · ${MIN_CONTENT_WIDTH}–${MAX_CONTENT_WIDTH}` + t`，含内边距`, source: '--content-width' },
        { n: 3, name: t`列内边距`, value: t`左右 12 · 16 · 48，顶 24 · 32，底 16`, source: 'TranscriptView.tsx' },
        { n: 4, name: t`宽度手柄`, value: t`宽 ${WIDTH_HANDLE_WIDTH}，距列 ${WIDTH_HANDLE_GAP}，向外拖动一像素列宽增加两像素`, source: 'ContentWidthHandle.tsx' },
        { n: 5, name: t`行距`, value: `${px(turn)} · ${px(answer)} · ${px(block)} · ${px(tight)}`, source: '--timeline-gap-*' },
        { n: 6, name: t`输入框列`, value: t`与阅读列同宽同轴，底 20（手机 12）`, source: 'ContentColumn' },
        { n: 7, name: t`侧列`, value: t`248，会话宽度 ≥ ${SESSION_ASIDE_MIN_WIDTH} 时出现`, source: 'sessionLayout.tsx' },
      ]} />
      <Matrix
        columns={[t`侧列`, t`轮次导航`, t`待办与目标`]}
        rows={[
          { label: `< ${SESSION_ASIDE_MIN_WIDTH}`, cells: [<Value key="a">none</Value>, <Value key="b">{t`贴在列边缘的导轨`}</Value>, <Value key="c">{t`输入框上方`}</Value>] },
          { label: `≥ ${SESSION_ASIDE_MIN_WIDTH}`, cells: [<Value key="a">column</Value>, <Value key="b">{t`侧列里的大纲`}</Value>, <Value key="c">{t`侧列`}</Value>] },
        ]}
      />
      <Dim>{t`会话宽度只决定这三项，不随内容变化`}</Dim>
    </div>
  );
}

// i18n-ignore: a sample document; mixed Han and Latin text is what the figure shows
const PROSE = `# 修复设置页的焦点顺序

焦点在弹窗关闭后回到了页面顶部。改为回到打开弹窗的按钮，并补上 Esc 的处理，参见 [WAI-ARIA 实践](https://www.w3.org/WAI/ARIA/apg/)。

## 做了什么

下面三项都在 \`apps/web\` 里完成，用 pnpm 运行 **Vitest** 后通过。

- 打开弹窗前记录触发元素
  - 关闭时把焦点还给它
  - 触发元素已被移除时回到页面标题
- 给 \`Dialog\` 补上 Esc 的处理
- 更新 3 个用例

### 结果对比

| 指标 | 修改前 | 修改后 |
|---|---|---|
| 焦点丢失 | 12 次 | 0 次 |
| 用例 | 41 | 44 |

> 弹窗里再开弹窗时，焦点按栈依次返回。

#### 命令

\`\`\`ts
const trigger = document.activeElement;
dialog.onClose(() => trigger?.focus());
\`\`\`

---

最后一行是普通段落，English 与中文混排，数字 1,234 与单位 ms 之间留半角空格。`;

interface ProseRow { name: string; size: string; line: string; weight: string; top: string; bottom: string }

const PROSE_PARTS: Array<[string, string]> = [
  ['h1', 'h1'], ['h2', 'h2'], ['h3', 'h3'], ['h4', 'h4'], ['p', 'p'], ['li', 'li'], ['code', 'p > code'],
  ['table', 'table'], ['blockquote', 'blockquote'], ['pre', '.md-code pre'], ['hr', 'hr'],
];

const round = (value: string) => String(Math.round(parseFloat(value) * 10) / 10);

function readProse(root: HTMLElement): { rows: ProseRow[]; codeFill: string; codeRadius: string } {
  const rows: ProseRow[] = [];
  for (const [name, selector] of PROSE_PARTS) {
    const node = root.querySelector(selector);
    if (!node) continue;
    const style = getComputedStyle(node);
    rows.push({ name, size: round(style.fontSize), line: style.lineHeight === 'normal' ? '–' : round(style.lineHeight), weight: style.fontWeight, top: round(style.marginTop), bottom: round(style.marginBottom) });
  }
  const code = root.querySelector('p > code');
  const style = code ? getComputedStyle(code) : undefined;
  return { rows, codeFill: style?.backgroundColor ?? '', codeRadius: style ? round(style.borderTopLeftRadius) : '' };
}

function Prose() {
  const { t } = useLingui();
  const [ref, measured] = useMeasured(readProse);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Frame className="p-8 max-md:p-5">
        <div ref={ref} className="mx-auto" style={{ maxWidth: DEFAULT_CONTENT_WIDTH - COLUMN_PADDING * 2 }}>
          <Markdown text={PROSE} />
        </div>
      </Frame>
      <div className="flex min-w-0 flex-col gap-6">
        <Matrix
          columns={[t`字号 / 行高`, t`字重`, t`上 / 下外距`]}
          rows={(measured?.rows ?? []).map((row) => ({
            label: row.name,
            cells: [<Value key="s">{row.size} / {row.line}</Value>, <Value key="w">{row.weight}</Value>, <Value key="m">{row.top} / {row.bottom}</Value>],
          }))}
        />
        <Dim>{t`px，随「文字大小」整体缩放`}</Dim>
      </div>
    </div>
  );
}

const ISO = '2026-11-14T09:41:00';

function Messages() {
  const { t } = useLingui();
  const resuming: Run = {
    id: 'resume-example', sessionId: 'design', commandId: 'resume-example',
    prompt: t`把设置页的焦点顺序修一下`, state: 'queued', createdAt: ISO, updatedAt: ISO,
    native: { input: { text: '', attachmentIds: [], context: [] }, config: { mode: 'agent' },
      fingerprint: 'design', delivery: 'preparing', stage: 'resuming', attempt: 1, configRevision: 0 },
  };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Frame className="flex flex-col gap-[var(--timeline-gap-turn)] p-8 max-md:p-5">
        <UserMessage text={t`把设置页的焦点顺序修一下`} attachments={[]} time={ISO} footerPinned />
        <AssistantMessage
          text={t`焦点在弹窗关闭后回到了页面顶部。已改为回到打开弹窗的按钮，并补上 Esc 的处理。`}
          showActions={false}
          time={ISO}
          footerPinned
          metrics={{ outputTokens: 2300, durationMs: 41000, tokens: 'provider', window: 'stream', steps: 3 }}
        />
        <UserMessage text={resuming.prompt} attachments={[]} time={ISO} run={resuming} footerPinned onCancelNativeRun={() => {}} />
      </Frame>
      <Matrix rows={[
        { label: t`用户消息`, cells: [<Value key="a">rounded-3xl · px 16 · py 10 · bg-bubble</Value>, <Value key="b">max-w min(82%, 560px)</Value>] },
        { label: t`用户元信息`, cells: [<Value key="a">text-2xs · text-fg-3 · {t`右对齐`}</Value>] },
        { label: t`回答`, cells: [<Value key="a">{t`无气泡，占满阅读列`}</Value>] },
        { label: t`回答脚注`, cells: [<Value key="a">min-h 36 · text-2xs · {t`时间 · tok/s`}</Value>, <Value key="b">{t`估算值前缀 ~，字色 fg-4`}</Value>] },
        { label: t`显示时机`, cells: [<Value key="a">{t`指针停留 500 ms，触屏常显`}</Value>] },
      ]} />
    </div>
  );
}

function Row({ open: initial = false, ...props }: Omit<Parameters<typeof Disclosure>[0], 'open' | 'onToggle'> & { open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return <Disclosure {...props} open={open} onToggle={() => setOpen(!open)} />;
}

function Tools() {
  const { t } = useLingui();
  const following = useRef(true);
  const [started] = useState(() => Date.now() - 12_000);
  const cell = (node: ReactNode) => <div className="w-full min-w-0 max-w-xl">{node}</div>;
  const inner = (
    <>
      <Row touchCompact icon={<IconFileText />} title={<span className="font-mono text-xs">Read</span>} detail="apps/web/src/app/session/Timeline.tsx" />
      <Row touchCompact icon={<IconSquareTerminal />} title={<span className="font-mono text-xs">pnpm vitest run settings</span>}>{null}</Row>
    </>
  );
  return (
    <div className="flex flex-col gap-10">
      <Frame className="p-8 max-md:p-5">
        <Matrix rows={[
          { label: t`折叠`, cells: [cell(<Row touchCompact icon={<IconFileText />} title={<span className="font-mono text-xs">Read</span>} detail="apps/web/src/app/session/Timeline.tsx" />)] },
          { label: t`展开`, cells: [cell(<Row open touchCompact icon={<IconSquareTerminal />} title={<span className="font-mono text-xs">pnpm vitest run settings</span>}><CodeBlock className="text-fg" copy="pnpm vitest run settings"><span className="select-none text-fg-4">$ </span>pnpm vitest run settings</CodeBlock><CodeBlock copy="12 passed">{'✓ settings/focus.test.ts (12)\nTest Files  1 passed'}</CodeBlock></Row>)] },
          { label: t`进行中`, cells: [cell(<Row touchCompact icon={<Spinner className="size-3.5" />} title={<span className="font-mono text-xs">pnpm build</span>} expandable={false} />)] },
          { label: t`带改动统计`, cells: [cell(<Row touchCompact icon={<IconGitBranch />} title={<span className="font-mono text-xs">Edit</span>} detail="Dialog.tsx" inline={<span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums"><span className="text-[var(--diff-add-marker)]">+12</span><span className="text-[var(--diff-del-marker)]">−3</span></span>} />)] },
          { label: t`失败`, cells: [cell(<Row touchCompact icon={<IconSquareTerminal />} title={<span className="font-mono text-xs">pnpm lint</span>} inline={<RowOutcome failed />} />)] },
          { label: t`未完成`, cells: [cell(<Row touchCompact icon={<IconSquareTerminal />} title={<span className="font-mono text-xs">pnpm test</span>} inline={<RowOutcome />} />)] },
          { label: t`思考`, cells: [cell(<ThoughtRow channel="thinking" text={t`先确认焦点是在关闭时丢失，还是在打开时没有记录触发元素。`} />)] },
          { label: t`旁白`, cells: [cell(<ThoughtRow channel="narration" text={t`先看关闭弹窗时焦点去了哪里。`} />)] },
        ]} />
      </Frame>
      <div className="grid gap-6 md:grid-cols-2">
        <Specimen name={t`进行中`} prop="TurnProcess running">
          <div className="w-full"><TurnProcess running issueCount={0} interrupted={false} startedAt={started} following={following}>{inner}</TurnProcess></div>
        </Specimen>
        <Specimen name={t`已结束`} prop="TurnProcess">
          <div className="w-full"><TurnProcess running={false} issueCount={0} interrupted={false} choice={false} startedAt={Date.now() - 101_000} endedAt={Date.now()} footerTime={ISO} footerPinned following={following}>{inner}</TurnProcess></div>
        </Specimen>
      </div>
    </div>
  );
}

const SWATCHES: Array<[string, string, string]> = [
  ['--diff-add', 'bg-[var(--diff-add)]', 'bg-[var(--diff-del)]'],
  ['--diff-add-gutter', 'bg-[var(--diff-add-gutter)]', 'bg-[var(--diff-del-gutter)]'],
  ['--diff-add-marker', 'bg-[var(--diff-add-marker)]', 'bg-[var(--diff-del-marker)]'],
  ['--diff-add-strong', 'bg-[var(--diff-add-strong)]', 'bg-[var(--diff-del-strong)]'],
];

function Code() {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-10">
      <div className="grid gap-6 md:grid-cols-2">
        <Specimen name="CodeBlock" prop={t`工具输出`}>
          <div className="w-full">
            <CodeBlock copy="pnpm vitest run" maxHeight="max-h-40"><span className="select-none text-fg-4">$ </span>{'pnpm vitest run\n✓ settings/focus.test.ts (12)\n✓ dialog/escape.test.ts (3)\nTest Files  2 passed'}</CodeBlock>
          </div>
        </Specimen>
        <Specimen name=".md-code" prop={t`回答里的围栏`}>
          <div className="w-full"><Markdown text={'```ts\nconst trigger = document.activeElement;\ndialog.onClose(() => trigger?.focus());\n```'} /></div>
        </Specimen>
      </div>
      <Frame className="p-8 max-md:p-5">
        <div className="mx-auto max-w-2xl">
          <DiffView path="apps/web/src/lib/focus.ts" before={'export function restore(el) {\n  window.scrollTo(0, 0);\n}\n'} after={'export function restore(el) {\n  el?.focus();\n}\n'} />
        </div>
      </Frame>
      <Matrix
        columns={[t`添加`, t`删除`]}
        rows={SWATCHES.map(([token, add, del]) => ({
          label: token.replace('add', '*'),
          cells: [
            <span key="a" className="flex items-center gap-3"><span className={cn('size-6 rounded-md shadow-[0_0_0_1px_var(--line)]', add)} /><Value>{token}</Value></span>,
            <span key="d" className="flex items-center gap-3"><span className={cn('size-6 rounded-md shadow-[0_0_0_1px_var(--line)]', del)} /><Value>{token.replace('add', 'del')}</Value></span>,
          ],
        }))}
      />
    </div>
  );
}

function ApprovalCard({ long = false }: { long?: boolean }) {
  const { t } = useLingui();
  const command = long
    ? `rm -rf ${Array.from({ length: 14 }, (_, index) => `/Users/dev/workspace/riffet/apps/web/dist/assets/chunk-${index}.js`).join(' \\\n  ')}` // privacy: allow placeholder path in a specimen command
    : 'pnpm vitest run settings';
  return (
    <article className="rounded-xl bg-subtle/45 px-3 py-2.5">
      <header className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{t`运行命令`}</h3>
        <span className="shrink-0 text-xs text-fg-3">Esc {t`拒绝`}</span>
      </header>
      <div className="mt-2 flex flex-col gap-2">
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto overscroll-contain rounded-md bg-bg px-2 py-1.5 font-mono text-xs leading-5 text-fg-2 whitespace-pre-wrap break-words">
          <p>{command}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-1.5">
        {[t`允许一次`, t`本会话内允许此类命令`, t`拒绝`].map((label, index) => (
          <Button key={label} size="sm" variant={index === 0 ? 'primary' : index === 2 ? 'danger' : 'secondary'} className="h-auto min-h-9 w-full justify-start whitespace-normal px-3 py-2 text-left text-sm break-words">
            <span className="min-w-0 flex-1">{label}</span>
            <Kbd className="bg-transparent text-current opacity-60">{index + 1}</Kbd>
          </Button>
        ))}
      </div>
    </article>
  );
}

function Approvals() {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-6 md:grid-cols-2">
        <Specimen name={t`摘要`} prop="NativeInteractionCard"><div className="w-full max-w-md"><ApprovalCard /></div></Specimen>
        <Specimen name={t`长内容`} prop="max-h-72"><div className="w-full max-w-md"><ApprovalCard long /></div></Specimen>
      </div>
      <Matrix rows={[
        { label: t`标题`, cells: [<Value key="a">truncate · text-sm · 500</Value>] },
        { label: t`正文`, cells: [<Value key="a">max-h-72 · overflow-y-auto · font-mono text-xs / 20</Value>] },
        { label: t`选项`, cells: [<Value key="a">Button sm · min-h 36 · {t`原文换行，不截断`}</Value>] },
        { label: t`快捷键`, cells: [<Value key="a">{t`数字键 1–9，卡片获得焦点时显示；Esc 拒绝`}</Value>] },
      ]} />
    </div>
  );
}

function States() {
  const { t } = useLingui();
  const following = useRef(true);
  const [started] = useState(() => Date.now() - 83_000);
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Specimen name={t`处理中`} prop="WorkingIndicator">
        <div className="w-full"><WorkingIndicator startedAt={started} /></div>
      </Specimen>
      <Specimen name={t`后台运行中`} prop="BackgroundWorkIndicator">
        <div className="w-full"><BackgroundWorkIndicator agents={3} onOpen={() => {}} /></div>
      </Specimen>
      <Specimen name={t`已停止`} prop="stopped">
        <div className="flex w-full flex-col">
          <TurnProcess running={false} issueCount={0} interrupted stopped choice={false} startedAt={Date.now() - 101_000} endedAt={Date.now()} following={following}>{null}</TurnProcess>
          <MessageFooter showActions={false} time={ISO} stopped footerPinned />
        </div>
      </Specimen>
      <Specimen name={t`失败`} prop="StatusRow danger">
        <div className="w-full"><StatusRow tone="danger" text={t`上游服务暂时不可用，请稍后重试`} /></div>
      </Specimen>
    </div>
  );
}

function Composer() {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-10">
      <Frame className="flex flex-col gap-8 p-8 max-md:p-5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          <TriggerMenu kind="slash" heading={t`命令与 Skills`} rows={[{ name: '/review', hint: t`审查当前改动`, active: true }, { name: '/compact', hint: t`压缩上下文` }, { name: '/init', hint: t`生成 AGENTS.md` }]} className="w-72" />
          <ComposerCard
            placeholder={t`输入消息…`}
            draft={t`把设置页的焦点顺序再核对一遍`}
            rail={<div className="flex flex-wrap gap-1.5 px-3 pt-3"><AttachmentChip name="focus-trace.png" /><AttachmentChip name="settings.log" state="uploading" /></div>}
          />
        </div>
      </Frame>
      <Matrix
        columns={['dock', 'hero', 'embedded', 'compact']}
        rows={[
          { label: t`文本区下限`, cells: [<Value key="a">52</Value>, <Value key="b">76</Value>, <Value key="c">52</Value>, <Value key="d">44</Value>] },
          { label: t`自动增高上限`, cells: [<Value key="a">240</Value>, <Value key="b">320</Value>, <Value key="c">120</Value>, <Value key="d">–</Value>] },
          { label: t`表面`, cells: [<Value key="a">shadow-composer</Value>, <Value key="b">shadow-composer</Value>, <Value key="c">border-line</Value>, <Value key="d">{t`手机，未聚焦`}</Value>] },
        ]}
      />
      <div className="grid gap-6 md:grid-cols-2">
        <Specimen name="dock" prop="rounded-2xl"><div className="w-full"><ComposerCard placeholder={t`输入消息…`} /></div></Specimen>
        <Specimen name="hero" prop="min-h 76"><div className="w-full"><ComposerCard shape="hero" placeholder={t`描述任务…`} /></div></Specimen>
        <Specimen name="embedded" prop="rounded-xl"><div className="w-full"><ComposerCard shape="embedded" placeholder={t`输入消息…`} /></div></Specimen>
        <Specimen name="compact" prop="running"><div className="w-full"><ComposerCard shape="compact" placeholder={t`输入消息…`} running /></div></Specimen>
      </div>
      <Matrix rows={[
        { label: t`卡片`, cells: [<Value key="a">bg-elevated · {t`圆角`} 16 · shadow-composer / -focus</Value>] },
        { label: t`文本区`, cells: [<Value key="a">px 16 · text-base / leading-6</Value>] },
        { label: t`工具行`, cells: [<Value key="a">px 8 · pt 4 · pb 8 · gap 4</Value>] },
        { label: t`左侧按钮`, cells: [<Value key="a">28 · {t`图标`} 18</Value>] },
        { label: t`模型`, cells: [<Value key="a">h 28 · rounded-full · text-sm · fg-3</Value>] },
        { label: t`发送`, cells: [<Value key="a">32 · rounded-full · primary</Value>, <Value key="b">{t`禁用 8% 墨色`}</Value>] },
      ]} />
    </div>
  );
}

export function SessionChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`会话`} lede={t`一条纵向的阅读列，输入框在它下方。回答是正文，过程可折叠，结果独立于过程。`} tone="canvas" source="apps/web/src/app/session/">
      <Plate number={1} title={t`结构`} note={t`阅读列、输入框和侧列共用一个宽度上限与一条轴线。`}><Structure /></Plate>
      <Plate number={2} title={t`正文排版`} note={t`回答用 .md 排版；数值取自此刻渲染的页面。`}><Prose /></Plate>
      <Plate number={3} title={t`消息`}><Messages /></Plate>
      <Plate number={4} title={t`工具调用与过程`} note={t`一行一个动作；过程组在回合结束后折叠。`}><Tools /></Plate>
      <Plate number={5} title={t`代码与 diff`}><Code /></Plate>
      <Plate number={6} title={t`审批与交互`}><Approvals /></Plate>
      <Plate number={7} title={t`回合状态`}><States /></Plate>
      <Plate number={8} title={t`输入框`} note={t`实底卡片，与转录同宽同轴；悬浮玻璃只用于移动端。`}><Composer /></Plate>
    </Chapter>
  );
}
