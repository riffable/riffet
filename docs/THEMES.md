# Riffet 主题契约

本文是主题能力的实现契约，与 `docs/WEB.md`（web 体验）、`docs/MOBILE.md`（移动客户端）并列。
内置 12 套主题：**Riffet（默认）/ Solarized / Catppuccin / Rosé Pine / Everforest / Kiln / Ink / Sepia / Moss / Slate / Pencil / Celadon**；
在此之上，用户可以通过 Web 或 macOS 编辑器新增、复制和修改**自定义主题**。

本文件是主题能力的唯一权威说明：结构、不变量、加主题的步骤、以及所有已知取舍。

## 1. 一句话结构

**`.dark` 决定「明暗」，`data-theme` 决定「哪套配色」，两者互不写入。**

这不是一个实现细节，而是整个设计能成立的原因：全仓库 `dark:` 工具类读的仍然是同一个 class，所以加主题**没有改过一个组件**；而「跟随系统」只写 mode，于是 Solarized 的手机在入夜后仍然是 Solarized。

```css
:root, [data-theme="riffet"]:not(.dark) { /* 默认主题，浅色 */ }
.dark, [data-theme="riffet"].dark       { /* 默认主题，深色 */ }

[data-theme="solarized"]:not(.dark) { /* … */ }
[data-theme="solarized"].dark       { /* … */ }
```

两个属性选择器同为 (0,2,0)，都高于 `.dark` / `:root` 的 (0,1,0)，且互斥 —— 所以带主题的页面在深色模式下解析到该主题的深色半套，而不是回退到默认主题。

自定义主题沿用同一协议：运行时把 `[data-theme="custom-…"]:not(.dark)` / `[data-theme="custom-…"].dark` 规则块注入 `<style id="riffet-custom-themes">`。因此 `ThemeSwatch`、终端和页面不需要知道主题来自 CSS 还是用户编辑。

## 2. 不变量

### 2.1 由生成器或契约强制

| 不变量 | 由谁保证 |
|---|---|
| **每套内置主题必须定义全部 53 个颜色角色**，明暗两半的角色集必须相同 | `scripts/gen-mobile-theme.ts` 的 `assertRoleContract()` / `assertRoles()`，不一致直接失败 |
| 内置主题的颜色值只能是 `#hex` 或 `rgb(r g b / a)` | 同一个生成器：无法表达的形式（如 `oklch()`）会抛出 |
| 每套内置主题的终端 ANSI 恰好 16 个槽位，且为 `#rrggbb` | 同一个生成器；来源是 `scripts/theme-ansi.ts`，三端生成物不允许手改 |
| **自定义主题的结构**：id 为 `custom-[a-z0-9-]{8,64}`；53 个角色齐全且颜色为 `#rrggbb[aa]`；ANSI 恰好 16 个 `#rrggbb`；名称 1–60 字符；说明 ≤200 字符；名称/说明无控制字符；主题数 ≤50；序列化 ≤256KB | `packages/contracts/src/theme.ts` 的 `validateCustomThemes()` / `validateThemeLibrary()`；服务端用同一套规则拒绝，三端读取时重新校验 |
| 自定义主题的 revision 是内容哈希，不是计数器；并发写以 409 拒绝 | `apps/server/src/themes/index.ts` |
| 三端内置调色板与 ANSI 表逐值一致 | 同一个生成器输出的 Kotlin / Swift / Web 表，`pnpm gen:theme:check` 防止漂移 |

### 2.2 设计约定

前两条对比度规则由 `scripts/check-theme-contrast.ts` 守护：`pnpm gen:theme` 与 `pnpm gen:theme:check`（CI）对每套内置主题的明暗两半逐条断言，违反即失败，没有豁免名单。校验的是 `--fg` 阶梯严格递减、`--fg`/`--fg-2`/`--fg-3` 对 `--bg` 的 4.5:1、状态色与 agent 色对 `--bg` 的 3:1、三组填充色前景；`--fg-4`（占位与禁用）只要求阶梯递减。界面风格不带颜色，不参与。`apps/web/src` 的裸色值与字号/圆角/层级字面量由 `pnpm check:design`（`scripts/check-design-rules.mjs`）拦截。其余几条没有自动校验，改动时需要自觉维持：

- 文本阶梯严格递减（`--fg` > `--fg-2` > `--fg-3` > `--fg-4`），内置主题的正文与次要文本达到 WCAG AA（≥ 4.5:1），状态色与 agent 色 ≥ 3:1。
- 填充色上的前景成对达标：`--accent-fg` / `--accent`、`--danger-fg` / `--danger`、`--primary-fg` / `--primary` ≥ 4.5:1。**自定义主题不受此约束**：编辑器只提示，不阻止保存。
- `--line*` **不受**对比度门禁约束。这个仓库用近乎不可见的 hairline 分隔区域（见 `edge-*` 工具类），3:1 的边框会毁掉该设计。
- 同一主题同一模式下，四个 `--agent-*` 必须互相可分辨。它们是后端身份而非装饰。
- 组件里不得出现裸色值；`apps/web/src` 里也不得出现 `text-[Npx]`、`rounded-[Npx]`、`z-[N]`（字号走 `--text-*`，层级走 `--z-*`）。
- `prefers-color-scheme` 只允许出现在 `lib/theme.ts` 与 `public/theme-init.js`。

## 3. 加一套内置主题

1. **CSS**：在 `apps/web/src/styles/index.css` 里加一对块，`[data-theme="<id>"]:not(.dark)` 与 `[data-theme="<id>"].dark`，各写满 53 个角色。
   - 建议只从上游抄「页面底色 / 文本阶梯 / 强调色 / 三个状态色」，其余（`--bg-hover`、`--line*`、`*-soft`、`--diff-*`、`--toast`）按默认主题的同一套规则派生：分隔线是前景色加固定 alpha，`-soft` 是状态色加 alpha，diff 行是状态色按比例混进页面。
   - 派生不是硬性要求，但偏离时要想清楚为什么。
2. **目录**：在 `apps/web/src/lib/themes.ts` 的 `themes` 里加一项，`id` 必须与 CSS 的 `data-theme` 完全一致；借用他人配色时在 `credit` 里写明来源与许可（显示在设置页）。
3. **终端**：在 `scripts/theme-ansi.ts` 的 `BUILTIN_ANSI` 里加 16 个槽位。
   - 上游若发布了 ANSI 表（Catppuccin、Solarized），照抄。
   - 上游没有的话，把它发布的 accent 铺到 6 个色相槽上 —— 16 个槽是**终端与外部程序的契约**（`git diff`、`ls` 读的就是它），必须互相可区分，这一点和应用配色不同。
4. **移动端**：在 `AppPreferences.kt` 的 `ThemeId` 枚举里加一项。该枚举只提供选择器的 id / 名称 / 摘要与顺序；颜色来自生成物。
5. **生成与验证**：

```bash
pnpm gen:theme          # 重新生成 Kotlin / Swift / Web 调色板与 ANSI 表
pnpm gen:theme:check    # CI 会跑；忘了生成就在这一步失败
pnpm typecheck && pnpm test && pnpm build
```

**不要手工编辑**这些生成文件：Kotlin `apps/mobile/shared/src/commonMain/kotlin/riffet/theme/RiffetTheme.kt`、Swift `apps/macos/Riffet/Theme/RiffetTheme.swift`、Web `apps/web/src/lib/theme-builtins.generated.ts` 与 `theme-ansi.generated.ts`。它们都由 `scripts/gen-mobile-theme.ts` 从 CSS 与 `scripts/theme-ansi.ts` 生成。

## 4. 自定义主题（服务端共享）

### 4.1 分工

主题库是**服务端状态**，选择是**设备本地偏好**：

- 哪些主题存在、各自长什么样：`<stateDir>/themes.json`，通过 `GET /api/themes` / `PUT /api/themes` 共享给所有设备；`themes.json` 也纳入备份的 `included` 列表。
- 这台设备显示哪一套：Web `localStorage`、macOS `UserDefaults`、移动端平台 preferences。和字号一样，不同步。

一套自定义主题是自包含的：53 个颜色角色 × 明暗 + 16 个 ANSI 槽 × 明暗，全部显式存储。任何客户端都不需要回退表，也不需要从主题色派生 ANSI。

### 4.2 Wire 格式

定义在 `packages/contracts/src/theme.ts`，Kotlin 端的 `riffet.contracts.Theme*` 是同一份契约：

```ts
interface CustomTheme {
  id: string;            // custom-<uuid>
  name: string;          // 1–60 字符
  description?: string;  // ≤200 字符
  palette: { light: Record<ThemeRole, string>; dark: Record<ThemeRole, string> };
  ansi: { light: string[]; dark: string[] };   // 各 16 个 #rrggbb
  seed?: { points: { hue: number; radius: number }[]; softness: number };  // 画板状态，1–3 个点
}
interface ThemeLibrary { version: 1; revision: string; themes: CustomTheme[]; }
interface ThemeLibraryUpdate { expectedRevision: string; themes: CustomTheme[]; }
```

角色键是不带 `--` 的名字（`bg`、`bg-sidebar`、`chart-1`）。生成 CSS 时统一拼 `--`，因此变量名无法注入；颜色只允许 hex，注入路径就此封闭。

### 4.3 并发与故障

- `PUT` 发送整库与 `expectedRevision`。revision 不匹配时返回 `409 THEME_CONFLICT`，`details.revision` 是服务端当前值；内容完全相同的重试是幂等的。
- 编辑器遇到 409 提供「重新加载最新版」或「以本地版本覆盖」。
- 写入串行化，落盘用临时文件 + rename；损坏的 `themes.json` 抛 `THEME_STORAGE_CORRUPT`，**绝不覆盖原文件**。
- 所有客户端都是**本地缓存优先**：首帧同步读缓存，网络同步在后台。拉取失败保留缓存与当前选择。
- 只有一次**成功的**拉取才能证明某个自定义 id 已不存在；此时才把它回退到 Riffet。缓存读到的 id 不能被猜测性地丢弃。

缓存位置：

| 客户端 | 缓存 | 选择 |
|---|---|---|
| Web | `localStorage["riffet.theme.library.v1"]` | `localStorage["riffet.theme.id"]` |
| macOS | `~/Library/Application Support/Riffet/themes/<hash>.json`（按 serverKey 分文件） | `UserDefaults["riffet.theme-id"]` |
| 移动端 | `LocalFiles` 下的 `themes/<hash>.json`（按 `api.baseUrl` 分文件） | `PreferenceKeys.THEME_ID` |

### 4.4 编辑器与预览

- 编辑只在 Web 与 macOS，移动端只展示和选择。
- 入口在配色列表里：末尾的「新建主题」以当前正在显示的配色（内置、插件或自定义）为底稿，保存后本机直接选中它；自定义主题卡片上的编辑按钮打开编辑，删除（需确认）在编辑框底部。明暗两个页签；53 个角色分组展示；ANSI 收在「终端颜色」折叠区。macOS 的「主题」页是同一流程（新建卡片、卡片上的编辑按钮）。
- 两端编辑器都以 Arc 式画板为主入口（Web `apps/web/src/lib/theme-seed.ts`，macOS `apps/macos/Riffet/Theme/ThemeSeed.swift` 逐行移植，同一 seed 得到同一组 hex，跨端「手改过的角色」判断才一致）：角度是 OKLCH 色相，离中心的距离是用色量；第一个点给表面着色，可选的第二、第三个点分别是强调色和侧栏色，拖第一个点时其余点跟着转，⟳ 在互补/分裂互补、三分、邻近之间切换；滑块是柔和度（浅色离纯白、深色离纯黑的距离）。预览是一个缩小的 Riffet 窗口（侧栏、对话、diff、输入框）。画板只重绘表面、文本、分隔线、主要操作、强调色、提示条与 `chart-1`，状态、diff、agent、其余图表和 ANSI 保持草稿原值；文本按对比度阈值自动调整明度。53 个角色收进「逐项调整」，手改过的角色（与上一个 `seed` 的派生值不同）在画板重绘时保留。
- `seed` 只供编辑器重新打开画板，`palette` 仍是唯一的绘制来源，各端不从 `seed` 派生；Kotlin 契约与 macOS 缓存原样带着它，保存不会丢。
- 预览是**局部**的：Web 在对话框内注入 `preview-<id>` 的规则块，macOS 用草稿 `Palette` 作用在一个预览卡片的环境里。两者都不改全局 `<html>` / 正在运行的主题。
- 保存前跑结构校验；失败时列出具体字段。对比度按固定配对显示比值与阈值，**只警告**，低对比度主题仍可保存；服务端不检查对比度。

### 4.5 revision 与重绘

