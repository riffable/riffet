import AppKit
import Foundation
import Observation
import RiffetKit

/// Owned by the workbench, so a configuration draft survives visits to another page.
@MainActor @Observable
final class PluginManagementStore {
    var items: [PluginDescriptor] = []
    var selectedID = ""
    var query = ""
    var filter = "all"
    var draft: [String: String] = [:]
    var baseline: PluginDescriptor?
    var error: String?
    var busy = false
    var loading = false
    var recovery = false
    var diagnostics: [PluginDiagnostic] = []
    /// READMEs by plugin id and language; an empty one is a plugin without, a missing one is not read yet.
    var readmes: [String: String] = [:]
    var logs: [PluginLogEntry] = []
    @ObservationIgnored private var readSerial = 0
    var grant: PluginGrantRequired?
    var trustedInstall = false
    @ObservationIgnored private var package: (data: Data, name: String)?
    /// A release of the plugin index being installed, or asked for by a `riffet://plugins/install` link before this page connected.
    @ObservationIgnored private var market: (id: String, version: String?, source: String?)?
    @ObservationIgnored private var api: RiffetApi?
    @ObservationIgnored private var serverKey: String?
    @ObservationIgnored private var generation = 0
    /// The public plugin index as the server lists it; nil until first loaded.
    var marketList: PluginMarketList?
    var marketLoading = false
    var marketError: String?
    /// The source the market list is narrowed to; "all" is every enabled one.
    var marketSource = "all"
    var sourceBusy = false
    var sourceError: String?
    @ObservationIgnored private var marketSerial = 0
    var connected: Bool { api != nil }
    /// For the plugin's own page, which talks to the server itself.
    var client: RiffetApi? { api }
    var dirty: Bool { !draft.isEmpty }
    var selected: PluginDescriptor? { items.first { Self.key($0) == selectedID || $0.id == selectedID } }
    static func key(_ plugin: PluginDescriptor) -> String {
        let identity = (plugin.source ?? "builtin") + ":" + plugin.id
        return plugin.source == "development" ? identity + ":" + (plugin.developmentPath ?? "") : identity
    }
    static func canRemove(_ plugin: PluginDescriptor) -> Bool {
        plugin.source == "installed" && plugin.installed != nil
            || plugin.source == "development" && plugin.developmentPath?.isEmpty == false
    }

    func connect(_ next: RiffetApi?) async {
        // Reopening this page is not a new connection. Keep in-flight writes and
        // their generation alive so a second operation cannot overtake them.
        if api === next {
            if !busy { await refresh() }
            return
        }
        generation += 1; busy = false; loading = false; marketLoading = false; sourceBusy = false; sourceError = nil; marketSource = "all"; trustedInstall = false
        if let next, serverKey != next.baseUrl {
            // A link that arrived before the first connection is for this server; one left pending on another is not.
            if serverKey != nil { market = nil }
            serverKey = next.baseUrl
            marketList = nil; marketError = nil
            items = []; selectedID = ""; draft = [:]; baseline = nil; grant = nil; package = nil; trustedInstall = false
        }
        api = next
        await refresh()
        if let market, grant == nil { await offer(id: market.id, version: market.version, source: market.source) }
    }

