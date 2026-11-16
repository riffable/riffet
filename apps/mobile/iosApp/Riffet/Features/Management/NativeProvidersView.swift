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
    @Environment(\.palette) private var palette
    @State private var backend: NativeBackendId = .cursor
    @State private var profiles: [NativeBackendProfileSettings] = []
    @State private var loading = false
    @State private var error: String?
    @State private var actionError: String?
    @State private var editing: ProfileEditTarget?
    @State private var gateway = false
    init(workbench: Workbench) {
        self.workbench = workbench
        // Opens on the agent new tasks use: the one the reader most likely came to adjust.
        let preferred = workbench.settings?.defaultBackendId
        _backend = State(initialValue: preferred.flatMap { managementBackends.contains($0) ? $0 : nil } ?? .cursor)
    }
    private var defaultProfileId: String? { workbench.settings?.nativeBackendDefaults?[backend]?.profileId }
    private var isDefaultAgent: Bool { workbench.settings?.defaultBackendId == backend }
    var body: some View {
        RiffetList {
            SettingsChipRow {
                RiffetMenuChip(title: managementBackendName(backend, workbench), leading: {
                    AgentMarkView(backend: backend.name, size: 14, color: agentMarkColor(backend.name, palette))
                }, items: {
                    ForEach(managementBackends, id: \.self) { item in
                        Button { backend = item } label: {
                            if item == backend { Label(managementBackendName(item, workbench), systemImage: "checkmark") } else { Text(managementBackendName(item, workbench)) }
                        }
                    }
                })
            }
            Section {
                if isDefaultAgent {
                    HStack(spacing: 8) {
                        SettingsRowLabel(title: String(localized: "新任务默认使用", bundle: .riffet), symbol: "star", value: nil)
                        Image(systemName: "checkmark").riffetFont(.label, weight: .semibold).foregroundStyle(palette.accent)
                    }
                    .accessibilityAddTraits(.isSelected)
                } else {
                    Button { Task { await makeDefault() } } label: {
                        SettingsRowLabel(title: String(localized: "设为新任务默认", bundle: .riffet), symbol: "star", value: nil)
                            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                }
            }
            if backend == .cursor {
                Section {
                    Button { gateway = true } label: {
                        SettingsRowLabel(title: String(localized: "网关", bundle: .riffet), symbol: "network",
                                         value: workbench.settings?.cursorCli?.apiEndpoint.flatMap { $0.isEmpty ? nil : (URL(string: $0)?.host ?? $0) })
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            } else if error == nil {
                Section { providerRows } header: { RiffetSectionTitle(String(localized: "提供商", bundle: .riffet)) }
            }
            if let error { RiffetNotice.section(.error, error, actionTitle: String(localized: "重试", bundle: .riffet)) { Task { await load() } } }
            else { RiffetNotice.section(.error, actionError) }
        }
        .overlay {
            if backend != .cursor && error == nil {
                if loading { ProgressView() }
                else if profiles.isEmpty {
                    ContentUnavailableView {
                        Label("还没有提供商", systemImage: "key")
                    } actions: {
                        Button("添加提供商") { editing = .new }
                    }
                }
            }
        }
        .navigationTitle(String(localized: "提供商与模型", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if backend != .cursor {
                    Button { editing = .new } label: { Image(systemName: "plus") }.accessibilityLabel("添加提供商")
                }
            }
        }
        .task(id: backend) { actionError = nil; await load() }
        .refreshable { if backend == .cursor { workbench.refresh() } else { await load() } }
        .sheet(item: $editing) { target in
            NativeProfileEditor(workbench: workbench, backend: backend, profile: target.profile) { Task { await load() } }
        }
        .sheet(isPresented: $gateway) { NativeCursorGateway(workbench: workbench) }
    }
    @ViewBuilder private var providerRows: some View {
        ForEach(profiles, id: \.id) { profile in
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
        let requested = backend; error = nil; profiles = []
        // Cursor keeps one gateway in the server settings, not a provider list.
        guard requested != .cursor else { loading = false; return }
        loading = true
        defer { if backend == requested { loading = false } }
        do { let result = try await api.backendProfiles(backendId: requested); if backend == requested { profiles = result.profiles } }
        catch { if backend == requested { self.error = error.riffetMessage } }
    }
    private func makeDefault() async {
        do {
            guard let api = workbench.api else { return }
            let saved = try await api.updateSettings(body: managementSettingsPatch(defaultBackend: backend))
            workbench.store.applySavedSettings(settings: saved); actionError = nil
        } catch { actionError = error.riffetMessage }
    }
}

private struct NativeProfileEditor: View {
    let workbench: Workbench
    let backend: NativeBackendId
    let profile: NativeBackendProfileSettings?
    let saved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var name = ""
    @State private var endpoint = ""
    @State private var apiProtocol = "openai-completions"
    @State private var key = ""
    @State private var keyCleared = false
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
    private var dirty: Bool {
        name != (profile?.name ?? "") || endpoint != (profile?.apiEndpoint ?? "") || !key.isEmpty
        || executable != (profile?.executable ?? "") || configDir != (profile?.configDir ?? "") || sourceDir != (profile?.sourceDir ?? "")
        || defaultModel != (profile?.defaultModel ?? "") || autoUpdateOff != (profile?.disableAutoUpdate?.boolValue == true)
        || allModels != (profile?.enabledModels == nil) || (!allModels && enabled != Set(profile?.enabledModels ?? []))
        || (backend == .pi && apiProtocol != (profile?.apiProtocol ?? "openai-completions"))
    }
    private var hasSavedKey: Bool { profile?.hasApiKey?.boolValue == true && !keyCleared }
    private var isDefaultProfile: Bool { workbench.settings?.nativeBackendDefaults?[backend]?.profileId == profile?.id }
    private var manualIds: [String] { enabled.sorted().filter { id in !models.contains { $0.value == id } } }
    private var projectOptions: [RiffetPickerOption<String>] {
        [.init(id: "", title: String(localized: "选择项目", bundle: .riffet))] + workbench.projects.map { .init(id: $0.id, title: $0.name) }
    }
    var body: some View {
        RiffetEditPage(title: profile == nil ? String(localized: "添加提供商", bundle: .riffet) : String(localized: "编辑提供商", bundle: .riffet),
                       dirty: dirty, canSave: !name.trimmingCharacters(in: .whitespaces).isEmpty, save: { await save() }) {
            Group {
                fields
                if profile != nil || (allowsEndpoint && !endpoint.isEmpty) || !workbench.projects.isEmpty { actions }
                if profile != nil {
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
        }
    }

    @ViewBuilder private var fields: some View {
        Section { RiffetField(label: String(localized: "名称", bundle: .riffet), prompt: "", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled() }
        if allowsEndpoint {
            Section {
                RiffetField(label: String(localized: "地址", bundle: .riffet), prompt: String(localized: "CLI 登录", bundle: .riffet), text: $endpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                RiffetField(label: String(localized: "API Key", bundle: .riffet), prompt: hasSavedKey ? String(localized: "已保存", bundle: .riffet) : String(localized: "未设置", bundle: .riffet), text: $key, secure: true).textInputAutocapitalization(.never).autocorrectionDisabled()
                if backend == .pi, !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Picker("接口", selection: $apiProtocol) {
                        ForEach(nativeApiProtocols, id: \.id) { item in Text(item.label).tag(item.id) }
                    }
                    .pickerStyle(.menu)
                }
            } header: { RiffetSectionTitle(String(localized: "连接", bundle: .riffet)) } footer: { Text("Key 只发送到当前服务器，不会回显") }
        }
        Section {
            RiffetField(label: String(localized: "默认模型", bundle: .riffet), prompt: String(localized: "自动", bundle: .riffet), text: $defaultModel).textInputAutocapitalization(.never).autocorrectionDisabled()
            Toggle("提供全部模型", isOn: $allModels)
            ForEach(models, id: \.value) { model in
                if allModels { Text(model.name).riffetFont(.body).foregroundStyle(palette.fg2) }
                else { Toggle(model.name, isOn: Binding(get: { enabled.contains(model.value) }, set: { on in if on { enabled.insert(model.value) } else { enabled.remove(model.value) } })) }
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
        Section {
            DisclosureGroup("CLI 启动参数") {
                RiffetField(label: String(localized: "CLI 路径", bundle: .riffet), prompt: "", text: $executable, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled()
                if backend != .droid && backend != .antigravity { RiffetField(label: String(localized: "配置目录", bundle: .riffet), prompt: "", text: $configDir, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled() }
                if backend == .dsh { RiffetField(label: String(localized: "DSH 源码目录", bundle: .riffet), prompt: "", text: $sourceDir, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled() }
                if backend == .claude { Toggle("关闭自动更新", isOn: $autoUpdateOff) }
            }
        } header: { RiffetSectionTitle(String(localized: "高级", bundle: .riffet)) }
    }

    /// The long operations and the one-shot actions, after the fields; their progress shows in the row.
    @ViewBuilder private var actions: some View {
        if !workbench.projects.isEmpty || (allowsEndpoint && !endpoint.isEmpty) {
            Section {
                if !workbench.projects.isEmpty {
                    if projectOptions.count >= 5 {
                        RiffetPickerRow(title: String(localized: "项目", bundle: .riffet), options: projectOptions, selection: $projectID)
                    } else {
                        Picker("项目", selection: $projectID) { ForEach(projectOptions) { Text($0.title).tag($0.id) } }.pickerStyle(.menu)
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
        "\(backend.name)#\(profile?.id ?? "")#\(endpoint)#\(apiProtocol)#\(projectID)#\(key)#\(keyCleared)"
    }
    private func catalog(probe: Bool) async {
        guard let api = workbench.api else { return }
        let token = catalogToken
        busy = true; probing = probe; error = nil; defer { busy = false; probing = nil }
        do {
            let found: [ModelInfo]
            if probe { found = try await api.probeBackendModels(backendId: backend, body: ProbeBackendModelsBody(apiEndpoint: endpoint.isEmpty ? nil : endpoint, apiKey: key.isEmpty ? (keyCleared ? "" : nil) : key, profileId: profile?.id, modelSource: profile?.modelSource, apiProtocol: backend == .antigravity && !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "google-generative-ai" : backend == .pi && !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? apiProtocol : nil)) }
            else { guard !projectID.isEmpty else { return }; found = try await api.backendCatalog(backendId: backend, profileId: profile?.id, projectId: projectID, allModels: true, global: false).models }
            guard token == catalogToken else { return }
            models = found
        } catch { if token == catalogToken { self.error = error.riffetMessage } }
    }
    private func save() async -> Bool {
        guard let api = workbench.api else { return false }; error = nil
        let body = NativeBackendProfileSettingsUpdate(name: name.trimmingCharacters(in: .whitespaces), description: nil, executable: executable, configDir: backend == .droid || backend == .antigravity ? nil : configDir,
            sourceDir: backend == .dsh ? sourceDir : nil, apiEndpoint: allowsEndpoint ? endpoint.trimmingCharacters(in: .whitespaces) : nil, agentEndpoint: nil,
            disableAutoUpdate: backend == .claude ? KotlinBoolean(bool: autoUpdateOff) : nil, defaultModel: defaultModel,
            enabledModels: PatchValue.shared.list(value: allModels ? nil : enabled.sorted()), modelInputModalities: nil, modelContextWindows: nil,
            apiKey: key.isEmpty ? nil : PatchValue.shared.key(value: key), modelSource: nil,
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
            defaults[backend] = NativeBackendDefaults(profileId: profile.id, model: old?.model, mode: old?.mode, approval: old?.approval)
            let result = try await api.updateSettings(body: managementSettingsPatch(defaults: defaults)); workbench.store.applySavedSettings(settings: result); error = nil
        } catch { self.error = error.riffetMessage }
    }
    private func remove() async {
        guard let profile, let api = workbench.api else { return }; busy = true; defer { busy = false }
        do {
            _ = try await api.deleteBackendProfile(backendId: backend, profileId: profile.id)
            if workbench.settings?.nativeBackendDefaults?[backend]?.profileId == profile.id {
                var defaults = workbench.settings?.nativeBackendDefaults ?? [:]; let previous = defaults[backend]
                defaults[backend] = NativeBackendDefaults(profileId: nil, model: previous?.model, mode: previous?.mode, approval: previous?.approval)
                let result = try await api.updateSettings(body: managementSettingsPatch(defaults: defaults)); workbench.store.applySavedSettings(settings: result)
            }
            workbench.store.invalidateBackendCatalog(); await workbench.loadBackends(); saved(); dismiss()
        }
        catch { self.error = error.riffetMessage }
    }
}

private struct NativeCursorGateway: View {
    let workbench: Workbench
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
        RiffetEditPage(title: String(localized: "网关", bundle: .riffet), dirty: dirty, save: { await save() }) {
            if initialized {
                Group {
                    Section {
                        RiffetField(label: String(localized: "API 地址", bundle: .riffet), prompt: String(localized: "默认", bundle: .riffet), text: $endpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        RiffetField(label: String(localized: "Agent 地址", bundle: .riffet), prompt: String(localized: "默认", bundle: .riffet), text: $agentEndpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        RiffetField(label: String(localized: "API Key", bundle: .riffet), prompt: hasSavedKey ? String(localized: "已保存", bundle: .riffet) : String(localized: "未设置", bundle: .riffet), text: $key, secure: true).textInputAutocapitalization(.never).autocorrectionDisabled()
                    } footer: { Text("重启服务器上的 Riffet 后生效") }
                    Section {
                        DisclosureGroup("CLI 启动参数") {
                            RiffetField(label: String(localized: "CLI 路径", bundle: .riffet), prompt: "", text: $executable, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled()
                            RiffetField(label: String(localized: "配置目录", bundle: .riffet), prompt: "", text: $configDir, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled()
                            Toggle("关闭自动更新", isOn: $autoUpdateOff)
                        }
                    } header: { RiffetSectionTitle(String(localized: "高级", bundle: .riffet)) }
                    if hasSavedKey {
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
