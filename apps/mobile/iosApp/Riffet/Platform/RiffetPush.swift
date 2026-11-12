import ActivityKit
import Observation
import UIKit
import UserNotifications
import RiffetKit

/// Receives the APNs token; also the earliest point to install the notification delegate, which a
/// notification action that launches the app in the background needs before launch finishes.
final class RiffetAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        RiffetNotifications.shared.install()
        RiffetPush.shared.start()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        RiffetPush.shared.received(apnsToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        AppLog.shared.log(tag: "push", message: "APNs registration failed: \(error.localizedDescription)")
    }
}

/// Background push (docs/IOS.md): this device's APNs and Live Activity tokens, reported to every
/// paired server with `PUT /api/devices/me`, and each server's answer about how it reaches the device.
/// Servers whose owner configured an APNs key push directly; the others report `none`.
@MainActor @Observable
final class RiffetPush {
    static let shared = RiffetPush()

    /// Each paired server's last answer, by origin. Absent from a server without background push.
    private(set) var routes: [String: DevicePushRoute] = [:]
    @ObservationIgnored private var started = false
    /// Nothing is reported before the authorization has been read: an unread one is not a refusal.
    @ObservationIgnored private var authorizationKnown = false
    @ObservationIgnored private var allowed = false
    @ObservationIgnored private var apnsToken: String?
    @ObservationIgnored private var startToken: String?
    @ObservationIgnored private var activityToken: (activity: String, token: String)?
    @ObservationIgnored private var observedActivities: Set<String> = []
    /// What each server last accepted; an unchanged report is not sent again.
    @ObservationIgnored private var reported: [String: String] = [:]
    @ObservationIgnored private var pending: Task<Void, Never>?
    @ObservationIgnored private var pendingForce = false
    /// Push payloads name their server by its `serverId` (`instanceId` from an older server); each
    /// report records which origin that is.
    @ObservationIgnored private var servers = UserDefaults.standard.dictionary(forKey: "riffet.ios.push-servers") as? [String: String] ?? [:]
    @ObservationIgnored private var storedClient: IOSPush?
    var client: IOSPush {
        if let storedClient { return storedClient }
        let made = IOSPush(host: AppModel.shared.host)
        storedClient = made
        return made
    }

    private init() {}

    func start() {
        guard !started else { return }
        started = true
        Task {
            await RiffetNotifications.shared.refreshAuthorization()
            report(force: true)
        }
        Task {
            for await token in Activity<RiffetSummaryAttributes>.pushToStartTokenUpdates {
                startToken = token.hex
                report()
            }
        }
        Task {
            for await activity in Activity<RiffetSummaryAttributes>.activityUpdates { observe(activity) }
        }
        for activity in Activity<RiffetSummaryAttributes>.activities { observe(activity) }
    }

    /// From [RiffetNotifications] whenever the authorization it read differs from the last one.
    func authorizationChanged(_ status: UNAuthorizationStatus) {
        authorizationKnown = true
        allowed = status == .authorized || status == .provisional || status == .ephemeral
        if allowed { UIApplication.shared.registerForRemoteNotifications() }
        report()
    }

    func received(apnsToken data: Data) {
        let token = data.hex
        guard token != apnsToken else { return }
        apnsToken = token
        report()
    }

    /// The paired server a push came from, by the `server` its payload names.
    func origin(forServer id: String?) async -> String? {
        if let id, let origin = servers[id] { return origin }
        // Not reported to yet, or an older server restarted since (a new instance id): with one server there is no doubt.
        let paired = (try? await AppModel.shared.host.pairedServers()) ?? []
        return paired.count == 1 ? paired[0].origin : nil
    }

    /// Whether a push names the server the app has open.
    func isOpen(server id: String?, baseURL: URL) -> Bool {
        guard let id, let origin = servers[id].flatMap(URL.init(string:)) else { return false }
        return ServerAddress.sameOrigin(origin, baseURL)
    }

