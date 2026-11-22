纸墨：近无彩墨色与低色度纸色的配色，搭配 Inter 字体和纸纹背景，并提供一个同名预设。只含配色、字体、背景和预设，没有服务端入口。字体许可位于 `assets/Inter-OFL.txt`。

## 开发

不需要 package.json、Node 依赖、锁文件或 SDK。安装 Riffet 后直接操作：

```sh
riffet plugin pack .
riffet plugin install "$PWD/dist/riffet.appearance-paper-1.0.1.tgz" --trusted

# 修改资源后自动校验并刷新本机 Riffet
riffet plugin dev .
riffet plugin unlink riffet.appearance-paper
```

开发前如已安装同 ID 版本，先卸载该安装版本；退出监听保留开发关联，`unlink` 才会解除。

`--trusted` 用于保留官方 `riffet.` 身份，纯资源包不会启动服务端代码。构建目录与归档自动写入本插件的 `dist/`；可用 `--format zip` 或 `--format tar` 切换归档格式。失败保留上次成功产物。

`riffet-plugin.json` 是声明来源，资源位于 `assets/`。`scripts/generate-grain.mjs` 仅用于重新生成纸纹，使用 Node 内置模块，打包时不会执行或分发该脚本。
