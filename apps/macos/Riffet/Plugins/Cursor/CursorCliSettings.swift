import SwiftUI
import RiffetKit

/// The Cursor CLI terminal, opened from 模型设置 → Cursor. It keeps its own chrome so the
/// settings window's sidebar stays focused on preferences.
struct CursorCliSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.sm) {
                Text("Cursor CLI")
                    .font(.riffet(size: S(16), weight: .semibold))
                Spacer(minLength: Space.sm)
                Button("完成") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(busy)
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
            Divider()
            CursorCliPage(onBusyChange: { busy = $0 })
        }
        // Shorter than the settings window's minimum, so the sheet never overhangs it.
        .frame(minWidth: 640, idealWidth: 720, minHeight: 480, idealHeight: 560)
        .interactiveDismissDisabled(busy)
    }
}

struct CursorCliPage: View {
    var onBusyChange: (Bool) -> Void = { _ in }
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var operation = "status"
    @State private var args = ""
    @State private var projectId = ""
    @State private var running = false
    @State private var error: String?
    @State private var output: CommandResult?
    @State private var outputLabel = ""
    @State private var report: CapabilityReport?
    @State private var checking = false
    @State private var showAdvanced = false

    private let quick: [QuickCommand] = [
        QuickCommand(String(localized: "状态"), "status", ""),
        QuickCommand(String(localized: "模型"), "models", ""),
        QuickCommand(String(localized: "账户"), "about", ""),
        QuickCommand(String(localized: "团队"), "team", ""),
        QuickCommand("MCP", "mcp", "list"),
        QuickCommand(String(localized: "插件"), "plugin.marketplace.list", ""),
    ]

    var body: some View {
        Group {
            if let workbench = model.workbench {
                form(workbench)
            } else {
                NeedsServerView()
            }
        }
        .onChange(of: running || checking, initial: true) { _, busy in onBusyChange(busy) }
        .onDisappear { onBusyChange(false) }
    }

