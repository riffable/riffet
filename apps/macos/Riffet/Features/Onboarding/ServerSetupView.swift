import ServiceManagement
import SwiftUI

/// Shown when no local server answers: start one here, start the existing login service, or pair
/// with a server on another machine. The decision table is docs/MACOS.md, "启动时的判定".
struct ServerSetupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var busy = false
    @State private var showRemote = false

    /// Why the last start did not work: the server host keeps it until the next attempt.
    private var failure: String? {
        if case let .failed(message) = model.server.state { message } else { nil }
    }

    var body: some View {
        VStack(spacing: 22) {
            Image(icon: "server.rack")
                .font(.riffet(size: S(40), weight: .light))
                .foregroundStyle(palette.fg3)
            VStack(spacing: 6) {
                Text("本机的 Riffet 服务器没有运行").font(.title2.weight(.semibold))
                Text(detail).font(RiffetFont.label).foregroundStyle(palette.fg3).multilineTextAlignment(.center)
            }
            .frame(maxWidth: 460)

            if let failure {
                VStack(spacing: 8) {
                    Text(failure).font(RiffetFont.caption).foregroundStyle(palette.danger).multilineTextAlignment(.center)
                        .textSelection(.enabled)
                    HStack(spacing: 12) {
                        Button("打开 server.log") { model.server.openLog() }
                        if model.server.appAgentStatus == .requiresApproval {
                            Button("打开登录项设置") { SMAppService.openSystemSettingsLoginItems() }
                        }
                    }
                    .buttonStyle(.link)
                }
                .frame(maxWidth: 460)
            }

            HStack(spacing: 10) {
                Button {
                    run { await model.startServer() }
                } label: {
                    Text(primaryTitle).frame(minWidth: 140)
                }
                .buttonStyle(SolidButtonStyle(kind: .primary))
                .controlSize(.large)
                .disabled(busy || !(model.server.hasLoginService || model.server.canHostServer))

                Button("重新检测") {
                    model.server.clearFailure()
                    run { await model.connectLocal() }
                }
                    .controlSize(.large)
                    .disabled(busy)
            }
            if busy { Spinner(size: .small) }

            Button("连接服务器…") { showRemote = true }
                .buttonStyle(.link)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $showRemote) { RemotePairingSheet() }
    }

    private var detail: String {
        if model.server.hasLoginService {
            String(localized: "已安装登录服务 local.riffet，但它现在没有运行。启动它即可继续使用。")
        } else if model.server.canHostServer {
            String(localized: "Riffet 可以替你托管服务器：登录后自动运行，关闭窗口后 Agent 继续工作。也可以在终端执行 riffet start。")
        } else {
            String(localized: "这个构建没有内置服务器。在终端执行 riffet start 启动服务器后点「重新检测」。")
        }
    }

    private var primaryTitle: String {
        if failure != nil { return String(localized: "重试") }
        return model.server.hasLoginService ? String(localized: "启动登录服务") : String(localized: "由 Riffet 托管服务器")
    }

    private func run(_ action: @escaping () async -> Void) {
        busy = true
        Task {
            await action()
            busy = false
        }
    }
}

struct ConnectionFailedView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    let message: String
    @State private var showRemote = false

    var body: some View {
        VStack(spacing: 16) {
            Image(icon: "exclamationmark.triangle")
                .font(.riffet(size: S(34), weight: .light))
                .foregroundStyle(palette.warning)
            Text("无法连接 Riffet").font(.title2.weight(.semibold))
            Text(message).font(RiffetFont.label).foregroundStyle(palette.fg3).multilineTextAlignment(.center).frame(maxWidth: 480)
                .textSelection(.enabled)
            HStack {
                Button("重试") { Task { await model.start() } }.buttonStyle(SolidButtonStyle(kind: .primary))
                Button("连接本机") { Task { await model.connectLocal() } }
                Button("连接服务器…") { showRemote = true }
            }
            .controlSize(.large)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $showRemote) { RemotePairingSheet() }
    }
}

/// Pairs with a server on any reachable machine: its address and the five-minute code `riffet pair`
/// prints there. The payload that command (and its QR code) encodes can be pasted into the address.
struct RemotePairingSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var address = ""
    @State private var code = ""
    /// The name the payload carried and the address it filled in; a name of another address is not kept.
    @State private var payloadName: String?
    @State private var payloadAddress: String?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("连接服务器").font(.title3.weight(.semibold))
            Text("在服务器上执行 riffet pair 获取配对码。")
                .font(RiffetFont.caption).foregroundStyle(palette.fg3)
                .fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("地址", text: $address, prompt: Text(verbatim: "192.168.1.10:4337"))
                    .formField(label: "地址")
                    .onChange(of: address) { _, value in applyPayload(value) }
                TextField("配对码", text: $code)
                    .formField(label: "配对码")
            }
            .riffetForm()
            if let error { Text(error).font(RiffetFont.caption).foregroundStyle(palette.danger) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("配对") {
                    busy = true
                    error = nil
                    Task {
                        do {
                            try await model.pairRemote(
                                address: address,
                                code: code.trimmingCharacters(in: .whitespaces),
                                name: address == payloadAddress ? payloadName : nil
                            )
                            dismiss()
                        } catch {
                            self.error = error.riffetMessage
                        }
                        busy = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(busy || address.isEmpty || code.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private func applyPayload(_ raw: String) {
        guard let payload = PairingPayload(parsing: raw) else { return }
        address = payload.address
        code = payload.code
        payloadAddress = payload.address
        payloadName = payload.name
    }
}
