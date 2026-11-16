import SwiftUI
import RiffetKit

/// Labels for the extension vocabulary, matching the Mac app (`ExtensionText`).
private enum ExtText {
    static let kindOrder = ["skill", "mcp", "plugin", "hook", "rule", "command", "config"]

    static func kind(_ kind: String) -> String {
        switch kind {
        case "skill": "Skill"
        case "mcp": "MCP"
        case "plugin": "Plugin"
        case "hook": "Hook"
        case "rule": "Rule"
        case "command": "Command"
        default: String(localized: "配置", bundle: .riffet)
        }
    }

    static func scope(_ scope: String) -> String {
        switch scope {
        case "user": String(localized: "用户级", bundle: .riffet)
        case "project": String(localized: "项目级", bundle: .riffet)
        case "managed": String(localized: "外部维护", bundle: .riffet)
        case "builtin": String(localized: "内置", bundle: .riffet)
        case "riffet": "Riffet"
        default: scope
        }
    }

    static func action(_ action: String) -> String {
        switch action {
        case "enable": String(localized: "启用", bundle: .riffet)
        case "disable": String(localized: "停用", bundle: .riffet)
        case "install": String(localized: "安装", bundle: .riffet)
        case "update": String(localized: "更新", bundle: .riffet)
        case "uninstall": String(localized: "卸载", bundle: .riffet)
        case "reload": String(localized: "重载 MCP", bundle: .riffet)
        case "login": String(localized: "认证", bundle: .riffet)
        default: action
        }
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "skill": "sparkles"
        case "mcp": "point.3.connected.trianglepath.dotted"
        case "plugin": "puzzlepiece.extension"
        case "hook": "arrow.triangle.turn.up.right.diamond"
        case "rule": "text.alignleft"
        case "command": "terminal"
        default: "doc.text"
        }
    }

    /// Nil when the state says nothing worth showing.
    static func runtimeState(_ state: String) -> String? {
        switch state {
        case "unknown", "": nil
        case "loaded": String(localized: "已加载", bundle: .riffet)
        case "error": String(localized: "异常", bundle: .riffet)
        case "pending": String(localized: "待生效", bundle: .riffet)
        default: state
        }
    }
}

private struct ExtensionGroup: Identifiable {
    let kind: String
    let items: [ExtensionItem]
    var id: String { kind }
}

