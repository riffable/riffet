import AppKit
import Foundation
import RiffetKit

extension Notification.Name {
    /// The interface style changed; the sidebars regroup for the arrangement it brings.
    static let riffetInterfaceStyleChanged = Notification.Name("riffet.interface-style-changed")
}

/// The sidebar of a workbench: its rows (grouped by Kotlin's `visibleGroups` / `timeBuckets`), the
/// reader's filters remembered in `UserDefaults`, and the message search merged from this Mac's
/// cached transcripts and the server's index.
@MainActor
@Observable
final class WorkbenchSidebar {
    /// The workbench it belongs to, set once by it: the list, the open conversation and the store.
    @ObservationIgnored weak var workbench: Workbench?

    /// The sidebar's rows, recomputed only when the list or the reader's filters change.
    private(set) var groups: [ProjectGroup] = []
    private(set) var buckets: [TimeBucket] = []
    /// How the reader arranged the native list and the project tree (`PROJECT` or `TIME`).
    var preferredLayout: String = UserDefaults.standard.string(forKey: "riffet.sidebar-layout") ?? "TIME" {
        didSet { UserDefaults.standard.set(preferredLayout, forKey: "riffet.sidebar-layout"); rebuild() }
    }
    /// How the reader arranged the time-grouped sidebar: by time, as it opens, or by project.
    var timeGroupsLayout: String = UserDefaults.standard.string(forKey: "riffet.sidebar-layout.time-groups") ?? "TIME" {
        didSet { UserDefaults.standard.set(timeGroupsLayout, forKey: "riffet.sidebar-layout.time-groups"); rebuild() }
    }
    /// The arrangement on screen, as the reader picked it for the style's sidebar. Derived from the
    /// style, so it is never stale.
    var layout: String {
        switch DisplayPreferences.shared.style.sidebar {
        case .timeGroups: timeGroupsLayout
        case .projectTree, .systemList: preferredLayout
        }
    }

    /// Picks the arrangement of the sidebar on screen.
    func choose(layout: String) {
        switch DisplayPreferences.shared.style.sidebar {
        case .timeGroups: timeGroupsLayout = layout
        case .projectTree, .systemList: preferredLayout = layout
        }
    }

    /// 按标签页顺序: the pinned conversations in the tab bar's order rather than newest pin first.
    var pinsInTabOrder: Bool = UserDefaults.standard.string(forKey: "riffet.sidebar-sort") == "tabs" {
        didSet { UserDefaults.standard.set(pinsInTabOrder ? "tabs" : nil, forKey: "riffet.sidebar-sort"); rebuild() }
    }

    /// Without tabs there is no tab order to follow.
    var tabsShown: Bool {
        DisplayPreferences.shared.style.header == .sessionTabs && SessionTabsPreferences.shared.style == .titleBar
    }
    var showArchived: Bool = UserDefaults.standard.bool(forKey: "riffet.show-archived") {
        didSet { UserDefaults.standard.set(showArchived, forKey: "riffet.show-archived"); rebuild() }
    }
    /// Only what finished while nobody looked (`isDoneUnseen`), and the conversation on screen.
    var unreadOnly = false {
        didSet { rebuild() }
    }
    /// Only sessions carrying this tag are listed; empty lists everything.
    var tag = "" {
        didSet { rebuild() }
    }
    var query = "" {
        didSet { if query != oldValue { clearMessageHits() } }
    }
    enum SearchMode: Hashable, CaseIterable {
        case title
        case content

