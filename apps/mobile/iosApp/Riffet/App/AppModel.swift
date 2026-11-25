import Network
import SwiftUI
import RiffetKit

@MainActor @Observable
final class AppModel {
    static let shared = AppModel()
    let host: IOSHost = {
        // Before any connection: the device certificate answers the server's request for one (docs/TRANSPORT-SECURITY.md §2).
        DeviceCredentials.shared.provider = DeviceIdentity.shared
        return IOSHost()
    }()
    let themeStore = ThemeStore()
    var workbench: Workbench?
    var starting = true
    var pairing = false
    var pairedServers: [PairedServer] = []
    var switchingOrigin: String?
    var forgetting = false
    var renamingOrigin: String?
    var serverFailures: [String: String] = [:]
    var connectionBusy: Bool { pairing || switchingOrigin != nil || forgetting || renamingOrigin != nil }
    var error: String?
    var needsNetworkSettings = false
    var address = UserDefaults.standard.string(forKey: "riffet.ios.server") ?? ""
    var pendingSessionID: String?
    var pendingPrompt: String?
    /// The task list, from the summary Live Activity.
    var pendingHome = false
    /// The first-launch pages (OnboardingView.swift) are showing: decided once at start, never for a device that has a pairing.
    var onboarding = false
    /// Leaving the first-launch pages lands on 新会话, whatever tab the last launch left selected.
    var landOnNewTask = false
    static let onboardingKey = "riffet.ios.onboarding.completed"
    private var started = false
    /// Network reachability: a path that becomes usable again redials and re-reads at once instead
    /// of waiting out the stream's or the list poll's backoff.
    @ObservationIgnored private let pathMonitor = NWPathMonitor()
    @ObservationIgnored private var networkLost = false

