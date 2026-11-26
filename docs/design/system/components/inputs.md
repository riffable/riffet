# 输入

取得一个值的控件：`Input` `Textarea` `Field` `Select` `Switch` `Segmented`（`apps/web/src/components/ui/controls.tsx`），以及 `SearchField` `Checkbox` `RadioGroup` `Slider`（同目录各自的文件）。画面在 `/design/components/inputs`。选用规则（值、视图、对象各用哪个）在 [patterns.md](../patterns.md) 的选择一节。

字段共用 `fieldClass`（`controls.tsx:7`）：`rounded-lg`、`border-line-strong`、`bg-elevated`；悬停边框加深；聚焦时边框 `accent`，外加 `ring-3 accent/15`；禁用不透明度 50%。

## Input

### 用途

单行文本。

### 变体与尺寸

| 写法 | 用于 |
|---|---|
| 默认 | 标题、名称 |
| `className="pl-8"` 加定位的图标 | 搜索、路径；图标 `size-3.5 text-fg-4` 绝对定位在 `left-2.5` |
| `className="font-mono text-xs"` | 路径、命令、标识符 |

高 32；`no-hover` 下最小高 44。

### 状态

默认、悬停、聚焦、禁用。没有错误样式：校验失败给 `Field` 的 `error`（字段下方的 `role="alert"` 文字，并给控件 `aria-invalid` 与 `aria-describedby`）。

### 键盘与无障碍

原生 `<input>`。没有可见标签时必须有 `aria-label`；有标签用 `Field`。

### 文案

占位符是示例或动作（「搜索会话」），不重复标签。

### 不要

- 用占位符当标签。
- 自己拼搜索图标与清除按钮：用 `SearchField`；其他前缀结构（输入框内的标签）没有对应组件，先补组件。

## Textarea

### 用途

多行文本。`fieldClass` 加 `min-h-20 resize-y py-2 leading-5`。

### 状态与无障碍

同 `Input`。输入框（Composer）的草稿区是另一个实现，不是 `Textarea`（`app/session/Composer.tsx`）。

### 不要

用 `Textarea` 做自动增高的聊天输入；那是 Composer 的职责。

## Field

### 用途

给控件加标签与说明。`<label>` 包住控件，点击标签聚焦控件；`label` 为 `text-sm font-medium`，`hint` 为 `text-xs text-fg-3`。

### 文案

`label` 是名词（「工作目录」）；`hint` 只写用户推断不出的信息（保存位置、格式限制），一句。

### 现状

- 设置页不用 `Field`，用 `SettingsRow`（标题在左、控件在右，`app/settings/SettingsLayout.tsx:6`）；`Field` 用在对话框与编辑页的表单里（`AddProjectDialog.tsx`、`automations/AutomationEditor.tsx`）。
- 没有必填参数；`error` 已有，业务代码还没有调用点。

## Select

### 用途

从 5 个以上、或数量随数据变化的选项里选一个值；对象切换用 `heading` 外观。

### 变体与尺寸

| `appearance` | 画法 | 用于 |
|---|---|---|
| `field`（默认） | 字段外观，右侧 `IconChevronDown` | 表单值 |
| `heading` | 无边框、`text-base font-medium`，`-mx-2` 抵消内边距 | 标题位置的对象切换（见 patterns） |

选项可带 `icon`、`disabled`；`placeholder` 在值不匹配任何选项时显示；`name` 渲染隐藏的 `<input>` 以进入 `FormData`。

### 状态

默认、悬停、打开（`data-[state=open]` 边框与光晕同聚焦）、禁用。

### 键盘与无障碍

基于 `DropdownMenu` 的 `RadioGroup`：触发器是按钮，`aria-label` 是 `label`，`aria-describedby` 指向当前值；方向键移动、Enter 选定、Esc 关闭，字母键跳转。手机上选项列表是底部面板（`mobileSheet` 默认开），触发器高 44。

### 文案

`label` 是被选的东西（「Agent」），不写「请选择」。

### 现状

- 不是原生 `<select>`，浏览器的表单自动填充与 `<label for>` 不可用；`id` 传给触发器按钮。

## Switch

### 用途

一个即时生效的开关。需要「保存」才生效的布尔值用复选框（见下）。

### 状态

关：轨道 `fg/16%`；开：轨道 `primary`、滑钮 `primary-fg`；禁用不透明度 50%；聚焦 `ring-2 ring-focus`；`no-hover` 下命中区放大到 44 见方。

### 键盘与无障碍

Radix `role="switch"`，`aria-checked`；Space 切换。名称来自 `aria-label` 或包住它的 `<label>`。

### 文案

