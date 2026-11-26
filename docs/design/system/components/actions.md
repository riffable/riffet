# 操作

触发一次动作的控件：`Button` 与 `StatusPill`。画面在 `/design/components/actions`，实现在 `apps/web/src/components/ui/button.tsx`、`controls.tsx`。画法依据见 [DECISIONS](../../DECISIONS.md) 2026-11-14「Web 组件收紧为墨色与浅底」；主按钮的颜色已由 2026-11-26「主题色分三档，墨色只给文字」改为 `primary`。

## Button

### 用途

执行动作或进入下一步。导航到另一个页面用链接语义的 `variant="link"` 或行（见 [navigation.md](navigation.md)），不用主按钮。

### 变体与尺寸

| 变体 | 画法 | 用于 | 每个区域最多 |
|---|---|---|---|
| `primary` | 主题色实心（`primary`） | 这一屏的主操作 | 1 个 |
| `secondary`（默认） | 墨色 7% 浅底，悬停 11% | 平行的次要操作 | 不限 |
| `ghost` | 透明，文字 `fg-2` | 工具栏、对话框的取消 | 不限 |
| `quiet` | 透明，文字 `fg-3` | 图标按钮、行内操作 | 不限 |
| `danger` | 红色 12% 浅底、红字 | 不可逆操作的确认按钮 | 1 个 |
| `danger-ghost` | 透明，悬停出现红色浅底 | 列表里的移除、断开 | 不限 |
| `link` | 无内边距，`accent` 文字，悬停下划线 | 句子里的操作 | 不限 |

| 尺寸 | 高 | 用于 |
|---|---|---|
| `xs` · `sm` · `md`（默认）· `lg` | 24 · 28 · 32 · 36 | 文字按钮；`md` 对齐输入框高度 |
| `icon-xs` · `icon-sm` · `icon` | 24 · 28 · 32 见方 | 只有图标；必须有名称 |

### 状态

| 状态 | 外观 | 备注 |
|---|---|---|
| 悬停 | 浅底加深一档 | 仅 `can-hover` |
| 按下 | 缩放到 0.97 | 全部变体 |
| 键盘焦点 | `ring-2 ring-focus` | `:focus-visible` |
| 打开 | 同悬停（`data-[state=open]`） | 作为菜单触发器时 |
| 禁用 | 不透明度 50%，不接收指针 | |
| 进行中 | `busy`：`Spinner` 盖在内容上，宽度不变，`aria-busy`，点击被忽略，仍可聚焦 | |

### 键盘与无障碍

原生 `<button type="button">`（`asChild` 时由子元素承担）；Enter / Space 触发。文字按钮的名称就是标签；图标按钮必须同时有 `aria-label` 和 `Tip`，快捷键放 `Tip kbd`。触屏上 `no-hover` 的最小点击区 44，但 `Button` 本身没有放大，见现状。

### 文案

动词开头，主操作写动词加对象（「保存」「删除会话」），不写「确定」。长度以不换行为准，`whitespace-nowrap`。

### 不要

- 同一区域放两个 `primary`。
- 用 `danger` 做普通删除入口：它只出现在确认处，入口用 `danger-ghost` 或菜单里的危险项。
- 用 `accent`：`Button` 已没有这个变体；插件 SDK 的 `ButtonProps` 仍列着它，插件套件里按 `primary` 画。

### 现状

- 原生 `<button>` 约 230 处，`Button` 约 520 处（`components/ui/button` 被 110 个文件导入）；原生按钮各自写样式，如对话框关闭按钮（`components/ui/dialog.tsx` 的 `ui-dialog-close`）、`CopyButton`（`components/ui/copy-button.tsx`）。
- 触屏点击区：`Button` 各尺寸在 `no-hover` 下没有最小 44 的约束，手机上靠调用方加 `min-h-11`（如 `SettingsRow` 的 `max-md:[&_button:not([role=switch])]:min-h-11`）。
- 进行中的 `Button` 已改用 `busy`；非 `Button` 的元素（如 `QuickCreate` 的圆形发送钮、`DirectoryPicker` 的刷新钮）仍自己换 `Spinner`。

## StatusPill

### 用途

状态附带一个安全的补救操作（「连接失败」→「重试」）。它外观是 `Badge`，行为是按钮，归入操作而不是展示：分类依据是交互模型，读屏器读到的是按钮，焦点顺序里有它，`Badge` 没有。只陈述状态、没有补救操作时用 [`Badge`](display.md)。

### 变体与尺寸

`tone`：`neutral` `accent` `success` `warning` `danger`，与 `Badge` 同色；尺寸固定（高 20，`text-2xs`），不提供尺寸参数。

### 状态

| 状态 | 外观 |
|---|---|
| 默认 | 显示 `label` |
| 悬停 / 键盘焦点 | 标签换成 `actionLabel`（两者在同一格里，宽度取较宽者） |
| 触屏 | 一开始就显示 `actionLabel`，没有悬停可找 |
| 进行中 `busy` | 前置 `Spinner`；保持可聚焦，不再触发 |
| 禁用 | 不透明度 60% |

### 键盘与无障碍

内部是 `<button aria-label={actionLabel} aria-description={title}>`，旁边有 `sr-only` 的状态文字，所以先读状态再读操作。`StatusPillActions` 为 `false` 时（手机标题栏按钮内）退化为 `Badge`，操作改在该控件自己的面板里（`app/Header.tsx:255`）。

### 文案

`label` 是状态（「连接失败」），`actionLabel` 是动词（「重试」）；`title` 放状态背后的细节，如错误原文。

### 不要

- 放进另一个按钮里（会嵌套按钮）；用 `StatusPillActions` 关闭。
- 补救操作有风险或需要确认时使用：它一次点击就执行。

### 现状

- 使用处只有 `Header.tsx`、`terminal/TerminalView.tsx`、`terminal/NativeSession.tsx`；插件 SDK 未导出 `StatusPill`，只导出 `Badge` 与 `StatusDot`。

## ActionBar

### 用途

手机面板上的一排去处或小操作：一张卡片分成二到四格，每格图标在上、一个词在下（手机 Web 会话详情的「变更 · 文件 · 终端 · 更多」）。对应 Android 的 `PaneActionBar`。超过四项时，第四格是「更多」，其余进它的菜单。只在手机布局用；桌面的同类入口是行或菜单。

### 变体与尺寸

无变体。格等宽；格高至少 64，图标 20，文字 `text-sm` `fg`，一行截断。卡片与面板里的其他卡片相同：`rounded-xl`、`line` 描边。

### 状态

| 状态 | 外观 |
|---|---|
| 默认 | 透明底 |
| 按下 | `bg-active` |
| 当前打开（`active`） | `bg-active`，同时设 `aria-pressed` |
| 菜单展开 | `bg-active`（`data-state="open"`） |
| 键盘焦点 | 内侧焦点环 |
| 禁用 | 不透明度 50%，不响应 |

### 键盘与无障碍

容器是 `role="group"`；每格是 `<button>`，可见的文字就是名称。`ActionBarButton` 透传属性，可作 `DropdownMenuTrigger asChild`。

### 文案

一个词或「任务 #12」这样的短名，名词或动词都可，不加省略号；会打开确认或表单的操作同样不加。

### 不要

- 放进五格以上，或折成两行文字。
- 把危险操作放进来：删除单独一张卡片。

### 现状

- 使用处：`app/Header.tsx`、`app/SessionInfo.tsx`（手机会话详情）。
