import SwiftUI
import RiffetKit

/// A side-panel view's identity, the ID the panel state persists and the web shares: `changes` and
/// `files` are the host's, a plugin's is `<pluginId>/<name>`. Any string decodes, so the ID of a
/// view that is not offered now (the plugin is off, this Mac has no renderer for it) stays in storage.
struct InspectorTab: Hashable, Codable, Identifiable, RawRepresentable {
    let rawValue: String
    var id: String { rawValue }

    init(rawValue: String) { self.rawValue = rawValue }

    init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    static let changes = InspectorTab(rawValue: "changes")
    static let files = InspectorTab(rawValue: "files")
}

struct InspectorViewEntry: Identifiable {
    let tab: InspectorTab
    let title: String
    let symbol: String
    let makeView: @MainActor (Workbench, Project) -> AnyView
    /// The task provider a `tasks` view shows, so a command that started a task finds the view to open.
    var taskProvider: String?
    var id: String { tab.id }
}

/// What a view's `when` condition is judged against, as on the web (`plugins/catalog.ts`). A key
/// this client cannot judge fails the condition, so a view is never offered on a guess.
struct InspectorFacts {
    var hasProject = false
    var hasSession = false
    /// The types, such as `android`, of the task providers that recognise the project.
    var projectTypes: Set<String> = []
    var capabilities: Set<String> = []
    /// Every condition holds: settings list the views this Mac can draw whatever the project is.
    var everything = false

    func matches(_ condition: PluginCondition?) -> Bool {
        guard let condition, !everything else { return true }
        if condition.hasProject?.boolValue == true, !hasProject { return false }
        if condition.hasSession?.boolValue == true, !hasSession { return false }
        if let type = condition.projectType, !projectTypes.contains(type) { return false }
        if let capability = condition.capability, !capabilities.contains(capability) { return false }
        return true
    }
}

/// The native renderers of side-panel views. `InspectorView` lays out whatever `available` returns,
/// so a new renderer is one entry here and no change to the layout.
@MainActor
enum InspectorViewRegistry {
    typealias Make = @MainActor (Workbench, Project) -> AnyView
    typealias MakeDeclared = @MainActor (Workbench, Project, ViewDeclaration) -> AnyView

    /// Renderers of views a plugin declares with `renderer: { kind }`, drawn from the declaration
    /// alone, by `kind`. A kind with no renderer here is not shown.
    static let capabilities: Set<String> = Set(["tasks", "list", "form", "detail"].map { "renderer." + $0 } + PluginBridgeMethod.allCases.map { "bridge." + $0.rawValue })

    private static let declarativeRenderers: [String: MakeDeclared] = [
        "list": { AnyView(DeclarativePluginView(workbench: $0, project: $1, declaration: $2)) },
        "form": { AnyView(DeclarativePluginView(workbench: $0, project: $1, declaration: $2)) },
        "detail": { AnyView(DeclarativePluginView(workbench: $0, project: $1, declaration: $2)) },
        "tasks": { workbench, project, view in AnyView(TasksPanel(workbench: workbench, project: project, provider: view.renderer?.provider ?? "")) },
    ]

    /// Renderers of a plugin's own native views by view ID. The Mac offers a declared plugin view
    /// only when one is registered here: a view with no native renderer is not shown.
    private static let pluginRenderers: [String: Make] = [
        "riffet.browser/panel": { AnyView(BrowserPanel(workbench: $0, project: $1)) },
    ]

    /// The native renderer of a view that declares the Mac as a client, if there is one.
    private static func nativeRenderer(for view: ViewDeclaration) -> Make? {
        guard view.clients.contains("macos") else { return nil }
        if let renderer = view.renderer {
            guard let declared = declarativeRenderers[renderer.kind] else { return nil }
            return { declared($0, $1, view) }
        }
        return pluginRenderers[view.id]
    }

    /// A web view for a view of a development or installed package that declares the web as a client,
    /// has no renderer of the host's and no native one here. A built-in plugin's web view, such as the
    /// canvas, is not offered, and neither is one the server found incompatible.
    private static func webRenderer(for view: ViewDeclaration, of plugin: PluginDescriptor) -> Make? {
        guard plugin.source == "development" || plugin.source == "installed",
              let entry = plugin.webEntry,
              plugin.compatibility?.web.map({ $0.range.isEmpty || PluginEntry.admits($0.range) }) ?? true,
              view.clients.contains("web"), view.renderer == nil, pluginRenderers[view.id] == nil else { return nil }
        let package = PluginWebPackage(
            id: plugin.id, title: plugin.displayTitle, entryPath: entry.path, integrity: entry.integrity, version: plugin.version,
            capabilities: Set(plugin.capabilities ?? []), commands: Set((plugin.declared?.commands ?? []).map(\.id)),
            externalLinks: view.requires.contains("bridge.navigation.openExternal")
        )
        let instances = view.instances
        return { workbench, project in AnyView(PluginWebView(package: package, viewId: view.id, instances: instances, workbench: workbench, project: project)) }
    }

    /// The host's views, then the plugin views whose plugin is on, which declare a sidebar view
    /// for this client, hold for [facts] and have a renderer here: a native one, or the web view of a
    /// package that runs its own page.
    static func available(_ plugins: [PluginDescriptor], facts: InspectorFacts = InspectorFacts()) -> [InspectorViewEntry] {
        var entries = [
            InspectorViewEntry(tab: .changes, title: String(localized: "变更"), symbol: "plusminus") { AnyView(ChangesPanel(workbench: $0, project: $1)) },
            InspectorViewEntry(tab: .files, title: String(localized: "文件"), symbol: "folder") { AnyView(FilesPanel(workbench: $0, project: $1)) },
        ]
        for plugin in plugins where plugin.enabled {
            for view in plugin.declared?.views ?? [] {
                guard view.locations.contains("sidebar"), facts.matches(view.whenCondition),
                      !entries.contains(where: { $0.id == view.id }) else { continue }
                let compatible = view.requires.allSatisfy({ capabilities.contains($0) }) && (plugin.compatibility?.web.map({ $0.range.isEmpty || PluginEntry.admits($0.range) }) ?? true)
                let make: Make
                if !compatible { make = { _, _ in AnyView(Text("当前客户端版本不兼容").foregroundStyle(.secondary)) } }
                else if let renderer = nativeRenderer(for: view) ?? webRenderer(for: view, of: plugin) { make = renderer }
                else { continue }
                entries.append(InspectorViewEntry(
                    tab: InspectorTab(rawValue: view.id), title: localizedText(view.title, fallback: view.id),
                    symbol: view.icon?.sfSymbol ?? "puzzlepiece.extension", makeView: { workbench, project in
                        compatible ? AnyView(PluginViewActivation(workbench: workbench, pluginId: plugin.id, viewId: view.id, content: make(workbench, project))) : make(workbench, project)
                    },
                    taskProvider: view.renderer?.kind == "tasks" ? view.renderer?.provider : nil
                ))
            }
        }
        return entries
    }
}
