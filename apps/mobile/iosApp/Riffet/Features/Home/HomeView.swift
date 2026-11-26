import SwiftUI
import RiffetKit

enum MobileRoute: Hashable { case session(String, Bool), member(String) }

/// The tabs, in the bar's order. A launch opens the one chosen in 设置 → 交互与输入; 新会话 until then.
enum RootTab: String, CaseIterable {
    case newTask, assistant, tasks, settings
    /// The title with the server's team in mind: the second tab is 团队 once the server has members, else 助理.
    func title(team: Bool) -> String { self == .assistant && team ? String(localized: "团队", bundle: .riffet) : title }
    static let launchKey = "riffet.ios.launch-tab"
    static var launch: RootTab { RootTab(rawValue: UserDefaults.standard.string(forKey: launchKey) ?? "") ?? .newTask }
    var title: String {
        switch self {
        case .newTask: String(localized: "新会话", bundle: .riffet)
        case .assistant: String(localized: "助理", bundle: .riffet)
        case .tasks: String(localized: "任务", bundle: .riffet)
        case .settings: String(localized: "设置", bundle: .riffet)
        }
    }
}

/// The tabs. `workbench` is nil while no server is connected: the same tabs show, the pages that need a
/// server show `NeedsServerView`, and 新会话 holds the setup card (patterns.md §1.5).
struct RiffetRootView: View {
    let workbench: Workbench?
    @Environment(\.palette) private var palette
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var widthClass
    @Environment(\.verticalSizeClass) private var heightClass
    // Scene storage, not @State, so the selected tab also survives this root
    // being rebuilt (new workbench, scene restoration). The `.tag` on each tab
    // below is load-bearing, not decoration: without tags TabView loses the
    // selection on any redraw driven by a global observable change.
    @SceneStorage("riffet.root-tab") private var tabRaw = RootTab.launch.rawValue
    @State private var newPath: [MobileRoute] = []
    @State private var assistantPath: [MobileRoute] = []
    @State private var taskPath: [MobileRoute] = []
    @State private var openFromList = RouteAction()
    @State private var teamNavigator = TeamNavigator()
    /// Bumped when the current Tasks tab is tapped again; the list scrolls to its top.
    @State private var tasksScrollTop = 0
    @State private var deletionShown = false
    @State private var deletionConfirmed = false
    private var currentTab: RootTab { RootTab(rawValue: tabRaw) ?? .newTask }
    private var tabSelection: Binding<RootTab> {
        Binding(get: { currentTab }, set: { value in
            if value == currentTab, value == .tasks { tasksScrollTop += 1 }
            tabRaw = value.rawValue
        })
    }
    /// The server has team members: the 助理 tab is 团队.
    private var teamTab: Bool { workbench?.teamMembers != nil }
    /// What the pages of the 团队 stack open, bound to this stack's path on each pass.
    private var refreshedTeamNavigator: TeamNavigator {
        teamNavigator.open = { assistantPath.append(.session($0, false)) }
        teamNavigator.popToRoot = { assistantPath = [] }
        return teamNavigator
    }
    /// Each tab's badge counts the waiting conversations it lists: 团队 the members', 任务 the rest.
    private var waiting: WaitingCounts? {
        guard let list = workbench?.list else { return nil }
        return waitingCounts(sessions: list.sessions, projects: list.projects, team: list.teamMembers != nil)
    }
    /// A window wide and tall enough for 任务 to keep its list beside the conversation: iPad, an
    /// unfolded iPhone Duo. The window decides, not the device, so Split View and Stage Manager
    /// windows follow the iPhone rules once they are narrow, and a phone in landscape stays one column.
    private var wide: Bool { widthClass == .regular && heightClass == .regular }
    /// The session the detail column shows; the list marks it.
    private var openTaskID: String? {
        guard wide, case let .session(id, _)? = taskPath.first else { return nil }
        return id
    }
    var body: some View {
        TabView(selection: tabSelection) {
            NavigationStack(path: $newPath) {
                Group {
                    if let workbench {
                        NewTaskView(workbench: workbench,
                                    onStart: { newPath.append(.session($0.id, false)) },
                                    onOpenSession: { newPath.append(.session($0, false)) })
                    } else {
                        UnconnectedNewTaskView(model: model)
                    }
                }
                    .background(TabBarVisibility(hidden: false))
                    .navigationDestination(for: MobileRoute.self) { destination($0) }
            }
            .riffetToastHost()
            .tint(palette.accent)
            .tabItem { Image(systemName: "plus.bubble").environment(\.symbolVariants, .none).accessibilityLabel("新会话") }
            .tag(RootTab.newTask)
            NavigationStack(path: $assistantPath) {
                Group {
                    if let workbench {
                        if workbench.teamMembers != nil { TeamRootView(workbench: workbench, onOpen: { assistantPath.append(.member($0)) }) }
                        else { AssistantRootView(workbench: workbench, onOpenSession: { assistantPath.append(.session($0, false)) }) }
                    }
                    else { NeedsServerView().navigationTitle(RootTab.assistant.title(team: teamTab)).navigationBarTitleDisplayMode(.inline).background(TabBarVisibility(hidden: false)) }
                }
                    .navigationDestination(for: MobileRoute.self) { destination($0) }
            }
            .environment(\.teamNavigator, refreshedTeamNavigator)
            .riffetToastHost()
            .tint(palette.accent)
            .tabItem { Image(systemName: teamTab ? "person.2" : "sparkles").environment(\.symbolVariants, .none).accessibilityLabel(RootTab.assistant.title(team: teamTab)) }
            .tag(RootTab.assistant)
            .badge(Int(waiting?.team ?? 0))
            // One stack in both widths: on a wide window the list moves out beside it and the stack's
            // root becomes the empty detail, while its path, and the conversation on it, stay mounted
            // through a fold, an unfold or a resize.
            HStack(spacing: 0) {
                if wide, workbench != nil {
                    NavigationStack { taskList }
                        .containerRelativeFrame(.horizontal) { width, _ in min(max(width * 0.32, 320), 420) }
                    Divider().ignoresSafeArea()
                }
                NavigationStack(path: $taskPath) {
                    Group { if wide, workbench != nil { TaskDetailPlaceholder() } else { taskList } }
                        .background(TabBarVisibility(hidden: false))
                        .navigationDestination(for: MobileRoute.self) { destination($0, splitRoot: wide && workbench != nil && $0 == taskPath.first) }
                }
            }
            .riffetToastHost()
            .tint(palette.accent)
            .tabItem { Image(systemName: "checklist").environment(\.symbolVariants, .none).accessibilityLabel("任务") }
            .tag(RootTab.tasks)
            .badge(Int(waiting?.tasks ?? 0))
            NavigationStack {
                SettingsView(workbench: workbench)
            }
            .riffetToastHost()
            .tint(palette.accent)
            .tabItem { Image(systemName: "gearshape").environment(\.symbolVariants, .none).accessibilityLabel("设置") }
            .tag(RootTab.settings)
        }
        // The bar's current icon is primary; each page below goes back to accent.
        .tint(palette.primary)
        .task {
            consumeNavigation()
            if workbench == nil || model.landOnNewTask { tabRaw = RootTab.newTask.rawValue; model.landOnNewTask = false }
        }
        .environment(\.connectServer, { tabRaw = RootTab.newTask.rawValue })
        .confirmationDialog(deletionTitle, isPresented: $deletionShown, titleVisibility: .visible, presenting: workbench?.deletion) { request in
            Button(String(localized: "删除", bundle: .riffet), role: .destructive) {
                deletionConfirmed = true
                Task {
                    await workbench?.confirmDeletion(request)
                    if let failure = request.error { RiffetToastCenter.shared.error(failure); workbench?.deletion = nil }
                    else if workbench?.deletion === request { deletionConfirmed = false; deletionShown = true }
                }
            }
        } message: { request in
            Text(deletionSummary(request))
        }
        .onChange(of: workbench?.deletion?.id) { _, id in deletionConfirmed = false; deletionShown = id != nil }
        .onChange(of: deletionShown) { _, shown in if !shown && !deletionConfirmed { workbench?.deletion = nil } }
        .onChange(of: workbench?.removal) { _, removal in
            guard let ids = removal?.ids else { return }
            let gone: (MobileRoute) -> Bool = { if case let .session(id, _) = $0 { ids.contains(id) } else { false } }
            newPath.removeAll(where: gone)
            assistantPath.removeAll(where: gone)
            taskPath.removeAll(where: gone)
        }
        .onChange(of: model.pendingSessionID) { _, _ in consumeNavigation() }
        .onChange(of: model.pendingPrompt) { _, _ in consumeNavigation() }
        .onChange(of: model.pendingHome) { _, _ in consumeNavigation() }
        // An operation's failure is a toast; a conversation that could not open says so on its own page
        // (`presentsOperationError` leaves that one to it).
        .onChange(of: workbench?.error) { _, error in
            guard let error, presentsOperationError else { return }
            RiffetToastCenter.shared.error(error)
            workbench?.error = nil
        }
    }
    private var deletionTitle: String {
        guard let session = workbench?.deletion?.session else { return "" }
        let name = session.shownTitle.isEmpty ? String(localized: "未命名会话", bundle: .riffet) : session.shownTitle
        return String(localized: "删除会话「\(name)」？", bundle: .riffet)
    }
    /// What the server says the deletion removes, in one sentence.
    private func deletionSummary(_ request: SessionDeletion) -> String {
        let effects = request.preview.effects
        var parts = [String(localized: "所有设备都会移除，无法恢复。项目文件和 CLI 历史保留。", bundle: .riffet)]
        if effects.discussions > 0 { parts.append(String(localized: "同时删除 \(Int(effects.discussions)) 个侧边聊天。", bundle: .riffet)) }
        if effects.schedules > 0 { parts.append(String(localized: "\(Int(effects.schedules)) 个定时计划继续运行。", bundle: .riffet)) }
        return parts.joined(separator: " ")
    }
    @ViewBuilder private var taskList: some View {
        if let workbench {
            // The action is refreshed each pass and handed over as the same object, so a push does not
            // count as a change to the list: a closure would, and the list body would run again.
            let _ = openFromList.run = { openTask($0) }
            SessionHomeView(workbench: workbench, scrollToTop: tasksScrollTop, openSessionID: openTaskID, onOpen: openFromList)
        } else {
            NeedsServerView().navigationTitle(RootTab.tasks.title).navigationBarTitleDisplayMode(.inline)
        }
    }
    /// On a wide window the detail column swaps in place; a narrow one pushes.
    private func openTask(_ route: MobileRoute) {
        guard wide else { taskPath.append(route); return }
        guard taskPath != [route] else { return }
        var swap = Transaction()
        swap.disablesAnimations = true
        withTransaction(swap) { taskPath = [route] }
    }
    /// `splitRoot`: the detail column's first page, with the list beside it instead of behind it.
    @ViewBuilder private func destination(_ route: MobileRoute, splitRoot: Bool = false) -> some View {
        switch route {
        case let .session(id, attention):
            if let workbench { ConversationView(workbench: workbench, sessionID: id, focusApproval: attention).id(id)
                .navigationBarBackButtonHidden(splitRoot)
                // The tab bar leaves a phone's conversation; a wide window keeps its tabs in reach.
                .background(TabBarVisibility(hidden: !wide)) }
        case let .member(id):
            if let workbench { TeamMemberPage(workbench: workbench, memberID: id).id(id).background(TabBarVisibility(hidden: !wide)) }
        }
    }
    private var stackTop: MobileRoute? {
        switch currentTab {
        case .newTask: newPath.last
        case .assistant: assistantPath.last
        case .tasks: taskPath.last
        case .settings: nil
        }
    }
    private var presentsOperationError: Bool {
        guard let workbench, workbench.error != nil else { return false }
        // Only the current tab's stack top can suppress the toast (its
        // conversation is being replaced anyway); another tab's leftover
        // destination must not hide an error from the page in front.
        if case let .session(id, _) = stackTop,
           workbench.selected?.id != id,
           !workbench.list.sessions.contains(where: { $0.id == id }) { return false }
        return true
    }
    private func consumeNavigation() {
        guard let workbench else { return }
        if model.pendingHome { tabRaw = RootTab.tasks.rawValue; taskPath = []; model.pendingHome = false }
        if let id = model.pendingSessionID {
            // The assistant's conversation is its tab, not a page of 任务.
            if workbench.teamMembers != nil, let session = workbench.listedSession(id), workbench.member(of: session) != nil {
                tabRaw = RootTab.assistant.rawValue; assistantPath = [.session(id, true)]
            } else if id == workbench.assistantMain?.id { tabRaw = RootTab.assistant.rawValue; assistantPath = [] }
            else { tabRaw = RootTab.tasks.rawValue; taskPath = [.session(id, true)] }
            model.pendingSessionID = nil
        }
        if let prompt = model.pendingPrompt {
            let draft = workbench.drafts.draft("new")
            // An empty prompt (⌘N, riffet://new) only opens the page; it leaves the draft as it was.
            if !prompt.isEmpty { draft.text = draft.text.isEmpty ? prompt : draft.text + "\n\n" + prompt }
            tabRaw = RootTab.newTask.rawValue; newPath = []; model.pendingPrompt = nil
        }
    }
}

