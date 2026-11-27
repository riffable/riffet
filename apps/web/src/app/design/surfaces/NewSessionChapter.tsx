import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { AgentMark } from '@/components/agent-marks';
import { IconCheck, IconChevronRight, IconColumns2, IconFolderClosed, IconHistory, IconSquareTerminal, IconTerminal } from '@/components/icons';
import { StatusDot } from '@/components/ui/controls';
import { menuSurface } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Matrix, Plate, Specimen, Value } from '../specimen';
import { ComposerCard } from './ComposerFigure';
import { Legend, Line, Mark } from './wire';

/** The project chip above the composer: the one choice that cannot change after the session starts. */
function ProjectChip({ name }: { name: string }) {
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg px-2 text-xs text-fg-2">
      <IconFolderClosed className="size-3.5 shrink-0 text-fg-3" />
      <span className="min-w-0 truncate font-medium">{name}</span>
    </span>
  );
}

/** A start-page shortcut, drawn from `QuickAction` in `ProjectHome.tsx`. */
function QuickAction({ icon, title, note }: { icon: ReactNode; title: string; note?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-3 rounded-xl border border-line bg-elevated px-3.5 py-3 text-left">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-fg-2 [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-fg">{title}</span>
        {note && <span className="truncate text-xs text-fg-3">{note}</span>}
      </span>
    </span>
  );
}

function Structure() {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-8">
      <Frame className="p-4 max-md:p-2">
        <div className="relative flex h-[27rem] flex-col overflow-hidden rounded-xl bg-bg shadow-[0_0_0_1px_var(--line)]">
          <div className="flex h-9 shrink-0 items-center gap-3 px-4"><Line w="w-24" className="bg-fg-4" /></div>
          <div className="relative mx-auto flex w-3/5 min-w-[16rem] flex-col items-center gap-3 pt-10 max-md:w-4/5">
            <Mark n={1} className="-left-6 top-10" />
            <span className="size-10 rounded-full bg-line-strong" />
            <Mark n={2} className="-left-6 top-24" />
            <Line w="w-2/3" className="h-3 bg-fg-4" />
            <div className="relative mt-3 flex w-full flex-col gap-1.5">
              <Mark n={3} className="-left-6 top-0" />
              <span className="h-3 w-16 rounded-md bg-muted" />
              <Mark n={4} className="-left-6 top-6" />
              <div className="h-20 w-full rounded-2xl bg-elevated shadow-composer" />
            </div>
            <div className="relative mt-6 grid w-full grid-cols-3 gap-2">
              <Mark n={5} className="-left-6 top-0" />
              {[0, 1, 2].map((index) => <span key={index} className="h-10 rounded-xl border border-line bg-elevated" />)}
            </div>
          </div>
        </div>
      </Frame>
      <Legend items={[
        { n: 1, name: t`内容列`, value: t`最大宽 720，左右 32（手机 16），顶 max(48, 14vh)，底 64`, source: 'ProjectHome.tsx' },
        { n: 2, name: t`标志与标题`, value: t`标志 64（手机 48）· 标题 text-2xl 600`, source: 'LiveBrandMark' },
        { n: 3, name: t`项目`, value: t`高 28 · text-xs，会话开始后不能更改`, source: 'NewSessionComposer' },
        { n: 4, name: t`输入框`, value: t`hero，文本区下限 76，居中`, source: 'Composer variant="hero"' },
        { n: 5, name: t`入口`, value: t`三列卡片，手机折叠为一行标题`, source: 'QuickAction' },
      ]} />
    </div>
  );
}

const COLUMN = 'flex shrink-0 flex-col gap-0.5 overflow-y-auto overscroll-contain edge-r p-1';
const ROW = (shown: boolean) => cn('flex h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm [&_svg]:shrink-0', shown ? 'bg-hover text-fg' : 'text-fg-2');