    /// From the plugin market page: the release is shown for confirmation, never installed by the link alone.
    func requestMarketInstall(id: String, version: String?, source: String? = nil) async {
        package = nil; market = (id, version, source); trustedInstall = false
        if api != nil { await offer(id: id, version: version, source: source) }
    }
    private func offer(id: String, version: String?, source: String?) async {
        let current = generation
        await run { api in
            let offer = try await api.marketPluginOffer(id: id, version: version, source: source)
            if current == self.generation { self.market = (offer.id, offer.version, offer.sourceId); self.grant = offer.grant }
        }
        if grant == nil { market = nil }
    }
    func loadMarket(refresh: Bool = false) async {
        guard let api else { return }
        let current = generation
        marketSerial += 1
        let reading = marketSerial
        marketLoading = true; marketError = nil
        defer { if current == generation, reading == marketSerial { marketLoading = false } }
        do {
            let list = try await api.marketPlugins(refresh: refresh)
            guard current == generation, reading == marketSerial else { return }
            marketList = list; keepSourceFilter()
        } catch { if current == generation, reading == marketSerial { marketError = error.riffetMessage } }
    }
    /// Sources that feed the list, in the server's order.
    var enabledSources: [PluginSource] { (marketList?.sources ?? []).filter(\.enabled) }
    /// Names are shown only when there is more than one source to tell apart.
    var multipleSources: Bool { enabledSources.count > 1 }
    func sourceName(_ id: String) -> String {
        marketList?.sources.first { $0.id == id }.map(Self.displayName) ?? id
    }
    private static func installedKey(_ items: [PluginDescriptor]) -> String {
        items.map { "\($0.id)@\($0.installed?.selected ?? $0.version ?? "")" }.sorted().joined(separator: "\n")
    }
    static func displayName(_ source: PluginSource) -> String {
        if let name = source.name, !name.isEmpty { return name }
        if source.builtin { return "Riffet" }
        if let host = URL(string: source.url)?.host(), !host.isEmpty { return host }
        return source.url
    }
    private func keepSourceFilter() {
        if marketSource != "all", !enabledSources.contains(where: { $0.id == marketSource }) { marketSource = "all" }
    }
    /// Source changes answer with the whole list, which replaces the one shown.
    private func changeSources(_ action: (RiffetApi) async throws -> PluginMarketList) async -> Bool {
        guard let api, !sourceBusy else { return false }
        let current = generation
        sourceBusy = true; sourceError = nil
        defer { if current == generation { sourceBusy = false } }
        do {
            let list = try await action(api)
            guard current == generation else { return false }
            marketList = list; marketError = nil; keepSourceFilter()
            return true
        } catch { if current == generation { sourceError = error.riffetMessage }; return false }
    }
    func addSource(_ url: String) async -> Bool { await changeSources { try await $0.addPluginSource(url: url) } }
    func setSource(_ id: String, enabled: Bool) async { _ = await changeSources { try await $0.setPluginSourceEnabled(id: id, enabled: enabled) } }
    func removeSource(_ id: String) async { _ = await changeSources { try await $0.removePluginSource(id: id) } }

    func select(_ plugin: PluginDescriptor) { selectedID = Self.key(plugin); baseline = plugin; draft = [:]; diagnostics = []; logs = [] }
    func collapse() { selectedID = ""; baseline = nil; draft = [:]; diagnostics = []; logs = [] }
    func discard() { draft = [:]; baseline = selected }

    func refresh(detect: Bool = false) async {
        guard let api else { return }
        let current = generation
        readSerial += 1
        let reading = readSerial
        loading = true
        defer { if current == generation, reading == readSerial { loading = false } }
        do {
            if detect { _ = try await api.refreshPlugins() }
            let inventory = try await api.pluginInventory()
            let loaded = inventory.integrations
            guard current == generation, reading == readSerial else { return }
            recovery = inventory.recovery
            // The market marks what is installed as of its read: a change to the installed list reads it again.
            let installedChanged = Self.installedKey(items) != Self.installedKey(loaded)
            items = loaded; if !dirty { error = nil }
            if installedChanged, marketList != nil { Task { await self.loadMarket() } }
            if !dirty && !busy { baseline = selected }
            PluginsStore.shared.update(loaded)
        } catch { if current == generation, reading == readSerial { self.error = error.riffetMessage } }
    }

    private func run(_ action: (RiffetApi) async throws -> Void) async {
        guard let api, !busy else { return }
        let current = generation
        busy = true; error = nil
        defer { if current == generation { busy = false } }
        do { try await action(api); if current == generation { await refresh() } }
        catch { if current == generation { self.error = error.riffetMessage } }
    }
    func enable(_ value: String, force: Bool = false, plugin: PluginDescriptor? = nil) async {
        guard let selected = plugin ?? selected else { return }
        await run { api in _ = try await api.updatePlugin(id: selected.id, update: PluginUpdate(enablement: value, settings: nil, force: KotlinBoolean(bool: force), configRevision: nil)) }
    }
    func save() async {
        guard let selected, !selected.rejected, let baseline, dirty else { return }
        let values = draft, current = generation
        await run { api in
            let saved = try await api.updatePlugin(id: selected.id, update: PluginUpdate(enablement: nil, settings: values, force: nil, configRevision: baseline.configRevision))
            if current == self.generation { self.baseline = saved; self.draft = [:] }
        }
    }
    func readLogs() async {
        guard let selected else { return }
        let current = generation, key = Self.key(selected)
        await run { api in
            let logs = try await api.pluginLogs(id: selected.id).logs
            if current == self.generation, key == self.selected.map(Self.key) { self.logs = logs }
        }
    }

