import AppKit
import UniformTypeIdentifiers
import SwiftUI
import RiffetKit

/// The conversation's terminal (the CLI's own TUI) or a shell in the project, rendered behind
/// [TerminalSurfaceBackend] over `WS /api/terminals/:id/ws`. Control and resize follow the phone's
/// `TerminalConnection`: this Mac watches until it types, and only the controlling client resizes the pane.
struct TerminalPanel: View {
    let workbench: Workbench
    let project: Project
    let session: Session?
    @Environment(\.palette) private var palette
    @State private var shells: [TerminalInfo] = []
    @State private var error: String?

    private var selection: String? { workbench.terminalDock.selections[project.id] }

    private var options: [(id: String, title: String)] {
        var result: [(String, String)] = []
        if let id = session?.terminalId { result.append((id, String(localized: "Agent 终端"))) }
        result += shells.map { shell in
            let name = [shell.paneTitle, shell.foregroundCommand, shell.title]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { !$0.isEmpty } ?? "Shell"
            return (shell.id, name)
        }
        return result
    }

    var body: some View {
        VStack(spacing: 0) {
            if let error { Text(error).font(RiffetFont.caption).foregroundStyle(palette.danger).padding(6) }
            if let selection {
                TerminalSurface(
                    workbench: workbench, terminalId: selection,
                    title: options.first { $0.id == selection }?.title ?? "Shell", options: options,
                    onSelect: { workbench.terminalDock.select($0, projectId: project.id) },
                    onNew: { Task { await workbench.terminalDock.openShell(projectId: project.id, createNew: true) } },
                    onTerminate: shells.contains { $0.id == selection } ? { Task { await close(selection) } } : nil,
                    onCollapse: hide, focusRequest: workbench.terminalDock.focusRequest
                )
                    .id(selection)
            } else {
                HStack {
                    Text("终端").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    Spacer()
                    Button(action: hide) { Image(icon: "chevron.down").font(.riffet(size: S(11))) }
                        .buttonStyle(IconButtonStyle(size: 24)).help("收起终端面板")
                        .accessibilityLabel("收起终端面板")
                }
                .padding(.horizontal, Space.sm).frame(height: InspectorMetrics.headerHeight)
                ContentUnavailableView {
                    Label("没有终端", icon: "terminal")
                } actions: {
                    Button("新建 Shell") { Task { await workbench.terminalDock.openShell(projectId: project.id, createNew: true) } }
                        .buttonStyle(ChipButtonStyle()).disabled(workbench.terminalDock.openingShell)
                }
            }
        }
        .onChange(of: session?.terminalId) { _, id in
            if selection == nil { workbench.terminalDock.selections[project.id] = id }
        }
        .task(id: project.id) { await loadShells() }
        .onChange(of: workbench.terminalDock.focus?.id, initial: true) { _, _ in
            guard let terminal = workbench.terminalDock.focus, terminal.projectId == project.id else { return }
            if !shells.contains(where: { $0.id == terminal.id }) { shells.append(terminal) }
            workbench.terminalDock.selections[project.id] = terminal.id
            workbench.terminalDock.focus = nil
        }
    }

    /// Shells already running in this project, so a reopened panel finds them again.
    private func loadShells() async {
        let knownIds = Set(shells.map(\.id))
        guard let all = try? await workbench.host.api?.terminals(), !Task.isCancelled else { return }
        let loaded = all.filter { $0.projectId == project.id && $0.kind == .shell && $0.state != .exited }
        // A create/open action can add a shell while this older list request is in flight.
        let added = shells.filter { shell in !knownIds.contains(shell.id) && !loaded.contains { $0.id == shell.id } }
        shells = loaded + added
        if !options.contains(where: { $0.id == selection }) {
            workbench.terminalDock.selections[project.id] = options.first?.id
        }
    }

    private func close(_ id: String) async {
        do {
            guard let api = workbench.host.api else { throw LocalPairing.Failure(message: String(localized: "服务器未连接，请稍后重试")) }
            _ = try await api.closeTerminal(id: id)
            workbench.terminalDock.evictController(for: id)
            shells.removeAll { $0.id == id }
            error = nil
            if selection == id { workbench.terminalDock.select(options.first?.id, projectId: project.id) }
        } catch {
            self.error = error.riffetMessage
        }
    }

    private func hide() {
        workbench.terminalDock.hide()
        NotificationCenter.default.post(name: .riffetFocusComposer, object: workbench)
    }
}

