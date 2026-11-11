import AppKit
import Foundation
import RiffetKit

/// Which server this app talks to: the Mac's own by default, or one of the paired servers (`SavedServers`).
enum ConnectionTarget: Equatable {
    case local
    case remote(URL)

    private static let key = "riffet.connection-target"

    static func load(defaults: UserDefaults = .standard) -> ConnectionTarget {
        guard let raw = defaults.string(forKey: key), let url = URL(string: raw) else { return .local }
        return .remote(url)
    }

    func save(defaults: UserDefaults = .standard) {
        switch self {
        case .local: defaults.removeObject(forKey: Self.key)
        case let .remote(url): defaults.set(url.absoluteString, forKey: Self.key)
        }
    }
}

/// Something wrong with the local server that the reader can fix without leaving the page they are on.
enum ServiceAlert: Equatable {
    /// It answered before and no longer does.
    case stopped
    /// The App-managed server runs another version than the App carries.
    case outdated(running: String, bundled: String)

    var message: String {
        switch self {
        case .stopped: String(localized: "本机服务器已停止")
        case let .outdated(running, bundled): String(localized: "服务器版本 \(running) 与 App \(bundled) 不一致，重启服务器以使用新版本")
        }
    }

    var actionTitle: String {
        switch self {
        case .stopped: String(localized: "重新启动")
        case .outdated: String(localized: "重启服务器")
        }
    }
}

