import PhotosUI
import SwiftUI
import UserNotifications
import RiffetKit

private struct SettingsEntry: Identifiable {
    enum Kind {
        case link(() -> AnyView)
        case action(() -> Void)
        case plain
    }
    let title: String
    let icon: String
    var value: String?
    var identifier: String = ""
    var busy = false
    let kind: Kind
    var id: String { title }
}

private struct SettingsGroup: Identifiable {
    let title: String
    let entries: [SettingsEntry]
    var id: String { title }
}

private struct LogFile: Identifiable {
    let url: URL
    var id: URL { url }
}

struct SettingsView: View {
    /// Nil while no server is connected: the local rows work, the server's show 未连接.
    let workbench: Workbench?
    @Environment(AppModel.self) private var model
    @Environment(ThemeStore.self) private var themeStore
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var widthClass
    @Environment(\.verticalSizeClass) private var heightClass
    @State private var query = ""
    /// Read here so the row shows the tab just chosen on its page.
    @AppStorage(RootTab.launchKey) private var launchRaw = RootTab.assistant.rawValue
    @State private var deviceCount: Int?
    @State private var exporting = false
    @State private var exportError: String?
    @State private var logFile: LogFile?

    var body: some View {
        let groups = visibleGroups
        RiffetList {
            if query.isEmpty, let workbench { Section { profile(workbench) } }
            ForEach(groups) { group in
                Section {
                    ForEach(group.entries) { row($0) }
                } header: {
                    if !group.title.isEmpty { RiffetSectionTitle(group.title) }
                }
            }
            if let exportError { RiffetNotice.section(.error, exportError) }
        }
        .overlay {
            if groups.isEmpty && !query.isEmpty { ContentUnavailableView.search(text: query) }
        }
        .riffetSoftEdges()
        .overlay(alignment: .top) { RiffetBarScrim() }
        .riffetSearchable(text: $query, prompt: String(localized: "搜索设置", bundle: .riffet))
        .navigationTitle(String(localized: "设置", bundle: .riffet)).navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .bottomBar)
        .background(TabBarVisibility(hidden: false))
        .sheet(item: $logFile) { NativeShareSheet(items: [$0.url]).presentationDetents([.medium, .large]) }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await RiffetNotifications.shared.refreshAuthorization()
            await model.refreshPairedServers()
            await workbench?.refreshOwner()
            if let devices = try? await workbench?.api?.devices() { deviceCount = devices.count }
        }
    }

    /// A phone's settings page covers the tab bar; a wide window keeps its tabs in reach, as 任务 does.
    private var pushHidesTabs: Bool { !(widthClass == .regular && heightClass == .regular) }

    private func profile(_ workbench: Workbench) -> some View {
        NavigationLink { OwnerProfileView(workbench: workbench).background(TabBarVisibility(hidden: pushHidesTabs)) } label: {
            HStack(spacing: 14) {
                OwnerAvatarView(workbench: workbench, owner: workbench.owner, size: 52)
                VStack(alignment: .leading, spacing: 3) {
                    Text(workbench.owner?.name ?? String(localized: "个人资料", bundle: .riffet)).riffetFont(.headline).foregroundStyle(palette.fg).lineLimit(1)
                    HStack(spacing: 6) {
                        Circle().fill(workbench.serverReachable ? palette.success : palette.fg4).frame(width: 6, height: 6)
                        Text(profileSubtitle).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                    }
                }
            }.padding(.vertical, 6)
        }
        .accessibilityIdentifier("settingsProfile")
    }

    private var profileSubtitle: String {
        let server = model.pairedServers.first(where: model.isCurrent)?.displayName ?? ""
        let state = workbench?.serverReachable == true ? String(localized: "已连接", bundle: .riffet) : String(localized: "未连接", bundle: .riffet)
        return server.isEmpty ? state : "\(server) · \(state)"
    }

    @ViewBuilder private func row(_ entry: SettingsEntry) -> some View {
        switch entry.kind {
        case .link(let destination):
            // A settings page is pushed over the tab bar: it leaves with the push and returns with the pop.
            NavigationLink { destination().background(TabBarVisibility(hidden: pushHidesTabs)) } label: {
                SettingsRowLabel(title: entry.title, symbol: entry.icon, value: entry.value)
            }.accessibilityIdentifier(entry.identifier)
        case .action(let action):
            Button(action: action) {
                HStack(spacing: 8) {
                    SettingsRowLabel(title: entry.title, symbol: entry.icon, value: entry.value)
                    ProgressView().opacity(entry.busy ? 1 : 0)
                }.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(entry.busy)
        case .plain:
            SettingsRowLabel(title: entry.title, symbol: entry.icon, value: entry.value)
        }
    }

    private var visibleGroups: [SettingsGroup] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return groups }
        return groups.compactMap { group in
            let entries = group.entries.filter { $0.title.localizedCaseInsensitiveContains(needle) }
            return entries.isEmpty ? nil : SettingsGroup(title: group.title, entries: entries)
        }
    }

    private var groups: [SettingsGroup] {
        let workbench = workbench
        /// A row that needs the server: its page, or 未连接 and the empty state while there is none.
        func server(_ title: String, _ icon: String, value: String? = nil, identifier: String = "", _ page: @escaping (Workbench) -> AnyView) -> SettingsEntry {
            guard let workbench else {
                return SettingsEntry(title: title, icon: icon, value: String(localized: "未连接", bundle: .riffet), identifier: identifier, kind: .link { AnyView(NeedsServerView()) })
            }
            return SettingsEntry(title: title, icon: icon, value: value, identifier: identifier, kind: .link { page(workbench) })
        }
        var appearance = [
            SettingsEntry(title: String(localized: "主题", bundle: .riffet), icon: "paintpalette", value: themeStore.entry.name, kind: .link { AnyView(ThemeSettingsView()) }),
            SettingsEntry(title: String(localized: "显示模式", bundle: .riffet), icon: "circle.lefthalf.filled", value: displayModeName, kind: .link { AnyView(DisplayModeSettingsView()) }),
            SettingsEntry(title: String(localized: "代码高亮", bundle: .riffet), icon: "chevron.left.forwardslash.chevron.right", value: codeThemeName, kind: .link { AnyView(CodeThemeSettingsView()) }),
        ]
        if UIApplication.shared.supportsAlternateIcons {
            appearance.append(SettingsEntry(title: String(localized: "图标", bundle: .riffet), icon: "app", value: AppIconVariant.current.name, kind: .link { AnyView(AppIconSetting()) }))
        }
        return [
            SettingsGroup(title: "", entries: [
                SettingsEntry(title: String(localized: "语言", bundle: .riffet), icon: "globe", value: AppLanguage.current.name, kind: .link { AnyView(LanguageSettingsView()) }),
                SettingsEntry(title: String(localized: "启动时打开", bundle: .riffet), icon: "rectangle.on.rectangle", value: (RootTab(rawValue: launchRaw) ?? .assistant).title, kind: .link { AnyView(LaunchTabSettingsView()) }),
                server(String(localized: "扩展管理", bundle: .riffet), "puzzlepiece.extension") { AnyView(NativeExtensionsView(workbench: $0)) },
            ]),
            SettingsGroup(title: String(localized: "外观", bundle: .riffet), entries: appearance),
            SettingsGroup(title: String(localized: "行为", bundle: .riffet), entries: [
                SettingsEntry(title: String(localized: "交互与输入", bundle: .riffet), icon: "keyboard", kind: .link { AnyView(InteractionSettingsView(workbench: workbench)) }),
                SettingsEntry(title: String(localized: "通知", bundle: .riffet), icon: "bell", value: settingsNotificationStatus(), kind: .link { AnyView(NotificationSettingsView(workbench: workbench)) }),
                server(String(localized: "文件与编辑器", bundle: .riffet), "doc.text") { AnyView(FilesSettingsView(workbench: $0)) },
            ]),
            SettingsGroup(title: String(localized: "功能", bundle: .riffet), entries: [
                server(String(localized: "个人助理", bundle: .riffet), "sparkles") { AnyView(AssistantSettingsView(workbench: $0)) },
                server(String(localized: "任务看板", bundle: .riffet), "checklist") { AnyView(TaskBoardSettingsView(workbench: $0)) },
                server(String(localized: "快速对话", bundle: .riffet), "bubble.left") { AnyView(QuickChatSettingsView(workbench: $0)) },
            ]),
            SettingsGroup(title: String(localized: "模型", bundle: .riffet), entries: [
                server(String(localized: "Agent", bundle: .riffet), "sparkles", value: defaultAgentName, identifier: "agentSettings") { AnyView(NativeProvidersView(workbench: $0, agentSettings: true)) },
                server(String(localized: "模型提供商", bundle: .riffet), "server.rack", identifier: "nativeManagement") { AnyView(NativeProvidersView(workbench: $0)) },
                server(String(localized: "辅助模型", bundle: .riffet), "brain") { AnyView(AuxiliaryModelsView(workbench: $0)) },
            ]),
            SettingsGroup(title: String(localized: "访问", bundle: .riffet), entries: [
                SettingsEntry(title: String(localized: "连接与配对", bundle: .riffet), icon: "link", value: model.pairedServers.first(where: model.isCurrent)?.displayName, kind: .link { AnyView(ConnectionSettingsView(workbench: workbench)) }),
                server(String(localized: "已授权设备", bundle: .riffet), "iphone", value: deviceCount.map(String.init)) { AnyView(DevicesView(workbench: $0)) },
            ]),
            SettingsGroup(title: String(localized: "服务器", bundle: .riffet), entries: [
                server(String(localized: "服务器状态", bundle: .riffet), "gauge.with.dots.needle.33percent", identifier: "serviceStatus") { AnyView(ServiceStatusView(workbench: $0)) },
            ]),
            SettingsGroup(title: String(localized: "支持", bundle: .riffet), entries: [
                server(String(localized: "使用统计", bundle: .riffet), "chart.bar") { AnyView(NativeStatsView(workbench: $0)) },
                SettingsEntry(title: String(localized: "导出日志", bundle: .riffet), icon: "square.and.arrow.up", busy: exporting, kind: .action { Task { await exportLog() } }),
                SettingsEntry(title: String(localized: "关于 Riffet", bundle: .riffet), icon: "info.circle", value: appVersion, kind: .link { AnyView(AboutSettingsView(version: appVersion)) }),
            ]),
        ]
    }

    @AppStorage(ThemeStore.modeKey) private var appearanceMode = "system"
    private var displayModeName: String {
        switch appearanceMode {
        case "light": String(localized: "浅色", bundle: .riffet)
        case "dark": String(localized: "深色", bundle: .riffet)
        default: String(localized: "跟随系统", bundle: .riffet)
        }
    }

    private var codeThemeName: String {
        if themeStore.codeThemeId == "auto" {
            return String(localized: "跟随界面主题", bundle: .riffet)
        }
        return CodeThemeSettingsView.displayName(for: themeStore.codeTheme)
    }

    private var defaultAgentName: String? {
        workbench.flatMap { workbench in workbench.settings?.defaultBackendId.map { managementBackendName($0, workbench) } }
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "—"
        guard let build = info?["CFBundleVersion"] as? String else { return version }
        return "\(version) (\(build))"
    }

    private func exportLog() async {
        guard !exporting else { return }
        exporting = true
        defer { exporting = false }
        do {
            AppLog.shared.log(tag: "app", message: "export requested")
            let text = redactedLog(try await AppLog.shared.export())
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(AppLog.shared.exportName())
            try text.write(to: url, atomically: true, encoding: .utf8)
            exportError = nil
            logFile = LogFile(url: url)
        } catch is CancellationError {} catch { exportError = error.riffetMessage }
    }
}

