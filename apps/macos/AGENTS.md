# Mac 客户端

补充根目录 [AGENTS.md](../../AGENTS.md)，那里的「改界面」同样适用。Mac 的写法和迁移顺序在 [macOS](../../docs/design/system/macos.md)，构建与本地化在 [docs/MACOS.md](../../docs/MACOS.md)。

## 范围

- 动手前按 [Mac 客户端范围规范](../../docs/guide/mac-scope.md) §2 归类。M 类（服务器上的配置、统计、批量管理）不写原生页面，入口打开 Web；不用 `WKWebView` 嵌 Web 的页面。
- 规范 §4 里标着「冻结」的页面只修缺陷。改动超出字段改名，或页面只显示了 Web 的一部分内容时，删掉页面换成入口，不修补。
- 系统能力（规范 §5）排在 W 类的新增对齐之前。

## 界面

- 先看 macOS 文档 §1 的分工：交互跟平台（sheet、系统菜单、`.help`、菜单栏快捷键），外观跟风格。
- Mac 只有 Riffet 一种风格（DECISIONS 2026-11-25），不再加风格分支或风格开关。尺寸、字体、默认图标包读 `DisplayPreferences.shared.style`（由 `interface-styles.ts` 生成），不在业务代码里另写。
- 取值只用主题层：颜色 `palette.*`，文字 `RiffetFont` 的角色，间距 `Space.*`，圆角 `Radius.*`（一律 `.continuous`），阴影 `.elevation(_:)` 或 `Elevation.apply(to:dark:)`，动效 `Motion.*`。数字只在 `Theme/` 和画内容的文件里出现。
- `pnpm check:design` 按文件给数字内边距、圆角、字号记了基线（`scripts/design-rules-baseline.json`），只降不升；新文件从 0 开始。改完一个文件，运行 `node scripts/check-design-rules.mjs --update` 降低基线。
- 字重只用 `.regular` 和 `.medium`，`.semibold` 只给品牌名；不用半档字号。
- 迁移进行中：动到 macOS 文档「现状」里列出的代码时，顺手按 §9 的顺序改掉，并删掉对应条目。

## 本地化

- `Text`、`Button`、`Label`、`.help` 收到的字面量会被自动提取；`String` 类型的 API 用 `String(localized:)`，自己组件的文字参数用 `LocalizedStringResource`。
- 整句成文，不拼片段。同一句中文只对应一种英文；需要不同英文时，换一种中文说法。
- 新增键：`build.sh test` 之后运行 `node scripts/check-i18n.mjs --sync`，再在 `Riffet/Resources/Localizable.xcstrings` 补英文。`--sync` 会重排目录的格式；只手动加一两个键时，照原格式插入。

## 运行

- 正在运行的 App 可能是使用者正在用的那个。不要用 `riffet://` 链接驱动它来验收界面；用 `build.sh` 重启 App 之前先问。