private enum HomeFilter: String, CaseIterable {
    case all = "全部", running = "进行中", waiting = "待处理", unread = "未读", quickChat = "快速对话", archived = "归档"
    var title: String {
        switch self {
        case .all: String(localized: "全部", bundle: .riffet)
        case .running: String(localized: "运行中", bundle: .riffet)
        case .waiting: String(localized: "待处理", bundle: .riffet)
        case .unread: String(localized: "未读", bundle: .riffet)
        case .quickChat: String(localized: "快速对话", bundle: .riffet)
        case .archived: String(localized: "已归档", bundle: .riffet)
        }
    }
}
private enum HomeGrouping: String, CaseIterable {
    case time = "按时间", project = "按项目"
    var title: LocalizedStringKey {
        switch self {
        case .time: "按时间"
        case .project: "按项目"
        }
    }
}

struct SessionHomeView: View {
    let workbench: Workbench
    var scrollToTop = 0
    /// The session open beside the list on a wide window.
    var openSessionID: String?
    let onOpen: RouteAction
    @State private var query = ""
    @State private var scope: String?
    @State private var filter: HomeFilter
    @State private var grouping: HomeGrouping
    @State private var collapsedProjects: Set<String>
    @State private var tag: String?
    @State private var showingProjects = false
    @State private var renaming: Session?
    @State private var title = ""
    @State private var tagging: Session?
    @State private var tags = ""
    @State private var order = SessionOrder()
    @State private var rowActions = SessionRowActions()
    @State private var statusShown = false
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let topID = "tasks.top"
    private var preferenceKey: String { "riffet.ios.\(workbench.baseURL.absoluteString).home." }

