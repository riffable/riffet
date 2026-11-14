# 浮层

盖在内容之上的表面：`DropdownMenu`、`Popover`、`Dialog`，以及它们在手机上的底部面板形态。选哪一种见 [patterns.md](../patterns.md) 的浮层一节。画面在 `/design/components/overlays`，实现在 `apps/web/src/components/ui/`。Tip 与 toast 属于 [反馈](feedback.md)。

共用：菜单与弹出层共用 `menuSurface`（`dropdown-menu.tsx:16`）：`bg-popover`、`rounded-xl`、`shadow-pop`、内边距 4、最小宽 176，进入动画从触发点的方向滑入加缩放；弹窗共用 `shadow-pop`、`rounded-2xl`、`bg-elevated`。层级取 `--z-menu`、`--z-dialog` 等变量。

## DropdownMenu

### 用途

从一个触发点执行操作或选择命令。

### 变体与尺寸

| 部件 | 说明 |
|---|---|
| `DropdownMenuItem` | 一个操作；`variant="danger"` 为红字、悬停 `danger-soft`，用于删除类 |
| `DropdownMenuRadioItem` / `CheckboxItem` | 单选 / 勾选，已选项右侧 `IconCheck` |
| `MenuSub` | 子菜单行，右侧可带当前值与 `IconChevronRight` |
| `DropdownMenuLabel` | 组标题，`text-xs fg-3` |
| `DropdownMenuSeparator` | 1 的分隔线，`-mx-1 my-1` |

行高桌面最小 32、手机最小 44；图标 `size-4 fg-3`，危险项图标红色。`align` 默认 `start`；触发在右边缘的溢出菜单用 `end`。

### 状态

| 状态 | 外观 |
|---|---|
| 高亮（指针或方向键） | `bg-hover`（`data-[highlighted]`） |
| 禁用 | 不透明度 50%，不接收指针 |
| 打开 | 触发器保持悬停色（`data-[state=open]`） |

### 键盘与无障碍

Radix `role="menu"`：方向键移动、Enter / Space 选定、右方向键进子菜单、左方向键或 Esc 退出、字母键跳转；关闭后焦点回到触发器（输入框里的菜单保留输入焦点，`keepTypingFocus`）。图标触发器必须有 `aria-label`。

### 文案

动词或动词加对象（「重命名」「复制链接」）；危险项写具体动作（「删除会话」），不用「确定」；当前值写在 `MenuSub` 的 `value`，不重复在标签里。

### 不要

- 放表单控件（用 `Popover`）。
- 菜单项超过一屏仍不分组：先加 `Label` 和 `Separator`。
- 在菜单里放不可逆操作而不确认：危险项触发 `confirmDialog`。

### 现状

- 溢出按钮的写法统一为 `quiet icon-sm` 加 `IconEllipsis`（`Header.tsx:208`）（`aria-label` 为「更多操作」）。
- 菜单行的内边距（桌面 8）与标准行（10）不同，见 [navigation.md](navigation.md)。

## Popover

### 用途

锚定在触发点旁的小块内容，改动即时生效：显示选项、筛选条件。实现 `popover.tsx`，表面同 `menuSurface` 但 `p-0`，内容自带内边距（常见 `p-1` 加 40 高的行）。

### 变体与尺寸

| 参数 | 说明 |
|---|---|
| `mobileSheet` | 手机上画成底部面板，用于筛选、选项面板；默认关 |
| `align`（默认 `start`）、`sideOffset`（6） | |
| `hideWhenDetached` | 默认开，触发点滚出视口即隐藏 |

锚定在内容里某个位置（选区、光标、图表点）的弹出层保持锚定，不用 `mobileSheet`。

### 键盘与无障碍

Radix Popover：Esc 关闭，焦点回到触发器；手机上打开时焦点落在面板自身，不唤起键盘（`PopoverContent` 的 `onOpenAutoFocus`）。

### 不要

- 承载需要提交或取消的任务（用 `Dialog`）。
- 嵌套第二层弹出层。

## Dialog

### 用途

需要集中处理、有提交与取消的任务；确认一次不可逆的操作用 `confirmDialog`（`lib/dialogs.ts`）。

### 变体与尺寸

| `size` | 宽 | 用于 |
|---|---|---|
| `confirm` | 420 | 确认 |
| `form`（默认） | 448 | 小表单 |
| `content` | 768 | 内容较多的弹窗 |
| `workspace` | 1080 | 带自己导航的工作区弹窗 |

`hideClose` 隐藏右上角关闭；`mobileFullscreen` 手机上铺满；`mobileSheet` 手机上从底部升起。结构：`DialogHeader`（标题 + 说明）、`DialogBody`、`DialogFooter`（取消在左、主操作在右）。

### 状态

打开时 `bg-black/25` 的遮罩（深色 50%，1.5 的模糊）；Esc 与遮罩点击关闭；`confirmDialog` 在 `destructive` 时焦点落在取消上。

### 键盘与无障碍

Radix Dialog：焦点陷在内部，关闭后回到打开前的元素（手机上不回到输入框，避免唤起键盘）；桌面打开时焦点先落在对话框本身，除非第一个可聚焦元素是文本框，避免首个按钮出现像「被选中」的焦点环。标题用 `DialogTitle`，没有说明时传 `aria-describedby={undefined}`。

### 文案

标题陈述要发生的事（「删除这个会话？」）；主操作写动词加对象；手机上确认与小表单从底部弹出，按钮等宽铺满一行。

### 不要

- 对话框里再开对话框；用 `onBack` 在同一个对话框里切换内容。
- 用 `Dialog` 报告结果（用 `toast`）。

### 现状

- 弹窗结构的完整说明在页面「模式 · 浮层」章节（`patterns/OverlayChapter.tsx`），本页只复用它的宽度图 `Widths`。
- 关闭按钮是写在 `DialogContent` 里的 `Primitive.Close`，样式手写而不是 `Button`，桌面 28、手机 44，位置在 `ui-dialog-close` 里由 CSS 随安全区调整。

## 手机底部面板

### 用途

手机上菜单与小弹窗改从底部升起：`DropdownMenuContent` 默认 `mobileSheet`；`PopoverContent`、`DialogContent` 需显式传 `mobileSheet`。贴着光标的菜单（`/`、`@`）传 `mobileSheet={false}`。

### 变体与尺寸

`ui-floating-sheet`（`styles/index.css:2441`）：整宽贴底，顶部圆角，最大高度 = 应用高度 − 48，可内部滚动；内边距 8（`Popover` 为 0）；下方留出主屏指示条的安全区，用面板自己的颜色填充；后面是 25%（深色 50%）的遮罩。行最小高 44。

### 现状

- 遮罩用 `box-shadow: 0 0 0 100vmax` 画在面板上（`index.css:2449`），不是独立元素。
