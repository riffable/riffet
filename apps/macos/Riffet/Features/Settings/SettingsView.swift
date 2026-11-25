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
                        ForEach(webRows(in: entry.group)) { web in
                            webRow(web)
                        }
                    } header: {
                        if let title = entry.group.title { Text(title) }
                    }
                }
            }
            .listStyle(.sidebar)
            .background(SidebarListAppearance())
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
            .toolbar {
                if let web = selection.wrappedValue.webSection, let workbench = model.workbench {
                    ToolbarItem(placement: .primaryAction) { WebHandoffButton(page: .settings(section: web), workbench: workbench) }
                }
            }
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
        rowLabel(symbol: section.symbol, title: section.title)
            .tag(section)
            .help(section.summary)
            .listRowBackground(selection.wrappedValue == section ? SidebarSelectionBackground() : nil)
    }

    private func rowLabel(symbol: String, title: String) -> some View {
        HStack(spacing: Space.sm) {
            ZStack {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(palette.bgMuted)
                    .frame(width: 22, height: 22)
                Image(icon: symbol)
                    .font(.riffet(size: S(11), weight: .medium))
                    .foregroundStyle(palette.accent)
            }
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
            Text(title)
                .lineLimit(1)
        }
    }

    /// The Web-only sections of [group] that match the search, while a server is connected.
    private func webRows(in group: SettingsGroup) -> [WebSettingsRow] {
        guard let workbench = model.workbench, WebHandoff.isAvailable(workbench) else { return [] }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return WebSettingsRow.all.filter { $0.group == group && (needle.isEmpty || $0.title.lowercased().contains(needle)) }
    }

    /// A section only the Web has: the row opens it there instead of selecting a pane.
    private func webRow(_ web: WebSettingsRow) -> some View {
        Button {
            if let workbench = model.workbench { WebHandoff.open(.settings(section: web.section), in: workbench) }
        } label: {
            HStack(spacing: Space.sm) {
                rowLabel(symbol: web.symbol, title: web.title)
                Spacer(minLength: 0)
                Image(icon: "arrow.up.right.square")
                    .font(RiffetFont.caption)
                    .foregroundStyle(palette.fg4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func detail(_ section: SettingsSection) -> some View {
        switch section.pane {
        case .profile: ProfileSettings()
        case .general: GeneralSettings()
        case .appearance: ThemeSettings()
        case .window: WindowSettings()
        case .sidebar: SidebarSettings()
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
        case .assistant: AssistantSettingsView()
        case .workItems: WorkItemsSettingsView()
        case .connection: ConnectionSettings()
        case .shares: SharesSettings()
        case .channels: ChannelsSettings()
        case .server: ServerSettings()
        case .storage: StorageSettings()
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

/// The sidebar's search: the system's field.
private struct SettingsSearch: ViewModifier {
    @Binding var query: String

    func body(content: Content) -> some View {
        content.searchable(text: $query, placement: .sidebar, prompt: "搜索设置")
    }
}
