# Web 客户端

补充根目录 [AGENTS.md](../../AGENTS.md)，那里的「改界面」同样适用。规范在 `docs/design/system/`，设计规范页的代码在 `src/app/design/`，开发时地址为 `/design`。

## 组件

每种组件只有一个实现，在 `src/components/ui/`。业务代码不再自己画同一种东西：

| 要做的 | 用 |
|---|---|
| 按钮、图标按钮 | `Button`（`button.tsx`），进行中用 `busy`，不要同时设 `disabled` |
| 输入框、多行输入、带标签的字段 | `Input`、`Textarea`、`Field`（`controls.tsx`），错误用 `Field` 的 `error` |
| 下拉选择、开关、分段、下划线标签 | `Select`、`Switch`、`Segmented`、`UnderlineTabs`（`controls.tsx`） |
| 多选框、单选、滑块、搜索框 | `checkbox.tsx`、`radio-group.tsx`、`slider.tsx`、`search-field.tsx` |
| 列表行、复制按钮、骨架屏 | `list-row.tsx`、`copy-button.tsx`、`skeleton.tsx` |
| 徽标、状态点、状态胶囊、按键、空状态 | `Badge`、`StatusDot`、`StatusPill`、`Kbd`、`EmptyState`（`controls.tsx`） |
| 提示气泡 | `Tip`（`tooltip.tsx`）。新代码不用原生 `title=` |
| 通知、提示条 | `toast`（`src/lib/toast.ts`）、`Notice`、`FeedbackNotices` |
| 弹窗、确认、输入名称 | `DialogContent` 按 `size` 选宽度；确认和单行输入用 `confirmDialog`、`promptDialog`（`src/lib/dialogs.ts`），`confirmLabel` 写动作本身 |
| 菜单、弹出层 | `dropdown-menu.tsx`、`popover.tsx` |
| 整页 | `PageScaffold`（`src/app/PageScaffold.tsx`），按内容选 `column` |

表里没有的，先按根目录「改界面」补规范，再在 `src/components/ui/` 实现，不放进业务目录。

## 样式

- 只用 Tailwind 的设计变量类（`text-fg-2`、`bg-elevated`、`rounded-lg`、`shadow-soft`……）。`text-[Npx]`、`rounded-[Npx]`、`z-[N]`、`-[#hex]` 会被 `pnpm check:design` 拦下。
- 新取值加到源头再生成到各端，不在组件里写死：颜色和圆角在 `src/styles/index.css`（`pnpm gen:theme`），字号、间距、动效在 `packages/contracts/src/design-tokens.ts`（`pnpm gen:tokens`）。
- 窄屏用 `max-md:` 调整。点击区和图形分开算：桌面至少 24px，触屏至少 44px。
- 深浅色和各风格都要看：颜色只用语义变量，不判断主题名。

## 动画

- 动画状态只通过 `src/lib/motion.ts` 读取和等待。`pnpm check:motion` 会拦下直接调用 `getAnimations()` 和 Animation 的 `.finished`。
- JS 里读 CSS `--duration-*` 必须经 `src/lib/motion.ts` 的 `cssDurationMs` 解析（或直接用 `@contracts` 的 `MOTION_DURATION`）：生产构建的 CSS 压缩会把 `300ms` 写成 `.3s`，直接 `parseFloat` 会变成 `0.3` ms；`pnpm check:motion` 会拦下裸读。
- 复查动画状态要让出一帧，不用微任务循环：已结束、但因 `fill: 'forwards'` 仍留在列表里的动画，曾让一个标签页死循环。
- 动画结束后要移除的元素，由这段动画自己的结束来触发移除（`exit`）；定时器只作为动画没运行时的兜底。
- 循环动画只用于进行中的指示和品牌标志，要在同一行或上方两行内写 `motion-loop: <原因>`。

## 文案与多语言

- 用户可见的文字都经过 Lingui（`t` 宏或 `<Trans>`），包括 `aria-label` 和 `title`。
- 改完运行 `pnpm i18n:extract`，在 `src/locales/en/` 对应的 `.po` 里补英文，再运行 `pnpm i18n:check`。
- 同一个中文在不同目录下要译成不同英文时，加 `context` 区分，不要让两份目录互相冲突。

## 性能

规则与预算在 [Web 流畅度规范](../../docs/guide/web-performance.md)，这里只列最容易做错的。

- 条目可能过百的列表用 `src/lib/use-list-window.ts` 的 `useListWindow`，不整表 `map`；下拉菜单给条目数设上限。
- 传给子组件的数组和对象在源头用 `useMemo` 做一次，不在 JSX 里写 `list.filter(...)`。
- 组件里的定时器用 `useVisibleInterval`；隐藏的标签页不轮询（`pnpm check:perf` 的 `webInterval`）。
- 重连用 `reconnectDelay`；被取代的请求传 `AbortSignal` 并在 effect 清理时中止。
- 改了列表、转录、输入框或页面切换，跑 `pnpm perf:web run <场景>`，读数写进 PR。

## 设计规范页

- 新组件或新变体：在 `src/app/design/components/` 对应的章节里加一个 `Specimen`，用真实组件画出每种状态。
- 新的章节：在 `src/app/design/catalog.tsx` 登记，代码放在与组同名的目录里。
- 页面上只放名字和数值；规则的理由写在 `docs/design/system/` 的文档里，两边不重复。

## 其他

- 快捷键只有一张表：`packages/contracts/src/shortcuts.ts`。Web 的处理一律问 `src/app/shortcuts/` 的 `matches(event, id)`，显示用 `shortcutHint` / `shortcutCaps`，不在业务代码里写键位；`src/app/hostShortcuts.ts` 只放名称与分组。用户改键存在 `riffet.shortcuts.v1`，插件快捷键的禁用表读的是生效后的键位。
- 插件能用的组件和样式在 `packages/plugin-web`；给它加的 UiKit 成员设为可选，SDK 在旧宿主上要能退回。基础样式由 `pnpm gen:plugin-style` 生成，Mac 用的那份也会一起生成。
- 侧栏、导航栏、标签栏和会话信息等首屏壳层依赖的状态，统一随 `/api/bootstrap`（轻量摘要）和 `list-cache.ts` 同步水合，不在 `WorkbenchEffects` 里用 `useEffect(loaded)` 串行拉取，避免刷新首帧缺图标后再跳出来。
