import SwiftUI
import RiffetKit

/// Agent identity on the Mac is the raw wire id: a built-in id, or a plugin's namespaced one such as
/// `acme.gemini`. `NativeBackendId` is the Kotlin enum of the built-ins only and cannot hold a
/// plugin's id, so anything that may meet one carries a `String` (`Session.agent`,
/// `NativeBackendCatalogEntry.agent`, `AppSettings.defaultAgent`) and asks here how to show it.
///
/// A name comes from the backend catalog while the Agent is enabled and from its plugin's
/// declaration otherwise; an id nothing describes is shown as itself with a neutral glyph.
@MainActor
@Observable
final class AgentDirectory {
    static let shared = AgentDirectory()

    /// The built-in quick chat: no CLI, a gateway model.
    nonisolated static let quickChat = "chat"

    /// The `/api/backends` labels of the Agents that are on.
    private(set) var catalogLabels: [String: String] = [:]

    private init() {}

    func update(backends: [NativeBackendCatalogEntry]) {
        let labels = Dictionary(backends.map { ($0.agent, $0.label) }, uniquingKeysWith: { first, _ in first })
        if labels != catalogLabels { catalogLabels = labels }
    }

    /// The Agents the server offers, by name.
    var pickable: [(id: String, label: String)] {
        catalogLabels.filter { $0.key != Self.quickChat }.map { (id: $0.key, label: $0.value) }
            .sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }

    /// The Agent's long name, such as `Claude Code`.
    func label(_ id: String) -> String {
        if id == Self.quickChat { return String(localized: "快速对话") }
        return builtinAgentNames[id]?.label ?? catalogLabels[id] ?? declared(id).map { localizedText($0.title, fallback: id) } ?? fallbackAgentName(id)
    }

    /// The Agent's short name, such as `Claude`.
    func title(_ id: String) -> String {
        builtinAgentNames[id]?.title ?? label(id)
    }

    /// The SF Symbol for an Agent with no mark of its own: the plugin's declared one, else a neutral glyph.
    func symbol(_ id: String) -> String {
        declared(id)?.icon?.sfSymbol ?? "sparkles"
    }

    private func declared(_ id: String) -> AgentBackendDeclaration? {
        for plugin in PluginsStore.shared.items {
            if let match = plugin.declared?.agentBackends?.first(where: { $0.id == id }) { return match }
        }
        return nil
    }

}

/// Built-in Agents whose long and short names differ from the catalog's label.
private let builtinAgentNames: [String: (title: String, label: String)] = [
    "codex": ("Codex", "Codex"),
    "claude": ("Claude", "Claude Code"),
    "dsh": ("DeepSeek", "DeepSeek Harness"),
    "droid": ("Droid", "Droid"),
    "traex": ("Trae", "TRAE CLI"),
    "pi": ("pi", "pi"),
    "antigravity": ("Antigravity", "Antigravity"),
]

/// The name of a built-in Agent, which needs no catalog: usable off the main actor.
func builtinAgentTitle(_ wire: String) -> String { builtinAgentNames[wire]?.title ?? fallbackAgentName(wire) }
func builtinAgentLabel(_ wire: String) -> String { builtinAgentNames[wire]?.label ?? fallbackAgentName(wire) }

/// An id nothing describes is shown as its last segment, capitalised.
func fallbackAgentName(_ id: String) -> String {
    if id == AgentDirectory.quickChat { return String(localized: "快速对话") }
    return id.split(separator: ".").last.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? id
}

extension Session {
    /// The wire id of the Agent this conversation runs on; empty for a row that names none.
    var agentID: String { agent ?? "" }
}

extension NativeBackendCatalogEntry {
    /// Quick chat is not an Agent the user picks.
    var isPickable: Bool { agent != AgentDirectory.quickChat }
}

func backendWire(_ id: NativeBackendId) -> String { AgentIds.shared.wire(id: id) }

/// The agents the assistant runs on, first the one it starts on (`ASSISTANT_BACKENDS` in `packages/contracts`).
let assistantAgents: [String] = AssistantKt.ASSISTANT_BACKENDS.map(backendWire)

extension Array where Element == NativeBackendCatalogEntry {
    /// The assistant's agent: the saved one while it is offered and one the assistant runs on, else the first of [assistantAgents] that can run.
    func assistantEntry(saved: String?) -> NativeBackendCatalogEntry? {
        saved.flatMap { id in assistantAgents.contains(id) ? first { $0.agent == id } : nil }
            ?? assistantAgents.lazy.compactMap { id in first { $0.agent == id && $0.available } }.first
    }
}

/// The wire id as a built-in, or nil for a plugin's.
func builtinBackend(_ agent: String) -> NativeBackendId? { AgentIds.shared.builtin(raw: agent) }

@MainActor func backendTitle(_ id: String) -> String { AgentDirectory.shared.title(id) }
func backendTitle(_ id: NativeBackendId) -> String { builtinAgentTitle(backendWire(id)) }
@MainActor func backendLabel(_ id: String) -> String { AgentDirectory.shared.label(id) }
func backendLabel(_ id: NativeBackendId) -> String { builtinAgentLabel(backendWire(id)) }

/// The palette's agent colour for a built-in Agent's mark; the others keep the brand colour their
/// mark ships with, and an unknown Agent takes the caller's neutral one.
func agentMarkColor(_ id: String, _ palette: Palette) -> Color? {
    switch id {
    case "cursor": palette.agentCursor
    case "codex": palette.agentCodex
    case "claude": palette.agentClaude
    case "dsh": palette.agentDsh
    default: nil
    }
}

func agentMarkColor(_ id: NativeBackendId, _ palette: Palette) -> Color? { agentMarkColor(backendWire(id), palette) }

/// An Agent's mark: the built-in one when there is one, else the plugin's declared SF Symbol or a
/// neutral glyph.
struct AgentIcon: View {
    let id: String
    var size: CGFloat = 14
    var color: Color? = nil

    var body: some View {
        if AgentMarkGlyphs.paths(for: id).isEmpty {
            Image(icon: AgentDirectory.shared.symbol(id))
                .font(.riffet(size: size * 0.85, weight: .medium))
                .foregroundStyle(color ?? Color.primary)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            AgentMarkView(backend: id, size: size, color: color)
        }
    }
}
