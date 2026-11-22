import SwiftUI
import RiffetKit

/// Native rendering of the same list, detail and form declarations the Web workbench consumes.
struct DeclarativePluginView: View {
    let workbench: Workbench
    let project: Project
    let declaration: ViewDeclaration
    @State private var values: [String: String] = [:]

    private var renderer: ViewRenderer? { declaration.renderer }
    private func label(_ value: [String: String]?) -> String { localizedText(value, fallback: "") }
    private func value(_ field: DeclaredViewField) -> Binding<String> {
        Binding(get: { values[field.key] ?? field.initialValue() }, set: { values[field.key] = $0 })
    }
    private func execute(_ id: String, args: [String: String]) {
        let pluginId = declaration.id.components(separatedBy: "/")[0]
        guard id.hasPrefix(pluginId + "/"),
              let plugin = workbench.plugins.first(where: { $0.id == pluginId && $0.enabled }),
              let command = plugin.declared?.commands?.first(where: { $0.id == id }) else { return }
        workbench.pluginCommands.execute(
            PluginCommand(pluginTitle: plugin.displayTitle, declaration: command),
            PluginCommandRunner.Context(projectId: project.id, sessionId: workbench.showingHome ? nil : workbench.selected?.id),
            values: args, in: workbench
        )
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                if let renderer {
                    switch renderer.kind {
                    case "list":
                        ForEach(renderer.items, id: \.id) { item in
                            VStack(alignment: .leading, spacing: Space.xs) {
                                if let command = item.command { Button(label(item.title)) { execute(command, args: item.argumentValues()) }.buttonStyle(.borderless) }
                                else { Text(label(item.title)).font(.callout) }
                                if let description = item.description_ { Text(label(description)).font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    case "detail":
                        ForEach(Array(renderer.fields.enumerated()), id: \.offset) { _, field in
                            LabeledContent(label(field.label)) { Text(label(field.value)).textSelection(.enabled) }
                        }
                        ForEach(renderer.actions, id: \.id) { action in
                            if let command = action.command { Button(label(action.title)) { execute(command, args: action.argumentValues()) } }
                        }
                    case "form":
                        ForEach(renderer.fields, id: \.key) { field in
                            if field.kind == "boolean" {
                                Toggle(label(field.label), isOn: Binding(get: { value(field).wrappedValue == "true" }, set: { value(field).wrappedValue = $0 ? "true" : "false" }))
                            } else if field.kind == "choice" {
                                Picker(label(field.label), selection: value(field)) { ForEach(field.options, id: \.self) { Text($0).tag($0) } }
                            } else { TextField(label(field.label), text: value(field)).textFieldStyle(.roundedBorder) }
                        }
                        Button(renderer.submit.map { label($0) } ?? String(localized: "运行")) {
                            execute(renderer.command, args: Dictionary(uniqueKeysWithValues: renderer.fields.map { ($0.key, values[$0.key] ?? $0.initialValue()) }))
                        }.disabled(renderer.fields.contains { $0.required && (values[$0.key] ?? $0.initialValue()).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
                    default:
                        Text("当前客户端版本不兼容").foregroundStyle(.secondary)
                    }
                }
            }.padding(Space.md).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A first view use activates server code without coupling the renderer to the plugin lifecycle.
struct PluginViewActivation: View {
    let workbench: Workbench
    let pluginId: String
    let viewId: String
    let content: AnyView
    @Environment(\.inspectorPanelVisible) private var visible
    @State private var ready = false
    @State private var failure: String?
    private var lifecycle: String {
        let plugin = workbench.plugins.first { $0.id == pluginId }
        return (workbench.host.api?.baseUrl ?? "") + String(visible) + (plugin?.activation?.state ?? "") + String(plugin?.active?.boolValue ?? true)
    }
    var body: some View {
        Group {
            if let failure { Text(failure).font(.callout).foregroundStyle(.secondary) }
            else if ready { content }
            else { Spinner(size: .small) }
        }.task(id: lifecycle) {
            guard visible else { return }
            failure = nil
            guard let plugin = workbench.plugins.first(where: { $0.id == pluginId }), plugin.enabled else { return }
            if plugin.active?.boolValue != false || plugin.activation?.events.contains("view") != true { ready = true; return }
            ready = false
            do {
                guard let api = workbench.host.api else { return }
                let activated = try await api.activatePluginView(id: pluginId, viewId: viewId)
                guard !Task.isCancelled else { return }
                PluginsStore.shared.update(workbench.plugins.map { $0.id == pluginId ? activated : $0 })
                ready = true
            } catch { if !Task.isCancelled { failure = error.riffetMessage } }
        }
    }
}
