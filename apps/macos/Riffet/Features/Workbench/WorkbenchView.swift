import SwiftUI
import RiffetKit

struct WorkbenchView: View {
    @Bindable var workbench: Workbench
    @Environment(\.palette) private var palette
    @State private var columns: NavigationSplitViewVisibility
    /// The panel opening, not the reader, hid the sidebar; closing the panel then shows it again.
    @State private var sidebarAutoCollapsed = false
    /// The sidebar as the reader left it, restored at launch.
    @AppStorage("riffet.sidebar-visible") private var sidebarVisible = true
    @State private var searchPresented = false
    @State private var importRequest: WorkbenchSidebar.ImportRequest?
    /// The conversation last on screen, kept built while the home page or a page covers it.
    @State private var shownSessionId: String?
    @State private var width: CGFloat = 1360
    @State private var detailHeight: CGFloat = 800
    /// The conversation column's width as last laid out, read when the panel changes. A box, not
    /// state: a window resize writes it every frame, and nothing draws from it.
    @State private var detailWidth = ColumnWidthBox()
    /// The side panel's width as the reader dragged it; 0 until then, when the style's own applies.
    @AppStorage("riffet.inspector-width") private var storedInspectorWidth: Double = 0
    @AppStorage("riffet.terminal-height") private var terminalHeight: Double = 240
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The drawn sidebar's width, which the panel's room is reckoned against there.
    @AppStorage(CustomChrome.sidebarWidthKey) private var customSidebarWidth: Double = 0
    /// The side panel's space beside the conversation. It follows `inspectorShown` in the same update
    /// in which a narrow window's sidebar yields to the panel, so the transcript changes width once.
    @State private var panelReserved: Bool
    /// The panel's last change came from its own toggle, not from a page or conversation covering
    /// or uncovering it: only that one slides.
    @State private var panelSlides = false
    /// How far the conversation is drawn from where its column now puts it, while the panel slides:
    /// the column takes its new width in one step, and the content glides there with the panel
    /// instead of jumping ahead of it.
    @State private var panelShift: CGFloat = 0
    @State private var sidebarOpacity: Double = 1
    /// The app, not the split view, changed the columns: they snap rather than animate.
    @State private var sidebarSnaps = false
    /// The service alert's height above the content, which a page rising over the header passes.
    @State private var bannerHeight: CGFloat = 0

    init(workbench: Workbench) {
        _workbench = Bindable(workbench)
        // A conversation window has no sidebar: its layout stays on the detail column.
        let visible = workbench.role == .main && (UserDefaults.standard.object(forKey: "riffet.sidebar-visible") as? Bool ?? true)
        _columns = State(initialValue: visible ? .all : .detailOnly)
        _panelReserved = State(initialValue: Self.panelShown(in: workbench))
    }

    /// The view is a conversation window (`Workbench.Role.window`): the conversation, its panel and
    /// terminal, without the sidebar, the home page or the one-level pages.
    private var isWindow: Bool { workbench.role == .window }

    /// The tab bar's commands, while it is on screen.
    private var tabCommands: SessionTabCommands? {
        !isWindow && SessionTabsPreferences.shared.active ? SessionTabs.model(for: workbench.baseURL).commands : nil
    }

    /// The side panel is on screen: open for this conversation, and no page covers it.
    private var inspectorShown: Bool { Self.panelShown(in: workbench) }

    private static func panelShown(in workbench: Workbench) -> Bool {
        workbench.page == nil && workbench.attemptGroupSelection == nil && workbench.inspector.open && !workbench.quickChatContext
    }

    /// Whether the panel shows, with what besides its own toggle decides it.
    private struct PanelPlacement: Equatable {
        var shown: Bool
        var page: WorkbenchPage?
        var attempts: Bool
        var quickChat: Bool
        var key: String
    }

    private var panelPlacement: PanelPlacement {
        PanelPlacement(
            shown: inspectorShown, page: workbench.page, attempts: workbench.attemptGroupSelection != nil,
            quickChat: workbench.quickChatContext, key: workbench.inspectorKey
        )
    }

    private var inspectorTab: Binding<InspectorTab> {
        Binding(get: { workbench.inspector.tab }, set: { tab in workbench.setInspector { $0.tab = tab } })
    }

