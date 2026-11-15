import { useLingui } from '@lingui/react/macro';
import type { DesktopStyle } from '@contracts';
import type { CompareColumn } from '../compare';
import { STYLES, type Family } from './values';

/** The groups the recipe families are read in: the window's frame, the conversation, then surfaces and controls. */
export type FamilyGroup = 'frame' | 'session' | 'surface';

export interface FamilyNote {
  group: FamilyGroup;
  label: string;
  /** Each option's name; an option missing here shows its id. */
  options: Record<string, string>;
  /** Said once under the family, when the field does not apply everywhere. */
  note?: string;
}

/**
 * How the recipe vocabulary reads on the page. A family or option the contract gains before this
 * table does still shows, under its id, so the page never hides a recipe.
 */
export function useFamilyNotes(): (family: Family) => FamilyNote {
  const { t } = useLingui();
  const notes: Partial<Record<Family, FamilyNote>> = {
    backend: { group: 'frame', label: t`组件来源`, options: { native: t`系统组件`, custom: t`自绘` } },
    titleBar: { group: 'frame', label: t`标题栏`, options: { unified: t`统一工具栏`, compact: t`紧凑工具栏` } },
    window: { group: 'frame', label: t`窗口`, options: { system: t`系统分栏`, insetCard: t`内缩卡片`, flat: t`满铺单层` } },
    sidebar: { group: 'frame', label: t`侧栏`, options: { systemList: t`系统列表`, projectTree: t`项目树`, timeGroups: t`按时间分组` } },
    header: { group: 'frame', label: t`页头`, options: { toolbar: t`工具栏标题`, sessionTabs: t`会话标签栏`, titleMenu: t`标题与菜单` } },
    rightPanel: { group: 'frame', label: t`右侧面板`, options: { inspector: t`检查器页签`, outline: t`大纲加检查器`, panels: t`页头图标各开一栏` } },
    settings: { group: 'frame', label: t`设置`, options: { window: t`独立窗口`, modal: t`窗口内弹窗` }, note: t`Mac 的设置总是独立窗口，这一项只对 Web 生效。` },
    composer: { group: 'session', label: t`输入框`, options: { card: t`卡片`, line: t`单行` } },
    toolRun: { group: 'session', label: t`工具调用`, options: { summary: t`摘要行`, list: t`摘要加列表`, labelled: t`工具名行` } },
    home: { group: 'session', label: t`新会话页`, options: { tiles: t`居中加操作卡片`, docked: t`输入框停靠底部` } },
    approval: { group: 'session', label: t`审批`, options: { stack: t`纵向堆叠`, rows: t`选项行`, inline: t`单行` } },
    fileRow: { group: 'session', label: t`文件行`, options: { stacked: t`名称在上、目录在下`, inline: t`名称与目录同行` } },
    surface: { group: 'surface', label: t`卡片`, options: { raised: t`软阴影`, outlined: t`细线` } },
    block: { group: 'surface', label: t`内容块`, options: { filled: t`浅底`, outlined: t`细线` } },
    form: { group: 'surface', label: t`表单`, options: { grouped: t`系统分组框`, lined: t`细线分隔` } },
    menu: { group: 'surface', label: t`菜单`, options: { system: t`系统菜单`, drawn: t`自绘浮层` }, note: t`右键菜单在所有风格下都是系统菜单。` },
    selection: { group: 'surface', label: t`选中`, options: { wash: t`主题选中色`, block: t`实心块` } },
    inlineCode: { group: 'surface', label: t`行内代码`, options: { chip: t`浅底标签`, plain: t`只换等宽字体` } },
    ink: { group: 'surface', label: t`界面用色`, options: { brand: t`强调色`, quiet: t`墨色` } },
    tabs: { group: 'surface', label: t`页签`, options: { underline: t`下划线`, pill: t`胶囊` } },
  };
  return (family) => notes[family] ?? { group: 'surface', label: family, options: {} };
}

export function useGroupLabels(): Record<FamilyGroup, string> {
  const { t } = useLingui();
  return { frame: t`窗口结构`, session: t`会话`, surface: t`表面与控件` };
}

export interface StyleNote {
  title: string;
  lede: string;
  /** The document holding this style's own rules. */
  doc?: string;
  rules: string[];
  primary?: boolean;
}

/**
 * Each style's name and the few rules it adds on top of the shared ones. A style the contract
 * lists without a note here still gets its chapter section, drawn from its values alone.
 */
export function useStyleNote(): (style: DesktopStyle) => StyleNote {
  const { t } = useLingui();
  const notes: Record<string, StyleNote> = {
    native: {
      title: t({ message: '原生', context: 'interface-style' }),
      lede: t`系统组件：系统侧栏、工具栏与分组表单，菜单用系统菜单。`,
      doc: 'docs/design/macos-native.md',
      rules: [
        t`系统强调色只用于系统控件本身：开关、文本选区、焦点环、选中的列表行`,
        t`主区满铺，玻璃感只来自底层材质和连续的标题栏`,
        t`页面级搜索用工具栏的 .searchable`,
        t`工具栏的每个动作是单独的 ToolbarItem，不放说明文字`,
      ],
    },
    riffet: {
      title: 'Riffet',
      lede: t`主风格，以 Web 为准：内缩卡片、项目树侧栏、会话标签栏，菜单与弹出层共用一种浮层。`,
      doc: 'docs/design/riffet-style.md',
      primary: true,
      rules: [
        t`界面文字三档字号、两种字重，只有一种分隔线`,
        t`强调色只用于焦点环、文本选区和链接`,
        t`窗口里的控件只有图标按钮和胶囊两种`,
        t`菜单、弹出层、模型选择器共用圆角 12 的浮层`,
      ],
    },
    line: {
      title: t({ message: '线条', context: 'interface-style' }),
      lede: t`一张满铺的纸，边缘全部用细线，面板从页头的图标打开。`,
      doc: 'docs/design/interface-styles/',
      rules: [
        t`卡片与内容块用细线勾边，不用阴影`,
        t`表单是细线分隔的行，字段的描边画在纸上`,
        t`紧凑标题栏：页头与红绿灯同高`,
      ],
    },
  };
  return (style) => notes[style.id] ?? { title: style.id, lede: t`这种风格还没有说明，数值与配方取自 interface-styles.ts。`, rules: [] };
}

/** The desktop styles as comparison columns, in the contract's order. */
export function useMacColumns(): CompareColumn[] {
  const { t } = useLingui();
  const note = useStyleNote();
  return STYLES.map((style) => ({ id: style.id, title: note(style).title, tag: note(style).primary ? t`主风格` : undefined }));
}
