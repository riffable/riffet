import SwiftUI
import RiffetKit

/*
 * 技能与工具: which paired phones the conversation's agent may control (docs/DEVICES.md §2), and which
 * MCP servers and Skills it starts without (docs/EXTENSIONS.md). Riffet's own basic tools are always
 * on. The rules live in the shared `ToolGroups` and `ExtensionsOff`; this file only lays them out as
 * one more page of the send-settings sheet.
 */

/// The MCP and Skill switches of one conversation. [off] is the `mcp:` / `skill:` entries that are
/// off; [onChange] gets the whole new list.
struct ExtensionsPick {
    let api: RiffetApi
    let backendId: NativeBackendId
    let profileId: String?
    let projectId: String
    let toggles: ExtensionToggles
    let off: [String]
    let onChange: ([String]) -> Void
    var key: String { "\(backendId.name)|\(profileId ?? "")|\(projectId)" }

    /// The switches, when the backend has some and the conversation is not a quick chat or archived.
    @MainActor static func make(workbench: Workbench, allowed: Bool, capabilities: NativeBackendCapabilities?, backendId: NativeBackendId?,
                     profileId: String?, projectId: String?, off: [String], onChange: @escaping ([String]) -> Void) -> ExtensionsPick? {
        guard allowed, let api = workbench.api, let backendId, let projectId,
              let toggles = ExtensionsOff.shared.toggles(capabilities: capabilities) else { return nil }
        return ExtensionsPick(api: api, backendId: backendId, profileId: profileId, projectId: projectId, toggles: toggles, off: off, onChange: onChange)
    }
    func cached() -> LoadedExtensions? {
        LoadedExtensionsCache.shared.peek(api: api, backendId: backendId, profileId: profileId, projectId: projectId)
    }
}

/// What a launch loads, read when the picker page opens; the cache keeps it for the app session.
@MainActor @Observable final class ExtensionsReader {
    private(set) var loaded: LoadedExtensions?
    private(set) var failed = false
    func load(_ pick: ExtensionsPick, force: Bool) async {
        failed = false
        do {
            let result = try await LoadedExtensionsCache.shared.load(api: pick.api, backendId: pick.backendId, profileId: pick.profileId,
                                                                      projectId: pick.projectId, force: force)
            if !Task.isCancelled { loaded = result }
        } catch { if !Task.isCancelled { failed = true } }
    }
}

/// The paired devices, read when the page that offers the picker appears and again each time the app
/// returns to the foreground; never polled. Nil until the first read answers, and a failed read keeps
/// what was last seen.
@MainActor @Observable final class ToolDevices {
    private(set) var devices: [PublicDevice]?
    /// The plugins, for their agent tools (the browser, docs/BROWSER.md §2); read with the devices.
    private(set) var plugins: [PluginDescriptor]?
    func load(_ workbench: Workbench) async {
        guard let api = workbench.api else { return }
        async let devices = try? api.devices()
        async let plugins = try? api.plugins()
        let (readDevices, readPlugins) = await (devices, plugins)
        guard !Task.isCancelled else { return }
        if let readDevices { self.devices = readDevices }
        if let readPlugins { self.plugins = readPlugins }
    }
}

