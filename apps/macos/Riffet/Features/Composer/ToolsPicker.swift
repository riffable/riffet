import SwiftUI
import RiffetKit

/// What the picker reads (paired phones, the MCP servers and skills a launch loads) and, on the
/// new-conversation page, what it has picked. `ToolsPicker.tsx` is the reference.
@MainActor @Observable
final class ToolsPickerModel {
    private static let lastKey = "riffet.tool-groups.last"
    private static let loadedFresh: TimeInterval = 60

    var phones: [PublicDevice] = []
    var devicesLoaded = false
    var loaded: LoadedExtensions?
    var loadingExtensions = false
    var loadFailed = false
    private var loadedKey: String?
    private var loadedAt = Date.distantPast

    /// The new-conversation page's pick; an open conversation keeps its own on the session.
    private(set) var groups: [String] = ToolsPickerModel.remembered()
    private(set) var off: [String] = []
    private var offScope = ""

    private static func remembered() -> [String] {
        (UserDefaults.standard.stringArray(forKey: lastKey) ?? []).filter { $0.hasPrefix("device:") }
    }

    func setGroups(_ next: [String]) {
        groups = next
        UserDefaults.standard.set(next.filter { $0.hasPrefix("device:") }, forKey: Self.lastKey)
    }

    /// Switched-off items belong to one conversation setup: another agent, provider or project starts clean.
    func setOff(_ next: [String], scope: String) {
        offScope = scope
        off = next
    }

    func offItems(scope: String) -> [String] { offScope == scope ? off : [] }

    func loadDevices(api: RiffetApi?) async {
        guard let api else { return }
        if let devices = try? await api.devices() {
            phones = devices
            devicesLoaded = true
        }
    }

    func loadExtensions(api: RiffetApi?, agent: String, profileId: String?, projectId: String?, force: Bool = false) async {
        guard let api, let backend = builtinBackend(agent), let projectId else { return }
        let key = "\(agent)|\(profileId ?? "")|\(projectId)"
        if !force, loadedKey == key, loaded != nil, Date().timeIntervalSince(loadedAt) < Self.loadedFresh { return }
        if loadedKey != key { loaded = nil }
        loadedKey = key
        loadingExtensions = true
        loadFailed = false
        defer { loadingExtensions = false }
        do {
            let result = try await api.loadedExtensions(backendId: backend, profileId: profileId, projectId: projectId)
            guard loadedKey == key else { return }
            loaded = result
            loadedAt = Date()
        } catch {
            guard loadedKey == key else { return }
            if loaded == nil { loadFailed = true }
        }
    }

    /// The phones a conversation can be given: online and allowing control, plus any already picked.
    func controllable(_ value: [String]) -> [PublicDevice] {
        phones.filter { $0.platform != nil && (($0.allowControl && $0.online) || value.contains(Self.group($0.id))) }
    }

    static func group(_ deviceId: String) -> String { "device:\(deviceId)" }

    /// What a new conversation is created with: nil where the picker is not offered.
    func creation(capabilities: NativeBackendCapabilities?, agent: String, projectId: String?, scope: String) -> (groups: [String]?, off: [String]?) {
        guard let capabilities else { return (nil, nil) }
        let phoneGroups = capabilities.supportsRiffetTools
            ? groups.filter { id in phones.contains { Self.group($0.id) == id && $0.allowControl && $0.online } }
            : nil
        let offered = Self.toggles(capabilities, agent: agent, projectId: projectId) != nil
        let items = offered ? offItems(scope: scope) : []
        return (phoneGroups, items.isEmpty ? nil : items)
    }

    static func toggles(_ capabilities: NativeBackendCapabilities, agent: String, projectId: String?) -> ExtensionToggles? {
        guard projectId != nil, builtinBackend(agent) != nil, let toggles = capabilities.extensionToggles, toggles.mcp || toggles.skills else { return nil }
        return toggles
    }
}