        /// The label shown beside the search field, and the value the result cache keys on.
        var rawValue: String {
            switch self {
            case .title: String(localized: "标题")
            case .content: String(localized: "内容")
            }
        }
    }
    var searchMode: SearchMode = .title {
        didSet { if searchMode != oldValue { clearMessageHits() } }
    }
    /// A fixed conversation scope; nil searches every conversation.
    var searchSessionId: String? {
        didSet { if searchSessionId != oldValue { clearMessageHits() } }
    }
    var searchingContent: Bool { searchMode == .content && !searchingCommands && !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// The query starts with `>`: the palette lists commands only.
    var searchingCommands: Bool { query.hasPrefix(">") }
    var searchKey: String { "\(searchMode.rawValue)\u{0}\(searchSessionId ?? "")\u{0}\(query)" }
    /// Projects whose long history the reader unfolded past the first few conversations.
    var expandedProjects: Set<String> = []
    /// How the palette opens: on titles (⌘K), on message content (⇧⌘F), or on commands (⇧⌘P).
    enum SearchOpening: Equatable { case titles, content, commands }
    /// Opens the workbench palette, including while the sidebar is hidden.
    var searchRequested: SearchOpening?
    /// Opens the terminal-session picker, on [projectId]'s conversations or on all of them.
    struct ImportRequest: Equatable { var projectId: String? }
    var importRequested: ImportRequest?
    /// The row tag a click just picked, drawn selected until its page or conversation opens on the next frame.
    var picked: String?

    /// The sidebar's message results: this Mac's cached transcripts and the server's index, merged.
    private var storedMessageHits: [MessageHitRow] = []
    private var resultKey = ""
    var messageHits: [MessageHitRow] { resultKey == searchKey ? storedMessageHits : [] }
    /// The server still has conversations to index; its results may grow while the query stays.
    private var indexPending = false
    var messageSearchPending: Bool { searchingContent && (resultKey != searchKey || indexPending) }
    private(set) var messageSearchError: String?
    @ObservationIgnored private var localHits: [IndexHit] = []
    @ObservationIgnored private var serverHits: [MessageSearchHit] = []
    /// The query [serverHits] answer; hits for another query are not shown.
    @ObservationIgnored private var serverQuery = ""
    @ObservationIgnored private var pending = false

    static let projectLimit = 5

    @ObservationIgnored private var styleObserver: NSObjectProtocol?

    init() {
        // Synchronous, so the first frame of the new style already draws its own grouping.
        styleObserver = NotificationCenter.default.addObserver(forName: .riffetInterfaceStyleChanged, object: nil, queue: nil) { [weak self] _ in
            MainActor.assumeIsolated { self?.rebuild() }
        }
    }

    deinit {
        if let styleObserver { NotificationCenter.default.removeObserver(styleObserver) }
    }

    private var list: SessionListState? { workbench?.list }

    /// Several list frames can land in one turn of the main loop; the sidebar regroups once.
    func schedule() {
        guard !pending else { return }
        pending = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.pending = false
                self.rebuild()
            }
        }
    }

    private func rebuild() {
        guard let list else { return }
        let projects = list.projects.filter { !$0.isBuiltInQuickChat && !$0.isAssistant }
        // Quick chats have their own page and are in no sidebar list.
        let open = workbench?.selected?.id
        let sessions = list.sessions.filter {
            $0.backendId != .chat && (tag.isEmpty || $0.tags.contains(tag)) && (!unreadOnly || $0.id == open || SidebarModelKt.isDoneUnseen(session: $0))
        }
        if layout == "TIME" {
            let dayStart = Int64(Calendar.current.startOfDay(for: .now).timeIntervalSince1970 * 1000)
            buckets = timeBuckets(projects: projects, sessions: sessions, query: "", showArchived: showArchived, dayStartMillis: dayStart)
        } else {
            let groups = visibleGroups(projects: projects, sessions: sessions, query: "", showArchived: showArchived)
            self.groups = tag.isEmpty && !unreadOnly ? groups : groups.filter { !$0.sessions.isEmpty }
        }
        if pinsInTabOrder, tabsShown { orderPinsAsTabs() }
    }

    /// Puts the pinned conversations at the head of each list in the tab bar's pinned order.
    private func orderPinsAsTabs() {
        func ordered(_ sessions: [Session]) -> [Session] {
            let pinned = sessions.prefix { $0.pinnedAt != nil }
            guard pinned.count > 1 else { return sessions }
            return pinned.sorted(by: SessionTabs.pinsBefore) + sessions.dropFirst(pinned.count)
        }
        groups = groups.map { ProjectGroup(project: $0.project, sessions: ordered($0.sessions), forceOpen: $0.forceOpen) }
        buckets = buckets.map { TimeBucket(label: $0.label, sessions: ordered($0.sessions)) }
    }

    /// Draws the row [id] (a conversation, or `page:<name>`) selected at once and opens it on the
    /// next frame: opening holds the main thread for a while, and the click should show first. A
    /// later pick wins.
    func pick(_ id: String, clicked: Bool) {
        picked = id
        AfterNextFrame.run(in: NSApp.keyWindow?.contentView) { [weak self] in
            guard let self, let workbench = self.workbench, self.picked == id else { return }
            self.picked = nil
            if id.hasPrefix("page:") {
                if let page = WorkbenchPage(rawValue: String(id.dropFirst(5))) { workbench.show(page) } else { workbench.page = nil }
                return
            }
            workbench.open(sessionId: id)
            // A click hands the keyboard to the conversation; the composer's own request as it
            // appears can land before the click's tracking ends. Arrow keys stay in the list.
            if clicked {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    NotificationCenter.default.post(name: .riffetFocusComposer, object: workbench)
                }
            }
        }
    }

    /// The rows of the sidebar in the order it shows them.
    var order: [Session] {
        layout == "TIME" ? buckets.flatMap(\.sessions) : groups.flatMap(\.sessions)
    }

    /// The conversations of [group] the sidebar lists: the pinned and active ones and the first few
    /// others, all of them once unfolded, and the open one wherever it is.
    func slice(for group: ProjectGroup) -> (sessions: [Session], hiddenCount: Int, canCollapse: Bool) {
        let all = group.sessions
        let activeOrPinned = all.prefix { $0.pinnedAt != nil || $0.state.isActive }.count
        let limit = max(Self.projectLimit, activeOrPinned)
        if group.forceOpen || all.count <= limit {
            return (all, 0, false)
        }
        if expandedProjects.contains(group.project.id) {
            return (all, 0, true)
        }
        var visible = Array(all.prefix(limit))
        if let workbench, !workbench.showingHome, let selectedId = workbench.selected?.id,
           let selected = all.first(where: { $0.id == selectedId }),
           !visible.contains(where: { $0.id == selected.id }) {
            visible.append(selected)
        }
        return (visible, all.count - visible.count, false)
    }

    // MARK: Time bands

    /// The time-grouped sidebar's bands, which the drawn sidebar folds by their `rawValue`.
    enum TimeBand: String { case pinned, recent, earlier }

    struct TimeSection: Identifiable {
        let band: TimeBand
        let title: String
        let sessions: [Session]
        var id: String { band.rawValue }
    }

    static let collapsedProjectsKey = "riffet.collapsed-projects"
    static let collapsedTimeGroupsKey = "riffet.collapsed-time-groups"
    /// The oldest band shows this many conversations until 显示更多.
    static let earlierLimit = 8
    /// The oldest band is unfolded past its first few conversations.
    var showAllEarlier = false

    /// The layout's buckets in three bands: pinned, recent (active or today) and earlier. A bucket is
    /// one label, so its first conversation says which band it joins.
    var timeSections: [TimeSection] {
        let dayStart = Int64(Calendar.current.startOfDay(for: .now).timeIntervalSince1970 * 1000)
        var pinned: [Session] = [], recent: [Session] = [], earlier: [Session] = []
        for bucket in buckets {
            let sessions = bucket.sessions
            guard let first = sessions.first else { continue }
            if first.pinnedAt != nil {
                pinned += sessions
            } else {
                let key = timeBucketKey(session: first, dayStartMillis: dayStart)
                if key == "sidebar.bucket.active" || key == "sidebar.bucket.today" { recent += sessions } else { earlier += sessions }
            }
        }
        return [
            TimeSection(band: .pinned, title: String(localized: "置顶"), sessions: pinned),
            TimeSection(band: .recent, title: String(localized: "最近"), sessions: recent),
            TimeSection(band: .earlier, title: String(localized: "更早"), sessions: earlier),
        ].filter { !$0.sessions.isEmpty }
    }

    /// What a band lists: a few of the oldest until 显示更多, and the open one wherever it is.
    func shown(_ section: TimeSection) -> (sessions: [Session], more: Bool) {
        guard section.band == .earlier, !showAllEarlier, section.sessions.count > Self.earlierLimit else { return (section.sessions, false) }
        var visible = Array(section.sessions.prefix(Self.earlierLimit))
        if let workbench, !workbench.showingHome, let id = workbench.selected?.id, !visible.contains(where: { $0.id == id }),
           let open = section.sessions.first(where: { $0.id == id }) {
            visible.append(open)
        }
        return (visible, section.sessions.count > visible.count)
    }

    /// The conversations the sidebar shows, top to bottom: folded bands and projects and the hidden
    /// tail of long ones left out.
    var visibleOrder: [Session] {
        if layout == "TIME" {
            guard DisplayPreferences.shared.style.sidebar == .timeGroups else { return buckets.flatMap(\.sessions) }
            let folded = (UserDefaults.standard.string(forKey: Self.collapsedTimeGroupsKey) ?? "").split(separator: ",")
            return timeSections.filter { !folded.contains(Substring($0.id)) }.flatMap { shown($0).sessions }
        }
        let collapsed = (UserDefaults.standard.string(forKey: Self.collapsedProjectsKey) ?? "").split(separator: ",")
        return groups.flatMap { group in
            group.forceOpen || !collapsed.contains(Substring(group.project.id)) ? slice(for: group).sessions : []
        }
    }

    /// The project with the most recent activity: the first group of the sidebar's own ordering.
    var recentProjectId: String? {
        guard let list else { return nil }
        let projects = list.projects.filter { !$0.isBuiltInQuickChat && !$0.isAssistant }
        return (layout == "TIME"
            ? visibleGroups(projects: projects, sessions: list.sessions, query: "", showArchived: false)
            : groups).first?.project.id ?? workbench?.projects.first?.id
    }

    // MARK: Message search

    private func clearMessageHits() {
        localHits = []
        serverHits = []
        serverQuery = ""
        indexPending = false
        messageSearchError = nil
        storedMessageHits = []
        resultKey = ""
    }

    func search(_ query: String) async {
        let key = searchKey
        let sessionId = searchSessionId
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard searchMode == .content, !needle.isEmpty, !searchingCommands else {
            clearMessageHits()
            return
        }
        // The cache answers at once; the server's index follows and adds what was never cached here.
        clearMessageHits()
        let cached = (try? await workbench?.store.searchMessages(query: query, sessionId: sessionId)) ?? []
        guard !Task.isCancelled, searchKey == key else { return }
        localHits = cached
        resultKey = key
        indexPending = true
        mergeMessageHits(for: needle)
        await searchServer(needle, sessionId: sessionId, key: key)
    }

    /// Asks the server, again while it still has conversations to index (each answer indexes a few
    /// more; the cap only stops a persistent condition from turning the search box into a polling
    /// loop). The caller's task is cancelled when the query changes. Failed remote reads keep the
    /// cached hits, with a visible scope and retry instead of pretending the search was complete.
    private func searchServer(_ needle: String, sessionId: String?, key: String) async {
        guard let api = workbench?.host.api else {
            indexPending = false
            messageSearchError = String(localized: "服务器未连接")
            return
        }
        var refills = 0
        while !Task.isCancelled {
            let result: MessageSearchResult
            do { result = try await api.searchMessages(query: needle, limit: Int32(MessageHits.limit), sessionId: sessionId) }
            catch is CancellationError { return }
            catch {
                guard !Task.isCancelled, searchKey == key else { return }
                indexPending = false
                messageSearchError = error.riffetMessage
                return
            }
            guard !Task.isCancelled, searchKey == key else { return }
            serverHits = result.hits
            serverQuery = needle
            indexPending = result.pending > 0
            mergeMessageHits(for: needle)
            guard result.pending > 0, refills < 20 else { return }
            refills += 1
            try? await Task.sleep(for: .milliseconds(600))
        }
    }

    private func mergeMessageHits(for needle: String) {
        let merged = MessageHits.merge(local: localHits, remote: serverQuery == needle ? serverHits : [], query: needle)
        if merged != storedMessageHits { storedMessageHits = merged }
    }
}
