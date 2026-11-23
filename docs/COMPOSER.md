# Riffet 输入框体验契约

本文是 web 输入框（`apps/web/src/app/session/Composer.tsx`）的体验契约，回答三件事：**什么手势发送、什么手势换行**（§3）、**全屏编辑怎么开怎么退**（§4）、**图片附件的取、看、删**（§5）。技术落点与可验收项在 §7、§8。

**边界**：本文只管输入框本身。传输、排队投递、附件在服务端的落盘与注入 Agent 的协议不在本文范围（那些已在 `docs/guide/conversation.md` 的排队与附件段落描述）。设置页按使用偏好、工作环境、服务与支持分类，本文涉及账号级的 Enter 行为（§3.2），落在现有「设置 → 交互与输入」组里（`apps/web/src/app/settings/PreferencesSections.tsx` 的「Enter 键」行）。

状态：**P1 / P2 / P3 已全部落地**（2026-10-09）。§9 四项全部定案；三期的落点、与本文原方案的差异见 §10.1–§10.3。

---

## 1. 判据

沿用 `docs/WEB.md`§1 的判据，不另起一套：**键盘可达**（桌面端高频操作不依赖鼠标）、**位置不丢**（改手势不能让正在写的草稿、光标、引用丢失）、**变化可感知、不喧哗**、**不把估算说成事实**。

在此基础上给输入框加一条：**一次消息的编辑成本要和它的长度匹配**。三行以内的补充消息不该被拖进面板，一整段提示词也不该挤在 240px 高的滚动框里写。

## 2. 现状与问题

下表是契约评审时的现状，问题已按 §10.1 全部落地。「位置」一列只给符号、不给 `Composer.tsx` 的行号：P2/P3 落地后这个文件的行号整体移动过。

| 现状 | 位置 | 问题 |
| --- | --- | --- |
| 桌面 Enter 发送、Shift+Enter 换行、⌘/Ctrl+Enter 也发送；手机 Return 换行、⌘/Ctrl+Enter 发送 | `Composer.tsx` 的 `onKeyDown` | 桌面写多段消息必须先按 Shift，写计划、写复现步骤时每个换行都是一次修饰键决策 |
| 输入框高度上限 240px（hero 320px） | `Composer.tsx` 的草稿高度上限 | 长草稿变成小窗口里滚动，看不到全貌、改不动结构 |
| 附件只显示文件名胶囊，图片不显示缩略图 | `Composer.tsx` 的附件行、`ImageViewer.tsx:31` | 发送前无法确认截的是哪一屏；已有的 `ImageViewer`（`ImageViewer.tsx:31`）只用在已发送消息上 |
| 粘贴时若剪贴板同时有文件和文本，只取文件、丢掉文本 | `Composer.tsx` 的 `onPaste` | 从网页或飞书复制图文混排内容，文字静默丢失 |
| 拖放只在输入卡片范围内生效 | `Composer.tsx` 卡片上的 `onDrop` | 拖到转录大区域时被浏览器默认行为接走（打开图片） |

## 3. 发送手势

### 3.1 手势解析（单一真源）

所有发送手势由 `apps/web/src/app/session/composerKeyboard.ts` 的 `classifyEnterGesture()` / `resolveEnter(event, behavior)` 判定（落地名与签名见 §10.1 的 P1 表）。手势定义沿用 DSH 的命名（`reference deepseek-harness` 的 `input/editor/keymap.ts`）：

| 手势 | 事件特征 | 结果 |
| --- | --- | --- |
| `plainEnter` | Enter，无任何修饰键 | 按偏好：`sendOnEnter` 时发送；`newline` 时换行 |
| `modifiedEnter` | Enter + 恰好 Cmd 或恰好 Ctrl | **总是**发送，与偏好无关 |
| `shiftEnter` | Enter + Shift | 换行 |
| `accelerated` | Enter + Ctrl+Cmd、Shift+Cmd、Shift+Ctrl、Alt | 原样交给系统或应用快捷键，不消费（与 DSH 一致） |

按键事件必须给出手势签名（`altKey`/`ctrlKey`/`metaKey`/`shiftKey`），而不是只给 `event.key`——IME 在组合期间给出的 `Enter` 与真按 Enter 在 `key` 上无法区分，只能靠 `isComposing`/`keyCode === 229` 加时间窗拦下来。DSH 的窗口是「组合期间 + compositionend 之后 10ms」，因为 Safari 的收尾 keydown 落在 `compositionend` 之后（`input/editor/keymap.ts:44-101`）；组合期间的那个 Enter 只 `return true` 拦住默认行为，**不** `preventDefault`（浏览器自己要拿它选词）。现有代码已经是这个结构（`Composer.tsx` 的 `onKeyDown` 先判 IME，再判手势），本文只把判定挪进纯函数。

两个容易漏的守卫，一并写进纯函数：

- **长按不连发**：`event.repeat === true` 的 Enter 只消费、不产生第二次发送（DSH：`keymap.ts:154` 的注释「held-down Enter must not machine-gun sends」）。
- **提交去重**：`submit()` 现有的 `submittingRef` 已经挡住并发（`Composer.tsx`），纯函数只负责手势，不重复实现去重。

### 3.2 偏好：「Enter 键做什么」

新增**账号级**设置 `AppSettings.composerEnterBehavior`（`packages/contracts/src/index.ts:352-356`），随 `PATCH /api/settings` 持久化到服务端 `settings.json`，因此**换设备、换浏览器打开同一个工作台都生效**——这与「文字大小 / 会话间距」这类只影响这台设备的偏好（`lib/display-settings.ts:6-11`）是两种东西，界面上要把这个区别说清楚（见下）。

- `'send'`（**默认**）：Enter 发送、Shift+Enter 换行，⌘/Ctrl+Enter 同样发送。
- `'newline'`：Enter 换行、⌘/Ctrl+Enter 发送。
- **已定**（2026-11-22）：默认 Enter 发送，设置里可切换为 Enter 换行（切换后仍可用 ⌘/Ctrl+Enter 发送）。
- **全屏编辑不读这个设置**（2026-11-22）：全屏里 Enter 总是换行，⌘/Ctrl+Enter 发送，发送键提示 `⌘↵`（`Composer.tsx` 的 `keyBehavior`）。进入全屏就是要写长消息。

