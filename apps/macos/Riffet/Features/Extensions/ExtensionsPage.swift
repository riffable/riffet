import AppKit
import SwiftUI
import RiffetKit

/// Native extension management for one Agent and type, with independent detail and diagnostic sheets.
struct ExtensionsPage: View {
    let workbench: Workbench

    private enum Tool: String, Identifiable {
        case install, runtime, diagnostics
        var id: String { rawValue }
    }

    @Environment(\.palette) private var palette
    /// Kept by the workbench: a later visit shows the last catalog and re-reads only stale sources.
    private let store: ExtensionsStore
    @State private var projectId: String
    @State private var pendingChange: (() -> Void)?
    @State private var confirmDiscard = false
    @State private var pendingBatch: ExtensionBatchPlan?
    @State private var tool: Tool?
    @State private var toolSourceKey = ""
    @State private var installTarget = ""
    @State private var installScope = "user"
    @State private var toolNotice: String?
    @State private var toolError: String?
    @State private var toolOutput: String?
    @State private var toolLink: URL?
    @State private var toolBusy = false
    @State private var errorDismissal = UUID()
    @State private var bannerDismissal = UUID()

    init(workbench: Workbench) {
        self.workbench = workbench
        store = workbench.pageModels.extensions
        _projectId = State(initialValue: "")
    }

    /// The catalog is read again when the Agent profiles, the project or the server change.
    private var signature: String {
        let profiles = extensionSourceDescriptors(backends: workbench.backends, projectId: projectId.isEmpty ? nil : projectId).map(\.key)
        return "\(workbench.host.api?.baseUrl ?? "")|\(projectId)|\(profiles.joined(separator: ";"))"
    }

    var body: some View {
        Group {
            if workbench.host.api == nil {
                DisconnectedSettings(detail: String(localized: "连接服务器后可以查看和管理扩展。"))
            } else {
                VStack(spacing: 0) {
                    notices
                    manage
                }
            }
        }
        .navigationTitle(WorkbenchPage.extensions.title)
        .pageChrome(.extensions, workbench: workbench, hasActions: workbench.host.api != nil) { toolbarActions }
        .task(id: signature) {
            store.configure(
                api: workbench.host.api,
                backends: workbench.backends,
                projectId: projectId.isEmpty ? nil : projectId,
                projectName: workbench.projects.first { $0.id == projectId }?.name
            )
            await store.loadAll(force: false)
        }
        .task(id: store.neededCapabilityKeys.joined(separator: "\n")) {
            await store.ensureCapabilities(store.neededCapabilityKeys)
        }
        .onDisappear { store.stop() }
        .confirmationDialog(
            pendingBatch?.title ?? "",
            isPresented: Binding(get: { pendingBatch != nil }, set: { if !$0 { pendingBatch = nil } }),
            titleVisibility: .visible,
            presenting: pendingBatch
        ) { plan in
            Button(plan.enable ? "启用" : "停用") { Task { await store.runBatch(plan) } }
            Button("取消", role: .cancel) {}
        } message: { plan in
            Text(plan.message)
        }
        .sheet(item: $tool) { tool in
            toolSheet(tool)
                .interactiveDismissDisabled(toolBusy || store.operationBusy)
                .background(SheetOutsideClick {
                    guard !toolBusy, !store.operationBusy else { return }
                    self.tool = nil
                })
        }
        .sheet(isPresented: inspectorPresentation) { inspectorSheet }
    }

    // MARK: Header

    @ViewBuilder
    private var toolbarActions: some View {
        PageActionButton(title: String(localized: "刷新目录"), symbol: "arrow.clockwise") { store.refresh() }
            .disabled(store.busy || store.loading)
        PageMenuButton(symbol: "ellipsis", help: String(localized: "更多操作")) { NSMenu.choices(moreOptions) }
            .disabled(store.busy)
    }

    private var projectTitle: String { workbench.projects.first { $0.id == projectId }?.name ?? String(localized: "用户配置") }

