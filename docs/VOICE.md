# 语音输入

在输入框里说话，文字进输入框。转写在服务端完成；识别方式由用户在设置里选：远端服务，或从插件页安装的本机模型。

## 1. 已定

| 项 | 决定 |
|---|---|
| 转写位置 | 服务端。客户端只录音，各端共用同一套识别与设置 |
| 远端服务 | 任意 OpenAI 格式的 `/v1/audio/transcriptions`：地址、Key、模型由用户填写，不预设厂商 |
| 本机识别 | 可选安装：引擎与模型都由用户在设置里下载，服务端默认不带任何语音依赖 |
| 本机模型 | 流式 Zipformer（中英双语，约 190 MB）与 SenseVoice（中英日韩粤，约 228 MB）两个 |
| 客户端 | Web（含手机浏览器）、Android、iPhone；Mac 随后 |

## 2. 分工

```
客户端 ── 录音（16 kHz 单声道 PCM16）──► 核心：听写会话 ──► 识别器（扩展点）
                                                              ├─ 远端服务（核心内置）
                                                              └─ 本机识别（内置插件，引擎与模型按需下载）
```

- **核心**：听写的 WebSocket、会话生命周期与预算、远端服务实现、设置项、各端输入框的录音与界面。
- **扩展点 `speechRecognizers`**：识别器在一次听写里收 PCM、发部分结果与最终结果。远端服务和本机识别都是它的实现，核心不知道具体引擎。
- **内置插件「本机识别」**（`plugins/riffet/` 下的 `speech-local`）：随构建分发的只有它自己的代码；sherpa-onnx 运行时和模型在用户点安装时按服务器平台下载到插件数据目录（`<stateDir>/plugin-data/<id>/`）。插件进程内执行，所以能拉起子进程，也不受隔离进程 256 MB 堆的限制。

不做成独立安装包：独立包不区分平台，sherpa-onnx 的运行时却是每个平台一份原生库；隔离进程加载原生库还要额外授权。按需下载同样能做到「不装不占空间」。

## 3. 识别器

类型在 `packages/plugin-api/src/index.ts`（`SpeechRecognizer`、`SpeechSession`），插件以 `Contributions.speechRecognizer` 提供，并在清单里声明 `contributes.speechRecognizer: { title }`。它是拟议成员（`PROPOSED_CONTRIBUTIONS`），只给进程内的包：

```ts
interface SpeechRecognizer {
  /** 不能用时的原因原样显示给用户。 */
  status(): { ready: true; streaming: boolean } | { ready: false; reason: string };
  open(options: { language?: string; signal: AbortSignal; onPartial(segments: SpeechSegment[]): void }): SpeechSession;
}

interface SpeechSession {
  append(pcm: Int16Array): void;
  /** 录音结束，等全文；空字符串表示没说话。 */
  finish(): Promise<string>;
}

/** 一句话一个片段。`final` 的片段不再变；最后一个片段可能仍在变化。 */
interface SpeechSegment { text: string; final: boolean }
```

`status` 与 `open` 由注册表加了时限（10 秒、30 秒）。远端服务是核心里的同一接口实现（`apps/server/src/dictation/remote.ts`）。

三种行为：

| 识别方式 | 说话时 | 停下后 |
|---|---|---|
| 远端服务 | 只显示录音状态 | 整段上传，一次返回全文 |
| 本机，只装 Zipformer | 逐字出现 | 立即完成 |
| 本机，只装 SenseVoice | 用语音活动检测（Silero VAD，0.6 MB，随引擎下载）切句，每句说完出现；`streaming` 为 false，但每句仍经 `onPartial` 送出 | 最后一句转写完成 |
| 本机，两个都装 | Zipformer 逐字出现；每句说完由 SenseVoice 重写该句 | 最后一句重写完成 |

两个都装时自动走两遍识别，不另设选项：装了哪个模型就决定了行为。

## 4. 协议

`GET /api/dictation/ws`（WebSocket），沿用现有登录；登录被撤销时断开（同终端的 `auth.onRevoke`）。听写不属于某个会话，只要求已登录。

