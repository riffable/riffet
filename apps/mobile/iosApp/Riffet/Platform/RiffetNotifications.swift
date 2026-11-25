import Observation
import UIKit
@preconcurrency import UserNotifications
import RiffetKit

/// Session notifications from two sources: local ones the host posts from events it observes while
/// open, and pushes a server sends while the app is suspended ([RiffetPush]). A push's buttons and
/// reply field are answered here, in the background, on the server that sent it.
@MainActor @Observable
final class RiffetNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = RiffetNotifications()
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var openedSessionID: String?
    private(set) var openedServerOrigin: String?
    @ObservationIgnored private let center = UNUserNotificationCenter.current()
    @ObservationIgnored private var deliveredEvents = UserDefaults.standard.stringArray(forKey: "riffet.ios.notification-events") ?? []
    @ObservationIgnored private var pendingEvents: Set<String> = []
    @ObservationIgnored private var readAuthorization: UNAuthorizationStatus?
    @ObservationIgnored private var installed = false

    /// The categories a server's push names; their action ids are the push contract's.
    private static let waitingCategories: Set<String> = ["riffet.permission", "riffet.plan", "riffet.question", "riffet.question.reply"]

    private override init() { super.init() }

    /// Call during app initialization, before any notification is received.
    func install() {
        center.delegate = self
        guard !installed else { return }
        installed = true
        let allow = UNNotificationAction(identifier: "riffet.allow", title: String(localized: "允许", bundle: .riffet), options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: "riffet.deny", title: String(localized: "拒绝", bundle: .riffet), options: [])
        let approve = UNNotificationAction(identifier: "riffet.approve", title: String(localized: "批准", bundle: .riffet), options: [.authenticationRequired])
        let open = UNNotificationAction(identifier: "riffet.open", title: String(localized: "打开", bundle: .riffet), options: [.foreground])
        let reply = UNTextInputNotificationAction(identifier: "riffet.reply", title: String(localized: "回复", bundle: .riffet), options: [.authenticationRequired],
                                                  textInputButtonTitle: String(localized: "发送", bundle: .riffet), textInputPlaceholder: "")
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "riffet.permission", actions: [allow, deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: "riffet.plan", actions: [approve, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "riffet.question", actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "riffet.question.reply", actions: [reply, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "riffet.finished", actions: [reply], intentIdentifiers: []),
        ])
    }

    @discardableResult
    func refreshAuthorization() async -> UNAuthorizationStatus {
        authorization = await center.notificationSettings().authorizationStatus
        if readAuthorization != authorization {
            readAuthorization = authorization
            RiffetPush.shared.authorizationChanged(authorization)
        }
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

    /// The conversation was opened: its notifications have done their job.
    func withdraw(sessionID: String) {
        Task {
            let stale = await center.deliveredNotifications().filter { $0.request.content.threadIdentifier == sessionID }
            if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale.map(\.request.identifier)) }
        }
    }

    /// Best effort: a push asking for an answer goes once its conversation no longer waits, wherever it was answered.
    func withdrawSettled(waiting: Set<String>, known: Set<String>) {
        Task {
            let stale = await center.deliveredNotifications().filter {
                let content = $0.request.content
                return Self.waitingCategories.contains(content.categoryIdentifier)
                    && known.contains(content.threadIdentifier) && !waiting.contains(content.threadIdentifier)
            }
            if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale.map(\.request.identifier)) }
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

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let server = notification.request.content.userInfo["server"] as? String
        guard notification.request.trigger is UNPushNotificationTrigger else { return [.banner, .list, .sound] }
        // A new device or linked server is shown even from the open server: the app posts nothing of its own for it.
        if notification.request.content.userInfo["kind"] as? String == "security" { return [.banner, .list, .sound] }
        // The open server's events already reach the app, which posts its own; only another server's push shows.
        let fromOpenServer = await MainActor.run {
            AppModel.shared.workbench.map { RiffetPush.shared.isOpen(server: server, baseURL: $0.baseURL) } ?? false
        }
        return fromOpenServer ? [] : [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let info = content.userInfo
        let push = PushResponse(
            action: response.actionIdentifier,
            category: content.categoryIdentifier,
            typed: (response as? UNTextInputNotificationResponse)?.userText,
            server: info["server"] as? String,
            sessionID: info["sessionId"] as? String ?? info["sessionID"] as? String,
            localOrigin: info["serverOrigin"] as? String,
            interactionID: info["interactionId"] as? String,
            revision: info["revision"] as? String,
            interactionKind: info["interactionKind"] as? String,
            answer: (info["answers"] as? [String: Any])?[response.actionIdentifier].flatMap(PushAnswer.init),
            configRevision: (info["configRevision"] as? NSNumber)?.int64Value
        )
        await handle(push)
    }

    private func handle(_ response: PushResponse) async {
        guard let sessionID = response.sessionID, response.action != UNNotificationDismissActionIdentifier else { return }
        let origin: String? = if response.server == nil { response.localOrigin } else { await RiffetPush.shared.origin(forServer: response.server) }
        switch response.action {
        case "riffet.allow", "riffet.deny", "riffet.approve", "riffet.reply":
            guard let origin else {
                problem(sessionID: sessionID, origin: nil, body: String(localized: "这条提醒来自其他 Mac，请连接对应设备后查看", bundle: .riffet))
                return
            }
            if response.category == "riffet.finished" {
                await reply(sessionID: sessionID, origin: origin, text: response.typed ?? "", configRevision: response.configRevision)
            } else {
                await answer(response, sessionID: sessionID, origin: origin)
            }
        default:
            openedServerOrigin = origin
            openedSessionID = sessionID
        }
    }

    private func answer(_ response: PushResponse, sessionID: String, origin: String) async {
        // With 确认操作前验证本人 on, an approval waits for the check, which only the app can show.
        let verified = ["permission", "plan", "confirmation"].contains(response.interactionKind ?? "")
        if verified, UserDefaults.standard.bool(forKey: "riffet.ios.biometricApprovals") {
            problem(sessionID: sessionID, origin: origin, body: String(localized: "设备验证未完成，操作尚未提交。", bundle: .riffet))
            return
        }
        guard let interactionID = response.interactionID, let revision = response.revision, let answer = response.answer else {
            problem(sessionID: sessionID, origin: origin, body: String(localized: "结果未确认，请打开会话查看", bundle: .riffet))
            return
        }
        do {
            let done = try await RiffetPush.shared.client.respond(origin: origin, sessionId: sessionID, interactionId: interactionID,
                                                                  revision: revision, action: answer.action, selectedIds: answer.selectedIDs,
                                                                  text: answer.text ? response.typed : nil)
            if done.boolValue { withdraw(sessionID: sessionID) }
            else { problem(sessionID: sessionID, origin: origin, body: String(localized: "结果未确认，请打开会话查看", bundle: .riffet)) }
        } catch {
            problem(sessionID: sessionID, origin: origin, body: error.riffetMessage)
        }
    }

    private func reply(sessionID: String, origin: String, text: String, configRevision: Int64?) async {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        do {
            try await RiffetPush.shared.client.reply(origin: origin, sessionId: sessionID, text: text,
                                                     configRevision: configRevision.map { KotlinLong(value: $0) })
            withdraw(sessionID: sessionID)
        } catch {
            problem(sessionID: sessionID, origin: origin, title: String(localized: "回复没有发出", bundle: .riffet), body: error.riffetMessage)
        }
    }

    /// A button pressed in a notification has nowhere to show an error: another notification says
    /// so, and opens the conversation when tapped.
    private func problem(sessionID: String, origin: String?, title: String? = nil, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title ?? String(localized: "操作未完成", bundle: .riffet)
        content.body = body
        content.sound = .default
        content.threadIdentifier = sessionID
        content.userInfo = ["sessionID": sessionID, "serverOrigin": origin ?? ""]
        Task { try? await center.add(UNNotificationRequest(identifier: "riffet.problem.\(sessionID)", content: content, trigger: nil)) }
    }
}

/// What a notification response carries, read off the notification before leaving the delegate's thread.
private struct PushResponse: Sendable {
    let action: String
    let category: String
    let typed: String?
    /// The push's `server` (its server's `serverId`); nil for a local notification.
    let server: String?
    let sessionID: String?
    let localOrigin: String?
    let interactionID: String?
    let revision: String?
    let interactionKind: String?
    /// What the pressed button answers, from the push's `answers`.
    let answer: PushAnswer?
    /// A finished push's `configRevision`, which its reply is sent against.
    let configRevision: Int64?
}

/// One entry of a waiting push's `answers`: `{action, selectedIds?, text?: true}`.
private struct PushAnswer: Sendable {
    let action: String
    let selectedIDs: [String]?
    /// The button is a text field; what was typed goes as the 'Other' answer.
    let text: Bool

    init?(_ value: Any) {
        guard let entry = value as? [String: Any], let action = entry["action"] as? String else { return nil }
        self.action = action
        selectedIDs = entry["selectedIds"] as? [String]
        text = entry["text"] as? Bool ?? false
    }
}
