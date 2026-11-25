# 传输与身份安全

日期：2026-11-25。状态：规划，未实现（§9 做过原型验证）。当前实现与已知缺口见 [SECURITY.md](SECURITY.md)，服务器互联见 [SERVER-LINKS.md](SERVER-LINKS.md)。

本文给出客户端与服务器、服务器与服务器之间的加密、身份、配对和授权的整体方案。它取代 [MOBILE.md](MOBILE.md)「网络接入」里「不自建 TLS、不做证书固定」的决定：服务器互联以后，一个令牌泄露的影响从一台服务器扩大到所有对它开了入站的服务器，依赖用户自备 Tailscale 或反向代理已经不够。

## 1. 目标与威胁模型

**目标**

- 原生客户端、服务器互联和浏览器的主路径，每一段都加密并双向认证，不依赖用户自备的网络、域名或证书。
- 身份是公钥。信任来自配对时的带外通道（二维码、链接串、SSH），不用首次信任（TOFU）。
- 中转只能看到密文。
- 权限按能力分级，可撤销、可审计、可轮换。
- 例外只有一处：浏览器经明文 HTTP 访问非回环地址。这条路无法加密（§4），只能限权。

**防御的攻击者**

| 攻击者 | 例子 | 主要措施 |
| --- | --- | --- |
| 同网段被动窃听 | 公共 Wi-Fi、公司局域网 | §3 各段加密 |
| 同网段主动中间人 | ARP 欺骗、恶意热点、DNS 劫持 | 按指纹固定证书（§3）；配对走带外通道（§5）；明文浏览器限权（§4） |
| 中转或网络运营方 | 中转服务、VPS 提供商 | 端到端认证，中转只转发密文（§8） |
| 设备丢失或令牌泄露 | 手机丢失、备份泄露、日志里留下令牌 | 设备私钥不可导出（§2）；撤销；能力分级（§6） |
| 已被攻破的对端服务器 | 多人共用的 devbox 被拿到 root | 互联入站分级（§6）；对端碰不到本机的控制权（`links/policy.ts`） |
| 恶意网页 | CSRF、DNS rebinding | 保持现有的 Host、Origin、CSRF 校验；§3 本机转发端口同样校验 |
| 托管网页被篡改 | 项目的静态站点或发布流程被攻破 | §9：按版本固定路径、完整性校验、可自托管 |
| 被提示注入的 Agent | 借工具操作其他服务器 | 按会话勾选 `server:<id>`；能力不超过链接的入站级别（§6） |

不防御已经在服务器本机拿到用户权限的攻击者（SECURITY.md 已知缺口第 5 条）。

## 2. 身份

| 主体 | 密钥 | 存放 |
| --- | --- | --- |
| 服务器 | 两把长期密钥：互联用 Ed25519（现有，`links/identity.ts`）；面向客户端的 TLS 与 WebRTC 用 ECDSA P-256，浏览器和各平台系统库对它的支持最稳 | Mac：Keychain；Linux：0600 文件，可选 libsecret |
| 原生设备（Mac App、iOS、Android） | 设备本机生成 P-256 密钥和自签名证书，私钥不可导出 | Secure Enclave、Android Keystore（StrongBox） |
| 浏览器（HTTPS） | Passkey（WebAuthn）登录后的会话 Cookie | 浏览器 |
| 浏览器（§9 WebRTC 直连） | `RTCPeerConnection.generateCertificate()` 生成的 P-256 证书，私钥不可导出 | 托管站点源下的 IndexedDB |

- `serverId` 保持现在的 UUID，配对时与服务器的证书指纹一起记下。连接时用指纹确认对方身份，与 Syncthing 用证书确认设备 ID 是同一个原则。
- 设备的证书不经 CA 签发：服务器在配对时登记它的指纹，之后靠双向 TLS（mTLS）认证，不再传 bearer 令牌。复制出来的凭据文件不能用。
- 换密钥：服务器用旧密钥签一条轮换声明，把新证书推给所有对端和设备，对方更新指纹，不用重新配对。设备换密钥同理。SERVER-LINKS.md §6 写了互联的轮换，目前没有实现。
- iOS 上，Secure Enclave 的密钥要和证书一起组成 `SecIdentity`，才能在 URLSession 的客户端证书质询里使用。这一步要在 P1 先做小样验证。

## 3. 各段传输