/// One title row: the menu manages terminals, the chevron collapses the dock, and X ends
/// the selected shell. Agent terminals expose only collapse, keeping the session running.
struct TerminalSurface<Accessory: View>: View {
    let workbench: Workbench
    let terminalId: String
    var title = String(localized: "Agent 终端")
    var options: [(id: String, title: String)] = []
    var onSelect: ((String) -> Void)?
    var onNew: (() -> Void)?
    var onTerminate: (() -> Void)?
    var onCollapse: (() -> Void)?
    var focusRequest = 0
    var allowPopOut = true
    var clientIdOverride: String?
    var controllerOverride: TerminalController?
    @ViewBuilder var accessory: Accessory
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    @State private var confirmInterrupt = false
    @State private var confirmTerminate = false
    @State private var error: String?
    @State private var menuAnchor = MenuAnchor()
    @State private var searchQuery = ""
    @State private var searchCaseSensitive = false
    @State private var searchRegex = false
    @State private var searchSummary: (index: Int, total: Int) = (0, 0)
    @FocusState private var searchFieldFocused: Bool

    private var controller: TerminalController { controllerOverride ?? workbench.terminalDock.controller(for: terminalId) }
    private var resolvedClientId: String { clientIdOverride ?? workbench.terminalClientId }
    private var displayTitle: String { controller.displayTitle(fallback: title) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.sm) {
                Button { showMenu() } label: {
                    HStack(spacing: 6) {
                        Image(icon: "terminal")
                        Text(displayTitle).lineLimit(1)
                        Image(icon: "ellipsis").font(.riffet(size: S(11), weight: .semibold))
                    }
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg3)
                }
                .buttonStyle(ChipButtonStyle())
                .background(MenuAnchorView(anchor: menuAnchor))
                .help(controller.cwd.map { "\($0) · \(controller.status)" } ?? "终端菜单 · \(controller.status)")
                .accessibilityLabel("\(displayTitle)菜单")
                if let code = controller.lastExitCode, code != 0 {
                    Text("\(code)")
                        .font(RiffetFont.codeSmall)
                        .foregroundStyle(palette.danger)
                        .padding(.horizontal, Space.xs)
                        .padding(.vertical, Space.xxs)
                        .background(palette.danger.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.control))
                        .help("上一条命令退出码")
                }
                if !controller.live { Text(controller.status).font(.riffet(size: S(11))).foregroundStyle(palette.fg4).lineLimit(1) }
                if controller.pasting { Spinner(size: .small) }
                Spacer(minLength: Space.sm)
                Button { toggleSearch() } label: {
                    Image(icon: "magnifyingglass").font(RiffetFont.caption)
                }
                .buttonStyle(IconButtonStyle(size: 24))
                .help("在终端中查找 (⌘F)")
                .accessibilityLabel("在终端中查找")
                if allowPopOut {
                    Button { popOutWindow() } label: {
                        Image(icon: "macwindow.badge.plus").font(RiffetFont.caption)
                    }
                    .buttonStyle(IconButtonStyle(size: 24))
                    .help("在新窗口中打开")
                    .accessibilityLabel("在新窗口中打开")
                }
                if let onCollapse {
                    Button(action: onCollapse) { Image(icon: "chevron.down").font(.riffet(size: S(11), weight: .semibold)) }
                        .buttonStyle(IconButtonStyle(size: 24))
                        .help("收起终端面板（进程继续运行）")
                        .accessibilityLabel("收起终端面板")
                }
                if onTerminate != nil {
                    Button { confirmTerminate = true } label: {
                        Image(icon: "xmark").font(.riffet(size: S(11), weight: .semibold))
                    }
                    .buttonStyle(IconButtonStyle(size: 24))
                    .help("关闭当前 Shell")
                    .accessibilityLabel("关闭当前 Shell")
                }
                accessory
            }
            .padding(.horizontal, Space.md)
            .frame(height: InspectorMetrics.headerHeight)
            PanelRule()
            if controller.searchOpen {
                searchBar
                PanelRule()
            }
            if let error { Text(error).font(RiffetFont.caption).foregroundStyle(palette.danger).padding(6) }
            if let notice = controller.pasteNotice { Text(notice).font(RiffetFont.caption).foregroundStyle(palette.danger).padding(6) }
            ZStack(alignment: .bottomTrailing) {
                TerminalHost(
                    controller: controller, theme: ThemeStore.shared.entry,
                    dark: colorScheme == .dark,
                    fontFamily: DisplayPreferences.shared.terminalFontFamily,
                    fontSize: CGFloat(DisplayPreferences.shared.terminalFontSize),
                    fontWeight: DisplayPreferences.shared.terminalFontWeight,
                    fonts: AppearanceStore.shared.fonts.key,
                    cursorStyle: DisplayPreferences.shared.terminalCursorStyle,
                    cursorBlink: DisplayPreferences.shared.terminalCursorBlink,
                    optionAsMeta: DisplayPreferences.shared.terminalOptionAsMeta,
                    copyOnSelect: DisplayPreferences.shared.terminalCopyOnSelect,
                    rightClick: DisplayPreferences.shared.terminalRightClick,
                    scrollOnInput: DisplayPreferences.shared.terminalScrollOnInput,
                    scrollOnOutput: DisplayPreferences.shared.terminalScrollOnOutput,
                    scrollSensitivity: DisplayPreferences.shared.terminalScrollSensitivity
                )
                .padding(.horizontal, CGFloat(DisplayPreferences.shared.terminalHorizontalPadding))
                .padding(.vertical, CGFloat(DisplayPreferences.shared.terminalVerticalPadding))
                .overlay {
                    if controller.bellFlash {
                        Rectangle()
                            .strokeBorder(palette.accent, lineWidth: 2)
                            .allowsHitTesting(false)
                    }
                }
                if !controller.hasOutput, !controller.live, !controller.exited {
                    // Until the first snapshot arrives the surface is blank: say why.
                    VStack(spacing: Space.sm) {
                        if !controller.failed { Spinner(size: .small) }
                        Text(controller.failed ? controller.status : String(localized: "正在连接终端…"))
                            .font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                }
                if !controller.atBottom {
                    Button {
                        controller.backend?.scrollToLive()
                        controller.focus()
                    } label: {
                        Label("回到实时", icon: "arrow.down")
                            .font(.riffet(size: S(11)))
                    }
                    .buttonStyle(ChipButtonStyle())
                    .padding(Space.sm)
                }
            }
        }
        .background(palette.bg)
        .onAppear { controller.start(host: workbench.host, terminalId: terminalId, clientId: resolvedClientId) }
        .onChange(of: controller.searchOpen) { _, open in
            if open { searchFieldFocused = true; runSearch(forward: true) }
        }
        .onChange(of: searchQuery) { _, _ in if controller.searchOpen { runSearch(forward: true) } }
        .onChange(of: searchCaseSensitive) { _, _ in if controller.searchOpen { runSearch(forward: true) } }
        .onChange(of: searchRegex) { _, _ in if controller.searchOpen { runSearch(forward: true) } }
        .onChange(of: focusRequest, initial: true) { _, request in
            if request > 0, !workbench.terminalDock.automatic { controller.focus() }
        }
        .confirmationDialog("中断当前进程？", isPresented: $confirmInterrupt) {
            Button("中断", role: .destructive) { Task { await interrupt() } }
        } message: {
            Text("会向终端发送 Ctrl+C。Agent 会停止当前任务，并可能接着发送它自己排队的消息。")
        }
        .confirmationDialog("关闭当前 Shell？", isPresented: $confirmTerminate) {
            Button("关闭 Shell", role: .destructive) { onTerminate?() }
        } message: {
            Text("这个 Shell 及其中运行的进程将结束。")
        }
    }

    private var searchBar: some View {
        HStack(spacing: Space.xs) {
            Image(icon: "magnifyingglass")
                .font(RiffetFont.caption)
                .foregroundStyle(palette.fg4)
            TextField("查找", text: $searchQuery)
                .textFieldStyle(.plain)
                .font(RiffetFont.caption)
                .focused($searchFieldFocused)
                .onSubmit { runSearch(forward: true) }
                .onExitCommand { closeSearch() }
            if !searchQuery.isEmpty {
                Text("\(searchSummary.index)/\(searchSummary.total)")
                    .font(RiffetFont.codeSmall)
                    .foregroundStyle(searchSummary.total == 0 ? palette.danger : palette.fg3)
            }
            Button { searchCaseSensitive.toggle() } label: {
                Text(verbatim: "Aa").font(RiffetFont.codeSmall)
                    .foregroundStyle(searchCaseSensitive ? palette.accent : palette.fg3)
            }
            .buttonStyle(IconButtonStyle(size: 22))
            .help("区分大小写")
            Button { searchRegex.toggle() } label: {
                Text(verbatim: ".*").font(RiffetFont.codeSmall)
                    .foregroundStyle(searchRegex ? palette.accent : palette.fg3)
            }
            .buttonStyle(IconButtonStyle(size: 22))
            .help("正则表达式")
            Button { runSearch(forward: false) } label: {
                Image(icon: "arrow.up").font(RiffetFont.caption)
            }
            .buttonStyle(IconButtonStyle(size: 22))
            .disabled(searchQuery.isEmpty)
            .help("上一个匹配")
            Button { runSearch(forward: true) } label: {
                Image(icon: "arrow.down").font(RiffetFont.caption)
            }
            .buttonStyle(IconButtonStyle(size: 22))
            .disabled(searchQuery.isEmpty)
            .help("下一个匹配")
            Button { closeSearch() } label: {
                Image(icon: "xmark").font(RiffetFont.caption)
            }
            .buttonStyle(IconButtonStyle(size: 22))
            .help("关闭查找")
        }
        .padding(.horizontal, Space.md)
        .frame(height: InspectorMetrics.headerHeight)
        .background(palette.bgElevated)
    }

    private func toggleSearch() {
        if controller.searchOpen { closeSearch() }
        else { controller.searchOpen = true; searchFieldFocused = true }
    }

    private func popOutWindow() {
        if let onCollapse { onCollapse() }
        WindowRouter.shared.openTerminal(terminalId)
    }

    private func closeSearch() {
        controller.searchOpen = false
        controller.backend?.clearSearch()
        searchSummary = (0, 0)
        controller.focus()
    }

    private func runSearch(forward: Bool) {
        guard let backend = controller.backend else { return }
        if searchQuery.isEmpty {
            backend.clearSearch()
            searchSummary = (0, 0)
            return
        }
        if forward { _ = backend.findNext(searchQuery, caseSensitive: searchCaseSensitive, regex: searchRegex) }
        else { _ = backend.findPrevious(searchQuery, caseSensitive: searchCaseSensitive, regex: searchRegex) }
        searchSummary = backend.searchMatchSummary(searchQuery, caseSensitive: searchCaseSensitive, regex: searchRegex)
    }

    /// Connection updates leave this snapshot alone. Actions run after tracking ends so selecting
    /// another terminal cannot destroy the menu's hosting view while AppKit still uses it.
    private func showMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        var selected: (() -> Void)?
        @discardableResult
        func add(_ title: String, _ action: @escaping () -> Void) -> NSMenuItem {
            let item = MenuAction.item(title) { selected = action }
            menu.addItem(item)
            return item
        }
        if let onSelect {
            for option in options {
                let item = add(option.title) { if option.id != terminalId { onSelect(option.id) } }
                item.state = option.id == terminalId ? .on : .off
            }
        }
        if let onNew {
            add(String(localized: "新建 Shell")) { if !workbench.terminalDock.openingShell { onNew() } }.isEnabled = !workbench.terminalDock.openingShell
        }
        menu.addItem(.separator())
        let status = NSMenuItem(title: controller.status, action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        if controller.live {
            if controller.hasControl {
                add(String(localized: "释放控制权")) {
                    if controller.live, controller.hasControl { controller.connection?.release() }
                }
            } else {
                add(String(localized: "接管终端")) {
                    if controller.live, !controller.hasControl { controller.connection?.takeOver(); controller.focus() }
                }
            }
        }
        if !controller.atBottom {
            add(String(localized: "返回实时终端")) { controller.backend?.scrollToLive() }
        }
        add(String(localized: "在终端中查找…")) { controller.searchOpen = true; searchFieldFocused = true }
        if allowPopOut {
            add(String(localized: "在新窗口中打开")) { popOutWindow() }
        }
        if controller.backend?.hasPromptMarkers == true {
            add(String(localized: "跳到上一条命令")) { controller.backend?.jumpToPreviousPrompt() }
            add(String(localized: "跳到下一条命令")) { controller.backend?.jumpToNextPrompt() }
        }
        if controller.running { add(String(localized: "中断当前命令 (Ctrl+C)")) { if controller.running { confirmInterrupt = true } } }
        if !controller.live, !controller.exited {
            add(String(localized: "重新连接")) {
                if !controller.live, !controller.exited { controller.reconnect(host: workbench.host, terminalId: terminalId, clientId: resolvedClientId) }
            }
        }
        if onTerminate != nil {
            menu.addItem(.separator())
            add(String(localized: "关闭当前 Shell")) { confirmTerminate = true }
        }
        if menuAnchor.popUp(menu) { selected?() }
    }

    private func interrupt() async {
        do {
            _ = try await workbench.host.api?.interruptTerminal(id: terminalId)
            error = nil
        } catch {
            self.error = error.riffetMessage
        }
    }
}

