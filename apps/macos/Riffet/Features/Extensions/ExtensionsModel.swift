import Foundation
import RiffetKit

/// Vocabulary shared by the extensions page and the settings pane (web `lib/extensions.ts`).
enum ExtensionText {
    static let kindOrder = ["skill", "mcp", "plugin", "hook", "rule", "command", "config"]

    static func kind(_ kind: String) -> String {
        switch kind {
        case "skill": "Skill"
        case "mcp": "MCP"
        case "plugin": "Plugin"
        case "hook": "Hook"
        case "rule": "Rule"
        case "command": "Command"
        default: String(localized: "配置")
        }
    }

    static func scope(_ scope: String) -> String {
        switch scope {
        case "user": String(localized: "用户级")
        case "project": String(localized: "项目级")
        case "managed": String(localized: "外部维护")
        case "builtin": String(localized: "内置")
        default: scope
        }
    }

    static func action(_ action: String) -> String {
        switch action {
        case "enable": String(localized: "启用")
        case "disable": String(localized: "停用")
        case "install": String(localized: "安装插件")
        case "update": String(localized: "更新")
        case "uninstall": String(localized: "卸载")
        case "reload": String(localized: "重载 MCP")
        case "login": String(localized: "认证")
        default: action
        }
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "skill": "sparkles"
        case "mcp": "point.3.connected.trianglepath.dotted"
        case "plugin": "puzzlepiece.extension"
        case "hook": "arrow.triangle.turn.up.right.diamond"
        case "rule": "text.alignleft"
        case "command": "terminal"
        default: "doc.text"
        }
    }

    static func runtimeState(_ state: String) -> String {
        switch state {
        case "loaded": String(localized: "已加载")
        case "error": String(localized: "异常")
        case "pending": String(localized: "待生效")
        default: String(localized: "状态未知")
        }
    }
}

/// One item's state as the catalog shows it (web `extensionStatus`).
enum ExtensionStatus: Equatable {
    case disabled, attention, loaded, pending, enabled, discovered

    var label: String {
        switch self {
        case .disabled: String(localized: "已停用")
        case .attention: String(localized: "需处理")
        case .loaded: String(localized: "已加载")
        case .pending: String(localized: "待加载")
        case .enabled: String(localized: "已启用")
        case .discovered: String(localized: "已发现")
        }
    }
}

/// Which management actions an item offers, and how they are presented. Ported from web
/// `extensions/model.ts`: the server's per-item list is authoritative; only an item without one
/// falls back to the profile's capabilities for its kind.
enum ExtensionRules {
    static func actions(for item: ExtensionItem, capabilities: ExtensionManagementCapabilities?, inventoryFailed: Bool = false) -> [String] {
        if inventoryFailed { return [] }
        // An explicit empty list also overrides broad capabilities.
        if let declared = item.actions { return declared.filter { $0 != "install" } }
        if item.kind == "skill" || item.ownerPluginId != nil || item.scope == "managed" || item.scope == "builtin" { return [] }
        return (capabilities?.kinds[item.kind] ?? []).filter { action in
            action != "install" && (!["plugin", "mcp"].contains(item.kind) || item.nativeId?.isEmpty == false)
        }
    }

    /// The buttons of the detail's management section. An enabled item hides "启用" and a disabled
    /// one hides "停用"; a state that cannot be toggled keeps one disabled button that says why.
    static func presentations(for item: ExtensionItem, actions: [String]) -> [ExtensionActionPresentation] {
        let enabled = item.enabled?.boolValue
        var rows: [ExtensionActionPresentation] = []
        for action in actions {
            if let enabled, (action == "enable" && enabled) || (action == "disable" && !enabled) { continue }
            let title = item.kind == "skill" && action == "uninstall" ? String(localized: "删除 Skill") : ExtensionText.action(action)
            rows.append(ExtensionActionPresentation(id: action, title: title, help: nil, enabled: true))
        }
        if let enabled {
            let toggle = enabled ? "disable" : "enable"
            if !actions.contains(toggle) {
                rows.insert(ExtensionActionPresentation(
                    id: toggle,
                    title: ExtensionText.action(toggle),
                    help: item.readOnlyReason ?? String(localized: "此条目的来源不支持在这里\(ExtensionText.action(toggle))"),
                    enabled: false
                ), at: 0)
            }
        }
        return rows
    }

