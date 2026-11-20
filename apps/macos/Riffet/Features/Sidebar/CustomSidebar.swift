import AppKit
import SwiftUI
import RiffetKit

/// The sidebar of the drawn styles (`StyleSpec.backend == .custom`): a header, the main actions, a
/// scrolling list of conversations and a footer, all drawn here instead of by `List(.sidebar)`. The
/// data and the actions are the native sidebar's: `WorkbenchSidebar`'s groups and buckets, the same
/// row menu, hover card and page routing. The window's chrome paints the column behind it.
struct CustomSidebar: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @Environment(\.customSidebarPeeking) private var peeking
    @AppStorage(WorkbenchSidebar.collapsedProjectsKey) private var collapsed = ""
    @AppStorage(WorkbenchSidebar.collapsedTimeGroupsKey) private var collapsedTime = ""
    @State private var renaming: Session?
    @State private var renameText = ""
    @State private var taggingSession: Session?
    @State private var browsing = false
    @State private var addError: String?
    @State private var favorites = FolderFavoritesModel()
    @State private var customAnchor = MenuAnchor()
    @State private var moreAnchor = MenuAnchor()
    @Environment(\.openSettings) private var openSettings

    init(workbench: Workbench) { self.workbench = workbench }

    var body: some View {
        let style = DisplayPreferences.shared.style
        // The chrome is the style's; the list is the arrangement the reader picked.
        let treeChrome = style.sidebar != .timeGroups
        let tree = workbench.sidebar.layout == "PROJECT"
        VStack(spacing: 0) {
            if treeChrome { treeHeader(style) } else { timeHeader(style) }
            if treeChrome { treeActions(style) } else { timeActions(style) }
            list(style, tree: tree)
            CustomSidebarFooter(workbench: workbench, style: style)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Opening a project at a favorite stamps it on the server; the list moves with the projects.
        .task(id: workbench.projects.map(\.id)) { await favorites.load(workbench.host.api) }
        .sidebarDialogs(
            workbench: workbench, renaming: $renaming, renameText: $renameText,
            tagging: $taggingSession, browsing: $browsing, addError: $addError
        )
    }

    // MARK: Header

    private func toggleButton() -> some View {
        Button { NotificationCenter.default.post(name: .riffetToggleSidebar, object: workbench) } label: {
            Image(icon: peeking ? "pin" : "sidebar.left")
        }
        .buttonStyle(IconButtonStyle())
        .help(peeking ? LocalizedStringKey("固定侧边栏") : LocalizedStringKey("收起/展开侧栏"))
        .accessibilityLabel(peeking ? LocalizedStringKey("固定侧边栏") : LocalizedStringKey("收起/展开侧栏"))
    }

    /// The top row runs level with the traffic lights (`CustomChrome.titleRow`).
    private func headerHeight(_ style: StyleSpec) -> CGFloat { CustomChrome.titleRow(style) }

    private func treeHeader(_ style: StyleSpec) -> some View {
        HStack(spacing: Space.sm) {
            Button { workbench.showHome() } label: {
                HStack(spacing: Space.sm) {
                    BrandMark(front: palette.fg, back: palette.accent)
                        .frame(width: S(style.text.body + 6), height: S(style.text.body + 6))
                    Text(verbatim: "Riffet")
                        .font(.riffet(size: S(style.text.body + 1), weight: .semibold))
                        .foregroundStyle(palette.fg)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("新会话 (⌘N)")
            Spacer(minLength: 0)
            toggleButton()
        }
        // Clear of the traffic lights by twice their own spacing, so the mark does not read as a
        // fourth button; a fixed gap, as the sidebar's width changes.
        .padding(.leading, CustomChrome.trafficLights(style) + Space.sm)
        .padding(.trailing, Space.md)
        .frame(height: headerHeight(style))
    }

    private func timeHeader(_ style: StyleSpec) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.xs) {
                toggleButton()
                Spacer(minLength: 0)
            }
            .padding(.leading, CustomChrome.trafficLights(style) + Space.xs)
            .padding(.trailing, Space.md)
            .frame(height: headerHeight(style))
            CustomModeSwitch(workbench: workbench, style: style)
                .padding(.horizontal, Space.sm)
        }
    }

    // MARK: Actions

    private var destinations: (pinned: [WorkbenchPage], more: [WorkbenchPage]) { workbench.sidebarDestinations }

    /// [page]'s row is drawn selected: the page is open, or a click picked it and it opens next frame.
    private func shows(_ page: WorkbenchPage) -> Bool {
        workbench.sidebar.picked.map { $0 == "page:" + page.rawValue } ?? workbench.shows(page)
    }

    private func treeActions(_ style: StyleSpec) -> some View {
        VStack(spacing: Space.xxs) {
            CustomNavRow(symbol: "square.and.pencil", title: String(localized: "新会话"), style: style) { workbench.showHome() }
                .help("新会话 (⌘N)")
            CustomNavRow(symbol: "magnifyingglass", title: String(localized: "搜索内容"), trailing: "⌘K", style: style) {
                workbench.sidebar.searchRequested = .titles
            }
            .help("搜索内容 (⌘K)")
            ForEach(destinations.pinned, id: \.self) { page in
                CustomNavRow(symbol: page.symbol, title: page.title, selected: shows(page), mark: page == .assistant ? AnyView(AssistantStatusMark(workbench: workbench)) : nil, style: style) {
                    workbench.sidebar.pick("page:" + page.rawValue, clicked: true)
                }
                .help(page.shortcutLabel.map { "\(page.title) (\($0))" } ?? page.title)
            }
            ForEach(workbench.webSidebarDestinations.pinned, id: \.self) { page in
                CustomNavRow(symbol: page.symbol, title: page.title, mark: AnyView(
                    Image(icon: "arrow.up.right.square").font(.riffet(size: S(style.text.label))).foregroundStyle(palette.fg4)
                ), style: style) {
                    WebHandoff.open(page.webPage, in: workbench)
                }
            }
            CustomNavRow(symbol: "ellipsis", title: String(localized: "更多"), selected: destinations.more.contains(where: shows), anchor: moreAnchor, style: style) {
                workbench.popUpSidebarMore(moreAnchor, openSettings: openSettings)
            }
        }
        .padding(.horizontal, Space.sm)
        .padding(.bottom, Space.sm)
    }

    private func timeActions(_ style: StyleSpec) -> some View {
        VStack(spacing: Space.xxs) {
            CustomNavRow(symbol: "plus", title: String(localized: "新会话"), selected: workbench.showingHome && workbench.page == nil, style: style) {
                workbench.showHome()
            }
            .help("新会话 (⌘N)")
            CustomNavRow(symbol: "magnifyingglass", title: String(localized: "搜索"), style: style) {
                workbench.sidebar.searchRequested = .titles
            }
            .help("搜索内容 (⌘K)")
            CustomNavRow(symbol: "briefcase", title: String(localized: "自定义"), anchor: customAnchor, style: style) {
                showPages([.plugins, .extensions], at: customAnchor)
            }
            CustomNavRow(symbol: "ellipsis", title: String(localized: "更多"), anchor: moreAnchor, style: style) {
                showPages([.assistant, .tasks, .marks, .stats, .activity], at: moreAnchor)
            }
        }
        .padding(.horizontal, Space.sm)
        .padding(.top, Space.sm + Space.xxs)
    }

    /// Archive and tag filters, at a fixed place whatever the list holds. The time layout has no
    /// project header, so its menu also adds a project.
    private func filterButton(addProject: Bool) -> some View {
        SidebarFilterButton {
            SidebarFilterMenu.make(
                workbench: workbench,
                addProject: addProject ? { SidebarProjects.add(workbench: workbench, browsing: $browsing, error: $addError) } : nil
            )
        }
    }


    private func showPages(_ pages: [WorkbenchPage], at anchor: MenuAnchor) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        var chosen: (() -> Void)?
        for page in pages {
            menu.addItem(MenuAction.item(page.title, symbol: page.symbol) { chosen = { workbench.show(page) } })
        }
        _ = anchor.popUp(menu)
        chosen?()
    }

    // MARK: List

    private func list(_ style: StyleSpec, tree: Bool) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    tagChip(style)
                    if tree { projectRows(style) } else if style.sidebar == .projectTree { bucketRows(style) } else { timeRows(style) }
                }
                .padding(.horizontal, Space.sm)
                .padding(.bottom, Space.md)
            }
            .scrollIndicators(.automatic)
            // Focus by keyboard only: a click on a row or a header leaves the composer its focus.
            .focusable(interactions: .activate)
            .focusEffectDisabled()
            .onKeyPress(.upArrow) { move(-1, proxy: proxy); return .handled }
            .onKeyPress(.downArrow) { move(1, proxy: proxy); return .handled }
            .onKeyPress(.return) {
                NotificationCenter.default.post(name: .riffetFocusComposer, object: workbench)
                return .handled
            }
            .onDeleteCommand {
                // The row's menu (or the archived rows) brings it back.
                if !workbench.showingHome, let session = workbench.selected, session.archivedAt == nil {
                    Task { await workbench.update(session, archived: true) }
                }
            }
        }
    }

    @ViewBuilder private func tagChip(_ style: StyleSpec) -> some View {
        if !workbench.sidebar.tag.isEmpty {
            HStack(spacing: 4) {
                Image(icon: "tag").font(.riffet(size: S(style.text.label - 2)))
                Text(workbench.sidebar.tag).font(.riffet(size: S(style.text.label)))
                Button { workbench.sidebar.tag = "" } label: { Image(icon: "xmark").font(.riffet(size: S(style.text.label - 4), weight: .bold)) }
                    .buttonStyle(.plain)
                    .help("清除筛选")
                    .accessibilityLabel("清除筛选")
            }
            .foregroundStyle(palette.accent)
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .padding(.leading, Space.sm)
            .padding(.vertical, Space.xs)
        }
    }

    // MARK: Project tree

    @ViewBuilder private func projectRows(_ style: StyleSpec) -> some View {
        CustomSectionTitle(title: String(localized: "项目"), style: style) { listButtons() }
        if workbench.sidebar.groups.isEmpty {
            VStack(spacing: Space.sm) {
                Text(workbench.sidebar.tag.isEmpty ? "还没有项目" : "没有匹配的结果")
                    .font(.riffet(size: S(style.text.secondary))).foregroundStyle(palette.fg3)
                if workbench.sidebar.tag.isEmpty {
                    Button { SidebarProjects.add(workbench: workbench, browsing: $browsing, error: $addError) } label: { Label("添加项目", icon: "folder.badge.plus") }.buttonStyle(SolidButtonStyle(kind: .secondary))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Space.xl)
        }
        ForEach(projectLines(style)) { entry in line(entry, style: style) }
    }

    private func projectLines(_ style: StyleSpec) -> [SidebarLine] {
        let hidden = Set(collapsed.split(separator: ",").map(String.init))
        let tree = style.sidebar == .projectTree
        var lines: [SidebarLine] = []
        for group in workbench.sidebar.groups {
            let open = group.forceOpen || !hidden.contains(group.project.id)
            lines.append(.project(group, open: open))
            guard open else { continue }
            let slice = workbench.sidebar.slice(for: group)
            lines += slice.sessions.map { .session($0, indented: tree, timed: tree) }
            if slice.hiddenCount > 0 { lines.append(.expand(group, hidden: slice.hiddenCount)) }
            else if slice.canCollapse { lines.append(.collapse(group)) }
            if group.sessions.isEmpty { lines.append(.empty(group)) }
        }
        return lines
    }

    /// The list's filter and add-project buttons, on its first label.
    private func listButtons() -> some View {
        HStack(spacing: Space.xxs) {
            filterButton(addProject: false)
            Button { SidebarProjects.add(workbench: workbench, browsing: $browsing, error: $addError) } label: { Image(icon: "folder.badge.plus") }
                .buttonStyle(IconButtonStyle(size: 24))
                .help("添加项目")
                .accessibilityLabel("添加项目")
        }
    }

    // MARK: Time buckets

    /// The project tree's time layout, as the web lays it out: every conversation under light labels
    /// (置顶, 进行中, 今天…), the first carrying the list's buttons.
    @ViewBuilder private func bucketRows(_ style: StyleSpec) -> some View {
        let buckets = workbench.sidebar.buckets
        if buckets.isEmpty {
            CustomSectionTitle(title: String(localized: "会话"), style: style) { listButtons() }
            if !workbench.sidebar.tag.isEmpty {
                Text("没有匹配的结果")
                    .font(.riffet(size: S(style.text.secondary))).foregroundStyle(palette.fg3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Space.xl)
            }
        }
        ForEach(bucketLines(buckets)) { entry in line(entry, style: style) }
    }

    private func bucketLines(_ buckets: [TimeBucket]) -> [SidebarLine] {
        var lines: [SidebarLine] = []
        for (index, bucket) in buckets.enumerated() where !bucket.sessions.isEmpty {
            lines.append(.label(bucket.label, first: index == 0))
            lines += bucket.sessions.map { .session($0, indented: false, timed: true) }
        }
        return lines
    }

    // MARK: Time groups

    @ViewBuilder private func timeRows(_ style: StyleSpec) -> some View {
        let sections = workbench.sidebar.timeSections
        // The filter menu holds 添加项目 and 显示已归档: it stays reachable with no band to carry it.
        if sections.isEmpty {
            CustomSectionTitle(title: "", style: style, buttonsOnHover: false) { filterButton(addProject: true) }
        }
        if sections.isEmpty, !workbench.sidebar.tag.isEmpty {
            Text("没有匹配的结果")
                .font(.riffet(size: S(style.text.secondary))).foregroundStyle(palette.fg3)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.xl)
        }
        ForEach(timeLines(sections)) { entry in line(entry, style: style) }
    }

    private func timeLines(_ sections: [WorkbenchSidebar.TimeSection]) -> [SidebarLine] {
        let folded = Set(collapsedTime.split(separator: ",").map(String.init))
        // The filters sit on the first band past the pinned one, where the list's order starts.
        let filtered = sections.first { $0.band != .pinned }?.id ?? sections.first?.id
        var lines: [SidebarLine] = []
        for section in sections {
            let open = !folded.contains(section.id)
            lines.append(.band(section, open: open, filters: section.id == filtered))
            guard open else { continue }
            let visible = workbench.sidebar.shown(section)
            lines += visible.sessions.map { .session($0, indented: false, timed: false) }
            if visible.more { lines.append(.more) }
        }
        return lines
    }

    /// The list's rows, one flat `ForEach` for every band and project. Nested ones lost updates: in a
    /// lazy stack, an `.equatable()` row that moved from one inner `ForEach` to another (a
    /// conversation going up to 最近 as it opened) kept drawing what it showed before, so the
    /// conversations picked earlier stayed selected.
    @ViewBuilder private func line(_ line: SidebarLine, style: StyleSpec) -> some View {
        switch line {
        case let .band(section, open, filters):
            CustomGroupTitle(title: section.title, expanded: open, style: style, toggle: {
                collapsedTime = toggleCollapsed(raw: collapsedTime, id: section.id)
            }) {
                if filters { filterButton(addProject: true) }
            }
            .padding(.top, style.layout.sidebarGap)
        case let .label(title, first):
            CustomSectionTitle(title: title, style: style) { if first { listButtons() } }
        case .more:
            CustomLinkRow(symbol: nil, title: String(localized: "显示更多"), style: style) { workbench.sidebar.showAllEarlier = true }
        case let .project(group, open):
            CustomProjectRow(
                workbench: workbench, project: group.project, favorites: favorites, expanded: open, style: style,
                toggle: { collapsed = toggleCollapsed(raw: collapsed, id: group.project.id) }
            )
            .padding(.top, style.layout.sidebarGap)
        case let .expand(group, hidden):
            CustomLinkRow(symbol: "ellipsis", title: String(localized: "展开其余 \(hidden) 个会话"), style: style) {
                workbench.sidebar.expandedProjects.insert(group.project.id)
            }
        case let .collapse(group):
            CustomLinkRow(symbol: "chevron.up", title: String(localized: "收起历史会话"), style: style) {
                workbench.sidebar.expandedProjects.remove(group.project.id)
            }
        case .empty:
            Text("暂无会话").font(.riffet(size: S(style.text.secondary))).foregroundStyle(palette.fg4)
                .padding(.leading, Space.sm + Space.xxs + 16 + Space.sm)
                .frame(height: style.layout.sidebarRow)
        case let .session(session, indented, timed):
            sessionRow(session, style: style, indented: indented, timed: timed)
        }
    }

    // MARK: Rows

    private func sessionRow(_ session: Session, style: StyleSpec, indented: Bool, timed: Bool) -> some View {
        let project = workbench.project(session.projectId)
        let now = Int64(workbench.minute.timeIntervalSince1970 * 1000)
        return CustomSessionRow(
            session: session,
            info: { sessionHoverInfo(session: session, project: project?.name, models: workbench.catalogs.cached(for: session)?.models ?? [], now: now) },
            selected: workbench.sidebarRowSelected(session),
            indented: indented,
            activity: timed ? relativeLabel(value: activityAt(session: session), now: now) : nil,
            style: style,
            menu: workbench.sidebarRowMenu(for: session, rename: { renameText = session.title; renaming = session }, editTags: { taggingSession = session }),
            hover: { hovering in workbench.hover(sessionId: session.id, entered: hovering) },
            open: { workbench.sidebar.pick(session.id, clicked: true) }
        )
        .equatable()
        .id(session.id)
    }

    // MARK: Keyboard

    private func move(_ delta: Int, proxy: ScrollViewProxy) {
        let order = workbench.sidebar.visibleOrder
        guard !order.isEmpty else { return }
        let current = workbench.sidebar.picked ?? (workbench.page == nil && !workbench.showingHome ? workbench.selected?.id : nil)
        let next: Int
        if let index = order.firstIndex(where: { $0.id == current }) {
            next = min(max(index + delta, 0), order.count - 1)
        } else {
            next = delta > 0 ? 0 : order.count - 1
        }
        let id = order[next].id
        workbench.sidebar.pick(id, clicked: false)
        proxy.scrollTo(id)
    }
}