extension TerminalSurface where Accessory == EmptyView {
    init(workbench: Workbench, terminalId: String, title: String = String(localized: "Agent 终端"), options: [(id: String, title: String)] = [],
         onSelect: ((String) -> Void)? = nil, onNew: (() -> Void)? = nil, onTerminate: (() -> Void)? = nil,
         onCollapse: (() -> Void)? = nil, focusRequest: Int = 0, allowPopOut: Bool = true,
         clientIdOverride: String? = nil, controllerOverride: TerminalController? = nil) {
        self.init(workbench: workbench, terminalId: terminalId, title: title, options: options,
                  onSelect: onSelect, onNew: onNew, onTerminate: onTerminate, onCollapse: onCollapse,
                  focusRequest: focusRequest, allowPopOut: allowPopOut, clientIdOverride: clientIdOverride,
                  controllerOverride: controllerOverride, accessory: { EmptyView() })
    }
}

@MainActor
@Observable
final class TerminalController {
    private(set) var status = String(localized: "正在连接…")
    private(set) var live = false
    private(set) var exited = false
    private(set) var running = false
    private(set) var hasControl = false
    fileprivate(set) var atBottom = true
    /// The first snapshot (or output) has reached the screen; until then the area says it is connecting.
    private(set) var hasOutput = false
    private(set) var bellFlash = false
    private(set) var paneTitle: String?
    private(set) var foregroundCommand: String?
    private(set) var cwd: String?
    private(set) var lastExitCode: Int?
    var searchOpen = false
    private(set) var pasteNotice: String?