    private func form(_ workbench: Workbench) -> some View {
        Form {
            SettingsBlock("安装情况") {
                if let report {
                    SettingsRow("版本") {
                        Text(report.cliVersion ?? String(localized: "未知"))
                            .font(.riffet(size: S(12), design: .monospaced))
                    }
                    SettingsRow("路径") {
                        Text(report.cliPath)
                            .font(.riffet(size: S(12), design: .monospaced))
                            .textSelection(.enabled)
                    }
                    SettingsRow("账户") {
                        SettingsStatusBadge(
                            text: report.authenticated ? String(localized: "已登录") : String(localized: "未登录"),
                            tint: report.authenticated ? palette.success : palette.warning
                        )
                    }
                    ForEach(Array(report.warnings.enumerated()), id: \.offset) { _, warning in
                        SettingsCallout(.warning, message: warning)
                    }
                } else {
                    SettingsStatusRow(
                        title: String(localized: "安装情况"),
                        status: checking ? String(localized: "检查中") : String(localized: "未检查"),
                        tint: checking ? palette.accent : palette.fg3
                    )
                }
                HStack(spacing: Space.sm) {
                    SettingsActionButton("检查", symbol: "arrow.clockwise") { Task { await check(workbench) } }
                        .disabled(checking)
                    SettingsActionButton("更新 CLI", symbol: "arrow.down.circle") { runQuick(workbench, operation: "update", args: "") }
                        .disabled(running)
                    if checking || running { Spinner(size: .small) }
                    Spacer(minLength: 0)
                }
            }
            SettingsBlock("命令", detail: "受服务器允许列表限制。") {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 76), alignment: .leading)],
                    alignment: .leading,
                    spacing: Space.sm
                ) {
                    ForEach(quick) { item in
                        SettingsActionButton(verbatim: item.label, kind: .secondary) {
                            runQuick(workbench, operation: item.operation, args: item.args)
                        }
                        .disabled(running)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                DisclosureGroup("手动运行命令", isExpanded: $showAdvanced) {
                    Picker("范围", selection: $projectId) {
                        Text("用户").tag("")
                        ForEach(workbench.projects, id: \.id) { Text($0.name).tag($0.id) }
                    }
                    .formPicker()
                    TextField("命令", text: $operation)
                        .formField(label: "命令")
                    TextField("参数（空格分隔，或以 JSON 字符串数组）", text: $args)
                        .formField(label: "参数（空格分隔，或以 JSON 字符串数组）")
                    HStack(spacing: Space.sm) {
                        SettingsActionButton("运行", symbol: "play.fill") { Task { await run(workbench) } }
                            .disabled(running || operation.trimmingCharacters(in: .whitespaces).isEmpty)
                        if running { Spinner(size: .small) }
                        Spacer(minLength: 0)
                    }
                }
                SettingsErrorText(message: error)
                if let output {
                    console(output)
                }
            }
        }
        .riffetForm()
        .task { await check(workbench) }
    }

    private func console(_ output: CommandResult) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: Space.sm) {
                Text(outputLabel.isEmpty ? String(localized: "命令输出") : outputLabel)
                    .font(.riffet(size: S(11), design: .monospaced))
                    .foregroundStyle(palette.fg3)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: Space.sm)
                if let code = output.code?.intValue {
                    SettingsStatusBadge(
                        text: String(localized: "退出码 \(code)"),
                        tint: code == 0 ? palette.success : palette.danger
                    )
                } else {
                    SettingsStatusBadge(text: String(localized: "退出码 ?"), tint: palette.fg3)
                }
                CopyButton(text: commandText(output), help: String(localized: "复制输出"))
            }
            if output.timedOut?.boolValue == true {
                SettingsHint("命令超时。", symbol: "clock.badge.exclamationmark")
            }
            if output.truncated?.boolValue == true {
                SettingsHint("输出已截断。", symbol: "scissors")
            }
            Text(commandText(output))
                .font(.riffet(size: S(11.5), design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Space.sm)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(palette.lineSoft)
        )
    }

    private func commandText(_ output: CommandResult) -> String {
        let stdout = output.stdout
        let stderr = output.stderr
        if stdout.isEmpty, stderr.isEmpty { return String(localized: "（无输出）") }
        if stderr.isEmpty { return stdout }
        if stdout.isEmpty { return stderr }
        return stdout + "\n" + stderr
    }

    private func check(_ workbench: Workbench) async {
        guard !checking, let api = workbench.host.api else { return }
        checking = true
        error = nil
        do {
            report = try await api.capabilities()
        } catch {
            // The plugin was turned off while this was open: nothing to report, nothing to blame.
            if !error.riffetBackendUnavailable { self.error = error.riffetMessage }
        }
        checking = false
    }

    private func runQuick(_ workbench: Workbench, operation: String, args: String) {
        self.operation = operation
        self.args = args
        showAdvanced = true
        Task { await run(workbench, operation: operation, rawArgs: args) }
    }

    private func run(_ workbench: Workbench) async {
        await run(workbench, operation: operation, rawArgs: args)
    }

    private func run(_ workbench: Workbench, operation: String, rawArgs: String) async {
        guard !running, let api = workbench.host.api else { return }
        let list: [String]
        do { list = try parseArgs(rawArgs) }
        catch {
            self.error = error.riffetMessage
            return
        }
        running = true
        error = nil
        let op = operation.trimmingCharacters(in: .whitespaces)
        outputLabel = ([op] + list).joined(separator: " ")
        do {
            output = try await api.command(operation: op, args: list, projectId: projectId.isEmpty ? nil : projectId)
        } catch {
            if !error.riffetBackendUnavailable { self.error = error.riffetMessage }
        }
        running = false
    }

    private func parseArgs(_ raw: String) throws -> [String] {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("[") else {
            return trimmed.isEmpty ? [] : trimmed.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        }
        guard let data = trimmed.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String] else {
            throw SettingsFailure(String(localized: "参数需要是字符串数组 JSON，或用空格分隔"))
        }
        return parsed
    }
}

private struct QuickCommand: Identifiable {
    let label: String
    let operation: String
    let args: String
    var id: String { label }
    init(_ label: String, _ operation: String, _ args: String) {
        self.label = label
        self.operation = operation
        self.args = args
    }
}
