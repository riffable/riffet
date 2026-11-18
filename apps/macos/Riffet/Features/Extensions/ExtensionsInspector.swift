import SwiftUI
import RiffetKit

/// The detail pane of one catalog entry, or of a new file: overview, runtime state, management
/// actions and the file editor with hash-checked saves. It is keyed by its entry (`.id`), so each
/// selection owns its requests and drafts and an older response cannot reach a newer selection.
struct ExtensionsInspector: View {
    let workbench: Workbench
    let store: ExtensionsStore
    let entry: ExtensionEntry?
    let creation: ExtensionCreation?
    /// The directory no longer lists this entry (a refresh dropped it).
    let missing: Bool
    let onClose: () -> Void
    let onOpenOwner: (String) -> Void

    private enum Mode { case overview, files, runtime, file }

    @Environment(\.palette) private var palette
    @State private var detail: ExtensionDetail?
    @State private var document: ExtensionDocument?
    @State private var editorText = ""
    @State private var mode = Mode.overview
    @State private var creating = false
    @State private var createTarget: ExtensionCreateTarget?
    @State private var createPath = ""
    @State private var createText = ""
    @State private var createInitialPath = ""
    @State private var createInitialText = ""
    @State private var reading = false
    @State private var saving = false
    @State private var actionBusy = false
    @State private var conflict = false
    @State private var error: String?
    @State private var notice: String?
    @State private var actionOutput: String?
    @State private var authorizationURL: URL?
    @State private var showPreview = false
    @State private var previewOperation = "save"
    @State private var previewPath = ""
    @State private var previewText = ""
    @State private var previewEffect = ""
    @State private var confirmDiscardBack = false
    @State private var pendingTargetId: String?
    @State private var confirmReread = false
    @State private var pendingAction: String?
    @State private var documentToken = UUID()
    @State private var requestedDocumentId: String?
    @State private var showSource = false

    private var context: ExtensionContext { entry?.context ?? creation!.context }
    private var contextKey: String { extensionContextKey(context) }
    private var source: ExtensionSource? { store.source(entry?.sourceKey ?? contextKey) }
    private var item: ExtensionItem? { entry?.item ?? detail?.item }
    private var busy: Bool { reading || saving || actionBusy || store.operationBusy }

    private var dirty: Bool {
        if creating { return createPath != createInitialPath || createText != createInitialText }
        return document.map { editorText != $0.content } ?? false
    }

