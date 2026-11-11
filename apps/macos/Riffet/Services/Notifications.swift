import AppKit
import UserNotifications
import RiffetKit

/// How a dialog is answered from outside the conversation (a notification button, the menu bar
/// panel). The same rule as the conversation's own card: with "批准前使用 Touch ID" on, a
/// permission dialog is answered only after Touch ID. Every failure comes back as a thrown message
/// for the caller to show; none is swallowed.
@MainActor
enum QuickApproval {
    static var requiresTouchID: Bool { UserDefaults.standard.bool(forKey: "riffet.touchid-approvals") }

    static func submit(workbench: Workbench, sessionId: String, interactionId: String, revision: String, permission: Bool, action: String, selectedIds: [String]?) async throws {
        if requiresTouchID, permission {
            // The sheet needs an app in front; a notification button leaves Riffet in the background.
            NSApp.activate()
            guard await TouchID.confirm(String(localized: "批准 Agent 的操作")) else {
                throw LocalPairing.Failure(message: String(localized: "没有通过 Touch ID 验证，Agent 仍在等待你的确认"))
            }
        }
        let result = try await workbench.store.respondFor(
            sessionId: sessionId, interactionId: interactionId, revision: revision,
            action: action, selectedIds: (selectedIds?.isEmpty ?? true) ? nil : selectedIds
        )
        workbench.host.poke()
        if result.status == .uncertain {
            throw LocalPairing.Failure(message: result.message ?? String(localized: "结果未确认，请打开会话查看"))
        }
    }
}