    var body: some View {
        Group {
            if isWindow {
                workspace.toolbar { toolbar }.toolbarBackgroundVisibility(toolbarBackground, for: .windowToolbar)
            } else if DisplayPreferences.shared.style.backend == .custom {
                CustomWorkbench(workbench: workbench, sidebarShown: columns != .detailOnly) {
                    if DisplayPreferences.shared.style.header == .titleMenu { customHeader }
                } content: {
                    workspace
                }
            } else {
                NavigationSplitView(columnVisibility: $columns) {
                    SidebarView(workbench: workbench)
                        .opacity(sidebarOpacity)
                        .navigationSplitViewColumnWidth(min: 210, ideal: 268, max: 400)
                } detail: {
                    workspace.toolbar { toolbar }.toolbarBackgroundVisibility(toolbarBackground, for: .windowToolbar)
                }
            }
        }
        .environment(\.workbenchScope, workbench)
        .pluginCommandPresenter(workbench)
        .sessionDeletionDialog(workbench)
        .background { WindowBackdrop(material: DisplayPreferences.shared.material).ignoresSafeArea() }
        .background(WorkbenchWindowBinder(workbench: workbench))
        .background(WindowTitleBarBinder(titleBar: isWindow ? .unified : DisplayPreferences.shared.style.titleBar))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        // A running benchmark labels its own pages.
        .onChange(of: perfPage, initial: true) { _, page in if !isWindow, !PerfBenchmark.shared.running { PerfMonitor.shared.page = page } }
        .overlay { AppearanceBackdrop() }
        .overlay { ImageViewerOverlay() }
        .onChange(of: panelPlacement) { old, new in
            guard old.shown != new.shown else { return }
            let shown = new.shown
            // Sidebar, transcript and inspector do not all fit a narrow window; the sidebar yields,
            // and comes back only if the panel took it away, not if the reader had hidden it.
            var sidebarMoved = false
            if shown {
                if width < sidebarColumnWidth + 420 + inspectorWidth, columns != .detailOnly {
                    sidebarMoved = true
                    sidebarAutoCollapsed = true
                    sidebarSnaps = true
                    columns = .detailOnly
                }
            } else if sidebarAutoCollapsed {
                sidebarMoved = true
                sidebarAutoCollapsed = false
                sidebarSnaps = true
                columns = .all
            }
            // Only the reader's toggle slides; a page or another conversation shows or hides it at once.
            var toggled = old
            toggled.shown = shown
            let slides = toggled == new
            if slides != panelSlides { panelSlides = slides }
            panelReserved = shown
            // The reading column starts where it was and follows the panel: it moves by as much as its
            // centring moves, half the panel's room while it has that much slack, less (or nothing)
            // when it already fills the column. A sidebar folding in the same step snaps instead.
            if slides, !maximized, !reduceMotion, !sidebarMoved {
                let reading = CGFloat(DisplayPreferences.shared.contentWidth) + TranscriptStyle.gutterWidth * 2
                let before = detailWidth.value
                let after = before + (shown ? -panelRoom : panelRoom)
                let shift = max(0, (before - reading) / 2) - max(0, (after - reading) / 2)
                if abs(shift) > 0.5 {
                    panelShift = shift
                    DispatchQueue.main.async { withAnimation(panelAnimation) { panelShift = 0 } }
                }
            }
        }
        .onChange(of: columns) { old, columns in
            // Showing the sidebar by hand ends the automatic collapse; only the reader's choice is kept.
            if sidebarAutoCollapsed, columns != .detailOnly { sidebarAutoCollapsed = false }
            if !sidebarAutoCollapsed { sidebarVisible = columns != .detailOnly }
            let snaps = sidebarSnaps
            sidebarSnaps = false
            // A column that snapped in has its rows fade in over it. One the split view animates
            // slides in with its rows already drawn, as one piece.
            if old == .detailOnly, columns != .detailOnly {
                if snaps { fadeInSidebar() } else { sidebarOpacity = 1 }
            }
            // The folding column narrows under its rows, which would re-lay out and clip as it
            // goes; they fade out in its first frames instead, and are drawn again once it is gone,
            // ready to slide in with it.
            if old != .detailOnly, columns == .detailOnly, !snaps {
                withAnimation(.easeOut(duration: reduceMotion ? 0 : 0.1)) { sidebarOpacity = 0 }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    if self.columns == .detailOnly { sidebarOpacity = 1 }
                }
            }
        }
        .disabled(searchPresented || importRequest != nil)
        .accessibilityHidden(searchPresented || importRequest != nil)
        .overlay {
            if let request = importRequest {
                GeometryReader { geometry in
                    ZStack(alignment: .top) {
                        Color.black.opacity(0.14)
                            .ignoresSafeArea()
                            .onTapGesture { importRequest = nil }
                        ExternalImportDialog(workbench: workbench, projectId: request.projectId, listHeight: min(680, geometry.size.height * 0.72), dismiss: { importRequest = nil })
                            .clipShape(RoundedRectangle(cornerRadius: Radius.floating, style: .continuous))
                            .shadow(color: .black.opacity(0.12), radius: 14, y: 5)
                            .padding(.horizontal, Space.xl)
                            .padding(.top, geometry.size.height * 0.06)
                    }
                }
            } else {
                // The panel drops in from above while the window dims behind it, and lifts away the
                // same way (docs/design/macos-native.md 1.3). The container stays, so the animation
                // reaches the panel coming and going and nothing else in the window.
                ZStack {
                    if searchPresented {
                        Color.black.opacity(0.14)
                            .ignoresSafeArea()
                            .onTapGesture { searchPresented = false }
                            .transition(.opacity)
                        SearchDialog(workbench: workbench, dismiss: { searchPresented = false })
                            .clipShape(RoundedRectangle(cornerRadius: Radius.floating, style: .continuous))
                            .shadow(color: .black.opacity(0.12), radius: 14, y: 5)
                            .padding(Space.xl)
                            .transition(.opacity.combined(with: .offset(y: -8)))
                    }
                }
                .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: searchPresented) // perf-lint: allow only the overlay's own panel and scrim move; the window's layout is untouched
            }
        }
        .alert("无法打开终端", isPresented: Binding(
            get: { workbench.terminalDock.error != nil },
            set: { if !$0 { workbench.terminalDock.error = nil } }
        )) {
            Button("好", role: .cancel) { workbench.terminalDock.error = nil }
        } message: {
            Text(workbench.terminalDock.error ?? "")
        }
        .onReceive(NotificationCenter.default.publisher(for: .riffetToggleSidebar)) { note in
            if note.targets(workbench) { toggleSidebar() }
        }
        .onChange(of: workbench.sidebar.searchRequested, initial: true) { _, requested in
            guard let requested else { return }
            workbench.sidebar.searchRequested = nil
            workbench.sidebar.searchMode = requested == .content ? .content : .title
            workbench.sidebar.searchSessionId = nil
            workbench.sidebar.query = requested == .commands ? ">" : ""
            searchPresented = true
        }
        .onChange(of: workbench.sidebar.importRequested, initial: true) { _, requested in
            guard let requested else { return }
            workbench.sidebar.importRequested = nil
            searchPresented = false
            importRequest = requested
        }
        .modifier(QuickOpenOverlay(workbench: workbench))
        .focusedSceneValue(\.workbenchActions, WorkbenchActions(
            newSession: { workbench.showHome() },
            toggleInspector: { workbench.toggleInspector() },
            showInspector: { tab in workbench.showInspector(tab) },
            toggleInspectorMaximized: { workbench.toggleInspectorMaximized() },
            openPalette: { workbench.sidebar.searchRequested = .commands },
            interrupt: { Task { await workbench.interrupt() } },
            refresh: { workbench.refresh() },
            toggleSidebar: { toggleSidebar() },
            openPage: { page in workbench.page = page },
            previousSession: { if let tabs = tabCommands { tabs.step(-1) } else { workbench.openAdjacentSession(-1) } },
            nextSession: { if let tabs = tabCommands { tabs.step(1) } else { workbench.openAdjacentSession(1) } },
            tabs: tabCommands,
            openSession: { index in
                // A conversation window has no sidebar of its own: the order is the main window's.
                guard !isWindow else {
                    workbench.showInMain { $0.openSidebarSession(at: index) }
                    return
                }
                workbench.openSidebarSession(at: index)
            },
            search: { workbench.sidebar.searchRequested = .titles },
            searchContent: { workbench.sidebar.searchRequested = .content },
            quickOpen: { NotificationCenter.default.post(name: .riffetQuickOpen, object: workbench) },
            find: { workbench.openFind() },
            findNext: { workbench.findNext() },
            findPrevious: { workbench.findPrevious() },
            toggleTerminalView: { workbench.toggleTerminalPage() },
            toggleTerminal: { workbench.terminalDock.toggle() },
            openInWindow: isWindow ? nil : {
                if !workbench.showingHome, let id = workbench.selected?.id { WindowRouter.shared.openConversation(id) }
            },
            pluginCommands: Dictionary(workbench.pluginCommandList.map { command in (command.id, { workbench.pluginCommands.run(command, in: workbench) }) }, uniquingKeysWith: { first, _ in first })
        ))
    }

    /// The conversation or page with the side panel and the terminal dock: the split view's detail
    /// column, or the whole of a conversation window. The panel and the dock take their space in one
    /// step and slide over it (or, closing, over the conversation that has already taken the space
    /// back): every frame of a width or height animation would re-measure the whole transcript and
    /// composer, which takes seconds on a long conversation.
    private var workspace: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                // A drawn header of the conversation's own column; the native window's is the toolbar.
                if !isWindow, DisplayPreferences.shared.style.backend == .custom, DisplayPreferences.shared.style.header == .sessionTabs {
                    customHeader
                }
                // Over the content, not the window: the sidebar's fixed rows would sit under it. A page
                // that rises over the header carries it in its own bar instead (`CustomPageBar`).
                ServiceAlertBanner()
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { bannerHeight = $0 }
                    .opacity(coverRise > 0 ? 0 : 1)
                    .allowsHitTesting(coverRise == 0)
                    .accessibilityHidden(coverRise > 0)
                detail
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // Drawn shifted, not laid out again: an offset moves the rendered column only.
                    .offset(x: panelShift)
                if terminalProject != nil {
                    PanelResizeHandle(size: $terminalHeight, limit: terminalHeightLimit, minimum: 140, axis: .vertical)
                    Color.clear.frame(height: terminalPanelHeight)
                }
            }
                .overlay(alignment: .bottom) { terminalDock }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { detailHeight = $0 }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { detailWidth.value = $0 }
                .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
                .background(canvas)
                .modifier(CustomCard(on: cards, drawn: drawn))
                // Maximized, the conversation keeps its width under the panel: no re-layout of
                // the transcript on the way in or out, and its scroll position stays.
                .allowsHitTesting(!maximized)
                .accessibilityHidden(maximized)
            if panelReserved {
                // Painted up under the toolbar like the conversation's own canvas: otherwise the
                // window's glass shows there until the panel has slid in over it.
                Color.clear
                    .frame(width: panelRoom)
                    .background(cards ? Color.clear : canvas)
            }
        }
        .overlay(alignment: .trailing) { sidePanel }
    }

    /// The sidebar column's width: the split view's ideal one, or the drawn sidebar's own.
    private var sidebarColumnWidth: CGFloat {
        let style = DisplayPreferences.shared.style
        return style.backend == .custom ? CustomChrome.sidebarWidth(stored: customSidebarWidth, style: style) : 268
    }

    /// The drawn title bar of a custom style, over the whole content or the conversation's column.
    private var customHeader: some View {
        CustomHeader(workbench: workbench, sidebarShown: columns != .detailOnly) { runtimeNotice }
    }

    /// A clear window gets a separate titlebar fill from the system; hiding it lets the canvas run up
    /// under the toolbar as it does in an opaque window.
    private var toolbarBackground: Visibility {
        let clear = DisplayPreferences.shared.material != .solid
        return clear ? .hidden : .automatic
    }

    /// The content's colour over the window material; pages in the detail column paint none of their own.
    private var canvas: Color { palette.page.opacity(DisplayPreferences.shared.contentTint) }

    /// The window is drawn by the app (`CustomWorkbench`), not the system's.
    private var drawn: Bool { !isWindow && DisplayPreferences.shared.style.backend == .custom }

    /// The conversation and the side panel are cards of their own (`StyleSpec.Window.insetCard`).
    private var cards: Bool { drawn && DisplayPreferences.shared.style.window == .insetCard }

    private var sidePanel: some View {
        let animation = panelSlides ? panelAnimation : nil
        return ZStack(alignment: .trailing) {
            if panelReserved {
                HStack(spacing: 0) {
                    if !maximized {
                        PanelResizeHandle(size: Binding(get: { inspectorWidth }, set: { storedInspectorWidth = $0 }), limit: max(300, width - 420 - (columns == .detailOnly ? 0 : sidebarColumnWidth)), drawn: !cards)
                            .frame(width: cards ? Space.sm : 1)
                    }
                    InspectorView(workbench: workbench, tab: inspectorTab, maximized: maximized) { workbench.toggleInspectorMaximized() }
                        .frame(minWidth: maximized ? 0 : panelWidth, maxWidth: maximized ? .infinity : panelWidth)
                        .modifier(CustomCard(on: cards, drawn: drawn))
                }
                .frame(maxWidth: maximized ? .infinity : nil)
                .transition(panelTransition(.trailing))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
        // Only the panel's own insertion and removal animate: a transform, no layout per frame.
        .transaction(value: panelReserved) { $0.animation = animation }
    }

    /// The bottom terminal of the current project, when it is on screen.
    private var terminalProject: Project? {
        guard workbench.terminalDock.shown, workbench.page == nil, !workbench.showsTerminalPage else { return nil }
        return workbench.currentProject
    }

    private var terminalPanelHeight: CGFloat { min(max(terminalHeight, 140), terminalHeightLimit) }

    private var terminalDock: some View {
        let project = terminalProject
        let animation = panelAnimation
        return ZStack(alignment: .bottom) {
            if let project {
                TerminalPanel(workbench: workbench, project: project, session: workbench.showingHome ? nil : workbench.selected)
                    .frame(height: terminalPanelHeight)
                    .background(palette.bg)
                    .id(project.id)
                    .transition(panelTransition(.bottom))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        // Opening and closing slide; another project's terminal replaces the old one in place.
        .transaction(value: project != nil) { $0.animation = animation }
    }

    private func panelTransition(_ edge: Edge) -> AnyTransition {
        reduceMotion ? .opacity : .move(edge: edge)
    }

    private var panelAnimation: Animation { .snappy(duration: reduceMotion ? 0.15 : 0.22) }

    private var maximized: Bool { workbench.inspectorMaximized }

    private var inspectorWidth: Double {
        storedInspectorWidth > 0 ? storedInspectorWidth : Double(DisplayPreferences.shared.style.layout.rightPanel)
    }

    private var panelWidth: CGFloat { min(max(inspectorWidth, 300), max(300, width - 420)) }

    /// What the panel takes from the conversation's column: the panel and its divider or gap.
    private var panelRoom: CGFloat { (cards ? Space.sm : 1) + panelWidth }

    private var terminalHeightLimit: CGFloat { max(140, min(detailHeight * 0.6, detailHeight - 240)) }

    /// The page the performance monitor files frames under.
    private var perfPage: String {
        if let page = workbench.page { return page.rawValue }
        if workbench.showingHome || workbench.selected == nil { return "home" }
        return workbench.showsTerminalPage ? "terminal" : "transcript"
    }

    /// The column itself snaps for the same reason as the inspector: the detail column would re-lay
    /// out per frame. The sidebar's content fades in instead.
    private func toggleSidebar() {
        guard !isWindow else { return }
        sidebarAutoCollapsed = false
        sidebarSnaps = true
        columns = columns == .detailOnly ? .all : .detailOnly
    }

    /// The returning sidebar's rows fade in over the column that has already taken its width.
    private func fadeInSidebar() {
        sidebarOpacity = 0
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.2)) { sidebarOpacity = 1 }
        }
    }

    /// The open conversation stays built under the home page and the one-level pages once it has been
    /// on screen: coming back shows it as it was left instead of building its transcript, composer
    /// and docks again, which took longer than anything else on the way back.
    private var detail: some View {
        let covered = covering
        return ZStack {
            if let session = workbench.selected, !covered || session.id == shownSessionId {
                ConversationView(workbench: workbench, session: session)
                    .environment(\.covered, covered)
                    .opacity(covered ? 0 : 1)
                    .allowsHitTesting(!covered)
                    .accessibilityHidden(covered)
            }
            if covered { cover.padding(.top, -coverRise) }
        }
        .background(ColumnCrossfade(key: workbench.page?.rawValue ?? (covered ? "cover" : workbench.selected?.id ?? "")))
        .onChange(of: covered, initial: true) { _, covered in
            if !covered { shownSessionId = workbench.selected?.id }
            else { resignCoveredFocus() }
        }
        .onChange(of: workbench.selected?.id) { _, id in
            if !covering { shownSessionId = id }
        }
        // What this window has on screen is what the reader has seen (`UnreadStore`).
        .onChange(of: covered ? nil : workbench.selected?.id, initial: true) { _, id in
            UnreadStore.shared.show(id, in: ObjectIdentifier(workbench))
        }
        .onDisappear { UnreadStore.shared.show(nil, in: ObjectIdentifier(workbench)) }
    }

    /// How far a page rises over the drawn header above it, which it covers with its own bar
    /// (`pageChrome`), and over the service alert between them. 0 for everything else and in the
    /// native window.
    private var coverRise: CGFloat {
        let style = DisplayPreferences.shared.style
        guard drawn, workbench.page != nil else { return 0 }
        return style.layout.header + (style.header == .titleMenu ? 1 : 0) + bannerHeight
    }

    /// Something other than the conversation fills the detail column.
    private var covering: Bool {
        workbench.page != nil || workbench.attemptGroupSelection != nil || workbench.showingHome || workbench.selected == nil
    }

    @ViewBuilder
    private var cover: some View {
        if let page = workbench.page {
            switch page {
            case .stats: StatsView(workbench: workbench)
            case .tasks: TasksPage(workbench: workbench)
            case .extensions: ExtensionsPage(workbench: workbench)
            case .plugins: PluginsPage(workbench: workbench)
            case .marks: MarksPage(workbench: workbench)
            case .activity: ActivityPage(workbench: workbench)
            }
        } else if let group = workbench.attemptGroupSelection {
            AttemptGroupView(workbench: workbench, groupId: group.id, projectId: group.projectId)
                .id(group.id)
        } else if isWindow, workbench.selected == nil {
            Spinner(size: .small).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            HomeView(workbench: workbench)
        }
    }

    /// Typing must not land in the covered conversation: its composer or a selection in its transcript
    /// gives up the keyboard (the home page's composer takes it as it appears).
    private func resignCoveredFocus() {
        guard let window = WorkbenchWindows.window(of: workbench),
              let responder = window.firstResponder as? NSView else { return }
        let transcript = TranscriptController.active(in: window, includingCovered: true)?.view
        if responder is SubmitTextView || transcript.map(responder.isDescendant(of:)) == true {
            window.makeFirstResponder(nil)
        }
    }

    /// A conversation is the page (not the home page or a one-level page).
    private var sessionChrome: Bool {
        !workbench.showingHome && workbench.page == nil && workbench.attemptGroupSelection == nil
    }

    /// The toolbar's items stay put across the home page and conversations, and only their content
    /// changes: adding and removing toolbar items re-creates their hosting views and re-tiles the
    /// whole toolbar, about a hundred milliseconds per switch. The title has no glass and turns
    /// transparent off a conversation; the trailing capsule keeps the panel button (the home page
    /// has a panel too) and gains the conversation's counts and menu on its page. The one-level pages
    /// (which bring their own title and controls) and the image viewer, whose dimming cannot cover
    /// the toolbar, drop the items. The new-session button lives in the sidebar's toolbar.
    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if ImageViewer.shared.item == nil {
            let conversation = sessionChrome ? workbench.selected : nil
            // The title placeholder is for conversations and the home page; a page puts its own
            // title and controls here (`pageChrome`).
            if workbench.page == nil {
                ToolbarItem(placement: .principal) {
                    Group {
                        if !isWindow, workbench.attemptGroupSelection == nil, workbench.showingHome || workbench.selected == nil {
                            Picker("新会话", selection: Binding(
                                get: { workbench.homeIsQuickChat },
                                set: { workbench.showHomeTab(quickChat: $0) }
                            )) {
                                Text("新建任务").tag(false)
                                Text("快速对话").tag(true)
                                    .disabled(workbench.quickChatProject == nil)
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                            .fixedSize()
                        } else if let session = workbench.selected {
                            SessionTitleView(workbench: workbench, session: session)
                                .opacity(conversation == nil ? 0 : 1)
                                .allowsHitTesting(conversation != nil)
                        }
                    }
                    .frame(width: 440)
                }
                .hideSharedToolbarBackground()
            }
            if workbench.page == nil {
                ToolbarItem(placement: .primaryAction) { trailingControls(conversation: conversation) }
            }
        }
    }

    /// The item sits at the toolbar's trailing edge: what comes and goes stays on the leading side, so
    /// the panel button and ⋯ keep their place. A grouped toolbar leaves the macOS 26 glass capsule
    /// around all of it; otherwise each control stands on its own.
    @ViewBuilder
    private func trailingControls(conversation: Session?) -> some View {
        HStack(spacing: 2) {
            if conversation != nil, !workbench.quickChatContext {
                runtimeNotice
            }
            // Three entries, as on the web: 会话信息 (where the session can take you, and the work
            // running in it), the panel, and ⋯ for what can be done to it.
            if let conversation {
                SessionInfoButton(workbench: workbench, session: conversation)
            }
            if !workbench.quickChatContext {
                Button { workbench.toggleInspector() } label: {
                    Image(icon: "sidebar.right").font(.riffet(size: S(13)))
                }
                .buttonStyle(IconButtonStyle(size: 28))
                .help("变更与文件 (⌥⌘I)")
            }
            if let conversation {
                SessionMenu(workbench: workbench, session: conversation, inspectorTab: inspectorTab, inspectorOpen: Binding(
                    get: { workbench.inspector.open },
                    set: { workbench.setInspectorOpen($0) }
                ), infoInHeader: true)
            }
        }
        .padding(.horizontal, 4)
        .fixedSize()
    }

    /// The plugin's notice for this conversation; its actions beyond the notice's own are in the ⋯ menu.
    @ViewBuilder
    private var runtimeNotice: some View {
        if let session = workbench.selected, let notice = workbench.runtimeControl?.notice {
            let pending = workbench.runtimeActionPending
            let label = localizedText(notice.label, fallback: "")
            let progress = notice.tone == "progress" || pending
            let danger = notice.tone == "danger" && !pending
            if progress || !label.isEmpty || notice.action != nil {
                HStack(spacing: 4) {
                    if progress { Spinner(size: .mini) }
                    // A pending request shows the spinner alone; the plugin's next state brings its own words.
                    if !pending, !label.isEmpty {
                        Text(label).foregroundStyle(danger ? palette.danger : palette.fg3)
                    }
                    if let action = notice.action {
                        Button(localizedText(action.label, fallback: action.id)) {
                            Task { await workbench.runRuntimeAction(action, for: session.id) }
                        }
                        .buttonStyle(ChipButtonStyle()).disabled(pending || action.disabled == true)
                    }
                }
                .font(.riffet(size: S(11)))
                .help(notice.detail ?? "")
                .padding(.horizontal, 4)
                .fadesIn()
            }
        }
    }
}