    func choosePackage() async {
        guard !busy else { return }
        let current = generation
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard await panel.begin() == .OK, current == generation, let url = panel.url else { return }
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 32 * 1024 * 1024 else { error = String(localized: "插件包不能超过 32 MB"); return }
            package = (try Data(contentsOf: url), url.lastPathComponent); market = nil
            trustedInstall = false
            await install(grant: [])
        } catch { self.error = error.riffetMessage }
    }
    func install(grant capabilities: [String], trusted: Bool = false) async {
        guard package != nil || market?.version != nil else { return }
        let package = package, market = market
        let current = generation
        await run { api in
            do {
                let result = if let package {
                    try await api.installPluginPackage(bytes: byteArrayFromData(data: package.data), fileName: package.name, grant: capabilities, trusted: trusted)
                } else {
                    try await api.installMarketPlugin(id: market!.id, version: market!.version!, source: market!.source ?? "riffet", grant: capabilities, trusted: trusted)
                }
                guard current == self.generation else { return }
                self.grant = result.grant
                self.trustedInstall = false
                if let plugin = result.plugin {
                    self.selectedID = Self.key(plugin); self.package = nil; self.market = nil
                    self.query = ""; self.filter = "all"
                    self.diagnostics = []; self.baseline = plugin
                }
            } catch {
                if current == self.generation { self.grant = nil; self.trustedInstall = false; self.market = nil }
                throw error
            }
        }
    }
    func cancelInstall() { grant = nil; package = nil; market = nil; trustedInstall = false }
    func selectVersion(_ version: String) async {
        guard let selected else { return }
        await run { api in _ = try await api.selectPluginVersion(id: selected.id, version: version) }
    }
    func uninstall(_ version: String) async {
        guard let selected else { return }
        await run { api in _ = try await api.uninstallPluginVersion(id: selected.id, version: version) }
    }
    func remove(_ plugin: PluginDescriptor) async {
        guard !dirty, Self.canRemove(plugin), let selected, Self.key(selected) == Self.key(plugin) else { return }
        let current = generation
        await run { api in
            _ = try await api.uninstallPlugin(id: plugin.id, source: plugin.source, path: plugin.developmentPath)
            guard current == self.generation else { return }
            if Self.key(plugin) == self.selectedID || plugin.id == self.selectedID { self.collapse() }
        }
    }
    func diagnose() async {
        guard let selected else { return }
        let current = generation, key = Self.key(selected)
        await run { api in
            let result = try await api.pluginDiagnostics(id: selected.id)
            if current == self.generation, key == self.selected.map(Self.key) { self.diagnostics = result }
        }
    }
    static func readmeKey(_ plugin: PluginDescriptor) -> String { plugin.id + "|" + PluginPageModel.locale }
    /// Read once per plugin and language; a failure shows the description instead.
    func loadReadme(_ plugin: PluginDescriptor) async {
        let key = Self.readmeKey(plugin)
        guard let api, readmes[key] == nil, !plugin.rejected else { return }
        let text = (try? await api.pluginReadme(id: plugin.id, locale: PluginPageModel.locale))?.readme ?? ""
        readmes[key] = text
    }
    func setRecovery(_ enabled: Bool) async { await run { api in _ = try await api.setPluginRecovery(enabled: enabled) } }
    func reload() async { guard let selected else { return }; await run { api in _ = try await api.reloadPlugin(id: selected.id) } }
    func deleteData() async {
        guard let selected else { return }
        await run { api in _ = try await api.deletePluginData(id: selected.id) }
    }
}
