import SwiftUI
import RiffetKit

/// One settings row that picks a model of an agent across its providers, with the composer's
/// model panel. Callers resolve the agent, provider and model they show; a choice comes back as the
/// agent's catalog entry, the provider and the model id.
struct AgentModelRow: View {
    let workbench: Workbench
    let title: String
    /// The agent's wire id; the row is empty without one.
    let agent: String?
    let profileId: String?
    let model: String?
    var disabled = false
    let choose: (NativeBackendCatalogEntry, String?, String) -> Void

    /// The agent's catalog per provider (profile id, "" for none), as the composer reads them.
    @State private var catalogs: [String: NativeBackendCatalogEntry] = [:]
    @State private var issues: [String: String] = [:]

    private func key(_ id: String?) -> String { id ?? "" }

    var body: some View {
        let entry = agent.flatMap { agent in workbench.backends.first { $0.agent == agent } }
        let profiles = entry?.profiles ?? []
        let active = profileId ?? profiles.first { $0.isDefault?.boolValue == true }?.id ?? profiles.first?.id
        let current = catalogs[key(active)]
        let providers = profiles.count > 1
            ? profiles.map { ProviderModels(profile: $0, models: catalogs[key($0.id)]?.models, issue: issues[key($0.id)]) }
            : []
        return SettingsRow(title, detail: entry?.label) {
            if let entry {
                ModelControls(
                    catalog: current?.models ?? [],
                    selection: model,
                    loading: current == nil,
                    providers: providers,
                    activeProviderId: active,
                    chooseInProvider: { provider, value in choose(entry, provider, value) },
                    retryProvider: { provider in Task { await load(entry, reload: true, only: provider) } },
                    scope: "\(entry.agent)|\(active ?? "")|\(workbench.catalogs.connectionRevision)",
                    refresh: { await load(entry, reload: true) }
                ) { value in
                    choose(entry, active, value)
                }
                .id("\(entry.agent)|\(active ?? "")")
                .disabled(disabled)
            }
        }
        .task(id: "\(entry?.agent ?? "")|\(profiles.map(\.id).joined(separator: ","))|\(workbench.backendRevision)") {
            if let entry { await load(entry) }
        }
    }

    private func load(_ entry: NativeBackendCatalogEntry, reload: Bool = false, only: String? = nil) async {
        let ids: [String?] = entry.profiles.isEmpty ? [nil] : entry.profiles.map(\.id)
        for id in ids where only == nil || id == only {
            do {
                if let loaded = try await workbench.catalogs.loadCatalog(entry.agent, profileId: id, projectId: nil, reload: reload) {
                    catalogs[key(id)] = loaded
                    issues[key(id)] = nil
                }
            } catch is CancellationError {
            } catch {
                issues[key(id)] = error.riffetMessage
            }
        }
    }
}