名称写被控制的东西（「显示行号」），不写「启用」「是否」。

## Segmented

### 用途

2 至 4 个固定、标签简短的值；一级视图内部的子视图。总宽超过所在行一半时换 `Select`。

### 变体与尺寸

| `size` | 段高 | 用于 |
|---|---|---|
| `sm`（默认） | 28 | 独立一行 |
| `xs` | 24 | 设置行右侧、浮层里 |

选项可带 `icon`、单项 `disabled`；窄容器内横向滚动，标签不被压缩。

### 状态

选中块是一个滑动的 `accent-soft` 滑块、文字墨色 `fg`（小字放在浅色底上用 `accent` 对比度不够；`--duration-base`），首次与尺寸变化时不动画；单项禁用不透明度 50%。

### 键盘与无障碍

渲染为 `role="radiogroup"` / `role="radio"` + `aria-checked`（它选的是值，不是视图）；roving tabindex，Tab 只停在选中段；左右方向键、Home、End 只移动焦点，Enter、Space 或点击才选中（APG 的手动激活）。很多调用处在改值时保存或跳转，选中跟着焦点走会让方向键逐项提交；忙时禁用选项也会让焦点丢失。

## SearchField

### 用途

列表与页面顶部的过滤输入：`Input` 加左侧 `IconSearch`（16，`fg-4`，`left-2.5`），`pl-8 pr-8`。`components/ui/search-field.tsx`。

### 变体与尺寸

`size="md"`（32，默认）、`size="lg"`（36，页面顶部的主搜索）；`no-hover` 下最小高 44。`hint` 放右侧，空时显示（如聚焦键 `Kbd`），有内容时换成清除按钮（`Button size="icon-xs" variant="quiet"`，名称「清除搜索」）。

### 状态

同 `Input`。

### 键盘与无障碍

有内容时 Escape 清空并阻止默认；已空时失焦，事件继续交给所在界面。输入法组词期间不响应。必须传 `aria-label`。

### 文案

占位符写范围（「搜索扩展」「搜索收藏的内容、备注或会话」）。

### 不要

- 在浮层的组合框查询行里用它：`QuickInput` 是 `role="combobox"` 的无边框大行，Escape 关闭浮层，见现状。

### 现状

- `CommandPalette.tsx`、`SessionSearchDialog.tsx`、`ImportSessionDialog.tsx` 用 `QuickInput`（`SessionSearchDialog.tsx:29`）：组合框与列表框键盘模型、无边框的整行外观、Escape 属于浮层，不并入 `SearchField`。
- `Sidebar.tsx:445` 是打开搜索浮层的按钮，不是输入框。

## ShortcutRecorder

### 用途

设置里改一个快捷键：显示当前键帽，激活后录入下一组按键。`components/ui/shortcut-recorder.tsx`。它只管录入状态与键盘处理，组合的含义（冲突、保存）由调用方判断。不用于输入文字，也不用于只读的快捷键列表（那里直接用 `Kbd`）。

### 状态

| 状态 | 外观 | 触发 |
|---|---|---|
| 默认 | 右对齐的 `Kbd` 键帽，高 28，无边框；悬停 `bg-hover` | |
| 录入中 | 强调色边框加 3px 15% 光晕（同 `Input` 聚焦），显示「按下组合键」 | 点击或 Enter、Space |
| 已停用 | `fg-4` 的「未设置」 | 键位为空 |
| 键盘焦点 | 焦点环 | Tab |

### 键盘与无障碍

- 录入中，按键只属于它：阻止默认并不再向上传递，工作台与插件的快捷键在这段时间暂停（`suspendShortcuts`）。只按修饰键时继续等待；组合必须含 Ctrl、Alt 或 ⌘（Mac 的 ⌘、其他平台的 Ctrl 记作 `Mod`）。
- Esc 取消；Tab 离开（失焦即结束录入）；按下可用的组合即结束。
- `aria-label` 是快捷键的名称，`aria-pressed` 表示录入中。触屏 `no-hover` 下最小高 44。

### 文案

只有两句：「按下组合键」「未设置」。冲突、重置、停用由所在的设置行处理：与另一个快捷键相同时在行下显示「键帽 已用于「名称」」与「取消」「替换」（对方失去该组合；整组只读的键没有「替换」），浏览器占用的组合显示「这个组合归浏览器所有」与「取消」。行右侧有「恢复默认」（仅已改动时）与「停用」两个 `icon-xs` 静默按钮；列表头的「全部恢复默认」仅在有改动时出现。

### 不要

- 在业务代码里自己监听按键来录入；也不在这里写键位，键位只在快捷键表（patterns §10）。

## Checkbox

### 用途

