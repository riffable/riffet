import SwiftUI
import RiffetKit

struct InspectorView: View {
    let workbench: Workbench
    @Binding var tab: InspectorTab
    /// The panel covers the whole conversation area.
    var maximized = false
    /// The panel floats over the conversation.
    var floating = false
    var toggleFloating: () -> Void = {}
    let toggleMaximized: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.openSettings) private var openSettings
    /// The panels opened since the side panel appeared; they stay mounted behind the shown one.
    @State private var visited: Set<InspectorTab> = []

    private var project: Project? { workbench.currentProject }

    var body: some View {
        // The stored view is what the reader chose; when it is not on offer now (its plugin is off)
        // the first one shows instead and the stored one stays, to be shown again when it returns.
        let views = workbench.inspectorViews
        let shown = views.contains { $0.tab == tab } ? tab : (views.first?.tab ?? tab)
        let style = DisplayPreferences.shared.style
        let maximize = PanelMaximize(on: maximized, toggle: toggleMaximized)
        let float = PanelFloat(on: floating, toggle: toggleFloating)
        VStack(spacing: 0) {
            // One panel per header icon has no bar of its own: the header's icons pick it, and the
            // view's own top bar carries the full-screen toggle.
            if style.rightPanel != .panels {
                HStack(spacing: Space.sm) {
                    // The segmented views sit in the middle, balanced against the toggle.
                    if style.rightPanel == .inspector {
                        Color.clear.frame(width: PanelMaximizeButton.width * (floating ? 1 : 2))
                        Spacer(minLength: 0)
                    }
                    if !views.isEmpty {
                        switch style.rightPanel {
                        case .outline:
                            if style.tabs == .pill {
                                HStack(spacing: 2) {
                                    ForEach(views) { view in
                                        PillTab(title: view.title, symbol: view.symbol, selected: view.tab == shown, style: style) { tab = view.tab }
                                    }
                                }
                            } else {
                                HStack(spacing: Space.lg) {
                                    ForEach(views) { view in
                                        UnderlineTab(title: view.title, selected: view.tab == shown, style: style) { tab = view.tab }
                                    }
                                }
                            }
                        case .inspector, .panels:
                            // Plugins add tabs: the track tightens, then turns into a menu, rather than overflow.
                            ViewThatFits(in: .horizontal) {
                                tabTrack(inset: Space.md)
                                tabTrack(inset: Space.sm - 2)
                                ChoiceMenu(options: views.map { view in ChoiceOption(title: view.title, selected: view.tab == shown) { tab = view.tab } }) {
                                    HStack(spacing: Space.xs) {
                                        Text(views.first { $0.tab == shown }?.title ?? "").font(.riffet(size: S(13), weight: .semibold)).foregroundStyle(palette.fg)
                                        Image(icon: "chevron.down").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
                                    }
                                    .padding(.horizontal, Space.sm)
                                    .frame(height: 28)
                                }
                                .fixedSize()
                            }
                            .accessibilityLabel("面板")
                        }
                    }
                    Spacer(minLength: 0)
                    // One run of buttons, spaced as one: float, full screen, close.
                    HStack(spacing: 0) {
                        PanelMaximizeButton().environment(\.panelMaximize, maximize).environment(\.panelFloat, float)
                        if style.rightPanel == .outline {
                            Button { workbench.setInspectorOpen(false) } label: { Image(icon: "xmark").font(.riffet(size: S(style.tabs == .pill ? 13 : 12))) }
                                .buttonStyle(IconButtonStyle(size: PanelMaximizeButton.width))
                                .help("关闭")
                        }
                    }
                }
                .padding(.horizontal, style.tabs == .pill ? Space.sm : Space.md)
                .frame(height: style.rightPanel == .outline ? style.layout.header : InspectorMetrics.headerHeight)
                .panelDragHandle()
                PanelRule()
            }
            if floating && style.rightPanel == .panels { PanelGrip() }
            Group {
                if views.isEmpty {
                    // Every view is turned off in settings.
                    ContentUnavailableView {
                        Label("没有显示的视图", icon: "sidebar.right")
                    } actions: {
                        Button("打开设置") {
                            UserDefaults.standard.set(SettingsSection.window.rawValue, forKey: PreferenceKey.settingsSection)
                            openSettings()
                        }
                    }
                } else if let project {
                    // Each view stays alive once opened, so switching back keeps its data, scroll
                    // position and open page.
                    ZStack {
                        ForEach(views.filter { $0.tab == shown || visited.contains($0.tab) }) { view in
                            view.makeView(workbench, project).keptAlive(hidden: view.tab != shown)
                        }
                    }
                    .onChange(of: shown, initial: true) { _, shown in visited.insert(shown) }
                } else {
                    ContentUnavailableView("没有打开的项目", icon: "folder")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .environment(\.conversationProjectId, project?.id)
            .environment(\.panelMaximize, style.rightPanel == .panels ? maximize : nil)
            .environment(\.panelFloat, style.rightPanel == .panels ? float : nil)
        }
        .background(palette.page)
    }

    private func tabTrack(inset: CGFloat) -> some View {
        let views = workbench.inspectorViews
        let shown = views.contains { $0.tab == tab } ? tab : (views.first?.tab ?? tab)
        return SegmentedTrack(selection: Binding(get: { shown }, set: { tab = $0 }), inset: inset) {
            ForEach(views) { Text($0.title).tag($0.tab) }
        }
    }
}

/// A tab in a `.pill` row (`StyleSpec.Tabs`): a filled pill when current. With a symbol it is the
/// icon alone, a 28pt square, and the current one adds its name; without one, the name alone.
struct PillTab: View {
    let title: String
    var symbol: String? = nil
    /// A row under the panel's own (a view's sections): a step smaller, so it reads as one level down.
    var compact = false
    let selected: Bool
    let style: StyleSpec
    let action: () -> Void
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.xs + 2) {
                if let symbol { Image(icon: symbol).font(.riffet(size: S(13))).frame(width: 16) }
                if selected || symbol == nil { Text(verbatim: title).font(.riffet(size: S(compact ? style.text.secondary : style.text.body))).lineLimit(1) }
            }
            .foregroundStyle(selected ? palette.fg : palette.fg3)
            .padding(.horizontal, symbol != nil && !selected ? 0 : compact ? Space.xs + 2 : Space.sm)
            .frame(minWidth: compact ? 24 : 28, minHeight: compact ? 24 : 28)
            .background(selected ? palette.bgActive : (hovering ? palette.bgHover : .clear), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(symbol == nil ? "" : title)
    }
}

