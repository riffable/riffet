# Riffet 设计体系

Web、macOS、Android、iOS 四端共用的设计规范和组件库。改界面先查这里：用哪个组件、组件有哪些状态、键盘和触摸怎么操作、文案怎么写，都以本目录为准。做过的取舍记在 [设计决定](../DECISIONS.md)，否决过的做法不再重做。

## 1. 分类

规范按从小到大分层，每层只用前面的层。设计规范页的目录和本目录的文档都按这个分：

| 组 | 放什么 | 判断标准 | 文档 |
|---|---|---|---|
| 总览 | 原则、本节的分类 | 读者从这里进来 | 本文 |
| 基础 | 颜色、文字、排版、间距与尺寸、圆角、层级、动效、图标、状态、无障碍、文案 | 只有取值和通用规则，没有部件 | [foundations.md](foundations.md)、[content.md](content.md) |
| 组件 | 按用途分六组：操作、输入、导航、展示、反馈、浮层 | 一个可复用的部件，有变体、尺寸、状态 | [components/](components/) |
| 模式 | 页面、导航、浮层的选用、选择、反馈与加载、确认与撤销、表单与设置、列表、搜索与筛选、键盘 | 几个组件怎么组合、怎么交互 | [patterns.md](patterns.md) |
| 界面 | 会话、新会话、侧边面板 | Riffet 自己的整页 | [surfaces.md](surfaces.md) |
| 扩展与工程 | 插件界面、架构（生成与检查） | 给写插件、改体系的人 | [plugins.md](plugins.md)、[architecture.md](architecture.md) |

- **动效、无障碍、文案不单独成层。** 基础里给它们的取值和通用规则；每个组件、模式、界面再写自己的过渡、键盘操作和用词。
- **一条规则放在用到它的最低一层。** 按钮的按下缩放写在组件，弹窗从触发点展开写在模式，回合结果的位置写在界面。上层只引用，不重写。
- **新内容先找组。** 说不清放哪一组，通常是把两层的东西混在了一起，例如把某个页面的布局写成组件。

另有两条轴，与分层正交：

- **平台**：同一条规则在各端的写法。行为跟平台，数值跟同一份定义（§3）。设计规范页切到 macOS 时目录的分组不变，只换内容；各端的差异写在平台文档，现有 [macOS](macos.md)。
- **风格**：每个语义取什么值、组件画成什么形态。语义层不写数值，风格层不改交互。同一个组件在桌面 Riffet 风格下是 28pt 的透明图标按钮，在 iOS 上是系统按钮加 44pt 点击区，但两者的状态、键盘操作、无障碍名称和文案规则相同。
  - **桌面**（Mac、Web）：配方 `packages/contracts/src/interface-styles.ts`，`pnpm gen:styles` 生成 Mac 的 `StyleSpec`。Riffet 是主风格，规则见 [Riffet 风格](../riffet-style.md)；原生风格见 [macOS 原生](../macos-native.md)；线条风格见 `interface-styles/`。
  - **移动**（Android、iOS）：Android 有 material3、ios、expressive、miuix、fluent 五种风格，规则见 [主题契约](../../THEMES.md) §8–9。iOS 原生端用系统控件，结构与 Android 的 `IosPreset` 对齐，见 [iPhone 原生方案](../../IOS.md)。

颜色不属于风格：53 个颜色角色由主题提供，规则见 [主题契约](../../THEMES.md)。代码里的分层（源、生成文件、组件、模式、页面，依赖只向下）见 [架构](architecture.md)。

## 2. 原则

从 [macOS 原生](../macos-native.md) §1 提升为全产品原则，四端都按这三条取舍：

1. **彩色只用来传递信息。** 界面框架使用灰阶。彩色出现在运行状态、diff、语法高亮和 agent 标志上，每种颜色对应一种含义；强调色只用于焦点环、文本选区和链接。
2. **正在发生的事最醒目。** 运行中、待确认和出错的条目使用正文色；已完成的工具调用和历史轮次降为次要色，或折叠成一行。
3. **过渡保留位置关系。** 浮层从触发它的控件展开、收回；切换内容时容器保持尺寸；控件在原位改变状态（如分段控件的选中块在选项之间滑动）。

规则冲突时，按这三条取舍，再记一条设计决定。

## 3. 平台分工：行为跟平台，外观跟风格