/// The title of a one-level page, at the toolbar's leading edge with no glass, set like a window
/// title. The page adds its controls with its own `.toolbar` at the default (trailing) placement:
/// on macOS `.primaryAction` is the leading edge, which put them against the title. The sidebar's
/// row is the way back, so there is no back button.
extension EnvironmentValues {
    /// The view is kept built under another page (the home page, a one-level page) and is not on screen.
    @Entry var covered = false
}

extension View {
    /// A one-level page's title and actions: in the toolbar of the native window, in a bar drawn
    /// over the hidden header of a custom one (`CustomPageBar`).
    /// [hasActions] false adds no toolbar item to the native window, whatever [actions] draws.
    /// [search] filters the page: the system's toolbar search field in the native window, a field
    /// beside the actions in a custom one.
    func pageChrome<Actions: View>(_ page: WorkbenchPage, workbench: Workbench, hasActions: Bool = true, search: PageSearch? = nil, @ViewBuilder actions: () -> Actions) -> some View {
        modifier(PageChrome(page: page, workbench: workbench, hasActions: hasActions, search: search, actions: actions()))
    }

    func pageChrome(_ page: WorkbenchPage, workbench: Workbench) -> some View {
        pageChrome(page, workbench: workbench) { EmptyView() }
    }
}