/// Where a composer's + button finds the skills-and-tools rows: the picker in its controls publishes
/// them here and draws no button of its own, and the + button shows them as a submenu.
@MainActor @Observable
final class ComposerToolsSlot {
    /// Builds the rows when the + menu opens; nil when the controls offer nothing.
    @ObservationIgnored private(set) var entries: (() -> [NativeMenuEntry])?
    /// Re-reads the phones and extensions, for the next time the menu opens.
    @ObservationIgnored private(set) var refresh: (() -> Void)?
    private(set) var offered = false
    /// The picker that last published: another one leaving (a conversation switch) does not clear it.
    @ObservationIgnored private var owner: UUID?

    func publish(_ entries: (() -> [NativeMenuEntry])?, refresh: (() -> Void)?, owner: UUID) {
        guard entries != nil || self.owner == owner || self.owner == nil else { return }
        self.owner = entries == nil ? nil : owner
        self.entries = entries
        self.refresh = refresh
        if offered != (entries != nil) { offered = entries != nil }
    }
}

extension EnvironmentValues {
    @Entry var composerToolsSlot: ComposerToolsSlot?
}

/// Which paired phones the agent may control, and which MCP servers and skills it keeps; Riffet's
/// own tools need no pick. Inside a composer the rows go to its + menu (`ComposerToolsSlot`);
/// elsewhere the picker is a button of its own.
struct ToolsPicker: View {
    let model: ToolsPickerModel
    let api: RiffetApi?
    let capabilities: NativeBackendCapabilities
    let agent: String
    let profileId: String?
    let projectId: String?
    let groups: [String]
    let off: [String]
    /// Shown under the rows, for a pick that applies at the next launch.
    var note: String?
    let setGroups: ([String]) -> Void
    let setOff: ([String]) -> Void

    @Environment(\.palette) private var palette
    @Environment(\.composerEnvRow) private var envRow
    @Environment(\.composerToolsSlot) private var slot
    @State private var open = false
    @State private var slotOwner = UUID()

    private static let mcp = "mcp:"
    private static let skill = "skill:"

    private var toggles: ExtensionToggles? { ToolsPickerModel.toggles(capabilities, agent: agent, projectId: projectId) }
    private var phones: [PublicDevice] { capabilities.supportsRiffetTools ? model.controllable(groups) : [] }
    private var loadKey: String { "\(agent)|\(profileId ?? "")|\(projectId ?? "")|\(toggles != nil)" }

    private func rows(_ listed: [String]?, prefix: String) -> [String] {
        var names = listed ?? []
        for item in off where item.hasPrefix(prefix) && !names.contains(String(item.dropFirst(prefix.count))) { names.append(String(item.dropFirst(prefix.count))) }
        return names
    }

    private var mcpRows: [String] { toggles?.mcp == true ? rows(model.loaded?.mcp.map(\.name), prefix: Self.mcp) : [] }
    private var skillRows: [String] { toggles?.skills == true ? rows(model.loaded?.skills.map(\.name), prefix: Self.skill) : [] }
    private var offered: Bool { !phones.isEmpty || !mcpRows.isEmpty || !skillRows.isEmpty }

    private var summary: String {
        let phoneCount = phones.filter { groups.contains(ToolsPickerModel.group($0.id)) }.count
        let offCount = off.count
        let parts = [phoneCount > 0 ? String(localized: "\(phoneCount) 项") : "", offCount > 0 ? String(localized: "已关 \(offCount)") : ""].filter { !$0.isEmpty }
        return parts.isEmpty ? String(localized: "默认") : parts.joined(separator: " · ")
    }

    var body: some View {
        Group {
            if let slot {
                // Nothing to draw: the rows are handed to the + button whenever they change.
                Color.clear.frame(width: 0, height: 0)
                    .onAppear { publish(slot) }
                    .onChange(of: publishKey) { publish(slot) }
                    .onDisappear { slot.publish(nil, refresh: nil, owner: slotOwner) }
            } else if offered {
                button
            }
        }
        .task(id: loadKey) { await reload() }
        .onChange(of: open) { _, isOpen in
            guard isOpen else { return }
            Task { await reload() }
        }
    }

