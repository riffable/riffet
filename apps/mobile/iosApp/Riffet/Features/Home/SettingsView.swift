import PhotosUI
import SwiftUI
import UserNotifications
import RiffetKit

/// The container of every settings page: the white page, grey group cards, rows at least 52 high.
struct RiffetForm<Content: View>: View {
    private let content: Content
    @Environment(\.palette) private var palette
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        Form { Group { content }.listRowBackground(palette.bgSubtle) }
            .scrollContentBackground(.hidden).background(palette.bg)
            .environment(\.defaultMinListRowHeight, RiffetMetrics.settingsRowHeight)
    }
}

/// `RiffetForm`'s counterpart for pages built as a list.
struct RiffetList<Content: View>: View {
    private let content: Content
    @Environment(\.palette) private var palette
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        List { Group { content }.listRowBackground(palette.bgSubtle) }
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
            .contentMargins(.top, 4, for: .scrollContent)
            .scrollContentBackground(.hidden).background(palette.bg)
            .environment(\.defaultMinListRowHeight, RiffetMetrics.settingsRowHeight)
    }
}

// MARK: - Settings parts
//
// Every settings page is built from these: a grouped list, rows with a symbol tile, a trailing
// value in the third text colour, a check mark for a choice, and a one-line message for errors.
// Sections carry no headers unless the page has several groups of the same kind; footers only say
// what a reader could not infer (where it is stored, when it takes effect).

/// A row's symbol on a small tile: the page colour on the row's grey, so glyphs of different
/// optical sizes sit on the same square.
struct SettingsIcon: View {
    let symbol: String
    @Environment(\.palette) private var palette
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(palette.fg2)
            .frame(width: 30, height: 30)
            .background(palette.bg, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(palette.lineSoft, lineWidth: 0.5))
            .accessibilityHidden(true)
    }
}

/// A settings row: tile, title, and an optional value on the trailing edge.
struct SettingsRowLabel: View {
    let title: String
    var symbol: String?
    var value: String?
    @Environment(\.palette) private var palette
    var body: some View {
        HStack(spacing: 12) {
            if let symbol { SettingsIcon(symbol: symbol) }
            Text(title).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
            Spacer(minLength: 8)
            if let value { Text(value).riffetFont(.body).foregroundStyle(palette.fg3).lineLimit(1) }
        }
    }
}

