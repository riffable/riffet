import SwiftUI
import RiffetKit

/// The same server-owned names are used by the composer and its configuration sheets.
enum NativeConfigurationSummary {
    /// What a new task starts with: the draft's picks where the catalog still offers them, else the
    /// shared defaults (`NewSessionDraft`, the same rules as Android).
    @MainActor static func choice(catalog: NativeBackendCatalogEntry, draft: MessageDraft, settings: AppSettings?) -> NewSessionChoice {
        NewSessionDraft(profileId: draft.profileID, model: draft.model, mode: draft.mode, approval: draft.approval)
            .resolve(catalog: catalog, saved: settings?.nativeBackendDefaults?[catalog.backendId], cursorModel: settings?.defaultModel, listed: nil)
    }
    static func model(catalog: NativeBackendCatalogEntry?, selection: String?) -> String {
        let value = selection ?? catalog?.defaultModel
        guard let value, !value.isEmpty else { return String(localized: "选择模型", bundle: .riffet) }
        guard let catalog, !catalog.models.isEmpty else { return value }
        return modelSelectionSummary(catalog: catalog.models, selection: value)
    }
    /// The input's model entry names only the family; parameters remain in its settings sheet.
    static func shortModel(catalog: NativeBackendCatalogEntry?, selection: String?) -> String {
        let label = modelLabel(catalog: catalog?.models ?? [], value: selection ?? catalog?.defaultModel)
        return label.isEmpty ? String(localized: "选择模型", bundle: .riffet) : label
    }
    static func profile(catalog: NativeBackendCatalogEntry?, profileID: String?) -> String? {
        guard let catalog else { return nil }
        if let profileID { return catalog.profiles.first { $0.id == profileID }?.name ?? profileID }
        return catalog.profiles.first { $0.isDefault?.boolValue == true }?.name
    }
    @MainActor static func chooseModel(catalog: NativeBackendCatalogEntry, projectID: String, profileID: String?, value: String, draft: MessageDraft) -> Bool {
        guard draft.projectID == projectID, draft.backendName == nil || draft.backendName == catalog.backendId.name,
              catalog.available, catalog.capabilities.supportsModelSelection, profileID == nil || catalog.profiles.contains(where: { $0.id == profileID }), catalog.models.contains(where: { $0.value == resolveModelSelection(catalog: catalog.models, selection: value).model }) else { return false }
        draft.profileID = profileID
        draft.model = value
        return true
    }
    static func approval(status: NativeStatus?, backend: NativeBackendId, sessionApproval: String?) -> String? {
        if let value = status?.approval, !value.isEmpty { return value }
        if backend == .cursor, let permission = status?.permission?.lowercased() {
            if permission.range(of: "auto.?review", options: .regularExpression) != nil { return "auto-review" }
            if ["run everything", "unrestricted", "yolo"].contains(where: permission.contains) { return "unrestricted" }
        }
        return sessionApproval
    }
    static func configuration(catalog: NativeBackendCatalogEntry?, profileID: String?, selection: String?) -> String {
        [profile(catalog: catalog, profileID: profileID), model(catalog: catalog, selection: selection)].compactMap { $0 }.joined(separator: " · ")
    }
}

enum SessionOptionFocus: String, Identifiable {
    case all, model, mode, approval
    var id: String { rawValue }
}

