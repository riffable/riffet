import SwiftUI
import RiffetKit

// 辅助模型 and 快速对话: the models the server uses besides an Agent's own, as on Android
// (`AuxiliaryModelsSection.kt`, `QuickChatSection`). Both are server settings, shared by every device.

/// The models behind the profiles' gateways, read once per page.
@MainActor @Observable
final class AuxiliaryModelOptions {
    private(set) var options: [AuxiliaryModelOption]?
    private(set) var error: String?
    func load(_ workbench: Workbench) async {
        guard options == nil, let api = workbench.api else { return }
        do { options = try await api.auxiliaryModels(); error = nil }
        catch is CancellationError {} catch { options = []; self.error = error.riffetMessage.isEmpty ? String(localized: "无法读取可用模型", bundle: .riffet) : error.riffetMessage }
    }
}

/// `profile · model`, as the server's catalog names a choice; the profile id stands in for a missing name.
@MainActor func auxiliaryModelName(_ ref: AuxiliaryModelRef?, options: [AuxiliaryModelOption]?, off: String) -> String {
    guard let ref else { return off }
    let profile = options?.first { $0.backendId == ref.backendId && $0.profileId == ref.profileId && $0.model == ref.model }?.profileName
    let name = (profile?.isEmpty == false ? profile : nil) ?? ref.profileId
    return name.isEmpty ? ref.model : "\(name) · \(ref.model)"
}

/// Writes one purpose (`title`, `handoff`, `chat`) or clears it, and folds the answer into the store.
@MainActor func saveAuxiliaryModel(_ workbench: Workbench, purpose: String, ref: AuxiliaryModelRef?) async throws {
    guard let api = workbench.api else { return }
    let saved = try await api.setAuxiliaryModel(purpose: purpose, ref: ref)
    workbench.store.applySavedSettings(settings: saved)
}

struct AuxiliaryModelsView: View {
    let workbench: Workbench
    @State private var catalog = AuxiliaryModelOptions()
    var body: some View {
        let models = workbench.settings?.auxiliaryModels
        RiffetForm {
            Section {
                AuxiliaryModelRow(workbench: workbench, catalog: catalog, purpose: "title", title: String(localized: "会话标题", bundle: .riffet),
                                  off: String(localized: "只用 CLI 标题", bundle: .riffet), current: models?.title)
                AuxiliaryModelRow(workbench: workbench, catalog: catalog, purpose: "handoff", title: String(localized: "交接摘要", bundle: .riffet),
                                  off: String(localized: "不使用", bundle: .riffet), current: models?.handoff)
            }
            if let error = catalog.error { RiffetNotice.section(.error, error) }
        }
        .navigationTitle(String(localized: "辅助模型", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task { await catalog.load(workbench) }
    }
}

struct QuickChatSettingsView: View {
    let workbench: Workbench
    @State private var catalog = AuxiliaryModelOptions()
    @State private var saving = false
    @State private var error: String?
    private static let retention: [Int32] = [1, 3, 7, 14, 30, 0]
    var body: some View {
        let days = workbench.settings?.quickChat?.retentionDays?.int32Value ?? 7
        RiffetForm {
            Section {
                AuxiliaryModelRow(workbench: workbench, catalog: catalog, purpose: "chat", title: String(localized: "默认模型", bundle: .riffet),
                                  off: String(localized: "不设置", bundle: .riffet), current: workbench.settings?.auxiliaryModels?.chat)
                RiffetPickerRow(title: String(localized: "自动归档", bundle: .riffet), options: (Self.retention.contains(days) ? Self.retention : Self.retention + [days]).map {
                    .init(id: $0, title: $0 == 0 ? String(localized: "永不", bundle: .riffet) : String(localized: "\(Int($0)) 天", bundle: .riffet))
                }, selection: Binding(get: { days }, set: { next in Task { await saveRetention(next, current: days) } }))
                .disabled(saving)
            } footer: { Text("置顶或有收藏的对话不会归档") }
            if let message = error ?? catalog.error { RiffetNotice.section(.error, message) }
        }
        .navigationTitle(String(localized: "快速对话", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task { await catalog.load(workbench) }
    }
    private func saveRetention(_ value: Int32, current: Int32) async {
        guard value != current, !saving, let api = workbench.api else { return }
        saving = true
        defer { saving = false }
        do {
            let saved = try await api.updateQuickChat(retentionDays: KotlinInt(int: value), openMode: nil, presets: nil, resetPresets: false)
            workbench.store.applySavedSettings(settings: saved)
            error = nil
        } catch is CancellationError {} catch { self.error = error.riffetMessage }
    }
}

/// A purpose and its model; opens the list of models grouped by provider.
private struct AuxiliaryModelRow: View {
    let workbench: Workbench
    let catalog: AuxiliaryModelOptions
    let purpose: String
    let title: String
    let off: String
    let current: AuxiliaryModelRef?
    var body: some View {
        NavigationLink {
            AuxiliaryModelChoice(workbench: workbench, catalog: catalog, purpose: purpose, title: title, off: off, current: current)
        } label: {
            SettingsRowLabel(title: title, value: auxiliaryModelName(current, options: catalog.options, off: off))
        }
        .disabled(catalog.options == nil)
    }
}

private struct AuxiliaryModelChoice: View {
    let workbench: Workbench
    let catalog: AuxiliaryModelOptions
    let purpose: String
    let title: String
    let off: String
    let current: AuxiliaryModelRef?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var saving = false
    @State private var error: String?

    /// Models under their provider, in the catalog's order.
    private var groups: [(name: String, options: [AuxiliaryModelOption])] {
        var order: [String] = []
        var byName: [String: [AuxiliaryModelOption]] = [:]
        for option in catalog.options ?? [] {
            let name = option.profileName.isEmpty ? managementBackendName(option.backendId, workbench) : option.profileName
            if byName[name] == nil { order.append(name) }
            byName[name, default: []].append(option)
        }
        return order.map { ($0, byName[$0] ?? []) }
    }

    var body: some View {
        RiffetList {
            Section { SettingsCheckRow(title: off, selected: current == nil) { pick(nil) } }
            ForEach(groups, id: \.name) { group in
                Section {
                    ForEach(group.options, id: \.self) { option in
                        SettingsCheckRow(title: option.model, selected: current.map { $0.backendId == option.backendId && $0.profileId == option.profileId && $0.model == option.model } == true) {
                            pick(AuxiliaryModelRef(backendId: option.backendId, profileId: option.profileId, model: option.model))
                        }
                    }
                } header: {
                    RiffetSectionTitle(group.name)
                }
            }
            if let error { RiffetNotice.section(.error, error) }
        }
        .disabled(saving)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { if saving { ProgressView() } } }
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
    }

    private func pick(_ ref: AuxiliaryModelRef?) {
        guard !saving else { return }
        if ref == current { dismiss(); return }
        saving = true
        Task {
            defer { saving = false }
            do { try await saveAuxiliaryModel(workbench, purpose: purpose, ref: ref); dismiss() }
            catch is CancellationError {} catch { self.error = error.riffetMessage }
        }
    }
}
