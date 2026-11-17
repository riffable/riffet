import SwiftUI
import RiffetKit

/// The gateway models for side jobs, one per purpose (`AppSettings.auxiliaryModels`): conversation
/// titles, the summary a handoff opens with and the canvas's turn summaries. Every purpose picks from the same list.
struct AuxiliaryModelSettings: View {
    @Environment(AppModel.self) private var model
    @State private var state = AuxiliaryModelsState()
    @State private var refreshedAt = Date.distantPast

    var body: some View {
        if let workbench = model.workbench {
            Form {
                AuxiliaryModelSection(workbench: workbench, state: state)
                PluginModelSection(workbench: workbench, state: state)
                SettingsScopeFooter()
            }
            .riffetForm()
            .task {
                refreshedAt = .now
                await state.refresh(workbench)
            }
            .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
                guard note.object as? String == SettingsSection.auxiliaryModels.rawValue,
                      Date.now.timeIntervalSince(refreshedAt) > 30 else { return }
                refreshedAt = .now
                Task { await state.refresh(workbench) }
            }
            .sheet(item: $state.preview) { selection in
                AuxiliaryModelPreview(workbench: workbench, selection: selection)
            }
        } else {
            DisconnectedSettings()
        }
    }
}

@MainActor
@Observable
private final class AuxiliaryModelsState {
    fileprivate(set) var options: [AuxiliaryModelOption]?
    var error: String?
    fileprivate(set) var saving: AuxiliaryPurpose?
    fileprivate(set) var savingUse: String?
    var preview: AuxiliaryPreviewSelection?

    /// The choices come from the settings, which another device may have changed too.
    func refresh(_ workbench: Workbench) async {
        async let latest = try? workbench.host.api?.settings()
        if error != nil { error = nil }
        do {
            let loaded = try await workbench.host.api?.auxiliaryModels()
            if loaded != options { options = loaded }
        } catch {
            self.error = error.riffetMessage
        }
        if let settings = await latest { workbench.store.applySavedSettings(settings: settings) }
    }

    fileprivate func save(_ workbench: Workbench, _ purpose: AuxiliaryPurpose, key: String) async {
        guard let api = workbench.host.api else { return }
        saving = purpose
        error = nil
        do {
            let ref = options?.first(where: { modelKey($0) == key })
                .map { AuxiliaryModelRef(backendId: $0.backendId, profileId: $0.profileId, model: $0.model) }
            let saved = try await api.setAuxiliaryModel(purpose: purpose.rawValue, ref: ref)
            workbench.store.applySavedSettings(settings: saved)
        } catch {
            self.error = error.riffetMessage
        }
        saving = nil
    }

    fileprivate func saveUse(_ workbench: Workbench, _ use: String, key: String) async {
        guard let api = workbench.host.api else { return }
        savingUse = use
        error = nil
        do {
            let ref = options?.first(where: { modelKey($0) == key })
                .map { AuxiliaryModelRef(backendId: $0.backendId, profileId: $0.profileId, model: $0.model) }
            let saved = try await api.setPluginModel(use: use, ref: ref)
            workbench.store.applySavedSettings(settings: saved)
        } catch {
            self.error = error.riffetMessage
        }
        savingUse = nil
    }
}

/// The pane's sections: a row per purpose, then a row per model use an enabled plugin declares.
private struct AuxiliaryModelSection: View {
    let workbench: Workbench
    let state: AuxiliaryModelsState

    var body: some View {
        let settings = workbench.settings
        Section {
            if state.options?.isEmpty == true {
                SettingsHint("先在 Claude、DeepSeek 或 Codex 下添加一个自定义 API 提供商。")
            }
            ForEach(AuxiliaryPurpose.allCases, id: \.self) { purpose in
                SettingsRow(purpose.title) {
                    HStack(spacing: Space.sm) {
                        picker(purpose, settings: settings)
                            .labelsHidden()
                            .pickerStyle(.menu)
                            .formPicker()
                        if purpose.canPreview {
                            Button("试用") {
                                if let ref = purpose.ref(in: settings) {
                                    state.preview = AuxiliaryPreviewSelection(purpose: purpose, ref: ref)
                                }
                            }
                            .disabled(purpose.ref(in: settings) == nil || state.saving != nil)
                        }
                    }
                }
            }
            if let error = state.error {
                SettingsCallout(.danger, message: error)
            }
        }
    }