    private var projectOptions: [ChoiceOption] {
        [ChoiceOption(title: String(localized: "用户配置"), selected: projectId.isEmpty) { select(project: "") }]
            + workbench.projects.map { project in
                ChoiceOption(title: project.name, selected: project.id == projectId) { select(project: project.id) }
            }
    }

    private var moreOptions: [ChoiceOption] {
        [
            ChoiceOption(title: String(localized: "运行状态与 MCP"), selected: false) { openTool(.runtime) },
            ChoiceOption(title: String(localized: "诊断"), selected: false) { openTool(.diagnostics) },
        ]
    }

    @ViewBuilder
    private var notices: some View {
        FeedbackRegion(value: store.error, active: tool == nil && pendingBatch == nil) { error, live in
            noticeBar(color: live ? palette.danger : palette.fg3, text: error) {
                if store.error == error { store.error = nil }
                errorDismissal = UUID()
            }
        }
        .id("\(signature)|error|\(errorDismissal)")
        FeedbackRegion(value: store.banner, active: tool == nil && pendingBatch == nil) { banner, live in
            noticeBar(color: !live ? palette.fg3 : banner.success ? palette.success : palette.warning, title: banner.title, text: banner.text) {
                if store.banner == banner { store.banner = nil }
                bannerDismissal = UUID()
            }
        }
        .id("\(signature)|banner|\(bannerDismissal)")
    }