    private func reload(force: Bool = false) async {
        if capabilities.supportsRiffetTools { await model.loadDevices(api: api) }
        if toggles != nil { await model.loadExtensions(api: api, agent: agent, profileId: profileId, projectId: projectId, force: force) }
    }

    /// Everything the menu rows show: a change republishes them.
    private var publishKey: [String] {
        phones.map { "\($0.id)|\($0.name)|\($0.online)" } + groups + off + mcpRows + ["|"] + skillRows
            + [loadKey, "\(model.loadingExtensions)", "\(model.loadFailed)", "\(model.loaded == nil)"]
    }

    private func publish(_ slot: ComposerToolsSlot) {
        let loading = toggles != nil && model.loadingExtensions && model.loaded == nil
        let failed = toggles != nil && model.loadFailed
        guard offered || loading || failed else { slot.publish(nil, refresh: nil, owner: slotOwner); return }
        let entries = menuEntries(loading: loading, failed: failed)
        slot.publish({ entries }, refresh: { Task { await reload() } }, owner: slotOwner)
    }

    private func menuEntries(loading: Bool, failed: Bool) -> [NativeMenuEntry] {
        var entries: [NativeMenuEntry] = []
        if !phones.isEmpty { entries.append(.header(String(localized: "手机"))) }
        for device in phones {
            let group = ToolsPickerModel.group(device.id)
            let on = groups.contains(group)
            entries.append(.item(String(localized: "控制 \(device.name)"), subtitle: device.online ? nil : String(localized: "离线"), checked: on) {
                // A phone that is gone is dropped with the change.
                let kept = groups.filter { id in id != group && phones.contains { ToolsPickerModel.group($0.id) == id } }
                setGroups(on ? kept : kept + [group])
            })
        }
        if !mcpRows.isEmpty { entries.append(.header("MCP")) }
        for name in mcpRows {
            let item = Self.mcp + name
            let on = !off.contains(item)
            entries.append(.item(name, checked: on) { toggleExtension(item, on: !on) })
        }
        if !skillRows.isEmpty { entries.append(.header("Skills")) }
        for name in skillRows {
            let item = Self.skill + name
            let on = !off.contains(item)
            entries.append(.item(name, checked: on) { toggleExtension(item, on: !on) })
        }
        if loading { entries.append(.item(String(localized: "加载中…"), enabled: false) {}) }
        if failed {
            entries.append(.item(String(localized: "无法读取技能与工具"), enabled: false) {})
            entries.append(.item(String(localized: "重试")) { Task { await reload(force: true) } })
        }
        if let note, offered {
            entries.append(.separator)
            entries.append(.item(note, enabled: false) {})
        }
        return entries
    }

    private var button: some View {
        Button { open.toggle() } label: {
            if envRow {
                Image(icon: "puzzlepiece.extension").font(.riffet(size: S(16))).foregroundStyle(palette.fg2)
            } else {
                Image(icon: "puzzlepiece.extension")
            }
        }
        .buttonStyle(IconButtonStyle(size: envRow ? 32 : 26, active: open))
        .help(Text("技能与工具") + Text(verbatim: " · \(summary)"))
        .accessibilityLabel("技能与工具")
        .accessibilityValue(summary)
        .stylePopover(isPresented: $open, arrowEdge: .top) { panel }
    }

