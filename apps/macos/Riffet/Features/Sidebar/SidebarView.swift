import AppKit
import QuartzCore
import SwiftUI
import RiffetKit

/// The conversation list, grouped through the shared `SidebarModel.kt`.
struct SidebarView: View {
    @Bindable var workbench: Workbench
    @Environment(\.palette) private var palette
    @AppStorage(WorkbenchSidebar.collapsedProjectsKey) private var collapsed = ""
    @State private var renaming: Session?
    @State private var renameText = ""
    @State private var taggingSession: Session?
    @State private var browsing = false
    @State private var addError: String?
    /// The host's favorite folders, for the project headers' 收藏 item.
    @State private var favorites = FolderFavoritesModel()
    @State private var moreAnchor = MenuAnchor()
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        // The footer sits below the list rather than over it: rows never scroll under its text.
        VStack(spacing: 0) {
            header
            list
            SidebarFooter(workbench: workbench)
        }
        .background(palette.bgSidebar.opacity(DisplayPreferences.shared.sidebarTint))
    }

    /// The brand, search and pages stay put above the list; only the conversations scroll.
    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The mark leads home, as in most apps; the toolbar's compose button stays the explicit one.
            Button { workbench.showHome() } label: {
                // The mark sits on the icon column's axis and the name on the titles' column below.
                HStack(spacing: Space.sm) {
                    BrandMark(front: palette.fg, back: palette.fg4)
                        .frame(width: S(18), height: S(18))
                        .frame(width: 12)
                    Text(verbatim: "Riffet")
                        .font(.riffet(size: S(14), weight: .semibold))
                        .foregroundStyle(palette.fg)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Space.xs + Space.xxs)
                .padding(.vertical, Space.xs)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("新会话 (⌘N)")
            // The list's own filter rides in the sidebar, so it leaves with the list instead of
            // blinking out of the toolbar when the column folds.
            .overlay(alignment: .trailing) {
                MenuLabelButton(label: AnyView(
                    Image(icon: "line.3.horizontal.decrease")
                        .font(.riffet(size: S(13)))
                        .foregroundStyle(palette.fg3)
                        .frame(width: 26, height: 26)
                ), build: displayMenu)
                .help("排列方式、归档与标签")
                .accessibilityLabel("排列方式、归档与标签")
            }
            .padding(.bottom, Space.sm)
            SidebarFixedRow(action: { workbench.sidebar.searchRequested = .titles }) {
                navigationLabel(String(localized: "搜索内容"), symbol: "magnifyingglass")
                Spacer(minLength: 0)
                Text("⌘K").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
            }
            .help("搜索内容 (⌘K)")
            ForEach(destinations.pinned, id: \.self) { page in
                SidebarFixedRow(selected: shows(page), action: { selection.wrappedValue = Self.pageTag(page) }) {
                    navigationLabel(page.title, symbol: page.symbol, selected: shows(page))
                    Spacer(minLength: 0)
                    if page == .assistant { AssistantStatusMark(workbench: workbench) }
                }
                .help(page.shortcutLabel.map { "\(page.title) (\($0))" } ?? page.title)
            }
            ForEach(workbench.webSidebarDestinations.pinned, id: \.self) { page in
                SidebarFixedRow(action: { WebHandoff.open(page.webPage, in: workbench) }) {
                    navigationLabel(page.title, symbol: page.symbol)
                    Spacer(minLength: 0)
                    Image(icon: "arrow.up.right.square").font(RiffetFont.caption).foregroundStyle(palette.fg4)
                }
            }
            let moreOpen = destinations.more.contains(where: shows)
            SidebarFixedRow(selected: moreOpen, action: { workbench.popUpSidebarMore(moreAnchor, openSettings: openSettings) }) {
                navigationLabel(String(localized: "更多"), symbol: "ellipsis", selected: moreOpen)
                Spacer(minLength: 0)
            }
            .background { MenuAnchorView(anchor: moreAnchor) }
        }
        .padding(.horizontal, Space.sm + Space.xxs)
        .padding(.bottom, Space.sm)
    }

    private var list: some View {
        List(selection: selection) {
            if !workbench.sidebar.tag.isEmpty {
                HStack(spacing: 4) {
                    Image(icon: "tag").font(.riffet(size: S(10)))
                    Text(workbench.sidebar.tag).font(.riffet(size: S(11.5)))
                    Button { workbench.sidebar.tag = "" } label: { Image(icon: "xmark").font(.riffet(size: S(8), weight: .bold)) }
                        .buttonStyle(.plain)
                        .help("清除筛选")
                        .accessibilityLabel("清除筛选")
                }
                .foregroundStyle(palette.mark)
                .padding(.horizontal, 8)
                .frame(height: 22)
                .background(palette.markSoft, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .listRowSeparator(.hidden)
            }
            if workbench.sidebar.layout == "TIME" {
                ForEach(workbench.sidebar.buckets, id: \.label) { bucket in
                    Section {
                        ForEach(bucket.sessions, id: \.id) { row($0) }
                    } header: {
                        Text(bucket.label).font(.riffet(size: S(11), weight: .medium)).foregroundStyle(palette.fg4)
                    }
                }
            } else {
                if workbench.sidebar.groups.isEmpty {
                    VStack(spacing: Space.sm) {
                        Text(workbench.sidebar.tag.isEmpty ? "还没有项目" : "没有匹配的结果")
                            .font(.riffet(size: S(12.5))).foregroundStyle(palette.fg3)
                        if workbench.sidebar.tag.isEmpty {
                            Button { SidebarProjects.add(workbench: workbench, browsing: $browsing, error: $addError) } label: { Label("添加项目", icon: "folder.badge.plus") }.buttonStyle(SolidButtonStyle(kind: .secondary))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Space.xl)
                }
                ForEach(workbench.sidebar.groups, id: \.project.id) { group in
                    Section(isExpanded: expansion(group)) {
                        let slice = workbench.sidebar.slice(for: group)
                        ForEach(slice.sessions, id: \.id) { row($0) }
                        if slice.hiddenCount > 0 {
                            Button {
                                workbench.sidebar.expandedProjects.insert(group.project.id)
                            } label: {
                                HStack(spacing: Space.sm) {
                                    Image(icon: "ellipsis")
                                        .font(.riffet(size: S(10), weight: .semibold))
                                        .foregroundStyle(palette.fg4)
                                        .frame(width: 12, height: 12)
                                    Text("展开其余 \(slice.hiddenCount) 个会话")
                                        .font(.riffet(size: S(12)))
                                        .foregroundStyle(palette.fg3)
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 2)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        } else if slice.canCollapse {
                            Button {
                                workbench.sidebar.expandedProjects.remove(group.project.id)
                            } label: {
                                HStack(spacing: Space.sm) {
                                    Image(icon: "chevron.up")
                                        .font(.riffet(size: S(9.5), weight: .semibold))
                                        .foregroundStyle(palette.fg4)
                                        .frame(width: 12, height: 12)
                                    Text("收起历史会话")
                                        .font(.riffet(size: S(12)))
                                        .foregroundStyle(palette.fg3)
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 2)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        if group.sessions.isEmpty {
                            Text("暂无会话").font(.riffet(size: S(12))).foregroundStyle(palette.fg4).padding(.leading, 20)
                        }
                    } header: {
                        ProjectHeader(workbench: workbench, project: group.project, favorites: favorites)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .onDeleteCommand {
            // The row's menu (or the archived rows) brings it back.
            if !workbench.showingHome, let session = workbench.selected, session.archivedAt == nil {
                Task { await workbench.update(session, archived: true) }
            }
        }
        .scrollContentBackground(.hidden)
        .environment(\.sidebarRowSize, .small)
        .background(SidebarListAppearance())
        // Opening a project at a favorite stamps it on the server; the list moves with the projects.
        .task(id: workbench.projects.map(\.id)) { await favorites.load(workbench.host.api) }
        .toolbar {
            if ImageViewer.shared.item == nil {
                // Bare, both here and beside the traffic lights once the column folds: a glass
                // capsule would only appear at the end of the fold, and the button would jump into it.
                if #available(macOS 26, *) { ToolbarSpacer(.flexible) }
                ToolbarItem {
                    Button { workbench.showHome() } label: {
                        // The square sits low under the pen's tip: lifted a point, it lines up with
                        // the traffic lights and the sidebar button beside it.
                        Label { Text("新会话") } icon: { Image(icon: "square.and.pencil").offset(y: -1) }
                    }
                    .help("新会话 (⌘N)")
                }
                .hideSharedToolbarBackground()
                // The system's own toggle, redrawn so it can stay bare like the button beside it; it
                // sends the same action, so the fold animates exactly as the system's does.
                ToolbarItem {
                    Button { NSApp.sendAction(#selector(NSSplitViewController.toggleSidebar(_:)), to: nil, from: nil) } label: {
                        Label("显示/隐藏侧栏", icon: "sidebar.left")
                    }
                    .help("显示/隐藏侧栏 (⌘B)")
                }
                .hideSharedToolbarBackground()
            }
        }
        .toolbar(removing: .sidebarToggle)
        .sidebarDialogs(
            workbench: workbench, renaming: $renaming, renameText: $renameText,
            tagging: $taggingSession, browsing: $browsing, addError: $addError
        )
    }

    private func displayMenu() -> NSMenu {
        SidebarFilterMenu.make(workbench: workbench)
    }

    private static func pageTag(_ page: WorkbenchPage) -> String { "page:" + page.rawValue }

    private var destinations: (pinned: [WorkbenchPage], more: [WorkbenchPage]) { workbench.sidebarDestinations }

    /// [page]'s row is drawn selected: the page is open, or a click picked it and it opens next frame.
    private func shows(_ page: WorkbenchPage) -> Bool {
        workbench.sidebar.picked.map { $0 == Self.pageTag(page) } ?? workbench.shows(page)
    }

    /// The icon sits in the session rows' 12pt mark column, so titles line up with theirs.
    private func navigationLabel(_ title: String, symbol: String, selected: Bool = false) -> some View {
        HStack(spacing: Space.sm) {
            Image(icon: symbol).frame(width: 12, alignment: .center)
                .foregroundStyle(selected ? palette.fg : palette.fg3)
            Text(title).foregroundStyle(selected ? palette.fg : palette.fg2)
        }
        .font(.riffet(size: S(12.5), weight: selected ? .medium : .regular))
    }

    private var selection: Binding<String?> {
        Binding(
            get: {
                if let picked = workbench.sidebar.picked { return picked }
                if let page = workbench.page { return Self.pageTag(page) }
                // The assistant's conversation is not a list row: the destination row shows it.
                if workbench.onAssistantPage { return Self.pageTag(.assistant) }
                return workbench.showingHome || workbench.attemptGroupSelection != nil ? nil : workbench.selected?.id
            },
            set: { id in
                guard let id else { return }
                let clicked = NSApp.currentEvent.map { [.leftMouseDown, .leftMouseUp].contains($0.type) } ?? false
                workbench.sidebar.pick(id, clicked: clicked)
            }
        )
    }

    private func expansion(_ group: ProjectGroup) -> Binding<Bool> {
        Binding(
            get: { group.forceOpen || !collapsed.split(separator: ",").contains(Substring(group.project.id)) },
            set: { _ in collapsed = toggleCollapsed(raw: collapsed, id: group.project.id) }
        )
    }

    private func row(_ session: Session) -> some View {
        let project = workbench.project(session.projectId)
        let selected = workbench.sidebarRowSelected(session)
        return SessionRow(
            session: session,
            info: sessionHoverInfo(session: session, project: project?.name, models: workbench.catalogs.cached(for: session)?.models ?? [], now: Int64(workbench.minute.timeIntervalSince1970 * 1000)),
            selected: selected,
            unread: UnreadStore.shared.isUnread(session) && !selected,
            menu: workbench.sidebarRowMenu(for: session, rename: { renameText = session.title; renaming = session }, editTags: { taggingSession = session }),
            hover: { hovering in workbench.hover(sessionId: session.id, entered: hovering) }
        )
        .equatable()
        .tag(session.id)
        .listRowBackground(selected ? SidebarSelectionBackground() : nil)
    }
}

/// A row's context menu actions; they never make two rows differ.
struct SessionRowMenu {
    let togglePin: () -> Void
    let rename: () -> Void
    let editTags: (() -> Void)?
    let reveal: (() -> Void)?
    let toggleArchive: () -> Void
    let openInWindow: () -> Void
    /// Nil when the server cannot delete; the closure says whether the entry is enabled (its preview is loading).
    let delete: (() -> Void)?
    var deleteEnabled = true
    /// The tabs, while the header draws them: the row can add its conversation to the bar or take it out.
    var tabs: SessionTabs?
}

/**
 * What a sidebar row no longer spends width on — the project, the agent and the last activity —
 * composed for its hover card. The relative label is in the text (not just the clock), so a
 * row's card ages at the same minute tick the list already re-renders on.
 */
@MainActor func sessionHoverInfo(session: Session, project: String?, models: [ModelInfo], now: Int64) -> SessionHoverInfo {
    let at = activityAt(session: session)
    let when = [relativeLabel(value: at, now: now) ?? "", formatDateTime(value: at) ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    // The stored model is a raw selection (`…[context=1m,effort=high]`); the card repeats the
    // picker's own summary — the catalog name plus its translated parameter tags — never the spec.
    let model = session.model.map { modelSelectionSummary(catalog: models, selection: $0) } ?? ""
    return SessionHoverInfo(
        title: session.shownTitle.isEmpty ? String(localized: "新会话") : session.shownTitle,
        state: session.state,
        project: project,
        backend: session.agentID,
        agent: backendLabel(session.agentID),
        model: model.isEmpty ? nil : model,
        activity: when.isEmpty ? String(localized: "更早") : when
    )
}

/// One conversation in the sidebar: its state, its title and its tags. The project and the
/// relative time it used to carry live in the hover card (see `sessionHoverInfo`), which
/// keeps a grouped list to one quiet line per conversation. Rows compare by what they show, so
/// re-rendering the list re-measures only the rows that changed: each row is a self-sizing
/// hosting view, and measuring all of them on every switch cost tens of milliseconds.
struct SessionRow: View, Equatable {
    let session: Session
    /// The hover card's text, composed only as the card is about to show: lists re-render their rows
    /// on every switch, and composing it for each row (model names, times) was most of that cost.
    let info: () -> SessionHoverInfo
    var selected = false
    /// Work finished here since the reader last had it open (never true for the open one).
    var unread = false
    /// The row's relative activity, when the surface shows it beside the title (the quick-chat page).
    var activity: String?
    /// The conversation has a saved reply.
    var marked = false
    /// A quick chat: its menu keeps only the actions that apply to one.
    var quickChat = false
    var menu: SessionRowMenu?
    /// The pointer entered (true) or left the row.
    var hover: ((Bool) -> Void)?
    @Environment(\.palette) private var palette
    @State private var anchorBox = HoverAnchorBox()

    init(session: Session, info: @autoclosure @escaping () -> SessionHoverInfo, selected: Bool = false, unread: Bool = false, activity: String? = nil, marked: Bool = false, quickChat: Bool = false, menu: SessionRowMenu? = nil, hover: ((Bool) -> Void)? = nil) {
        self.session = session
        self.info = info
        self.selected = selected
        self.unread = unread
        self.activity = activity
        self.marked = marked
        self.quickChat = quickChat
        self.menu = menu
        self.hover = hover
    }

    static func == (lhs: SessionRow, rhs: SessionRow) -> Bool {
        lhs.session == rhs.session && lhs.selected == rhs.selected && lhs.unread == rhs.unread && lhs.activity == rhs.activity
            && lhs.marked == rhs.marked && lhs.quickChat == rhs.quickChat
    }

    var body: some View {
        HStack(spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 1) {
                Text(session.shownTitle.isEmpty ? String(localized: "新会话") : session.shownTitle)
                    .font(.riffet(size: S(13), weight: unread ? .semibold : selected ? .medium : .regular))
                    .lineLimit(1)
                    .foregroundStyle(session.archivedAt != nil ? palette.fg3 : selected || unread ? palette.fg : palette.fg2)
                if !quickChat, !session.tags.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(session.tags.prefix(3), id: \.self) { tag in
                            Text(tag).padding(.horizontal, 4).background(selected ? palette.markSoft : palette.bgMuted, in: RoundedRectangle(cornerRadius: Radius.control))
                        }
                    }
                    .font(.riffet(size: S(10.5)))
                    .foregroundStyle(selected ? palette.fg3 : palette.fg4)
                }
            }
            Spacer(minLength: 0)
            if let activity {
                Text(activity)
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(palette.fg4)
                    .lineLimit(1)
            }
            if SessionStatePill.shows(session.state, unread: unread) {
                SessionStatePill(state: session.state)
            } else if SessionStatePill.running(session.state) {
                Spinner(size: .mini).help("运行中").accessibilityLabel("运行中")
            } else if unread {
                Circle().fill(palette.fg).frame(width: 6, height: 6).accessibilityLabel("未读")
            } else if session.terminalHold != nil {
                Image(icon: "terminal")
                    .font(.riffet(size: S(10)))
                    .foregroundStyle(palette.fg4)
                    .help("在终端中")
            } else if marked {
                Image(icon: "bookmark.fill")
                    .font(.riffet(size: S(10)))
                    .foregroundStyle(palette.fg4)
            }
        }
        .padding(.vertical, session.tags.isEmpty || quickChat ? 2 : 1)
        .contentShape(Rectangle())
        .sessionRowHover(box: anchorBox, info: info) { hover?($0) }
        .contextMenu {
            if let menu { SessionRowMenuItems(session: session, menu: menu, quickChat: quickChat) }
        }
    }
}

/// A row above the sidebar's list, drawn like one of its rows: the selected wash, a lighter one on hover.
private struct SidebarFixedRow<Content: View>: View {
    var selected = false
    let action: () -> Void
    @ViewBuilder let content: Content
    @Environment(\.palette) private var palette
    @Environment(\.appearsActive) private var appearsActive
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.xs) { content }
                .padding(.horizontal, Space.xs + Space.xxs)
                .frame(maxWidth: .infinity, minHeight: 26, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                        .fill(selected ? (appearsActive ? palette.bgActive : palette.bgHover) : hovering ? palette.bgHover : .clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// Applied to the List's direct row, outside its Equatable content, so SwiftUI forwards the row trait.
/// The one selected-row look for every sidebar (the workbench's and Settings'), matching the web's
/// `bg-active`: a neutral wash, no outline — an outline reads as keyboard focus, and the accent is kept
/// for states that ask for attention.
struct SidebarSelectionBackground: View {
    @Environment(\.palette) private var palette
    /// An inactive window quiets the wash to the hover tone, as AppKit's source lists do.
    @Environment(\.appearsActive) private var appearsActive

    var body: some View {
        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
            .fill(appearsActive ? palette.bgActive : palette.bgHover)
            // List row backgrounds span the full sidebar; keep the highlight inside its chrome
            // without changing the native content insets or reducing the text's available width.
            .padding(.horizontal, Space.sm + Space.xxs)
    }
}

/// Running spins, waiting asks for attention, a failure not yet seen is red; idle conversations show nothing.
struct SessionStateMark: View {
    let state: SessionState
    @Environment(\.palette) private var palette

    /// Whether the state is one the row calls out. A failure once seen is told in the conversation
    /// itself, not on the row (docs/design/DECISIONS.md 2026-11-17).
    static func shows(_ state: SessionState, unread: Bool) -> Bool {
        [.running, .starting, .cancelling, .waiting].contains(state) || state == .failed && unread
    }

    var body: some View {
        Group {
            switch state {
            case .running, .starting, .cancelling:
                Spinner(size: .mini)
            case .waiting:
                Circle().fill(palette.warning).frame(width: 7, height: 7)
            case .failed:
                Circle().fill(palette.danger).frame(width: 7, height: 7)
            default:
                Color.clear.frame(width: 7, height: 7)
            }
        }
        .frame(width: 12, height: 12)
    }
}

/// What a sidebar row says in words: only the states that need the reader. Running is the agent
/// mark breathing, not a word or a spinner (docs/design/macos-native.md 1.2).
struct SessionStatePill: View {
    let state: SessionState
    @Environment(\.palette) private var palette
    @Environment(\.appearsActive) private var appearsActive

    /// A failure only until it is seen, as `SessionStateMark.shows`.
    static func shows(_ state: SessionState, unread: Bool) -> Bool { state == .waiting || state == .failed && unread }
    static func running(_ state: SessionState) -> Bool { [.running, .starting, .cancelling].contains(state) }

    var body: some View {
        let tint = !appearsActive ? palette.fg3 : state == .failed ? palette.danger : palette.warning
        Text(state == .failed ? String(localized: "出错") : String(localized: "待确认"))
            .font(.riffet(size: S(10.5), weight: .medium))
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .frame(height: 16)
            .background(tint.opacity(0.12), in: Capsule())
            .fixedSize()
    }
}

/// The agent a conversation runs on, in its own colour.
struct SessionAgentMark: View {
    let backend: String?
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            if let backend {
                AgentIcon(id: backend, size: 12, color: agentMarkColor(backend, palette) ?? palette.fg3)
            } else {
                Color.clear
            }
        }
        .frame(width: 12, height: 12)
    }
}

struct ProjectHeader: View {
    let workbench: Workbench
    let project: Project
    let favorites: FolderFavoritesModel
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        HStack(spacing: Space.xs + 2) {
            Text(project.name).font(.riffet(size: S(11), weight: .medium)).foregroundStyle(palette.fg3).lineLimit(1)
            if let worktree = project.worktree {
                Text(worktree.branch).font(.riffet(size: S(10), design: .monospaced)).foregroundStyle(palette.fg4).lineLimit(1)
            }
            ForEach((project.tags ?? []).prefix(2), id: \.self) { tag in
                Text(tag).font(.riffet(size: S(10))).foregroundStyle(palette.fg4).padding(.horizontal, 4).background(palette.bgMuted, in: RoundedRectangle(cornerRadius: Radius.control))
            }
            Spacer()
            Button {
                if project.isTaskWorkspace { workbench.selectHomeProject(nil); workbench.showHome() }
                else { workbench.showHome(projectId: project.id) }
            } label: { Image(icon: "plus").font(.riffet(size: S(10.5), weight: .semibold)) }
                .buttonStyle(IconButtonStyle(size: 20))
                .opacity(hovering ? 1 : 0)
                .help("在 \(project.name) 中新建会话")
                .accessibilityLabel("在 \(project.name) 中新建会话")
        }
        .opacity(project.archivedAt == nil ? 1 : 0.6)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .projectActions(workbench: workbench, project: project, favorites: favorites)
    }
}

struct SidebarFooter: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme
    @State private var menuAnchor = MenuAnchor()
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        HStack {
            Button { SidebarFooterSupport.popUp(menuAnchor, scheme: scheme, workbench: workbench, openSettings: openSettings) } label: {
                OwnerAvatar(workbench: workbench, size: Space.xl)
                    .overlay(alignment: .bottomTrailing) {
                        if SidebarFooterSupport.unhealthy(workbench) || workbench.backendNotice != nil {
                            Circle()
                                .fill(palette.warning)
                                .frame(width: Space.sm, height: Space.sm)
                                .overlay(Circle().strokeBorder(palette.bgSidebar, lineWidth: 1))
                                .allowsHitTesting(false)
                        }
                    }
            }
            .buttonStyle(IconButtonStyle())
            .background(MenuAnchorView(anchor: menuAnchor))
            .help(SidebarFooterSupport.menuHelp(workbench))
            .accessibilityLabel(SidebarFooterSupport.menuHelp(workbench))
            Spacer(minLength: 0)
        }
        .padding(.leading, Space.md)
        .padding(.trailing, Space.xs)
        .frame(height: 36)
        .overlay(alignment: .top) { palette.lineSoft.frame(height: 1) }
        .padding(.horizontal, Space.sm)
        .padding(.bottom, Space.xs)
    }

}

/// Light, dark or the system's, then the palette; neither choice writes the other (the web's
/// theme menu). Shared by the sidebar footer's menu and 显示 ▸ 外观.
struct AppearanceMenuItems: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        @Bindable var prefs = DisplayPreferences.shared
        let theme = ThemeStore.shared
        Group {
            Picker("明暗", selection: $prefs.appearance) {
                Label("跟随系统", icon: "circle.lefthalf.filled").tag("system")
                Label("浅色", icon: "sun.max").tag("light")
                Label("深色", icon: "moon").tag("dark")
            }
            .pickerStyle(.inline)
            // Every item carries an image: a menu re-rendered while open otherwise re-lays out its
            // text column and the theme names jump sideways.
            Picker("主题", selection: Binding(
                get: { theme.entry.id },
                set: { id in if let entry = theme.choices.first(where: { $0.id == id }) { theme.choose(entry) } }
            )) {
                ForEach(theme.choices, id: \.id) { entry in
                    Label { Text(entry.name) } icon: { Image(nsImage: Self.swatch(scheme == .dark ? entry.values.dark : entry.values.light)) }
                        .tag(entry.id)
                }
            }
            .pickerStyle(.inline)
        }
    }

    /// The palette's background with its accent inside, as a menu-sized dot.
    static func swatch(_ palette: RiffetPaletteValues) -> NSImage {
        func color(_ rgba: RiffetRGBA) -> NSColor { NSColor(srgbRed: rgba.red, green: rgba.green, blue: rgba.blue, alpha: rgba.alpha) }
        let image = NSImage(size: NSSize(width: 14, height: 14), flipped: false) { rect in
            let outer = NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1))
            color(palette.bg).setFill()
            outer.fill()
            color(palette.fg).withAlphaComponent(0.25).setStroke()
            outer.lineWidth = 1
            outer.stroke()
            color(palette.accent).setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 4, dy: 4)).fill()
            return true
        }
        image.isTemplate = false
        return image
    }
}

