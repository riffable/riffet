# 导航

在视图和条目之间移动：`UnderlineTabs`、列表行与卡片网格（`Tile`）。画面在 `/design/components/navigation`，页签在 `apps/web/src/components/ui/controls.tsx:100`。

## UnderlineTabs

### 用途

页面的一级视图（变更 / 文件 / 终端）。一级视图内部的子视图用 [`Segmented`](inputs.md)，两者并存时靠样式区分层级。

### 变体与尺寸

默认保持原有布局；`scrollable` 变体用于 Agent 页和模型提供商页的 Agent 对象导航：单行横向排列、标签不收缩，超宽原生横向滚动，切换或缩放后选中项保持可见，焦点移动时只滚动本栏。选项可带 `icon`（`size-3.5`）、单项 `disabled`。高度由所在栏决定（`h-full`），常见为 36。

### 状态

| 状态 | 外观 |
|---|---|
| 默认 | `fg-3` |
| 悬停 / 键盘焦点 | `fg` |
| 选中 | `fg`，下方 2 的 `primary` 下划线 |
| 禁用 | 不透明度 50% |

手机上字号升到 `text-base`、横向内边距 12。

### 键盘与无障碍

`role="tablist"` 内的 `role="tab"` 按钮，`aria-selected`；roving tabindex，Tab 只停在选中页签，左右方向键、Home、End 只移动焦点，Enter、Space 或点击才切换（手动激活，理由见 [输入](inputs.md) 的 Segmented）；选项带 `panelId` 时设 `aria-controls`。需要 `ariaLabel` 命名这组页签。

### 文案

视图页签用短名词，通常不超过 5 个；Agent 页和模型提供商页的 Agent 导航保留产品名与标志，数量不受此限。

### 不要

- 做页面内的筛选（用 `Segmented`）。
- 除 Agent 页和模型提供商页的 Agent 对象导航外，不做对象切换（用 `Select appearance="heading"`）。

### 现状

- 只有插件详情的页签传了 `panelId`；收藏、扩展检查器和上下文面板的页签与内容混排，面板没有 `aria-controls` 关联。页签没有 id，面板也无法用 `aria-labelledby` 指回页签。

## 列表行

标准行是 `ListRow`（`components/ui/list-row.tsx`）：高 32（触屏 `no-hover:min-h-11`，44）、横向内边距 10、间距 8、圆角 `lg`、悬停 `bg-hover`、选中 `bg-active` 且文字 `fg`、禁用按 foundations §9。依次是前置图标（`leading`，16，`fg-3`）、标题（`children`，单行截断）、`meta`（`text-xs tabular-nums fg-3`）、`trailing`（不可交互的装饰，如箭头）、`actions`（可交互的尾部操作）。

- 选中状态由调用方传对应的 ARIA：`aria-current="page"`（导航）、`aria-pressed`（开关）、`aria-selected`（列表框）。
- 带 `actions` 的行渲染成 `role="button"` 的 `div`（按钮里不能嵌按钮），Enter 与空格由行自己响应，落在内部控件上的按键不触发。不带 `actions` 的行是 `<button>`。
- `RowActions` 与 `rowReveal` 把「指针停留、键盘进入（`:focus-visible`）或菜单打开时出现，触屏常驻」写成一处；隐藏时仍占位、不拦截点击。`rowConceal` 给同格里让位的内容（如时间）。命名分组固定为 `group/row`。
- 内容放不进上述插槽的行可直接用 `listRowClass`（`SessionInfo.tsx` 的 `infoRow` 即 `listRowClass` 加 `text-fg`）。

保持独立的三种：

- `menuItem`（浮层）内边距 8（桌面）/ 12（手机），仅与标准行的高度、圆角对齐。
- `SettingsLinkRow` 最小 48 且没有圆角，是卡片内的整宽分隔行，与 `SettingsRow`（`py-3.5`）同类。
- `Disclosure` 是转录里的折叠行，高度随文字缩放，不属于列表行。

设置导航在手机上仍是 48 高的整行列表（`SettingsPage.tsx` 手机分支），那是另一种版式，不是 `ListRow`。

### 现状

- `SessionRow` 以 `ListRow` 为外壳，保留自己的「时间与操作同格」布局和 `RowMenu` 触发器（24 见方，悬停 `bg-active`），尚未换成 `Button size="icon-sm"`。
- `SessionInfo.tsx` 的 `infoRow` 仍被 `session/SessionWorkActions.tsx`、`session/marks.tsx` 以类名使用，尚未换成 `ListRow`。

## Tile（卡片网格）

一组可挑选、每项要看说明才能分辨的对象排成的卡片，比如插件。实现在 `components/ui/tile.tsx`。

### 用途

- 用于：看板档正文里的目录，每项有标志、名称、一两句说明和自己的控件（开关、安装）。
- 不用于：只靠名称就能分辨的条目（用 `ListRow`）；设置项（用 `SettingsRow`）；单选（用 `SettingsThumbChoice`）。

