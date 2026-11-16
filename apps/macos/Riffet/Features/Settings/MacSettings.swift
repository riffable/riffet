import ServiceManagement
import SwiftUI
import RiffetKit

struct ConnectionSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var devices: [PublicDevice] = []
    @State private var showRemote = false
    @State private var forgetting: SavedServer?
    @State private var revokeId: String?
    @State private var confirmIdle = false
    @State private var error: String?
    @State private var loadedAt = Date.distantPast
    @State private var devicesLoaded = false
    @State private var pairing: PairingCodeResponse?
    /// Drawn once per pairing code rather than on every redraw of the form.
    @State private var pairingQR: NSImage?
    @State private var pairingBusy = false
    @State private var pairingError: String?
    @State private var pushKey = PushKeyStore()

    var body: some View {
        Form {
            SettingsBlock("连接") {
                SettingsRow(String(localized: "本机"), detail: localAddress) {
                    serverTrailing(current: isLocal) { Task { await model.connectLocal() } }
                }
                ForEach(model.servers) { server in
                    SettingsRow(server.title, detail: server.detail) {
                        serverTrailing(current: isCurrent(server), forget: { forgetting = server }) {
                            if let url = server.url { Task { await model.connectRemote(url) } }
                        }
                    }
                }
                if insecure {
                    SettingsCallout(.warning, message: String(localized: "连接未加密，仅在可信网络中使用。"))
                }
                SettingsRow("设备令牌") {
                    Text(tokenStorage)
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.fg2)
                        .help(AppSecrets.shared.storageDescription)
                }
                HStack(spacing: Space.sm) {
                    SettingsActionButton("连接服务器…", symbol: "plus.rectangle.on.rectangle") {
                        showRemote = true
                    }
                    Spacer(minLength: 0)
                }
            }

            SettingsBlock("设备", scope: .server) {
                if model.workbench == nil {
                    SettingsHint("连接服务器后可查看。", symbol: "info.circle")
                } else {
                    pairingRow
                    ForEach(devices.sorted(by: Self.byPresence), id: \.id) { device in
                        SettingsRow(device.name, detail: status(device)) {
                            SettingsActionButton("撤销", kind: .secondary) { revokeId = device.id }
                                .controlSize(.small)
                                .help("撤销这台设备")
                        }
                    }
                    if !idleDevices.isEmpty {
                        SettingsRow("超过 7 天未使用 · \(idleDevices.count)") {
                            SettingsActionButton("全部撤销", kind: .secondary) { confirmIdle = true }
                                .controlSize(.small)
                        }
                    }
                    if devices.isEmpty, devicesLoaded {
                        SettingsHint("还没有配对的设备。")
                    }
                }
                SettingsErrorText(message: error)
            }
            if model.workbench != nil {
                PushKeyBlock(store: pushKey)
            }
            SettingsScopeFooter()
        }
        .riffetForm()
        .task { await load() }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == SettingsSection.connection.rawValue,
                  Date.now.timeIntervalSince(loadedAt) > 30 else { return }
            Task { await load() }
        }
        .sheet(isPresented: $showRemote) { RemotePairingSheet() }
        .onChange(of: model.workbench?.baseURL) { _, _ in
            // A code belongs to the server that issued it.
            pairing = nil
            pairingQR = nil
            pairingError = nil
            pushKey.reset()
            Task { await load() }
        }
        .confirmationDialog("忘记这台服务器？", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }), titleVisibility: .visible) {
            Button("忘记", role: .destructive) {
                if let server = forgetting { model.forget(server) }
                forgetting = nil
            }
            Button("取消", role: .cancel) { forgetting = nil }
        } message: {
            Text("本机保存的设备令牌会被删除。")
        }
        .confirmationDialog("撤销这台设备？", isPresented: Binding(get: { revokeId != nil }, set: { if !$0 { revokeId = nil } }), titleVisibility: .visible) {
            Button("撤销", role: .destructive) {
                let id = revokeId
                revokeId = nil
                if let id { Task { await revoke(id) } }
            }
            Button("取消", role: .cancel) { revokeId = nil }
        } message: {
            Text("该设备需要重新配对。")
        }
        .confirmationDialog("撤销 \(idleDevices.count) 台设备？", isPresented: $confirmIdle, titleVisibility: .visible) {
            Button("撤销", role: .destructive) {
                let ids = idleDevices.map(\.id)
                Task { for id in ids { await revoke(id) } }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("设备需要重新配对。")
        }
    }

    @ViewBuilder
    private var pairingRow: some View {
        if let pairing {
            HStack(alignment: .top, spacing: Space.lg) {
                if let image = pairingQR {
                    Image(nsImage: image)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 172, height: 172)
                        .padding(Space.lg + Space.sm)
                        .background(.white, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.lineSoft))
                }
                VStack(alignment: .leading, spacing: Space.sm) {
                    HStack(spacing: Space.sm) {
                        Text(pairing.code)
                            .font(.riffet(size: S(24), weight: .semibold, design: .monospaced))
                            .foregroundStyle(palette.fg)
                            .textSelection(.enabled)
                        CopyButton(text: pairing.code, help: String(localized: "复制配对码"))
                    }
                    Text("有效至 \(pairingExpiry(pairing))")
                        .font(.riffet(size: S(11.5)))
                        .foregroundStyle(palette.fg3)
                    ForEach(Array(pairing.hosts.prefix(3)), id: \.self) { host in
                        Text("\(pairing.scheme)://\(host):\(pairing.port)")
                            .font(.riffet(size: S(11.5), design: .monospaced))
                            .foregroundStyle(palette.fg2)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    if pairing.localOnly {
                        SettingsCallout(.warning, message: String(localized: "服务器只监听本机，其他设备无法连接。"))
                    }
                    HStack(spacing: Space.sm) {
                        SettingsActionButton("重新生成", symbol: "arrow.clockwise") {
                            Task { await makePairing() }
                        }
                        .disabled(pairingBusy)
                        if pairingBusy { Spinner(size: .small) }
                        Spacer(minLength: 0)
                    }
                }
                Spacer(minLength: 0)
            }
        } else {
            SettingsRow("配对新设备", detail: "5 分钟内有效，仅可使用一次。") {
                HStack(spacing: Space.sm) {
                    if pairingBusy { Spinner(size: .small) }
                    SettingsActionButton("生成配对码", symbol: "qrcode") {
                        Task { await makePairing() }
                    }
                    .controlSize(.small)
                    .disabled(pairingBusy)
                }
            }
        }
        SettingsErrorText(message: pairingError)
    }

    private var isLocal: Bool { model.target == .local }

    private func isCurrent(_ server: SavedServer) -> Bool {
        guard case let .remote(url) = model.target else { return false }
        return SavedServer.base(of: url).lowercased() == server.id
    }

    private var localAddress: String {
        (model.server.state.running?.baseURL ?? model.server.recordedBaseURL)?.absoluteString ?? String(localized: "未检测到服务器地址")
    }

    /// The current server is marked; another is switched to by its button, and a paired one can be forgotten.
    @ViewBuilder
    private func serverTrailing(current: Bool, forget: (() -> Void)? = nil, connect: @escaping () -> Void) -> some View {
        HStack(spacing: Space.sm) {
            if current {
                Image(icon: "checkmark")
                    .font(.riffet(size: S(12), weight: .semibold))
                    .foregroundStyle(palette.fg2)
                    .accessibilityLabel(Text("当前"))
            } else {
                SettingsActionButton("连接", kind: .secondary, action: connect)
                    .controlSize(.small)
            }
            if let forget {
                Button("忘记", role: .destructive, action: forget)
                    .buttonStyle(.plain)
                    .foregroundStyle(palette.danger)
                    .font(.riffet(size: S(12.5)))
            }
        }
    }

    /// Plain HTTP to another machine; loopback never leaves this Mac.
    private var insecure: Bool {
        guard case let .remote(url) = model.target else { return false }
        return url.scheme != "https"
    }

    /// Where the device token lives, in words; the file's path and mode are in the tooltip.
    private var tokenStorage: String {
        let storage = AppSecrets.shared.storageDescription
        return storage.hasPrefix("~") || storage.hasPrefix("/") ? String(localized: "本地文件") : storage
    }

    private func makePairing() async {
        guard let api = model.workbench?.host.api else {
            pairingError = String(localized: "请先连接服务器")
            return
        }
        pairingBusy = true
        pairingError = nil
        do {
            let next = try await api.pairingCode(name: nil)
            pairingQR = Self.qrImage(next)
            pairing = next
        } catch {
            pairing = nil
            pairingQR = nil
            pairingError = error.riffetMessage
        }
        pairingBusy = false
    }

    private func pairingExpiry(_ pairing: PairingCodeResponse) -> String {
        let date = Date(timeIntervalSince1970: Double(pairing.expiresAt) / 1000)
        return date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }

    private static func qrImage(_ pairing: PairingCodeResponse) -> NSImage? {
        // The server's own string when it sends one; an older server gets the same fields built here.
        guard let payload = pairing.payload ?? pairingPayload(pairing) else { return nil }
        return QRCode.image(payload)
    }

    private static func pairingPayload(_ pairing: PairingCodeResponse) -> String? {
        let host = pairing.hosts.first ?? "127.0.0.1"
        var object: [String: Any] = [
            "v": 1,
            "scheme": pairing.scheme,
            "host": host,
            "port": Int(pairing.port),
            "code": pairing.code,
        ]
        if let name = Host.current().localizedName { object["name"] = name }
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Online first, then the most recently seen.
    private static func byPresence(_ a: PublicDevice, _ b: PublicDevice) -> Bool {
        if a.online != b.online { return a.online }
        return (a.lastSeenAt ?? "") > (b.lastSeenAt ?? "")
    }

    /// Unseen this long, a record is usually one left behind by re-pairing.
    private var idleDevices: [PublicDevice] {
        let limit = Date.now.addingTimeInterval(-7 * 24 * 3600)
        return devices.filter { device in
            !device.online && (ServerTime.date(device.lastSeenAt ?? device.createdAt) ?? .distantFuture) < limit
        }
    }

    private func status(_ device: PublicDevice) -> String {
        let phone = device.platform == "android" || device.platform == "ios"
        let duplicated = devices.filter { $0.name == device.name }.count > 1
        return [
            device.online ? String(localized: "在线") : ServerTime.relative(device.lastSeenAt).map { String(localized: "最后在线 \($0)") },
            duplicated ? formatDateTime(value: device.createdAt).map { String(localized: "配对于 \($0)") } : nil,
            phone && device.allowControl ? String(localized: "允许 Agent 操作") : nil,
            phone && device.capabilities.contains("screen.observe") ? String(localized: "无障碍已开启") : nil,
        ].compactMap { $0 }.joined(separator: " · ")
    }

    private func load() async {
        guard let api = model.workbench?.host.api else {
            if !devices.isEmpty { devices = [] }
            return
        }
        loadedAt = .now
        do {
            let loaded = try await api.devices()
            if loaded != devices { devices = loaded }
            devicesLoaded = true
        } catch {
            self.error = error.riffetMessage
        }
        await pushKey.load(api)
    }

    private func revoke(_ id: String) async {
        guard let api = model.workbench?.host.api else { return }
        do {
            try await api.revokeDevice(id: id)
            await load()
        } catch {
            self.error = error.riffetMessage
        }
    }
}

