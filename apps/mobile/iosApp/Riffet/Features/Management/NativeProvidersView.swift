import SwiftUI
import RiffetKit

/// The wire APIs pi can speak, in the order the editor offers them.
private let nativeApiProtocols: [(id: String, label: String)] = [
    ("openai-completions", "OpenAI Chat Completions"),
    ("openai-responses", "OpenAI Responses"),
    ("anthropic-messages", "Anthropic Messages"),
    ("google-generative-ai", "Google Gemini"),
]

private enum ProfileEditTarget: Identifiable {
    case new
    case edit(NativeBackendProfileSettings)
    var id: String { if case .edit(let profile) = self { profile.id } else { "new" } }
    var profile: NativeBackendProfileSettings? { if case .edit(let profile) = self { profile } else { nil } }
}

struct NativeProvidersView: View {
    let workbench: Workbench
    let agentSettings: Bool
    @Environment(\.palette) private var palette
    @State private var backend: NativeBackendId = .cursor
    @State private var profiles: [NativeBackendProfileSettings] = []
    @State private var loading = false
    @State private var error: String?
    @State private var actionError: String?
    @State private var editing: ProfileEditTarget?
    @State private var gateway = false
    @State private var capabilities: NativeBackendCapabilities?
    init(workbench: Workbench, agentSettings: Bool = false) {
        self.workbench = workbench
        self.agentSettings = agentSettings
        // Opens on the agent new tasks use: the one the reader most likely came to adjust.
        let preferred = workbench.settings?.defaultBackendId
        _backend = State(initialValue: preferred.flatMap { managementBackends.contains($0) ? $0 : nil } ?? .cursor)
    }
    private var currentCapabilities: NativeBackendCapabilities? { capabilities?.backendId == backend ? capabilities : nil }
    private var currentProfiles: [NativeBackendProfileSettings] { profiles.filter { $0.backendId == backend } }
    private var defaultProfileId: String? { workbench.settings?.nativeBackendDefaults?[backend]?.profileId }
    private var selectedProfile: NativeBackendProfileSettings? {
        let id = defaultProfileId ?? currentProfiles.first { $0.isDefault?.boolValue == true }?.id ?? currentProfiles.first?.id
        return currentProfiles.first { $0.id == id }
    }
    var body: some View {
        let displayedBackend = backend
        RiffetList {
            if agentSettings {
                Section {
                    RiffetPickerRow(title: String(localized: "默认 Agent", bundle: .riffet), options: managementBackends.map { .init(id: $0, title: managementBackendName($0, workbench)) }, selection: Binding(get: { workbench.settings?.defaultBackendId ?? managementBackends[0] }, set: { next in Task { await saveDefaultAgent(next) } }))
                }
            }
            RiffetViewTabs(items: managementBackends.map { .init(value: $0, title: managementBackendName($0, workbench)) }, selection: $backend)
                .listRowInsets(EdgeInsets()).listRowBackground(Color.clear).listRowSeparator(.hidden)
            if agentSettings {
                AgentLaunchDefaults(workbench: workbench, backend: backend, profiles: currentProfiles, saveProvider: { id in await saveDefaultProfile(id, backend: displayedBackend) }).id(backend)
            }
            if agentSettings, let capabilities = currentCapabilities, capabilities.supportsPermissionSelection {
                Section {
                    RiffetPickerRow(title: String(localized: "默认审批模式", bundle: .riffet), options: [.init(id: "", title: String(localized: "CLI 默认", bundle: .riffet))] + capabilities.permissions.map { .init(id: $0.id, title: $0.label) }, selection: Binding(get: { workbench.settings?.nativeBackendDefaults?[capabilities.backendId]?.approval ?? "" }, set: { next in Task { await saveApproval(next, backend: capabilities.backendId) } }))
                } footer: { Text("已有会话保持原配置") }
            }
            if backend == .cursor {
                Section {
                    Button { gateway = true } label: {
                        SettingsRowLabel(title: (agentSettings ? String(localized: "高级启动配置", bundle: .riffet) : String(localized: "网关", bundle: .riffet)), symbol: agentSettings ? "terminal" : "network",
                                         value: workbench.settings?.cursorCli?.apiEndpoint.flatMap { $0.isEmpty ? nil : (URL(string: $0)?.host ?? $0) })
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            } else if agentSettings, let selectedProfile {
                Section {
                    Button { editing = .edit(selectedProfile) } label: {
                        SettingsRowLabel(title: String(localized: "高级启动配置", bundle: .riffet), symbol: "terminal", value: nil).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            } else if !agentSettings && error == nil {
                Section { providerRows } header: { RiffetSectionTitle(String(localized: "提供商", bundle: .riffet)) }
            }
            if let error { RiffetNotice.section(.error, error, actionTitle: String(localized: "重试", bundle: .riffet)) { Task { await load() } } }
            else { RiffetNotice.section(.error, actionError) }
        }
        .overlay {
            if backend != .cursor && error == nil {
                if loading { ProgressView() }
                else if currentProfiles.isEmpty {
                    ContentUnavailableView {
                        Label("还没有提供商", systemImage: "key")
                    } actions: {
                        if agentSettings { NavigationLink("模型提供商") { NativeProvidersView(workbench: workbench) } }
                        else { Button("添加提供商") { editing = .new } }
                    }
                }
            }
        }
        .navigationTitle(agentSettings ? String(localized: "Agent", bundle: .riffet) : String(localized: "模型提供商", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if backend != .cursor && !agentSettings {
                    Button { editing = .new } label: { Image(systemName: "plus") }.accessibilityLabel("添加提供商")
                }
            }
        }
        .task(id: backend) { actionError = nil; await load() }
        .refreshable { if backend == .cursor { workbench.refresh() } else { await load() } }
        .sheet(item: $editing) { target in
            NativeProfileEditor(workbench: workbench, backend: target.profile?.backendId ?? backend, profile: target.profile, capabilities: currentCapabilities, launchOnly: agentSettings) { Task { await load() } }
        }
        .sheet(isPresented: $gateway) { NativeCursorGateway(workbench: workbench, launchOnly: agentSettings) }
    }
    @ViewBuilder private var providerRows: some View {
        ForEach(currentProfiles, id: \.id) { profile in
            Button { editing = .edit(profile) } label: { providerLabel(profile).contentShape(Rectangle()) }
                .buttonStyle(.plain)
        }
    }
    private func providerLabel(_ profile: NativeBackendProfileSettings) -> some View {
        let endpoint = profile.apiEndpoint ?? ""
        let hasEndpoint = !endpoint.isEmpty
        let subtitle = hasEndpoint ? (URL(string: endpoint)?.host ?? endpoint) : String(localized: "CLI 登录", bundle: .riffet)
        return HStack(spacing: 12) {
            SettingsIcon(symbol: hasEndpoint || profile.hasApiKey?.boolValue == true ? "key" : "terminal")
            VStack(alignment: .leading, spacing: 2) {
                Text(profile.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                Text(subtitle).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
            }
            Spacer(minLength: 8)
            if defaultProfileId == profile.id { Text("默认").riffetFont(.caption).foregroundStyle(palette.accent) }
        }
    }
    private func load() async {
        guard let api = workbench.api else { return }
        let requested = backend
        error = nil; profiles = []; capabilities = nil; loading = true
        defer { if backend == requested { loading = false } }
        do {
            let offered = try await api.backends()
            try Task.checkCancellation()
            guard backend == requested else { return }
            capabilities = offered.first { $0.backendId == requested }?.capabilities
            // Cursor keeps one gateway in the server settings, not a provider list.
            if requested == .cursor { return }
            let result = try await api.backendProfiles(backendId: requested)
            try Task.checkCancellation()
            guard backend == requested else { return }
            profiles = result.profiles
        } catch is CancellationError {} catch {
            if backend == requested && !Task.isCancelled { self.error = error.riffetMessage }
        }
    }
    private func saveDefaultProfile(_ profileId: String, backend requested: NativeBackendId) async {
        guard backend == requested, currentProfiles.contains(where: { $0.id == profileId }), let api = workbench.api else { return }
        do {
            var defaults = workbench.settings?.nativeBackendDefaults ?? [:]
            defaults[requested] = selectDefaultProfile(current: defaults[requested], profileId: profileId)
            let saved = try await api.updateSettings(body: managementSettingsPatch(defaults: defaults))
            workbench.store.applySavedSettings(settings: saved)
            if backend == requested { actionError = nil }
        } catch { if backend == requested { actionError = error.riffetMessage } }
    }
    private func saveApproval(_ approval: String, backend requested: NativeBackendId) async {
        guard backend == requested, let capabilities = currentCapabilities,
              approval.isEmpty || capabilities.permissions.contains(where: { $0.id == approval }), let api = workbench.api else { return }
        do {
            var defaults = workbench.settings?.nativeBackendDefaults ?? [:]
            let old = defaults[requested]
            defaults[requested] = NativeBackendDefaults(profileId: old?.profileId, model: old?.model, mode: old?.mode, approval: approval.isEmpty ? nil : approval, profileModels: nil)
            let saved = try await api.updateSettings(body: managementSettingsPatch(defaults: defaults))
            workbench.store.applySavedSettings(settings: saved)
            if backend == requested { actionError = nil }
        } catch { if backend == requested { actionError = error.riffetMessage } }
    }
    private func saveDefaultAgent(_ next: NativeBackendId) async {
        do {
            guard let api = workbench.api else { return }
            let saved = try await api.updateSettings(body: managementSettingsPatch(defaultBackend: next))
            workbench.store.applySavedSettings(settings: saved); actionError = nil
        } catch { actionError = error.riffetMessage }
    }
}

/// These defaults are consumed by NewSessionDraft; model parameters use the existing selector string.
private struct AgentLaunchDefaults: View {
    let workbench: Workbench
    let backend: NativeBackendId
    let profiles: [NativeBackendProfileSettings]
    let saveProvider: (String) async -> Void
    @State private var catalog: NativeBackendCatalogEntry?
    @State private var catalogProfile: String?
    @State private var error: String?
    @State private var saving = false
    @State private var loading = false
    @State private var retry = 0
    private var defaults: NativeBackendDefaults? { workbench.settings?.nativeBackendDefaults?[backend] }
    private var profileId: String { defaults?.profileId ?? profiles.first { $0.isDefault?.boolValue == true }?.id ?? profiles.first?.id ?? "default" }
    private var effectiveCatalog: NativeBackendCatalogEntry? { catalogProfile == profileId ? catalog : nil }
    private var selection: String? {
        guard let catalog = effectiveCatalog else { return defaults?.model }
        return NewSessionDraft(profileId: profileId, model: nil, mode: nil, approval: nil).resolve(catalog: catalog, saved: defaults, cursorModel: workbench.settings?.defaultModel, listed: nil).model
    }
    private var explicitModelId: String {
        guard let value = defaults?.model else { return "" }
        return resolveModelSelection(catalog: effectiveCatalog?.models ?? [], selection: value).model
    }
    private var modelChoices: [RiffetPickerOption<String>] {
        let models = effectiveCatalog?.models ?? []
        var options: [RiffetPickerOption<String>] = [.init(id: "", title: String(localized: "自动", bundle: .riffet))]
        options += models.map { .init(id: $0.value, title: cleanLabel(value: $0.name)) }
        if !explicitModelId.isEmpty && !models.contains(where: { $0.value == explicitModelId }) { options.append(.init(id: explicitModelId, title: explicitModelId)) }
        return options
    }
    var body: some View {
        Group {
        Section {
            if !profiles.isEmpty {
                RiffetPickerRow(title: String(localized: "默认提供商", bundle: .riffet), options: profiles.map { .init(id: $0.id, title: $0.name) }, selection: Binding(get: { profileId }, set: { next in Task { guard !saving else { return }; saving = true; await saveProvider(next); saving = false } }))
            }
            RiffetPickerRow(title: String(localized: "默认模型", bundle: .riffet), options: modelChoices, selection: Binding(get: { explicitModelId }, set: { next in
                guard let catalog = effectiveCatalog else { return }
                let requestedProfile = profileId
                let value = selectionForDefaultModel(catalog: catalog.models, currentSelection: selection, model: next)
                Task { await saveModel(value, profile: requestedProfile) }
            })).disabled(loading || effectiveCatalog?.capabilities.supportsModelSelection != true)
        } header: { RiffetSectionTitle(String(localized: "启动设置", bundle: .riffet)) }
        .disabled(saving)
        if let catalog = effectiveCatalog, catalog.capabilities.supportsModelSelection {
            ModelParameterSection(catalog: catalog.models, selection: selection, settingsControls: true) { value in
                guard effectiveCatalog != nil else { return }
                let requestedProfile = profileId
                Task { await saveModel(value, profile: requestedProfile) }
            }.disabled(saving)
        }
        if let error { RiffetNotice.section(.error, error, actionTitle: String(localized: "重试", bundle: .riffet)) { retry += 1 } }
        }
            .task(id: "\(backend.name)#\(profileId)#\(retry)") { await load() }
    }
    private func load() async {
        guard let api = workbench.api else { return }
        let requestedProfile = profileId
        catalog = nil; catalogProfile = requestedProfile; loading = true; error = nil
        defer { if requestedProfile == profileId { loading = false } }
        do {
            let result = try await api.backendCatalog(backendId: backend, profileId: requestedProfile, projectId: nil, allModels: false, global: true)
            guard requestedProfile == profileId, !Task.isCancelled else { return }
            catalog = result; error = result.available ? nil : result.reason
        } catch { if requestedProfile == profileId && !Task.isCancelled { self.error = error.riffetMessage } }
    }
    private func saveModel(_ value: String?, profile: String) async {
        guard !saving, profile == profileId, let api = workbench.api else { return }
        saving = true; defer { saving = false }
        do {
            var defaults = workbench.settings?.nativeBackendDefaults ?? [:]
            let old = defaults[backend]
            defaults[backend] = NativeBackendDefaults(profileId: profile, model: value, mode: old?.mode, approval: old?.approval, profileModels: nil)
            let saved = try await api.updateSettings(body: managementSettingsPatch(defaults: defaults))
            workbench.store.applySavedSettings(settings: saved); error = nil
        } catch { self.error = error.riffetMessage }
    }
}

private struct NativeProfileEditor: View {
    let workbench: Workbench
    let backend: NativeBackendId
    let profile: NativeBackendProfileSettings?
    var capabilities: NativeBackendCapabilities? = nil
    var launchOnly = false
    let saved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var name = ""
    @State private var endpoint = ""
    @State private var apiProtocol = "openai-completions"
    @State private var key = ""
    @State private var keyCleared = false
    @State private var source = "login"
    @State private var sources: [ModelSourceDescriptor] = []
    @State private var availableSources: Set<String> = []
    @State private var sourcesLoaded = false
    @State private var sourceReplaced = false
    @State private var usage: NativeBackendUsage?
    @State private var quotaLoading = false
    @State private var quotaError: String?
    @State private var executable = ""
    @State private var configDir = ""
    @State private var sourceDir = ""
    @State private var autoUpdateOff = false
    @State private var defaultModel = ""
    @State private var allModels = true
    @State private var enabled: Set<String> = []
    @State private var models: [ModelInfo] = []
    @State private var manualModel = ""
    @State private var projectID = ""
    @State private var busy = false
    /// Which model-list request is running: false the server catalog, true the endpoint probe.
    @State private var probing: Bool?
    @State private var error: String?
    @State private var confirmDelete = false
    @State private var confirmClearKey = false
    @State private var initialized = false
    private var allowsEndpoint: Bool { backend != .droid && backend != .traex }
    private var profileFields: NativeBackendProfileFields? {
        (capabilities ?? workbench.backends.first { $0.backendId == backend }?.capabilities)?.profileFields
    }
    private var executablePlaceholder: String {
        profileFields?.executablePlaceholder ?? (backend == .antigravity ? "agy" : backend.name.lowercased())
    }
    private var showsConfigDir: Bool {
        if let fields = profileFields { return fields.configDir?.boolValue == true }
        return backend != .droid && backend != .antigravity
    }
    private var sourceDirKind: String? {
        if let fields = profileFields { return fields.sourceDir }
        if backend == .dsh { return "source" }
        if backend == .antigravity { return "config" }
        return nil
    }
    private var showsAutoUpdate: Bool {
        if let fields = profileFields { return fields.disableAutoUpdate?.boolValue == true }
        return backend == .claude || backend == .antigravity
    }
    private var dirty: Bool {
        modelSource != profile?.modelSource || name != (profile?.name ?? "") || endpoint != (profile?.apiEndpoint ?? "") || !key.isEmpty
        || executable != (profile?.executable ?? "") || configDir != (profile?.configDir ?? "") || sourceDir != (profile?.sourceDir ?? "")
        || defaultModel != (profile?.defaultModel ?? "") || autoUpdateOff != (profile?.disableAutoUpdate?.boolValue == true)
        || allModels != (profile?.enabledModels == nil) || (!allModels && enabled != Set(profile?.enabledModels ?? []))
        || (backend == .pi && apiProtocol != (profile?.apiProtocol ?? "openai-completions"))
    }
    private var modelSource: String? { source == "login" || source == "api" ? nil : source }
    private var adapter: Bool { sources.first { $0.id == source }?.role == "adapter" }
    private var apiConnection: Bool { source == "api" || adapter }
    private var sourceEntry: ModelSourceDescriptor? { sources.first { $0.id == source } }
    private var connectionSelection: Binding<String> { Binding(get: { apiConnection ? "api" : source }, set: { next in
        guard next != (apiConnection ? "api" : source) else { return }
        sourceReplaced = true; source = next; endpoint = ""; key = ""; keyCleared = true; defaultModel = ""; enabled = []; allModels = true; models = []
    }) }
    private var hasSavedKey: Bool { profile?.hasApiKey?.boolValue == true && !keyCleared }
    private var isDefaultProfile: Bool {
        guard let profile else { return false }
        if let selected = workbench.settings?.nativeBackendDefaults?[backend]?.profileId { return selected == profile.id }
        return profile.isDefault?.boolValue == true
    }
    private var manualIds: [String] { enabled.sorted().filter { id in !models.contains { $0.value == id } } }
    private var projectOptions: [RiffetPickerOption<String>] {
        [.init(id: "", title: String(localized: "选择项目", bundle: .riffet))] + workbench.projects.map { .init(id: $0.id, title: $0.name) }
    }
    var body: some View {
        RiffetEditPage(title: launchOnly ? String(localized: "高级启动配置", bundle: .riffet) : profile == nil ? String(localized: "添加提供商", bundle: .riffet) : String(localized: "编辑提供商", bundle: .riffet),
                       dirty: dirty, canSave: !name.trimmingCharacters(in: .whitespaces).isEmpty && (source != "api" || !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty), save: { await save() }) {
            Group {
                if launchOnly { launchFields } else { fields }
                if !launchOnly && (profile != nil || (allowsEndpoint && !endpoint.isEmpty) || !workbench.projects.isEmpty) { actions }
                if profile != nil && !launchOnly {
                    Section {
                        RiffetActionRow("删除提供商", destructive: true) { confirmDelete = true }
                    }
                }
                RiffetNotice.section(.error, error)
            }
            .disabled(busy)
        }
        .onChange(of: endpoint) { _, _ in models = [] }
        .onChange(of: apiProtocol) { _, _ in models = [] }
        .onChange(of: key) { _, _ in models = [] }
        .onChange(of: source) { _, _ in models = [] }
        .onChange(of: dirty) { _, changed in if changed { usage = nil; quotaError = nil } }
        .confirmationDialog(String(localized: "删除「\(profile?.name ?? "")」？", bundle: .riffet), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("删除", role: .destructive) { Task { await remove() } }
        } message: { Text("保存的 Key 会一并删除") }
        .confirmationDialog(String(localized: "清除已保存的 Key？", bundle: .riffet), isPresented: $confirmClearKey, titleVisibility: .visible) {
            Button("清除", role: .destructive) { Task { await clearKey() } }
        }
        .task {
            guard !initialized else { return }; initialized = true
            name = profile?.name ?? ""; endpoint = profile?.apiEndpoint ?? ""; executable = profile?.executable ?? ""; configDir = profile?.configDir ?? ""; sourceDir = profile?.sourceDir ?? ""
            autoUpdateOff = profile?.disableAutoUpdate?.boolValue == true; defaultModel = profile?.defaultModel ?? ""; allModels = profile?.enabledModels == nil; enabled = Set(profile?.enabledModels ?? [])
            apiProtocol = profile?.apiProtocol ?? "openai-completions"
            source = profile?.modelSource ?? ((profile?.apiEndpoint?.isEmpty == false) ? "api" : "login")
            if let api = workbench.api {
                do {
                    let plugins = try await api.plugins()
                    let offered = plugins.flatMap { $0.contributes.modelSources }
                    availableSources = Set(plugins.filter { $0.enabled }.flatMap { $0.contributes.modelSources }.map { $0.id })
                    let consumes = workbench.backends.first { $0.backendId == backend }?.capabilities.consumesProtocols
                    sources = offered.filter { item in
                        if let consumes, let protocols = item.protocols { return consumes.contains { protocols.contains($0) } }
                        return item.backends.contains(backend.name.lowercased())
                    }
                    sourcesLoaded = true
                } catch { self.error = error.riffetMessage }
            }
            await readUsage()
        }
    }

    @ViewBuilder private var fields: some View {
        Section { RiffetField(label: String(localized: "名称", bundle: .riffet), prompt: "", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled() }
        if allowsEndpoint {
            Section {
                RiffetPickerRow(title: String(localized: "接入方式", bundle: .riffet), options: [.init(id: "login", title: String(localized: "CLI 登录", bundle: .riffet)), .init(id: "api", title: "API")] + sources.filter { $0.role != "adapter" && availableSources.contains($0.id) }.map { .init(id: $0.id, title: $0.label) } + (modelSource != nil && !availableSources.contains(source) && !adapter ? [.init(id: source, title: source + " · " + String(localized: "不可用", bundle: .riffet))] : []), selection: connectionSelection).disabled(!sourcesLoaded)
                if apiConnection {
                    RiffetPickerRow(title: String(localized: "网关类型", bundle: .riffet), options: [.init(id: "api", title: String(localized: "通用", bundle: .riffet))] + sources.filter { $0.role == "adapter" && availableSources.contains($0.id) }.map { .init(id: $0.id, title: $0.label) } + (adapter && !availableSources.contains(source) ? [.init(id: source, title: (sourceEntry?.label ?? source) + " · " + String(localized: "不可用", bundle: .riffet))] : []), selection: $source).disabled(!sourcesLoaded)
                }
                if source != "login", sourceEntry == nil || sourceEntry?.overridable.contains("apiEndpoint") == true {
                RiffetField(label: String(localized: "地址", bundle: .riffet), prompt: sourceEntry?.defaultEndpoint ?? "https://", text: $endpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                }
                if source != "login", sourceEntry == nil || sourceEntry?.overridable.contains("apiKey") == true {
                RiffetField(label: String(localized: "API Key", bundle: .riffet), prompt: hasSavedKey ? String(localized: "已保存", bundle: .riffet) : String(localized: "未设置", bundle: .riffet), text: $key, secure: true).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                if backend == .pi, !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Picker("接口", selection: $apiProtocol) {
                        ForEach(nativeApiProtocols, id: \.id) { item in Text(item.label).tag(item.id) }
                    }
                    .pickerStyle(.menu)
                    .tint(palette.fg3)
                }
            } header: { RiffetSectionTitle(String(localized: "连接", bundle: .riffet)) } footer: { Text("Key 只发送到当前服务器，不会回显") }
        }
        Section {
            RiffetField(label: String(localized: "默认模型", bundle: .riffet), prompt: String(localized: "自动", bundle: .riffet), text: $defaultModel).textInputAutocapitalization(.never).autocorrectionDisabled()
            Toggle("提供全部模型", isOn: $allModels).tint(palette.primary)
            ForEach(models, id: \.value) { model in
                if allModels { Text(model.name).riffetFont(.body).foregroundStyle(palette.fg2) }
                else { Toggle(model.name, isOn: Binding(get: { enabled.contains(model.value) }, set: { on in if on { enabled.insert(model.value) } else { enabled.remove(model.value) } })).tint(palette.primary) }
            }
            if !allModels {
                RiffetField(prompt: String(localized: "添加模型 ID", bundle: .riffet), text: $manualModel).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.done).onSubmit { addManualModel() }
                ForEach(manualIds, id: \.self) { id in
                    Text(id).riffetFont(.body).foregroundStyle(palette.fg)
                        .swipeActions { Button("移除", role: .destructive) { enabled.remove(id) } }
                }
            }
        } header: { RiffetSectionTitle(String(localized: "模型", bundle: .riffet)) }
        if sourceEntry?.usage?.boolValue == true {
            Section {
                HStack {
                    let summary = usage?.account.map { account in accountSummary(account: account, now: platformNowMillis(), offsetOf: { KotlinLong(longLong: platformUtcOffsetMillis(epochMillis: $0.int64Value)) }) }
                    Text(verbatim: summary.flatMap { $0.isEmpty ? nil : $0 } ?? "—").riffetFont(.body).foregroundStyle(palette.fg3)
                    Spacer()
                    if quotaLoading { ProgressView() }
                }
                RiffetActionRow("刷新额度", busy: quotaLoading) { Task { await readUsage() } }.disabled(dirty || !availableSources.contains(source))
            } header: { RiffetSectionTitle(String(localized: "额度", bundle: .riffet)) }
            if let quotaError { RiffetNotice.section(.error, quotaError) }
        }

    }

    @ViewBuilder private var launchFields: some View {
        Section {
            RiffetField(label: String(localized: "CLI 路径", bundle: .riffet), prompt: executablePlaceholder, text: $executable, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled()
            if showsConfigDir { RiffetField(label: String(localized: "配置目录", bundle: .riffet), prompt: "", text: $configDir, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled() }
            if sourceDirKind == "source" { RiffetField(label: String(localized: "DSH 源码目录", bundle: .riffet), prompt: "", text: $sourceDir, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled() }
            if sourceDirKind == "config" { RiffetField(label: String(localized: "配置目录", bundle: .riffet), prompt: "", text: $sourceDir, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled() }
            if showsAutoUpdate { Toggle("关闭自动更新", isOn: $autoUpdateOff).tint(palette.primary) }
        } footer: { Text("更换配置目录会切换账号与原生历史范围") }
    }

    /// The long operations and the one-shot actions, after the fields; their progress shows in the row.
    @ViewBuilder private var actions: some View {
        if !workbench.projects.isEmpty || (allowsEndpoint && !endpoint.isEmpty) {
            Section {
                if !workbench.projects.isEmpty {
                    if projectOptions.count >= 5 {
                        RiffetPickerRow(title: String(localized: "项目", bundle: .riffet), options: projectOptions, selection: $projectID)
                    } else {
                        Picker("项目", selection: $projectID) { ForEach(projectOptions) { Text($0.title).tag($0.id) } }.pickerStyle(.menu).tint(palette.fg3)
                    }
                    RiffetActionRow("从服务器读取", busy: probing == false) { Task { await catalog(probe: false) } }
                        .disabled(projectID.isEmpty)
                }
                if allowsEndpoint && !endpoint.isEmpty {
                    RiffetActionRow("用地址与 Key 检测", busy: probing == true) { Task { await catalog(probe: true) } }
                }
            }
        }
        if profile != nil {
            Section {
                if isDefaultProfile {
                    HStack {
                        Text("默认提供商").riffetFont(.body).foregroundStyle(palette.fg)
                        Spacer(minLength: 8)
                        Image(systemName: "checkmark").riffetFont(.label, weight: .semibold).foregroundStyle(palette.accent)
                    }
                    .accessibilityAddTraits(.isSelected)
                } else {
                    RiffetActionRow("设为默认提供商") { Task { await makeDefault() } }
                }
                if allowsEndpoint && hasSavedKey {
                    RiffetActionRow("清除已保存的 Key", destructive: true) { confirmClearKey = true }
                }
            }
        }
    }
    private func addManualModel() {
        let value = manualModel.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return }
        enabled.insert(value); manualModel = ""
    }
    /// The values a catalog or probe reply was requested for; a reply for another identity is stale.
    private var catalogToken: String {
        "\(backend.name)#\(profile?.id ?? "")#\(endpoint)#\(apiProtocol)#\(projectID)#\(key)#\(keyCleared)#\(source)"
    }
    private func catalog(probe: Bool) async {
        guard let api = workbench.api else { return }
        let token = catalogToken
        busy = true; probing = probe; error = nil; defer { busy = false; probing = nil }
        do {
            let found: [ModelInfo]
            if probe { found = try await api.probeBackendModels(backendId: backend, body: ProbeBackendModelsBody(apiEndpoint: endpoint.isEmpty ? nil : endpoint, apiKey: key.isEmpty ? (keyCleared ? "" : nil) : key, profileId: profile?.id, modelSource: modelSource, apiProtocol: backend == .antigravity && !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "google-generative-ai" : backend == .pi && !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? apiProtocol : nil)) }
            else { guard !projectID.isEmpty else { return }; found = try await api.backendCatalog(backendId: backend, profileId: profile?.id, projectId: projectID, allModels: true, global: false).models }
            guard token == catalogToken else { return }
            models = found
        } catch { if token == catalogToken { self.error = error.riffetMessage } }
    }
    private func readUsage() async {
        guard !launchOnly, !dirty, sourceEntry?.usage?.boolValue == true, availableSources.contains(source), let profile, let api = workbench.api else { return }
        let token = catalogToken
        quotaLoading = true; defer { quotaLoading = false }
        do {
            let value = try await api.backendUsage(backendId: backend, projectId: nil, profileId: profile.id, sessionId: nil, global: true)
            guard token == catalogToken, !dirty else { return }
            usage = value; quotaError = nil
        } catch {
            guard token == catalogToken, !dirty else { return }
            quotaError = String(localized: "额度读取失败", bundle: .riffet)
        }
    }
    private func save() async -> Bool {
        guard let api = workbench.api else { return false }; error = nil
        let body = launchOnly ? NativeBackendProfileSettingsUpdate(
            name: profile?.name, description: nil, executable: executable, configDir: showsConfigDir ? configDir : nil,
            sourceDir: sourceDirKind != nil ? sourceDir : nil, apiEndpoint: nil, agentEndpoint: nil, disableAutoUpdate: showsAutoUpdate ? KotlinBoolean(bool: autoUpdateOff) : nil,
            defaultModel: nil, enabledModels: nil, modelInputModalities: nil, modelContextWindows: nil, apiKey: nil, modelSource: nil, apiProtocol: nil
        ) : NativeBackendProfileSettingsUpdate(name: name.trimmingCharacters(in: .whitespaces), description: nil, executable: executable, configDir: showsConfigDir ? configDir : nil,
            sourceDir: sourceDirKind != nil ? sourceDir : nil, apiEndpoint: allowsEndpoint ? endpoint.trimmingCharacters(in: .whitespaces) : nil, agentEndpoint: nil,
            disableAutoUpdate: showsAutoUpdate ? KotlinBoolean(bool: autoUpdateOff) : nil, defaultModel: defaultModel,
            enabledModels: PatchValue.shared.list(value: allModels ? nil : enabled.sorted()), modelInputModalities: sourceReplaced ? PatchValue.shared.modalities(value: nil) : nil, modelContextWindows: sourceReplaced ? PatchValue.shared.contextWindows(value: nil) : nil,
            apiKey: key.isEmpty ? (keyCleared ? PatchValue.shared.key(value: nil) : nil) : PatchValue.shared.key(value: key), modelSource: modelSource == profile?.modelSource ? nil : PatchValue.shared.key(value: modelSource),
            apiProtocol: backend == .antigravity ? PatchValue.shared.key(value: endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : "google-generative-ai") : backend == .pi && !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? PatchValue.shared.key(value: apiProtocol) : nil)
        do {
            if let profile { _ = try await api.updateBackendProfile(backendId: backend, profileId: profile.id, body: body) }
            else { _ = try await api.createBackendProfile(backendId: backend, id: UUID().uuidString.lowercased(), body: body) }
            key = ""; workbench.store.invalidateBackendCatalog(); await workbench.loadBackends(); saved()
            return true
        } catch { self.error = error.riffetMessage; return false }
    }
    /// Clears the saved Key on the server at once; the other fields stay as they are.
    private func clearKey() async {
        guard let profile, let api = workbench.api else { return }; busy = true; defer { busy = false }
        do {
            _ = try await api.updateBackendProfile(backendId: backend, profileId: profile.id, body: NativeBackendProfileSettingsUpdate(
                name: nil, description: nil, executable: nil, configDir: nil, sourceDir: nil, apiEndpoint: nil, agentEndpoint: nil, disableAutoUpdate: nil,
                defaultModel: nil, enabledModels: nil, modelInputModalities: nil, modelContextWindows: nil, apiKey: PatchValue.shared.key(value: nil), modelSource: nil, apiProtocol: nil))
            keyCleared = true; error = nil; workbench.store.invalidateBackendCatalog(); saved()
        } catch { self.error = error.riffetMessage }
    }
    private func makeDefault() async {
        guard let profile, let api = workbench.api else { return }; busy = true; defer { busy = false }
        do {
            var defaults = workbench.settings?.nativeBackendDefaults ?? [:]; let old = defaults[backend]
            defaults[backend] = selectDefaultProfile(current: old, profileId: profile.id)
            let result = try await api.updateSettings(body: managementSettingsPatch(defaults: defaults)); workbench.store.applySavedSettings(settings: result); error = nil
        } catch { self.error = error.riffetMessage }
    }
    private func remove() async {
        guard let profile, let api = workbench.api else { return }; busy = true; defer { busy = false }
        let removedDefault = isDefaultProfile
        do {
            _ = try await api.deleteBackendProfile(backendId: backend, profileId: profile.id)
            if removedDefault {
                var defaults = workbench.settings?.nativeBackendDefaults ?? [:]; let previous = defaults[backend]
                defaults[backend] = selectDefaultProfile(current: previous, profileId: nil)
                let result = try await api.updateSettings(body: managementSettingsPatch(defaults: defaults)); workbench.store.applySavedSettings(settings: result)
            }
            workbench.store.invalidateBackendCatalog(); await workbench.loadBackends(); saved(); dismiss()
        }
        catch { self.error = error.riffetMessage }
    }
}

private struct NativeCursorGateway: View {
    let workbench: Workbench
    var launchOnly = false
    @Environment(\.palette) private var palette
    @State private var saved: CursorCliSettings?
    @State private var initialized = false
    @State private var endpoint = ""
    @State private var agentEndpoint = ""
    @State private var key = ""
    @State private var keyCleared = false
    @State private var executable = ""
    @State private var configDir = ""
    @State private var autoUpdateOff = false
    @State private var busy = false
    @State private var confirmClearKey = false
    @State private var error: String?
    private var settingsReady: Bool {
        workbench.list.loaded && !workbench.list.loading && workbench.list.cachedAt == nil
            && workbench.list.error == nil && workbench.settings != nil
    }
    private var dirty: Bool {
        initialized && (endpoint != (saved?.apiEndpoint ?? "") || agentEndpoint != (saved?.agentEndpoint ?? "")
            || executable != (saved?.executable ?? "") || configDir != (saved?.configDir ?? "")
            || autoUpdateOff != (saved?.disableAutoUpdate?.boolValue == true) || !key.isEmpty)
    }
    private var hasSavedKey: Bool { workbench.settings?.cursorCli?.hasApiKey?.boolValue == true && !keyCleared }
    var body: some View {
        RiffetEditPage(title: launchOnly ? String(localized: "高级启动配置", bundle: .riffet) : String(localized: "网关", bundle: .riffet), dirty: dirty, save: { await save() }) {
            if initialized {
                Group {
                    if !launchOnly { Section {
                        RiffetField(label: String(localized: "API 地址", bundle: .riffet), prompt: String(localized: "默认", bundle: .riffet), text: $endpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        RiffetField(label: String(localized: "Agent 地址", bundle: .riffet), prompt: String(localized: "默认", bundle: .riffet), text: $agentEndpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        RiffetField(label: String(localized: "API Key", bundle: .riffet), prompt: hasSavedKey ? String(localized: "已保存", bundle: .riffet) : String(localized: "未设置", bundle: .riffet), text: $key, secure: true).textInputAutocapitalization(.never).autocorrectionDisabled()
                    } footer: { Text("重启服务器上的 Riffet 后生效") } }
                    if launchOnly { Section {
                        DisclosureGroup("CLI 启动参数") {
                            RiffetField(label: String(localized: "CLI 路径", bundle: .riffet), prompt: "", text: $executable, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled()
                            RiffetField(label: String(localized: "配置目录", bundle: .riffet), prompt: "", text: $configDir, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled()
                            Toggle("关闭自动更新", isOn: $autoUpdateOff).tint(palette.primary)
                        }
                    } header: { RiffetSectionTitle(String(localized: "高级启动配置", bundle: .riffet)) } }
                    if hasSavedKey && !launchOnly {
                        Section { RiffetActionRow("清除已保存的 Key", destructive: true) { confirmClearKey = true } }
                    }
                    RiffetNotice.section(.error, error)
                }
                .disabled(busy)
            } else if let message = workbench.list.error {
                RiffetNotice.section(.error, message, actionTitle: String(localized: "重新读取", bundle: .riffet)) { workbench.refresh() }
            } else {
                Section { HStack { Spacer(); ProgressView(); Spacer() } }.listRowBackground(Color.clear)
            }
        }
        .onChange(of: settingsReady, initial: true) { _, ready in
            if ready && !initialized { apply(workbench.settings?.cursorCli) }
        }
        .confirmationDialog(String(localized: "清除已保存的 Key？", bundle: .riffet), isPresented: $confirmClearKey, titleVisibility: .visible) {
            Button("清除", role: .destructive) { Task { await clearKey() } }
        }
    }
    private func apply(_ value: CursorCliSettings?) {
        saved = value; initialized = true
        endpoint = value?.apiEndpoint ?? ""; agentEndpoint = value?.agentEndpoint ?? ""
        executable = value?.executable ?? ""; configDir = value?.configDir ?? ""
        autoUpdateOff = value?.disableAutoUpdate?.boolValue == true
    }
    private func clearKey() async {
        guard let api = workbench.api else { return }; busy = true; defer { busy = false }
        do {
            let result = try await api.updateSettings(body: managementSettingsPatch(cursor: CursorCliSettingsUpdate(
                executable: nil, configDir: nil, apiEndpoint: nil, agentEndpoint: nil, disableAutoUpdate: nil, apiKey: PatchValue.shared.key(value: nil))))
            workbench.store.applySavedSettings(settings: result); keyCleared = true; error = nil
        } catch { self.error = error.riffetMessage }
    }
    private func save() async -> Bool {
        guard initialized, let api = workbench.api else { return false }
        do {
            let patch = CursorCliSettingsUpdate(
                executable: executable == (saved?.executable ?? "") ? nil : executable,
                configDir: configDir == (saved?.configDir ?? "") ? nil : configDir,
                apiEndpoint: endpoint == (saved?.apiEndpoint ?? "") ? nil : endpoint,
                agentEndpoint: agentEndpoint == (saved?.agentEndpoint ?? "") ? nil : agentEndpoint,
                disableAutoUpdate: autoUpdateOff == (saved?.disableAutoUpdate?.boolValue == true) ? nil : KotlinBoolean(bool: autoUpdateOff),
                apiKey: key.isEmpty ? nil : PatchValue.shared.key(value: key))
            let result = try await api.updateSettings(body: managementSettingsPatch(cursor: patch)); workbench.store.applySavedSettings(settings: result)
            key = ""; error = nil
            return true
        } catch { self.error = error.riffetMessage; return false }
    }
}