/// One choice of several: the title, an optional second line, and the accent check when picked.
struct SettingsCheckRow: View {
    let title: String
    var subtitle: String?
    let selected: Bool
    let action: () -> Void
    @Environment(\.palette) private var palette
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).riffetFont(.body).foregroundStyle(palette.fg)
                    if let subtitle { Text(subtitle).riffetFont(.caption).foregroundStyle(palette.fg3) }
                }
                Spacer(minLength: 8)
                Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.accent)
                    .opacity(selected ? 1 : 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// An error or a server's notice inside a settings list: its own quiet section, selectable.
struct SettingsMessage: View {
    let text: String
    var error = true
    @Environment(\.palette) private var palette
    var body: some View {
        Section {
            Label { Text(text).textSelection(.enabled) } icon: {
                Image(systemName: error ? "exclamationmark.circle" : "info.circle")
            }
            .riffetFont(.caption).foregroundStyle(error ? palette.danger : palette.fg2)
        }
    }
}

/// A row of scope chips above a settings list, outside any card.
struct SettingsChipRow<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) { content() }.padding(.horizontal, RiffetMetrics.pageInset)
        }
        .scrollClipDisabled()
        .listRowInsets(EdgeInsets()).listRowBackground(Color.clear).listRowSeparator(.hidden)
    }
}

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
    let workbench: Workbench
    @Environment(AppModel.self) private var model
    @Environment(ThemeStore.self) private var themeStore
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var widthClass
    @Environment(\.verticalSizeClass) private var heightClass
    @State private var query = ""
    @State private var deviceCount: Int?
    @State private var exporting = false
    @State private var exportError: String?
    @State private var logFile: LogFile?

    var body: some View {
        let groups = visibleGroups
        RiffetList {
            if query.isEmpty { Section { profile } }
            ForEach(groups) { group in
                Section {
                    ForEach(group.entries) { row($0) }
                } header: {
                    Text(group.title).riffetFont(.label).foregroundStyle(palette.fg3).textCase(nil)
                }
            }
            if let exportError { SettingsMessage(text: exportError) }
        }
        .overlay {
            if groups.isEmpty && !query.isEmpty { ContentUnavailableView.search(text: query) }
        }
        .riffetSoftEdges()
        .overlay(alignment: .top) { RiffetBarScrim() }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: String(localized: "搜索设置", bundle: .riffet))
        .navigationTitle(String(localized: "设置", bundle: .riffet)).navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .bottomBar)
        .background(TabBarVisibility(hidden: false))
        .sheet(item: $logFile) { NativeShareSheet(items: [$0.url]).presentationDetents([.medium, .large]) }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await RiffetNotifications.shared.refreshAuthorization()
            await model.refreshPairedServers()
            await workbench.refreshOwner()
            if let devices = try? await workbench.api?.devices() { deviceCount = devices.count }
        }
    }

    /// A phone's settings page covers the tab bar; a wide window keeps its tabs in reach, as 任务 does.
    private var pushHidesTabs: Bool { !(widthClass == .regular && heightClass == .regular) }

    private var profile: some View {
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
        let state = workbench.serverReachable ? String(localized: "已连接", bundle: .riffet) : String(localized: "未连接", bundle: .riffet)
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
        var appearance = [
            SettingsEntry(title: String(localized: "主题", bundle: .riffet), icon: "paintpalette", value: themeStore.entry.name, kind: .link { AnyView(ThemeSettingsView()) }),
            SettingsEntry(title: String(localized: "显示模式", bundle: .riffet), icon: "circle.lefthalf.filled", value: displayModeName, kind: .link { AnyView(DisplayModeSettingsView()) }),
        ]
        if UIApplication.shared.supportsAlternateIcons {
            appearance.append(SettingsEntry(title: String(localized: "应用图标", bundle: .riffet), icon: "app", value: AppIconVariant.current.name, kind: .link { AnyView(AppIconSetting()) }))
        }
        return [
            SettingsGroup(title: String(localized: "通用", bundle: .riffet), entries: [
                SettingsEntry(title: String(localized: "语言", bundle: .riffet), icon: "globe", value: AppLanguage.current.name, kind: .link { AnyView(LanguageSettingsView()) }),
                SettingsEntry(title: String(localized: "Agent 扩展", bundle: .riffet), icon: "puzzlepiece.extension", kind: .link { AnyView(NativeExtensionsView(workbench: workbench)) }),
            ]),
            SettingsGroup(title: String(localized: "外观", bundle: .riffet), entries: appearance),
            SettingsGroup(title: String(localized: "行为", bundle: .riffet), entries: [
                SettingsEntry(title: String(localized: "交互与输入", bundle: .riffet), icon: "keyboard", kind: .link { AnyView(InteractionSettingsView(workbench: workbench)) }),
                SettingsEntry(title: String(localized: "通知", bundle: .riffet), icon: "bell", value: settingsNotificationStatus(), kind: .link { AnyView(NotificationSettingsView(workbench: workbench)) }),
                SettingsEntry(title: String(localized: "文件与编辑器", bundle: .riffet), icon: "doc.text", kind: .link { AnyView(FilesSettingsView(workbench: workbench)) }),
            ]),
            SettingsGroup(title: String(localized: "模型", bundle: .riffet), entries: [
                SettingsEntry(title: String(localized: "提供商与模型", bundle: .riffet), icon: "server.rack", value: defaultAgentName, identifier: "nativeManagement", kind: .link { AnyView(NativeProvidersView(workbench: workbench)) }),
                SettingsEntry(title: String(localized: "辅助模型", bundle: .riffet), icon: "brain", kind: .link { AnyView(AuxiliaryModelsView(workbench: workbench)) }),
                SettingsEntry(title: String(localized: "快速对话", bundle: .riffet), icon: "bubble.left", kind: .link { AnyView(QuickChatSettingsView(workbench: workbench)) }),
            ]),
            SettingsGroup(title: String(localized: "连接", bundle: .riffet), entries: [
                SettingsEntry(title: String(localized: "连接与配对", bundle: .riffet), icon: "link", value: model.pairedServers.first(where: model.isCurrent)?.displayName, kind: .link { AnyView(ConnectionSettingsView(workbench: workbench)) }),
                SettingsEntry(title: String(localized: "服务器状态", bundle: .riffet), icon: "gauge.with.dots.needle.33percent", identifier: "serviceStatus", kind: .link { AnyView(ServiceStatusView(workbench: workbench)) }),
                SettingsEntry(title: String(localized: "已授权设备", bundle: .riffet), icon: "iphone", value: deviceCount.map(String.init), kind: .link { AnyView(DevicesView(workbench: workbench)) }),
            ]),
            SettingsGroup(title: String(localized: "支持", bundle: .riffet), entries: [
                SettingsEntry(title: String(localized: "使用统计", bundle: .riffet), icon: "chart.bar", kind: .link { AnyView(NativeStatsView(workbench: workbench)) }),
                SettingsEntry(title: String(localized: "导出日志", bundle: .riffet), icon: "square.and.arrow.up", busy: exporting, kind: .action { Task { await exportLog() } }),
                SettingsEntry(title: String(localized: "版本", bundle: .riffet), icon: "info.circle", value: appVersion, kind: .plain),
            ]),
        ]
    }

    @AppStorage("riffet.ios.appearance") private var appearanceMode = "system"
    private var displayModeName: String {
        switch appearanceMode {
        case "light": String(localized: "浅色", bundle: .riffet)
        case "dark": String(localized: "深色", bundle: .riffet)
        default: String(localized: "跟随系统", bundle: .riffet)
        }
    }

    private var defaultAgentName: String? {
        workbench.settings?.defaultBackendId.map { managementBackendName($0, workbench) }
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

/// The owner's name and avatar, shared by every device paired with this server.
private struct OwnerProfileView: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @State private var name = ""
    @State private var submitted: String?
    @State private var picked: PhotosPickerItem?
    @State private var busy = false
    @State private var error: String?
    @State private var styles: [OwnerAvatarStyle] = []
    @State private var randomizing = false
    @FocusState private var focused: Bool
    var body: some View {
        RiffetForm {
            Section {
                VStack(spacing: 12) {
                    OwnerAvatarView(workbench: workbench, owner: workbench.owner, size: 96)
                    HStack(spacing: 12) {
                        PhotosPicker(selection: $picked, matching: .images) { Text("更换头像") }
                        if !styles.isEmpty {
                            Button { randomizing = true } label: { Label("随机头像", systemImage: "dice") }
                        }
                        if workbench.owner?.avatar != nil {
                            Button("移除", role: .destructive) { Task { await run { try await workbench.removeOwnerAvatar() } } }
                        }
                    }.buttonStyle(.bordered).disabled(busy)
                }.frame(maxWidth: .infinity)
            }.listRowBackground(Color.clear)
            Section {
                LabeledContent("名称") {
                    TextField("", text: $name).multilineTextAlignment(.trailing).focused($focused).submitLabel(.done)
                        .onSubmit { saveName() }
                }
            } footer: { Text("所有连接这台服务器的设备共用") }
            if let history = workbench.owner?.history, !history.isEmpty {
                Section("历史头像") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(history, id: \.sha256) { avatar in
                                Button { Task { await run { try await workbench.restoreOwnerAvatar(avatar) } } } label: {
                                    OwnerAvatarView(workbench: workbench, owner: nil, size: 44, url: workbench.ownerAvatarURL(avatar))
                                }
                                .buttonStyle(.plain).disabled(busy)
                                .contextMenu {
                                    Button("删除", role: .destructive) { Task { await run { try await workbench.deleteOwnerAvatarHistory(avatar) } } }
                                }
                            }
                        }.padding(.vertical, 4)
                    }
                }
            }
            if let error { SettingsMessage(text: error) }
        }
        .navigationTitle(String(localized: "个人资料", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task { styles = await workbench.ownerAvatarStyles() }
        .sheet(isPresented: $randomizing) {
            RandomAvatarSheet(workbench: workbench, styles: styles) { style, seed, ink, paper in
                await run { try await workbench.generateOwnerAvatar(style: style, seed: seed, ink: ink, paper: paper) }
            }
        }
        .task(id: workbench.owner?.name) { if !focused { name = workbench.owner?.name ?? "" } }
        .onChange(of: name) { _, value in
            let limit = 32 // OWNER_NAME_MAX
            if value.unicodeScalars.count > limit { name = String(String.UnicodeScalarView(value.unicodeScalars.prefix(limit))) }
        }
        .onChange(of: focused) { _, isFocused in if !isFocused { saveName() } }
        .onDisappear { saveName() }
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
    private func saveName() {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value != (submitted ?? workbench.owner?.name ?? "") else { return }
        submitted = value
        Task {
            // Only a save in flight is skipped as a repeat; once it settles, the server's name is the reference again.
            defer { submitted = nil }
            do { try await workbench.updateOwnerName(value); error = nil }
            catch is CancellationError {} catch { self.error = error.riffetMessage }
        }
    }
    private func run(_ action: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do { try await action(); error = nil } catch is CancellationError {} catch { self.error = error.riffetMessage }
    }
}

/// Paired servers, pairing another one, and the devices this server has authorised.
private struct ConnectionSettingsView: View {
    let workbench: Workbench
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
                NavigationLink { PairDeviceView(workbench: workbench) } label: { Label("配对新设备", systemImage: "qrcode") }
            }
            if let error = model.error { SettingsMessage(text: error) }
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
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @State private var error: String?
    var body: some View {
        RiffetForm {
            Section {
                LabeledContent {
                    Text(settingsNotificationStatus()).riffetFont(.body).foregroundStyle(palette.fg3)
                } label: {
                    SettingsRowLabel(title: String(localized: "任务提醒", bundle: .riffet), symbol: "bell")
                }
                Button {
                    if RiffetNotifications.shared.authorization == .notDetermined {
                        Task { do { _ = try await RiffetNotifications.shared.requestAuthorization() } catch { self.error = error.localizedDescription } }
                    } else {
                        Task { await RiffetNotifications.shared.openSettings() }
                    }
                } label: {
                    Text(RiffetNotifications.shared.authorization == .notDetermined ? "启用任务提醒" : "打开系统通知设置")
                        .riffetFont(.body).foregroundStyle(palette.accent)
                }
            } footer: { Text("App 被挂起后不再收到提醒。") }
            if let message = error ?? workbench.notificationError {
                SettingsMessage(text: message)
            }
        }
        .navigationTitle(String(localized: "通知", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task { await RiffetNotifications.shared.refreshAuthorization() }
        .onDisappear { error = nil; if let shown = workbench.notificationError { workbench.consumeNotificationError(shown) } }
    }
}

/// Server-wide file access and the editor the server opens files with.
private struct FilesSettingsView: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @State private var editor = ""
    @State private var saving = false
    @State private var error: String?
    private var savedEditor: String { workbench.settings?.editorCommand ?? "" }
    var body: some View {
        RiffetForm {
            Section {
                Toggle("允许预览项目外的文件", isOn: Binding(
                    get: { workbench.settings?.allowOutsideRead?.boolValue == true },
                    set: { value in Task { await save(managementSettingsPatch(allowOutsideRead: value)) } }
                )).tint(palette.accent).disabled(saving)
            } header: { Text("文件访问") } footer: { Text("只读打开项目外路径；文件树与搜索仍限项目内。") }

            Section {
                TextField("cursor", text: $editor).riffetFont(.mono)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(saving)
                    .submitLabel(.done).onSubmit { saveEditor() }
                if editor != savedEditor {
                    Button { saveEditor() } label: { Text("保存").riffetFont(.body).foregroundStyle(palette.accent) }.disabled(saving)
                }
            } header: { Text("编辑器命令") } footer: { Text("在服务器电脑上打开文件时使用。") }

            if let error { SettingsMessage(text: error) }
        }
        .navigationTitle(String(localized: "文件与编辑器", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .onAppear { editor = savedEditor }
    }
    private func saveEditor() {
        guard editor != savedEditor else { return }
        Task { await save(managementSettingsPatch(editorCommand: editor.trimmingCharacters(in: .whitespacesAndNewlines))) }
    }
    private func save(_ patch: AppSettingsUpdate) async {
        guard !saving, let api = workbench.api else { return }
        saving = true
        defer { saving = false }
        do {
            let saved = try await api.updateSettings(body: patch)
            workbench.store.applySavedSettings(settings: saved)
            editor = saved.editorCommand ?? ""
            error = nil
        } catch { self.error = error.riffetMessage }
    }
}

private struct InteractionSettingsView: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @AppStorage("riffet.ios.biometricApprovals") private var biometric = false
    @State private var savingInput = false
    @State private var error: String?
    private var runningBehavior: String { workbench.settings?.composerRunningBehavior == "steer" ? "steer" : "queue" }
    var body: some View {
        RiffetForm {
            Section {
                SettingsCheckRow(title: String(localized: "排队", bundle: .riffet), selected: runningBehavior == "queue") { Task { await saveRunningBehavior("queue") } }
                SettingsCheckRow(title: String(localized: "补充到当前任务", bundle: .riffet), selected: runningBehavior == "steer") { Task { await saveRunningBehavior("steer") } }
            } header: {
                Text("运行中发送的消息").riffetFont(.label).foregroundStyle(palette.fg3).textCase(nil)
            }
            .disabled(savingInput)
            .accessibilityIdentifier("composerRunningBehavior")
            Section {
                Toggle(isOn: Binding(get: { biometric }, set: { enabled in
                    if !enabled { biometric = false; return }
                    Task {
                        do {
                            let allowed = try await workbench.host.authenticate(reason: String(localized: "开启操作确认前的身份验证", bundle: .riffet))
                            biometric = allowed.boolValue
                            if !biometric { error = String(localized: "没有完成身份验证，设置未开启", bundle: .riffet) }
                        } catch { self.error = error.riffetMessage }
                    }
                })) {
                    SettingsRowLabel(title: String(localized: "确认操作前验证本人", bundle: .riffet), symbol: "faceid")
                }
                .tint(palette.accent)
            } footer: { Text("仅保存在这台设备") }
            if let error { SettingsMessage(text: error) }
        }
        .navigationTitle(String(localized: "交互与输入", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }

    private func saveRunningBehavior(_ value: String) async {
        guard !savingInput, let api = workbench.api else { return }
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

/// Shared by settings and the signed-out entry so a saved server stays reachable without an active one.
struct PairedServersSection: View {
    let model: AppModel
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
                HStack(spacing: 12) {
                    Button {
                        if model.serverFailures[server.origin] == String(localized: "需重新配对", bundle: .riffet) { onPair(server) }
                        else { Task { await model.switchServer(server) } }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.accent)
                                .opacity(model.isCurrent(server) ? 1 : 0).frame(width: 20)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(server.displayName).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                                Text(server.baseUrl).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            if model.switchingOrigin == server.origin { ProgressView() }
                            else if let failure = model.serverFailures[server.origin] {
                                Text(failure).riffetFont(.caption).foregroundStyle(palette.fg3)
                            }
                        }.frame(maxWidth: .infinity, minHeight: 64, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .accessibilityValue(model.isCurrent(server) ? String(localized: "当前服务器", bundle: .riffet) : model.serverFailures[server.origin] ?? "")
                    Menu {
                        Text(server.baseUrl)
                        Button("重命名", systemImage: "pencil") { renaming = server }
                        Button("重新配对", systemImage: "qrcode.viewfinder") { onPair(server) }
                        Button("忘记服务器", systemImage: "trash", role: .destructive) { forgetting = server }
                    } label: {
                        Image(systemName: "ellipsis").foregroundStyle(palette.fg2).frame(width: 44, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel("服务器选项")
                }
                .disabled(model.connectionBusy)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 8))
            }
        } header: { Text("已配对服务器") } footer: { Text("仅保存在这台设备") }
        .confirmationDialog("忘记服务器？", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }), titleVisibility: .visible) {
            Button("忘记服务器", role: .destructive) {
                if let server = forgetting { Task { await model.forgetServer(server) } }
                forgetting = nil
            }
        } message: { Text("仅删除本机配对凭据，再次连接需重新配对。") }
        .sheet(isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            if let server = renaming { RenameServerSheet(model: model, server: server) }
        }
    }
}

private struct RenameServerSheet: View {
    let model: AppModel
    let server: PairedServer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var value: String
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focused: Bool

    init(model: AppModel, server: PairedServer) {
        self.model = model; self.server = server
        _value = State(initialValue: server.name ?? "")
    }

    private var name: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool { model.host.isValidServerName(name: name) }

    var body: some View {
        NavigationStack {
            RiffetForm {
                Section {
                    TextField("名称", text: $value)
                        .focused($focused)
                        .disabled(saving)
                } footer: {
                    if valid { Text("仅保存在这台设备，留空显示地址") }
                    else { Text("名称需为单行，最多 64 个字符").foregroundStyle(palette.danger) }
                }
                if let error { Text(error).foregroundStyle(palette.danger) }
            }
            .navigationTitle(String(localized: "重命名服务器", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "保存中…" : "保存") { Task { await save() } }
                        .disabled(saving || !valid)
                }
            }
            .interactiveDismissDisabled(saving)
            .task { focused = true }
        }.presentationDetents([.medium, .large])
    }

    private func save() async {
        guard !saving, valid else { return }
        saving = true; error = nil
        defer { saving = false }
        if await model.renameServer(server, name: name) { dismiss() }
        else { error = model.error ?? String(localized: "操作未完成", bundle: .riffet) }
    }
}

