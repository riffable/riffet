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

/// Writes one plugin-declared model use (`<pluginId>/<name>`) or clears it, and folds the answer into the store.
@MainActor func savePluginModel(_ workbench: Workbench, use: String, ref: AuxiliaryModelRef?) async throws {
    guard let api = workbench.api else { return }
    let saved = try await api.setPluginModel(use: use, ref: ref)
    workbench.store.applySavedSettings(settings: saved)
}

struct AuxiliaryModelsView: View {
    let workbench: Workbench
    @State private var catalog = AuxiliaryModelOptions()
    @State private var uses: [ModelUseDeclaration] = []
    var body: some View {
        let models = workbench.settings?.auxiliaryModels
        RiffetForm {
            Section {
                AuxiliaryModelRow(workbench: workbench, catalog: catalog, purpose: "title", title: String(localized: "会话标题", bundle: .riffet),
                                  off: String(localized: "只用 CLI 标题", bundle: .riffet), current: models?.title)
                AuxiliaryModelRow(workbench: workbench, catalog: catalog, purpose: "handoff", title: String(localized: "交接摘要", bundle: .riffet),
                                  off: String(localized: "不使用", bundle: .riffet), current: models?.handoff)
            }
            if !uses.isEmpty {
                Section {
                    ForEach(uses, id: \.id) { use in
                        AuxiliaryModelRow(workbench: workbench, catalog: catalog, purpose: "chat", title: localizedText(use.title, fallback: use.id),
                                          off: use.fallback == "chat" ? String(localized: "跟随快速对话", bundle: .riffet) : String(localized: "不使用", bundle: .riffet),
                                          current: workbench.settings?.pluginModels?[use.id], use: use.id)
                    }
                } header: { RiffetSectionTitle(String(localized: "插件", bundle: .riffet)) }
            }
            if let error = catalog.error { RiffetNotice.section(.error, error) }
        }
        .navigationTitle(String(localized: "辅助模型", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task { await catalog.load(workbench) }
        .task {
            guard let plugins = try? await workbench.api?.plugins() else { return }
            uses = plugins.filter { $0.enabled }.flatMap { $0.declared?.modelUses ?? [] }
        }
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
    var use: String?
    var body: some View {
        NavigationLink {
            AuxiliaryModelChoice(workbench: workbench, catalog: catalog, purpose: purpose, title: title, off: off, current: current, use: use)
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
    var use: String?
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
            do {
                if let use { try await savePluginModel(workbench, use: use, ref: ref) } else { try await saveAuxiliaryModel(workbench, purpose: purpose, ref: ref) }
                dismiss()
            }
            catch is CancellationError {} catch { self.error = error.riffetMessage }
        }
    }
}

/// 任务看板 (docs/TASK-BOARD.md §10): whether composer conversations open tasks, and the agent and model a new task
/// starts with. Saved at once, on the server, for every device.
struct TaskBoardSettingsView: View {
    let workbench: Workbench
    @State private var saving = false
    @State private var error: String?
    @Environment(\.palette) private var palette

    private static let follow = ""

    var body: some View {
        let saved = workbench.settings?.workItems
        let backend = workbench.backends.first { $0.backendId == saved?.backendId }
        let projectID = workbench.assistantProject?.id ?? workbench.projects.first?.id
        let agents = workbench.backends.filter { $0.available || $0.backendId == saved?.backendId }
        RiffetForm {
            Section {
                Toggle(String(localized: "新会话作为任务", bundle: .riffet), isOn: Binding(
                    get: { saved?.composerSessions?.boolValue == true },
                    set: { on in save { try await $0.setWorkItemComposerSessions(on: on) } }
                ))
                .tint(palette.accent).disabled(saving)
                RiffetPickerRow(
                    title: String(localized: "默认 Agent", bundle: .riffet),
                    options: [.init(id: Self.follow, title: String(localized: "跟随新会话", bundle: .riffet))] + agents.map { .init(id: $0.backendId.name, title: $0.label) },
                    selection: Binding(get: { saved?.backendId?.name ?? Self.follow }, set: { id in
                        let next = agents.first { $0.backendId.name == id }?.backendId
                        save { try await $0.setWorkItemAgent(backendId: next, profileId: nil, model: nil) }
                    })
                ).disabled(saving)
                if let saved, let backend, let backendId = saved.backendId, let projectID {
                    NavigationLink {
                        NewTaskModelPicker(workbench: workbench, backend: backendId, projectID: projectID, profiles: backend.profiles,
                                           selectedProfileID: saved.profileId, selection: saved.model) { _, profileID, model in
                            save { try await $0.setWorkItemAgent(backendId: backendId, profileId: profileID, model: model) }
                        }
                    } label: {
                        SettingsRowLabel(title: String(localized: "默认模型", bundle: .riffet), value: saved.model?.isEmpty == false ? saved.model : nil)
                    }
                    .disabled(saving)
                } else {
                    SettingsRowLabel(title: String(localized: "默认模型", bundle: .riffet))
                }
            }
            RiffetNotice.section(.error, error)
        }
        .navigationTitle(String(localized: "任务看板", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }

    private func save(_ write: @escaping (RiffetApi) async throws -> AppSettings) {
        guard !saving, let api = workbench.api else { return }
        saving = true
        Task {
            defer { saving = false }
            do {
                workbench.store.applySavedSettings(settings: try await write(api))
                error = nil
            } catch is CancellationError {} catch { self.error = error.riffetMessage }
        }
    }
}

/// 个人助理 (docs/ASSISTANT.md §7.6): its model, what it does in the background, which spends the owner's tokens while
/// they are away, and how it starts tasks. Saved at once, on the server, for every device.
struct AssistantSettingsView: View {
    let workbench: Workbench
    @State private var setup = AssistantSetup()
    @State private var usage: AssistantRunUsage?
    @State private var saving = false
    @State private var error: String?
    @State private var removing: AssistantPack?
    @Environment(\.palette) private var palette

    private static let dailyRuns: [Int32] = [10, 30, 100]

    var body: some View {
        let assistant = workbench.settings?.assistant
        // The assistant's own agent; its model comes from every provider of that agent, as the composer lists them.
        let choice = AssistantKt.assistantChoice(saved: assistant, backends: workbench.backends)
        let backend = workbench.backends.first { $0.backendId == choice?.backendId }
        let projectID = workbench.assistantProject?.id
        let daily = assistant?.dailyRuns?.int32Value ?? Int32(BudgetsKt.ASSISTANT_BUDGET_DAILY_RUNS)
        let dailyChoices = (Self.dailyRuns.contains(daily) ? Self.dailyRuns : (Self.dailyRuns + [daily]).sorted())
        let active = setup.delegations?.filter { $0.state == "active" }.count
        RiffetForm {
            Section {
                if let choice, let backend, let projectID {
                    NavigationLink {
                        NewTaskModelPicker(workbench: workbench, backend: choice.backendId, projectID: projectID, profiles: backend.profiles,
                                           selectedProfileID: choice.profileId, selection: choice.model) { _, profileID, model in
                            save { try await $0.rememberAssistant(backendId: choice.backendId, profileId: profileID, model: model) }
                        }
                    } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(String(localized: "模型", bundle: .riffet)).riffetFont(.body).foregroundStyle(palette.fg)
                                Text(backend.label).riffetFont(.caption).foregroundStyle(palette.fg3)
                            }
                            Spacer(minLength: 8)
                            if let model = choice.model, !model.isEmpty { Text(model).riffetFont(.body).foregroundStyle(palette.fg3).lineLimit(1) }
                        }
                    }
                    .disabled(saving)
                } else {
                    SettingsRowLabel(title: String(localized: "模型", bundle: .riffet))
                }
            }
            if !setup.packs.isEmpty {
                Section {
                    ForEach(setup.packs, id: \.id) { pack in
                        Toggle(isOn: Binding(get: { pack.installed }, set: { on in
                            if !on && !pack.builtIn { removing = pack } else { setPack(pack, on: on) }
                        })) {
                            describedLabel(pack.title, pack.description)
                        }
                        .tint(palette.accent).disabled(saving)
                    }
                } header: {
                    RiffetSectionTitle(String(localized: "能力包", bundle: .riffet))
                } footer: {
                    Text(String(localized: "个人助理空闲时生效；去掉后记忆保留", bundle: .riffet))
                }
            }
            Section {
                Toggle(isOn: Binding(get: { assistant?.supervision?.boolValue == true }, set: { on in save { try await $0.setAssistantSupervision(on: on) } })) {
                    describedLabel(String(localized: "跟进任务", bundle: .riffet), spent("supervise") ?? String(localized: "任务的会话停下、你不在时，核对交付或推动它", bundle: .riffet))
                }
                .tint(palette.accent).disabled(saving)
                Toggle(isOn: Binding(get: { assistant?.consolidation?.boolValue != false }, set: { on in save { try await $0.setAssistantConsolidation(on: on) } })) {
                    describedLabel(String(localized: "记忆整理", bundle: .riffet), spent("consolidate") ?? String(localized: "每晚，以及主对话压缩前", bundle: .riffet))
                }
                .tint(palette.accent).disabled(saving)
                NavigationLink { AssistantDelegationsView(workbench: workbench, setup: setup) } label: {
                    SettingsRowLabel(title: String(localized: "委托", bundle: .riffet), value: spent("delegation") ?? active.map { String(localized: "\($0) 项进行中", bundle: .riffet) })
                }
                VStack(alignment: .leading, spacing: 2) {
                    RiffetPickerRow(title: String(localized: "24 小时内最多", bundle: .riffet), options: dailyChoices.map {
                        .init(id: $0, title: String(localized: "\(Int($0)) 次运行", bundle: .riffet))
                    }, selection: Binding(get: { daily }, set: { value in save { try await $0.setAssistantDailyRuns(count: value) } }))
                    .disabled(saving)
                    if let usage {
                        Text(usage.waiting > 0
                             ? String(localized: "已开始 \(Int(usage.started)) 次，\(Int(usage.waiting)) 次在等", bundle: .riffet)
                             : String(localized: "已开始 \(Int(usage.started)) 次", bundle: .riffet))
                            .riffetFont(.caption).foregroundStyle(palette.fg3)
                    }
                }
            } header: {
                RiffetSectionTitle(String(localized: "后台运行", bundle: .riffet))
            } footer: {
                Text(String(localized: "用个人助理的模型，按用量计费", bundle: .riffet))
            }
            Section {
                Picker(String(localized: "开始任务前", bundle: .riffet), selection: Binding(
                    get: { assistant?.dispatch == "all" ? "all" : "edits" },
                    set: { value in save { try await $0.setAssistantDispatch(value: value) } }
                )) {
                    Text(String(localized: "改代码的先问我", bundle: .riffet)).tag("edits")
                    Text(String(localized: "都先问我", bundle: .riffet)).tag("all")
                }
                .pickerStyle(.menu).tint(palette.fg3).disabled(saving)
            } header: {
                RiffetSectionTitle(String(localized: "任务", bundle: .riffet))
            }
            RiffetNotice.section(.error, error)
        }
        .confirmationDialog(removing.map { String(localized: "去掉「\($0.title)」？", bundle: .riffet) } ?? "",
                            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button(String(localized: "去掉", bundle: .riffet), role: .destructive) {
                if let pack = removing { setPack(pack, on: false) }
                removing = nil
            }
        } message: { Text(String(localized: "它的文件夹会删除，可以从个人助理目录的提交历史找回", bundle: .riffet)) }
        .navigationTitle(String(localized: "个人助理", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task { await setup.refresh(workbench.api) }
        .task { await loadUsage() }
    }

    private func describedLabel(_ title: String, _ detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).riffetFont(.body).foregroundStyle(palette.fg)
            if let detail, !detail.isEmpty { Text(detail).riffetFont(.caption).foregroundStyle(palette.fg3) }
        }
    }

    /// `近 7 天 12 次 · 1.2M tokens`, once the job has had runs.
    private func spent(_ job: String) -> String? {
        guard let usage, let row = usage.jobs.first(where: { $0.job == job }), row.runs > 0 else { return nil }
        let tokens = StatsMathKt.compactCount(value: Double(row.tokens))
        return String(localized: "近 \(Int(usage.days)) 天 \(Int(row.runs)) 次 · \(tokens) tokens", bundle: .riffet)
    }

    private func setPack(_ pack: AssistantPack, on: Bool) {
        guard !saving, let api = workbench.api else { return }
        saving = true
        Task {
            defer { saving = false }
            do { try await setup.setPack(api, id: pack.id, on: on); error = nil }
            catch is CancellationError {} catch { self.error = error.riffetMessage; await setup.refresh(api) }
        }
    }

    private func loadUsage() async {
        guard let api = workbench.api else { return }
        if let value = try? await api.assistantRunUsage() { usage = value }
    }

    private func save(_ write: @escaping (RiffetApi) async throws -> AppSettings) {
        guard !saving, let api = workbench.api else { return }
        saving = true
        Task {
            defer { saving = false }
            do {
                workbench.store.applySavedSettings(settings: try await write(api))
                error = nil
                await loadUsage()
            } catch is CancellationError {} catch { self.error = error.riffetMessage }
        }
    }
}