字段命名为 `composerEnterBehavior` 而不是 `enterBehavior`：`AppSettings` 是扁平的，服务端 `validateSettings` 对未知键是**抛错**的（`apps/server/src/settings/index.ts:684`），以后输入框还会有别的键，先给它一个命名空间，避免以后叫 `enterBehavior` 的第二个设置撞名。

要点：

1. **⌘/Ctrl+Enter 在两种模式下都发送**。否则切成 `'newline'` 之后，键盘用户唯一出路是靠 Shift+Enter 发送，等于把发送动作藏进一个从未表示过发送的修饰键。参照 DSH：`resolveSubmitMode` 把「Enter / 发送按钮」当成同一个手势，⌘/Ctrl+Enter 是它的加速版（`input/submission-policy.ts:36-38`；快捷键清单也是这么登记的三行——Enter 发送、Shift+Enter 换行、Ctrl/Meta+Enter 补充手势，`client/apply.ts:239-249`）。
2. **按钮与手势同源**：发送按钮走同一个 `resolveSendGesture(..., 'plainEnter', ...)` 的结果，所以「按钮做什么」和「Enter 做什么」永远一致；`running` 时的排队语义也随之统一（见 §3.4）。DSH 就是这么做的：`InputBar.tsx:307` 用 `'enter'` 手势算主提交模式，`:321` 让按钮走同一条路。
3. **手机端不动**。软键盘的 Return 不是 keydown，天然只换行；硬件回车在移动端继续按现状发送（`apps/mobile/.../composer/Composer.kt:369-381` 已是这个契约）。这个设置是账号级的，所以手机端读到的值是同一个，但手机端行为不因此改变——设置项的描述里要写明「只影响桌面端的物理键盘」。
4. **提示要说清当前手势**：发送按钮 tooltip 按当前模式显示 `Enter` 或 `⌘↵`（`Tip` 的 `kbd` 由 `primaryEnterHint(behavior)` 给出；P1 已落地，见 §10.1）。偏好改变时提示同步变化——不改行为却不改提示，比不改行为更糟。
5. **提示保持简洁**：不在输入框底部显示 Enter 行为说明；发送按钮 tooltip 与设置项负责说明当前手势。
6. **设置行的保存语义**：通知开关与 Enter 行为修改后立即 `PATCH`，分别位于 `PreferencesSections.tsx` 的 `NotificationsSection` 与 `InteractionSection`。提供商与编辑器保留明确的保存按钮，未保存时离开会确认。

### 3.3 Escape 的分层

Esc 只做一件事：**关掉当前最内层的浮层**。顺序固定为 菜单（slash/@，`Composer.tsx` 的 `onKeyDown` 里的 `resolveEscapeLayer({ menuOpen, fullscreen: false })`）→ 全屏编辑（§4）。两层都关着时 Esc 不做事，不抢浏览器默认行为。判定同样进纯函数（`resolveEscapeLayer({ menuOpen, fullscreen })`），避免以后每加一个浮层就在 `onKeyDown` 里加一段 if。

落地时这条分层有两个持有者：`Composer.tsx` 只关自己的 slash/@ 菜单；全屏面板的 Escape 由 `ComposerFullscreen` 在 window capture 阶段处理并 `preventDefault`，且在面板里有 listbox、或上面压着 Radix `z-[70]` 浮层（模型菜单、图片预览）时让位（§10.1 P3）。

### 3.4 忙碌时的手势

发送按钮、Enter 和 ⌘/Ctrl+Enter 都走会话的同一个提交入口，按已有设置排队或引导当前任务。

工具栏右侧只有一个固定尺寸的操作位：有草稿时显示发送；任务或后台 Agent 运行且草稿为空时显示停止。2026-10-27 移除编辑时并列的小停止按钮和「立即发送」，同时移除草稿打断并发送的前端回调与命令。停止和发送的切换不改变操作位尺寸，不播放尺寸或入场动画。有草稿时可从已有操作菜单停止任务或明确加入队列。

2026-11-05：发送与异常恢复遵循持久 Outbox 方案。消息异常只在对应消息显示；可靠保存到持久 Outbox 后移走已提交草稿，修订号保护后续编辑。浏览器中的保存不跨设备，也不能抵抗浏览器清理数据。

## 4. 全屏编辑

### 4.0 先说清楚：这是新增能力，不是照搬

DSH **没有**全屏或放大输入框。搜遍它的 composer 包与 `apps/`（`fullscreen|expand|maximize|modal|dialog|sheet|drawer|enlarge|zoom`），命中的只有桌面窗口边框、dockkit 面板和工具输出行的展开——没有一条是输入框。它对这个问题的答案是**上限 + 内部滚动**：唯一的滚动口是草稿的 `.scroll`，上限 `--dsh-composer-text-max-height: 336px`，来源写在 token 旁边——「figma Input 75:8208 max 14 lines × 24px line」（`ConversationRoot.module.css:350-358`、`InputBar.module.css:120-135`）。

所以本节要**独立设计**，只借 DSH 的一条原则和两条细节：

- 原则：编辑面只应该有一个常驻宿主，状态切换不换节点（§4.3）；
- 细节 1：**没有全屏时，上限也要存在且明确**（DSH 是 14 行）；
- 细节 2：长草稿滚到底后，滚轮继续滚要交给转录，不能让输入框吃掉手势（DSH 的 wheel chaining，`input/editor/view-binding.ts:65-79`）。Riffet 现在没有这一步，做完全屏顺手补上：文本域滚到顶/底时把剩余 delta 转给转录滚动容器。

### 4.1 形态

**同一张输入卡片铺满视口**，不是另开一个编辑器、不是把草稿复制到别处：

