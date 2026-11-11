import Foundation
import RiffetKit

/// Where the import picker looks: the project the reader came from, one directory at a time, or everywhere.
enum ExternalImportScope: Hashable { case project, directory, all }

/// What a picker row stands for.
enum ExternalImportEntry: Identifiable {
    case directory(ExternalSessionDirectory)
    case session(ExternalSession)

    var id: String {
        switch self {
        case .directory(let directory): "dir:" + directory.cwd
        case .session(let item): "\(item.backendId)\u{0}\(item.backendProfileId)\u{0}\(item.nativeSessionId)"
        }
    }

    /// Cannot be chosen: its directory is gone, and nothing can be imported from it.
    var disabled: Bool {
        guard case .session(let item) = self else { return false }
        return !item.cwdExists
    }
}

/// The provider conversations on the server's machine (docs/TERMINAL-SESSIONS.md), listed by scope,
/// Agent and query. Every read is tagged; an answer for a superseded one is dropped.
@MainActor
@Observable
final class ExternalImportModel {
    static let pageSize: Int32 = 40

    let projectId: String?
    var scope: ExternalImportScope
    /// The directory a `.directory` scope has opened; nil lists the directories themselves.
    var directory: String?
    var agent: String?
    var nonInteractive = false
    var query = ""

    private(set) var sessions: [ExternalSession] = []
    private(set) var directories: [ExternalSessionDirectory] = []
    private(set) var failures: [ExternalSessionFailure] = []
    private(set) var nextCursor: String?
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var error: String?
    /// The id of the row being imported.
    private(set) var importing: String?
    var importError: String?
    @ObservationIgnored private var generation = 0

    init(projectId: String?) {
        self.projectId = projectId
        scope = projectId == nil ? .all : .project
    }

    var listsDirectories: Bool { scope == .directory && directory == nil }

    /// What a new read depends on; the view reloads when it changes.
    var key: String { "\(scope)\u{0}\(directory ?? "")\u{0}\(agent ?? "")\u{0}\(nonInteractive)\u{0}\(query)" }

    var entries: [ExternalImportEntry] {
        guard listsDirectories else { return sessions.map(ExternalImportEntry.session) }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return directories.filter { needle.isEmpty || $0.cwd.lowercased().contains(needle) }.map(ExternalImportEntry.directory)
    }

    func reload(api: RiffetApi?, refresh: Bool = false) async {
        generation += 1
        let mine = generation
        guard let api else { error = String(localized: "尚未连接服务器"); return }
        loading = true
        loadingMore = false
        defer { if mine == generation { loading = false } }
        do {
            if listsDirectories {
                let found = try await api.externalSessionDirectories(backendId: agent, nonInteractive: nonInteractive)
                guard mine == generation else { return }
                directories = found
                sessions = []
                nextCursor = nil
                failures = []
            } else {
                let page = try await read(api, cursor: nil, refresh: refresh)
                guard mine == generation else { return }
                sessions = page.items
                directories = []
                nextCursor = page.nextCursor
                failures = page.failures
            }
            error = nil
        } catch {
            guard mine == generation, !(error is CancellationError) else { return }
            self.error = error.riffetMessage
        }
    }

    func loadMore(api: RiffetApi?) async {
        guard let api, let cursor = nextCursor, !loading, !loadingMore, !listsDirectories else { return }
        let mine = generation
        loadingMore = true
        defer { if mine == generation { loadingMore = false } }
        do {
            let page = try await read(api, cursor: cursor, refresh: false)
            guard mine == generation else { return }
            let known = Set(sessions.map { ExternalImportEntry.session($0).id })
            sessions += page.items.filter { !known.contains(ExternalImportEntry.session($0).id) }
            nextCursor = page.nextCursor
        } catch {
            guard mine == generation, !(error is CancellationError) else { return }
            self.error = error.riffetMessage
        }
    }

    private func read(_ api: RiffetApi, cursor: String?, refresh: Bool) async throws -> ExternalSessionPage {
        try await api.externalSessions(
            scope: scope == .project && projectId != nil ? "project" : scope == .directory ? "directory" : "all",
            projectId: scope == .project ? projectId : nil,
            cwd: scope == .directory ? directory : nil,
            backendId: agent,
            query: query,
            cursor: cursor,
            limit: KotlinInt(int: Self.pageSize),
            nonInteractive: nonInteractive,
            refresh: refresh
        )
    }

    /// Imports [item] and opens the resulting conversation.
    func open(_ item: ExternalSession, workbench: Workbench) async -> Bool {
        guard importing == nil else { return false }
        importing = ExternalImportEntry.session(item).id
        defer { importing = nil }
        do {
            let result = try await workbench.importExternalSession(item)
            workbench.open(result.session)
            return true
        } catch {
            importError = error.riffetMessage
            return false
        }
    }

    func enter(_ directory: ExternalSessionDirectory) {
        self.directory = directory.cwd
        query = ""
    }

    func leaveDirectory() {
        directory = nil
        query = ""
    }
}