| 段 | 方案 |
| --- | --- |
| 服务器 ↔ 服务器 | 保持现状：隧道内 TLS 1.3，双方按配对时记下的指纹验证证书 |
| 原生 App ↔ 服务器 | 直连服务器端口上的 TLS 1.3。客户端按配对时记下的指纹验证服务器证书，不依赖 CA；同时出示设备证书（mTLS） |
| 浏览器 ↔ 回环 | 明文 HTTP。浏览器把 localhost 视为安全上下文 |
| Mac 浏览器 ↔ 互联的对端 | 本机转发（见下） |
| 浏览器 ↔ 非回环的服务器 | 有浏览器信任的 HTTPS 时（Tailscale、反向代理、用户自己的域名）正常使用；手机浏览器长期走 §9；都没有时按 §4 限权 |

**同一端口**：服务器按连接的首字节分流 TLS 和明文 HTTP。非回环来源的明文 HTTP 只服务三种请求：互联隧道的入口（`/api/links/tunnel`，隧道内自带 TLS）、§4 的限权浏览器会话、TLS 配对之前的服务发现。原生客户端升级到 TLS 以后，服务器不再接受它经明文 HTTP 发来的凭据。

**Mac 浏览器经本机转发访问对端**：Mac 上的服务器在回环地址开一个端口，经已加密的互联隧道把连接原样转到对端。浏览器打开 `localhost:<端口>`，使用对端自己的网页和登录。

- 对端必须把这类连接当作远程请求：要求登录，不享受回环的免令牌，项目外文件读取按远程处理。
- 这类连接也不带链接身份 `link:<serverId>`，否则会绕过对端的登录。
- 对端的 Host 允许列表要接受 `localhost:<端口>`；Origin 和 CSRF 校验照常进行，防止网页借这个端口做 DNS rebinding。
- 只有本机对这台对端有出站权限（`outbound`）时才开这个端口，链接断开时关闭。

## 4. 浏览器的限制

浏览器只信任两种网页来源：CA 签发证书的 HTTPS，或者 localhost。网页代码经明文 HTTP 下发时，中间人可以直接替换代码，所以在网页里另做一层加密无效，即使密钥是扫码拿到的也一样。§9 能做到加密，是因为网页代码从可信的 HTTPS 站点加载，只有数据经 WebRTC 走向服务器。

**明文浏览器的规则**：浏览器经明文 HTTP 访问非回环地址时：

- 会话默认只有 `read`。
- `chat` 要用户在那台服务器上明确开启「允许未加密连接对话」，并提示代价：对话可以让 Agent 执行命令（§6），等于把执行权交给网络上的中间人。
- `exec` 和 `admin` 一律拒绝。
- 会话有效期比加密通道上的短（`SESSION_COOKIE_BUDGET`：1 天，加密通道上 30 天），界面上标出连接没有加密。
- 不设 `Secure` Cookie（明文 HTTP 下设不了），所以只在 HTTPS 下用 `__Host-` 前缀，读取时两个名字都认。localhost 经 HTTP 时保持原名：不是每个浏览器内核都在 localhost 上保留 `Secure` Cookie，而本机的 HTTP 也没有可以被篡改 Cookie 的路径。

**主路径**：手机用原生 App。浏览器是退路，长期方案见 §9。

## 5. 配对

| 场景 | 做法 |
| --- | --- |
| 原生 App 扫码（主路径） | 二维码里放地址列表、服务器证书指纹和 128 位一次性密钥。客户端按指纹建立 TLS，用 HMAC 证明自己持有密钥，HMAC 绑定双方证书指纹（与 `links/invite.ts` 相同），然后登记设备证书指纹和选定的能力 |
| 原生 App 手输（没有摄像头，例如 Mac App 连 devbox） | 地址加短码。两边各显示一个由双方证书指纹算出的 6 位比对码，用户确认一致才完成。之后可以换成 CPace 或 SPAKE2+，并绑定 TLS exporter，让中间人拿不到能离线暴力破解的材料 |
| 浏览器（§9） | 手机相机扫码，打开 `https://<托管站点>/v<版本>/#pair=<载荷>`。载荷放在 `#` 后面，不发给任何服务器；之后与原生 App 扫码相同 |
| 服务器互联 | 链接串保持现状，配对完成后加比对码。只有在回环或 HTTPS 下，Web 才显示和接受链接串，否则只能用命令行或 SSH 配对 |
| 新设备或新互联 | 推送给其他已配对设备，并附撤销入口 |

