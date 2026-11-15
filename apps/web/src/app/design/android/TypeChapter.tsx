import { useLingui } from '@lingui/react/macro';
import { CompareTable, type CompareRow } from '../compare';
import { Chapter, Plate, Token, Value } from '../specimen';
import { useAndroidColumns } from './notes';
import { ANDROID_STYLES, type TypeScale } from './values';

const SANS = 'Roboto, "Noto Sans SC", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "Roboto Mono", ui-monospace, monospace';

export function TypeChapter() {
  const { t } = useLingui();
  const columns = useAndroidColumns();
  const roles: Array<{ key: keyof TypeScale; name: string; api: string; sample: string; mono?: boolean }> = [
    { key: 'body', name: t`正文`, api: 'body', sample: t`超时常量` },
    { key: 'label', name: t`界面`, api: 'label · button', sample: t`保存` },
    { key: 'menu', name: t`菜单`, api: 'menu', sample: t`重命名` },
    { key: 'caption', name: t`次要`, api: 'caption', sample: t`3 分钟前` },
    { key: 'barTitle', name: t`导航栏标题`, api: 'barTitle', sample: t`设置` },
    { key: 'largeTitle', name: t`大标题`, api: 'largeTitle', sample: t({ message: '任务', context: 'design-sample' }) },
    { key: 'dialogTitle', name: t`弹窗标题`, api: 'dialogTitle', sample: t`删除？` },
    { key: 'mono', name: t`代码`, api: 'mono', sample: 'TIMEOUT_MS', mono: true },
  ];
  const rows: CompareRow[] = roles.map((role) => ({
    label: role.name,
    hint: <Token className="text-2xs text-fg-4">{role.api}</Token>,
    keys: ANDROID_STYLES.map((style) => { const value = style.type[role.key]; return `${value.size}/${value.line}/${value.weight}`; }),
    cells: ANDROID_STYLES.map((style) => {
      const value = style.type[role.key];
      return (
        <span key={style.id} className="flex flex-col gap-1">
          <span className="text-fg" style={{ fontFamily: role.mono ? MONO : SANS, fontSize: value.size, lineHeight: `${value.line}px`, fontWeight: value.weight }}>{role.sample}</span>
          <Value>{value.size} / {value.line}{value.weight !== 400 ? ` · ${value.weight}` : ''}</Value>
        </span>
      );
    }),
  }));
  const rules = [
    t`调用处只写角色，不写 .sp`,
    t`字距一律为 0：Material 的拉丁字距会把中文标签撑开`,
    t`设置用紧凑的导航栏标题，大标题只用于滚动时会收起的页面`,
    t`会变化的数字用 tnum`,
    t`用户的文字大小与系统字体倍率相乘，终端固定为 1`,
  ];
  return (
    <Chapter title={t`文字角色`} lede={t`每种风格从自己的字阶映射到同一组角色；主题可以按角色覆盖。单位 sp。`} source="apps/mobile/shared/src/commonMain/kotlin/riffet/ui/design/ThemePresets.kt">
      <Plate number={1} title={t`角色与取值`} note={t`每格用该风格的字号排出；取值在各风格间相同的行颜色变淡。`}>
        <CompareTable columns={columns} groups={[{ rows }]} />
      </Plate>
      <Plate number={2} title={t`规则`}>
        <ul className="flex flex-col edge-b">
          {rules.map((rule) => <li key={rule} className="py-2.5 text-sm text-fg-2 edge-t">{rule}</li>)}
        </ul>
      </Plate>
    </Chapter>
  );
}
