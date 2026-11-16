import { useLingui } from '@lingui/react/macro';
import type { DesktopStyle } from '@contracts';
import { Chapter, Plate, Token, Value } from '../specimen';
import { CompareTable, type CompareRow } from '../compare';
import { useMacColumns } from './notes';
import { fontStack, points, STYLES } from './values';

interface Role {
  name: string;
  api: string;
  sample: string;
  size: (style: DesktopStyle) => number;
  weight?: 500;
  mono?: boolean;
  /** The line height, where the role sets one apart from the ladder. */
  line?: (style: DesktopStyle) => number;
}

export function TypeChapter() {
  const { t } = useLingui();
  const columns = useMacColumns();
  const roles: Role[] = [
    { name: t`正文`, api: 'RiffetFont.body', sample: t`把超时统一成一个常量`, size: () => 14, line: (style) => style.tokens.text.readingLine },
    { name: t`界面`, api: 'RiffetFont.label', sample: t`整理超时常量`, size: (style) => points(style.tokens.text.body) },
    { name: t`次要`, api: 'RiffetFont.caption', sample: t`3 分钟前 · main`, size: (style) => points(style.tokens.text.secondary) },
    { name: t`分组标题`, api: 'style.text.label', sample: t`今天`, size: (style) => points(style.tokens.text.label), weight: 500 },
    { name: t`侧栏`, api: 'style.text.sidebar', sample: t`修复首帧跳变`, size: (style) => points(style.tokens.text.sidebar) },
    { name: t`注脚`, api: 'RiffetFont.footnote', sample: '1m 41s · 2.3k tok/s', size: () => 11 },
    { name: t`弹窗标题`, api: 'RiffetFont.dialogTitle', sample: t`删除这个会话？`, size: () => 16, weight: 500 },
    { name: t`栏标题`, api: 'RiffetFont.barTitle', sample: t`自动化`, size: (style) => points(style.tokens.text.body), weight: 500 },
    { name: t`代码`, api: 'RiffetFont.code', sample: 'TIMEOUT_MS = 30_000', size: () => 13, mono: true },
  ];
  const rows: CompareRow[] = roles.map((role) => ({
    label: role.name,
    hint: <Token className="text-2xs text-fg-4">{role.api}</Token>,
    keys: STYLES.map((style) => `${role.size(style)}:${role.mono ? style.tokens.fonts.mono : style.tokens.fonts.ui}:${role.line?.(style) ?? ''}`),
    cells: STYLES.map((style) => (
      <span key={style.id} className="flex flex-col gap-1">
        <span className="truncate text-fg" style={{ fontFamily: fontStack(role.mono ? style.tokens.fonts.mono : style.tokens.fonts.ui, role.mono), fontSize: role.size(style), fontWeight: role.weight ?? 400 }}>{role.sample}</span>
        <Value>{role.size(style)}{role.line ? ` / ${role.line(style)}` : ''}{role.weight ? ` · ${role.weight}` : ''}</Value>
      </span>
    )),
  }));
  const rules = [
    t`字重只用常规和中等，半粗只给品牌名`,
    t`没有半档字号：11.5 并入 12，12.5 并入 13`,
    t`10 以下只用于图形尺寸，不用于文字`,
    t`读者的字号缩放在角色内部乘上，调用处不再乘`,
    t`会变化的数字用等宽数字`,
  ];
  return (
    <Chapter title={t`文字角色`} lede={t`调用处只写角色，不写字号。角色的取值随风格变：界面、次要、侧栏三档来自配方，正文、注脚、标题与代码各端相同。`} source="apps/macos/Riffet/Theme/Theme.swift">
      <Plate number={1} title={t`角色与取值`} note={t`每格用该风格的字体与字号排出；取值在各风格间相同的行颜色变淡。`}>
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
