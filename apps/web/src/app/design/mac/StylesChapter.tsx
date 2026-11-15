import { useLingui } from '@lingui/react/macro';
import type { DesktopStyle, DesktopStyleLength } from '@contracts';
import { Chapter, Plate, Token } from '../specimen';
import { CompareTable, type CompareRow } from '../compare';
import { useFamilyNotes, useGroupLabels, useMacColumns, useStyleNote, type FamilyGroup } from './notes';
import { StyleMiniature } from './StyleMiniature';
import { FAMILIES, points, STYLES } from './values';

/** A length as the Mac gets it, with the web token it was read from. */
function Length({ value }: { value: DesktopStyleLength }) {
  return (
    <span className="flex flex-col">
      <span className="font-mono tabular-nums">{points(value)}</span>
      {typeof value === 'string' && <span className="font-mono text-2xs text-fg-4">{value}</span>}
    </span>
  );
}

function useTokenGroups(): Array<{ title: string; rows: CompareRow[] }> {
  const { t } = useLingui();
  const row = (label: string, key: string, read: (style: DesktopStyle) => DesktopStyleLength): CompareRow => ({
    label,
    hint: <Token className="text-2xs text-fg-4">{key}</Token>,
    cells: STYLES.map((style) => <Length key={style.id} value={read(style)} />),
    keys: STYLES.map((style) => points(read(style))),
  });
  const words = (label: string, key: string, read: (style: DesktopStyle) => string): CompareRow => ({
    label,
    hint: <Token className="text-2xs text-fg-4">{key}</Token>,
    cells: STYLES.map((style) => <Token key={style.id} className="text-current">{read(style)}</Token>),
    keys: STYLES.map(read),
  });
  return [
    {
      title: t`圆角`,
      rows: [
        row(t`控件`, 'radii.control', (style) => style.tokens.radii.control),
        row(t`容器`, 'radii.container', (style) => style.tokens.radii.container),
        row(t`卡片`, 'radii.card', (style) => style.tokens.radii.card),
        row(t`浮层`, 'radii.floating', (style) => style.tokens.radii.floating),
        row(t`菜单`, 'radii.menu', (style) => style.tokens.radii.menu),
      ],
    },
    {
      title: t`布局`,
      rows: [
        row(t`侧栏默认宽`, 'layout.sidebarWidth', (style) => style.tokens.layout.sidebarWidth),
        row(t`侧栏行高`, 'layout.sidebarRow', (style) => style.tokens.layout.sidebarRow),
        row(t`侧栏分组间距`, 'layout.sidebarGap', (style) => style.tokens.layout.sidebarGap),
        row(t`页头高`, 'layout.header', (style) => style.tokens.layout.header),
        row(t`右侧面板默认宽`, 'layout.rightPanel', (style) => style.tokens.layout.rightPanel),
      ],
    },
    {
      title: t`文字`,
      rows: [
        row(t`界面`, 'text.body', (style) => style.tokens.text.body),
        row(t`次要`, 'text.secondary', (style) => style.tokens.text.secondary),
        row(t`分组标题`, 'text.label', (style) => style.tokens.text.label),
        row(t`侧栏`, 'text.sidebar', (style) => style.tokens.text.sidebar),
        row(t`正文行高`, 'text.readingLine', (style) => style.tokens.text.readingLine),
      ],
    },
    {
      title: t`字体与图标`,
      rows: [
        words(t`界面字体`, 'fonts.ui', (style) => style.tokens.fonts.ui),
        words(t`代码字体`, 'fonts.mono', (style) => style.tokens.fonts.mono),
        words(t`默认图标包`, 'icons', (style) => style.tokens.icons),
      ],
    },
  ];
}

function useRecipeGroups(): Array<{ title: string; rows: CompareRow[] }> {
  const familyNote = useFamilyNotes();
  const groupLabels = useGroupLabels();
  const order: FamilyGroup[] = ['frame', 'session', 'surface'];
  return order.map((group) => ({
    title: groupLabels[group],
    rows: FAMILIES.filter((family) => familyNote(family).group === group).map((family): CompareRow => {
      const note = familyNote(family);
      return {
        label: note.label,
        hint: <span className="flex flex-col gap-0.5"><Token className="text-2xs text-fg-4">{family}</Token>{note.note && <span>{note.note}</span>}</span>,
        cells: STYLES.map((style) => {
          const value = style.recipes[family];
          return (
            <span key={style.id} className="flex flex-col">
              <span>{note.options[value] ?? value}</span>
              <Token className="text-2xs text-fg-4">{value}</Token>
            </span>
          );
        }),
        keys: STYLES.map((style) => style.recipes[family]),
      };
    }),
  }));
}

/** One style's own plate: what it is, the window it draws, and the rules it adds. */
function StylePlate({ style, number }: { style: DesktopStyle; number: number }) {
  const { t } = useLingui();
  const note = useStyleNote()(style);
  return (
    <Plate
      number={number}
      title={note.primary ? `${note.title} · ${t`主风格`}` : note.title}
      note={note.lede}
      action={note.doc && <Token className="text-fg-3">{note.doc}</Token>}
    >
      <div className="flex flex-col gap-6">
        <StyleMiniature style={style} />
        {note.rules.length > 0 && (
          <ul className="grid gap-x-8 gap-y-2 text-sm text-fg-2 md:grid-cols-2">
            {note.rules.map((rule) => <li key={rule} className="flex gap-2"><span aria-hidden className="mt-2 h-px w-3 shrink-0 bg-fg-4" />{rule}</li>)}
          </ul>
        )}
      </div>
    </Plate>
  );
}

export function StylesChapter() {
  const { t } = useLingui();
  const tokens = useTokenGroups();
  const recipes = useRecipeGroups();
  const columns = useMacColumns();
  return (
    <Chapter title={t`风格`} lede={t`${STYLES.length} 种界面风格共用一套组件：配方决定每类组件取哪种形态，数值决定它的尺寸。颜色由主题决定，与风格无关。`} tone="canvas" source="packages/contracts/src/interface-styles.ts">
      <Plate number={1} title={t`数值`} note={t`写成 Web 变量名的数值在生成时从样式表读出，所以 Riffet 风格跟着 Web 变。各风格取值相同的行颜色变淡。`}>
        <CompareTable columns={columns} groups={tokens} />
      </Plate>
      <Plate number={2} title={t`配方`} note={t`每个形态在 Mac 上只有一份实现。新风格只是重新组合已有形态时，在 contracts 里加一条即可，不写界面代码。`}>
        <CompareTable columns={columns} groups={recipes} />
      </Plate>
      {STYLES.map((style, index) => <StylePlate key={style.id} style={style} number={index + 3} />)}
    </Chapter>
  );
}
