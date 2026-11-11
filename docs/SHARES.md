# 会话分享

把会话冻结为只读静态包，交给发布插件放到可访问的地址。服务端负责历史读取、范围裁剪、主题冻结、资源打包和内容哈希；Web 与 macOS 共用同一份分享阅读页（`apps/web/src/share`）。

契约在 `packages/contracts/src/share.ts`，核心逻辑在 `apps/server/src/shares/`。

## 发布插件

没有发布插件时只能本地预览。发布插件通过 `@riffet/plugin-api` 的 `SharePublisher` 接入（见 [PLUGINS.md](PLUGINS.md)）：

| 方法 | 职责 |
|---|---|
| `capability(options?)` | 登录和平台是否可用；`fresh` 仅在用户主动刷新时传入 |
| `deploy(directory, alias, expiryDays, identity, override)` | 发布静态包，返回 `PublishedPreview` |
| `find(alias, identity)` | 按别名查找已发布的页面 |
| `remove(previewId, identity)` | 撤销 |
| `verify(alias, hash)` | 核对线上内容与本地包的哈希一致 |
| `publicUrl?(alias)` | 可选，同步纯函数，把已存回执投影为展示链接，不做 I/O |

包、别名与回执由核心持有，凭证留在发布插件内。`audience` 说明谁能打开页面，界面原样展示。

别名规则、失败码（`SharePublisherErrorCode`）和幂等恢复由 `ShareService` 统一处理。发布、撤销中断后进入 `uncertain`，通过核对和重试收敛，不自动重复发布。

## 快照与主题

- 快照协议 `riffet-share-v1`，模型与外观字段均为可选；旧分享缺字段仍可阅读，已发布的包需要“更新分享”才会升级。
- 模型信息只取实际回答对应的响应模型与参数，不从当前会话配置回填历史。
- 主题在生成草稿时冻结，发布接口只接收已生成的 `draftId` 与有效期。读者可在分享页切换主题和明暗，选择只存在本机的分享专用偏好里。

## 客户端状态

`GET /api/sessions/:id/share/status` 返回 `ShareStatus`：能力、已有分享、阻塞原因和可用动作（`preview`、`publish`、`remove`、`reconcile`、`retry`）。动作由服务端统一计算，客户端只叠加本地 busy 和预览是否就绪；写入接口仍会重新校验。