随表单确认才生效的布尔值，或多选、批量选择。即时生效的用 `Switch`。`components/ui/checkbox.tsx`（Radix Checkbox）。

### 变体与尺寸

16 见方，圆角 `rounded-xs`；`no-hover` 下命中区放大到 44。选中与半选为 `primary` 实心加 `primary-fg` 的勾或横线（主题色，与 `Switch` 一致）。

### 状态

未选、选中、半选（`checked="indeterminate"`，用于覆盖部分选中的全选）、悬停、聚焦（`ring-2 ring-focus`）、禁用（不透明度 45%）。

### 键盘与无障碍

Radix `role="checkbox"`；Space 切换。用 `<label>` 包住复选框与文字，点文字即切换；没有文字时给 `aria-label`。表单里的必填用 `required`。

### 文案

名称写被选中的东西或同意的事（「显示隐藏文件」「信任此插件」），不写「是否」。

### 不要

- 即时生效的开关用复选框。
- 用 `accent-accent` 的原生 `<input type="checkbox">`。Markdown 渲染出的任务列表是内容，不在此列。

## RadioGroup

### 用途

3 个以上、每项需要读一读（带说明）的单选。2 到 4 个短选项用 `Segmented`，更多或随数据变化用 `Select`。`components/ui/radio-group.tsx`（Radix RadioGroup）。

### 变体与尺寸

纵向列表，每行最小高 36（`no-hover` 44）；圆点 16，选中为 `primary` 实心加 `primary-fg` 圆点。选项有 `label`，可选 `description`（一行 `text-xs fg-3`）、`trailing`（行尾的值或操作按钮，不属于可选的标签）、`disabled`。

### 状态

未选、选中、悬停、聚焦、禁用（整组或单项，不透明度 50%）。

### 键盘与无障碍

`role="radiogroup"` + `role="radio"`；Tab 进入当前项，方向键移动并选中（Radix 的行为）。改值会保存的调用处在保存期间传 `busy`、忽略改动，不禁用整组，否则第一步之后焦点就丢了。必须传 `ariaLabel`。

### 文案

选项写名称，说明写差别，不重复名称。

### 不要

- 手写 `role="radio"` 的按钮组。菜单里的单选项（`session/ModelPicker.tsx:40`）是菜单项语义，保持现状，不属于这个组件。

## ChoiceCards

### 用途

一整页只做这一个决定、选项带标志值得看的单选，例如首次引导的「默认用哪个 Agent」（[模式](../patterns.md) §1.5）。设置里的单选用 `RadioGroup`，需要看缩略图的用 `SettingsThumbChoice`。Web `components/ui/choice-card.tsx`（Radix RadioGroup）；Mac `Features/Onboarding/OnboardingComponents.swift` 的 `ChoiceCard`。

### 变体与尺寸

纵向排列，间距 8；每张卡片最小高 64、圆角 12，1px `line` 描边。左侧可选 40 的方块（`bg-subtle`、圆角 10）放标志，中间是名称（`text-sm` medium）和一行说明（`text-xs fg-3`，单行截断），右侧单选圆点 16。

### 状态

未选、选中（描边 1.5px `fg`，圆点实心 `fg`）、悬停（`bg-hover`）、聚焦（`focus` 环）、禁用（不透明度 50%，不可选）。

### 键盘与无障碍

`role="radiogroup"` + `role="radio"`；Tab 进入当前项，方向键移动并选中。必须传 `ariaLabel`。在引导页里回车运行页面的主按钮。

### 文案

名称写选项本身；说明只写读者要知道的状态或差别（「未登录」），不重复名称，所有选项都一样的话（「可用」）不写。

### 不要

- 用在设置或表单里：那里一屏有多项设置，卡片太占地方，用 `RadioGroup`。

## Slider

### 用途

一个数值在连续或步进范围内取值。`components/ui/slider.tsx`（Radix Slider）。

### 变体与尺寸

轨道高 4、`fg/16%`，已选段 `primary`，滑块 16 圆形；控件高 20，`no-hover` 下 44。默认撑满父宽，宽度由父元素定。

### 状态

默认、悬停（滑块阴影）、聚焦（`ring-2 ring-focus`）、禁用（不透明度 45%）。

### 键盘与无障碍

`role="slider"`；方向键按 `step` 调整，Home/End 到端点。必须传 `aria-label`。

### 文案

当前值写在滑块旁的文字里（`tabular-nums text-fg-3`，带单位，如「12 px」），滑块自己不带数字。可恢复默认的用旁边的 `quiet` 图标按钮。

### 不要

- 用原生 `<input type="range">`。
- 需要精确输入的数值用 `Input`，不用滑块。
