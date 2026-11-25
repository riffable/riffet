import { useLingui } from '@lingui/react/macro';
import type { DesktopStyleLength } from '@contracts';
import { Chapter, Plate, Token } from '../specimen';
import { StyleMiniature } from './StyleMiniature';
import { CompareTable, type CompareRow } from '../compare';
import { COLUMNS, points, STYLE } from './values';

/** A length as the Mac gets it, with the web token it was read from. */
function Length({ value }: { value: DesktopStyleLength }) {
  return (
    <span className="flex flex-col">
      <span className="font-mono tabular-nums">{points(value)}</span>
      {typeof value === 'string' && <span className="font-mono text-2xs text-fg-4">{value}</span>}
    </span>
  );
}

function useGroups(): Array<{ title: string; rows: CompareRow[] }> {
  const { t } = useLingui();
  const row = (label: string, key: string, value: DesktopStyleLength): CompareRow => ({ label, hint: <Token className="text-2xs text-fg-4">{key}</Token>, cells: [<Length value={value} />] });
  const word = (label: string, key: string, value: string): CompareRow => ({ label, hint: <Token className="text-2xs text-fg-4">{key}</Token>, cells: [<Token className="text-current">{value}</Token>] });
  const { radii, layout, text, fonts, icons } = STYLE;
  return [
    {
      title: t`圆角`,
      rows: [
        row(t`控件`, 'radii.control', radii.control),
        row(t`容器`, 'radii.container', radii.container),
        row(t`卡片`, 'radii.card', radii.card),
        row(t`浮层`, 'radii.floating', radii.floating),
        row(t`菜单`, 'radii.menu', radii.menu),
      ],
    },
    {
      title: t`布局`,
      rows: [
        row(t`侧栏默认宽`, 'layout.sidebarWidth', layout.sidebarWidth),
        row(t`侧栏行高`, 'layout.sidebarRow', layout.sidebarRow),
        row(t`侧栏分组间距`, 'layout.sidebarGap', layout.sidebarGap),
        row(t`页头高`, 'layout.header', layout.header),
        row(t`右侧面板默认宽`, 'layout.rightPanel', layout.rightPanel),
      ],
    },
    {
      title: t`文字`,
      rows: [
        row(t`界面`, 'text.body', text.body),
        row(t`次要`, 'text.secondary', text.secondary),
        row(t`分组标题`, 'text.label', text.label),
        row(t`侧栏`, 'text.sidebar', text.sidebar),
        row(t`正文行高`, 'text.readingLine', text.readingLine),
      ],
    },
    {
      title: t`字体与图标`,
      rows: [
        word(t`界面字体`, 'fonts.ui', fonts.ui),
        word(t`代码字体`, 'fonts.mono', fonts.mono),
        word(t`默认图标包`, 'icons', icons),
      ],
    },
  ];
}

export function StylesChapter() {
  const { t } = useLingui();
  const groups = useGroups();
  return (
    <Chapter title={t`数值`} lede={t`写成 Web 变量名的数值在生成时从样式表读出，Mac 跟着 Web 变。颜色由主题决定。`} tone="canvas" source="packages/contracts/src/interface-styles.ts">
      <Plate number={1} title={t`取值`}>
        <CompareTable columns={COLUMNS} groups={groups} head={false} />
      </Plate>
      <Plate number={2} title={t`窗口缩样`}>
        <StyleMiniature />
      </Plate>
    </Chapter>
  );
}