    private func noticeBar(color: Color, title: String? = nil, text: String, dismiss: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Circle().fill(color).frame(width: 7, height: 7).padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                if let title { Text(title).font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg) }
                if !text.isEmpty {
                    ScrollView {
                        Text(text).font(.riffet(size: S(12))).foregroundStyle(palette.fg2).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 96)
                }
            }
            Spacer(minLength: Space.sm)
            Button(action: dismiss) { Image(icon: "xmark").font(.riffet(size: S(10), weight: .semibold)) }
                .buttonStyle(IconButtonStyle(size: 22))
                .help("关闭")
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.bgSubtle)
        .overlay(alignment: .bottom) { Rectangle().fill(palette.lineSoft).frame(height: 1) }
    }

    // MARK: Manage

    private var manage: some View {
        ExtensionsCatalog(
            store: store,
            onOpen: { key in guarded { store.open(key) } },
            onCreate: { guarded { if let source = store.currentSource { store.beginCreate(source.key) } } },
            onBatch: { enable in Task { pendingBatch = await store.prepareBatch(enable: enable) } },
            onBackend: { backend in guarded {
                store.closeInspector()
                store.setFilters { $0.backend = backend; $0.profileKey = nil }
                store.resetFilters()
            } },
            onKind: { kind in guarded {
                store.closeInspector()
                store.setFilters { $0.kind = kind }
                store.resetFilters()
            } },
            onInstall: { openTool(.install) },
            onDiagnostics: { openTool(.diagnostics) },
            projectTitle: projectTitle,
            projectOptions: projectOptions
        )
        .frame(maxWidth: 1080)
        .padding(.horizontal, Space.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var inspectorPresentation: Binding<Bool> {
        Binding(get: { store.creation != nil || store.selected != nil }, set: { value in
            if !value { guarded { store.closeInspector() } }
        })
    }

    /// Give sheets an actual reading size: an ideal width alone lets SwiftUI collapse to the minimum.
    private func sheetSize(width: CGFloat, height: CGFloat) -> CGSize {
        let visible = (WorkbenchWindows.window(of: workbench)?.screen ?? NSScreen.main)?.visibleFrame.size
            ?? CGSize(width: 1280, height: 900)
        return CGSize(width: min(width, visible.width - 64), height: min(height, visible.height - 112))
    }

    private var inspectorSheet: some View {
        Group {
            if let creation = store.creation {
                ExtensionsInspector(
                    workbench: workbench, store: store, entry: nil, creation: creation, missing: false,
                    onClose: { guarded { store.closeInspector() } }, onOpenOwner: { _ in }
                )
                .id("create|\(extensionContextKey(creation.context))")
            } else if let entry = store.selected {
                ExtensionsInspector(
                    workbench: workbench, store: store, entry: entry, creation: nil, missing: store.selectedMissing,
                    onClose: { guarded { store.closeInspector() } },
                    onOpenOwner: { key in guarded {
                        if let owner = store.entry(key) {
                            store.setFilters { $0.kind = owner.kind }
                            store.resetFilters()
                            store.open(key)
                        }
                    } }
                )
                .id(entry.key)
            }
        }
        .frame(width: sheetSize(width: 960, height: 760).width, height: sheetSize(width: 960, height: 760).height)
        .interactiveDismissDisabled(store.dirty || store.busy)
        .background(SheetOutsideClick { guarded { store.closeInspector() } })
        .confirmationDialog("放弃未保存的扩展更改？", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("放弃更改", role: .destructive) {
                store.dirty = false
                let change = pendingChange
                pendingChange = nil
                change?()
            }
            Button("继续编辑", role: .cancel) { pendingChange = nil }
        }
    }

    // MARK: Navigation guard

    /// Runs a change that leaves the open file after the reader decided about an unsaved draft.
    private func guarded(_ change: @escaping () -> Void) {
        guard !store.busy else { return }
        if store.dirty {
            pendingChange = change
            confirmDiscard = true
        } else {
            change()
        }
    }

    private func select(project id: String) {
        guard id != projectId else { return }
        guarded {
            store.closeInspector()
            projectId = id
        }
    }

    // MARK: Tools

    private func openTool(_ next: Tool) {
        guarded {
            if next == .diagnostics { tool = next; return }
            guard let source = store.currentSource else {
                store.error = String(localized: "没有可用的 Agent 配置。")
                return
            }
            toolSourceKey = source.key
            installTarget = ""
            installScope = "user"
            toolNotice = nil
            toolError = nil
            toolOutput = nil
            toolLink = nil
            tool = next
        }
    }

    private var toolSource: ExtensionSource? { store.source(toolSourceKey) }

    private var installScopes: [String] {
        let supported = toolSource?.capabilities?.installScopes ?? ["user"]
        return ["user", "project"].filter { supported.contains($0) && ($0 != "project" || !projectId.isEmpty) }
    }

    @ViewBuilder
    private func toolSheet(_ tool: Tool) -> some View {
        switch tool {
        case .install: installSheet
        case .runtime: runtimeSheet
        case .diagnostics: diagnosticsSheet
        }
    }

    private var installSheet: some View {
        let source = toolSource
        let supported = source?.capabilities?.actions.contains("install") == true
        let waiting = source?.capabilities == nil && source?.capabilityError == nil
        let unsupported: String? = supported || waiting ? nil : (source?.capabilityError ?? source?.capabilities?.reason ?? String(localized: "此配置不支持原生插件安装。"))
        return ExtensionInstallSheet(
            target: $installTarget,
            scope: Binding(get: { installScopes.contains(installScope) ? installScope : "user" }, set: { installScope = $0 }),
            scopes: installScopes,
            sources: [],
            sourceId: $toolSourceKey,
            error: toolError ?? unsupported,
            notice: toolNotice,
            output: toolOutput,
            busy: toolBusy || waiting,
            canInstall: supported && !toolBusy && !installTarget.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !installScopes.isEmpty,
            onClose: { tool = nil },
            onInstall: {
                guard let source else { return }
                Task {
                    toolBusy = true
                    toolError = nil
                    toolOutput = nil
                    let report = await store.run(
                        context: source.context, item: nil, action: "install",
                        target: installTarget.trimmingCharacters(in: .whitespacesAndNewlines),
                        scope: installScopes.contains(installScope) ? installScope : "user"
                    )
                    toolBusy = false
                    toolOutput = report.details
                    if report.success { toolNotice = report.text.isEmpty ? String(localized: "已安装。") : report.text } else { toolError = report.text }
                }
            }
        )
        .task(id: toolSourceKey) {
            toolError = nil
            toolOutput = nil
            toolNotice = nil
            await store.ensureCapabilities([toolSourceKey])
        }
    }

    private var diagnosticsSheet: some View {
        let lines = store.diagnosticLines
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text("诊断").font(.riffet(size: S(18), weight: .semibold)).foregroundStyle(palette.fg)
                    Text([store.currentSource.map { backendTitle($0.backendId) }, projectTitle].compactMap { $0 }.joined(separator: " · "))
                        .font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                }
                Spacer()
                Button { tool = nil } label: { Image(icon: "xmark") }
                    .buttonStyle(IconButtonStyle()).help("关闭")
            }
            .padding(Space.lg)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if lines.isEmpty {
                        Text(store.loading ? "正在读取扩展" : "暂无诊断记录")
                            .font(.riffet(size: S(12))).foregroundStyle(palette.fg3).padding(.vertical, Space.lg)
                    } else {
                        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                            Text(line).font(.riffet(size: S(12), design: .monospaced))
                                .foregroundStyle(palette.fg2).textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, Space.md)
                            if index < lines.count - 1 { Divider().overlay(palette.lineSoft) }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, Space.lg)
            }
            HStack(spacing: Space.sm) {
                Button("复制记录") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
                }
                .buttonStyle(ChipButtonStyle()).disabled(lines.isEmpty)
                Spacer()
                Button("重新读取") { store.refresh() }.buttonStyle(SolidButtonStyle()).disabled(store.loading || store.busy)
                Button("关闭") { tool = nil }.buttonStyle(SolidButtonStyle())
            }
            .padding(Space.lg)
        }
        .frame(width: sheetSize(width: 800, height: 560).width, height: sheetSize(width: 800, height: 560).height)
        .background(palette.bg)
    }

    private var runtimeSheet: some View {
        let source = toolSource
        let report = store.runtime[toolSourceKey]
        let capabilities = source?.capabilities
        let login = ExtensionRules.canLogin(capabilities)
        let entries = (report?.entries ?? []).map { runtime in
            ExtensionRuntimePresentation(
                id: "\(runtime.sessionId)|\(runtime.kind)|\(runtime.name)",
                sessionId: runtime.sessionId, kind: runtime.kind, name: runtime.name, state: runtime.state,
                message: runtime.message, tools: runtime.tools ?? [], canLogin: runtime.kind == "mcp" && login
            )
        }
        return NavigationStack {
            Form {
                Section {
                    if let source { Text(backendTitle(source.backendId)).font(.riffet(size: S(12))).foregroundStyle(.secondary) }
                    if let error = store.error { SettingsErrorText(message: error) }
                    if let reason = source?.capabilityError { SettingsErrorText(message: reason) }
                    if let report {
                        Text("检查于 \(report.checkedAt)").font(.riffet(size: S(11))).foregroundStyle(.secondary)
                    }
                }
                ExtensionRuntimeSection(
                    entries: entries,
                    diagnostics: report?.diagnostics ?? [],
                    authorizationURL: toolLink,
                    actionOutput: toolOutput,
                    error: toolError,
                    notice: toolNotice,
                    isBusy: toolBusy || store.operationBusy,
                    isDirty: false,
                    canReload: capabilities?.actions.contains("reload") == true,
                    onRuntimeAction: { name, action in runToolAction(action, target: name) },
                    onReload: { runToolAction("reload", target: nil) },
                    onCheck: { Task { if let source { await store.checkRuntime(source.context) } } }
                )
            }
            .riffetForm()
            .navigationTitle("运行状态与 MCP")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { tool = nil }.disabled(toolBusy || store.operationBusy)
                }
            }
        }
        .frame(width: sheetSize(width: 800, height: 620).width, height: sheetSize(width: 800, height: 620).height)
        .task(id: toolSourceKey) {
            toolError = nil
            toolOutput = nil
            toolNotice = nil
            toolLink = nil
            await store.ensureCapabilities([toolSourceKey])
        }
    }

    private func runToolAction(_ action: String, target: String?) {
        guard let source = toolSource else { return }
        Task {
            toolBusy = true
            toolError = nil
            toolOutput = nil
            toolNotice = nil
            toolLink = nil
            let report = await store.run(context: source.context, item: nil, action: action, target: target)
            toolBusy = false
            toolOutput = report.details
            if report.success {
                toolNotice = report.text
                toolLink = report.authorizationURL
            } else {
                toolError = report.text
            }
        }
    }
}
