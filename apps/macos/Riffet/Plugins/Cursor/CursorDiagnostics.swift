import Foundation
import RiffetKit

/// What Cursor adds to the diagnostics export: its CLI report, the models it lists and its saved
/// connection (without the key). Left out quietly while the plugin is off.
@MainActor
func cursorDiagnostics(_ workbench: Workbench) async -> PluginDiagnostics {
    guard let api = workbench.host.api else { return PluginDiagnostics() }
    let report = try? await api.capabilities()
    let models = (try? await api.cursorModels()) ?? []
    var result = PluginDiagnostics()
    result.root = [
        "capabilities": capabilityObject(report),
        "models": models.map { ["value": $0.value, "name": $0.name] },
    ]
    if let cli = workbench.settings?.cursorCli {
        result.settings["cursorCli"] = [
            "executable": cli.executable ?? "",
            "configDir": cli.configDir ?? "",
            "apiEndpoint": cli.apiEndpoint ?? "",
            "agentEndpoint": cli.agentEndpoint ?? "",
            "disableAutoUpdate": cli.disableAutoUpdate?.boolValue ?? false,
            "hasApiKey": cli.hasApiKey?.boolValue ?? false,
        ]
    }
    return result
}

private func capabilityObject(_ report: CapabilityReport?) -> [String: Any] {
    guard let report else { return [:] }
    return [
        "cliPath": report.cliPath,
        "cliVersion": report.cliVersion ?? "",
        "authenticated": report.authenticated,
        "authMessage": report.authMessage ?? "",
        "nativePersistence": report.nativePersistence,
        "models": Array(report.models),
        "warnings": Array(report.warnings),
        "checkedAt": report.checkedAt,
    ]
}
