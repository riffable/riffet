# 架构

设计体系在代码里分六层，依赖只向下：上层引用下层的名字，下层不知道上层。

| 层 | 内容 | 位置 |
|---|---|---|
| 6 页面 | 产品功能 | `apps/web/src/app/`、`apps/macos/Riffet/Features/`、移动端各页面 |
| 5 模式 | 页面骨架、设置行、弹窗结构、确认与通知 | [patterns.md](patterns.md)；Web 的 `app/settings/SettingsLayout.tsx`、`lib/dialogs.ts`、`lib/toast.ts` |
| 4 组件 | 每种组件每端一个实现 | Web `apps/web/src/components/ui/`；Mac `apps/macos/Riffet/Theme/`；Android `apps/mobile/shared/src/commonMain/kotlin/riffet/ui/design/`；iOS `apps/mobile/iosApp/Riffet/Design/` |
| 3 生成文件 | 各端可直接引用的常量 | 见下表，文件头标明「generated」，手改会被 `--check` 拦截 |
| 2 源 | 颜色角色与主题取值；代码高亮；间距、字号、圆角、动效；风格配方 | `apps/web/src/styles/index.css`；`scripts/code-themes.ts`；`packages/contracts/src/design-tokens.ts`、`mobile-styles.ts`、`interface-styles.ts`、`theme.ts`（`THEME_ROLES`）、`code-theme.ts` |
| 1 原则 | 三条原则与设计决定 | [README](README.md) §2、[DECISIONS](../DECISIONS.md) |

- 页面只经组件和模式使用样式。组件只引用颜色角色（`fg`、`bg-elevated`……）和档位（`--duration-fast`、`rounded-xl`……），不写色值和像素。
- 颜色的源是 `index.css`，其余数值的源是 `packages/contracts`。两处都只在源里改，然后重新生成。

## 生成

| 命令 | 读 | 写 |
|---|---|---|
| `pnpm gen:theme` | `index.css` 的主题、`scripts/code-themes.ts` | Web `index.css`（`code-themes` 标记区）、`lib/theme-ansi.generated.ts`、`lib/code-themes.generated.ts`；Shared `packages/contracts/src/theme-builtins.generated.ts`；Android `riffet/theme/RiffetTheme.kt`；Mac `Theme/RiffetTheme.swift`；iOS `Theme/RiffetTheme.swift` |
| `pnpm gen:tokens` | `design-tokens.ts`、`mobile-styles.ts` | Web `index.css` 的生成段；Mac `Theme/Controls.swift`；Android `ui/design/MobileStyles.generated.kt`；iOS `Design/RiffetDesign.swift` |
| `pnpm gen:styles` | `interface-styles.ts`、`index.css` | Mac `Theme/InterfaceStyles.swift` |

每个生成命令都有 `--check` 模式（`pnpm gen:*:check`）：生成结果与仓库里的文件不一致时以非零状态退出。

## 检查

| 命令 | 拦截 |
|---|---|
| `pnpm check:design` | Web 的 `text-[Npx]`、`rounded-[Npx]`、`z-[N]`、`[#hex]`；没写原因的循环动画；Mac 和 iOS 新增的手写内边距、圆角、字号、阴影、曲线（以 `scripts/design-rules-baseline.json` 为基线，只减不增） |
| `pnpm check:motion` | Web 绕过 `lib/motion.ts` 读取动画状态 |
| `pnpm check:compose` | 会导致重建或逐帧重组的 Compose 写法 |
| `pnpm i18n:check` | Lingui 消息之外新增的中文字面量；各语言目录不一致 |

有意的例外在同一行写明原因：`design-rules: allow <原因>`、`web-motion: allow`、`compose-pitfalls: allow`。

## 改动的顺序

- **新增或修改一个取值**：改源（`index.css` 或 `packages/contracts`），运行对应的 `gen:*`，再运行 `--check` 和 `check:design`。在 [foundations.md](foundations.md) 里写明它的用途。
- **新增一个组件**：
  1. 先确认现有组件加一个参数能否覆盖。例如标题式选择是 `Select` 的 `appearance="heading"`，没有新建组件。
  2. 按 [组件模板](components/TEMPLATE.md) 写规范：用途、结构、状态、键盘操作、各端映射。
  3. 依次实现 Web、Mac、Android、iOS，在各端的设计规范页加上它。
  4. 迁移调用点，删除旧写法。
- **新增一种模式**：写进 [patterns.md](patterns.md)，列出现有实现中不符合的地方，迁移后删掉对应的「现状」条目。
- **推翻一条规则**：在 [DECISIONS](../DECISIONS.md) 追加一条新决定，写明原因和否决的做法，再改规范与代码。

## 参考

| 方向 | 参照 |
|---|---|
| 页面布局与断点 | [Material 3 窗口尺寸类别](https://m3.material.io/foundations/layout/applying-layout/window-size-classes)、[Apple HIG · Layout](https://developer.apple.com/design/human-interface-guidelines/layout) |
| 弹窗与浮层的交互 | [WAI-ARIA APG · Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)、[Menu Button](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/) |
| 组件文档的组织 | [Astryx](https://github.com/meta/astryx)（每个组件一页：用法、结构、最佳实践）、[Primer](https://primer.style/) |
| 多端共用一套语义 | [Fluent 2](https://fluent2.microsoft.design/)、[Design Tokens 格式](https://www.designtokens.org/) |
