# 会话标题规则

用户在设置里写规则，按目录、Agent、来源、标签决定会话显示成什么名字：例如 `~/work/clients` 下的会话都显示为「[客户] 原标题」，或者所有会话前面加上日期。规则只改变显示，不改写会话的标题。

## 1. 已定

| 项 | 决定 |
|---|---|
| 作用方式 | 只改变显示。存储的 `title`、它的来源 `titleSource`、写回 CLI 的名字都不变 |
| 计算位置 | 服务器。会话写入时按当前规则派生 `Session.displayTitle`，规则或项目变化时整批重算 |
| 匹配 | 规则有先后，第一条匹配的生效。条件之间是「且」，同一条件里的多个值是「或」；不写条件的规则作用于所有会话 |
| 覆盖范围 | 默认只覆盖自动生成的标题；选「全部标题」时，手动改过的标题也覆盖 |
| 不覆盖的会话 | 个人助理项目里的会话、模型讨论的席位 |
| 设置入口 | Web：设置 › 行为 › 会话标题；设置 › 辅助模型的「会话标题」下有一行跳转 |

## 2. 规则

```ts
interface TitleRule {
  id: string;
  match: { directories?: string[]; agents?: string[]; origins?: TitleRuleOrigin[]; tags?: string[] };
  template: string;          // 一行，最多 200 字
  scope?: 'auto' | 'all';    // 不写为 auto
}
```

定义和匹配函数在 `packages/contracts/src/title-rules.ts`，服务器和 Web 的预览用的是同一份。

- **目录**：项目目录等于它或在它下面就算匹配；worktree 也按它来源项目的目录匹配。保存时 `~` 按这台服务器的主目录展开，存的是绝对路径。
- **Agent**：会话的 `backendId`，旧会话没有这个字段时按 `cursor` 算。
- **来源**：`origin.kind`，没有来源的是 `manual`（从输入框新建）。界面上的「自动化」同时勾选旧的 `template`、`schedule`。
- **标签**：会话标签里有其中任意一个。
- **模板**：`{{title}}` 是原标题，`{{project}}` 是项目名（worktree 取来源项目），`{{date}}`、`{{time}}` 是会话创建的日期和时间。时区取个人助理设置里记下的时区，没有就用服务器的。其他 `{{…}}` 原样保留。空白合并成一个空格。结果和原标题相同时不设 `displayTitle`。

日期取创建时间而不是当前时间，所以标题不会每天变化。

## 3. 实现

- `Store` 是唯一写 `displayTitle` 的地方：`createSession`、`updateSession` 都先丢掉调用方传来的值，再按规则重新计算，所以任何写入方都存不进过期的值（`apps/server/src/titles/rules.test.ts`）。
- `app.ts` 保留最近一次保存的规则和时区，每次写会话时直接读这份，不读磁盘。设置保存后（`SettingsService.onSaved`）规则有变化就调用 `store.refreshDisplayTitles()`。改了项目的名称、目录或类型时，`updateProject` 也会重算。
- 标题模型：会话命中的规则模板里没有 `{{title}}` 时，原标题不会显示出来，`TitleService` 就不再为它请求标题。规则删除或修改后会补跑一次，让这些会话重新拿到模型写的标题。
- 服务器自己展示给人看的地方改用 `displayTitle ?? title`：推送、机器人消息、标记快照、分享、服务监控、重启阻塞、尝试列表、助理工具、消息搜索结果、`riffet ls`。交接摘要和新会话标题这类给 Agent 看或要沿用的内容仍用原标题。
- Web：列表 store 收到会话时把 `displayTitle` 放进 `title`，原标题留在 `baseTitle`（`apps/web/src/lib/shown-title.ts`），所以各个视图不需要知道规则的存在。重命名从原标题开始填写；当前名字由规则决定时，对话框里会说明显示成了什么。
- Android、iOS、Mac：共享的 Kotlin `Session` 提供 `shownTitle`（`displayTitle ?: title`），显示的地方用它，重命名用 `title`。

## 4. 多服务器

1. **归类**：B 环境和配置。规则里的目录是这台服务器上的路径，所以每台服务器只用自己的规则处理自己的会话。
2. **A 类对象**：不适用。合并列表里，每台服务器的会话自带它自己算好的 `displayTitle`，入口服务器原样显示，不套用自己的规则。
3. **路由**：没有新增路由，规则随 `PUT /api/settings` 保存，跟其他 B 类配置一样经链接照常处理。
4. **客户端请求**：走原有的设置请求，没有新的请求路径。
5. **id**：规则 id 只在一台服务器的设置里需要唯一。
6. **扩展点**：不适用。
7. **助理与 Riffet MCP**：助理工具里看到的会话名是 `displayTitle ?? title`，只看本机。
8. **入口缓存**：没有新增缓存。
9. **提醒**：推送用会话所在服务器算出的名字。
10. **旧版本**：对端是旧版本时不会发 `displayTitle`，客户端显示原标题；旧客户端会忽略这个字段，也显示原标题。
11. **控制权**：不涉及。要改对端的规则，打开对端的网页。

## 5. 未做

- Mac、Android、iOS 还没有规则编辑页面，只显示服务器算好的标题。
