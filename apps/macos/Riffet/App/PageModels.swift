import Foundation
import Observation
import RiffetKit

/// The one-level pages' models, kept by the workbench so leaving a page and coming back shows what
/// it last read (and the reader's range, filters and query) while it reads again in the background.
/// Each is made on the first visit; the pages stop their streams and polls when they disappear.
@MainActor
final class PageModels {
    private unowned let workbench: Workbench

    init(workbench: Workbench) {
        self.workbench = workbench
    }

    private(set) lazy var stats = StatsModel(workbench: workbench)
    private(set) lazy var tasks = TasksModel(workbench: workbench)
    private(set) lazy var marks = MarksModel()
    private(set) lazy var extensions = ExtensionsStore()
    private(set) lazy var plugins = PluginManagementStore()
    /// The host's favorite folders for the home page.
    private(set) lazy var composers = ComposerPool()
    /// The conversations' composers, kept here rather than in the conversation view so a rebuilt view
    /// (another 界面风格) finds its drafts, attachments and uploads in flight where it left them.
    private(set) lazy var sessionComposers = ComposerPool()
    private(set) lazy var homeFavorites = FolderFavoritesModel()
    /// The home page's attempt groups per project.
    private(set) lazy var attemptGroups = AttemptGroupsCache()

    /// Model catalogs the home page last showed, by its catalog key (context and revisions), so a new
    /// home page draws its model controls on the first frame.
    private var homeCatalogs: [String: NativeBackendCatalogEntry] = [:]

    func homeCatalog(_ key: String) -> NativeBackendCatalogEntry? { homeCatalogs[key] }

    func rememberHomeCatalog(_ entry: NativeBackendCatalogEntry?, key: String) {
        if homeCatalogs.count > 32 { homeCatalogs.removeAll() }
        homeCatalogs[key] = entry
    }
}

/// Attempt groups per project, shown at once from the last read and read again once a few seconds old.
@MainActor
@Observable
final class AttemptGroupsCache {
    private(set) var groups: [String: [AttemptGroup]] = [:]
    @ObservationIgnored private var readAt: [String: Date] = [:]

    private static let maxAge: TimeInterval = 5

    /// Attempts were just started in [projectId]: the next visit reads its groups again.
    func invalidate(_ projectId: String) { readAt[projectId] = nil }

    func load(_ projectId: String, api: RiffetApi?) async {
        if let at = readAt[projectId], Date().timeIntervalSince(at) < Self.maxAge { return }
        guard let api, let next = try? await api.attemptGroups(projectId: projectId) else { return }
        readAt[projectId] = Date()
        if groups[projectId] != next { groups[projectId] = next }
    }
}