struct NativeExtensionsView: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var backend: NativeBackendId = .cursor
    @State private var profiles: [NativeBackendProfileSettings] = []
    @State private var profileID = ""
    @State private var projectID = ""
    @State private var inventory: ExtensionInventory?
    @State private var capabilities: ExtensionManagementCapabilities?
    @State private var runtime: ExtensionRuntimeReport?
    @State private var error: String?
    @State private var profilesBackend: NativeBackendId?
    @State private var profilesRequest: (id: UUID, backend: NativeBackendId)?
    @State private var inventoryRequest: (id: UUID, contextKey: String)?
    @State private var filter = ""
    @State private var creating = false
    @State private var installing = false
    /// The kind chip: empty shows every kind, each cut to its first few.
    @State private var kindFilter = ""
    private static let preview = 5
    init(workbench: Workbench) {
        self.workbench = workbench
        let preferred = workbench.settings?.defaultBackendId
        _backend = State(initialValue: preferred.flatMap { managementBackends.contains($0) ? $0 : nil } ?? .cursor)
    }
    private var context: ExtensionContext { ExtensionContext(backendId: backend, profileId: profileID, projectId: projectID.isEmpty ? nil : projectID) }
    private var contextKey: String { "\(backend.name)|\(profileID)|\(projectID)" }
    private var loading: Bool { profilesRequest != nil || inventoryRequest != nil }
    private var canCreate: Bool { inventory?.createTargets.isEmpty == false }
    private var canInstall: Bool { capabilities?.actions.contains("install") == true }
    private var needle: String { filter.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var groups: [ExtensionGroup] {
        guard let inventory else { return [] }
        let items = needle.isEmpty ? inventory.items : inventory.items.filter {
            $0.name.localizedCaseInsensitiveContains(needle) || $0.kind.localizedCaseInsensitiveContains(needle)
                || ExtText.kind($0.kind).localizedCaseInsensitiveContains(needle)
        }
        let extra = Array(Set(items.map { $0.kind }).subtracting(ExtText.kindOrder)).sorted()
        return (ExtText.kindOrder + extra).compactMap { kind in
            let members = items.filter { $0.kind == kind }
            return members.isEmpty ? nil : ExtensionGroup(kind: kind, items: members)
        }
    }

    var body: some View {
        let all = groups
        // A kind that left with a scope change falls back to every kind.
        let kind = all.contains { $0.kind == kindFilter } ? kindFilter : ""
        let grouped = kind.isEmpty ? all : all.filter { $0.kind == kind }
        let capped = kind.isEmpty && needle.isEmpty
        let diagnostics = (inventory?.diagnostics ?? []) + (runtime?.diagnostics ?? [])
        RiffetList {
            SettingsChipRow { chips }
            if all.count > 1 {
                RiffetChipBar(items: [.init(value: "", title: String(localized: "全部", bundle: .riffet))]
                                + all.map { .init(value: $0.kind, title: "\(ExtText.kind($0.kind)) \($0.items.count)") },
                              selection: Binding(get: { kind }, set: { kindFilter = $0 }))
                    .listRowInsets(EdgeInsets()).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            RiffetNotice.section(.error, error, actionTitle: String(localized: "重试", bundle: .riffet)) { Task { await reload() } }
            ForEach(grouped) { group in
                let shown = capped ? Array(group.items.prefix(Self.preview)) : group.items
                Section {
                    ForEach(shown, id: \.id) { item in
                        NavigationLink {
                            NativeExtensionDetail(workbench: workbench, context: context, item: item, capabilities: capabilities) { Task { await load() } }
                        } label: { row(item) }
                    }
                    if shown.count < group.items.count {
                        Button { withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) { kindFilter = group.kind } } label: {
                            Text("全部 \(group.items.count) 个").riffetFont(.body).foregroundStyle(palette.accent)
                                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    RiffetSectionTitle(ExtText.kind(group.kind))
                }
            }
            if kind.isEmpty, (runtime?.entries.isEmpty == false) || !diagnostics.isEmpty {
                Section {
                    if let runtime, !runtime.entries.isEmpty {
                        NavigationLink { NativeExtensionRuntime(entries: runtime.entries) } label: {
                            SettingsRowLabel(title: String(localized: "运行状态", bundle: .riffet), symbol: "waveform.path.ecg", value: "\(runtime.entries.count)")
                        }
                    }
                    if !diagnostics.isEmpty {
                        NavigationLink { NativeExtensionDiagnostics(values: diagnostics) } label: {
                            SettingsRowLabel(title: String(localized: "诊断", bundle: .riffet), symbol: "stethoscope", value: "\(diagnostics.count)")
                        }
                    }
                }
            }
            if let reason = capabilities?.reason { RiffetNotice.section(.info, reason) }
        }
        .overlay {
            if loading && inventory == nil { ProgressView() }
            else if let inventory, !loading, error == nil {
                if inventory.items.isEmpty { ContentUnavailableView("没有扩展", systemImage: "puzzlepiece.extension") }
                else if grouped.isEmpty && !needle.isEmpty { ContentUnavailableView.search(text: needle) }
            }
        }
        .navigationTitle(String(localized: "扩展管理", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .riffetSearchable(text: $filter, prompt: String(localized: "搜索名称或类型", bundle: .riffet))
        .toolbar {
            if canCreate || canInstall {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if canCreate { Button { creating = true } label: { Label("新建配置文件", systemImage: "doc.badge.plus") } }
                        if canInstall { Button { installing = true } label: { Label("安装插件", systemImage: "arrow.down.circle") } }
                    } label: { Image(systemName: "plus") }
                    .accessibilityLabel("添加")
                }
            }
        }
        .task(id: backend) { await loadProfiles() }
        .task(id: contextKey) { await load() }
        .refreshable { await reload() }
        .onDisappear { profilesRequest = nil; inventoryRequest = nil }
        .sheet(isPresented: $creating) {
            NavigationStack { NativeExtensionCreate(workbench: workbench, context: context, targets: inventory?.createTargets ?? []) { Task { await load() } } }
        }
        .sheet(isPresented: $installing) {
            NavigationStack { NativeExtensionInstall(workbench: workbench, context: context, scopes: capabilities?.installScopes ?? []) { Task { await load() } } }
        }
    }

    @ViewBuilder private var chips: some View {
        RiffetMenuChip(title: managementBackendName(backend, workbench), leading: {
            AgentMarkView(backend: backend.name, size: 14, color: agentMarkColor(backend.name, palette))
        }, items: {
            ForEach(managementBackends, id: \.self) { item in
                choice(managementBackendName(item, workbench), selected: item == backend) { backend = item }
            }
        }).disabled(loading)
        RiffetMenuChip(title: workbench.projects.first(where: { $0.id == projectID })?.name ?? String(localized: "用户级", bundle: .riffet), highlighted: !projectID.isEmpty, items: {
            choice(String(localized: "用户级", bundle: .riffet), selected: projectID.isEmpty) { projectID = "" }
            ForEach(workbench.projects, id: \.id) { project in
                choice(project.name, selected: project.id == projectID) { projectID = project.id }
            }
        }).disabled(loading)
    }

    @ViewBuilder private func choice(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            if selected { Label(title, systemImage: "checkmark") } else { Text(title) }
        }
    }

    private func row(_ item: ExtensionItem) -> some View {
        let caption = [ExtText.scope(item.scope), item.description_].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return HStack(spacing: 12) {
            SettingsIcon(symbol: ExtText.symbol(item.kind))
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                Text(caption).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
            }
            Spacer(minLength: 8)
            if item.enabled?.boolValue == false {
                Text("已停用").riffetFont(.caption).foregroundStyle(palette.fg4).lineLimit(1)
            }
        }
    }

    private func reload() async {
        if profilesBackend != backend || profileID.isEmpty { await loadProfiles() }
        else { await load() }
    }
    private func loadProfiles() async {
        guard let api = workbench.api, !Task.isCancelled, profilesRequest?.backend != backend else { return }
        let selected = backend, requestID = UUID()
        profilesRequest = (requestID, selected); inventoryRequest = nil
        profilesBackend = nil; profiles = []; profileID = ""
        error = nil; inventory = nil; capabilities = nil; runtime = nil
        defer { if profilesRequest?.id == requestID { profilesRequest = nil } }
        do {
            let response = try await api.backendProfiles(backendId: selected)
            guard profilesRequest?.id == requestID, selected == backend, !Task.isCancelled else { return }
            profilesBackend = selected
            profiles = response.profiles; profileID = response.defaultProfileId ?? profiles.first?.id ?? ""
        } catch { if profilesRequest?.id == requestID, selected == backend, !Task.isCancelled { self.error = error.riffetMessage } }
    }
    private func load() async {
        guard profilesBackend == backend, !profileID.isEmpty, let api = workbench.api, !Task.isCancelled,
              inventoryRequest?.contextKey != contextKey else { return }
        let requested = contextKey, requestID = UUID(); let scope = context
        inventoryRequest = (requestID, requested)
        error = nil; inventory = nil; capabilities = nil; runtime = nil
        defer { if inventoryRequest?.id == requestID { inventoryRequest = nil } }
        do {
            async let inv = api.extensions(context: scope)
            async let cap = api.extensionCapabilities(context: scope)
            async let run = api.extensionRuntime(context: scope)
            let result = try await (inv, cap, run)
            guard inventoryRequest?.id == requestID, requested == contextKey, !Task.isCancelled else { return }
            inventory = result.0; capabilities = result.1; runtime = result.2
        } catch { if inventoryRequest?.id == requestID, requested == contextKey, !Task.isCancelled { self.error = error.riffetMessage } }
    }
}