/// A page's search: its query and what the empty field says.
struct PageSearch {
    let text: Binding<String>
    let prompt: String
}

private struct PageChrome<Actions: View>: ViewModifier {
    let page: WorkbenchPage
    let workbench: Workbench
    let hasActions: Bool
    let search: PageSearch?
    let actions: Actions

    @ViewBuilder
    func body(content: Content) -> some View {
        if DisplayPreferences.shared.style.backend == .native {
            // The title leads; the actions sit on the trailing edge as the system's own items, each
            // in its own place rather than one capsule beside the title.
            let bar = content.toolbar {
                PageTitleToolbar(page: page)
                if hasActions, !(actions is EmptyView) { ToolbarItemGroup(placement: .primaryAction) { actions } }
            }
            if let search {
                bar.searchable(text: search.text, placement: .toolbar, prompt: Text(search.prompt))
            } else {
                bar
            }
        } else {
            content.safeAreaInset(edge: .top, spacing: 0) {
                CustomPageBar(workbench: workbench, title: page.title) {
                    if let search { PageSearchField(search: search) }
                    actions
                }
            }
        }
    }
}

/// A page action: the system's toolbar button in the native window, a chip in a custom one.
/// [titled] spells the action out in the native toolbar too, for words an icon would not say (完成).
struct PageActionButton: View {
    let title: String
    let symbol: String
    var titled = false
    let action: () -> Void

    var body: some View {
        if DisplayPreferences.shared.style.backend == .native {
            if titled {
                Button(title, action: action)
            } else {
                Button(action: action) { Label(title, icon: symbol) }.help(title)
            }
        } else {
            Button(action: action) { ChipLabel(text: title, symbol: symbol, chevron: false) }
                .buttonStyle(ChipButtonStyle())
                .help(title)
        }
    }
}

/// A page's menu behind an icon: `ToolbarMenuButton` in the native window, a drawn one in a custom one.
struct PageMenuButton: View {
    let symbol: String
    let help: String
    let build: () -> NSMenu
    @Environment(\.palette) private var palette

    var body: some View {
        if DisplayPreferences.shared.style.backend == .native {
            ToolbarMenuButton(symbol: symbol, help: help, build: build)
        } else {
            MenuLabelButton(label: AnyView(
                Image(icon: symbol).font(.riffet(size: S(13))).foregroundStyle(palette.fg3).frame(width: 26, height: 26)
            ), build: build)
            .help(help)
        }
    }
}

/// The page search of a custom window, where there is no system toolbar to hold one.
private struct PageSearchField: View {
    let search: PageSearch
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            Image(icon: "magnifyingglass").font(.riffet(size: S(11.5))).foregroundStyle(palette.fg4)
            TextField(search.prompt, text: search.text)
                .textFieldStyle(.plain)
                .font(.riffet(size: S(12.5)))
            if !search.text.wrappedValue.isEmpty {
                Button { search.text.wrappedValue = "" } label: {
                    Image(icon: "xmark.circle.fill").font(.riffet(size: S(11.5))).foregroundStyle(palette.fg4)
                }
                .buttonStyle(.plain)
                .help("清除搜索")
            }
        }
        .padding(.horizontal, Space.sm)
        .frame(width: 200, height: 26)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgElevated))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
    }
}

struct PageTitleToolbar: ToolbarContent {
    let page: WorkbenchPage

    var body: some ToolbarContent {
        ToolbarItem(placement: .navigation) { PageTitleText(title: page.title) }
            .hideSharedToolbarBackground()
    }
}

/// 活动: the connected service's load, requests and processes, as a page of the main window.
struct ActivityPage: View {
    let workbench: Workbench

    var body: some View {
        ServiceMonitorDashboard()
            .navigationTitle(WorkbenchPage.activity.title)
            .pageChrome(.activity, workbench: workbench)
    }
}

struct PageTitleText: View {
    let title: String
    @Environment(\.palette) private var palette

    var body: some View {
        Text(title)
            .font(.riffet(size: S(16), weight: .bold))
            .foregroundStyle(palette.fg)
            .lineLimit(1)
            .fixedSize()
            .padding(.leading, Space.sm)
    }
}

/// The toolbar title: the conversation (click to rename), its project/worktree, agent icon and status.
struct SessionTitleView: View {
    let workbench: Workbench
    let session: Session
    @Environment(\.palette) private var palette
    @State private var renaming = false
    @State private var draft = ""
    @State private var showingNotice = false

