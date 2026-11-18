import { useMemo, useState, type ComponentType, type CSSProperties } from 'react';
import { useLingui } from '@lingui/react/macro';
import { PermissionGlyph, permissionIconStyles, permissionTiers, setPermissionIconStyle, usePermissionIconStyle, type PermissionIconStyle, type PermissionTier } from '@/app/session/ApprovalPicker';
import * as icons from '@/components/icons';
import { IconSearch, IconSparkles } from '@/components/icons';
import { Input, Segmented } from '@/components/ui/controls';
import { copyWithToast } from '@/lib/files';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Matrix, Plate, Scrubber, Value } from '../specimen';

type Glyph = ComponentType<{ className?: string; style?: CSSProperties }>;

/** Every glyph the app imports, by the name call sites use. */
export const GLYPHS = (Object.entries(icons) as Array<[string, unknown]>)
  .filter((entry): entry is [string, Glyph] => entry[0].startsWith('Icon') && typeof entry[1] === 'function')
  .sort(([a], [b]) => a.localeCompare(b));

/** The sizes the interface uses, and where. */
function useSizes(): Array<[number, string]> {
  const { t } = useLingui();
  return [[12, t`元信息`], [14, t`行内`], [16, t`按钮、页签`], [18, t`主导航`]];
}

/** One glyph scrubbed from 12 to 128: the drawing grows, the stroke stays 1.25px. */
function Stroke() {
  const { t } = useLingui();
  const sizes = useSizes();
  const [size, setSize] = useState(64);
  return (
    <Frame className="grid gap-px md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className="relative grid min-h-[300px] place-items-center bg-[linear-gradient(to_right,var(--line-soft)_1px,transparent_1px),linear-gradient(to_bottom,var(--line-soft)_1px,transparent_1px)] bg-[size:16px_16px] bg-center">
        <IconSparkles className="text-fg" style={{ width: size, height: size }} />
        <span className="absolute bottom-4 left-5 font-mono text-2xs text-fg-4">{`${size} × ${size}`}</span>
        <span className="absolute bottom-4 right-5 font-mono text-2xs text-fg-4">stroke 1.25</span>
      </div>
      <div className="flex flex-col justify-between gap-10 p-8 edge-l max-md:edge-t max-md:p-6">
        <Scrubber label={t`尺寸`} value={size} min={12} max={128} onChange={setSize} unit="px" />
        <ul className="grid grid-cols-4 gap-4">
          {sizes.map(([px, use]) => (
            <li key={px}>
              <button type="button" onClick={() => setSize(px)} className="flex w-full flex-col items-start gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-focus">
                <span className="grid h-6 place-items-center"><IconSparkles className={size === px ? 'text-fg' : 'text-fg-3'} style={{ width: px, height: px }} /></span>
                <span className="flex flex-col gap-0.5">
                  <Value className={size === px ? 'text-fg' : undefined}>{px}</Value>
                  <span className="text-xs text-fg-3">{use}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Frame>
  );
}

export function IconChapter() {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const permissionStyle = usePermissionIconStyle();
  const tierLabels: Record<PermissionTier, string> = {
    read: t`只读`,
    ask: t`每次询问`,
    default: t`默认`,
    workspace: t`工作区`,
    auto: t`自动审查`,
    deny: t`拒绝`,
    full: t`全部放行`,
  };
  const styleLabels: Record<PermissionIconStyle, string> = {
    shield: t`盾牌`,
    semantic: t`语义`,
    gate: t`门禁`,
    ring: t`圆环`,
  };
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? GLYPHS.filter(([name]) => name.toLowerCase().includes(needle)) : GLYPHS;
  }, [query]);
  return (
    <Chapter title={t`图标`} lede={t`单一图形族 Lucide，单一线宽：描边 1.25px，经 non-scaling-stroke 在全部尺寸下恒定；颜色继承所在行的文字色。`} tone="canvas" source="apps/web/src/components/icons.tsx">
      <Plate number={1} title={t`尺寸`} note={t`界面使用 12、14、16、18 四档。尺寸放大时，描边保持 1.25px。`}>
        <Stroke />
      </Plate>
      <Plate
        number={2}
        title={t`权限图标`}
        note={t`7 个无冲突语义档位 × 4 套可选风格，默认盾牌，1.25px 恒定描边。`}
        action={(
          <Segmented<PermissionIconStyle>
            size="xs"
            value={permissionStyle}
            onChange={setPermissionIconStyle}
            ariaLabel={t`权限图标风格`}
            options={permissionIconStyles.map((style) => ({ value: style, label: styleLabels[style] }))}
          />
        )}
      >
        <Frame className="p-6">
          <Matrix
            columns={permissionIconStyles.map((style) => styleLabels[style])}
            rows={permissionTiers.map((tier) => ({
              label: tierLabels[tier],
              cells: permissionIconStyles.map((style) => (
                <span key={style} className={cn('inline-flex items-center gap-3', tier === 'full' ? 'text-warning' : 'text-fg-2')}>
                  <PermissionGlyph tier={tier} iconStyle={style} className="size-[18px]" />
                  <Value>{`${style}.${tier}`}</Value>
                </span>
              )),
            }))}
          />
        </Frame>
      </Plate>
      <Plate
        number={3}
        title={t`图标表`}
        note={t`${GLYPHS.length} 个图标，复制内容为组件名。各端按同一套语义名映射到各自的图形资源。`}
        action={(
          <div className="relative w-full max-w-60">
            <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-4" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t`搜索图标`} aria-label={t`搜索图标`} className="pl-8" />
          </div>
        )}
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-px overflow-hidden rounded-2xl bg-line shadow-[0_0_0_1px_var(--line)]">
          {shown.map(([name, Glyph]) => (
            <button
              key={name}
              type="button"
              onClick={() => void copyWithToast(name)}
              className="flex aspect-square min-w-0 flex-col items-center justify-between bg-bg px-2 pb-3 pt-[34%] text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
            >
              <Glyph className="size-5" />
              <span className="w-full truncate text-center font-mono text-2xs text-fg-4">{name.slice(4)}</span>
            </button>
          ))}
          {!shown.length && <p className="col-span-full bg-bg py-12 text-center text-sm text-fg-3">{t`没有匹配的图标`}</p>}
        </div>
      </Plate>
    </Chapter>
  );
}
