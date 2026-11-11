import AppKit
import SwiftUI
import RiffetKit

/// The drawn title bar of the content (`StyleSpec.header`), in place of the system toolbar:
/// `sessionTabs` lists the conversations opened in this window, `titleMenu` names the open one and
/// opens its menu. The controls are the toolbar's own (counts, panel, terminal, ⋯ menu); only the
/// arrangement differs. Its gaps move the window.
struct CustomHeader<Status: View>: View {
    let workbench: Workbench
    /// With the sidebar hidden the traffic lights sit over the header, and the sidebar's toggle comes here.
    let sidebarShown: Bool
    /// A plugin's runtime notice for the conversation, the toolbar's own view.
    @ViewBuilder let status: Status
    @Environment(\.palette) private var palette
    @State private var showingInfo = false
    @State private var titleAnchor = MenuAnchor()

    var body: some View {
        let style = DisplayPreferences.shared.style
        let conversation = sessionChrome ? workbench.selected : nil
        // A one-level page draws its own bar over this row (`pageChrome`): the row keeps its place,
        // so nothing below it moves, and only hides.
        let page = workbench.page
        VStack(spacing: 0) {
            HStack(spacing: Space.xs) {
                CustomHeaderLeading(workbench: workbench, sidebarShown: sidebarShown, style: style)
                switch style.header {
                case .sessionTabs:
                    SessionTabsBar(workbench: workbench, home: home, style: style)
                case .titleMenu:
                    title(style, conversation: conversation)
                    Spacer(minLength: Space.sm)
                case .toolbar:
                    Spacer(minLength: Space.sm)
                }
                trailing(style, conversation: conversation)
            }
            .padding(.horizontal, Space.sm)
            .frame(height: style.layout.header)
            .opacity(page == nil ? 1 : 0)
            .allowsHitTesting(page == nil)
            .accessibilityHidden(page != nil)
            .background { WindowDragArea() }
            if style.header == .titleMenu {
                Rectangle().fill(palette.headerRule).frame(height: 1)
            }
        }
        // Above the content a title bar paints its own; inside a card or a column it has their colour.
        .background(style.header == .titleMenu && style.window != .insetCard ? palette.page.opacity(DisplayPreferences.shared.contentTint) : .clear)
        .onChange(of: conversation?.id) { _, _ in showingInfo = false }
    }

    /// A conversation is the page (not the home page, a one-level page or an attempt group).
    private var sessionChrome: Bool {
        !workbench.showingHome && workbench.page == nil && workbench.attemptGroupSelection == nil
    }

    /// The new-conversation page fills the content.
    private var home: Bool {
        workbench.page == nil && workbench.attemptGroupSelection == nil && (workbench.showingHome || workbench.selected == nil)
    }

    private var inspectorTab: Binding<InspectorTab> {
        Binding(get: { workbench.inspector.tab }, set: { tab in workbench.setInspector { $0.tab = tab } })
    }

    private var inspectorOpen: Binding<Bool> {
        Binding(get: { workbench.inspector.open }, set: { workbench.setInspectorOpen($0) })
    }

    // MARK: Title

    @ViewBuilder
    private func title(_ style: StyleSpec, conversation: Session?) -> some View {
        if let conversation {
            SessionMenu(
                workbench: workbench, session: conversation, inspectorTab: inspectorTab, inspectorOpen: inspectorOpen,
                label: AnyView(titleLabel(conversation, style: style)), anchor: titleAnchor, panelsInHeader: true
            )
        } else if home {
            titleText(String(localized: "新会话"), style: style, color: palette.fg3)
        }
    }

