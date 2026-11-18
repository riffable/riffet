import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI

/// A dialog over the bot pages: scan a new bot in, scan an existing one again, retype its
/// credentials, or read a bind code.
enum ChannelSheet: Identifiable {
    case add
    case reauthorize(ChannelAccount)
    case replace(ChannelAccount)
    case bind(ChannelAccount)

    var id: String {
        switch self {
        case .add: "add"
        case let .reauthorize(account): "reauthorize-\(account.id)"
        case let .replace(account): "replace-\(account.id)"
        case let .bind(account): "bind-\(account.id)"
        }
    }
}

enum QRCode {
    private static let context = CIContext()

    static func image(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }
}

/// One line of a checklist: a state mark, what it is, why it failed, and the action that fixes it.
struct ChannelCheckRow<Action: View>: View {
    enum Mark { case ok, bad, todo, busy }

    let mark: Mark
    let title: String
    var detail: String?
    @ViewBuilder var action: Action
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            icon.frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.riffet(size: S(13))).foregroundStyle(palette.fg)
                if let detail {
                    Text(detail)
                        .font(.riffet(size: S(11.5)))
                        .foregroundStyle(palette.fg3)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Space.sm)
            action
        }
    }

    @ViewBuilder
    private var icon: some View {
        switch mark {
        case .ok: Image(icon: "checkmark.circle.fill").foregroundStyle(palette.success)
        case .bad: Image(icon: "exclamationmark.circle.fill").foregroundStyle(palette.danger)
        case .todo: Image(icon: "circle").foregroundStyle(palette.fg4)
        case .busy: Spinner(size: .mini)
        }
    }
}

extension ChannelCheckRow where Action == EmptyView {
    init(_ mark: Mark, _ title: String, detail: String? = nil) {
        self.init(mark: mark, title: title, detail: detail) { EmptyView() }
    }
}

/// A fresh bind code for one bot, and the one line that says what to do with it.
struct ChannelBindCodeView: View {
    let accountId: String
    @State private var code: ChannelBindCode?
    @State private var expired = false
    @State private var busy = false
    @State private var error: String?
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: Space.sm) {
            if let code {
                HStack(spacing: Space.sm) {
                    Text(code.code)
                        .font(.riffet(size: S(28), weight: .semibold, design: .monospaced))
                        .foregroundStyle(palette.fg)
                        .opacity(expired ? 0.3 : 1)
                        .textSelection(.enabled)
                    CopyButton(text: code.code, help: String(localized: "复制"))
                }
                Text(expired ? String(localized: "已过期") : String(localized: "有效至 \(expiry(code))"))
                    .font(.riffet(size: S(11.5)))
                    .foregroundStyle(palette.fg3)
                Text("在飞书私聊机器人发送 /bind \(code.code)")
                    .font(.riffet(size: S(12.5)))
                    .foregroundStyle(palette.fg2)
                    .textSelection(.enabled)
                if expired { SettingsActionButton("重新生成", symbol: "arrow.clockwise") { Task { await generate() } }.disabled(busy) }
            } else if busy {
                Spinner(size: .small)
            }
            SettingsErrorText(message: error)
        }
        .frame(maxWidth: .infinity)
        .task { await generate() }
        .task(id: code?.code) {
            guard let date = ServerTime.date(code?.expiresAt) else { return }
            try? await Task.sleep(for: .seconds(max(0, date.timeIntervalSinceNow)))
            if !Task.isCancelled { expired = true }
        }
    }

    private func expiry(_ code: ChannelBindCode) -> String {
        ServerTime.date(code.expiresAt)?.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) ?? code.expiresAt
    }

    private func generate() async {
        busy = true
        error = nil
        do {
            let next = try await ChannelsAPI.bindCode(accountId)
            code = next
            expired = (ServerTime.date(next.expiresAt) ?? .distantFuture) <= .now
        } catch {
            self.error = error.riffetMessage
        }
        busy = false
    }
}

struct ChannelBindSheet: View {
    let account: ChannelAccount
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("可以使用的人").font(.title3.weight(.semibold))
            ChannelBindCodeView(accountId: account.id)
            HStack {
                Spacer()
                Button("完成") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 400)
    }
}

/// Scan the QR or type the credentials, then watch the bot come up.
struct ChannelAddSheet: View {
    enum Mode {
        case add
        case reauthorize(ChannelAccount)
        case replace(ChannelAccount)

        var account: ChannelAccount? {
            switch self {
            case .add: nil
            case let .reauthorize(account), let .replace(account): account
            }
        }
    }

