import AppKit
import Foundation
import Observation
import RiffetKit

/// Which conversations finished work the reader has not seen. The read state is the server's
/// (`Session.seenActivityAt`, shared by every device); this keeps what each window has on screen and
/// reports that conversation's activity as seen while this Mac is in front, as it arrives.
@MainActor @Observable
final class UnreadStore {
    static let shared = UnreadStore()

    /// What this Mac kept before the server had read state: seconds since 1970 per session id. Uploaded
    /// once to a server that has it, then removed.
    private static let legacyKey = "unreadViewedAt"
    private static let legacySeedKey = "unreadSeededAt"

    /// The conversation each window shows in its detail column, by window. Observed: a row whose
    /// conversation comes on screen loses its marker.
    private var shown: [ObjectIdentifier: String] = [:]
    private var appActive = NSApplication.shared.isActive
    /// Windows whose shown conversation is being watched for activity; one watch each.
    @ObservationIgnored private var watching: Set<ObjectIdentifier> = []
    @ObservationIgnored private var legacyUpload: LegacyUpload = UserDefaults.standard.object(forKey: legacyKey) == nil ? .done : .waiting
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    private enum LegacyUpload { case waiting, watching, uploading, done }

    private init() {
        let center = NotificationCenter.default
        for (name, active) in [(NSApplication.didBecomeActiveNotification, true), (NSApplication.didResignActiveNotification, false)] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.appActive = active }
            })
        }
    }

    func isUnread(_ session: Session) -> Bool {
        !shown.values.contains(session.id) && SidebarModelKt.isDoneUnseen(session: session)
    }

    /// [workbench]'s window now shows [sessionId] (nil: a page, the home page, or the window went away).
    func show(_ sessionId: String?, in workbench: Workbench) {
        uploadLegacyWhenReady(workbench)
        let window = ObjectIdentifier(workbench)
        guard shown[window] != sessionId else { return }
        shown[window] = sessionId
        if sessionId != nil, watching.insert(window).inserted { watch(workbench) }
    }

    /// Reports the shown conversation whenever it, its activity or this Mac's being in front changes.
    private func watch(_ workbench: Workbench) {
        let window = ObjectIdentifier(workbench)
        guard shown[window] != nil else { watching.remove(window); return }
        withObservationTracking {
            guard appActive, let id = shown[window], let session = workbench.selected, session.id == id else { return }
            _ = session.lastActivityAt
            // The store skips a conversation with nothing unread and coalesces the rest.
            DispatchQueue.main.async { workbench.store.markSeen(id: id) }
        } onChange: { [weak self, weak workbench] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, let workbench else { return }
                    self.watch(workbench)
                }
            }
        }
    }

    /// Uploads what this Mac saw before the server kept read state, once the list comes from a server
    /// that does; the server keeps the later of the two.
    private func uploadLegacyWhenReady(_ workbench: Workbench) {
        guard legacyUpload == .waiting else { return }
        let ready = withObservationTracking {
            workbench.list.sessions.contains { $0.seenActivityAt != nil }
        } onChange: { [weak self, weak workbench] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, let workbench, self.legacyUpload == .watching else { return }
                    self.legacyUpload = .waiting
                    self.uploadLegacyWhenReady(workbench)
                }
            }
        }
        guard ready else { legacyUpload = .watching; return }
        legacyUpload = .uploading
        let local = UserDefaults.standard.dictionary(forKey: Self.legacyKey) as? [String: Double] ?? [:]
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let pending = workbench.list.sessions.compactMap { session -> (String, String)? in
            guard SidebarModelKt.isUnread(session: session), let at = local[session.id] else { return nil }
            return (session.id, formatter.string(from: Date(timeIntervalSince1970: at)))
        }
        Task { [weak self] in
            var failed = false
            for (id, at) in pending {
                do { try await workbench.store.mergeSeen(id: id, activityAt: at) } catch { failed = true }
            }
            guard let self else { return }
            if failed { self.legacyUpload = .waiting; return }
            UserDefaults.standard.removeObject(forKey: Self.legacyKey)
            UserDefaults.standard.removeObject(forKey: Self.legacySeedKey)
            self.legacyUpload = .done
        }
    }
}
