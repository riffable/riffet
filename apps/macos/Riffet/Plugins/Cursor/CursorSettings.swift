import SwiftUI
import RiffetKit

/// Cursor's settings in Agent and 模型提供商, drawn by the host from the `riffet.cursor/provider` and
/// `riffet.cursor/cli` views the Cursor plugin declares. Everything Cursor-specific the settings window shows lives in this folder.
enum CursorPlugin {
    /// The two `settings` views the Cursor plugin declares: the provider page and the CLI page.
    static let renderers: [String: PluginAgentRenderer] = [
        "riffet.cursor/provider": PluginAgentRenderer(
            providers: { AnyView(CursorProviderRow(workbench: $0)) },
            choosesDefaultModelHere: true
        ),
        "riffet.cursor/cli": PluginAgentRenderer(
            links: { AnyView(CursorCliLink(workbench: $0)) },
            diagnostics: { await cursorDiagnostics($0) },
            commandNeedsTerminal: cursorCommandNeedsTerminal
        ),
    ]
}

/// Cursor's single implicit provider; its connection opens in a sheet.
private struct CursorProviderRow: View {
    let workbench: Workbench
    @State private var showConnection = false

    var body: some View {
        let endpoint = workbench.settings?.cursorCli?.apiEndpoint ?? ""
        AgentProviderRow(
            name: "Cursor",
            summary: endpoint.isEmpty ? String(localized: "Cursor 默认服务") : displayEndpoint(endpoint),
            isDefault: false,
            missingKey: false
        ) { showConnection = true }
        .sheet(isPresented: $showConnection) {
            CursorConnectionSheet(workbench: workbench)
        }
    }
}

private struct CursorCliLink: View {
    let workbench: Workbench
    @State private var showCli = false
    @State private var showLaunch = false

    var body: some View {
        SettingsNavigationRow(title: String(localized: "高级启动配置")) { showLaunch = true }
            .sheet(isPresented: $showLaunch) { CursorConnectionSheet(workbench: workbench, launchSettings: true) }
        SettingsNavigationRow(title: "Cursor CLI") { showCli = true }
            .sheet(isPresented: $showCli) { CursorCliSheet() }
    }
}

/// Cursor's connection: its single implicit provider. Explicit save, like the other providers'
/// editors; the connection reaches the CLI on Riffet's next start.
struct CursorConnectionSheet: View {
    let workbench: Workbench
    let launchSettings: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    @State private var draft: CursorDraft
    @State private var baseline: CursorDraft
    @State private var key = ""
    @State private var clearKey = false
    @State private var saving = false
    @State private var error: String?
    @State private var confirmDiscard = false

    init(workbench: Workbench, launchSettings: Bool = false) {
        self.workbench = workbench
        self.launchSettings = launchSettings
        let current = CursorDraft(workbench.settings?.cursorCli)
        _draft = State(initialValue: current)
        _baseline = State(initialValue: current)
    }