/** The model menu on the start page: agent, provider, model, each its own column; parameters and quota below. */
function ModelMenu({ agents, providers, models }: { agents: Array<[string, string]>; providers: string[]; models: Array<[string, string?]> }) {
  return (
    <div className={cn(menuSurface, 'flex max-h-[26rem] w-[660px] max-w-full flex-col p-0')}>
      <div className="flex min-h-0 flex-row">
        <div className={cn(COLUMN, 'w-44')}>
          {agents.map(([id, label], index) => (
            <span key={id} className={ROW(index === 0)}><AgentMark backend={id} size={14} /><span className="min-w-0 flex-1 truncate">{label}</span>{index === 0 && <IconCheck className="size-3.5 text-fg-2" />}</span>
          ))}
        </div>
        <div className={cn(COLUMN, 'w-40')}>
          {providers.map((label, index) => <span key={label} className={ROW(index === 0)}><span className="min-w-0 flex-1 truncate">{label}</span>{index === 0 && <IconCheck className="size-3.5 text-fg-2" />}</span>)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1">
          {models.map(([label, quota], index) => (
            <span key={label} className={ROW(index === 1)}>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {quota && <span className="shrink-0 text-2xs tabular-nums text-fg-4">{quota}</span>}
              {index === 1 && <IconCheck className="size-3.5 text-fg-2" />}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-3 edge-t bg-subtle/60 px-3 py-3">
        <div className="flex min-h-6 items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-2">Effort</span>
          <span className="text-xs text-fg-3">High</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="flex min-h-5 items-baseline gap-1.5">
            <span className="truncate text-xs font-medium text-fg-2">Quota left</span>
            <span className="truncate text-2xs text-fg-3">All models</span>
          </span>
          <div className="flex flex-col gap-1 text-xs tabular-nums">
            <div className="flex min-h-5 items-baseline justify-between gap-3">
              <span className="text-fg-3">5h</span>
              <span className="flex shrink-0 items-baseline gap-2.5">
                <span className="text-2xs text-fg-4">Resets in 2 hr</span>
                <span className="min-w-9 text-right font-medium text-fg-2">100%</span>
              </span>
            </div>
            <div className="flex min-h-5 items-baseline justify-between gap-3">
              <span className="text-fg-3">Weekly</span>
              <span className="flex shrink-0 items-baseline gap-2.5">
                <span className="text-2xs text-fg-4">Resets Sun 09:00</span>
                <span className="min-w-9 text-right font-medium text-warning">12%</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Start() {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-8">
      <Frame className="flex flex-col items-center gap-3 p-8 max-md:p-4">
        <div className="flex w-full max-w-[720px] flex-col gap-1.5">
          <ProjectChip name="riffet" />
          <ComposerCard shape="hero" placeholder={t`描述任务…`} model="Opus 5.5 · high" leadingModel />
        </div>
        {/* design-rules: allow the menu starts 2px left of the button so both agent marks share one line */}
        <div className="w-full max-w-[720px] overflow-x-auto pb-1 pl-[38px]">
          <ModelMenu
            agents={[['claude', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor']]}
            providers={['Anthropic', 'Relay']}
            models={[['Fable 5.2', '90% left'], ['Opus 5.5'], ['Sonnet 5.5'], ['Haiku 5.5']]}
          />
        </div>
      </Frame>
      <Matrix
        columns={[t`宽度`, t`滚动`]}
        rows={[
          { label: t`Agent`, cells: [<Value key="w">176</Value>, <Value key="s">{t`各栏独立`}</Value>] },
          { label: t`提供商`, cells: [<Value key="w">160</Value>, <Value key="s">{t`各栏独立`}</Value>] },
          { label: t`模型`, cells: [<Value key="w">flex</Value>, <Value key="s">{t`各栏独立`}</Value>] },
          { label: t`整体`, cells: [<Value key="w">660 · {t`无提供商栏时`} 500</Value>, <Value key="s">max-h min(64dvh, 420)</Value>] },
        ]}
      />
    </div>
  );
}

function Entries() {
  const { t } = useLingui();
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Specimen name={t`快捷入口`} prop="QuickAction">
        <div className="grid w-full gap-2">
          <QuickAction icon={<IconTerminal />} title="Shell" />
          <QuickAction icon={<IconColumns2 />} title={t`并行尝试`} note={t`各自在独立 Worktree`} />
          <QuickAction icon={<IconHistory />} title={t`继续终端会话`} />
        </div>
      </Specimen>
      <Specimen name={t`最近会话`} prop={t`仅手机`}>
        <div className="flex w-full flex-col">
          {[[t`修复设置页的焦点顺序`, 'accent', 'Claude Code', t`2 分钟前`], [t`整理发布说明`, 'idle', 'Codex', t`昨天`]].map(([title, tone, agent, when]) => (
            <span key={title} className="flex h-10 items-center gap-3 rounded-lg px-2 text-sm">
              {tone === 'accent' ? <StatusDot className="mx-[5px]" tone="accent" /> : <IconSquareTerminal className="size-4 shrink-0 text-fg-4" />}
              <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
              <span className="shrink-0 text-xs text-fg-3">{agent}</span>
              <span className="shrink-0 text-xs text-fg-3">{when}</span>
              <IconChevronRight className="size-4 shrink-0 text-fg-4 opacity-0" />
            </span>
          ))}
        </div>
      </Specimen>
    </div>
  );
}

export function NewSessionChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`新会话`} lede={t`项目主页也是起始页：输入框居中，一次选好项目、Agent 与模型。`} tone="canvas" source="apps/web/src/app/ProjectHome.tsx">
      <Plate number={1} title={t`结构`} note={t`内容列 720，输入框居中，宽度跟随输入框；页面骨架的例外。`}><Structure /></Plate>
      <Plate number={2} title={t`起始输入与模型菜单`} note={t`桌面端 Agent 并入模型菜单，按钮在工具行最前，菜单从它向右展开；手机的设置弹层里仍有 Agent 一行。`}><Start /></Plate>
      <Plate number={3} title={t`入口与最近会话`}><Entries /></Plate>
    </Chapter>
  );
}