    @ViewBuilder
    private func picker(_ purpose: AuxiliaryPurpose, settings: AppSettings?) -> some View {
        if state.options == nil, state.error == nil {
            // The saved choice in a disabled menu of the same size while the list loads, so the row
            // does not change height when the real menu replaces it.
            let key = purpose.ref(in: settings).map(modelKey) ?? ""
            Picker(purpose.title, selection: .constant(key)) {
                Text(purpose.ref(in: settings)?.model ?? purpose.emptyLabel).tag(key)
            }
            .disabled(true)
        } else {
            AuxiliaryModelPicker(
                title: purpose.title,
                emptyLabel: purpose.emptyLabel,
                current: purpose.ref(in: settings),
                options: state.options ?? [],
                selection: Binding(
                    get: { purpose.ref(in: settings).map(modelKey) ?? "" },
                    set: { key in
                        guard key != (purpose.ref(in: settings).map(modelKey) ?? "") else { return }
                        Task { await state.save(workbench, purpose, key: key) }
                    }
                )
            )
            .disabled(state.saving != nil || state.savingUse != nil)
        }
    }
}

/// The model uses enabled plugins declare (`AppSettings.pluginModels`), keyed by use id.
private struct PluginModelSection: View {
    let workbench: Workbench
    let state: AuxiliaryModelsState

    var body: some View {
        let uses = workbench.plugins.filter(\.enabled).flatMap { $0.declared?.modelUses ?? [] }
        if !uses.isEmpty {
            let settings = workbench.settings
            Section {
                ForEach(uses, id: \.id) { use in
                    let title = localizedText(use.title, fallback: use.id)
                    let empty = use.fallback == "chat" ? String(localized: "跟随快速对话") : String(localized: "不使用")
                    let current = settings?.pluginModels?[use.id]
                    SettingsRow(title) {
                        AuxiliaryModelPicker(
                            title: title,
                            emptyLabel: empty,
                            current: current,
                            options: state.options ?? [],
                            selection: Binding(
                                get: { current.map(modelKey) ?? "" },
                                set: { key in
                                    guard key != (current.map(modelKey) ?? "") else { return }
                                    Task { await state.saveUse(workbench, use.id, key: key) }
                                }
                            )
                        )
                        .labelsHidden()
                        .pickerStyle(.menu)
                        .formPicker()
                        .disabled(state.options == nil || state.saving != nil || state.savingUse != nil)
                    }
                }
            } header: {
                SettingsSectionHeader(title: String(localized: "插件"))
            }
        }
    }
}

/// The purposes `AppSettings.auxiliaryModels` keys its models by; the raw value is the wire key.
private enum AuxiliaryPurpose: String, CaseIterable {
    case title, handoff, summary

    var title: String {
        switch self {
        case .title: String(localized: "会话标题")
        case .handoff: String(localized: "交接摘要")
        case .summary: String(localized: "画布摘要")
        }
    }

    var emptyLabel: String {
        switch self {
        case .title: String(localized: "只用 CLI 标题")
        case .handoff, .summary: String(localized: "不使用")
        }
    }

    var inputPlaceholder: String {
        switch self {
        case .title: String(localized: "输入一条会话消息")
        case .handoff, .summary: String(localized: "粘贴对话内容")
        }
    }

    /// The server's `/api/auxiliary-models/preview` writes titles and handoff summaries only.
    var canPreview: Bool { self != .summary }

    var inputLimit: Int { self == .title ? 2_000 : 150_000 }

    func ref(in settings: AppSettings?) -> AuxiliaryModelRef? {
        switch self {
        case .title: settings?.auxiliaryModels?.title
        case .handoff: settings?.auxiliaryModels?.handoff
        case .summary: settings?.auxiliaryModels?.summary
        }
    }
}

