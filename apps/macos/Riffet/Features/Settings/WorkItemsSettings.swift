import SwiftUI
import RiffetKit

/// 任务看板: whether a new conversation becomes a task, and the agent and model tasks start with.
/// Saved at once, on the server, for every device.
struct WorkItemsSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var save = SettingsSaveState()

    var body: some View {
        if let workbench = model.workbench {
            form(workbench)
        } else {
            DisconnectedSettings()
        }
    }

    private func form(_ workbench: Workbench) -> some View {
        let agents = workbench.backends.filter(\.isPickable)
        let saved = workbench.settings?.workItems
        let savedProfile = saved?.profileId.flatMap { $0.isEmpty ? nil : $0 }
        let savedModel = saved?.model.flatMap { $0.isEmpty ? nil : $0 }
        let entry = saved?.backendId.flatMap { id in agents.first { $0.agent == backendWire(id) } }
        let profile = savedProfile.flatMap { id in entry?.profiles.contains { $0.id == id } == true ? id : nil }
        return Form {
            Section {
                SettingsRow(String(localized: "新会话作为任务")) {
                    Toggle("新会话作为任务", isOn: Binding(
                        get: { saved?.composerSessions?.boolValue == true },
                        set: { on in persist(workbench) { try await $0.setWorkItemComposerSessions(on: on) } }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .disabled(save.busy)
                }

                SettingsRow(String(localized: "默认 Agent")) {
                    Picker("默认 Agent", selection: Binding(
                        get: { entry?.agent ?? "" },
                        set: { id in
                            guard id != (entry?.agent ?? "") else { return }
                            let backendId = agents.first { $0.agent == id }?.backendId
                            persist(workbench) { try await $0.setWorkItemAgent(backendId: backendId, profileId: nil, model: nil) }
                        }
                    )) {
                        Text("跟随新会话").tag("")
                        ForEach(agents, id: \.agent) { agent in
                            Text(agent.label).tag(agent.agent).disabled(!agent.available)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .formPicker()
                    .fixedSize()
                    .disabled(save.busy)
                }

                if let entry {
                    AgentModelRow(
                        workbench: workbench,
                        title: String(localized: "默认模型"),
                        agent: entry.agent,
                        profileId: profile,
                        model: profile == savedProfile || savedProfile == nil ? savedModel : nil,
                        disabled: save.busy
                    ) { entry, provider, value in
                        persist(workbench) { try await $0.setWorkItemAgent(backendId: entry.backendId, profileId: provider, model: value) }
                    }
                }

                SettingsFeedback(state: save)
            }

            SettingsScopeFooter()
        }
        .riffetForm()
        .task { await refresh(workbench) }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == SettingsSection.workItems.rawValue else { return }
            Task { await refresh(workbench) }
        }
    }

    private func refresh(_ workbench: Workbench) async {
        guard let api = workbench.host.api, let settings = try? await api.settings() else { return }
        workbench.store.applySavedSettings(settings: settings)
    }

    private func persist(_ workbench: Workbench, _ change: @escaping (RiffetApi) async throws -> AppSettings) {
        guard let api = workbench.host.api else { return }
        Task {
            await save.run {
                workbench.store.applySavedSettings(settings: try await change(api))
            }
        }
    }
}