    init(workbench: Workbench, scrollToTop: Int = 0, openSessionID: String? = nil, onOpen: RouteAction) {
        self.workbench = workbench
        self.scrollToTop = scrollToTop
        self.openSessionID = openSessionID
        self.onOpen = onOpen
        let key = "riffet.ios.\(workbench.baseURL.absoluteString).home."
        let defaults = UserDefaults.standard
        _scope = State(initialValue: defaults.string(forKey: key + "project"))
        _filter = State(initialValue: HomeFilter(rawValue: defaults.string(forKey: key + "filter") ?? "") ?? .all)
        _grouping = State(initialValue: HomeGrouping(rawValue: defaults.string(forKey: key + "grouping") ?? "") ?? .time)
        _collapsedProjects = State(initialValue: Set(defaults.stringArray(forKey: key + "collapsedProjects") ?? []))
        _tag = State(initialValue: defaults.string(forKey: key + "tag"))
    }
    private var sessions: [Session] {
        let names = Dictionary(uniqueKeysWithValues: workbench.list.projects.map { ($0.id, $0.name) })
        let archivedProjects = Set(workbench.list.projects.filter { $0.archivedAt != nil }.map(\.id))
        let memberProjects = self.memberProjects
        // Quick chats have no project to scope by: 快速对话 lists the live ones, and 已归档 without a
        // project scope adds the archived ones; every other filter leaves them out.
        let chats = chatProject?.id
        let withChats = filter == .quickChat || (filter == .archived && scope == nil)
        return order.sorted(workbench.list).filter {
            !isTeamSession($0, memberProjects) &&
            ($0.projectId == chats ? withChats : filter != .quickChat) &&
            (($0.archivedAt != nil || archivedProjects.contains($0.projectId)) == (filter == .archived)) &&
            (scope == nil || $0.projectId == scope || ($0.projectId == chats && filter == .quickChat)) &&
            (filter != .running || $0.state.isActive) && (filter != .waiting || $0.state == .waiting) &&
            (filter != .unread || $0.id == openSessionID || SidebarModelKt.isDoneUnseen(session: $0)) &&
            (tag == nil || $0.tags.contains(tag!)) &&
            (query.isEmpty || "\($0.title) \(names[$0.projectId] ?? "") \($0.tags.joined(separator: " "))".localizedCaseInsensitiveContains(query))
        }
    }
    /// A team member's conversations are in 团队, as in the web sidebar: those it opened, and the older ones in its
    /// own project that carry no member yet.
    private var memberProjects: Set<String> {
        workbench.teamMembers == nil ? [] : Set(workbench.list.projects.filter(\.isAssistant).map(\.id))
    }
    private func isTeamSession(_ session: Session, _ memberProjects: Set<String>) -> Bool {
        session.agentMemberId != nil || memberProjects.contains(session.projectId)
    }
    private var chatProject: Project? { workbench.list.projects.first { $0.isQuickChat && $0.archivedAt == nil } }
    /// 快速对话 only when the server keeps quick chats.
    private var filters: [HomeFilter] { HomeFilter.allCases.filter { $0 != .quickChat || chatProject != nil } }
    private var scopeIsUnavailable: Bool {
        guard let scope else { return false }
        let state = workbench.list
        // A missing project in the device copy or a failed read is not an authoritative removal.
        guard state.loaded, !state.loading, state.cachedAt == nil, state.error == nil else { return false }
        return !workbench.projects.contains { $0.id == scope }
    }
    private var availableTags: [String] { Set(workbench.list.sessions.flatMap(\.tags)).sorted() }
    private var isConnected: Bool { workbench.serverReachable }
    private var statusPending: Bool { !isConnected && workbench.list.error == nil }
    private var connectionStatus: String {
        workbench.list.error != nil ? String(localized: "待重连", bundle: .riffet) : String(localized: "同步中", bundle: .riffet)
    }

