import AppKit
import CryptoKit
import Foundation
import RiffetKit

/// The one-level pages that replace the home page or a conversation in the detail column.
enum WorkbenchPage: String, Equatable {
    case stats, tasks, extensions, plugins, marks, activity

    /// The order of the sidebar's first rows, as on the web.
    static let sidebarOrder: [WorkbenchPage] = [.tasks, .extensions, .marks, .plugins, .stats]

    /// The pages behind the sidebar footer's menu instead of a row.
    static let footerMenu: [WorkbenchPage] = [.extensions, .stats, .activity]

    var title: String {
        switch self {
        case .tasks: String(localized: "定时任务")
        case .plugins: String(localized: "插件")
        case .extensions: String(localized: "Agent 扩展")
        case .marks: String(localized: "收藏夹")
        case .stats: String(localized: "数据统计")
        case .activity: String(localized: "活动")
        }
    }

    var symbol: String {
        switch self {
        case .tasks: "clock"
        case .plugins: "puzzlepiece.extension"
        case .extensions: "wrench.and.screwdriver"
        case .marks: "bookmark"
        case .stats: "chart.bar"
        case .activity: "waveform.path.ecg"
        }
    }

    /// The menu shortcut that opens it (`RiffetCommands`), when it has one.
    var shortcutLabel: String? {
        switch self {
        case .tasks: "⇧⌘J"
        case .extensions: "⇧⌘E"
        case .marks: "⇧⌘L"
        case .stats: "⇧⌘U"
        case .activity, .plugins: nil
        }
    }
}

/// A line above the composer for one conversation, such as a saved reply that could not be found.
struct SessionNotice: Equatable {
    let sessionId: String
    let text: String
}

/// The parallel-attempt group whose comparison page covers the detail column.
struct AttemptGroupSelection: Equatable {
    let id: String
    let projectId: String
}

/// The open server's state as SwiftUI sees it: a mirror of `SessionStore` plus what the macOS views
/// derive from it. Nothing here interprets the protocol; projection and grouping are Kotlin's.
@MainActor
@Observable
final class Workbench {
    /// What this workbench is for. `main` is the app's window with the sidebar, the home page and the
    /// global duties (notifications, Spotlight, the remembered conversation). `window` shows one
    /// conversation in its own window, on its own `store` (stream and transcript) and presenter; the
    /// session lists, settings and projects come from the main store, which keeps them polled.
    enum Role { case main, window }

    let role: Role
    /// The conversation a `window` workbench is pinned to; set when it first opens it and kept, so
    /// opening anything else from the window goes to another window.
    @ObservationIgnored private(set) var windowSessionId: String?
    /// Who this window is to the server's terminal lease: two windows with one id would both think
    /// they hold the terminal.
    @ObservationIgnored let terminalClientId: String
    let store: SessionStore
    /// Where the lists, settings and projects are read from and refreshed: the main store.
    private let listStore: SessionStore
    let presenter: TimelinePresenter?
    let host: MacHost
    let baseURL: URL
    /// The server runs on this Mac, so paths can be opened in local apps.
    let local: Bool

    private(set) var list = SessionListState(projects: [], sessions: [], settings: nil, backendRevision: 0, loading: false, loaded: false, error: nil, cachedAt: nil, canDeleteSessions: false)
    /// The list's backend revision on its own: model catalogs follow it, not every list frame.
    private(set) var backendRevision: Int64 = 0
    /// The list's settings and projects on their own, written only when they change: a session
    /// frame replaces the list many times a minute while a turn runs, and views that only need
    /// these should not follow it.
    private(set) var settings: AppSettings?
    private(set) var projectList: [Project] = []
    // Everything below that belongs to the open conversation is written together by
    // `apply(_ state:)`, from the store's one atomic `openSession` snapshot: a switch never pairs
    // the new title with the previous conversation's interaction card, queue or status.

    /// The open session. Frames that only move its timestamps are skipped, so the conversation's
    /// views do not re-render for them.
    private(set) var selected: Session?
    /// The conversation last shown here, for a deletion that clears `selected` before it is noticed.
    @ObservationIgnored private var lastShown: (id: String, projectId: String)?
    /// The confirmation being asked for, the conversation whose preview is loading, and a failure to report.
    var deletion: SessionDeletion?
    private(set) var deletionLoading: String?
    var deletionError: String?
    private(set) var timeline: [TimelineItem] = []
    /// The native status without its live output rate (`outputRate` is its own flow, and the
    /// speed label reads it from the presentation).
    private(set) var status: NativeStatus?
    private(set) var runs: [Run] = []
    private(set) var queued: [Run] = []
    private(set) var uncertain: [Run] = []
    private(set) var working = false
    private(set) var interaction: NativeInteraction?
    private(set) var sendState = ComposerSendState(sending: false, interrupting: false, pendingRunIds: [], error: nil, notice: nil)
    private(set) var connection: RiffetConnectionState = RiffetConnectionStateIdle.shared
    private(set) var configurationError: String?
    private(set) var recoveryError: SessionNotice?
    private(set) var context: NativeContext?
    private(set) var history: NativeHistoryState?
    private(set) var loadingHistory = false
    private(set) var historyError: String?
    private(set) var cachedAt: Int64?
    private(set) var subagents: [StoredSubagent] = []

    /// The open conversation once it has assembled: its rows and its status are in, or the wait for
    /// them ran out. Until then the page shows it as one piece arriving rather than part by part.
    /// Written once per conversation, so views may read it freely.
    private(set) var assembledSession: String?
    @ObservationIgnored private var assemblyDeadline: Task<Void, Never>?
    /// How long a switch waits for the conversation to assemble before showing what it has.
    static let assemblyWait: Duration = .milliseconds(400)

    /// The transcript's rows, docks and working line, computed by Kotlin off the main thread.
    private(set) var presentation: TimelinePresentation?
    var grouping: TimelineGrouping? { presentation?.sessionId == selected?.id ? presentation?.grouping : nil }
    /// The docks' state, written only when it changes, so a streamed chunk does not re-render them.
    private(set) var todos: [TodoEntry] = []
    private(set) var goal: SessionGoal?
    /// Background shells and subagents of the open conversation, as the presenter lists them
    /// (running first), written only when they change.
    private(set) var jobs: [NativeJob] = []
    private(set) var subagentEntries: [SubagentEntry] = []
    /// The files the conversation's tools wrote, newest first (paths as written, see `TimelinePresentation.outputs`).
    private(set) var outputs: [SessionOutput] = []
    /// Subagents still running while the main agent is idle; the stop button and the composer's hint.
    private(set) var backgroundSubagents = 0
    /// Compaction and background tasks above the composer; invisible when the server reports no activity.
    private(set) var dock = ActivityDock(compacting: false, background: 0, tasks: [])
    private(set) var stoppingActivities: Set<String> = []
    /// The conversation the docks above describe, and what each recently left one last showed: a
    /// switch shows the new conversation's last docks while the presenter catches up, never the
    /// previous conversation's, and never an empty frame between two conversations that have docks.
    @ObservationIgnored private var docksSessionId: String?
    @ObservationIgnored private var recentDocks: [String: SessionDocks] = [:]
    @ObservationIgnored private var recentDocksOrder: [String] = []

    /// The sidebar's rows, filters and message search.
    let sidebar = WorkbenchSidebar()
    /// The side panel's state per conversation, remembered across launches.
    let panels = InspectorPanels()
    /// The order and visibility of the side panel's views, on this Mac for this server.
    let sidebarViewPrefs: SidebarViewPrefs
    /// Plugin commands in flight: their input form, the confirmation of a task and the message they end with.
    let pluginCommands = PluginCommandRunner()
    /// A task the reader should see in its view, as a command that started it asked: the view shows it once.
    var taskFocus: TaskFocus?
    /// The project terminal docked below the conversation.
    let terminalDock = TerminalDock()
    /// Model catalogs and `/` menus read so far.
    let catalogs: CatalogCache
    /// The pages' models, kept across visits.
    @ObservationIgnored private(set) lazy var pageModels = PageModels(workbench: self)
    /// One clock for every relative time on screen, instead of a timer per row.
    private(set) var minute = Date()
    private var clock: Timer?

    /// 个人资料 of this server's owner; nil until the first read, or when the server predates it.
    private(set) var owner: OwnerInfo?
    /// The next healthy list frame re-reads the owner: set at start and whenever the list failed or went offline.
    @ObservationIgnored private var ownerStale = true
    @ObservationIgnored private var activation: NSObjectProtocol?

    /// The new-conversation page is showing instead of a transcript.
    var showingHome = true
    /// A one-level page (statistics, tasks, extensions) covers both the home page and a transcript.
    var page: WorkbenchPage? {
        didSet {
            guard page != oldValue else { return }
            if role == .window, let requested = page {
                // A conversation window has no pages; they open in the main window.
                page = nil
                showInMain { $0.page = requested }
                return
            }
            navigationIntent += 1
            if page != nil { exitInspectorMaximized() }
        }
    }
    /// The statistics page, kept as a flag for the callers that only know that page.
    var showingStats: Bool {
        get { page == .stats }
        set { if newValue { page = .stats } else if page == .stats { page = nil } }
    }
    var pendingHomeCreation: PendingSessionCreation?
    var creatingHomeSession = false
    var homeCreationError: String?
    private(set) var supportsProjectlessTasks = false
    private var serverFeaturesLoaded = false
    private var homeTaskSelectionKey: String { "riffet.home-target|\(baseURL.absoluteString)" }
    private var homeTaskSelection: String?