struct ServerSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var busy = false
    @State private var error: String?
    @State private var doctor: String?
    @State private var confirmStop = false

    var body: some View {
        let server = model.server
        Form {
            SettingsBlock("状态") {
                // A running service needs no status line; every other state does.
                if server.state.running == nil {
                    SettingsStatusRow(
                        title: String(localized: "服务器状态"),
                        detail: failureMessage,
                        status: stateTitle,
                        tint: stateTint
                    )
                }
                if server.appAgentStatus == .requiresApproval {
                    SettingsCallout(
                        .warning,
                        message: String(localized: "在系统设置中允许 Riffet 后台运行"),
                        actionTitle: String(localized: "打开系统设置"),
                        action: { SMAppService.openSystemSettingsLoginItems() }
                    )
                }
                if let running = server.state.running {
                    SettingsRow("运行方式") {
                        Text(managerLabel(running.manager))
                            .font(.riffet(size: S(12)))
                            .foregroundStyle(palette.fg2)
                    }
                    SettingsRow("地址") {
                        HStack(spacing: Space.xs) {
                            Text(running.baseURL.absoluteString)
                                .font(.riffet(size: S(12), design: .monospaced))
                                .foregroundStyle(palette.fg2)
                                .textSelection(.enabled)
                            CopyButton(text: running.baseURL.absoluteString, help: String(localized: "复制服务器地址"))
                        }
                    }
                    if let version = running.version {
                        SettingsRow("版本") {
                            Text(version)
                                .font(.riffet(size: S(12), design: .monospaced))
                                .foregroundStyle(palette.fg2)
                                .textSelection(.enabled)
                        }
                    }
                }
                SettingsRow("数据目录") {
                    Text(server.stateDirectory.path)
                        .font(.riffet(size: S(12), design: .monospaced))
                        .foregroundStyle(palette.fg3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .frame(maxWidth: 320, alignment: .trailing)
                        .help(server.stateDirectory.path)
                }
                if model.workbench != nil {
                    SettingsRow("资源占用") {
                        SettingsActionButton("打开服务器监控", symbol: "chart.xyaxis.line") {
                            WindowRouter.shared.showMain()
                            AppModel.shared.whenReady { $0.page = .activity }
                        }
                        .controlSize(.small)
                    }
                }
            }

            SettingsBlock("管理") {
                HStack(spacing: Space.sm) {
                    if server.state.running == nil {
                        SettingsActionButton(
                            server.hasLoginService ? "启动登录服务" : "由 Riffet 托管并启动",
                            symbol: "play.fill",
                            kind: .primary
                        ) {
                            run { await model.startServer() }
                        }
                    } else {
                        // Waits for the turns a restart would end first. A daemon started in a terminal is then
                        // restarted through the CLI, which replays its own arguments; the App only kickstarts
                        // what it launched itself.
                        SettingsActionButton("重启", symbol: "arrow.clockwise") {
                            run { try await server.restartWhenIdle() }
                        }
                        .disabled(server.maintenance?.running == true || server.restartBlockers != nil)
                        if let manager = server.state.running?.manager, manager != .loginService {
                            SettingsActionButton("停止", symbol: "stop.fill", kind: .danger) {
                                confirmStop = true
                            }
                        }
                    }
                    if server.hasLoginService, server.canHostServer {
                        SettingsActionButton("改由 Riffet 管理") {
                            run { try await server.migrateLoginServiceToApp(); await model.connectLocal() }
                        }
                    }
                    Spacer(minLength: 0)
                    if busy { Spinner(size: .small) }
                }
                if let blockers = server.restartBlockers, !blockers.isEmpty || server.restartProblem != nil {
                    if let problem = server.restartProblem {
                        Text(verbatim: problem)
                            .font(.riffet(size: S(12)))
                            .foregroundStyle(palette.warning)
                    }
                    ForEach(blockers) { blocker in
                        SettingsRow(blocker.title.isEmpty ? backendLabel(blocker.backendId) : blocker.title) {
                            Text(verbatim: "\(backendLabel(blocker.backendId)) · \(blocker.reasonLabel)")
                                .font(.riffet(size: S(12)))
                                .foregroundStyle(palette.fg3)
                        }
                    }
                    HStack(spacing: Space.sm) {
                        SettingsActionButton("仍然重启", kind: .danger) { server.restartAnyway() }
                        SettingsActionButton("取消") { server.cancelRestart() }
                        Spacer(minLength: 0)
                    }
                }
                HStack(spacing: Space.sm) {
                    SettingsActionButton("查看日志", symbol: "doc.text.magnifyingglass") {
                        server.openLog()
                    }
                    SettingsActionButton("诊断", symbol: "stethoscope") {
                        Task { doctor = await server.doctorReport() }
                    }
                    // Rebuilding `dist/` only means something to an App built from a checkout.
                    if AppBuildRecord.fromCheckout {
                        SettingsActionButton("构建服务器", symbol: "hammer") {
                            server.buildServer()
                        }
                        .disabled(server.maintenance?.running == true)
                        .help("构建后需重启生效。")
                    }
                    Spacer(minLength: 0)
                }
                .controlSize(.small)
                SettingsErrorText(message: error)
            }

            if let workbench = model.workbench {
                ServiceReclaimSection(workbench: workbench)
            }
        }
        .riffetForm()
        .task { await server.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == SettingsSection.server.rawValue else { return }
            Task { await server.refresh() }
        }
        .sheet(item: Binding(get: { server.maintenance }, set: { if $0 == nil { server.dismissMaintenance() } })) { _ in
            ServerMaintenanceSheet(server: server) { server.dismissMaintenance() }
        }
        .confirmationDialog("停止本机服务器？", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("停止", role: .destructive) {
                if model.server.state.running?.manager == .cli { run { await model.server.stopCliDaemon() } }
                else { run { try await model.server.stopAppManaged() } }
            }
            Button("取消", role: .cancel) {}
        } message: {
            if model.server.state.running?.manager == .cli {
                Text("停止后所有设备都无法连接，直到再次启动。")
            } else {
                Text("停止后所有设备都无法连接，登录时也不再自动启动。")
            }
        }
        .sheet(item: Binding(get: { doctor.map(DoctorReport.init) }, set: { doctor = $0?.text })) { report in
            ServerOutputSheet(title: String(localized: "诊断"), text: report.text, width: 560, height: 420) {
                doctor = nil
            }
        }
    }

    /// Who keeps the service running, in the reader's terms rather than the launcher's name.
    private func managerLabel(_ manager: ServerManager) -> String {
        switch manager {
        case .app: String(localized: "由 Riffet 管理")
        case .loginService: String(localized: "登录项")
        case .cli: String(localized: "由终端启动")
        }
    }

    private var compacting: Bool { model.server.databaseCompaction != nil && model.server.state.running == nil }

    private var stateTitle: String {
        if compacting { return String(localized: "正在整理数据库") }
        return switch model.server.state {
        case .running: String(localized: "运行中")
        case .stopped: String(localized: "未运行")
        case .starting: String(localized: "正在启动")
        case .checking: String(localized: "检测中")
        case .failed: String(localized: "启动失败")
        }
    }

    private var stateTint: Color {
        if compacting { return palette.warning }
        return switch model.server.state {
        case .running: palette.success
        case .stopped: palette.fg3
        case .starting: palette.warning
        case .checking: palette.fg3
        case .failed: palette.danger
        }
    }

    private var failureMessage: String? {
        if compacting { return nil }
        return if case let .failed(message) = model.server.state { message } else { nil }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do { try await action() } catch { self.error = error.riffetMessage }
            busy = false
        }
    }
}