    private func titleText(_ text: String, style: StyleSpec, color: Color) -> some View {
        Text(text)
            .font(.riffet(size: S(style.text.body), weight: .medium))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 6)
    }

    private func titleLabel(_ session: Session, style: StyleSpec) -> some View {
        HStack(spacing: 6) {
            if let agent = session.agent {
                AgentIcon(id: agent, size: S(style.text.body), color: agentMarkColor(agent, palette) ?? palette.fg3)
            }
            Text(session.title.isEmpty ? String(localized: "新会话") : session.title)
                .font(.riffet(size: S(style.text.body), weight: .medium))
                .foregroundStyle(palette.fg)
                .lineLimit(1)
            // The menu opens under the chevron.
            Image(icon: "chevron.down")
                .font(.riffet(size: S(style.text.label - 3), weight: .semibold))
                .foregroundStyle(palette.fg3)
                .background(MenuAnchorView(anchor: titleAnchor))
        }
        .padding(.horizontal, 6)
        .frame(height: CustomChrome.control(style))
    }

    // MARK: Controls

    /// What comes and goes stays on the leading side, so the panel buttons and ⋯ keep their place.
    @ViewBuilder
    private func trailing(_ style: StyleSpec, conversation: Session?) -> some View {
        let quickChat = workbench.quickChatContext
        let titleMenu = style.header == .titleMenu
        HStack(spacing: 2) {
            if conversation != nil, !quickChat {
                status
                if !titleMenu { SessionWorkActions(workbench: workbench) }
            }
            if workbench.page == nil, !quickChat {
                switch style.header {
                case .titleMenu:
                    panelButtons(conversation: conversation, style: style)
                    // The header keeps the panels of the app's own; the rest waits behind ⋯.
                    SessionWorkActions(workbench: workbench, more: moreItems(conversation: conversation), size: CustomChrome.control(style))
                case .sessionTabs, .toolbar:
                    if let conversation { infoButton(conversation, style: style) }
                    inspectorButton(style)
                }
            }
            // The title menu's own title opens this menu; one instance, one set of its sheets and reads.
            if let conversation, style.header != .titleMenu {
                SessionMenu(workbench: workbench, session: conversation, inspectorTab: inspectorTab, inspectorOpen: inspectorOpen)
            }
        }
        .fixedSize()
    }

    /// The view the panel shows: the stored one, or the first on offer when that one is not.
    private func shownPanel(_ views: [InspectorViewEntry]) -> InspectorTab? {
        let tab = workbench.inspector.tab
        return views.contains { $0.tab == tab } ? tab : views.first?.tab
    }

    private func inspectorButton(_ style: StyleSpec) -> some View {
        // With one icon per panel, each icon lights up for its own panel.
        let state = workbench.inspector
        let own = style.header == .titleMenu && shownPanel(workbench.inspectorViews) != nil
        return Button { workbench.toggleInspector() } label: { Image(icon: "sidebar.right") }
            .buttonStyle(IconButtonStyle(size: CustomChrome.control(style), active: state.open && !own))
            .help("变更与文件 (⌥⌘I)")
            .accessibilityLabel("变更与文件 (⌥⌘I)")
    }

    private func infoButton(_ session: Session, style: StyleSpec) -> some View {
        Button { showingInfo.toggle() } label: { Image(icon: "info.circle") }
            .buttonStyle(IconButtonStyle(size: CustomChrome.control(style), active: showingInfo))
            .help("会话信息")
            .accessibilityLabel("会话信息")
            .stylePopover(isPresented: $showingInfo, arrowEdge: .bottom) {
                SessionTitleView(workbench: workbench, session: session)
                    .padding(Space.md)
            }
    }

    /// The terminal and the built-in panel views (changes, files), one icon each: the panels Claude
    /// Desktop also opens from its header. Plugin views and the panel's own toggles are in ⋯.
    @ViewBuilder
    private func panelButtons(conversation: Session?, style: StyleSpec) -> some View {
        let state = workbench.inspector
        let size = CustomChrome.control(style)
        let shown = shownPanel(workbench.inspectorViews)
        if workbench.currentProject != nil {
            Button { workbench.terminalDock.toggle() } label: { Image(icon: "terminal") }
                .buttonStyle(IconButtonStyle(size: size, active: workbench.terminalDock.shown))
                .help("显示/隐藏终端")
                .accessibilityLabel("显示/隐藏终端")
        }
        ForEach(headerViews(conversation: conversation)) { view in
            Button { togglePanel(view.tab) } label: { Image(icon: panelSymbol(view)) }
                .buttonStyle(IconButtonStyle(size: size, active: state.open && view.tab == shown))
                .help(view.title)
                .accessibilityLabel(view.title)
        }
    }

    /// The panel views with an icon of their own in the header.
    private func headerViews(conversation: Session?) -> [InspectorViewEntry] {
        workbench.inspectorViews.filter { $0.tab == .files || ($0.tab == .changes && conversation != nil) }
    }

    /// ⋯ after the conversation's work: the plugin views, then the panel and its full-screen toggle.
    private func moreItems(conversation: Session?) -> [HeaderMoreItem] {
        let state = workbench.inspector
        let shown = shownPanel(workbench.inspectorViews)
        let builtIn = Set(headerViews(conversation: conversation).map(\.tab))
        var items = workbench.inspectorViews.filter { !builtIn.contains($0.tab) && $0.tab != .changes }.map { view in
            HeaderMoreItem(title: view.title, symbol: panelSymbol(view), on: state.open && view.tab == shown) { togglePanel(view.tab) }
        }
        if conversation != nil {
            items.append(HeaderMoreItem(title: String(localized: "面板"), symbol: "sidebar.right", on: state.open, shortcut: ("i", [.option, .command])) {
                workbench.toggleInspector()
            })
        }
        if state.open {
            items.append(HeaderMoreItem(title: String(localized: "全屏"), symbol: "arrow.up.left.and.arrow.down.right", on: workbench.inspectorMaximized, shortcut: ("f", [.option, .command])) {
                workbench.toggleInspectorMaximized()
            })
        }
        return items
    }

    /// The built-in views keep the icons this header drew for them; a plugin's is its declared one.
    private func panelSymbol(_ view: InspectorViewEntry) -> String {
        switch view.tab {
        case .changes: "plus.forwardslash.minus"
        case .files: "folder"
        default: view.symbol
        }
    }
}

