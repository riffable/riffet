import Observation
import UIKit
@preconcurrency import UserNotifications

/// Foreground and local notifications only. This does not register for APNs or promise delivery
/// while iOS has suspended the network connection. The host posts from actual incoming events.
@MainActor @Observable
final class RiffetNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = RiffetNotifications()
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var openedSessionID: String?
    private(set) var openedServerOrigin: String?
    @ObservationIgnored private let center = UNUserNotificationCenter.current()
    @ObservationIgnored private var deliveredEvents = UserDefaults.standard.stringArray(forKey: "riffet.ios.notification-events") ?? []
    @ObservationIgnored private var pendingEvents: Set<String> = []

    private override init() { super.init() }

    /// Call during app initialization, before any notification is received.
    func install() { center.delegate = self }

    @discardableResult
    func refreshAuthorization() async -> UNAuthorizationStatus {
        authorization = await center.notificationSettings().authorizationStatus
        return authorization
    }

    /// Request in response to the user's notification setting, never automatically on launch.
    @discardableResult
    func requestAuthorization() async throws -> Bool {
        let allowed = try await center.requestAuthorization(options: [.alert, .badge, .sound])
        await refreshAuthorization()
        return allowed
    }

    func postSessionUpdate(sessionID: String, title: String, body: String, eventID: String? = nil, namespace: String = "") async throws {
        let status = await refreshAuthorization()
        guard status == .authorized || status == .provisional || status == .ephemeral else { return }
        let eventKey = eventID.map { "\(namespace)|\(sessionID)|\($0)" }
        if let eventKey {
            guard !deliveredEvents.contains(eventKey), !pendingEvents.contains(eventKey) else { return }
            pendingEvents.insert(eventKey)
        }
        defer { if let eventKey { pendingEvents.remove(eventKey) } }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = sessionID
        content.userInfo = ["sessionID": sessionID, "serverOrigin": namespace]
        // A stable eventID lets the host deduplicate replayed stream events after reconnecting.
        let identifier = eventKey.map { "riffet.\($0)" } ?? "riffet.\(sessionID).\(UUID().uuidString)"
        try await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
        if let eventKey {
            deliveredEvents.append(eventKey)
            deliveredEvents = Array(deliveredEvents.suffix(200))
            UserDefaults.standard.set(deliveredEvents, forKey: "riffet.ios.notification-events")
        }
    }

    func consumeOpenedSession() -> (id: String, origin: String?)? {
        guard let id = openedSessionID else { return nil }
        defer { openedSessionID = nil; openedServerOrigin = nil }
        return (id, openedServerOrigin)
    }

    func openSettings() async {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        await UIApplication.shared.open(url)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let sessionID = response.notification.request.content.userInfo["sessionID"] as? String
        let origin = response.notification.request.content.userInfo["serverOrigin"] as? String
        Task { @MainActor [weak self] in
            self?.openedServerOrigin = origin
            self?.openedSessionID = sessionID
        }
        completionHandler()
    }
}