自定义主题的 revision 进入所有以主题为键的缓存与重绘键：Web 终端 effect 依赖、macOS `PaletteCache.Key` / 终端外观 key / transcript 风格签名、移动端 `remember(entry, dark)`。没有它，用同一个 id 修改主题后界面不会刷新。

## 5. 首屏防闪

`apps/web/public/theme-init.js` 是阻塞脚本，在首次绘制前写好 `data-theme`、`.dark`，并把本地缓存中的自定义主题规则注入 `<head>`。

一个已踩过的坑：构建产物里 `<link rel="stylesheet">` **排在**这个脚本之后，所以脚本第一次同步执行时读不到 `--bg`。浏览器工具栏颜色因此改为监听样式表的 `load` 事件后再取 —— 会阻塞渲染的样式表在首次绘制前就会触发 `load`，所以没有引入闪烁。改这个文件时别把它退回成「同步读一次」。

## 6. 已知取舍

- **自定义主题仍要交满 53 个角色，没有种子色派生。** 编辑器从一套内置主题复制开始，而不是让用户选几个颜色再自动铺开；因此也不存在 primitive/semantic 两层拆分。将来若做「只交几个种子色」，那一层才开始有价值。
- **主题选择是设备本地的**，web 存 `localStorage`、macOS 存 `UserDefaults`、移动端存平台 preferences，都不同步到服务端。这与 `display-settings.ts` 的既有决策一致：一台设备的字号/配色不是另一台设备的事。
- **v1 不做**：移动端编辑入口、主题导入/导出、服务端主动推送（SSE）、从 53 个角色自动派生 ANSI、主题继承/覆盖层、按项目绑定主题、高对比模式。
- **`oklch()` 暂不支持**。Tailwind v4 与 shadcn 生态已转向 oklch；内置主题仍以 `#hex` / `rgb()` 书写，自定义主题的 wire 格式只接受 hex。将来若要导入社区主题，需要先给生成器加转换（色域外还需一个 clamp 策略）。
- **没有高对比模式。** 调研结论是它应当做成 `data-contrast` 正交轴而不是第 7 套主题（对比度是维度，不是风格），但那需要重推背景/文本/线三组阶梯，本轮未做。
- **Kiln 主题的 `--fg-4` 不在 Anthropic 的令牌里**：它的阶梯止于 `text-500`，第 4 级是按同一规则向页面混合派生的。
- **`--fg-4` 不承载信息**：它在默认主题上只有约 2:1，只用于装饰性占位。约定是「它必须比 `--fg-3` 更淡」，不是「它可读」。
- **借用的配色在达不到对比度时会被调整**，且只调明度、不改色相（把颜色朝黑或白混合，色相基本保持）。**共 12 处**，每一处都是「原值确实不达标」。调整量是**二分搜索出的最小必要值**（早期实现用固定步长会过冲：Claude 的黏土橙曾被推到 4.81:1，落成一个暗棕色，而它只需要 4.50:1）：

  | 主题 / 模式 | 角色 | 上游值 → 实际值 |
  |---|---|---|
  | solarized / light | `--accent` | `#268bd2` (3.41:1) → `#2076b3` (4.52:1) |
  | solarized / light | `--success` | `#859900` (2.97:1) → `#859800` (3.00:1) |
  | solarized / light | `--warning` | `#b58900` (2.98:1) → `#b48800` (3.01:1) |
  | solarized / dark | `--accent` | `#268bd2` (4.08:1) → `#3694d5` (4.54:1) |
  | catppuccin / light | `--success` | `#40a02b` (2.96:1) → `#3f9e2b` (3.03:1) |
  | catppuccin / light | `--warning` | `#df8e1d` (2.31:1) → `#c27b19` (3.02:1) |
  | rose-pine / light | `--accent` | `#907aa9` (3.47:1) → `#7b6991` (4.50:1) |
  | rose-pine / light | `--warning` | `#ea9d34` (2.05:1) → `#bf802b` (3.03:1) |
  | everforest / light | `--accent` | `#3a94c5` (3.26:1) → `#307ba4` (4.52:1) |
  | everforest / light | `--success` | `#8da101` (2.81:1) → `#889b01` (3.01:1) |
  | everforest / light | `--warning` | `#dfa000` (2.21:1) → `#be8800` (3.02:1) |
  | kiln / light | `--accent` | `#d97757` (2.96:1) → `#ab5e45` (4.51:1) |

  注意几乎每一处都停在刚过门槛的位置（3.00 / 3.02 / 4.50 / 4.52）—— 这正是「最小必要压暗」的样子。
  另外：**四套借用主题的浅色 `--warning` 全部不达标**（2.05–2.98:1），Kiln 是唯一例外（取自 Anthropic 设计令牌的 `#966c1e` 直接过线）—— 「浅底上的黄色」是系统性最难的一格，这与 Radix Colors 把 `Yellow`/`Amber` 的 step 9-10 单列出来处理是同一个问题。
- **填充色上的前景（`--accent-fg` / `--danger-fg`）不是一律白色。** 规则：白色达到 4.5:1 就用白色，否则用该主题深色半套的 `--bg` 作墨色（仍不足时朝黑色做最小必要压暗）。结果是所有深色半套的强调色按钮都用深色字（Catppuccin 深色 `#cba6f7` 上白字只有 2.03:1），Riffet / Rosé Pine / Everforest 浅色的 `--danger` 按钮也用深色字（白字分别为 4.10 / 4.19 / 3.27:1）。约定只管静止态；`hover:bg-accent-hover` 与 `hover:bg-danger/90` 的悬停态未纳入（Kiln / Everforest 浅色的 `--accent-hover` 上白字约 3.9–4.3:1）。
- **提示条跟随主题的浮层底色，`--toast` 只剩 web 工具提示在用。** 提示条与弹层同用 `--bg-elevated`（Mac 为 `bgPopover`）和主题自己的 `--success` / `--danger`。`--toast-success` / `--toast-danger` 不再被任何界面使用，编辑器也不再展示，只为兼容已保存的主题和旧客户端而保留在契约里。
- **`--agent-*` 是「模式常量」，但浅色下会被逐主题微调。** 基准值按明暗取自 Riffet 的四支后端标识色，对比度守卫只在某套主题的浅色页面会让它掉到 3:1 以下时才动它 —— 实测发生在这几处：`--agent-codex` `#10a37f` → `#0f9c7a`（solarized / catppuccin / rose-pine），`--agent-claude` `#d97757` → `#d07254`（solarized / rose-pine）、`#c86d50`（catppuccin）。**深色下四色在全部主题里都不变**，因为每个深色页面都足够暗。
  之前这里的措辞是「不随主题改变」，与实现不符 —— 需要修正的是文档，不是代码：让一个后端标识色在某套浅色主题上不可读，比让它随主题微调更糟。
- **没有 GitHub 主题，这是有意的。** Riffet 自己的配色当初就是照着 Primer 调的（浅色侧栏 `#f7f8fa` 与 Primer 的 `#f6f8fa` 每通道只差 1），而且终端 ANSI 本来就是 Primer 的。实测：两者浅色的「页面底色 + 卡片 + 弹层」**逐字节相同**，终端 16 色也完全相同——切过去只有强调色在变。把 GitHub 改得不一样就得偏离它自己发布的配色，那它也就不叫 GitHub 了，所以选择去掉而不是硬凑差异。若要重新加回，必须给出与 Primer 的可见差异，而不是原样收录。
- **`--line*` / `--bg-hover` / `--bg-active` 在深色下也按各主题前景色派生。** 实现时这几个角色一度被写成固定的 `rgb(255 255 255 / …)`，导致所有深色主题在这 5 个角色上逐字节相同 —— 等于没被主题化。默认主题（Riffet）例外：它保持改造前的原值，以兑现「改造后默认主题逐像素不变」。
- **配色来源与许可**：Solarized / Catppuccin / Rosé Pine / Everforest 均为 **MIT**，上游与许可见 `themes.ts` 的 `credit` 字段（显示在设置页）；**Kiln 不是第三方移植主题**，没有 credit 字段。**不要把 Gruvbox 收进来**：其仓库内没有 LICENSE 文件。
- **Kiln 的色值来自 Anthropic 自己的产品**，不是第三方移植：界面面与文本阶梯取自 `docs.claude.com` 内联的 Anthropic 设计令牌（`--bg-000..500`、`--text-000..500`、`--accent-*`、`--danger-*`），强调色与状态色取自本机 Claude Code 二进制里的主题对象。色值本身通常不受版权保护；主题最初借用「Claude」作名，2026-10-26 已按性格改名为 **Kiln（窑）**，色值不变，旧存档 id `claude` 会迁移到 `kiln`。
- **Ink / Sepia / Moss / Slate / Pencil / Celadon 是 Riffet 自己的阅读配色，按 Kiln 的配方推导**，没有上游、没有 credit：纸底色度 ≤ 6（Sepia 例外，有意更暖），正文是接近无彩的墨（约 12–14:1），`--fg-2` 保持约 9–10:1，`--fg-3` 刚过 4.5:1；一个中饱和的强调色，状态色深而沉；卡片与弹层用纯白（Sepia 用 `#fffdf8`）。这几套之间只差纸的冷暖和强调色。其余角色全部按本文的派生规则推出，对比度门槛逐项达标。
  正文墨不取纯墨：Riffet、Kiln 与这六套的 `--fg` 都从纯墨向纸收 10%（深色 12%），整屏的黑白对比不再发硬，阶梯与
  4.5:1 门槛不变。Kiln 的 `--fg` 因此不再是 Anthropic 令牌的原值。
  借用的四套之所以在浅色下显得“廉价”，原因正是这套配方的反面：它们的正文是为代码高亮设计的带色中灰（5–8:1），文字阶梯挤在 4.5–5.4:1，墨与纸色相冲突，强调色与状态色偏饱和。这四套保持对上游的忠实，不做“阅读校正”。
- **Pencil 的强调色是无彩的。** `--accent` 在浅色下是 `#2a2a2a`，与正文几乎同色；正文链接（`.md a` 只靠颜色、不加下划线）、运行中转圈、选中和收藏态因此只能靠形状和位置区分。这是这套主题的定位，不是遗漏；需要彩色强调时用 Ink 或 Slate。
- **Kiln 主题的 `--accent` 与 `--agent-claude` 不相等，这是有意的，不是漏改。** 两者同源（Anthropic 品牌黏土橙 `#d97757`），但**职责不同、门槛不同**：`--accent` 承载正文大小的链接文字，必须 4.5:1，所以在象牙底上被压到 `#ab5e45`；`--agent-claude` 只是一个标记点，只需 3:1，所以留在 `#d77656`（几乎是原色）。同一个源色在两个门槛下解析成两个值，这个差异是有理由的。深色下 `--accent` 原值 `#d97757` 就有 5.90:1，无需调整。
- **默认主题的终端配色与应用强调色不一致。** 它的终端 ANSI 沿用改造前的 Primer 配色，蓝色是 `#0969da`；而应用强调色是靛蓝 `#3867f0`。这个不一致在主题能力之前就存在（当时只有一套终端配色），本轮**刻意保留**以免改动既有用户看惯的 `git diff` 配色。若要统一，把 `scripts/theme-ansi.ts` 里的默认表换成从 `--accent` 派生即可。

## 7. 插件外观

插件（见 [PLUGIN_ARCHITECTURE.md](PLUGIN_ARCHITECTURE.md)）可以贡献配色、字体、背景，以及把它们组合起来的预设。它独立于 §4 的主题库：不写入 `themes.json`，`GET/PUT /api/themes` 的语义不变，内置主题仍由 `gen:theme` 生成，没有服务端时默认外观照常显示。插件配色不占用 `custom-…` id，也不会被用户编辑覆盖；卸载插件不会删除用户创建的主题。

### 7.1 声明与目录

manifest 的 `contributes.appearance`（类型在 `packages/contracts/src/appearance.ts`），贡献 ID 为 `<插件 id>/<名称>`，所有路径都在包内的 `assets/` 下：

| 种类 | 内容 |
|---|---|
| `palettes` | `asset` 是一份 JSON，结构与一套 `CustomTheme` 完全相同（53 个角色 × 明暗 + 各 16 个 ANSI）；服务端用 `validateCustomThemes` 校验，其中的 `id` 与 `name` 被忽略，配色以贡献 ID 标识 |
| `fonts` | `role` 为 `ui` 或 `mono`；`family` 是字体文件自带的族名；`files[]` 为 woff2（可带 `weight`、`style`、`unicodeRange`）；`fallback` 是回退族名；`license` 见下 |
| `backgrounds` | 图片资产、`areas`（目前只有 `workbench`）、`opacity`、`fit`（`cover` 或 `tile`）、`license` |
| `presets` | 引用配色、字体、背景的贡献 ID，可以来自别的插件 |
| `iconPacks` | `id`、`title`、`asset`；资产为单色矢量 JSON，Android 在设置 → 外观 → 界面图标中选择，见 §7.5 |

