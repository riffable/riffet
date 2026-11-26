import { useLingui } from '@lingui/react/macro';
import { CompareTable, type CompareRow } from '../compare';
import { Chapter, Plate, Token } from '../specimen';
import { useAndroidColumns, useAndroidStyleNote } from './notes';
import { PhoneMiniature } from './PhoneMiniature';
import { ANDROID_STYLES, type AndroidStyle, type Dimensions, type Motion, type Recipes } from './values';

const number = (value: number) => <span className="font-mono tabular-nums">{Number.isInteger(value) ? value : value.toFixed(2)}</span>;

function useValueGroups(): Array<{ title: string; note?: string; rows: CompareRow[] }> {
  const { t } = useLingui();
  const size = (label: string, key: keyof Dimensions): CompareRow => ({
    label,
    hint: <Token className="text-2xs text-fg-4">{key}</Token>,
    cells: ANDROID_STYLES.map((style) => <span key={style.id}>{number(style.dimensions[key])}</span>),
    keys: ANDROID_STYLES.map((style) => style.dimensions[key]),
  });
  const pair = (label: string, keys: [keyof Dimensions, keyof Dimensions]): CompareRow => ({
    label,
    hint: <Token className="text-2xs text-fg-4">{keys.join(' × ')}</Token>,
    cells: ANDROID_STYLES.map((style) => <span key={style.id} className="font-mono tabular-nums">{style.dimensions[keys[0]]} × {style.dimensions[keys[1]]}</span>),
    keys: ANDROID_STYLES.map((style) => `${style.dimensions[keys[0]]}:${style.dimensions[keys[1]]}`),
  });
  const motion = (label: string, key: keyof Motion): CompareRow => ({
    label,
    hint: <Token className="text-2xs text-fg-4">{key}</Token>,
    cells: ANDROID_STYLES.map((style) => <span key={style.id}>{number(style.motion[key])}</span>),
    keys: ANDROID_STYLES.map((style) => style.motion[key]),
  });
  return [
    {
      title: t`圆角`,
      rows: [
        size(t`分组、弹窗、面板`, 'groupRadius'),
        size(t`输入框卡片`, 'composerRadius'),
        size(t`按钮、搜索框`, 'controlRadius'),
        size(t`列表行的选中面`, 'rowRadius'),
        size(t`菜单`, 'menuRadius'),
        size(t`分段控件的滑块`, 'selectionRadius'),
      ],
    },
    {
      title: t`布局`,
      rows: [
        size(t`页面边距`, 'pageInset'),
        size(t`分组之间`, 'sectionGap'),
        size(t`列表行`, 'rowHeight'),
        size(t`导航栏`, 'barHeight'),
        size(t`底栏`, 'tabBarHeight'),
        size(t`浮动底栏的侧边留白`, 'tabBarInset'),
      ],
    },
    {
      title: t`控件`,
      rows: [
        size(t`点击区与控件高`, 'controlHeight'),
        size(t`分段控件`, 'segmentedHeight'),
        pair(t`开关`, ['switchWidth', 'switchHeight']),
        size(t`滑块轨道`, 'sliderTrackHeight'),
        size(t`发送按钮`, 'sendButtonSize'),
        size(t`确认框宽`, 'alertWidth'),
        size(t`图标`, 'iconSize'),
      ],
    },
    {
      title: t`动效`,
      note: t`毫秒；弹簧为阻尼比与刚度`,
      rows: [
        motion(t`进入页面`, 'pageEnter'),
        motion(t`离开页面`, 'pageExit'),
        motion(t`下层页面的位移`, 'coveredPageShift'),
        motion(t`短`, 'short'),
        motion(t`中`, 'medium'),
        motion(t`空间弹簧 · 阻尼`, 'spatialDamping'),
        motion(t`空间弹簧 · 刚度`, 'spatialStiffness'),
        motion(t`按下时的不透明度`, 'pressOpacity'),
        {
          label: t`曲线`,
          cells: ANDROID_STYLES.map((style) => <Token key={style.id} className="text-current">{style.easing.join(', ')}</Token>),
          keys: ANDROID_STYLES.map((style) => style.easing.join()),
        },
      ],
    },
  ];
}

