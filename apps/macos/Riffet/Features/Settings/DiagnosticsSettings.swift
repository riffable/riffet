import SwiftUI
import RiffetKit

/// 诊断 (Help › 诊断… opens it): the diagnostics export and the performance monitor.
struct DiagnosticsSettings: View {
    var body: some View {
        Form {
            DiagnosticsExportSection()
            PerformanceSettingsSection()
        }
        .riffetForm()
    }
}

/// The diagnostics export: the Agents the server offers and the settings, plus whatever the plugins
/// that are on add through their renderer (`PluginAgentRenderer.diagnostics`).
struct DiagnosticsExportSection: View {
    @Environment(AppModel.self) private var model
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        SettingsBlock("诊断信息", detail: "不含 API Key。") {
            HStack(spacing: Space.sm) {
                SettingsActionButton("导出 JSON…", symbol: "square.and.arrow.up") {
                    if let workbench = model.workbench { Task { await export(workbench) } }
                }
                .disabled(busy || model.workbench == nil)
                if busy { Spinner(size: .small) }
                Spacer(minLength: 0)
            }
            if model.workbench == nil {
                SettingsHint("连接服务器后可用。", symbol: "network.slash")
            }
            SettingsErrorText(message: error)
        }
    }

    private func export(_ workbench: Workbench) async {
        busy = true
        error = nil
        let machine = try? await workbench.host.api?.machineReport()
        var payload: [String: Any] = [
            "checkedAt": ISO8601DateFormatter().string(from: Date()),
            "backends": workbench.backends.map { entry -> [String: Any] in
                ["id": entry.agent, "label": entry.label, "available": entry.available, "reason": entry.reason ?? ""]
            },
        ]
        if let machine { payload["machine"] = machineObject(machine) }
        var settings = settingsObject(workbench.settings)
        // What a plugin adds is asked of its renderer, and only while the plugin is on.
        for renderer in PluginAgentRegistry.active(PluginsStore.shared.items) {
            guard let extra = await renderer.diagnostics?(workbench) else { continue }
            payload.merge(extra.root) { _, new in new }
            settings.merge(extra.settings) { _, new in new }
        }
        payload["settings"] = settings
        do {
            _ = try saveTextFile(suggestedName: "riffet-diagnostics.json", text: jsonText(payload))
        } catch {
            self.error = error.riffetMessage
        }
        busy = false
    }

    /// tmux and the tailnet are the machine's, so they are asked of the server, not of an Agent's plugin.
    private func machineObject(_ report: MachineReport) -> [String: Any] {
        [
            "tmux": report.tmux,
            "warnings": Array(report.warnings),
            "checkedAt": report.checkedAt,
            "tailscale": [
                "present": report.tailscale.present,
                "loggedIn": report.tailscale.loggedIn?.boolValue ?? false,
                "ip": report.tailscale.ip ?? "",
                "version": report.tailscale.version ?? "",
                "message": report.tailscale.message,
            ] as [String: Any],
        ]
    }

    private func settingsObject(_ settings: AppSettings?) -> [String: Any] {
        guard let settings else { return [:] }
        var object: [String: Any] = [
            "editorCommand": settings.editorCommand ?? "",
            "defaultModel": settings.defaultModel ?? "",
            "defaultMode": settings.defaultMode ?? "",
            "notifications": settings.notifications?.boolValue ?? false,
            "allowOutsideRead": settings.allowOutsideRead?.boolValue ?? true,
            "composerEnterBehavior": settings.composerEnterBehavior ?? "",
        ]
        if let id = settings.defaultAgent { object["defaultBackendId"] = id }
        if let models = settings.auxiliaryModels {
            var auxiliary: [String: Any] = [:]
            for (purpose, ref) in [("title", models.title), ("handoff", models.handoff), ("summary", models.summary)] {
                guard let ref else { continue }
                auxiliary[purpose] = ["backendId": backendWire(ref.backendId), "profileId": ref.profileId, "model": ref.model]
            }
            object["auxiliaryModels"] = auxiliary
        }
        return object
    }
}