## 6. 授权

| 能力 | 包含 |
| --- | --- |
| `read` | 会话、列表、文件的读取 |
| `chat` | 发消息、新建会话、答复审批 |
| `exec` | 终端、`/api/remote/exec`、`/api/remote/shell`、直接写文件 |
| `admin` | 配对、设备、互联、设置、插件、更新 |

**`chat` 不是安全边界**：Agent 会执行命令，答复审批就是批准命令。拿到 `chat`，就能在 Agent 的审批模式允许的范围内间接执行命令。真正能隔离执行能力的只有「关闭」和 `read` 两级。`exec` 单列，是为了把不经 Agent、不留对话记录的直接执行和对话分开，便于默认关闭和审计。

- 新配对的手机默认 `read` 加 `chat`，`exec` 在配对时勾选。
- 互联的入站分为关闭、`read`、`read+chat`、完整。界面说明 `read+chat` 的代价同上。`admin` 不能经链接授予（与 `links/policy.ts` 一致）。
- 所需能力按路由模式登记在一张表里，没有登记的默认拒绝，用检查脚本拦住漏登记的路由，做法同 `links/policy.ts`。
- 管理操作和首次开终端需要再验证一次：浏览器用 Passkey，原生 App 用生物识别。
- Agent 的 `server:<id>` 工具组拿到的能力，不超过那条链接的入站级别。

## 7. 密钥与审计

- 模型源密钥、APNs 密钥、链接私钥、服务器 TLS 私钥、Cookie 签名密钥放进 Keychain 或 libsecret。只能用文件时用 0600，并由 `riffet doctor` 检查数据目录是否在云盘同步目录里。
- 推送只带 id 和必要的标题，正文由客户端拉取。
- 单独的安全审计流记录：配对、撤销、能力变更、互联变更、开终端、远程执行、经链接的写操作、登录失败、指纹核对失败。只追加，条数上限进 `budgets.ts`。
- 实现：`access/audit.ts` 写数据目录里的 `security-audit.jsonl`（0600），上限 `SECURITY_AUDIT_BUDGET`；`GET /api/security/events` 读，「设置 › 设备」底部的「安全记录」展示。同一来源反复被拒、终端重连只记一次（`repeatWindowMs`）；本机自己开终端不记；经链接的写操作仍记在各链接的记录里（`LinkService.record`）。
- 新设备配对、新的互联服务器：推给其他已配对的 iPhone（前台也显示，标题由 App 本地化，正文是名字），打开着的 Web 弹出提示。
- 现状：Android 没有后台推送，前台也还没有处理列表流的 `security` 事件；Mac 原生客户端同样未处理。

## 8. 跨网络

- 文档推荐 Tailscale 或公司 VPN，Riffet 不需要改动。
- 可选自托管的 `riffet relay`：两端都向外连到中转，中转只拼接字节流，端到端的认证在两端之间完成（Syncthing 中继的做法）。§9 的浏览器连接需要 UDP 直达；跨网络时要么走 VPN，要么中转同时提供 TURN。
- 不做 NAT 穿透，不由项目运营公共中转。

## 9. 待建设：手机浏览器经 WebRTC 直连

不装证书、不需要域名，就让手机浏览器获得加密并双向认证的连接。做法参考 libp2p 的 WebRTC Direct。原型已验证可行（见下）。

**结构**

```
手机浏览器
  https://<项目静态站点>/v<版本>/        网页代码：静态托管、CI 构建、完整性校验
     │ 扫码：地址、UDP 端口、服务器证书指纹、一次性配对密钥（放在 # 后）
     ▼
  RTCPeerConnection（DTLS + ICE，UDP）   每个请求一条 DataChannel
     ▼
服务器：node-datachannel 在一个 UDP 端口上监听（IceUdpMuxListener）
  每条 DataChannel 承载原样的 HTTP/1.1，交给现有 HTTP 服务（emit('connection')），连接上标记设备身份
```

