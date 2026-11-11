import Foundation
import RiffetKit

/// One line of the sidebar's message results: a hit from this Mac's cached transcripts, or one the
/// server found (`use-message-search.ts`), which also covers history that was never cached here.
struct MessageHitRow: Identifiable, Hashable {
    let id: String
    let sessionId: String
    /// The server's title for a hit; a local one reads it from the list.
    let title: String?
    let snippet: String
    /// UTF-16 ranges of [snippet] to emphasise.
    let highlights: [Range<Int>]
    /// The item's place in the transcript, for a hit found locally; opening it scrolls there.
    let sequence: Int64?
    let createdAt: String
}

/// Merges the local hits with the server's, local first (they can scroll to the message) and each
/// message once.
enum MessageHits {
    static let limit = 50

    static func merge(local: [IndexHit], remote: [MessageSearchHit], query: String) -> [MessageHitRow] {
        var rows = local.map { hit in
            MessageHitRow(
                id: "local:\(hit.sessionId):\(hit.sequence)", sessionId: hit.sessionId, title: nil, snippet: hit.snippet,
                highlights: hit.highlights.map { Int($0.start.intValue)..<(Int($0.endInclusive.intValue) + 1) },
                sequence: hit.sequence, createdAt: hit.createdAt
            )
        }
        let known = Dictionary(grouping: local, by: \.sessionId)
        for hit in remote {
            if let same = known[hit.sessionId], same.contains(where: { duplicate($0, hit) }) { continue }
            rows.append(MessageHitRow(
                id: "remote:\(hit.sessionId):\(hit.messageId)", sessionId: hit.sessionId, title: hit.sessionTitle.isEmpty ? nil : hit.sessionTitle,
                snippet: hit.snippet, highlights: ranges(of: query, in: hit.snippet), sequence: nil, createdAt: hit.at
            ))
        }
        return Array(rows.prefix(limit))
    }

    /// The same message found twice: same moment, or one snippet's text inside the other's.
    private static func duplicate(_ local: IndexHit, _ remote: MessageSearchHit) -> Bool {
        if !local.createdAt.isEmpty, local.createdAt == remote.at { return true }
        let a = normalized(local.snippet), b = normalized(remote.snippet)
        return !a.isEmpty && !b.isEmpty && (a.contains(b) || b.contains(a))
    }

    private static func normalized(_ text: String) -> String {
        text.replacingOccurrences(of: "…", with: "").filter { !$0.isWhitespace }.lowercased()
    }

    private static func ranges(of query: String, in text: String) -> [Range<Int>] {
        var result: [Range<Int>] = []
        var cursor = text.startIndex
        while cursor < text.endIndex, !query.isEmpty,
              let found = text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive], range: cursor..<text.endIndex) {
            let lower = text.utf16.distance(from: text.utf16.startIndex, to: found.lowerBound)
            let upper = text.utf16.distance(from: text.utf16.startIndex, to: found.upperBound)
            result.append(lower..<upper)
            cursor = found.upperBound
        }
        return result
    }
}