- 进入：卡片铺满视口（`fixed inset-0` 的效果），铺一层 `bg-black/25` 遮罩，面板居中、宽度上限 920px（与转录列宽一致），高度 `min(80vh, 720px)`（实现另有 360px 下限与视口夹取，见 §10.1 P3 的 `fullscreenPanel()`），下面留出安全区；
- 布局：附件轨（§5）在最上，文本域占满剩余高度并在内部滚动，工具栏（模式 / 模型 / 权限 / 上下文环 / 发送）固定在面板底部，dock 卡片（目标、待办、队列，`ComposerDock.tsx`）与卡片一起进面板、显示在页眉之下、卡片之上；
- 退出：关闭按钮、Esc（§3.3）。

**不做的事**：不换组件、不复制草稿状态、不与转录抢编辑权。全屏只改三类东西——`textarea` 的高度上限、外层容器的定位与尺寸、多出来的一行全屏页眉。

### 4.2 触发器

**只做按钮，不做快捷键**（已定，2026-10-09）：

- 会话页和新会话页都提供。桌面端输入非空文字后显示（会话页在权限按钮右侧，新会话页在发送键左边）无边框的四角展开图标（手机端暂不提供入口），`aria-pressed` + `aria-label`（「全屏编辑 / 退出全屏」，落地时用 `aria-pressed` 而不是 `aria-expanded`：它报告的是自己切换的模式），进入后按钮换成收起图标（`IconMaximize` / `IconMinimize`）；焦点在进入时给文本域，退出时还给这个按钮。
- 退出还有 Esc（§3.3）。
- **不加 `⌘⇧E` 之类的全局键**。理由：DSH 没有全屏编辑，也就没有可参照的键位；而全屏是一个「看得见的状态切换」，按钮 + Esc 已经够用，新增一个没有先例的组合键只会多一个要记、要在快捷键帮助里解释、还要防冲突的东西。以后若真有用户要，再按 DSH 的做法把它登记进快捷键清单（`apply.ts:239-249` 那种登记方式），而不是先埋一个。

### 4.3 为什么用 portal，而不是就地 `position: fixed`

就地 fixed 会被祖先的 `overflow-hidden` / `transform` 裁切或劫持（转录滚动容器、终端面板都有这类盒子）。做法是把卡片**整棵子树**经 `createPortal` 挂到 `document.body`：React 的 portal 只把 DOM 节点搬到别处，同一个 React 元素树保留，`<textarea>` 的 DOM 节点不重建，因此焦点、光标位置、选区、`scrollTop` 全部保持。这是 DSH 教出来的同一条经验：编辑面只应该有一个常驻宿主，状态切换不换节点（`input/editor/ComposerContentEditable.tsx` 的「resident div」注释）。

配套：

- **与原方案的差异**：原方案写的是「卡片 `fixed inset-0`」＋「整棵子树 `createPortal` 到 `<body>`」；实现改成**常驻宿主节点、只移动它的父节点**——`ComposerFullscreen` 自己创建一个 `display: contents` 的宿主 `div`，portal 只渲染一次，进出全屏只把宿主的父节点在「锚点旁边」与 `<body>` 之间搬。原因是 `open ? portal(children) : children`（或换 portal 容器）会让 React 重建这棵子树，焦点、光标、选区、`scrollTop` 全丢；宿主不是 React 的节点，它移动时 React 的引用不会失效（长注释在 `ComposerFullscreen.tsx` 顶部）。关闭时组件添加的节点全是 `display: contents` / `hidden`，会话列布局与没有这个组件时一致。
- 进入时记录焦点来源，退出后把焦点还给那个按钮；
- 背景加 `inert` + `aria-hidden="true"`（挂在输入框所在的会话主列上，由 `NativeSession.tsx` 施加），既挡住 Tab 走神，也避免读屏读到两份内容；不做焦点陷阱（仍需用鼠标滚读转录）；
- 锁定 `body` 滚动，退出时恢复；`visualViewport` 变化由现有 `--app-height` 机制覆盖（`styles/index.css:576-608`）；
- 层级：面板 `z-[60]`，低于弹窗 `z-[70]`（`components/ui/dialog.tsx` 的 `DialogContent` overlay）——所以全屏下打开图片预览、模型菜单时，它们盖在上面，符合「后开者在上」；
- 高度：全屏卡片与文本域用 flex 占满面板剩余空间，附件、dock 和工具栏按实际高度参与布局；不再给整张卡片扣除固定 200px 的预留。内部滚动保持在文本域自身。

### 4.4 进入全屏后的可见变化

只多一行页眉（标题「编辑消息」+ 关闭按钮），不隐藏任何原有控件。全屏不是另一种编辑模式，所以不新增「自动保存 / 不保存」这类语义。

## 5. 附件

### 5.1 图片：缩略图 + 预览 + 删除

- **缩略图**：图片附件从「文件名胶囊」改为 64px 方形 `object-cover` 缩略图（`composerAttachmentIntake.ts` 的 `COMPOSER_IMAGE_TILE`），四角圆角、`border border-line`；文件名进 `title` 与 `aria-label`。整条轨道统一 64px 方块——已发送消息那条轨道有它自己的 `TILE`（72px，`MessageAttachments.tsx:10`），两个数字不是同一个。
- **点击预览**：直接复用 `ImageViewer`（`ImageViewer.tsx:31`），它就是为「不能新开标签页看 data:/本地图」写的应用内 lightbox（关闭按钮、下载、Esc、点击遮罩、`onCloseAutoFocus` 焦点归还都已实现）。**不新写查看器**。
- **删除**：缩略图右上角一个 ✕（≥44px 触达区，桌面 24px），`aria-label="移除 <文件名>"`；键盘用户 Tab 到 ✕ 后 Enter 删除，焦点按 §7.3 规则落到下一个缩略图或文本域。
- **上传中**：固定 64×64 的占位方块 + 转圈（`UploadingTile`），与缩略图同尺寸，图到了不跳版。
- **加载失败**：同一个槽位换成重试按钮（`ImageTile` 的 `failed` 分支），点击重新拉取原图；同时报一次「图片无法加载：<文件名>」，不留一个沉默的灰方块。
- **比例**：全部统一方形裁切，只有一张图也走 64px 方块。原方案想对单图沿用 `MessageAttachments.imageBox('single')` 的自然比例，实现没有跟这条（§10.1 P2 差异 2）。
- 非图片附件仍是胶囊：图标 + 文件名 + 体积（`size` 字段一直在 `Attachment` 里，`packages/contracts/src/index.ts:339`），删除按钮同规格。

