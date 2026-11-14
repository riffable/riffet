import { Fragment } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Chapter, Plate, Token } from '../specimen';

/** A Web component, the Mac component that draws the same thing, and what the Mac one must hold to. */
type Pair = { web: string; mac: string; note?: string; added?: boolean };

export function ComponentChapter() {
  const { t } = useLingui();
  const families: Array<{ title: string; pairs: Pair[] }> = [
    {
      title: t`按钮`,
      pairs: [
        { web: 'Button primary', mac: 'SolidButtonStyle(.primary)', note: t`墨色实心，每个区域最多一个` },
        { web: 'Button secondary', mac: 'SolidButtonStyle(.secondary)', note: t`7% 墨色浅底，无描边` },
        { web: 'Button ghost · quiet', mac: 'SolidButtonStyle(.quiet)', note: t`透明底；弹窗的取消`, added: true },
        { web: 'Button danger', mac: 'SolidButtonStyle(.danger)', note: t`红色浅底、红字` },
        { web: 'Button size="icon"', mac: 'IconButtonStyle', note: '28 × 28' },
        { web: 'Chip', mac: 'ChipButtonStyle · ChipLabel', note: t`高 26，透明底` },
      ],
    },
    {
      title: t`输入与选择`,
      pairs: [
        { web: 'Input · Textarea', mac: '.formField() · TextEditor' },
        { web: 'Switch', mac: 'Toggle(.switch)', note: t`墨色；设置的分组列表里用迷你尺寸` },
        { web: 'Segmented', mac: 'SegmentedTrack · FormSegmented', note: t`2–4 个固定的短选项` },
        { web: 'Select', mac: 'ChoiceMenu · .formPicker()', note: t`工作台里是应用菜单，设置里是系统弹出菜单` },
        { web: 'Select appearance="heading"', mac: 'ChoiceMenu(.heading)', note: t`切换下方内容所属的对象`, added: true },
        { web: 'UnderlineTabs', mac: 'style.tabs', note: t`页面与面板的一级视图` },
      ],
    },
    {
      title: t`浮层与反馈`,
      pairs: [
        { web: 'DropdownMenu', mac: 'popUpStyled · DrawnMenu', note: t`右键菜单仍是系统菜单` },
        { web: 'Popover', mac: 'StylePopover' },
        { web: 'Dialog', mac: 'SheetScaffold', note: t`四档宽度，Return 与 Esc`, added: true },
        { web: 'confirmDialog', mac: '.confirmationDialog' },
        { web: 'Tip', mac: '.help' },
        { web: 'toast', mac: 'Toast', note: t`与菜单同一种浮层`, added: true },
        { web: 'Notice', mac: 'NoticeBar' },
        { web: 'Spinner', mac: 'Spinner' },
      ],
    },
    {
      title: t`页面`,
      pairs: [
        { web: 'PageScaffold', mac: 'PageScaffold', note: t`页头、单一滚动区、内容列档位`, added: true },
        { web: 'SettingsGroup · SettingsRow', mac: '.riffetForm() · SettingsRow' },
      ],
    },
  ];
  return (
    <Chapter title={t`组件对照`} lede={t`每种组件每端只有一个实现。Mac 的组件在 Theme 目录，业务代码只经它们画界面。`} tone="canvas" source="apps/macos/Riffet/Theme/">
      <Plate number={1} title={t`Web 与 Mac`} note={t`标为新增的组件还没有 Mac 实现，迁移时先建组件，再改调用点。`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] table-fixed border-collapse text-sm">
            <colgroup><col className="w-[30%]" /><col className="w-[34%]" /><col /></colgroup>
            <thead>
              <tr className="text-left font-mono text-2xs text-fg-4">
                <th className="pb-3 pr-4 font-normal">Web</th>
                <th className="pb-3 pr-4 font-normal">macOS</th>
                <th className="pb-3 font-normal" />
              </tr>
            </thead>
            <tbody>
              {families.map((family, index) => (
                <Fragment key={family.title}>
                  <tr><td colSpan={3} className={index ? 'pb-2 pt-8 text-xs font-medium text-fg-3' : 'pb-2 pt-2 text-xs font-medium text-fg-3'}>{family.title}</td></tr>
                  {family.pairs.map((pair) => (
                    <tr key={pair.web} className="edge-t">
                      <td className="py-2.5 pr-4 align-top"><Token className="text-fg-2">{pair.web}</Token></td>
                      <td className="py-2.5 pr-4 align-top">
                        <span className="flex flex-wrap items-baseline gap-2">
                          <Token>{pair.mac}</Token>
                          {pair.added && <span className="rounded-xs px-1 text-2xs text-fg-3 shadow-[inset_0_0_0_1px_var(--line-strong)]">{t`新增`}</span>}
                        </span>
                      </td>
                      <td className="py-2.5 align-top text-fg-3">{pair.note}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Plate>
    </Chapter>
  );
}
