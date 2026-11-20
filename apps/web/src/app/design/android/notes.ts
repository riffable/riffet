import { useLingui } from '@lingui/react/macro';
import type { CompareColumn } from '../compare';
import { ANDROID_STYLES, type AndroidStyle } from './values';

export interface AndroidStyleNote { title: string; lede: string; rules: string[]; primary?: boolean }

/** Each Android style's name and what it changes from material3. A style without a note shows its id. */
export function useAndroidStyleNote(): (style: AndroidStyle) => AndroidStyleNote {
  const { t } = useLingui();
  const notes: Record<string, AndroidStyleNote> = {
    riffet: {
      title: 'Riffet',
      lede: t`默认风格。墨色代替强调色，分层靠明度不靠线，行用常规字重，标题和未读才加重。`,
      primary: true,
      rules: [
        t`页面比卡片暗一档，卡片、胶囊和面板都不描边；线只分开同一张卡片里的行`,
        t`选中是中性的浅底，主操作是墨色；强调色只留给焦点、选区和链接`,
        t`会话行只有一行：行首是 Agent 的标志，行尾是状态或时间`,
        t`筛选胶囊没选中时只是文字，选中的一个有底，选中底滑到新的位置`,
      ],
    },
    material3: {
      title: 'Material 3',
      lede: t`数值的基准，其余风格只改与它不同的字段。Material 的控件结构、ripple 与弹窗排列。`,
      rules: [
        t`导航栏标题左对齐，底栏平铺并延伸到手势区`,
        t`次要按钮是浅色填充，危险操作用 error 角色`,
        t`分组标题用强调色`,
        t`首页的模式切换是下划线页签`,
      ],
    },
    expressive: {
      title: 'Expressive',
      lede: t`Material 控件，更大的圆角与选中面，浮动底栏，空间动效用更有弹性的弹簧。`,
      rules: [
        t`分段控件是一组独立的胶囊`,
        t`底栏浮在内容上，选中项是胶囊`,
        t`导航栏标题 24，大标题加粗`,
        t`正文密度与 Material 3 相同`,
      ],
    },
    miuix: {
      title: 'Miuix',
      lede: t`按钮、开关、复选、输入与滑块用官方 Miuix 组件；分组、导航与面板用共享组件。`,
      rules: [
        t`列表行高 56，分组之间 24`,
        t`选中项在行尾打勾，分组标题用次级墨色`,
        t`底栏选中项下方一个圆点`,
        t`按下是表面高亮，没有 ripple`,
      ],
    },
    fluent: {
      title: 'Fluent',
      lede: t`中性浮层、小圆角、描边的次要按钮、细轨道开关和下划线输入框。`,
      rules: [
        t`控件圆角 4，分组 8`,
        t`分段控件是下划线页签`,
        t`底栏选中项上方一条线`,
        t`行之间有分隔线`,
      ],
    },
    ios: {
      title: 'iOS',
      lede: t`用 Compose 画出的 iOS 外观；iPhone 原生端与它取同样的值。`,
      rules: [
        t`导航栏标题居中，56 高`,
        t`只有主操作填充强调色，次要与危险操作是透明的着色文字`,
        t`简单的操作面板把取消单独放在下方`,
        t`按下降低不透明度，没有 ripple`,
      ],
    },
  };
  return (style) => notes[style.id] ?? { title: style.id, lede: t`这种风格还没有说明，数值读自 mobile-styles.ts。`, rules: [] };
}

/** The Android styles as comparison columns, material3 first. */
export function useAndroidColumns(): CompareColumn[] {
  const { t } = useLingui();
  const note = useAndroidStyleNote();
  return ANDROID_STYLES.map((style) => ({ id: style.id, title: note(style).title, tag: note(style).primary ? t`默认` : undefined }));
}