    var homeProjectId: String? {
        didSet {
            guard homeProjectId != oldValue else { return }
            if homeProjectId == nil || project(homeProjectId)?.isSystemProject == false {
                homeTaskSelection = homeProjectId ?? "__projectless__"
                UserDefaults.standard.set(homeTaskSelection, forKey: homeTaskSelectionKey)
                if let id = homeProjectId { visitProject(id) }
                if showingHome { loadReferences(sessionId: nil, projectId: homeProjectId) }
            }
            guard showingHome else { return }
            terminalDock.hide()
            exitInspectorMaximized()
        }
    }
    /// Text a system entry hands to the next quick chat composer, consumed once.
    var quickChatPrefill = ""
    private(set) var quickChatPrefillToken = 0
    /// Where the open transcript scrolls next (a search hit, a saved reply).
    var focus: TranscriptFocus?
    /// 会话内查找 of the open conversation (`SessionFind`), and a counter that moves the caret to its field.
    private(set) var find: FindState?
    private(set) var findFocus = 0
    /// The topmost visible row's item key, set by the open transcript.
    @ObservationIgnored var readingKey: () -> String? = { nil }
    @ObservationIgnored private weak var findReturn: NSResponder?
    /// Shown above the composer while its conversation is open, until dismissed.
    var notice: SessionNotice?
    /// The attempt group comparison page, when it covers the detail column.
    var attemptGroupSelection: AttemptGroupSelection?

    /// Files the next message cites, shared by the home and conversation composers like the web's.
    private(set) var references: [PromptContextReference] = [] {
        didSet { saveReferences() }
    }
    private var referencesSessionId: String?
    private var referencesProjectId: String?
    func references(for projectId: String?) -> [PromptContextReference] {
        referencesProjectId == projectId ? references : []
    }
    /// A file the file panel opens next; `token` repeats a request for the same file.
    private(set) var previewTarget: PreviewTarget?
    /// The open conversation shown as its transcript or as the CLI's own terminal, full page.
    var showsTerminalPage = false {
        didSet { if showsTerminalPage { showsCanvasPage = false; exitInspectorMaximized() } }
    }
    /// The open conversation shown as the canvas plugin's flow in place of its transcript; another conversation opens as its transcript.
    var showsCanvasPage = false {
        didSet { if showsCanvasPage { showsTerminalPage = false; exitInspectorMaximized() } }
    }
    /// The canvas is a plugin: it is offered while the server has it on.
    var canvasAvailable: Bool { plugins.contains { $0.id == "riffet.canvas" && $0.enabled } }
    var showsCanvas: Bool { showsCanvasPage && canvasAvailable && !showingHome && page == nil }
    private var reopeningSessionIds: Set<String> = []
    var reopening: Bool { selected.map { reopeningSessionIds.contains($0.id) } ?? false }
    private var wakeActivity: NSObjectProtocol?

    private let subscriptions = FlowSubscriptions()
    /// Bumped by every navigation, so a lookup started for an earlier one cannot open its result.
    @ObservationIgnored private var navigationIntent = 0
    var creationNavigationIntent: Int { navigationIntent }
    private(set) var backends: [NativeBackendCatalogEntry] = []
    /// The server's plugins, shared with every window: which plugin views the inspector can offer.
    var plugins: [PluginDescriptor] { PluginsStore.shared.items }
    /// What the task providers say each project is (`android`, ...): what a view's `projectType`
    /// condition is judged against. A project is read when a view list first needs it, again after a
    /// minute and when the plugins change; until the answer arrives it has no type.
    private(set) var projectTypes: [String: Set<String>] = [:]
    @ObservationIgnored private var projectTypesRead: [String: Date] = [:]
    @ObservationIgnored private var projectTypesLoading: Set<String> = []
    /// The plugins the project types were read under: another plugin set can recognise other projects.
    @ObservationIgnored private var projectTypesRevision = 0
    @ObservationIgnored private var pendingPanel: (sessionId: String, panel: String)?
    @ObservationIgnored private var pendingPanelSerial = 0
    /// The list's first load restores the last open conversation, unless the reader navigated before it.
    @ObservationIgnored private var restoredLastSession = false

