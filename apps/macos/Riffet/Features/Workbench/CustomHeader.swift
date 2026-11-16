import AppKit
import SwiftUI
import RiffetKit

/// The drawn title bar of the content (`StyleSpec.header`), in place of the system toolbar:
/// `sessionTabs` lists the conversations kept as tabs (or names the open one, with tabs off), `titleMenu` names the open one and
/// opens its menu. The controls are the toolbar's own (counts, panel, terminal, ⋯ menu); only the
/// arrangement differs. Its gaps move the window.
struct CustomHeader<Status: View>: View {
    let workbench: Workbench
    /// With the sidebar hidden the traffic lights sit over the header, and the sidebar's toggle comes here.
    let sidebarShown: Bool
    /// A plugin's runtime notice for the conversation, the toolbar's own view.
    @ViewBuilder let status: Status
    @Environment(\.palette) private var palette
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
                    if SessionTabsPreferences.shared.style == .titleBar {
                        SessionTabsBar(workbench: workbench, style: style)
                    } else {
                        title(style, conversation: conversation)
                        Spacer(minLength: Space.sm)
                    }
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
            if let agent = session.agent, !workbench.isAssistantMain(session) {
                AgentIcon(id: agent, size: S(style.text.body), color: agentMarkColor(agent, palette) ?? palette.fg3)
            }
            Text(workbench.isAssistantMain(session) ? String(localized: "个人助理") : session.title.isEmpty ? String(localized: "新会话") : session.title)
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
        HStack(spacing: 2) {
            // The work running in the conversation is in 会话信息, or in ⋯ beside a title menu.
            if conversation != nil, !quickChat { status }
            if workbench.page == nil, !quickChat {
                switch style.header {
                case .titleMenu:
                    panelButtons(conversation: conversation, style: style)
                    // The header keeps the panels of the app's own; the rest waits behind ⋯.
                    SessionWorkActions(workbench: workbench, more: moreItems(conversation: conversation), size: CustomChrome.control(style))
                case .sessionTabs, .toolbar:
                    if let conversation { SessionInfoButton(workbench: workbench, session: conversation, size: CustomChrome.control(style)) }
                    if !workbench.inspectorUnavailable { inspectorButton(style) }
                }
            } else if workbench.page == nil, home, style.header != .titleMenu {
                // The quick chat home keeps it, unusable: switching 新建任务 / 快速对话 does not move the tabs.
                inspectorButton(style).disabled(true)
            }
            // The title menu's own title opens this menu; one instance, one set of its sheets and reads.
            if let conversation, style.header != .titleMenu {
                SessionMenu(workbench: workbench, session: conversation, inspectorTab: inspectorTab, inspectorOpen: inspectorOpen, infoInHeader: true)
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

    /// The terminal and the built-in panel views (changes, files), one icon each: the panels Claude
    /// Desktop also opens from its header. Plugin views and the panel's own toggles are in ⋯.
    @ViewBuilder
    private func panelButtons(conversation: Session?, style: StyleSpec) -> some View {
        let state = workbench.inspector
        let size = CustomChrome.control(style)
        let shown = shownPanel(workbench.inspectorViews)
        if workbench.currentProject != nil, !workbench.assistantContext {
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

    /// ⋯ after the conversation's work: the plugin views, then the panel and a plugin view's full-screen toggle.
    private func moreItems(conversation: Session?) -> [HeaderMoreItem] {
        let state = workbench.inspector
        let shown = shownPanel(workbench.inspectorViews)
        let builtIn = Set(headerViews(conversation: conversation).map(\.tab))
        var items = workbench.inspectorViews.filter { !builtIn.contains($0.tab) && $0.tab != .changes }.map { view in
            HeaderMoreItem(title: view.title, symbol: panelSymbol(view), on: state.open && view.tab == shown) { togglePanel(view.tab) }
        }
        if conversation != nil, !workbench.inspectorUnavailable {
            items.append(HeaderMoreItem(title: String(localized: "面板"), symbol: "sidebar.right", on: state.open, shortcut: ("i", [.option, .command])) {
                workbench.toggleInspector()
            })
        }
        // The changes and files panels carry the toggle in their own bar; a plugin's view has none.
        if state.open, let shown, shown != .changes, shown != .files {
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

/// The conversations kept as tabs (`SessionTabs`), pinned ones first. Closing the last tab goes home;
/// when the tabs do not all fit, the rest are in the trailing menu.
private struct SessionTabsBar: View {
    let workbench: Workbench
    let style: StyleSpec
    @Environment(\.palette) private var palette
    @State private var model: SessionTabs
    @State private var available: CGFloat = 0
    @State private var renaming: Session?
    @State private var draft = ""

    /// The narrowest a tab gets before the next one goes to the menu.
    private static let minimumTabWidth: CGFloat = 96

    init(workbench: Workbench, style: StyleSpec) {
        self.workbench = workbench
        self.style = style
        let model = SessionTabs.model(for: workbench.baseURL)
        model.workbench = workbench
        _model = State(initialValue: model)
    }

    var body: some View {
        let zones = model.zones
        let all = zones.pinned + zones.normal
        let current = model.current
        // A clicked tab lights up at once; the conversation follows a frame later, as from the sidebar.
        let picked = workbench.sidebar.picked
        let control = CustomChrome.control(style)
        // Room for the tabs: the row less the new-conversation button and the menu's.
        let capacity = max(1, Int((available - 2 * (control + Space.xs)) / (Self.minimumTabWidth + 2)))
        let overflow = all.count > capacity
        let shown = overflow ? window(all, capacity: capacity, current: current) : all
        let separator = shown.last { $0.pinned }.flatMap { pin in shown.contains { !$0.pinned } ? pin.id : nil }
        HStack(spacing: Space.xs) {
            HStack(spacing: 2) {
                ForEach(shown) { item in
                    tab(item, active: picked.map { $0 == item.id } ?? (item.id == current))
                    if item.id == separator {
                        Rectangle().fill(palette.line).frame(width: 1, height: 16).padding(.horizontal, Space.xs)
                    }
                }
                Button { workbench.showHome() } label: { Image(icon: "plus") }
                    .buttonStyle(IconButtonStyle(size: control))
                    .help("新会话 (⌘N)")
                    .accessibilityLabel("新会话 (⌘N)")
                if overflow {
                    ChoiceMenu(options: all.map { item in
                        ChoiceOption(title: item.session.title.isEmpty ? String(localized: "新会话") : item.session.title, selected: item.id == current) {
                            model.activate(item.id)
                        }
                    }) {
                        Image(icon: "chevron.down")
                            .font(.riffet(size: S(style.text.label - 2), weight: .semibold))
                            .foregroundStyle(palette.fg3)
                            .frame(width: control, height: control)
                    }
                    .help("全部标签")
                    .accessibilityLabel("全部标签")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { available = $0 }
        }
        .onChange(of: current, initial: true) { _, _ in model.sync() }
        .onChange(of: ObjectIdentifier(workbench.list), initial: true) { _, _ in model.sync() }
        .alert("重命名会话", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("标题", text: $draft)
            Button("取消", role: .cancel) {}
            Button("保存") {
                let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                if let session = renaming, !title.isEmpty, title != session.title { Task { await workbench.update(session, title: title) } }
            }
        }
    }

    /// The first [capacity] tabs, with the open one in the last place when it is further on.
    private func window(_ all: [SessionTabItem], capacity: Int, current: String?) -> [SessionTabItem] {
        let head = Array(all.prefix(capacity))
        guard let current, !head.contains(where: { $0.id == current }), let open = all.first(where: { $0.id == current }) else { return head }
        return head.dropLast() + [open]
    }

    private func tab(_ item: SessionTabItem, active: Bool) -> SessionTab {
        let id = item.id
        let session = item.session
        return SessionTab(
            session: session, preview: item.entry.preview, pinned: item.pinned, unread: model.unread.contains(id), active: active, style: style,
            model: model,
            open: { model.activate(id) }, close: { model.close(id) },
            togglePin: { Task { await workbench.update(session, pinned: !item.pinned) } },
            rename: { draft = session.title; renaming = session }
        )
    }
}

private struct SessionTab: View, Equatable {
    let session: Session
    let preview: Bool
    let pinned: Bool
    let unread: Bool
    let active: Bool
    let style: StyleSpec
    let model: SessionTabs
    let open: () -> Void
    let close: () -> Void
    let togglePin: () -> Void
    let rename: () -> Void
    @Environment(\.palette) private var palette
    @State private var hovering = false

    static func == (lhs: SessionTab, rhs: SessionTab) -> Bool {
        lhs.session == rhs.session && lhs.preview == rhs.preview && lhs.pinned == rhs.pinned && lhs.unread == rhs.unread
            && lhs.active == rhs.active && lhs.style == rhs.style
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
            CappedWidth(maximum: active ? 280 : 160) {
                Text(title)
                    .font(.riffet(size: S(style.text.body), weight: .regular))
                    .foregroundStyle(active ? palette.fg : palette.fg3)
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
                } else if unread {
                    Circle().fill(style.ink == .quiet ? palette.fg : palette.accent).frame(width: 6, height: 6)
                }
            }
            .frame(width: 18, height: 18)
        }
        .padding(.leading, 10)
        .padding(.trailing, 5)
        .frame(height: style.layout.header - 2 * Space.sm + 2)
        .background(shape.fill(active ? palette.bgActive : hovering ? palette.bgHover : .clear))
        .overlay {
            if preview {
                shape.strokeBorder(active ? palette.fg4 : palette.line, style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
            }
        }
        .contentShape(shape)
        .onTapGesture(perform: open)
        // The first click of a double click already opened the tab; the second keeps it.
        .simultaneousGesture(TapGesture(count: 2).onEnded { model.keep(session.id) })
        .overlay { MiddleClick(action: close) }
        .contextMenu {
            if preview { Button("加入标签栏") { model.keep(session.id) } }
            Button(pinned ? "取消置顶" : "置顶会话", action: togglePin)
            Button("重命名", action: rename)
            Divider()
            Button("关闭", action: close)
            Button("关闭其他标签") { model.closeOthers(session.id) }
                .disabled(model.othersToClose(session.id).isEmpty)
            Button("关闭右侧标签") { model.closeRight(session.id) }
                .disabled(model.rightToClose(session.id).isEmpty)
        }
        .onHover { hovering = $0 }
        .help(title)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { open() }
        .accessibilityAction(named: Text("关闭"), close)
    }
}

/// Catches the middle button, which SwiftUI has no gesture for; every other event passes through.
private struct MiddleClick: NSViewRepresentable {
    let action: () -> Void

    final class Catcher: NSView {
        var action: () -> Void = {}

        override func hitTest(_ point: NSPoint) -> NSView? {
            guard let type = NSApp.currentEvent?.type, type == .otherMouseDown || type == .otherMouseUp else { return nil }
            return super.hitTest(point)
        }

        override func otherMouseUp(with event: NSEvent) {
            if event.buttonNumber == 2 { action() } else { super.otherMouseUp(with: event) }
        }
    }

    func makeNSView(context: Context) -> Catcher { Catcher() }

    func updateNSView(_ view: Catcher, context: Context) { view.action = action }
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

/// 新建任务 | 快速对话 under the session tabs on the home page, as on the web: the toolbar's
/// segmented switch, as text tabs.
struct HomeModeTabs: View {
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
    /// The text size, the style's body size unless set.
    var size: CGFloat?
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let points = S(size ?? style.text.body)
        Button(action: action) {
            // Sized by the bold title, so picking a tab does not push the ones after it.
            Text(title)
                .font(.riffet(size: points, weight: .semibold))
                .hidden()
                .overlay {
                    Text(title)
                        .font(.riffet(size: points, weight: selected ? .semibold : .regular))
                        .foregroundStyle(selected ? palette.fg : palette.fg3)
                }
                .padding(.vertical, 6)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(selected ? palette.fg : .clear).frame(height: 2)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
