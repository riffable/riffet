import AppKit
import SwiftUI
import UniformTypeIdentifiers
import RiffetKit

struct SettingsFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// Builds a settings patch. Null fields stay absent (`explicitNulls` is false), which is what
/// `PATCH /api/settings` treats as "leave this alone". The Agent keys are raw ids: a plugin's Agent
/// cannot be a `NativeBackendId`, so the client folds them back into the keys the server reads.
enum SettingsPatch {
    static func make(
        taskWorkspaceRoot: String? = nil,
        editorCommand: String? = nil,
        defaultMode: String? = nil,
        notifications: Bool? = nil,
        allowOutsideRead: Bool? = nil,
        defaultAgentId: String? = nil,
        agentDefaults: [String: NativeBackendDefaults]? = nil,
        composerEnterBehavior: String? = nil,
        composerRunningBehavior: String? = nil,
        composerSendLater: Bool? = nil,
        idleReclaimMinutes: Int? = nil,
        maxAgentMemoryMb: Int? = nil,
        quickChat: QuickChatSettings? = nil,
        sidebarPinned: [String]? = nil
    ) -> AppSettingsUpdate {
        AppSettingsUpdate(
            taskWorkspaceRoot: taskWorkspaceRoot,
            editorCommand: editorCommand,
            defaultModel: nil,
            defaultMode: defaultMode,
            notifications: notifications.map { KotlinBoolean(bool: $0) },
            allowOutsideRead: allowOutsideRead.map { KotlinBoolean(bool: $0) },
            defaultBackendId: nil,
            nativeBackendDefaults: nil,
            cursorCli: nil,
            composerEnterBehavior: composerEnterBehavior,
            composerRunningBehavior: composerRunningBehavior,
            composerSendLater: composerSendLater.map { KotlinBoolean(bool: $0) },
            idleReclaimMinutes: idleReclaimMinutes.map { KotlinInt(int: Int32($0)) },
            maxAgentMemoryMb: maxAgentMemoryMb.map { KotlinInt(int: Int32($0)) },
            quickChat: quickChat,
            defaultAgentId: defaultAgentId,
            agentDefaults: agentDefaults,
            sidebarPinned: sidebarPinned
        )
    }
}

@MainActor
enum SettingsStore {
    static func save(_ workbench: Workbench, _ body: AppSettingsUpdate) async throws {
        guard let api = workbench.host.api else { throw SettingsFailure(String(localized: "尚未连接服务器")) }
        let saved = try await api.updateSettings(body: body)
        workbench.store.applySavedSettings(settings: saved)
    }
}

/// Copies every Agent's defaults, built-in or a plugin's, so a patch does not wipe the ones it did not mention.
func agentDefaults(from settings: AppSettings?) -> [String: NativeBackendDefaults] {
    var map: [String: NativeBackendDefaults] = [:]
    for (key, value) in settings?.nativeBackendDefaults ?? [:] { map[backendWire(key)] = value }
    for (key, value) in settings?.agentDefaults ?? [:] { map[key] = value }
    return map
}

func endpointHint(_ id: NativeBackendId) -> (placeholder: String, hint: String)? {
    switch id {
    case .claude: ("https://gateway.example.com", String(localized: "需兼容 Anthropic Messages API，地址不要带 /v1"))
    case .codex: ("https://gateway.example.com/v1", String(localized: "需兼容 OpenAI Responses API，地址要带 /v1"))
    case .dsh: ("https://api.deepseek.com", String(localized: "需兼容 DeepSeek 接口"))
    default: nil
    }
}

func profileAllowsEndpoint(_ id: NativeBackendId) -> Bool { id != .droid && id != .traex }
func profileAllowsConfigDir(_ id: NativeBackendId) -> Bool { id != .droid && id != .antigravity }
func profileAllowsSourceDir(_ id: NativeBackendId) -> Bool { id == .dsh }
func profileAllowsAutoUpdate(_ id: NativeBackendId) -> Bool { id == .claude }

/// The wire APIs pi can speak, in the order the editor offers them.
let nativeModelApiProtocols: [(id: String, label: String)] = [
    ("openai-completions", "OpenAI Chat Completions"),
    ("openai-responses", "OpenAI Responses"),
    ("anthropic-messages", "Anthropic Messages"),
    ("google-generative-ai", "Google Gemini"),
]
let defaultNativeModelApiProtocol = "openai-completions"

/// A model source an enabled plugin offers, with that plugin, which owns its actions.
struct OfferedModelSource {
    let plugin: PluginDescriptor
    let source: ModelSourceDescriptor
}

/// The model sources the enabled plugins offer a backend, in precedence order. A source is offered when it
/// serves a gateway protocol the backend consumes; a server that predates `protocols` is matched by `backends`.
func offeredModelSources(_ plugins: [PluginDescriptor], for id: NativeBackendId, consuming protocols: [String]? = nil) -> [OfferedModelSource] {
    let wire = backendWire(id)
    return plugins.filter(\.enabled).flatMap { plugin in
        plugin.contributes.modelSources
            .filter { source in
                if let protocols, let served = source.protocols { return served.contains(where: protocols.contains) }
                return source.backends.contains(wire)
            }
            .map { OfferedModelSource(plugin: plugin, source: $0) }
    }
}

