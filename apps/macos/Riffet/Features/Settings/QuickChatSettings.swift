import SwiftUI
import RiffetKit

/// The default chat model and retention, stored on the server. The global hotkey that opens
/// quick chat is on the 快捷键 page.
struct QuickChatSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var options: [AuxiliaryModelOption]?
    @State private var loadError: String?
    @State private var save = SettingsSaveState()
    @State private var refreshedAt = Date.distantPast

    var body: some View {
        if let workbench = model.workbench {
            form(workbench)
        } else {
            Form {
                Section {
                    SettingsHint("连接服务器后可修改。")
                }
                SettingsScopeFooter()
            }
            .riffetForm()
        }
    }

    private func form(_ workbench: Workbench) -> some View {
        let settings = workbench.settings
        let quick = settings?.quickChat
        let retention = quick?.retentionDays?.intValue ?? 7
        return Form {
            Section {
                SettingsRow(
                    String(localized: "默认模型"),
                    detail: options?.isEmpty == true ? String(localized: "需先在「模型设置」添加带网关的提供商。") : nil
                ) {
                    modelPicker(workbench, settings: settings)
                        .labelsHidden()
                        .pickerStyle(.menu)
                        .formPicker()
                        .fixedSize()
                        .disabled(save.busy || options == nil)
                }

                SettingsRow(String(localized: "自动归档"), detail: String(localized: "置顶或有收藏的对话不会归档。")) {
                    Picker("自动归档", selection: Binding(
                        get: { retention },
                        set: { days in Task { await saveQuickChat(workbench, retentionDays: days) } }
                    )) {
                        ForEach(retentionChoices(retention), id: \.self) { days in
                            Text("\(days) 天").tag(days)
                        }
                        Text("永不").tag(0)
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .formPicker()
                    .fixedSize()
                    .disabled(save.busy)
                }

                if let loadError {
                    SettingsCallout(
                        .danger,
                        message: loadError,
                        actionTitle: String(localized: "重试"),
                        action: { Task { await refresh(workbench) } }
                    )
                }
                SettingsFeedback(state: save)
            }

            SettingsScopeFooter()
        }
        .riffetForm()
        .task { await refresh(workbench) }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == SettingsSection.quickChat.rawValue,
                  Date.now.timeIntervalSince(refreshedAt) > 30 else { return }
            Task { await refresh(workbench) }
        }
    }

    @ViewBuilder
    private func modelPicker(_ workbench: Workbench, settings: AppSettings?) -> some View {
        let current = settings?.auxiliaryModels?.chat
        Picker("模型", selection: Binding(
            get: { current.map(modelKey) ?? "" },
            set: { key in Task { await saveModel(workbench, key: key) } }
        )) {
            Text("不设置").tag("")
            // A saved model the list no longer offers: still the selection, marked as gone once the
            // list has loaded.
            if let current, !(options ?? []).contains(where: { modelKey($0) == modelKey(current) }) {
                Text(options == nil ? current.model : String(localized: "\(current.model)（已不可用）")).tag(modelKey(current))
            }
            ForEach(options ?? [], id: \.self) { option in
                Text("\(option.profileName) · \(option.model)").tag(modelKey(option))
            }
        }
    }

    private func refresh(_ workbench: Workbench) async {
        refreshedAt = .now
        loadError = nil
        async let latest = try? workbench.host.api?.settings()
        do {
            let loaded = try await workbench.host.api?.auxiliaryModels()
            if loaded != options { options = loaded }
        } catch {
            loadError = error.riffetMessage
        }
        if let settings = await latest { workbench.store.applySavedSettings(settings: settings) }
    }

    private func saveModel(_ workbench: Workbench, key: String) async {
        guard let api = workbench.host.api else { return }
        await save.run {
            let ref = key.isEmpty ? nil : (options ?? []).first { modelKey($0) == key }
                .map { AuxiliaryModelRef(backendId: $0.backendId, profileId: $0.profileId, model: $0.model) }
            let saved = try await api.setAuxiliaryModel(purpose: "chat", ref: ref)
            workbench.store.applySavedSettings(settings: saved)
        }
    }

    private func saveQuickChat(
        _ workbench: Workbench,
        retentionDays: Int? = nil
    ) async {
        guard let api = workbench.host.api else { return }
        await save.run {
            let saved = try await api.updateQuickChat(
                retentionDays: retentionDays.map { KotlinInt(int: Int32($0)) },
                openMode: nil,
                presets: nil,
                resetPresets: false
            )
            workbench.store.applySavedSettings(settings: saved)
        }
    }
}

/// The usual choices, plus whatever another client set, so the picker always shows the current
/// retention instead of an empty selection.
private func retentionChoices(_ days: Int) -> [Int] {
    let standard = [1, 3, 7, 14, 30]
    return standard.contains(days) || days == 0 ? standard : standard + [days]
}

private func modelKey(_ option: AuxiliaryModelOption) -> String {
    "\(backendWire(option.backendId)):\(option.profileId):\(option.model)"
}

private func modelKey(_ ref: AuxiliaryModelRef) -> String {
    "\(backendWire(ref.backendId)):\(ref.profileId):\(ref.model)"
}
