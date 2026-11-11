import Foundation
import Observation
import RiffetKit

/// Which conversations finished work the reader has not seen, kept only on this Mac: the server has
/// no read state. A conversation is unread when its last activity is newer than what the reader saw
/// of it. What they saw is the activity it had while on screen in some window, stamped again as it
/// leaves the screen; one never shown counts from the first launch, so an existing list does not
/// start out all unread.
@MainActor @Observable
final class UnreadStore {
    static let shared = UnreadStore()

    private static let key = "unreadViewedAt"
    private static let seedKey = "unreadSeededAt"
    private static let keep = 500

    /// The conversation each window shows in its detail column, by window. Observed: a row whose
    /// conversation comes on screen loses its marker.
    private var shown: [ObjectIdentifier: String] = [:]
    /// Seconds since 1970 per session id: the newest activity seen. Rows read it through `isUnread`
    /// in the list's one pass and receive a Bool, so writing it re-renders no row by itself.
    @ObservationIgnored private var seen: [String: Double]
    /// Each session's parsed activity, by the string it came from: the list asks on every pass.
    @ObservationIgnored private var activity: [String: (raw: String, at: Double)] = [:]
    @ObservationIgnored private var saving = false
    private let seededAt: Double

    private init() {
        let defaults = UserDefaults.standard
        seen = defaults.dictionary(forKey: Self.key) as? [String: Double] ?? [:]
        if defaults.object(forKey: Self.seedKey) == nil { defaults.set(Date().timeIntervalSince1970, forKey: Self.seedKey) }
        seededAt = defaults.double(forKey: Self.seedKey)
    }

    func isUnread(_ session: Session) -> Bool {
        guard let at = activityTime(session) else { return false }
        if shown.values.contains(session.id) {
            // On screen: what arrives is seen as it arrives.
            if at > seen[session.id] ?? 0 { stamp(session.id, at) }
            return false
        }
        return at > (seen[session.id] ?? seededAt)
    }

    /// [window] now shows [sessionId] (nil: a page, the home page, or the window went away). The one
    /// it showed before is stamped as it leaves, with this Mac's clock or the newest activity known
    /// for it, whichever is later, so work that arrived while it was open does not turn into a marker.
    func show(_ sessionId: String?, in window: ObjectIdentifier) {
        let left = shown[window]
        guard left != sessionId else { return }
        shown[window] = sessionId
        if let left, !shown.values.contains(left) {
            stamp(left, max(Date().timeIntervalSince1970, activity[left]?.at ?? 0))
        }
    }

    private func activityTime(_ session: Session) -> Double? {
        let raw = session.lastActivityAt ?? session.createdAt
        if let cached = activity[session.id], cached.raw == raw { return cached.at }
        guard let at = ServerTime.date(raw)?.timeIntervalSince1970 else { return nil }
        activity[session.id] = (raw, at)
        return at
    }

    private func stamp(_ id: String, _ at: Double) {
        seen[id] = max(seen[id] ?? 0, at)
        // Called from a list pass too: write once afterwards, not during the view update.
        guard !saving else { return }
        saving = true
        DispatchQueue.main.async { [self] in
            saving = false
            if seen.count > Self.keep + 50 {
                for (id, _) in seen.sorted(by: { $0.value < $1.value }).prefix(seen.count - Self.keep) { seen[id] = nil }
            }
            UserDefaults.standard.set(seen, forKey: Self.key)
        }
    }
}