    init(store: SessionStore, host: MacHost, baseURL: URL, local: Bool, role: Role = .main, presenter: TimelinePresenter? = nil, listStore: SessionStore? = nil) {
        self.role = role
        terminalClientId = role == .main ? TerminalController.mainClientId : "mac-" + UUID().uuidString.lowercased()
        self.store = store
        self.listStore = listStore ?? store
        self.presenter = presenter ?? host.presenter
        self.host = host
        self.baseURL = baseURL
        self.local = local
        sidebarViewPrefs = SidebarViewPrefs.shared(for: baseURL)
        catalogs = CatalogCache(host: host, store: store)
        projectVisits = UserDefaults.standard.dictionary(forKey: projectVisitsKey) as? [String: Double] ?? [:]
        homeTaskSelection = UserDefaults.standard.string(forKey: homeTaskSelectionKey)
        if role == .window { showingHome = false }
        sidebar.workbench = self
        terminalDock.workbench = self
        subscriptions.observe(self.listStore.list) { [weak self] list in
            guard let self else { return }
            if list.backendRevision != self.backendRevision {
                self.backendRevision = list.backendRevision
                self.catalogs.backendsChanged(list.backendRevision)
            }
            self.list = list
            if list.settings != self.settings { self.settings = list.settings }
            if list.projects != self.projectList { self.projectList = list.projects }
            guard self.role == .main else { return }
            if list.error != nil || list.cachedAt != nil {
                self.ownerStale = true
            } else if list.loaded, self.ownerStale {
                self.ownerStale = false
                Task { await self.refreshOwner() }
            }
            self.restoreLastSession()
            self.sidebar.schedule()
            SpotlightIndex.schedule(sessions: list.sessions, projects: list.projects)
        }
        subscriptions.observe(store.openSession) { [weak self] state in self?.apply(state) }
        subscriptions.observe(self.listStore.removedSessions) { [weak self] ids in self?.sessionsRemoved(ids) }
        subscriptions.observe(store.timeline) { [weak self] items in self?.applyTimeline(items) }
        subscriptions.observe(store.find.state) { [weak self] state in self?.find = state }
        if let presenter = self.presenter {
            subscriptions.observe(presenter.presentation) { [weak self] presentation in
                self?.applyPresentation(presentation)
                self?.noteAssembly()
            }
        }
        Task { await loadBackends() }
        // Notifications and the relative times belong to the main window only.
        guard role == .main else { return }
        subscriptions.observe(store.activity) { activity in
            NotificationCenterBridge.shared.handle(activity)
        }
        MarksStore.shared.attach(host.marks)
        clock = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.minute = Date() }
        }
        // Another device may have changed the profile while this app was in the background.
        activation = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { guard let self, !self.ownerStale else { return }; Task { await self.refreshOwner() } }
        }
    }

    func close() {
        WorkbenchWindows.unregister(self)
        subscriptions.cancelAll()
        if role == .main { MarksStore.shared.attach(nil) }
        clock?.invalidate()
        if let activation { NotificationCenter.default.removeObserver(activation) }
        pendingPanel = nil
        holdWake(false)
        // The page models hold the workbench; letting them go breaks the cycle.
        pageModels = PageModels(workbench: self)
    }

    /// Mirrors the open conversation from `SessionStore.openSession`, one atomic snapshot. Each
    /// property is written only when it changed, so views follow only what they show.
    private func apply(_ state: OpenSessionState) {
        let session = state.selected
        if let session { lastShown = (session.id, session.projectId) }
        let switched = session?.id != selected?.id
        if switched {
            configurationError = nil
            if showsCanvasPage { showsCanvasPage = false }
        }
        if switched || (state.status != nil && state.status?.phase != .offline) { recoveryError = nil }
        if let session, let current = selected {
            if !Self.sameForDisplay(current, session) { selected = session }
        } else if switched {
            selected = session
        }
        if switched {
            loadReferences(sessionId: session?.id, projectId: session?.projectId)
            // The transcript and the presenter's output are separate flows that arrive behind the
            // snapshot; take what the store holds now and drop the previous conversation's lists.
            applyTimeline(store.timeline.value)
            applyPresentation(presenter?.presentation.value)
        }

        let subagents = state.subagents
        if !Self.identical(subagents, self.subagents) { self.subagents = subagents }
        if state.status != status { status = state.status }
        if state.runs != runs { runs = state.runs }
        if state.queued != queued { queued = state.queued }
        if state.uncertain != uncertain { uncertain = state.uncertain }
        if state.working != working {
            working = state.working
            holdWake(state.working)
            if role == .main { PerfMonitor.shared.streaming = state.working }
        }
        if state.interaction != interaction { interaction = state.interaction }
        if state.sendState != sendState { sendState = state.sendState }

        let connection = state.connection
        catalogs.follow(connection)
        if (connection as? NSObject)?.isEqual(self.connection) != true { self.connection = connection }

        if state.context != context { context = state.context }
        if state.history != history { history = state.history }
        if state.loadingHistory != loadingHistory { loadingHistory = state.loadingHistory }
        if state.historyError != historyError { historyError = state.historyError }
        let cachedAt = state.cachedAt?.int64Value
        if cachedAt != self.cachedAt { self.cachedAt = cachedAt }
        if switched { awaitAssembly() } else { noteAssembly() }
    }

    private func awaitAssembly() {
        assemblyDeadline?.cancel()
        assemblyDeadline = nil
        guard let id = selected?.id else { return }
        noteAssembly()
        guard assembledSession != id else { return }
        assemblyDeadline = Task { [weak self] in
            try? await Task.sleep(for: Self.assemblyWait)
            guard !Task.isCancelled, let self, self.selected?.id == id, self.assembledSession != id else { return }
            self.assembledSession = id
        }
    }

    /// The open conversation has assembled once its loaded rows and its status (which places the
    /// notices, the interaction card and the working line) have both arrived.
    private func noteAssembly() {
        guard let id = selected?.id, assembledSession != id, status != nil,
              let presentation, presentation.sessionId == id, presentation.loaded else { return }
        assembledSession = id
        assemblyDeadline?.cancel()
        assemblyDeadline = nil
    }

    private func applyTimeline(_ items: [TimelineItem]) {
        if !Self.identical(items, timeline) { timeline = items }
    }

    private func applyPresentation(_ presentation: TimelinePresentation?) {
        if presentation !== self.presentation { self.presentation = presentation }
        let id = selected?.id
        if let presentation, let id, presentation.sessionId == id {
            var docks = SessionDocks(presentation)
            if !presentation.loaded {
                // A frame from before this conversation's history arrived has empty lists: those
                // keep what is on screen (or what it showed when last open) until the loaded frame.
                // Compaction, background tasks and stop requests are live and follow at once.
                let held = docksSessionId == id ? openDocks : (recentDocks[id] ?? SessionDocks())
                docks.todos = held.todos
                docks.goal = held.goal
                docks.jobs = held.jobs
                docks.subagents = held.subagents
                docks.outputs = held.outputs
                docks.backgroundSubagents = held.backgroundSubagents
            }
            showDocks(docks, for: id)
        } else if docksSessionId != id {
            // The presenter runs behind the store; until it catches up with this conversation its
            // docks, jobs and subagents belong to the previous one. Show what this conversation
            // showed when it was last open, or nothing.
            showDocks(id.flatMap { recentDocks[$0] } ?? SessionDocks(), for: id)
        }
    }

    /// Writes [docks] as the open conversation's, each property only when it changed, and keeps
    /// the conversation being left for when it is opened again.
    private func showDocks(_ docks: SessionDocks, for id: String?) {
        if let previous = docksSessionId, previous != id { rememberDocks(for: previous) }
        docksSessionId = id
        if docks.todos != todos { todos = docks.todos }
        if docks.goal != goal { goal = docks.goal }
        if docks.jobs != jobs { jobs = docks.jobs }
        if docks.subagents != subagentEntries { subagentEntries = docks.subagents }
        if docks.outputs != outputs { outputs = docks.outputs }
        if docks.backgroundSubagents != backgroundSubagents { backgroundSubagents = docks.backgroundSubagents }
        if docks.dock != dock { dock = docks.dock }
        if docks.stopping != stoppingActivities { stoppingActivities = docks.stopping }
    }

    /// The docks on screen now.
    private var openDocks: SessionDocks {
        SessionDocks(todos: todos, goal: goal, jobs: jobs, subagents: subagentEntries, outputs: outputs, backgroundSubagents: backgroundSubagents, dock: dock, stopping: stoppingActivities)
    }

    private func rememberDocks(for id: String) {
        var docks = openDocks
        docks.stopping = []
        recentDocks[id] = docks
        recentDocksOrder.removeAll { $0 == id }
        recentDocksOrder.append(id)
        if recentDocksOrder.count > Self.recentDocksLimit {
            recentDocks[recentDocksOrder.removeFirst()] = nil
        }
    }

    private static let recentDocksLimit = 24

    /// Whether two lists from Kotlin hold the same instances, without calling `equals` on them.
    private static func identical<T>(_ a: [T], _ b: [T]) -> Bool {
        a.count == b.count && zip(a, b).allSatisfy { ($0 as AnyObject) === ($1 as AnyObject) }
    }

    /// Everything the conversation's views show of a session; timestamps alone do not count.
    private static func sameForDisplay(_ a: Session, _ b: Session) -> Bool {
        a.id == b.id && a.title == b.title && a.state == b.state && a.tags == b.tags && a.archivedAt == b.archivedAt
            && a.pinnedAt == b.pinnedAt && a.agent == b.agent && a.backendProfileId == b.backendProfileId
            && a.nativeSessionId == b.nativeSessionId && a.terminalId == b.terminalId
            && a.model == b.model && a.mode == b.mode && a.approval == b.approval && a.error == b.error
            && a.configRevision == b.configRevision && a.resumePicker == b.resumePicker && a.projectId == b.projectId
            && a.titleSource == b.titleSource && a.kind == b.kind
    }

    // MARK: Derived

    /// The server-owned project that holds quick chats; it is never listed as an ordinary project.
    var quickChatProject: Project? { projectList.first { $0.isBuiltInQuickChat } }
    /// Every project a reader may pick, archived included, without the quick-chat project.
    var listingProjects: [Project] { projectList.filter { !$0.isSystemProject } }

    var projects: [Project] { listingProjects.filter { $0.archivedAt == nil } }

    func project(_ id: String?) -> Project? {
        guard let id else { return nil }
        return projectList.first { $0.id == id }
    }

    var selectedProject: Project? { project(selected?.projectId) }

    /// The quick chat page is open, or a quick chat is the conversation on screen: no project cwd,
    /// terminal, inspector or git.
    var quickChatContext: Bool {
        if showingHome { return project(homeProjectId)?.isBuiltInQuickChat == true }
        return selected?.backendId == .chat
    }
    var homeIsQuickChat: Bool { showingHome && project(homeProjectId)?.isBuiltInQuickChat == true }
    var openSessionIsQuickChat: Bool { !showingHome && selected?.backendId == .chat }

    var currentProjectId: String? {
        if showingHome { return project(homeProjectId)?.isBuiltInQuickChat == true ? nil : homeTaskProjectId }
        return selected?.backendId == .chat ? nil : selected?.projectId
    }
    var currentProject: Project? { project(currentProjectId) }

    var activeSessions: [Session] { list.sessions.filter { $0.archivedAt == nil && $0.state.isActive } }

    var waitingSessions: [Session] { list.sessions.filter { $0.archivedAt == nil && $0.state == .waiting } }

    // MARK: Side panel

    /// The key of what the page shows: the open conversation, or the home page.
    var inspectorKey: String {
        if !showingHome, let id = selected?.id { return id }
        return "home"
    }

    /// The panel's state for the open conversation (or the home page).
    var inspector: InspectorPanelState { panels.state(inspectorKey) }

    /// The panel is maximized and nothing takes the area back: a page, the terminal dock or the terminal view.
    var inspectorMaximized: Bool {
        let state = inspector
        return state.open && state.maximized && page == nil && !terminalDock.shown && !showsTerminalPage
    }

    func setInspector(_ key: String? = nil, _ change: (inout InspectorPanelState) -> Void) {
        panels.update(key ?? inspectorKey, change)
    }

    func setInspectorOpen(_ open: Bool) {
        guard !quickChatContext else { return }
        if open { page = nil }
        setInspector { $0.open = open }
    }

    /// From a page the shortcut brings the panel back instead of toggling one that is not on screen.
    func toggleInspector() {
        guard !quickChatContext else { return }
        setInspectorOpen(page != nil || !inspector.open)
    }

    /// What a plugin's `when` condition is judged against for the open conversation or project.
    var inspectorFacts: InspectorFacts {
        let project = currentProject
        if let project { noteProjectTypes(project.id) }
        var facts = InspectorFacts(hasProject: project != nil, hasSession: !showingHome && selected != nil)
        if let project {
            facts.projectTypes = projectTypes[project.id] ?? []
            // The Changes view is always offered here; a task workspace's repository is not asked about.
            if !project.isTaskWorkspace { facts.capabilities.insert("git") }
        }
        return facts
    }

    /// The side panel's views on offer now, in the reader's order and without the ones they turned off.
    var inspectorViews: [InspectorViewEntry] {
        let offered = InspectorViewRegistry.available(plugins, facts: inspectorFacts)
        return sidebarViewPrefs.ordered(offered, id: \.id).filter { !sidebarViewPrefs.isHidden($0.id) }
    }

    /// Every view this Mac can draw whatever the project, in the reader's order and hidden ones included:
    /// what settings lists.
    var configurableInspectorViews: [InspectorViewEntry] {
        sidebarViewPrefs.ordered(InspectorViewRegistry.available(plugins, facts: InspectorFacts(everything: true)), id: \.id)
    }

    /// The tab for a panel ID from outside, such as a link; nil when no such view is on offer.
    func inspectorTab(panel id: String) -> InspectorTab? { inspectorViews.first { $0.id == id }?.tab }

    /// Opens the panel view [panel] of conversation [sessionId], as a link names it. A plugin view is
    /// only on offer once the plugins, the conversation, its project and the project's types are
    /// known, so the request waits for them (a newer one replaces it, and it lapses after a while).
    func showPanel(_ panel: String, session sessionId: String) {
        pendingPanelSerial += 1
        let serial = pendingPanelSerial
        if panel == InspectorTab.changes.id || panel == InspectorTab.files.id {
            pendingPanel = nil
            setInspector(sessionId) { $0.open = true; $0.tab = InspectorTab(rawValue: panel) }
            return
        }
        pendingPanel = (sessionId, panel)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            if self?.pendingPanelSerial == serial { self?.pendingPanel = nil }
        }
        resolvePendingPanel(serial)
    }

    private func resolvePendingPanel(_ serial: Int) {
        guard serial == pendingPanelSerial, let pending = pendingPanel else { return }
        if !showingHome, selected?.id == pending.sessionId, let tab = inspectorTab(panel: pending.panel) {
            pendingPanel = nil
            setInspector(pending.sessionId) { $0.open = true; $0.tab = tab }
            return
        }
        // Re-judged on the next change to anything the offered list is made of.
        withObservationTracking {
            _ = showingHome
            _ = selected?.id
            _ = inspectorViews
        } onChange: { [weak self] in
            Task { @MainActor in self?.resolvePendingPanel(serial) }
        }
    }

    func showInspector(_ tab: InspectorTab) {
        guard !quickChatContext else { return }
        page = nil
        setInspector { $0.open = true; $0.tab = tab }
    }

    /// Maximizing takes the area back from the terminal; leaving the conversation, closing the panel,
    /// or opening a page or terminal leaves it again, as on the web.
    func toggleInspectorMaximized() {
        guard page == nil, !quickChatContext else { return }
        if inspectorMaximized {
            exitInspectorMaximized()
        } else {
            showsTerminalPage = false
            terminalDock.hide()
            setInspector { $0.open = true; $0.maximized = true }
            // The conversation stays laid out under the panel; its composer must not keep the keys.
            if let window = NSApp.keyWindow, window.firstResponder is NSTextView { window.makeFirstResponder(nil) }
        }
    }

    func exitInspectorMaximized(_ key: String? = nil) {
        setInspector(key) { $0.maximized = false }
    }

    // MARK: Navigation

    private var lastSessionKey: String { "riffet.last-session|\(baseURL.absoluteString)" }

    private func restoreLastSession() {
        guard !restoredLastSession, list.loaded else { return }
        restoredLastSession = true
        guard navigationIntent == 0, let id = UserDefaults.standard.string(forKey: lastSessionKey), id != "home",
              let session = list.sessions.first(where: { $0.id == id && $0.archivedAt == nil }) else { return }
        open(session)
    }

    /// ⌘1…⌘9: the [index]th conversation the sidebar shows.
    func openSidebarSession(at index: Int) {
        let order = sidebar.visibleOrder
        guard order.indices.contains(index) else { return }
        open(order[index])
    }

    /// The previous or next conversation of the sidebar, wrapping around; from the home page, the first or last.
    func openAdjacentSession(_ step: Int) {
        let order = sidebar.order
        guard !order.isEmpty else { return }
        let current = showingHome ? nil : order.firstIndex { $0.id == selected?.id }
        let index = current.map { (($0 + step) % order.count + order.count) % order.count } ?? (step > 0 ? 0 : order.count - 1)
        open(order[index])
    }

    /// Shows [page], or goes back to what it covers when it is already showing.
    func toggle(page: WorkbenchPage) {
        self.page = self.page == page ? nil : page
    }

    /// Hands [sessionId] to another window when this workbench must not show it: a conversation
    /// already open in its own window stays there, and a conversation window stays on its own
    /// conversation. True when handed over.
    private func redirect(_ sessionId: String, focus: TranscriptFocus? = nil) -> Bool {
        if role == .window, let pinned = windowSessionId, pinned != sessionId {
            WindowRouter.shared.openConversation(sessionId, focus: focus)
            return true
        }
        if role == .main, WorkbenchWindows.focus(sessionId, transcriptFocus: focus) { return true }
        return false
    }

    func open(_ session: Session) {
        visitProject(session.projectId)
        if redirect(session.id) { return }
        navigationIntent += 1
        if selected?.id != session.id || showingHome {
            exitInspectorMaximized()
        }
        if selected?.id != session.id {
            if showsTerminalPage { showsTerminalPage = false }
            terminalDock.hide()
        }
        store.select(session: session)
        // Leave Home only after the destination is mirrored: `select` has already written the
        // store, and the flow deliveries arrive a turn later. Reading it now keeps Home from
        // revealing the previous conversation and its interaction card or queue for a frame.
        apply(store.openSession.value)
        if referencesSessionId != session.id { loadReferences(sessionId: session.id, projectId: session.projectId) }
        // Written only when they change: each write re-renders whatever reads it.
        if page != nil { page = nil }
        if attemptGroupSelection != nil { attemptGroupSelection = nil }
        if showingHome { showingHome = false }
        if role == .main { UserDefaults.standard.set(session.id, forKey: lastSessionKey) }
        NotificationCenterBridge.shared.withdraw(sessionId: session.id)
    }

    @ObservationIgnored private var preloading: (id: String, task: Task<Void, Never>)?

    /// The pointer entered or left [sessionId]'s row: after a moment on it the conversation is read
    /// from this Mac and laid out ahead of a click, so the click opens it like one just visited.
    func hover(sessionId: String, entered: Bool) {
        if let preloading, preloading.id != sessionId || !entered {
            // Leaving another row (its exit can arrive after this row's entry) leaves this one alone.
            guard entered || preloading.id == sessionId else { return }
            preloading.task.cancel()
            store.cancelPreload(sessionId: preloading.id)
            self.preloading = nil
        }
        guard entered, preloading == nil, sessionId != selected?.id else { return }
        let task = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            self?.store.preload(sessionId: sessionId)
        }
        preloading = (sessionId, task)
    }

    func open(sessionId: String, focus: TranscriptFocus? = nil) {
        if redirect(sessionId, focus: focus) { return }
        if let focus { self.focus = focus }
        if let session = list.sessions.first(where: { $0.id == sessionId }) {
            open(session)
            return
        }
        // A link or a search hit can name a conversation the list has not loaded (or has archived).
        // Whatever the reader opened while it loaded wins over it.
        navigationIntent += 1
        let request = RequestContext { self.navigationIntent }
        Task {
            guard let session = try? await host.api?.session(id: sessionId), request.isCurrent else { return }
            open(session)
        }
    }

    /// Opens [sessionId], reading it from the server when the list does not have it. False when the
    /// conversation cannot be read; a window shows that instead of an empty page.
    func openReading(sessionId: String) async -> Bool {
        if role == .window, windowSessionId == nil {
            windowSessionId = sessionId
            WorkbenchWindows.register(self)
        }
        if let session = list.sessions.first(where: { $0.id == sessionId }) {
            open(session)
            return true
        }
        navigationIntent += 1
        let request = RequestContext { self.navigationIntent }
        guard let session = try? await host.api?.session(id: sessionId) else { return false }
        guard request.isCurrent else { return true }
        open(session)
        return true
    }

    /// Runs [action] on the main window's workbench and brings that window forward. A conversation
    /// window has no home page, pages or sidebar; what needs them happens there.
    func showInMain(_ action: (Workbench) -> Void) {
        guard let main = AppModel.shared.workbench, main !== self else { return }
        WindowRouter.shared.showMain()
        action(main)
    }

    func showHome(projectId: String? = nil) {
        if role == .window {
            showInMain { $0.showHome(projectId: projectId) }
            return
        }
        navigationIntent += 1
        terminalDock.hide()
        exitInspectorMaximized()
        if let projectId {
            if project(projectId)?.isTaskWorkspace == true { selectHomeProject(nil) }
            else { homeProjectId = projectId }
        } else {
            homeProjectId = homeTaskProjectId
        }
        loadReferences(sessionId: nil, projectId: homeProjectId)
        page = nil
        attemptGroupSelection = nil
        showingHome = true
        UserDefaults.standard.set("home", forKey: lastSessionKey)
    }

    func selectHomeProject(_ id: String?) {
        loadReferences(sessionId: nil, projectId: id)
        homeTaskSelection = id ?? "__projectless__"
        UserDefaults.standard.set(homeTaskSelection, forKey: homeTaskSelectionKey)
        homeProjectId = id
    }

    /// Opens the quick-chat tab with text supplied by a system entry, or the task composer
    /// when an older server has no quick-chat project.
    func openQuickChat(prefill: String = "") {
        if role == .window {
            showInMain { $0.openQuickChat(prefill: prefill) }
            return
        }
        quickChatPrefill = prefill
        quickChatPrefillToken += 1
        showHome(projectId: quickChatProject?.id)
        pageModels.composers.model(for: homeDraftKey).focus()
    }

    func showHomeTab(quickChat: Bool) {
        if quickChat {
            guard let project = quickChatProject else { return }
            showHome(projectId: project.id)
        } else {
            let target = homeTaskProjectId
            // An empty workspace still needs a task tab so the reader can choose a directory.
            homeProjectId = target
            showHome(projectId: target)
        }
    }

    func openAttemptGroup(id: String, projectId: String) {
        if role == .window {
            showInMain { $0.openAttemptGroup(id: id, projectId: projectId) }
            return
        }
        navigationIntent += 1
        terminalDock.hide()
        exitInspectorMaximized()
        page = nil
        showingHome = false
        attemptGroupSelection = AttemptGroupSelection(id: id, projectId: projectId)
    }

    private var projectVisitsKey: String { "riffet.project-visits|\(baseURL.absoluteString)" }
    private var projectVisits: [String: Double] = [:]

    private func visitProject(_ id: String) {
        guard project(id)?.isSystemProject == false else { return }
        // Other conversation windows share these preferences with the main window.
        projectVisits.merge(UserDefaults.standard.dictionary(forKey: projectVisitsKey) as? [String: Double] ?? [:], uniquingKeysWith: max)
        projectVisits[id] = Date.now.timeIntervalSince1970
        UserDefaults.standard.set(projectVisits, forKey: projectVisitsKey)
    }

    /// Directory selection ignores sidebar grouping and pinning. Worktrees participate on their own.
    var projectsByRecentUse: [Project] {
        var activity = projectVisits
        for session in list.sessions {
            let at = ServerTime.date(session.lastActivityAt ?? session.createdAt)?.timeIntervalSince1970 ?? 0
            activity[session.projectId] = max(activity[session.projectId] ?? 0, at)
        }
        return projects.sorted { a, b in
            let left = activity[a.id] ?? ServerTime.date(a.createdAt)?.timeIntervalSince1970 ?? 0
            let right = activity[b.id] ?? ServerTime.date(b.createdAt)?.timeIntervalSince1970 ?? 0
            return left == right ? a.id < b.id : left > right
        }
    }

    var recentProjectId: String? { projectsByRecentUse.first?.id }
    /// The task target stays independent of the chat tab and of activity arriving in other projects.
    var homeTaskProjectId: String? {
        if let current = homeProjectId, project(current)?.isSystemProject == false { return current }
        if let homeTaskSelection, homeTaskSelection != "__projectless__", projects.contains(where: { $0.id == homeTaskSelection }) { return homeTaskSelection }
        return supportsProjectlessTasks || !serverFeaturesLoaded ? nil : recentProjectId
    }

    var homeDraftKey: String { "new-session|\(baseURL.absoluteString)" }

    /// Full selectors retain effort and other parameters, scoped to the same agent/provider.
    func recentModel(agent: String, profileId: String?) -> String? {
        let defaultProfile = backends.first { $0.agent == agent }?.profiles.first { $0.isDefault?.boolValue == true }?.id ?? "default"
        return list.sessions.filter {
            $0.agentID == agent && ($0.backendProfileId ?? defaultProfile) == (profileId ?? defaultProfile) && $0.model?.isEmpty == false
        }.max {
            (ServerTime.date($0.lastActivityAt ?? $0.createdAt) ?? .distantPast) < (ServerTime.date($1.lastActivityAt ?? $1.createdAt) ?? .distantPast)
        }?.model
    }

    func defaultChatModel(_ catalog: NativeBackendCatalogEntry?) -> String? {
        let models = catalog?.models ?? []
        let configured = settings?.auxiliaryModels?.chat.map { "\(backendWire($0.backendId)):\($0.profileId):\($0.model)" }
        let chats = list.sessions.filter { $0.agentID == AgentDirectory.quickChat && $0.projectId == quickChatProject?.id && $0.model?.isEmpty == false }
        let preferred = configured.map { resolveModelSelection(catalog: models, selection: $0).model }
        let validPreferred = preferred.flatMap { value in models.isEmpty || models.contains { $0.value == value } ? value : nil }
        let latest = chats.filter { session in
            let value = resolveModelSelection(catalog: models, selection: session.model).model
            return validPreferred.map { $0 == value } ?? (models.isEmpty || models.contains { $0.value == value })
        }.max {
            (ServerTime.date($0.lastActivityAt ?? $0.createdAt) ?? .distantPast) < (ServerTime.date($1.lastActivityAt ?? $1.createdAt) ?? .distantPast)
        }
        guard let selection = latest?.model ?? validPreferred ?? catalog?.defaultModel else { return nil }
        let resolved = resolveModelSelection(catalog: models, selection: selection)
        return catalogSelection(catalog: models, model: resolved.model, overrides: resolved.params, preferredParam: nil)
    }

    func refresh() {
        listStore.refresh()
        host.poke()
    }

    // MARK: Conversation terminal

    /// ⌘F: opens find in the shown conversation, or moves to its field when already open.
    func openFind() {
        guard selected != nil, page == nil, !showingHome else { return }
        if find?.open != true {
            findReturn = NSApp.keyWindow?.firstResponder
            store.find.open(readingPos: nil)
        }
        findFocus += 1
    }

    func setFind(query: String) { store.find.setQueryFrom(query: query, readingKey: readingKey()) }
    func findNext() { if find?.open == true { store.find.next() } }
    func findPrevious() { if find?.open == true { store.find.previous() } }
    func closeFind() {
        store.find.close()
        guard let window = NSApp.keyWindow else { return }
        if let back = findReturn as? NSView, back.window === window { window.makeFirstResponder(back); return }
        func composer(_ view: NSView) -> NSView? {
            if view is SubmitTextView { return view }
            for sub in view.subviews { if let found = composer(sub) { return found } }
            return nil
        }
        if let field = window.contentView.flatMap(composer) { window.makeFirstResponder(field) }
    }

    func toggleTerminalPage() {
        guard !showingHome, page == nil, let selected,
              ConversationState(workbench: self, session: selected, catalog: catalogs.cached(for: selected)).supportsTerminal else { return }
        showsTerminalPage.toggle()
    }

    // MARK: Writes

    func toggleCanvasPage() {
        guard !showingHome, page == nil, selected != nil, canvasAvailable else { return }
        showsCanvasPage.toggle()
    }

    @discardableResult
    func send(_ text: String, attachments: [Attachment], interrupt: Bool = false, enqueue: Bool = false, onStored: (() -> Void)? = nil) async -> Bool {
        do {
            let projectId = selected?.projectId
            let sessionId = selected?.id
            let cited = selected?.backendId == .chat || referencesProjectId != projectId ? [] : references
            let transfer: (() -> Void)? = onStored.map { callback in { [self] in
                clearSubmittedReferences(cited, sessionId: sessionId, projectId: projectId)
                callback()
            } }
            let sent = try await (enqueue ? store.enqueue(text: text, attachments: attachments, context: cited, onStored: transfer) : store.send(text: text, attachments: attachments, context: cited, interrupt: interrupt, onStored: transfer)).boolValue
            if sent, onStored == nil { clearSubmittedReferences(cited, sessionId: sessionId, projectId: projectId) }
            if sent, let sessionId { SessionTabs.model(for: baseURL).sent(sessionId) }
            return sent
        } catch {
            return false
        }
    }

    @discardableResult
    func steer(_ text: String, attachments: [Attachment], target: NativeTurnTarget) async -> Bool {
        do {
            let projectId = selected?.projectId
            let sessionId = selected?.id
            let cited = selected?.backendId == .chat || referencesProjectId != projectId ? [] : references
            let sent = try await store.steer(text: text, attachments: attachments, context: cited, target: target).boolValue
            if sent { clearSubmittedReferences(cited, sessionId: sessionId, projectId: projectId) }
            return sent
        } catch { return false }
    }

    /// Schedules the message, with its attachments and the cited references, as a later turn of the open conversation.
    struct SendLaterError: LocalizedError {
        static let notConnected = SendLaterError()
        var errorDescription: String? { String(localized: "尚未连接") }
    }

    /// [id] is made once per attempt so a retry is the same request.
    func sendLater(_ text: String, attachments: [Attachment], at date: Date, id: String) async throws {
        guard let api = host.api, let session = selected else { throw SendLaterError.notConnected }
        let cited = session.backendId == .chat || referencesProjectId != session.projectId ? [] : references
        _ = try await api.createFollowUp(sessionId: session.id, prompt: text, at: TimePreset.iso(date), timeZone: TimeZone.current.identifier, attachments: attachments, context: cited, id: id)
        clearSubmittedReferences(cited, sessionId: session.id, projectId: session.projectId)
    }

    /// Starts the CLI again for a conversation whose process is gone (`POST /api/sessions/:id/start`).
    func reopen(_ session: Session, restartBinding: SessionNativeRuntime? = nil) async -> String? {
        guard let api = host.api, !reopeningSessionIds.contains(session.id) else { return nil }
        let opened = store.openSession.value
        guard opened.sessionId == session.id else { return nil }
        let epoch = opened.epoch
        if selected?.id == session.id { recoveryError = nil }
        reopeningSessionIds.insert(session.id)
        defer { reopeningSessionIds.remove(session.id) }
        do {
            let result = if let restartBinding {
                try await api.restartSession(id: session.id, fingerprint: restartBinding.fingerprint, address: restartBinding.address)
            } else {
                try await api.startSession(id: session.id)
            }
            if let updated = result.session { store.applySession(session: updated) }
            let current = store.openSession.value
            if current.epoch == epoch, current.sessionId == session.id { store.retry() }
            return nil
        } catch {
            let message = error.riffetMessage
            let current = store.openSession.value
            if current.epoch == epoch, current.sessionId == session.id, current.status == nil || current.status?.phase == .offline {
                recoveryError = SessionNotice(sessionId: session.id, text: message)
            }
            return message
        }
    }

    /// Keeps the Mac awake while an agent works, like the web's Wake Lock.
    private func holdWake(_ working: Bool) {
        if working, wakeActivity == nil {
            wakeActivity = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled, .userInitiatedAllowingIdleSystemSleep], reason: "Agent 正在工作") // i18n-ignore: power assertion reason, not interface text
        } else if !working, let activity = wakeActivity {
            ProcessInfo.processInfo.endActivity(activity)
            wakeActivity = nil
        }
    }

    // MARK: References and previews

    private struct SavedPromptReference: Codable {
        var path: String
        var line: Int64?
        var kind: String?
        var sessionId: String?
        var fromRunId: String?
        var title: String?
        init(_ reference: PromptContextReference) {
            path = reference.path; line = reference.line?.int64Value; kind = reference.kind
            sessionId = reference.sessionId; fromRunId = reference.fromRunId; title = reference.title
        }
        var value: PromptContextReference {
            PromptContextReference(path: path, line: line.map(KotlinLong.init(value:)), kind: kind, sessionId: sessionId, fromRunId: fromRunId, title: title)
        }
    }

    private struct SavedPromptReferences: Codable {
        var projectId: String?
        var references: [SavedPromptReference]
    }

    private var referencesStorageKey: String {
        referencesStorageKey(sessionId: referencesSessionId)
    }

    private func referencesStorageKey(sessionId: String?) -> String {
        "riffet.references|\(baseURL.absoluteString)|\(sessionId ?? "home")"
    }

    private func clearSubmittedReferences(_ cited: [PromptContextReference], sessions: [SessionReferenceInput] = [], sessionId: String?, projectId: String?) {
        let matches: (PromptContextReference) -> Bool = { ref in
            cited.contains(ref) || (ref.kind == "session" && sessions.contains { $0.sessionId == ref.sessionId && $0.fromRunId == ref.fromRunId })
        }
        if referencesSessionId == sessionId {
            references.removeAll { ($0.kind == "session" || referencesProjectId == projectId) && matches($0) }
        } else {
            let key = referencesStorageKey(sessionId: sessionId)
            guard let data = UserDefaults.standard.data(forKey: key),
                  var saved = try? JSONDecoder().decode(SavedPromptReferences.self, from: data) else { return }
            let sameProject = saved.projectId == projectId
            saved.references.removeAll { ($0.kind == "session" || sameProject) && matches($0.value) }
            if let data = try? JSONEncoder().encode(saved) { UserDefaults.standard.set(data, forKey: key) }
        }
    }

    private func saveReferences() {
        guard let data = try? JSONEncoder().encode(SavedPromptReferences(projectId: referencesProjectId, references: references.map(SavedPromptReference.init))) else { return }
        UserDefaults.standard.set(data, forKey: referencesStorageKey)
    }

    private func loadReferences(sessionId: String?, projectId: String?) {
        referencesSessionId = sessionId
        referencesProjectId = projectId
        let saved = UserDefaults.standard.data(forKey: referencesStorageKey)
            .flatMap { try? JSONDecoder().decode(SavedPromptReferences.self, from: $0) }
        references = saved?.references.map(\.value).filter { $0.kind == "session" || saved?.projectId == projectId } ?? []
    }

    func addReference(path: String, line: Int? = nil) {
        guard let projectId = currentProjectId else { return }
        if referencesProjectId != projectId { references = []; referencesProjectId = projectId }
        guard references.count < 20, !references.contains(where: { $0.path == path && $0.line?.intValue == line }) else { return }
        references.append(PromptContextReference(path: path, line: line.map { KotlinLong(value: Int64($0)) }, kind: nil, sessionId: nil, fromRunId: nil, title: nil))
    }

    func addSessionReference(_ session: Session) {
        let projectId = showingHome ? homeProjectId : selected?.projectId
        if referencesProjectId != projectId { references = []; referencesProjectId = projectId }
        guard references.filter({ $0.kind == "session" }).count < 5,
              !references.contains(where: { $0.sessionId == session.id }) else { return }
        references.append(sessionReference(session: session))
    }

    func removeReference(_ reference: PromptContextReference) {
        references.removeAll { $0 == reference }
    }

    /// Opens [path] in the file panel, showing the panel first.
    func preview(path: String, line: Int? = nil) {
        previewTarget = PreviewTarget(path: path, line: line, token: (previewTarget?.token ?? 0) + 1, at: .now)
        showInspector(.files)
    }

    func interrupt() async {
        _ = try? await store.interrupt()
    }

    /// Asks the server to stop a background task. The store marks it stopping at once and takes the mark
    /// back if the request fails; the server's later state is what the row finally shows.
    func stop(activity id: String) async -> Bool {
        (try? await store.stopActivity(activityId: id))?.boolValue ?? false
    }

    func text(of blobRef: String) async -> String? {
        try? await store.activityText(blobRef: blobRef)
    }

    func respond(_ response: NativeInteractionResponse) async -> String? {
        do {
            let result = try await store.respondInteraction(response: response)
            return result.status == .uncertain ? (result.message ?? String(localized: "结果未确认")) : nil
        } catch {
            return error.riffetMessage
        }
    }

    func sendQueuedNow(_ run: Run) async { _ = try? await store.sendQueuedNow(run: run) }
    func cancelRun(_ run: Run) async { _ = try? await store.cancelRun(run: run) }
    func retryRun(_ run: Run) async { _ = try? await store.retryRun(run: run) }
    func checkRun(_ run: Run) async {
        guard let result = try? await store.checkRun(run: run), result.canContinue else { return }
        let count = result.queuedRunIds.count
        let title = count == 0 ? String(localized: "继续对话") : String(localized: "继续发送 \(count) 条消息")
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = String(localized: "上一条消息是否已执行仍无法确认")
        alert.addButton(withTitle: title)
        alert.addButton(withTitle: String(localized: "取消"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        _ = try? await store.continueRun(run: result.run, queuedRunIds: result.queuedRunIds)
    }

    func takeBack(_ run: Run) async -> QueuedDraft? {
        guard let draft = try? await store.takeBackQueued(run: run) else { return nil }
        if referencesSessionId == run.sessionId {
            references = mergeRestoredReferences(current: references, restored: draft.context)
        } else {
            let key = referencesStorageKey(sessionId: run.sessionId)
            let saved = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(SavedPromptReferences.self, from: $0) }
            let merged = mergeRestoredReferences(current: saved?.references.map(\.value) ?? [], restored: draft.context)
            let next = SavedPromptReferences(projectId: saved?.projectId ?? list.sessions.first { $0.id == run.sessionId }?.projectId, references: merged.map(SavedPromptReference.init))
            if let data = try? JSONEncoder().encode(next) { UserDefaults.standard.set(data, forKey: key) }
        }
        return draft
    }

    func upload(_ file: PickedFile, projectId: String?) async throws -> Attachment {
        if let projectId {
            return try await store.uploadAttachment(picked: file, projectId: projectId)
        }
        return try await store.uploadAttachment(picked: file)
    }

    /// The quick-chat overlay keeps its existing creation path; Home uses the durable outbox below.
    func createSession(projectId: String, prompt: String, attachments: [Attachment], agent: String, profileId: String?, model: String?, mode: String?, approval: String?) async throws -> Session {
        let cited = agent == AgentDirectory.quickChat || referencesProjectId != projectId ? [] : references
        let referenceSessionId = referencesSessionId
        let intent = navigationIntent
        let revision = defaultsRevision
        let session = try await store.createSession(
            projectId: projectId, prompt: prompt, attachments: attachments, backendId: nil,
            backendProfileId: profileId, model: model, mode: mode, approval: approval, context: cited, agentId: agent
        )
        clearSubmittedReferences(cited, sessionId: referenceSessionId, projectId: projectId)
        SessionTabs.model(for: baseURL).launched(session.id)
        if navigationIntent == intent { open(session) }
        if agent != AgentDirectory.quickChat, defaultsRevision == revision, let accepted = session.model ?? model {
            Task {
                guard defaultsRevision == revision else { return }
                await rememberDefaults(agent: agent, profileId: session.backendProfileId ?? profileId, model: accepted)
            }
        }
        return session
    }

    /// The shared outbox owns the frozen request; success may navigate only while its page is still open.
    func createPreparedSession(_ request: PendingSessionCreation, intent: Int, rememberSelection: Bool) async throws -> Session {
        let revision = defaultsRevision
        let session = try await store.createPreparedSession(request: request)
        let body = request.body
        let cited = body.initialMessage?.context ?? []
        let sessions = body.initialMessage?.references ?? []
        clearSubmittedReferences(cited, sessions: sessions, sessionId: nil, projectId: body.projectId)
        SessionTabs.model(for: baseURL).launched(session.id)
        if navigationIntent == intent { open(session) }
        if rememberSelection, let agent = body.agentId ?? body.backendId.map(backendWire), agent != AgentDirectory.quickChat, defaultsRevision == revision, let accepted = session.model ?? body.model {
            Task {
                guard defaultsRevision == revision else { return }
                await rememberDefaults(agent: agent, profileId: session.backendProfileId ?? body.backendProfileId, model: accepted)
            }
        }
        return session
    }

    func promoteProject(_ project: Project, name: String) async throws {
        guard host.api != nil else { throw SettingsFailure(String(localized: "尚未连接服务器")) }
        _ = try await store.promoteProject(id: project.id, name: name)
        refresh()
    }

    func update(_ session: Session, title: String? = nil, tags: [String]? = nil, archived: Bool? = nil, pinned: Bool? = nil, toolGroups: [String]? = nil, extensionsOff: [String]? = nil) async {
        let body = SessionUpdate(title: title, tags: tags, archived: archived.map { KotlinBoolean(bool: $0) }, pinned: pinned.map { KotlinBoolean(bool: $0) }, toolGroups: toolGroups, extensionsOff: extensionsOff)
        let updated = try? await store.updateSession(id: session.id, body: body)
        // The window's own store has the answer; the main list follows its next poll unless told now.
        if role == .window, let updated { listStore.applySession(session: updated) }
        if archived == true, role == .main, selected?.id == session.id { showHome(projectId: session.projectId) }
    }

    // MARK: Terminal conversations (docs/TERMINAL-SESSIONS.md)

    /// Binds the provider conversation to a Riffet one through the main store, which folds it into the list.
    func importExternalSession(_ item: ExternalSession) async throws -> ExternalSessionImport {
        let result = try await listStore.importExternalSession(backendId: item.backendId, backendProfileId: item.backendProfileId, nativeSessionId: item.nativeSessionId)
        if role == .window { store.applySession(session: result.session) }
        return result
    }

    /// Takes a terminal hold back; 409 `TERMINAL_STILL_RUNNING` unless [force].
    func releaseTerminalHold(_ session: Session, force: Bool) async throws {
        let released = try await listStore.releaseTerminalHold(id: session.id, force: force)
        if role == .window { store.applySession(session: released) }
    }

    // MARK: Deleting a conversation

    func requestDeletion(_ session: Session) async {
        guard deletionLoading == nil else { return }
        deletionLoading = session.id
        defer { deletionLoading = nil }
        do {
            let preview = try await listStore.deletionPreview(id: session.id)
            if let blocker = preview.blocker { deletionError = blocker.text }
            else { deletion = SessionDeletion(session: session, preview: preview) }
        } catch {
            if let http = (error as NSError).userInfo["KotlinException"] as? RiffetHttpException, http.status == 410, http.code == "SESSION_DELETED" {
                sessionsRemoved([session.id])
            } else {
                deletionError = error.riffetMessage
            }
        }
    }

    func confirmDeletion(_ request: SessionDeletion) async {
        guard !request.submitting else { return }
        request.submitting = true
        request.error = nil
        defer { request.submitting = false }
        do {
            _ = try await listStore.deleteSession(id: request.session.id, sessionIds: request.preview.sessionIds)
            if deletion === request { deletion = nil }
        } catch {
            let code = ((error as NSError).userInfo["KotlinException"] as? RiffetHttpException)?.code
            if code == "SESSION_DELETE_SCOPE_CHANGED", let fresh = try? await listStore.deletionPreview(id: request.session.id) {
                if let blocker = fresh.blocker { request.error = blocker.text }
                else { request.preview = fresh }
                return
            }
            request.error = error.riffetMessage
        }
    }

    /// Deleted here or on another device: the page, or the window, that shows one of them goes.
    private func sessionsRemoved(_ ids: [String]) {
        let gone = Set(ids)
        if deletion.map({ gone.contains($0.session.id) }) == true { deletion = nil }
        for id in gone { pageModels.sessionComposers.discard("session.\(id)") }
        if role == .main, let remembered = UserDefaults.standard.string(forKey: lastSessionKey), gone.contains(remembered) {
            UserDefaults.standard.set("home", forKey: lastSessionKey)
        }
        let shownId = selected?.id ?? lastShown?.id
        guard let shownId, gone.contains(shownId), selected == nil || gone.contains(selected?.id ?? "") else { return }
        switch role {
        case .main:
            // An attempt-group view only leaves when it showed the deleted conversation.
            if attemptGroupSelection == nil, !showingHome || page != nil {
                showHome(projectId: lastShown?.projectId)
            }
        case .window:
            WorkbenchWindows.window(of: self)?.close()
        }
    }

    func openDirectory(_ path: String) async throws -> Project {
        let project = try await store.openDirectory(path: path)
        homeProjectId = project.id
        return project
    }

    func loadOlder() { store.loadOlder() }

    // MARK: Owner (个人资料)

    /// A failed read keeps the last answer. A full read is the server's word, even with a lower revision (a restored
    /// backup, a fresh state directory).
    func refreshOwner() async {
        guard let api = host.api, let info = try? await api.owner() else { return }
        if info != owner { owner = info }
    }

    func setOwnerName(_ name: String) async throws {
        guard let api = host.api else { throw SettingsFailure(String(localized: "尚未连接服务器")) }
        applyOwner(try await api.updateOwnerName(name: name))
    }

    func setOwnerAvatar(_ bytes: Data, type: String) async throws {
        guard let api = host.api else { throw SettingsFailure(String(localized: "尚未连接服务器")) }
        applyOwner(try await api.uploadOwnerAvatar(bytes: byteArrayFromData(data: bytes), type: type))
    }

    /// The avatar styles the enabled plugins offer; a failed read gives none.
    func ownerAvatarStyles() async -> [OwnerAvatarStyle] {
        guard let api = host.api else { return [] }
        return (try? await api.ownerAvatarStyles()) ?? []
    }

    /// [ink] and [paper] are `#rrggbb` from the current theme.
    func generateOwnerAvatar(style: String, seed: String, ink: String, paper: String) async throws {
        guard let api = host.api else { throw SettingsFailure(String(localized: "尚未连接服务器")) }
        applyOwner(try await api.generateOwnerAvatar(style: style, seed: seed, ink: ink, paper: paper))
    }

    func ownerAvatarPreviewUrl(style: String, seed: String, ink: String, paper: String) -> String? {
        host.api?.ownerAvatarPreviewUrl(style: style, seed: seed, ink: ink, paper: paper)
    }

    func removeOwnerAvatar() async throws {
        guard let api = host.api else { throw SettingsFailure(String(localized: "尚未连接服务器")) }
        applyOwner(try await api.removeOwnerAvatar())
    }

    func restoreOwnerAvatar(sha256: String) async throws {
        guard let api = host.api else { throw SettingsFailure(String(localized: "尚未连接服务器")) }
        applyOwner(try await api.restoreOwnerAvatar(sha256: sha256))
    }

    func deleteOwnerAvatarHistory(sha256: String) async throws {
        guard let api = host.api else { throw SettingsFailure(String(localized: "尚未连接服务器")) }
        applyOwner(try await api.deleteOwnerAvatarHistory(sha256: sha256))
    }

    /// A history picture's absolute URL, loaded through `ImageLoader` like the current one.
    func ownerAvatarUrl(_ avatar: RiffetKit.OwnerAvatar) -> String? {
        host.api?.ownerAvatarUrl(avatar: avatar)
    }

    /// A read that started before a newer change must not overwrite it.
    private func applyOwner(_ info: OwnerInfo) {
        if let current = owner, current.revision > info.revision { return }
        if info != owner { owner = info }
    }

    // MARK: Backends and models

    func loadBackends() async {
        guard let api = host.api else { return }
        if let health = try? await api.health() {
            supportsProjectlessTasks = health.protocol?.features.contains("projectless-tasks") == true
            serverFeaturesLoaded = true
        }
        // Written only when they changed: settings re-read them often, and every page follows them.
        let backends = (try? await api.backends()) ?? []
        if backends != self.backends { self.backends = backends }
        AgentDirectory.shared.update(backends: backends)
    }

    private func noteProjectTypes(_ projectId: String) {
        if projectTypesRevision != PluginsStore.shared.revision {
            projectTypesRevision = PluginsStore.shared.revision
            projectTypesRead.removeAll()
        }
        if let read = projectTypesRead[projectId], Date().timeIntervalSince(read) < 60 { return }
        guard projectTypesLoading.insert(projectId).inserted else { return }
        Task { [weak self] in await self?.loadProjectTypes(projectId) }
    }

    /// A failed read keeps the last answer; the next view list asks again after a minute.
    private func loadProjectTypes(_ projectId: String) async {
        defer { projectTypesLoading.remove(projectId) }
        projectTypesRead[projectId] = Date()
        guard let api = host.api, let response = try? await api.taskActions(projectId: projectId) else { return }
        let types = Set(response.projectTypes)
        if projectTypes[projectId] != types { projectTypes[projectId] = types }
    }

    /// Tags in use on conversations that are not archived, for the filter and the tag editor.
    var sessionTags: [String] {
        Array(Set(list.sessions.filter { $0.archivedAt == nil }.flatMap(\.tags))).sorted()
    }

    /// What the sidebar warns about: the default agent is unavailable, or not signed in.
    var backendNotice: (label: String, detail: String?)? {
        guard let entry = defaultBackend else { return nil }
        if entry.needsLogin?.boolValue == true { return (String(localized: "\(entry.label) 未登录"), entry.reason) }
        return entry.available ? nil : (String(localized: "\(entry.label) 不可用"), entry.reason)
    }

    /// The Agent a session started without a choice runs on.
    var newSessionAgent: String? { defaultBackend?.agent }

    /// The catalog entry new sessions start on: the saved default, else the first Agent that is available.
    var defaultBackend: NativeBackendCatalogEntry? {
        let pickable = backends.filter(\.isPickable)
        return pickable.first { $0.agent == settings?.defaultAgent } ?? pickable.first { $0.available } ?? pickable.first
    }

    /// The session's provider no longer exists (removed, or never present on this host): the
    /// history stays readable and the conversation can be handed off, but nothing can run on a
    /// profile that is not there. Unknown backends say nothing — absence of evidence is not
    /// evidence of removal.
    func providerMissing(for session: Session) -> Bool {
        guard let profileId = session.backendProfileId,
              let entry = backends.first(where: { $0.agent == session.agentID }) else { return false }
        return !entry.profiles.contains { $0.id == profileId }
    }

    func updateProject(_ project: Project, name: String? = nil, tags: [String]? = nil, archived: Bool? = nil) async -> String? {
        do {
            _ = try await host.api?.updateProject(id: project.id, name: name, tags: tags, archived: archived.map { KotlinBoolean(bool: $0) })
            listStore.refresh()
            return nil
        } catch {
            return error.riffetMessage
        }
    }

    func deleteProject(_ project: Project) async -> String? {
        do {
            try await host.api?.deleteProject(id: project.id)
            if homeProjectId == project.id { homeProjectId = nil }
            if selected?.projectId == project.id { showHome() }
            listStore.refresh()
            return nil
        } catch {
            return error.riffetMessage
        }
    }

    private var runtimeActionPendingSession: String?
    var runtimeActionPending: Bool { runtimeActionPendingSession != nil && runtimeActionPendingSession == selected?.id }

    /// What the session's plugin shows beside its status; the plugin decides visibility and wording.
    var runtimeControl: NativeRuntimeControl? {
        guard connection is RiffetConnectionStateLive, let session = selected, session.archivedAt == nil else { return nil }
        return status?.runtimeControl
    }

    func runRuntimeAction(_ action: NativeRuntimeAction, for sessionId: String) async {
        guard selected?.id == sessionId, let control = runtimeControl, !runtimeActionPending, let api = host.api else { return }
        let request = RequestContext { self.selected?.id }
        runtimeActionPendingSession = sessionId
        defer { if runtimeActionPendingSession == sessionId { runtimeActionPendingSession = nil } }
        do {
            try await api.nativeRuntimeAction(id: sessionId, action: action.id, revision: control.revision)
            guard request.isCurrent else { return }
            configurationError = nil
        } catch {
            guard request.isCurrent else { return }
            configurationError = error.riffetMessage
        }
    }

    func setModel(_ model: String, for sessionId: String) async {
        guard let session = selected, session.id == sessionId, let api = host.api else { return }
        let request = RequestContext { self.selected?.id }
        do {
            let updated = try await api.nativeSetModel(id: session.id, model: model)
            guard request.isCurrent else { return }
            configurationError = nil
            store.applySession(session: updated)
            // A quick chat's model belongs to that conversation; its default lives in settings.
            if session.agentID != AgentDirectory.quickChat {
                // The native selection already succeeded; remembering defaults is a separate action.
                await rememberDefaults(agent: session.agentID, profileId: session.backendProfileId, model: updated.model ?? model)
            }
        } catch {
            guard request.isCurrent else { return }
            configurationError = String(localized: "模型设置失败：\(error.riffetMessage)")
        }
    }

    /// Continues the open conversation on another provider with one of its models.
    func switchProfile(_ profileId: String, model: String, for sessionId: String) async {
        guard let session = selected, session.id == sessionId, let api = host.api else { return }
        let request = RequestContext { self.selected?.id }
        do {
            let updated = try await api.nativeSwitchProfile(id: session.id, backendProfileId: profileId, model: model)
            guard request.isCurrent else { return }
            // Read the new provider's catalogs before the session moves, so the chip does not blink out.
            _ = try? await catalogs.loadCatalog(updated.agentID, profileId: updated.backendProfileId, projectId: updated.projectId)
            await catalogs.loadSessionCatalog(for: updated)
            guard request.isCurrent else { return }
            configurationError = nil
            store.applySession(session: updated)
        } catch {
            guard request.isCurrent else { return }
            configurationError = String(localized: "模型设置失败：\(error.riffetMessage)")
        }
    }

    func rememberDefaults(agent: String, profileId: String? = nil, model: String? = nil, makeDefault: Bool = false) async {
        try? await saveDefaults(agent: agent, profileId: profileId, model: model, makeDefault: makeDefault)
    }

    @ObservationIgnored private var defaultsRevision = 0
    @ObservationIgnored private var defaultsSave: Task<Void, Error>?

    func saveDefaults(agent: String, profileId: String? = nil, model: String? = nil, makeDefault: Bool = false) async throws {
        guard agent != AgentDirectory.quickChat else { return }
        if role == .window, let main = AppModel.shared.workbench, main !== self, main.baseURL == baseURL {
            try await main.saveDefaults(agent: agent, profileId: profileId, model: model, makeDefault: makeDefault)
            return
        }
        defaultsRevision += 1
        let revision = defaultsRevision
        let predecessor = defaultsSave
        let task = Task { @MainActor in
            _ = try? await predecessor?.value
            try await self.writeDefaults(agent: agent, profileId: profileId, model: model, makeDefault: makeDefault)
        }
        defaultsSave = task
        defer { if defaultsRevision == revision { defaultsSave = nil } }
        try await task.value
    }

    private func writeDefaults(agent: String, profileId: String?, model: String?, makeDefault: Bool) async throws {
        var map = agentDefaults(from: store.list.value.settings)
        let previous = map[agent]
        let nextModel: String?
        if let model {
            nextModel = model.isEmpty ? nil : model
        } else {
            nextModel = previous?.model
        }
        map[agent] = NativeBackendDefaults(
            profileId: profileId ?? previous?.profileId,
            model: nextModel,
            mode: previous?.mode,
            approval: previous?.approval
        )
        let patch = SettingsPatch.make(
            defaultAgentId: makeDefault ? agent : nil,
            agentDefaults: map
        )
        try await SettingsStore.save(self, patch)
        // The save is applied to this workbench's own store; a window reads settings from the main one.
        if role == .window { listStore.refresh() }
    }

    func setApproval(_ approval: String, for sessionId: String) async {
        guard let session = selected, session.id == sessionId, let api = host.api else { return }
        let request = RequestContext { self.selected?.id }
        do {
            let updated = try await api.nativeSetApproval(id: session.id, approval: approval)
            guard request.isCurrent else { return }
            configurationError = nil
            store.applySession(session: updated)
        } catch {
            guard request.isCurrent else { return }
            configurationError = String(localized: "审批设置失败：\(error.riffetMessage)")
        }
    }
}