/// The app's root state: which server, whether it is reachable and paired, and the workbench on top.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    enum Phase: Equatable {
        case launching
        /// No local server is running; the app offers to start one.
        case needsServer
        case connecting
        case failed(String)
        case ready
    }

    let host = MacHost(secrets: AppSecrets.shared)
    let server = ServerHost()
    let theme = ThemeStore.shared

    private(set) var phase: Phase = .launching
    private(set) var workbench: Workbench?
    private(set) var target = ConnectionTarget.load()
    /// The servers paired by address; the Mac's own is not among them.
    private(set) var servers = SavedServers.load()
    /// The workbench a cold start showed from cache before the server answered; the connection
    /// that follows keeps it instead of installing another.
    @ObservationIgnored private var provisional: Workbench?
    /// Bumped by every connection attempt, so a slower earlier one cannot install over it.
    @ObservationIgnored private var connectAttempt = 0

    /// Set while the local server is not running or runs another version; the window shows it as a
    /// banner (see `ServiceAlertBanner`) instead of sending the reader back to the setup screen.
    private(set) var serviceAlert: ServiceAlert?
    private(set) var recoveringService = false
    /// Why the last [recoverService] did not bring the server back.
    private(set) var serviceError: String?
    @ObservationIgnored private var monitor: Task<Void, Never>?
    @ObservationIgnored private var lastCheck = Date.distantPast
    @ObservationIgnored private var outdatedDismissed = false
    @ObservationIgnored private var lastManager: ServerManager?

    /// Work that arrived before there was a workbench: a link, a notification click, a Spotlight hit.
    @ObservationIgnored private var readyActions: [(id: Int, run: @MainActor (Workbench) -> Void)] = []
    @ObservationIgnored private var readyCounter = 0
    private static let readyLimit = 16
    private static let readyTimeout: Duration = .seconds(30)

    static let bundledVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""

    var deviceName: String { Host.current().localizedName ?? "Mac" }

    private init() {}

    func start() async {
        switch target {
        case .local:
            // The cached list of a server paired before shows at once; its health and the device
            // token are checked behind it (cold start budget: < 500 ms to the cached list).
            if let url = server.recordedBaseURL, host.hasToken(baseUrl: Self.base(url)) {
                show(base: Self.base(url), local: true)
                provisional = workbench
            }
            await connectLocal()
        case let .remote(url): await connect(to: url, local: false)
        }
    }

    func connectLocal() async {
        target = .local
        target.save()
        if workbench == nil { phase = .connecting }
        await server.refresh()
        guard let running = server.state.running else {
            if workbench?.local == true, provisional == nil {
                // A server that stopped under an open window is not the first-run screen: keep the
                // page and say so (the failure is in `server.state` when a start was what failed).
                serviceAlert = .stopped
                return
            }
            disconnect()
            phase = .needsServer
            return
        }
        evaluate(running)
        await connect(to: running.baseURL, local: true)
    }

    /// Starts the App-managed server and connects once it answers. A start that does not work leaves
    /// the reason in `server.state` and the setup screen up; it is never swallowed.
    func startServer() async {
        if workbench == nil { phase = .connecting }
        do {
            if server.hasLoginService {
                try await server.kickstartLoginService()
            } else {
                try await server.startAppManaged()
            }
        } catch {
            if case .failed = server.state {} else { server.markFailed(error.riffetMessage) }
            if workbench == nil { phase = .needsServer }
            return
        }
        if case .failed = server.state {
            if workbench == nil { phase = .needsServer }
            return
        }
        await connectLocal()
    }

    // MARK: Local server health

    /// Looks again at the local server: when the app comes to the front and every half minute, only
    /// while this app talks to its own Mac's server.
    func checkService(force: Bool = false) async {
        guard target == .local, phase == .ready, workbench?.local == true, !recoveringService else { return }
        guard force || Date.now.timeIntervalSince(lastCheck) > 10 else { return }
        lastCheck = .now
        if case .starting = server.state { return }
        await server.refresh()
        if server.state.running == nil {
            // One missed answer is not a stop: the server may be busy or in the middle of a restart.
            try? await Task.sleep(for: .seconds(3))
            await server.refresh()
        }
        guard target == .local, phase == .ready, !recoveringService else { return }
        if let running = server.state.running {
            evaluate(running)
            if let current = workbench, Self.base(running.baseURL) != Self.base(current.baseURL) {
                await connect(to: running.baseURL, local: true)
            }
        } else if case .starting = server.state {
            return
        } else {
            serviceAlert = .stopped
        }
    }

    private func evaluate(_ running: RunningServer) {
        lastManager = running.manager
        let bundled = Self.bundledVersion
        if running.manager == .app, !outdatedDismissed, let version = running.version, !bundled.isEmpty, version != "unknown",
           Self.normalized(version) != Self.normalized(bundled) {
            serviceAlert = .outdated(running: version, bundled: bundled)
        } else {
            serviceAlert = nil
        }
    }

    private static func normalized(_ version: String) -> String {
        version.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
    }

    /// Whether the banner can offer a button: a server started by `riffet start` can only be
    /// started again from the terminal it came from.
    var canRecoverService: Bool {
        switch serviceAlert {
        case .stopped?: lastManager != .cli && (server.hasLoginService || server.canHostServer)
        case .outdated?: server.state.running?.manager != .cli
        case nil: false
        }
    }

    /// Starts the stopped server, or restarts the outdated one, without leaving the current page.
    func recoverService() async {
        guard !recoveringService, let alert = serviceAlert else { return }
        recoveringService = true
        serviceError = nil
        do {
            switch alert {
            case .outdated:
                try await server.restart()
            case .stopped:
                if server.hasLoginService { try await server.kickstartLoginService() } else { try await server.startAppManaged() }
            }
        } catch {
            serviceError = error.riffetMessage
        }
        if case let .failed(message) = server.state { serviceError = message }
        recoveringService = false
        await checkService(force: true)
        if serviceAlert == nil { workbench?.host.poke() }
    }

    /// Hides the version notice until the next launch; a stopped server is not dismissable.
    func dismissServiceAlert() {
        guard case .outdated = serviceAlert else { return }
        outdatedDismissed = true
        serviceAlert = nil
    }

    private func startMonitoring() {
        guard monitor == nil else { return }
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                await self?.checkService()
            }
        }
    }

    private func stopMonitoring() {
        monitor?.cancel()
        monitor = nil
    }

    // MARK: Work that waits for the workbench

    /// Runs [action] with the workbench: now when it is up, otherwise as soon as it is, in the order
    /// asked. What is still waiting after 30 seconds (or beyond the 16 newest) is dropped.
    func whenReady(_ action: @escaping @MainActor (Workbench) -> Void) {
        if phase == .ready, let workbench {
            action(workbench)
            return
        }
        readyCounter += 1
        let id = readyCounter
        readyActions.append((id, action))
        if readyActions.count > Self.readyLimit { readyActions.removeFirst() }
        Task { [weak self] in
            try? await Task.sleep(for: Self.readyTimeout)
            self?.readyActions.removeAll { $0.id == id }
        }
    }

    /// The workbench for work that has to answer (App Intents): waits up to [timeout] for it, and
    /// gives up early when there is no server to wait for.
    func readyWorkbench(timeout: Duration = .seconds(15)) async -> Workbench? {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if phase == .ready, let workbench { return workbench }
            switch phase {
            case .needsServer, .failed: return nil
            default: try? await Task.sleep(for: .milliseconds(200))
            }
        }
        return nil
    }

    private func flushReady() {
        guard phase == .ready, let workbench, !readyActions.isEmpty else { return }
        let pending = readyActions
        readyActions = []
        for action in pending { action.run(workbench) }
    }

    /// Pairs with a server on another machine using the code `riffet pair` prints there, remembers
    /// it, and connects to it.
    func pairRemote(address: String, code: String, name: String? = nil) async throws {
        guard let url = Self.normalize(address) else { throw LocalPairing.Failure(message: String(localized: "地址无效")) }
        _ = try await host.pair(baseUrl: url.absoluteString, code: code, deviceName: deviceName)
        let saved = SavedServer(base: Self.base(url), name: name)
        if let index = servers.firstIndex(where: { $0.id == saved.id }) {
            servers[index] = SavedServer(base: servers[index].base, name: name ?? servers[index].name)
        } else {
            servers.append(saved)
        }
        SavedServers.save(servers)
        await connectRemote(url)
    }

    /// Switches to a paired server. The one shown is closed first; a local server keeps running.
    func connectRemote(_ url: URL) async {
        target = .remote(url)
        target.save()
        await connect(to: url, local: false)
    }

    /// Removes a paired server and its device token. Forgetting the current one returns to the
    /// Mac's own server.
    func forget(_ server: SavedServer) {
        host.forgetToken(baseUrl: server.base)
        servers.removeAll { $0.id == server.id }
        SavedServers.save(servers)
        guard case let .remote(url) = target, Self.base(url).lowercased() == server.id else { return }
        disconnect()
        // A stopped server keeps its conversations searchable; a forgotten one does not.
        SpotlightIndex.clear()
        target = .local
        target.save()
        phase = .launching
        Task { await start() }
    }

    func disconnect() {
        provisional = nil
        stopMonitoring()
        serviceAlert = nil
        workbench?.close()
        workbench = nil
        theme.detach()
        AppearanceStore.shared.detach()
        PluginsStore.shared.detach()
        host.uninstall()
    }

    private func connect(to url: URL, local: Bool) async {
        connectAttempt += 1
        let attempt = connectAttempt
        let base = Self.base(url)
        // A workbench already on this server stays: a reconnect must not lose the page it shows.
        let reusing = workbench != nil && workbench?.baseURL == URL(string: base) && host.api?.baseUrl == base
        provisional = nil
        do {
            if !reusing {
                phase = .connecting
                if !host.hasToken(baseUrl: base) {
                    guard local else {
                        disconnect()
                        phase = .failed(String(localized: "这台 Mac 还没有与 \(base) 配对"))
                        return
                    }
                    try await LocalPairing.pair(baseURL: URL(string: base)!, stateDirectory: server.stateDirectory, deviceName: deviceName, host: host)
                    guard attempt == connectAttempt else { return }
                }
                // The store shows its cached list at once; the token is verified alongside.
                show(base: base, local: local)
            }
            let verified: Bool
            do {
                verified = try await authenticated()
            } catch {
                // No answer is not a revoked token: the cached list stays and the store reports
                // its own connection state.
                return
            }
            guard attempt == connectAttempt, !verified else { return }
            // The device token was revoked on the server: pair again (locally) or ask for a code.
            let resume = workbench.flatMap { $0.showingHome ? nil : $0.selected?.id }
            host.forgetToken(baseUrl: base)
            disconnect()
            // Access to this server was revoked: its conversations must not stay searchable.
            SpotlightIndex.clear()
            guard local else {
                phase = .failed(String(localized: "设备令牌已失效，请重新配对 \(base)"))
                return
            }
            phase = .connecting
            try await LocalPairing.pair(baseURL: URL(string: base)!, stateDirectory: server.stateDirectory, deviceName: deviceName, host: host)
            guard attempt == connectAttempt else { return }
            show(base: base, local: local, restoring: resume)
        } catch {
            guard attempt == connectAttempt else { return }
            disconnect()
            phase = .failed(error.riffetMessage)
        }
    }

    /// Installs a store for [base] and shows its workbench, starting from the local cache.
    /// [sessionId] is the conversation the previous workbench of this server had open.
    private func show(base: String, local: Bool, restoring sessionId: String? = nil) {
        let url = URL(string: base)!
        if let previous = workbench, previous.baseURL != url { SpotlightIndex.clear() }
        let store = host.install(baseUrl: base)
        // The palette is shared state keyed by server: the cached one is read synchronously here,
        // before the first window of this connection is built, and the fetch corrects it behind.
        if let api = host.api {
            theme.attach(api: api, serverKey: base)
            AppearanceStore.shared.attach(api: api, serverKey: base)
            PluginsStore.shared.attach(api: api, serverKey: base)
        }
        workbench?.close()
        let next = Workbench(store: store, host: host, baseURL: url, local: local)
        workbench = next
        if let sessionId { next.open(sessionId: sessionId) }
        phase = .ready
        if local { startMonitoring() } else { stopMonitoring(); serviceAlert = nil }
        NotificationCenterBridge.shared.attach(to: self)
        flushReady()
    }

    private static func base(_ url: URL) -> String { SavedServer.base(of: url) }

    private func authenticated() async throws -> Bool {
        guard let api = host.api else { return false }
        do {
            return try await api.authStatus().authenticated
        } catch where error.riffetUnauthenticated {
            return false
        }
    }

    nonisolated static func normalize(_ address: String) -> URL? {
        var value = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        if !value.contains("://") { value = "http://" + value }
        guard var components = URLComponents(string: value), components.host != nil else { return nil }
        // The `riffet` launcher and npm installs listen on 4337; an https address without a port is a TLS front door on 443.
        if components.port == nil && components.scheme == "http" { components.port = 4337 }
        components.path = ""
        return components.url
    }
}
