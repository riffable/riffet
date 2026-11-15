# 个人资料

日期：2026-11-09。状态：第一期已实现（服务端、Web、macOS、Android、iOS）；分享署名未做。

Riffet 是单用户的（[MOBILE.md](MOBILE.md)「目标与非目标」）。个人资料是这台工作台主人的昵称和头像，不是账号：不注册、不登录、不改鉴权，设备身份仍是 `DeviceRecord`（[DEVICES.md](DEVICES.md)）。

## 边界

- **按服务器一份**，所有配对设备共用；客户端按服务器缓存。连两台服务器就是两份，不跨服务器同步。
- **只有昵称和头像**。不注入 Agent 上下文，不写 Git 身份，不按设备区分，不接 Gravatar。
- **默认留空**，不读取系统用户名或头像。
- **时间线不显示头像**：单用户场景里用户气泡永远是本人，Agent 侧也没有头像，保持两侧对称。
- 术语：界面叫「个人资料 / Personal info」，代码与接口叫 `owner`。「档案 / Profile」已指后端配置档案，`/api/devices/me` 指当前设备，都不复用。

## 契约

TypeScript `packages/contracts/src/owner.ts`，Kotlin `apps/mobile/contracts/.../Owner.kt`，客户端接口 `RiffetApiOwner.kt`。

| 接口 | 说明 |
|---|---|
| `GET /api/owner` → `OwnerInfo` | 同一份也在 `GET /api/bootstrap` 的 `owner` |
| `PATCH /api/owner {name}` → `OwnerInfo` | 去首尾空白；空或 null 清除；最多 32 个码点，拒绝控制字符 |
| `PUT /api/owner/avatar {type, data}` → `OwnerInfo` | base64；png / jpeg / webp，按文件头校验类型，最大 1 MiB；不接受 SVG |
| `DELETE /api/owner/avatar` → `OwnerInfo` | 已无头像也成功 |
| `GET /api/owner/avatar/:sha256` | `private, max-age=31536000, immutable`、`nosniff`、`default-src 'none'` CSP |

- 并发：后写覆盖，不做 revision 校验；单人改自己的昵称不值得冲突处理。`revision` 每次变更加一，供客户端判断新旧。
- 推送：每次变更在 `/api/lists/stream` 发 `event: owner`，`data` 是完整的 `OwnerInfo`。Web 直接替换；原生端在连上、回到前台和打开设置时重新读取 `GET /api/owner`。各端都丢弃 revision 更旧的结果。
- 头像：客户端先裁成正方形、缩到 512 px 再上传，服务端不引入图片库。

## 存储

`<stateDir>/owner.json` 保存 `{revision, name, avatar: {sha256, type, size}, updatedAt}`，头像文件在 `<stateDir>/owner/<sha256>`，权限 0600 / 目录 0700。换头像或移除时删掉旧文件。`avatar.generated = { style, seed }` 只在随机头像时有，上传会清掉它。两者都进备份；旧备份没有它们也能恢复。文件头校验与外观资源共用 `IMAGE_MAGIC`（`appearance/index.ts`）。

## 显示

- **头像**：圆形。无图时显示昵称首字（`ownerMonogram`），底色用主题的中性色，不按名字生成彩色；无昵称时显示通用人形图标。
- **侧栏底部（macOS、Web）**：只保留头像，点击打开个人菜单；顶部为头像与昵称，整行进入个人资料，下方直接列出原更多菜单、主题（Mac 为外观）与设置入口，保留前置图标。
  - 连接状态：远端或离线时显示在个人菜单中，地址与复制入口仍可达。
  - 后端或连接异常时头像带提醒点，具体问题在菜单对应入口中显示；健康时无状态点。
- **设置**：个人资料是第一组，包括头像（更换、移除）和名称，附一行「所有连接这台服务器的设备共用」。
- **移动端**：Android 的左抽屉顶部是头像和名称；设置页里个人资料行在搜索框下方。iOS 设置页顶部是个人资料行。点进去编辑。

## 头像历史

- **保留范围**：换头像（上传、生成、恢复）或移除时，原来的头像移进 `history`，最近用过的在前，最多 12 个。
  - 同一张图只出现一次。当前头像不在历史里。
  - 超出 12 个时删掉最旧那张的文件。
- **存储与读取**：历史和当前头像存在同一个目录，走同一个读取地址（`GET /api/owner/avatar/:sha256` 认当前头像和历史里的任意一张），也一起进备份。
- **接口**：
  - `POST /api/owner/avatar/restore {sha256}`：把历史里的一张设回当前头像，原来的当前头像进历史。
  - `DELETE /api/owner/avatar/history/:sha256`：删一条，并删掉对应文件。
- **界面**：个人资料里有历史时，显示一排小头像；点一个就恢复，右键（桌面）或长按（手机）可以删除。

## 分享署名

分享面板的「显示分享者」默认关闭，并记在分享上（`SessionShare.author`，规则与 `appearance` 相同）。打开时，生成草稿那一刻把昵称和头像冻结进 `ShareSnapshot.author`，头像文件作为 `assets/owner-<sha16>.<ext>` 打进包里；之后改资料不影响已生成的草稿和已发布的页面。

## 随机头像

由插件提供风格，核心负责光栅化和存储。用户在个人资料里点了才生成，「默认留空」不变。

- **声明**：`contributes.avatarStyles: [{ id, title, credit?, needsName? }]`，插件关闭时也能读到。
- **实现**：`Contributions.avatarStyles[id].generate({ seed, size, ink, paper, name? })` 返回 SVG 字符串。同样的参数必须得到同样的图。
- **核心**：
  - 校验 SVG：大小有上限；拒绝脚本、`foreignObject`，以及指向外部的 `href` / `url()`。
  - 用 `sharp` 转成 PNG：预览 128 px，正式头像 512 px。
  - 正式头像走与上传相同的存储，记下 `avatar.generated = { style, seed }`。SVG 不落盘，也不交给客户端。
- **接口**：
  - `GET /api/owner/avatar-styles`
  - `GET /api/owner/avatar-styles/<pluginId>/<name>/preview?seed&ink&paper`：PNG，每次按 ETag 校验，不长期缓存：改名（印章）或插件更新后，同一地址会换图。服务端另有一个 256 条的内存缓存。
  - `POST /api/owner/avatar/generate {style, seed, ink?, paper?}` → `OwnerInfo`
- **配色**：客户端传当前主题的墨色（正文色）和纸色（背景色），生成的图与生成时的主题一致，之后不跟着主题变。
- **内置插件** `riffet.avatars`（头像风格）：
  - [DiceBear](https://github.com/dicebear/dicebear)（MIT）的 CC0 风格：Notionists、Lorelei、Open Peeps、Line Face、Shadows、Cutouts、Sprouts、Critters、Planets、Landscape、Patchwork。
  - 自绘的「印章」：取昵称首字，种子决定朱文或白文、方印或圆印、轻微倾斜和磨损。字体用系统宋体或衬线字体；服务器没有中文字体时会缺字。
- **界面**：「更换头像」旁边加一个骰子按钮，打开风格网格，每格是当前种子的预览；「换一批」重新随机种子；点一格即设为头像。
