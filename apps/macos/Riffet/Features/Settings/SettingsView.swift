import SwiftUI

/// Sidebar settings. The command palette writes `PreferenceKey.settingsSection` and then opens
/// this window, so the selection is the stored value rather than a local default.
struct SettingsView: View {
    @AppStorage(PreferenceKey.settingsSection) private var sectionID = SettingsSection.general.rawValue
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var query = ""

    private var selection: Binding<SettingsSection> {
        Binding(
            get: {
                // An earlier pane's selection or link lands on the pane that took it over; the pane
                // reads the stored value to open or scroll to what was asked for.
                SettingsSection(rawValue: sectionID)?.pane ?? .general
            },
            set: { sectionID = $0.rawValue }
        )
    }

    var body: some View {
        // A constant size range: a minimum on the content made the window measure every row of the
        // section's form on each change.
        WindowContentLayout(minimum: CGSize(width: 820, height: 600), ideal: CGSize(width: 880, height: 780)) {
            split
        }
    }

    private var split: some View {
        NavigationSplitView {
            List(selection: selection) {
                if visibleGroups.isEmpty {
                    Text("没有匹配的设置")
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.fg3)
                        .padding(.vertical, Space.sm)
                }
                ForEach(visibleGroups, id: \.group) { entry in
                    Section {
                        ForEach(entry.sections) { section in
                            row(section)
                        }
                    } header: {
                        if let title = entry.group.title { Text(title) }
                    }
                }
            }
            .listStyle(.sidebar)
            .background(SidebarListAppearance(refusesFocus: false))
            .navigationSplitViewColumnWidth(min: 200, ideal: 228, max: 270)
            .toolbar(removing: .sidebarToggle)
            .modifier(SettingsSearch(query: $query))
            .onChange(of: query) { _, value in
                // Keep the highlighted row and the detail in step while filtering. A blank query
                // leaves the reader's choice alone.
                let trimmed = value.trimmingCharacters(in: .whitespaces)
                guard !trimmed.isEmpty, let first = matches.first else { return }
                if !matches.contains(selection.wrappedValue) { sectionID = first.rawValue }
            }
        } detail: {
            SettingsPanes(section: selection.wrappedValue, style: "\(palette.values.id)|\(palette.revision)") { section in
                AnyView(detail(section).environment(model).environment(\.palette, palette).environment(\.settingsPaneScope, section.scope))
            }
            .navigationTitle(selection.wrappedValue.title)
        }
        .navigationSplitViewStyle(.balanced)
        // Section changes keep the split columns in place. The first presentation also needs the
        // hosting panes laid out before the window is visible (SettingsPaneController.viewWillAppear).
        .transaction { $0.disablesAnimations = true }
    }

    private var matches: [SettingsSection] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return SettingsSection.navigable }
        return SettingsSection.navigable.filter { section in
            let haystack = [section.title, section.summary, section.keywords].joined(separator: " ").lowercased()
            return haystack.contains(needle)
        }
    }

    private struct GroupEntry: Identifiable {
        let group: SettingsGroup
        let sections: [SettingsSection]
        var id: SettingsGroup { group }
    }

    private var visibleGroups: [GroupEntry] {
        let allowed = Set(matches)
        return SettingsGroup.allCases.compactMap { group in
            let sections = group.sections.filter { allowed.contains($0) }
            return sections.isEmpty ? nil : GroupEntry(group: group, sections: sections)
        }
    }

    private func row(_ section: SettingsSection) -> some View {
        // A lined form's sidebar is outline too: the icon alone, in the text's colour.
        let lined = DisplayPreferences.shared.style.form == .lined
        return HStack(spacing: Space.sm) {
            ZStack {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(lined ? .clear : palette.bgMuted)
                    .frame(width: 22, height: 22)
                Image(icon: section.symbol)
                    .font(.riffet(size: S(lined ? 14 : 11), weight: lined ? .regular : .medium))
                    .foregroundStyle(lined ? palette.fg2 : palette.accent)
            }
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(lined ? .clear : palette.lineSoft))
            Text(section.title)
                .lineLimit(1)
        }
        .tag(section)
        .help(section.summary)
        .listRowBackground(selection.wrappedValue == section ? SidebarSelectionBackground() : nil)
    }

    @ViewBuilder
    private func detail(_ section: SettingsSection) -> some View {
        switch section.pane {
        case .profile: ProfileSettings()
        case .general: GeneralSettings()
        case .appearance: ThemeSettings()
        case .window: WindowSettings()
        case .tabs: TabsSettings()
        case .typography: TypographySettings()
        case .terminal: TerminalSettings()
        case .appIcon: AppIconSettings()
        case .input: InputSettings()
        case .shortcuts: ShortcutSettings()
        case .notifications: NotificationSettings()
        case .files: FilesSettings()
        case .agents: AgentSettings()
        case .modelProviders: AgentSettings(providersOnly: true)
        case .auxiliaryModels: AuxiliaryModelSettings()
        case .quickChat: QuickChatSettingsView()
        case .connection: ConnectionSettings()
        case .shares: SharesSettings()
        case .channels: ChannelsSettings()
        case .server: ServerSettings()
        case .backup: BackupSettings()
        case .diagnostics: DiagnosticsSettings()
        default: AboutSettings()
        }
    }
}