extension Project {
    /// The server-owned quick-chat project, marked by the contract's `system` field.
    var isBuiltInQuickChat: Bool { system == "quick-chat" }
    var isTaskWorkspace: Bool { system == "task-workspace" }
    var isSystemProject: Bool { isBuiltInQuickChat || isTaskWorkspace }
}

/// What an async request was started for. Its result is dropped once the task is cancelled or
/// any part of that context has moved on: another conversation, a reconnect, new backends.
@MainActor
struct RequestContext {
    private let unchanged: @MainActor () -> Bool

    init<Key: Equatable>(_ key: @escaping @MainActor () -> Key) {
        let start = key()
        unchanged = { key() == start }
    }

    var isCurrent: Bool { !Task.isCancelled && unchanged() }
}

struct PreviewTarget: Equatable {
    let path: String
    let line: Int?
    let token: Int
    let at: Date
}

extension SessionState {
    var isActive: Bool { self == .starting || self == .running || self == .waiting || self == .cancelling }
}

/// A file picked, dropped or pasted into a composer, ready for upload.
final class PickedFile: NSObject, UploadableAttachment {
    let name: String
    let mimeType: String
    let bytes: KotlinByteArray
    /// The same bytes, for the image viewer to open before the upload finishes.
    let data: Data
    let width: KotlinInt?
    let height: KotlinInt?
    let preview: NSImage?