enum ToolsPick {
    /// The plugins' tool groups to list, or nil before the plugins are read.
    static func pluginGroups(_ plugins: [PluginDescriptor]?, value: [String]) -> [PluginToolGroup]? {
        plugins.map { ToolGroups.shared.pluginGroups(plugins: $0, value: value) }
    }
    /// There is something to pick, or something already picked that can be switched off.
    static func offered(devices: [PublicDevice]?, value: [String], plugins: [PluginDescriptor]? = nil) -> Bool {
        !value.isEmpty || devices.map { !ToolGroups.shared.controllable(devices: $0).isEmpty } == true
            || pluginGroups(plugins, value: [])?.contains(where: \.enabled) == true
    }
    /// A new conversation's pick: the remembered phones and plugin tools that can be offered now. One offline is kept for the next.
    static func offeredPicks(devices: [PublicDevice]?, value: [String], plugins: [PluginDescriptor]? = nil) -> [String] {
        let kit = ToolGroups.shared
        var offered = Set((devices.map { kit.controllable(devices: $0) } ?? []).map { kit.deviceGroup(deviceId: $0.id) })
        offered.formUnion((pluginGroups(plugins, value: []) ?? []).filter(\.enabled).map(\.id))
        return kit.picks(groups: value).filter { offered.contains($0) }
    }
    /// The phones picked, then how many MCP servers and Skills are off.
    /// With switches and nothing changed, everything installed is on: 默认, not 未开启.
    static func summary(_ value: [String], off: Int = 0, switches: Bool = false) -> String {
        if off == 0 { return value.isEmpty ? (switches ? String(localized: "默认", bundle: .riffet) : String(localized: "未开启", bundle: .riffet)) : String(localized: "\(value.count) 项", bundle: .riffet) }
        return value.isEmpty ? String(localized: "已关 \(off)", bundle: .riffet) : String(localized: "\(value.count) 项 · 已关 \(off)", bundle: .riffet)
    }
}

extension View {
    /// Reads the device list while [enabled] and the app is in the foreground.
    func readsToolDevices(_ tools: ToolDevices, workbench: Workbench, enabled: Bool) -> some View {
        modifier(ToolDevicesReader(tools: tools, workbench: workbench, enabled: enabled))
    }
}

private struct ToolDevicesReader: ViewModifier {
    let tools: ToolDevices
    let workbench: Workbench
    let enabled: Bool
    @Environment(\.scenePhase) private var phase
    func body(content: Content) -> some View {
        let reading = enabled && phase == .active
        content.task(id: reading) { if reading { await tools.load(workbench) } }
    }
}

/// The settings row that opens [ToolsPickerPage].
struct ToolsPickerLink: View {
    let value: [String]
    let devices: [PublicDevice]?
    let onChange: ([String]) -> Void
    var plugins: [PluginDescriptor]? = nil
    var extensions: ExtensionsPick? = nil
    var footnote: String? = nil
    var error: String? = nil
    var enabled = true
    var body: some View {
        NavigationLink {
            ToolsPickerPage(value: value, devices: devices, onChange: onChange, plugins: plugins, extensions: extensions, footnote: footnote, error: error, enabled: enabled)
        } label: {
            LabeledContent("技能与工具", value: ToolsPick.summary(value, off: extensions?.off.count ?? 0, switches: extensions != nil))
        }.accessibilityIdentifier("sessionToolsOptions")
    }
}

