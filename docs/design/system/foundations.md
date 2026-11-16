# 基础

四端共用的语义：颜色角色、文字角色、间距、尺寸、圆角、层级、动效、图标、状态、无障碍。组件规范只引用这里的名字，不写数值。

取值分两组：**桌面**（Mac、Web，指针操作）和**移动**（Android、iOS，触摸操作）。桌面的值以 Riffet 风格为准，原生和线条风格在自己的配方里改；移动的值以 material3 和 ios 两种风格为准，其余移动风格在 `ThemePresets.kt` 里改。数值的来源和生成见 §11。

## 1. 颜色角色

角色和取值由主题提供，见 [主题契约](../../THEMES.md)。这里只规定哪个位置用哪个角色。

| 角色 | 用于 | 不用于 |
|---|---|---|
| `fg` | 正文、当前项、输入的文字 | |
| `fg-2` | 列表里的其余行、次级按钮的文字 | 正文 |
| `fg-3` | 元信息：时间、计数、路径、分组标题、未选中的图标 | 可点的文字链接 |
| `fg-4` | 占位、快捷键、预估值（带 `~` 的速度） | 需要读清的信息 |
| `bg-sidebar` / `bg` | 窗口底 / 内容面 | |
| `bg-hover` / `bg-active` | 悬停 / 选中和按下 | 装饰 |
| `line` | 唯一的分隔线：列头、标签栏底边、卡片外框、代码块 | |
| `accent` | 焦点环、文本选区、链接 | 按钮、开关、图标、分段控件、运行状态 |
| `primary` | 主按钮的实心底（每个区域最多一个）、开关打开时的轨道 | 其他按钮 |
| `danger` / `warning` / `success` | 出错 / 等待处理 / diff 新增，只表达状态 | 装饰、强调 |

- 彩色只来自内容：agent 标志、代码高亮、diff、头像。
- 移动端另有 19 个设计颜色角色（`page`、`card`、`floating`、`press`、`selected`……，见 `packages/contracts/src/theme-design.ts`），由上表的角色派生，组件优先用它们。
- 文字与底色的对比度至少 4.5:1，非文字（图标、边框、焦点环）至少 3:1，由 `scripts/check-theme-contrast.ts` 检查所有内置主题。

### 1.1 代码高亮角色

代码高亮风格独立于界面主题（`data-theme`），由设备本地偏好选择（默认 `auto` 跟随界面主题，或指定内置风格）。所有风格共用 14 个语法色角色与 2 个界面派生角色，定义在 `packages/contracts/src/code-theme.ts` 与 `scripts/code-themes.ts`：

| 角色 | 用于 | 说明 |
|---|---|---|
| `fg` | 默认正文、运算符、标点、普通变量 | 继承界面主题 `fg`，保证任何纸底上的最高可读性 |
| `comment` | 注释 | 默认斜体（`commentItalic`），渲染时向 `fg-3` 微混 |
| `keyword` | 关键字、存储修饰符、基础类型关键字 | |
| `string` | 字符串、字符、正则、diff 插入片段 | |
| `number` | 数字字面量 | |
| `constant` | 布尔、空值、全大写常量、枚举成员 | |
| `declaration` | 函数与方法声明或调用标识 | |
| `type` | 类、接口、结构体、类型名 | |
| `property` | 成员属性、对象字段 | |
| `namespace` | 包名、命名空间、导入路径 | |
| `tag` | HTML / XML 标签、选择器 | |
| `attribute` | 属性名、对象或配置键名 | |
| `annotation` | 注解、装饰器 | |
| `escape` | 转义字符、模板插值定界符 | |
| `heading` | 标记语言标题 | |
| `link` | 代码内链接 | 继承界面主题 `accent` |

- **无独立底色**：代码块始终画在界面主题的 `bg-subtle`（文件预览为 `bg`）上，不取第三方主题自带背景。
- **纸底融合**：非注释语法色向当前主题 `fg` 混合（浅色留 88% 原色、深色 90%），注释向 `fg-3` 混合（浅色 80%、深色 85%），避免高饱和语法色在纸底上发飘。

## 2. 文字

### 2.1 角色