    @ViewBuilder private var sessionList: some View {
        let visible = sessions
        ScrollViewReader { proxy in
            List {
                controlsHeader.id(Self.topID)
                    .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
                // One ForEach over headers and sessions. List runs its content closure for every item on
                // each pass, so the closure only picks the row's frame; what a row shows is worked out in
                // `SessionRowLabel`, for the rows on screen (ios-performance.md §2.4).
                ForEach(listItems(visible)) { item in
                    switch item {
                    case let .header(_, title): groupHeader(title)
                    case let .project(project, count): projectHeader(project, count: count)
                    case let .session(session):
                        SessionRow(session: session, workbench: workbench, openSessionID: openSessionID, showsProject: scope == nil, actions: rowActions)
                    }
                }
                if visible.isEmpty {
                    Group {
                        if workbench.list.loading && !workbench.list.loaded {
                            ProgressView()
                        } else if !query.isEmpty {
                            ContentUnavailableView.search(text: query)
                        } else {
                            if filter == .waiting { ContentUnavailableView("没有待处理的请求", systemImage: "checkmark.circle") }
                            else { ContentUnavailableView("没有会话", systemImage: "bubble.left") }
                        }
                    }
                    .frame(maxWidth: .infinity).padding(.top, 48)
                    .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
                if !query.isEmpty {
                    NavigationLink { CachedSearchView(workbench: workbench, query: query) } label: {
                        Label("在已缓存的消息中搜索", systemImage: "text.magnifyingglass").riffetFont(.body).foregroundStyle(palette.fg)
                    }
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
            }
            .onChange(of: scrollToTop) { _, _ in withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) { proxy.scrollTo(Self.topID, anchor: .top) } }
        }
    }
    /// 项目 ▾ opens the project sheet; with a project picked it shows its name, highlighted.
    private var projectChip: some View {
        let picked = workbench.project(scope)
        return RiffetChipButton(title: picked?.name ?? String(localized: "项目", bundle: .riffet), highlighted: picked != nil) { showingProjects = true }
            .frame(maxWidth: 180).fixedSize()
            .accessibilityLabel(String(localized: "项目", bundle: .riffet)).accessibilityIdentifier("sessionProjectFilter")
    }
    /// A filter's title with how many sessions need the reader or are working, when that is a count to act on.
    private func filterTitle(_ filter: HomeFilter) -> String {
        let memberProjects = self.memberProjects
        let live = workbench.list.sessions.filter { $0.archivedAt == nil && !isTeamSession($0, memberProjects) }
        let count: Int
        switch filter {
        case .waiting: count = live.count { $0.state == .waiting }
        case .running: count = live.count { $0.state.isActive }
        default: count = 0
        }
        return count > 0 ? "\(filter.title) \(count)" : filter.title
    }
    /// The status chips lead the list and scroll with it; a tag filter and a sync failure follow as quiet lines.
    @ViewBuilder private var controlsHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 0) {
                projectChip.padding(.leading, RiffetMetrics.pageInset).zIndex(1)
                // The bar insets its chips by the page margin; pull it back so they follow the project chip closely.
                RiffetChipBar(items: filters.map { .init(value: $0, title: filterTitle($0)) }, selection: $filter)
                    .padding(.leading, 6 - RiffetMetrics.pageInset).clipped()
                    .accessibilityIdentifier("sessionFilter")
            }
            if let tag {
                Button { self.tag = nil } label: {
                    Label("标签：\(tag)", systemImage: "xmark.circle.fill").riffetFont(.caption).foregroundStyle(palette.fg3)
                }
                .buttonStyle(RiffetDimPressStyle()).padding(.horizontal, RiffetMetrics.pageInset)
            }
            if let error = workbench.list.error { syncFailure(error) }
        }
        .padding(.top, 12).padding(.bottom, 6)
    }
    private func syncFailure(_ error: String) -> some View {
        RiffetNotice(kind: .warning, title: String(localized: "无法同步会话", bundle: .riffet), message: AppModel.connectionMessage(error),
                     actionTitle: String(localized: "重试", bundle: .riffet), action: { workbench.refresh() }, boxed: true)
            .padding(.horizontal, RiffetMetrics.pageInset)
    }
    var body: some View {
        // Refreshed each pass on the same object (see `SessionRowActions`).
        let _ = rowActions.open = { [onOpen] in onOpen.run($0) }
        let _ = rowActions.rename = { title = $0.title; renaming = $0 }
        let _ = rowActions.tag = { tags = $0.tags.joined(separator: ", "); tagging = $0 }
        renameAlertHome.alert("编辑标签", isPresented: taggingPresented) { tagActions }
    }
    private var decoratedHome: some View {
        sessionList
            .listStyle(.plain)
            .listRowSpacing(0)
            .scrollContentBackground(.hidden)
            .background(palette.bg)
            .riffetSoftEdges()
            .overlay(alignment: .top) { RiffetBarScrim() }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(String(localized: "任务", bundle: .riffet))
            .navigationBarTitleDisplayMode(.inline)
            .riffetSearchable(text: $query, prompt: String(localized: "搜索会话、项目与消息", bundle: .riffet))
            .refreshable { await workbench.refreshAndWait() }
            .toolbar { homeToolbar }
            // Connection status only shows while the list is not live.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if statusShown && statusPending {
                    HStack(spacing: 6) {
                        RiffetStatusDot(state: .waiting, size: 6)
                        Text(connectionStatus).lineLimit(1)
                    }.riffetFont(.caption).foregroundStyle(palette.fg2)
                        .padding(.horizontal, 12).frame(minHeight: 28)
                        .riffetGlass(in: Capsule())
                        .frame(maxWidth: .infinity).padding(.bottom, 6)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(connectionStatus)，服务器 \(workbench.baseURL.host ?? "Mac")")
                }
            }
            .task(id: statusPending) {
                statusShown = false
                guard statusPending else { return }
                // After launch the device copy shows until the live list arrives, often within a moment:
                // shown at once, the status would only blink.
                try? await Task.sleep(for: .seconds(1))
                if !Task.isCancelled { statusShown = true }
            }
            .sheet(isPresented: $showingProjects) {
                ProjectSheet(workbench: workbench, selection: scope, allLabel: String(localized: "全部项目", bundle: .riffet)) { scope = $0?.id }
            }
    }
    private var preferenceHome: some View {
        decoratedHome
            .onChange(of: scope) { (_: String?, value: String?) in savePreference(value, field: "project") }
            .onChange(of: filter) { (_: HomeFilter, value: HomeFilter) in savePreference(value.rawValue, field: "filter") }
            .onChange(of: grouping) { (_: HomeGrouping, value: HomeGrouping) in savePreference(value.rawValue, field: "grouping") }
            .onChange(of: tag) { (_: String?, value: String?) in savePreference(value, field: "tag") }
            .onChange(of: scopeIsUnavailable, initial: true) { (_: Bool, unavailable: Bool) in
                if unavailable { scope = nil }
            }
    }
    private func savePreference(_ value: String?, field: String) {
        UserDefaults.standard.set(value as Any?, forKey: preferenceKey + field)
    }
    private var renameAlertHome: some View {
        preferenceHome.alert("重命名会话", isPresented: renamingPresented) { renameActions }
    }
    private var renamingPresented: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }
    private var taggingPresented: Binding<Bool> {
        Binding(get: { tagging != nil }, set: { if !$0 { tagging = nil } })
    }
    @ViewBuilder private var renameActions: some View {
        TextField("名称", text: $title)
        Button("保存", action: saveTitle).disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        Button("取消", role: .cancel) { renaming = nil }
    }
    @ViewBuilder private var tagActions: some View {
        TextField("工作, 紧急", text: $tags)
        Button("保存", action: saveTags)
        Button("取消", role: .cancel) { tagging = nil }
    }
    private func saveTitle() {
        guard let session = renaming else { return }
        let updatedTitle = title
        renaming = nil
        Task { await workbench.update(session, title: updatedTitle) }
    }
    private func saveTags() {
        guard let session = tagging else { return }
        let updatedTags: [String] = tags
            .split(whereSeparator: { character in character == "," || character == "，" })
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        tagging = nil
        Task { await workbench.update(session, tags: updatedTags) }
    }
    @ToolbarContentBuilder private var homeToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Section {
                    Picker("分组方式", selection: $grouping) { ForEach(HomeGrouping.allCases, id: \.self) { Text($0.title).tag($0) } }
                    Menu("按标签筛选", systemImage: "tag") {
                        Button("所有标签") { tag = nil }
                        ForEach(availableTags, id: \.self) { value in Button { tag = value } label: { if tag == value { Label(value, systemImage: "checkmark") } else { Text(value) } } }
                    }.disabled(availableTags.isEmpty)
                    if scope != nil || tag != nil || filter != .all { Button("清除筛选") { scope = nil; tag = nil; filter = .all } }
                }
                if let project = workbench.project(scope) {
                    Section(project.name) { projectLinks(project) }
                }
                Section {
                    Button(String(localized: "全部标为已读", bundle: .riffet), systemImage: "checkmark.circle") { Task { await workbench.markAllSeen() } }
                }
            } label: { Image(systemName: "ellipsis") }.accessibilityLabel("更多")
        }
    }
    /// The list's rows in order: what needs the reader, then what is still working, lead; a pinned
    /// session that is running shows among the running ones and returns to 置顶 when it settles.
    private func listItems(_ visible: [Session]) -> [HomeListItem] {
        let waiting = visible.filter { $0.state == .waiting }
        let running = visible.filter { $0.state != .waiting && $0.state.isActive }
        let settled = visible.filter { $0.state != .waiting && !$0.state.isActive }
        let pinned = settled.filter { $0.pinnedAt != nil }
        let recent = settled.filter { $0.pinnedAt == nil }
        var items: [HomeListItem] = []
        items.reserveCapacity(visible.count + 8)
        func group(_ key: String, _ title: String, _ sessions: [Session]) {
            guard !sessions.isEmpty else { return }
            items.append(.header("group." + key, title))
            items.append(contentsOf: sessions.map(HomeListItem.session))
        }
        group("waiting", String(localized: "待处理", bundle: .riffet), waiting)
        group("running", String(localized: "运行中", bundle: .riffet), running)
        group("pinned", String(localized: "置顶", bundle: .riffet), pinned)
        if grouping == .project && scope == nil {
            let byProject = Dictionary(grouping: recent, by: \.projectId)
            for project in workbench.list.projects {
                guard let sessions = byProject[project.id] else { continue }
                items.append(.project(project, count: sessions.count))
                if !collapsedProjects.contains(project.id) { items.append(contentsOf: sessions.map(HomeListItem.session)) }
            }
            group("unknown", String(localized: "其他会话", bundle: .riffet), recent.filter { workbench.project($0.projectId) == nil })
        } else {
            for time in timeGroups(recent) { group("time." + time.title, time.title, time.items) }
        }
        return items
    }

    private func timeGroups(_ sessions: [Session]) -> [(title: String, items: [Session])] {
        let calendar = Calendar.current
        let groups = Dictionary(grouping: sessions) { session -> Int in
            guard let date = ServerTime.date(SidebarModelKt.activityAt(session: session)) else { return 3 }
            if calendar.isDateInToday(date) { return 0 }
            if calendar.isDateInYesterday(date) { return 1 }
            if date >= calendar.date(byAdding: .day, value: -7, to: .now)! { return 2 }
            return 3
        }
        return [(0, String(localized: "今天", bundle: .riffet)), (1, String(localized: "昨天", bundle: .riffet)), (2, String(localized: "最近 7 天", bundle: .riffet)), (3, String(localized: "更早", bundle: .riffet))].compactMap { key, name in groups[key].map { (name, $0) } }
    }
    /// Section titles are plain rows, not List section headers: no sticky band and no system edge material.
    private func groupHeader(_ title: String) -> some View {
        RiffetSectionHeader(title: title)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
    /// Project groups fold like the Mac sidebar's: a project with a long history
    /// collapses to one line with its count, and the choice is remembered.
    private func projectHeader(_ project: Project, count: Int) -> some View {
        let collapsed = collapsedProjects.contains(project.id)
        return HStack(spacing: 6) {
            Image(systemName: collapsed ? "chevron.right" : "chevron.down").riffetFont(.caption, weight: .semibold).frame(width: 12)
            Text(project.name).lineLimit(1)
            Text("\(count)")
            Spacer(minLength: 0)
        }
        .riffetFont(.label).foregroundStyle(palette.fg3)
        .padding(.leading, 20).padding(.trailing, 16).padding(.top, 18).padding(.bottom, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture { toggleProject(project.id) }
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(project.name)，\(count) 个会话")
        .accessibilityValue(collapsed ? "已折叠" : "已展开")
    }
    private func toggleProject(_ id: String) {
        withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) {
            if collapsedProjects.contains(id) { collapsedProjects.remove(id) } else { collapsedProjects.insert(id) }
        }
        UserDefaults.standard.set(Array(collapsedProjects), forKey: preferenceKey + "collapsedProjects")
    }
    /// What the new-session page does not offer: files, changes and the terminal live there.
    @ViewBuilder private func projectLinks(_ project: Project) -> some View {
        // Both open the Git page on their view, so its tabs, bar and refresh are the same from here.
        NavigationLink { ProjectChangesView(workbench: workbench, project: project, tab: .checkpoints) } label: { Label(gitText("Checkpoints"), systemImage: "clock.arrow.circlepath") }
        NavigationLink { ProjectChangesView(workbench: workbench, project: project, tab: .worktrees) } label: { Label(gitText("Worktrees"), systemImage: "arrow.triangle.branch") }
    }
}