/// The header's leading edge with the sidebar hidden: room for the traffic lights, then the toggle
/// that brings the sidebar back. Nothing while the sidebar is shown.
struct CustomHeaderLeading: View {
    let workbench: Workbench
    let sidebarShown: Bool
    let style: StyleSpec

    var body: some View {
        if !sidebarShown {
            Color.clear.frame(width: CustomChrome.trafficLights(style) - Space.sm - (style.window == .insetCard ? Space.sm : 0))
            Button { NotificationCenter.default.post(name: .riffetToggleSidebar, object: workbench) } label: {
                Image(icon: "sidebar.left")
            }
            .buttonStyle(IconButtonStyle(size: CustomChrome.control(style)))
            .help("显示/隐藏侧栏")
            .accessibilityLabel("显示/隐藏侧栏")
        }
    }
}

/// A one-level page's title and actions in a drawn window: the header's row, drawn by the page over
/// the hidden header so the actions sit where the conversation's controls do.
struct CustomPageBar<Actions: View>: View {
    let workbench: Workbench
    let title: String
    @ViewBuilder let actions: Actions
    @Environment(\.palette) private var palette
    @Environment(\.customSidebarShown) private var sidebarShown

    var body: some View {
        let style = DisplayPreferences.shared.style
        VStack(spacing: 0) {
            HStack(spacing: Space.xs) {
                CustomHeaderLeading(workbench: workbench, sidebarShown: sidebarShown, style: style)
                Text(title)
                    .font(.riffet(size: S(style.text.body), weight: .medium))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                Spacer(minLength: Space.sm)
                actions.fixedSize()
            }
            .padding(.horizontal, Space.sm)
            .frame(height: style.layout.header)
            .background { WindowDragArea() }
            if style.header == .titleMenu {
                Rectangle().fill(palette.headerRule).frame(height: 1)
            }
            // The page rose past the workbench's own (`WorkbenchView.coverRise`).
            ServiceAlertBanner()
        }
    }
}

extension CustomHeader {
    /// A panel's icon opens its panel, and closes it when it is the one on screen.
    fileprivate func togglePanel(_ tab: InspectorTab) {
        let state = workbench.inspector
        if state.open && state.tab == tab { workbench.setInspectorOpen(false) } else { workbench.showInspector(tab) }
    }
}

/// A button that opens an AppKit menu built at that moment, with any label (the toolbar's
/// `ToolbarMenuButton` is an icon only).
struct MenuLabelButton: View {
    let label: AnyView
    /// Where the menu opens, when the label marks a part of itself for it; under the label otherwise.
    var anchor: MenuAnchor?
    let build: () -> NSMenu
    @State private var own = MenuAnchor()