`GET /api/appearance` 只列已启用插件的贡献，每个资产解析为 `{ url, sha256, size, type }`；`revision` 是目录内容的哈希。资产在 `GET /api/appearance/assets/:pluginId/:sha256`，地址里带内容哈希，所以响应是 `private, max-age=31536000, immutable`：鉴权与其他 `/api` 一致，共享代理不缓存。

服务端逐个校验资产，不合格的贡献从目录里省去：realpath 必须留在包目录内；类型在白名单内（woff2、png、jpeg、webp、json）且文件头与类型相符；字体 ≤ 2 MB、图片 ≤ 4 MB、配色 ≤ 256 KB；配色必须是合法主题。包停用后目录不再列出它，资产路径也随之 404。

字体和背景可声明 `license: { redistributable: boolean }`，表示冻结的分享能否带上这份文件；形状不对按其他声明错误处理，包被拒绝。不声明等于不可再分发。官方「纸墨」包的 Inter（SIL OFL）声明为可再分发，纸纹不声明。

内置包的资产随构建发布：源码运行读 `plugins/<vendor>/<name>/assets/`，`pnpm build` 把每个包的 `assets/` 复制到 `dist/plugins/<vendor>/<name>/assets/`（被排除的厂商不复制），macOS 的内置服务整包带 `dist/`，三种运行方式用同一个解析（`apps/server/src/plugins/package-root.ts`）。

### 7.2 选择与优先级

选择是设备本地的，与主题选择一样不同步：

| 客户端 | 选择 | 缓存 |
|---|---|---|
| Web | `localStorage["riffet.appearance.selection"]` | 目录与配色 `riffet.appearance.cache.v1`；首帧配色 `riffet.appearance.palette.v1`；资产由 Service Worker 存入 `riffet-appearance-v1`；每次拿到目录后页面把仍列出的资产地址发给 Service Worker，其余的缓存项被删除（没有 Service Worker 或发送失败则不影响） |
| macOS | `UserDefaults["riffet.appearance-selection\|<服务端>"]` | `~/Library/Application Support/Riffet/appearance/<服务端哈希>/`，资产按 sha256 命名，使用前复核；缓存的配色与字体在启动后片刻应用，不在首帧 |

存储的是 `{ preset?, palette?, uiFont?, monoFont?, background? }`。每一项的优先级是：宿主默认值，选中的预设，单项选择；与插件加载顺序无关。单项值 `default` 表示宿主默认，即使预设指定了别的。引用的贡献缺失或插件被停用时，该项显示为宿主默认，但选择仍保留，重新启用后恢复；只有用户自己的操作才改写它。选中预设时会清掉之前的单项选择，让预设生效。

插件配色与 §4 的选择并存：它以 `[data-theme="plugin-<哈希>"]` 注入，走自定义主题的同一条 CSS 变量路径，不写入 `riffet.theme.id` / `riffet.theme-id`。生效时它盖在所选主题之上；用户在配色里选内置或自定义主题，就把单项配色设为 `default`，所选主题重新显示。

### 7.3 各端应用

- Web：字体以 `FontFace` 从资产地址加载，写到 `--font-sans` / `--font-mono`，宿主字体栈（含 CJK）跟在后面；终端自带字体栈，不随之变化。背景是工作台上一层不接收指针的满铺图层，按 `opacity` 叠在界面之上，不改变布局。
- macOS：字体用 CoreText 在进程范围注册，作用于转录文字、代码、输入框、终端和 `RiffetFont`；SwiftUI 中直接写 `.font(.system(...))` 的界面仍用系统字体。背景是工作台上不接收点击的覆盖层。
- 字体加载失败时回到宿主字体栈，不保留上一个插件字体；同一目录修订内不重试，修订变了才再试。
- 想改插件配色：主题编辑器的「新建自」可选插件配色，保存时是带新 `custom-…` id 的独立副本。
- 分享：当前绘制的是插件配色时，分享请求的 `themeId` 为 `plugin-<哈希前 16 位>`，服务端从仍启用的插件读出这份配色，冻结为 `custom-plugin-<哈希>` 的自包含主题；之后卸载插件不影响已冻结的分享。插件已停用则返回 `SHARE_THEME_CHANGED`。
- 分享的字体与背景：请求的 `appearance` 可带 `uiFont`、`monoFont`、`background`（设备当前生效的贡献 ID）。服务端只对仍启用、声明了 `license.redistributable: true` 且文件通过校验的项，把文件复制到分享包的 `appearance/<sha256>.<ext>`，并在冻结的外观里以 `fonts` / `background` 引用；其余项（含未声明许可的）不进包，分享页用自己的字体与背景。复制的文件计入分享包 50 MB 上限与内容哈希；草稿返回的 `appearance` 不含这三个字段。分享页用与工作台相同的 `FontFace` 路径加载字体，背景是同一种满铺图层。Mac 端暂不发送这三个字段，分享仍用默认字体与背景。
- Android 消费图标、配色、界面／等宽字体、背景及预设。预设与单项选择保存在本机，按服务端与鉴权身份隔离；配色沿用 `plugin-<hash前16>` 标识，资源按内容哈希复核。实现和平台边界见 §15。

### 7.4 官方包

外部插件 `riffet.appearance-paper`（安装后默认启用）：配色「纸墨」是近乎无彩的墨配低色度暖纸，明暗各一套，ANSI 取自同一组色相；字体是 Inter 的 opsz 可变子集（latin、latin-ext，SIL OFL，许可文本在 `assets/Inter-OFL.txt`）；背景是可平铺的纸纹 PNG，由插件仓库里的 scripts/generate-grain.mjs 确定性生成；预设「纸墨」组合三者。

### 7.5 Android 界面图标包

Android 在「设置 → 外观 → 图标」中的界面图标分组切换，内置 Lucide、Phosphor（Regular / Fill）、Tabler（Outline / Filled）、Material Symbols（Outlined / Fill）、Fluent、Octicons、Material Design Icons 和 Remix Icon 八套离线图标。选中态有独立的 `SettingsFilled`、`MessageSquarePlusFilled`、`StarFilled`，图标颜色和尺寸由界面决定。品牌 Logo 和 Agent 标志保持自己的形状。Tabler 采用官方 3.35.0；Material Symbols 固定到官方仓库提交 `10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7`。原始 SVG 和映射保存在 `scripts/icon-sources/`，生成脚本可离线复现。Tabler 没有 Filled 版本的 message-plus，选中时加粗其官方轮廓。

纯资源插件在 `contributes.appearance.iconPacks` 声明 `{ id, title, asset }`，无需脚本或能力授权。参考 [mono-icons 示例](../examples/plugins/mono-icons/riffet-plugin.json)：该示例只覆盖加号与菜单，其余使用默认图标。打包方式：

```sh
pnpm exec tsx scripts/pack-plugin.ts examples/plugins/mono-icons --out /tmp/mono-icons.tgz
riffet plugin install /tmp/mono-icons.tgz
```

启用插件后重新打开外观设置，目录会刷新。图标包最多 1 MiB，结构如下：

```json
{
  "version": 1,
  "icons": {
    "Plus": {
      "width": 24,
      "height": 24,
      "paths": [{ "d": "M12 4v16M4 12h16", "fill": false, "strokeWidth": 2 }]
    }
  }
}
```

`width`、`height` 是从 `(0,0)` 起的矢量坐标范围，各为 1–1024；整个图标缩放到界面要求的大小。每个包 1–256 个图标，每个图标 1–32 条 SVG path，每条 `d` 最多 16384 字符，坐标绝对值不超过 10000。只支持路径几何，不支持 SVG 标签、外链、变换、文字、渐变或脚本。需要先把 SVG 图元转为 path，并展开变换。

路径 `fill` 默认 `true`；`strokeWidth` 默认 0，范围 0–64；`lineCap` 默认 `round`（也支持 `butt`、`square`）；`lineJoin` 默认 `round`（也支持 `miter`、`bevel`）；`fillRule` 默认 `nonzero`（也支持 `evenodd`）。路径用黑色绘制，再由宿主按当前主题着色。

功能名称来自 [RiffetIcons.kt](../apps/mobile/shared/src/commonMain/kotlin/riffet/ui/icons/RiffetIcons.kt)，例如 `Settings`、`Search`、`Folder`、`Send`。缺少或无法解析的图标逐项回退到 Lucide；未知名称允许存在，供后续客户端使用。品牌标志不参与替换。

选择按服务端地址存入本机偏好 `icon-pack:<baseUrl>`；目录和矢量缓存在私有存储 `icon-packs/<服务端哈希>/`。只有所选插件包会下载；下载原始字节通过长度、SHA-256 和几何校验后才写入缓存。目录汇总所有插件，64 项限制只适用于单插件声明。网络失败保留上次目录；成功刷新后，已禁用或移除的包回退为默认图标，但保留选择，重新启用即可恢复。切换仅改变图标渲染，不销毁会话、导航栈或输入草稿。Web、macOS 原生界面暂不消费该项；服务端需更新到支持 `iconPacks` 的版本。

## 8. 移动端界面风格

以下为组件接入约定；具体默认值与主题覆盖规则见第 9 节。Android 的页面结构、浮层、组件对照与无障碍以 [设计体系 · Android](design/system/android.md) 为准，本节与第 9 节保留各风格的画法、主题格式和验证记录。

Android 的「设置 → 外观 → 界面风格」提供 material3（默认）、ios、expressive、miuix、fluent 五个内置风格。
这里的 iOS 指 Compose 绘制的视觉风格，不是 Android 上运行 UIKit。各风格共用现有主题配色
和图标包，不绑定 SF Symbols。Miuix 使用官方组件库，其他风格复用现有依赖；扩展细节见第 10 节。

### 8.1 三个独立维度

- **界面风格**：组件、字体层级、形状、表面、导航布局与页面转场。
- **配色主题**：现有主题库以及浅色／深色模式。
- **图标包**：内置和插件提供的图标资源。

DisplaySettings 通过设备级 AppPreferences 保存 display.interface-style，启动时同步读取，
通过 Compose snapshot state 立即更新。它不属于服务端设置或配对凭据；切换服务器不会改变风格。
未知 ID 在渲染时回退到 Material 3，保留原始存储值，直到用户明确选择另一风格。

### 8.2 实现边界

1. shared/DisplaySettings.kt 负责稳定 ID、持久化和可观察状态，不包含界面文案或 Compose 布局。
2. ui/design/InterfaceStyle.kt 集中解析形状、尺寸、转场等参数。RiffetTheme 在应用根部安装
   LocalInterfaceStyle、字体、Material 兼容主题、表面及点击反馈。配色和图标仍由原来的独立通道提供。
3. ui/design 的导航栏、底部导航、分组列表、开关、分段选择、筛选、按钮、输入框、滑块和确认弹窗负责不同风格的绘制。
   菜单、输入区和底部面板读取同一组参数；设置组件只是适配器，不再创建独立的局部主题。
4. PageHost 保留既有的导航栈、返回拦截、交互式返回与系统预测返回，风格仅影响转场时长和底层页面效果。
   不以风格作为页面或业务控制器的 key，公共分组始终保留同一内容容器；切换不会主动重建业务状态或清空草稿。

底部导航均保持仅图标，以符合产品当前约定。业务专用内容（消息、代码、终端、任务内容）
共用同一实现；风格不修改业务行为、触摸操作的授权或服务端能力。系统权限等原生系统弹窗仍由操作系统控制。

### 8.3 后续扩展规则

新增完整风格需增加稳定 ID、参数和公共组件绘制实现，并补齐选择器文案。业务页面不得散落
风格判断或复制数据加载/保存逻辑。新增通用控件先进入公共组件层，再供页面使用。

未来的资源预设可声明一个**已内置的组件风格**及经过验证的参数覆盖，例如圆角、间距与动效；
新交互组件仍需随 App 发布。当前版本没有提供插件风格预设下载协议，也不将主题 JSON 中的未知
字段作为可执行界面代码。该边界与已有图标包的纯资源扩展保持一致。


### 8.4 组件和状态设计

两套风格共用配色语义，但不共用所有组件外形。常规页面和分组页面都以主题 bg 为底色；
标题栏展开、收起、滚动后仍用同一底色，避免 Sepia 等暖色主题在滚动时出现白色条带。