    static func canLogin(_ capabilities: ExtensionManagementCapabilities?) -> Bool {
        capabilities?.kinds["mcp"]?.contains("login") == true
    }

    /// Runtime entries are session specific. Never pick a winner or join two same-name file sources.
    static func runtimeEntries(for item: ExtensionItem, ambiguousNativeId: Bool, report: ExtensionRuntimeReport?) -> [ExtensionRuntimeEntry] {
        guard let report else { return [] }
        return report.entries.filter { runtime in
            if runtime.kind != item.kind { return false }
            // One JSON document can hold several MCP servers or hooks; a path alone is not an identity.
            if let nativeId = item.nativeId, !nativeId.isEmpty, runtime.name != nativeId { return false }
            if let runtimePath = runtime.sourcePath, let itemPath = item.sourcePath { return runtimePath == itemPath }
            return !ambiguousNativeId && item.nativeId?.isEmpty == false && runtime.name == item.nativeId
        }
    }

    static func status(for item: ExtensionItem, runtime: [ExtensionRuntimeEntry]) -> ExtensionStatus {
        if item.enabled?.boolValue == false { return .disabled }
        if runtime.contains(where: { $0.state == "error" }) { return .attention }
        if !runtime.isEmpty, runtime.allSatisfy({ $0.state == "loaded" }) { return .loaded }
        if runtime.contains(where: { $0.state == "pending" }) { return .pending }
        return item.enabled?.boolValue == true ? .enabled : .discovered
    }
}

/// Request building and result handling for management actions, shared by both clients.
enum ExtensionOps {
    /// A Skill's enable, disable and delete are checked against its manifest's current hash.
    static func skillManifestHash(api: RiffetApi, context: ExtensionContext, item: ExtensionItem) async throws -> String? {
        guard item.kind == "skill" else { return nil }
        guard let documentId = item.documentId else { throw SettingsFailure(String(localized: "无法读取 Skill 主文件，请刷新目录后重试。")) }
        let document = try await api.extensionDocument(context: context, documentId: documentId)
        guard !document.contentHash.isEmpty else { throw SettingsFailure(String(localized: "无法确认 Skill 主文件版本，请刷新目录后重试。")) }
        return document.contentHash
    }

    /// The server refuses a Skill action without the main file's hash (`expectedHash`).
    static func request(action: String, item: ExtensionItem?, target: String?, scope: String?, expectedHash: String?) -> ExtensionActionRequest {
        ExtensionActionRequest(action: action, itemId: item?.id, target: target, scope: scope, expectedHash: expectedHash)
    }

    static func itemScope(_ item: ExtensionItem?) -> String? {
        item?.scope == "user" || item?.scope == "project" ? item?.scope : nil
    }

    static func authorizationURL(_ result: ExtensionActionResult) -> URL? {
        guard let value = result.authorizationUrl, let url = URL(string: value),
              ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return url
    }

    /// The text of an action's outcome: apply effect, output and diagnostics.
    static func summary(_ result: ExtensionActionResult) -> String {
        var lines = [result.applyEffect]
        if let output = result.output { lines.append(output) }
        lines += result.diagnostics ?? []
        return lines.filter { !$0.isEmpty }.joined(separator: "\n")
    }
}

/// The starting path and text of a new file for a create target.
enum ExtensionCreateDefaults {
    static func values(for target: ExtensionCreateTarget?) -> (path: String, text: String) {
        guard let target else { return ("", "") }
        let prefix = target.directory.isEmpty ? "" : "\(target.directory)/"
        var path: String
        var text: String
        switch target.kind {
        case "skill":
            path = "\(prefix)my-skill/SKILL.md"
            text = "---\nname: my-skill\ndescription: Describe when this skill applies\n---\n\n"
        case "rule":
            path = "\(prefix)my-rule.md"
            text = "# Rule\n\n"
        case "command":
            path = "\(prefix)my-command.md"
            text = "# Command\n\n"
        default:
            path = "\(prefix)\(target.fileName ?? "mcp.json")"
            text = target.kind == "mcp" ? "{\n  \"mcpServers\": {}\n}\n" : "{\n  \"hooks\": {}\n}\n"
        }
        if let template = target.template { text = template }
        return (path, text)
    }
}

// MARK: - Aggregated catalog