struct NewTaskOptions: View {
    let workbench: Workbench
    @Bindable var draft: MessageDraft
    let catalog: NativeBackendCatalogEntry?
    let backend: NativeBackendId
    var loading = false
    var error: String?
    var retry: (() -> Void)?
    var focus: SessionOptionFocus = .all
    /// The phones the new task may control: the list read now and the remembered pick that is offered.
    var toolDevices: [PublicDevice]?
    var toolGroups: [String] = []
    var onPickTools: ([String]) -> Void = { _ in }
    /// The MCP and Skill switches of the new task; nil where the backend has none.
    var extensions: ExtensionsPick?
    /// A quick chat has the chat backend's models and nothing else; [selectedModel] is the one it will start with.
    var quickChat = false
    var selectedModel: String?
    @State private var reader = ExtensionsReader()
    var body: some View {
        Group {
            if focus == .model || quickChat, let catalog, let projectID = draft.projectID, !loading, error == nil {
                modelPicker(catalog, projectID: projectID)
            } else if quickChat {
                Form {
                    if loading { Section { ProgressView("正在读取模型与配置…") } }
                    if let error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red); Button("重新读取", action: { retry?() }) } }
                }
            } else { optionsForm }
        }.navigationTitle(focus == .model || quickChat ? String(localized: "选择模型", bundle: .riffet) : String(localized: "Agent 与模型", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }
    /// Whether the MCP and Skill lists have anything to switch; nil while they are unknown or failed to read.
    private func hasSwitches(_ pick: ExtensionsPick) -> Bool? {
        guard let loaded = reader.loaded ?? pick.cached() else { return nil }
        let kit = ExtensionsOff.shared
        let mcp = pick.toggles.mcp ? kit.listed(loaded: loaded.mcp.map(\.name), value: pick.off, prefix: kit.MCP_PREFIX) : []
        let skills = pick.toggles.skills ? kit.listed(loaded: loaded.skills.map(\.name), value: pick.off, prefix: kit.SKILL_PREFIX) : []
        return !(mcp.isEmpty && skills.isEmpty)
    }
    private func modelPicker(_ catalog: NativeBackendCatalogEntry, projectID: String) -> some View {
        NewTaskModelPicker(workbench: workbench, backend: backend, projectID: projectID, profiles: catalog.profiles,
            selectedProfileID: draft.profileID, selection: selectedModel ?? draft.model ?? catalog.defaultModel) { selectedCatalog, profileID, value in
            if !NativeConfigurationSummary.chooseModel(catalog: selectedCatalog, projectID: projectID, profileID: profileID, value: value, draft: draft) {
                draft.error = String(localized: "项目或 Agent 配置已改变，请重新选择模型。", bundle: .riffet)
            }
        }
    }
    private var optionsForm: some View {
        Form {
            Section {
                NavigationLink {
                    List {
                        ForEach(workbench.backends, id: \.backendId) { entry in
                            Button {
                                guard entry.available else { return }
                                draft.backendName = entry.backendId.name
                                draft.profileID = nil; draft.model = nil; draft.mode = nil; draft.approval = nil
                            } label: {
                                ConfigurationChoiceRow(title: entry.label, markBackend: entry.backendId.name, detail: entry.available ? nil : entry.reason ?? String(localized: "此 Mac 上不可用", bundle: .riffet), selected: entry.backendId == backend)
                            }.disabled(!entry.available).foregroundStyle(.primary).accessibilityIdentifier("agentChoice.\(entry.backendId.name)")
                        }
                        if workbench.backends.isEmpty { Text(workbench.backendError ?? String(localized: "尚未读取到 Agent", bundle: .riffet)).foregroundStyle(.secondary) }
                    }.navigationTitle(String(localized: "选择 Agent", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                } label: { LabeledContent("Agent", value: catalog?.label ?? workbench.backends.first { $0.backendId == backend }?.label ?? backend.name.capitalized) }
            }

            if draft.projectID == nil {
                Section { Label("请先选择项目，再读取该项目可用的模型。", systemImage: "folder").foregroundStyle(.secondary) }
            } else if loading {
                Section { ProgressView("正在读取模型与配置…") }
            } else if let error {
                Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red); Button("重新读取", action: { retry?() }) }
            } else if let catalog {
                if !catalog.available { Section { Label(catalog.reason ?? String(localized: "此 Agent 当前不可用", bundle: .riffet), systemImage: "exclamationmark.triangle").foregroundStyle(.orange) } }
                if catalog.capabilities.supportsModelSelection {
                    Section {
                        NavigationLink {
                            if let projectID = draft.projectID { modelPicker(catalog, projectID: projectID) }
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("模型").font(.caption).foregroundStyle(.secondary)
                                Text(NativeConfigurationSummary.model(catalog: catalog, selection: draft.model)).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
                                if let profile = NativeConfigurationSummary.profile(catalog: catalog, profileID: draft.profileID) { Text(profile).font(.caption).foregroundStyle(.secondary) }
                            }.padding(.vertical, 3)
                        }.disabled(!catalog.available)
                    }
                    ModelParameterSection(catalog: catalog.models, selection: draft.model ?? catalog.defaultModel) { draft.model = $0 }
                } else { Section { Text("此 Agent 使用它自己的默认模型。改变模型需要在 Mac 上的 Agent 中操作。").foregroundStyle(.secondary) } }
                let choice = NativeConfigurationSummary.choice(catalog: catalog, draft: draft, settings: workbench.settings)
                if catalog.capabilities.supportsModeSelection {
                    Section("运行模式") {
                        ConfigurationOptionPicker(title: String(localized: "模式", bundle: .riffet), options: catalog.capabilities.modes, selection: choice.mode) { draft.mode = $0 }
                    }
                }
                if catalog.capabilities.supportsPermissionSelection {
                    Section {
                        ConfigurationOptionPicker(title: String(localized: "权限模式", bundle: .riffet), options: catalog.capabilities.permissions, selection: choice.approval) { draft.approval = $0 }
                    } header: { Text("操作确认") }
                }
                let phones = catalog.capabilities.supportsRiffetTools && backend != .chat && ToolsPick.offered(devices: toolDevices, value: [])
                // Nothing to toggle, nothing to show; a list not read yet keeps the row.
                let phonesUnknown = catalog.capabilities.supportsRiffetTools && backend != .chat && toolDevices == nil
                if phones || phonesUnknown || extensions.map({ hasSwitches($0) ?? true }) == true {
                    Section { ToolsPickerLink(value: toolGroups, devices: phones ? toolDevices : nil, onChange: onPickTools, extensions: extensions) }
                }
            } else { Section { Text("尚未读取到此项目的 Agent 配置。").foregroundStyle(.secondary); Button("重新读取", action: { retry?() }) } }
            if let error = workbench.backendError { Section { Text(error).foregroundStyle(.red); Button("重新读取 Agent") { Task { await workbench.loadBackends() } } } }
        }.navigationTitle(String(localized: "Agent 与模型", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .task(id: extensions?.key) { if let extensions { await reader.load(extensions, force: false) } }
    }
}

/// Model rows carry their provider identity, so equal model IDs from different providers do not collide.
private struct NewTaskModelPicker: View {
    let workbench: Workbench
    let backend: NativeBackendId
    let projectID: String
    let profiles: [NativeBackendProfile]
    let selectedProfileID: String?
    let selection: String?
    let choose: (NativeBackendCatalogEntry, String?, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var catalogs: [String: NativeBackendCatalogEntry] = [:]
    @State private var failures: [String: String] = [:]
    @State private var loading = true
    @State private var retry = 0
    private var effectiveProfile: String { selectedProfileID ?? profiles.first { $0.isDefault?.boolValue == true }?.id ?? "" }
    private var keys: [String] { profiles.isEmpty ? [""] : profiles.map(\.id) }
    var body: some View {
        List {
            if loading { Section { ProgressView("正在读取服务商模型…") } }
            if let selected = catalogs[effectiveProfile] {
                ModelParameterSection(catalog: selected.models, selection: selection ?? selected.defaultModel) { value in choose(selected, effectiveProfile.isEmpty ? nil : effectiveProfile, value) }
            }
            ForEach(keys, id: \.self) { key in
                Section {
                    if let error = failures[key] { Label(error, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(.red); Button("重试读取") { retry += 1 } }
                    if let catalog = catalogs[key] {
                        if !catalog.available { Label(catalog.reason ?? String(localized: "当前配置不可用", bundle: .riffet), systemImage: "exclamationmark.triangle").foregroundStyle(.secondary) }
                        let models = catalog.models.filter { query.isEmpty || ($0.name + " " + $0.value).localizedCaseInsensitiveContains(query) }
                        ForEach(models, id: \.value) { model in
                            Button {
                                guard catalog.available else { return }
                                choose(catalog, key.isEmpty ? nil : key, selectionForModel(catalog: catalog.models, model: model.value)); dismiss()
                            } label: {
                                ConfigurationChoiceRow(title: cleanLabel(value: model.name), detail: nil, selected: key == effectiveProfile && resolveModelSelection(catalog: catalog.models, selection: selection ?? catalog.defaultModel).model == model.value)
                            }.foregroundStyle(.primary).disabled(!catalog.available).accessibilityIdentifier("modelChoice.\(key).\(model.value)")
                        }
                        if models.isEmpty { Text(query.isEmpty ? "此配置未提供可选择的模型" : "没有匹配的模型").foregroundStyle(.secondary) }
                    }
                } header: { if let profile = profiles.first(where: { $0.id == key }) { Text(profile.name) } }
            }
        }.accessibilityIdentifier("newTaskModelList")
            .navigationTitle(String(localized: "选择模型", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: String(localized: "搜索模型或型号", bundle: .riffet))
            .task(id: retry) { await load() }
    }
    @MainActor private func load() async {
        loading = true; failures = [:]; catalogs = [:]
        defer { if !Task.isCancelled { loading = false } }
        guard let api = workbench.api else { for key in keys { failures[key] = String(localized: "未连接服务器", bundle: .riffet) }; return }
        for key in keys {
            do {
                let entry = try await api.backendCatalog(backendId: backend, profileId: key.isEmpty ? nil : key, projectId: projectID, allModels: false, global: false)
                try Task.checkCancellation()
                catalogs[key] = entry
            } catch is CancellationError { return }
            catch { failures[key] = error.riffetMessage }
        }
    }
}

struct SessionOptionsView: View {
    let workbench: Workbench
    let session: Session
    var focus: SessionOptionFocus = .all
    @State private var catalog: NativeBackendCatalogEntry?
    @State private var pending = false
    @State private var error: String?
    @State private var loading = true
    @State private var receipt: Session?
    @State private var restoring = false
    @State private var toolDevices = ToolDevices()
    /// The newest pick shows at once; writes go one at a time and only the newest unsent value follows an in-flight one.
    @State private var pendingTools: [String]?
    @State private var unsentTools: [String]?
    @State private var pendingOff: [String]?
    @State private var unsentOff: [String]?
    @State private var writingTools = false
    @State private var toolsError: String?
    private var current: Session {
        let selected = workbench.selected?.id == session.id ? workbench.selected : nil
        let latest = selected ?? workbench.list.sessions.first { $0.id == session.id } ?? session
        // Bridge a just-saved response only until the shared store reaches its revision.
        // Once it catches up, live state (including archive and delivery changes) wins.
        if let receipt, let revision = receipt.configRevision,
           (latest.configRevision?.int64Value ?? 0) < revision.int64Value { return receipt }
        return latest
    }
    private var effectiveApproval: String? {
        // A just-saved receipt bridges the CLI restart; otherwise its live footer is authoritative.
        if let receipt, let revision = receipt.configRevision,
           (workbench.selected?.configRevision?.int64Value ?? 0) < revision.int64Value { return receipt.approval }
        return NativeConfigurationSummary.approval(status: workbench.selected?.id == session.id ? workbench.status : nil,
            backend: current.backendId ?? .cursor, sessionApproval: current.approval)
    }
    private var context: NativeContext? { workbench.selected?.id == session.id ? workbench.context : nil }
    private var tools: [String] { pendingTools ?? ToolGroups.shared.phones(groups: current.toolGroups) }
    private var extensionsOff: [String] { pendingOff ?? ExtensionsOff.shared.clean(value: current.extensionsOff) }
    /// Phones need a backend that takes the tools and something to pick or switch off; quick chat and archived sessions have none.
    private func phonesShown(_ catalog: NativeBackendCatalogEntry) -> Bool {
        catalog.capabilities.supportsRiffetTools && current.backendId != .chat && current.archivedAt == nil
            && ToolsPick.offered(devices: toolDevices.devices, value: tools)
    }
    private func extensionsPick(_ catalog: NativeBackendCatalogEntry) -> ExtensionsPick? {
        ExtensionsPick.make(workbench: workbench, allowed: current.backendId != .chat && current.archivedAt == nil, capabilities: catalog.capabilities,
                            backendId: current.backendId, profileId: current.backendProfileId, projectId: current.projectId,
                            off: extensionsOff, onChange: setExtensionsOff)
    }
    private func toolsShown(_ catalog: NativeBackendCatalogEntry) -> Bool { phonesShown(catalog) || extensionsPick(catalog) != nil }
    private var title: String { switch focus { case .all: String(localized: "会话选项", bundle: .riffet); case .model: String(localized: "模型与参数", bundle: .riffet); case .mode: String(localized: "运行模式", bundle: .riffet); case .approval: String(localized: "操作确认", bundle: .riffet) } }
    var body: some View {
        Form {
            if focus == .all { Section("会话") {
                LabeledContent("项目", value: workbench.project(current.projectId)?.name ?? current.projectId)
                LabeledContent("Agent", value: catalog?.label ?? (current.backendId ?? .cursor).name.capitalized)
                if let profile = NativeConfigurationSummary.profile(catalog: catalog, profileID: current.backendProfileId) { LabeledContent("服务商配置", value: profile) }
                LabeledContent("状态", value: current.state.label)
            } }
            if focus == .all || focus == .model { SessionContextUsageSection(context: context) }
            if let error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red); Button("重新读取") { Task { await load() } }.disabled(pending) } }
            if loading { Section { ProgressView("正在读取 Agent 能力…") } }
            else if let catalog {
                if current.archivedAt != nil { Section {
                    Button {
                        restoring = true
                        // Stays pending until the store shows the session restored; only a failure re-enables it.
                        Task { await workbench.update(current, archived: false); if workbench.error != nil { restoring = false } }
                    } label: {
                        HStack { Label("恢复会话", systemImage: "arrow.uturn.backward"); if restoring { Spacer(); ProgressView() } }
                    }.disabled(restoring || pending)
                }.onDisappear { restoring = false } }
                if focus == .model { sendingOptions(catalog) }
                if focus == .all || focus == .model {
                    if catalog.capabilities.supportsModelSelection {
                        ModelOptions(catalog: catalog.models, selection: current.model ?? catalog.defaultModel, inlineList: focus == .model, providers: providers(catalog),
                                     switchTo: { profile, value in change { api in try await api.nativeSwitchProfile(id: session.id, backendProfileId: profile, model: value) } onDone: { Task { await load() } } }) { value in change { api in try await api.nativeSetModel(id: session.id, model: value) } }
                            .disabled(pending || current.archivedAt != nil)
                    } else { Section { Text("此 Agent 不支持在客户端切换模型。").foregroundStyle(.secondary) } }
                }
                if (focus == .all || focus == .mode) && catalog.capabilities.supportsModeSelection {
                    Section("运行模式") {
                        ConfigurationOptionPicker(title: String(localized: "模式", bundle: .riffet), options: catalog.capabilities.modes, selection: current.mode) { value in change { api in try await api.nativeSetMode(id: session.id, mode: value) } }
                    }.disabled(pending || current.archivedAt != nil)
                }
                if (focus == .all || focus == .approval) && catalog.capabilities.supportsPermissionSelection {
                    Section {
                        ConfigurationOptionPicker(title: String(localized: "权限模式", bundle: .riffet), options: catalog.capabilities.permissions, selection: effectiveApproval) { value in change { api in try await api.nativeSetApproval(id: session.id, approval: value) } }
                    } header: { Text("操作确认") } footer: { Text("只影响此会话；部分 Agent 会重启 CLI。") }
                    .disabled(pending || current.archivedAt != nil)
                }
                if current.state.isActive { Section { Text("当前轮次继续执行。模型和运行模式的修改将在 Agent 下次空闲时应用。").font(.footnote).foregroundStyle(.secondary) } }
            }
            if pending { Section { ProgressView("正在保存配置…") } }
            if focus == .all { Section {
                Button("重新打开 Agent") { change { api in
                    let result = try await api.startSession(id: session.id)
                    guard let updated = result.session else { throw ClientFailure(String(localized: "Agent 未返回会话，请重新读取后重试", bundle: .riffet)) }
                    workbench.store.retry(); return updated
                } }.disabled(pending || current.archivedAt != nil)
                Button(current.archivedAt == nil ? "归档会话" : "恢复会话") { Task { await workbench.update(current, archived: current.archivedAt == nil) } }.disabled(pending)
            } }
        }
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .bottomBar)
        .task { await load() }
        .readsToolDevices(toolDevices, workbench: workbench, enabled: true)
        .onChange(of: workbench.selected?.configRevision) { _, _ in if workbench.selected?.id == session.id { receipt = nil } }
    }
    @ViewBuilder private func sendingOptions(_ catalog: NativeBackendCatalogEntry) -> some View {
        if catalog.capabilities.supportsModeSelection || catalog.capabilities.supportsPermissionSelection || toolsShown(catalog) {
            Section("发送设置") {
                if catalog.capabilities.supportsModeSelection {
                    NavigationLink {
                        Form {
                            focusedSaveFeedback
                            Section("运行模式") {
                                ConfigurationOptionPicker(title: String(localized: "模式", bundle: .riffet), options: catalog.capabilities.modes, selection: current.mode) { value in
                                    change { api in try await api.nativeSetMode(id: session.id, mode: value) }
                                }
                            }.disabled(pending || current.archivedAt != nil)
                        }.navigationTitle(String(localized: "运行模式", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                    } label: {
                        LabeledContent("模式", value: catalog.capabilities.modes.first { $0.id == current.mode }?.label ?? (current.mode.isEmpty ? String(localized: "未报告", bundle: .riffet) : current.mode))
                    }.accessibilityIdentifier("sessionModeOptions")
                }
                if catalog.capabilities.supportsPermissionSelection {
                    NavigationLink {
                        Form {
                            focusedSaveFeedback
                            Section {
                                ConfigurationOptionPicker(title: String(localized: "权限模式", bundle: .riffet), options: catalog.capabilities.permissions, selection: effectiveApproval) { value in
                                    change { api in try await api.nativeSetApproval(id: session.id, approval: value) }
                                }
                            } footer: { Text("只影响此会话；部分 Agent 会重启 CLI。") }
                            .disabled(pending || current.archivedAt != nil)
                        }.navigationTitle(String(localized: "操作确认", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                    } label: {
                        LabeledContent("操作确认", value: catalog.capabilities.permissions.first { $0.id == effectiveApproval }?.label ?? effectiveApproval ?? String(localized: "未报告", bundle: .riffet))
                    }.accessibilityIdentifier("sessionApprovalOptions")
                }
                if toolsShown(catalog) {
                    ToolsPickerLink(value: tools, devices: phonesShown(catalog) ? toolDevices.devices : nil, onChange: setTools,
                        extensions: extensionsPick(catalog), footnote: String(localized: "下次启动时生效", bundle: .riffet), error: toolsError)
                }
            }.disabled(pending || current.archivedAt != nil)
        }
    }
    @ViewBuilder private var focusedSaveFeedback: some View {
        if let error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }
        if pending { Section { ProgressView("正在保存配置…") } }
        if current.state.isActive { Section { Text("当前轮次继续执行，修改将在 Agent 下次空闲时应用。").font(.footnote).foregroundStyle(.secondary) } }
    }
    @MainActor private func load() async {
        guard !pending else { return }
        loading = true; error = nil
        do {
            guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
            let loaded = try await api.sessionCatalog(id: session.id)
            try Task.checkCancellation(); catalog = loaded
        } catch is CancellationError { return }
        catch { self.error = error.riffetMessage; catalog = nil }
        loading = false
    }
    private func setTools(_ groups: [String]) { writeLaunchSettings(tools: groups, off: nil) }
    private func setExtensionsOff(_ items: [String]) { writeLaunchSettings(tools: nil, off: items) }
    /// Both lists apply at the next launch and share one writer: the newest pick shows at once, writes go
    /// one at a time, and what is unsent when one answers goes out together in the next request.
    private func writeLaunchSettings(tools: [String]?, off: [String]?) {
        if let tools { unsentTools = tools; pendingTools = tools }
        if let off { unsentOff = off; pendingOff = off }
        toolsError = nil
        guard !writingTools else { return }
        writingTools = true
        Task { @MainActor in
            defer { writingTools = false; pendingTools = unsentTools; pendingOff = unsentOff }
            while unsentTools != nil || unsentOff != nil {
                let groups = unsentTools, items = unsentOff
                unsentTools = nil; unsentOff = nil
                do {
                    _ = try await workbench.store.updateSession(id: session.id, body: SessionUpdate(title: nil, tags: nil, archived: nil, pinned: nil, toolGroups: groups, extensionsOff: items))
                } catch { toolsError = error.riffetMessage }
                // The server's answer, or its refusal, is what shows unless a newer pick waits.
                if unsentTools == nil { pendingTools = nil }
                if unsentOff == nil { pendingOff = nil }
            }
        }
    }
    /// The current provider plus the ones the conversation can continue on, in catalog order; empty when nothing qualifies.
    private func providers(_ catalog: NativeBackendCatalogEntry) -> [ModelProvider] {
        guard !catalog.continuations.isEmpty else { return [] }
        let currentID = current.backendProfileId ?? catalog.profiles.first { $0.isDefault?.boolValue == true }?.id ?? ""
        var all = [ModelProvider(id: currentID, name: catalog.profiles.first { $0.id == currentID }?.name ?? currentID, models: catalog.models, isCurrent: true)]
        for item in catalog.continuations where item.profile.id != currentID {
            all.append(ModelProvider(id: item.profile.id, name: catalog.profiles.first { $0.id == item.profile.id }?.name ?? item.profile.name, models: item.models))
        }
        let order = catalog.profiles.map(\.id)
        return all.enumerated().sorted { a, b in
            let l = order.firstIndex(of: a.element.id) ?? Int.max, r = order.firstIndex(of: b.element.id) ?? Int.max
            return l == r ? a.offset < b.offset : l < r
        }.map(\.element)
    }
    private func change(_ action: @escaping (RiffetApi) async throws -> Session, onDone: (() -> Void)? = nil) {
        guard !pending, current.archivedAt == nil else { return }
        pending = true; error = nil
        Task { @MainActor in
            defer { pending = false }
            do {
                guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
                let updated = try await action(api)
                guard updated.id == session.id else { throw ClientFailure(String(localized: "服务器返回了其他会话，配置未确认", bundle: .riffet)) }
                receipt = updated; workbench.store.applySession(session: updated)
                onDone?()
            } catch { self.error = error.riffetMessage }
        }
    }
}

private struct SessionContextUsageSection: View {
    let context: NativeContext?
    private var reported: NativeContext? {
        guard let context, context.size > 0, context.used >= 0 else { return nil }
        return context
    }
    private func label(_ part: NativeContextBreakdown) -> String {
        switch part.id {
        case "system_prompt": String(localized: "系统提示词", bundle: .riffet)
        case "tools": String(localized: "工具定义", bundle: .riffet)
        case "rules": String(localized: "规则", bundle: .riffet)
        case "skills": "Skills"
        case "mcp": String(localized: "MCP 与动态工具", bundle: .riffet)
        case "subagents": String(localized: "子 Agent 定义", bundle: .riffet)
        case "summarized_conversation": String(localized: "已压缩的对话", bundle: .riffet)
        case "conversation": String(localized: "对话", bundle: .riffet)
        default: part.label.isEmpty ? part.id : part.label
        }
    }
    var body: some View {
        Section("上下文用量") {
            if let context = reported {
                let ratio = Double(context.used) / Double(context.size)
                let tone: Color = ratio >= 0.9 ? .red : ratio >= 0.75 ? .orange : .accentColor
                LabeledContent("已使用", value: context.used.formatted() + " tokens")
                    .accessibilityIdentifier("modelContextUsed")
                LabeledContent(context.limitKind == "compaction" ? String(localized: "自动压缩阈值", bundle: .riffet) : String(localized: "上下文窗口", bundle: .riffet), value: context.size.formatted() + " tokens")
                    .accessibilityIdentifier("modelContextSize")
                VStack(alignment: .leading, spacing: 8) {
                    HStack { Text("使用比例"); Spacer(); Text(ratio.formatted(.percent.precision(.fractionLength(0...1)))).monospacedDigit().foregroundStyle(tone) }
                    ProgressView(value: min(1, ratio)).tint(tone).accessibilityHidden(true)
                }.accessibilityElement(children: .combine).accessibilityIdentifier("modelContextUsage")
                let parts = context.breakdown.filter { $0.tokens >= 0 }
                if parts.isEmpty { Text("当前 Agent 尚未提供用量分解。").font(.subheadline).foregroundStyle(.secondary) }
                else {
                    DisclosureGroup("用量分解") {
                        ForEach(parts, id: \.id) { part in
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text(label(part)).fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 4)
                                VStack(alignment: .trailing, spacing: 3) {
                                    Text(part.tokens.formatted() + " tokens").monospacedDigit()
                                    if context.used > 0 {
                                        Text((Double(part.tokens) / Double(context.used)).formatted(.percent.precision(.fractionLength(0...1))))
                                            .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                                    }
                                }
                            }.font(.subheadline).padding(.vertical, 3).accessibilityElement(children: .combine)
                                .accessibilityIdentifier("modelContextPart.\(part.id)")
                        }
                    }
                }
            } else {
                Text("当前 Agent 尚未报告上下文用量。").foregroundStyle(.secondary)
                    .accessibilityIdentifier("modelContextUnavailable")
            }
        }
    }
}

struct ConfigurationChoiceRow: View {
    let title: String
    var markBackend: String? = nil
    let detail: String?
    let selected: Bool
    /// A short figure before the check, such as how many tools an MCP server has.
    var trailing: String? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if let markBackend { AgentMarkView(backend: markBackend, size: 15) }
                    Text(title).fixedSize(horizontal: false, vertical: true)
                }
                if let detail, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let trailing { Text(trailing).font(.subheadline).foregroundStyle(.secondary).monospacedDigit() }
            if selected { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(.tint).accessibilityLabel("已选择") }
            else if trailing != nil { Image(systemName: "checkmark").fontWeight(.semibold).hidden() }
        }.padding(.vertical, 4).frame(minHeight: 36).contentShape(Rectangle())
    }
}