/// The detail column. A section's view is built the first time it shows and kept, hidden, while the
/// window is open, so going back to it shows a view instead of building and measuring its form again.
/// Closing the window drops all but the current one, so the next visit loads fresh state.
private struct SettingsPanes: NSViewControllerRepresentable {
    let section: SettingsSection
    /// The palette's identity: a change rebuilds the kept sections' roots with the new one.
    let style: String
    let content: (SettingsSection) -> AnyView

    func makeNSViewController(context: Context) -> SettingsPaneController { SettingsPaneController() }

    func updateNSViewController(_ controller: SettingsPaneController, context: Context) {
        controller.show(section, style: style, content: content)
    }
}

final class SettingsPaneController: NSViewController {
    private final class Root: NSView {
        var onWindow: ((NSWindow?) -> Void)?
        var onLayout: (() -> Void)?
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); onWindow?(window) }
        override func layout() { super.layout(); onLayout?() }
        override func setFrameSize(_ newSize: NSSize) { super.setFrameSize(newSize); onLayout?() }
    }

    private var panes: [SettingsSection: NSHostingView<AnyView>] = [:]
    private static let keepsWork: Set<SettingsSection> = [
        .backup, .diagnostics, .input, .general, .window, .shares, .agents, .modelProviders, .server, .connection,
    ]
    private var current: SettingsSection?
    private var style = ""
    private var closing: NSObjectProtocol?

    override func loadView() {
        let root = Root()
        root.onLayout = { [weak self] in self?.fit() }
        root.onWindow = { [weak self] window in self?.watch(window) }
        view = root
    }

    override func viewWillAppear() {
        super.viewWillAppear()
        // The representable's first update can install a pane while its root still has zero bounds.
        // Resolve the split view's column size, then the hosted form, before AppKit orders the
        // window in. Later opens reuse those bounds, which is why they did not show this first pass.
        (view.window?.contentView ?? view.superview ?? view).layoutSubtreeIfNeeded()
        view.layoutSubtreeIfNeeded()
        fit()
        if let current { panes[current]?.layoutSubtreeIfNeeded() }
    }

    deinit {
        if let closing { NotificationCenter.default.removeObserver(closing) }
    }

    fileprivate func show(_ section: SettingsSection, style: String, content: (SettingsSection) -> AnyView) {
        if style != self.style {
            self.style = style
            for (key, pane) in panes { pane.rootView = content(key) }
        }
        guard section != current else { return }
        let pane = panes[section] ?? {
            let pane = NSHostingView(rootView: content(section))
            // The column's size comes from the split view; measuring the form for constraints is wasted work.
            pane.sizingOptions = []
            // The window's title and toolbar belong to the split view (`navigationTitle` above). A
            // pane bridging its own (empty) ones re-tiled the title bar against it as the window
            // opened.
            pane.sceneBridgingOptions = []
            panes[section] = pane
            return pane
        }()
        // Hidden rather than removed: a hosting view taken out of the window rebuilds and measures
        // everything when it comes back.
        let previous = current
        if let current, let old = panes[current] {
            old.isHidden = true
        }
        current = section
        // The section just left stays warm for a quick return; the others are released, except panes
        // that can hold unfinished work in their @State (a running backup, a save, a test), which a
        // rebuilt view would lose and let the user repeat.
        for (key, stale) in panes where key != section && key != previous && !Self.keepsWork.contains(key) {
            stale.removeFromSuperview()
            panes[key] = nil
        }
        // Adopt the available column size now; the initial size is finalized in viewWillAppear.
        pane.frame = view.bounds
        if pane.superview == nil { view.addSubview(pane) }
        pane.isHidden = false
        // Kept panes keep their tasks alive; tell the one on screen that this is the moment to
        // re-read anything another device may have changed.
        NotificationCenter.default.post(name: .settingsSectionDidShow, object: section.rawValue)
    }

    /// Only the section on screen follows the column's size; the hidden ones catch up when shown.
    private func fit() {
        guard let current, let pane = panes[current], pane.frame != view.bounds else { return }
        pane.frame = view.bounds
    }

    private func watch(_ window: NSWindow?) {
        if let closing { NotificationCenter.default.removeObserver(closing) }
        closing = window.map { window in
            NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.dropHidden() }
            }
        }
        // Keep the window's native presentation unanimated; layout preparation is separate above.
        window?.animationBehavior = .none
    }

    private func dropHidden() {
        for (key, pane) in panes where key != current {
            pane.removeFromSuperview()
            panes[key] = nil
        }
    }
}

/// The sidebar's search: the system's field, or under a lined form one drawn as a hairline like the
/// form's own fields. Only the sidebar column changes with it; the pane beside it keeps its state.
private struct SettingsSearch: ViewModifier {
    @Binding var query: String
    @Environment(\.palette) private var palette

    @ViewBuilder
    func body(content: Content) -> some View {
        switch DisplayPreferences.shared.style.form {
        case .grouped:
            content.searchable(text: $query, placement: .sidebar, prompt: "搜索设置")
        case .lined:
            content.safeAreaInset(edge: .top, spacing: 0) {
                HStack(spacing: Space.sm) {
                    Image(icon: "magnifyingglass")
                        .font(.riffet(size: S(13)))
                        .foregroundStyle(palette.fg3)
                    TextField("搜索设置", text: $query, prompt: Text("搜索设置"))
                        .textFieldStyle(.plain)
                        .font(.riffet(size: S(13)))
                        .onExitCommand { query = "" }
                }
                .padding(.horizontal, Space.sm + Space.xxs)
                .frame(height: 30)
                .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
                .padding(.horizontal, Space.sm + Space.xxs)
                .padding(.vertical, Space.sm)
            }
        }
    }
}