/// One session of the task list. `List` builds this value for every session on every pass over the
/// list and runs its body only for the rows on screen, so the button, its swipe actions and its menu
/// are made here rather than in the list's `ForEach` (ios-performance.md §2.4).
private struct SessionRow: View {
    let session: Session
    let workbench: Workbench
    let openSessionID: String?
    let showsProject: Bool
    let actions: SessionRowActions

    var body: some View {
        Button { actions.open(.session(session.id, session.state == .waiting)) } label: {
            SessionRowLabel(session: session, workbench: workbench, openSessionID: openSessionID, showsProject: showsProject)
        }
        .buttonStyle(RiffetRowPressStyle(radius: 10))
        .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 10, style: .continuous))
        .hoverEffect(.highlight)
        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .accessibilityIdentifier("session.\(session.id)")
        .accessibilityAddTraits(openSessionID == session.id ? .isSelected : [])
        // Each in a view of its own: `List` runs this body for every session to count its rows, and the
        // buttons are only needed for a row on screen or a menu that opens.
        .swipeActions(edge: .leading, allowsFullSwipe: false) { SessionRowSwipe(session: session, workbench: workbench, edge: .leading) }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) { SessionRowSwipe(session: session, workbench: workbench, edge: .trailing) }
        .contextMenu { SessionRowMenu(session: session, workbench: workbench, actions: actions) }
    }
}

