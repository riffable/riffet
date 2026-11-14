# 展示

只呈现信息、不接受操作的元素。画面在 `/design/components/display`，实现在 `apps/web/src/components/ui/controls.tsx`、`components/AgentLogo.tsx`、`components/agent-marks.tsx`、`components/OwnerAvatar.tsx`。颜色只在表示状态时使用，且文字总要说出状态。

## Badge

### 用途

给一个对象附一个短状态（已完成、失败、新）。有补救操作用 [`StatusPill`](actions.md)。

### 变体与尺寸

`tone`：`neutral`（`bg-muted`）、`accent`、`success`、`warning`、`danger`（各自 `*-soft` 底，同色字）。高 20，`rounded-md`，`text-2xs font-medium`，图标 `size-3`。`title` 放细节。

### 状态

无交互状态。

### 键盘与无障碍

`<span>`，不可聚焦；状态靠文字读出，颜色不承载信息。

### 文案

1–4 个字的状态名，名词或过去分词（「已归档」「等待确认」）。

### 不要

- 只靠颜色区分状态。
- 把 Badge 做成可点：用 `StatusPill` 或按钮。

## StatusDot

### 用途

极小的状态指示：在线、运行、需要注意。

### 变体与尺寸

`tone`：`idle`（`fg-4`）、`accent`、`success`、`warning`、`danger`；`shape`：`dot` 实心、`ring` 空心；`pulse` 呼吸，用于仍在进行的状态（运行、录制、重连）和等待用户处理的会话（空心环）；其余状态不呼吸。尺寸固定 6。

### 状态

三个维度互相独立；同色的两种状态用实心 / 空心区分。减少动态时 `pulse` 由全局规则改为缓慢淡入淡出。

### 键盘与无障碍

传 `label` 时是 `role="img"` 加 `aria-label` 与 `title`；不传则 `aria-hidden`，意味着旁边必须有文字。

### 不要

- 做动态标志或会话运行指示以外的装饰（见 DECISIONS 2026-11-11「动态标志只做氛围」）。

## Kbd

### 用途

快捷键。一个键一枚；组合键并排多枚。高 20，`bg-muted`，`text-2xs`，`fg-3`。

### 文案

按平台符号（⌘ ⇧ ⌥ Esc）；Tip 内的快捷键用 `Tip kbd`，不嵌 `Kbd`。

### 现状

- `lib/platform.ts:9` 的 `shortcutLabel` 生成字符串，`Kbd` 本身不拆分组合键；没有快捷键注册表（见 patterns 的键盘一节）。

## AgentMark · AgentLogo

### 用途

标识一个后端（Claude Code、Codex、Cursor、DeepSeek、Droid、pi、TRAE CLI、Antigravity）。`AgentLogo` 是入口：内置 id 画 `AgentMark`，插件 Agent 画它声明的 SVG（以 `<img>`，不内联），没有则 `IconBot`。

### 变体与尺寸

`size` 为像素，常用 11（侧栏行）、14（默认）、20、28。多数标记取 `currentColor`；Codex 为渐变，pi 与 Antigravity 保留品牌色。

### 键盘与无障碍

装饰性图形，`aria-hidden`；名称由旁边的文字或所在元素的 `aria-label` 给出（`SessionRow` 的包裹 `<span role="img" aria-label>`）。

### 不要

- 改色或单色化品牌色标记（标签栏的 Agent 标志保留品牌色，见 DECISIONS）。
- 手改 `agent-marks.tsx`：由 `pnpm gen:marks` 从 `scripts/agent-marks/*.svg` 生成。

## OwnerAvatar

### 用途

所有者头像：图片，其次名字首字，其次通用人形，依次回落（`docs/OWNER.md`）。圆形，`bg-active`，`size` 为像素，字号为尺寸的 42%。

### 现状

- 渠道机器人头像是另一个实现 `BotAvatar`（`app/settings/channels/shared.tsx:15`，`size-8` / `size-10`，`bg-muted`），没有共用圆形头像组件。

## CodeBlock 与 Markdown 代码围栏

### 用途

展示代码或命令输出。两处共用 `session/codeSurface.ts` 的内边距（14 / 12）与字号（`--text-code` / `--leading-code`）：

| | `CodeBlock` | 围栏 `.md-code` |
|---|---|---|
| 位置 | `app/session/Timeline.tsx:363` | `app/session/Markdown.tsx:228` |
| 用于 | 工具输出、命令结果 | Agent 回答里的代码围栏 |
| 外观 | `bg-subtle`、`rounded-lg`，无头部 | `bg-subtle`、`rounded-lg`、头部 32 高 `bg-muted` |
| 操作 | 右上角复制（悬停出现，触屏常显）；过长输出省略中段并可展开 | 头部：语言名、预览（markdown / mermaid / html）、自动换行、复制 |
| 高亮 | 无 | refractor，按需加载 |

### 状态

围栏的换行与预览开关按「围栏在转录里的位置」记忆，行被窗口化卸载后保留（`rememberedState`）；`CodeBlock` 的展开状态同理，用 `remember` 命名。

### 键盘与无障碍

复制按钮 `aria-label="复制"`；围栏的开关用 `aria-pressed`；触屏上头部与按钮升到 44。

### 现状

- `CodeBlock` 与围栏仍是两个组件（头部有无、复制按钮位置不同），只共享尺寸；`CopyButton` 已移到 `components/ui/copy-button.tsx`。
- `DiffView`（`Timeline.tsx:401`）是第三种代码表面（`bg-subtle`、头部最小 32、`--diff-*` 颜色）。

## 标记（Token 式 chip）

### 现状

没有 `Chip` / `Token` 组件。输入框里的「将调用」标记（`/技能`、`/命令`）是手写的 `<span>`：`rounded-md bg-accent/10 text-xs text-accent`，`min-h-6`（触屏 44），带移除按钮（`app/session/Composer.tsx:1534`）。它是应用里唯一用 `accent/10` 做底的标记，与 `Badge accent` 的 `accent-soft` 是两种写法。其他类似物：`DropdownMenu` 里的当前值文字、Markdown 的 `.md-file-mention`（`Markdown.tsx:367`）。建议：出现第二处需求时抽成 `Chip`（可移除），底色取 `Badge accent` 的 `accent-soft`。
