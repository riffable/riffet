# 反馈

告诉用户发生了什么。按存续时间区分：`Tip` 随指针，`toast` 报告一次操作的结果并自动消失，`Notice` 随状态存在。选用规则在 [patterns.md](../patterns.md) 的反馈与加载一节。画面在 `/design/components/feedback`。

## Tip

### 用途

纯图标控件的名称与快捷键；截断文字的全文。实现 `components/ui/tooltip.tsx`（Radix Tooltip）。

### 变体与尺寸

`label`、`kbd`（字符串，如 `⌘K`）、`side`（默认 `bottom`，偏移 6）。表面：`bg-toast`、白字、`rounded-md`、`text-xs`，最宽 288；`kbd` 在 `bg-white/15` 的小块里。

### 状态

悬停或键盘聚焦时出现；`disabled` 或 `label` 为空时不挂载。只有带焦点环的聚焦才会打开（脚本移交的焦点不弹），触发元素离开视口时随之隐藏（`hideWhenDetached`）。

### 键盘与无障碍

提示不替代名称：图标按钮仍需 `aria-label`。Esc 关闭。触屏没有悬停，名称必须在别处可得。

### 文案

名词或动词短语，与按钮的 `aria-label` 相同；`kbd` 用平台符号。

### 不要

- 放必须阅读的信息、可交互内容。
- 用原生 `title=` 代替（见现状）。

### 现状

- `Tip` 约 120 处，原生 `title=` 约 150 处；`title` 在触屏与键盘上不出现，也没有快捷键位。
- 表面用 `bg-toast`（深色底白字），与 `toast`、`Notice` 的 `bg-elevated` / 色调底是两套画法。

## toast

### 用途

报告一次操作的结果（已复制、已删除、失败），自动消失。通过 `toast.success | info | error(message, { action, duration, details })` 调用（`lib/toast.ts:142`），由 `Toaster` 渲染在顶部居中（`components/ui/overlays.tsx:12`），最多同时 4 条，排队的不计时。

### 变体与尺寸

| `tone` | 图标 | 默认时长 | 角色 |
|---|---|---|---|
| `success` | `IconCircleCheck`，`text-success` | 2.8 秒 | `status` |
| `info` | `IconInfo`，`fg-3` | 3.5 秒 | `status` |
| `error` | `IconCircleAlert`，`text-danger` | 6.5 秒 | `alert` |

带 `action` 的至少 6 秒（`ACTION_DURATION_MS`）。表面 `bg-elevated`、`rounded-xl`、`shadow-pop`，最宽 480；正文最多两行，溢出或有 `details` 时出现「详情」，打开对话框看全文。

### 状态

指针悬停或键盘聚焦时暂停计时；视口外、页面隐藏时不计时；离场时行高折叠，下方的 toast 上滑。

### 键盘与无障碍

外层 `aria-live="polite"`；`error` 为 `role="alert"`。关闭按钮 `aria-label="关闭通知"`；操作按钮只执行一次并关闭。

### 文案

陈述结果（「已复制链接」「已丢弃 3 处改动」），不加感叹号；操作写动词（「撤销」）。

### 不要

- 承载必须处理的错误：用 `Notice`（持续存在）或对话框。
- 用 toast 报告用户看得见的状态变化。

## Notice

### 用途

持续存在的状态，留在内容里，随状态解除：降级的后端、未确认的发送、过期的历史。实现 `components/ui/notice.tsx`。

### 变体与尺寸

| `tone` | 底 | 默认图标 |
|---|---|---|
| `neutral` | `bg-subtle` | `IconInfo`，`fg-3` |
| `accent` | `accent/10` | `IconInfo` |
| `warning` | `warning/10` | `IconTriangleAlert` |
| `danger` | `danger/10` | `IconCircleAlert` |

`icon` 可替换，`null` 为不画图标；`action` 放在右侧，通常是 `Button size="xs"`。`rounded-xl`，内边距 14 × 10，`text-sm fg-2`，无边框无分隔线。

### 状态

无交互状态。`role` 默认 `status`，`danger` 为 `alert`。

### 键盘与无障碍

内部的操作按钮在 Tab 顺序里；整条不可聚焦。

### 文案

一句完整的话说明现状与影响（「Codex 本周额度剩余 8%」），需要处理的写在 `action` 上。

### 不要

- 用 `Notice` 报告一次性结果（用 `toast`）。
- 在同一处叠放多条：合并或用 `FeedbackNotices`。

### 现状

- `app/plugins/PluginFlowDialog.tsx:120` 的 `<p role="alert" class="text-danger">` 是授权流程整体失败的提示，不属于某个字段，保持手写；字段校验错误用 `Field` 的 `error`。

## FeedbackNotice

### 用途

来源会清空的 `Notice`：消息随来源出现，来源清空后保留一次退场动画，可标「已恢复」。`FeedbackNotices` 接一组消息，`FeedbackNotice` 接单条（`components/ui/feedback-notice.tsx`）。