| 组件 | Material 3 | iOS 风格 |
|---|---|---|
| 标题栏 | 左对齐，64dp；列表可使用大标题，设置使用紧凑标题 | 居中，56dp；设置使用紧凑标题，大标题仅用于可展开／收起页面 |
| 分组 | 默认 20dp 圆角，主题派生的 tonal 表面 | 默认 12dp 圆角，较浅或较高一层表面，行间细分隔线 |
| 按钮 | Material filled / tonal / text，危险操作使用 error 角色 | 仅显式主操作填充 accent；普通和危险操作为透明 tint 文字，禁用时不添加灰色背景，按压降低 opacity |
| 输入 | OutlinedTextField，聚焦描边 | Foundation 输入框、固定标签、48dp 编辑区域，无 floating label 或 Material 底部横线；深色填充与卡片分层 |
| 开关与选择 | Material Switch / Checkbox / RadioButton | 50×30dp 开关轨道与圆形滑钮；复选勾选框；选中行尾勾选标记 |
| 滑块 | 官方 Material Slider | 4dp 轨道与28dp圆形滑块；保留官方离散值、键盘及无障碍行为 |
| 分段与筛选 | Material segmented buttons / FilterChip | 共享轨道、抬高的选中项；筛选项使用轻量背景 |
| 底栏与宽屏侧栏 | Material navigation indicator | 浮动底栏使用完整胶囊外壳、留边的选中胶囊和无文字图标；侧栏使用行级高亮 |
| 首页模式切换 | Material primary tabs | 默认紧凑分段选择；主题可切换为下划线标签 |
| 菜单与底部面板 | tonal 浮层、Material 标题布局 | 平面菜单、行分隔和勾选；简单 action sheet 独立取消区，多级面板使用导航标题栏 |
| 确认弹窗 | Material AlertDialog | 270dp 紧凑确认框、17sp 标题、13sp 正文、并排透明操作和细分隔；长表单使用顶部取消／保存导航，超大文字时确认操作竖排 |
| 短暂反馈 | Material Snackbar | 主题浮层色与圆角，共享风格操作按钮；队列和超时仍由 SnackbarHost 管理 |

最小点击目标与视觉尺寸分开：小图标、开关和细轨道不必被画大，但常规独立按钮、筛选和
终端快捷键至少保留48dp点击区域。设置整行 toggle、选择项只保留一个激活入口，内部开关
和勾选标记不再重复接收点击。终端快捷键超出宽度时横向滚动；短按在有效抬手时发送，
滑动取消不发送，长按方向键在400ms后开始、每80ms重复，释放和取消终止重复。

| 状态 | 统一规则 |
|---|---|
| 普通 | 正文 fg、次级 fg2、辅助 fg3；页面、卡片和浮层读取各自 surface |
| 选中／定位 | selected 是由当前卡片与 accent 混合的实色，selectedContent 保持正文对比；勾选、焦点和强调图标使用 accent |
| 按下 | MD3 使用 ripple；iOS 普通按钮与图标按下降低 opacity，列表行使用表面高亮；取消操作释放反馈 |
| 聚焦／悬停 | 输入和独立控件显示聚焦边框；一般可点击行使用焦点色覆盖，悬停弱于按下；焦点移出清除 |
| 禁用 | disabledContent 与弱化容器，禁用点击；不可用原因仍保持可读 |
| 错误／警告 | 使用 danger / warning 语义，与普通选中分离；保留原因、重试与确认逻辑 |
| 文字选择 | TextSelectionColors 使用当前主题 accent 和 selected；不再继承其他默认主题的颜色 |

新控件优先复用这些语义和已有适配器。自绘消息、图表、代码和终端不能把所有状态都替换成
同一种“选中背景”：diff 增删、ANSI、热力和错误等仍保留自己的内容语义。

### 8.5 页面接入范围与验证边界

| 范围 | 已接入的部分 |
|---|---|
| 设置根页及分类、二级页 | 通用、外观、主题、排版、合并图标页、输入、通知、文件、模型／后端、扩展、服务器、服务状态；共享分组、字段、选择、保存和确认操作 |
| 首页与任务列表 | 输入胶囊、模式标签、目录选择、搜索、重试、会话卡片、底部与宽屏导航 |
| 会话、子代理、详情 | 标题及操作、输入区、消息定位、工作状态、交互提问、选择和确认、消息操作菜单 |
| 模型和发送配置 | 模型搜索、分组、不可用原因、重试、参数子页、权限与模式切换 |
| 文件、Git、收藏、下载 | 面包屑、定位高亮、列表和卡片、重命名、恢复／删除确认、操作与禁用状态 |
| 统计与终端 | 筛选、分段导航、统计卡片、终端输入与快捷键、返回实时操作 |
| 独立 Android 宿主 | QuickChatActivity、DeviceConfirmSheet 跟随本机界面风格和文字缩放；确认按钮复用共享实现 |

这些是源码接入范围，不代表每个页面、每个数据状态都完成了真机视觉验收。本次用项目已有的
Compose 离屏渲染能力生成两种风格 × Sepia 浅／深色的设置、滚动设置、排版、控件和模型面板
共20张代表性预览，检查了标题底色、滑块形态、分组层次、选择与禁用状态。预览直接使用生产
共享组件，但页面内容由临时样例组合，不是完整 Android 导航流程截图。没有添加仓库 UI 测试。

仍需真机验证的组合包括系统键盘与多行输入、手势返回、快速切换风格时的导航恢复、超大系统字体、
窄屏长标题、终端短按／长按／横向滑动，以及消息定位浮层与真实长转录的遮挡关系。
系统权限弹窗、系统文件选择器、相机、HTML 内容、全屏图片画布、图表及 ANSI 终端画布保留
各自系统或数据表现；不确定加载状态使用风格适配器：MD3 弧形进度，iOS 12辐条 activity indicator；确定进度保留数据比例。


### 8.6 Cupertino 参考与展开态复查