    var body: some View {
        Button { (anchor ?? own).popUp(build()) } label: { label.contentShape(Rectangle()) }
            .buttonStyle(HoverRowStyle())
            .background { if anchor == nil { MenuAnchorView(anchor: own) } }
    }
}

// MARK: Session tabs

/// The conversations opened in this window, as tabs. The list is kept on this Mac per server, not in
/// the view, so switching the style or relaunching keeps it; closing the last tab goes home.
private struct SessionTabsBar: View {
    let workbench: Workbench
    let home: Bool
    let style: StyleSpec
    @Environment(\.palette) private var palette
    @AppStorage private var stored: String
    @State private var index = SessionIndex()

    /// Opening one more drops the oldest.
    private static var limit: Int { 12 }

    init(workbench: Workbench, home: Bool, style: StyleSpec) {
        self.workbench = workbench
        self.home = home
        self.style = style
        _stored = AppStorage(wrappedValue: "", "riffet.session-tabs|\(workbench.baseURL.absoluteString)")
    }

    private var ids: [String] { stored.split(separator: "\n").map(String.init) }

    /// The tab on screen: none on the home page, a one-level page or an attempt group.
    private var current: String? {
        workbench.showingHome || workbench.page != nil || workbench.attemptGroupSelection != nil ? nil : workbench.selected?.id
    }

    var body: some View {
        let ids = self.ids
        let current = self.current
        let shown = visible(ids)
        // A clicked tab lights up at once; the conversation follows a frame later, as from the sidebar.
        let picked = workbench.sidebar.picked
        HStack(spacing: Space.xs) {
            HStack(spacing: 2) {
                ForEach(shown, id: \.id) { session in
                    tab(session, active: isActive(session.id, picked: picked, current: current))
                }
                Button { workbench.showHome() } label: { Image(icon: "plus") }
                    .buttonStyle(IconButtonStyle(size: CustomChrome.control(style)))
                    .help("新会话 (⌘N)")
                    .accessibilityLabel("新会话 (⌘N)")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if home {
                HomeModeTabs(workbench: workbench, style: style)
                    .fixedSize()
                // The same flexible width on both sides keeps the switch near the middle.
                Color.clear.frame(maxWidth: .infinity)
            }
        }
        .onChange(of: current, initial: true) { _, id in if let id { add(id) } }
        .onChange(of: ObjectIdentifier(workbench.list), initial: true) { _, _ in prune() }
    }

    private func isActive(_ id: String, picked: String?, current: String?) -> Bool {
        if let picked { return picked == id }
        return id == current
    }

    private func tab(_ session: Session, active: Bool) -> SessionTab {
        let id = session.id
        return SessionTab(
            session: session, active: active, style: style,
            open: { workbench.sidebar.pick(id, clicked: true) }, close: { close(id) }
        )
    }

    /// The tabs whose conversation is known, in tab order; the open one is its freshest copy.
    private func visible(_ ids: [String]) -> [Session] {
        guard !ids.isEmpty else { return [] }
        let byId = index.sessions(workbench.list)
        let selected = workbench.selected
        return ids.compactMap { id in selected?.id == id ? selected : byId[id] }
    }

    private func add(_ id: String) {
        var ids = self.ids
        guard !ids.contains(id) else { return }
        ids.append(id)
        if ids.count > Self.limit { ids.removeFirst(ids.count - Self.limit) }
        stored = ids.joined(separator: "\n")
    }

    /// A conversation the server no longer lists loses its tab, once a fresh list has loaded: never
    /// on a cached or loading list, which may simply not have it yet.
    private func prune() {
        let list = workbench.list
        guard list.loaded, !list.loading, list.cachedAt == nil, list.error == nil else { return }
        let ids = self.ids
        let byId = index.sessions(list)
        let kept = ids.filter { byId[$0] != nil || $0 == workbench.selected?.id }
        if kept.count != ids.count { stored = kept.joined(separator: "\n") }
    }

    /// Closing the tab on screen opens its visible neighbour, or the home page after the last one.
    private func close(_ id: String) {
        let shown = visible(ids).map(\.id)
        stored = ids.filter { $0 != id }.joined(separator: "\n")
        guard id == current, let position = shown.firstIndex(of: id) else { return }
        let rest = shown.filter { $0 != id }
        if rest.isEmpty {
            workbench.showHome()
        } else {
            workbench.sidebar.pick(rest[min(position, rest.count - 1)], clicked: true)
        }
    }
}

/// The list's conversations by id, rebuilt only when the list itself is replaced.
@MainActor
private final class SessionIndex {
    private var source: ObjectIdentifier?
    private var byId: [String: Session] = [:]