- 客户端 → 服务端：
  - 文本帧 `{ type: 'start', language? }` 打开一次听写；`{ type: 'finish' }`；`{ type: 'cancel' }`。
  - 二进制帧：PCM16LE，16 kHz 单声道，每帧 100 ms（3200 字节）。不用 base64。
- 服务端 → 客户端：
  - `{ type: 'ready', streaming }`
  - `{ type: 'partial', segments }`：整段替换，不发增量，客户端不用拼接。
  - `{ type: 'final', text }`，随后服务端关闭这次听写。
  - `{ type: 'error', code, retryable }`
- 一条连接同时只有一次听写；一个用户同时最多两条连接，超出拒绝。
- 单次时长、单帧大小、空闲超时都取自 `packages/contracts/src/budgets.ts` 新增的 `DICTATION_BUDGET`，到上限时服务端按 `finish` 收尾，不丢弃已说的内容。
- 远端服务：服务端把 PCM 留到 `finish`，封装成 WAV 上传。上限是单次时长对应的大小（5 分钟约 9.6 MB）。
- 失败重试：客户端保留本次录音的 PCM（同一上限）。可重试的错误或断线后，录音栏给「重试」，用新连接把整段重发（按非流式处理）；取消或完成后立即释放。

## 5. 本机识别插件

插件页（[插件界面](design/system/plugins.md)）分两组，下载期间页面带 `refreshMs` 刷新进度：

- **引擎**：sherpa-onnx 运行时。状态、版本、占用空间；「安装」「删除」。
- **模型**：Zipformer 约 190 MB、SenseVoice 约 228 MB，各一行；「下载」「删除」，下载中显示进度，可取消。

运行时：

- 下载 npm 上固定版本（1.13.8）的 `sherpa-onnx-node` 和本平台的 `sherpa-onnx-<os>-<arch>` 两个包（darwin-arm64 装好约 33 MB），核对写死的 sha512 后用系统 `tar` 解到 `engine/<版本>/node_modules/`。两个包并排放，`sherpa-onnx-node` 按相对路径找到平台包，动态库用 `@loader_path`，不需要设库路径。
- 模型按文件下载，逐个核对写死的 sha256（`pins.ts`）。Zipformer 用 int8 的编码器与 joiner 加浮点解码器；SenseVoice 用 2024-07-17 的 int8 模型，2025-09-09 的重打包不出标点和数字。先写临时目录，校验通过后改名，半途失败不留残件；插件启动时清掉中断留下的临时目录。
- 识别跑在一个子进程里：`process.execPath -e <worker 源码>`，worker 源码是插件里的字符串常量（服务端打成单个 bundle，旁挂文件要另做打包），经 IPC（advanced 序列化）收发音频。worker 从数据目录加载 sherpa-onnx。解码不占服务主线程，引擎崩溃也不影响服务。
- 断句：Zipformer 的句末静音阈值 1.2 秒（0.8 秒会在正常停顿处断开）；第二遍识别去掉句首静音；只用 SenseVoice 时每句向前多取 0.3 秒，避免首字被切。Zipformer 输出的英文是大写，统一转小写。Zipformer 不出标点：只装它时，停顿断出的句子末尾补逗号，录音结束时最后一句改成句号（英文用 `,` `.`）；标点跟着停顿而不是语义，只为不连成一片。
  - 所有者：插件。
  - 拉起：第一次听写时；同一时刻只有一个 worker，多次听写在其中并行。
  - 回收：空闲超过 `DICTATION_BUDGET` 的时长后退出；插件停用、删除引擎或模型、服务关闭时立即结束。
- 下载源：模型来自 Hugging Face，运行时来自 npm registry。国内网络可能需要镜像，见 §9。

## 6. 设置

放在「行为 › 输入」页，新增「语音输入」一组，每项一行：

| 行 | 内容 |
|---|---|
| 识别方式 | 关闭（默认）/ 语音识别服务 / 各插件的识别器（本机语音识别） |
| 地址、API Key、模型 | 选远端服务时出现。Key 只写不回显；行下一句「录音会发送到这个地址」 |
| 本机模型 | 选了插件的识别器时出现，点击进入插件页 |
| 语言 | 自动（默认）或指定；交给识别器作提示 |