    private var projectTitle: String? {
        guard session.agentID != AgentDirectory.quickChat, let project = workbench.project(session.projectId) else { return nil }
        if project.isTaskWorkspace { return String(localized: "未关联项目") }
        guard let tree = project.worktree, var origin = workbench.project(tree.originProjectId) else { return project.name }
        var visited: Set<String> = [project.id, origin.id]
        while let parentId = origin.worktree?.originProjectId, let parent = workbench.project(parentId), visited.insert(parent.id).inserted {
            origin = parent
        }
        let namespace = "riffet/"
        var name = tree.branch
        if name.hasPrefix(namespace) {
            name = String(name.dropFirst(namespace.count))
            // Match the server's generated project prefix; old dated branches have none.
            let stem = origin.name.precomposedStringWithCompatibilityMapping
                .replacingOccurrences(of: #"[^\p{L}\p{N}_-]+"#, with: "-", options: .regularExpression)
                .trimmingCharacters(in: CharacterSet(charactersIn: "-_"))
            let shortened = String(String.UnicodeScalarView(stem.unicodeScalars.prefix(48)))
                .trimmingCharacters(in: CharacterSet(charactersIn: "-_"))
            let prefix = "\(shortened.isEmpty ? "project" : shortened)_"
            if name.hasPrefix(prefix) { name = String(name.dropFirst(prefix.count)) }
        } else if name.hasPrefix("\(origin.name)/") {
            name = String(name.dropFirst(origin.name.count + 1))
        }
        return "\(origin.name) · \(name)"
    }

    var body: some View {
        VStack(spacing: 1) {
            TitleWithStatusLayout(spacing: 6) {
                Button { draft = session.title; renaming = true } label: {
                    Text(session.title.isEmpty ? String(localized: "新会话") : session.title)
                        .font(.riffet(size: S(13), weight: .medium))
                        .foregroundStyle(palette.fg)
                        .lineLimit(1)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .contentShape(Rectangle())
                }
                .buttonStyle(HoverRowStyle())
                .help("重命名会话")
                HStack(spacing: 6) {
                    status
                        .font(.riffet(size: S(11)))
                        .lineLimit(1)
                        .fixedSize()
                    if let notice = workbench.status?.profilePending?.boolValue == true ? String(localized: "新配置将在后端重启后生效") : (workbench.status?.noticeLevel == "info" ? workbench.status?.notice : nil) {
                        Button { showingNotice.toggle() } label: { Image(icon: "info.circle") }
                            .buttonStyle(IconButtonStyle(size: 20)).help(notice).accessibilityLabel(notice)
                            .stylePopover(isPresented: $showingNotice) {
                                ScrollView { Text(notice).font(RiffetFont.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(Space.md) }
                                    .frame(width: 360).frame(maxHeight: 200)
                            }
                            .fadesIn()
                    }
                }
            }
            HStack(spacing: 6) {
                if let projectTitle {
                    Text(projectTitle)
                }
                if let backend = session.agent {
                    Text("·")
                    Label { Text(backendLabel(backend)) } icon: {
                        AgentIcon(id: backend, size: 13, color: agentMarkColor(backend, palette))
                    }
                    .labelStyle(.iconOnly)
                    .help(backendLabel(backend))
                }
            }
            .font(.riffet(size: S(11)))
            .foregroundStyle(palette.fg3)
            .lineLimit(1)
        }
        .frame(maxWidth: 440)
        .onChange(of: session.id) { _, _ in showingNotice = false }
        .onChange(of: workbench.status?.noticeLevel) { _, level in if level != "info" { showingNotice = false } }
        .alert("重命名会话", isPresented: $renaming) {
            TextField("标题", text: $draft)
            Button("取消", role: .cancel) {}
            Button("保存") {
                let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                if !title.isEmpty, title != session.title { Task { await workbench.update(session, title: title) } }
            }
        }
    }

    /// One status, not two: the live badge replaces the session state while it says more.
    @ViewBuilder
    private var status: some View {
        let state = ConversationState(workbench: workbench, session: session, catalog: workbench.catalogs.cached(for: session))
        if let badge = state.badge {
            // Work in progress is the spinner alone; its words are in the tooltip.
            if badge.loading {
                Spinner(size: .mini).help(badge.text).accessibilityLabel(badge.text).fadesIn()
            } else {
                Text(badge.text).foregroundStyle(badge.warning ? palette.warning : palette.fg3).fadesIn()
            }
        } else if state.needsResume, session.agentID != AgentDirectory.quickChat, !workbench.providerMissing(for: session) {
            Button { Task { _ = await workbench.reopen(session) } } label: {
                Label("恢复会话", icon: "arrow.clockwise")
            }
            .buttonStyle(ChipButtonStyle())
            .disabled(workbench.reopening || (session.model != nil && workbench.catalogs.cached(for: session) == nil))
            .fadesIn()
        } else if session.state == .running {
            Spinner(size: .mini).help("运行中").accessibilityLabel("运行中").fadesIn()
        } else if session.state == .failed {
            Text("出错").foregroundStyle(palette.danger).fadesIn()
        }
    }
}

/// Cross-fades the detail column when what fills it changes (a page, the home page, another
/// conversation): the frame, the toolbar and the sidebar stay where they are and only the content
/// changes (docs/design/macos-native.md 1.3). A Core Animation transition on the column's own layer,
/// added in the same update that swaps the content, so SwiftUI does no work per frame; an animation
/// on the column in SwiftUI re-laid the window out on every one.
private struct ColumnCrossfade: NSViewRepresentable {
    let key: String

    final class Anchor: NSView {
        var key: String?

        /// The split view's column holding this view; none in a conversation window or a drawn layout.
        var column: NSView? {
            var view = superview
            while let current = view {
                if current.superview is NSSplitView { return current }
                view = current.superview
            }
            return nil
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> Anchor { Anchor() }

    func updateNSView(_ anchor: Anchor, context: Context) {
        defer { anchor.key = key }
        guard let old = anchor.key, old != key, let column = anchor.column else { return }
        column.wantsLayer = true
        let fade = CATransition()
        fade.type = .fade
        fade.duration = 0.2
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        column.layer?.add(fade, forKey: "riffet.crossfade")
    }
}

/// A width kept for reading, outside SwiftUI's change tracking.
private final class ColumnWidthBox {
    var value: CGFloat = 800
}

/// An entry of the header's ⋯ menu besides the conversation's own work.
struct HeaderMoreItem {
    let title: String
    var symbol: String?
    var on = false
    /// Shown beside the title; the main menu owns the shortcut itself.
    var shortcut: (key: String, modifiers: NSEvent.ModifierFlags)?
    let action: () -> Void
}

/// Subagents and background tasks of the open conversation (`SessionWorkActions.tsx`): one chip each,
/// sharing a capsule when both exist. With [more], they fold into one ⋯ menu after those entries
/// instead, as Claude Desktop keeps its header to the panels it opens.
struct SessionWorkActions: View {
    let workbench: Workbench
    var more: [HeaderMoreItem]?
    var size: CGFloat = 26
    /// Lists them in place, as sections of 会话信息, instead of behind chips; [onOpen] closes the
    /// surface holding them when a row leaves for a subagent.
    var inline = false
    var onOpen: (() -> Void)?
    @Environment(\.palette) private var palette
    /// A subagent's state and stats: quiet ink in the native style, the theme's accent in the drawn ones.
    private var workTint: Color { DisplayPreferences.shared.style.backend == .native ? palette.fg3 : palette.accent }
    @State private var showSubagents = false
    @State private var showTasks = false
    @State private var confirming: NativeActivity?
    @State private var anchor = MenuAnchor()
    @State private var showAllSubagents = false

    var body: some View {
        // The lists come from the presenter's output; the body only reads them.
        let subagents = workbench.subagentEntries
        let jobs = workbench.jobs
        // A task the transcript already shows as a subagent or a job is listed once.
        let known = Set(subagents.map(\.toolCallId) + jobs.map(\.toolCallId))
        let tasks = workbench.dock.tasks.filter { $0.toolCallId.map { !known.contains($0) } ?? true }
        let taskCount = tasks.count + jobs.count
        Group {
            if inline {
                sections(subagents: subagents, tasks: tasks, jobs: jobs, taskCount: taskCount)
            } else if let more {
                folded(more, subagents: subagents, tasks: tasks, jobs: jobs, taskCount: taskCount)
            } else {
                chips(subagents: subagents, tasks: tasks, jobs: jobs, taskCount: taskCount)
            }
        }
        .alert("停止后台任务？", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })) {
            Button("停止", role: .destructive) { if let id = confirming?.id { Task { _ = await workbench.stop(activity: id) } }; confirming = nil }
            Button("取消", role: .cancel) { confirming = nil }
        } message: { Text(confirming.map { activityView(activity: $0, stopping: false, nowMillis: 0).stopWarning ?? "" } ?? "") }
    }

    private func chips(subagents: [SubagentEntry], tasks: [NativeActivity], jobs: [NativeJob], taskCount: Int) -> some View {
        let both = !subagents.isEmpty && taskCount > 0
        return HStack(spacing: 0) {
            if !subagents.isEmpty {
                Button { showSubagents.toggle() } label: {
                    WorkCount(count: subagents.count, title: String(localized: "子 Agent"), running: subagents.contains { $0.state == .running })
                }
                .buttonStyle(ChipButtonStyle())
                .help("\(subagents.count) 个子 Agent")
                .anchoredPopup(isPresented: $showSubagents, edge: .below) { subagentList(subagents) }
                .fadesIn()
            }
            if both { Rectangle().fill(palette.line).frame(width: 0.5, height: 14).fadesIn() }
            if taskCount > 0 {
                Button { showTasks.toggle() } label: {
                    WorkCount(count: taskCount, title: String(localized: "后台任务"), running: !tasks.isEmpty || jobs.contains { $0.status == .running })
                }
                .buttonStyle(ChipButtonStyle())
                .help("\(taskCount) 个后台任务")
                .anchoredPopup(isPresented: $showTasks, edge: .below) { taskList(tasks: tasks, jobs: jobs, count: taskCount) }
                .fadesIn()
            }
        }
        .overlay { if both { RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line, lineWidth: 0.5) } }
    }

    /// The ⋯ button: the conversation's work first, then [more]; the lists open under the button.
    @ViewBuilder
    private func folded(_ more: [HeaderMoreItem], subagents: [SubagentEntry], tasks: [NativeActivity], jobs: [NativeJob], taskCount: Int) -> some View {
        if !subagents.isEmpty || taskCount > 0 || !more.isEmpty {
            Button { popUp(more, subagents: subagents.count, tasks: taskCount) } label: { Image(icon: "ellipsis") }
                .buttonStyle(IconButtonStyle(size: size, active: showSubagents || showTasks))
                .background(MenuAnchorView(anchor: anchor))
                .help("更多")
                .accessibilityLabel("更多")
                .anchoredPopup(isPresented: $showSubagents, edge: .below) { subagentList(subagents) }
                .anchoredPopup(isPresented: $showTasks, edge: .below) { taskList(tasks: tasks, jobs: jobs, count: taskCount) }
        }
    }

    private func popUp(_ more: [HeaderMoreItem], subagents: Int, tasks: Int) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        var chosen: (() -> Void)?
        if subagents > 0 {
            menu.addItem(MenuAction.item(String(localized: "\(subagents) 个子 Agent"), symbol: "bubble.left.and.bubble.right") { chosen = { showSubagents = true } })
        }
        if tasks > 0 {
            menu.addItem(MenuAction.item(String(localized: "\(tasks) 个后台任务"), symbol: "square.stack.3d.up") { chosen = { showTasks = true } })
        }
        if menu.numberOfItems > 0, !more.isEmpty { menu.addItem(.separator()) }
        for entry in more {
            let item = MenuAction.item(entry.title, symbol: entry.symbol) { chosen = entry.action }
            item.state = entry.on ? .on : .off
            if let shortcut = entry.shortcut {
                item.keyEquivalent = shortcut.key
                item.keyEquivalentModifierMask = shortcut.modifiers
            }
            menu.addItem(item)
        }
        if anchor.popUp(menu) { chosen?() }
    }

    private func subagentList(_ subagents: [SubagentEntry]) -> some View {
        WorkList(title: String(localized: "子 Agent"), count: subagents.count) { subagentRows(subagents) }
            .popupSurface(palette)
    }

