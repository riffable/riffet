---
module: server.workspace
verify:
  - npx vitest run apps/server/src/workspace
---

## 职责

项目目录里的文件操作：列目录、预览、搜索、下载、编辑与增删改名、附件、代码跳转和系统目录选择器，全部限定在项目范围内。行为说明见 `docs/guide/workspace.md`。

## 入口

- `index.ts#WorkspaceService`：对外的全部文件操作。
- `scope.ts#resolveReadablePath`：路径解析与读取边界的唯一入口。
- `write.ts#FileWrites`：保存、新建、移动、删除与撤销；`write.ts#resolveWritablePath` 是写入边界的唯一入口。
- `file-index.ts#FileIndex`：文件名搜索的路径清单，来自 git 或 ripgrep。
- `code-nav.ts#CodeNav`：基于搜索的定义与引用，不用编译器。
- `download.ts#zipStream`：文件夹打包。

## 不变量

- 所有读取先过 `scope.ts#resolveReadablePath`，它做符号链接解析、项目范围检查和凭证路径拒绝。不要在 `index.ts` 里直接 `readFile` 用户给的路径。
- 所有写入先过 `write.ts#resolveWritablePath`：只在项目内，拒绝项目目录本身、任何 `.git` 路径段、状态目录与凭证目录；不要在别处对用户给的路径 `writeFile` / `rename` / `rm`。
- 保存必须比对 `expectedHash` 与磁盘当前内容的 sha256，并在同一把按文件的锁里写入（`write.ts#FileWrites.save`）；`FilePreview.editable` 的条件要和 `save` 接受的一致，否则界面给了编辑入口却存不进去。
- 写入后调用 `noteWrite`（接到 `apps/server/src/backends/shared/workspace-observer.ts#noteEdit`），否则同时在跑的 shell 命令会把用户的修改算进自己的产出。
- 项目外的绝对路径只在 `allowOutsideRead` 打开时放行，且只能是已存在的常规文件，没有列目录和搜索（`scope.ts#resolveExternalFile`）；凭证目录与文件无论开关都拒绝，包括经符号链接指向它们（`scope.ts#isSecretPath`）。
- `~/` 要在解析前展开成服务进程用户的家目录，预览图片与普通预览走同一个入口，否则同一个路径在两条路径上结果不同（`scope.ts#expandHomePath`）。
- 图片 MIME 由文件字节判断，不信扩展名（`index.ts#previewImageMimeType`）；读文件有字节上限，并在读完后再核对大小（`index.ts#readFileBounded`）。
- 附件的 base64 校验必须线性：正则按四字符一组匹配在几 MB 的数据上会溢出 V8 的正则栈，表现为 500；格式错误应报 400（`index.ts#WorkspaceService`）。
- 打包在 git 工作区里只含 git 会显示的文件，不在 git 中时跳过符号链接和 `node_modules` 等目录；超过上限要报错而不是给出不完整的包（`download.ts#gitArchiveEntries`）。
- 取消系统目录选择器靠退出状态和哨兵值判断，不解析本地化的 stderr，否则取消会被当成失败并回退到应用内浏览器（`index.ts#pickerCancelled`）。

## 外部行为

- 依赖 git（`ls-files`、`archive`）与 ripgrep（`file-index.ts#ripgrepSearch`）；两者都不可用时调用方自己遍历目录。已跟踪文件清单随 git index 的 mtime 重读，未跟踪文件按 `UNTRACKED_TTL_MS` 在后台刷新。
- 大仓库预算：列目录页大小、遍历条目与深度、归档 2 万文件与 2 GiB、定义搜索的时间预算，均为 `index.ts`、`download.ts`、`code-nav.ts` 顶部的常量。
- 音视频不读进内存也不受预览上限约束：预览页的播放器经只含这一个文件的 file-site 地址按字节范围取（`apps/server/src/routes/workspace.ts#sendFile`，单段 `Range`，多段按整文件回答）；AVPlayer 不支持范围请求的地址不播放。
- macOS 用 osascript 唤起 Finder 选择器，其他平台回退到内置浏览器（`index.ts#directoryPickerCommand`）。

## 排障

- 保存总是 409 `FILE_CHANGED`：客户端带的 `hash` 要来自整份文件的预览；有进程在持续改写这个文件（格式化工具、监听编译）时也会这样。

- 文件预览报 `PATH_DENIED` 或 `FILE_NOT_FOUND`：先看路径是否在项目外且 `allowOutsideRead` 关闭，再看是否命中凭证规则（`scope.ts#isSecretPath`）。
- 搜索结果缺文件：`file-index.ts#FileIndex` 的清单可能是 git index 变化前的，或未跟踪文件还没刷新（60 秒内）。
- 任务工作区不可用：`scope.ts#projectRoot` 会先检查任务工作区是否可用（`apps/server/src/task-workspaces/identity.ts#assertTaskWorkspaceAvailable`）。
- 下载的 ZIP 缺文件：对照 `git ls-files` 与 `.gitignore`，打包规则与「下载 ZIP」一致。