private struct DevicesView: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @State private var devices: [PublicDevice] = []
    @State private var currentID: String?
    @State private var loaded = false
    @State private var target: PublicDevice?
    @State private var removingOlder = false
    @State private var showOlder = false
    @State private var busy = false
    @State private var error: String?

    /// Unseen this long, a record is folded away: usually one left behind by re-pairing.
    private static let idleInterval: TimeInterval = 7 * 24 * 60 * 60

    var body: some View {
        let now = Date()
        let recent = devices.filter { !isIdle($0, now) }
        let older = devices.filter { isIdle($0, now) }
        // Two records under one name are told apart by when each was paired.
        let names = Dictionary(grouping: devices, by: \.name).filter { $0.value.count > 1 }.keys
        RiffetList {
            if let error { Section { Text(error).foregroundStyle(palette.danger) } }
            if !recent.isEmpty {
                Section { ForEach(recent, id: \.id) { row($0, pairedDate: names.contains($0.name)) } }
            }
            if !older.isEmpty {
                Section {
                    if showOlder { ForEach(older, id: \.id) { row($0, pairedDate: names.contains($0.name)) } }
                } header: {
                    HStack {
                        Button { withAnimation(RiffetMotion.spatial) { showOlder.toggle() } } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).rotationEffect(.degrees(showOlder ? 90 : 0))
                                Text("较早的设备 · \(older.count)")
                            }
                        }
                        Spacer()
                        Button("全部移除", role: .destructive) { removingOlder = true }.disabled(busy)
                    }
                    .riffetFont(.label).textCase(nil).foregroundStyle(palette.fg3)
                    .buttonStyle(.borderless)
                }
            }
        }
        .overlay {
            if loaded && devices.isEmpty && error == nil { ContentUnavailableView("没有已配对的设备", systemImage: "iphone.slash") }
        }
        .navigationTitle(String(localized: "已授权设备", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog("撤销这个设备的授权？", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }), titleVisibility: .visible) {
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
            Image(systemName: icon(device)).font(.system(size: 18)).foregroundStyle(palette.fg2).frame(width: 22)
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

    private static func date(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

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