### 变体与尺寸

继承 `Notice` 的 `tone`；`floating` 时画成带边框、`shadow-soft` 的悬浮条，正文三行截断并带「详情」；`recovered` 显示「已恢复」。

### 状态

出现与退场用 `Collapse` 折叠高度；指针悬停、聚焦或详情打开时不退场（`useFeedbackTimer`）。

### 键盘与无障碍

同 `Notice`；详情是带 `mobileSheet` 的对话框。

### 现状

- 只在输入框的草稿警告与会话内几处使用（`Composer.tsx:1546`）；`noticeClassName` 用 `bg-transparent! p-0!` 覆盖掉 `Notice` 的外观，等于把它当文字行用。

## Spinner

### 用途

进行中且时长不确定的状态；会话运行中（侧栏、标签栏、页头、任务看板）用强调色；行里有任务状态环时不另放，由状态环的外圈旋转表示（`StatusIcon` 的 `running`）。实现 `controls.tsx:103`：`IconLoaderCircle`，`size-3.5`，`animate-spin`，`fg-3`。

### 变体与尺寸

通过 `className` 改尺寸与颜色；在按钮、`StatusPill` 里用 `text-current`。减少动态时全局规则把旋转换成缓慢淡入淡出。

### 键盘与无障碍

`aria-hidden`；进行中的状态由所在控件说明（`aria-busy`、`StatusPill` 的 `busy`）。

### 不要

- 单独占位整页内容（没有 Skeleton，见下）；整页 loading 居中、无文字。

## EmptyState

### 用途

列表或页面没有内容。实现 `controls.tsx:269`，约 39 处使用。

### 变体与尺寸

`icon`（`size-10` 方块，`bg-muted`）、`title`（`text-base font-medium`）、`description`（`text-sm fg-3`，最宽 384）、`children`（下一步操作）。垂直内边距 40，居中。

### 文案

标题陈述现状（「没有设备」）；说明只写下一步或用户推断不出的信息；有下一步时放一个 `Button`。

### 不要

- 在加载中显示（先 Spinner）；
- 在出错时显示：用 `Notice` 加重试。

## Collapse

### 用途

高度动画的折叠区域，任意内容高度，不测量。实现 `components/ui/collapse.tsx`。

### 变体与尺寸

`open`；`keep` 折叠后保持挂载，内容 `hidden="until-found"`，页内查找仍可命中并通过 `onReveal` 通知拥有者；`still` 跳过动画；`id` 供 `aria-controls`。

### 状态

打开且静止时不裁剪，浮层与阴影可以伸出；动画期间裁剪。减少动态时只保留透明度过渡。

### 键盘与无障碍

自身没有语义；触发按钮自己设置 `aria-expanded` 与 `aria-controls`。

## Skeleton

### 用途

数据到达前占住最终尺寸的块，页面不在数据到达时跳动。`components/ui/skeleton.tsx`。统计页与服务状态页用它。

### 变体与尺寸

没有变体：尺寸与圆角全由 `className` 给（`h-[132px] rounded-2xl`），写成与真实内容同高，窄屏与宽屏各写各的高。底色 `bg-muted` 到 `bg-subtle` 的流光。

### 状态

流光 1.4 s 循环；`prefers-reduced-motion` 下静止为纯色块（`index.css` 的 `.ui-skeleton`）。

### 键盘与无障碍

`aria-hidden`，不进入读屏与焦点顺序；外层容器自己表达 `aria-busy`。

### 文案

没有文字。

### 不要

- 用在页面整页加载：沿用居中的 `Spinner`，不带文字。
- 用在按钮或行内的等待：用 `Spinner` 替换图标位。
- 数据高度不可预知时硬写一个高度：高度对不上就不要用骨架。

## Progress

### 用途

确定进度或有上限的量：一条横条加填充。`components/ui/progress.tsx`。用在插件页的 `meter`（下载、额度）、服务状态页的用量、会话信息的上下文长度。不知道总量的等待用 `Spinner`。

### 变体与尺寸

高 6（`h-1.5`），全圆角，底 `bg-muted`。填充按语气：`accent`（默认）、`neutral`（`fg-3`，只读的数字，如上下文用量）、`success`、`warning`、`danger`。行内的小条可以用 `className` 改高和宽（会话信息里是高 4、宽 64）。

### 状态

填充宽度变化用 `--duration-medium` 与 `--ease-out-soft` 过渡；减弱动效时由全局规则取消。

### 键盘与无障碍

不可聚焦。进行中的工作用 `role="progressbar"`，有上限的量用 `role="meter"`；都带 `aria-valuenow`（0–100）和 `aria-label`。

### 文案

条本身没有文字；数值写在旁边（「112 MB / 190 MB」「剩余 20%」）。

### 不要

- 用它表示不知道终点的等待。
- 在一条里叠多段颜色：分项用量画成图表。