private struct SessionRowSwipe: View {
    let session: Session
    let workbench: Workbench
    let edge: HorizontalEdge
    @Environment(\.palette) private var palette
    var body: some View {
        if edge == .leading {
            Button(session.pinnedAt == nil ? "置顶" : "取消置顶", systemImage: "pin") { Task { await workbench.update(session, pinned: session.pinnedAt == nil) } }.tint(palette.accent)
        } else {
            Button(session.archivedAt == nil ? "归档" : "恢复", systemImage: "archivebox") { Task { await workbench.update(session, archived: session.archivedAt == nil) } }.tint(palette.fg3)
        }
    }
}

private struct SessionRowMenu: View {
    let session: Session
    let workbench: Workbench
    let actions: SessionRowActions
    var body: some View {
        Button("重命名", systemImage: "pencil") { actions.rename(session) }
        Button("编辑标签", systemImage: "tag") { actions.tag(session) }
        Button(session.pinnedAt == nil ? "置顶" : "取消置顶", systemImage: "pin") { Task { await workbench.update(session, pinned: session.pinnedAt == nil) } }
        Button(session.archivedAt == nil ? "归档" : "恢复", systemImage: "archivebox") { Task { await workbench.update(session, archived: session.archivedAt == nil) } }
        if workbench.list.canDeleteSessions {
            Button("删除…", systemImage: "trash", role: .destructive) { Task { await workbench.requestDeletion(session) } }.disabled(workbench.deletionLoading != nil)
        }
    }
}