/// Runs a block once the next frame is on screen, so what changed before it (a row drawn selected)
/// is shown before the block's work holds the main thread.
@MainActor
final class AfterNextFrame: NSObject {
    private var body: (() -> Void)?
    private var link: CADisplayLink?

    static func run(in view: NSView?, _ body: @escaping () -> Void) {
        guard let view, view.window != nil else { return body() }
        let runner = AfterNextFrame()
        runner.body = body
        // The link holds its target until it is invalidated.
        let link = view.displayLink(target: runner, selector: #selector(fire))
        runner.link = link
        link.add(to: .main, forMode: .common)
        // A window that gets no frames (fully covered) still opens what was picked.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { runner.fire() }
    }

    @objc private func fire() {
        link?.invalidate()
        link = nil
        let body = self.body
        self.body = nil
        body?()
    }
}

/// A click keeps keyboard focus in the composer; Tab and arrows still use native list selection.
/// SwiftUI supplies the theme-coloured row background so AppKit's inactive grey highlight must
/// not cover it when focus moves to the conversation or another window.
///
/// Settings passes `refusesFocus: false`: it has no composer to keep focus in, and its list is
/// walked with the arrow keys.
struct SidebarListAppearance: NSViewRepresentable {
    var refusesFocus = true

    func makeNSView(context: Context) -> NSView { Probe(refusesFocus: refusesFocus) }
    func updateNSView(_ nsView: NSView, context: Context) {}

    final class Probe: NSView {
        private let refusesFocus: Bool

        init(refusesFocus: Bool) {
            self.refusesFocus = refusesFocus
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil else { return }
            // The list's table is in the window only after this pass.
            DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.apply() } }
        }

        private func apply() {
            let frame = convert(bounds, to: nil)
            var ancestor = superview
            while let view = ancestor {
                if let table = Self.table(in: view, over: frame) {
                    if refusesFocus { table.refusesFirstResponder = true }
                    table.selectionHighlightStyle = .none
                    return
                }
                ancestor = view.superview
            }
        }

        /// The table under [frame]: the window holds others (the transcript) beside the list.
        private static func table(in view: NSView, over frame: NSRect) -> NSTableView? {
            if let table = view as? NSTableView, (table.enclosingScrollView ?? table).convert((table.enclosingScrollView ?? table).bounds, to: nil).intersects(frame) {
                return table
            }
            for child in view.subviews {
                if let table = table(in: child, over: frame) { return table }
            }
            return nil
        }
    }
}
