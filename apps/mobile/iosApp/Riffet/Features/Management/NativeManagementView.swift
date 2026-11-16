import SwiftUI
import RiffetKit

let managementBackends: [NativeBackendId] = [.cursor, .codex, .claude, .dsh, .droid, .traex, .pi, .antigravity]

func managementSettingsPatch(defaultBackend: NativeBackendId? = nil, defaults: [NativeBackendId: NativeBackendDefaults]? = nil,
                             cursor: CursorCliSettingsUpdate? = nil, defaultModel: String? = nil,
                             composerRunningBehavior: String? = nil, idleReclaimMinutes: Int32? = nil,
                             maxLiveAgents: Int32? = nil, editorCommand: String? = nil, allowOutsideRead: Bool? = nil) -> AppSettingsUpdate {
    AppSettingsUpdate(taskWorkspaceRoot: nil, editorCommand: editorCommand, defaultModel: defaultModel, defaultMode: nil, notifications: nil,
                      allowOutsideRead: allowOutsideRead.map { KotlinBoolean(bool: $0) }, defaultBackendId: defaultBackend, nativeBackendDefaults: defaults,
                      cursorCli: cursor, composerEnterBehavior: nil, composerRunningBehavior: composerRunningBehavior, composerSendLater: nil,
                      idleReclaimMinutes: idleReclaimMinutes.map { KotlinInt(int: $0) }, maxLiveAgents: maxLiveAgents.map { KotlinInt(int: $0) },
                      quickChat: nil, defaultAgentId: nil, agentDefaults: nil)
}

/// An agent's display name: the server's label when it sent one.
@MainActor func managementBackendName(_ backend: NativeBackendId, _ workbench: Workbench) -> String {
    workbench.backends.first(where: { $0.backendId == backend })?.label ?? backend.name.capitalized
}
