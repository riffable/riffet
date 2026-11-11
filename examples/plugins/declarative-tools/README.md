# Declarative tools

同一份 manifest 在 Web 与 macOS 中生成原生列表、表单和详情；三个视图复用同一条带参数校验的命令，不加载自定义 Web 代码。插件声明按视图或命令首次使用激活。

```sh
riffet plugin pack examples/plugins/declarative-tools --out /tmp/declarative-tools.zip
riffet plugin install /tmp/declarative-tools.zip
```

打开项目后，在插件详情进入任一视图。输入值由服务端按 `contributes.commands[].params` 再次校验；`requires` 只声明客户端所需的renderer，不能授予执行权限。
