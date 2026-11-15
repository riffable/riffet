import { useLingui } from '@lingui/react/macro';
import { PairTable, type ComponentPair } from '../platform';
import { Chapter, Plate } from '../specimen';

export function ComponentChapter() {
  const { t } = useLingui();
  const families: Array<{ title: string; pairs: ComponentPair[] }> = [
    {
      title: t`按钮`,
      pairs: [
        { web: 'Button primary · secondary · danger', native: 'RiffetButton', note: t`次要按钮按外观变体画成浅底或着色文字` },
        { web: 'Button ghost · quiet · link', native: 'RiffetTextButton · RiffetInlineAction' },
        { web: 'Button size="icon"', native: 'RiffetIconButton', note: t`图标 24，点击区 48` },
        { web: 'Chip', native: 'ChipRow · ChipButton · ToggleChip', note: t`筛选、菜单、开关三种，同一尺寸` },
      ],
    },
    {
      title: t`输入与选择`,
      pairs: [
        { web: 'Input · Textarea · Field', native: 'RiffetTextField · GroupField', note: t`分组卡片里的字段用 GroupField，卡片即容器` },
        { web: 'SearchField', native: 'RiffetSearchField' },
        { web: 'Switch', native: 'RiffetSwitch', note: t`设置里整行可点` },
        { web: 'Segmented', native: 'SegmentedControl', note: t`只用于二到三个短选项` },
        { web: 'UnderlineTabs', native: 'ViewTabs', note: t`切换一页里的视图` },
        { web: 'Select', native: 'PickerSheet · RiffetDropdownMenu', note: t`一组值用底部面板，就近的少量选项用菜单` },
        { web: 'Checkbox', native: 'RiffetCheckbox' },
        { web: 'RadioGroup', native: 'OptionRow · SelectionMark', note: t`当前值只打勾，不填充` },
        { web: 'Slider', native: 'RiffetSlider' },
      ],
    },
    {
      title: t`列表与展示`,
      pairs: [
        { web: 'SettingsGroup · ListRow', native: 'Group · GroupRow', note: t`标题与说明是 GroupTitle、GroupFootnote` },
        { web: 'StatusDot', native: 'StatusDot', note: t`在 timeline 目录，未进组件层` },
        { web: 'CopyButton', native: 'CopyTextButton', note: t`在 timeline 目录，未进组件层` },
        { web: 'EmptyState', native: 'EmptyState' },
        { web: 'Skeleton', native: 'SkeletonBlock · SkeletonRows' },
        { web: 'Avatar', native: 'OwnerAvatar · AgentAvatar' },
      ],
    },
    {
      title: t`浮层与反馈`,
      pairs: [
        { web: 'Dialog · confirmDialog', native: 'ConfirmDialog · AlertDialog · RiffetDialogContent', note: t`ui/design/Dialogs.kt，不是 Material 的同名组件` },
        { web: 'DropdownMenu', native: 'RiffetDropdownMenu' },
        { web: 'Popover', native: '—', note: t`触摸屏上改用菜单或底部面板` },
        { web: 'Tip', native: 'contentDescription', note: t`只有图标的按钮靠无障碍名称` },
        { web: 'toast', native: 'RiffetSnackbar', note: t`整个应用一个队列` },
        { web: 'Notice', native: 'Notice', note: t`一件事只在一处说` },
        { web: 'Spinner', native: 'RiffetProgressIndicator' },
      ],
    },
    {
      title: t`页面`,
      pairs: [
        { web: 'PageScaffold', native: 'RiffetPageScaffold', note: t`顶栏、单一滚动区、转场后淡入的正文` },
      ],
    },
  ];
  return (
    <Chapter title={t`组件对照`} lede={t`每种组件每端只有一个实现。Android 的组件在 ui/design，业务代码只经它们画界面，不直接调用 Material 控件。`} tone="canvas" source="apps/mobile/shared/src/commonMain/kotlin/riffet/ui/design/">
      <Plate number={1} title={t`Web 与 Android`} note={t`标为新增的组件还没有 Android 实现，迁移时先建组件，再改调用点。`}>
        <PairTable platform="Android" families={families} addedLabel={t`新增`} />
      </Plate>
    </Chapter>
  );
}