    private func subagentRows(_ subagents: [SubagentEntry]) -> some View {
        ForEach(subagents, id: \.toolCallId) { entry in
            if let task = workbench.dock.tasks.first(where: { $0.toolCallId == entry.toolCallId }) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    subagentRow(entry, task: task, view: activityView(activity: task, stopping: workbench.stoppingActivities.contains(task.id), nowMillis: Int64(context.date.timeIntervalSince1970 * 1000)))
                }
            } else {
                subagentRow(entry)
            }
        }
    }

    /// 会话信息's sections: a title and count over each list, the first few subagents and the rest a click away.
    @ViewBuilder
    private func sections(subagents: [SubagentEntry], tasks: [NativeActivity], jobs: [NativeJob], taskCount: Int) -> some View {
        if !subagents.isEmpty {
            InfoSection(title: String(localized: "子 Agent"), count: subagents.count) {
                subagentRows(showAllSubagents ? subagents : Array(subagents.prefix(5)))
                if !showAllSubagents, subagents.count > 5 {
                    Button { showAllSubagents = true } label: {
                        HStack {
                            Text("其余 \(subagents.count - 5) 个").font(.riffet(size: S(13))).foregroundStyle(palette.fg3)
                            Spacer(minLength: 0)
                            Image(icon: "chevron.down").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
                        }
                        .padding(.horizontal, Space.sm)
                        .frame(height: 28)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(HoverRowStyle(radius: 8))
                }
            }
        }
        if taskCount > 0 {
            InfoSection(title: String(localized: "后台任务"), count: taskCount) { taskRows(tasks: tasks, jobs: jobs) }
        }
    }

    private func taskList(tasks: [NativeActivity], jobs: [NativeJob], count taskCount: Int) -> some View {
        WorkList(title: String(localized: "后台任务"), count: taskCount) { taskRows(tasks: tasks, jobs: jobs) }
            .popupSurface(palette)
    }

    @ViewBuilder
    private func taskRows(tasks: [NativeActivity], jobs: [NativeJob]) -> some View {
        if !tasks.isEmpty {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(tasks, id: \.id) { task in
                        let view = activityView(activity: task, stopping: workbench.stoppingActivities.contains(task.id), nowMillis: Int64(context.date.timeIntervalSince1970 * 1000))
                        HStack(spacing: Space.sm) {
                            Spinner(size: .mini)
                            Text([view.label, view.subject].compactMap { $0 }.joined(separator: " · ")).font(.riffet(size: S(13))).foregroundStyle(palette.fg2).lineLimit(1)
                            Spacer(minLength: Space.sm)
                            if let stats = view.stats { Text(stats).font(.riffet(size: S(12)).monospacedDigit()).foregroundStyle(palette.fg4) }
                            if view.canStop {
                                Button("停止") { if view.stopWarning != nil { confirming = task } else { Task { _ = await workbench.stop(activity: task.id) } } }
                                    .buttonStyle(ChipButtonStyle())
                            }
                        }
                        .padding(.horizontal, Space.sm)
                        .frame(minHeight: 30)
                    }
                }
            }
        }
        ForEach(Array(jobs.enumerated()), id: \.offset) { _, job in JobRowView(job: job).padding(.horizontal, Space.sm) }
    }

    private func subagentRow(_ entry: SubagentEntry, task: NativeActivity? = nil, view: ActivityView? = nil) -> some View {
        HStack(spacing: Space.sm) {
            Button {
                showSubagents = false
                onOpen?()
                NotificationCenter.default.post(name: .riffetOpenSubagent, object: workbench, userInfo: ["id": entry.toolCallId, "title": entry.name])
            } label: {
                // The state sits on the row's centre line with the stop button beside it, not on the
                // title's line: a two-line row put the button half a line below the state.
                HStack(spacing: Space.sm) {
                    HStack(alignment: .top, spacing: Space.sm) {
                        if entry.state == .running {
                            Spinner(size: .mini).padding(.top, 4)
                        } else {
                            Circle().fill(entry.state == .done ? palette.success : entry.state == .failed ? palette.danger : palette.fg4)
                                .frame(width: 6, height: 6).padding(.top, 6)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.name).font(.riffet(size: S(13))).foregroundStyle(palette.fg2).lineLimit(1)
                            if let detail = entry.detail {
                                Text(detail).font(.riffet(size: S(11))).foregroundStyle(palette.fg3).lineLimit(1)
                            }
                        }
                    }
                    Spacer(minLength: Space.sm)
                    if let stats = view?.stats, let task,
                       (entry.state == .running && task.status.active) ||
                       (entry.state == .failed && task.status == .failed) ||
                       (entry.state == .done && (task.status == .completed || task.status == .stopped)) { Text(stats).font(.riffet(size: S(11))).monospacedDigit().foregroundStyle(workTint) }
                    else if entry.state == .running { Text("运行中").font(.riffet(size: S(11))).foregroundStyle(workTint) }
                    else if entry.state == .done { Text("已结束").font(.riffet(size: S(11))).foregroundStyle(palette.fg4) }
                    else if entry.state == .failed { Text("失败").font(.riffet(size: S(11))).foregroundStyle(palette.danger) }
                }
                .padding(.horizontal, Space.sm)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(HoverRowStyle(radius: 8))
            if let task, let view, view.canStop, entry.state == .running, task.status.active {
                Button("停止") { if view.stopWarning != nil { confirming = task } else { Task { _ = await workbench.stop(activity: task.id) } } }
                    .buttonStyle(ChipButtonStyle())
            }
        }
    }
}

/// The session title centred in the toolbar whatever its status says: the status (second subview)
/// hangs off the title's trailing edge, and the title gives up width on both sides to leave room for
/// it, so a spinner, a badge or the resume chip coming and going does not slide the title.
private struct TitleWithStatusLayout: Layout {
    var spacing: CGFloat

    private func measure(_ subviews: Subviews, width: CGFloat?) -> (title: CGSize, status: CGSize, gap: CGFloat) {
        let status = subviews.count > 1 ? subviews[1].sizeThatFits(.unspecified) : .zero
        let gap = status.width > 0.5 ? status.width + spacing : 0
        let limit = width.map { max(0, $0 - 2 * gap) }
        let title = subviews.first?.sizeThatFits(ProposedViewSize(width: limit, height: nil)) ?? .zero
        return (title, status, gap)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil }
        let (title, status, gap) = measure(subviews, width: width)
        return CGSize(width: width ?? title.width + 2 * gap, height: max(title.height, status.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let (title, status, _) = measure(subviews, width: bounds.width)
        let x = bounds.midX - title.width / 2
        subviews.first?.place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(title))
        if subviews.count > 1 {
            subviews[1].place(at: CGPoint(x: x + title.width + spacing, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(status))
        }
    }
}

/// Fades a view in where it appears. Its space is taken at once, so nothing beside it moves twice.
private struct FadeIn: ViewModifier {
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .onAppear { withAnimation(.easeOut(duration: 0.18)) { shown = true } }
    }
}

private extension View {
    func fadesIn() -> some View { modifier(FadeIn()) }

    func popupSurface(_ palette: Palette) -> some View {
        background(palette.bgPopover, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.line, lineWidth: 0.5))
            .clipShape(RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 14, y: 5)
    }
}

/// The toolbar's count of subagents or background tasks; a spinner while any of them runs.
private struct WorkCount: View {
    let count: Int
    let title: String
    let running: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 4) {
            Text("\(count)").font(.riffet(size: S(12)).monospacedDigit())
            Text(title).font(.riffet(size: S(12)))
            if running { Spinner(size: .mini) }
        }
        .foregroundStyle(palette.fg2)
        .padding(.horizontal, 4)
    }
}

private struct WorkList<Content: View>: View {
    let title: String
    let count: Int
    @ViewBuilder let content: Content
    @Environment(\.palette) private var palette
    @Environment(\.popupAvailableSize) private var popupAvailableSize

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.sm) {
                Text(title).font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg2)
                Text("\(count)").font(.riffet(size: S(12)).monospacedDigit()).foregroundStyle(palette.fg3)
            }
            .padding(.horizontal, Space.md)
            .frame(height: 34)
            Rectangle().fill(palette.line).frame(height: 1)
            ScrollView { VStack(alignment: .leading, spacing: 0) { content }.padding(Space.xs) }
                .frame(maxHeight: min(480, max(40, popupAvailableSize.height - 34)))
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(width: min(420, popupAvailableSize.width))
    }
}

/// The ⋯ menu: the branch, the view switch, the panels, and editing this conversation. The menu is
/// built when it opens: a SwiftUI `Menu` in the toolbar rebuilds its whole menu, icons included,
/// every time anything it reads changes, which cost a toolbar re-layout on each switch.
struct SessionMenu: View {
    let workbench: Workbench
    let session: Session
    @Binding var inspectorTab: InspectorTab
    @Binding var inspectorOpen: Bool
    /// What opens the menu in a drawn header (the conversation's title); the toolbar's ⋯ when nil.
    var label: AnyView? = nil
    /// Where [label]'s menu opens, when a part of it marks the place (the title's chevron).
    var anchor: MenuAnchor? = nil
    /// The header beside it has its own buttons for the terminal and the panel's views, so the menu
    /// leaves them out.
    var panelsInHeader = false
    /// 会话信息 beside it holds the branch, the panel's views and the terminal; the menu keeps to what
    /// can be done to the session.
    var infoInHeader = false
    @State private var restartBinding: SessionNativeRuntime?
    @State private var editingTags = false
    @State private var sharePurpose: SessionSharePurpose?
    @State private var renaming = false
    @State private var draft = ""
    @State private var orchestrator = SessionOrchestrator()
    @State private var savingAsProject = false
    @State private var projectName = ""
    @State private var projectError: String?
    @State private var resuming = false

    var body: some View {
        menuButton
            // The side panel's status for the project, read once for both when they ask together.
            .task(id: "\(session.projectId)|\(session.state)|\(inspectorOpen)") {
                guard session.agentID != AgentDirectory.quickChat else { return }
                await GitStatusModel.model(for: session.projectId).load(workbench.host.api)
            }
            .sessionOrchestration(orchestrator, workbench: workbench, session: session)
            .sheet(item: $sharePurpose) { purpose in
                SessionShareSheet(workbench: workbench, session: session, purpose: purpose)
            }
            .sheet(isPresented: $resuming) {
                TerminalResumeSheet(workbench: workbench, session: session)
            }
            .sheet(isPresented: $editingTags) {
                TagEditor(title: String(localized: "编辑会话标签"), tags: session.tags, suggestions: workbench.sessionTags) { tags in
                    Task { await workbench.update(session, tags: tags) }
                }
            }
            .alert("重启并应用？", isPresented: Binding(get: { restartBinding != nil }, set: { if !$0 { restartBinding = nil } })) {
                Button("取消", role: .cancel) { restartBinding = nil }
                Button("重启并应用", role: .destructive) {
                    let binding = restartBinding
                    restartBinding = nil
                    Task {
                        if let error = await workbench.reopen(session, restartBinding: binding) {
                            workbench.notice = SessionNotice(sessionId: session.id, text: error)
                        }
                    }
                }
            } message: { Text("运行中的任务会中断，对话记录保留") }
            .alert("保存为项目", isPresented: $savingAsProject) {
                TextField("名称", text: $projectName)
                Button("取消", role: .cancel) {}
                Button("保存") {
                    let name = projectName.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !name.isEmpty, let project = workbench.project(session.projectId) else { return }
                    Task {
                        do { try await workbench.promoteProject(project, name: name) }
                        catch { projectError = error.riffetMessage }
                    }
                }
            }
            .alert("操作失败", isPresented: Binding(get: { projectError != nil }, set: { if !$0 { projectError = nil } })) {
                Button("好") {}
            } message: { Text(projectError ?? "") }
            .alert("重命名会话", isPresented: $renaming) {
                TextField("标题", text: $draft)
                Button("取消", role: .cancel) {}
                Button("保存") {
                    let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !title.isEmpty { Task { await workbench.update(session, title: title) } }
                }
            }
    }

    @ViewBuilder
    private var menuButton: some View {
        if let label {
            MenuLabelButton(label: label, anchor: anchor, build: makeMenu)
        } else {
            ToolbarMenuButton(symbol: "ellipsis", help: String(localized: "更多操作"), build: makeMenu)
        }
    }