    private var panel: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !phones.isEmpty { header("手机") }
                ForEach(phones, id: \.id) { device in
                    let group = ToolsPickerModel.group(device.id)
                    row(String(localized: "控制 \(device.name)"), on: groups.contains(group), trailing: device.online ? nil : String(localized: "离线")) { on in
                        // A phone that is gone is dropped with the change.
                        let kept = groups.filter { id in id != group && phones.contains { ToolsPickerModel.group($0.id) == id } }
                        setGroups(on ? kept + [group] : kept)
                    }
                }
                if !mcpRows.isEmpty { header("MCP") }
                ForEach(mcpRows, id: \.self) { name in
                    let item = Self.mcp + name
                    let tools = model.loaded?.mcp.first { $0.name == name }?.tools
                    row(name, on: !off.contains(item), trailing: tools.map { "\($0)" }) { toggleExtension(item, on: $0) }
                }
                if !skillRows.isEmpty { header("Skills") }
                ForEach(skillRows, id: \.self) { name in
                    let item = Self.skill + name
                    row(name, on: !off.contains(item), trailing: nil) { toggleExtension(item, on: $0) }
                }
                if toggles != nil, model.loadingExtensions, model.loaded == nil {
                    HStack { Spinner(size: .mini) }.frame(height: 28).padding(.horizontal, Space.sm)
                }
                if toggles != nil, model.loadFailed {
                    Button { Task { await model.loadExtensions(api: api, agent: agent, profileId: profileId, projectId: projectId, force: true) } } label: {
                        HStack {
                            Text("无法读取技能与工具").foregroundStyle(palette.fg3).lineLimit(1)
                            Spacer(minLength: Space.sm)
                            Text("重试").foregroundStyle(palette.fg2)
                        }
                        .font(.riffet(size: S(13)))
                        .padding(.horizontal, Space.sm)
                        .frame(height: 28)
                    }
                    .buttonStyle(.plain)
                }
                if let note, offered {
                    Text(note).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                        .padding(.horizontal, Space.sm).padding(.top, Space.xs).padding(.bottom, Space.xs)
                }
            }
            .padding(Space.xs)
        }
        .frame(width: 280)
        .frame(maxHeight: 360)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func toggleExtension(_ item: String, on: Bool) {
        setOff(on ? off.filter { $0 != item } : (off.contains(item) ? off : off + [item]))
    }

    private func header(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.riffet(size: S(11), weight: .medium))
            .foregroundStyle(palette.fg3)
            .padding(.horizontal, Space.sm)
            .padding(.top, Space.sm)
            .padding(.bottom, Space.xxs)
    }

    private func row(_ name: String, on: Bool, trailing: String?, toggle: @escaping (Bool) -> Void) -> some View {
        ToolsRow(name: name, on: on, trailing: trailing) { toggle(!on) }
    }
}

private struct ToolsRow: View {
    let name: String
    let on: Bool
    let trailing: String?
    let action: () -> Void
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                Image(icon: "checkmark").font(.riffet(size: S(10), weight: .semibold)).foregroundStyle(palette.fg2).opacity(on ? 1 : 0).frame(width: 12)
                Text(verbatim: name).lineLimit(1).truncationMode(.tail).foregroundStyle(palette.fg)
                Spacer(minLength: Space.sm)
                if let trailing { Text(verbatim: trailing).font(.riffet(size: S(12)).monospacedDigit()).foregroundStyle(palette.fg3) }
            }
            .font(.riffet(size: S(13)))
            .padding(.horizontal, Space.sm)
            .frame(height: 28)
            .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(hovering ? palette.bgHover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// The open conversation's pick, saved with the session and applied at its next launch.
struct SessionToolsPicker: View {
    let workbench: Workbench
    let session: Session
    let capabilities: NativeBackendCapabilities
    @State private var model = ToolsPickerModel()
    @State private var pendingGroups: [String]?
    @State private var pendingOff: [String]?

    var body: some View {
        ToolsPicker(
            model: model, api: workbench.host.api, capabilities: capabilities,
            agent: session.agentID, profileId: session.backendProfileId, projectId: session.projectId,
            groups: pendingGroups ?? session.toolGroups ?? [], off: pendingOff ?? session.extensionsOff ?? [],
            note: String(localized: "下次启动时生效"),
            setGroups: { next in
                pendingGroups = next
                Task { await workbench.update(session, toolGroups: next); pendingGroups = nil }
            },
            setOff: { next in
                pendingOff = next
                Task { await workbench.update(session, extensionsOff: next); pendingOff = nil }
            }
        )
    }
}
