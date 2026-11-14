# Riffet 设计体系

Web、macOS、Android、iOS 四端共用的设计规范和组件库。改界面先查这里：用哪个组件、组件有哪些状态、键盘和触摸怎么操作、文案怎么写，都以本目录为准。做过的取舍记在 [设计决定](../DECISIONS.md)，否决过的做法不再重做。

## 1. 分层

| 层 | 内容 | 四端是否相同 | 位置 |
|---|---|---|---|
| 原则 | Riffet 是看 agent 干活的工作台：彩色只用来传递信息；正在发生的事最醒目；过渡保留位置关系 | 相同 | §2 |
| 语义 | 颜色角色、文字角色、尺寸档位、状态集合；组件的种类、结构、状态和交互；交互模式；文案 | 相同 | `foundations.md`、`components/`、`patterns.md`、`content.md` |
| 风格 | 每个语义取什么值、组件画成什么形态 | 桌面一套、移动一套，各有几种风格 | 见下 |
| 数值 | 风格的具体取值，只在一处定义，生成到各端 | 来源唯一 | §4 |
| 实现 | 每端每种组件一个实现，业务代码只用它 | 各端各写 | §5 |

语义层不写数值，风格层不改交互。同一个组件在桌面 Riffet 风格下是 28pt 的透明图标按钮，在 iOS 上是系统按钮加 44pt 点击区，但两者的状态、键盘操作、无障碍名称和文案规则相同。

风格层现有两组：

- **桌面**（Mac、Web）：配方 `packages/contracts/src/interface-styles.ts`，`pnpm gen:styles` 生成 Mac 的 `StyleSpec`。Riffet 是主风格，规则见 [Riffet 风格](../riffet-style.md)；原生风格见 [macOS 原生](../macos-native.md)；线条风格见 `interface-styles/`。
- **移动**（Android、iOS）：Android 有 material3、ios、expressive、miuix、fluent 五种风格，规则见 [主题契约](../../THEMES.md) §8–9。iOS 原生端用系统控件，结构与 Android 的 `IosPreset` 对齐，见 [iPhone 原生方案](../../IOS.md)。

颜色不属于风格：53 个颜色角色由主题提供，规则见 [主题契约](../../THEMES.md)。

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
| macOS | 原生风格用系统控件；Riffet、线条风格自绘，组件在 `apps/macos/Riffet/Theme/` | [HIG](https://developer.apple.com/design/human-interface-guidelines/)：菜单键盘导航、按首字母跳转、Esc 关闭、⌘ 快捷键 |
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
- 组件规范按 [模板](components/TEMPLATE.md) 写，一个组件一个文件，放在 `components/`。
- 每端有一页「设计规范」：原则、基础的取值和所有组件的所有状态，用真实组件画、读当前主题的计算值，换主题或深浅色时跟着变。它是独立页面，设置的「外观」组里只放入口。Web 在 `apps/web/src/app/design/`，地址 `/design`。新组件落地时在这一页加一节。
- 页面按印刷样张排：章节在两种纸色之间交替，12 栏网格，图号与说明占前三栏；每条规则配一张图示（剖面、标注图、曲线、叠放），不逐条罗列。界面唯一的彩色是 agent 的颜色，只在封面套印。它用来对照规范和交付前自审，不是 UI 测试（仓库不加 UI 展示测试，见 [AGENTS.md](../../../AGENTS.md)）。
- 页面只放名字和数值，规则的理由与交互细节留在本目录的文档里，两边不重复。

第一批组件，按这次打磨中出问题的频率排序：

| 组件 | 当前最明显的分歧 |
|---|---|
| 按钮、图标按钮 | Web 8 种变体；Mac 只有实心、胶囊、图标三种样式；Android 的封装只有 5 处调用，另有 36 处直接用 Material；iOS 没有封装 |
| 胶囊 | Mac 有手写的 Capsule；四端命名和尺寸各不相同 |
| 菜单、弹出层 | Mac 自绘菜单与系统 `Menu`（145 处）、`Picker`（68 处）并存；弹层有自绘、`.sheet`、`NSAlert` 三种 |
| 下拉选择 | Web 有 `Select` 和 `ChoiceMenu` 两种；Mac 自绘与系统 `Picker` 混用 |
| 弹窗 | 四端基本对齐，Mac 另有 `NSAlert` 直接调用 |
| 多选框、开关、单选、分段 | Web 没有多选框组件，只有裸 `<input>`；Android 的封装几乎没人用；分段控件有四种画法 |
| 输入框 | Android 有三处手写 `BasicTextField`；iOS 没有封装 |
| 提示气泡 | Web 的 `Tip` 110 处，原生 `title=` 379 处；移动端没有 |
| 通知、空状态 | Mac 和 iOS 没有统一组件 |

## 6. 交互模式与文案

- `patterns.md`：反馈（行内、通知、状态行各用在哪；现有的 [应用内提示](../feedback-presentation.md) 并入）、加载、空状态、确认与撤销、危险操作、溢出菜单、悬停才出现的操作、选择。
- `content.md`：界面文案规则、术语表（Git 面板用英文等）、时间与数字格式、中英混排。

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
| 1 | [基础](foundations.md)：颜色、文字与排版、间距、圆角、阴影、动效、图标；数值生成到四端 | 完成：规范已写，数值生成到四端，`check:design` 拦截手写值 |
| 2 | `components/`：第一批组件的规范、四端实现、调用点迁移；各端的设计规范页 | 进行中：Web 的设计规范页已有原则、基础和现有组件 |
| 3 | [模式](patterns.md)：页面布局、浮层、选择控件；[架构](architecture.md)：分层、生成、检查、改动顺序 | Web 已迁移：页面骨架、弹窗四档宽度与页脚、手机上的菜单弹层；Mac 与移动端待对齐 |
| 4 | `content.md` | 待开始 |

[Riffet 风格](../riffet-style.md)、[macOS 原生](../macos-native.md)、[主题契约](../../THEMES.md) §8–9 里属于语义层的内容（原则、状态、组件交互），随阶段 1–2 移进本目录；原文件只留各自风格的取值。
