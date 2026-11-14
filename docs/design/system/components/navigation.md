# 导航

在视图和条目之间移动：`UnderlineTabs` 与列表行。画面在 `/design/components/navigation`，页签在 `apps/web/src/components/ui/controls.tsx:100`。

## UnderlineTabs

### 用途

页面的一级视图（变更 / 文件 / 终端）。一级视图内部的子视图用 [`Segmented`](inputs.md)，两者并存时靠样式区分层级。

### 变体与尺寸

没有变体。选项可带 `icon`（`size-3.5`）、单项 `disabled`。高度由所在栏决定（`h-full`），常见为 36。

### 状态

| 状态 | 外观 |
|---|---|
| 默认 | `fg-3` |
| 悬停 / 键盘焦点 | `fg` |
| 选中 | `fg`，下方 2 的墨色下划线 |
| 禁用 | 不透明度 50% |

手机上字号升到 `text-base`、横向内边距 12。

### 键盘与无障碍

`role="tablist"` 内的 `role="tab"` 按钮，`aria-selected`；roving tabindex，Tab 只停在选中页签，左右方向键、Home、End 只移动焦点，Enter、Space 或点击才切换（手动激活，理由见 [输入](inputs.md) 的 Segmented）；选项带 `panelId` 时设 `aria-controls`。需要 `ariaLabel` 命名这组页签。

### 文案

名词，1–2 个字；不超过 5 个选项。

### 不要

- 做页面内的筛选（用 `Segmented`）。
- 做对象切换（用 `Select appearance="heading"`）。

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

设置导航在手机上仍是 48 高的整行列表（`SettingsDialog.tsx` 手机分支），那是另一种版式，不是 `ListRow`。

### 现状

- `SessionRow` 以 `ListRow` 为外壳，保留自己的「时间与操作同格」布局和 `RowMenu` 触发器（24 见方，悬停 `bg-active`），尚未换成 `Button size="icon-sm"`。
- `SessionInfo.tsx` 的 `infoRow` 仍被 `session/SessionWorkActions.tsx`、`session/marks.tsx` 以类名使用，尚未换成 `ListRow`。