private struct ConfigurationOptionPicker: View {
    let title: String
    let options: [NativeBackendOption]
    let selection: String?
    let choose: (String) -> Void
    var body: some View {
        ForEach(options, id: \.id) { option in
            Button { choose(option.id) } label: { ConfigurationChoiceRow(title: option.label, detail: option.description_, selected: selection == option.id) }.foregroundStyle(.primary).accessibilityIdentifier("configurationOption.\(option.id)")
        }
        if options.isEmpty { Text("暂无可选择的\(title)").foregroundStyle(.secondary) }
    }
}

/// One provider's models in a conversation that can continue on other providers.
private struct ModelProvider: Identifiable {
    let id: String
    let name: String
    let models: [ModelInfo]
    var isCurrent = false
}

private struct ModelOptions: View {
    let catalog: [ModelInfo]
    let selection: String?
    var inlineList = false
    /// Non-empty groups the models by provider; `catalog` belongs to the one marked current.
    var providers: [ModelProvider] = []
    var switchTo: (String, String) -> Void = { _, _ in }
    let choose: (String) -> Void
    @State private var query = ""
    var body: some View {
        if inlineList { ModelParameterSection(catalog: catalog, selection: selection, choose: choose) }
        Section("模型") {
            if inlineList && providers.isEmpty {
                TextField("搜索模型或型号", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityLabel("搜索模型")
                ForEach(catalog.filter { query.isEmpty || ($0.name + " " + $0.value).localizedCaseInsensitiveContains(query) }, id: \.value) { model in
                    Button { choose(selectionForModel(catalog: catalog, model: model.value)) } label: {
                        ConfigurationChoiceRow(title: cleanLabel(value: model.name), detail: nil, selected: resolveModelSelection(catalog: catalog, selection: selection).model == model.value)
                    }.foregroundStyle(.primary).accessibilityIdentifier("sessionModelChoice.\(model.value)")
                }
            } else if inlineList {
                TextField("搜索模型或型号", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityLabel("搜索模型")
            } else { NavigationLink {
                ModelSelectionList(catalog: catalog, selection: selection, providers: providers, switchTo: switchTo, choose: choose)
            } label: { Text(selection?.isEmpty == false ? modelSelectionSummary(catalog: catalog, selection: selection) : String(localized: "选择模型", bundle: .riffet)).fixedSize(horizontal: false, vertical: true) }
            .disabled(catalog.isEmpty) }
            if catalog.isEmpty { Text("Agent 尚未提供可选择的模型，请重试读取。").font(.footnote).foregroundStyle(.secondary) }
            if let selection, !selection.isEmpty, !catalog.contains(where: { $0.value == resolveModelSelection(catalog: catalog, selection: selection).model }) {
                Text("当前保存的模型不在目录中：\(selection)").font(.footnote).foregroundStyle(.secondary)
            }
        }
        if inlineList && !providers.isEmpty {
            ForEach(providers) { provider in
                Section(provider.name) {
                    ProviderModelRows(provider: provider, query: query, selection: selection, switchTo: switchTo, choose: choose, dismisses: false)
                }
            }
        }
        if !inlineList { ModelParameterSection(catalog: catalog, selection: selection, choose: choose) }
    }
}

private struct ModelSelectionList: View {
    let catalog: [ModelInfo]
    let selection: String?
    var providers: [ModelProvider] = []
    var switchTo: (String, String) -> Void = { _, _ in }
    let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    private var groups: [ModelProvider] { providers.isEmpty ? [ModelProvider(id: "", name: "", models: catalog, isCurrent: true)] : providers }
    var body: some View {
        List {
            ForEach(groups) { provider in
                Section { ProviderModelRows(provider: provider, query: query, selection: selection, switchTo: switchTo, choose: choose, dismisses: true) }
                header: { if !providers.isEmpty { Text(provider.name) } }
            }
            if groups.allSatisfy({ $0.models.allSatisfy { !(query.isEmpty || ($0.name + " " + $0.value).localizedCaseInsensitiveContains(query)) } }) { ContentUnavailableView.search(text: query) }
        }.navigationTitle(String(localized: "选择模型", bundle: .riffet)).navigationBarTitleDisplayMode(.inline).searchable(text: $query, prompt: String(localized: "搜索模型或型号", bundle: .riffet))
    }
}

/// Model rows of one provider; picking another provider's model switches the conversation to it.
private struct ProviderModelRows: View {
    let provider: ModelProvider
    let query: String
    let selection: String?
    let switchTo: (String, String) -> Void
    let choose: (String) -> Void
    let dismisses: Bool
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ForEach(provider.models.filter { query.isEmpty || ($0.name + " " + $0.value).localizedCaseInsensitiveContains(query) }, id: \.value) { model in
            Button {
                let value = selectionForModel(catalog: provider.models, model: model.value)
                if provider.isCurrent { choose(value) } else { switchTo(provider.id, value) }
                if dismisses { dismiss() }
            } label: {
                ConfigurationChoiceRow(title: cleanLabel(value: model.name), detail: nil, selected: provider.isCurrent && resolveModelSelection(catalog: provider.models, selection: selection).model == model.value)
            }.foregroundStyle(.primary).accessibilityIdentifier("sessionModelChoice.\(provider.id).\(model.value)")
        }
    }
}

private struct ModelParameterSection: View {
    let catalog: [ModelInfo]
    let selection: String?
    let choose: (String) -> Void
    @State private var contextFallback: [String: String] = [:]
    private var resolved: ParsedSelection { resolveModelSelection(catalog: catalog, selection: selection) }
    private var params: [ModelParam_] { catalogParams(catalog: catalog, model: resolved.model, overrides: resolved.params) }
    var body: some View {
        if !params.isEmpty { Section("模型参数") {
            ForEach(params, id: \.id) { param in
                let kind = paramKind(param: param)
                if kind == .toggle || kind == .fast || kind == .max {
                    Toggle(isOn: Binding(get: { isOn(param: param) }, set: { on in
                        if kind == .max && on && !isOn(param: param) { contextFallback[resolved.model] = param.value }
                        apply(param, toggledValue(param: param, on: on, fallback: contextFallback[resolved.model]))
                    })) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(parameterTitle(param))
                            let hint = paramHint(param: param)
                            if !hint.isEmpty { Text(parameterHint(param, hint: hint)).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    .accessibilityIdentifier("modelParameter.\(param.id)")
                    if kind == .max && !isOn(param: param) && contextChoices(param: param).count > 1 {
                        Picker("上下文窗口", selection: Binding(get: { param.value }, set: { apply(param, $0) })) { ForEach(contextChoices(param: param), id: \.value) { option in Text(option.label).tag(option.value) } }.pickerStyle(.navigationLink)
                    }
                } else {
                    Picker(parameterTitle(param), selection: Binding(get: { param.value }, set: { apply(param, $0) })) {
                        ForEach(listValues(param: param), id: \.value) { option in Text(optionLabel(param: param, value: option.value)).tag(option.value) }
                    }.pickerStyle(.navigationLink).accessibilityIdentifier("modelParameter.\(param.id)")
                }
            }
        } }
    }
    private func apply(_ param: ModelParam_, _ value: String) { choose(selectionWithParam(catalog: catalog, currentSelection: selection ?? resolved.model, paramId: param.id, value: value)) }
    private func parameterTitle(_ param: ModelParam_) -> String {
        switch paramKind(param: param) { case .effort: String(localized: "思考程度", bundle: .riffet); case .fast: String(localized: "快速响应", bundle: .riffet); case .max: String(localized: "MAX 模式", bundle: .riffet); case .toggle: param.id == "thinking" ? String(localized: "思考", bundle: .riffet) : paramTitle(param: param); default: paramTitle(param: param) }
    }
    private func parameterHint(_ param: ModelParam_, hint: String) -> String {
        if paramKind(param: param) == .fast { return String(localized: "响应更快，用量更高", bundle: .riffet) }
        if param.id == "thinking" { return String(localized: "回复前进行推理", bundle: .riffet) }
        return hint
    }
}