private struct NativeExtensionRuntime: View {
    let entries: [ExtensionRuntimeEntry]
    @Environment(\.palette) private var palette
    var body: some View {
        RiffetList {
            Section {
                ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in runtimeRow(entry) }
            }
        }
        .navigationTitle(String(localized: "运行状态", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }

    private func runtimeRow(_ entry: ExtensionRuntimeEntry) -> some View {
        let caption = [ExtText.kind(entry.kind), ExtText.runtimeState(entry.state)].compactMap { $0 }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 2) {
            Text(entry.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
            Text(caption).riffetFont(.caption).foregroundStyle(palette.fg3)
            if let message = entry.message, !message.isEmpty { Text(message).riffetFont(.caption).foregroundStyle(palette.fg3) }
            if let tools = entry.tools, !tools.isEmpty {
                Text(tools.joined(separator: ", ")).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(2)
            }
        }
    }
}

private struct NativeExtensionDiagnostics: View {
    let values: [String]
    @Environment(\.palette) private var palette
    var body: some View {
        RiffetList {
            Section {
                ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                    Text(value).riffetFont(.caption).foregroundStyle(palette.fg2).textSelection(.enabled)
                }
            }
        }
        .navigationTitle(String(localized: "诊断", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }
}

private struct NativeExtensionDetail: View {
    let workbench: Workbench
    let context: ExtensionContext
    let item: ExtensionItem
    let capabilities: ExtensionManagementCapabilities?
    let changed: () -> Void
    @Environment(\.palette) private var palette
    @State private var detail: ExtensionDetail?
    @State private var error: String?
    @State private var output: String?
    @State private var authorization: URL?
    @State private var busy = false
    @State private var confirmAction: String?
    @State private var document: ExtensionDocument?
    @State private var showDocument = false
    private var actions: [String] {
        let current = detail?.item ?? item
        guard current.readOnlyReason == nil, current.ownerPluginId == nil, !["managed", "builtin"].contains(current.scope),
              !["mcp", "plugin"].contains(current.kind) || current.nativeId?.isEmpty == false else { return [] }
        let supported = capabilities?.kinds[current.kind] ?? []
        return supported.filter { $0 != "install" && (current.actions == nil || current.actions!.contains($0)) }
    }
    var body: some View {
        let current = detail?.item ?? item
        let toggles = actions.contains("enable") || actions.contains("disable")
        let others = actions.filter { !["enable", "disable", "uninstall"].contains($0) }
        let state = ExtText.runtimeState(current.runtimeState)
        RiffetForm {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 14) {
                        Image(systemName: ExtText.symbol(current.kind))
                            .riffetFont(.barTitle, weight: .medium).foregroundStyle(palette.fg2)
                            .frame(width: 44, height: 44)
                            .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(palette.lineSoft, lineWidth: 0.5))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(current.name).riffetFont(.headline).foregroundStyle(palette.fg)
                            Text(ExtText.kind(current.kind) + " · " + ExtText.scope(current.scope)).riffetFont(.caption).foregroundStyle(palette.fg3)
                        }
                    }
                    if let description = current.description_, !description.isEmpty {
                        Text(description).riffetFont(.body).foregroundStyle(palette.fg2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .listRowBackground(Color.clear)
            }
            Section {
                if toggles {
                    Toggle(isOn: Binding(get: { current.enabled?.boolValue ?? true }, set: { on in
                        let next = on ? "enable" : "disable"
                        if actions.contains(next) { Task { await action(next) } }
                    })) {
                        Text("启用").riffetFont(.body).foregroundStyle(palette.fg)
                    }.tint(palette.accent)
                }
                if let state { infoRow("状态", state) }
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    if let reason = current.readOnlyReason { Text(reason).riffetFont(.caption) }
                    if let note = current.managementNote { Text(note).riffetFont(.caption) }
                    if let path = current.sourcePath { Text(path).riffetFont(.monoSmall).textSelection(.enabled) }
                }.foregroundStyle(palette.fg3)
            }
            if let detail {
                let files = detail.files
                if !files.isEmpty || current.documentId != nil {
                    Section {
                        ForEach(files, id: \.id) { file in
                            Button { Task { await open(file.id) } } label: {
                                HStack(spacing: 12) {
                                    SettingsIcon(symbol: "doc.text")
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text((file.path as NSString).lastPathComponent).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                                        Text(file.path).riffetFont(.monoSmall).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.middle)
                                        if let reason = file.reason { Text(reason).riffetFont(.caption).foregroundStyle(palette.fg3) }
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right").riffetFont(.caption, weight: .semibold).foregroundStyle(palette.fg4)
                                }.contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                        if files.isEmpty, let documentID = current.documentId {
                            Button { Task { await open(documentID) } } label: {
                                SettingsRowLabel(title: String(localized: "查看配置", bundle: .riffet), symbol: "doc.text").contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    } header: {
                        RiffetSectionTitle(String(localized: "配置文件", bundle: .riffet))
                    }
                }
            }
            if !others.isEmpty {
                Section {
                    ForEach(others, id: \.self) { action in
                        Button { confirmAction = action } label: {
                            Text(ExtText.action(action)).riffetFont(.body).foregroundStyle(palette.accent)
                        }
                    }
                }
            }
            RiffetNotice.section(.error, error)
            if let output, !output.isEmpty {
                Section {
                    Text(output).riffetFont(.monoSmall).foregroundStyle(palette.fg2).textSelection(.enabled)
                } header: {
                    RiffetSectionTitle(String(localized: "服务器输出", bundle: .riffet))
                }
            }
            if let authorization {
                Section {
                    Link(destination: authorization) {
                        Text("打开服务器提供的认证地址").riffetFont(.body).foregroundStyle(palette.accent)
                    }
                } footer: {
                    Text("部分 CLI 的认证回调需要在运行 Riffet 的电脑上完成。").riffetFont(.caption).foregroundStyle(palette.fg3)
                }
            }
            if actions.contains("uninstall") {
                Section {
                    Button(role: .destructive) { confirmAction = "uninstall" } label: {
                        Text(ExtText.action("uninstall")).riffetFont(.body).foregroundStyle(palette.danger)
                    }
                }
            }
        }
        .disabled(busy).navigationTitle(item.name).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { if busy { ProgressView() } } }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showDocument) { if let document { NavigationStack { NativeExtensionDocumentEditor(workbench: workbench, context: context, original: document) { changed() } } } }
        .confirmationDialog(confirmAction.map { String(localized: "\(ExtText.action($0))「\((detail?.item ?? item).name)」？", bundle: .riffet) } ?? "", isPresented: Binding(get: { confirmAction != nil }, set: { if !$0 { confirmAction = nil } }), titleVisibility: .visible) {
            Button(ExtText.action(confirmAction ?? ""), role: confirmAction == "uninstall" ? .destructive : nil) { let value = confirmAction; confirmAction = nil; if let value { Task { await action(value) } } }
        }
    }
    private func infoRow(_ title: LocalizedStringKey, _ value: String) -> some View {
        LabeledContent {
            Text(value).riffetFont(.body).foregroundStyle(palette.fg3)
        } label: {
            Text(title).riffetFont(.body).foregroundStyle(palette.fg)
        }
    }
    private func load() async {
        guard let api = workbench.api else { return }; busy = true; defer { busy = false }
        do { detail = try await api.extension(context: context, itemId: item.id); error = nil } catch { self.error = error.riffetMessage }
    }
    private func open(_ id: String) async {
        guard let api = workbench.api else { return }; busy = true; defer { busy = false }
        do { document = try await api.extensionDocument(context: context, documentId: id); showDocument = true; error = nil } catch { self.error = error.riffetMessage }
    }
    private func action(_ action: String) async {
        guard let api = workbench.api else { return }; busy = true; defer { busy = false }
        let current = detail?.item ?? item
        output = nil
        do {
            let result = try await api.extensionAction(context: context, input: ExtensionActionRequest(action: action, itemId: current.id, target: current.nativeId, scope: ["user", "project"].contains(current.scope) ? current.scope : nil, expectedHash: nil))
            // On success the server's text (instructions, a login hint) stays on the page; a failure
            // without diagnostics already shows it as the error.
            output = !result.success && result.diagnostics == nil ? nil : result.output; authorization = result.authorizationUrl.flatMap { URL(string: $0) }.flatMap { ["https", "http"].contains($0.scheme?.lowercased() ?? "") ? $0 : nil }
            if result.success {
                if !result.applyEffect.isEmpty { RiffetToastCenter.shared.show(result.applyEffect, kind: .success) }
                error = nil; changed(); await load()
            }
            else { error = result.diagnostics?.joined(separator: "\n") ?? result.output ?? String(localized: "服务器未完成操作", bundle: .riffet) }
        } catch { self.error = error.riffetMessage }
    }
}

