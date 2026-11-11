import Foundation
import RiffetKit

/// The model catalogs and `/` menus a workbench has read, per backend, profile and project. A new
/// backend revision or a connection re-established after a failure marks them stale, as a restarted
/// server's model capabilities may have changed without an event. A stale answer stays readable
/// until the next read replaces it, so the controls built from it do not blink out.
@MainActor
@Observable
final class CatalogCache {
    /// A catalog answer older than this is refreshed on the next open, even if the connection is
    /// still live; model membership changes without an event.
    private static let catalogTTL: TimeInterval = 5 * 60
    private let host: MacHost
    private let store: SessionStore

    /// One observable slot per key: loading one backend's catalog does not re-render the pages
    /// showing another's.
    @ObservationIgnored private var slots: [String: CatalogSlot] = [:]
    /// Bumped when the connection comes back; views key their catalog reads on it.
    private(set) var connectionRevision = 0
    @ObservationIgnored private var refreshOnLive = true
    @ObservationIgnored private var slashCatalogs: [String: (entry: NativeSlashCatalog, connectionRevision: Int, backendRevision: Int64)] = [:]
    @ObservationIgnored private var backendRevision: Int64 = 0

    init(host: MacHost, store: SessionStore) {
        self.host = host
        self.store = store
    }

    /// The list's backend revision moved on: every catalog read so far is out of date. The entries
    /// stay on screen; the next read of each key goes to the server.
    func backendsChanged(_ revision: Int64) {
        backendRevision = revision
    }

    /// Follows the open conversation's stream: the first Live after a reconnect or failure bumps
    /// [connectionRevision].
    func follow(_ connection: RiffetConnectionState) {
        if connection is RiffetConnectionStateReconnecting || connection is RiffetConnectionStateFailed {
            refreshOnLive = true
        }
        if connection is RiffetConnectionStateLive, refreshOnLive {
            connectionRevision += 1
            refreshOnLive = false
        }
    }

    /// The backend's models and capabilities; throws so a picker can offer a retry.
    func loadCatalog(_ agent: String, profileId: String?, projectId: String?, reload: Bool = false) async throws -> NativeBackendCatalogEntry? {
        let slot = slot("\(agent)|\(profileId ?? "")|\(projectId ?? "")")
        let connectionRevision = self.connectionRevision
        let backendRevision = self.backendRevision
        if !reload, let entry = slot.entry, slot.connectionRevision == connectionRevision, slot.backendRevision == backendRevision,
           let savedAt = slot.savedAt, Date().timeIntervalSince(savedAt) < Self.catalogTTL { return entry }
        guard let api = host.api else { return nil }
        let request = staleness()
        let entry = try await api.agentCatalog(agentId: agent, profileId: profileId, projectId: projectId, allModels: false, global: projectId == nil)
        guard request.isCurrent else { throw CancellationError() }
        if slot.entry !== entry { slot.entry = entry }
        slot.connectionRevision = connectionRevision
        slot.backendRevision = backendRevision
        slot.savedAt = Date()
        return entry
    }

    /// The catalog already loaded for [session], without a request. A view reading it follows
    /// only this key's slot.
    func cached(for session: Session) -> NativeBackendCatalogEntry? {
        cached(session.agentID, profileId: session.backendProfileId, projectId: session.projectId)
    }

    /// The catalog already loaded for a backend, profile and project, without a request; a page
    /// shows it on its first frame while [loadCatalog] checks it.
    func cached(_ agent: String, profileId: String?, projectId: String?) -> NativeBackendCatalogEntry? {
        slot("\(agent)|\(profileId ?? "")|\(projectId ?? "")").entry
    }

    /// Providers [session] can continue on in place, from its own catalog; empty until read, and
    /// from a server that predates them. A view reading it follows only this conversation's slot.
    func continuations(for session: Session) -> [NativeProfileContinuation] {
        slot(sessionKey(session)).entry?.continuations ?? []
    }

    /// Reads [session]'s own catalog, the only one that lists its continuations. Best effort: the
    /// model list does not depend on it.
    func loadSessionCatalog(for session: Session) async {
        guard let api = host.api else { return }
        let request = staleness()
        guard let entry = try? await api.sessionCatalog(id: session.id), request.isCurrent else { return }
        slot(sessionKey(session)).entry = entry
    }

    private func sessionKey(_ session: Session) -> String { "session|\(session.id)|\(session.backendProfileId ?? "")" }

    private func slot(_ key: String) -> CatalogSlot {
        if let slot = slots[key] { return slot }
        let slot = CatalogSlot()
        slots[key] = slot
        return slot
    }

    /// A catalog answer is stale once the backends change or the connection was re-established.
    private func staleness() -> RequestContext {
        RequestContext { [self.backendRevision, Int64(self.connectionRevision)] }
    }

    /// The `/` menu already read for [session], without a request; a switch shows it at once.
    func cachedSlashCatalog(for session: Session) -> NativeSlashCatalog? {
        slashCatalogs[slashKey(session)]?.entry
    }

    private func slashKey(_ session: Session) -> String {
        "session|\(session.id)|\(session.agentID)|\(session.backendProfileId ?? "")|\(session.projectId)"
    }

    /// The `/` menu for [session]'s backend; [refresh] re-reads it as the menu opens, like the web.
    func slashCatalog(for session: Session, refresh: Bool = false) async -> NativeSlashCatalog? {
        let key = slashKey(session)
        let connectionRevision = self.connectionRevision
        let backendRevision = self.backendRevision
        if !refresh, let cached = slashCatalogs[key], cached.connectionRevision == connectionRevision,
           cached.backendRevision == backendRevision { return cached.entry }
        let request = staleness()
        let catalog = try? await store.slashCatalog(session: session)
        guard request.isCurrent else { return nil }
        guard let catalog else { return slashCatalogs[key]?.entry }
        slashCatalogs[key] = (catalog, connectionRevision, backendRevision)
        return catalog
    }

    /// The `/` menu for a conversation that does not exist yet.
    func slashCatalog(agent: String, profileId: String?, projectId: String?) async -> NativeSlashCatalog? {
        let key = "new|\(agent)|\(profileId ?? "")|\(projectId ?? "")"
        let connectionRevision = self.connectionRevision
        let backendRevision = self.backendRevision
        if let cached = slashCatalogs[key], cached.connectionRevision == connectionRevision,
           cached.backendRevision == backendRevision { return cached.entry }
        let request = staleness()
        let catalog = try? await host.api?.agentSlashCatalog(agentId: agent, projectId: projectId, profileId: profileId, sessionId: nil, global: projectId == nil)
        guard request.isCurrent else { return nil }
        guard let catalog else { return slashCatalogs[key]?.entry }
        slashCatalogs[key] = (catalog, connectionRevision, backendRevision)
        return catalog
    }
}

/// One cached model catalog; views observe the slot of the key they show.
@MainActor
@Observable
final class CatalogSlot {
    var entry: NativeBackendCatalogEntry?
    @ObservationIgnored var connectionRevision = 0
    /// The backend revision [entry] was read under; a newer one makes it stale, not gone.
    @ObservationIgnored var backendRevision: Int64 = 0
    /// When [entry] was read; nil for an entry that came from an older cache.
    @ObservationIgnored var savedAt: Date?
}
