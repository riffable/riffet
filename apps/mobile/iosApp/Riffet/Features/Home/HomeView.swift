import SwiftUI
import RiffetKit

enum MobileRoute: Hashable { case session(String, Bool) }

private enum RootTab: String { case newTask, tasks, settings }

struct RiffetRootView: View {
    let workbench: Workbench
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var widthClass
    @Environment(\.verticalSizeClass) private var heightClass
    // Scene storage, not @State, so the selected tab also survives this root
    // being rebuilt (new workbench, scene restoration). The `.tag` on each tab
    // below is load-bearing, not decoration: without tags TabView loses the
    // selection on any redraw driven by a global observable change.
    @SceneStorage("riffet.root-tab") private var tabRaw = RootTab.tasks.rawValue
    @State private var newPath: [MobileRoute] = []
    @State private var taskPath: [MobileRoute] = []
    /// Bumped when the current Tasks tab is tapped again; the list scrolls to its top.
    @State private var tasksScrollTop = 0
    private var currentTab: RootTab { RootTab(rawValue: tabRaw) ?? .tasks }
    private var tabSelection: Binding<RootTab> {
        Binding(get: { currentTab }, set: { value in
            if value == currentTab, value == .tasks { tasksScrollTop += 1 }
            tabRaw = value.rawValue
        })
    }
    private var waitingCount: Int { workbench.list.sessions.count { $0.state == .waiting } }
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
                NewTaskView(workbench: workbench,
                            onStart: { newPath.append(.session($0.id, false)) },
                            onOpenSession: { newPath.append(.session($0, false)) })
                    .background(TabBarVisibility(hidden: false))
                    .navigationDestination(for: MobileRoute.self) { destination($0) }
            }
            .tabItem { Image(systemName: "plus.bubble").environment(\.symbolVariants, .none).accessibilityLabel("新会话") }
            .tag(RootTab.newTask)
            // One stack in both widths: on a wide window the list moves out beside it and the stack's
            // root becomes the empty detail, while its path, and the conversation on it, stay mounted
            // through a fold, an unfold or a resize.
            HStack(spacing: 0) {
                if wide {
                    NavigationStack { taskList }
                        .containerRelativeFrame(.horizontal) { width, _ in min(max(width * 0.32, 320), 420) }
                    Divider().ignoresSafeArea()
                }
                NavigationStack(path: $taskPath) {
                    Group { if wide { TaskDetailPlaceholder() } else { taskList } }
                        .background(TabBarVisibility(hidden: false))
                        .navigationDestination(for: MobileRoute.self) { destination($0, splitRoot: wide && $0 == taskPath.first) }
                }
            }
            .tabItem { Image(systemName: "checklist").environment(\.symbolVariants, .none).accessibilityLabel("任务") }
            .tag(RootTab.tasks)
            .badge(waitingCount)
            NavigationStack {
                SettingsView(workbench: workbench)
            }
            .tabItem { Image(systemName: "gearshape").environment(\.symbolVariants, .none).accessibilityLabel("设置") }
            .tag(RootTab.settings)
        }
        .task { consumeNavigation() }
        .sheet(item: Binding(get: { workbench.deletion }, set: { workbench.deletion = $0 })) { SessionDeletionSheet(workbench: workbench, request: $0) }
        .onChange(of: workbench.removal) { _, removal in
            guard let ids = removal?.ids else { return }
            let gone: (MobileRoute) -> Bool = { if case let .session(id, _) = $0 { ids.contains(id) } else { false } }
            newPath.removeAll(where: gone)
            taskPath.removeAll(where: gone)
        }
        .onChange(of: model.pendingSessionID) { _, _ in consumeNavigation() }
        .onChange(of: model.pendingPrompt) { _, _ in consumeNavigation() }
        .onChange(of: model.pendingHome) { _, _ in consumeNavigation() }
        .alert("未能完成操作", isPresented: Binding(get: { presentsOperationError }, set: { if !$0 { workbench.error = nil } })) {
            Button("好") { workbench.error = nil }
        } message: { Text(workbench.error ?? "") }
    }
    private var taskList: some View {
        SessionHomeView(workbench: workbench, scrollToTop: tasksScrollTop, openSessionID: openTaskID) { openTask($0) }
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
            ConversationView(workbench: workbench, sessionID: id, focusApproval: attention).id(id)
                .navigationBarBackButtonHidden(splitRoot)
                // The tab bar leaves a phone's conversation; a wide window keeps its tabs in reach.
                .background(TabBarVisibility(hidden: !wide))
        }
    }
    private var presentsOperationError: Bool {
        guard workbench.error != nil else { return false }
        // Only the current tab's stack top can suppress the alert (its
        // conversation is being replaced anyway); another tab's leftover
        // destination must not hide an error from the page in front.
        let top: MobileRoute?
        switch currentTab {
        case .newTask: top = newPath.last
        case .tasks: top = taskPath.last
        case .settings: top = nil
        }
        if case let .session(id, _) = top,
           workbench.selected?.id != id,
           !workbench.list.sessions.contains(where: { $0.id == id }) { return false }
        return true
    }
    private func consumeNavigation() {
        if model.pendingHome { tabRaw = RootTab.tasks.rawValue; taskPath = []; model.pendingHome = false }
        if let id = model.pendingSessionID { tabRaw = RootTab.tasks.rawValue; taskPath = [.session(id, true)]; model.pendingSessionID = nil }
        if let prompt = model.pendingPrompt {
            let draft = workbench.drafts.draft("new")
            // An empty prompt (⌘N, riffet://new) only opens the page; it leaves the draft as it was.
            if !prompt.isEmpty { draft.text = draft.text.isEmpty ? prompt : draft.text + "\n\n" + prompt }
            tabRaw = RootTab.newTask.rawValue; newPath = []; model.pendingPrompt = nil
            UserDefaults.standard.set(NewSessionTab.task.rawValue, forKey: NewSessionTab.storageKey)
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
    let onOpen: (MobileRoute) -> Void
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
    @Environment(\.palette) private var palette
    private static let topID = "tasks.top"
    private var preferenceKey: String { "riffet.ios.\(workbench.baseURL.absoluteString).home." }

    init(workbench: Workbench, scrollToTop: Int = 0, openSessionID: String? = nil, onOpen: @escaping (MobileRoute) -> Void) {
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
        // Quick chats have no project to scope by: 快速对话 lists the live ones, and 已归档 without a
        // project scope adds the archived ones; every other filter leaves them out.
        let chats = chatProject?.id
        let withChats = filter == .quickChat || (filter == .archived && scope == nil)
        return workbench.list.sessions.filter {
            ($0.projectId == chats ? withChats : filter != .quickChat) &&
            (($0.archivedAt != nil || archivedProjects.contains($0.projectId)) == (filter == .archived)) &&
            (scope == nil || $0.projectId == scope || ($0.projectId == chats && filter == .quickChat)) &&
            (filter != .running || $0.state.isActive) && (filter != .waiting || $0.state == .waiting) &&
            (filter != .unread || $0.id == openSessionID || SidebarModelKt.isDoneUnseen(session: $0)) &&
            (tag == nil || $0.tags.contains(tag!)) &&
            (query.isEmpty || "\($0.title) \(names[$0.projectId] ?? "") \($0.tags.joined(separator: " "))".localizedCaseInsensitiveContains(query))
        }.sorted { SidebarModelKt.compareSessions(a: $0, b: $1) < 0 }
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
    private var connectionStatus: String {
        workbench.list.error != nil ? String(localized: "待重连", bundle: .riffet) : String(localized: "同步中", bundle: .riffet)
    }

    @ViewBuilder private var sessionList: some View {
        let visible = sessions
        // What needs the reader, then what is still working, lead the list; a pinned session that
        // is running shows among the running ones and returns to 置顶 when it settles.
        let waiting = visible.filter { $0.state == .waiting }
        let running = visible.filter { $0.state != .waiting && $0.state.isActive }
        let settled = visible.filter { $0.state != .waiting && !$0.state.isActive }
        let pinned = settled.filter { $0.pinnedAt != nil }
        let recent = settled.filter { $0.pinnedAt == nil }
        ScrollViewReader { proxy in
            List {
                controlsHeader.id(Self.topID)
                    .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
                Group {
                    if !waiting.isEmpty { groupHeader(String(localized: "待处理", bundle: .riffet)); ForEach(waiting, id: \.id) { row($0) } }
                    if !running.isEmpty { groupHeader(String(localized: "运行中", bundle: .riffet)); ForEach(running, id: \.id) { row($0) } }
                    if !pinned.isEmpty { groupHeader(String(localized: "置顶", bundle: .riffet)); ForEach(pinned, id: \.id) { row($0) } }
                    if grouping == .project && scope == nil {
                        ForEach(workbench.list.projects.filter { project in recent.contains { $0.projectId == project.id } }, id: \.id) { project in
                            let items = recent.filter { $0.projectId == project.id }
                            projectHeader(project, count: items.count)
                            if !collapsedProjects.contains(project.id) { ForEach(items, id: \.id) { row($0) } }
                        }
                        let unknown = recent.filter { workbench.project($0.projectId) == nil }
                        if !unknown.isEmpty { groupHeader(String(localized: "其他会话", bundle: .riffet)); ForEach(unknown, id: \.id) { row($0) } }
                    } else {
                        ForEach(timeGroups(recent), id: \.title) { group in
                            groupHeader(group.title)
                            ForEach(group.items, id: \.id) { row($0) }
                        }
                    }
                }
                if visible.isEmpty {
                    Group {
                        if workbench.list.loading && !workbench.list.loaded {
                            ProgressView { Text("正在读取会话…").riffetFont(.body).foregroundStyle(palette.fg2) }
                        } else {
                            Text(query.isEmpty ? (filter == .waiting ? "没有待处理的请求" : "没有会话") : "没有匹配的会话")
                                .riffetFont(.body).foregroundStyle(palette.fg2).multilineTextAlignment(.center)
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
            .onChange(of: scrollToTop) { _, _ in withAnimation(RiffetMotion.spatial) { proxy.scrollTo(Self.topID, anchor: .top) } }
        }
    }
    /// 项目 ▾ opens the project sheet; with a project picked it shows its name, highlighted.
    private var projectChip: some View {
        let picked = workbench.project(scope)
        return Button { showingProjects = true } label: {
            HStack(spacing: 4) {
                Text(picked?.name ?? String(localized: "项目", bundle: .riffet)).lineLimit(1).frame(maxWidth: 140)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
            .riffetFont(.label).foregroundStyle(picked == nil ? palette.fg2 : palette.fg)
            .padding(.horizontal, 15).frame(minHeight: RiffetMetrics.chipHeight).fixedSize()
            .background {
                Capsule().fill(palette.bg)
                Capsule().fill(picked == nil ? palette.press : palette.selected)
            }
            .frame(minHeight: RiffetMetrics.hitTarget)
        }
        .buttonStyle(RiffetDimPressStyle()).accessibilityLabel("项目").accessibilityIdentifier("sessionProjectFilter")
    }
    /// The status chips lead the list and scroll with it; a tag filter and a sync failure follow as quiet lines.
    @ViewBuilder private var controlsHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 0) {
                projectChip.padding(.leading, RiffetMetrics.pageInset).zIndex(1)
                // The bar insets its chips by the page margin; pull it back so they follow the project chip closely.
                RiffetChipBar(items: filters.map { .init(value: $0, title: $0.title) }, selection: $filter)
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
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "wifi.exclamationmark").font(.system(size: 16, weight: .medium)).foregroundStyle(palette.warning).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text("无法同步会话").riffetFont(.label).foregroundStyle(palette.fg)
                Text(AppModel.connectionMessage(error)).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Button("重试") { workbench.refresh() }
                .riffetFont(.label).foregroundStyle(palette.accent)
                .padding(.horizontal, 14).frame(minHeight: 32).background(palette.press, in: Capsule())
                .frame(minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
                .buttonStyle(RiffetDimPressStyle())
        }
        .padding(.leading, 14).padding(.trailing, 10).padding(.vertical, 6)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: RiffetMetrics.groupRadius, style: .continuous))
        .padding(.horizontal, RiffetMetrics.pageInset)
    }
    var body: some View {
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
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: String(localized: "搜索会话、项目与消息", bundle: .riffet))
            .refreshable { await workbench.refreshAndWait() }
            .toolbar { homeToolbar }
            // Connection status only shows while the list is not live.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !isConnected {
                    HStack(spacing: 6) {
                        Circle().fill(palette.warning).frame(width: 6, height: 6)
                        Text(connectionStatus).lineLimit(1)
                    }.riffetFont(.caption).foregroundStyle(palette.fg2)
                        .padding(.horizontal, 12).frame(minHeight: 28)
                        .riffetGlass(in: Capsule())
                        .frame(maxWidth: .infinity).padding(.bottom, 6)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(connectionStatus)，服务器 \(workbench.baseURL.host ?? "Mac")")
                }
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
        TextField("用逗号分隔", text: $tags)
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
                Picker("分组方式", selection: $grouping) { ForEach(HomeGrouping.allCases, id: \.self) { Text($0.title).tag($0) } }
                if let project = workbench.project(scope) {
                    Menu(project.name, systemImage: "ellipsis.circle") { projectLinks(project) }
                }
                Menu("按标签筛选", systemImage: "tag") {
                    Button("所有标签") { tag = nil }
                    ForEach(availableTags, id: \.self) { value in Button { tag = value } label: { if tag == value { Label(value, systemImage: "checkmark") } else { Text(value) } } }
                }.disabled(availableTags.isEmpty)
                if scope != nil || tag != nil || filter != .all { Button("清除筛选") { scope = nil; tag = nil; filter = .all } }
                Button(String(localized: "全部标为已读", bundle: .riffet), systemImage: "checkmark.circle") { Task { await workbench.markAllSeen() } }
            } label: { Image(systemName: "ellipsis") }.accessibilityLabel("筛选与分组")
        }
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
            Image(systemName: collapsed ? "chevron.right" : "chevron.down").font(.system(size: 11, weight: .semibold)).frame(width: 12)
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
        withAnimation(.easeInOut(duration: 0.2)) {
            if collapsedProjects.contains(id) { collapsedProjects.remove(id) } else { collapsedProjects.insert(id) }
        }
        UserDefaults.standard.set(Array(collapsedProjects), forKey: preferenceKey + "collapsedProjects")
    }
    /// What the new-session page does not offer: files, changes and the terminal live there.
    @ViewBuilder private func projectLinks(_ project: Project) -> some View {
        NavigationLink { ProjectCheckpoints(workbench: workbench, project: project, refresh: 0) } label: { Label(gitText("Checkpoints"), systemImage: "clock.arrow.circlepath") }
        NavigationLink { ProjectWorktrees(workbench: workbench, project: project, refresh: 0) } label: { Label(gitText("Worktrees"), systemImage: "arrow.triangle.branch") }
    }
    /// Project, tags and draft on one quiet line; whatever does not fit is truncated.
    private func rowMeta(_ session: Session) -> String {
        var parts: [String] = []
        if scope == nil { parts.append(workbench.project(session.projectId)?.name ?? String(localized: "项目", bundle: .riffet)) }
        if !session.tags.isEmpty { parts.append(session.tags.prefix(2).map { "#" + $0 }.joined(separator: " ")) }
        if workbench.drafts.hasContent("session.\(session.id)") { parts.append(String(localized: "草稿", bundle: .riffet)) }
        if session.state == .failed, let reason = session.error?.split(whereSeparator: \.isNewline).first.map(String.init), !reason.isEmpty { parts.append(reason) }
        return parts.joined(separator: " · ")
    }
    /// Today the clock, yesterday its name, within a week the weekday, else month/day.
    private func timeText(_ session: Session) -> String {
        guard let date = ServerTime.date(SidebarModelKt.activityAt(session: session)) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(AppLocalization.shared.locale)) }
        if calendar.isDateInYesterday(date) { return String(localized: "昨天", bundle: .riffet) }
        if date >= calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: .now))! { return date.formatted(.dateTime.weekday(.abbreviated).locale(AppLocalization.shared.locale)) }
        let parts = calendar.dateComponents([.month, .day], from: date)
        return "\(parts.month ?? 0)/\(parts.day ?? 0)"
    }
    private func avatarState(_ session: Session) -> AgentAvatarState {
        switch session.state {
        case .waiting: .waiting
        case .failed: .failed
        default: session.state.isActive ? .running : .idle
        }
    }
    /// A coloured status word where the session needs a look, then the quiet meta.
    private func subtitle(_ session: Session) -> Text? {
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
    private func row(_ session: Session) -> some View {
        let name = session.title.isEmpty ? String(localized: "未命名会话", bundle: .riffet) : session.title
        let time = timeText(session)
        return Button { onOpen(.session(session.id, session.state == .waiting)) } label: {
            HStack(spacing: 12) {
                AgentAvatar(backend: (session.backendId ?? .cursor).name, state: avatarState(session))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(name).riffetFont(.headline).foregroundStyle(session.archivedAt == nil ? palette.fg : palette.fg2).lineLimit(1)
                        Spacer(minLength: 0)
                        if openSessionID != session.id, SidebarModelKt.isDoneUnseen(session: session) {
                            Circle().fill(palette.fg).frame(width: 6, height: 6).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
                                .accessibilityLabel(String(localized: "未读", bundle: .riffet))
                        }
                        Text(time).riffetFont(.caption).foregroundStyle(palette.fg3).monospacedDigit()
                    }
                    if let line = subtitle(session) { line.riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1) }
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: RiffetMetrics.rowMinHeight, alignment: .leading)
            .background(openSessionID == session.id ? palette.selected : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(RiffetRowPressStyle(radius: 10))
        .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 10, style: .continuous))
        .hoverEffect(.highlight)
        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .accessibilityLabel([name, session.state.label, time].filter { !$0.isEmpty }.joined(separator: "，"))
        .accessibilityIdentifier("session.\(session.id)")
        .accessibilityAddTraits(openSessionID == session.id ? .isSelected : [])
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button(session.pinnedAt == nil ? "置顶" : "取消置顶", systemImage: "pin") { Task { await workbench.update(session, pinned: session.pinnedAt == nil) } }.tint(palette.accent)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(session.archivedAt == nil ? "归档" : "恢复", systemImage: "archivebox") { Task { await workbench.update(session, archived: session.archivedAt == nil) } }.tint(palette.fg3)
        }
        .contextMenu {
            Button("重命名", systemImage: "pencil") { title = session.title; renaming = session }
            Button("编辑标签", systemImage: "tag") { tags = session.tags.joined(separator: ", "); tagging = session }
            Button(session.pinnedAt == nil ? "置顶" : "取消置顶", systemImage: "pin") { Task { await workbench.update(session, pinned: session.pinnedAt == nil) } }
            Button(session.archivedAt == nil ? "归档" : "恢复", systemImage: "archivebox") { Task { await workbench.update(session, archived: session.archivedAt == nil) } }
            if workbench.list.canDeleteSessions {
                Button("删除…", systemImage: "trash", role: .destructive) { Task { await workbench.requestDeletion(session) } }.disabled(workbench.deletionLoading != nil)
            }
        }
    }
}

/// Shows or hides the tab bar as the page it sits in comes on screen, with UIKit's own animation,
/// so the bar leaves with a push and returns with the pop. SwiftUI's `.toolbar(.hidden, for: .tabBar)`
/// drops it at once and brings it back only after the pop has finished. During a back swipe the bar
/// waits for the swipe to commit; a cancelled swipe leaves it as it was.
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
            guard viewIfLoaded?.window != nil, let tabs = tabBarController, tabs.isTabBarHidden != hidden else { return }
            tabs.setTabBarHidden(hidden, animated: false)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
        override func loadView() { view = UIView(); view.isUserInteractionEnabled = false }
        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            guard let tabs = tabBarController, tabs.isTabBarHidden != hidden else { return }
            let hidden = hidden
            if let coordinator = transitionCoordinator, coordinator.isInteractive {
                coordinator.notifyWhenInteractionChanges { context in
                    if !context.isCancelled { tabs.setTabBarHidden(hidden, animated: true) }
                }
            } else {
                tabs.setTabBarHidden(hidden, animated: animated)
            }
        }
    }
}
