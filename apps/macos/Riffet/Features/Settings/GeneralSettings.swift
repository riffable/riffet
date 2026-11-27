import AppKit
import ServiceManagement
import SwiftUI
import UserNotifications
import RiffetKit

/// 通用设置: the interface language, how Riffet starts and stays in the menu bar, and the Touch ID
/// check before approvals (this Mac's, for every Agent).
struct GeneralSettings: View {
    @AppStorage("riffet.menu-bar-only") private var menuBarOnly = false
    @AppStorage(MenuBarLabel.progressKey) private var menuBarProgress = false
    @AppStorage("riffet.touchid-approvals") private var touchID = false
    /// What the toggle shows. The system's answer is read off the main thread (`SMAppService.status`
    /// is a synchronous XPC call); until it arrives the last answer this run read is shown.
    @State private var launchAtLogin = LoginItemStatus.known ?? false
    /// The system's last answer; a toggle change that only mirrors it registers nothing.
    @State private var loginEnabled = LoginItemStatus.known
    @State private var loginError: String?
    @State private var language = AppLanguage.chosen

    var body: some View {
        Form {
            SettingsBlock("语言") {
                SettingsRow("界面语言") {
                    FormSegmented("界面语言", selection: $language) {
                        ForEach(AppLanguage.allCases) { Text(verbatim: $0.name).tag($0) }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                if language != AppLanguage.running {
                    HStack(spacing: Space.sm) {
                        SettingsHint("重启后生效。")
                        Spacer(minLength: Space.sm)
                        Button("重启 Riffet") { AppLanguage.restart() }
                            .buttonStyle(SolidButtonStyle(kind: .secondary))
                            .controlSize(.small)
                    }
                }
            }

            SettingsBlock("启动与菜单栏") {
                SettingsRow("登录时打开 Riffet") {
                    Toggle("登录时打开 Riffet", isOn: $launchAtLogin)
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .onChange(of: launchAtLogin) { _, on in updateLoginItem(on) }
                }
                if let loginError {
                    SettingsCallout(.danger, message: loginError)
                }
                SettingsRow("关闭窗口后只保留菜单栏图标") {
                    Toggle("关闭窗口后只保留菜单栏图标", isOn: $menuBarOnly)
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .onChange(of: menuBarOnly) { _, _ in AppPresence.apply() }
                }
                SettingsRow("在菜单栏显示运行进度") {
                    Toggle("在菜单栏显示运行进度", isOn: $menuBarProgress)
                        .labelsHidden()
                        .toggleStyle(.switch)
                }
            }

            SettingsBlock("审批") {
                SettingsRow(String(localized: "审批前验证 Touch ID"), detail: String(localized: "未通过时 Agent 继续等待。")) {
                    Toggle("审批前验证 Touch ID", isOn: $touchID)
                        .labelsHidden()
                        .toggleStyle(.switch)
                }
            }

            SettingsScopeFooter()
        }
        .riffetForm()
        .task { await refreshLoginItem() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refreshLoginItem() }
        }
        .onChange(of: language) { _, value in AppLanguage.chosen = value }
    }

    /// Registering can fail (for example when the login item is unavailable). Reverting the toggle
    /// keeps it showing what the system actually accepted; the guard stops the revert's own
    /// `onChange` from retrying the failed call and clearing the message.
    private func updateLoginItem(_ enabled: Bool) {
        guard enabled != loginEnabled else { return }
        let current = SMAppService.mainApp.status == .enabled
        guard enabled != current else {
            loginEnabled = current
            LoginItemStatus.known = current
            return
        }
        do {
            try LoginItem.set(enabled)
            loginEnabled = enabled
            LoginItemStatus.known = enabled
            loginError = nil
        } catch {
            loginEnabled = current
            LoginItemStatus.known = current
            launchAtLogin = current
            loginError = enabled
                ? String(localized: "无法启用「登录时打开」：\(error.localizedDescription)")
                : String(localized: "无法停用「登录时打开」：\(error.localizedDescription)")
        }
    }

    private func refreshLoginItem() async {
        let enabled = await LoginItemStatus.read()
        LoginItemStatus.known = enabled
        // Recorded before the toggle moves, so its `onChange` sees nothing to register.
        loginEnabled = enabled
        if launchAtLogin != enabled { launchAtLogin = enabled }
    }
}

/// 通知: the Mac's own notifications and their system permission, plus the server's switch that
/// browsers follow.
struct NotificationSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @AppStorage("riffet.notifications") private var notifications = true
    @State private var permission = String(localized: "检测中")
    @State private var permissionDenied = false
    @State private var serverBusy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                SettingsRow("会话完成、失败或等待确认时通知我") {
                    Toggle("会话完成、失败或等待确认时通知我", isOn: $notifications)
                        .labelsHidden()
                        .toggleStyle(.switch)
                }