- **不用信令服务器**：浏览器根据二维码里的地址和证书指纹，自己构造对端的 SDP；服务端根据 STUN 请求里的 ufrag 重建浏览器的 offer。
- **双向认证**：浏览器证书的指纹在配对时登记，服务器证书的指纹从二维码固定。连接上不传 Cookie 或令牌，§6 的能力分级照常适用，审计记录写设备名。
- **服务端几乎不改**：做法同互联隧道，路由、SSE、WebSocket 升级都不用改。
- **Web 客户端**：在请求层增加一种传输方式，按网页的加载来源自动选择。与服务器同源时照常请求，从托管站点加载时走 DataChannel，本地 Web 和 Mac App 不受影响。用 URL 直接引用的资源（图片、预览 iframe、下载）由托管站点的 Service Worker 转交页面经通道取回；沙箱 iframe 不受 Service Worker 管辖，改为取回后用 blob 加载。
- **托管站点**：每个版本放在固定路径下，发布后不再修改；页面和脚本带完整性校验，CSP 只允许同源脚本。服务器在二维码里给出自己的版本，网页加载对应版本。用户也可以把这份静态文件放到自己的 HTTPS 静态站点，并在服务器上设置这个地址。托管站点被攻破，会影响所有用这种方式访问的浏览器，信任程度与从应用商店装 App 相当。
- **服务端资源**：一个固定的 UDP 端口，进 `budgets.ts`；未完成核对的连接数和每个来源的重试频率都设上限。

**依赖**（2026-11-25 npm 数据）

| 选择 | 大小 | 结论 |
| --- | --- | --- |
| `node-datachannel`（libdatachannel） | JS 1.1 MB，加上本平台的预编译二进制 8.5 到 9.1 MB；Linux 上安装后 `node_modules` 共 9.9 MB | 首选，原型用的就是它 |
| `werift`（纯 TypeScript） | 12.5 MB，另依赖 12 MB 的 `mediabunny` | 备选 |
| `@roamhq/wrtc`（libwebrtc） | 每个平台约 25 MB | 不用 |

浏览器端只用浏览器自带的 `RTCPeerConnection`，不引入第三方依赖。

**原型验证（2026-11-25）**

服务端：Linux devbox 上的 Node 24.20，node-datachannel 0.33.6（libdatachannel 0.24.6）。客户端：Mac 上的 Chrome（headless），以及 iOS 模拟器里的 Safari 26.5。网页只拿到地址、UDP 端口和服务器证书指纹，没有信令。

| 项目 | 结果 |
| --- | --- |
| 自行构造 SDP，服务端按 ufrag 接住来访连接 | Chrome 和 iOS Safari 都连通。DataChannel 上原样的 HTTP/1.1 请求由普通的 Node `http.Server` 应答 |
| 建立连接耗时 | 回环 183 ms；经 VPN 到 devbox，Chrome 466 到 607 ms，iOS Safari 386 ms |
| 往返延迟 | 经 VPN 到 devbox p50 约 48 ms。同一路径上 TCP 的 HTTP keep-alive 是 p50 52 ms、p95 745 ms，延迟来自路径本身，WebRTC 没有额外开销 |
| 服务器指纹不符 | 浏览器连接失败 |
| 浏览器证书未配对 | 服务端读 `remoteFingerprint()`，不符即关闭，不处理任何 DataChannel |
| UDP 可达 | Mac 经公司 VPN 到 devbox 的 UDP 可达 |

实现时要照做：

- **DTLS 角色**：服务端重建的浏览器 offer 必须写 `a=setup:active`，服务端作为应答方才会成为 DTLS 服务器，与浏览器构造的应答里的 `a=setup:passive` 一致。写成 `actpass` 时，两端都当 DTLS 客户端，握手报 `unexpected message`。
- **字节流**：node-datachannel 自带的 `DataChannelStream` 以对象模式推出字符串，交给 Node 的 HTTP 解析器时进程会断言崩溃。要自己包一层只推 Buffer 的 Duplex（与 `links/tunnel.ts` 的 `plain()` 同一类问题）。
- **证书核对**：服务端重建的 offer 里没有浏览器的真实指纹，只能关闭 DTLS 层的指纹校验，改为连上后用 `remoteFingerprint()` 核对。核对通过之前不处理任何 DataChannel；被拒的浏览器会用同一个 ufrag 重试，要限流。
- **多网卡**：服务器有多块网卡时，绑 `0.0.0.0` 会让回包从另一个地址发出，Chrome 按 peer-reflexive 候选接受了。应绑定二维码里给出的地址，Safari 未测这种情况。
- **监听器只建一次**：同一进程里对同一端口 `stop()` 后再注册 `IceUdpMuxListener`，在 Linux 上失败，所以监听器要在进程生命周期内只建一次。

**仍未验证**

