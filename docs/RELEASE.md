# 版本、发布与分发

日期：2026-11-13。范围：版本号与渠道、版本升级规则、发布流水线、各端产物与更新路径、签名材料。源码 clone 的检查与原地更新见 [UPDATE.md](UPDATE.md)；日常命令见 [运维指南](guide/operations.md)「版本与发布」。

参考实现：Ghostty（Sparkle 渠道、appcast 由发布记录生成、CI 内签名公证）、Zed / VS Code（stable 与预览渠道共用一条构建号序列）、Immich（服务端与移动端同版本号，靠能力声明兼容新旧组合）、Tauri（先建草稿再转正）。

## 1. 版本号

服务端、Web、macOS、iPhone 与 Android 使用同一个版本号，唯一来源是根目录 `package.json`。

| 渠道 | Git tag | `version` | Apple `MARKETING_VERSION` | Android `versionName` | npm dist-tag | GitHub Release |
| --- | --- | --- | --- | --- | --- | --- |
| stable | `v0.8.0` | `0.8.0` | `0.8.0` | `0.8.0` | `latest` | 正式，标为 Latest |
| beta | `v0.8.0-beta.1` | `0.8.0-beta.1` | `0.8.0` | `0.8.0-beta.1` | `next` | prerelease |

- 预发布只有 `-beta.N` 一种，N 从 1 开始。不设 alpha、rc，也不带构建元数据。
- Apple 的 `MARKETING_VERSION` 只接受三段整数，`scripts/version.ts` 写入两个 `project.yml` 时去掉 `-beta.N`。App 内展示的完整版本号来自构建记录（`scripts/build-info.mjs`）。
- `buildNumber`（`yyMMddNN`）是**所有渠道共用的唯一先后依据**：Android `versionCode`、Apple `CFBundleVersion`、Sparkle 的版本比较和 TestFlight 都按它排序，且都拒绝回退。同一天最多 99 个构建。
- 发布后的 tag 不可变。只修打包问题时执行 `pnpm version:bump` 换构建号后重新出包，不移动原 tag。

### 什么时候升哪一位

1.0 之前，新功能或不兼容变化升 MINOR，只含修复升 PATCH。以下变化一定升 MINOR，并在变更记录中写明升级须知：

| 变化 | 来源 | 变更记录须写 |
| --- | --- | --- |
| 数据库 `SCHEMA_VERSION` | `apps/server/src/store.ts` | 升级后旧版本无法打开数据库，升级前备份 |
| 删除 `ProtocolFeature`、`PROTOCOL_INFO.version` 变化 | `packages/contracts/src/protocol.ts` | 仍可用的最低客户端版本 |
| `PLUGIN_API_VERSION`、`AGENT_PROTOCOL_VERSION` | `packages/plugin-api/src` | 插件迁移方式；升 SDK 包版本时运行 `pnpm gen:plugin-api` 生成新基线 |
| Node.js、macOS、iOS、Android 最低版本 | `package.json` `engines`、两个 `project.yml`、`libs.versions.toml` | 新的最低要求 |

`scripts/release.mjs` 把这些来源与上一个 stable tag 比较：MAJOR.MINOR 未变却出现上述变化时，`release:prepare` 和发布工作流都会拒绝。新增协议能力不算不兼容。后端 CLI 的最低版本不在此列，由 `riffet doctor` 逐项提示。

### 兼容窗口

客户端与服务端通过 `/health` 的 `protocol.features` 和请求头 `x-riffet-features` 协商能力，不比较版本号。删除一个能力的前提是：依赖它的客户端版本已经落后至少两个 MINOR。在此之前服务端继续声明该能力。

## 2. 变更记录

- `CHANGELOG.md`（英文）与 `CHANGELOG.zh-CN.md`（中文）内容一一对应，只写使用者能感知的变化，由人整理，不从提交信息生成。开发期间随改动的提交一起写在各自的「Unreleased」「未发布」节；CI 发现用户可感知的提交没有对应条目时给出警告（`release.mjs changelog`，不阻塞）。`pnpm release:notes` 列出上一个发布以来的 `feat` / `fix` / `perf` 提交（不含 `ci`、`scripts`、`tests`、`build` 作用域），发布前对照补齐。
- stable：`release:prepare` 把两份文件的未发布节改为 `## <版本> - <日期>`，再在上方新建空的未发布节。
- beta：不改动变更记录。它的发布说明取 tag 所在提交上的未发布节，因此变更记录里只出现 stable 版本。
- GitHub Release 正文：英文在前，中文放在 `<details><summary>简体中文</summary>` 里。appcast 把两段分别写成 `xml:lang="en"` 与 `xml:lang="zh-Hans"` 的说明，Sparkle 按 App 的语言选用。

