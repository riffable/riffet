import AppKit

/// What one conversation's transcript keeps while its page is gone (another page, the terminal,
/// the full-screen editor): the reader's disclosures and where they were reading. The list itself is
/// rebuilt; this is what makes it come back the way it was left.
@MainActor
final class TranscriptMemory {
    struct Anchor {
        let key: String
        /// How far the row's top was below the top of the viewport.
        let offset: CGFloat
    }

    let ui = TranscriptUIStore(completedProcessesOpen: false)
    var atBottom = true
    var anchor: Anchor?
    /// The rows as last laid out (the controller's own entries): the next list for this conversation
    /// starts from them instead of laying every row out again. Kept for the few most recent only.
    var rows: Any?

    /// The most recently opened conversations; older ones start fresh (collapsed, at the end).
    private static let limit = 8
    /// How many of them keep their laid-out rows, which hold every row's text layout.
    private static let rowsLimit = 4
    private static var recent: [(id: String, memory: TranscriptMemory)] = []

    static func memory(for sessionId: String) -> TranscriptMemory {
        defer {
            for entry in recent.dropLast(rowsLimit) where entry.memory.rows != nil { entry.memory.rows = nil }
        }
        if let index = recent.firstIndex(where: { $0.id == sessionId }) {
            let entry = recent.remove(at: index)
            recent.append(entry)
            return entry.memory
        }
        let memory = TranscriptMemory()
        recent.append((sessionId, memory))
        if recent.count > limit { recent.removeFirst(recent.count - limit) }
        return memory
    }
}
