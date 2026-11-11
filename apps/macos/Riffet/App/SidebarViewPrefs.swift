import Foundation

/// The reader's order of the side panel's views, and the ones they turned off (docs/design/plugin-system.md §4.1),
/// as the web's `viewPrefs` keeps them: by view ID, including IDs this Mac does not offer now (a plugin
/// that is off), so a view that comes back finds its old place. Kept on this Mac, per server. Windows of
/// one server share the instance, so a change in settings reaches every open panel.
@MainActor
@Observable
final class SidebarViewPrefs {
    private(set) var order: [String]
    private(set) var hidden: [String]

    @ObservationIgnored private let key: String
    private static var instances: [String: SidebarViewPrefs] = [:]

    static func shared(for baseURL: URL) -> SidebarViewPrefs {
        let key = "riffet.sidebar-views|\(baseURL.absoluteString)"
        if let known = instances[key] { return known }
        let created = SidebarViewPrefs(key: key)
        instances[key] = created
        return created
    }

    private struct Stored: Codable {
        var order: [String] = []
        var hidden: [String] = []

        init() {}

        /// Field by field, so a field added later does not drop the others.
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            order = (try? values.decodeIfPresent([String].self, forKey: .order)) ?? []
            hidden = (try? values.decodeIfPresent([String].self, forKey: .hidden)) ?? []
        }
    }

    private init(key: String) {
        self.key = key
        let stored = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(Stored.self, from: $0) } ?? Stored()
        order = Self.unique(stored.order)
        hidden = Self.unique(stored.hidden)
    }

    private static func unique(_ ids: [String]) -> [String] {
        var seen: Set<String> = []
        return ids.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    func isHidden(_ id: String) -> Bool { hidden.contains(id) }

    /// Reorders the views on offer to [shown]. An ID that is not on offer keeps its place in the stored
    /// order and the offered ones fill the rest in [shown]'s order.
    func setOrder(_ shown: [String]) {
        let offered = Set(shown)
        var queue = Self.unique(shown)
        let kept = order.map { id -> String in offered.contains(id) && !queue.isEmpty ? queue.removeFirst() : id }
        let next = kept + queue
        guard next != order else { return }
        order = next
        save()
    }

    func setVisible(_ id: String, _ visible: Bool) {
        let next = visible ? hidden.filter { $0 != id } : Self.unique(hidden + [id])
        guard next != hidden else { return }
        hidden = next
        save()
    }

    /// [entries] in the reader's order; views they have not placed follow, in the order given.
    func ordered<Entry>(_ entries: [Entry], id: (Entry) -> String) -> [Entry] {
        let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        return entries.enumerated()
            .sorted { (rank[id($0.element)] ?? order.count, $0.offset) < (rank[id($1.element)] ?? order.count, $1.offset) }
            .map(\.element)
    }

    private func save() {
        var stored = Stored()
        stored.order = order
        stored.hidden = hidden
        if let data = try? JSONEncoder().encode(stored) { UserDefaults.standard.set(data, forKey: key) }
    }
}