/// The phone list and the MCP and Skill switches as one page; a pick changes the selection and keeps
/// the page open. The switches are read when the page opens; phones never wait on them.
struct ToolsPickerPage: View {
    let value: [String]
    let devices: [PublicDevice]?
    let onChange: ([String]) -> Void
    var plugins: [PluginDescriptor]? = nil
    var extensions: ExtensionsPick? = nil
    var footnote: String? = nil
    var error: String? = nil
    var enabled = true
    @State private var reader = ExtensionsReader()
    @Environment(\.palette) private var palette
    var body: some View {
        let kit = ToolGroups.shared
        let known = devices ?? []
        let controllable = kit.controllable(devices: known)
        // A phone in the value that is no longer offered stays listed, so it can be switched off.
        let offered = Set(controllable.map { kit.deviceGroup(deviceId: $0.id) })
        let stale = devices == nil ? [] : kit.phones(groups: value).filter { !offered.contains($0) }
        let groups = ToolsPick.pluginGroups(plugins, value: value)
        let language = Locale.current.language.languageCode?.identifier ?? "zh"
        Form {
            RiffetNotice.section(.error, error)
            if let groups, !groups.isEmpty { Section {
                ForEach(groups, id: \.id) { group in
                    let on = value.contains(group.id)
                    Button { onChange(kit.toggled(value: value, devices: known, plugins: groups, group: group.id, on: !on)) } label: {
                        ConfigurationChoiceRow(title: group.label(language: language), detail: group.enabled ? nil : String(localized: "已停用", bundle: .riffet), selected: on)
                    }.foregroundStyle(palette.fg)
                }
            } }
            if !controllable.isEmpty || !stale.isEmpty { Section {
                ForEach(controllable, id: \.id) { device in
                    let group = kit.deviceGroup(deviceId: device.id)
                    row(String(localized: "控制 \(device.name)", bundle: .riffet), detail: nil, group: group, known: known)
                }
                ForEach(stale, id: \.self) { group in
                    let phone = known.first { kit.deviceGroup(deviceId: $0.id) == group }
                    row(phone.map { String(localized: "控制 \($0.name)", bundle: .riffet) } ?? String(localized: "已移除的手机", bundle: .riffet),
                        detail: phone.flatMap { $0.online ? nil : String(localized: "离线", bundle: .riffet) }, group: group, known: known)
                }
            } header: { Text("手机") } }
            if let extensions { extensionSections(extensions, loaded: reader.loaded ?? extensions.cached()) }
            if let footnote { Section {} footer: { Text(footnote) } }
        }
        .task(id: extensions?.key) { if let extensions { await reader.load(extensions, force: false) } }
        .disabled(!enabled)
        .navigationTitle(String(localized: "技能与工具", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }
    private func row(_ title: String, detail: String?, group: String, known: [PublicDevice]) -> some View {
        let on = value.contains(group)
        return Button { onChange(ToolGroups.shared.toggled(value: value, devices: known, plugins: ToolsPick.pluginGroups(plugins, value: value), group: group, on: !on)) } label: {
            ConfigurationChoiceRow(title: title, detail: detail, selected: on)
        }.foregroundStyle(palette.fg)
    }
    @ViewBuilder private func extensionSections(_ pick: ExtensionsPick, loaded: LoadedExtensions?) -> some View {
        let kit = ExtensionsOff.shared
        if let loaded {
            if pick.toggles.mcp {
                let counts = Dictionary(loaded.mcp.compactMap { server in server.tools.map { (server.name, $0.intValue) } }, uniquingKeysWith: { first, _ in first })
                extensionSection(String(localized: "MCP", bundle: .riffet), names: kit.listed(loaded: loaded.mcp.map(\.name), value: pick.off, prefix: kit.MCP_PREFIX),
                                 prefix: kit.MCP_PREFIX, counts: counts, pick: pick)
            }
            if pick.toggles.skills {
                extensionSection(String(localized: "Skills", bundle: .riffet), names: kit.listed(loaded: loaded.skills.map(\.name), value: pick.off, prefix: kit.SKILL_PREFIX),
                                 prefix: kit.SKILL_PREFIX, counts: [:], pick: pick)
            }
        } else if reader.failed {
            Section {
                RiffetNotice(kind: .error, message: String(localized: "无法读取技能与工具", bundle: .riffet),
                             actionTitle: String(localized: "重试", bundle: .riffet)) { Task { await reader.load(pick, force: true) } }
            }
        } else {
            Section { ProgressView().frame(maxWidth: .infinity) }
        }
    }
    @ViewBuilder private func extensionSection(_ title: String, names: [String], prefix: String, counts: [String: Int], pick: ExtensionsPick) -> some View {
        if !names.isEmpty {
            Section {
                ForEach(names, id: \.self) { name in
                    let item = prefix + name
                    let on = !pick.off.contains(item)
                    Button { pick.onChange(ExtensionsOff.shared.toggled(value: pick.off, item: item, on: !on)) } label: {
                        ConfigurationChoiceRow(title: name, detail: nil, selected: on, trailing: counts[name].map { String($0) })
                    }.foregroundStyle(palette.fg)
                }
            } header: { Text(title) }
        }
    }
}
