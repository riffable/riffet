import SwiftUI
import RiffetKit

/// One provider's editor, presented as a sheet from `AgentSettings`. It owns its draft, model
/// catalog and save/delete/default actions, so the parent page only keeps the provider list.
struct AgentProviderEditor: View {
    let workbench: Workbench
    let backend: NativeBackendId
    let isDefault: Bool
    let onFinished: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    @State private var current: NativeBackendProfileSettings?
    @State private var draft: ProfileDraft
    @State private var baseline: ProfileDraft
    @State private var apiKey = ""
    @State private var clearKey = false
    @State private var catalog: [ModelInfo] = []
    @State private var catalogNote = ""
    @State private var reload = 0
    @State private var probing = false
    @State private var filter = ""
    @State private var manualModel = ""
    @State private var saving = false
    @State private var error: String?
    @State private var confirmDiscard = false
    @State private var confirmDelete = false
    @State private var plugins: [PluginDescriptor]
    @State private var flow: PluginFlow?

    init(
        workbench: Workbench,
        backend: NativeBackendId,
        profile: NativeBackendProfileSettings?,
        plugins: [PluginDescriptor],
        isDefault: Bool,
        onFinished: @escaping () -> Void
    ) {
        self.workbench = workbench
        self.backend = backend
        self.isDefault = isDefault
        self.onFinished = onFinished
        _plugins = State(initialValue: plugins)
        let next: ProfileDraft
        if let profile {
            next = ProfileDraft(profile)
        } else {
            var blank = ProfileDraft()
            blank.source = "custom"
            next = blank
        }
        _current = State(initialValue: profile)
        _draft = State(initialValue: next)
        _baseline = State(initialValue: next)
    }

    private var isNew: Bool { current == nil }

    /// Live sessions this provider still carries; deleting it leaves them inactive, not deleted.
    private var affectedSessionCount: Int {
        guard let profileId = current?.id else { return 0 }
        return workbench.list.sessions.filter {
            $0.backendId == backend && $0.backendProfileId == profileId && $0.archivedAt == nil
        }.count
    }
    private var dirty: Bool { draft != baseline || !apiKey.isEmpty || clearKey }

    private var canSave: Bool {
        guard dirty, !saving else { return false }
        if draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        if draft.source == "custom" && draft.apiEndpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        return true
    }

    /// A saved source no enabled plugin offers stays pickable, without its fields.
    private var sources: [String] {
        let listed = modelSources(for: backend, plugins: plugins, consuming: consumedProtocols)
        return listed.contains(baseline.source) ? listed : Array(listed.dropLast()) + [baseline.source, "custom"]
    }

    private var offered: OfferedModelSource? {
        offeredModelSources(plugins, for: backend, consuming: consumedProtocols).first { $0.source.id == draft.source }
    }

    /// The gateway protocols this Agent consumes, from the backend catalog; nil from a server that predates them.
    private var consumedProtocols: [String]? {
        workbench.backends.first { $0.agent == backendWire(backend) }?.capabilities.consumesProtocols
    }