/// What a row does, handed to every row as one object: closures as row properties would be new on
/// each pass, so every row on screen would count as changed (ios-performance.md §2.3).
private final class SessionRowActions {
    var open: (MobileRoute) -> Void = { _ in }
    var rename: (Session) -> Void = { _ in }
    var tag: (Session) -> Void = { _ in }
}

/// What a task-list row shows. Its body runs only for rows on screen.
private struct SessionRowLabel: View {
    let session: Session
    let workbench: Workbench
    /// The session open beside the list on a wide window.
    let openSessionID: String?
    let showsProject: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        let name = session.shownTitle.isEmpty ? String(localized: "未命名会话", bundle: .riffet) : session.shownTitle
        let time = timeText(session)
        HStack(spacing: 12) {
            AgentAvatar(backend: (session.backendId ?? .cursor).name, state: avatarState(session))
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(name).riffetFont(.headline).foregroundStyle(session.archivedAt == nil ? palette.fg : palette.fg2).lineLimit(1)
                    Spacer(minLength: 0)
                    if openSessionID != session.id, SidebarModelKt.isDoneUnseen(session: session) {
                        RiffetStatusDot(state: .unread, size: 6).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
                    }
                    Text(time).riffetFont(.caption).foregroundStyle(palette.fg3).monospacedDigit()
                }
                if let line = subtitle(session) { line.riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1) }
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: RiffetMetrics.rowMinHeight, alignment: .leading)
        .background(openSessionID == session.id ? palette.bgActive : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([name, session.state.label, time].filter { !$0.isEmpty }.joined(separator: "，"))
    }

    /// Project, tags and draft on one quiet line; whatever does not fit is truncated.
    func rowMeta(_ session: Session) -> String {
        var parts: [String] = []
        if showsProject { parts.append(workbench.project(session.projectId)?.name ?? String(localized: "项目", bundle: .riffet)) }
        if !session.tags.isEmpty { parts.append(session.tags.prefix(2).map { "#" + $0 }.joined(separator: " ")) }
        if workbench.drafts.hasContent("session.\(session.id)") { parts.append(String(localized: "草稿", bundle: .riffet)) }
        if failedUnseen(session), let reason = session.error?.split(whereSeparator: \.isNewline).first.map(String.init), !reason.isEmpty { parts.append(reason) }
        return parts.joined(separator: " · ")
    }
    /// Today the clock, yesterday its name, within a week the weekday, else month/day.
    func timeText(_ session: Session) -> String { sessionRowTime(SidebarModelKt.activityAt(session: session)) }
    /// A failure is called out until it is seen; after that the conversation tells it, and the row
    /// reads like any other (docs/design/DECISIONS.md 2026-11-17).
    func failedUnseen(_ session: Session) -> Bool {
        session.state == .failed && openSessionID != session.id && SidebarModelKt.isDoneUnseen(session: session)
    }
    func avatarState(_ session: Session) -> AgentAvatarState {
        switch session.state {
        case .waiting: .waiting
        case .failed: failedUnseen(session) ? .failed : .idle
        default: session.state.isActive ? .running : .idle
        }
    }
    /// A coloured status word where the session needs a look, then the quiet meta.
    func subtitle(_ session: Session) -> Text? {
        let status: (String, Color)?
        switch avatarState(session) {
        case .waiting: status = (String(localized: "等待你", bundle: .riffet), palette.warning)
        case .failed: status = (String(localized: "失败", bundle: .riffet), palette.danger)
        // Running rows sit under their own heading and turn an arc on the avatar; no word needed.
        case .running, .idle: status = nil
        }
        let meta = rowMeta(session)
        guard let status else { return meta.isEmpty ? nil : Text(meta) }
        let word = Text(status.0).fontWeight(.medium).foregroundStyle(status.1)
        return meta.isEmpty ? word : word + Text(" · " + meta)
    }
}

