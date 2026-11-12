import AppKit
import SwiftUI
import RiffetKit

/// A launch target as the editors hold it. Unset fields take the backend's saved defaults, as in the
/// composer, and a nil backend means the account's default Agent. Convert with `init(_:)` and `target`.
struct LaunchChoice: Equatable {
    /// The wire id of the Agent; nil is the account's default.
    var agent: String?
    var profileId: String?
    var model: String?
    var mode: String?
    var approval: String?

    init(agent: String? = nil, profileId: String? = nil, model: String? = nil, mode: String? = nil, approval: String? = nil) {
        self.agent = agent
        self.profileId = profileId
        self.model = model
        self.mode = mode
        self.approval = approval
    }

    init(_ target: LaunchTarget) {
        self.init(
            agent: target.agent,
            profileId: Self.nonEmpty(target.backendProfileId),
            model: Self.nonEmpty(target.model),
            mode: Self.nonEmpty(target.mode),
            approval: Self.nonEmpty(target.approval)
        )
    }

    var target: LaunchTarget {
        LaunchTarget(
            backendId: agent.flatMap(builtinBackend), backendProfileId: profileId, model: model, mode: mode, approval: approval,
            agentId: agent.flatMap { builtinBackend($0) == nil ? $0 : nil }
        )
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}

/// Backend, profile, model, mode and approval of one launch (`LaunchTarget`), for the places that pick
/// where work runs: task templates, handoff to another Agent, parallel attempts. Only the choices the
/// backend supports are shown; the model catalog is the workbench's cached one.
struct LaunchTargetPicker: View {
    let workbench: Workbench
    @Binding var choice: LaunchChoice
    /// The project the catalog is read for (some backends list models per project); nil reads the global one.
    var projectId: String?
    /// Offer "默认 Agent" (leave the backend unset). Off where a target is mandatory, e.g. a handoff.
    var allowsDefault = true
    /// Only the Agent chip, for a bar with no room for the model and mode rows.
    var compact = false
    @Environment(\.palette) private var palette
    @State private var catalog: NativeBackendCatalogEntry?
    @State private var loadedKey: String?
    @State private var loading = false
    @State private var loadError: String?

    private var contextKey: String { "\(choice.agent ?? "")|\(choice.profileId ?? "")|\(projectId ?? "")" }
    private var catalogKey: String { "\(contextKey)|\(workbench.backendRevision)|\(workbench.catalogs.connectionRevision)" }

    var body: some View {
        if compact {
            NativeChipMenu(text: agentLabel, symbol: "sparkle") { agentEntries }
                .task { if workbench.backends.isEmpty { await workbench.loadBackends() } }
        } else {
            VStack(alignment: .leading, spacing: Space.sm) {
                row("Agent") {
                    NativeChipMenu(text: agentLabel, symbol: "sparkle") { agentEntries }
                }
                if choice.agent != nil { details }
                hint
            }
            .task(id: catalogKey) {
                if workbench.backends.isEmpty { await workbench.loadBackends() }
                await load(reload: false)
            }
        }
    }

    @ViewBuilder
    private var details: some View {
        if let catalog, loadedKey == contextKey {
            let capabilities = catalog.capabilities
            if catalog.profiles.count > 1 {
                row(String(localized: "配置")) { NativeChipMenu(text: profileLabel(catalog), symbol: "slider.horizontal.3") { profileEntries(catalog) } }
            }
            if capabilities.supportsModelSelection, !catalog.models.isEmpty {
                row(String(localized: "模型")) {
                    ModelControls(catalog: catalog.models, selection: choice.model, scope: catalogKey, refresh: { await load(reload: true) }) { choice.model = $0 }
                        .id(catalogKey)
                    if choice.model != nil {
                        Button { choice.model = nil } label: { Image(icon: "xmark.circle.fill").font(.riffet(size: S(11))) }
                            .buttonStyle(IconButtonStyle(size: 20))
                            .help("使用默认模型")
                    }
                }
            }
            if capabilities.supportsModeSelection, !capabilities.modes.isEmpty {
                row(String(localized: "模式")) {
                    NativeChipMenu(text: label(of: choice.mode, in: capabilities.modes), symbol: "wand.and.stars") {
                        optionEntries(String(localized: "模式"), capabilities.modes, selection: choice.mode) { choice.mode = $0 }
                    }
                }
            }
            if capabilities.supportsPermissionSelection, !capabilities.permissions.isEmpty {
                row(String(localized: "审批")) {
                    NativeChipMenu(text: label(of: choice.approval, in: capabilities.permissions), symbol: "checkmark.shield") {
                        optionEntries(String(localized: "审批"), capabilities.permissions, selection: choice.approval) { choice.approval = $0 }
                    }
                }
            }
        } else if loading {
            row("") { Spinner(size: .mini); Text("正在加载…").font(.riffet(size: S(12))).foregroundStyle(palette.fg3) }
        } else if let loadError {
            row("") {
                Text("无法加载：\(loadError)").font(.riffet(size: S(12))).foregroundStyle(palette.danger).lineLimit(2)
                Button("重试") { Task { await load(reload: true) } }.buttonStyle(ChipButtonStyle())
            }
        }
    }

    private var hint: some View {
        Text(choice.agent == nil ? "未指定的项沿用默认值。" : "未指定的项沿用该 Agent 的默认值。")
            .font(.riffet(size: S(11.5)))
            .foregroundStyle(palette.fg4)
    }