    private var hasKey: Bool { workbench.settings?.cursorCli?.hasApiKey?.boolValue == true }
    private var dirty: Bool { normalize(draft) != normalize(baseline) || !key.isEmpty || clearKey }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.sm) {
                Text("Cursor")
                    .font(.riffet(size: S(16), weight: .semibold))
                    .foregroundStyle(palette.fg)
                Spacer(minLength: Space.sm)
                if saving { Spinner(size: .small) }
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
            Divider()
            Form {
                if !launchSettings {
                    Section {
                        SettingsFieldRow("网关地址") {
                            TextField("使用 Cursor 默认服务", text: gatewayBinding)
                                .font(.riffet(size: S(13), design: .monospaced))
                                .formField()
                        }
                        SettingsFieldRow("API Key") {
                            HStack(spacing: Space.sm) {
                                SecureField(clearKey ? String(localized: "保存后清除") : (hasKey ? String(localized: "已配置") : String(localized: "未配置")), text: $key)
                                    .font(.riffet(size: S(13), design: .monospaced))
                                    .formField()
                                    .onChange(of: key) { _, value in if !value.isEmpty { clearKey = false } }
                                if hasKey {
                                    Button(clearKey ? "取消清除" : "清除") {
                                        key = ""
                                        clearKey.toggle()
                                    }
                                }
                            }
                        }
                    }
                }
                if launchSettings {
                    SettingsBlock("高级启动配置") {
                        SettingsFieldRow("CLI 入口") {
                            TextField("cursor-agent", text: $draft.executable)
                                .font(.riffet(size: S(13), design: .monospaced))
                                .formField()
                        }
                        SettingsFieldRow("配置目录") {
                            TextField("~/.cursor", text: $draft.configDir)
                                .font(.riffet(size: S(13), design: .monospaced))
                                .formField()
                        }
                        Toggle("单独设置 Agent 端点", isOn: separateBinding)
                        if draft.separateAgent {
                            SettingsFieldRow("Agent 端点") {
                                TextField("使用 Cursor 默认端点", text: $draft.agentEndpoint)
                                    .font(.riffet(size: S(13), design: .monospaced))
                                    .formField()
                            }
                        }
                        Toggle("关闭自动更新", isOn: $draft.disableAutoUpdate)
                    }
                }
                if let error {
                    SettingsCallout(.danger, message: error)
                }
            }
            .riffetForm()
            .disabled(saving)
            Divider()
            HStack(spacing: Space.sm) {
                SettingsHint("重启 Riffet 后生效。")
                Spacer(minLength: Space.sm)
                Button("取消") { if dirty { confirmDiscard = true } else { dismiss() } }
                    .keyboardShortcut(.cancelAction)
                    .disabled(saving)
                SettingsActionButton("保存", kind: .primary) { Task { await save() } }
                    .disabled(!dirty || saving)
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
        }
        .frame(minWidth: 560, idealWidth: 620, minHeight: 420, idealHeight: 520)
        .background(palette.bg)
        .interactiveDismissDisabled(dirty)
        .confirmationDialog("放弃未保存的更改？", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("放弃更改", role: .destructive) { dismiss() }
            Button("继续编辑", role: .cancel) {}
        }
    }

    private var gatewayBinding: Binding<String> {
        Binding(get: { draft.apiEndpoint }, set: { value in
            draft.apiEndpoint = value
            if !draft.separateAgent { draft.agentEndpoint = value }
        })
    }

    private var separateBinding: Binding<Bool> {
        Binding(get: { draft.separateAgent }, set: { on in
            draft.separateAgent = on
            if !on { draft.agentEndpoint = draft.apiEndpoint }
        })
    }

    private func save() async {
        guard let patch = patch() else { dismiss(); return }
        saving = true
        error = nil
        do {
            // `cursorCli` must be its own request: the server rejects it next to any other key.
            try await SettingsStore.save(workbench, AppSettingsUpdate(
                taskWorkspaceRoot: nil, editorCommand: nil, defaultModel: nil, defaultMode: nil, notifications: nil,
                allowOutsideRead: nil, defaultBackendId: nil, nativeBackendDefaults: nil, cursorCli: patch,
                composerEnterBehavior: nil, composerRunningBehavior: nil, composerSendLater: nil, idleReclaimMinutes: nil, maxLiveAgents: nil,
                quickChat: nil, defaultAgentId: nil, agentDefaults: nil, sidebarPinned: nil
            ))
            dismiss()
        } catch {
            // The plugin went off while this was open: there is nothing left to save to.
            if error.riffetBackendUnavailable { dismiss() } else { self.error = error.riffetMessage }
        }
        saving = false
    }

    private func patch() -> CursorCliSettingsUpdate? {
        let next = normalize(draft)
        let previous = normalize(baseline)
        let keyPatch = key.isEmpty ? (clearKey ? PatchValue.shared.key(value: nil) : nil) : PatchValue.shared.key(value: key)
        if next == previous && keyPatch == nil { return nil }
        return CursorCliSettingsUpdate(
            executable: next.executable == previous.executable ? nil : next.executable,
            configDir: next.configDir == previous.configDir ? nil : next.configDir,
            apiEndpoint: next.apiEndpoint == previous.apiEndpoint ? nil : next.apiEndpoint,
            agentEndpoint: next.agentEndpoint == previous.agentEndpoint ? nil : next.agentEndpoint,
            disableAutoUpdate: next.disableAutoUpdate == previous.disableAutoUpdate ? nil : KotlinBoolean(bool: next.disableAutoUpdate),
            apiKey: keyPatch
        )
    }
}

private struct CursorDraft: Equatable {
    var executable = ""
    var configDir = ""
    var apiEndpoint = ""
    var agentEndpoint = ""
    var separateAgent = false
    var disableAutoUpdate = false

    init(_ cli: CursorCliSettings?) {
        executable = cli?.executable ?? ""
        configDir = cli?.configDir ?? ""
        apiEndpoint = cli?.apiEndpoint ?? ""
        agentEndpoint = cli?.agentEndpoint ?? ""
        separateAgent = (cli?.agentEndpoint ?? "").trimmingCharacters(in: .whitespacesAndNewlines) != (cli?.apiEndpoint ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        disableAutoUpdate = cli?.disableAutoUpdate?.boolValue == true
    }
}

private func normalize(_ draft: CursorDraft) -> CursorDraft {
    var copy = draft
    copy.executable = draft.executable.trimmingCharacters(in: .whitespacesAndNewlines)
    copy.configDir = draft.configDir.trimmingCharacters(in: .whitespacesAndNewlines)
    copy.apiEndpoint = draft.apiEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
    copy.agentEndpoint = draft.agentEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
    return copy
}