    private func makeMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let session = workbench.selected ?? session
        let quickChat = session.agentID == AgentDirectory.quickChat
        let git = quickChat ? nil : GitStatusModel.model(for: session.projectId).status
        let state = ConversationState(workbench: workbench, session: session, catalog: workbench.catalogs.cached(for: session))
        func add(_ title: String, _ symbol: String, _ action: @escaping () -> Void) -> NSMenuItem {
            let item = MenuAction.item(title, action)
            item.image = NSImage.icon(symbol, accessibilityDescription: nil)
            menu.addItem(item)
            return item
        }
        // The web's menu shape: the branch line names the branch and nothing else, and the
        // change summary rides the 变更 item it opens.
        let changeSummary = git.flatMap { status in
            status.entries.isEmpty ? nil : String(localized: "\(status.entries.count) 个文件，+\(status.added?.int64Value ?? 0) −\(status.removed?.int64Value ?? 0)")
        }
        if !infoInHeader, let git, !git.branch.isEmpty {
            menu.addItem(.sectionHeader(title: String(localized: "当前分支")))
            _ = add(git.branch, "arrow.triangle.branch") { copyToPasteboard(git.branch) }
            menu.addItem(.separator())
        }
        if state.supportsTerminal {
            let terminal = workbench.showsTerminalPage
            let item = add(terminal ? String(localized: "切换对话视图") : String(localized: "切换终端视图"), terminal ? "bubble.left.and.text.bubble.right" : "terminal") { workbench.toggleTerminalPage() }
            item.keyEquivalent = "t"
            item.keyEquivalentModifierMask = [.command, .shift]
            menu.addItem(.separator())
        }
        if state.needsResume, !quickChat, !workbench.providerMissing(for: session) {
            let item = add(String(localized: "恢复会话"), "arrow.clockwise") {
                Task { _ = await workbench.reopen(session) }
            }
            item.isEnabled = !workbench.reopening && (session.model == nil || workbench.catalogs.cached(for: session) != nil)
            menu.addItem(.separator())
        }
        if session.archivedAt == nil, workbench.status?.profilePending?.boolValue == true, let binding = session.nativeRuntime {
            let item = add(String(localized: "重启并应用"), "arrow.clockwise") { restartBinding = binding }
            item.isEnabled = !workbench.reopening
            menu.addItem(.separator())
        }
        if let actions = workbench.runtimeControl?.actions, !actions.isEmpty {
            for action in actions {
                let item = add(localizedText(action.label, fallback: action.id), "puzzlepiece.extension") {
                    Task { await workbench.runRuntimeAction(action, for: session.id) }
                }
                if let hint = action.hint { item.subtitle = localizedText(hint, fallback: "") }
                item.isEnabled = !workbench.runtimeActionPending && action.disabled != true
            }
            menu.addItem(.separator())
        }
        if !quickChat {
            if workbench.supportsProjectlessTasks, let project = workbench.project(session.projectId), project.isTaskWorkspace {
                _ = add(String(localized: "保存为项目"), "folder.badge.plus") { projectName = session.title; savingAsProject = true }
            }
        }
        if !quickChat, !panelsInHeader, !infoInHeader {
            for view in workbench.inspectorViews {
                let item = add(view.title, view.symbol) { inspectorTab = view.tab; inspectorOpen = true }
                if view.tab == .changes, let changeSummary { item.subtitle = changeSummary }
            }
            let terminal = add(workbench.terminalDock.openingShell ? String(localized: "正在打开终端…") : String(localized: "打开终端"), "terminal") {
                Task { await workbench.terminalDock.openShell(projectId: session.projectId) }
            }
            terminal.isEnabled = !workbench.terminalDock.openingShell
        }
        if workbench.role == .main {
            let window = add(String(localized: "在新窗口中打开"), "macwindow.badge.plus") { WindowRouter.shared.openConversation(session.id) }
            window.keyEquivalent = "o"
            window.keyEquivalentModifierMask = [.command, .option]
        }
        if session.archivedAt == nil, !quickChat, session.terminalHold == nil, session.nativeSessionId != nil {
            _ = add(String(localized: "在终端恢复…"), "terminal") { resuming = true }
        }
        menu.addItem(.separator())
        if session.archivedAt == nil, !quickChat {
            if session.handedOffTo == nil {
                _ = add(String(localized: "交接会话…"), "arrow.left.arrow.right") { orchestrator.handoff() }
            }
            _ = add(String(localized: "存为定时任务…"), "clock") { orchestrator.saveAsAutomation(session: session, workbench: workbench) }
        }
        _ = add(String(localized: "分享会话…"), "link") { sharePurpose = .link }
        _ = add(String(localized: "导出为 PDF…"), "doc.richtext") { sharePurpose = .pdf }
        _ = add(String(localized: "导出会话…"), "square.and.arrow.up") { orchestrator.export(session: session, workbench: workbench) }
        menu.addItem(.separator())
        _ = add(String(localized: "重命名"), "pencil") { draft = session.title; renaming = true }
        _ = add(String(localized: "编辑标签"), "tag") { editingTags = true }
        let pinned = session.pinnedAt != nil
        _ = add(pinned ? String(localized: "取消置顶") : String(localized: "置顶会话"), pinned ? "pin.slash" : "pin") { Task { await workbench.update(session, pinned: !pinned) } }
        menu.addItem(.separator())
        let archived = session.archivedAt != nil
        _ = add(archived ? String(localized: "取消归档") : String(localized: "归档会话"), archived ? "tray.and.arrow.up" : "archivebox") { Task { await workbench.update(session, archived: !archived) } }
        if workbench.list.canDeleteSessions {
            let delete = add(String(localized: "删除…"), "trash") { Task { await workbench.requestDeletion(session) } }
            delete.isEnabled = workbench.deletionLoading == nil
        }
        return menu
    }

}

/// A toolbar button that opens an AppKit menu built at that moment.
struct ToolbarMenuButton: NSViewRepresentable {
    let symbol: String
    let help: String
    let build: () -> NSMenu

    final class Coordinator: NSObject {
        var build: (() -> NSMenu)?
        var symbol = ""

        @MainActor @objc func open(_ sender: NSButton) {
            guard let menu = build?() else { return }
            menu.popUpStyled(at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(image: NSImage.icon(symbol, accessibilityDescription: help) ?? NSImage(), target: context.coordinator, action: #selector(Coordinator.open(_:)))
        // Pinned to the size SwiftUI gives a toolbar item's symbol: unpinned, the image takes the
        // size of whichever toolbar group holds it, and changes when the sidebar folds.
        button.symbolConfiguration = NSImage.SymbolConfiguration(textStyle: .body, scale: .large)
        button.isBordered = false
        button.bezelStyle = .toolbar
        button.imagePosition = .imageOnly
        button.toolTip = help
        button.setAccessibilityLabel(help)
        return button
    }

    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.build = build
        button.isEnabled = context.environment.isEnabled
        // The help can change with what the menu offers (the export's time, say).
        if button.toolTip != help {
            button.toolTip = help
            button.setAccessibilityLabel(help)
        }
        if context.coordinator.symbol != symbol {
            if !context.coordinator.symbol.isEmpty { button.image = NSImage.icon(symbol, accessibilityDescription: help) }
            context.coordinator.symbol = symbol
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSButton, context: Context) -> CGSize? {
        CGSize(width: 28, height: 28)
    }
}

/// Edits a list of tags: chips that remove, a field that adds, and the tags already in use.
struct TagEditor: View {
    let title: String
    let tags: [String]
    let suggestions: [String]
    let save: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var current: [String] = []
    @State private var input = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Text(title).font(.riffet(size: S(16), weight: .semibold))
            FlowLayout(spacing: 6) {
                ForEach(current, id: \.self) { tag in
                    HStack(spacing: 4) {
                        Text(tag).font(.riffet(size: S(12)))
                        Button { current.removeAll { $0 == tag } } label: { Image(icon: "xmark").font(.riffet(size: S(8), weight: .bold)) }
                            .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 24)
                    .background(palette.bgMuted, in: Capsule())
                }
                if current.isEmpty { Text("还没有标签").font(.riffet(size: S(12))).foregroundStyle(palette.fg4) }
            }
            TextField("输入标签后按回车", text: $input)
                .textFieldStyle(.roundedBorder)
                .onSubmit(add)
            let unused = suggestions.filter { !current.contains($0) }
            if !unused.isEmpty {
                Text("已有标签").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                FlowLayout(spacing: 6) {
                    ForEach(unused, id: \.self) { tag in
                        Button(tag) { current.append(tag) }.buttonStyle(ChipButtonStyle())
                    }
                }
            }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(SolidButtonStyle(kind: .secondary))
                Button("保存") { add(); save(current); dismiss() }.keyboardShortcut(.defaultAction).buttonStyle(SolidButtonStyle(kind: .primary))
            }
        }
        .padding(Space.xl)
        .frame(width: 420)
        .onAppear { current = tags }
    }

    private func add() {
        let tag = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tag.isEmpty, !current.contains(tag), tag.count <= 40 else { input = ""; return }
        current.append(tag)
        input = ""
    }
}

