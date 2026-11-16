import SwiftUI
import RiffetKit

/// What the diagnostics export takes from a plugin: keys for the export itself and for its `settings`.
struct PluginDiagnostics {
    var root: [String: Any] = [:]
    var settings: [String: Any] = [:]
}

/// What a plugin's native renderer adds for its Agents: the content of a `settings` view it
/// declares, drawn in the Agent and 模型提供商 panes, and the few rules that differ from the host's defaults. A
/// plugin with several such views registers one renderer each; they combine for the plugin's Agents.
struct PluginAgentRenderer {
    /// Replaces the provider list: for an Agent with one implicit provider the plugin configures itself.
    var providers: (@MainActor (Workbench) -> AnyView)?
    /// Rows under the new-session defaults, next to 项目配置.
    var links: (@MainActor (Workbench) -> AnyView)?
    /// The Agent has no provider list the host edits; startup defaults use its own model catalog.
    var choosesDefaultModelHere = false
    var diagnostics: (@MainActor (Workbench) async -> PluginDiagnostics)?
    /// Whether a slash command the Agent's TUI alone can answer should open its terminal after it is sent.
    var commandNeedsTerminal: ((String) -> Bool)?

    func merged(with other: PluginAgentRenderer) -> PluginAgentRenderer {
        let links: (@MainActor (Workbench) -> AnyView)?
        switch (self.links, other.links) {
        case let (mine?, theirs?): links = { workbench in AnyView(Group { mine(workbench); theirs(workbench) }) }
        case let (mine?, nil): links = mine
        default: links = other.links
        }
        return PluginAgentRenderer(
            providers: providers ?? other.providers,
            links: links,
            choosesDefaultModelHere: choosesDefaultModelHere || other.choosesDefaultModelHere,
            diagnostics: diagnostics ?? other.diagnostics,
            commandNeedsTerminal: commandNeedsTerminal ?? other.commandNeedsTerminal
        )
    }
}

/// The native renderers of plugin Agents, by the contribution ID of the view the plugin declares
/// with the `settings` location, as `InspectorViewRegistry` does for side-panel views. A plugin's
/// page is shown only while the plugin is on, and only when this registry has a renderer for it;
/// deleting a plugin's folder and its line here leaves the rest of the app as it was.
@MainActor
enum PluginAgentRegistry {
    private static let renderers: [String: PluginAgentRenderer] = {
        var table: [String: PluginAgentRenderer] = [:]
        table.merge(CursorPlugin.renderers) { _, new in new }
        return table
    }()

    /// The same plugin-owned configuration content can be hosted outside the settings window.
    static func configuration(_ viewId: String, workbench: Workbench) -> AnyView? {
        guard let renderer = renderers[viewId] else { return nil }
        return AnyView(VStack(alignment: .leading, spacing: Space.md) {
            if let providers = renderer.providers { providers(workbench) }
            if let links = renderer.links { links(workbench) }
        })
    }

    /// The renderer of the plugin that provides [agent].
    static func renderer(for agent: String, plugins: [PluginDescriptor]) -> PluginAgentRenderer? {
        for plugin in plugins where plugin.enabled {
            guard plugin.declared?.agentBackends?.contains(where: { $0.id == agent }) == true,
                  let renderer = renderer(of: plugin) else { continue }
            return renderer
        }
        return nil
    }

    /// Every renderer whose plugin is on.
    static func active(_ plugins: [PluginDescriptor]) -> [PluginAgentRenderer] {
        plugins.filter(\.enabled).compactMap(renderer(of:))
    }

    /// The plugin's registered `settings` views for this Mac, combined.
    private static func renderer(of plugin: PluginDescriptor) -> PluginAgentRenderer? {
        let found = (plugin.declared?.views ?? [])
            .filter { $0.locations.contains("settings") && $0.clients.contains("macos") }
            .compactMap { renderers[$0.id] }
        return found.dropFirst().reduce(found.first) { $0?.merged(with: $1) }
    }
}