| 端 | 默认做法 | 交互依据 |
|---|---|---|
| Web | 全部自绘，行为由 Radix 提供，组件在 `apps/web/src/components/ui/` | [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/) |
| macOS | 原生风格用系统控件；Riffet、线条风格自绘，组件在 `apps/macos/Riffet/Theme/`；各项语义在 Mac 上的写法见 [macOS](macos.md) | [HIG](https://developer.apple.com/design/human-interface-guidelines/)：菜单键盘导航、按首字母跳转、Esc 关闭、⌘ 快捷键 |
| Android | 只经 `apps/mobile/shared/src/commonMain/kotlin/riffet/ui/design/` 的组件；material3 风格下它们包装 Material 组件，其他风格自绘 | [Material 3](https://m3.material.io/) |
| iOS | 系统 SwiftUI 控件优先，导航和控制层用 Liquid Glass；系统没有的才在 `apps/mobile/iosApp/Riffet/Design/` 自建 | [HIG](https://developer.apple.com/design/human-interface-guidelines/) |

- 平台约定的行为不重新发明：返回手势、系统菜单的键盘操作、Dynamic Type、VoiceOver、TalkBack、减少动态效果。
- 点击区与视觉尺寸分开：桌面指针目标至少 24，iOS 44pt，Android 48dp；图形可以更小，点击区不缩。
- 触摸端没有悬停。只在悬停时出现的东西，在触摸端常显或收进长按菜单，由组件或模式规范写明是哪一种。

## 4. 数值：一处定义，生成到各端

目标：每个数值只在一处定义，其余端由生成器产出，并由 `--check` 检查生成物是否最新。手抄的数值只在注释里写对应关系，没有机制保证一致，迟早漂移。

| 类别 | 现在（2026-11-14 盘点） | 目标 |
|---|---|---|
| 颜色角色 | 已统一：`apps/web/src/styles/index.css` 为源，`pnpm gen:theme` 生成 Android、Mac、iOS | 不变 |
| 桌面风格配方与圆角 | 已统一：`interface-styles.ts` 生成 Mac | 不变，其余桌面数值并入 |
| 文字阶梯 | Web 7 档（`index.css` 里定义了两遍，另有一档 15px）；Mac 在调用处写数字；Android 部分生成；iOS 手写 16/17/15/13/14，与 Web 不是一套 | 语义角色一套，桌面和移动各一组取值，生成四端 |
| 间距 | Web 用 Tailwind 默认；Mac `Space.*`、Android `DesignMetrics`、iOS `RiffetMetrics` 各自手写 | 同上 |
| 阴影 | Web 8 种约 30 处声明；Android 生成 4 种但不用，另有手写值；Mac、iOS 手抄近似值 | 桌面收成五档，生成到 Mac；移动端按风格定义，生成到 Android 和 iOS |
| 动效 | Web 6 个时长、5 条曲线；Mac `Motion.*`、Android、iOS 手写，Android 内部两处标准曲线不一致 | 时长与曲线生成四端；弹簧参数各端按平台习惯，写明对应关系 |
| 图标 | Web 用 Lucide；Mac 映射 `apps/macos/scripts/icon-map.json` 并依赖 Android 的生成物；iOS 用 SF Symbols | 语义图标名一套，各端映射表生成 |

具体的来源文件和生成方式在 `foundations.md` 里定。

## 5. 组件：一种组件一个实现

- 每端每种组件只有一个实现。业务代码不直接用系统或第三方控件画同一种东西；平台需要系统控件时，由组件内部去用。
- 新组件先写规范，再三端（含 iOS）实现，最后迁移调用点。只建组件不迁移，新旧写法会长期并存。
- 组件规范按 [模板](components/TEMPLATE.md) 的标题写，一组一个文件（`components/actions.md`、`inputs.md`、`navigation.md`、`display.md`、`feedback.md`、`overlays.md`），一个组件一节，与设计规范页的六章对应。
- 每端有一页「设计规范」：原则、基础的取值和所有组件的所有状态，用真实组件画、读当前主题的计算值，换主题或深浅色时跟着变。它是独立页面，设置的「外观」组里只放入口。Web 在 `apps/web/src/app/design/`，目录按 §1 分组，一次显示一章，地址 `/design/<组>/<章>`；页头可切到 macOS 部分（`?platform=macos`），讲各风格与 Mac 的写法。章节登记在 `design/catalog.tsx`，代码目录与组同名。Mac 另有一个原生窗口，用来验收组件（[macOS](macos.md) §8）。新组件落地时在这一页加一节。
- 每章按印刷样张排：12 栏网格，图号与说明占前三栏；每条规则配一张图示（剖面、标注图、曲线、叠放），不逐条罗列。界面唯一的彩色是 agent 的颜色，只在封面套印。它用来对照规范和交付前自审，不是 UI 测试（仓库不加 UI 展示测试，见 [AGENTS.md](../../../AGENTS.md)）。
- 页面只放名字和数值，规则的理由与交互细节留在本目录的文档里，两边不重复。

第一批组件，按这次打磨中出问题的频率排序：

| 组件 | 当前最明显的分歧 |
|---|---|
| 按钮、图标按钮 | Web 7 种变体；Mac 只有实心、胶囊、图标三种样式；Android 的封装只有 5 处调用，另有 36 处直接用 Material；iOS 没有封装 |
| 胶囊 | Mac 有手写的 Capsule；四端命名和尺寸各不相同 |
| 菜单、弹出层 | Mac 自绘菜单与系统 `Menu`（145 处）、`Picker`（68 处）并存；弹层有自绘、`.sheet`、`NSAlert` 三种 |
| 下拉选择 | Mac 自绘的 `ChoiceMenu` 与系统 `Picker` 混用（Web 已统一为 `Select`） |
| 弹窗 | 四端基本对齐，Mac 另有 `NSAlert` 直接调用 |
| 多选框、开关、单选、分段 | Android 的封装几乎没人用；分段控件有四种画法（Web 已补齐多选框、单选、滑块） |
| 输入框 | Android 有三处手写 `BasicTextField`；iOS 没有封装 |
| 提示气泡 | Web 的 `Tip` 119 处，原生 `title=` 约 150 处；移动端没有 |
| 通知、空状态 | Mac 和 iOS 没有统一组件 |

## 6. 交互模式、界面与文案

- [模式](patterns.md)：页面与页面类型、导航、浮层的选用、选择、反馈与加载（[应用内提示](../feedback-presentation.md) 的时序仍在原文）、确认与撤销、表单与设置、列表、搜索与筛选、键盘。
- [界面](surfaces.md)：会话（结构、正文排版、消息、工具调用、代码与 diff、审批、回合状态、输入框）、新会话、侧边面板。
- [文案](content.md)：语气、说明文字、按钮与菜单用词、错误、空状态与确认、术语表、时间与数字格式；中英混排在 [基础](foundations.md) §2.4。
- [插件界面](plugins.md)：插件视图的三种呈现方式、位置与尺寸、可用的取值和组件、插件不要做的事。

各文档每节末尾的「现状」列出与规则不符的现有代码，迁移后删掉对应条目。

## 7. 检查

能从源码文本识别的规则，写进现有检查，不另起炉灶：

- `pnpm check:design`：拦截 Web 手写的字号、圆角、z-index、颜色；Mac 和 iPhone 手写的阴影、数值动画曲线；Mac 和 iPhone 的数字内边距、圆角、字号按文件记基线（`scripts/design-rules-baseline.json`），只降不升。之后补业务代码绕过组件直接用系统控件，以及 Android 的数值。
- `pnpm check:motion`、`pnpm check:compose`、`scripts/check-theme-contrast.ts`：继续沿用。
- 各生成器的 `--check`：生成物必须最新。

例外在该行或上一行写 `design-rules: allow <原因>`。

## 8. 参考

不照搬任何一套的外观，只借方法：

| 来源 | 借什么 |
|---|---|
| [Fluent 2](https://fluent2.microsoft.design/) | 一套语义、多端各自实现的组织方式 |
| [Carbon](https://carbondesignsystem.com/)、[Primer](https://primer.style/) | 组件文档的写法；Primer 的 UI patterns（加载、空状态、保存、提示） |
| [Material 3](https://m3.material.io/) | 状态层的定义方法；Android 的交互 |
| [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/) | macOS 和 iOS 的交互 |
| [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/) | Web 组件的键盘操作与无障碍 |
| [中文排版需求 (clreq)](https://www.w3.org/TR/clreq/) | 中英混排、标点、换行、行高 |
| [Design Tokens 格式](https://www.designtokens.org/) | 数值的组织方式 |

## 9. 进度

| 阶段 | 产出 | 状态 |
|---|---|---|
| 0 | 本文、[组件模板](components/TEMPLATE.md) | 完成 |
| 1 | [基础](foundations.md)：颜色、文字与排版、间距与尺寸、圆角、阴影、动效、图标、状态、无障碍；数值生成到四端 | 完成：规范已写，数值生成到四端，`check:design` 拦截手写值 |
| 2 | [组件](components/)：六组组件的规范、四端实现、调用点迁移；各端的设计规范页 | Web：规范与设计规范页已写全，多选框、单选、滑块、骨架屏、搜索框、列表行、复制按钮已实现并迁移调用点；`Progress` 等出现第二处确定进度再抽，原生 `title=` 待换成 `Tip`，余下记在各组的「现状」。Mac、Android、iOS 待迁移 |
| 3 | [模式](patterns.md)、[界面](surfaces.md)、[插件界面](plugins.md)、[架构](architecture.md) | Web 的规范已写全，页面骨架、弹窗四档宽度与页脚、手机上的菜单弹层、列表行与悬停操作、按钮的进行中状态、确认按钮的文案已迁移，其余按「现状」迁移。Mac 的映射与落地顺序在 [macOS](macos.md)，待迁移；移动端待对齐 |
| 4 | [文案](content.md) | 规则与术语表已写；现有文案按「现状」修改 |

[Riffet 风格](../riffet-style.md)、[macOS 原生](../macos-native.md)、[主题契约](../../THEMES.md) §8–9 里属于语义层的内容（原则、状态、组件交互），随阶段 1–2 移进本目录；原文件只留各自风格的取值。
