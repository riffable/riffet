---
module: server.adapters
verify:
  - npx vitest run apps/server/src/adapters
---

## 职责

核心驱动用来读 CLI 终端屏幕的标记与读取函数，目前只有 Claude Code。

## 入口

- `cli/registry.ts#getScreenMarkers`：按 CLI id 取就绪与忙碌的正则，只有协议之外要看屏幕的 CLI 才登记。
- `cli/claude-code.ts#claudeComposerVisible`：输入框是否画出。
- `cli/claude-code.ts#claudeComposerHoldsPrompt`：输入框里是否已有要发送的文本。

## 不变量

- 屏幕只用来交叉校验，不决定回合状态，且未命中忙碌规则时默认保守（不据此跳过控制动作或伪造空闲）：Claude 在回合中输入框仍然画着并可输入，状态来自转写与 hook（`cli/claude-code.ts#CLAUDE_CODE_READY_PATTERN`）。
- 输入框以顶部的横线为准，不以 `❯` 为准：空输入框里有灰色的建议文字，与已输入的文本无法区分（`cli/claude-code.ts#claudeComposerBounds`）。
- 忙碌检测由 `cli/claude-code.ts#claudeScreenBusy` 负责：兼容老版本的中断提示（`CLAUDE_CODE_BUSY_PATTERN`），并在 2.1.302/2.1.322+ 上识别输入框上方的实时 spinner 行（`[·✢✳✶✻✽] …`）、工具运行态（`Running…`/`Waiting…`/`Initializing…`）以及尚未出现 `✻ … for …`/`Interrupted` 结束行的流式 `⏺` 块；不匹配散落文本里的「thinking」「working」。
- `cli/claude-code.ts` 中所有依赖 TUI 版面的判断与解析函数，新增或修改时都必须在 `apps/server/src/backends/claude/screen-fixtures.test.ts` 对每版真实录屏校验，不以单元测试里的手写假屏幕代替。
- 粘贴的长文本在输入框里显示为占位符，比较输入框内容时要先处理它（`cli/claude-code.ts#CLAUDE_CODE_PASTE_PLACEHOLDER_PATTERN`）。
- 宽字符按单元格宽度计算，不按字符数（`cli/claude-code.ts#cellWidth`）。

## 外部行为

- 读取的是 Claude Code 的 TUI 屏幕：输入框、页脚 agent 列表与任务入口、Background 任务列表。录制在 `apps/server/src/backends/claude/fixtures/screens/<版本>/`，由 `apps/server/src/backends/claude/screen-fixtures.test.ts` 回放；本目录的 `cli/claude-code.test.ts` 只测函数。
- CLI 升级后的验证步骤在 `cli/claude-code.ts` 顶部注释，提高 `apps/server/src/backends/claude/launch.ts#CLAUDE_CLI_VERSIONS` 的 `testedThrough`。

## 排障

- 发送一直不确认、认为输入框没出现：用 `scripts/probe-claude-e2e.ts --capture` 抓当前版本的屏幕，对照 `claudeComposerBounds` 的规则；日志见 `riffet logs --scope claude`。
- 新版 CLI 后 agent 列表或任务入口读不到：`npx vitest run apps/server/src/backends/claude/screen-fixtures.test.ts`，先补新版本的录制，再改这里的正则。