    /// The picked bytes' digest, kept after they are released so the same file dropped again
    /// still counts once.
    let digest: SHA256Digest?

    init(name: String, mimeType: String, data: Data, width: Int?, height: Int?, preview: NSImage?) {
        self.name = name
        self.mimeType = mimeType
        self.data = data
        self.bytes = byteArrayFromData(data: data)
        self.width = width.map { KotlinInt(int: Int32($0)) }
        self.height = height.map { KotlinInt(int: Int32($0)) }
        self.preview = preview
        digest = data.isEmpty ? nil : SHA256.hash(data: data)
    }

    private init(releasing file: PickedFile) {
        name = file.name
        mimeType = file.mimeType
        data = Data()
        bytes = byteArrayFromData(data: Data())
        width = file.width
        height = file.height
        preview = file.preview
        digest = file.digest
    }

    /// The same file without its bytes, once the server has them.
    func withoutBytes() -> PickedFile { PickedFile(releasing: self) }

    func sameContent(as other: PickedFile) -> Bool {
        guard let digest, let otherDigest = other.digest else { return false }
        return digest == otherDigest
    }
}

/// What the docks above the composer and the toolbar's activity summary show for one conversation.
private struct SessionDocks {
    var todos: [TodoEntry] = []
    var goal: SessionGoal?
    var jobs: [NativeJob] = []
    var subagents: [SubagentEntry] = []
    var outputs: [SessionOutput] = []
    var backgroundSubagents = 0
    var dock = ActivityDock(compacting: false, background: 0, tasks: [])
    var stopping: Set<String> = []
}

private extension SessionDocks {
    init(_ presentation: TimelinePresentation) {
        self.init(
            todos: presentation.todos, goal: presentation.goal, jobs: presentation.jobs, subagents: presentation.subagents, outputs: presentation.outputs,
            backgroundSubagents: Int(presentation.backgroundSubagents), dock: presentation.dock, stopping: presentation.stoppingActivities
        )
    }
}