- 设置存在服务端（`AppSettings.voiceInput`），Key 和其他设置一起存在权限 600 的 settings.json 里，读取时只回 `hasApiKey`；所有设备共用。
- 「识别方式」列出所有声明了 `contributes.speechRecognizer` 的插件，开着关着都列。本机插件默认关闭，选它时开启；「本机模型」一行打开插件页。

## 7. Web 输入框

- **入口**：左侧工具组的麦克风按钮，样式同附件按钮。识别方式为「关闭」或识别器不可用时不显示，所以默认没有新的常驻按钮（[设计决定](design/DECISIONS.md) 2026-11-12）。
- **录音中**：
  - 工具行换成录音栏：计时、音量波形、取消、完成。
  - 定下来的句子写进输入框光标处；仍在变的那句只显示在录音栏里（文本框不能给一段文字单独着色），放不下时裁掉开头。输入框里原有的文字不动；有选区时替换选区。录音期间文本框只读。
  - 远端服务没有中途结果，只显示录音栏。
- **结束**：
  - 完成：等最终结果，文字留在输入框，光标放在末尾，可以继续改或照常发送。
  - 取消：撤掉这次插入的文字，回到开始前的内容。
  - Esc 等于取消，Enter 等于完成（[COMPOSER.md](COMPOSER.md) §3.3 的 Escape 分层里排在最内层）。
- **快捷键**：开始录音的全局快捷键还没做，之后进入 `hostShortcuts`。
- **触屏**（手机浏览器与 §7.1 的 App）：麦克风改成语音模式的开关，在语音模式里按住「按住 说话」录音，松手写进草稿，上滑取消；轻点进入上面的录音栏，手离开也继续录。规则见 [界面](design/system/surfaces.md)「语音输入（触屏）」，实现在 `session/HoldToTalk.tsx`。
  - 语音模式存在浏览器本地（`riffet.composer.voice-mode`）；只在手机布局且是触屏时提供，桌面仍是点按开始。
  - 按下时捕获指针，浮层不接收触摸，手指在页面上怎么移动都还由长条处理。按住期间写进草稿的句子不会让长条换位置。
  - 页面切到后台或屏幕锁定时按「完成」收尾。
  - 来电等音频中断时停止并保留已有文字。
- **失败**：录音栏显示原因与「重试」「放弃」。重试用保留的录音重新转写；放弃即释放录音。
- **麦克风权限**：首次点按时由浏览器询问。被拒绝时，录音栏写明需要在浏览器设置里允许麦克风。

### 录音实现

- `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`。
- 采集用 AudioWorklet，在 worklet 里重采样到 16 kHz 并转 PCM16，每 100 ms 交给主线程发送。不用已弃用的 ScriptProcessor。
- AudioContext 在点按的事件处理里创建或恢复（iOS Safari 的要求）。
- 音量取每帧的 RMS，驱动波形，不另开分析节点。

### HTTPS

浏览器只在 HTTPS 或 localhost 下开放麦克风。用 `http://` 访问（例如 Tailscale 直连 IP）时麦克风不可用：入口照常显示，点按后录音栏写明麦克风只能在 HTTPS 地址下使用。配置方法见 [远程访问](guide/remote-access.md) 的 HTTPS 一节（`tailscale serve` 或反向代理）。

## 7.1 手机 App

Android 与 iPhone 按 §7 的触屏交互做（语音模式、按住说话、轻点进录音栏），录音栏的布局与 Web 相同（手机宽度：16 根波形）。按住的浮层：Android 是不抢焦点的 `Popup`（`HoldToTalk.kt`），iPhone 是单独一层不接收触摸的 `UIWindow`（`RiffetVoiceHold.swift`），失败时才接收触摸，好点「重试」「放弃」。语音模式存在 `AppPreferences`（`ComposerVoiceMode`）。录音与界面之外的部分在 `:client` 里共用一份：`DictationController`（`apps/mobile/client/.../ui/composer/Dictation.kt`）管连接、状态、写入草稿、重试和 5 分钟上限，各端只实现 `DictationMicrophone`。

