import SwiftUI
import RiffetKit

/// One Agent at a time: its providers and new-session defaults, then links to the project
/// configuration and to whatever its plugin adds. Every Agent has the same layout; an Agent whose
/// plugin configures it (`PluginAgentRegistry`) swaps in the plugin's providers and links. Saving
/// happens in sheets or on change, never with a page button. `section=projectConfigs` opens the
/// project configuration editor over this pane.
struct AgentSettings: View {
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

    /// The models offered for an Agent whose default model is chosen here.
    @State private var modelCatalog: [ModelInfo] = []
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
        return listed.isEmpty ? ["codex", "claude", "dsh", "droid", "traex", "pi", "antigravity"] : listed
    }

    private func renderer(_ workbench: Workbench) -> PluginAgentRenderer? {
        PluginAgentRegistry.renderer(for: backend, plugins: plugins.isEmpty ? PluginsStore.shared.items : plugins)
    }

    var body: some View {
        if let workbench = model.workbench {
            form(workbench)
        } else {
            DisconnectedSettings()
        }
    }

    private func form(_ workbench: Workbench) -> some View {
        let settings = workbench.settings
        let renderer = renderer(workbench)
        return Form {
            Section {
                AgentSegments(backends: agents(workbench), selection: backend, defaultBackend: settings?.defaultAgent) { backend = $0 }
            }

            providerSection(workbench, settings: settings, renderer: renderer)
            newSessionSection(workbench, settings: settings, renderer: renderer)

            Section {
                renderer?.links?(workbench)
                SettingsNavigationRow(title: String(localized: "项目配置")) { showProjectConfigs = true }
            }
            SettingsScopeFooter()
        }
        .riffetForm()
        .task { await bootstrap(workbench) }
        .task(id: backend) {
            await loadProfiles(workbench)
            await loadModelCatalog(workbench)
        }
        .task(id: backend) { await loadObservation(workbench) }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == SettingsSection.agents.rawValue,
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
                    isDefault: selection.profile.map { defaultProfileId(settings) == $0.id } ?? false
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
            SettingsBlock("提供商") { providers(workbench) }
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

    // MARK: - New session

    @ViewBuilder
    private func newSessionSection(_ workbench: Workbench, settings: AppSettings?, renderer: PluginAgentRenderer?) -> some View {
        SettingsBlock("新会话") {
            Picker("默认 Agent", selection: defaultAgentBinding(workbench, settings: settings)) {
                ForEach(agents(workbench), id: \.self) { Text(backendTitle($0)).tag($0) }
            }
            .formPicker()
            .disabled(saving)

            approvalRow(workbench, settings: settings)
            observationRow(workbench)

            if renderer?.choosesDefaultModelHere == true {
                SettingsRow(String(localized: "\(backendTitle(backend)) 默认模型")) {
                    modelPicker(workbench, catalog: modelCatalog, selection: modelBinding(workbench, settings: settings), disabled: saving)
                }
            }

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
        } else {
            SettingsRow(title) {
                if entry != nil {
                    Text("不支持")
                        .font(.riffet(size: S(12.5)))
                        .foregroundStyle(palette.fg3)
                } else if backendsLoading {
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

    // MARK: - Model picker

    @ViewBuilder
    private func modelPicker(_ workbench: Workbench, catalog: [ModelInfo], selection: Binding<String>, disabled: Bool) -> some View {
        HStack {
            if catalog.isEmpty {
                CommittedModelField(saved: selection.wrappedValue) { selection.wrappedValue = $0 }
                    .disabled(disabled)
            } else {
                if !selection.wrappedValue.isEmpty {
                    Button("清除") { selection.wrappedValue = "" }.disabled(disabled)
                }
                ModelControls(catalog: catalog, selection: selection.wrappedValue.isEmpty ? nil : selection.wrappedValue, scope: backend, refresh: { await loadModelCatalog(workbench, reload: true) }) {
                    selection.wrappedValue = $0
                }
                .disabled(disabled)
            }
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
        await loadModelCatalog(workbench)
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
        await loadModelCatalog(workbench)
        await profilesLoaded
        await pluginsLoaded
    }

    /// The model list of an Agent whose default model is chosen on this pane: the backends list's,
    /// else its catalog read on its own. An Agent with a provider list has no use for one here.
    private func loadModelCatalog(_ workbench: Workbench, reload: Bool = false) async {
        guard renderer(workbench)?.choosesDefaultModelHere == true else {
            if !modelCatalog.isEmpty { modelCatalog = [] }
            return
        }
        let requested = backend
        if !reload, let models = workbench.backends.first(where: { $0.agent == requested })?.models, !models.isEmpty {
            if models != modelCatalog { modelCatalog = models }
            return
        }
        let models = (try? await workbench.host.api?.agentCatalog(agentId: requested, profileId: nil, projectId: nil, allModels: true, global: true))?.models ?? []
        guard backend == requested, !models.isEmpty, models != modelCatalog else { return }
        modelCatalog = models
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
        var map = agentDefaults(from: workbench.settings)
        let previous = map[backend]
        // A model belongs to its provider; the mode and approval are the Agent's, as `Workbench.writeDefaults` keeps them.
        let model = previous?.profileId == profile.id ? previous?.model : nil
        map[backend] = NativeBackendDefaults(profileId: profile.id, model: model, mode: previous?.mode, approval: previous?.approval)
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
        let saved = settings?.defaultsFor(agent: backend)?.model ?? workbench.backends.first { $0.agent == backend }?.defaultModel ?? ""
        let agent = backend
        return Binding(
            get: { pendingModel ?? saved },
            set: { value in
                guard value != (pendingModel ?? saved) else { return }
                pendingModel = value
                Task {
                    saving = true
                    error = nil
                    do {
                        try await workbench.saveDefaults(agent: agent, model: value)
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
                    approval: next.isEmpty ? nil : next
                )
                Task { await save(workbench, SettingsPatch.make(agentDefaults: map)) }
            }
        )
    }

    private func defaultProfileId(_ settings: AppSettings?) -> String? {
        settings?.defaultsFor(agent: backend)?.profileId ?? profiles.first { $0.isDefault?.boolValue == true }?.id
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

/// The Agents as one segmented row with their marks. Titles drop to marks alone when the pane is
/// too narrow for both; the tooltip keeps the name.
private struct AgentSegments: View {
    let backends: [String]
    let selection: String
    let defaultBackend: String?
    let pick: (String) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        ViewThatFits(in: .horizontal) {
            segments(titled: true)
            segments(titled: false)
        }
    }

    private func segments(titled: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(backends, id: \.self) { id in
                let on = id == selection
                Button { pick(id) } label: {
                    HStack(spacing: 5) {
                        AgentIcon(id: id, size: 14, color: agentMarkColor(id, palette))
                        if titled {
                            Text(backendTitle(id))
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                    .font(.riffet(size: S(12.5), weight: on ? .medium : .regular))
                    .foregroundStyle(on ? palette.fg : palette.fg3)
                    .padding(.horizontal, Space.sm)
                    .frame(maxWidth: .infinity)
                    .frame(height: 26)
                    .background {
                        if on {
                            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                                .fill(palette.bgElevated)
                                .elevation(.raised)
                                .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(id == defaultBackend ? String(localized: "\(backendTitle(id))（新会话默认）") : backendTitle(id))
                .accessibilityLabel(backendTitle(id))
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgSubtle))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
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

/// A free-text model id, saved on Return or when the field loses focus rather than per keystroke.
private struct CommittedModelField: View {
    let saved: String
    let commit: (String) -> Void
    @State private var draft: String?
    @FocusState private var focused: Bool

    var body: some View {
        TextField("CLI 默认", text: Binding(get: { draft ?? saved }, set: { draft = $0 }))
            .font(.riffet(size: S(13), design: .monospaced))
            .formField()
            .labelsHidden()
            .focused($focused)
            .onSubmit(send)
            .onChange(of: focused) { _, now in if !now { send() } }
    }

    private func send() {
        guard let value = draft?.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
        draft = nil
        if value != saved { commit(value) }
    }
}