    private var actions: [String] {
        guard let item, entry != nil else { return [] }
        return ExtensionRules.actions(for: item, capabilities: source?.capabilities, inventoryFailed: source?.error != nil || missing)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(palette.line)
            content
        }
        .background(palette.bg)
        .task(id: entry?.item.documentId) { await start() }
        .onChange(of: dirty) { _, value in store.dirty = value }
        .onChange(of: saving) { _, value in store.editorBusy = value }
        .onDisappear {
            store.dirty = false
            store.editorBusy = false
        }
        .sheet(isPresented: $showPreview) {
            previewSheet
                .background(SheetOutsideClick { if !busy { showPreview = false } })
        }
        .confirmationDialog("放弃未保存的更改？", isPresented: $confirmDiscardBack, titleVisibility: .visible) {
            Button("放弃更改", role: .destructive) { leaveFile() }
            Button("继续编辑", role: .cancel) {}
        } message: { Text("当前文档中的内容尚未保存。") }
        .confirmationDialog(
            "放弃未保存的更改？",
            isPresented: Binding(get: { pendingTargetId != nil }, set: { if !$0 { pendingTargetId = nil } }),
            titleVisibility: .visible,
            presenting: pendingTargetId
        ) { id in
            Button("放弃更改", role: .destructive) {
                changeTarget(id, discardingChanges: true)
                pendingTargetId = nil
            }
            .disabled(busy)
            Button("继续编辑", role: .cancel) { pendingTargetId = nil }
        } message: { _ in Text("当前文档中的内容尚未保存。") }
        .confirmationDialog("重新读取文件？", isPresented: $confirmReread, titleVisibility: .visible) {
            Button("重新读取", role: .destructive) {
                if let document { Task { await openDocument(document.id) } }
            }
            Button("继续编辑", role: .cancel) {}
        } message: { Text("当前未保存的修改会被替换。") }
        .confirmationDialog(
            pendingAction.map { actionConfirmTitle($0) } ?? "",
            isPresented: Binding(get: { pendingAction != nil }, set: { if !$0 { pendingAction = nil } }),
            titleVisibility: .visible,
            presenting: pendingAction
        ) { action in
            Button(actionConfirmTitle(action).replacingOccurrences(of: String(localized: "？"), with: ""), role: action == "uninstall" ? .destructive : nil) {
                Task { await perform(action, target: nil) }
            }
            Button("取消", role: .cancel) {}
        } message: { action in
            Text(actionConfirmMessage(action))
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: Space.md) {
                Image(icon: ExtensionText.symbol(item?.kind ?? createTarget?.kind ?? "config"))
                    .font(.riffet(size: S(16))).foregroundStyle(palette.fg3)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(title).font(.riffet(size: S(18), weight: .semibold)).foregroundStyle(palette.fg)
                        .lineLimit(1).truncationMode(.middle).textSelection(.enabled).help(title)
                    Text(headerContext)
                        .font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
                }
                .layoutPriority(1)
                if let reason = item?.readOnlyReason ?? document?.reason, !reason.isEmpty {
                    Image(icon: "lock").font(.riffet(size: S(11)))
                        .foregroundStyle(palette.fg3).help(reason)
                }
                Spacer(minLength: Space.md)
                if dirty {
                    Text("未保存").font(.riffet(size: S(11))).foregroundStyle(palette.warning)
                }
                if !creating, mode != .file, let presentation = detailPresentation {
                    headerActions(presentation)
                }
                Button(action: onClose) { Image(icon: "xmark").font(.riffet(size: S(11), weight: .semibold)) }
                    .buttonStyle(IconButtonStyle(size: 26))
                    .disabled(saving || actionBusy)
                    .help("关闭详情")
            }
            if missing {
                Text("当前目录不再包含此扩展，请刷新目录后重试管理操作。")
                    .font(.riffet(size: S(11.5))).foregroundStyle(palette.warning)
            }
        }
        .padding(.horizontal, Space.xl)
        .padding(.vertical, Space.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func headerActions(_ presentation: ExtensionDetailPresentation) -> some View {
        HStack(spacing: Space.sm) {
            ForEach(presentation.actions.filter { $0.id != "update" && $0.id != "uninstall" }) { action in
                Button(action.title) { request(action.id) }
                    .buttonStyle(ChipButtonStyle())
                    .disabled(busy || dirty || missing || !action.enabled)
                    .help(action.help ?? action.title)
            }
            if let document, document.editable {
                Button { mode = .file } label: { Label("编辑", icon: "square.and.pencil") }
                    .buttonStyle(SolidButtonStyle(kind: .secondary))
                    .disabled(busy || dirty || missing)
            }
            let secondaryActions = presentation.actions.filter { $0.id == "update" || $0.id == "uninstall" }
            if !secondaryActions.isEmpty {
                NativeMenuButton(entries: {
                    secondaryActions.map { action in
                        .item(action.title, enabled: !(busy || dirty || missing) && action.enabled) { request(action.id) }
                    }
                }) {
                    Image(icon: "ellipsis").frame(width: 16, height: 16)
                }
                .buttonStyle(ChipButtonStyle())
                .disabled(busy || dirty || missing)
                .help("更多操作")
            }
        }
        .fixedSize()
    }

    private var headerContext: String {
        let scope = item?.scope ?? createTarget?.scope
        return [backendTitle(context.backendId), scope.map { ExtensionText.scope($0) }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    private var title: String {
        if creating { return String(localized: "新建扩展") }
        if let item { return item.name }
        if let document { return (document.path as NSString).lastPathComponent }
        return String(localized: "扩展文件")
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if creating {
            ExtensionCreateFormContent(
                targets: creation?.targets ?? [],
                targetId: createTarget?.id ?? "",
                onTarget: { changeTarget($0) },
                path: $createPath,
                text: $createText,
                pathLocked: createTarget?.fileName != nil,
                busy: busy,
                error: error,
                canPreview: createTarget != nil && !createPath.trimmingCharacters(in: .whitespaces).isEmpty && !createText.isEmpty,
                onPreview: {
                    previewOperation = "create"
                    previewPath = createPath.trimmingCharacters(in: .whitespacesAndNewlines)
                    previewText = createText
                    previewEffect = createTarget.map { String(localized: "\($0.scope == "project" ? String(localized: "仅当前项目") : String(localized: "用户级"))；创建后：\($0.kind == "skill" ? String(localized: "下次启动或刷新时发现 Skill") : String(localized: "由 Agent 按其原生配置规则读取"))") } ?? ""
                    showPreview = true
                },
                onCancel: onClose
            )
        } else if mode == .file, let document {
            VStack(spacing: 0) {
                if detail != nil {
                    HStack {
                        Button { if dirty { confirmDiscardBack = true } else { leaveFile() } } label: {
                            HStack(spacing: 4) {
                                Image(icon: "chevron.left").font(.riffet(size: S(10), weight: .semibold))
                                Text("返回详情")
                            }
                        }
                        .buttonStyle(ChipButtonStyle())
                        .disabled(busy)
                        Spacer()
                    }
                    .padding(.horizontal, Space.sm)
                    .padding(.top, Space.xs)
                }
                ExtensionDocumentFormContent(
                    path: document.path,
                    language: document.language,
                    editable: document.editable,
                    reason: document.reason,
                    validationNote: document.validationNote,
                    applyEffect: document.applyEffect,
                    conflict: conflict,
                    isBusy: busy,
                    isDirty: dirty,
                    error: error,
                    notice: notice,
                    text: $editorText,
                    onSave: {
                        previewOperation = "save"
                        previewPath = document.path
                        previewText = editorText
                        previewEffect = document.applyEffect
                        showPreview = true
                    },
                    onRetryRead: {
                        if dirty { confirmReread = true } else { Task { await openDocument(document.id) } }
                    }
                )
            }
            .overlay { if reading { Spinner(size: .small) } }
        } else if mode == .file {
            fileState
        } else if let presentation = detailPresentation {
            VStack(spacing: 0) {
                detailTabs
                if let error { SettingsErrorText(message: error, details: actionOutput).padding(Space.md) }
                if let notice {
                    Text(notice).font(.riffet(size: S(12))).foregroundStyle(palette.fg2)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(Space.md)
                }
                if let authorizationURL { Link("打开授权页面", destination: authorizationURL).padding(Space.sm) }
                switch mode {
                case .overview: reader(presentation)
                case .files: fileList(presentation)
                case .runtime: runtimeContent
                case .file: EmptyView()
                }
            }
        } else if let error {
            VStack(spacing: Space.md) {
                SettingsErrorText(message: error)
                Button("重新读取详情") { Task { await loadDetail() } }.buttonStyle(SolidButtonStyle())
            }
            .padding(Space.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Spinner(size: .small).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var detailTabs: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.lg) {
                detailTabGroup
                Spacer(minLength: Space.lg)
                if mode == .overview, let document { documentControls(document) }
            }
            VStack(spacing: 0) {
                HStack { detailTabGroup; Spacer(minLength: 0) }
                if mode == .overview, let document {
                    documentControls(document).padding(.bottom, Space.sm)
                }
            }
        }
        .padding(.horizontal, Space.xl)
        .overlay(alignment: .bottom) { Rectangle().fill(palette.lineSoft).frame(height: 1) }
    }

    private var detailTabGroup: some View {
        HStack(spacing: Space.lg) {
            detailTab(String(localized: "内容"), mode: .overview)
            detailTab(String(localized: "文件 · \(detail?.files.count ?? 0)"), mode: .files)
            detailTab(String(localized: "运行状态"), mode: .runtime)
        }
        .fixedSize()
    }

    private func detailTab(_ title: String, mode target: Mode) -> some View {
        Button { mode = target } label: {
            Text(title)
                .font(.riffet(size: S(12), weight: mode == target ? .medium : .regular))
                .foregroundStyle(mode == target ? palette.fg : palette.fg3)
                .padding(.vertical, Space.sm + 2)
                .overlay(alignment: .bottom) {
                    if mode == target { Rectangle().fill(palette.accent).frame(height: 2) }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(mode == target ? .isSelected : [])
    }

    private func reader(_ presentation: ExtensionDetailPresentation) -> some View {
        VStack(spacing: 0) {
            if let document {
                if reading {
                    Spinner(size: .small).frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if document.language == "markdown", !showSource {
                    ScrollView {
                        MarkdownView(source: markdownBody(document))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, Space.xl)
                            .padding(.vertical, Space.lg)
                    }
                    .id(document.id)
                } else {
                    CodeTextView(text: document.content, language: document.language, palette: palette)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if reading {
                Spinner(size: .small).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.lg) {
                        if let description = presentation.description, !description.isEmpty {
                            Text(description).font(.riffet(size: S(13))).foregroundStyle(palette.fg2)
                                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                        sourceInformation(presentation)
                        if let id = requestedDocumentId, error != nil {
                            Button("重新读取文件") { Task { await openDocument(id) } }.buttonStyle(SolidButtonStyle())
                        } else if !presentation.files.isEmpty {
                            Button("查看文件") { mode = .files }.buttonStyle(SolidButtonStyle())
                        } else {
                            Text("此扩展未提供可查看的文件。")
                                .font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                        }
                    }
                    .padding(Space.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func documentControls(_ document: ExtensionDocument) -> some View {
        HStack(spacing: Space.sm) {
            Text((document.path as NSString).lastPathComponent)
                .font(.riffet(size: S(11), design: .monospaced))
                .foregroundStyle(palette.fg3)
                .lineLimit(1).truncationMode(.middle).help(document.path)
            if !document.editable {
                Image(icon: "lock").font(.riffet(size: S(10)))
                    .foregroundStyle(palette.fg3).help(document.reason ?? String(localized: "只读"))
            }
            if document.language == "markdown" {
                HStack(spacing: Space.xxs) {
                    Button("阅读") { showSource = false }
                        .buttonStyle(ChipButtonStyle(active: !showSource))
                    Button("源码") { showSource = true }
                        .buttonStyle(ChipButtonStyle(active: showSource))
                }
            }
            Button { Task { await openDocument(document.id) } } label: {
                Image(icon: "arrow.clockwise").font(.riffet(size: S(11)))
            }
            .buttonStyle(IconButtonStyle(size: 26)).disabled(busy).help("重新读取文件")
        }
    }

    /// Front matter stays intact in the source and editor; the reader presents the document body.
    private func markdownBody(_ document: ExtensionDocument) -> String {
        let content = document.content
        guard ["skill", "rule", "command"].contains(item?.kind ?? ""), document.id == detail?.item.documentId else { return content }
        let lines = content.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        let frontmatterKeys = ["name:", "description:", "alwaysapply:", "globs:", "paths:"]
        guard lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---"),
              lines[1..<end].contains(where: { line in
                  let trimmed = line.trimmingCharacters(in: .whitespaces).lowercased()
                  return frontmatterKeys.contains(where: { trimmed.hasPrefix($0) })
              }) else { return content }
        return lines.dropFirst(end + 1).joined(separator: "\n")
    }

    private func sourceInformation(_ presentation: ExtensionDetailPresentation) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if let owner = presentation.owner {
                if let key = entry?.ownerKey, store.entry(key) != nil {
                    Button { onOpenOwner(key) } label: {
                        Label(owner, icon: "puzzlepiece.extension")
                    }
                    .buttonStyle(ChipButtonStyle()).disabled(busy).help("所属插件")
                } else {
                    Label(owner, icon: "puzzlepiece.extension").foregroundStyle(palette.fg3)
                }
            }
            if let reason = presentation.readOnlyReason {
                Label(reason, icon: "lock").foregroundStyle(palette.fg3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let sourcePath = presentation.sourcePath {
                DisclosureGroup("来源") {
                    Text(sourcePath).font(.riffet(size: S(11), design: .monospaced))
                        .foregroundStyle(palette.fg3).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, Space.xs)
                }
            }
        }
        .font(.riffet(size: S(12)))
        .foregroundStyle(palette.fg2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func fileList(_ presentation: ExtensionDetailPresentation) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                sourceInformation(presentation)
                if presentation.files.isEmpty {
                    Text("此扩展未提供可查看的文件。").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                }
                VStack(spacing: 0) {
                    ForEach(presentation.files) { file in
                        Button { Task { await openFile(file.id) } } label: {
                            HStack(spacing: Space.sm) {
                                Image(icon: "doc.text").foregroundStyle(palette.fg3)
                                VStack(alignment: .leading, spacing: Space.xs) {
                                    Text(file.name).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg)
                                    Text(file.path).font(.riffet(size: S(10), design: .monospaced)).foregroundStyle(palette.fg3)
                                        .lineLimit(1).truncationMode(.middle)
                                }
                                Spacer(minLength: 0)
                                if !file.editable { Image(icon: "lock").foregroundStyle(palette.fg4) }
                                Image(icon: "chevron.right").font(.riffet(size: S(10), weight: .semibold)).foregroundStyle(palette.fg4)
                            }
                            .padding(.vertical, Space.md)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(busy).help(file.reason ?? file.path)
                        Divider().overlay(palette.lineSoft)
                    }
                }
            }
            .padding(Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var runtimeContent: some View {
        if store.runtime[contextKey] == nil {
            VStack(spacing: Space.md) {
                if let error = store.error {
                    SettingsErrorText(message: error)
                } else {
                    Text("未检查").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                }
                Button("检查运行状态") { Task { await store.checkRuntime(context) } }
                    .buttonStyle(SolidButtonStyle()).disabled(busy)
            }
            .padding(Space.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Form {
                ExtensionRuntimeSection(
                    entries: runtimePresentations,
                    diagnostics: store.runtime[contextKey]?.diagnostics ?? [],
                    authorizationURL: nil,
                    actionOutput: actionOutput,
                    error: store.error,
                    notice: nil,
                    isBusy: busy,
                    isDirty: dirty,
                    canReload: false,
                    onRuntimeAction: { name, action in Task { await perform(action, target: name) } },
                    onReload: {},
                    onCheck: { Task { await store.checkRuntime(context) } }
                )
            }
            .riffetForm()
        }
    }

    @ViewBuilder
    private var fileState: some View {
        VStack(spacing: Space.md) {
            if reading {
                Spinner(size: .small)
            } else {
                Text(error == nil ? "此扩展未提供可查看的文件。" : "文件读取失败。")
                    .font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                SettingsErrorText(message: error)
                Button("返回详情") { leaveFile() }.buttonStyle(SolidButtonStyle())
            }
        }
        .padding(Space.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var previewSheet: some View {
        ExtensionPreviewSheet(
            title: previewOperation == "save" ? String(localized: "保存前预览") : String(localized: "创建前预览"),
            path: previewPath,
            effect: previewEffect,
            text: previewText,
            confirmTitle: previewOperation == "save" ? String(localized: "确认保存") : String(localized: "确认创建"),
            canConfirm: !busy && !previewPath.isEmpty && !previewText.isEmpty,
            onCancel: { showPreview = false },
            onConfirm: {
                showPreview = false
                Task {
                    if previewOperation == "save", let document {
                        await save(document: document, content: previewText)
                    } else if previewOperation == "create", let targetId = createTarget?.id {
                        await create(targetId: targetId, path: previewPath, content: previewText)
                    }
                }
            }
        )
    }

    // MARK: Presentation

    private var detailPresentation: ExtensionDetailPresentation? {
        guard let item, entry != nil, let detail else { return nil }
        let files = detail.files.map { file in
            ExtensionFilePresentation(id: file.id, name: (file.path as NSString).lastPathComponent, path: file.path, editable: file.editable, reason: file.reason)
        }
        return ExtensionDetailPresentation(
            name: item.name,
            kindAndScope: "\(ExtensionText.kind(item.kind)) · \(ExtensionText.scope(item.scope))",
            description: item.description_,
            sourcePath: item.sourcePath,
            owner: item.ownerPluginId == nil ? nil : entry?.sourceLabel,
            readOnlyReason: item.readOnlyReason,
            files: files,
            actions: ExtensionRules.presentations(for: item, actions: actions)
        )
    }

    /// Runtime entries that belong to this item; a hook, an ambiguous MCP server or a TOML-based
    /// Codex / Trae item falls back to the profile's whole report (web `profileRuntime`).
    private var runtimeScope: (entries: [ExtensionRuntimeEntry], profileLevel: Bool) {
        guard let item, let entry else { return ([], false) }
        let report = store.runtime[contextKey]
        let matching = ExtensionRules.runtimeEntries(for: item, ambiguousNativeId: entry.ambiguousNativeId, report: report)
        let profileLevel = matching.isEmpty && (item.kind == "hook" || (item.kind == "mcp" && entry.ambiguousNativeId)
            || ([NativeBackendId.codex, .traex].contains(context.backendId) && item.sourcePath?.hasSuffix(".toml") == true))
        return (profileLevel ? report?.entries ?? [] : matching, profileLevel)
    }

    private var runtimePresentations: [ExtensionRuntimePresentation] {
        let scope = runtimeScope
        let login = ExtensionRules.canLogin(source?.capabilities)
        return scope.entries.map { runtime in
            ExtensionRuntimePresentation(
                id: "\(runtime.sessionId)|\(runtime.kind)|\(runtime.name)",
                sessionId: runtime.sessionId,
                kind: runtime.kind,
                name: runtime.name,
                state: runtime.state,
                message: runtime.message,
                tools: runtime.tools ?? [],
                canLogin: runtime.kind == "mcp" && scope.profileLevel && login
            )
        }
    }

    private func actionConfirmTitle(_ action: String) -> String {
        guard let item else { return "" }
        let label = item.kind == "skill" && action == "uninstall" ? String(localized: "删除 Skill") : ExtensionText.action(action)
        return String(localized: "\(label) \(item.name)？")
    }

    private func actionConfirmMessage(_ action: String) -> String {
        guard let item else { return "" }
        if item.kind == "skill" && action == "uninstall" {
            return String(localized: "将整个 Skill 目录从来源位置移出并备份。若此目录由多个 Agent 共用，这些 Agent 都会受到影响。现有会话的生效时机由原生 Agent 决定。")
        }
        if let note = item.managementNote, !note.isEmpty { return String(localized: "\(note)现有会话的生效时机由原生 Agent 决定。") }
        if item.kind == "skill" { return String(localized: "技能开关写入当前 Agent 配置，其他项目也可能受影响。现有会话的生效时机由原生 Agent 决定。") }
        return String(localized: "\(item.scope == "project" ? String(localized: "项目级") : String(localized: "用户级"))操作。现有会话的生效时机由原生 Agent 决定。")
    }

    // MARK: Loading

    private func start() async {
        // Batch actions may rename a Skill's main file while its catalog identity stays stable.
        guard !dirty else { return }
        if let creation, let first = creation.targets.first {
            creating = true
            mode = .file
            createTarget = first
            applyDefaults()
        } else if entry != nil {
            await loadDetail(refreshDocument: detail != nil)
        }
    }

    private func loadDetail(refreshDocument: Bool = false) async {
        guard let entry, let api = workbench.host.api else { return }
        reading = true
        error = nil
        actionOutput = nil
        defer { reading = false }
        do {
            let loaded = try await api.extension(context: entry.context, itemId: entry.item.id)
            guard !Task.isCancelled else { return }
            let wasMainDocument = requestedDocumentId == detail?.item.documentId
            let retainedFileId = loaded.files.first { $0.id == requestedDocumentId }?.id
            detail = loaded
            if refreshDocument {
                document = nil
                editorText = ""
                requestedDocumentId = wasMainDocument ? loaded.item.documentId : (retainedFileId ?? loaded.item.documentId)
            }
            if document == nil, let id = requestedDocumentId ?? loaded.item.documentId {
                await openDocument(id)
            }
        } catch {
            if !Task.isCancelled { self.error = error.riffetMessage }
        }
    }

    private func openFile(_ id: String) async {
        mode = .overview
        document = nil
        showSource = false
        await openDocument(id)
    }

    private func openDocument(_ id: String) async {
        guard let api = workbench.host.api else { return }
        let token = UUID()
        documentToken = token
        requestedDocumentId = id
        reading = true
        error = nil
        actionOutput = nil
        notice = nil
        conflict = false
        defer { if documentToken == token { reading = false } }
        do {
            let loaded = try await api.extensionDocument(context: context, documentId: id)
            guard documentToken == token, !Task.isCancelled else { return }
            document = loaded
            editorText = loaded.content
        } catch {
            guard documentToken == token else { return }
            self.error = error.riffetMessage
        }
    }

    private func leaveFile() {
        mode = .overview
        editorText = document?.content ?? ""
        conflict = false
        error = nil
        actionOutput = nil
        notice = nil
    }

    // MARK: Editing

    private func applyDefaults() {
        let defaults = ExtensionCreateDefaults.values(for: createTarget)
        createPath = defaults.path
        createText = defaults.text
        createInitialPath = defaults.path
        createInitialText = defaults.text
    }

    private func changeTarget(_ id: String, discardingChanges: Bool = false) {
        guard !busy, let target = creation?.targets.first(where: { $0.id == id }), target.id != createTarget?.id else { return }
        if dirty, !discardingChanges {
            pendingTargetId = id
            return
        }
        createTarget = target
        applyDefaults()
        error = nil
        actionOutput = nil
    }

    private func save(document: ExtensionDocument, content: String) async {
        guard let api = workbench.host.api else { return }
        saving = true
        error = nil
        actionOutput = nil
        conflict = false
        defer { saving = false }
        do {
            let updated = try await api.saveExtensionDocument(context: context, documentId: document.id, content: content, expectedHash: document.contentHash)
            self.document = updated
            editorText = updated.content
            notice = String(localized: "已保存。\(updated.applyEffect)")
            await store.changed([contextKey])
        } catch {
            conflict = isConfigConflict(error)
            self.error = conflict ? String(localized: "文件已在其他地方修改，草稿已保留。重新读取后再保存。") : error.riffetMessage
        }
    }

    private func create(targetId: String, path: String, content: String) async {
        guard let api = workbench.host.api else { return }
        saving = true
        error = nil
        actionOutput = nil
        defer { saving = false }
        do {
            let created = try await api.createExtensionDocument(context: context, targetId: targetId, path: path, content: content)
            creating = false
            createTarget = nil
            document = created
            editorText = created.content
            notice = String(localized: "已创建。\(created.applyEffect)")
            await store.changed([contextKey])
        } catch {
            conflict = isConfigConflict(error)
            self.error = error.riffetMessage
        }
    }

    // MARK: Actions

    private func request(_ action: String) {
        guard let item else { return }
        if action == "uninstall" || item.kind == "skill" {
            pendingAction = action
        } else {
            Task { await perform(action, target: nil) }
        }
    }

    private func perform(_ action: String, target: String?) async {
        guard let item, !actionBusy else { return }
        actionBusy = true
        error = nil
        actionOutput = nil
        notice = nil
        authorizationURL = nil
        defer { actionBusy = false }
        let report = await store.run(context: context, item: target == nil ? item : nil, action: action, target: target)
        if report.success {
            authorizationURL = report.authorizationURL
            if action == "uninstall" {
                onClose()
                return
            }
            await loadDetail(refreshDocument: true)
            notice = report.text
        } else {
            error = report.text
            actionOutput = report.details
        }
    }
}