    func route(for baseURL: URL) -> DevicePushRoute? {
        routes.first { URL(string: $0.key).map { ServerAddress.sameOrigin($0, baseURL) } ?? false }?.value
    }

    func forget(origin: String) {
        reported.removeValue(forKey: origin)
        routes.removeValue(forKey: origin)
    }

    /// Reports to every paired server whose last accepted report differs; [force] asks each again.
    func report(force: Bool = false) {
        pendingForce = pendingForce || force
        pending?.cancel()
        pending = Task {
            // Tokens and the authorization tend to arrive together at launch; one report covers them.
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            let force = pendingForce
            pendingForce = false
            await send(force: force)
        }
    }

    private func send(force: Bool) async {
        // Allowed but still waiting for the APNs token: the report follows when it arrives.
        guard authorizationKnown, !allowed || apnsToken != nil else { return }
        let startToken = ActivityAuthorizationInfo().areActivitiesEnabled ? self.startToken : nil
        let openURL = AppModel.shared.workbench?.baseURL
        guard let paired = try? await AppModel.shared.host.pairedServers() else { return }
        for server in paired {
            // One summary activity, so only the open server starts and updates it; the others get no activity tokens.
            let open = openURL.map { url in URL(string: server.origin).map { ServerAddress.sameOrigin($0, url) } ?? false } ?? false
            let registration = allowed ? apnsToken.map {
                DevicePushRegistration(token: $0, topic: Bundle.main.bundleIdentifier ?? "", environment: Self.environment,
                                       activityStartToken: open ? startToken : nil, activityToken: open ? activityToken?.token : nil)
            } : nil
            let fingerprint = [registration?.token, registration?.activityStartToken, registration?.activityToken].map { $0 ?? "-" }.joined(separator: "|")
            guard force || reported[server.origin] != fingerprint else { continue }
            do {
                guard let answer = try await client.report(origin: server.origin, appVersion: Self.appVersion, installationId: Self.installationId,
                                                          push: registration, clearPush: registration == nil) else { continue }
                reported[server.origin] = fingerprint
                routes[server.origin] = answer.route
                let ids = [answer.serverId, answer.instanceId].compactMap { $0 }
                if !ids.isEmpty, Set(servers.filter { $0.value == server.origin }.keys) != Set(ids) {
                    servers = servers.filter { $0.value != server.origin }
                    for id in ids { servers[id] = server.origin }
                    UserDefaults.standard.set(servers, forKey: "riffet.ios.push-servers")
                }
            } catch {
                // Tried again at the next change or return to the foreground.
                AppLog.shared.log(tag: "push", message: "device report failed: \(error.riffetMessage)")
            }
        }
    }

    private func observe(_ activity: Activity<RiffetSummaryAttributes>) {
        guard observedActivities.insert(activity.id).inserted else { return }
        Task {
            for await token in activity.pushTokenUpdates {
                activityToken = (activity.id, token.hex)
                report()
            }
        }
        Task {
            for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
                observedActivities.remove(activity.id)
                if activityToken?.activity == activity.id { activityToken = nil; report() }
                return
            }
        }
    }

    private static let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""

    /// Random and kept on the device, so pairing again replaces this device's earlier record.
    private static let installationId: String = {
        if let saved = UserDefaults.standard.string(forKey: "riffet.ios.installation-id") { return saved }
        let made = UUID().uuidString.lowercased()
        UserDefaults.standard.set(made, forKey: "riffet.ios.installation-id")
        return made
    }()

    /// The APNs gateway this build's token belongs to. A development profile signs for the sandbox;
    /// App Store and TestFlight builds carry no profile and use production.
    private static let environment: String = {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1) else { return "production" }
        let development = text.range(of: #"<key>aps-environment</key>\s*<string>development</string>"#, options: .regularExpression) != nil
        return development ? "sandbox" : "production"
        #endif
    }()
}

private extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
