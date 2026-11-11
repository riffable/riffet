import Foundation

/// What the app hands the desktop widget: the counts and the few rows it shows. Compiled into both
/// targets (the app writes it, the widget reads it), so the two cannot drift apart.
struct WidgetSnapshot: Codable, Equatable {
    struct Row: Codable, Equatable, Identifiable {
        let id: String
        let title: String
        let project: String
        /// `waiting` or `running`.
        let state: String
        /// When the running turn started, for the widget's own timer.
        let since: Date?
    }

    var waiting = 0
    var running = 0
    var rows: [Row] = []
    /// The app quit: what the counts say is no longer being watched.
    var offline = false
    /// When the app wrote it. The app rewrites it every few minutes while it runs, so a snapshot older
    /// than `staleAfter` was left by an app that is gone (a crash writes no `offline`). Longer than
    /// the widget's own 15-minute refresh plus a heartbeat, so a quiet app is never read as gone.
    var generatedAt: Date?

    static let staleAfter: TimeInterval = 20 * 60

    func isStale(at date: Date) -> Bool {
        guard let generatedAt else { return true }
        return date.timeIntervalSince(generatedAt) > Self.staleAfter
    }

    /// Whether the widget would show the same thing, ignoring when it was written.
    func sameContent(as other: WidgetSnapshot) -> Bool {
        waiting == other.waiting && running == other.running && rows == other.rows && offline == other.offline
    }

    static let fileName = "widget-snapshot.json"

    /// `~/Library/Application Support/Riffet/`. The widget is sandboxed, where `NSHomeDirectory()` is
    /// its container, so the real home comes from the password database.
    static var directory: URL {
        let home = getpwuid(getuid()).map { String(cString: $0.pointee.pw_dir) } ?? NSHomeDirectory()
        return URL(fileURLWithPath: home).appending(path: "Library/Application Support/Riffet", directoryHint: .isDirectory)
    }

    static var fileURL: URL { directory.appending(path: fileName) }

    static func decode(_ data: Data) -> WidgetSnapshot? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(WidgetSnapshot.self, from: data)
    }

    func encoded() -> Data? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return try? encoder.encode(self)
    }
}