/// The bar at the top of a pushed detail page: back, what it is, and its actions.
struct DetailHeader<Actions: View>: View {
    let title: String
    let subtitle: String?
    let back: () -> Void
    /// In a sheet the way back closes it.
    var closes = false
    @ViewBuilder let actions: Actions
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            Button(action: back) { Image(icon: closes ? "xmark" : "chevron.left").font(.riffet(size: S(12), weight: .semibold)) }
                .buttonStyle(IconButtonStyle())
                .keyboardShortcut(.cancelAction)
                .help(closes ? "关闭" : "返回")
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.riffet(size: S(13), weight: .semibold)).foregroundStyle(palette.fg).lineLimit(1)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.riffet(size: S(11))).foregroundStyle(palette.fg4).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: Space.sm)
            actions
        }
        .padding(.horizontal, Space.sm)
        .frame(height: InspectorMetrics.headerHeight)
    }
}

/// The side panel's full-screen toggle, for the button that shows it.
struct PanelMaximize {
    let on: Bool
    let toggle: () -> Void
}

extension EnvironmentValues {
    /// Set where a view's own top bar carries the panel's full-screen toggle: in a panel without a
    /// bar of its own (`StyleSpec.RightPanel.panels`).
    @Entry var panelMaximize: PanelMaximize?
}

/// The panel's full-screen toggle, at the trailing end of the bar it sits in; nothing where
/// `panelMaximize` is not set.
struct PanelMaximizeButton: View {
    static let width: CGFloat = 26
    @Environment(\.panelMaximize) private var maximize
    @Environment(\.panelFloat) private var float

    var body: some View {
        // Beside pill tabs the controls take the window header's 13pt symbol, as the tabs do.
        let glyph = S(DisplayPreferences.shared.style.tabs == .pill ? 13 : 12), box = Self.width
        HStack(spacing: 0) {
            if let float {
                Button(action: float.toggle) {
                    Image(icon: float.on ? "sidebar.right" : "pip").font(.riffet(size: glyph))
                }
                .buttonStyle(IconButtonStyle(size: box))
                .help(float.on ? "停靠到侧边" : "悬浮")
            }
            if let maximize, float?.on != true {
                Button(action: maximize.toggle) {
                    Image(icon: maximize.on ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                        .font(.riffet(size: glyph))
                }
                .buttonStyle(IconButtonStyle(size: box))
                .help(maximize.on ? "退出全屏 (⌥⌘F)" : "全屏 (⌥⌘F)")
            }
        }
    }
}

/// Sizes the side panel's bars share: the inspector's tab bar, a page's header and the terminal dock's.
enum InspectorMetrics {
    static let headerHeight: CGFloat = 44
}

/// A one-pixel line in the palette's line colour, the one rule between the panel's bars and pages.
struct PanelRule: View {
    @Environment(\.palette) private var palette

    var body: some View {
        Rectangle().fill(palette.line).frame(height: 1)
    }
}

private struct InspectorPanelVisibleKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    /// False inside a page kept alive behind another one: periodic work waits until it is shown again.
    var inspectorPanelVisible: Bool {
        get { self[InspectorPanelVisibleKey.self] }
        set { self[InspectorPanelVisibleKey.self] = newValue }
    }
}

private struct KeptAlive: ViewModifier {
    let hidden: Bool
    @Environment(\.inspectorPanelVisible) private var visible

    func body(content: Content) -> some View {
        content
            .opacity(hidden ? 0 : 1)
            .allowsHitTesting(!hidden)
            .accessibilityHidden(hidden)
            // Keyboard shortcuts (a detail page's Esc) must not fire from behind the shown page.
            .disabled(hidden)
            .environment(\.inspectorPanelVisible, visible && !hidden)
    }
}

extension View {
    /// Keeps a page mounted, with its state and scroll position, while another one is shown over it.
    func keptAlive(hidden: Bool) -> some View { modifier(KeptAlive(hidden: hidden)) }
}

func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