private struct DoctorReport: Identifiable {
    let text: String
    var id: String { text }
}

/// The raw output of the last maintenance command, live while it runs. Nothing is summarised: a
/// build or a restart is diagnosed from what the command itself printed.
private struct ServerMaintenanceSheet: View {
    let server: ServerHost
    let dismiss: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let entry = server.maintenance
        ServerOutputSheet(
            title: entry?.title ?? String(localized: "本机服务器"),
            text: entry?.output.isEmpty == false ? entry!.output : "…",
            width: 640,
            height: 460,
            follows: true,
            closable: entry?.running != true,
            dismiss: dismiss
        ) {
            if entry?.running == true {
                Spinner(size: .small)
            } else if let status = entry?.status {
                Text(status == 0 ? "完成" : "退出码 \(status)")
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(status == 0 ? palette.fg3 : palette.danger)
            }
        }
    }
}

/// A command's text output in a sheet: title, optional status, the selectable text, 关闭.
private struct ServerOutputSheet<Status: View>: View {
    let title: String
    let text: String
    let width: CGFloat
    let height: CGFloat
    /// Keeps the end in view while the text grows.
    var follows = false
    var closable = true
    let dismiss: () -> Void
    @ViewBuilder var status: Status
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(spacing: Space.sm) {
                Text(title)
                    .font(.riffet(size: S(16), weight: .semibold))
                    .foregroundStyle(palette.fg)
                Spacer(minLength: Space.sm)
                status
            }
            ScrollViewReader { proxy in
                ScrollView {
                    Text(text)
                        .font(.riffet(size: S(11), design: .monospaced))
                        .foregroundStyle(palette.fg2)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .id("end")
                }
                .onChange(of: text) { _, _ in if follows { proxy.scrollTo("end", anchor: .bottom) } }
            }
            HStack {
                Spacer()
                Button("关闭") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(!closable)
            }
        }
        .padding(Space.lg)
        .frame(width: width, height: height)
    }
}

