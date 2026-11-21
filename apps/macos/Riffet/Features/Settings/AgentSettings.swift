import SwiftUI
import RiffetKit

/// Agent defaults and launch settings, or the selected Agent's model providers.
/// Both panes keep the existing profile identities and their distinct launch configuration.
struct AgentSettings: View {
    var providersOnly = false
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @AppStorage(PreferenceKey.settingsSection) private var sectionID = SettingsSection.agents.rawValue

    /// The wire id of the Agent on show.
    @State private var backend = ""
    @State private var profiles: [NativeBackendProfileSettings] = []
    /// Each Agent's last list, shown at once when it is picked again while a fresh one loads.
    @State private var profileCache: [String: [NativeBackendProfileSettings]] = [:]
    @State private var plugins: [PluginDescriptor] = []
    @State private var loading = false
    @State private var loadError: String?
    /// The backends list (capabilities, models) is being read; a missing entry after that means the
    /// Agent is unavailable rather than still loading.
    @State private var backendsLoading = true
    @State private var saving = false
    @State private var error: String?
    /// The server's answer for the Agent on show; nil until read, and for an Agent that cannot observe commands.
    @State private var observation: String?
    @State private var trusting = false
    @State private var editor: ProviderSelection?

    /// The default provider's catalog; a different provider never reuses its model parameters.
    @State private var modelCatalog: [ModelInfo] = []
    @State private var modelCatalogKey: String?
    @State private var modelCatalogDefault: String?
    @State private var modelCatalogLoading = false
    @State private var modelCatalogError: String?
    /// The model just picked, shown until the saved settings carry it.
    @State private var pendingModel: String?

    @State private var showProjectConfigs = false
    @State private var refreshedAt = Date.distantPast

    private struct ProviderSelection: Identifiable {
        let id: String
        let profile: NativeBackendProfileSettings?
    }

    /// The Agents the server offers; before the list is read, the built-in ones that are not a plugin's.
    private func agents(_ workbench: Workbench) -> [String] {
        let listed = workbench.backends.filter(\.isPickable).map(\.agent)
        return listed.isEmpty ? AgentDirectory.builtinOrder.filter { $0 != "cursor" } : listed
    }

    private func renderer(_ workbench: Workbench) -> PluginAgentRenderer? {
        PluginAgentRegistry.renderer(for: backend, plugins: plugins.isEmpty ? PluginsStore.shared.items : plugins)
    }

    var body: some View {
        if let workbench = model.workbench {
            form(workbench)
        } else {
            NeedsServerView()
        }
    }

