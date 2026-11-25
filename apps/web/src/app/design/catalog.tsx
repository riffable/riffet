import type { ComponentType } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { DesignPlatform } from '../state/page-url';
import { ActionsChapter } from './components/ActionsChapter';
import { DisplayChapter } from './components/DisplayChapter';
import { FeedbackChapter as FeedbackComponentsChapter } from './components/FeedbackChapter';
import { InputsChapter } from './components/InputsChapter';
import { NavigationChapter as NavigationComponentsChapter } from './components/NavigationChapter';
import { OverlaysChapter as OverlayComponentsChapter } from './components/OverlaysChapter';
import { ComponentChapter as AndroidComponentChapter } from './android/ComponentChapter';
import { OverlayChapter as AndroidOverlayChapter } from './android/OverlayChapter';
import { PagesChapter as AndroidPagesChapter } from './android/PagesChapter';
import { PlatformChapter as AndroidPlatformChapter } from './android/PlatformChapter';
import { StylesChapter as AndroidStylesChapter } from './android/StylesChapter';
import { TypeChapter as AndroidTypeChapter } from './android/TypeChapter';
import { ArchitectureChapter } from './engineering/ArchitectureChapter';
import { PluginsChapter } from './engineering/PluginsChapter';
import { AccessibilityChapter } from './foundations/AccessibilityChapter';
import { ColorChapter } from './foundations/ColorChapter';
import { ContentChapter } from './foundations/ContentChapter';
import { ElevationChapter } from './foundations/ElevationChapter';
import { IconChapter } from './foundations/IconChapter';
import { MotionChapter } from './foundations/MotionChapter';
import { RadiusChapter } from './foundations/RadiusChapter';
import { SpaceChapter } from './foundations/SpaceChapter';
import { StatesChapter } from './foundations/StatesChapter';
import { TypeChapter } from './foundations/TypeChapter';
import { TypesetChapter } from './foundations/TypesetChapter';
import { ComponentChapter as MacComponentChapter } from './mac/ComponentChapter';
import { OverlayChapter as MacOverlayChapter } from './mac/OverlayChapter';
import { PlatformChapter as MacPlatformChapter } from './mac/PlatformChapter';
import { StylesChapter as MacStylesChapter } from './mac/StylesChapter';
import { TypeChapter as MacTypeChapter } from './mac/TypeChapter';
import { WindowChapter as MacWindowChapter } from './mac/WindowChapter';
import { PrinciplesChapter } from './overview/Opening';
import { SystemChapter } from './overview/SystemChapter';
import { ConfirmChapter } from './patterns/ConfirmChapter';
import { FeedbackChapter as FeedbackPatternsChapter } from './patterns/FeedbackChapter';
import { FormsChapter } from './patterns/FormsChapter';
import { KeyboardChapter } from './patterns/KeyboardChapter';
import { ListsChapter } from './patterns/ListsChapter';
import { NavigationChapter as NavigationPatternsChapter } from './patterns/NavigationChapter';
import { OverlayChapter as OverlayPatternsChapter } from './patterns/OverlayChapter';
import { PagesChapter } from './patterns/PagesChapter';
import { SearchChapter } from './patterns/SearchChapter';
import { SelectionChapter } from './patterns/SelectionChapter';
import { NewSessionChapter } from './surfaces/NewSessionChapter';
import { PanelsChapter } from './surfaces/PanelsChapter';
import { CouncilChapter } from './surfaces/CouncilChapter';
import { SessionChapter } from './surfaces/SessionChapter';

/**
 * The design system's layers, smallest first: each one is built only from the ones before it.
 * Motion, accessibility and wording are not layers of their own: the foundations give their values
 * and general rules, and every component, pattern and surface states its own.
 */
export const DESIGN_GROUPS = ['overview', 'foundations', 'components', 'patterns', 'surfaces', 'engineering'] as const;
export type DesignGroup = (typeof DESIGN_GROUPS)[number];

export interface CatalogChapter {
  /** `<group>/<slug>`, the chapter's address under `/design/`. */
  id: string;
  group: DesignGroup;
  /** Printed on the chapter and in the contents: its position across all groups, from 01. */
  number: string;
  title: string;
  summary: string;
  render: ComponentType;
}

export interface CatalogGroup { id: DesignGroup; number: string; title: string; definition: string; chapters: CatalogChapter[] }

type Entry = [slug: string, title: string, summary: string, render: ComponentType];

/**
 * The chapters a platform has, by group. The platforms share the groups and, where a chapter covers
 * the same thing, its slug, so switching platform keeps the reader on it. A group a platform has
 * nothing for is left out of its contents.
 */
