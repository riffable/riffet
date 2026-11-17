# Android Build

在 Riffet 里构建、运行和观察 Android 项目，不经过 Android Studio 的 Sync 和索引。任务由宿主运行（日志、取消、产物、重启恢复），已安装包的首次执行计划仍需确认。

- 识别：项目根目录或下一两层的 Gradle 构建；应用模块来自 settings 的 `include`、构建脚本，以及已有构建产物的 `output-metadata.json`（由 settings 插件动态引入模块的项目也能识别）。变体与 applicationId 优先取产物里记录的值，其次解析 `buildTypes`、`productFlavors`。
- 「Android」视图：Run（构建、安装并启动，同 Android Studio 的 Run）、Build APK（只打包）、Unit Tests、Lint、Clean、Crashes、Screenshot。Gradle 任务共用一个锁。
- 「Configs」视图：项目里 Android Studio 的运行配置（`.run/*.run.xml`、`.idea/runConfigurations`、`.idea/workspace.xml`），按 Studio 的文件夹分组；支持 Shell Script 与 Gradle 两类，按 Studio 的方式执行。
- 「Logcat」视图：按应用的 pid 持续跟随，应用重启后自动切换到新进程；单独成一个视图，跟随日志时不会锁住构建按钮。
  按列显示时间、pid、tid、tag、级别和消息，筛选语法同 Android Studio：`tag:Foo`、`-tag:Bar`、`tag~:正则`、`level:W`（W 及以上）、直接输入的词搜消息；点 tag 等列即加入筛选，⌥ 点击则排除。
- 诊断：Kotlin、javac、AAPT、Gradle 摘要、Lint、失败的单元测试、应用崩溃（含 Caused by），点击跳到源码行。崩溃栈和测试失败位置由脚本在 Gradle 根目录下按源码列表解析。
- 操作按「检查 / 设备 / 工程」分组，日志按规则着色并折叠重复的 Gradle 任务行。
- 设备：多台时按 `ANDROID_SERIAL` 选择；参数（模块、变体、设备）已声明，宿主表单尚未绘制前使用默认值（`:app` 或与项目同名的应用模块、debug 变体、第一台设备）。

其他受信任的插件可以通过 `workspaces` 服务（`workspaces.ts`）注册工作区处理器，接管某类工作区的应用列表、构建计划、诊断和运行配置命令，例如把构建交给远端系统；处理器需在自己的 `requires` 里声明 `riffet.android`。

本包是公开的任务提供方参考实现：任务提供方、视图、命令和诊断都用 `@riffet/plugin-api` 声明，见 [插件文档](../../docs/PLUGINS.md)。

```sh
riffet plugin pack official/android --out /tmp/riffet-android.tgz
riffet plugin install /tmp/riffet-android.tgz --trusted --yes

# 开发：构建、关联本机 Riffet、监听修改并重载
riffet plugin dev official/android
```

`pack` 每次读取当前源码，自动构建、校验和归档。运行归档不包含测试。单元测试在仓库根目录用 `npx vitest run official/android` 运行。

也可以在 Web 或 Mac 的插件页导入归档，明确勾选“信任此插件”后安装。卸载会保留设置和数据。