    private func overrides(_ field: String) -> Bool {
        draft.source == "custom" || offered?.source.overridable.contains(field) == true
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Form {
                Section {
                    SettingsFieldRow("名称") {
                        TextField(sourceTitlePlaceholder, text: $draft.name)
                            .formField()
                            .disabled(saving)
                    }
                    if profileAllowsEndpoint(backend) {
                        Picker("来源", selection: sourceBinding) {
                            ForEach(sources, id: \.self) { source in
                                Text(modelSourceTitle(source, plugins: plugins)).tag(source)
                            }
                        }
                        .formPicker()
                        .disabled(saving)
                        if backend == .pi && draft.source == "custom" {
                            SettingsFieldRow("协议") {
                                Picker("协议", selection: Binding(
                                    get: { draft.apiProtocol ?? defaultNativeModelApiProtocol },
                                    set: { draft.apiProtocol = $0 }
                                )) {
                                    ForEach(nativeModelApiProtocols, id: \.id) { item in
                                        Text(item.label).tag(item.id)
                                    }
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .formPicker()
                                .disabled(saving)
                            }
                        }
                        sourceLoginControls
                        if overrides("apiEndpoint") {
                            SettingsFieldRow("服务地址") {
                                TextField(draft.modelSource != nil ? offered?.source.defaultEndpoint ?? String(localized: "使用来源默认地址") : endpointHint(backend)?.placeholder ?? "https://", text: $draft.apiEndpoint)
                                    .font(.riffet(size: S(13), design: .monospaced))
                                    .formField()
                                    .disabled(saving)
                            }
                            if let hint = endpointHint(backend), !draft.apiEndpoint.isEmpty {
                                SettingsHint(hint.hint)
                            }
                        }
                        if overrides("apiKey") {
                            SettingsFieldRow("API Key") {
                                HStack(spacing: Space.sm) {
                                    SecureField(keyPlaceholder, text: $apiKey)
                                        .font(.riffet(size: S(13), design: .monospaced))
                                        .formField()
                                        .disabled(saving)
                                        .onChange(of: apiKey) { _, value in if !value.isEmpty { clearKey = false } }
                                    if current?.hasApiKey?.boolValue == true, draft.source == baseline.source {
                                        Button(clearKey ? "取消清除" : "清除") {
                                            apiKey = ""
                                            clearKey.toggle()
                                        }
                                        .disabled(saving)
                                    }
                                }
                            }
                        }
                    }
                }

                // A new provider picks its models as soon as there is something to read them from.
                if current != nil || canProbe {
                    modelBlock
                }

                SettingsBlock("高级") {
                    SettingsFieldRow("CLI 入口") {
                        TextField(backendWire(backend), text: $draft.executable)
                            .font(.riffet(size: S(13), design: .monospaced))
                            .formField()
                    }
                    if profileAllowsConfigDir(backend) {
                        SettingsFieldRow("配置目录") {
                            TextField(backend == .dsh ? "~/.riffet/dsh（默认）" : "使用 CLI 默认目录", text: $draft.configDir)
                                .font(.riffet(size: S(13), design: .monospaced))
                                .formField()
                        }
                    }
                    if profileAllowsSourceDir(backend) {
                        SettingsFieldRow("DSH 源码目录") {
                            TextField("可选", text: $draft.sourceDir)
                                .font(.riffet(size: S(13), design: .monospaced))
                                .formField()
                        }
                    }
                    if profileAllowsAutoUpdate(backend) {
                        Toggle("关闭自动更新", isOn: $draft.disableAutoUpdate)
                    }
                }
                .disabled(saving)

                if let error {
                    SettingsCallout(.danger, message: error)
                }
            }
            .riffetForm()
            Divider()
            footer
        }
        // Shorter than the settings window's minimum, so the sheet never overhangs it.
        .frame(minWidth: 620, idealWidth: 680, minHeight: 460, idealHeight: 560)
        .background(palette.bg)
        .task(id: catalogToken) { await loadCatalog() }
        .interactiveDismissDisabled(dirty)
        .confirmationDialog("放弃未保存的更改？", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("放弃更改", role: .destructive) { dismiss() }
            Button("继续编辑", role: .cancel) {}
        } message: {
            Text("更改尚未保存。")
        }
        .confirmationDialog("删除这个提供商？", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("删除", role: .destructive) { Task { await remove() } }
            Button("取消", role: .cancel) {}
        } message: {
            if affectedSessionCount > 0 {
                Text("\(affectedSessionCount) 个会话将无法继续发送，仍可查看或交接。")
            }
        }
        .sheet(item: $flow) { flow in
            PluginFlowSheet(workbench: workbench, pluginId: flow.pluginId, action: flow.action) {
                Task {
                    if let loaded = try? await workbench.host.api?.plugins() { plugins = loaded; PluginsStore.shared.update(loaded) }
                    if current != nil { await probe() }
                }
            }
        }
    }

