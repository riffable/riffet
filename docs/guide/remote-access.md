# 远程访问

返回 [中文 README](../../README.zh-CN.md)。本文说明如何在另一台机器（Mac 或 Linux，例如开发机）上运行 Riffet 服务器，并从网页、Mac App、Android 和 iPhone 连接。启动参数的完整说明见 [运行、部署与维护](operations.md)，威胁模型见 [SECURITY.md](../SECURITY.md)。

所有客户端用同一种方式连接任意服务器：完整地址加一次性配对码，或扫描配对二维码。配对码由 `riffet pair` 在服务器上生成，有效期 5 分钟，只能使用一次。已连接的客户端也能为它当前所连的服务器生成配对码和二维码（「配对新设备」），让另一台设备加入。

## 选择方式

| 场景 | 监听 | 建议 |
| --- | --- | --- |
| 同一台机器 | `127.0.0.1`（默认） | 免令牌，不需要配对 |
| 同一局域网 | `0.0.0.0` | 配对码；局域网是明文 HTTP |
| 跨网络 | 见下 | 公司 VPN、Tailscale 或 WireGuard，服务器不暴露到公网 |

## 本机

```bash
riffet
```

默认监听 `127.0.0.1:4337`，本机访问免令牌。本机 Mac App 自动连接，不需要配对。

## 局域网

在服务器上：

```bash
riffet restart --host 0.0.0.0 --auth
riffet pair
```

Mac App 管理的本机服务器也可以在「设置 → 连接」打开「允许同一网络的设备连接」，或在配对页点同名按钮：服务器改为监听局域网并启用令牌，空闲时重启；这台电脑上的浏览器之后也需要登录。首次启动可用 `riffet start --host 0.0.0.0`；显式指定非回环地址时默认启用认证。`riffet pair` 打印服务器的局域网地址、配对码和二维码。服务器没有图形界面时不要直接运行 `riffet`，它会在启动后尝试打开浏览器；用 `riffet start`。

服务器默认通过 mDNS 在局域网广播（`--no-mdns` 或 `RIFFET_MDNS=0` 关闭），手机 App 可以在同一网络里发现它。绑定到具体 IP 时不广播，需要手动输入地址。有些公司网络不转发组播，此时发现不到，用地址或二维码连接。

局域网是明文 HTTP，令牌和会话内容可被同一网络上的人嗅探。所以别的电脑或手机的浏览器经明文 HTTP 打开时只能查看，不能发消息、开终端或改设置；App 用配对得到的设备令牌，不受这条限制。要在浏览器里操作，用 HTTPS 地址（见下文）或服务器本机的网页。「设置 › 设备」可以允许这类浏览器对话，代价是同一网络上的人可以冒充它，并借 Agent 执行命令。流量本来就在加密网络里（WireGuard、公司 VPN 的网段）时，用 `--trust-network 10.8.0.0/24` 把这个网段标为已加密；Tailscale 的地址默认已视为加密。<!-- privacy: allow example subnet -->

## 跨网络

### Tailscale、WireGuard 或公司 VPN

推荐。服务器只在私有网络内可达，不需要额外的 TLS。

```bash
riffet restart --host 0.0.0.0 --auth
riffet pair
```

- 用虚拟网络的 IP 连接（例如 Tailscale 的 `100.x.y.z`）时，它属于服务器的网卡地址，Host 校验自动通过，`riffet pair` 会把它列在地址里。
- 用主机名连接（MagicDNS、内网 DNS）时，要把名字加入允许列表，否则请求被拒绝为 `INVALID_HOST`：

  ```bash
  riffet restart --host 0.0.0.0 --auth --allow-host dev-box.tailnet.ts.net
  ```

  `--allow-host` 可重复，设置后随启动配置保存。`riffet pair` 默认只列网卡 IP 和 `*.local`；要让二维码带这个名字，运行 `riffet pair --url dev-box.corp.example:4337`。