    func sessions(_ list: SessionListState) -> [String: Session] {
        let key = ObjectIdentifier(list)
        if key != source {
            source = key
            byId = Dictionary(list.sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        }
        return byId
    }
}

private struct SessionTab: View, Equatable {
    let session: Session
    let active: Bool
    let style: StyleSpec
    let open: () -> Void
    let close: () -> Void
    @Environment(\.palette) private var palette
    @State private var hovering = false

    static func == (lhs: SessionTab, rhs: SessionTab) -> Bool {
        lhs.session == rhs.session && lhs.active == rhs.active && lhs.style == rhs.style
    }

    private var title: String { session.title.isEmpty ? String(localized: "新会话") : session.title }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
        HStack(spacing: 6) {
            switch session.state {
            case .running, .starting, .cancelling:
                Spinner(size: .mini).frame(width: 12, height: 12)
            default:
                SessionAgentMark(backend: session.agent)
            }
            CappedWidth(maximum: 200) {
                Text(title)
                    .font(.riffet(size: S(style.text.secondary), weight: active ? .medium : .regular))
                    .foregroundStyle(active ? palette.fg : palette.fg2)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            ZStack {
                if hovering || active {
                    Button(action: close) {
                        Image(icon: "xmark").font(.riffet(size: S(style.text.label - 3), weight: .semibold))
                    }
                    .buttonStyle(IconButtonStyle(size: 18))
                    .help("关闭")
                } else if session.state == .waiting {
                    Circle().fill(palette.warning).frame(width: 6, height: 6)
                } else if session.state == .failed {
                    Circle().fill(palette.danger).frame(width: 6, height: 6)
                }
            }
            .frame(width: 18, height: 18)
        }
        .padding(.leading, 10)
        .padding(.trailing, 5)
        .frame(height: style.layout.header - 2 * Space.sm + 2)
        .background(shape.fill(active ? palette.bgElevated : hovering ? palette.bgHover : .clear))
        .overlay { if active { shape.strokeBorder(palette.line, lineWidth: 1) } }
        .contentShape(shape)
        .onTapGesture(perform: open)
        .onHover { hovering = $0 }
        .help(title)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { open() }
        .accessibilityAction(named: Text("关闭"), close)
    }
}

/// Its content at the width it wants, up to [maximum]; narrower when the row runs out of room.
/// A `frame(maxWidth:)` would grow every tab to the maximum instead.
private struct CappedWidth: Layout {
    let maximum: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = min(proposal.width ?? maximum, maximum)
        return subviews.first?.sizeThatFits(ProposedViewSize(width: width, height: proposal.height)) ?? .zero
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}

/// 新建任务 | 快速对话 on the home page's tab bar: the toolbar's segmented switch, as text tabs.
private struct HomeModeTabs: View {
    let workbench: Workbench
    let style: StyleSpec
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.lg) {
            UnderlineTab(title: String(localized: "新建任务"), selected: !workbench.homeIsQuickChat, style: style) {
                workbench.showHomeTab(quickChat: false)
            }
            UnderlineTab(title: String(localized: "快速对话"), selected: workbench.homeIsQuickChat, style: style) {
                workbench.showHomeTab(quickChat: true)
            }
            .disabled(workbench.quickChatProject == nil)
        }
    }
}

/// A text tab of a drawn header, underlined while it is the one shown.
struct UnderlineTab: View {
    let title: String
    let selected: Bool
    let style: StyleSpec
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.riffet(size: S(style.text.body), weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? palette.fg : palette.fg3)
                .padding(.vertical, 6)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(selected ? palette.fg : .clear).frame(height: 2)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
