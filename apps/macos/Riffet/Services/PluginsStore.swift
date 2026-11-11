import Foundation
import Observation
import RiffetKit

/// The current server's plugins, shared by every window.
///
/// One list per connection instead of one per workbench: a window opened later sees the same plugins
/// as the main one, and a change settings read reaches all of them. The Mac does not follow the
/// server's list stream, so the list is read again when the app becomes active, now and then while it
/// stays active, and whenever a settings page hands over a fresher copy. The appearance catalog depends
/// on which plugins are on, so it is read in the same moments.
@MainActor
@Observable
final class PluginsStore {
    static let shared = PluginsStore()

    private static let interval: TimeInterval = 60

    private(set) var items: [PluginDescriptor] = []
    /// Changes with `items`; what is derived from the list (a project's types) is keyed on it.
    private(set) var revision = 0

    @ObservationIgnored private var api: RiffetApi?
    @ObservationIgnored private var attachedServer: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var timer: Timer?

    private init() {}

    /// Points the store at one server. Another server's plugins are not kept.
    func attach(api: RiffetApi, serverKey: String) {
        if attachedServer != serverKey, !items.isEmpty {
            items = []
            revision += 1
        }
        attachedServer = serverKey
        self.api = api
        generation += 1
        let generation = self.generation
        Task { await load(api: api, generation: generation) }
    }

    func detach() {
        generation += 1
        api = nil
        attachedServer = nil
    }

    /// Reads the cached list (not a fresh detection) and the appearance catalog again.
    func refresh() {
        guard let api else { return }
        let generation = self.generation
        Task { await load(api: api, generation: generation) }
    }

    /// A settings page read the list itself; its copy replaces this one.
    func update(_ loaded: [PluginDescriptor]) {
        set(loaded)
        AppearanceStore.shared.refresh()
    }

    func appBecameActive() {
        refresh()
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    func appResigned() {
        timer?.invalidate()
        timer = nil
    }

    private func load(api: RiffetApi, generation: Int) async {
        guard let loaded = try? await api.plugins(), generation == self.generation else { return }
        set(loaded)
        AppearanceStore.shared.refresh()
    }

    private func set(_ loaded: [PluginDescriptor]) {
        guard loaded != items else { return }
        items = loaded
        revision += 1
    }
}