/// The CLI's own login, the plugins' sources, then a custom API.
func modelSources(for id: NativeBackendId, plugins: [PluginDescriptor], consuming protocols: [String]? = nil) -> [String] {
    ["login"] + offeredModelSources(plugins, for: id, consuming: protocols).map(\.source.id) + ["custom"]
}

/// A source no enabled plugin offers keeps its raw id.
func modelSourceTitle(_ source: String, plugins: [PluginDescriptor]) -> String {
    switch source {
    case "login": String(localized: "CLI 自带登录")
    case "custom": String(localized: "自定义 API")
    default:
        plugins.lazy.filter(\.enabled)
            .compactMap { $0.contributes.modelSources.first { $0.id == source } }
            .first?.label ?? source
    }
}

/// The text for the interface language from a BCP-47 keyed map: the exact tag, then the tag with
/// subtags dropped (`zh-Hans-CN` → `zh-Hans` → `zh`), then `zh-Hans`, `en`, any entry, [fallback].
func localizedText(_ text: [String: String]?, fallback: String, locale: Locale = AppLocale.current) -> String {
    guard let text, !text.isEmpty else { return fallback }
    var tag = locale.identifier(.bcp47)
    while true {
        if let hit = text[tag] { return hit }
        guard let dash = tag.lastIndex(of: "-") else { break }
        tag = String(tag[..<dash])
    }
    return text["zh-Hans"] ?? text["en"] ?? text.min { $0.key < $1.key }?.value ?? fallback
}

extension PluginDescriptor {
    var displayTitle: String { localizedText(title, fallback: name) }
}

/// The one-line summary under a provider's name in the list: where it signs in, and the model
/// count only when it offers a subset.
func providerSummary(_ profile: NativeBackendProfileSettings, plugins: [PluginDescriptor]) -> String {
    let source = profile.modelSource.flatMap { id in
        plugins.lazy.compactMap { $0.contributes.modelSources.first { $0.id == id } }.first
    }
    let endpoint = profile.apiEndpoint.flatMap { $0.isEmpty ? nil : displayEndpoint($0) }
    let place: String
    if source?.role == "adapter" {
        place = [source?.label, endpoint].compactMap { $0 }.joined(separator: " · ")
    } else {
        place = profile.modelSource.map { modelSourceTitle($0, plugins: plugins) }
            ?? endpoint ?? String(localized: "CLI 登录")
    }
    guard let models = profile.enabledModels else { return place }
    return "\(place) · \(String(localized: "\(models.count) 个模型"))"
}

/// An endpoint without its scheme or trailing slash: `https://relay.example.com/` → `relay.example.com`.
func displayEndpoint(_ endpoint: String) -> String {
    var text = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
    if let range = text.range(of: "://") { text = String(text[range.upperBound...]) }
    while text.hasSuffix("/") { text.removeLast() }
    return text
}

extension ConfigFile {
    /// Content fingerprint. The generated property is `hash`, which collides with `NSObject.hash`.
    var fingerprint: String {
        let selector = NSSelectorFromString("hash_")
        guard responds(to: selector), let value = perform(selector) else { return "" }
        return value.takeUnretainedValue() as? String ?? ""
    }
}

func isConfigConflict(_ error: Error) -> Bool {
    let ns = error as NSError
    if let http = ns.userInfo["KotlinException"] as? RiffetHttpException, http.status == 409 { return true }
    let message = error.riffetMessage
    return message.contains("409")
        || message.localizedCaseInsensitiveContains("CONFIG_CONFLICT")
        || message.localizedCaseInsensitiveContains("reload before editing")
}

struct SettingsErrorText: View {
    let message: String?
    var details: String?

    var body: some View {
        if let message, !message.isEmpty {
            VStack(alignment: .leading, spacing: Space.sm) {
                SettingsCallout(.danger, message: message)
                if let details, !details.isEmpty {
                    DisclosureGroup("错误详情") {
                        Text(details)
                            .font(.riffet(size: S(11.5)))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.riffet(size: S(11.5)))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

extension Notification.Name {
    /// Posted by `SettingsPaneController` after a section becomes the visible pane. Cached panes
    /// stay alive (and so do their tasks), so this is the moment to re-read server state.
    static let settingsSectionDidShow = Notification.Name("riffet.settings-section-did-show")
}

@MainActor
func saveTextFile(suggestedName: String, text: String) throws -> Bool {
    let panel = NSSavePanel()
    panel.canCreateDirectories = true
    panel.isExtensionHidden = false
    panel.nameFieldStringValue = suggestedName
    panel.allowedContentTypes = [.json]
    guard panel.runModal() == .OK, let url = panel.url else { return false }
    try text.write(to: url, atomically: true, encoding: .utf8)
    return true
}

func jsonText(_ object: Any) -> String {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { return "{}" }
    return text
}