### 结构

`TileGrid` 按自己的宽度排列：一列，512 起两列，768 起三列，间距 12。卡片 `rounded-xl`、`border-line`、底 `bg-elevated`、内边距 16，平面无阴影。从上到下：40 见方的标志（`rounded-xl bg-muted`）与标题（`text-sm font-medium fg`，可跟一枚 `Badge`）、`meta` 一行（`text-xs fg-3`）；说明 `text-xs fg-2`，最多两行；页脚在底部对齐，左边是 `facts`（14 的图标，`fg-4`，每个带 `Tip`），右边是 `actions`。

### 状态

悬停时边框换 `line-strong`；标题按钮获得键盘焦点时整张卡片画焦点环；禁用时标题不可点，页脚的控件各自处理禁用。

### 键盘与无障碍

标题是 `h4` 里的 `<button>`（卡片放在 `h3` 分组标题下），它的 `::after` 铺满卡片，所以点卡片任何空白处都等于点标题；页脚里只有各个事实和控件在这一层之上，开关和按钮各自可聚焦。Tab 依次经过标题和页脚的控件。`facts` 的图标是 `role="img"`，名称写在 `aria-label`。

### 不要

- 在卡片上再放一个与标题同义的「详情」按钮。
- 把整段权限、说明放进卡片：卡片只放图标和两行说明，完整内容在详情里。
- 在文档档（768）里用：两列以下不如列表。

## 可排序列表（SortableList）

用户自己定顺序的一组行：设置里的侧栏去处、会话视图、侧板视图、以及侧栏的团队成员。设置列表拖行首的把手（或聚焦把手后按方向键）；侧栏列表使用 `drag="row"` + `variant="inset"`，桌面精细指针按住整行超过阈值后浮起拖动、其余行实时让位，单击仍打开该行，行内菜单按钮标 `data-sort-ignore` 不触发拖动。

### 用途

- 用于：顺序本身就是设置、行数在一屏之内的列表。
- 不用于：会话、文件这类按数据排序的列表；要跨区域移动的场合（标签页在两个区之间拖动用 `tabs/useZoneDrag.ts`）。

### 结构

| 部分 | 必选 | 说明 |
|---|---|---|
| 行 | 是 | 调用方自己的行（`SettingsRow` 等）；列表不另加容器，每行外包一层，父级按直接子元素画的分隔线照常 |
| 把手 | 是 | `SortHandle`，放在行首、标题之前；图标 `IconGripVertical` |

### 状态

| 状态 | 外观（语义） | 触发 |
|---|---|---|
| 默认 | 把手 `fg-4` | |
| 悬停 | 把手 `bg-hover`、`fg-2`，指针为抓手 | 指针 |
| 键盘焦点 | 把手 `ring-focus` | Tab |
| 拖动中 | 被拖的行浮起：`bg-elevated`、`shadow-pop`、圆角 `lg`，左右各外扩 8；其余行让位 | 按住把手 |

### 交互

| 输入 | 行为 |
|---|---|
| 指针 | 按住把手拖动，只在纵向移动，不超出首尾行；越过相邻行的中线时它让位。松开后行落到空位，再提交顺序 |
| 键盘 | 把手聚焦时 ↑ ↓ 与相邻行交换，焦点留在同一把手上；拖动中 Esc 取消，弹窗不关闭 |
| 触摸 | 把手点击区 44，`touch-action: none`，按住即拖，不必长按；行的其余部分照常滚动 |
| 屏幕阅读器 | 把手名称「调整 X 的顺序」；每次移动后由 `role="status"` 读出「X：第 n 项，共 m 项」 |

- 动效：让位与落位取 `fast`、标准曲线；减弱动效时随全局规则缩短。
- 调用方在同一次渲染里显示新顺序（保存走乐观更新），否则行会先弹回再跳到新位置；一帧内没有回来的顺序视为被拒绝，行回到原位。

### 实现

| 端 | 组件 | 位置 |
|---|---|---|
| Web | `SortableList`、`SortHandle` | `apps/web/src/components/ui/sortable-list.tsx` |
| macOS | `SortableList`、`SortHandle` | `apps/macos/Riffet/Theme/SortableList.swift` |

### 迁移

- [x] macOS 设置的「侧栏」页和「外观」里的检查器视图已迁到 `SortableList`：`DragGesture` 拖把手（行内 `offset` 让位，松手后落位再提交），聚焦把手后 ↑ ↓ 移动，VoiceOver 动作「上移」「下移」；侧栏页按乐观更新保存，不再在保存时禁用控件。macOS 不支持拖动中按 Esc 取消。
- `FolderFavorites.tsx` 的上移、下移在行的菜单里，属于菜单命令，不迁移。

### 不做

- 每行常驻上移、下移按钮：两个按钮占了行尾，保存时整组按钮一起变灰，读起来像闪了一下；方向键在把手上已经覆盖键盘操作。
- HTML5 拖放：纵向列表里拖影是整行截图，落点只能在松手后才知道。