    private func form(_ workbench: Workbench) -> some View {
        let settings = workbench.settings
        let renderer = renderer(workbench)
        return Form {
            if !providersOnly {
                Section {
                    Picker("默认 Agent", selection: defaultAgentBinding(workbench, settings: settings)) {
                        ForEach(agents(workbench), id: \.self) { Text(backendTitle($0)).tag($0) }
                    }
                    .formPicker()
                    .disabled(saving)
                }
            }

            Section {
                agentTabs(workbench)
            }

            if providersOnly {
                providerSection(workbench, settings: settings, renderer: renderer)
            } else {
                startupSection(workbench, settings: settings)
                advancedLaunchSection(workbench)
                Section {
                    renderer?.links?(workbench)
                    SettingsNavigationRow(title: String(localized: "项目配置")) { showProjectConfigs = true }
                }
            }
            SettingsScopeFooter()
        }
        .riffetForm()
        .task { await bootstrap(workbench) }
        .task(id: backend) { await loadProfiles(workbench) }
        .task(id: modelCatalogScope(workbench)) { await loadModelCatalog(workbench) }
        .task(id: backend) { await loadObservation(workbench) }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == (providersOnly ? SettingsSection.modelProviders.rawValue : SettingsSection.agents.rawValue),
                  Date.now.timeIntervalSince(refreshedAt) > 30 else { return }
            Task { await refresh(workbench) }
        }
        .sheet(item: $editor) { selection in
            if let builtin = builtinBackend(backend) {
                AgentProviderEditor(
                    workbench: workbench,
                    backend: builtin,
                    profile: selection.profile,
                    plugins: plugins,
                    isDefault: selection.profile.map { defaultProfileId(settings) == $0.id } ?? false,
                    launchSettings: !providersOnly
                ) {
                    Task { await reloadAfterEditor(workbench) }
                }
            }
        }
        .sheet(isPresented: $showProjectConfigs, onDismiss: {
            if sectionID == SettingsSection.projectConfigs.rawValue { sectionID = SettingsSection.agents.rawValue }
        }) {
            ProjectConfigSheet()
        }
        .onAppear { openRequestedProjectConfigs() }
        .onChange(of: sectionID) { _, _ in openRequestedProjectConfigs() }
    }

    /// A link to `section=projectConfigs` opens the editor over this pane.
    private func openRequestedProjectConfigs() {
        if sectionID == SettingsSection.projectConfigs.rawValue, !showProjectConfigs { showProjectConfigs = true }
    }

    // MARK: - Providers

    @ViewBuilder
    private func providerSection(_ workbench: Workbench, settings: AppSettings?, renderer: PluginAgentRenderer?) -> some View {
        if let providers = renderer?.providers {
            SettingsBlock("提供商") {
                providers(workbench)
            }
        } else if builtinBackend(backend) != nil {
            SettingsBlock("提供商") {
                if let loadError {
                    SettingsCallout(
                        .danger,
                        message: loadError,
                        actionTitle: String(localized: "重试"),
                        action: { Task { await loadProfiles(workbench) } }
                    )
                } else if profiles.isEmpty {
                    if loading {
                        HStack(spacing: Space.sm) {
                            Spinner(size: .small)
                            Text("读取中…")
                                .font(.riffet(size: S(12)))
                                .foregroundStyle(palette.fg3)
                        }
                    } else {
                        Text("还没有提供商")
                            .font(.riffet(size: S(12.5)))
                            .foregroundStyle(palette.fg3)
                    }
                }
                // The previous Agent's list holds the section's height, inert, until this one's lands.
                ForEach(loadError == nil ? profiles : [], id: \.id) { profile in
                    let isDefault = defaultProfileId(settings) == profile.id
                    AgentProviderRow(
                        name: profile.name,
                        summary: providerSummary(profile, plugins: plugins),
                        isDefault: isDefault,
                        missingKey: !(profile.apiEndpoint ?? "").isEmpty && profile.hasApiKey?.boolValue != true
                    ) {
                        editor = ProviderSelection(id: profile.id, profile: profile)
                    }
                    .contextMenu {
                        Button("编辑…") { editor = ProviderSelection(id: profile.id, profile: profile) }
                        if !isDefault {
                            Button("设为默认") { Task { await makeDefault(workbench, profile: profile) } }
                        }
                    }
                    .disabled(loading || saving)
                    .opacity(loading ? 0.4 : 1)
                }
                Button {
                    editor = ProviderSelection(id: "new-\(UUID().uuidString)", profile: nil)
                } label: {
                    Label("添加提供商", icon: "plus")
                        .font(.riffet(size: S(13)))
                        .foregroundStyle(palette.accent)
                }
                .buttonStyle(.plain)
                .disabled(saving || loading || loadError != nil)
            }
        }
    }

    @ViewBuilder
    private func advancedLaunchSection(_ workbench: Workbench) -> some View {
        if builtinBackend(backend) != nil, renderer(workbench)?.providers == nil {
            let profile = profiles.first { $0.id == defaultProfileId(workbench.settings) && backendWire($0.backendId) == backend }
            Section {
                SettingsNavigationRow(title: String(localized: "高级启动配置")) {
                    if let profile { editor = ProviderSelection(id: profile.id, profile: profile) }
                }
                .disabled(loading || saving || profile == nil)
                if let loadError {
                    SettingsCallout(.danger, message: loadError, actionTitle: String(localized: "重试"), action: {
                        Task { await loadProfiles(workbench) }
                    })
                }
            }
        }
    }

    // MARK: - Startup defaults

    @ViewBuilder
    private func startupSection(_ workbench: Workbench, settings: AppSettings?) -> some View {
        SettingsBlock("启动设置") {
            if !profiles.isEmpty {
                Picker("默认提供商", selection: Binding(
                    get: { defaultProfileId(settings) ?? profiles.first?.id ?? "" },
                    set: { id in
                        if let profile = profiles.first(where: { $0.id == id }) {
                            Task { await makeDefault(workbench, profile: profile) }
                        }
                    }
                )) {
                    ForEach(profiles, id: \.id) { Text($0.name).tag($0.id) }
                }
                .formPicker()
                .disabled(loading || saving)
            }

            SettingsRow(String(localized: "默认模型")) {
                if modelCatalogLoading && currentModelCatalog(workbench).isEmpty {
                    Spinner(size: .small)
                } else {
                    modelPicker(catalog: currentModelCatalog(workbench), selection: modelBinding(workbench, settings: settings), explicitSelection: pendingModel ?? settings?.defaultsFor(agent: backend)?.model, disabled: saving || loading || modelCatalogLoading)
                }
            }
            modelParameterRows(workbench, settings: settings)
            if let modelCatalogError {
                SettingsCallout(.danger, message: modelCatalogError, actionTitle: String(localized: "重试"), action: {
                    Task { await loadModelCatalog(workbench) }
                })
            }

            approvalRow(workbench, settings: settings)
            observationRow(workbench)

            if let error {
                SettingsCallout(.danger, message: error)
            }
        }
    }

    @ViewBuilder
    private func approvalRow(_ workbench: Workbench, settings: AppSettings?) -> some View {
        let title = String(localized: "\(backendTitle(backend)) 默认审批")
        let entry = workbench.backends.first { $0.agent == backend }
        let current = settings?.defaultsFor(agent: backend)?.approval ?? ""
        if let entry, entry.capabilities.supportsPermissionSelection,
           !entry.capabilities.permissions.isEmpty {
            Picker(title, selection: approvalBinding(workbench, settings: settings, current: current)) {
                Text("CLI 默认").tag("")
                ForEach(entry.capabilities.permissions, id: \.id) { option in
                    Text(option.label).tag(option.id)
                }
            }
            .formPicker()
            .disabled(saving)
        } else if entry == nil {
            SettingsRow(title) {
                if backendsLoading {
                    Spinner(size: .small)
                } else {
                    HStack(spacing: Space.sm) {
                        SettingsStatusBadge(text: String(localized: "不可用"), tint: palette.fg3)
                        Button("重试") { Task { await reloadBackends(workbench) } }
                            .controlSize(.small)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func observationRow(_ workbench: Workbench) -> some View {
        if let observation, observation != "unsupported" {
            SettingsRow(
                "记录命令改动的文件",
                detail: observation == "untrusted" ? "由 Codex 写入 ~/.codex/config.toml" : nil
            ) {
                switch observation {
                case "untrusted":
                    Button("信任") { Task { await trustObservation(workbench) } }
                        .controlSize(.small)
                        .disabled(trusting)
                case "active":
                    Text("已开启").font(.riffet(size: S(12.5))).foregroundStyle(palette.fg3)
                default:
                    Text("重启会话后生效").font(.riffet(size: S(12.5))).foregroundStyle(palette.fg3)
                }
            }
        }
    }

    private func loadObservation(_ workbench: Workbench) async {
        observation = nil
        guard let builtin = builtinBackend(backend), let api = workbench.host.api else { return }
        let requested = backend
        let state = try? await api.commandObservation(backendId: builtin)
        guard !Task.isCancelled, backend == requested else { return }
        observation = state
    }

    private func trustObservation(_ workbench: Workbench) async {
        guard let builtin = builtinBackend(backend), let api = workbench.host.api else { return }
        let requested = backend
        trusting = true
        error = nil
        defer { trusting = false }
        do {
            let state = try await api.trustCommandObservation(backendId: builtin)
            if backend == requested { observation = state }
        } catch {
            self.error = error.riffetMessage
        }
    }

    private func agentTabs(_ workbench: Workbench) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: Space.lg) {
                    ForEach(agents(workbench), id: \.self) { id in
                        UnderlineTab(title: backendTitle(id), selected: backend == id, style: DisplayPreferences.shared.style, size: RiffetTextSize.sm.size) {
                            backend = id
                        }
                        .id(id)
                        .accessibilityAddTraits(backend == id ? .isSelected : [])
                    }
                }
            }
            .scrollIndicators(.hidden)
            .frame(height: S(RiffetTextSize.sm.lineHeight) + Space.md)
            .onAppear { proxy.scrollTo(backend, anchor: .center) }
            .onChange(of: backend) { _, id in proxy.scrollTo(id, anchor: .center) }
        }
        .disabled(saving)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("配置的 Agent")
    }

    // MARK: - Model picker

    private func modelPicker(catalog: [ModelInfo], selection: Binding<String>, explicitSelection: String?, disabled: Bool) -> some View {
        let inherited = selection.wrappedValue
        let inheritedModel = resolveModelSelection(catalog: catalog, selection: inherited).model
        let selected = explicitSelection.flatMap { $0.isEmpty ? nil : resolveModelSelection(catalog: catalog, selection: $0).model } ?? ""
        return Picker("默认模型", selection: Binding(
            get: { selected },
            set: { id in
                selection.wrappedValue = id.isEmpty ? "" : id == inheritedModel && !inherited.isEmpty ? inherited : selectionForModel(catalog: catalog, model: id)
            }
        )) {
            Text("自动").tag("")
            ForEach(catalog, id: \.value) { item in
                Text(cleanLabel(value: item.name)).tag(item.value)
            }
            if !selected.isEmpty, !catalog.contains(where: { $0.value == selected }) {
                Text(selected).tag(selected)
            }
        }
        .labelsHidden()
        .formPicker()
        .disabled(disabled)
    }

    @ViewBuilder
    private func modelParameterRows(_ workbench: Workbench, settings: AppSettings?) -> some View {
        let catalog = currentModelCatalog(workbench)
        let selection = modelBinding(workbench, settings: settings)
        let parsed = resolveModelSelection(catalog: catalog, selection: selection.wrappedValue.isEmpty ? nil : selection.wrappedValue)
        let params = catalogParams(catalog: catalog, model: parsed.model, overrides: parsed.params)
        ForEach(params, id: \.id) { param in
            let title = paramTitle(param: param)
            let value = Binding(
                get: { param.value },
                set: { value in
                    selection.wrappedValue = selectionWithParam(catalog: catalog, currentSelection: selection.wrappedValue.isEmpty ? parsed.model : selection.wrappedValue, paramId: param.id, value: value)
                }
            )
            SettingsRow(title) {
                if paramKind(param: param) == .fast || paramKind(param: param) == .toggle {
                    HStack(spacing: Space.sm) {
                        if param.options.contains(where: { $0.value == "default" }) {
                            Button("自动") { value.wrappedValue = "default" }
                                .buttonStyle(.borderless)
                                .font(RiffetFont.caption)
                                .foregroundStyle(param.value == "default" ? palette.fg : palette.fg3)
                                .accessibilityAddTraits(param.value == "default" ? .isSelected : [])
                        }
                        Toggle(title, isOn: Binding(
                            get: { isOn(param: param) },
                            set: { value.wrappedValue = toggledValue(param: param, on: $0, fallback: nil) }
                        ))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                    }
                } else if compactParameter(param) {
                    FormSegmented(LocalizedStringResource(stringLiteral: title), selection: value) {
                        ForEach(listValues(param: param), id: \.value) { option in
                            Text(optionLabel(param: param, value: option.value)).tag(option.value)
                        }
                    }
                    .labelsHidden()
                    .fixedSize()
                } else {
                    Picker(title, selection: value) {
                        ForEach(listValues(param: param), id: \.value) { option in
                            Text(optionLabel(param: param, value: option.value)).tag(option.value)
                        }
                    }
                    .labelsHidden()
                    .formPicker()
                }
            }
            .disabled(saving || loading || modelCatalogLoading)
        }
    }

    /// Only short, fixed choices fit beside a settings-row title.
    private func compactParameter(_ param: ModelParam_) -> Bool {
        (2...4).contains(param.options.count) && param.options.allSatisfy { option in
            let label = optionLabel(param: param, value: option.value)
            let hasHan = label.unicodeScalars.contains { (0x3400...0x9fff).contains(Int($0.value)) }
            return hasHan ? label.count <= 4 : label.count <= 10 && !label.contains(where: \.isWhitespace)
        }
    }

    // MARK: - Load / save

    private func bootstrap(_ workbench: Workbench) async {
        refreshedAt = .now
        if let id = workbench.settings?.defaultAgent { backend = id }
        // Independent reads go out together; the models of an Agent that has no provider list come from the backends list.
        async let sources: Void = loadPlugins(workbench)
        await workbench.loadBackends()
        if backend.isEmpty { backend = agents(workbench).first ?? "" }
        backendsLoading = false
        await sources
    }

    /// A server without plugins leaves the list empty; saved sources then show their raw id.
    private func loadPlugins(_ workbench: Workbench) async {
        let api = workbench.host.api
        let loaded = try? await api?.plugins()
        guard let loaded else { return }
        PluginsStore.shared.update(loaded)
        guard loaded != plugins else { return }
        plugins = loaded
    }

    /// Shows the Agent's last list while the fresh one loads. Without one, the previous Agent's
    /// list stays dimmed under the spinner until the answer replaces it, so the block keeps its
    /// height instead of collapsing to a loading line and growing back.
    private func loadProfiles(_ workbench: Workbench) async {
        guard let builtin = builtinBackend(backend), renderer(workbench)?.providers == nil else {
            if !profiles.isEmpty { profiles = [] }
            if loading { loading = false }
            if loadError != nil { loadError = nil }
            return
        }
        guard let api = workbench.host.api else { return }
        let requestedBackend = backend
        let cached = profileCache[requestedBackend]
        if loadError != nil { loadError = nil }
        if let cached {
            if cached != profiles { profiles = cached }
        } else {
            loading = true
        }
        do {
            let loaded = try await api.backendProfiles(backendId: builtin).profiles
            guard !Task.isCancelled, backend == requestedBackend else { return }
            profileCache[requestedBackend] = loaded
            if loaded != profiles { profiles = loaded }
        } catch {
            guard !Task.isCancelled, backend == requestedBackend else { return }
            // Without a list of its own, the one on screen is another Agent's.
            if loading, !profiles.isEmpty { profiles = [] }
            loadError = error.riffetMessage
        }
        if loading { loading = false }
    }

    private func reloadAfterEditor(_ workbench: Workbench) async {
        workbench.store.invalidateBackendCatalog()
        await refresh(workbench)
    }

    /// The reads are independent of each other, so they run together; the model list waits for
    /// the backends it is read from.
    private func refresh(_ workbench: Workbench) async {
        refreshedAt = .now
        async let profilesLoaded: Void = loadProfiles(workbench)
        async let pluginsLoaded: Void = loadPlugins(workbench)
        async let backendsLoaded: Void = workbench.loadBackends()
        if let latest = try? await workbench.host.api?.settings() {
            workbench.store.applySavedSettings(settings: latest)
        }
        await backendsLoaded
        await profilesLoaded
        await pluginsLoaded
        await loadModelCatalog(workbench)
    }

    private func modelCatalogScope(_ workbench: Workbench) -> String {
        "\(backend)#\(defaultProfileId(workbench.settings) ?? "")"
    }

    private func currentModelCatalog(_ workbench: Workbench) -> [ModelInfo] {
        modelCatalogKey == modelCatalogScope(workbench) ? modelCatalog : []
    }

    /// Read the same default provider the next session will use, including its parameter catalog.
    private func loadModelCatalog(_ workbench: Workbench) async {
        guard !providersOnly, !backend.isEmpty, let api = workbench.host.api else { return }
        let requested = modelCatalogScope(workbench)
        if modelCatalogKey != requested {
            modelCatalog = []
            modelCatalogDefault = nil
            modelCatalogKey = requested
        }
        modelCatalogLoading = true
        modelCatalogError = nil
        defer { if modelCatalogScope(workbench) == requested { modelCatalogLoading = false } }
        do {
            let entry = try await api.agentCatalog(agentId: backend, profileId: defaultProfileId(workbench.settings), projectId: nil, allModels: false, global: true)
            guard !Task.isCancelled, modelCatalogScope(workbench) == requested else { return }
            modelCatalog = Array(entry.models)
            modelCatalogDefault = entry.defaultModel
            if !entry.available { modelCatalogError = entry.reason ?? String(localized: "当前不可用") }
        } catch {
            guard !Task.isCancelled, modelCatalogScope(workbench) == requested else { return }
            modelCatalogError = error.riffetMessage
        }
    }

    private func save(_ workbench: Workbench, _ body: AppSettingsUpdate) async {
        saving = true
        error = nil
        do { try await SettingsStore.save(workbench, body) } catch { self.error = error.riffetMessage }
        saving = false
    }

    private func reloadBackends(_ workbench: Workbench) async {
        backendsLoading = true
        workbench.store.invalidateBackendCatalog()
        await workbench.loadBackends()
        backendsLoading = false
    }

    /// Only this Agent's default provider; the default Agent is its own setting.
    private func makeDefault(_ workbench: Workbench, profile: NativeBackendProfileSettings) async {
        guard profile.id != defaultProfileId(workbench.settings) else { return }
        pendingModel = nil
        var map = agentDefaults(from: workbench.settings)
        let previous = map[backend]
        // A model belongs to its provider; the mode and approval are the Agent's, as `Workbench.writeDefaults` keeps them.
        let model = previous?.profileId == profile.id ? previous?.model : nil
        map[backend] = NativeBackendDefaults(profileId: profile.id, model: model, mode: previous?.mode, approval: previous?.approval, profileModels: nil)
        await save(workbench, SettingsPatch.make(agentDefaults: map))
        await workbench.loadBackends()
    }

    private func defaultAgentBinding(_ workbench: Workbench, settings: AppSettings?) -> Binding<String> {
        Binding(
            get: { settings?.defaultAgent ?? agents(workbench).first ?? "" },
            set: { next in
                guard next != settings?.defaultAgent else { return }
                Task { await save(workbench, SettingsPatch.make(defaultAgentId: next)) }
            }
        )
    }

    private func modelBinding(_ workbench: Workbench, settings: AppSettings?) -> Binding<String> {
        let profile = defaultProfileId(settings)
        let saved = settings?.defaultsFor(agent: backend)?.model
            ?? workbench.recentModel(agent: backend, profileId: profile)
            ?? (modelCatalogKey == modelCatalogScope(workbench) ? modelCatalogDefault : nil) ?? ""
        let agent = backend
        return Binding(
            get: { pendingModel ?? saved },
            set: { value in
                guard value != (pendingModel ?? settings?.defaultsFor(agent: agent)?.model) else { return }
                pendingModel = value
                Task {
                    saving = true
                    error = nil
                    do {
                        try await workbench.saveDefaults(agent: agent, profileId: profile, model: value)
                        workbench.store.invalidateBackendCatalog()
                        await workbench.loadBackends()
                    } catch {
                        self.error = error.riffetMessage
                    }
                    // A later choice may already be on its way; its own save clears it.
                    if pendingModel == value { pendingModel = nil }
                    saving = false
                }
            }
        )
    }

    private func approvalBinding(_ workbench: Workbench, settings: AppSettings?, current: String) -> Binding<String> {
        Binding(
            get: { current },
            set: { next in
                guard next != current else { return }
                var map = agentDefaults(from: settings)
                let previous = map[backend]
                map[backend] = NativeBackendDefaults(
                    profileId: previous?.profileId,
                    model: previous?.model,
                    mode: previous?.mode,
                    approval: next.isEmpty ? nil : next,
                    profileModels: nil
                )
                Task { await save(workbench, SettingsPatch.make(agentDefaults: map)) }
            }
        )
    }

    private func defaultProfileId(_ settings: AppSettings?) -> String? {
        settings?.defaultsFor(agent: backend)?.profileId
            ?? profiles.first { backendWire($0.backendId) == backend && $0.isDefault?.boolValue == true }?.id
            ?? profiles.first { backendWire($0.backendId) == backend }?.id
    }
}

