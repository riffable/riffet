import SwiftUI
import RiffetKit

/// The composer's place while a terminal holds the conversation (docs/TERMINAL-SESSIONS.md): the same
/// card, saying who writes, with the way to take it back.
struct TerminalHoldBar: View {
    let workbench: Workbench
    let session: Session
    @Environment(\.palette) private var palette
    @State private var releasing = false
    @State private var confirming = false
    @State private var error: String?

    var body: some View {
        HStack(spacing: Space.sm) {
            Image(icon: "terminal")
                .font(.riffet(size: S(14)))
                .foregroundStyle(palette.fg3)
            Text(error ?? String(localized: "在终端中"))
                .font(.riffet(size: S(13)))
                .foregroundStyle(error == nil ? palette.fg2 : palette.danger)
                .lineLimit(2)
                .textSelection(.enabled)
            Spacer(minLength: 0)
            if releasing { Spinner(size: .mini) }
            Button("收回") { Task { await release(force: false) } }
                .buttonStyle(ChipButtonStyle())
                .disabled(releasing)
        }
        .padding(.horizontal, Space.md)
        .frame(minHeight: 52)
        .background(
            RoundedRectangle(cornerRadius: Radius.floating, style: .continuous)
                .fill(palette.bgElevated)
                .elevation(.float)
        )
        .overlay(RoundedRectangle(cornerRadius: Radius.floating, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
        .onChange(of: session.id) { _, _ in error = nil }
        .confirmationDialog("结束终端中的进程？", isPresented: $confirming) {
            Button("结束进程", role: .destructive) { Task { await release(force: true) } }
        }
    }

    private func release(force: Bool) async {
        releasing = true
        error = nil
        defer { releasing = false }
        do {
            try await workbench.releaseTerminalHold(session, force: force)
        } catch let failure {
            if !force, failure.riffetStatus == 409, failure.riffetCode == "TERMINAL_STILL_RUNNING" {
                confirming = true
            } else {
                error = failure.riffetMessage
            }
        }
    }
}

/// 在终端恢复: the id and the command that continue [session] in a terminal. Copying the command first
/// stops Riffet's process for the conversation, so the terminal is the only writer.
struct TerminalResumeSheet: View {
    let workbench: Workbench
    let session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var resume: SessionResumeCommand?
    @State private var error: String?
    @State private var releasing = false
    @State private var copied: Field?

    private enum Field { case id, command }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack {
                Text("在终端恢复").font(.riffet(size: S(16), weight: .semibold))
                Spacer()
                Button { dismiss() } label: { Image(icon: "xmark") }
                    .buttonStyle(IconButtonStyle())
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("关闭")
            }
            if let resume {
                row("会话 ID", resume.nativeSessionId, .id) { copy(.id, resume.nativeSessionId) }
                row("命令", resume.command, .command) { Task { await copyCommand(resume.command) } }
                Text("复制命令时会停止 Riffet 中这个会话的进程，终端运行期间这里无法发送。")
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg3)
                    .fixedSize(horizontal: false, vertical: true)
                if resume.credentialsOmitted {
                    Text("终端不会带上 Riffet 中配置的模型接口和密钥。")
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.fg3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if error == nil {
                Spinner(size: .mini).frame(maxWidth: .infinity)
            }
            if let error {
                Text(error)
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.danger)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Space.xl)
        .frame(width: 460)
        .task {
            guard let api = workbench.host.api else { return }
            do { resume = try await api.resumeCommand(sessionId: session.id) }
            catch { self.error = error.riffetMessage }
        }
    }

    private func row(_ title: LocalizedStringKey, _ value: String, _ field: Field, copy: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
            HStack(alignment: .top, spacing: Space.sm) {
                Text(value)
                    .font(RiffetFont.mono(12))
                    .foregroundStyle(palette.fg)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(action: copy) { Image(icon: copied == field ? "checkmark" : "doc.on.doc") }
                    .buttonStyle(IconButtonStyle())
                    .disabled(releasing)
                    .accessibilityLabel("复制")
            }
            .padding(Space.sm)
            .background(palette.bgMuted, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        }
    }

    private func copyCommand(_ command: String) async {
        guard let api = workbench.host.api, !releasing else { return }
        releasing = true
        error = nil
        defer { releasing = false }
        do {
            _ = try await api.releaseSessionCli(sessionId: session.id)
            copy(.command, command)
        } catch let failure {
            error = failure.riffetMessage
        }
    }

    private func copy(_ field: Field, _ text: String) {
        copyToPasteboard(text)
        copied = field
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            if copied == field { copied = nil }
        }
    }
}