/// One Agent profile's extension directory for the current project.
struct ExtensionSource: Identifiable {
    let key: String
    let context: ExtensionContext
    let backendId: NativeBackendId
    var profileName: String
    var inventory: ExtensionInventory?
    var capabilities: ExtensionManagementCapabilities?
    var capabilityError: String?
    var error: String?
    var loading = false

    var id: String { key }
    var title: String { "\(backendTitle(backendId)) · \(profileName)" }
}

/// An item of one source's inventory. Items of different sources stay separate even with the same name.
struct ExtensionEntry: Identifiable {
    let key: String
    let sourceKey: String
    let context: ExtensionContext
    let backendId: NativeBackendId
    let profileName: String
    let item: ExtensionItem
    let sourceLabel: String
    let ownerKey: String?
    let ambiguousNativeId: Bool
    /// Lower-cased text the search matches, built once with the entry.
    let search: String
    /// The item's fields the catalog filters, sorts and draws, read once from the Kotlin object
    /// rather than bridged again on every filter pass.
    let name: String
    let kind: String
    let scope: String
    let enabled: Bool?
    let fromPlugin: Bool
    let subtitle: String
    let scopeAndKind: String
    let agent: String

    var id: String { key }
}

func extensionContextKey(_ context: ExtensionContext) -> String {
    "\(backendWire(context.backendId))|\(context.profileId)|\(context.projectId ?? "")"
}

func extensionEntryKey(_ context: ExtensionContext, _ id: String) -> String {
    "\(extensionContextKey(context))#\(id)"
}

/// Extensions use one native configuration per Agent, independent of conversation providers.
func extensionSourceDescriptors(backends: [NativeBackendCatalogEntry], projectId: String?) -> [ExtensionSource] {
    // Extension management is the built-in Agents'; a plugin's Agent has no inventory here.
    backends.compactMap { backend in
        guard backend.agentId == nil, let profile = backend.profiles.first(where: { $0.id == "local" })
            ?? backend.profiles.first(where: { $0.isDefault?.boolValue == true })
            ?? backend.profiles.first else { return nil }
        let context = ExtensionContext(backendId: backend.backendId, profileId: profile.id, projectId: projectId)
        return ExtensionSource(key: extensionContextKey(context), context: context, backendId: backend.backendId, profileName: profile.name)
    }
}

/// Entries of one inventory, with the source label web shows: the owning plugin, native plugin,
/// the project, or the scope.
func extensionEntries(for source: ExtensionSource, projectName: String?) -> [ExtensionEntry] {
    guard let inventory = source.inventory else { return [] }
    let plugins = Dictionary(inventory.items.filter { $0.kind == "plugin" }.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    var identities: [String: Int] = [:]
    for item in inventory.items {
        if let nativeId = item.nativeId, !nativeId.isEmpty { identities["\(item.kind)|\(nativeId)", default: 0] += 1 }
    }
    let agent = backendTitle(source.backendId)
    return inventory.items.map { item in
        let name = item.name, kind = item.kind, scope = item.scope, owner = item.ownerPluginId
        let description = item.description_, sourcePath = item.sourcePath, nativeId = item.nativeId
        let label: String
        if let owner { label = plugins[owner]?.name ?? String(localized: "插件提供") }
        else if kind == "plugin" { label = String(localized: "原生插件") }
        else if scope == "project" { label = projectName ?? String(localized: "当前项目") }
        else { label = ExtensionText.scope(scope) }
        let ambiguous = nativeId.map { !$0.isEmpty && (identities["\(kind)|\($0)"] ?? 0) > 1 } ?? false
        let search = [name, description, sourcePath, nativeId, label, source.profileName, agent, ExtensionText.kind(kind)]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ").lowercased()
        return ExtensionEntry(
            key: extensionEntryKey(source.context, item.id),
            sourceKey: source.key,
            context: source.context,
            backendId: source.backendId,
            profileName: source.profileName,
            item: item,
            sourceLabel: label,
            ownerKey: owner.map { extensionEntryKey(source.context, $0) },
            ambiguousNativeId: ambiguous,
            search: search,
            name: name,
            kind: kind,
            scope: scope,
            enabled: item.enabled?.boolValue,
            fromPlugin: owner != nil || kind == "plugin",
            subtitle: [description, owner.flatMap { plugins[$0]?.name }].compactMap { $0 }.first { !$0.isEmpty } ?? "",
            scopeAndKind: "\(ExtensionText.scope(scope)) · \(ExtensionText.kind(kind))",
            agent: agent
        )
    }
}