/// A navigation action a page hands to a child view as one object across passes.
final class RouteAction {
    var run: (MobileRoute) -> Void = { _ in }
}

/// One row of the task list: a group heading, a project heading or a session.
private enum HomeListItem: Identifiable {
    case header(String, String)
    case project(Project, count: Int)
    case session(Session)
    var id: String {
        switch self {
        case let .header(key, _): "header." + key
        case let .project(project, _): "project." + project.id
        case let .session(session): session.id
        }
    }
}

/// A page pushed over a tab's first page: on a phone it covers the tab bar, as settings pages do;
/// a wide window keeps its tabs in reach.
struct PushedPageTabBar: ViewModifier {
    @Environment(\.horizontalSizeClass) private var widthClass
    @Environment(\.verticalSizeClass) private var heightClass
    func body(content: Content) -> some View {
        content.background(TabBarVisibility(hidden: !(widthClass == .regular && heightClass == .regular)))
    }
}

/// The list's sessions in display order, sorted once per list rather than on every pass of the page:
/// this page re-evaluates on every list update, filter and keystroke in its search (ios-performance.md §2.1).
final class SessionOrder {
    /// Held, so a later list can never be mistaken for it.
    private var source: SessionListState?
    private var sorted: [Session] = []
    func sorted(_ list: SessionListState) -> [Session] {
        if list !== source { source = list; sorted = SessionOrderKt.sortSessions(sessions: list.sessions) }
        return sorted
    }
}

/// Shows or hides the tab bar as the page it sits in comes on screen, with UIKit's own animation,
/// so the bar leaves with a push and returns with the pop. SwiftUI's `.toolbar(.hidden, for: .tabBar)`
/// drops it at once and brings it back only after the pop has finished. During a back swipe the bar
/// waits for the swipe to commit; a cancelled swipe leaves it as it was.
///
/// The bar never changes inside `viewWillAppear` or a SwiftUI update: `setTabBarHidden` lays the tab
/// controller out on the spot, and on iOS 27 that renders the page being pushed before SwiftUI has given
/// it its environment, so an `@Environment(AppModel.self)` read on it traps. The change rides the
/// transition's animation instead, or the next turn of the run loop when there is none.
struct TabBarVisibility: UIViewControllerRepresentable {
    let hidden: Bool
    func makeUIViewController(context: Context) -> Controller { Controller(hidden: hidden) }
    func updateUIViewController(_ controller: Controller, context: Context) { controller.update(hidden: hidden) }

    final class Controller: UIViewController {
        private var hidden: Bool
        init(hidden: Bool) { self.hidden = hidden; super.init(nibName: nil, bundle: nil) }
        /// A window crossing the wide threshold changes what the page on screen wants.
        func update(hidden: Bool) {
            guard hidden != self.hidden else { return }
            self.hidden = hidden
            guard viewIfLoaded?.window != nil else { return }
            apply(animated: false)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
        override func loadView() { view = UIView(); view.isUserInteractionEnabled = false }
        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            guard let tabs = tabBarController, tabs.isTabBarHidden != hidden else { return }
            let hidden = hidden
            guard let coordinator = transitionCoordinator else { apply(animated: animated); return }
            if coordinator.isInteractive {
                coordinator.notifyWhenInteractionChanges { context in
                    if !context.isCancelled { tabs.setTabBarHidden(hidden, animated: true) }
                }
            } else if !coordinator.animate(alongsideTransition: { _ in tabs.setTabBarHidden(hidden, animated: false) }) {
                apply(animated: false)
            }
        }
        /// After the current layout pass, so the page being shown has its environment by then.
        private func apply(animated: Bool) {
            DispatchQueue.main.async { [weak self] in
                guard let self, let tabs = self.tabBarController, tabs.isTabBarHidden != self.hidden else { return }
                tabs.setTabBarHidden(self.hidden, animated: animated)
            }
        }
    }
}