private struct NativeExtensionDocumentEditor: View {
    let workbench: Workbench
    let context: ExtensionContext
    let original: ExtensionDocument
    let changed: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var snapshot: ExtensionDocument?
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @State private var confirmDiscard = false
    @State private var confirmReload = false
    private var current: ExtensionDocument { snapshot ?? original }
    private var dirty: Bool { text != current.content }
    var body: some View {
        let notes = [current.reason, current.validationNote, current.applyEffect].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        VStack(alignment: .leading, spacing: 8) {
            Text(current.path).riffetFont(.monoSmall).foregroundStyle(palette.fg3).textSelection(.enabled)
                .padding(.horizontal, RiffetMetrics.pageInset).padding(.top, 8)
            TextEditor(text: $text).riffetFont(.mono).foregroundStyle(palette.fg).tint(palette.accent)
                .scrollContentBackground(.hidden).disabled(!current.editable || busy)
                .padding(.horizontal, RiffetMetrics.pageInset - 5)
            VStack(alignment: .leading, spacing: 4) {
                if !notes.isEmpty { Text(notes).riffetFont(.caption).foregroundStyle(palette.fg3) }
                if let error { RiffetNotice(kind: .error, message: error) }
            }
            .padding(.horizontal, RiffetMetrics.pageInset).padding(.bottom, 8)
        }
        .background(palette.bg)
        .navigationTitle(current.editable ? String(localized: "编辑配置", bundle: .riffet) : String(localized: "查看配置", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(current.editable ? "取消" : "关闭") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(busy) }
            ToolbarItem(placement: .topBarTrailing) {
                if busy { ProgressView() } else {
                    Menu {
                        Button { if dirty { confirmReload = true } else { Task { await reload() } } } label: {
                            Label("重新读取服务器版本", systemImage: "arrow.clockwise")
                        }
                    } label: { Image(systemName: "ellipsis") }
                    .accessibilityLabel("重新读取服务器版本")
                }
            }
            if current.editable { ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await save() } }.disabled(!dirty || busy) } }
        }
        .riffetUnsavedGuard(dirty: dirty, locked: busy, confirming: $confirmDiscard) { dismiss() }
        .onAppear { if snapshot == nil { snapshot = original; text = original.content } }
        .confirmationDialog("用服务器版本替换当前编辑内容？", isPresented: $confirmReload, titleVisibility: .visible) { Button("重新读取", role: .destructive) { Task { await reload() } } }
    }
    private func save() async {
        guard let api = workbench.api else { return }; busy = true; defer { busy = false }
        do {
            let result = try await api.saveExtensionDocument(context: context, documentId: current.id, content: text, expectedHash: current.contentHash)
            snapshot = result; text = result.content; error = nil; changed()
        } catch { self.error = error.riffetMessage + "\n" + String(localized: "若文件已在 Mac 上更改，请重新读取后再保存。当前编辑内容会保留。", bundle: .riffet) }
    }
    private func reload() async {
        guard let api = workbench.api else { return }; busy = true; defer { busy = false }
        do { let result = try await api.extensionDocument(context: context, documentId: current.id); snapshot = result; text = result.content; error = nil }
        catch { self.error = error.riffetMessage }
    }
}