/// The same redaction the Android export applies (shared `redactLog`): credentials never leave in a log.
private func redactedLog(_ text: String) -> String {
    let patterns: [(String, String)] = [
        (#"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=\-]+"#, "$1 <redacted>"),
        (#"\bwkn_([0-9a-f]{16})_[A-Za-z0-9_\-]+"#, "wkn_$1_<redacted>"),
        (#"\bwkn_share_preview=[^;\s]+"#, "wkn_share_preview=<redacted>"),
        (#"(?i)\b(authorization|cookie|set-cookie)(\s*[:=]\s*)[^\r\n]+"#, "$1$2<redacted>"),
        (#"(?i)\b(access_token|device_token|api_key|apikey|password|secret)(\s*[=:]\s*)[^\s&"',;]+"#, "$1$2<redacted>"),
    ]
    return patterns.reduce(text) { $0.replacingOccurrences(of: $1.0, with: $1.1, options: .regularExpression) }
}

@MainActor private func settingsNotificationStatus() -> String {
    switch RiffetNotifications.shared.authorization {
    case .authorized, .provisional, .ephemeral: String(localized: "已允许", bundle: .riffet)
    case .denied: String(localized: "已关闭", bundle: .riffet)
    default: String(localized: "尚未选择", bundle: .riffet)
    }
}

/// An edit page with one text field and no label: the page title names it, the keyboard's done saves.
/// `save` returns the reason it failed, or nil once saved.
private struct SettingsTextEditPage: View {
    let title: String
    let initial: String
    var prompt = ""
    var mono = false
    var limit: Int?
    var footer: String?
    var valid: (String) -> Bool = { _ in true }
    var invalidMessage: String?
    let save: (String) async -> String?
    @Environment(\.dismiss) private var dismiss
    @State private var value: String
    @State private var error: String?
    @State private var submitting = false

    init(title: String, initial: String, prompt: String = "", mono: Bool = false, limit: Int? = nil, footer: String? = nil,
         valid: @escaping (String) -> Bool = { _ in true }, invalidMessage: String? = nil,
         save: @escaping (String) async -> String?) {
        self.title = title; self.initial = initial; self.prompt = prompt; self.mono = mono; self.limit = limit
        self.footer = footer; self.valid = valid; self.invalidMessage = invalidMessage; self.save = save
        _value = State(initialValue: initial)
    }

    private var trimmed: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var dirty: Bool { trimmed != initial.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isValid: Bool { valid(trimmed) }

    var body: some View {
        RiffetEditPage(title: title, dirty: dirty, canSave: isValid, save: commit) {
            Section {
                RiffetField(prompt: prompt, text: $value, mono: mono)
                    .textInputAutocapitalization(mono ? .never : nil).autocorrectionDisabled(mono)
                    .submitLabel(.done)
                    .onSubmit {
                        guard dirty, isValid, !submitting else { return }
                        submitting = true
                        Task {
                            if await commit() { dismiss() }
                            submitting = false
                        }
                    }
            } footer: {
                if let footer, isValid { Text(footer) }
            }
            RiffetNotice.section(.error, isValid ? nil : invalidMessage)
            RiffetNotice.section(.error, error)
        }
        .onChange(of: value) { _, text in
            guard let limit, text.unicodeScalars.count > limit else { return }
            value = String(String.UnicodeScalarView(text.unicodeScalars.prefix(limit)))
        }
    }

    private func commit() async -> Bool {
        error = await save(trimmed)
        return error == nil
    }
}

/// The owner's name and avatar, shared by every device paired with this server.
private struct OwnerProfileView: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @State private var picked: PhotosPickerItem?
    @State private var pickingPhoto = false
    @State private var busy = false
    @State private var error: String?
    @State private var styles: [OwnerAvatarStyle] = []
    @State private var randomizing = false
    @State private var editingName = false

    private var name: String { workbench.owner?.name ?? "" }

    var body: some View {
        RiffetForm {
            Section { header }.listRowBackground(Color.clear).listRowSeparator(.hidden)
            if let history = workbench.owner?.history, !history.isEmpty {
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: RiffetMetrics.floatingGap) {
                            ForEach(history, id: \.sha256) { avatar in
                                Button { Task { await run { try await workbench.restoreOwnerAvatar(avatar) } } } label: {
                                    OwnerAvatarView(workbench: workbench, owner: nil, size: RiffetMetrics.avatar, url: workbench.ownerAvatarURL(avatar))
                                }
                                .buttonStyle(.plain).disabled(busy)
                                .contextMenu {
                                    Button("删除", role: .destructive) { Task { await run { try await workbench.deleteOwnerAvatarHistory(avatar) } } }
                                }
                            }
                        }
                    }
                } header: { RiffetSectionTitle(String(localized: "历史头像", bundle: .riffet)) }
            }
            RiffetNotice.section(.error, error)
        }
        .navigationTitle(String(localized: "个人资料", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task { styles = await workbench.ownerAvatarStyles() }
        .photosPicker(isPresented: $pickingPhoto, selection: $picked, matching: .images)
        .sheet(isPresented: $randomizing) {
            RandomAvatarSheet(workbench: workbench, styles: styles) { style, seed, ink, paper in
                await run { try await workbench.generateOwnerAvatar(style: style, seed: seed, ink: ink, paper: paper) }
            }
        }
        .sheet(isPresented: $editingName) {
            SettingsTextEditPage(title: String(localized: "名称", bundle: .riffet), initial: name, limit: 32 /* OWNER_NAME_MAX */) { value in
                do { try await workbench.updateOwnerName(value); return nil } catch { return error.riffetMessage }
            }
        }
        .onChange(of: picked) { _, item in
            guard let item else { return }
            picked = nil
            Task {
                await run {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw OwnerAvatarError.unreadable }
                    let avatar = try await Task.detached(priority: .userInitiated) { try OwnerAvatarEncoder.encode(data) }.value
                    try await workbench.uploadOwnerAvatar(avatar.data, type: avatar.type)
                }
            }
        }
    }

    private var header: some View {
        VStack(spacing: 12) {
            Menu {
                Button("从相册选择", systemImage: "photo") { pickingPhoto = true }
                if !styles.isEmpty { Button("随机", systemImage: "dice") { randomizing = true } }
                if workbench.owner?.avatar != nil {
                    Button("移除", systemImage: "trash", role: .destructive) { Task { await run { try await workbench.removeOwnerAvatar() } } }
                }
            } label: {
                OwnerAvatarView(workbench: workbench, owner: workbench.owner, size: 96)
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: "pencil").riffetFont(.caption, weight: .semibold).foregroundStyle(palette.fg2)
                            .frame(width: RiffetMetrics.iconSlot, height: RiffetMetrics.iconSlot)
                            .background(palette.bgSubtle, in: Circle())
                            .overlay(Circle().strokeBorder(palette.line, lineWidth: 0.5))
                    }
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(busy)
            .accessibilityLabel("更换头像")
            Button { editingName = true } label: {
                Text(name.isEmpty ? String(localized: "名称", bundle: .riffet) : name)
                    .riffetFont(.barTitle).foregroundStyle(name.isEmpty ? palette.fg3 : palette.fg).lineLimit(1)
                    .frame(minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
            }.buttonStyle(.plain)
            Text("所有连接这台服务器的设备共用").riffetFont(.caption).foregroundStyle(palette.fg3)
        }.frame(maxWidth: .infinity)
    }

    private func run(_ action: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do { try await action(); error = nil } catch is CancellationError {} catch { self.error = error.riffetMessage }
    }
}

/// Paired servers, pairing another one, and the devices this server has authorised.
private struct ConnectionSettingsView: View {
    let workbench: Workbench?
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var pairing = false
    @State private var pairingTarget: PairedServer?
    var body: some View {
        RiffetForm {
            PairedServersSection(model: model) { server in
                pairingTarget = server
                pairing = true
            }
            Section {
                Button { pairingTarget = nil; pairing = true } label: { Label("配对新服务器", systemImage: "plus") }
                    .disabled(model.connectionBusy)
                if let workbench { NavigationLink { PairDeviceView(workbench: workbench) } label: { Label("配对新设备", systemImage: "qrcode") } }
            }
            if let error = model.error { RiffetNotice.section(.error, error) }
        }
        .navigationTitle(String(localized: "连接与配对", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task { await model.refreshPairedServers() }
        .sheet(isPresented: $pairing) {
            NavigationStack {
                PairingView(model: model, initialServer: pairingTarget).toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { pairing = false }.disabled(model.connectionBusy)
                    }
                }
            }.interactiveDismissDisabled(model.connectionBusy)
        }
    }
}

private struct NotificationSettingsView: View {
    let workbench: Workbench?
    @Environment(\.palette) private var palette
    @State private var error: String?
    private var authorization: UNAuthorizationStatus { RiffetNotifications.shared.authorization }
    var body: some View {
        RiffetForm {
            Section {
                Toggle(isOn: Binding(
                    get: { [.authorized, .provisional, .ephemeral].contains(authorization) },
                    set: { on in
                        if on && authorization == .notDetermined {
                            Task { do { _ = try await RiffetNotifications.shared.requestAuthorization() } catch { self.error = error.localizedDescription } }
                        } else {
                            Task { await RiffetNotifications.shared.openSettings() }
                        }
                    }
                )) {
                    SettingsRowLabel(title: String(localized: "任务提醒", bundle: .riffet), symbol: "bell")
                }.tint(palette.accent)
            } footer: { Text(pushStatus) }
            if authorization == .denied {
                RiffetNotice.section(.warning, String(localized: "系统通知已关闭", bundle: .riffet), actionTitle: String(localized: "去系统设置", bundle: .riffet)) {
                    Task { await RiffetNotifications.shared.openSettings() }
                }
            }
            RiffetNotice.section(.error, error ?? workbench?.notificationError)
        }
        .navigationTitle(String(localized: "通知", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task {
            await RiffetNotifications.shared.refreshAuthorization()
            RiffetPush.shared.report(force: true)
        }
        .onDisappear { error = nil; if let shown = workbench?.notificationError { workbench?.consumeNotificationError(shown) } }
    }
}

extension NotificationSettingsView {
    /// This server's answer about reaching the phone in the background; a server without push says nothing.
    private var pushStatus: String {
        guard let baseURL = workbench?.baseURL, let push = RiffetPush.shared.route(for: baseURL) else {
            return String(localized: "App 被挂起后不再收到提醒。", bundle: .riffet)
        }
        if push.route == "direct" { return String(localized: "后台推送：可用", bundle: .riffet) }
        let reason: String? = switch push.reason {
        case "no_key": String(localized: "服务器未配置推送密钥", bundle: .riffet)
        case "no_token": String(localized: "未允许通知", bundle: .riffet)
        case "failed": push.detail
        default: nil
        }
        guard let reason, !reason.isEmpty else { return String(localized: "后台推送：不可用", bundle: .riffet) }
        return String(localized: "后台推送：不可用（\(reason)）", bundle: .riffet)
    }
}

/// Server-wide file access and the editor the server opens files with.
private struct FilesSettingsView: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @State private var saving = false
    @State private var editingEditor = false
    @State private var error: String?
    private var savedEditor: String { workbench.settings?.editorCommand ?? "" }
    var body: some View {
        RiffetForm {
            Section {
                Toggle("允许预览项目外的文件", isOn: Binding(
                    get: { workbench.settings?.allowOutsideRead?.boolValue != false },
                    set: { value in Task { error = await save(managementSettingsPatch(allowOutsideRead: value)) } }
                )).tint(palette.accent).disabled(saving)
            } header: { RiffetSectionTitle(String(localized: "文件访问", bundle: .riffet)) } footer: { Text("只读打开项目外路径；文件树与搜索仍限项目内。") }

            Section {
                Button { editingEditor = true } label: {
                    SettingsRowLabel(title: String(localized: "编辑器命令", bundle: .riffet), value: savedEditor.isEmpty ? nil : savedEditor)
                        .contentShape(Rectangle())
                }.buttonStyle(.plain)
            } footer: { Text("在服务器电脑上打开文件时使用。") }

            RiffetNotice.section(.error, error)
        }
        .navigationTitle(String(localized: "文件与编辑器", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $editingEditor) {
            SettingsTextEditPage(title: String(localized: "编辑器命令", bundle: .riffet), initial: savedEditor, prompt: "cursor", mono: true) { value in
                await save(managementSettingsPatch(editorCommand: value))
            }
        }
    }
    /// The reason it failed, or nil once saved.
    private func save(_ patch: AppSettingsUpdate) async -> String? {
        guard !saving, let api = workbench.api else { return nil }
        saving = true
        defer { saving = false }
        do {
            let saved = try await api.updateSettings(body: patch)
            workbench.store.applySavedSettings(settings: saved)
            return nil
        } catch { return error.riffetMessage }
    }
}

private struct LaunchTabSettingsView: View {
    @AppStorage(RootTab.launchKey) private var launchRaw = RootTab.assistant.rawValue
    var body: some View {
        RiffetForm {
            Section {
                ForEach(RootTab.allCases, id: \.rawValue) { tab in
                    SettingsCheckRow(title: tab.title, selected: launchRaw == tab.rawValue) { launchRaw = tab.rawValue }
                }
            } footer: { Text("仅保存在这台设备") }
        }
        .navigationTitle(String(localized: "启动时打开", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }
}

private struct InteractionSettingsView: View {
    let workbench: Workbench?
    @Environment(\.palette) private var palette
    @AppStorage("riffet.ios.biometricApprovals") private var biometric = false
    @State private var savingInput = false
    @State private var error: String?
    private var runningBehavior: String { workbench?.settings?.composerRunningBehavior == "steer" ? "steer" : "queue" }
    var body: some View {
        RiffetForm {
            if workbench != nil {
                Section {
                    Picker(String(localized: "运行中发送的消息", bundle: .riffet), selection: Binding(
                        get: { runningBehavior }, set: { value in Task { await saveRunningBehavior(value) } }
                    )) {
                        Text("排队").tag("queue")
                        Text("补充到当前任务").tag("steer")
                    }
                    .pickerStyle(.menu).tint(palette.fg3)
                    .disabled(savingInput)
                    .accessibilityIdentifier("composerRunningBehavior")
                }
            }
            Section {
                Toggle(isOn: Binding(get: { biometric }, set: { enabled in
                    if !enabled { biometric = false; return }
                    Task {
                        do {
                            let allowed = try await AppModel.shared.host.authenticate(reason: String(localized: "开启操作确认前的身份验证", bundle: .riffet))
                            biometric = allowed.boolValue
                            if !biometric { error = String(localized: "没有完成身份验证，设置未开启", bundle: .riffet) }
                        } catch { self.error = error.riffetMessage }
                    }
                })) {
                    SettingsRowLabel(title: String(localized: "确认操作前验证本人", bundle: .riffet), symbol: "faceid")
                }
                .tint(palette.accent)
            } footer: { Text("仅保存在这台设备") }
            RiffetNotice.section(.error, error)
        }
        .navigationTitle(String(localized: "交互与输入", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }

    private func saveRunningBehavior(_ value: String) async {
        guard !savingInput, let workbench, let api = workbench.api else { return }
        guard value != (workbench.settings?.composerRunningBehavior == "steer" ? "steer" : "queue") else { return }
        savingInput = true
        defer { savingInput = false }
        do {
            let saved = try await api.updateSettings(body: managementSettingsPatch(composerRunningBehavior: value))
            workbench.store.applySavedSettings(settings: saved)
            error = nil
        } catch { self.error = error.riffetMessage }
    }
}

private extension View {
    /// Forgetting a paired server: named in the question, confirmed before anything is deleted.
    func forgetServerDialog(_ model: AppModel, target: Binding<PairedServer?>) -> some View {
        confirmationDialog(target.wrappedValue.map { String(localized: "忘记「\($0.displayName)」？", bundle: .riffet) } ?? "",
                           isPresented: Binding(get: { target.wrappedValue != nil }, set: { if !$0 { target.wrappedValue = nil } }),
                           titleVisibility: .visible) {
            Button("忘记", role: .destructive) {
                if let server = target.wrappedValue { Task { await model.forgetServer(server) } }
                target.wrappedValue = nil
            }
        } message: { Text("仅删除本机配对凭据，再次连接需重新配对。") }
    }

    func renameServerSheet(_ model: AppModel, target: Binding<PairedServer?>) -> some View {
        sheet(isPresented: Binding(get: { target.wrappedValue != nil }, set: { if !$0 { target.wrappedValue = nil } })) {
            if let server = target.wrappedValue {
                SettingsTextEditPage(
                    title: String(localized: "重命名服务器", bundle: .riffet), initial: server.name ?? "",
                    prompt: String(localized: "名称", bundle: .riffet),
                    footer: String(localized: "仅保存在这台设备，留空显示地址", bundle: .riffet),
                    valid: { model.host.isValidServerName(name: $0) },
                    invalidMessage: String(localized: "名称需为单行，最多 64 个字符", bundle: .riffet)
                ) { name in
                    if await model.renameServer(server, name: name) { return nil }
                    return model.error ?? String(localized: "操作未完成", bundle: .riffet)
                }
            }
        }
    }
}

/// Shared by settings and the signed-out entry so a saved server stays reachable without an active one.
/// A directory of servers: a row opens the server's page; the same actions sit in its menu and swipe.
/// On the connection page (`connects`) the reader came to connect, so a row connects at once instead.
struct PairedServersSection: View {
    let model: AppModel
    var connects = false
    let onPair: (PairedServer) -> Void
    @Environment(\.palette) private var palette
    @State private var forgetting: PairedServer?
    @State private var renaming: PairedServer?

    private var servers: [PairedServer] {
        model.pairedServers.sorted {
            if model.isCurrent($0) != model.isCurrent($1) { return model.isCurrent($0) }
            return $0.lastUsedAt > $1.lastUsedAt
        }
    }

    var body: some View {
        Section {
            ForEach(servers, id: \.origin) { server in
                Group {
                    if connects {
                        // A server whose pairing has expired cannot be switched to; its row pairs it again.
                        Button {
                            if model.serverFailures[server.origin] == String(localized: "需重新配对", bundle: .riffet) { onPair(server) }
                            else { Task { await model.switchServer(server) } }
                        } label: { row(server).contentShape(Rectangle()) }
                            .buttonStyle(.plain)
                    } else {
                        NavigationLink { ServerDetailView(model: model, origin: server.origin, onPair: onPair) } label: { row(server) }
                    }
                }
                    .disabled(model.connectionBusy)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("忘记服务器", systemImage: "trash", role: .destructive) { forgetting = server }
                        Button("重命名", systemImage: "pencil") { renaming = server }.tint(palette.fg3)
                    }
                    .swipeActions(edge: .leading) {
                        if !model.isCurrent(server) {
                            Button("切换", systemImage: "arrow.left.arrow.right") { Task { await model.switchServer(server) } }.tint(palette.accent)
                        }
                    }
                    .contextMenu {
                        if !model.isCurrent(server) {
                            Button("切换到此服务器", systemImage: "arrow.left.arrow.right") { Task { await model.switchServer(server) } }
                        }
                        Button("重命名", systemImage: "pencil") { renaming = server }
                        Button("重新配对", systemImage: "qrcode.viewfinder") { onPair(server) }
                        Button("忘记服务器", systemImage: "trash", role: .destructive) { forgetting = server }
                    }
            }
        } header: { RiffetSectionTitle(String(localized: "已配对服务器", bundle: .riffet)) } footer: { Text("仅保存在这台设备") }
        .forgetServerDialog(model, target: $forgetting)
        .renameServerSheet(model, target: $renaming)
    }

    private func row(_ server: PairedServer) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(server.displayName).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                Text(server.baseUrl).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
            }
            Spacer(minLength: 0)
            if model.switchingOrigin == server.origin { ProgressView() }
            else if model.isCurrent(server) { Text("当前").riffetFont(.body).foregroundStyle(palette.fg3) }
            else if let failure = model.serverFailures[server.origin] { Text(failure).riffetFont(.caption).foregroundStyle(palette.fg3) }
        }
        .frame(minHeight: RiffetMetrics.rowMinHeight)
        .accessibilityElement(children: .combine)
    }
}

/// One paired server: its address and every action on it.
private struct ServerDetailView: View {
    let model: AppModel
    let origin: String
    let onPair: (PairedServer) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var forgetting: PairedServer?
    @State private var renaming: PairedServer?

    private var server: PairedServer? { model.pairedServers.first { $0.origin == origin } }

    var body: some View {
        RiffetForm {
            if let server {
                Section { RiffetValueRow(label: String(localized: "地址", bundle: .riffet), value: server.baseUrl, mono: true) }
                Section {
                    if !model.isCurrent(server) {
                        Button { Task { await model.switchServer(server) } } label: { Label("切换到此服务器", systemImage: "arrow.left.arrow.right") }
                    }
                    Button { renaming = server } label: { Label("重命名", systemImage: "pencil") }
                    Button { onPair(server); dismiss() } label: { Label("重新配对", systemImage: "qrcode.viewfinder") }
                }
                Section {
                    Button(role: .destructive) { forgetting = server } label: { Label("忘记服务器", systemImage: "trash") }
                }
                RiffetNotice.section(.error, model.error)
            }
        }
        .disabled(model.connectionBusy)
        .navigationTitle(server?.displayName ?? "").navigationBarTitleDisplayMode(.inline)
        .onChange(of: server == nil) { _, gone in if gone { dismiss() } }
        .forgetServerDialog(model, target: $forgetting)
        .renameServerSheet(model, target: $renaming)
    }
}

private struct DevicesView: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var devices: [PublicDevice] = []
    @State private var currentID: String?
    @State private var loaded = false
    @State private var target: PublicDevice?
    @State private var removingOlder = false
    @State private var showOlder = false
    @State private var busy = false
    @State private var error: String?
    @State private var appearanceAllowed = false
    @State private var savingAppearance = false

    /// Unseen this long, a record is folded away: usually one left behind by re-pairing.
    private static let idleInterval: TimeInterval = 7 * 24 * 60 * 60

    var body: some View {
        let now = Date()
        let recent = devices.filter { !isIdle($0, now) }
        let older = devices.filter { isIdle($0, now) }
        // Two records under one name are told apart by when each was paired.
        let names = Dictionary(grouping: devices, by: \.name).filter { $0.value.count > 1 }.keys
        RiffetList {
            Section {
                Toggle(isOn: Binding(get: { appearanceAllowed }, set: { enabled in
                    Task { await setAppearanceAllowed(enabled) }
                })) {
                    Text(String(localized: "允许助理修改本机 Riffet 外观", bundle: .riffet))
                }
                .disabled(savingAppearance || currentID == nil)
            } footer: {
                Text(String(localized: "仅在 Riffet 连接此服务器并在前台时生效。", bundle: .riffet))
            }
            RiffetNotice.section(.error, error, actionTitle: String(localized: "重新读取", bundle: .riffet)) { Task { await load() } }
            if !recent.isEmpty {
                Section { ForEach(recent, id: \.id) { row($0, pairedDate: names.contains($0.name)) } }
            }
            if !older.isEmpty {
                Section {
                    Button { withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) { showOlder.toggle() } } label: {
                        HStack {
                            Text("较早的设备 · \(older.count)").riffetFont(.body).foregroundStyle(palette.fg)
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right").riffetFont(.caption, weight: .semibold).foregroundStyle(palette.fg3)
                                .rotationEffect(.degrees(showOlder ? 90 : 0))
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    if showOlder { ForEach(older, id: \.id) { row($0, pairedDate: names.contains($0.name)) } }
                }
            }
        }
        .overlay {
            if loaded && devices.isEmpty && error == nil { ContentUnavailableView("没有已配对的设备", systemImage: "iphone.slash") }
        }
        .navigationTitle(String(localized: "已授权设备", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !older.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("移除较早的设备", systemImage: "trash", role: .destructive) { removingOlder = true }.disabled(busy)
                    } label: { Image(systemName: "ellipsis") }.accessibilityLabel("更多")
                }
            }
        }
        .task { await load(); await readAppearancePermission() }
        .refreshable { await load() }
        .confirmationDialog(target.map { String(localized: "撤销「\($0.name)」的授权？", bundle: .riffet) } ?? "", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }), titleVisibility: .visible) {
            Button("撤销授权", role: .destructive) {
                if let target { Task { await revoke([target.id]) } }
                target = nil
            }
        } message: {
            if target?.id == currentID { Text("这台设备会退出登录，需要重新配对") }
        }
        .confirmationDialog("移除 \(older.count) 台设备？", isPresented: $removingOlder, titleVisibility: .visible) {
            Button("移除", role: .destructive) { Task { await revoke(older.map(\.id)) } }
        } message: { Text("移除后需要重新配对") }
    }

    private func row(_ device: PublicDevice, pairedDate: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon(device)).riffetFont(.barTitle, weight: .regular).foregroundStyle(palette.fg2).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                HStack(spacing: 6) {
                    if device.online { Circle().fill(palette.success).frame(width: 7, height: 7) }
                    Text(subtitle(device, pairedDate: pairedDate)).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .swipeActions(edge: .trailing) { Button("撤销", role: .destructive) { target = device }.disabled(busy) }
        .contextMenu { Button("撤销", role: .destructive) { target = device } }
    }

    private func icon(_ device: PublicDevice) -> String {
        switch device.platform {
        case "ios", "android": "iphone"
        case "mac": "laptopcomputer"
        default: "globe"
        }
    }

    private func readAppearancePermission() async {
        guard let api = workbench.api else { return }
        appearanceAllowed = (try? await workbench.host.appearanceAllowed(api: api))?.boolValue ?? false
    }

    private func setAppearanceAllowed(_ enabled: Bool) async {
        guard !savingAppearance, AppModel.shared.workbench === workbench, let api = workbench.api else { return }
        savingAppearance = true
        defer { savingAppearance = false }
        do { appearanceAllowed = try await workbench.host.setAppearanceAllowed(api: api, enabled: enabled).boolValue }
        catch { self.error = error.riffetMessage }
    }

    private func subtitle(_ device: PublicDevice, pairedDate: Bool) -> String {
        var parts: [String] = []
        if device.id == currentID { parts.append(String(localized: "本机", bundle: .riffet)) }
        if device.online { parts.append(String(localized: "在线", bundle: .riffet)) }
        else if let seen = device.lastSeenAt.flatMap(Self.date) {
            parts.append(String(localized: "最后在线 \(Self.relativeText(seen))", bundle: .riffet))
        }
        let platform = switch device.platform {
        case "ios": "iOS"
        case "android": "Android"
        case "mac": "Mac"
        default: ""
        }
        let app = [platform, device.appVersion ?? ""].filter { !$0.isEmpty }.joined(separator: " ")
        if !app.isEmpty { parts.append(app) }
        if pairedDate, let created = Self.date(device.createdAt) {
            parts.append(String(localized: "配对于 \(created.formatted(.dateTime.month(.defaultDigits).day().locale(AppLocalization.shared.locale)))", bundle: .riffet))
        }
        return parts.joined(separator: " · ")
    }

    private func isIdle(_ device: PublicDevice, _ now: Date) -> Bool {
        guard device.id != currentID, !device.online,
              let seen = Self.date(device.lastSeenAt ?? device.createdAt) else { return false }
        return now.timeIntervalSince(seen) > Self.idleInterval
    }

    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    private static func relativeText(_ date: Date) -> String {
        relative.locale = AppLocalization.shared.locale
        return relative.localizedString(for: date, relativeTo: Date())
    }

    private static func date(_ value: String) -> Date? { ServerTime.date(value) }

    /// Online first, then the most recently seen.
    private static func presence(_ a: PublicDevice, _ b: PublicDevice) -> Bool {
        if a.online != b.online { return a.online }
        return (a.lastSeenAt ?? "") > (b.lastSeenAt ?? "")
    }

    private func load() async {
        do {
            devices = (try await workbench.api?.devices() ?? []).sorted(by: Self.presence)
            // The device token is `wkn_<id>_<secret>`; only the id is read, and nothing is kept of the rest.
            let header = try? await workbench.host.authorizationFor(url: workbench.baseURL.absoluteString)
            currentID = header?.split(separator: "_", maxSplits: 2).dropFirst().first.map(String.init)
            error = nil
        } catch is CancellationError {} catch { self.error = error.riffetMessage }
        loaded = true
    }

    private func revoke(_ ids: [String]) async {
        busy = true
        defer { busy = false }
        do {
            for id in ids { try await workbench.api?.revokeDevice(id: id) }
            error = nil
        } catch is CancellationError {} catch { self.error = error.riffetMessage }
        await load()
        workbench.refresh()
    }
}

private struct AboutSettingsView: View {
    let version: String
    @Environment(\.palette) private var palette
    private static let repositoryURL = URL(string: "https://github.com/riffable/riffet")!

    var body: some View {
        RiffetForm {
            Section {
                SettingsRowLabel(title: String(localized: "版本", bundle: .riffet), value: version)
            }
            Section {
                Link(destination: Self.repositoryURL) {
                    HStack(spacing: RiffetMetrics.floatingGap) {
                        SettingsRowLabel(title: "GitHub", value: "riffable/riffet")
                        Image(systemName: "arrow.up.right")
                            .riffetFont(.label)
                            .foregroundStyle(palette.fg4)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .navigationTitle(String(localized: "关于 Riffet", bundle: .riffet))
        .navigationBarTitleDisplayMode(.inline)
    }
}