## 3. 发布流程

```bash
pnpm release:notes                  # 整理两份未发布节
pnpm release:prepare 0.8.0-beta.1   # 预检、改版本、生成契约快照、（stable 时）定稿变更记录、提交、打 annotated tag
git push origin main v0.8.0-beta.1  # 推送后触发 .github/workflows/release.yml
```

`release:prepare` 的预检项：工作树干净；当前分支是 `main` 或 `release/X.Y`；版本号比现有版本新；beta 的目标 stable 尚未发布；两份变更记录的未发布节都不为空；满足版本升级规则。它不负责推送。

`release.yml` 的各个 job：

| Job | 做什么 | 失败时 |
| --- | --- | --- |
| `meta` | `release.mjs check`：tag 与 `package.json` 一致；tag 位于 `origin/main` 或 `origin/release/X.Y`；变更记录有对应内容；版本升级规则；算出渠道、npm dist-tag、是否标为 Latest；生成发布说明 | 不构建任何产物 |
| `verify` | 在 tag 上运行完整的 `verify.yml` | 同上 |
| `npm-package`、`android`、`macos` | 并行构建 | 不建草稿 |
| `draft` | 汇总产物与 `SHA256SUMS`，仓库公开时附 build provenance attestation，创建草稿 Release | 不对外可见 |
| `smoke` | 在 Ubuntu 和 macOS 上从 tarball 全局安装 npm 包，核对 `riffet-server --version` 和 `/health` 的版本 | 草稿保留，可排查后重跑 |
| `publish` | stable 在 `release` environment 等待人工批准，beta 进入 `beta` environment 直接执行。依次：npm 发布、草稿转正、更新 Homebrew cask（仅最新 stable） | — |
| `appcast` | 调用 `pages.yml` 重新部署站点，appcast 加入本次 Mac 更新 | Release 已公开，Sparkle 暂时还看不到新版本；手动运行 Pages 补上 |

顺序有讲究：npm 在 Release 公开之前发布，因为页面一公开就有人安装；appcast 最后更新，Sparkle 才不会指向还没公开的下载。手动运行工作流（输入已有 tag）可以重建产物：资产按同名替换，npm 上已有的版本不重发，已公开的 Release 保持公开。

人工批准只给 stable。npm 同一版本号不能重发，Sparkle 会主动推送给所有 Mac 用户，Homebrew 会被大量缓存，三者都无法撤回。审批发生在草稿与冒烟测试之后，批准时看的是真实产物。

### 补丁与回滚

- 补丁默认从 `main` 发。只有 `main` 上已有不能随补丁发布的改动时，才从 tag 拉 `release/X.Y` 分支，cherry-pick 修复后发 `vX.Y.(Z+1)`。比 `main` 上最新版本更旧的 stable 不会标为 Latest，npm 也改用 dist-tag `release-X.Y`。
- 数据库迁移只能向前，所以发布出错时一律发新版本修复：
  - npm：用 `npm dist-tag add riffet@<上一个版本> latest` 把 `latest` 指回去，再对问题版本执行 `npm deprecate`。
  - Mac：把问题 Release 的 `Riffet-<版本>.appcast.json` 删掉后重跑 Pages，Sparkle 不再提供这个版本。已经升级的用户等下一个 PATCH。
  - Release 正文开头注明问题。

## 4. 产物与更新路径

| 产物 | 分发 | 更新 |
| --- | --- | --- |
| `riffet-<版本>.tgz`（服务端 + Web） | npm `riffet` | `npm i -g riffet@latest`（beta 用 `@next`）；`riffet update --check` 对 npm 安装只给出命令 |
| 源码 clone | GitHub | `riffet update`，只认 stable tag，beta tag 不参与比较（[UPDATE.md](UPDATE.md)） |
| `Riffet-<版本>.dmg` | GitHub Release、Homebrew tap `riffable/homebrew-riffet` | Sparkle 2；cask 设了 `auto_updates true`，由 Sparkle 负责更新 |
| `Riffet-<版本>.zip` 与 `Riffet-<版本>.appcast.json` | GitHub Release | 前者是 Sparkle 实际安装的包；后者记录前者的 EdDSA 签名、大小和最低系统版本 |
| `Riffet-<版本>.apk` | GitHub Release（只能侧载，见 [MOBILE.md](MOBILE.md)） | 手动安装；按 `versionCode` 覆盖 |
| `SHA256SUMS` | GitHub Release | — |