/// A provider in the list: its name, where it signs in, and a chevron that opens it.
struct AgentProviderRow: View {
    let name: String
    let summary: String
    let isDefault: Bool
    let missingKey: Bool
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Space.xs) {
                        Text(name)
                            .font(.riffet(size: S(13), weight: .medium))
                            .foregroundStyle(palette.fg)
                            .lineLimit(1)
                        if isDefault {
                            SettingsStatusBadge(text: String(localized: "默认"), tint: palette.success)
                        }
                    }
                    Text(summary)
                        .font(.riffet(size: S(11.5)))
                        .foregroundStyle(palette.fg3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: Space.sm)
                if missingKey {
                    SettingsStatusBadge(text: String(localized: "未配置 Key"), tint: palette.warning)
                }
                Image(icon: "chevron.right")
                    .font(.riffet(size: S(10), weight: .semibold))
                    .foregroundStyle(palette.fg4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A row that opens another page or sheet.
struct SettingsNavigationRow: View {
    let title: String
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                Text(title)
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(palette.fg)
                Spacer(minLength: Space.sm)
                Image(icon: "chevron.right")
                    .font(.riffet(size: S(10), weight: .semibold))
                    .foregroundStyle(palette.fg4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The project configuration editor at a size its file list and editor need.
private struct ProjectConfigSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.sm) {
                Text("项目配置")
                    .font(.riffet(size: S(16), weight: .semibold))
                    .foregroundStyle(palette.fg)
                Spacer(minLength: Space.sm)
                Button("完成") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
            Divider()
            ProjectConfigSettings()
        }
        // Within the settings window's minimum size, so the sheet never overhangs it.
        .frame(minWidth: 760, idealWidth: 900, minHeight: 520, idealHeight: 580)
    }
}