export function useDesignCatalog(platform: DesignPlatform): CatalogGroup[] {
  const { t } = useLingui();
  const titles: Record<DesignGroup, [string, string]> = {
    overview: [t`总览`, t`原则，以及体系的分层。`],
    foundations: [t`基础`, t`颜色、文字、间距这些取值与通用规则。没有部件，其余各层都由它们组成。`],
    components: [t`组件`, t`可复用的部件，各有变体、尺寸与状态。每种组件每端一个实现。`],
    patterns: [t`模式`, t`组件的组合方式与交互约定：页面怎么搭，反馈、确认、键盘怎么做。`],
    surfaces: [t`界面`, t`Riffet 自己的整页，由模式和组件组成。`],
    engineering: [t`扩展与工程`, t`插件怎么接入界面，取值从哪里来、怎么检查。`],
  };
  const web: Record<DesignGroup, Entry[]> = {
    overview: [
      ['principles', t`原则`, t`三条取舍依据`, PrinciplesChapter],
      ['system', t`体系的组织`, t`分层、平台与风格`, SystemChapter],
    ],
    foundations: [
      ['colors', t`颜色`, t`底色、墨色、状态色`, ColorChapter],
      ['type', t`文字`, t`字体、字阶与角色`, TypeChapter],
      ['typesetting', t`排版`, t`混排、标点、截断、换行`, TypesetChapter],
      ['spacing', t`间距与尺寸`, t`间距档位、控件高度、点击区`, SpaceChapter],
      ['radius', t`圆角`, t`档位与嵌套`, RadiusChapter],
      ['elevation', t`层级`, t`阴影与叠放顺序`, ElevationChapter],
      ['motion', t`动效`, t`曲线、时长与规则`, MotionChapter],
      ['icons', t`图标`, t`尺寸、描边与颜色`, IconChapter],
      ['states', t`状态`, t`悬停、按下、焦点、选中、禁用`, StatesChapter],
      ['accessibility', t`无障碍`, t`对比度、键盘、读屏、减弱动效`, AccessibilityChapter],
      ['content', t`文案`, t`用词、语气、术语与格式`, ContentChapter],
    ],
    components: [
      ['actions', t`操作`, t`按钮与图标按钮`, ActionsChapter],
      ['inputs', t`输入`, t`输入框、开关、分段、下拉选择`, InputsChapter],
      ['navigation', t`导航`, t`标签与列表行`, NavigationComponentsChapter],
      ['display', t`展示`, t`徽标、状态点、按键、代码`, DisplayChapter],
      ['feedback', t`反馈`, t`提示气泡、通知、提示条、加载`, FeedbackComponentsChapter],
      ['overlays', t`浮层`, t`弹窗、菜单、弹出层`, OverlayComponentsChapter],
    ],
    patterns: [
      ['pages', t`页面`, t`工作台、页面骨架与页面类型`, PagesChapter],
      ['navigation', t`导航`, t`侧栏、标签页、返回与关闭`, NavigationPatternsChapter],
      ['overlays', t`浮层的选用`, t`选哪一种、结构与宽度`, OverlayPatternsChapter],
      ['selection', t`选择`, t`在几种选择控件之间怎么选`, SelectionChapter],
      ['feedback', t`反馈与加载`, t`结果、错误、进行中、空状态`, FeedbackPatternsChapter],
      ['confirm', t`确认与撤销`, t`危险操作与可撤销的操作`, ConfirmChapter],
      ['forms', t`表单与设置`, t`设置行、校验、保存`, FormsChapter],
      ['lists', t`列表`, t`行、悬停操作、更多菜单`, ListsChapter],
      ['search', t`搜索与筛选`, t`搜索框、筛选与无结果`, SearchChapter],
      ['keyboard', t`键盘`, t`快捷键、焦点顺序`, KeyboardChapter],
    ],
    surfaces: [
      ['session', t`会话`, t`消息、工具调用、代码、审批、输入框`, SessionChapter],
      ['new-session', t`新会话`, t`项目主页与起始输入`, NewSessionChapter],
      ['panels', t`侧边面板`, t`变更、文件、浏览器、终端`, PanelsChapter],
      ['council', t`模型协作`, t`发言、轮次、裁判记录`, CouncilChapter],
    ],
    engineering: [
      ['plugins', t`插件界面`, t`插件视图能用什么、怎么画`, PluginsChapter],
      ['architecture', t`架构`, t`分层、生成与检查`, ArchitectureChapter],
    ],
  };
  /** The Mac's own chapters; the principles and foundations they build on are the web part's. */
  const macos: Record<DesignGroup, Entry[]> = {
    overview: [
      ['platform', t`平台分工`, t`跟平台与跟 Web`, MacPlatformChapter],
      ['styles', t`数值`, t`圆角、布局、文字与窗口缩样`, MacStylesChapter],
    ],
    foundations: [['type', t`文字角色`, t`RiffetFont 的角色`, MacTypeChapter]],
    components: [['mapping', t`组件对照`, t`Web 与 Mac 一一对应`, MacComponentChapter]],
    patterns: [
      ['pages', t`窗口与页面`, t`工作台、页面、设置窗口`, MacWindowChapter],
      ['overlays', t`浮层`, t`sheet、菜单与通知`, MacOverlayChapter],
    ],
    surfaces: [],
    engineering: [],
  };
  /** Android's own chapters, under the same slugs as the Mac's where they cover the same thing. */
  const android: Record<DesignGroup, Entry[]> = {
    overview: [
      ['platform', t`平台分工`, t`跟平台与跟共用的规范`, AndroidPlatformChapter],
      ['styles', t`风格`, t`五种风格的数值、配方与缩样`, AndroidStylesChapter],
    ],
    foundations: [['type', t`文字角色`, t`各风格的字阶映射`, AndroidTypeChapter]],
    components: [['mapping', t`组件对照`, t`Web 与 Android 一一对应`, AndroidComponentChapter]],
    patterns: [
      ['pages', t`页面与导航`, t`底栏、页面栈、侧栏与返回`, AndroidPagesChapter],
      ['overlays', t`浮层`, t`菜单、底部面板、确认框与 Snackbar`, AndroidOverlayChapter],
    ],
    surfaces: [],
    engineering: [],
  };
  const entries = { web, macos, android }[platform];
  let count = 0;
  return DESIGN_GROUPS.filter((group) => entries[group].length > 0).map((group, index) => ({
    id: group,
    number: String(index),
    title: titles[group][0],
    definition: titles[group][1],
    chapters: entries[group].map(([slug, title, summary, render]) => ({ id: `${group}/${slug}`, group, number: String(++count).padStart(2, '0'), title, summary, render })),
  }));
}
