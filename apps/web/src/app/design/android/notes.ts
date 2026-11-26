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
  };
  return (style) => notes[style.id] ?? { title: style.id, lede: t`这种风格还没有说明，数值读自 mobile-styles.ts。`, rules: [] };
}

/** The Android styles as comparison columns, material3 first. */
export function useAndroidColumns(): CompareColumn[] {
  const { t } = useLingui();
  const note = useAndroidStyleNote();
  return ANDROID_STYLES.map((style) => ({ id: style.id, title: note(style).title, tag: note(style).primary ? t`默认` : undefined }));
}