### macOS 更新（appcast）

appcast 是 Sparkle 读取的 RSS 格式更新清单，地址固定为 `https://riffable.github.io/riffet/appcast.xml`（`apps/macos/project.yml` 的 `RIFFET_APPCAST_URL`）。它不存放在仓库里：每次部署 Pages 时，`scripts/build-appcast.ts` 根据已公开的 Release 重新生成。每个带 `.appcast.json` 的 Release 对应一条记录，prerelease 的记录带 `<sparkle:channel>beta</sparkle:channel>`。部署会替换整个站点，因此 appcast 每次都必须重新生成，不能只在发布时生成一次。

App 只接收 stable 记录。用户打开「设置 → 关于 → 接收测试版更新」，或者正在运行的本身就是 beta 构建时，才同时接收 beta 记录（`Updater` 的 `allowedChannels`）。Sparkle 比较的是构建号，所以 beta 用户在正式版发布后会自动收到它。

## 5. 签名材料与仓库配置

仓库公开后全部存放在 GitHub environment 中：`signing` 与 `release` 的部署规则只允许 `v*` tag，`beta` 不设规则。

| 名称 | 类型 | 所在 | 用途 |
| --- | --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` | secret | `signing` | APK 签名（证书 subject `CN=Riffet, O=riffable`） |
| `MACOS_CERTIFICATE_P12_BASE64`、`MACOS_CERTIFICATE_PASSWORD` | secret | `signing` | Developer ID Application 证书 |
| `APP_STORE_CONNECT_API_KEY` | secret | `signing` | `.p8` 内容，用于公证；之后 TestFlight 也用它 |
| `SPARKLE_ED_PRIVATE_KEY` | secret | `signing` | Sparkle EdDSA 私钥（`generate_keys -x` 导出） |
| `HOMEBREW_TAP_TOKEN` | secret | `release` | 对 tap 仓库有写权限的 fine-grained token；未设置时跳过并给出提示 |
| `MACOS_SIGN_IDENTITY`、`APPLE_TEAM_ID`、`APP_STORE_CONNECT_KEY_ID`、`APP_STORE_CONNECT_ISSUER_ID`、`RIFFET_SPARKLE_PUBLIC_KEY` | variable | 仓库 | 签名身份、团队、API key 标识、写进 `Info.plist` 的 Sparkle 公钥 |
| `RIFFET_MACOS_RELEASE` | variable | 仓库 | 设为 `true` 后才构建 Mac 产物；在此之前 `macos` job 跳过，不阻塞其他产物 |
| `HOMEBREW_TAP` | variable | 仓库 | 可选，默认 `riffable/homebrew-riffet` |

`release` environment 需配置 required reviewer。只有一位维护者时不能勾选 "Prevent self-review"。组织目前是 Free 套餐，私有仓库用不了 environment，Pages、attestation 与 npm provenance 也要求仓库公开。因此仓库公开前，工作流不使用 environment，签名材料从仓库级 secret 读取，npm 与 appcast 两步自动跳过。公开后先建好三个 environment，再发第一个正式版本，签名 secret 随后迁到 `signing`。

## 6. 尚未实现

| 项 | 内容 | 前提 |
| --- | --- | --- |
| iOS | 新增 job：archive，导出后直接上传 App Store Connect。beta 进 TestFlight 外部测试组，stable 由维护者在 App Store Connect 提交审核 | Apple 开发者账号、App 记录、分发证书与 profile；上架所需的隐私清单与审核材料 |
| Android 应用内更新 | 读取 GitHub Releases 的最新版本，下载后先校验签名证书再安装 | — |
| 构建记录的分发方式 | `build-info.json` 记录 `distribution`（source、npm、app、appstore、apk），各端按它决定检查更新的方式 | — |
| nightly | `main` 有新提交时按日构建，滚动更新 `nightly` prerelease 与 Sparkle `nightly` 渠道，构建号由 CI 注入 `yyMMdd90`–`99` | beta 运行一段时间后再评估 |
| 插件 SDK | `@riffet/plugin-api`、`@riffet/plugin-web` 用独立的 `sdk-v*` tag 按 semver 发布到 npm；`contracts` 只在工作区内部使用 | — |
| 供应链 | release 工作流中的 actions 固定到 commit SHA，zizmor 扫描工作流，生成 CycloneDX SBOM | — |