extension ServerOutputSheet where Status == EmptyView {
    init(title: String, text: String, width: CGFloat, height: CGFloat, dismiss: @escaping () -> Void) {
        self.init(title: title, text: text, width: width, height: height, dismiss: dismiss) { EmptyView() }
    }
}

extension AppBuildRecord {
    /// Built from a checkout on this Mac: a public build records no source root. Developer actions
    /// (rebuilding the server, updating from git, the benchmark) only show then.
    static var fromCheckout: Bool { !(bundled?.sourceRoot ?? "").isEmpty }
}

/// 关于: the version and one update check. A build from a checkout also shows its git release
/// check and update command.
struct AboutSettings: View {
    @State private var updates = GitUpdates()
    @State private var receivesBeta = Updater.shared.receivesBeta
    @Environment(\.palette) private var palette

    var body: some View {
        Form {
            Section {
                identity
                    .padding(.vertical, Space.md)
            }
            SettingsBlock("更新") {
                updateCard
            }
        }
        .riffetForm()
    }

    private var identity: some View {
        VStack(spacing: Space.sm) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 80, height: 80)
                // The icon image is not observable; the preference that sets it is.
                .id(DisplayPreferences.shared.appIcon)
            Text("Riffet")
                .font(.riffet(size: S(22), weight: .semibold))
                .foregroundStyle(palette.fg)
            Text("版本 \(version) (\(build))")
                .font(.riffet(size: S(12.5)))
                .foregroundStyle(palette.fg2)
                .monospacedDigit()
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity)
    }

    /// The release feed when this build has one; otherwise the checkout's git tags.
    private var usesFeed: Bool { Updater.shared.available }
    private var showsSource: Bool { AppBuildRecord.fromCheckout || !usesFeed }

    @ViewBuilder
    private var updateCard: some View {
        if usesFeed {
            Toggle("接收测试版更新", isOn: Binding(
                get: { receivesBeta },
                set: { receivesBeta = $0; Updater.shared.receivesBeta = $0 }
            ))
        }

        HStack(spacing: Space.sm) {
            SettingsActionButton(
                updates.checking ? "检查中…" : "检查更新…",
                symbol: "arrow.clockwise",
                kind: .primary
            ) {
                if usesFeed { Updater.shared.checkForUpdates() } else { Task { await updates.check() } }
            }
            .disabled(updates.checking)
            if updates.checking { Spinner(size: .small) }
            Spacer(minLength: 0)
        }

        if !updates.message.isEmpty {
            Text(updates.message)
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg3)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }

        if let latest = updates.latestTag {
            Text("最新发布：\(latest)")
                .font(.riffet(size: S(12), design: .monospaced))
                .foregroundStyle(palette.fg2)
                .textSelection(.enabled)
        }

        if showsSource { source }
    }

    private var source: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text(updates.currentLabel)
                    .font(.riffet(size: S(11.5), design: .monospaced))
                    .foregroundStyle(palette.fg3)
                    .textSelection(.enabled)
                if let root = updates.sourceRoot {
                    Text("源码目录：\(root)")
                        .font(.riffet(size: S(11)))
                        .foregroundStyle(palette.fg3)
                        .textSelection(.enabled)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
                HStack(spacing: Space.sm) {
                    SettingsActionButton("选择源码目录…", symbol: "folder") {
                        Task { await updates.chooseSource() }
                    }
                    // With a feed, the main button asks the feed; the checkout is asked here.
                    if usesFeed {
                        SettingsActionButton("检查源码发布", symbol: "arrow.triangle.branch") {
                            Task { await updates.check() }
                        }
                    }
                    Spacer(minLength: 0)
                }
                .controlSize(.small)
                .disabled(updates.checking)
                if let command = updates.updateCommand {
                    Text(command)
                        .font(.riffet(size: S(11), design: .monospaced))
                        .foregroundStyle(palette.fg2)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(Space.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(palette.formFill(palette.bgSubtle), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
                    HStack(spacing: Space.sm) {
                        SettingsActionButton("复制 App 更新命令", symbol: "doc.on.doc") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(command, forType: .string)
                        }
                        .controlSize(.small)
                        Spacer(minLength: 0)
                    }
                    SettingsHint("在终端执行，先停止这个源码目录的服务器。")
                }
            }
            .padding(.top, Space.xs)
        } label: {
            Text("源码构建")
                .font(.riffet(size: S(13)))
                .foregroundStyle(palette.fg)
        }
    }

    private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }
    private var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "" }
}