private struct AuxiliaryPreviewSelection: Identifiable {
    let id = UUID()
    let purpose: AuxiliaryPurpose
    let ref: AuxiliaryModelRef
}

private struct AuxiliaryModelPreview: View {
    let workbench: Workbench
    let selection: AuxiliaryPreviewSelection
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var input = ""
    @State private var result = ""
    @State private var error: String?
    @State private var generation: Task<Void, Never>?

    private var canGenerate: Bool {
        generation == nil && !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && input.utf16.count <= selection.purpose.inputLimit
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(selection.purpose.title)
                    .font(.riffet(size: S(15), weight: .semibold))
                Text(selection.ref.model)
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg3)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            OrchestrationField(label: String(localized: "输入")) {
                OrchestrationTextArea(text: $input, placeholder: selection.purpose.inputPlaceholder, minHeight: 120, maxHeight: 180)
                    .disabled(generation != nil)
                    .accessibilityLabel(String(localized: "输入"))
            }
            if !result.isEmpty {
                OrchestrationField(label: String(localized: "结果")) {
                    ScrollView {
                        Text(result)
                            .font(.riffet(size: S(12.5)))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: selection.purpose == .title ? 80 : 220)
                }
            }
            if input.utf16.count > selection.purpose.inputLimit {
                SettingsCallout(.danger, message: String(localized: "最多 \(selection.purpose.inputLimit) 个字符"))
            } else if let error {
                SettingsCallout(.danger, message: error)
            }
            HStack(spacing: Space.sm) {
                Spacer()
                if generation != nil { Spinner(size: .small) }
                Button("关闭") { dismiss() }
                    .buttonStyle(SolidButtonStyle())
                    .keyboardShortcut(.cancelAction)
                Button(generation == nil ? String(localized: "生成") : String(localized: "生成中…"), action: generate)
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canGenerate)
            }
        }
        .padding(Space.xl)
        .frame(width: 500)
        .background(palette.bg)
        .onChange(of: input) { _, _ in result = ""; error = nil }
        .onDisappear { generation?.cancel() }
    }

    private func generate() {
        guard canGenerate, let api = workbench.host.api else { return }
        let message = input.trimmingCharacters(in: .whitespacesAndNewlines)
        result = ""
        error = nil
        generation = Task {
            defer { generation = nil }
            do {
                let text = try await api.previewAuxiliaryModel(purpose: selection.purpose.rawValue, ref: selection.ref, message: message)
                guard !Task.isCancelled else { return }
                result = text
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error.riffetMessage
            }
        }
    }
}

/// The models grouped by the provider they are listed under. A saved model its provider no longer
/// lists stays selectable, marked, so the choice is not silently dropped.
private struct AuxiliaryModelPicker: View {
    let title: String
    let emptyLabel: String
    let current: AuxiliaryModelRef?
    let options: [AuxiliaryModelOption]
    @Binding var selection: String

    var body: some View {
        Picker(title, selection: $selection) {
            Text(emptyLabel).tag("")
            if let current, !options.contains(where: { modelKey($0) == modelKey(current) }) {
                Text("\(current.model)（提供商里已不可用）").tag(modelKey(current))
            }
            ForEach(groups, id: \.name) { group in
                Section(group.name) {
                    ForEach(group.options, id: \.self) { option in
                        Text(option.model).tag(modelKey(option))
                    }
                }
            }
        }
    }

    private var groups: [(name: String, options: [AuxiliaryModelOption])] {
        var order: [String] = []
        var buckets: [String: [AuxiliaryModelOption]] = [:]
        for option in options {
            let name = "\(option.profileName) · \(backendTitle(option.backendId))"
            if buckets[name] == nil { order.append(name) }
            buckets[name, default: []].append(option)
        }
        return order.map { (name: $0, options: buckets[$0] ?? []) }
    }
}

private func modelKey(_ option: AuxiliaryModelOption) -> String { "\(backendWire(option.backendId))|\(option.profileId)|\(option.model)" }
private func modelKey(_ ref: AuxiliaryModelRef) -> String { "\(backendWire(ref.backendId))|\(ref.profileId)|\(ref.model)" }