                // Only a permission that is missing is shown; an allowed one needs nothing.
                if permissionMissing {
                    SettingsRow("系统通知权限") {
                        HStack(spacing: Space.sm) {
                            SettingsStatusBadge(text: permission, tint: permissionTint)
                            if permissionDenied {
                                SettingsActionButton("打开系统设置") { openNotificationSettings() }
                                    .controlSize(.small)
                            } else {
                                SettingsActionButton("允许通知") { Task { await requestPermission() } }
                                    .controlSize(.small)
                            }
                        }
                    }
                }
            }

            // The Mac posts its own notifications; the server's switch is what browsers follow.
            if model.workbench != nil {
                Section {
                    LabeledContent {
                        Toggle("网页端会话提醒", isOn: serverNotifications)
                            .labelsHidden()
                            .toggleStyle(.switch)
                            .disabled(serverBusy)
                    } label: {
                        HStack(spacing: Space.sm) {
                            Text("网页端会话提醒")
                                .font(RiffetFont.label)
                                .foregroundStyle(palette.fg)
                            SettingsScopeBadge(scope: .server)
                        }
                    }
                    SettingsErrorText(message: error)
                }
            }

            SettingsScopeFooter()
        }
        .riffetForm()
        .task { await refreshPermission() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refreshPermission() }
        }
        // An agent's notify call is served only while this is on.
        .onChange(of: notifications) { _, _ in MacDeviceService.shared.permissionsChanged() }
    }

    /// Denied or not yet asked. The first read is still in flight while it shows 检测中.
    private var permissionMissing: Bool {
        permission != String(localized: "已允许") && permission != String(localized: "检测中")
    }

    private var permissionTint: Color {
        let allowed = String(localized: "已允许")
        let denied = String(localized: "已拒绝")
        let notDetermined = String(localized: "尚未授权")
        switch permission {
        case allowed: return palette.success
        case denied: return palette.danger
        case notDetermined: return palette.warning
        default: return palette.fg3
        }
    }

    private var serverNotifications: Binding<Bool> {
        Binding(
            get: { model.workbench?.settings?.notifications?.boolValue == true },
            set: { value in Task { await saveServer(value) } }
        )
    }

    private func refreshPermission() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        switch status {
        case .authorized, .provisional, .ephemeral:
            permission = String(localized: "已允许")
            permissionDenied = false
        case .denied:
            permission = String(localized: "已拒绝")
            permissionDenied = true
        case .notDetermined:
            permission = String(localized: "尚未授权")
            permissionDenied = false
        @unknown default:
            permission = String(localized: "未知")
            permissionDenied = false
        }
    }

    private func requestPermission() async {
        let granted = await NotificationCenterBridge.shared.requestAuthorization()
        await refreshPermission()
        if !granted { openNotificationSettings() }
    }

    private func openNotificationSettings() {
        let urls = [
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "x-apple.systempreferences:com.apple.preference.notifications",
        ]
        for raw in urls {
            if let url = URL(string: raw), NSWorkspace.shared.open(url) { return }
        }
    }

    private func saveServer(_ enabled: Bool) async {
        guard let workbench = model.workbench else { return }
        serverBusy = true
        error = nil
        do {
            try await SettingsStore.save(workbench, SettingsPatch.make(notifications: enabled))
        } catch {
            self.error = error.riffetMessage
        }
        serverBusy = false
    }
}

/// Registers or removes Riffet's own login item; the settings toggle and the guide's last page share it.
enum LoginItem {
    static func set(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }
}

/// Whether Riffet opens at login, read off the main thread and remembered for the next time the
/// section is built.
private enum LoginItemStatus {
    static var known: Bool?

    static func read() async -> Bool {
        await Task.detached(priority: .userInitiated) { SMAppService.mainApp.status == .enabled }.value
    }
}