/// Actions the menu bar commands send to the focused window.
struct WorkbenchActions {
    let newSession: () -> Void
    let toggleInspector: () -> Void
    let showInspector: (InspectorTab) -> Void
    let toggleInspectorMaximized: () -> Void
    let openPalette: () -> Void
    let interrupt: () -> Void
    let refresh: () -> Void
    let toggleSidebar: () -> Void
    let openPage: (WorkbenchPage) -> Void
    let previousSession: () -> Void
    let nextSession: () -> Void
    /// The session tab bar's commands; nil while no bar is on screen, when the keys keep their other meanings.
    let tabs: SessionTabCommands?
    /// ⌘1…⌘9, zero-based.
    let openSession: (Int) -> Void
    /// The palette on titles (⌘K) or on message content (⇧⌘F).
    let search: () -> Void
    let searchContent: () -> Void
    /// ⌘P: a project file by name.
    let quickOpen: () -> Void
    /// 会话内查找: ⌘F, ⌘G and ⇧⌘G.
    let find: () -> Void
    let findNext: () -> Void
    let findPrevious: () -> Void
    let toggleTerminalView: () -> Void
    let toggleTerminal: () -> Void
    /// Opens the shown conversation in its own window; nil in a window that already is one.
    let openInWindow: (() -> Void)?
    /// The plugin commands on offer, by id (`PluginKeybindingMenu`).
    let pluginCommands: [String: () -> Void]
}

struct WorkbenchActionsKey: FocusedValueKey {
    typealias Value = WorkbenchActions
}

extension FocusedValues {
    var workbenchActions: WorkbenchActions? {
        get { self[WorkbenchActionsKey.self] }
        set { self[WorkbenchActionsKey.self] = newValue }
    }
}

struct RiffetCommands: Commands {
    let model: AppModel
    @FocusedValue(\.workbenchActions) private var actions
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("检查更新…") { Updater.shared.checkForUpdates() }
                .disabled(!Updater.shared.available)
        }
        CommandGroup(replacing: .help) {
            Button("Riffet 文档") {
                if let url = URL(string: "https://github.com/riffable/riffet#readme") { NSWorkspace.shared.open(url) }
            }
            Button("诊断…") {
                UserDefaults.standard.set(SettingsSection.diagnostics.rawValue, forKey: PreferenceKey.settingsSection)
                WindowRouter.shared.showSettings()
            }
            Divider()
            Button("界面风格设计稿") { openWindow(id: InterfaceStyleDraftsWindow.id) }
        }
        // 显示: what is on screen — the sidebar, the inspector and its panels, the terminal — then
        // the appearance and the text size.
        CommandGroup(after: .toolbar) {
            Divider()
            Button("显示/隐藏侧栏") { actions?.toggleSidebar() }.keyboardShortcut("b")
            Button("显示/隐藏检查器") { actions?.toggleInspector() }.keyboardShortcut("i", modifiers: [.command, .option])
            Button("变更") { actions?.showInspector(.changes) }.keyboardShortcut("1", modifiers: [.command, .option])
            Button("文件") { actions?.showInspector(.files) }.keyboardShortcut("2", modifiers: [.command, .option])
            Button("检查器全屏") { actions?.toggleInspectorMaximized() }.keyboardShortcut("f", modifiers: [.command, .option])
            Divider()
            Button("显示/隐藏终端") { actions?.toggleTerminal() }.keyboardShortcut("`", modifiers: [.control])
            // ⇧⌘T reopens a closed tab while the tab bar is on.
            Button("切换对话/终端视图") { actions?.toggleTerminalView() }
                .keyboardShortcut(actions?.tabs == nil ? KeyboardShortcut("t", modifiers: [.command, .shift]) : nil)
            Divider()
            Button("刷新") { actions?.refresh() }.keyboardShortcut("r")
            Divider()
            Menu("外观") { AppearanceMenuItems() }
            Divider()
            Button("放大") { DisplayPreferences.shared.stepTextScale(1) }
                .keyboardShortcut("+")
                .disabled(DisplayPreferences.shared.textScale >= DisplayPreferences.textScales.last ?? 1.2)
            Button("缩小") { DisplayPreferences.shared.stepTextScale(-1) }
                .keyboardShortcut("-")
                .disabled(DisplayPreferences.shared.textScale <= DisplayPreferences.textScales.first ?? 0.9)
            Button("实际大小") { DisplayPreferences.shared.textScale = 1.0 }
                .keyboardShortcut("0")
                .disabled(DisplayPreferences.shared.textScale == 1.0)
        }
        // AppKit repopulates the Services submenu, reading every installed service's strings from
        // disk, on each key press while a text view has focus; the app has no use for it.
        CommandGroup(replacing: .systemServices) {}
        CommandGroup(replacing: .newItem) {
            Button("新会话") { WindowRouter.shared.showMain(); actions?.newSession() }
                .keyboardShortcut("n")
        }
        // ⌘W closes the tab on screen, else the window.
        CommandGroup(replacing: .saveItem) {
            Button("关闭") {
                // A sheet over the window takes the key, not the tab under it.
                let sheet = NSApp.keyWindow?.attachedSheet != nil
                if sheet || actions?.tabs?.closeCurrent() != true { NSApp.keyWindow?.performClose(nil) }
            }
            .keyboardShortcut("w")
        }
        // 前往: the palette, the pages, and moving between conversations.
        CommandMenu("前往") {
            Button("搜索…") { actions?.search() }.keyboardShortcut("k")
            Button("搜索内容…") { actions?.searchContent() }.keyboardShortcut("f", modifiers: [.command, .shift])
            Button("在会话中查找") { actions?.find() }.keyboardShortcut("f")
            Button("下一个") { actions?.findNext() }.keyboardShortcut("g")
            Button("上一个") { actions?.findPrevious() }.keyboardShortcut("g", modifiers: [.command, .shift])
            Button("命令…") { actions?.openPalette() }.keyboardShortcut("p", modifiers: [.command, .shift])
            Button("快速打开…") { actions?.quickOpen() }.keyboardShortcut("p")
            Divider()
            Button(WorkbenchPage.marks.title) { actions?.openPage(.marks) }.keyboardShortcut("l", modifiers: [.command, .shift])
            Button(WorkbenchPage.tasks.title) { actions?.openPage(.tasks) }.keyboardShortcut("j", modifiers: [.command, .shift])
            Button(WorkbenchPage.extensions.title) { actions?.openPage(.extensions) }.keyboardShortcut("e", modifiers: [.command, .shift])
            Button(WorkbenchPage.stats.title) { actions?.openPage(.stats) }.keyboardShortcut("u", modifiers: [.command, .shift])
            Button(WorkbenchPage.activity.title) { actions?.openPage(.activity) }
            Divider()
            Button("上一个会话") { actions?.previousSession() }.keyboardShortcut("[", modifiers: [.command, .shift])
            Button("下一个会话") { actions?.nextSession() }.keyboardShortcut("]", modifiers: [.command, .shift])
            if let tabs = actions?.tabs {
                Button("下一个标签") { tabs.step(1) }.keyboardShortcut(.tab, modifiers: .control)
                Button("上一个标签") { tabs.step(-1) }.keyboardShortcut(.tab, modifiers: [.control, .shift])
                Button("重新打开关闭的标签") { tabs.reopen() }.keyboardShortcut("t", modifiers: [.command, .shift])
            }
            Menu(actions?.tabs == nil ? "侧栏会话" : "标签页") {
                ForEach(1...9, id: \.self) { number in
                    Button("第 \(number) 个") {
                        if let tabs = actions?.tabs { tabs.goTo(number) } else { actions?.openSession(number - 1) }
                    }
                    .keyboardShortcut(KeyEquivalent(Character(String(number))))
                }
            }
        }
        PluginKeybindingMenu(run: actions?.pluginCommands)
        // 会话: actions on the open conversation only.
        CommandMenu("会话") {
            Button("中断") { actions?.interrupt() }.keyboardShortcut(".")
            Divider()
            Button("在新窗口中打开") { actions?.openInWindow?() }
                .keyboardShortcut("o", modifiers: [.command, .option])
                .disabled(actions?.openInWindow == nil)
        }
    }
}

extension DisplayPreferences {
    /// The text sizes the settings offer, in the order they step through.
    static let textScales = [0.9, 1.0, 1.1, 1.2]

    func stepTextScale(_ step: Int) {
        let index = Self.textScales.enumerated().min { abs($0.element - textScale) < abs($1.element - textScale) }?.offset ?? 1
        textScale = Self.textScales[min(max(index + step, 0), Self.textScales.count - 1)]
    }
}

/// The divider for the side inspector or bottom terminal dock.
struct PanelResizeHandle: View {
    @Binding var size: Double
    let limit: CGFloat
    var minimum: Double = 300
    var axis: Axis = .horizontal
    /// Off between two cards: the gap is the edge, and only the pointer shows it can be dragged.
    var drawn = true
    @Environment(\.palette) private var palette
    @State private var start: Double?
    @State private var hovering = false

    var body: some View {
        Rectangle()
            .fill(drawn ? (hovering || start != nil ? palette.lineStrong : palette.line) : .clear)
            .frame(width: axis == .horizontal ? 1 : nil, height: axis == .vertical ? 1 : nil)
            // The system owns the cursor while the pointer is over the handle; nothing to restore when
            // the handle goes away mid-hover.
            .overlay(
                Color.clear.frame(width: axis == .horizontal ? 8 : nil, height: axis == .vertical ? 8 : nil)
                    .contentShape(Rectangle())
                    .pointerStyle(axis == .horizontal ? .columnResize : .rowResize)
            )
            .onHover { hovering = $0 }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { value in
                        let origin = start ?? min(max(size, minimum), Double(limit))
                        start = origin
                        let translation = axis == .horizontal ? value.translation.width : value.translation.height
                        size = min(max(origin - translation, minimum), Double(limit))
                    }
                    .onEnded { _ in start = nil }
            )
            .accessibilityElement()
            .accessibilityLabel(axis == .horizontal ? "检查器宽度" : "终端高度")
            .accessibilityAdjustableAction { direction in
                size = min(max(size + (direction == .increment ? 20 : -20), minimum), Double(limit))
            }
    }
}
