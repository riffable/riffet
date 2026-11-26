---
module: web.session
verify:
  - npx vitest run apps/web/src/app/session
co-change:
  - when: apps/web/src/components/ui/collapse.tsx#Collapse
    with: [TurnProcess.tsx#TurnProcess, readingAnchor.ts#readingAnchorTop]
    reason: Collapse 的 still 同步提交与 data-collapse-state 结构是过程块零位移收起和滚动锚定的前提
  - when: TurnProcess.tsx#TurnProcess
    with: [readingAnchor.ts#decideProcessFold, useTranscriptScroll.ts#useTranscriptScroll]
    reason: 过程块展开/收起时序与滚动所有权耦合，改一边要核对另一边的不变量
  - when: TranscriptView.tsx#TranscriptView
    with: [useTranscriptScroll.ts#useTranscriptScroll, readingAnchor.ts#readingAnchorTop]
    reason: 滚动容器属性、行布局与窗口化测高直接决定锚点能否保住阅读位置
---

## 职责

渲染单会话的时间线、过程折叠、阅读滚动锚定、输入框草稿与交互卡片。

## 入口

- `TranscriptView.tsx#TranscriptView`：时间线容器、虚拟窗口化、选区冻结与行渲染。
- `useTranscriptScroll.ts#useTranscriptScroll`：转录区唯一滚动所有者、跟底状态与披露切换期间的锚点保持。
- `readingAnchor.ts#readingAnchorTop`：阅读锚点捕获/恢复、跨文件 DOM 契约 `TRANSCRIPT_ATTR` 与过程折叠策略 `decideProcessFold`。
- `TurnProcess.tsx#TurnProcess`：回合过程组折叠与推迟收起调度。
- `useSessionSync.ts#useSessionSync`：接入同步引擎并向视图提供时间线、状态与大纲。
- `Composer.tsx#Composer`：输入框、草稿持久化、附件与提交意图。

## 不变量

- 滚动容器固定禁用浏览器原生锚定（`[overflow-anchor:none]`，`TranscriptView.tsx#TranscriptView`），`useTranscriptScroll.ts#useTranscriptScroll` 是唯一滚动所有者，不在非虚拟列表行上使用 `content-visibility: auto`。
- 自动收起过程块必须在 render 期同步算出状态并通过 `apps/web/src/components/ui/collapse.tsx#Collapse` 的 `still` 在同一 commit 落位，禁止拆到 `useEffect` 产生首帧跳动。
- `TurnProcess.tsx#TurnProcess`、锚定逻辑、`TurnRail.tsx` 与滚动容器共享 `readingAnchor.ts#TRANSCRIPT_ATTR` 与 `apps/web/src/components/ui/collapse.tsx#COLLAPSE_STATE_ATTR`，不各自手写 `data-*` 选择器；消息行统一挂在独立的 `[data-transcript-rows]` 容器内，与头尾 `FeedbackNotice`、`PageProbe` 和交互卡隔离。
- 禁止在转录区末尾用临时空白撑垫（spacer）保住旧 `scrollTop`：锚点上方的折叠会同步减小锚点目标与可滚底边（无需撑垫），锚点下方靠近末尾的折叠（如 `ToolRun` 自动收起或手动折叠）直接钳位到新底部，避免在末尾露出空白或阻断重新跟底。
- 读者离底阅读过程块下方或同屏正文时（`!following` 且过程块底边在视口底边上方），无论上方 `scrollTop` 余量多少都走 `readingAnchor.ts#decideProcessFold` 的 `defer` 推迟收起，待恢复跟底（`data-transcript-following="true"`）或滚离使过程块落到视口下方（`boxTop >= viewBottom`）后再释放收起。
- 过程块折叠触顶（目标值 < 0）时 `readingAnchor.ts#readingAnchorTop` 钳位到 `0`，不回退锚定到折叠中的过程块标题；流式草稿被正式行替换时凭 `data-row-slot` 保持锚点连续；`captureReadingAnchor` 二分查找跳过未参与布局的节点并在异常命中空结果时线性回退。
- 读者在转录区内选中文字时由 `TranscriptView.tsx#TranscriptView` 冻结 `rowTurns` 重分组，避免流式工具/状态把选中正文卸载。

## 外部行为

- 过程块默认在回合结束收起（用户可在 `viewPrefs.ts#setProcessFoldTiming` 切换为发送下一条时收起）；进行中的过程块标题只显示「处理中」不重复计时，回合计时统一由末尾 `WorkingIndicator` 承担；界面规则见 `docs/design/system/surfaces.md` §1.4 与 `docs/design/DECISIONS.md`。
- 同一回合内若某条 `final_answer` 之后还有非 `activity` / 非 `task_notification` / 非未收件 steer 的后续工作，`transcriptRows.ts#transcriptTurns` 将回合的 `held`/`shown` 页脚归属移交到后续工作末尾，避免 `WorkingIndicator` 夹在中间回复和尾部过程块之间。
- 新建会话的 Agent 菜单打开时重新读取目标服务器的 Agent 列表；即使没有候选项或当前模型目录读取失败，仍能打开并重新检测。
- 真实浏览器回放验证入口为 `scripts/replay-transcript.ts`（页面 `apps/web/src/replay/ReplayView.tsx`），可录制并检测非动画位移。

## 排障

- 回合结束正文上跳：先看 `readingAnchor.ts#decideProcessFold`、`TurnProcess.tsx#TurnProcess`（`deferredFold` / `instantFold`）与 `useTranscriptScroll.ts#useTranscriptScroll`（`data-transcript-following` 是否同步），再用 `pnpm replay:transcript` 复现；若仅在完整 `Workbench`（带顶栏且有 `empty:hidden` `FeedbackNotice` 子节点）出现，检查 `readingAnchor.ts#captureReadingAnchor` 对非布局节点的二分跳过是否破坏单调性。
- 切换草稿到正式回答时视口跳动：检查 `TranscriptView.tsx#TranscriptView` 的 `data-row-slot` 分配与 `readingAnchor.ts#readingAnchorTop` 的文本引用回退。
- 折叠某工具或过程块后底部露出空白或回弹：确认转录区末尾未被任何撑高节点占位，再检查 `useTranscriptScroll.ts#useTranscriptScroll` 的 `hold` 生命周期与 `Collapse` 结束收拢状态。
