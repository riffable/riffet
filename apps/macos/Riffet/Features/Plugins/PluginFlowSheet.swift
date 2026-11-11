import AppKit
import SwiftUI
import RiffetKit

/// Runs one plugin action and follows the steps the server answers with. A device-code login
/// shows its code and polls the flow until a step other than `pending` / `slow_down`, or expiry.
struct PluginFlowSheet: View {
    let workbench: Workbench
    let pluginId: String
    let action: PluginAction
    let finished: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var phase: Phase = .starting
    @State private var attempt = 0

    private enum Phase {
        case starting
        case code(ActionStepShowCode, qr: NSImage?)
        case hint(String, command: String?)
        case failed(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(action.label).font(.title3.weight(.semibold))
            if action.kind == "device-flow" {
                Text("凭据保存在服务器。").foregroundStyle(palette.fg3)
            }
            // A device-code login keeps the size of its code page from the first spinner to a retry:
            // the page's footprint sits under whichever step is shown.
            ZStack(alignment: .topLeading) {
                if deviceFlow { codeFootprint }
                VStack(alignment: .leading, spacing: 16) { steps }
            }
            HStack { Spacer(); Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction) }
        }
        .padding(Space.xl).frame(width: 440)
        // The task ends with the sheet, which is what stops the polling.
        .task(id: attempt) { await run() }
    }

    private var deviceFlow: Bool { action.kind == "device-flow" }

    /// The QR code's square with its white margin.
    private var qrSide: CGFloat { 172 + 2 * Space.sm }

    /// The code page's rows, empty: the QR square, the code, the link and the waiting line.
    private var codeFootprint: some View {
        VStack(alignment: .leading, spacing: 16) {
            Color.clear.frame(width: qrSide, height: qrSide)
            Text(verbatim: " ").font(.system(.title2, design: .monospaced))
            Text(verbatim: " ")
            HStack { Color.clear.frame(width: 16, height: 16); Text(verbatim: " ") }
        }
        .hidden()
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var steps: some View {
        switch phase {
        case .starting:
            // Where the QR code will be.
            Spinner(size: .small).frame(width: deviceFlow ? qrSide : nil, height: deviceFlow ? qrSide : nil)
        case let .code(code, qr):
            if let qr {
                Image(nsImage: qr)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 172, height: 172)
                    .padding(Space.sm)
                    .background(.white, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.lineSoft))
            }
            if let userCode = code.userCode {
                Text(userCode).font(.system(.title2, design: .monospaced)).textSelection(.enabled)
            }
            if let url = URL(string: code.verificationUri) { Link("打开授权页", destination: url) }
            HStack { Spinner(size: .small); Text("等待授权…").foregroundStyle(palette.fg3) }
        case let .hint(text, command):
            PluginHintRow(text: text, command: command)
        case let .failed(message):
            SettingsCallout(.danger, message: message, actionTitle: String(localized: "重试")) { attempt += 1 }
        }
    }

    private func run() async {
        phase = .starting
        guard let api = workbench.host.api else { phase = .failed(String(localized: "请先连接服务器")); return }
        do {
            var step = try await api.runPluginAction(id: pluginId, action: action.id)
            var code: ActionStepShowCode?
            var interval: Int64 = 0
            while !Task.isCancelled {
                switch onEnum(of: step) {
                case let .showCode(shown):
                    code = shown
                    interval = max(shown.intervalMs, 1000)
                    phase = .code(shown, qr: shown.qrSvg.flatMap { NSImage(data: Data($0.utf8)) })
                case .pending:
                    break
                case .slowDown:
                    interval += 5000
                case .done:
                    dismiss()
                    finished()
                    return
                case let .failed(failure):
                    phase = .failed(failure.message)
                    return
                case let .hint(hint):
                    phase = .hint(hint.text, command: hint.command)
                    return
                case .unknown:
                    phase = .failed(String(localized: "无法识别服务器的回应"))
                    return
                }
                guard let code else { phase = .failed(String(localized: "无法识别服务器的回应")); return }
                try await Task.sleep(for: .milliseconds(interval))
                guard Date.now.timeIntervalSince1970 * 1000 < Double(code.expiresAt) else {
                    phase = .failed(String(localized: "设备码已过期，请重新登录"))
                    return
                }
                step = try await api.pollPluginFlow(id: pluginId, flowId: code.flowId)
            }
        } catch {
            if !Task.isCancelled { phase = .failed(error.riffetMessage) }
        }
    }
}

/// A plugin's note, such as how to sign in outside Riffet, with the command to run.
struct PluginHintRow: View {
    let text: String
    let command: String?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
            SettingsHint(text, symbol: command == nil ? "info.circle" : "terminal")
            if let command {
                Text(command)
                    .font(.riffet(size: S(11.5), design: .monospaced))
                    .foregroundStyle(palette.fg2)
                    .textSelection(.enabled)
                CopyButton(text: command, help: String(localized: "复制命令"))
            }
        }
    }
}