/// Session alerts as system notifications, with the same rules as Android's `RiffetNotifier`:
/// finished / failed / interrupted / waiting; a waiting alert carries the dialog's answers as
/// buttons when buttons can answer it honestly; a finished one carries a reply field. The session
/// the reader is looking at gets no notification. A notification is withdrawn once its session
/// stops waiting, wherever that was answered.
@MainActor
final class NotificationCenterBridge: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCenterBridge()

    private weak var app: AppModel?
    private let center = UNUserNotificationCenter.current()
    private var authorized = false
    private var registeredCategories: [String: UNNotificationCategory] = [:]
    private var waiting: Set<String> = []

    private static let finishedCategory = "riffet.finished"
    private static let waitingPrefix = "riffet.waiting."
    private static let openAction = "riffet.open"
    private static let replyAction = "riffet.reply"

    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: "riffet.notifications") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "riffet.notifications") }
    }

    func attach(to app: AppModel) {
        self.app = app
        center.delegate = self
        FocusFilter.sync()
        let reply = UNTextInputNotificationAction(identifier: Self.replyAction, title: String(localized: "回复"), options: [], textInputButtonTitle: String(localized: "发送"), textInputPlaceholder: String(localized: "继续对话…"))
        register(UNNotificationCategory(identifier: Self.finishedCategory, actions: [reply], intentIdentifiers: []))
        guard !authorized else { return }
        Task {
            authorized = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        }
    }

    func handle(_ activity: SessionActivity) {
        let nowWaiting = Set(activity.sessions.filter { $0.state == .waiting && $0.archivedAt == nil }.map(\.id))
        for id in waiting.subtracting(nowWaiting) { withdraw(sessionId: id) }
        waiting = nowWaiting
        NSApp.dockTile.badgeLabel = nowWaiting.isEmpty ? nil : "\(nowWaiting.count)"
        guard Self.enabled, let workbench = app?.workbench else { return }
        for alert in activity.alerts {
            // A Focus filter (专注模式) may let only some kinds through; the badge above is unaffected.
            guard FocusFilter.allows(alert.kind) else { continue }
            let inMain = !workbench.showingHome && workbench.selected?.id == alert.session.id
            if NSApp.isActive, inMain || WorkbenchWindows.isVisiblyShowing(alert.session.id) {
                NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .now)
                continue
            }
            Task { await post(alert, workbench: workbench) }
        }
    }

    func withdraw(sessionId: String) {
        center.removeDeliveredNotifications(withIdentifiers: [sessionId])
        // Its buttons are gone with it: a category per waiting session must not outlive the wait.
        if registeredCategories.removeValue(forKey: Self.waitingPrefix + sessionId) != nil {
            center.setNotificationCategories(Set(registeredCategories.values))
        }
    }

    private func post(_ alert: SessionAlert, workbench: Workbench) async {
        let session = alert.session
        let content = UNMutableNotificationContent()
        content.title = session.title.isEmpty ? "Riffet" : session.title
        content.threadIdentifier = session.projectId
        content.userInfo = ["sessionId": session.id]
        if let project = workbench.project(session.projectId) { content.subtitle = project.name }
        switch alert.kind {
        case .finished:
            content.body = (try? await workbench.store.latestReply(session: session)) ?? String(localized: "已完成")
            content.categoryIdentifier = Self.finishedCategory
            content.sound = .default
        case .failed:
            content.body = session.error ?? String(localized: "运行失败")
            content.sound = .default
        case .interrupted:
            content.body = String(localized: "已中断")
        case .waiting:
            let interaction = try? await workbench.store.currentInteraction(sessionId: session.id)
            // It may have been answered while the dialog was being read.
            guard waiting.contains(session.id) else { return }
            content.body = interaction.map { [$0.title, $0.message].compactMap { $0 }.joined(separator: " · ") } ?? String(localized: "等待你确认")
            content.interruptionLevel = .timeSensitive
            content.sound = .default
            if let interaction {
                let choices = interactionChoices(interaction: interaction, limit: 3)
                if !choices.isEmpty {
                    let category = Self.waitingPrefix + session.id
                    let actions = choices.enumerated().map { index, choice in
                        UNNotificationAction(identifier: "choice.\(index)", title: choice.label, options: [])
                    }
                    register(UNNotificationCategory(identifier: category, actions: actions, intentIdentifiers: []))
                    content.categoryIdentifier = category
                    content.userInfo["interactionId"] = interaction.id
                    content.userInfo["revision"] = interaction.revision
                    content.userInfo["permission"] = interaction.kind == .permission
                    content.userInfo["choices"] = choices.map { ["action": $0.action, "selected": $0.selectedIds ?? []] }
                }
            }
        }
        let request = UNNotificationRequest(identifier: session.id, content: content, trigger: nil)
        try? await center.add(request)
    }

    private func register(_ category: UNNotificationCategory) {
        registeredCategories[category.identifier] = category
        center.setNotificationCategories(Set(registeredCategories.values))
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let sessionId = info["sessionId"] as? String else { return }
        let action = response.actionIdentifier
        let typed = (response as? UNTextInputNotificationResponse)?.userText
        let interactionId = info["interactionId"] as? String
        let revision = info["revision"] as? String
        let choices = info["choices"] as? [[String: Any]]
        // Notifications posted before the flag existed ask for Touch ID too.
        let permission = info["permission"] as? Bool ?? true
        await MainActor.run {
            self.respond(sessionId: sessionId, action: action, typed: typed, interactionId: interactionId, revision: revision, permission: permission, choices: choices)
        }
    }

    private func respond(sessionId: String, action: String, typed: String?, interactionId: String?, revision: String?, permission: Bool, choices: [[String: Any]]?) {
        if action == Self.replyAction, let typed {
            app?.whenReady { workbench in
                Task {
                    do { try await workbench.store.replyFor(sessionId: sessionId, text: typed) } catch {
                        self.reportFailure(sessionId: sessionId, title: String(localized: "回复没有发出"), reason: error.riffetMessage)
                    }
                }
            }
            return
        }
        if action.hasPrefix("choice."), let index = Int(action.dropFirst(7)), let choices, index < choices.count,
           let interactionId, let revision, let choiceAction = choices[index]["action"] as? String {
            let selected = choices[index]["selected"] as? [String]
            app?.whenReady { workbench in
                Task {
                    do {
                        try await QuickApproval.submit(
                            workbench: workbench, sessionId: sessionId, interactionId: interactionId, revision: revision,
                            permission: permission, action: choiceAction, selectedIds: selected
                        )
                    } catch {
                        self.reportFailure(sessionId: sessionId, title: String(localized: "操作未完成"), reason: error.riffetMessage)
                    }
                }
            }
            return
        }
        NSApp.activate()
        WindowRouter.shared.showMain()
        app?.whenReady { $0.open(sessionId: sessionId) }
    }

    /// A button pressed in a notification has nowhere to show an error: say so in another one,
    /// which opens the conversation when clicked.
    private func reportFailure(sessionId: String, title: String, reason: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = reason
        content.sound = .default
        content.userInfo = ["sessionId": sessionId]
        Task { try? await center.add(UNNotificationRequest(identifier: "failure." + sessionId, content: content, trigger: nil)) }
    }
}
