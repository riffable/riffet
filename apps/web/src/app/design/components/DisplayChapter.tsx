import { useLingui } from '@lingui/react/macro';
import { IconSlash, IconSparkles, IconX } from '@/components/icons';
import { AgentMark } from '@/components/agent-marks';
import { OwnerAvatar } from '@/components/OwnerAvatar';
import { Badge, Kbd, StatusDot } from '@/components/ui/controls';
import { CodeBlock } from '@/app/session/Timeline';
import { Markdown } from '@/app/session/Markdown';
import { Chapter, Family, Frame, Matrix, Plate, Specimen } from '../specimen';

const TONES = ['neutral', 'accent', 'success', 'warning', 'danger'] as const;
const DOTS = ['idle', 'accent', 'success', 'warning', 'danger'] as const;
const BACKENDS = [['claude', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['dsh', 'DeepSeek'], ['droid', 'Droid'], ['pi', 'pi'], ['traex', 'TRAE CLI'], ['antigravity', 'Antigravity']] as const;
const FENCE = '```ts\nconst timeout = REQUEST_TIMEOUT_MS;\nawait fetch(url, { signal });\n```';
const OUTPUT = 'src/app/design/catalog.tsx\nsrc/app/design/specimen.tsx\n3 files changed';

export function DisplayChapter() {
  const { t } = useLingui();
  const badge: Record<(typeof TONES)[number], string> = { neutral: t`已归档`, accent: t`新`, success: t`已完成`, warning: t`等待确认`, danger: t`失败` };
  return (
    <Chapter title={t`展示`} lede={t`只呈现信息、不接受操作的元素。颜色只在表示状态时使用。`} source="apps/web/src/components/ui/controls.tsx">
      <Family title="Badge">
        <Specimen name={t`语气`} prop="tone" note={t`文字说明状态；颜色只是补充。`}>
          <div className="flex flex-wrap justify-center gap-2">{TONES.map((tone) => <Badge key={tone} tone={tone}>{badge[tone]}</Badge>)}</div>
        </Specimen>
      </Family>
      <Family title="StatusDot">
        <Specimen name={t`语气与形状`} prop="tone · shape · pulse" note={t`同色的两种状态靠实心与空心区分；脉动用于仍在进行的状态和等待用户处理。`} wide>
          <div className="w-full">
            <Matrix
              columns={['dot', 'ring', 'pulse']}
              rows={DOTS.map((tone) => ({ label: tone, cells: [<StatusDot key="a" tone={tone} label={tone} />, <StatusDot key="b" tone={tone} shape="ring" label={tone} />, <StatusDot key="c" tone={tone} pulse label={tone} />] }))}
            />
          </div>
        </Specimen>
      </Family>
      <Family title="Kbd">
        <Specimen name={t`快捷键`} note={t`每个键一枚。`}>
          <span className="flex gap-1"><Kbd>⌘</Kbd><Kbd>⇧</Kbd><Kbd>P</Kbd></span>
          <span className="flex gap-1"><Kbd>Esc</Kbd></span>
        </Specimen>
      </Family>
      <Family title="AgentMark · AgentLogo">
        <Specimen name={t`全部后端`} prop="backend · size" note={t`AgentLogo 在内置 id 上等同 AgentMark，插件 Agent 画它声明的 SVG。`} wide>
          <div className="grid w-full grid-cols-4 gap-x-4 gap-y-6 max-md:grid-cols-2">
            {BACKENDS.map(([id, name]) => (
              <div key={id} className="flex flex-col items-center gap-2.5">
                <span className="flex items-end gap-3 text-fg"><AgentMark backend={id} size={14} /><AgentMark backend={id} size={20} /><AgentMark backend={id} size={28} /></span>
                <span className="text-xs text-fg-3">{name}</span>
              </div>
            ))}
          </div>
        </Specimen>
      </Family>
      <Family title="OwnerAvatar">
        <Specimen name={t`字符与默认`} prop="size" note={t`头像、名字首字、通用人形，依次回落。`}>
          <OwnerAvatar owner={{ name: 'Febers' }} size={24} />
          <OwnerAvatar owner={{ name: 'Febers' }} size={28} />
          <OwnerAvatar owner={{ name: 'Febers' }} size={40} />
          <OwnerAvatar owner={undefined} size={28} />
        </Specimen>
      </Family>
      <Family title={t`标记`}>
        <Specimen name={t`将调用`} prop="Composer.tsx:1535" note={t`输入框里出现的 / 引用；输入框自带，未抽成组件。`}>
          <div className="flex flex-wrap items-center gap-1">
            {[['skill', 'review'], ['command', 'compact']].map(([kind, name]) => (
              <span key={name} className="inline-flex min-h-6 max-w-full items-center gap-1 rounded-md bg-accent/10 pl-1.5 pr-0.5 text-xs text-accent">
                {kind === 'skill' ? <IconSparkles className="size-3 shrink-0" /> : <IconSlash className="size-3 shrink-0" />}
                <span className="min-w-0 truncate font-mono">{name}</span>
                <span className="grid size-5 shrink-0 place-items-center rounded text-accent/70"><IconX className="size-3" /></span>
              </span>
            ))}
          </div>
        </Specimen>
      </Family>
      <Plate number={1} title="CodeBlock" note={t`代码有两种写法：工具输出用 CodeBlock，回答里的代码围栏由 Markdown 画。外观与行为各自实现。`}>
        <Frame className="grid gap-px md:grid-cols-2">
          <div className="flex flex-col gap-3 p-6 max-md:p-4">
            <span className="font-mono text-2xs text-fg-4">CodeBlock · Timeline.tsx:363</span>
            <CodeBlock copy={OUTPUT}>{OUTPUT}</CodeBlock>
          </div>
          <div className="flex flex-col gap-3 p-6 edge-l max-md:p-4 max-md:edge-t">
            <span className="font-mono text-2xs text-fg-4">.md-code · Markdown.tsx:228</span>
            <Markdown text={FENCE} />
          </div>
        </Frame>
      </Plate>
    </Chapter>
  );
}