private struct NativeExtensionCreate: View {
    let workbench: Workbench
    let context: ExtensionContext
    let targets: [ExtensionCreateTarget]
    let changed: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var targetID = ""
    @State private var path = ""
    @State private var content = ""
    @State private var busy = false
    @State private var error: String?
    @State private var discard = false
    @State private var pendingTarget: String?
    @State private var initialPath = ""
    @State private var initialContent = ""
    private var dirty: Bool { path != initialPath || content != initialContent }
    var body: some View {
        RiffetForm {
            Section {
                let choice = Binding(get: { targetID }, set: { value in
                    if dirty { pendingTarget = value }
                    else { targetID = value; applyTemplate() }
                })
                if targets.count >= 5 {
                    RiffetPickerRow(title: String(localized: "配置类型", bundle: .riffet), options: targets.map { .init(id: $0.id, title: $0.label, subtitle: ExtText.scope($0.scope)) }, selection: choice)
                } else {
                    Picker(selection: choice) { ForEach(targets, id: \.id) { Text($0.label + " · " + ExtText.scope($0.scope)).tag($0.id) } } label: {
                        Text("配置类型").riffetFont(.body).foregroundStyle(palette.fg)
                    }.pickerStyle(.menu).tint(palette.fg3)
                }
            } footer: {
                if let target = targets.first(where: { $0.id == targetID }) {
                    Text(target.directory).riffetFont(.monoSmall).foregroundStyle(palette.fg3).textSelection(.enabled)
                }
            }
            Section {
                RiffetField(prompt: String(localized: "文件路径", bundle: .riffet), text: $path, mono: true).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            Section {
                TextEditor(text: $content).riffetFont(.mono).foregroundStyle(palette.fg).tint(palette.accent)
                    .scrollContentBackground(.hidden).frame(minHeight: 280)
            } header: {
                RiffetSectionTitle(String(localized: "内容", bundle: .riffet))
            }
            RiffetNotice.section(.error, error)
        }.disabled(busy).navigationTitle(String(localized: "新建配置", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("取消") { if dirty { discard = true } else { dismiss() } }.disabled(busy) }
            ToolbarItem(placement: .confirmationAction) {
                if busy { ProgressView() }
                else { Button("创建") { Task { await create() } }.disabled(targetID.isEmpty || path.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
        }
        .riffetUnsavedGuard(dirty: dirty, locked: busy, confirming: $discard) { dismiss() }
        .confirmationDialog("切换类型并放弃当前内容？", isPresented: Binding(get: { pendingTarget != nil }, set: { if !$0 { pendingTarget = nil } }), titleVisibility: .visible) {
            Button("切换类型", role: .destructive) { if let value = pendingTarget { targetID = value; applyTemplate() }; pendingTarget = nil }
        }
        .onAppear { if targetID.isEmpty { targetID = targets.first?.id ?? ""; applyTemplate() } }
    }
    private func applyTemplate() {
        guard let target = targets.first(where: { $0.id == targetID }) else { return }
        let leaf: String
        switch target.kind { case "skill": leaf = "my-skill/SKILL.md"; case "rule": leaf = "my-rule.md"; case "command": leaf = "my-command.md"; default: leaf = target.fileName ?? "config.json" }
        path = target.directory.isEmpty ? leaf : target.directory + "/" + leaf
        content = target.template ?? (target.kind == "mcp" ? "{\n  \"mcpServers\": {}\n}\n" : target.kind == "hook" ? "{\n  \"hooks\": {}\n}\n" : "")
        initialPath = path; initialContent = content
    }
    private func create() async {
        guard let api = workbench.api else { return }; busy = true; defer { busy = false }
        do { _ = try await api.createExtensionDocument(context: context, targetId: targetID, path: path, content: content); changed(); dismiss() }
        catch { self.error = error.riffetMessage }
    }
}

private struct NativeExtensionInstall: View {
    let workbench: Workbench
    let context: ExtensionContext
    let scopes: [String]
    let changed: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var target = ""
    @State private var scope = "user"
    @State private var busy = false
    @State private var error: String?
    @State private var discard = false
    /// What the server said after installing, kept on the page until the reader closes it.
    @State private var installed: (effect: String, output: String)?
    private var dirty: Bool { installed == nil && !target.trimmingCharacters(in: .whitespaces).isEmpty }
    private var availableScopes: [String] { scopes.filter { $0 != "project" || context.projectId != nil } }
    var body: some View {
        RiffetForm {
            Section {
                RiffetField(prompt: String(localized: "插件 ID 或服务器支持的来源", bundle: .riffet), text: $target).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            if availableScopes.count > 1 {
                Section {
                    Picker(selection: $scope) { ForEach(availableScopes, id: \.self) { Text(ExtText.scope($0)).tag($0) } } label: {
                        Text("安装范围")
                    }.pickerStyle(.segmented).labelsHidden()
                } header: {
                    RiffetSectionTitle(String(localized: "安装范围", bundle: .riffet))
                }
            }
            RiffetNotice.section(.error, error)
            if let installed {
                RiffetNotice.section(.success, installed.effect)
                Section {
                    Text(installed.output).riffetFont(.monoSmall).foregroundStyle(palette.fg2).textSelection(.enabled)
                } header: {
                    RiffetSectionTitle(String(localized: "服务器输出", bundle: .riffet))
                }
            }
        }.navigationTitle(String(localized: "安装插件", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .riffetUnsavedGuard(dirty: dirty, locked: busy, confirming: $discard) { dismiss() }
        .toolbar {
            if installed == nil {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { if dirty { discard = true } else { dismiss() } }.disabled(busy) }
            }
            ToolbarItem(placement: .confirmationAction) {
                if busy { ProgressView() }
                else if installed != nil { Button("完成") { dismiss() } }
                else { Button("安装") { Task { await install() } }.disabled(target.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
        }
        .onAppear { scope = availableScopes.first ?? "user" }
    }
    private func install() async {
        guard let api = workbench.api else { return }; busy = true; defer { busy = false }
        do {
            let result = try await api.extensionAction(context: context, input: ExtensionActionRequest(action: "install", itemId: nil, target: target.trimmingCharacters(in: .whitespaces), scope: scope, expectedHash: nil))
            if result.success {
                let effect = result.applyEffect.isEmpty ? String(localized: "已安装", bundle: .riffet) : result.applyEffect
                error = nil; changed()
                // Text from the server is read here before leaving; without any, a toast says it and the page closes.
                if let output = result.output, !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { installed = (effect, output) }
                else { RiffetToastCenter.shared.show(effect, kind: .success); dismiss() }
            }
            else { error = result.diagnostics?.joined(separator: "\n") ?? result.output ?? String(localized: "安装失败", bundle: .riffet) }
        } catch { self.error = error.riffetMessage }
    }
}
