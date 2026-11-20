import AppKit
import RiffetKit

/// What this Mac does when an agent calls it as a device (docs/DEVICES.md「实现（Mac，T0）」). Kotlin
/// (`MacDevice`) decides whether a call may reach this at all; here each capability does its one thing
/// and answers through the reply it was given.
final class MacDeviceService: NSObject, MacDeviceActions, @unchecked Sendable {
    static let shared = MacDeviceService()

    private let lock = NSLock()
    private var tasks: [String: (token: UUID, task: Task<Void, Never>)] = [:]
    private var notificationsGranted = false

    private static let askedKey = "riffet.screen-capture-asked"
    /// What a password manager puts on the pasteboard beside a secret (nspasteboard.org).
    private static let concealedType = "org.nspasteboard.ConcealedType"

    // MARK: Capabilities

    /// Read from the Kotlin side on any thread, so it uses only thread-safe state; the notification
    /// answer is the last one [permissionsChanged] read from the system.
    func capabilities() -> [String] {
        let id = DeviceCapability.shared
        var ids = [id.CLIPBOARD_READ, id.CLIPBOARD_WRITE, id.OPEN_URL]
        if WindowCapture.hasAccess { ids.append(id.WINDOW_CAPTURE) }
        lock.lock()
        let notifications = notificationsGranted
        lock.unlock()
        if notifications, NotificationCenterBridge.enabled { ids.append(id.NOTIFY) }
        return ids
    }

    /// A permission or preference behind a capability may have changed: read the system's notification
    /// state, then let the device report what is usable now.
    @MainActor
    func permissionsChanged() {
        Task { @MainActor in
            let granted = await NotificationCenterBridge.shared.authorizationGranted()
            lock.withLock { notificationsGranted = granted }
            AppModel.shared.host.refreshDevice()
        }
    }

    /// The first ask shows the system prompt; once asked, the system will not prompt again, so
    /// the Screen Recording pane of System Settings opens instead.
    @MainActor
    func requestScreenCapture() {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: Self.askedKey) {
            if let pane = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
                NSWorkspace.shared.open(pane)
            }
        } else {
            defaults.set(true, forKey: Self.askedKey)
            _ = CGRequestScreenCaptureAccess()
        }
        permissionsChanged()
    }

    // MARK: Actions

    func notify(callId: String, sessionId: String, title: String?, body: String, reply: MacActionReply) {
        run(callId) {
            guard await NotificationCenterBridge.shared.authorizationGranted() else {
                reply.failed(message: "Notifications are not allowed for Riffet on this Mac")
                return
            }
            guard !Task.isCancelled else { return }
            do {
                try await NotificationCenterBridge.shared.postDevice(callId: callId, sessionId: sessionId, title: title, body: body)
                reply.done()
            } catch {
                reply.failed(message: "The notification could not be posted")
            }
        }
    }

    func clipboardRead(callId: String, reply: MacActionReply) {
        run(callId) {
            // A secret its source marked as concealed is not handed to an agent.
            let read: (concealed: Bool, text: String?) = await MainActor.run {
                let board = NSPasteboard.general
                let concealed = board.types?.contains { $0.rawValue == MacDeviceService.concealedType } ?? false
                return (concealed, concealed ? nil : board.string(forType: .string))
            }
            if read.concealed {
                reply.failed(message: "The clipboard holds content its source marked as concealed")
            } else {
                reply.text(value: read.text)
            }
        }
    }

    func clipboardWrite(callId: String, text: String, reply: MacActionReply) {
        run(callId) {
            let written = await MainActor.run { () -> Bool? in
                guard !Task.isCancelled else { return nil }
                NSPasteboard.general.clearContents()
                return NSPasteboard.general.setString(text, forType: .string)
            }
            guard let written else { return }
            if written { reply.done() } else { reply.failed(message: "The clipboard could not be written") }
        }
    }

    /// Only http and https are opened, decided on the parsed scheme: a link the default app of another
    /// scheme handles (a file, an app, a script) would be code execution for whoever sent it.
    func openUrl(callId: String, url: String, reply: MacActionReply) {
        guard let components = URLComponents(string: url), let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            reply.failed(message: "This Mac opens only http and https links")
            return
        }
        guard let host = components.host, !host.isEmpty, let target = components.url,
              ["http", "https"].contains(target.scheme?.lowercased() ?? "") else {
            reply.failed(message: "The link has no host")
            return
        }
        run(callId) {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            guard !Task.isCancelled else { return }
            do {
                _ = try await NSWorkspace.shared.open(target, configuration: configuration)
                reply.done()
            } catch {
                reply.failed(message: "No app could open the link")
            }
        }
    }

    func listWindows(callId: String, reply: MacActionReply) {
        run(callId) {
            do {
                reply.windows(list: try await WindowCapture.list())
            } catch {
                reply.failed(message: "The windows could not be listed")
            }
        }
    }

    func captureWindow(callId: String, windowId: Int64, attempt: Int32, reply: MacActionReply) {
        run(callId) {
            guard let id = UInt32(exactly: windowId) else {
                reply.failed(message: "No window has this id")
                return
            }
            do {
                guard let image = try await WindowCapture.capture(windowId: id, attempt: Int(attempt)) else {
                    reply.failed(message: "The window image is too large to send")
                    return
                }
                reply.image(bytes: image.data, mimeType: image.mimeType, width: Int32(image.width), height: Int32(image.height))
            } catch let failure as WindowCapture.Failure {
                reply.failed(message: failure.message)
            } catch {
                reply.failed(message: "The window could not be captured")
            }
        }
    }

    func cancel(callId: String) {
        lock.lock()
        let entry = tasks.removeValue(forKey: callId)
        lock.unlock()
        entry?.task.cancel()
    }

    func cancelAll() {
        lock.lock()
        let running = tasks.values.map { $0.task }
        tasks.removeAll()
        lock.unlock()
        running.forEach { $0.cancel() }
    }

    /// Runs [work] as the call's task so [cancel] can stop it. Registered before it can finish; a
    /// finished task removes only itself, since a capture's next attempt reuses the call id.
    private func run(_ callId: String, _ work: @escaping @Sendable () async -> Void) {
        let token = UUID()
        lock.lock()
        tasks[callId] = (token, Task { [self] in
            if !Task.isCancelled { await work() }
            lock.withLock { if tasks[callId]?.token == token { tasks[callId] = nil } }
        })
        lock.unlock()
    }
}