| 角色 | 用于 | 字重 |
|---|---|---|
| 正文 | 对话正文、用户消息、输入框 | 400 |
| 界面 | 行、按钮、菜单、标签页、工具名 | 400；分组标题、工具名、未读会话 500 |
| 次要 | 时间、计数、路径、元信息、分组标题 | 400 / 500 |
| 注脚 | 对话里每条消息下的时间、速度、用量 | 400 |
| 标题 | 页面标题、弹窗标题、导航栏标题 | 500；移动端按平台惯例 |
| 代码 | 代码块、命令、路径 | 400 |

### 2.2 取值

字号 / 行高。桌面的单位 Web 为 px、Mac 为 pt，数字相同；移动为 sp（Android）和 pt（iOS）。

| 角色 | 桌面 · Riffet | 移动 · ios | 移动 · material3 | 移动端角色名 |
|---|---|---|---|---|
| 正文 | 14 / 23 | 16 / 22 | 16 / 24 | `body` |
| 界面 | 13 / 20 | 15 / 20，500 | 14 / 20，500 | `label`、`button`、`menu` |
| 次要 | 12 / 16 | 13 / 18 | 12 / 16 | `caption` |
| 注脚 | 11 / 16 | 同次要 | 同次要 | `caption` |
| 标题 · 弹窗 | 16 / 24，500 | 17 / 24，500 | 24 / 32 | `dialogTitle` |
| 标题 · 导航栏 | 13 / 20，500 | 17 / 24，500 | 22 / 28，500 | `barTitle` |
| 标题 · 大标题 | 无 | 34 / 41，700 | 32 / 40，500 | `largeTitle` |
| 代码 | 13 / 20（行内 0.86em） | 14 / 22 | 14 / 22 | `mono` |

移动端的值取自 `ThemePresets.kt`：material3 风格是 Material 3 的字阶（`bodyLarge`、`labelLarge`、`bodySmall`……）去掉字距；ios 风格是 Cupertino 的字阶。iOS 原生端与 ios 风格取同样的值，用 Dynamic Type 的文字样式缩放。

- 桌面只用 400、500 两种字重，600 只给品牌名。移动端的大标题字重跟平台。
- 注脚是桌面对话里特有的一档，移动端屏幕小、字号已经是触摸尺寸，不再细分，用次要。
- 移动端的组件文字角色（`button`、`menu`、`segmented`、`dialogTitle`……，见 `THEME_TEXT_ROLES`）默认取上表对应的角色，风格可以单独覆盖。
- 注脚只用在对话里每条消息下的元信息，界面其他地方用次要。
- iOS 原生的导航栏标题用 600，和系统导航栏的标题一致；Android 的 ios 风格是 500。这是 iOS 原生端有意的覆盖，写在 `packages/contracts/src/mobile-styles.ts` 的 `IOS_NATIVE_OVERRIDES`。
- 现状：Web 的弹窗标题是 600，改为 500。

### 2.3 字体

| | 桌面 · Riffet | 桌面 · 原生、线条 | 移动 |
|---|---|---|---|
| 界面 | Inter，中文回退苹方 | 系统字体 | 系统字体 |
| 代码 | JetBrains Mono，中文回退苹方 | 系统等宽 | 系统等宽 |

用户可以在设置里换字体和调整字号缩放，规则里的字号是缩放前的值。

### 2.4 排版

