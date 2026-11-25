import { useLingui } from '@lingui/react/macro';
import { PairTable, type ComponentPair } from '../platform';
import { Chapter, Plate } from '../specimen';

export function ComponentChapter() {
  const { t } = useLingui();
  const families: Array<{ title: string; pairs: ComponentPair[] }> = [
    {
      title: t`按钮`,
      pairs: [
        { web: 'Button primary', native: 'SolidButtonStyle(.primary)', note: t`墨色实心，每个区域最多一个` },
        { web: 'Button secondary', native: 'SolidButtonStyle(.secondary)', note: t`7% 墨色浅底，无描边` },
        { web: 'Button ghost · quiet', native: 'SolidButtonStyle(.quiet)', note: t`透明底；弹窗的取消`, added: true },
        { web: 'Button danger', native: 'SolidButtonStyle(.danger)', note: t`红色浅底、红字` },
        { web: 'Button size="icon"', native: 'IconButtonStyle', note: '28 × 28' },
        { web: 'Chip', native: 'ChipButtonStyle · ChipLabel', note: t`高 26，透明底` },
      ],
    },
    {
      title: t`输入与选择`,
      pairs: [
        { web: 'Input · Textarea', native: '.formField() · TextEditor' },
        { web: 'Switch', native: 'Toggle(.switch)', note: t`墨色；设置的分组列表里用迷你尺寸` },
        { web: 'Segmented', native: 'SegmentedTrack · FormSegmented', note: t`2–4 个固定的短选项` },
        { web: 'Select', native: 'ChoiceMenu · Picker', note: t`工作台里是应用菜单，设置里是系统弹出菜单` },
        { web: 'Select appearance="heading"', native: 'ChoiceMenu(.heading)', note: t`切换下方内容所属的对象`, added: true },
        { web: 'UnderlineTabs', native: 'PillTab', note: t`页面与面板的一级视图` },
      ],
    },
    {
      title: t`浮层与反馈`,
      pairs: [
        { web: 'DropdownMenu', native: 'popUpStyled · DrawnMenu', note: t`右键菜单仍是系统菜单` },
        { web: 'Popover', native: 'StylePopover' },
        { web: 'Dialog', native: 'SheetScaffold', note: t`四档宽度，Return 与 Esc`, added: true },
        { web: 'confirmDialog', native: '.confirmationDialog' },
        { web: 'Tip', native: '.help' },
        { web: 'toast', native: 'Toast', note: t`与菜单同一种浮层`, added: true },
        { web: 'Notice', native: 'NoticeBar' },
        { web: 'Spinner', native: 'Spinner' },
      ],
    },
    {
      title: t`页面`,
      pairs: [
        { web: 'PageScaffold', native: 'PageScaffold', note: t`页头、单一滚动区、内容列档位`, added: true },
        { web: 'SettingsGroup · SettingsRow', native: '.riffetForm() · SettingsRow' },
      ],
    },
  ];
  return (
    <Chapter title={t`组件对照`} lede={t`每种组件每端只有一个实现。Mac 的组件在 Theme 目录，业务代码只经它们画界面。`} tone="canvas" source="apps/macos/Riffet/Theme/">
      <Plate number={1} title={t`Web 与 Mac`} note={t`标为新增的组件还没有 Mac 实现，迁移时先建组件，再改调用点。`}>
        <PairTable platform="macOS" families={families} addedLabel={t`新增`} />
      </Plate>
    </Chapter>
  );
}