    private enum Step: Equatable {
        case scan, manual
        case progress(accountId: String, manual: Bool)
    }

    let mode: Mode
    let model: ChannelsModel
    @Environment(\.dismiss) private var dismiss
    @State private var step: Step

    init(mode: Mode, model: ChannelsModel) {
        self.mode = mode
        self.model = model
        let kind = mode.account?.kind ?? model.state?.newBotKind ?? "feishu"
        self.kind = kind
        if case .replace = mode { _step = State(initialValue: .manual) }
        else { _step = State(initialValue: model.state?.scannable(kind) == false ? .manual : .scan) }
    }

    /// A new bot is for the platform a plugin provides; an existing one stays on its own.
    private let kind: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title3.weight(.semibold))
            switch step {
            case .scan:
                ChannelScanStep(
                    kind: kind,
                    appId: mode.account?.appId,
                    canType: { if case .add = mode { true } else { false } }(),
                    onType: { step = .manual },
                    onCancel: { dismiss() },
                    onDone: { id in
                        Task { await model.reload() }
                        step = .progress(accountId: id, manual: false)
                    }
                )
            case .manual:
                ChannelManualStep(kind: kind, account: mode.account, onCancel: { dismiss() }) { account in
                    Task { await model.reload() }
                    if case .replace = mode { dismiss() } else { step = .progress(accountId: account.id, manual: true) }
                }
            case let .progress(accountId, manual):
                ChannelProgressStep(accountId: accountId, manual: manual, model: model, onClose: { dismiss() })
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private var title: String {
        switch (mode, step) {
        case (.replace, .manual): String(localized: "更换凭据")
        case (.reauthorize, .scan): String(localized: "重新扫码授权")
        default: String(localized: "添加飞书机器人")
        }
    }
}

private struct ChannelScanStep: View {
    let kind: String
    let appId: String?
    let canType: Bool
    let onType: () -> Void
    let onCancel: () -> Void
    let onDone: (String) -> Void
    @State private var registration: ChannelRegistration?
    @State private var qr: NSImage?
    @State private var expired = false
    @State private var error: String?
    @State private var attempt = 0
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: Space.md) {
            if let registration {
                if let qr {
                    Image(nsImage: qr)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 180, height: 180)
                        .padding(Space.lg)
                        .background(.white, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.lineSoft))
                        .opacity(expired ? 0.3 : 1)
                }
                Text("用飞书扫码").font(.riffet(size: S(13))).foregroundStyle(palette.fg)
                Button("在浏览器中打开") {
                    if let url = URL(string: registration.url) { NSWorkspace.shared.open(url) }
                }
                .buttonStyle(.link)
                if expired {
                    SettingsActionButton("重新生成", symbol: "arrow.clockwise", kind: .primary) { attempt += 1 }
                } else if let date = ServerTime.date(registration.expiresAt) {
                    Text("有效至 \(date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)))")
                        .font(.riffet(size: S(11.5)))
                        .foregroundStyle(palette.fg3)
                }
            } else if error == nil {
                Spinner(size: .small).frame(height: 180)
            } else {
                SettingsActionButton("重试", symbol: "arrow.clockwise") { attempt += 1 }
            }
            SettingsErrorText(message: error)
            HStack {
                if canType { Button("手动填写", action: onType) }
                Spacer()
                Button("取消", action: onCancel).keyboardShortcut(.cancelAction)
            }
        }
        .frame(maxWidth: .infinity)
        .task(id: attempt) { await run() }
    }

    /// One registration per attempt; leaving cancels it on the server unless it finished.
    private func run() async {
        registration = nil
        qr = nil
        expired = false
        error = nil
        let created: ChannelRegistration
        do { created = try await ChannelsAPI.createRegistration(kind: kind, appId: appId) } catch {
            if !Task.isCancelled { self.error = error.riffetMessage.isEmpty ? String(localized: "无法生成二维码") : error.riffetMessage }
            return
        }
        guard !Task.isCancelled else {
            Task { await ChannelsAPI.deleteRegistration(created.id) }
            return
        }
        registration = created
        qr = QRCode.image(created.url)
        let expiry = ServerTime.date(created.expiresAt)
        var finished = false
        while !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(2)) } catch { break }
            if let expiry, expiry <= .now { expired = true; break }
            guard let next = try? await ChannelsAPI.registration(created.id) else { continue }
            if next.state == "done", let id = next.accountId { finished = true; onDone(id); break }
            if next.state == "expired" || next.state == "cancelled" { expired = true; break }
            if next.state == "failed" {
                error = next.error ?? String(localized: "授权失败")
                expired = true
                break
            }
        }
        if !finished { Task { await ChannelsAPI.deleteRegistration(created.id) } }
    }
}