中文排版参照 [中文排版需求](https://www.w3.org/TR/clreq/)。设计规范页的「排版」一章逐条画出对错对照。

- **中英混排**：文案里中文与英文、中文与数字之间加一个半角空格（「运行 Codex」「3 个文件」）；紧挨全角标点的一侧不加（「先运行 Codex，再提交。」）。代码在字体切换处加空格，不靠字距。
- **标点**：中文用全角标点。并列的元信息用前后带空格的间隔号 ` · ` 分开（「已处理 · 1m 41s」），不用竖线。省略号用单字符 `…`，不写三个点。不用感叹号。
- **数字**：会变化的数字（时间、计数、速度、表格列）用等宽数字（Web `tabular-nums`，Mac/iOS `monospacedDigit()`，Android `fontFeatureSettings = "tnum"`）。表格列右对齐。
- **截断**：单行标签截尾，加 `…`（Web `truncate`）。路径截中间，保留文件名：目录段 `truncate`，文件名段 `shrink-0`。截断的文字在悬停或长按时能看到全文（Web `Tip`）。会话标题、文件名不截到只剩几个字：容器给不出最小宽度时换布局，不压缩文字。
- **行高**：正文至少 1.6 倍；多行中文段落不低于 1.5 倍。单行控件的文字在容器里垂直居中（`items-center`），按字体的视觉中心对齐，不按行框。
- **换行**：长 URL、路径、无空格的英文串允许任意处断行（Web `overflow-wrap: anywhere`）。行首不出现句号、逗号这类标点（平台默认的禁则即可，不自己断行）。
- **行内代码**：不加底色和内边距，用等宽字体，字号 0.86em，颜色比正文弱一档（`fg-2`）。这是 Riffet 风格的配方 `inlineCode: plain`（`docs/design/riffet-style.md` §2，`packages/contracts/src/interface-styles.ts`）；原生和线条风格仍是 `chip`。
- **选中**：内容可以选中复制（正文、代码、错误原因）；界面文字和元信息不可选中，光标不变成文字光标（Web `select-none cursor-default`）。
- 文案本身（语气、用词、错误、空状态、术语、时间与数字的写法）见 [content.md](content.md)。

现状：
- Web 没有全局的 `user-select: none`：界面文字不可选只靠 26 处 `select-none`，其余按钮、标签仍可被拖选。
- Web 没有路径截中间的公共组件，调用处各自处理；需要时抽成一个，同时处理 `Tip`。

## 3. 间距

只用这几个值：**2 · 4 · 8 · 12 · 16 · 20 · 24 · 32**。28 只用于对话列的边距和轮次之间。

| 关系 | 桌面 | 移动 |
|---|---|---|
| 同一组内的元素 | 4–8 | 8 |
| 组与组之间 | 16 | 20 |
| 页面边距 | 12–16 | 16 |
| 对话轮次之间 | 24–28 | 24 |
| 浮层的内边距 | 4 | 8 |

- 嵌套的圆角按 §5 的规则随内边距变化。
- Mac 用 `Space.*`（`apps/macos/Riffet/Theme/Controls.swift`），Web 用 Tailwind 的 4px 单位，移动用 `DesignMetrics` 的字段；业务代码不写裸数字，`check:design` 已拦截 Mac 新增的数字内边距。

## 4. 尺寸与点击区

| | 桌面 · Riffet | 移动 · ios | 移动 · material3 |
|---|---|---|---|
| 列表行 | 30 | 52 | 52 |
| 图标按钮 | 28 × 28 | 图标 22，点击区 44 | 图标 24，点击区 48 |
| 胶囊 | 高 26 | 高 34 | 高 32 |
| 输入框 | 单行 32 | 48 | 48 |
| 分段控件 | 32 | 34 | 40 |
| 菜单行 | 32 | 48 | 48 |
| 导航栏 / 卡片头 | 44 | 56 | 64 |

- 点击区和视觉尺寸分开：图形可以小，点击区不缩。最小点击区：桌面 24，iOS 44pt，Android 48dp。
- **Web 按钮**（`apps/web/src/components/ui/button.tsx`）：

| `size` | 高 | 圆角 | 文字 | 图标 |
|---|---|---|---|---|
| `xs` | 24 | `rounded-md` | `text-xs` | 14 |
| `sm` | 28 | `rounded-lg` | `text-sm` | 14 |
| `md`（默认） | 32 | `rounded-lg` | `text-sm` | 16 |
| `lg` | 36 | `rounded-lg` | `text-base` | 16 |
| `icon-xs` | 24 × 24 | `rounded-md` | | 14 |
| `icon-sm` | 28 × 28 | `rounded-lg` | | 16 |
| `icon` | 32 × 32 | `rounded-lg` | | 16 |

- **Web 的触摸点击区**：指针是手指的设备（`@media (hover: none)`，Tailwind 变体 `no-hover:`）上，`Button` 通过 `.ui-button` 取 44 × 44 的最小尺寸，`Input` 是 `no-hover:min-h-11`，`Switch` 是 `no-hover:size-11`（轨道仍画 32 × 18）。判断依据是指针而不是视口宽度：窄的桌面窗口保持鼠标尺寸。手写的可点元素自己加 `no-hover:min-h-11`。
- **阅读列宽**：Web 的对话列宽可由用户拖动，默认 920，范围 640–1600（`apps/web/src/lib/content-width.ts`，存在 `localStorage` 的 `riffet.contentWidth`，CSS 变量 `--content-width`）；Mac 默认 760，范围 640–1600（[决定](../DECISIONS.md) 2026-11-13，[macos.md](macos.md) §3.1）。输入框比列宽多 24。移动端内容最大宽度 760（iOS）、840（Android）。

现状：
- 手写的 `<button>` 约 230 处没有走 `Button`，不带 `.ui-button`，触摸设备上的点击区要靠各处自己加 `no-hover:min-h-11`。
- 设置页的 `SettingsLinkRow` 行高 48（`min-h-12`），高于桌面的列表行 30，这是设置页自己的行；是否并入列表行的取值待定。

## 5. 圆角

| 档 | 用于 | 桌面 · Riffet | 移动 · ios | 移动 · material3 |
|---|---|---|---|---|
| 控件 | 按钮、页签、胶囊、列表行 | 8 | 10 | 12 |
| 容器 | 代码块、菜单里的行 | 10 | 8 | 12 |
| 卡片 | 内容卡、用户消息、设置分组 | 12 | 12 | 20 |
| 菜单 | 菜单、弹出层 | 12 | 10 | 12 |
| 浮层 | 输入框、悬浮面板 | 16 | 14 | 20 |

- 嵌套时内圆角 = 外圆角 − 内边距，小于 4 时取 4。
- 胶囊和圆形按钮取高度的一半（Web `rounded-full`）。例：高 26 的胶囊半径 13。
- 圆角用连续曲线（Apple 的 `.continuous`），Web 用普通圆角。
- iOS 原生的分组 16、输入框 24，比 Android 的 ios 风格（12、14）圆：Liquid Glass 的形状与屏幕圆角同心，Compose 的模仿不需要。这是 iOS 原生端有意的覆盖，同样写在 `IOS_NATIVE_OVERRIDES`。

## 6. 层级与阴影

层次靠底色，不靠阴影：窗口底、内容面、选中、悬停四层底色已经够用。只有浮在内容上的东西有阴影。

| 档 | 用于 | Web 现有 token |
|---|---|---|
| 平面 | 卡片、列表、面板 | 无阴影 |
| 抬起 | 分段控件的选中项、开关的滑钮这类略高于底面的控件 | `shadow-soft` |
| 浮动 | 输入框；聚焦时加深一级 | `shadow-composer`、`shadow-composer-focus`；窄屏网页的输入框用 `shadow-soft`、`shadow-focus` |
| 弹出 | 菜单、弹出层、提示气泡、弹窗 | `shadow-pop` |
| 悬浮 | 悬浮面板、全屏预览 | `shadow-peek` |

- 桌面的阴影随明暗模式变（不随配色变），以 `apps/web/src/styles/index.css` 为源；`pnpm gen:styles` 把它们换算成 Mac 的 `Elevation`，SwiftUI 用 `.elevation(_:)`，AppKit 的图层用 `Elevation.apply(to:dark:)`。SwiftUI 的阴影没有扩散值，生成器按高斯分布折算负扩散：半径取 CSS 模糊的一半，透明度乘以 2Φ(扩散 / 半径)。表面自己描 1px 的线，阴影里的细描边（`0 0 0 0.5px`）不再生成。
- 移动端的阴影属于界面风格：material3 和 ios 各有一套（`floatingShadow*`），主题可以覆盖，不照搬 Web 的值，随 §11 第 3 步迁到 contracts。
- 叠放顺序从下到上：内容 → 侧栏和面板 → 底部停靠 → 全屏 → 拖放提示 → 遮罩 → 弹窗 → 菜单 → 提示气泡 → 通知（Web 的 `--z-*`）。原生端按同样的顺序决定谁盖住谁。
- 已收掉（2026-11-14）：没有调用点的 `shadow-lift`；`shadow-xs` 并入 `shadow-soft`。

## 7. 动效

### 7.1 档位

| 档 | 用于 | 桌面 | 移动 · material3 | 移动 · ios |
|---|---|---|---|---|
| 即时 | 悬停、按下、颜色变化 | 120–150 | 150 | 180 |
| 标准 | 展开、切换、调整大小 | 200 | 250 | 280 |
| 强调 | 浮层、页面、视图之间的转场 | 250–300 | 300（进页） | 350（进页） |
| 退出 | 关闭、消失 | 100–140 | 200–220 | 250 |

单位毫秒。退出比进入短。

### 7.2 曲线

| 名称 | 用于 | 值 |
|---|---|---|
| 标准 | 原地变化 | `cubic-bezier(0.2, 0, 0, 1)` |
| 减速 | 进入 | `cubic-bezier(0.05, 0.7, 0.1, 1)` |
| 加速 | 退出 | `cubic-bezier(0.3, 0, 0.8, 0.15)` |
| 柔和减速 | 图片放大、面板出现 | `cubic-bezier(0.2, 0.7, 0.2, 1)` |
| 底部面板 | 移动端的底部面板 | `cubic-bezier(0.32, 0.72, 0, 1)` |

- Android 的 ios 风格用 `cubic-bezier(0.25, 0.1, 0.25, 1)`，与 material3 的标准曲线不同，这是风格差异，不是漂移。
- Mac 用 SwiftUI 的 `snappy` / `smooth`，iOS 用弹簧（`RiffetMotion`）。弹簧不换算成贝塞尔，按平台习惯，档位与上表对应。

### 7.3 规则

- 浮层以触发控件为变换原点进入与退出；内容切换期间，容器保持位置与尺寸；控件状态在原位过渡。
- 动画属性为透明度、位移、缩放，由合成器执行。例外是脱离文档流的单个元素随目标改变宽度，如分段控件的选中块：它的重新布局只涉及自身。
- 循环动画只给进行中的指示和品牌标志，写明原因（`motion-loop:`，由 `check:design` 检查）。
- 系统开启「减少动态效果」时，位移和缩放换成淡入淡出。
- Web 读取和等待动画只经 `apps/web/src/lib/motion.ts`。

## 8. 图标

- 图形用 Lucide，桌面 1.25 描边，描边粗细在各尺寸下保持不变。Mac 默认风格可选 SF Symbols，用户也可以换图标包。
- 图标颜色跟随所在行的文字；主导航以外的图标降一级。

| 用途 | Web | Mac | 移动 |
|---|---|---|---|
| 主导航 | 18 | 12.5 | 24 |
| 按钮、页签 | 16 | 13 | 20 |
| 行内 | 14 | 12 | 18 |
| 元信息 | 12 | 11 | 16 |

- Mac 的图标按字号排版，同一个数字画出来比 Web 大，不照搬 Web 的值。左栏、标签栏、右侧面板的同类图标一样大。
- 图标有一套语义名（`apps/macos/scripts/icon-map.json` 的值，如 `SquareTerminal`），各端用同一个名字映射到自己的图形。

## 9. 状态

所有可交互的组件从这套状态里取，组件规范只列自己有的。设计规范页的「状态」一章把它们画成矩阵。

| 状态 | 桌面 | 移动 · material3 | 移动 · ios / iOS 原生 |
|---|---|---|---|
| 默认 | | | |
| 悬停 | 底色 `bg-hover`，文字升一级 | 无 | 无（iPad 指针用系统悬停效果） |
| 按下 | 底色 `bg-active`；按钮缩放到 0.97 | 水波纹 | 降低透明度（按钮 0.55），列表行用 `press` 底色 |
| 键盘焦点 | 2px `focus` 焦点环，只在键盘操作时显示 | 焦点覆盖色 | 系统焦点 |
| 选中 | 导航行（侧栏的当前会话）底色 `bg-active`，文字 `fg`；菜单和选择列表里的当前值只打勾 | 导航目的地（底栏、页签、当前会话）用 `selected` 底色或指示条；选择面板、菜单、单选的当前值只在行尾打勾，不填充（[移动端页面](mobile.md) §1.1） | 行尾勾选 |
| 禁用 | 透明度 0.5，不响应 | 内容色 `disabledContent`，透明度 0.38 | 系统禁用样式 |
| 加载 | 原位换成 spinner，尺寸不变 | 同左 | 同左 |
| 错误 | `danger` 文字或描边，附原因 | 同左 | 同左 |

- 状态变化不改变组件尺寸：加载时文字换成 spinner，宽度保持；选中加粗时预留粗体的宽度。
- 禁用的原因看不出来时，在旁边说明或在悬停提示里写原因。

### 9.1 Web 的写法

| 状态 | `Button`（`secondary`） | 列表行 | 输入框（`fieldClass`） | `Switch` |
|---|---|---|---|---|
| 悬停 | `hover:bg-fg/[0.11]` | `hover:bg-hover`，文字 `text-fg` | `hover:border-fg-4/60` | 无 |
| 按下 | `active:scale-[0.97]` | `bg-active` | 无 | 无 |
| 键盘焦点 | `focus-visible:ring-2 ring-focus` | `focus-visible:ring-2 ring-inset ring-focus` | `focus:border-accent focus:ring-3 ring-accent/15` | `focus-visible:ring-2 ring-focus` |
| 选中 | `data-[state=open]` 同悬停底色 | `bg-active text-fg` | 无 | 轨道 `bg-primary` |
| 禁用 | `disabled:opacity-50`，`pointer-events-none` | `opacity-50` | `disabled:opacity-50` | `disabled:opacity-50` |
| 加载 | 文字换成 `Spinner`，宽度固定 | 行尾换成 `Spinner` | 无 | 无 |

- 全局的 `:focus-visible` 是 `outline: 2px solid var(--focus-ring)`、偏移 1px（`index.css`）；输入框和文本域去掉轮廓，改用边框加光晕。组件的 `ring-2 ring-focus` 覆盖全局的轮廓。`lib/focus-ring.ts` 保证只按修饰键（⇧⌘ 截图、⌘ 选菜单）时不在指针刚聚焦的元素上画环，Tab、回车、输入仍显示。
- 贴着容器边缘的整行（`SettingsLinkRow`）用 `ring-inset`，环画在行内。
- `Spinner` 是 14 的 `IconLoaderCircle`，颜色 `fg-3`，放在按钮里时用 `text-current`。

## 10. 无障碍

设计规范页的「无障碍」一章画出下列各项。

### 10.1 名称与键盘

- 每个可交互元素都有名称；只有图标的按钮必须有无障碍名称（Web `aria-label`，Mac/iOS `accessibilityLabel`，Android `contentDescription`）。Web 同时用 `Tip` 把名称显示给指针和键盘用户。
- 键盘能到达所有操作，指针能做的键盘都能做：悬停才出现的操作在 `focus-within` 时同样出现（`group-focus-within:opacity-100`）；右键菜单有对应的「更多操作」按钮；`Tip` 在键盘焦点时显示。
- Tab 顺序与视觉顺序一致；Esc 关闭最上层的浮层，焦点回到打开它的控件。
- 焦点环在所有主题下与底色的对比度至少 3:1（`scripts/check-theme-contrast.ts`）。

### 10.2 对比度

- 文字与底色至少 4.5:1，非文字（图标、边框、焦点环）至少 3:1，见 §1。
- `fg-4` 只给占位、快捷键和行尾时间，不承载需要读清的信息（§1）。
- 状态不只靠颜色表达：出错同时有图标或文字。

### 10.3 文字缩放

- 文字随系统或用户的字号设置缩放：Web 的 `--text-scale`，Mac 的文字缩放，iOS 的 Dynamic Type，Android 的字体倍率。
- Web 的设置项「文字大小」是 0.9 / 1 / 1.1 / 1.2 四档（`apps/web/src/lib/display-settings.ts` 的 `textScales`）；字号与行高一起乘以该值，间距和控件高度不缩放。
- 布局在 1.6 倍时不重叠、不截断关键信息。

### 10.4 减少动态效果

系统开启「减少动态效果」时：位移、缩放换成淡入淡出；过渡缩短为 100ms 线性，只保留 `opacity`、颜色类属性；循环动画（spinner）换成缓慢的淡入淡出。写在 `index.css` 的 `@media (prefers-reduced-motion: reduce)`；规则见 §7.3。

### 10.5 触摸

触摸设备上的点击区见 §4，最小 44（iOS）、48（Android）。

现状：
- Web 的文字缩放最大 1.2，没有做到 §10.3 的 1.6 倍。
- `Tip` 之外仍有约 150 处原生 `title=` 提示，键盘用户看不到。
- `session/NativeInteractionCard.tsx` 的选项仍是原生 `<input>`（按题目在多选与单选间切换），没有用 `Checkbox` / `RadioGroup` 的焦点环和 44 点击区。

## 11. 数值的来源

**随主题变的值在 CSS，不随主题变的值在 contracts。** 每个值只在一处定义，其余各端由生成器产出，生成器的 `--check` 保证生成物最新。

| 类别 | 来源 | 生成 |
|---|---|---|
| 颜色角色 | `apps/web/src/styles/index.css` | `pnpm gen:theme` → Android、Mac、iOS |
| 代码高亮风格 | `packages/contracts/src/code-theme.ts`、`scripts/code-themes.ts` | `pnpm gen:theme` → Web（`index.css` 标记区、`code-themes.generated.ts`）、Android、Mac、iOS |
| 桌面阴影 | `apps/web/src/styles/index.css` | `pnpm gen:styles` → Mac 的 `Elevation` |
| 桌面风格：配方、圆角、文字、布局 | `packages/contracts/src/interface-styles.ts` | `pnpm gen:styles` → Mac（Web CSS 待接入） |
| 间距、桌面文字阶梯、动效时长与曲线 | `packages/contracts/src/design-tokens.ts` | `pnpm gen:tokens` → Web 的 CSS 变量（`index.css` 的标记区）、Mac 的 `Space` 和 `Motion`（`Controls.swift` 的标记区）；移动端待接入 |
| 图标尺寸 | 待定 | |
| 移动风格：尺寸、圆角、阴影、动效、ios 风格的文字 | `packages/contracts/src/mobile-styles.ts`（字段名和上下限在 `theme-design.ts`，生成时检查取值在上下限内） | `pnpm gen:tokens` → Android 的 `MobileStyles.generated.kt`；iOS `RiffetDesign.swift` 的标记区（`RiffetText`、`RiffetMetrics`、`RiffetMotion`），取 ios 风格的值加上 `IOS_NATIVE_OVERRIDES` |
| 移动风格：组件配方 | `ThemePresets.kt` | 是代码，不是数值，留在 Kotlin |

落地顺序：

1. ~~在 contracts 建立间距、动效、文字阶梯的唯一定义，生成 Web 的 CSS 变量和 Mac 的 `Space`、`Motion`，替换手写值。~~ 已完成（2026-11-14）。Mac 的 `Motion.fast` 由 0.12 秒改为 Web 的 0.15 秒。Mac 的字号仍在调用处写数字，随组件迁移换成文字角色。
2. ~~桌面阴影生成到 Mac，替换手写的阴影；收掉多余的 token。~~ 已完成（2026-11-14）。Android 不再生成用不到的 CSS 阴影字符串；移动端阴影并入第 3 步。
3. ~~移动风格的取值（含阴影）迁到 contracts，生成 Kotlin 和 iOS。~~ 已完成（2026-11-14）。iOS 的弹簧参数由 Compose 的刚度换算（response = 2π / √k），与原手写值相同；iOS 26 以前的悬浮阴影透明度由 0.10 改为 ios 风格的 0.12；ios 风格的 `titleMedium` 改由数据定义，字距从 Material 默认的 0.15 变为 0。
4. ~~`check:design` 补上 Mac 的圆角、阴影、字号，以及 iOS 的数值。~~ 已完成（2026-11-14）。阴影是硬规则：Mac 和 iPhone 只能用生成的层级，主题层和画内容的文件（主题预览、导出图片）除外。内边距、圆角、字号按文件记基线，只降不升；记下的存量是 Mac 与 iPhone 共 84 个文件 375 处内边距、28 个文件 64 处圆角、108 个文件 1123 处字号，随组件迁移逐步清零。