### 5.2 添加附件：三条入口

1. **选择**：现有 ➕ 打开普通文件选择器，不设置格式白名单；ZIP、CSV、Office 文档及未知格式都可添加。
2. **粘贴**：`onPaste` 文本与文件都收——有文件就上传文件，有文本就把文本按当前光标插进草稿，两者都做（修掉旧的丢文本问题）。落地细节：会被 `validateIntake` 拒绝的粘贴**不** `preventDefault`，文件不会成为附件，但剪贴板里的文字照常落进草稿——拒绝一项不该连另一项一起吞掉。
3. **拖放**：拖放范围从卡片扩到**整个窗口**（`windowDragDepth` 计数 + `dragenter/over/leave/drop/dragend` 监听），进入时显示一个横跨窗口的虚线落区提示（`z-[65]`、`pointer-events-none`，不压暗底下的转录）；卡片内的落区高亮保留，且卡片自己的 `onDrop` 仍是权威——window 处理器用 `cardRef.contains(target)` 让位，同一批文件不会上传两次。拖入多文件时按顺序入队。

去重：同一批里 `name + size + lastModified` 相同即视为同一张（`dedupeKey()` / `newCandidates()`），跳过重复上传（避免「拖两次变成两张一样的图」）；已接受的附件把键按附件 id 记在 `Composer.tsx` 的 `attachmentKeysRef` 里，删除、发送成功或切换草稿时一并清掉。上传前同步预留文件名额和去重键，连续拖放也计入上限；成功项保留，失败项留在原位置重试或移除。是否再按内容哈希去重（读前 64 KiB 做 SHA-256）留给实现判断，不做硬要求——实现没做，理由写在 `newCandidates()` 的注释里。

### 5.3 上限与拒绝语义

服务端已定：单文件 24 MiB（`apps/server/src/workspace/index.ts`）、单条消息最多 20 个附件（`apps/server/src/app.ts`）。客户端把这两个数复制成 `MAX_ATTACHMENT_BYTES` / `MAX_ATTACHMENTS_PER_MESSAGE`（`composerAttachmentIntake.ts`），**同一批整批拒绝**并给出原因，绝不「收下一半、静默丢掉另一半」。所有普通文件都可以上传，扩展名映射只用于补全 MIME 元数据。浏览器没有提供 MIME、只提供 `application/octet-stream` 或提供无效类型时，按已知扩展名补全（例如 `.md`、`.png`、`.zip`），未知格式使用 `application/octet-stream`；明确的有效 MIME 不覆盖。普通文件保留原文件名，只有实际重编码的图片更新扩展名。先判数量，再按批次顺序判体积，第一条命中的文件决定文案：

- 「最多 20 个附件」（草稿里已有附件时是「最多 20 个附件，当前这条已有 N 个」）
- 「单个附件最大 24.0 MB：`<文件名>` 超了」

超出时要把「超了什么」说清楚——「上传失败」不是理由。

### 5.4 移动端

折叠态（`compact`）保持现在的「一个回形针 + N 个附件 + 展开」摘要行（摘要内容由 `ComposerAttachments` 的 `variant="summary"` 渲染，展开/收起按钮仍归 `Composer.tsx`）；展开后与桌面同构：图片一行缩略图、其它附件胶囊。桌面把「引用文件」与「附件」拆成两行（引用一行胶囊，附件一行缩略图），因为图片缩略图会把文件引用挤到换行，两行比一行混排更稳；两种形态由同一个 `ComposerAttachments` 渲染，手机展开行与桌面轨完全同构。

## 6. 借用清单（别人已经做对的部分）