private struct ChannelManualStep: View {
    let kind: String
    let account: ChannelAccount?
    let onCancel: () -> Void
    let onSaved: (ChannelAccount) -> Void
    @State private var appId: String
    @State private var appSecret = ""
    @State private var domain: String
    @State private var busy = false
    @State private var error: String?

    init(kind: String, account: ChannelAccount?, onCancel: @escaping () -> Void, onSaved: @escaping (ChannelAccount) -> Void) {
        self.kind = kind
        self.account = account
        self.onCancel = onCancel
        self.onSaved = onSaved
        _appId = State(initialValue: account?.appId ?? "")
        _domain = State(initialValue: account?.domain ?? "feishu")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Form {
                TextField("App ID", text: $appId)
                    .font(.riffet(size: S(13), design: .monospaced))
                    .formField(label: "App ID")
                    .disabled(busy || account != nil)
                SecureField("App Secret", text: $appSecret)
                    .formField(label: "App Secret")
                    .disabled(busy)
                SettingsRow("域名") {
                    FormSegmented("域名", selection: $domain) {
                        Text("飞书").tag("feishu")
                        Text(verbatim: "Lark").tag("lark")
                    }
                    .labelsHidden()
                    .disabled(busy)
                }
            }
            .riffetForm()
            SettingsErrorText(message: error)
            HStack {
                Spacer()
                Button("取消", action: onCancel).keyboardShortcut(.cancelAction)
                Button("保存") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || appId.trimmingCharacters(in: .whitespaces).isEmpty || appSecret.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func save() async {
        busy = true
        error = nil
        let id = appId.trimmingCharacters(in: .whitespaces)
        let secret = appSecret.trimmingCharacters(in: .whitespaces)
        do {
            if let account {
                onSaved(try await ChannelsAPI.update(account.id, ["appId": id, "appSecret": secret, "domain": domain]))
            } else {
                onSaved(try await ChannelsAPI.create(kind: kind, appId: id, appSecret: secret, domain: domain))
            }
        } catch {
            self.error = error.riffetMessage
            busy = false
        }
    }
}

private struct ChannelProgressStep: View {
    let accountId: String
    let manual: Bool
    let model: ChannelsModel
    let onClose: () -> Void
    @State private var settled = false

    private var account: ChannelAccount? { model.state?.accounts.first { $0.id == accountId } }
    private var bound: Bool { model.state?.identities.contains { $0.account == accountId } ?? false }
    private var connected: Bool { account?.status.state == "connected" }
    private var needsLongConnection: Bool { connected && model.healths[accountId]?.needsLongConnection == true }
    private var complete: Bool { connected && bound && !needsLongConnection }

    var body: some View {
        let state = account?.status.state
        VStack(alignment: .leading, spacing: Space.md) {
            ChannelCheckRow(.ok, manual ? String(localized: "保存凭据") : String(localized: "创建应用"))
            ChannelCheckRow(
                connected ? .ok : (state == "error" || state == "disconnected") ? .bad : .busy,
                String(localized: "连接飞书"),
                detail: connected ? nil : account?.status.error
            )
            if needsLongConnection {
                ChannelCheckRow(mark: .todo, title: String(localized: "把事件订阅改为长连接")) {
                    if let link = account?.links.console, let url = URL(string: link) {
                        Button("打开开发者后台") { NSWorkspace.shared.open(url) }
                    }
                }
            }
            if !manual || connected {
                ChannelCheckRow(bound ? .ok : .busy, String(localized: "绑定你的飞书账号"))
            }
            if manual, connected, !bound { ChannelBindCodeView(accountId: accountId) }
            HStack {
                Spacer()
                if complete, let link = account?.links.open, let url = URL(string: link) {
                    Button("在飞书中打开") { NSWorkspace.shared.open(url) }
                }
                Button("完成", action: onClose).keyboardShortcut(.defaultAction)
            }
        }
        .onChange(of: complete) { _, done in if done { settled = true } }
        .task(id: settled) {
            // The server's changes are not streamed to this window, so the checks are read until the bot is complete.
            while !settled, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                if !Task.isCancelled { await model.reload() }
            }
        }
    }
}
