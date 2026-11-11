import SwiftUI
import UIKit
import RiffetKit

/// The command that continues this conversation in a terminal on the server's machine (docs/TERMINAL-SESSIONS.md).
/// Copying the command first stops Riffet's own process for the session, so the terminal is the only writer.
struct TerminalResumeSheet: View {
    let workbench: Workbench
    let sessionID: String
    @Environment(\.dismiss) private var dismiss
    @State private var resume: SessionResumeCommand?
    @State private var loading = true
    @State private var releasing = false
    @State private var error: String?
    @State private var copied: Field?
    @State private var copyTick = 0

    private enum Field { case id, command }

    var body: some View {
        NavigationStack {
            RiffetForm {
                if let resume {
                    Section {
                        row("会话 ID", value: resume.nativeSessionId, field: .id) { copy(resume.nativeSessionId, .id) }
                        row("命令", value: resume.command, field: .command) { Task { await copyCommand(resume.command) } }
                    } footer: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("复制命令时会停止 Riffet 中这个会话的进程，终端运行期间这里无法发送。")
                            if resume.credentialsOmitted { Text("终端不会带上 Riffet 中配置的模型接口和密钥。") }
                        }
                    }
                } else if loading {
                    Section { HStack { Spacer(); ProgressView(); Spacer() } }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle(String(localized: "在终端恢复", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .sensoryFeedback(.success, trigger: copyTick)
            .task { await load() }
        }
    }

    private func row(_ title: LocalizedStringKey, value: String, field: Field, copy: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).riffetFont(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(action: copy) {
                    Image(systemName: copied == field ? "checkmark" : "doc.on.doc").contentTransition(.symbolEffect(.replace))
                }.buttonStyle(.borderless).disabled(releasing).accessibilityLabel(title)
            }
            Text(value).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
        }.padding(.vertical, 2)
    }

    private func load() async {
        loading = true; defer { loading = false }
        do {
            guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
            resume = try await api.resumeCommand(sessionId: sessionID)
        } catch is CancellationError {} catch { self.error = error.riffetMessage }
    }

    private func copyCommand(_ command: String) async {
        guard !releasing else { return }
        releasing = true; defer { releasing = false }
        do {
            guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
            _ = try await api.releaseSessionCli(sessionId: sessionID)
            error = nil
            copy(command, .command)
        } catch is CancellationError {} catch { self.error = error.riffetMessage }
    }

    private func copy(_ text: String, _ field: Field) {
        UIPasteboard.general.string = text
        copyTick += 1
        withAnimation { copied = field }
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            withAnimation { if copied == field { copied = nil } }
        }
    }
}