1. Android 真机 Chrome（与桌面 Chrome 同一内核，风险低）。
2. 手机经办公 Wi-Fi 直连服务器的路径：原型里 Mac 走的是 VPN 隧道，手机的网络路径和 UDP 策略可能不同。
3. Chrome「本地网络访问」策略：真实的公网 HTTPS 页面访问内网地址时会不会弹授权。原型用的是本机伪造的 HTTPS 源，测不出来。

**估计**：服务端约 1 周；Web 传输层与 Service Worker 1 到 2 周；静态站点发布与配对界面几天。

## 10. 考虑过、不采用的方案

| 方案 | 不采用的原因 |
| --- | --- |
| 明文 HTTP 下发网页，在网页里做加密（密钥扫码获得） | 只能挡被动窃听。网页代码本身可以被中间人替换 |
| 自签名证书，让用户点「继续访问」 | 用户会习惯性跳过警告，有人冒充时分辨不出来 |
| 项目提供子域名和自动证书（Unraid `myunraid.net`、libp2p AutoTLS、Plex `plex.direct` 的做法） | 公司 DNS 会拦截解析到内网 IP 的公网域名（2026-11-25 在公司网络实测不通）；运营方能为用户的名字另签证书；项目要长期运营 DNS 服务 |
| 每台服务器自带根证书，并用名称约束限定范围 | 每台设备要为每台服务器装一次；Android 装用户 CA 后常驻「网络可能受到监控」提示；受公司管理的设备可能不允许装。浏览器只是退路，代价不值得 |
| 要求用户自备域名 | 不能把域名作为使用前提 |
| 明文浏览器保留 `chat` 作为默认 | `chat` 能借 Agent 执行命令（§6），等于把执行权交给中间人 |
| 应用层端到端加密（Happy 的做法） | Happy 的数据存在第三方运营的服务器上；Riffet 的服务器归用户自己，服务器就是端点，传输层加密已经足够 |

## 11. 迁移

- **服务器**：升级后自动生成 P-256 密钥和证书；现有互联不受影响。
- **原生客户端**：新版 App 连到新版服务器时，提示重新扫一次码，完成 TLS 配对。之前的 bearer 令牌在宽限期内只保留 `read` 和 `chat`，宽限期过后作废。旧版 App 仍可经明文 HTTP 连接，按 §4 限权。
- **能力**：已有设备迁移时按现在的实际权限（全部能力）保留，在设备列表里提示收窄；新配对的设备按 §6 的默认值。
- **协议**：新能力用 `ProtocolInfo` 的特性位声明（例如 `transport-tls-v1`、`webrtc-direct-v1`），客户端按特性位决定是否走新路径。

## 12. 分期

| 期 | 内容 |
| --- | --- |
| P0 | 路由能力表与检查脚本（先只区分 `read`、`chat`、`exec`、`admin` 四类）；明文浏览器会话按 §4 限权；链接串只在回环或 HTTPS 下显示和接受；互联加比对码；新设备推送提醒；HTTPS 下 Cookie 改用 `__Host-` 前缀；安全审计流（已完成） |
| P1 | 服务器 P-256 证书与同端口分流；原生客户端证书固定与 mTLS，设备私钥放进安全硬件（先做 iOS `SecIdentity` 小样）；扫码配对，手输配对加比对码（要先有设备证书才算得出）；迁移（§11）；Mac 浏览器经本机转发访问对端 |
| P2 | 按设备、按链接授予能力，再次验证；互联入站分级；密钥轮换；各类密钥放进 Keychain |
| P3 | 手输短码改用 PAKE；自托管中转 |
| 待建设 | §9 手机浏览器经 WebRTC 直连：先补完「仍未验证」的三项 |

## 参考

- Syncthing BEP：<https://docs.syncthing.net/specs/bep-v1.html>，中继：<https://docs.syncthing.net/specs/relay-v1.html>
- LocalSend 协议：<https://github.com/localsend/protocol>
- Happy 加密说明：<https://github.com/slopus/happy/blob/main/docs/encryption.md>
- libp2p WebRTC（浏览器到服务器）：<https://blog.libp2p.io/libp2p-webrtc-browser-to-server/>，浏览器连通性：<https://libp2p.io/docs/browser-connectivity/>
- Unraid 连接安全：<https://docs.unraid.net/unraid-os/system-administration/secure-your-server/securing-your-connection/>
- node-datachannel：<https://github.com/murat-dogan/node-datachannel>