    private func row<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: Space.sm) {
            // The width scales with the font (S), so "Agent" never wraps at larger text sizes.
            Text(title).font(.riffet(size: S(12))).foregroundStyle(palette.fg3).lineLimit(1).frame(width: S(44), alignment: .leading)
            content()
            Spacer(minLength: 0)
        }
    }

    // MARK: Labels and menus

    private var agentLabel: String {
        guard let id = choice.agent else { return String(localized: "默认 Agent") }
        return workbench.backends.first { $0.agent == id }?.label ?? backendLabel(id)
    }

    private var agentEntries: [NativeMenuEntry] {
        var entries: [NativeMenuEntry] = [.header("Agent")]
        if allowsDefault {
            entries.append(.item(String(localized: "默认 Agent"), subtitle: String(localized: "使用设置里的默认 Agent"), checked: choice.agent == nil) { choice = LaunchChoice() })
        }
        for entry in workbench.backends.filter(\.isPickable) {
            let id = entry.agent
            entries.append(.item(
                entry.label,
                subtitle: entry.available ? nil : entry.reason,
                checked: choice.agent == id,
                enabled: entry.available || choice.agent == id
            ) {
                // Profile, model, mode and approval belong to one backend; another one starts from its defaults.
                if choice.agent != id { choice = LaunchChoice(agent: id) }
            })
        }
        return entries
    }

    private func profileLabel(_ catalog: NativeBackendCatalogEntry) -> String {
        guard let id = choice.profileId else { return String(localized: "默认配置") }
        return catalog.profiles.first { $0.id == id }?.name ?? id
    }

    private func profileEntries(_ catalog: NativeBackendCatalogEntry) -> [NativeMenuEntry] {
        var entries: [NativeMenuEntry] = [.header(String(localized: "配置")), .item(String(localized: "默认配置"), checked: choice.profileId == nil) { selectProfile(nil) }]
        for profile in catalog.profiles {
            let id = profile.id
            entries.append(.item(profile.name, subtitle: profile.description_, checked: choice.profileId == id) { selectProfile(id) })
        }
        return entries
    }

    /// A profile has its own model catalog, so the model is dropped with it.
    private func selectProfile(_ id: String?) {
        guard choice.profileId != id else { return }
        choice.profileId = id
        choice.model = nil
    }

    private func label(of value: String?, in options: [NativeBackendOption]) -> String {
        guard let value else { return String(localized: "默认") }
        return options.first { $0.id == value }?.label ?? value
    }

    private func optionEntries(_ title: String, _ options: [NativeBackendOption], selection: String?, choose: @escaping (String?) -> Void) -> [NativeMenuEntry] {
        var entries: [NativeMenuEntry] = [.header(title), .item(String(localized: "默认"), checked: selection == nil) { choose(nil) }]
        for option in options {
            let id = option.id
            entries.append(.item(option.label, subtitle: option.description_, checked: selection == id) { choose(id) })
        }
        return entries
    }

    private func load(reload: Bool) async {
        guard let backend = choice.agent else {
            catalog = nil
            loadedKey = nil
            loadError = nil
            loading = false
            return
        }
        let request = RequestContext { catalogKey }
        let key = contextKey
        if loadedKey != key { catalog = nil }
        loading = true
        loadError = nil
        defer { if request.isCurrent { loading = false } }
        do {
            let loaded = try await workbench.catalogs.loadCatalog(backend, profileId: choice.profileId, projectId: projectId, reload: reload)
            guard request.isCurrent else { return }
            catalog = loaded
            loadedKey = key
        } catch {
            guard request.isCurrent else { return }
            loadError = error.riffetMessage
        }
    }
}

// MARK: - Native menus for chips

/// One line of a menu built on click. An AppKit menu rather than a SwiftUI `Menu`, for the reason
/// `DirectoryMenu` gives: SwiftUI rebuilds an open menu whenever its page re-renders.
enum NativeMenuEntry {
    case header(String)
    case separator
    case item(String, subtitle: String? = nil, symbol: String? = nil, checked: Bool = false, enabled: Bool = true, action: () -> Void)
}

extension MenuAnchor {
    /// Shows [entries] under the anchor and runs the chosen entry's action once the menu has closed.
    @MainActor
    func popUp(entries: [NativeMenuEntry]) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        var selected: (() -> Void)?
        for entry in entries {
            switch entry {
            case .header(let title):
                menu.addItem(.sectionHeader(title: title))
            case .separator:
                menu.addItem(.separator())
            case .item(let title, let subtitle, let symbol, let checked, let enabled, let action):
                let item = MenuAction.item(title) { selected = action }
                item.subtitle = subtitle
                if let symbol { item.image = NSImage.icon(symbol, accessibilityDescription: nil) }
                item.state = checked ? .on : .off
                item.isEnabled = enabled
                menu.addItem(item)
            }
        }
        if popUp(menu) { selected?() }
    }
}

/// A picker chip that opens a native menu of [entries], built when it is clicked.
struct NativeChipMenu: View {
    let text: String
    var symbol: String?
    let entries: () -> [NativeMenuEntry]
    @State private var anchor = MenuAnchor()

    var body: some View {
        Button { anchor.popUp(entries: entries()) } label: { ChipLabel(text: text, symbol: symbol) }
            .buttonStyle(ChipButtonStyle())
            .background(MenuAnchorView(anchor: anchor))
            .fixedSize()
    }
}

/// A button drawn by [label] that opens a native menu of [entries], built when it is clicked.
struct NativeMenuButton<Label: View>: View {
    let entries: () -> [NativeMenuEntry]
    @ViewBuilder let label: Label
    @State private var anchor = MenuAnchor()

    var body: some View {
        Button { anchor.popUp(entries: entries()) } label: { label }
            .background(MenuAnchorView(anchor: anchor))
            .fixedSize()
    }
}