/// The filter button. Each place it appears (the project tree's title, a time band's) owns its
/// anchor: switching the arrangement swaps one for the other, and a shared anchor would be left
/// pointing at the one that went away.
private struct SidebarFilterButton: View {
    let menu: () -> NSMenu
    @State private var anchor = MenuAnchor()

    var body: some View {
        Button { anchor.popUp(menu()) } label: { Image(icon: "line.3.horizontal.decrease") }
            .buttonStyle(IconButtonStyle())
            .background(MenuAnchorView(anchor: anchor))
            .help("排列方式、归档与标签")
    }
}

/// A line of the drawn sidebar's list (`CustomSidebar.line`).
private enum SidebarLine: Identifiable {
    case band(WorkbenchSidebar.TimeSection, open: Bool, filters: Bool)
    case label(String, first: Bool)
    case more
    case project(ProjectGroup, open: Bool)
    case expand(ProjectGroup, hidden: Int)
    case collapse(ProjectGroup)
    case empty(ProjectGroup)
    case session(Session, indented: Bool, timed: Bool)

    var id: String {
        switch self {
        case let .band(section, _, _): "band:" + section.id
        case let .label(title, _): "label:" + title
        case .more: "more"
        case let .project(group, _): "project:" + group.project.id
        case let .expand(group, _): "expand:" + group.project.id
        case let .collapse(group): "collapse:" + group.project.id
        case let .empty(group): "empty:" + group.project.id
        case let .session(session, _, _): session.id
        }
    }
}