参考了 [alexzhirkevich/compose-cupertino](https://github.com/alexzhirkevich/compose-cupertino) 的
[按钮](https://github.com/alexzhirkevich/compose-cupertino/blob/f66875aa6f3848b30c38e42a89fc99c9ac24a585/cupertino/src/commonMain/kotlin/io/github/alexzhirkevich/cupertino/CupertinoButton.kt)、
[输入框](https://github.com/alexzhirkevich/compose-cupertino/blob/f66875aa6f3848b30c38e42a89fc99c9ac24a585/cupertino/src/commonMain/kotlin/io/github/alexzhirkevich/cupertino/CupertinoTextField.kt)、
[确认框与 Action Sheet](https://github.com/alexzhirkevich/compose-cupertino/blob/f66875aa6f3848b30c38e42a89fc99c9ac24a585/cupertino/src/commonMain/kotlin/io/github/alexzhirkevich/cupertino/CupertinoDialogs.kt)、
[菜单](https://github.com/alexzhirkevich/compose-cupertino/blob/f66875aa6f3848b30c38e42a89fc99c9ac24a585/cupertino/src/commonMain/kotlin/io/github/alexzhirkevich/cupertino/CupertinoDropdownMenu.kt)
及 activity indicator 源码；同时查阅了更新至 CMP 1.7+ 的
[slanos 分支](https://github.com/slanos/compose-cupertino)。采用其组件结构和视觉规则作为参考，
没有新增组件库依赖，没有引入 SF Symbols，也没有整段移植第三方实现。

第二轮复查直接渲染实际 SettingsScreen，以及打开状态的生产 AlertDialog、编辑表单、
RiffetDropdownMenu 和 PickerOverlay；控件和排版仍由共享生产组件组合。两种风格 × 浅／深色，
包含设置滚动前后，共32张基础预览。与第一轮的关闭态示例相比，这轮明确展开弹窗和菜单，
检查操作排列、点击区域、标题与正文层级、禁用状态和浮层边缘。

预览中发现并修复了右侧设置摘要挤断英文标题、深色输入背景与弹窗混为一层、菜单阴影被父层裁切。
设置摘要依据实际文本宽度选择右侧值或副标题布局，页面分类及路由不参与风格切换。
设置导航在 iOS 使用实色图标底板和 trailing value，Material 保留原列表及 supporting label。
下载列表、快捷会话弹层、composer 次要动作和交互提问也分别适配；授权、发送和取消的业务接口共用。

预览运行于 JVM 离屏 Compose 宿主，系统级键盘、Android 窗口及触摸手势仍以 APK 真机验收为准。
另补查了320dp宽、1.6倍字体下的英文设置与弹窗／菜单，确认摘要转副标题、确认操作竖排，菜单不挤压操作图标。
不将这些预览等同于所有业务数据、语言、屏幕尺寸和系统状态的穷尽验收。

### 8.7 长菜单与双侧栏

iOS 菜单的圆角、背景和阴影由固定的 DropdownMenu Surface 承载，滚动内容只负责行布局。
不能把圆角外壳放进滚动列，否则长目录和消息历史菜单滚动后会露出直角。菜单行保留细分隔，
“选择其他目录”等动作分组使用6dp留白，不绘制厚实色条。MD3 继续使用其原生菜单表面。

iOS 左右侧栏使用镜像圆角、主题分组底色、内侧细边和安全区；标题及关闭操作固定，正文独立滚动。
左侧服务器切换、收藏、下载和统计复用共享分组行；右侧变更／文件／终端使用纵向导航组，
详情、子代理、后台任务与会话操作沿用同一分组规则。外壳阻挡落到背后遮罩的点击，同时不消费
子控件和祖先拖动事件。MD3 保留 ModalDrawerSheet 与横向导航入口。

发送设置根页及上下文明细也复用 picker 的卡片表面和0.5dp内缩分隔，避免根页和子页的规则不同。
这轮检查使用实际 TurnNavigator、SideDrawers、WorkbenchDrawer、SessionDetailsPane，
以及生产菜单组件组成的长目录样例，覆盖两种风格与 Sepia 浅／深色，检查菜单滚动和侧栏固定标题。
另在离屏宿主分发指针事件，验证两侧标题点击不触发关闭、遮罩触发关闭及 iOS 关闭按钮的回调；
使用13个模拟配对服务检查左栏展开及滚动，使用28条消息检查实际历史菜单的定位和末尾圆角。
临时 JVM 离屏宿主不写入仓库 UI 测试；不替代 Android 系统安全区、手势返回和真实服务数据验收。

## 9. 可覆盖的移动设计系统

移动界面由同一套语义规范驱动，MD3 与 iOS 是两套默认渲染风格。自定义主题在原有
53个颜色角色及 ANSI 表之外，可以通过可选的 design 描述排版、组件尺寸、表面、状态和动效。
旧主题不需要迁移：缺少 design 时使用当前风格的默认值；未扩展的旧主题 canonical JSON 和 revision 不变。

### 9.1 分层与覆盖顺序

1. 用户选择的界面风格决定组件结构和默认值：MD3 或 iOS。
2. 主题的 palette 提供颜色，design.tokens 提供公共设计覆盖。
3. design.styles.material3 或 design.styles.ios 对当前风格逐字段覆盖。
4. 系统及本机辅助设置最后生效：字体倍率、减少动态效果、屏幕可用空间与安全区。

覆盖按叶子合并。例如公共 body 指定 size，iOS body 仅指定 weight，字号不会因后者缺少 size 而丢失。
排版过大的行高下限、组件的派生间距与视觉尺寸关系在合并后处理。点击目标至少48dp，
视觉图形可以更小；减小图形不缩小点击区域。主题不替换业务动作、权限确认、菜单回调、
消息顺序、服务器状态、触摸识别阈值或数据重试间隔。

解析结果是跟随 Composition 的不可变值，不写入全局可变单例；主题、明暗模式或风格改变后，
当前组件重新解析。手势和异步回调捕获该实例，避免另一窗口的风格影响当前动画。

### 9.2 规范覆盖范围

| 层 | 语义规范 | 消费入口 |
|---|---|---|
| 页面 | 普通／分组背景、内容最大宽度、页面边距、标题间距、侧栏宽度、安全区 | 页面容器、首页、设置、列表、会话、文件、统计和终端 |
| 文字 | 页面标题、导航标题、正文、辅助文字、标签、按钮、输入、分段选择、菜单、弹窗、代码 | LocalRiffetTypography；Material Typography 同步映射，消息 Markdown 也读取当前主题 |
| 组件 | 行高、图标槽、可见图标、触控区域、圆角、输入／开关／滑块／弹窗／菜单／导航尺寸 | LocalInterfaceStyle.metrics；已有共享组件统一读取 |
| 表面与状态 | 页面、卡片、浮层、输入、导航、遮罩、主次操作、按下、选中、禁用、焦点、细线、阴影 | LocalRiffetSurfaces；已有 palette 继续控制正文、危险、警告、diff 等内容色 |
| 操作反馈 | 主／次／危险操作，按压、焦点、选择、禁用、展开、返回和关闭 | 共享控件与原业务回调；不能由主题执行任意代码 |
| 动效 | 淡入淡出、展开、空间移动、页面进退、拖动释放、按压透明度、背景位移与遮罩 | LocalRiffetMotion；系统动画缩放优先，不重复乘倍率 |
| 外观变体 | 设置图标 plain／tonal、导航 flat／floating、首页 underline／segmented、次要按钮 plain／tinted | 风格提供默认值，主题可有选择地覆盖 |

确定进度、ANSI、代码语法及 diff 增删仍表达数据语义；其颜色取已有专用角色，不以装饰高亮替代。
操作系统权限窗口、系统文件选择器、键盘等由 Android 管理，不由 App 的主题渲染。

### 9.3 默认设计决策

- iOS 使用16sp正文、13sp辅助文字与紧凑导航标题，辅助按钮和分段选择使用15sp角色；大标题仅用于有展开／收起语义的页面。
- iOS 首页两种会话目标使用紧凑分段选择，快速会话模式和模型入口降低视觉分量。输入胶囊保持独立编辑表面。
- 两种风格的设置默认单色裸图标；tonal 变体保留彩色底板。图标包决定图形，风格和主题决定显示尺寸、颜色与背景。
- iOS 导航默认浮动外观：底部导航和独立导航操作使用轻半透明表面、细边与柔和阴影。标题不包进整条浮动卡片。
- 发送可见圆默认36dp，点击区至少48dp。主题色集中在主要操作和选择状态，次要操作保持轻量。
- MD3 保留 Material 控件结构、ripple、Material 选择和弹窗排列，通过同一语义层接收主题覆盖。
- 当前浮动材质使用 Compose 半透明表面和阴影，不将它称为 Apple 原生 Liquid Glass 折射实现。

设计依据包括 Apple 当前的 [Typography](https://developer.apple.com/design/human-interface-guidelines/typography)、
[Materials](https://developer.apple.com/design/human-interface-guidelines/materials)、
[Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls) 及
[WWDC26 品牌与平台规范](https://developer.apple.com/videos/play/wwdc2026/251/)。这些规范用于指导组件角色，
Android 上的具体 dp/sp 数值属于本项目设计，不能当作 Apple 系统尺寸的直接承诺。

### 9.4 主题格式与扩展

在现有完整 CustomTheme JSON 中增加以下字段即可；palette、ansi、id、name 仍遵循原合同：

~~~json
{
  "design": {
    "version": 1,
    "tokens": {
      "typography": {
        "body": { "size": 16, "lineHeight": 24 },
        "buttonSmall": { "size": 14, "weight": 500 },
        "mono": { "family": "mono" }
      },
      "dimensions": { "pageInset": 20, "groupRadius": 18, "menuRadius": 20 },
      "motion": { "short": 180, "spatialDamping": 1, "pageEnter": 320 },
      "colors": {
        "light": { "navigation": "#ffffffef", "primaryAction": "#375fb5" },
        "dark": { "navigation": "#202b3aef", "primaryAction": "#739df2" }
      }
    },
    "styles": {
      "ios": {
        "typography": { "body": { "weight": 400 } },
        "variants": { "settingsIcons": "plain", "navigation": "floating" }
      },
      "material3": {
        "variants": { "settingsIcons": "tonal", "homeTabs": "underline" }
      }
    }
  }
}
~~~

version 1 包含19个文字角色、51个尺寸键、19个表面颜色键、18个动效键、4个外观变体。
完整白名单、单位和范围以 packages/contracts/src/theme-design.ts 为准，Kotlin 协议在
apps/mobile/contracts/src/commonMain/kotlin/riffet/contracts/ThemeDesign.kt 对齐。
字体 family 是 system／sans／serif／mono 的可移植别名；此字段不下载字体文件。
缺少的字段继承默认；未知键、错误枚举、数字字符串、非有限值、越界值和显式 null 会被拒绝。

主题保存、导入、导出、复制、插件 palette 和缓存沿用原来的 CustomTheme 通路。
Web 的配色编辑器保留 design，不会因为修改一个颜色而清掉移动设计配置；当前通过主题 JSON
编写这些高级字段，未新增一个包含所有参数的表单编辑器。Web 会保留字段，但移动组件尺寸不会
自动当作 CSS 写到网页：每个客户端负责解释自己支持的渲染规范。

### 9.5 后续组件约束

新增页面先选用现有页面容器和共享组件，再选语义角色。普通文字不得另起一套局部字号；
按钮不得直接依赖正文大小；普通表面不写固定明暗色；动效从当前 LocalRiffetMotion 取得。
需要新增视觉能力时，先补协议键、两种风格默认值、运行时映射和真实消费者，再修改页面。
没有消费者的主题字段不作为已实现能力发布。数据可视化坐标、内容比例和业务计时不套用装饰尺寸。


### 9.6 本轮验证边界

协议验证复用既有核心测试：TypeScript 类型检查及主题／外观／分享的35项测试通过，
Kotlin contracts JVM 的16项测试通过。覆盖旧主题不变、新 design 往返、无效字段拒绝和保存导入链路。
纯界面变更未新增仓库 UI 测试。

使用临时 JVM 离屏 Compose 宿主渲染 MD3／iOS、浅／深色、默认／自定义主题；
普通预览覆盖首页、设置、共享控件、picker、弹窗、菜单和双侧栏，
窄屏预览覆盖320dp宽、1.6倍字体下的首页、设置、弹窗及菜单，并检查滚动前后。
自定义样例实际覆盖排版、颜色、尺寸和风格变体；额外检查合法 groupInset=0 的 picker，
补齐派生 padding 下限、窄窗口侧栏宽度、头像内部间距及零时长循环动效的约束。
大标题在已提供页面边距的容器内不重复添加水平留白，允许两行显示。

首页预览未连接真实服务目录，不能替代所有模型与模式组合的业务验收；
离屏预览也不等同于 Android 真机上的系统键盘、手势、安全区和设备性能验证。


### 9.7 Material 默认层级与组件语义

共享语义层保留 Material 的形状角色；第 9.8 节规定 Android 界面直接消费这些角色时的统一默认值。
主题显式指定圆角仍覆盖对应角色。
Material Typography 保留 display、headline、title 与 label 的完整层级，未配置的角色沿用默认。
文本框使用透明底和 outline 边框，普通容器保持中性色；selected 只表达选择状态，不能映射为
surfaceContainerHighest 并让关闭的开关呈现选中底色。

MD3 按钮区分40dp可见表面与至少48dp点击区域；主题增大 controlHeight 时两者一起增加。
普通图标24dp，当前无文字底栏64dp；iOS 仍为22dp图标与56dp底栏，不机械套用带标签的80dp导航。
两侧 Material 抽屉共用中性的分组页面表面与 `groupRadius` 外侧圆角；菜单使用 `menuRadius`，均可被对应主题角色覆盖。
iOS 浮动底栏保留外层页面留白，三个无文字目的地均分胶囊内部宽度；选中背景与外壳之间保留小间距，不在浮动外壳顶部画贯穿屏宽的分隔线。


本轮复查使用相同离屏宿主重新渲染两种风格、浅深色与自定义主题，增加底栏三个选中位置、
控件滚动状态和实际设置二级页预览；另检查320dp宽、1.6倍字体下的首页、设置、弹窗、菜单及底栏。
Material 源码核对使用项目实际依赖的 Compose Material3 1.9.0；不把无文字导航错误改为带标签导航高度。


设置首页使用紧凑标题栏，日志操作排在说明下方，避免大按钮挤窄文字。
iOS 发送设置采用左标签、右侧最多两行摘要；picker 必须挂在窗口层，遮罩覆盖应用标题栏与底栏，
不能留在页面内容视口。MD 无文字底栏的选中容器加宽加高，图形本身仍使用正常图标尺寸。

MD 模型入口使用无描边的填色 Chip，正常、加载、错误和禁用状态均不恢复默认描边。
平铺底栏的表面色延伸到系统手势区；浮动底栏的外围继续使用页面背景。侧栏不复用底栏的强调色表面。

### 9.8 Android 组件形状与尺寸角色

Material 的整行选中背景（菜单、picker、侧栏入口和底部导航）统一读取 `rowRadius`，默认 12dp；搜索框与普通按钮读取 `controlRadius`，默认同为 12dp。面板和弹窗读取 `groupRadius`，默认 20dp。`selectionRadius` 的 8dp 仅用于分段滑块等小型选中面，不用于整行选中背景。MaterialTheme.shapes 始终由已解析的尺寸角色生成，不再在无主题覆盖时回退到库默认值；Material 底部导航的选中背景由共享组件绘制，避免库内固定的胶囊形状绕过角色。主题显式覆盖仍按对应角色生效。

Android 共享界面按可见组件的层级取圆角，并由界面风格约束默认值。Material 3 使用大容器 20dp、中型控件 12dp、小型选中项 8dp；iOS 风格使用分组与侧栏 12dp、输入卡片 14dp、控件与菜单 10dp、列表行 8dp、选中项 6dp。大容器包括弹窗、底部面板、侧栏、设置分组、输入卡片和浮动底栏；中型控件包括搜索框、筛选项、工具行、普通列表行和按钮；小型选中项包括分段控件的滑块；菜单与 picker 的整行选中背景属于普通列表行。圆形头像、发送按钮、开关圆点和细进度条保留圆形。对应的主题角色分别是 `groupRadius`／`composerRadius`、`controlRadius`／`rowRadius`／`menuRadius`、`selectionRadius`。组件读取角色，主题显式覆盖时仍按覆盖值绘制。

页面横向留白使用 `pageInset`，卡片内部使用 `groupInset`，控件内部使用 `controlInset` 和 `inputInset`。列表与设置项的最小触控高度沿用 `controlHeight`（至少 48dp）；时间线的连续工具行单独使用 36dp 的可见行高，避免把普通按钮和设置项一起压小。工具组内的相邻行间距为 0，阅读内容之间仍由 `rowPadding` 和会话间距设置控制。输入卡片始终先为模型与发送行保留位置，长正文在卡片内滚动，输入视口的上限是 `composerMaxHeight` 扣除底部操作行。

### 9.9 Android 线条、字级与留白

普通列表、设置分组、抽屉边缘和阅读内容的分隔线使用 `hairline` 颜色及 `hairlineWidth`，默认 1dp；静态容器边框也使用此宽度，焦点状态使用 `focus` 颜色及 `focusWidth`，默认 2dp。按钮按压靠背景反馈，除焦点和明确的内容边界外不额外加框。图表数据线、进度和终端字形按数据可读性决定粗细，不套用容器分隔线宽度。

三个根页面与下钻页面的标题栏共用 `barTitle`，取当前风格字阶的导航栏标题（material3 为 22sp、Medium，各风格见 [Android](design/system/android.md) §2.1）；任务页标题不再额外加粗。会话标题使用 `headline`，正文与设置行使用 `body`，组名使用 `footnote` 和次级文字色，时间与辅助信息使用 `caption`。仅搜索命中、状态和选中项以颜色或局部字重强调，避免每一层标题都加重。

任务页的外侧留白跟随 `pageInset`，分组和行内留白跟随 `rowPadding`，小控件与相邻图标使用 `controlInset` 的派生值；不用独立的固定像素间距制造第二套节奏。主题可以覆盖这些角色，触控区域仍受 `controlHeight` 的最小值保护。


## 10. Android 扩展风格与图标（2026-11-08）

界面风格增加 `expressive`、`miuix`、`fluent`，与 `material3`、`ios` 一起提供五个选择。
风格选择与 AMOLED 开关仍是设备偏好，分别保存为 `display.interface-style`、`display.amoled`；
切换不重建导航栈，不修改配色 ID、图标选择或正文排版偏好。
Miuix 主题容器始终保留在同一 composition 位置，仅在该风格启用其点击和滚动反馈，
避免条件包装导致内部 remember 状态在切换时被销毁。

| 风格 | 组件与默认外观 |
|---|---|
| Material 3 Expressive | 复用 Material 控件，增加浮动导航、更大的选中面和圆角；共享运动 token 使用更有弹性的空间弹簧，正文密度不变 |
| Miuix | 固定官方 Compose Multiplatform `miuix-ui` 0.9.4；按钮、开关、复选、单选、输入和滑块使用官方组件；分组、导航、面板与紧凑选择器使用共享语义组件，颜色映射到 Miuix 色表 |
| Fluent | 按官方 Fluent Android 设计参考调整现有共享组件：中性浮层、小圆角、描边次要按钮、细轨道开关、下划线输入和顶部导航选中标记；不额外引入 Android 专用组件库 |

当前 Compose Material3 1.9.0 的 `MotionScheme` 与 Expressive 主题重载为内部 API，
因此 Expressive 是 Riffet 的形状与运动预设，不调用内部接口，也不升级整个 Compose 依赖。
Miuix 0.9.4 元数据要求 Kotlin 2.4.20、Compose Foundation 1.12.0，已与项目版本核对。
其 Android 与桌面包均为 Java 21 字节码（major 65），因此移动端 JVM CI 使用 JDK 21，
本地移动端构建与 JVM UI 运行也需要 JDK 21+；应用的 JVM 17 输出目标与 Android minSdk 26 不变。
Android D8 构建和桌面离屏渲染分别验证平台兼容性。
只引入 UI 模块；玻璃、模糊、窗口和额外导航模块不属于本次扩展。

AMOLED 只在深色模式生效，保留当前主题的强调色、正文与 ANSI 色表。
页面、分组页面、侧栏和终端背景为纯黑，卡片与浮层保留深灰层级；
显式纯黑选择覆盖自定义主题的背景类 design 颜色，其他 design 角色仍按原有覆盖顺序解析。

新增图标每套包含 79 个功能映射，品牌与 Agent 标记仍不替换。
源 SVG、上游版本和功能到文件的映射在 `scripts/icon-sources/{fluent,octicons,mdi,remix}.json`，
`pnpm gen:icon-packs` 与 `pnpm gen:icons:check` 均可离线运行。

| 图标包 | 固定资源版本 | 来源与许可 |
|---|---|---|
| Fluent | `@fluentui/svg-icons` 1.1.345 | [Microsoft](https://github.com/microsoft/fluentui-system-icons)，MIT；Regular，选中项使用 Filled |
| Octicons | `@primer/octicons` 19.42.0 | [GitHub](https://github.com/primer/octicons)，MIT；优先 24px，缺少时保留官方 16px 的 viewport |
| Material Design Icons | `@mdi/svg` 7.4.47 | [Pictogrammers](https://github.com/Templarian/MaterialDesign)，图标采用 Apache-2.0 或各自上游许可；有 Outline 时优先使用 |
| Remix Icon | `remixicon` 4.6.0 | [Remix Design](https://github.com/Remix-Design/RemixIcon)，固定历史 Apache-2.0 版本；不自动更新到 2026 自定义许可版本 |

个别库没有完全对应的图形，使用同库相近语义的官方图标，例如 Octicons 的 Puzzle 使用 Plug、
ShieldHalf 使用 ShieldCheck；MDI 的 CircleDashed 使用 Circle。选中版本缺失时保持同库形状。
不修改原始 path；SVG 图元与 viewport 仅通过现有生成器转换。
完整许可在 `apps/mobile/shared/icon-licenses/`，版权与版本记录在 shared/NOTICE。
生成器将这些文件同步到现有 `composeResources/files/licenses/`，由 Compose 资源流程打包进 APK。
`gen:icons:check` 同时校验生成图标与随包许可，避免版权记录和资源发生漂移。

主题设计契约允许这五个 style ID，旧主题的结构和 revision 不变；
服务端继续规范化排序并持久化 style 覆盖，Kotlin 读取相同协议。未知 ID 仍被校验拒绝。

新增可见字符串仅为三个风格名、四个图标包名、AMOLED 开关名及“仅在深色模式生效”；
风格说明不再随列表重复，设备存储提示缩短为“仅保存在这台设备”。

## 11. Android 共享组件布局复核（2026-11-08）

本轮修复针对新会话页、模型选择面板及其共享组件。原有问题来自四处：文字操作继承次要按钮填色；
触控区域同时被用作绘制背景；标题与长副标题叠放；非 Material 分支把 Miuix 也送入 iOS 布局。
修复落在共享按钮、选择器、菜单、面板标题、顶栏、底栏与弹窗中，业务页面复用这些组件。

触控高度继续由 controlHeight 保护，默认至少 48dp。普通按钮可见面默认 40dp，
模型、目录与 picker 内联选择器默认 32dp；两者由既有 controlHeight 派生，不增加主题协议字段。
可见面随文字和主题覆盖增高，不能以固定高度裁掉大字号内容。返回、关闭、附件与顶栏图标保持普通图标操作，
不叠加常驻填色圆盘。底栏整格负责选择，选中背景只围绕图标绘制。

| 风格 | 内联选择器 | 列表与导航 |
|---|---|---|
| Material 3 | 紧凑色调填充 | 圆角选中行、紧凑底栏选中面 |
| Expressive | 圆角色调填充 | 分离的分段按钮、浮动底栏与圆角选中面 |
| Miuix | 中性填充 | 选中行填色与勾选、平铺底栏与选中点 |
| Fluent | 中性描边 | 细分隔线、选中行左侧标记、底栏顶部标记 |
| iOS | 透明强调色操作 | 分组分隔线、勾选、浮动底栏 |

面板标题、返回与关闭按钮使用同一行的顺序布局；长副标题独立放在下方，最多两行。
下钻页面顶栏遵循相同规则。浮动底栏偏好不再让顶栏也生成浮动面板。
弹窗 action 插槽允许发射多个按钮：Miuix 与 Fluent 使用可换行布局，
iOS 短提示按纵向顺序放置操作，避免未保存设置的三个操作在 Box 中重叠。
Miuix 每个 action 单独绘制背景，背景不跨过相邻操作的触控留白。

验证使用临时 JVM 离屏渲染入口，复用实际 ProjectHome、ModelPickerPages、ComposerCard、
ProjectSwitcher 和共享弹窗内容；未向仓库增加 UI 测试。
五套风格分别渲染 393×853dp 浅色、320×853dp／1.6 倍字号浅色、393×853dp 深色，
包含新会话、模型、组合控件、两操作弹窗与三操作未保存弹窗，共 75 张图。
弹窗额外限制为屏幕宽度减 56dp，检查窄内容约束；这仍不代表 Android 原生窗口或键盘交互验证。
对比图位于 output/android-theme-review。Android APK 构建、共享 JVM 编译和 diff 格式检查另行执行。
本轮无新增产品文案；已有按钮名只用于临时预览。

## 12. Android 主题解析与组件策略（2026-11-08）

风格标识只用于设备偏好、协议覆盖索引和 ThemePresets 的预设分派。渲染组件不再读取
material、ios、miuix、fluent、expressive 身份开关，InterfaceStyle 枚举也不再携带 materialControls。
主题职责分为预设、解析和渲染三个边界：

| 边界 | 实现 | 职责 |
|---|---|---|
| 预设 | ThemePresets.kt | 集中声明尺寸、字级、表面色、运动默认值及各组件策略 |
| 解析 | DesignTokens.kt | 合并通用默认值、预设、通用 token 和指定风格 token，执行尺寸保护与值转换 |
| 组件 | ComponentRecipes.kt 与共享组件 | 按具体组件的 backend、presentation 和外观规则渲染，持有交互状态与语义 |
| 安装 | RiffetTheme.kt | 安装解析后的字级、颜色、形状和反馈，不按风格名称分支 |

按钮、开关、选项、输入框、滑块、进度和导航分别选择组件 backend；
分段、内联选择器和导航标记使用各自的 presentation。列表分组、选中面、分隔线与选项位置分别声明，
不能从某个按钮或输入组件的 backend 推导。表面着色与点击反馈也分别声明。
Material 与 Miuix 的调用留在组件适配边界，业务页面复用共享控件；
发送与交互选项的激活、长按、单选和多选语义使用统一的 interaction source 与主题反馈。
现有导航、草稿、provider 选择与参数状态继续由调用方持有，预设中不存储业务状态。

导航布局、首页标签、设置图标和次要按钮的协议字符串在解析边界转换为内部枚举；
协议键和值保持不变，未知值保留上一层结果。颜色、字级、尺寸和运动覆盖顺序沿用现有契约。
运动参数的回退与预设读取同一份默认表。Miuix 包装仍位于固定 composition 位置，
避免切换预设重建导航或草稿。AMOLED 继续在解析颜色后施加本地纯黑覆盖。

新增风格应先组合已有组件策略和 token，再注册预设及现有选择入口；
只有新增的交互或结构不能由既有组件表达时，才扩展对应组件适配器。
不在业务页面增加风格 ID 判断，也不复制整套页面为新风格服务。

共享 picker 的可见高度上限改为 min(扣除 IME 后可用高度 × 70%, 640dp)，短内容仍可包裹。
遮罩覆盖完整窗口。模型页参数区最多占提示后剩余内容高度的 40%，内部可滚动；
模型列表获得其余空间，避免小窗口下被参数区挤没。该比例属于本地面板策略，不增加服务器协议字段。

本轮临时预览增加 393×430dp、320×430dp／1.6 倍字号和 800×1200dp 三组约束，
与此前浅色、深色、大字号条件合计渲染 150 张实际页面与共享控件图。
430dp 场景模拟键盘后的可用内容高度，不代表真机 IME 验证。现有偏好持久化和契约测试另行执行，
没有增加 UI 测试或新依赖。新增产品可见字符串为零。

项目选择使用 DropdownMenu，读取独立 MenuRecipe 的 70%／640dp 高度上限；
共享菜单在把约束交给 Material 内置滚动布局前限制最大高度，短菜单仍包裹内容。
“选择其他目录”位于项目菜单标题后、项目列表前。
临时预览点击实际 ProjectSwitcher 展开 DropdownMenu，覆盖五套风格、手机、大字号和平板、
26 条长列表与 2 条短列表，共 30 张图；实际 Popup 的高度、包裹与操作顺序已检查代表场景。

## 13. Android 表面材质方案与实现（2026-11-08）

表面材质与五套界面风格、配色、图标和 AMOLED 分开。设备偏好新增纯色、磨砂、通透玻璃、
液态玻璃四档及 0～1 的强度，默认磨砂／0.5；保存为 display.surface-material 和
display.material-strength。未知存储值保留到用户选择，非有限强度不写入。没有扩展服务器主题协议。

统一使用 Haze core／blur／glass 2.0.1，依赖元数据与 Kotlin 2.4.20、Compose 1.12.1 对齐。
SurfaceMaterial.kt 封装该版本的公共 API 和 experimental opt-in，不使用反射、内部 Haze area 集合、
实验 native window backdrop 或实验 source-sharing；Miuix 继续负责已有控件。
磨砂使用一个 Blur pass；通透与液态的独立表面使用一个 Glass pass，连续顶栏统一使用无边缘 Blur pass。前景文字和图标在材质背景之后独立绘制，
交互形变只作用于材质，遵循系统减少动态配置，不增加周期性 shader 动画。

| 材质 | 策略 |
|---|---|
| 纯色 | 保留原背景和布局，不注册采样源 |
| 磨砂 | 背景模糊、主题染色和细颗粒；顶栏使用渐进强度 |
| 通透玻璃 | 背景扩散与轻染色，保留背景层次，不改变背景几何 |
| 液态玻璃 | 边缘折射、高光及轻微按压反馈；阅读面强化模糊并关闭色散 |

材质的字级和控件尺寸沿用解析后的组件角色；手机导航使用独立的悬浮胶囊，顶部工具栏、搜索和分类共用连续材质。
MaterialSpec 集中按用途解析参数：菜单、面板、输入卡片、弹窗和侧栏优先保护文字；
导航与独立小控件允许较轻的材质和边缘光学。大面板使用 Performance profile，其他表面使用 Balanced。
Glass 的 depth 设为 1，避免清晰原图混合削弱模糊与折射。普通内层背景保留轻微色调，避免遮住材质外壳；
选中、禁用、危险操作和焦点反馈继续使用既有语义颜色。

### 13.1 采样与窗口边界

源与消费者按层级分离。根窗口提供不含控件的背景源，任务列表和时间线提供独立的正文源。
被覆盖页面不注册正文源；源键随其列表／会话生命周期管理。Haze 按消费需求录制，并在节点分离时释放图层。

| 入口 | 约束 |
|---|---|
| RiffetMaterialScope | 固定包装位置，持有根 source scope，不保存导航或业务状态 |
| riffetMaterialSource | 注册到当前 scope；内部记录不透明底色，避免透明采样伪影 |
| RiffetMaterialSourceContent | 保持当前 scope，抑制源中的材质消费，避免源采样自身 |
| riffetMaterial | 从最近有已附着源的 scope 读取，缺少源时沿父 scope 回退 |
| RiffetMaterialContent | 为外壳内容建立 child scope，抑制内层重复材质；子源不进入父外壳的 state |
| RiffetMaterialWindow | Popup／Dialog 入口清除旧边界，保留 source scope 和父链 |

Haze 的 Behind selection 不能自动排除消费者的所有子源，因此每个 source scope 使用独立 HazeState。
轻量 Modifier.Node 跟踪源的 attach／detach，仅用于选择可用源，不读取库内部集合。
窗口边界须包住材质 modifier 的组合计算；只包窗口的内容槽会让 modifier 仍读取旧边界。
先绘制外壳，再进入 Content；透明间隔不能提前进入 Content，例如分离的 iOS action sheet 的列表与取消面板。

跨 Popup／Dialog 的坐标由 Haze Sources 的 Screen 策略处理。保留策略为 ClearWhenUnavailable，
不可用的源像素清除；原背景提供基底，Haze 可叠加 tint／rim 简化材质。不同平台的降级不承诺像素一致。

### 13.2 覆盖与布局

| 角色 | 绑定范围 |
|---|---|
| NAVIGATION | 底栏外壳、宽屏导航栏 |
| TOP_BAR | 共享顶栏、大标题栏；无光学边框，下缘渐隐；任务页覆盖工具栏、搜索和分类 |
| COMPOSER | 新会话与会话输入卡片 |
| MENU | 所有共享 DropdownMenu，包括项目、模型入口与会话动作 |
| SHEET | 共享 picker、分离 action sheet、快速对话原生面板 |
| DIALOG | 共享确认与表单弹窗；纯色保留原生 Material 路径 |
| SIDEBAR | 左右抽屉外壳；内层分组保持色调和边界 |
| CONTROL | 独立内联选择器与分段选中面；已处于材质外壳内则继承外壳 |

启用材质时，首页正文延伸到导航栏后方；任务列表和设置滚动区保留底部内容留白，末项可滚动到导航栏上方。
纯色恢复原来的空间分配。会话输入、导航回调、草稿和 provider 选择仍由原组件管理。
picker、项目菜单以及快速对话中的模型／阅读区域继续遵守 70%／640dp 上限，参数区保留自己的滚动约束。
独立 QuickChatActivity 与设备确认窗口读取同一设备材质、强度和 AMOLED 偏好；没有可用背景源时使用降级表面。

### 13.3 验证与边界

验证复用已有 DisplaySettingsTest 的持久化行为，未增加 UI 展示测试。
临时 ImageComposeScene 预览使用可见的代码／渐变兄弟源，覆盖四材质 × 五风格 × 明暗，
另加 320dp／1.6 倍字号与真实嵌套 ProjectSwitcher Popup，共 48 个场景。
父源与子源使用不同颜色，以检查作用域隔离和跨窗口坐标；预览仅是验证背景，不写入产品。
共享 JVM 编译与 Android debug APK 构建通过；既有偏好持久化测试、图标生成一致性、
1199 项中英文资源检查及 diff 空白检查通过。48 个预览场景完成渲染，代表图已检查明暗、
大字号和嵌套菜单，产物见 output/android-material-review。真机 GPU 性能及 iOS 实机效果未验证。

新增产品字符串仅为“表面材质”“纯色”“磨砂”“通透玻璃”“液态玻璃”“强度”；
这些字符串标识分组、可选材质和控制含义，无控件说明副标题，设备存储提示复用现有文案。

### 13.4 玻璃布局与光学修正（2026-11-09）

任务页的顶部改为覆盖层：先测量工具栏、搜索、分类和离线提示，再将该高度作为列表的顶部留白。
列表与材质均延伸至已消费的状态栏区域；正文从整块顶部材质后方滚过，采样源不包含前景控件。
纯色仍保留搜索与分类随列表滚动的布局。内层工具栏背景透明，不绘制内部的样式分隔线。

启用材质时，手机底部导航使用居中的胶囊，外侧与手势区域显示正文，选中面只叠加轻色调。
导航尺寸不再由某个风格的矩形面板决定；宽屏仍使用导航栏。

连续顶部按材质解析模糊与颜色响应，保护前景文字；无矩形折射边框、高光边框或边缘阴影。
Haze 公共 mask API 将完整材质在下缘 16dp 淡出，遮罩不影响前景控件和采样源。
独立表面的默认强度为 0.5：通透玻璃使用 12dp 模糊、不改变背景几何；液态玻璃使用 2.75dp 模糊、
0.775 边缘折射强度、40dp 位移与 0.76 清晰折射细节。Haze 按实际尺寸限制位移，阅读表面保留更强模糊和染色。

Android 35 模拟器使用隔离的本地服务和空测试会话，检查列表滚动、搜索输入、放大字号与 Pad 双栏；未提交模型消息。
JVM 和 Android 编译通过，复用四个临时材质／嵌套窗口预览，未增加维护中的 UI 测试。
实际截图保存在 output/android-glass-review；OEM GPU 与低版本 Android 的高级折射未验证。
新增用户可见字符串为零，底部标签复用既有目的地名称。

### 13.5 固定顶底区域统一接入（2026-11-09）

RiffetPageScaffold 统一测量固定顶部、底部与正文，正文留白放在现有滚动容器内部。
固定栏与采样正文是兄弟层；状态栏、手势区域及上下渐隐在共同布局处理，页面不再复制独立的材质布局。
材质作用域始终挂载，切换纯色与玻璃只改变 modifier 和参数，不重建时间线、滚动状态或输入草稿。
非活动页保持相同测量几何，但不注册正文源。

正文源的 zIndex 为 1，根背景为 0。正文消费者显式筛选 zIndex < 1；Haze Behind 同时避免读取祖先源自身：
正文的 Composer／选择器读取根背景，固定兄弟栏读取正文与背景；弹窗读取最近可用的正文。
RiffetMaterialRecordedContent 保留正文控件的材质渲染，抑制重复注册正文源；没有把整页当作 SOURCE 来关闭内层材质。

| 默认强度 0.5 的连续固定栏 | 模糊 | 浅色染色 | 饱和度 | 细颗粒 |
|---|---|---|---|---|
| 磨砂 | 30dp | 0.59 | 1.0 | 有 |
| 通透玻璃 | 17dp | 0.38 | 1.03 | 无 |
| 液态玻璃 | 12dp | 0.34 | 1.22 | 无 |

连续栏保留颜色与扩散差异，独立胶囊、菜单和弹窗使用真正的边缘折射。底部连续栏在上缘 16dp 渐隐。
手机导航只显示图标，保留目的地无障碍描述；等宽槽位的选中面四边统一内缩 4dp，使用同心胶囊，光照水平居中。

| 接入入口 | 固定区域 |
|---|---|
| ScrollablePage | 设置首页、全部设置路由及共用滚动页面的标题栏 |
| ProjectHome | 新会话标题与模式分类 |
| SessionList | 任务标题、搜索、筛选与离线提示 |
| SessionScreen／SubagentScreen | 会话标题与固定状态；会话完整输入 dock |
| StatsScreen | 统计标题、筛选及统计分类 |
| DownloadsScreen | 下载标题、提示及摘要 |
| FilePageChrome | 文件标题、路径／收藏／搜索表单／预览选项；代码行数底栏 |
| TerminalScreen／TerminalBenchScreen | 终端标题、连接信息及诊断参数；终端输入和快捷键底栏 |
| QuickChatSheet 会话分支 | sheet 内标题与输入区；不重复扩展 Activity 的系统 inset |

终端先绘制完整背景配色，再在安全区域测量网格；不为玻璃透视扩展协议中的行列数。
图片与原生 HTML 阅读器保留安全阅读区；没有承诺采样原生 WebView 的页面像素或跨原生窗口的其他应用内容。

验证：共享 JVM／Android 编译，现有临时设置搜索预览 6 场景与原生快速对话高度预览 4 场景通过。
Android 35 模拟器检查任务和设置滚动、左右端选中形状、新会话控件、会话输入及键盘；测试服务未发送模型消息。
截图保存于 output/android-fixed-chrome-review。未新增维护中的 UI 测试或用户可见字符串；物理 GPU、原生 WebView 与所有终端／折叠姿态组合未逐一实机验证。

### 13.6 编辑区、材质入口与切页采样（2026-11-09）

会话详情采用玻璃底托与实色编辑面：底托继续采样正文，圆角编辑面使用主题 floating 色，
遮住经过编辑区的正文。普通 group 的 12% 内层填色不适用于编辑器；高对比正文验证中，
78% 填色仍会在底托渐隐上缘留下正文轮廓，因此编辑面保留完整填色。
空草稿未聚焦时保留原有紧凑高度、细边框与填色，聚焦后展开模型／操作行并加强边框。
有草稿、附件或引用时保留展开状态，继续使用原有行为。
编辑器使用自己的紧凑装饰布局，避免叠加 Material 输入控件的最小高度和上下留白。

材质选择与强度统一放在「界面风格」，主题页保留配色与背景设置。
设置与会话列表使用同一个 RiffetSearchField，统一使用实色搜索编辑面，不受父层材质边界影响。
周围页面间距由调用方提供；材质搜索目标
appearance.material 保留原 ID，跳转至界面风格。

正文内材质控件显式使用 HazeSourceSelection.Behind.where { zIndex < 1f }，只消费 wallpaper0。
退出页在淡出期间移除 body1 source 时，采样范围不再扩张到进入页；固定栏仍消费活动 body1。
继续使用 ClearWhenUnavailable，不保留其他页面的像素，也不增加延迟挂载。

验证：JVM／Android 编译、设置检索和跳转 6 场景；三种材质的空输入未聚焦／聚焦、多行与
1.6 倍字体共 12 张临时渲染预览；Android 35 模拟器检查失焦／键盘、两处搜索框和多次 tab 切换录像。
实际截图、录像与代表性渲染预览保存于 output/android-composer-review。
渲染预览包含红蓝高对比正文；模拟器使用隔离服务和空会话，未发送模型请求。
未验证物理设备 GPU 与 OEM 渲染差异。未新增产品字符串或维护型 UI 测试。

### 13.7 输入区孤岛布局（2026-11-09）

会话输入区改为与底 tab 一致的浮动布局：水平外边距至少 24dp，安全区域底部留白至少
12dp，保持空输入未聚焦时的 48dp 紧凑高度。输入框复用 floatingShadow，不再绘制常驻或
聚焦边框；聚焦通过光标、操作行展开及轻微加深的阴影表达。

RiffetPageScaffold 的 floatingBottomBar 只取消连续底栏材质，保留同一套底部测量与
系统栏 inset 算术；正文从岛的四周经过。岛内编辑面继续使用完整主题填色，遮住正文。
会话详情与快速对话的 transcript 分支使用浮动底部，后者移除重复的 Composer 外层间距。
共享 ComposerCard 保留各风格既有圆角、内部字号与输入尺寸，不增加新的样式 ID 判断。

验证：共享 JVM／Android 编译、三种材质共 12 张紧凑／聚焦／多行／大字体临时预览，
既有快速对话手机／Pad 弹窗高度预览。孤岛预览保存在 output/android-composer-island-review。
本轮没有重复实机 IME 验证；系统 inset 与键盘布局逻辑沿用原有实现。未新增产品字符串。

### 13.8 输入岛与底 tab 统一材质（2026-11-09）

浮动 bottom slot 使用 RiffetMaterialWindow，让输入岛自行消费活动正文源；连续底栏仍
使用 RiffetMaterialContent。上一版浮动容器继承 SURFACE 并保留完整填色，导致输入岛
没有执行 Haze 材质 pass；本次移除该遮挡路径。

COMPOSER 在材质引擎中复用 NAVIGATION 光学角色，使用相同的底色、模糊、染色、折射、
高光与顶部居中光照；不再维护输入区独立的 reading recipe。纯色模式仍沿用原有填色。
孤岛外边距、无边框以及未激活紧凑高度继续沿用 §13.7。

| 强度 0.5、浅色模式的基础参数（对比度下限应用前） | 模糊半径 | 基础染色透明度 |
|---|---|---|
| 磨砂 | 21dp | 0.58 |
| 玻璃 | 12dp | 0.24 |
| 液态玻璃 | 2.75dp | 0.13 |

三种材质各增加真实 ComposerCard 与 RiffetTabBar 同背景对照，连同紧凑、聚焦、多行和
大字体共 15 张临时渲染预览。对照采用相同横向颜色分布，以检查染色与扩散一致性；液态
玻璃保留底 tab 的清透与折射表现。输出保存于 output/android-composer-material-review。
验证为 JVM 渲染与 Android 编译；本轮未重新进行物理 GPU 或实机 IME 检查。

### 13.9 提交前整体复核（2026-11-09）

复核修正两处问题：输入岛／底 tab 在浅色主题与深色背景组合中前景对比度不足；任务页
把搜索／筛选移入固定区后，保存的列表索引因条目数变化而指向另一条会话。

材质引擎对两个岛使用共同染色下限，检查黑白背景端点形成的完整亮度区间；普通前景
目标 4.5:1，强调色选中图标经原有选中层后的目标 3:1。输入占位文字和未选中图标使用
较强的主题前景。模糊、折射与光照仍共用原来的配方，没有叠加实色遮挡层；柔和的主题
前景可能需要更高染色比例。自身颜色已经低对比度的自定义主题仍需修正配色。

任务页保留搜索与筛选的 LazyColumn 键和索引；固定顶部模式下，这两个条目不绘制子内容，
避免跨材质恢复保存状态时条目序号偏移。

资源缓存范围、资源下载与字体预检、设置持久化、协议、生命周期与折叠窗口经过复核。
本轮使用现有核心测试、类型／生成检查和临时渲染验证；不增加维护型 UI 测试。
设置持久化／主题协议 9 个 JVM 用例、主题服务 7 个用例通过；TypeScript、图标／主题
生成和中英文资源检查通过。更新后的材质对照 9 场景、搜索跳转 6 场景、手机／Pad
快速对话高度 4 场景及 Android APK 构建通过。
Android 35 隔离模拟器实际检查玻璃→纯色→玻璃切换，三次均保留同一会话滚动锚点；
紧凑输入框、软件键盘上方留白与新会话组件完成检查，未发送模型请求。
本轮截图与材质对照保存于 output/android-theme-final-review；源码提交不包含这些预览产物。
物理 GPU、OEM 折叠扩展和全部终端／原生 WebView 组合仍未逐项实机验证。

## 14. BiliPai 的进一步借鉴点（2026-11-08）

调研固定在 jay3-yy/BiliPai 的 01712e7d7ff7cc5e9ff2b1b39eccf9fb8450d724 提交；
以下记录调研时的建议；设置搜索、Android 外观资源、视觉生命周期及折叠／Pad 布局已在 §15 落地，备份与预测返回仍为后续工作。未复制其应用代码。

| 优先级 | 借鉴点 | Riffet 应补的部分与源码证据 |
|---|---|---|
| P1 | 设置搜索与定位 | 当前只有分类导航。可按标题、别名、拼音检索，并跳转／滚动到目标控件：[SettingsSearchPolicy](https://github.com/jay3-yy/BiliPai/blob/01712e7d7ff7cc5e9ff2b1b39eccf9fb8450d724/app/src/main/java/com/android/purebilibili/feature/settings/SettingsSearchPolicy.kt) |
| P1 | Android 完整消费外观资源 | 已有字体、背景和预设协议，Android 尚未完整消费。应复用现有格式补选择、预览与缓存，而不是重建皮肤包：[UiSkinModels](https://github.com/jay3-yy/BiliPai/blob/01712e7d7ff7cc5e9ff2b1b39eccf9fb8450d724/app/src/main/java/com/android/purebilibili/core/plugin/skin/UiSkinModels.kt)、[UiSkinPackageReader](https://github.com/jay3-yy/BiliPai/blob/01712e7d7ff7cc5e9ff2b1b39eccf9fb8450d724/app/src/main/java/com/android/purebilibili/core/plugin/skin/UiSkinPackageReader.kt) |
| P2 | 本机偏好备份与迁移 | 服务端备份已有；设备上的界面风格、图标、字号和材质不在其中。适合版本化 JSON 和选择性恢复，WebDAV 可后续接：[WebDavBackupService](https://github.com/jay3-yy/BiliPai/blob/01712e7d7ff7cc5e9ff2b1b39eccf9fb8450d724/app/src/main/java/com/android/purebilibili/feature/settings/webdav/WebDavBackupService.kt) |
| P2 | 视觉工作的统一可见性闸门 | 已有 LocalPageActive 与减少动态；可进一步统一页面可见、宿主 resumed、窗口焦点，供后续装饰动画共用：[DecorativeAnimationGate](https://github.com/jay3-yy/BiliPai/blob/01712e7d7ff7cc5e9ff2b1b39eccf9fb8450d724/app/src/main/java/com/android/purebilibili/core/ui/DecorativeAnimationGate.kt) |
| P2 | 折叠屏与多窗口上下文 | 已有宽度驱动的导航栏与双栏。可补铰链、折叠姿态与多窗口上下文，避免内容跨铰链：[FoldableDisplayPolicy](https://github.com/jay3-yy/BiliPai/blob/01712e7d7ff7cc5e9ff2b1b39eccf9fb8450d724/app/src/main/java/com/android/purebilibili/core/util/FoldableDisplayPolicy.kt) |
| P3 | 可中断的预测返回 | 已有 PredictiveBackHandler；可改善进入／settle 中拒绝新手势的行为，借鉴先停止动画再抓取锚点的接续模型：[NavPredictiveBackDriver](https://github.com/jay3-yy/BiliPai/blob/01712e7d7ff7cc5e9ff2b1b39eccf9fb8450d724/miuix-navigation/src/main/java/top/yukonga/miuix/kmp/nav/gesture/NavPredictiveBackDriver.kt) |

## 15. 设置搜索、外观资源与自适应窗口（2026-11-09）

### 15.1 设置搜索与定位

SettingsSearch.kt 维护一份目录，当前包含 17 个分类和 46 个控件／分组目标。条目使用稳定 ID、
分类、资源标题及中英文／拼音／首字母别名；检索本地目录，不为搜索挂载远程配置页。
结果进入现有 SettingsPageRoute，共享 SettingsGroup／SettingsRow 及显式字号锚点在完成布局后
BringIntoView 并高亮 2.2 秒。选择不改设置、不调用控件动作；返回保留查询。不可用平台入口与
尚不存在的外观资源 provider 从目录中排除。动态模型、扩展实例、设备名称不属于此索引。

### 15.2 Android 外观资源

沿用 AppearanceCatalog、AppearanceAsset 与既有预设格式，不新增皮肤包或服务器协议。
本机保存 preset／palette／uiFont／monoFont／background，顺序为宿主默认、预设、单项选择；
单项 default 显式恢复默认。选择预设清除先前单项覆盖；插件停用或贡献缺失只影响当前有效值，
不删除选择。选择内置主题时只将插件配色设为 default，字体和背景继续生效。

主界面、快捷聊天及设备确认入口读取同一鉴权范围的偏好。范围由服务端 origin 与当前鉴权身份的
SHA-256 确定，不存储明文凭证；无鉴权开发服务使用独立 anonymous 范围。目录缓存复用 LocalFiles／
IconPackCache，资产使用 Android 私有 no-backup 目录。使用前验证资产路径、声明大小、内容哈希与
解码边界，原子替换缓存，磁盘资产限制 128MiB。资源损坏或加载失败显示原因类别并使用默认值；
目录刷新失败仍保留本机目录和已加载资源。

目录、配色、两种字体和背景独立加载；仅有效 payload 或显式刷新改变时重载。改配色不会清掉字体。
每个加载槽记录请求 owner，旧请求的结果及取消清理不能覆盖新请求状态。字体应用于共享排版角色、
原生 Material 字级、Markdown／代码及终端；未选等宽字体时，终端仍使用原来的 JetBrains Mono。
背景位于正文之前，遵守 cover／tile／opacity，并进入材质采样背景，不增加触控或无障碍入口。

现有字体资源为 WOFF2。Android 使用 io.github.khoben.woff2-android:decoder:0.0.3 解码为 TTF，
仅调用文件接口。预检限制输入 16MiB、单字体族展开与变换流 32MiB、Brotli window ≤22；解码后的
文件单独校验。发布 AAR 覆盖四个 Android ABI，64 位 ELF 为 16KiB 对齐；wrapper、Google WOFF2、
Brotli 的许可证已随应用打包。Android 29+ 使用原生 CustomFallbackBuilder 合并字重和 cmap 子集，
保留系统 CJK 回退；26～28 使用 Compose 文件字体族，同字重多子集受旧平台解析器限制。
正式 iOS 界面是 SwiftUI，本节的资源消费能力仅指 Android。

### 15.3 视觉生命周期

RiffetVisualWorkScope 安装宿主生命周期，visualWorkActive 统一组合 RESUMED、当前窗口焦点、
LocalPageActive 与可见区域；装饰循环还检查系统减少动态设置。VisualWorkVisibility 通过布局的
clipped window bounds 更新，离开 Lazy 列表视口后不再维持头像转圈、工作脉冲、加载动画和计时循环。
计时器在恢复可见时读取当前时钟；减少动态保留可读的静态状态与计时。此层只管理界面工作，
不改变连接、后台任务、消息发送或导航的生命周期。

### 15.4 Pad、分屏与物理铰链

AndroidX WindowManager 1.5.1 在 Activity STARTED 范围采集 FoldingFeature，提供窗口相对像素坐标、
方向、分隔／遮挡和 half-opened 状态。分屏只改变当前窗口约束，不据其宽度推断物理折叠状态。
普通窗口在宽度 ≥600dp／高度 ≥400dp 使用 rail，宽度 ≥840dp／高度 ≥480dp 使用任务双栏；
列表为剩余宽度的 32%，限制 320～420dp，内层总宽不足 681dp 才回退。

book 模式预留 rail 后保证列表至少 320dp、详情至少 360dp；tabletop 上下屏段均满足最小高度后
分置列表和详情。空间不足或键盘压缩详情时使用较大的安全屏段。其他页面不横跨分隔／遮挡铰链。
Pad 抽屉使用覆盖布局，宽度上限 420dp，并受所在边缘屏段限制。共享 Picker、确认框和原生快捷聊天
使用来源屏段；原生 sheet 保留官方 anchor／拖动／关闭逻辑，无铰链时保留原测量路径。浮层最大宽度
640dp，面板高度继续遵守可用高度的 70%／640dp 上限。
物理铰链上的菜单使用公共 PopupPositionProvider，在调用方尺寸 modifier 之前限制宽高，再按来源
锚点定位；靠近铰链与窗口最右缘请求 640dp 宽菜单均通过整壳边界检查。普通窗口沿用 Material 菜单。

### 15.5 本次验收

共享 JVM 编译、Android APK 构建及既有 DisplaySettingsTest 的 5 项核心检查通过。中英文资源共有
1210 个 key，图标／许可证生成一致性及 diff 空白检查通过。临时实际 SettingsScreen 交互覆盖中文、
英文、拼音、首字母、320dp／1.6 倍字号：定位到目标并返回后保留查询。Pad、book、tabletop 的实际
组件预览共 13 个自适应场景，检查浮层屏段、焦点／页面 gate、受控浮层卸载后不重复关闭与
840／900dp 阈值。4 个实际原生快捷聊天场景检查关闭态与模型页，含手柄的模型页总高在手机
为 597dp、Pad 为 630dp，均遵守窗口 70%／640dp 上限。
没有增加维护 UI 展示测试。

Android 35 arm64 临时模拟器完成实际配对、选择官方纸墨预设；两份 Inter WOFF2 实际解码为
168916／286744 字节 TTF，UI 应用 Inter、纸纹和配色。Pad 尺寸显示列表／详情双栏，断开测试服务后
重启仍恢复字体、背景与列表缓存。预览及模拟器截图位于 output/android-capabilities-review。
OEM 折叠屏 extensions、真实设备 GPU 性能、系统键盘／手势全组合及 Android 26～28 字体子集仍未
进行实机穷尽验证。

新增产品文案为搜索入口／空结果，以及外观资源、预设、配色、界面字体、等宽字体、背景、刷新和
两种加载失败提示。标签说明可选项，失败提示说明当前默认或缓存行为；无操作说明副标题。

## 16. 代码高亮风格（2026-11-16）

代码高亮风格作为独立于界面配色与明暗模式的设备本地偏好，在四端「主题」设置里提供「跟随界面主题（`auto`）」与 9 套内置风格（`intellij`、`github`、`vitesse`、`one`、`catppuccin`、`solarized`、`rose-pine`、`everforest`、`monochrome`），各含明暗两半，具体角色与纸底融合规则见 [基础](design/system/foundations.md) §1.1。

- **单一来源**：契约在 `packages/contracts/src/code-theme.ts`（14 个语法色角色与 `auto` 映射规则），调色板在 `scripts/code-themes.ts`，由 `pnpm gen:theme` 统一生成到 Web CSS（`apps/web/src/styles/index.css` 的 `code-themes` 标记区）、`apps/web/src/lib/code-themes.generated.ts`、Android `RiffetTheme.kt` 以及 Mac / iOS 的 `RiffetTheme.swift`。
- **`auto` 映射**：自定义主题或插件配色自带 `syntax` 时优先使用其自带配色；`solarized`、`catppuccin`、`rose-pine`、`everforest` 界面主题自动匹配同名高亮风格；`pencil` 自动匹配 `monochrome`；其余界面主题（含默认 `riffet`、阅读主题与未附带 `syntax` 的自定义主题）使用 `intellij`。
- **用户自定义与导入**：`CustomTheme` 支持可选字段 `syntax: { light, dark }`（各含 14 个角色色值与 `commentItalic`，由 `packages/contracts/src/theme.ts` 校验与规范化，缺省时兼容既有主题的 `revision`）。Web（`ThemeEditor.tsx`）与 macOS（`ThemeEditorView.swift`）编辑器支持套用内置预设、逐项编辑 14 色与注释斜体，并支持导入社区 VS Code / TextMate JSON(C) 主题自动映射到 14 角色。Android 与 iOS 在选择列表中消费随主题库同步下来的自定义代码风格。
- **各端存储**：Web 存在 `riffet.display`（`codeTheme`），macOS 存在 `UserDefaults["riffet.code-theme"]`，Android 存在 `DisplaySettings`（`display.code-theme`），iOS 存在 `UserDefaults["riffet.ios.code-theme"]`。