    func displayTitle(fallback: String) -> String {
        for candidate in [paneTitle, foregroundCommand] {
            if let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
                return trimmed
            }
        }
        return fallback
    }
    private(set) var pasting = false
    /// The connection cannot be made without the reader doing something (not paired, not connected).
    private(set) var failed = false
    @ObservationIgnored var connection: TerminalConnection?
    /// Retained while this controller lives in [TerminalDock]'s bounded keep-alive pool so switching
    /// tabs or collapsing the dock restores the live scrollback and selection instantly.
    @ObservationIgnored private(set) var backend: (any TerminalSurfaceBackend)?
    private let subscriptions = FlowSubscriptions()
    /// Output that arrived before the terminal surface was attached; the newest [pendingLimit] bytes at most.
    @ObservationIgnored private var pending: [(String, Bool, Int, Int)] = []
    @ObservationIgnored private var pendingBytes = 0
    private static let pendingLimit = 2 * 1024 * 1024
    @ObservationIgnored private var renderedGrid: (cols: Int, rows: Int)?
    @ObservationIgnored private var connectionRevision = 0
    @ObservationIgnored private var appearanceKey = ""
    @ObservationIgnored private var launchAppearance: TerminalAppearance?
    @ObservationIgnored private var appearanceConfiguration: (theme: ThemeEntry, dark: Bool, fontSize: CGFloat)?
    @ObservationIgnored private var colors: (foreground: Int32, background: Int32, ansi: KotlinIntArray)?
    @ObservationIgnored private var refreshSnapshot: (() -> Void)?
    @ObservationIgnored private var retintStore: TerminalRetint?
    private var retint: TerminalRetint {
        if let retintStore { return retintStore }
        let made = makeRetint()
        retintStore = made
        return made
    }

    /// The page may go while a connection is open (a view that never disappeared cleanly); the socket must not outlive it.
    deinit {
        connection?.close()
    }

    func makeRetint() -> TerminalRetint {
        let tint = TerminalRetint { KotlinDouble(value: 0) }
        if let colors { tint.configure(foreground: colors.foreground, background: colors.background, ansi: colors.ansi) }
        return tint
    }

    /// Install concrete colors for the requested appearance, rather than resolving dynamic
    /// NSColors against whichever window happens to be current during SwiftUI's update.
    func applyAppearance(theme: ThemeEntry, dark appDark: Bool, fontSize: CGFloat) {
        appearanceConfiguration = (theme, appDark, fontSize)
        // Without a recorded appearance the pane keeps tmux's default colours, painted with this theme.
        let page = appDark ? theme.values.dark : theme.values.light
        let appearance = launchAppearance ?? TerminalAppearance(foreground: String(page.fg.hex.prefix(7)), background: String(page.bg.hex.prefix(7)))
        let dark = appearance.dark
        let foreground = RiffetRGBA(hex: appearance.foreground) ?? theme.values.dark.fg
        let background = RiffetRGBA(hex: appearance.background) ?? theme.values.dark.bg
        guard let backend else { return }
        // The revision is part of the key: editing a custom theme keeps its id and changes every
        // colour, so id and mode alone would leave the running terminal on the old palette.
        // Font size and family stay out of `key` so typography changes never trigger a reconnect.
        let key = "\(theme.id)|\(theme.revision)|\(appearance.foreground)|\(appearance.background)"
        let hadApplied = !appearanceKey.isEmpty
        let colorChanged = appearanceKey != key
        appearanceKey = key
        let palette = dark ? theme.values.dark : theme.values.light
        let ansi = TerminalANSI.colors(theme.ansi, dark: dark)
        let array = KotlinIntArray(size: 16)
        for (index, color) in ansi.enumerated() {
            array.set(index: Int32(index), value: TerminalANSI.argb(color))
        }
        colors = (TerminalANSI.argb(foreground), TerminalANSI.argb(background), array)
        if colorChanged { retintStore = nil }
        let prefs = DisplayPreferences.shared
        let surfaceAppearance = TerminalSurfaceAppearance(
            font: Self.resolveTerminalFont(family: prefs.terminalFontFamily, size: fontSize, weight: prefs.terminalFontWeight),
            foreground: TerminalANSI.nativeColor(foreground),
            background: TerminalANSI.nativeColor(background),
            cursor: TerminalANSI.nativeColor(foreground),
            cursorText: TerminalANSI.nativeColor(background),
            selection: TerminalANSI.nativeColor(palette.accent).withAlphaComponent(dark ? 0.3 : 0.18),
            ansiColors: ansi.map(TerminalANSI.color),
            dark: dark,
            cursorStyle: prefs.terminalCursorStyle,
            cursorBlink: prefs.terminalCursorBlink,
            optionAsMeta: prefs.terminalOptionAsMeta,
            copyOnSelect: prefs.terminalCopyOnSelect,
            rightClick: prefs.terminalRightClick,
            scrollOnInput: prefs.terminalScrollOnInput,
            scrollOnOutput: prefs.terminalScrollOnOutput,
            scrollSensitivity: prefs.terminalScrollSensitivity
        )
        backend.applyAppearance(surfaceAppearance)
        if let renderedGrid { backend.setRemoteGrid(cols: renderedGrid.cols, rows: renderedGrid.rows) }
        // Re-fetching a compressed protocol 4 snapshot replaces the old 2 MiB in-memory replay buffer
        // when the user switches themes on an already populated surface.
        if colorChanged, hadApplied, hasOutput {
            refreshSnapshot?()
        }
        // Watching another client's terminal must not claim input just to announce our theme.
        if colorChanged, hasControl { backend.notifyColorScheme() }
    }

    static func resolveTerminalFont(family: String, size: CGFloat, weight: TerminalFontWeight) -> NSFont {
        let trimmed = family.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            if let weighted = NSFontManager.shared.font(withFamily: trimmed, traits: [], weight: weight.managerWeight, size: size) {
                return weighted
            }
            if let exact = NSFont(name: trimmed, size: size) {
                return exact
            }
            let descriptor = NSFontDescriptor(fontAttributes: [.family: trimmed])
            if let matched = NSFont(descriptor: descriptor, size: size) {
                return matched
            }
        }
        if weight == .regular, let pluginMono = AppearanceFonts.current.mono?.nsFont(size: size) {
            return pluginMono
        }
        if let pluginMono = AppearanceFonts.current.mono?.nsFont(size: size),
           let familyName = pluginMono.familyName,
           let weighted = NSFontManager.shared.font(withFamily: familyName, traits: [], weight: weight.managerWeight, size: size) {
            return weighted
        }
        return NSFont.monospacedSystemFont(ofSize: size, weight: weight.nsWeight)
    }

    /// The id the main window claims terminals with, kept across launches. The server treats it as the
    /// lease owner, so each conversation window uses its own (`Workbench.terminalClientId`).
    static var mainClientId: String {
        if let id = UserDefaults.standard.string(forKey: "riffet.terminal-client") { return id }
        let id = "mac-" + UUID().uuidString.lowercased()
        UserDefaults.standard.set(id, forKey: "riffet.terminal-client")
        return id
    }

    func start(host: MacHost, terminalId: String, clientId: String) {
        guard connection == nil else { return }
        connectionRevision += 1
        let revision = connectionRevision
        refreshSnapshot = { [weak self, weak host] in
            guard let self, let host else { return }
            reconnect(host: host, terminalId: terminalId, clientId: clientId)
        }
        let inbox = TerminalOutputInbox { [weak self] data, fresh, cols, rows in
            guard let self, self.connectionRevision == revision else { return }
            self.output(data, fresh: fresh, cols: cols, rows: rows)
        }
        connection = host.openTerminal(terminalId: terminalId, clientId: clientId) { data, fresh, cols, rows in
            inbox.append(data, fresh: fresh.boolValue, cols: cols.intValue, rows: rows.intValue)
        }
        guard let connection else {
            status = String(localized: "未连接")
            failed = true
            return
        }
        failed = false
        subscriptions.observe(connection.link) { [weak self] link in
            guard let self else { return }
            failed = false
            switch onEnum(of: link) {
            case .connecting: status = String(localized: "正在连接…"); live = false; exited = false
            case .live: status = String(localized: "已连接"); live = true; exited = false
            case let .reconnecting(state): status = String(localized: "重新连接（第 \(state.attempt) 次）"); live = false
            case let .exited(exit): status = exit.exitCode.map { String(localized: "进程已退出（\($0.int64Value)）") } ?? String(localized: "进程已退出"); live = false; exited = true; running = false
            case .unauthenticated: status = String(localized: "设备令牌已失效，请重新配对"); live = false; failed = true
            }
        }
        subscriptions.observe(connection.info) { [weak self] info in
            guard let self else { return }
            hasControl = connection.hasControl
            backend?.controlsRemote = hasControl
            if let info {
                if launchAppearance?.foreground != info.appearance?.foreground || launchAppearance?.background != info.appearance?.background {
                    launchAppearance = info.appearance
                    if let config = appearanceConfiguration { applyAppearance(theme: config.theme, dark: config.dark, fontSize: config.fontSize) }
                }
                running = info.state == .running
                paneTitle = info.paneTitle
                foregroundCommand = info.foregroundCommand
                cwd = info.cwd
            }
        }
        subscriptions.observe(connection.notice) { [weak self] notice in
            if let notice { self?.status = notice }
        }
    }

    /// Tears down the socket while preserving any attached view so `reconnect` resumes painting in place.
    private func disconnect() {
        connectionRevision += 1
        refreshSnapshot = nil
        subscriptions.cancelAll()
        connection?.close()
        connection = nil
        pending.removeAll()
        pendingBytes = 0
        hasOutput = false
        pasting = false
        pasteNotice = nil
    }

    func stop() {
        disconnect()
        backend = nil
    }

    func reconnect(host: MacHost, terminalId: String, clientId: String) {
        disconnect()
        start(host: host, terminalId: terminalId, clientId: clientId)
    }

    func focus() {
        // SwiftUI may request focus before the represented view has entered its window.
        DispatchQueue.main.async { [weak self] in
            self?.backend?.focusSurface()
        }
    }

    func attach(_ backend: any TerminalSurfaceBackend) {
        self.backend = backend
        backend.controlsRemote = hasControl
        backend.onInput = { [weak self] text in self?.connection?.sendInput(data: text) }
        backend.onAttachmentPaste = { [weak self] board in self?.pasteAttachments(board) ?? false }
        backend.onReply = { [weak self] text in self?.connection?.sendReply(data: text) }
        backend.onTextPaste = { [weak self] text in self?.connection?.paste(text: text) }
        backend.onViewportSize = { [weak self] cols, rows in self?.connection?.requestSize(cols: Int32(cols), rows: Int32(rows)) }
        backend.onScrollPositionChange = { [weak self] bottom in
            guard let self, self.atBottom != bottom else { return }
            self.atBottom = bottom
        }
        backend.onBell = { [weak self] in
            switch DisplayPreferences.shared.terminalBell {
            case .none: break
            case .sound: NSSound.beep()
            case .visual:
                guard let self, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
                self.bellFlash = true
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(180)) { [weak self] in
                    self?.bellFlash = false
                }
            }
        }
        backend.onClipboardCopy = { text in
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
        backend.onOpenLink = { url in NSWorkspace.shared.open(url) }
        backend.onCommandExitCode = { [weak self] code in self?.lastExitCode = code }
        backend.onOpenSearch = { [weak self] in self?.searchOpen = true }
        let waiting = pending
        pending.removeAll()
        pendingBytes = 0
        for (data, fresh, cols, rows) in waiting { output(data, fresh: fresh, cols: cols, rows: rows) }
    }

    /// Capture the paste target before reading files; a later upload cannot move to another lease.
    private func pasteAttachments(_ board: NSPasteboard) -> Bool {
        guard ComposerModel.holdsAttachment(board) else { return false }
        guard live, !pasting, let connection else { return true }
        pasting = true
        pasteNotice = nil
        let revision = connectionRevision
        let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        let imageData = urls.isEmpty ? NSImage(pasteboard: board)?.tiffRepresentation : nil
        let text = imageData == nil ? nil : board.string(forType: .string)
        Task { [weak self] in
            guard let self else { return }
            defer { if revision == connectionRevision { pasting = false } }
            do {
                guard revision == connectionRevision else { return }
                let epoch = try await connection.acquirePasteLease()
                guard urls.count <= 20 else { throw LocalPairing.Failure(message: String(localized: "一次最多粘贴 20 个附件")) }
                guard !urls.contains(where: { ((try? $0.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? Int.max) > 24 * 1024 * 1024 }) else {
                    throw LocalPairing.Failure(message: String(localized: "附件超过 24 MiB"))
                }
                let files = await Task.detached(priority: .userInitiated) {
                    if !urls.isEmpty { return urls.compactMap { ComposerModel.prepare(url: $0) } }
                    guard let imageData, let png = NSBitmapImageRep(data: imageData)?.representation(using: .png, properties: [:]),
                          let file = ComposerModel.prepare(data: png, name: "paste.png", type: .png) else { return [PickedFile]() }
                    return [file]
                }.value
                guard revision == connectionRevision, self.connection === connection else { return }
                guard !files.isEmpty, urls.isEmpty || files.count == urls.count else { throw LocalPairing.Failure(message: String(localized: "无法读取附件")) }
                let result = try await connection.pasteAttachments(files: files, requestId: UUID().uuidString.lowercased(), expectedLease: epoch, text: text)
                guard revision == connectionRevision else { return }
                if result.status != "completed" { pasteNotice = String(localized: "粘贴结果未知，请检查终端后再操作") }
            } catch {
                guard revision == connectionRevision else { return }
                pasteNotice = error.riffetMessage
            }
        }
        return true
    }

    func output(_ data: String, fresh: Bool, cols: Int, rows: Int) {
        guard let backend else {
            if fresh { pending.removeAll(); pendingBytes = 0 }
            pending.append((data, fresh, cols, rows))
            pendingBytes += data.utf8.count
            // Without a view nothing drains this: keep the newest output, which is what the screen needs.
            while pendingBytes > Self.pendingLimit, pending.count > 1 {
                pendingBytes -= pending.removeFirst().0.utf8.count
            }
            return
        }
        if !hasOutput { hasOutput = true }
        if fresh {
            renderedGrid = (cols, rows)
            retint.reset()
        }
        backend.feed(retint.transform(data: data), fresh: fresh, cols: cols, rows: rows)
    }
}