- **入口**：设置里选了识别方式才出现语音模式开关（读 `AppSettings.voiceInput`）。手机上不能改语音设置，要在 Web 里设。
- **录音**：Android 用 `AudioRecord`（`VOICE_RECOGNITION` 音源，直接 16 kHz）；iPhone 用 `AVAudioEngine` 加 `AVAudioConverter` 转成 16 kHz。音量都取每帧 RMS，和 Web 同一刻度。
- **权限**：第一次录音时由系统询问；拒绝后录音栏写明要在系统设置里允许。App 录音不要求 HTTPS。
- **中断**：App 进入后台、来电或别的 App 占用麦克风时，按「完成」收尾（`DictationSink.interrupted`）。
- 硬件键盘：Enter 完成、Esc 取消，与 Web 相同。

## 8. 预算

`DICTATION_BUDGET`（`packages/contracts/src/budgets.ts`）：

| 键 | 值 | 说明 |
|---|---|---|
| `maxDurationMs` | 5 分钟 | 单次听写；也是客户端保留录音的上限 |
| `frameBytes` | 3200 | 100 ms PCM16；超出的帧断开连接 |
| `maxConnectionsPerUser` | 2 | 同一用户的并发听写连接 |
| `idleTimeoutMs` | 30 秒 | 听写中这么久没有音频帧即收尾 |
| `workerIdleMs` | 10 分钟 | 本机 worker 空闲后退出 |
| `remoteTimeoutMs` | 60 秒 | 远端转写请求 |
| `finishTimeoutMs` | 2 分钟 | 录音结束到出文字；超时按可重试的失败结束 |

## 9. 验证情况

已验证（2026-11-17，macOS arm64）：
- 服务端协议：开始、帧、完成、取消；远端服务连不上时报可重试的错误；插件不存在时报不可重试的错误；设置接口不回 Key。
- Web：Chrome 里 AudioWorklet 采集、远端服务、只装 Zipformer、两个都装、取消恢复原文、手机宽度的录音栏。
- 插件：引擎与模型下载、校验、进度、两次听写之间互不影响；两个都装时中英混说的例子（「我们今天要修复web socket的问题。」）。

待验证：
- Linux：预编译库要求的 glibc 版本未测；插件只区分有没有 glibc，musl（Alpine）写明不支持。
- Mac App：下载的动态库未签名；随包的 node 带 `disable-library-validation`，应能加载，要在正式包里确认。
- iOS Safari：AudioWorklet、后台切换和来电中断的实际行为。
- Android 与 iPhone App：共用的 `DictationController` 已用真实服务端验证（完成、取消、中断、失败后重试、权限被拒、5 分钟上限）。按住说话在 Android 模拟器上验证过（会话页与首页）：切换语音模式、按住出浮层、松手写入草稿、上滑取消草稿不变、轻点转录音栏；模拟器的话筒是假的。iPhone 只编译通过；两端真机录音、权限弹窗、震动与 iPhone 的按住手势未验证。
- 手机浏览器的按住说话：在无头 Chrome 的手机模拟（触屏、假麦克风）里验证过新会话页的切换、按住、上滑取消、松手写入和轻点转录音栏；真机浏览器未试。
- Hugging Face 与 npm 在国内的可达性：测试中各断过一次、重试成功；不稳定时再考虑插件页加镜像地址。
- 准确率：Zipformer 的英文较弱；两遍识别偶有漏字（例：「today」成了「day」）。

## 10. 分期

1. **P1 核心与远端服务**（2026-11-17 完成）：扩展点、WebSocket、预算、设置、Web 输入框的录音与界面。界面按流式设计，远端服务只是没有中途结果。
2. **P2 本机识别插件**（2026-11-17 完成）：引擎与两个模型的下载，worker，流式与两遍识别。
3. **P3 手机 App**（2026-11-17 完成，真机待验证）：Android（AudioRecord）、iPhone（AVAudioEngine），协议不变。
4. **P4 Mac App 与手机上的语音设置**。

每期改动界面时，按 [设计体系](design/system/README.md) 先在组件文档里补「录音栏」一节和设计规范页样张。

## 11. 参考

Paseo（Apache-2.0）的听写做法：服务端转写，客户端以 16 kHz PCM16 推流，带序号与确认，失败后保留录音重试。我们沿用转写位置、统一音频格式和失败重试；不沿用的是 base64 传音频、只追加到末尾、不显示中途结果、录音时长无上限，以及近二十个模型的目录。
