import Foundation

/// The side panel's state for one conversation, or for the home page (key `home`). The width is shared.
struct InspectorPanelState: Codable, Equatable {
    var open = false
    var tab = InspectorTab.changes
    /// The panel covers the whole conversation area; the sidebar stays.
    var maximized = false
    /// Last change, to drop the oldest entries past the limit.
    var touched: Double = 0

    var isDefault: Bool { !open && tab == .changes && !maximized }

    init() {}

    /// Field by field, so a field added later does not drop every stored state.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        open = try values.decodeIfPresent(Bool.self, forKey: .open) ?? false
        tab = (try? values.decodeIfPresent(InspectorTab.self, forKey: .tab)) ?? .changes
        maximized = try values.decodeIfPresent(Bool.self, forKey: .maximized) ?? false
        touched = try values.decodeIfPresent(Double.self, forKey: .touched) ?? 0
    }
}

/// The side panel's state per conversation (and `home`), remembered across launches. Written only
/// by the reader's own actions; the newest `limit` entries are kept. Windows share one stored map.
@MainActor
@Observable
final class InspectorPanels {
    private(set) var states: [String: InspectorPanelState] = InspectorPanels.load()
    private static let storageKey = "riffet.inspector-states"
    private static let limit = 200

    func state(_ key: String) -> InspectorPanelState { states[key] ?? InspectorPanelState() }

    func update(_ key: String, _ change: (inout InspectorPanelState) -> Void) {
        var state = states[key] ?? InspectorPanelState()
        let before = state
        change(&state)
        if !state.open { state.maximized = false }
        guard state != before else { return }
        if state.isDefault {
            states[key] = nil
        } else {
            state.touched = Date().timeIntervalSince1970
            states[key] = state
        }
        if states.count > Self.limit {
            let drop = states.sorted { $0.value.touched < $1.value.touched }.prefix(states.count - Self.limit)
            for (key, _) in drop { states[key] = nil }
        }
        // Windows share one stored map; each writes only its own key into what is stored now.
        var stored = Self.load()
        stored[key] = states[key]
        if stored.count > Self.limit {
            for (key, _) in stored.sorted(by: { $0.value.touched < $1.value.touched }).prefix(stored.count - Self.limit) { stored[key] = nil }
        }
        if let data = try? JSONEncoder().encode(stored) { UserDefaults.standard.set(data, forKey: Self.storageKey) }
    }

    private static func load() -> [String: InspectorPanelState] {
        guard let data = UserDefaults.standard.data(forKey: storageKey) else { return [:] }
        return (try? JSONDecoder().decode([String: InspectorPanelState].self, from: data)) ?? [:]
    }
}