private struct TerminalHost: NSViewRepresentable {
    let controller: TerminalController
    let theme: ThemeEntry
    let dark: Bool
    let fontFamily: String
    let fontSize: CGFloat
    let fontWeight: TerminalFontWeight
    /// The plugin fonts in effect; a change re-applies the surface.
    let fonts: String
    let cursorStyle: TerminalCursorShape
    let cursorBlink: Bool
    let optionAsMeta: Bool
    let copyOnSelect: Bool
    let rightClick: TerminalRightClickBehavior
    let scrollOnInput: Bool
    let scrollOnOutput: Bool
    let scrollSensitivity: Double
    var backendKind: TerminalBackendKind = .swiftTerm

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        if let existing = controller.backend {
            context.coordinator.backend = existing
            apply(coordinator: context.coordinator)
            return existing.surfaceView
        }
        let backend = backendKind.makeSurface(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        context.coordinator.backend = backend
        controller.attach(backend)
        apply(coordinator: context.coordinator)
        return backend.surfaceView
    }

    func updateNSView(_ view: NSView, context: Context) {
        apply(coordinator: context.coordinator)
    }

    /// The surface follows the app's palette and the ANSI set follows its theme (`terminal-theme.ts`).
    private func apply(coordinator: Coordinator) {
        let key = "\(theme.id)|\(theme.revision)|\(dark)|\(fontFamily)|\(fontSize)|\(fontWeight.rawValue)|\(fonts)|\(cursorStyle.rawValue)|\(cursorBlink)|\(optionAsMeta)|\(copyOnSelect)|\(rightClick.rawValue)|\(scrollOnInput)|\(scrollOnOutput)|\(scrollSensitivity)"
        guard coordinator.applied != key else { return }
        coordinator.applied = key
        controller.applyAppearance(theme: theme, dark: dark, fontSize: fontSize)
    }

    final class Coordinator {
        var applied = ""
        var backend: (any TerminalSurfaceBackend)?
    }
}