function useRecipeRows(): CompareRow[] {
  const { t } = useLingui();
  const names: { [K in keyof Recipes]: { label: string; options?: Record<string, string> } } = {
    buttons: { label: t`按钮的实现`, options: { material: 'Material', shared: t`共享实现` } },
    segments: { label: t`分段控件`, options: { connected: t`相连的按钮`, sliding: t`轨道加滑块` } },
    secondaryButtons: { label: t`次要按钮`, options: { tonal: t`浅色填充`, plain: t`着色文字` } },
    navigation: { label: t`底栏`, options: { flat: t`平铺`, floating: t`浮动` } },
    indicator: { label: t`底栏的选中`, options: { fill: t`色块`, capsule: t`胶囊` } },
    homeTabs: { label: t`首页的模式切换`, options: { underline: t`下划线页签` } },
    dividers: { label: t`行之间的分隔线` },
    selectionAtEnd: { label: t`选中项在行尾打勾` },
    accentSections: { label: t`分组标题用强调色` },
    card: { label: t`分组卡片`, options: { tonal: t`浅色填充`, elevated: t`抬起的表面` } },
    dialogs: { label: t`弹窗的实现`, options: { material: 'Material', shared: t`共享实现` } },
    press: { label: t`按下`, options: { ripple: 'ripple', highlight: t`表面高亮` } },
  };
  return (Object.keys(names) as Array<keyof Recipes>).map((key) => {
    const { label, options } = names[key];
    const read = (style: AndroidStyle) => style.recipes[key];
    return {
      label,
      hint: <Token className="text-2xs text-fg-4">{key}</Token>,
      keys: ANDROID_STYLES.map((style) => String(read(style))),
      cells: ANDROID_STYLES.map((style) => {
        const value = read(style);
        return <span key={style.id}>{typeof value === 'boolean' ? (value ? t`是` : '—') : (options?.[value] ?? value)}</span>;
      }),
    };
  });
}

function StylePlate({ style, number }: { style: AndroidStyle; number: number }) {
  const { t } = useLingui();
  const note = useAndroidStyleNote()(style);
  return (
    <Plate number={number} title={note.primary ? `${note.title} · ${t`默认`}` : note.title} note={note.lede} action={<Token className="text-fg-3">{style.id}</Token>}>
      <div className="grid items-start gap-8 md:grid-cols-[360px_minmax(0,1fr)]">
        <div className="overflow-x-auto"><PhoneMiniature style={style} /></div>
        {note.rules.length > 0 && (
          <ul className="flex flex-col edge-b">
            {note.rules.map((rule) => <li key={rule} className="py-2.5 text-sm text-fg-2 edge-t">{rule}</li>)}
          </ul>
        )}
      </div>
    </Plate>
  );
}

export function StylesChapter() {
  const { t } = useLingui();
  const columns = useAndroidColumns();
  const values = useValueGroups();
  const recipes = useRecipeRows();
  return (
    <Chapter title={t`风格`} lede={t`${ANDROID_STYLES.length} 种界面风格共用一套组件：数值决定尺寸与动效，配方决定每类组件画成哪种形态。颜色由主题决定，与风格无关。`} tone="canvas" source="packages/contracts/src/mobile-styles.ts">
      <Plate number={1} title={t`数值`} note={t`单位 dp。读自 mobile-styles.ts，与生成到 Kotlin 的是同一份；各风格取值相同的行颜色变淡。主题可以在上下限内覆盖。`}>
        <CompareTable columns={columns} groups={values} />
      </Plate>
      <Plate number={2} title={t`配方`} note={t`配方写在 ThemePresets.kt，这张表按它誊写。组件只读这些字段，不判断风格名。`}>
        <CompareTable columns={columns} groups={[{ rows: recipes }]} />
      </Plate>
      {ANDROID_STYLES.map((style, index) => <StylePlate key={style.id} style={style} number={index + 3} />)}
    </Chapter>
  );
}