    func start() async {
        guard !started else { return }
        started = true
        host.configureAppearance(appVersion: RiffetPush.appVersion, installationId: RiffetPush.installationId) { [weak self] theme, mode in
            MainActor.assumeIsolated {
                guard let self, UIApplication.shared.applicationState == .active,
                      let api = self.host.api, self.workbench?.api === api else { return nil }
                return self.themeStore.applyAppearance(theme: theme, mode: mode)
            }
        }
        RiffetNotifications.shared.install()
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let usable = path.status == .satisfied
            Task { @MainActor in self?.networkChanged(usable: usable) }
        }
        pathMonitor.start(queue: DispatchQueue(label: "riffet.network"))
        defer { starting = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if ProcessInfo.processInfo.arguments.contains("-ui-testing-reset") {
                for server in try await host.pairedServers() { _ = try await host.forgetServer(origin: server.origin) }
                for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("riffet.ios.") {
                    UserDefaults.standard.removeObject(forKey: key)
                }
                for key in AppStateDefaults.store.dictionaryRepresentation().keys where key.hasPrefix("riffet.ios.") {
                    AppStateDefaults.store.removeObject(forKey: key)
                }
                let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                let sharedCache = support.appendingPathComponent("Riffet", isDirectory: true)
                if FileManager.default.fileExists(atPath: sharedCache.path) { try FileManager.default.removeItem(at: sharedCache) }
                address = ""
            }
            #endif
            if let store = try await host.restore(), let raw = host.api?.baseUrl, let url = URL(string: raw) {
                install(store: store, url: url)
            }
            await refreshPairedServers()
            if !UserDefaults.standard.bool(forKey: Self.onboardingKey) {
                // An upgrade or a restored pairing never sees the welcome, now or after forgetting the server.
                if workbench == nil && pairedServers.isEmpty { onboarding = true } else { UserDefaults.standard.set(true, forKey: Self.onboardingKey) }
            }
            #if DEBUG
            PerfProbe.install(model: self)
            #endif
        } catch { self.error = error.riffetMessage }
    }
    func finishOnboarding() {
        UserDefaults.standard.set(true, forKey: Self.onboardingKey)
        landOnNewTask = true
        onboarding = false
    }
    func pair(address: String, code: String, name: String? = nil, alternates: [String] = []) async -> Bool {
        guard !connectionBusy else { return false }
        pairing = true; error = nil; needsNetworkSettings = false
        defer { pairing = false }
        do {
            let entered = try ServerAddress.normalized(address)
            guard !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ClientFailure(String(localized: "请输入 Mac 上显示的配对码", bundle: .riffet)) }
            // A scanned QR lists every address of the server; pair at the first that answers.
            let candidates = [entered.absoluteString] + alternates
            var url = entered
            if !alternates.isEmpty, let reached = try await host.firstReachable(baseUrls: candidates), let reachedURL = URL(string: reached) {
                url = reachedURL
            }
            _ = try await host.pair(baseUrl: url.absoluteString, code: code, deviceName: UIDevice.current.name, name: name,
                                    alternates: candidates.filter { $0 != url.absoluteString })
            let store = try host.install(baseUrl: url.absoluteString)
            install(store: store, url: url)
            await refreshPairedServers()
            if let server = pairedServers.first(where: { ServerAddress.sameOrigin(URL(string: $0.baseUrl) ?? url, url) }) {
                serverFailures.removeValue(forKey: server.origin)
                RiffetPush.shared.forget(origin: server.origin)
            }
            RiffetPush.shared.report()
            return true
        } catch {
            let message = error.riffetMessage
            needsNetworkSettings = message.contains("Denied over") || message.contains("Local network prohibited")
            self.error = Self.connectionMessage(message)
            return false
        }
    }
    static func connectionMessage(_ message: String) -> String {
        if message.contains("Denied over") || message.contains("Local network prohibited") {
            return String(localized: "系统阻止了 Riffet 使用网络。请在系统设置中允许无线数据和本地网络，再重试连接。", bundle: .riffet)
        }
        if message.contains("NSURLErrorDomain") {
            if message.contains("Code=-1009") { return String(localized: "iPhone 当前没有可用的网络。请检查网络连接，再重试。", bundle: .riffet) }
            if message.contains("Code=-1001") { return String(localized: "连接 Mac 超时。请确认服务器正在运行，且两台设备的网络可以互通。", bundle: .riffet) }
            if message.contains("Code=-1003") || message.contains("Code=-1004") { return String(localized: "无法连接这台 Mac。请核对服务器地址和端口，并确认 Riffet 服务器正在运行。", bundle: .riffet) }
            if message.contains("Code=-1022") { return String(localized: "系统要求这个地址使用加密连接。请使用 HTTPS，或使用 Mac 的局域网地址。", bundle: .riffet) }
            return String(localized: "网络连接未能完成。请检查服务器地址与网络后重试。", bundle: .riffet)
        }
        return message
    }
    func decodePairing(_ raw: String) throws -> (address: String, code: String, name: String?, alternates: [String]) {
        let payload = try host.parsePairing(raw: raw)
        return (payload.baseUrl, payload.code, payload.name, Array(payload.baseUrls.dropFirst()))
    }
    private func install(store: SessionStore, url: URL) {
        if let previous = workbench, !ServerAddress.sameOrigin(previous.baseURL, url) {
            pendingSessionID = nil
            pendingPrompt = nil
        }
        workbench?.close()
        address = url.absoluteString
        UserDefaults.standard.set(address, forKey: "riffet.ios.server")
        workbench = Workbench(store: store, host: host, baseURL: url) { [weak self] in
            // Defer teardown until the StateFlow observer has yielded.
            Task { @MainActor in
                guard self?.workbench?.store === store else { return }
                self?.authorizationExpired()
            }
        }
        error = nil
        consumeNotification()
        // The Live Activity's tokens follow the open server.
        RiffetPush.shared.report()
    }
    func authorizationExpired() {
        error = String(localized: "这台 iPhone 的连接授权已失效，请在 Mac 上生成新的配对码", bundle: .riffet)
        if let server = pairedServers.first(where: isCurrent) { serverFailures[server.origin] = String(localized: "需重新配对", bundle: .riffet) }
        workbench?.close(); workbench = nil; host.uninstall()
    }
    func refreshPairedServers() async {
        do { pairedServers = try await host.pairedServers() }
        catch { self.error = error.riffetMessage }
    }
    @discardableResult
    func renameServer(_ server: PairedServer, name: String) async -> Bool {
        guard !connectionBusy else { return false }
        renamingOrigin = server.origin
        error = nil
        defer { renamingOrigin = nil }
        do {
            let renamed = try await host.renameServer(origin: server.origin, name: name)
            if let index = pairedServers.firstIndex(where: { $0.origin == server.origin }) {
                pairedServers[index] = renamed
            } else {
                await refreshPairedServers()
            }
            return true
        } catch {
            self.error = error.riffetMessage
            return false
        }
    }
    func isCurrent(_ server: PairedServer) -> Bool {
        guard let current = workbench?.baseURL, let target = URL(string: server.baseUrl) else { return false }
        return ServerAddress.sameOrigin(current, target)
    }
    @discardableResult
    func switchServer(_ server: PairedServer) async -> Bool {
        guard !connectionBusy, !isCurrent(server), let url = URL(string: server.baseUrl) else { return false }
        switchingOrigin = server.origin
        error = nil
        defer { switchingOrigin = nil }
        do {
            let store = try await host.switchServer(origin: server.origin)
            install(store: store, url: url)
            serverFailures.removeValue(forKey: server.origin)
            await refreshPairedServers()
            return true
        } catch {
            let exception = (error as NSError).userInfo["KotlinException"]
            let expired = exception is RiffetUnauthenticatedException
            serverFailures[server.origin] = expired ? String(localized: "需重新配对", bundle: .riffet) : String(localized: "无法连接", bundle: .riffet)
            self.error = expired ? String(localized: "连接授权已失效，请重新配对", bundle: .riffet) : Self.connectionMessage(error.riffetMessage)
            return false
        }
    }
    func forgetServer(_ server: PairedServer) async {
        guard !connectionBusy else { return }
        forgetting = true
        defer { forgetting = false }
        do {
            let current = try await host.forgetServer(origin: server.origin)
            if current.boolValue {
                workbench?.close(); workbench = nil
                pendingSessionID = nil; pendingPrompt = nil
                address = ""
                UserDefaults.standard.removeObject(forKey: "riffet.ios.server")
            }
            serverFailures.removeValue(forKey: server.origin)
            RiffetPush.shared.forget(origin: server.origin)
            error = nil
            await refreshPairedServers()
        } catch { self.error = error.riffetMessage }
    }
    func disconnect() async {
        guard let server = pairedServers.first(where: isCurrent) else { return }
        await forgetServer(server)
    }
    private func networkChanged(usable: Bool) {
        if !usable { networkLost = true; return }
        guard networkLost else { return }
        networkLost = false
        host.networkRestored()
    }
    func scene(_ phase: ScenePhase) {
        if phase == .background { workbench?.drafts.flush() }
        // Back from the background of a server that pushes directly: it already sent the alerts for
        // what moved meanwhile, so the next list read does not post them again.
        if phase != .background, !host.foreground, let workbench, RiffetPush.shared.route(for: workbench.baseURL)?.route == "direct" {
            workbench.store.forgetSessionStates()
        }
        host.foreground = phase != .background
        host.appearanceForeground(active: phase == .active)
        MetricsReporter.shared.foreground(phase == .active)
        if phase == .active {
            consumeNotification()
            Task {
                // Notification permission may have changed in Settings while away.
                await RiffetNotifications.shared.refreshAuthorization()
                RiffetPush.shared.report()
            }
            workbench?.withdrawSettledNotifications()
        }
    }
    func consumeNotification() {
        guard let workbench, let notification = RiffetNotifications.shared.consumeOpenedSession() else { return }
        guard let origin = notification.origin, let url = URL(string: origin), ServerAddress.sameOrigin(url, workbench.baseURL) else {
            workbench.error = String(localized: "这条提醒来自其他 Mac，请连接对应设备后查看", bundle: .riffet)
            return
        }
        pendingSessionID = notification.id
    }
    func open(_ url: URL) {
        guard url.scheme == "riffet" else { return }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if url.host == "session" { pendingSessionID = query.first { $0.name == "id" }?.value }
        if url.host == "new" { pendingPrompt = query.first { $0.name == "prompt" }?.value ?? "" }
        if url.host == "home" { pendingHome = true }
    }
}