- 客户端手动输入的地址没有端口时按 4337 处理：`dev-box.tailnet.ts.net` 等于 `http://dev-box.tailnet.ts.net:4337`；`https://` 开头且没有端口时按 443。

### SSH 隧道

只用一台电脑访问时可以不开放服务器端口。服务器保持监听 `127.0.0.1`，但要启用认证（`riffet restart --auth`）：

```bash
ssh -L 4337:127.0.0.1:4337 dev-box
```

然后在本地打开 `http://127.0.0.1:4337`，用服务器上 `riffet token` 打印的访问令牌登录，或在服务器上运行 `riffet pair --url http://127.0.0.1:4337`，在本地输入配对码。隧道只连通这台电脑，手机需要可直连的地址。

### HTTPS 反向代理

适用于已经有可信私有网络和内部域名的情况。Riffet 自身不终止 TLS，由代理提供。服务器监听回环并启用认证，名字加入允许列表：

```bash
riffet restart --host 127.0.0.1 --auth --allow-host riffet.internal.example
```

Caddy 示例：

```caddyfile
riffet.internal.example {
    reverse_proxy 127.0.0.1:4337
}
```

要求：

- 代理保留原始 `Host`（Caddy 默认保留；nginx 需要 `proxy_set_header Host $host`），并转发 WebSocket Upgrade，终端和实时事件依赖它。
- 必须启用 `--auth`。免令牌模式会拒绝带转发头或非回环 `Host` 的请求，经代理访问会得到 `LOCAL_ACCESS_ONLY`。
- 代理要设置 `X-Forwarded-Proto: https`（Caddy、`tailscale serve` 默认会设置），生成配对码时才会使用 `https`。
- 在服务器上运行 `riffet pair --url https://riffet.example.com`，或通过这个域名登录网页后用「配对新设备」，二维码都会使用该域名、`https` 和端口 443。
- 不要把它放到公网。持有设备令牌等同于拿到服务器上用户的 Agent 和终端权限。

限制：

- 监听回环时 `riffet pair` 需要 `--url` 指明客户端用的地址，否则拒绝输出配对码。
- 二维码里的域名只取自通过校验的 `Host`，不读 `X-Forwarded-Host`；代理改写了 `Host` 时，二维码和 Host 校验都会不符合预期。

## 安全

- 密钥和权限模型见 [SECURITY.md](../SECURITY.md)。配对一台设备等于把服务器上用户的 Agent 权限交给它，目前没有只读级别。
- 回环和受信的私有网络之外不要使用明文 HTTP。Riffet 没有内置 TLS，局域网模式的令牌是明文传输的。
- 每台设备有独立的设备令牌，可以在「设置 → 连接」的设备列表里单独撤销，撤销后它的实时连接立即断开。
- 配对码 5 分钟内有效且只能使用一次，登录与配对接口有限流。访问令牌（`riffet token`）不进入二维码。

## 连接各个客户端

先在服务器上运行 `riffet pair`，或在任意已连接的客户端上打开「配对新设备」。

- 网页：浏览器打开服务器地址，在登录页输入配对码。已登录的网页可以在「设置 → 连接」里「连接其他服务器」：输入地址和配对码，或把配对载荷粘贴到地址框；触屏设备上还可以直接扫码。网页每次只连接一台服务器，换服务器会跳转到对方的地址。
- Mac App：「设置 → 连接」列出本机和已配对的服务器，可以切换或忘记；「连接服务器…」输入地址和配对码（载荷粘贴到地址框会同时填好两项）。本机服务不需要配对。
- Android、iPhone：扫描二维码，或输入地址和配对码；也可以从局域网发现的服务里选择。多台服务器可以保存并在设置里切换，忘记服务只删除这台设备上的凭据。
- 另一台设备要加入当前服务器：在已连接的客户端打开「配对新设备」，显示二维码和配对码，5 分钟内由新设备扫描或输入。

「配对新设备」生成的地址由当前连接决定：通过局域网 IP 连接时是该 IP，通过允许的域名连接时是该域名。服务器只监听本机时会提示其他设备无法连接。