    // MARK: - Chrome

    private var header: some View {
        HStack(spacing: Space.sm) {
            Text(isNew ? String(localized: "添加 \(backendTitle(backend)) 提供商") : (current?.name ?? String(localized: "编辑提供商")))
                .font(.riffet(size: S(16), weight: .semibold))
                .foregroundStyle(palette.fg)
            Spacer(minLength: Space.sm)
            if saving { Spinner(size: .small) }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
    }

    private var footer: some View {
        HStack(spacing: Space.sm) {
            if !isNew {
                SettingsActionButton("删除", kind: .danger) { confirmDelete = true }
                    .disabled(saving)
            }
            Spacer(minLength: Space.sm)
            if !isNew, !isDefault {
                SettingsActionButton("设为默认", kind: .secondary) { Task { await makeDefault() } }
                    .disabled(saving || dirty)
                    .help(dirty ? String(localized: "先保存更改，再设为默认") : "")
            }
            Button("取消") { requestClose() }
                .keyboardShortcut(.cancelAction)
                .disabled(saving)
            SettingsActionButton(isNew ? "添加" : "保存", kind: .primary) {
                Task { await save() }
            }
            .disabled(!canSave)
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
    }

    private var keyPlaceholder: String {
        if clearKey { return String(localized: "保存后清除") }
        return current?.hasApiKey?.boolValue == true ? String(localized: "已配置") : String(localized: "未配置")
    }

    /// The draft can be probed for models without saving it first.
    private var canProbe: Bool {
        !draft.apiEndpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.modelSource != nil
    }

    /// The draft reaches the same models as the saved provider, whose catalogue the server keeps.
    private var matchesSaved: Bool {
        current != nil && draft.source == baseline.source && draft.apiEndpoint == baseline.apiEndpoint
            && draft.apiProtocol == baseline.apiProtocol && apiKey.isEmpty && !clearKey
    }

    private var sourceTitlePlaceholder: String {
        draft.source == "custom" ? String(localized: "例如 公司网关") : modelSourceTitle(draft.source, plugins: plugins)
    }

    private func requestClose() {
        if dirty { confirmDiscard = true } else { dismiss() }
    }

    private var sourceBinding: Binding<String> {
        Binding(
            get: { draft.source },
            set: { next in
                guard next != draft.source else { return }
                draft.source = next
                draft.apiEndpoint = ""
                draft.defaultModel = ""
                draft.enabledModels = nil
                draft.modalities = [:]
                draft.contextWindows = [:]
                apiKey = ""
                clearKey = true
                catalog = []
            }
        )
    }

    @ViewBuilder
    private var sourceLoginControls: some View {
        if let offered, let id = offered.source.loginAction,
           let action = offered.plugin.actions.first(where: { $0.id == id }) {
            Button(action.label) { flow = PluginFlow(pluginId: offered.plugin.id, action: action) }
                .disabled(saving)
        }
        if let hint = offered?.source.hint {
            PluginHintRow(text: hint.text, command: hint.command)
        }
    }

    // MARK: - Models

    private var modelBlock: some View {
        SettingsBlock("模型") {
            HStack(spacing: Space.sm) {
                Text(catalogNote)
                    .font(.riffet(size: S(11.5)))
                    .foregroundStyle(palette.fg3)
                    .lineLimit(1)
                Spacer(minLength: Space.sm)
                if probing { Spinner(size: .mini) }
                Button {
                    if matchesSaved || !canProbe { reload += 1 } else { Task { await probe() } }
                } label: {
                    Image(icon: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(saving || probing)
                .help("获取模型列表")
            }

            HStack(spacing: Space.sm) {
                Toggle("使用全部模型", isOn: Binding(
                    get: { draft.enabledModels == nil },
                    set: { all in
                        if all { draft.enabledModels = nil }
                        else { draft.enabledModels = catalog.map(\.value) }
                    }
                ))
                .disabled(saving)
                Spacer(minLength: Space.sm)
                if let enabled = draft.enabledModels {
                    Text("已选 \(enabled.count) / \(candidates.count) 个")
                        .font(.riffet(size: S(11.5)))
                        .foregroundStyle(palette.fg3)
                    Button("全不选") { draft.enabledModels = [] }
                        .disabled(saving || enabled.isEmpty)
                }
            }

            if draft.enabledModels != nil {
                if candidates.count > 8 {
                    TextField("筛选", text: $filter)
                        .formField()
                        .disabled(saving)
                }
                ForEach(visibleCandidates, id: \.value) { model in
                    VStack(alignment: .leading, spacing: 4) {
                        Toggle(isOn: modelToggle(model.value)) {
                            Text(cleanLabel(value: model.name)).lineLimit(1)
                        }
                        .disabled(saving)
                        if backend == .dsh || (backend == .pi && draft.source == "custom"), !draft.apiEndpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, isModelOn(model.value) {
                            modalityRow(model.value, disabled: saving)
                        }
                        if backend == .claude || (backend == .pi && draft.source == "custom"), draft.source != "login", isModelOn(model.value) {
                            contextRow(model, disabled: saving)
                        }
                    }
                }

                HStack(spacing: Space.sm) {
                    TextField("手动添加模型 ID", text: $manualModel)
                        .formField()
                        .disabled(saving)
                    Button("添加") { addManual() }
                        .disabled(saving || manualModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }

            SettingsRow("默认模型") {
                modelPicker(catalog: pickable, selection: $draft.defaultModel, disabled: saving)
            }
        }
    }

    private var candidates: [ModelInfo] {
        var seen = Set(catalog.map(\.value))
        var rows = catalog
        for id in draft.enabledModels ?? [] where !seen.contains(id) {
            seen.insert(id)
            rows.append(ModelInfo(value: id, name: id, configOptions: [], nativeVariants: nil, contextWindow: nil, aliases: nil))
        }
        return rows
    }

    private var visibleCandidates: [ModelInfo] {
        let query = filter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return candidates }
        return candidates.filter { "\($0.name) \($0.value)".lowercased().contains(query) }
    }

    private var pickable: [ModelInfo] {
        guard let enabled = draft.enabledModels else { return catalog }
        return catalog.filter { enabled.contains($0.value) }
    }

    @ViewBuilder
    private func modelPicker(catalog: [ModelInfo], selection: Binding<String>, disabled: Bool) -> some View {
        HStack {
            if catalog.isEmpty {
                TextField("CLI 默认", text: selection)
                    .font(.riffet(size: S(13), design: .monospaced))
                    .formField()
                    .labelsHidden()
                    .disabled(disabled)
            } else {
                if !selection.wrappedValue.isEmpty {
                    Button("清除") { selection.wrappedValue = "" }.disabled(disabled)
                }
                ModelControls(catalog: catalog, selection: selection.wrappedValue.isEmpty ? nil : selection.wrappedValue, scope: catalogToken, refresh: { await loadCatalog(quiet: true) }) {
                    selection.wrappedValue = $0
                }
                .disabled(disabled)
            }
        }
    }

    private func modelToggle(_ id: String) -> Binding<Bool> {
        Binding(
            get: { isModelOn(id) },
            set: { on in
                var base = draft.enabledModels ?? candidates.map(\.value)
                if on { if !base.contains(id) { base.append(id) } }
                else { base.removeAll { $0 == id } }
                draft.enabledModels = base
            }
        )
    }

    private func isModelOn(_ id: String) -> Bool { draft.enabledModels?.contains(id) ?? true }

    private func modalityRow(_ id: String, disabled: Bool) -> some View {
        let current = draft.modalities[id] ?? ["text"]
        return HStack(spacing: 12) {
            Text("输入类型").font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
            Toggle("文本", isOn: modalityBinding(id, "text", current: current)).disabled(disabled || (current == ["text"]))
            Toggle("图片", isOn: modalityBinding(id, "image", current: current)).disabled(disabled)
        }
        .padding(.leading, 22)
    }

    private func modalityBinding(_ id: String, _ kind: String, current: [String]) -> Binding<Bool> {
        Binding(
            get: { current.contains(kind) },
            set: { on in
                var next = current
                if on { if !next.contains(kind) { next.append(kind) } }
                else { next.removeAll { $0 == kind } }
                if next.isEmpty { next = ["text"] }
                let order = ["text", "image"]
                draft.modalities[id] = order.filter { next.contains($0) }
            }
        )
    }

    private func contextRow(_ model: ModelInfo, disabled: Bool) -> some View {
        let id = model.value
        let stored = draft.contextWindows[id]
        let presets: [Int64] = [131_072, 200_000, 262_144, 1_048_576]
        return HStack(spacing: 12) {
            Text("上下文长度").font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
            Picker("上下文长度", selection: Binding(get: { stored ?? 0 }, set: { draft.contextWindows[id] = $0 == 0 ? nil : $0 })) {
                // The catalog already applies a saved declaration, so only an undeclared id shows the gateway's own figure.
                Text(baseline.contextWindows[id] != nil
                    ? String(localized: "默认")
                    : String(localized: "默认（\(model.contextWindow.map { contextLabel($0.int64Value) } ?? String(localized: "未声明"))）")).tag(Int64(0))
                ForEach(presets, id: \.self) { Text(contextLabel($0)).tag($0) }
                if let stored, !presets.contains(stored) { Text(contextLabel(stored)).tag(stored) }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .formPicker()
            .fixedSize()
            .disabled(disabled)
        }
        .padding(.leading, 22)
    }

    private func addManual() {
        let id = manualModel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { return }
        var base = draft.enabledModels ?? candidates.map(\.value)
        if !base.contains(id) { base.append(id) }
        draft.enabledModels = base
        manualModel = ""
    }

    // MARK: - Catalog

    private var catalogToken: String {
        "\(backendWire(backend))#\(current?.id ?? "")#\(reload)#\(draft.source)#\(draft.apiEndpoint)#\(draft.apiProtocol ?? "")#\(apiKey)#\(clearKey)"
    }

    private func loadCatalog(quiet: Bool = false) async {
        if !quiet { catalog = [] }
        guard let id = current?.id, matchesSaved, let api = workbench.host.api else {
            catalogNote = canProbe ? String(localized: "刷新模型列表") : ""
            return
        }
        let projectId = workbench.supportsProjectlessTasks ? nil : workbench.selected?.projectId ?? workbench.homeProjectId ?? workbench.projects.first?.id
        guard workbench.supportsProjectlessTasks || projectId != nil else {
            catalogNote = String(localized: "先选择工作目录才能获取模型列表")
            return
        }
        catalogNote = String(localized: "读取中…")
        let request = catalogToken
        do {
            let entry = try await api.backendCatalog(backendId: backend, profileId: id, projectId: projectId, allModels: true, global: projectId == nil)
            guard !Task.isCancelled, request == catalogToken else { return }
            if !entry.available {
                catalogNote = entry.reason ?? String(localized: "当前不可用")
            } else if let reason = entry.reason, !reason.isEmpty {
                catalog = Array(entry.models)
                catalogNote = String(localized: "CLI 可用，但获取模型列表失败：\(reason)")
            } else {
                catalog = Array(entry.models)
                catalogNote = String(localized: "可用 · \(entry.models.count) 个模型")
            }
        } catch {
            guard !Task.isCancelled, request == catalogToken else { return }
            catalogNote = error.riffetMessage
        }
    }

    private func probe() async {
        let endpoint = draft.apiEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !endpoint.isEmpty || draft.modelSource != nil, let api = workbench.host.api else { return }
        let request = catalogToken
        let key = apiKey
        let clearingKey = clearKey
        probing = true
        catalogNote = String(localized: "读取中…")
        do {
            let body = ProbeBackendModelsBody(
                apiEndpoint: endpoint.isEmpty ? nil : endpoint,
                apiKey: apiKey.isEmpty ? (clearKey || draft.source != baseline.source ? "" : nil) : apiKey,
                profileId: current?.id,
                modelSource: draft.modelSource,
                apiProtocol: backend == .antigravity && draft.source == "custom" ? "google-generative-ai" : backend == .pi && draft.source == "custom" ? draft.apiProtocol : nil
            )
            let found = try await api.probeBackendModels(backendId: backend, body: body)
            guard request == catalogToken, key == apiKey, clearingKey == clearKey else { probing = false; return }
            catalog = found
            catalogNote = found.isEmpty ? String(localized: "这个地址没有返回任何模型，可以手动填写模型 ID。") : String(localized: "可用 · \(found.count) 个模型")
        } catch {
            if request == catalogToken, key == apiKey, clearingKey == clearKey {
                catalogNote = error.riffetMessage
            }
        }
        probing = false
    }

    // MARK: - Save

    private func save() async {
        if isNew { await create() } else { await saveProfile() }
    }

    private func saveProfile() async {
        guard let profile = current, let body = profileUpdate(profile), let api = workbench.host.api else { return }
        saving = true
        error = nil
        do {
            let saved = try await api.updateBackendProfile(backendId: backend, profileId: profile.id, body: body)
            current = saved
            applyDraft(saved)
            apiKey = ""
            clearKey = false
            reload += 1
            if body.defaultModel != nil, let latest = try? await workbench.host.api?.settings() {
                workbench.store.applySavedSettings(settings: latest)
            }
            workbench.store.invalidateBackendCatalog()
            await workbench.loadBackends()
            onFinished()
            dismiss()
        } catch {
            self.error = error.riffetMessage
        }
        saving = false
    }

    private func create() async {
        guard let api = workbench.host.api else { return }
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let endpoint = draft.apiEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = UUID().uuidString.lowercased()
        let body = NativeBackendProfileSettingsUpdate(
            name: name,
            description: nil,
            executable: draft.executable.isEmpty ? nil : draft.executable,
            configDir: draft.configDir.isEmpty ? nil : draft.configDir,
            sourceDir: draft.sourceDir.isEmpty ? nil : draft.sourceDir,
            apiEndpoint: draft.source != "login" && !endpoint.isEmpty ? endpoint : nil,
            agentEndpoint: nil,
            disableAutoUpdate: draft.disableAutoUpdate ? KotlinBoolean(bool: true) : nil,
            defaultModel: draft.defaultModel.isEmpty ? nil : draft.defaultModel,
            enabledModels: draft.enabledModels.map { PatchValue.shared.list(value: $0) },
            modelInputModalities: draft.modalities.isEmpty ? nil : PatchValue.shared.modalities(value: draft.modalities),
            modelContextWindows: draft.contextWindows.isEmpty ? nil : PatchValue.shared.contextWindows(value: draft.contextWindows.mapValues { KotlinLong(value: $0) }),
            apiKey: draft.source != "login" && !apiKey.isEmpty ? PatchValue.shared.key(value: apiKey) : nil,
            modelSource: draft.source == "login" || draft.source == "custom" ? nil : PatchValue.shared.key(value: draft.source),
            apiProtocol: backend == .antigravity && draft.source == "custom" ? PatchValue.shared.key(value: "google-generative-ai") : backend == .pi && draft.source == "custom" ? PatchValue.shared.key(value: draft.apiProtocol ?? defaultNativeModelApiProtocol) : nil
        )
        saving = true
        error = nil
        do {
            let created = try await api.createBackendProfile(backendId: backend, id: id, body: body)
            current = created
            applyDraft(created)
            apiKey = ""
            clearKey = false
            reload += 1
            await workbench.loadBackends()
            workbench.store.invalidateBackendCatalog()
            onFinished()
        } catch {
            self.error = error.riffetMessage
        }
        saving = false
    }

    private func remove() async {
        guard let profile = current, let api = workbench.host.api else { return }
        saving = true
        error = nil
        do {
            _ = try await api.deleteBackendProfile(backendId: backend, profileId: profile.id)
            let agent = backendWire(backend)
            if workbench.settings?.defaultsFor(agent: agent)?.profileId == profile.id {
                var map = agentDefaults(from: workbench.settings)
                let previous = map[agent]
                map[agent] = NativeBackendDefaults(
                    profileId: nil,
                    model: previous?.model,
                    mode: previous?.mode,
                    approval: previous?.approval
                )
                try await SettingsStore.save(workbench, SettingsPatch.make(agentDefaults: map))
            }
            await workbench.loadBackends()
            workbench.store.invalidateBackendCatalog()
            onFinished()
            dismiss()
        } catch {
            self.error = error.riffetMessage
        }
        saving = false
    }

    private func makeDefault() async {
        guard let profile = current else { return }
        let agent = backendWire(backend)
        var map = agentDefaults(from: workbench.settings)
        let previous = map[agent]
        // A model belongs to its provider; the mode and approval are the Agent's.
        map[agent] = NativeBackendDefaults(
            profileId: profile.id,
            model: previous?.profileId == profile.id ? previous?.model : nil,
            mode: previous?.mode,
            approval: previous?.approval
        )
        saving = true
        error = nil
        do {
            try await SettingsStore.save(workbench, SettingsPatch.make(agentDefaults: map))
            await workbench.loadBackends()
            onFinished()
            dismiss()
        } catch {
            self.error = error.riffetMessage
        }
        saving = false
    }

    private func applyDraft(_ profile: NativeBackendProfileSettings) {
        let next = ProfileDraft(profile)
        draft = next
        baseline = next
        apiKey = ""
        clearKey = false
        filter = ""
    }

    private func profileUpdate(_ profile: NativeBackendProfileSettings) -> NativeBackendProfileSettingsUpdate? {
        let key = apiKey.isEmpty ? (clearKey || draft.source != baseline.source ? PatchValue.shared.key(value: nil) : nil) : PatchValue.shared.key(value: apiKey)
        let modelsSame = sameStrings(draft.enabledModels, baseline.enabledModels)
        let inputsSame = sameModalities(draft.modalities, baseline.modalities)
        let windowsSame = draft.contextWindows == baseline.contextWindows
        let textSame = draft.name == baseline.name && draft.executable == baseline.executable && draft.configDir == baseline.configDir
            && draft.sourceDir == baseline.sourceDir && draft.apiEndpoint == baseline.apiEndpoint && draft.defaultModel == baseline.defaultModel
            && draft.disableAutoUpdate == baseline.disableAutoUpdate
            && draft.source == baseline.source && draft.apiProtocol == baseline.apiProtocol
        if textSame && modelsSame && inputsSame && windowsSame && key == nil { return nil }
        return NativeBackendProfileSettingsUpdate(
            name: draft.name,
            description: nil,
            executable: draft.executable == baseline.executable ? nil : draft.executable,
            configDir: draft.configDir == baseline.configDir ? nil : draft.configDir,
            sourceDir: draft.sourceDir == baseline.sourceDir ? nil : draft.sourceDir,
            apiEndpoint: draft.apiEndpoint == baseline.apiEndpoint ? nil : draft.apiEndpoint,
            agentEndpoint: nil,
            disableAutoUpdate: draft.disableAutoUpdate == baseline.disableAutoUpdate ? nil : KotlinBoolean(bool: draft.disableAutoUpdate),
            defaultModel: draft.defaultModel == baseline.defaultModel ? nil : draft.defaultModel,
            enabledModels: modelsSame ? nil : PatchValue.shared.list(value: draft.enabledModels),
            modelInputModalities: inputsSame ? nil : PatchValue.shared.modalities(value: draft.modalities.isEmpty ? nil : draft.modalities),
            modelContextWindows: windowsSame ? nil : PatchValue.shared.contextWindows(value: draft.contextWindows.isEmpty ? nil : draft.contextWindows.mapValues { KotlinLong(value: $0) }),
            apiKey: key,
            modelSource: draft.modelSource == baseline.modelSource ? nil : PatchValue.shared.key(value: draft.modelSource),
            apiProtocol: backend == .antigravity ? PatchValue.shared.key(value: draft.source == "custom" ? "google-generative-ai" : nil) : backend == .pi && draft.source == "custom" && draft.apiProtocol != baseline.apiProtocol
                ? PatchValue.shared.key(value: draft.apiProtocol ?? defaultNativeModelApiProtocol)
                : nil
        )
    }
}

private struct ProfileDraft: Equatable {
    var source = "login"
    var modelSource: String? { source == "login" || source == "custom" ? nil : source }
    var name = ""
    var executable = ""
    var configDir = ""
    var sourceDir = ""
    var apiEndpoint = ""
    var disableAutoUpdate = false
    var defaultModel = ""
    var enabledModels: [String]?
    var modalities: [String: [String]] = [:]
    /// Declared context window per model id, in tokens; absent ids keep the gateway's figure.
    var contextWindows: [String: Int64] = [:]
    /// Wire API a custom pi provider speaks; `nil` keeps the backend's default.
    var apiProtocol: String? = defaultNativeModelApiProtocol

    init() {}

    init(_ profile: NativeBackendProfileSettings) {
        source = profile.modelSource ?? ((profile.apiEndpoint ?? "").isEmpty ? "login" : "custom")
        name = profile.name
        executable = profile.executable ?? ""
        configDir = profile.configDir ?? ""
        sourceDir = profile.sourceDir ?? ""
        apiEndpoint = profile.apiEndpoint ?? ""
        disableAutoUpdate = profile.disableAutoUpdate?.boolValue == true
        defaultModel = profile.defaultModel ?? ""
        enabledModels = profile.enabledModels.map { Array($0) }
        apiProtocol = profile.apiProtocol ?? defaultNativeModelApiProtocol
        if let raw = profile.modelInputModalities {
            for (key, value) in raw { modalities[key] = Array(value) }
        }
        if let raw = profile.modelContextWindows {
            for (key, value) in raw { contextWindows[key] = value.int64Value }
        }
    }
}

private func sameStrings(_ lhs: [String]?, _ rhs: [String]?) -> Bool {
    switch (lhs, rhs) {
    case (nil, nil): true
    case let (left?, right?): left == right
    default: false
    }
}

/// 131072 → 128K, 200000 → 200K, 1048576 and 1000000 → 1M.
private func contextLabel(_ tokens: Int64) -> String {
    let (value, suffix): (Double, String) = tokens >= 1_000_000
        ? (Double(tokens) / (tokens % 1_048_576 == 0 ? 1_048_576 : 1_000_000), "M")
        : (Double(tokens) / (tokens % 1024 == 0 ? 1024 : 1000), "K")
    return String(format: "%g", (value * 10).rounded() / 10) + suffix
}

private func sameModalities(_ lhs: [String: [String]], _ rhs: [String: [String]]) -> Bool {
    let left = lhs.keys.sorted().map { ($0, (lhs[$0] ?? []).sorted()) }
    let right = rhs.keys.sorted().map { ($0, (rhs[$0] ?? []).sorted()) }
    return left.count == right.count && zip(left, right).allSatisfy { $0.0.0 == $0.1.0 && $0.0.1 == $0.1.1 }
}

/// A plugin action the editor runs in a sheet.
private struct PluginFlow: Identifiable {
    let pluginId: String
    let action: PluginAction
    var id: String { "\(pluginId)/\(action.id)" }
}