| 来源 | 借什么 | 不借什么 |
| --- | --- | --- |
| DSH（`packages/client/ui-conversation/src/client/input/editor/keymap.ts`） | 手势优先级与 IME 守卫：⌘/Ctrl+Enter 是 Enter 的加速版、Shift+Enter 换行永远放行、Alt/组合修饰键交回系统、`repeat` 不连发、composition 关闭后 10ms 收尾窗 | Lexical + chip 节点的编辑器内核——Riffet 用 textarea + `sessionStorage` 草稿已经满足需求，换编辑器的收益不抵风险 |
| DSH（`skeleton/InputBar.module.css:120-135`、`ConversationRoot.module.css:357`） | 「草稿有一个行数上限的滚动口」这个模型：非全屏时的上限就该存在且明确（DSH 是 14 行 / 336px），全屏是同一模型换一个上限 | 336px 这个具体数字，Riffet 按自己的转录列宽定 |
| DSH（`input/submission-policy.ts`、`settings/EnterBehaviorRow.tsx`） | 发送策略是纯函数 + 一个偏好，UI 只读结果；忙碌时的行为要显式选，不靠猜 | 第二层「排队 vs 插话」偏好（理由见 §3.4） |
| DSH（`ui-attachment/src/client/ComposerAttachments.tsx`、`ui-primitives/src/ImageLightbox.tsx`） | 缩略图点击开原图、角标删除、上传中/失败态、整批校验后拒绝 | 它的 slot 扩展体系 |
| DSH（`ui-primitives/src/ImageLightbox.tsx` 顶部注释） | portal 到 body、Esc 关、焦点归还、`aria-modal` | —— |
| DSH（`input/editor/view-binding.ts:65-79`） | 草稿滚到边界后，滚轮余量交给转录，输入框不吃掉手势 | —— |
| DSH（`input/facade.ts:672-678`、`input/editor/runtime.ts:183-188`） | 两个撤销卫生习惯：发送成功后切断历史（Ctrl-Z 不能把已发出的文字复活）、粘贴自成一条历史边界 | 它的 Lexical history 实现；Riffet 的 textarea 只有浏览器原生撤销栈，能做的是「发送后清空」这条语义不变 |
| DSH（`input/editor/runtime.ts:71-86`、`InputBar.tsx:266-272`） | 工具栏按钮按下时不抢走输入框焦点（`mousedown` 上 `preventDefault`）——Riffet 已有等价物（`holdComposerFocus`），新增的全屏按钮与缩略图删除必须走同一条路 | —— |
| VS Code Chat（[Chat interaction controls](https://code.visualstudio.com/docs/chat/chat-overview)） | 输入框同时提供 Enter 与发送按钮，两者等价 | 请求进行中并列的多种提交操作；Riffet 输入区使用一个固定操作位 |
| Cursor（[Plan Mode](https://cursor.com/docs/agent/plan-mode)）/ VS Code | Enter 发送是编辑器内聊天的默认，所以改默认值要显式告知，不能静默 | —— |

## 7. 技术方案

### 7.1 改动清单

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/app/session/composerKeyboard.ts` + `.test.ts` | **新增**：`classifyEnterGesture()`、`resolveEnter()`、`readEnterKeyBehavior()`、`isComposingKey()`、`resolveEscapeLayer()`、`primaryEnterHint()`。纯函数，无 DOM、无 React（照 `image-upload.ts`、`streamResume.ts` 的既有分工：逻辑进 `.ts` 并被 `.test.ts` 覆盖）。 |
| `packages/contracts/src/index.ts` | `AppSettings` 新增 `composerEnterBehavior?: 'newline' \| 'send'`。 |
| `apps/server/src/settings/index.ts` | `validateSettings` 的 `known` 集合加键，并校验取值只能是这两个字面量（`:684`；未知键是抛错的，所以必须显式登记）。 |
| `apps/web/src/app/settings/PreferencesSections.tsx` | 「外观」组加一行 `Row` + `Segmented`（Enter 换行 / Enter 发送），描述里写明「所有设备都生效，只影响桌面端的物理键盘」；保存走既有的即时 `PATCH`（`persistNotifications` 同款，落地为 `persistEnterBehavior`）。 |
| `apps/web/src/app/Workbench.tsx` | 把 `settings.composerEnterBehavior` 传进会话页与首页；`setSettings` 已经会合并回写（`Workbench.tsx:565-577`），不用另加通路。 |
| `apps/web/src/app/session/composerAttachmentIntake.ts` + `.test.ts` | **新增**：附件模型（图片/文件的判别、去重键、上限校验、拒绝文案、缩略图尺寸、删除后的焦点落点）。上限与服务端同数：`MAX_ATTACHMENTS_PER_MESSAGE = 20`、`MAX_ATTACHMENT_BYTES = 24 MiB`、`COMPOSER_IMAGE_TILE = 64`。 |
| `apps/web/src/app/session/ComposerAttachments.tsx` | **新增**：缩略图轨、文件胶囊、上传中占位、失败重试、`ImageViewer` 接线；引用与附件由它一起渲染（`variant="rail"` / `"summary"`）。原先在 `Composer.tsx` 里的本地 `Chip` 随 P2 删除，那份标记复制进了这个组件（§10.1 P2 差异 1）。 |
| `apps/web/src/app/session/composerFullscreenGeometry.ts` + `.test.ts` | **新增**：`fullscreenPanel()`、`fullscreenTextLimit()`、`shouldForwardWheel()` 三个几何/手势纯函数（§10.1 P3）。 |
| `apps/web/src/app/session/ComposerFullscreen.tsx` | **新增**：常驻宿主 + 移动父节点的 portal、面板页眉与 scrim、`body` 滚动锁定、面板自己的 Escape 分层（§4.3、§10.1 P3）。 |
| `apps/web/src/app/session/Composer.tsx` | 键盘判定改调纯函数（`classifyEnterGesture` / `resolveEnter`）；`onPaste` 文本 + 文件；全屏受控对与 flex 高度分配；textarea 上的非被动 `wheel` 监听；附件区换成新组件；`ingestFiles()` 统一四个取件入口；拖放扩到窗口（`windowDragDepth`）；发送按钮的 `kbd` 与 tooltip 跟随设置。 |
| `apps/web/src/app/terminal/NativeSession.tsx` | 持有全屏状态（`composerFullscreen` + `setComposerFullscreen`）并把它作为受控对传给 `Composer`；全屏时给会话主列加 `inert` + `aria-hidden`。 |
| `apps/web/src/app/ProjectHome.tsx` | 只传 `enterBehavior`；首页 hero 输入框不传全屏对，因此没有全屏按钮。 |
| `apps/web/src/app/session/TranscriptView.tsx`、`apps/web/src/components/icons.tsx` | 转录滚动由会话内协调器持有，Composer 通过宿主委托滚轮余量；新增 `IconMaximize` / `IconMinimize`。 |
| `README.md`、`docs/WEB.md` | 记录新契约：Enter 手势、全屏编辑、附件预览；`WEB.md`§7 的决策记录追加「默认换行、账号级设置、不做全屏快捷键」三条，并把三期的落地状态写进去。 |
| `apps/mobile/.../composer/Composer.kt` | **不改**。§5.4 的折叠态在移动端已经等价；手机端不消费 `composerEnterBehavior`，文档与设置描述都写明「只影响桌面端物理键盘」。 |

### 7.2 关键实现点

1. **一个 DOM 节点**：全屏进出只切 portal 的挂载目标与类名，`<textarea>` 不重建（§4.3）。实现后必须验证：进入/退出全屏后 `document.activeElement` 仍是那个 textarea、`selectionStart` 不变、`scrollTop` 不变。
2. **状态单一持有者**：`fullscreen` 由会话页 `NativeSession` 持有，以受控对（`fullscreen` + `onFullscreenChange`）传给 `Composer`——因为全屏同时要改会话列的 `inert`，一个持有者比两处同步稳；`Composer` 内部那份 `fullscreenOpen` 只在宿主不传受控值时兜底（首页 hero 两个都不传，所以没有全屏按钮）。`enterBehavior` 由 `AppSettings` 经 `Workbench` 传下来（服务端是真源，组件不自己存影子状态）；`ComposerAttachments` 是受控组件（附件数组与回调由 `Composer` 持有）。
3. **设置读不到不等于行为坏掉**：`composerEnterBehavior` 缺失或非法时按 `'newline'` 解释（服务端 `validateSettings` 已把非法值挡在写入前，客户端只需 `=== 'send' ? 'send' : 'newline'`）；bootstrap 还没回来时也不能让输入框变得不能发送——⌘/Ctrl+Enter 在两种模式下都发送，最坏情况只是「Enter 不发送」。
4. **不新增服务端接口**：附件上传、元数据、读取都已有（`lib/api.ts:316-318`）；设置走既有 `PATCH /api/settings`。旧 `settings.json` 缺这个键就是默认值，不需要迁移（`SettingsService.readSettings`，`apps/server/src/settings/index.ts:660-671`）。
4. **无障碍**：面板是 `role="dialog"` + `aria-modal="true"` + `aria-label="编辑消息"`，但**故意不做焦点陷阱**（§9-4：转录要保持可读）——取而代之的是背景 `inert` + `aria-hidden`，以及退出后焦点归还。触达区 ≥44px（沿用现有 `min-h-11` 约定）。
5. **动效**：沿用现有 `ease-out-soft` 与 `animate-in fade-in-0`，全屏面板只做淡入 + 轻微缩放，不做位移；`prefers-reduced-motion` 下立即到位（现有全局规则覆盖）。
6. **草稿**：仍走 `sessionStorage`（`Composer.tsx` 的 `storageKey` 与草稿读写），全屏不改键、不改保存时机。
7. **工具栏与缩略图的按下不抢焦点**：全屏按钮、删除角标都属于「卡片自己的 chrome」，必须走现有 `holdComposerFocus`（`Composer.tsx`、`lib/tap-focus.ts`）；面板自己新加的页眉与关闭按钮走 `ComposerFullscreen` 里的 `swallowPress`（`mousedown` 上 `preventDefault`）。在手机上点删除角标不该把键盘收掉（这是 `Composer.tsx` 注释里已经付过学费的那条）。
8. **滚轮边界传递**：文本域 `scrollTop` 到顶/底后，剩余滚轮增量转给转录滚动容器（§4.0 细节 2），非全屏与全屏一致。

### 7.3 删除附件后的焦点

删除一张缩略图后：焦点落到**后一个**缩略图，没有就落到**前一个**，都没有就回文本域。不做「焦点掉到 body」。

## 8. 验收

可在没有浏览器的情况下测的（`vitest`，`apps/**/*.test.ts`）：

| 用例 | 断言 |
| --- | --- |
| 手势 × 偏好 × 忙碌 | 12 组组合（3 手势 × 2 偏好 × 忙碌/空闲）的 `{ preventDefault, action }` 完全确定；⌘/Ctrl+Enter 在两种偏好下都发送 |
| 组合输入 | `isComposing` 与 `keyCode 229` 的 Enter 都不发送、不换行 |
| 加速键豁免 | Shift+Cmd、Ctrl+Cmd、Alt 组合原样返回，不消费 |
| 长按 | `repeat: true` 的 Enter 不产生第二次发送 |
| 空草稿 | 两种偏好下都不发送；按钮同源也不发送 |
| Esc 分层 | 菜单开着时先关菜单；菜单关着且全屏时退全屏；都不在时不消费 |
| 发送按钮提示 | `primaryEnterHint()` 在两种偏好下分别给出 `Enter` / `⌘↵`，与手势解析的结果一致 |
| 设置值兜底 | `'send'` 原样、`'newline'` 原样、`undefined`/其他字符串/损坏值都按 `'newline'` |
| 服务端校验 | `validateSettings` 拒绝非这两个取值的 `composerEnterBehavior`，并接受缺省 |
| 附件模型 | 20 个上限、24 MiB 上限、整批拒绝、去重键、图片/文件判别、拒绝文案逐条 |
| 取件计划 | `planIntake` 先判上限再去重（20 个里 19 个是旧的 → 拒绝，而不是「收下 1 个新的」）、重复项只算一次、全部重复返回空、下标与去重键随件返回 |
| 全屏几何 | 小视口夹到 360、宽视口夹到 920、面板不超过视口、文本上限恒正且小于面板高 |
| 滚轮边界 | 顶/底各自转发、1px 容差、还能滚时不转发、零增量不转发 |

必须有眼睛（或浏览器）才能验的，逐条列出，不写成「已验」：

1. 进入/退出全屏后焦点、光标、选区、滚动位置不丢（§7.2-1）。
2. 全屏下面板层级低于图片预览与模型菜单（`z-[60]` < `z-[70]`）。
3. 背景 `inert` 生效：Tab 走不进会话列；同时输入框通过会话的滚动句柄传递滚轮余量，转录仍能滚读。
4. 移动端 `visualViewport` 变化（软键盘弹出/收起）时面板高度与发送按钮仍可点。
5. 真实拖放（从 Finder 拖多张图到转录区域，落点提示层是 `z-[65]`，低于弹窗与图片预览）与从网页复制图文混排后粘贴。
6. IME 实机（中文输入法候选框回车选词不发消息）。
7. 正文长草稿在 1280×720 与 2560×1440 两个视口下的高度上限都合理。
8. 弱动效（`prefers-reduced-motion: reduce`）下无位移、状态仍可感知。
9. 全屏时待办/排队卡片很长的情况：卡片本身有 `max-h`，但面板内没有第二个滚动口，需要确认它不会把工具栏顶出面板。

## 9. 已定

**已定**（2026-10-09，产品确认）：

1. **默认 `'newline'`**：Enter 换行、⌘/Ctrl+Enter 发送；设置里给一个开关切回 Enter 发送（§3.2）。
2. **偏好是账号级**：存进 `AppSettings`（服务端 `settings.json`，随 `PATCH /api/settings`），换设备换浏览器都生效；设置行的描述必须写明这一点（§3.2、§7.1）。
3. **全屏不做快捷键**：只有按钮 + Esc；没有先例的组合键不埋（§4.2）。
4. **全屏时转录保留可见但要 `inert`**：正文不被隐藏（还能滚读、还能对照着改），但从 Tab 顺序和指针里移出——编辑面只剩眼前这一个。落地方式见 §10.1：`NativeSession` 拥有全屏状态，打开时给会话列加 `inert` + `aria-hidden`；滚读不受影响，因为输入框把草稿吃不下的滚轮增量通过会话滚动句柄交给转录协调器。

## 10. 落地分期

| 期 | 内容 | 可独立验收 | 状态 |
| --- | --- | --- | --- |
| P1 | 手势：`composerKeyboard.ts` + `AppSettings.composerEnterBehavior` + 服务端校验 + 设置行 + 按钮提示 + 一次性说明 + 测试 | 桌面 Enter/⌘↵ 行为可切换、跨设备生效、可解释、可测 | 已落地（§10.1，19 条测试） |
| P2 | 附件：`composerAttachmentIntake.ts` + 缩略图轨 + 预览 + 删除焦点 + 粘贴/拖放 + 上限拒绝 | 发图前能看清、能删、拖进整窗口都能收 | 已落地（§10.2，47 条测试） |
| P3 | 全屏：portal 面板 + Esc 分层 + 背景 `inert` + 高度上限 + 层级/动效 + 滚轮边界传递 | 长草稿能一屏写完，退出后一切不丢 | 已落地（§10.3，15 条测试） |

三期按此顺序落地（P1 与 P2 本可并行；P3 依赖 P1 的 Esc 分层与 P2 的附件轨组件）。P1 动了 `packages/contracts` 与服务端设置校验，其验收含「旧 `settings.json` 仍能读、新键缺失即默认」，已由 `apps/server/src/app.test.ts` 覆盖。

### 10.1 P1 已完成：手势与设置（2026-10-09）

| 落点 | 内容 |
| --- | --- |
| `apps/web/src/app/session/composerKeyboard.ts` | `classifyEnterGesture` / `resolveEnter` / `isComposingKey` / `readEnterKeyBehavior` / `resolveEscapeLayer` / `primaryEnterHint`，纯函数 |
| `packages/contracts/src/index.ts` | `AppSettings.composerEnterBehavior?: 'newline' \| 'send'` |
| `apps/server/src/settings/index.ts` | 显式登记键 + 只接受两个字面量（`:683`、`:730-735`） |
| `apps/server/src/app.test.ts` | 缺省不发明值、`PATCH` 写入、部分更新不丢键、非法值 400、落盘可读 |
| `apps/web/src/app/settings/PreferencesSections.tsx` | 「外观」组新增「Enter 键」行，即时保存，描述写明跨设备与「只管桌面物理键盘」 |
| `apps/web/src/app/session/Composer.tsx` | 键盘判定改调 `resolveEnter`；按钮 `kbd` 跟随 `primaryEnterHint`；一次性说明（`riffet.composer.enterNotice`，本机、可关） |
| `Workbench.tsx` → `NativeSession.tsx` / `ProjectHome.tsx` | 传入 `enterBehavior`；首页直接读 `settings.composerEnterBehavior` |

与本文原方案的差异，两条都要记住：

1. **手机端显式传 `'send'`**：`resolveEnter` 的第三个入参在移动端固定为 `'send'`。原因是这个设置是账号级的，笔记本和平板/手机常常登录同一个工作台；手机一直以来的行为是「物理回车发送」，不该因为桌面端拨了一个开关而改变。设置行的描述与本文 §3.2-3 都按这个写。
2. **换行不自己插**：`'newline'` 下 Enter 的动作是 `'pass'`（不 `preventDefault`），换行由 textarea 的浏览器默认行为完成——这样撤销栈、光标、IME 都是原生的，Composer 里不需要手写插入文本。只有「该发送却是空草稿」和 `repeat` 才消费按键。
3. **`isComposingKey` 取代了原计划的 `isComposingEvent`**：DSH 的 10ms 收尾窗是给 Lexical 的命令层用的（它的 keydown 早于 `compositionend` 的对账）；textarea 的 `onKeyDown` 只需要两个信号，多一个时间窗反而多一处时钟。等 P3 引入别的编辑面时再回来评估。

### 10.2 P2 已完成：附件（2026-10-09）

| 落点 | 内容 |
| --- | --- |
| `apps/web/src/app/session/composerAttachmentIntake.ts` | `validateIntake`（整批拒绝，理由点名文件）、`dedupeKey` / `newCandidates`、`planIntake`（先判上限、再去重，返回数据不做事）、`isImageAttachment`、`focusIndexAfterRemoval`、上限常量与服务端一致（20 个 / 24 MiB） |
| `apps/web/src/app/session/ComposerAttachments.tsx` | 受控组件：64px 缩略图（点开既有 `ImageViewer`）、非图片胶囊（图标+名+体积）、上传中占位、加载失败原地重试、引用胶囊；`summary` 变体供手机折叠态 |
| `apps/web/src/app/session/Composer.tsx` | `ingestFiles` 成为唯一入口（选择 / 粘贴 / 卡片拖放 / 整窗口拖放）；`onPaste` 同时收文件与文本；整窗口拖放（`windowDragDepth` + 5 个监听，卡片内仍由卡片处理）；删除时同步丢掉去重键 |

与本文原方案的差异：

1. **一段 DOM 换一个纯函数**：原计划把「先判上限、再去重」写在组件里。落成 `planIntake` 后这条路径有了测试——而且测试立刻抓到一个真 bug：用「保留对象身份」去匹配重复项时，同一个 `File` 对象在同一批里出现两次会被当成两个不同文件，重复项照传。改成用下标匹配后修正。
2. **图片统一 64px 方形**：§5.1 里提过「只有一张时按自然比例」，实现选择统一方形——草稿轨是缩略图，不是消息里的成品展示，比例抖动反而更难扫。已发送消息那边仍按 `imageBox('single')` 保持原样。
3. **`onDropFiles` 是空实现**：组件不再挂任何 drop 监听，避免和卡片的拖放重复上传（入口只有一个）。

### 10.3 P3 已完成：全屏编辑（2026-10-09）

| 落点 | 内容 |
| --- | --- |
| `apps/web/src/app/session/composerFullscreenGeometry.ts` | `fullscreenPanel`（宽 ≤920、高 = clamp(0.8·视口, 360, 720, ≤视口)）、`fullscreenTextLimit`、`shouldForwardWheel` |
| `apps/web/src/app/session/ComposerFullscreen.tsx` | 常驻 portal 宿主（只移动宿主的 DOM 父节点）、遮罩、`--app-top/--app-height` 定位器、页眉与关闭、Esc 分层（面板内的 listbox 或 Radix `z-[70]` 层优先）、锁 `body` 滚动并还原 |
| `apps/web/src/app/session/Composer.tsx` | 工具栏切换按钮（`aria-pressed`，桌面端；宿主未提供受控对时不渲染）、卡片在面板内的上限、滚轮监听、进入时把光标还给草稿、退出时焦点还给按钮 |
| `apps/web/src/app/terminal/NativeSession.tsx` | 全屏状态的真源；打开时给会话列加 `inert` + `aria-hidden` |
| `apps/web/src/app/session/TranscriptView.tsx` | 经 `TranscriptScrollHandle` 向宿主提供滚轮余量委托；`data-transcript-scroll` 仅保留为滚动区标识 |
| `apps/web/src/components/icons.tsx` | `IconMaximize` / `IconMinimize` |

与本文原方案的差异：

1. **不是 `position: fixed`，是「宿主的父节点搬家」**：原计划靠 portal 保住节点身份，但 React 会重建「在元素树里位置变化」的子树，也会重建 `containerInfo` 变化的 portal——`open ? portal(children) : children` 恰好会重建 `<textarea>`。改成 portal 只渲染一次、宿主由组件自己持有，关闭时挂在隐藏 `<span>` 锚点旁（全局 `display: contents`，布局与从前一致），打开时把宿主 append 到 `body`。同一个节点，同一份光标与滚动位置。
2. **面板不是自己要 `fixed`**：它是一个 `--app-top/--app-height` 定位器的 flex 子项。居中用 flex 而不是 `translate`，既让 `prefers-reduced-motion` 的全局规则继续够用，也让手机软键盘弹出时面板跟着视觉视口缩。
3. **不做焦点陷阱**：§9-4 已定「转录可见」，所以 Tab 仍能走到面板外——面板只把背景设为 `inert`，不夺回焦点。

## 11. 参考

<!-- doc-paths:off -->
- DSH 源码（`deepseek-harness` checkout，版本 `0.2.1-alpha.1`，全部为只读查阅）：
  - `packages/client/ui-conversation/src/client/input/editor/keymap.ts` —— 手势优先级、IME 守卫、`repeat` 守卫、paste 路由
  - `packages/client/ui-conversation/src/client/input/submission-policy.ts`、`src/submission-settings.ts` —— 发送策略纯函数与偏好持久化（Host settings 文档，字段 `busyEnter`）
  - `packages/client/ui-conversation/src/client/settings/EnterBehaviorRow.tsx`、`src/client/locales.ts:73-76` —— 偏好行的形状与文案
  - `packages/client/ui-conversation/src/client/apply.ts:239-249`、`packages/client/ui-shortcuts/src/client/fixed.ts:13-15` —— 快捷键清单的登记方式（也是它唯一记录 Enter 语义的地方，文档里没有）
  - `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css:120-135`、`ConversationRoot.module.css:350-358` —— 草稿滚动口与 14 行 / 336px 上限
  - `packages/client/ui-conversation/src/client/input/editor/view-binding.ts:65-79` —— 滚轮到边界后交给转录
  - `packages/client/ui-attachment/src/client/ComposerAttachments.tsx`、`packages/client/ui-conversation/src/client/service.ts:74-97,309-330,441-466` —— 缩略图轨、浏览器附件注册表、尺寸探测、提交序列化
  - `packages/client/ui-primitives/src/ImageLightbox.tsx` —— portal lightbox、Esc、焦点归还
  - `packages/attachment/attachment-local/src/index.ts:34-42` —— 图片上限默认值（20 MiB / 20 张 / 200 MiB / 8192px）
  - **全屏编辑**：搜 `fullscreen|expand|maximize|modal|dialog|sheet|drawer|enlarge|zoom` 无输入框相关命中 —— DSH 没有这个能力，§4 是新增设计
<!-- doc-paths:on -->
- Riffet 内部：`docs/WEB.md`（体验契约与判据）、`docs/MOBILE.md`（移动端焦点与动效规则）。
- 外部产品：VS Code [Chat interaction controls](https://code.visualstudio.com/docs/chat/chat-overview)（Enter 与按钮等价、进行中的三种发送语义）、[Add context to chat](https://code.visualstudio.com/docs/chat/copilot-chat-context)（图片作为上下文、拖放）、Cursor [Plan Mode](https://cursor.com/docs/agent/plan-mode)（编辑器内聊天默认 Enter 发送）。


### 10.4 提交前修复（2026-10-09）

- `/`、`@` 菜单与编辑器共享 portal，全屏时放在面板内；Esc 先关闭菜单，再退出全屏，关闭菜单后相同选区的 `select` 事件不会立刻把它重新打开。
- 切换到手机宽度会同步关闭父组件的全屏状态，恢复对话交互；附件折叠时隐藏轨道，展开时只挂载一份。
- 附件去重随草稿清理，上传期间同步预留数量与键；成功项保留，失败项提供重试或移除，未处理的失败项阻止发送。
- 图文粘贴交给浏览器插入文字，保留光标、选区和撤销行为，文件独立走统一上传入口。
- 验证包含浏览器实测：发送后重传、失败重试、连续拖放去重与数量上限、空 MIME、全屏菜单点击与 Esc、缩窄窗口恢复交互、手机附件展开，以及真实剪贴板的图文粘贴。


### 10.5 体验调整（2026-10-09）

移除输入框底部的 Enter 说明及其本地关闭状态；展开入口改为无圆形边框的四角图标，输入文字后出现在模式选择右侧。全屏内即使清空文字也保留退出入口。手机端位置待定，继续不显示。


### 10.6 工具栏图标规格（2026-10-09）

附件、权限与展开统一使用无边框按钮，桌面点击区域 28px、间距 4px、圆角 6px，悬停与键盘焦点样式一致。权限与展开图标均为 16px；加号因图形占画布比例较小，使用 18px 做视觉补偿。描边沿用 Web：任何尺寸下都是 1.25 像素，发送按钮保留强调样式。
