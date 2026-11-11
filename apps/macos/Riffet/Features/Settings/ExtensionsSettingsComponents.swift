import AppKit
import SwiftUI
import RiffetKit

struct ExtensionListRowPresentation: Identifiable {
    let id: String
    let name: String
    let kind: String
    let scope: String
    let state: String?
}

struct ExtensionListGroupPresentation: Identifiable {
    let id: String
    let title: String
    let rows: [ExtensionListRowPresentation]
}

struct ExtensionInventoryRows: View {
    let groups: [ExtensionListGroupPresentation]
    let onSelect: (String) -> Void

    var body: some View {
        ForEach(groups) { group in
            Section(group.title) {
                if group.rows.isEmpty {
                    Text("没有发现扩展")
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(group.rows) { row in
                        Button { onSelect(row.id) } label: {
                            HStack(spacing: 10) {
                                Image(icon: ExtensionText.symbol(row.kind))
                                    .font(.riffet(size: S(14)))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 20)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(row.name)
                                        .font(.riffet(size: S(13), weight: .medium))
                                        .lineLimit(1)
                                    Text("\(ExtensionText.kind(row.kind)) · \(ExtensionText.scope(row.scope))")
                                        .font(.riffet(size: S(11)))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer(minLength: 8)
                                if let state = row.state {
                                    Text(state)
                                        .font(.riffet(size: S(11)))
                                        .foregroundStyle(.secondary)
                                }
                                Image(icon: "chevron.right")
                                    .font(.riffet(size: S(10), weight: .semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .contentShape(Rectangle())
                            .padding(.vertical, 2)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

struct ExtensionFilePresentation: Identifiable {
    let id: String
    let name: String
    let path: String
    let editable: Bool
    let reason: String?
}

struct ExtensionActionPresentation: Identifiable {
    let id: String
    let title: String
    let help: String?
    let enabled: Bool
}

struct ExtensionRuntimePresentation: Identifiable {
    let id: String
    let sessionId: String
    let kind: String
    let name: String
    let state: String
    let message: String?
    let tools: [String]
    let canLogin: Bool
}

struct ExtensionDetailPresentation {
    let name: String
    let kindAndScope: String
    let description: String?
    let sourcePath: String?
    let owner: String?
    let readOnlyReason: String?
    let files: [ExtensionFilePresentation]
    let actions: [ExtensionActionPresentation]
}

struct ExtensionDetailFormContent: View {
    let detail: ExtensionDetailPresentation
    let runtimeEntries: [ExtensionRuntimePresentation]
    let diagnostics: [String]
    let isBusy: Bool
    let isDirty: Bool
    let canReload: Bool
    let authorizationURL: URL?
    let actionOutput: String?
    let error: String?
    let notice: String?
    let onFile: (String) -> Void
    let onAction: (String) -> Void
    let onRuntimeAction: (String, String) -> Void
    let onReload: () -> Void
    /// Shown as "检查运行状态" when set (the extensions page reads runtime state on request).
    var onCheckRuntime: (() -> Void)?

    var body: some View {
        Form {
            Section("扩展") {
                LabeledContent("类型", value: detail.kindAndScope)
                if let description = detail.description, !description.isEmpty {
                    Text(description)
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let owner = detail.owner {
                    LabeledContent("所属插件", value: owner)
                }
                if let reason = detail.readOnlyReason {
                    Label(reason, icon: "lock.fill")
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(.secondary)
                }
                if let sourcePath = detail.sourcePath {
                    LabeledContent("来源") {
                        Text(sourcePath)
                            .font(.riffet(size: S(11), design: .monospaced))
                            .textSelection(.enabled)
                            .lineLimit(2)
                            .truncationMode(.middle)
                    }
                }
            }

            if !detail.actions.isEmpty {
                Section("管理") {
                    ForEach(detail.actions) { action in
                        LabeledContent(action.title) {
                            Button("执行") { onAction(action.id) }
                                .disabled(isBusy || isDirty || !action.enabled)
                                .buttonStyle(.borderless)
                                .help(action.help ?? "")
                        }
                    }
                }
            }

            if !detail.files.isEmpty {
                Section("文件") {
                    ForEach(detail.files) { file in
                        Button { onFile(file.id) } label: {
                            LabeledContent {
                                Image(icon: file.editable ? "chevron.right" : "lock.fill")
                                    .font(.riffet(size: S(10)))
                                    .foregroundStyle(.tertiary)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(file.name)
                                        .font(.riffet(size: S(13)))
                                        .lineLimit(1)
                                    Text(file.path)
                                        .font(.riffet(size: S(10), design: .monospaced))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(isBusy || isDirty)
                        .help(file.reason ?? String(localized: "打开文件"))
                    }
                }
            }

            ExtensionRuntimeSection(
                entries: runtimeEntries,
                diagnostics: diagnostics,
                authorizationURL: authorizationURL,
                actionOutput: actionOutput,
                error: error,
                notice: notice,
                isBusy: isBusy,
                isDirty: isDirty,
                canReload: canReload,
                onRuntimeAction: onRuntimeAction,
                onReload: onReload,
                onCheck: onCheckRuntime
            )
        }
        .riffetForm()
        .navigationTitle(detail.name)
    }
}

struct ExtensionRuntimeSection: View {
    let entries: [ExtensionRuntimePresentation]
    let diagnostics: [String]
    let authorizationURL: URL?
    let actionOutput: String?
    let error: String?
    let notice: String?
    let isBusy: Bool
    let isDirty: Bool
    let canReload: Bool
    let onRuntimeAction: (String, String) -> Void
    let onReload: () -> Void
    var onCheck: (() -> Void)?

    var body: some View {
        Group {
            if authorizationURL != nil || (actionOutput?.isEmpty == false) || error != nil || notice != nil {
                Section("操作结果") {
                    if let authorizationURL {
                        Link("打开授权页面", destination: authorizationURL)
                            .font(.riffet(size: S(12)))
                    }
                    if let actionOutput, !actionOutput.isEmpty, error == nil {
                        Text(actionOutput)
                            .font(.riffet(size: S(11), design: .monospaced))
                            .textSelection(.enabled)
                    }
                    if let error { SettingsErrorText(message: error, details: actionOutput) }
                    if let notice {
                        Text(notice)
                            .font(.riffet(size: S(11)))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Section("当前会话") {
                if entries.isEmpty {
                    Text("没有连接的会话")
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(.secondary)
                }
                ForEach(entries) { entry in
                    HStack(alignment: .top, spacing: Space.md) {
                        VStack(alignment: .leading, spacing: Space.xs) {
                            Text(entry.name)
                                .font(.riffet(size: S(12), weight: .medium))
                            Text("\(ExtensionText.runtimeState(entry.state)) · \(entry.sessionId)")
                                .font(.riffet(size: S(10)))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                            if let message = entry.message, !message.isEmpty {
                                Text(message)
                                    .font(.riffet(size: S(11)))
                                    .foregroundStyle(.secondary)
                            }
                            if !entry.tools.isEmpty {
                                Text("工具：\(entry.tools.joined(separator: ", "))")
                                    .font(.riffet(size: S(10)))
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: Space.sm)
                        if entry.canLogin {
                            Button("认证") { onRuntimeAction(entry.name, "login") }
                                .disabled(isBusy || isDirty)
                        }
                    }
                }
                if !diagnostics.isEmpty {
                    ForEach(Array(diagnostics.enumerated()), id: \.offset) { _, message in
                        Text(message)
                            .font(.riffet(size: S(11), design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                if let onCheck {
                    Button("检查运行状态") { onCheck() }
                        .disabled(isBusy || isDirty)
                }
                if canReload {
                    Button("重载 MCP") { onReload() }
                        .disabled(isBusy || isDirty)
                }
            }
        }
    }
}

struct ExtensionDocumentFormContent: View {
    let path: String
    let language: String
    let editable: Bool
    let reason: String?
    let validationNote: String?
    let applyEffect: String
    let conflict: Bool
    let isBusy: Bool
    let isDirty: Bool
    let error: String?
    let notice: String?
    @Binding var text: String
    let onSave: () -> Void
    let onRetryRead: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack(spacing: Space.md) {
                    Text(path)
                        .font(.riffet(size: S(11), design: .monospaced))
                        .foregroundStyle(palette.fg2)
                        .textSelection(.enabled)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(language.uppercased())
                        .font(.riffet(size: S(10), weight: .medium))
                        .foregroundStyle(palette.fg3)
                }
                if !applyEffect.isEmpty {
                    Text(applyEffect)
                        .font(.riffet(size: S(11)))
                        .foregroundStyle(palette.fg3)
                }
                if let reason {
                    Label(reason, icon: "lock.fill")
                        .font(.riffet(size: S(11)))
                        .foregroundStyle(palette.fg3)
                }
                if let validationNote {
                    Label(validationNote, icon: "info.circle")
                        .font(.riffet(size: S(11)))
                        .foregroundStyle(palette.fg3)
                }
            }
            .padding(Space.lg)
            Divider().overlay(palette.lineSoft)
            TextEditor(text: $text)
                .font(.riffet(size: S(12), design: .monospaced))
                .foregroundStyle(palette.fg)
                .scrollContentBackground(.hidden)
                .disabled(!editable || isBusy)
                .padding(Space.md)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(palette.bgElevated)
            Divider().overlay(palette.lineSoft)
            VStack(alignment: .leading, spacing: Space.sm) {
                if conflict {
                    HStack(spacing: Space.md) {
                        SettingsErrorText(message: String(localized: "文件已被其他程序修改。重新读取后再保存。"))
                        Spacer(minLength: Space.sm)
                        Button("重新读取", action: onRetryRead)
                            .buttonStyle(SolidButtonStyle())
                            .disabled(isBusy)
                    }
                }
                if let error { SettingsErrorText(message: error) }
                if let notice {
                    Text(notice).font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
                }
                if editable {
                    HStack(spacing: Space.sm) {
                        if isBusy { Spinner(size: .small) }
                        Spacer(minLength: Space.sm)
                        Button("预览并保存", action: onSave)
                            .buttonStyle(SolidButtonStyle(kind: .primary))
                            .disabled(!isDirty || isBusy)
                    }
                }
            }
            .padding(Space.lg)
        }
        .background(palette.bg)
        .navigationTitle(path.split(separator: "/").last.map(String.init) ?? path)
    }
}


/// The read-only preview before a save or a create: the path, what the change means, and the full text.
struct ExtensionPreviewSheet: View {
    let title: String
    let path: String
    let effect: String
    let text: String
    let confirmTitle: String
    let canConfirm: Bool
    let onCancel: () -> Void
    let onConfirm: () -> Void

    @Environment(\.palette) private var palette
    @Environment(\.workbenchScope) private var workbench

    private var sheetSize: CGSize {
        let screen = workbench.flatMap { WorkbenchWindows.window(of: $0)?.screen } ?? NSScreen.main
        let visible = screen?.visibleFrame.size ?? CGSize(width: 1280, height: 900)
        return CGSize(width: min(840, visible.width - 64), height: min(640, visible.height - 112))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text(title).font(.riffet(size: S(17), weight: .semibold)).foregroundStyle(palette.fg)
                Text(path)
                    .font(.riffet(size: S(11), design: .monospaced))
                    .foregroundStyle(palette.fg2)
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
                if !effect.isEmpty {
                    Text(effect).font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
                }
            }
            .padding(Space.lg)
            Divider().overlay(palette.lineSoft)
            ScrollView {
                Text(text)
                    .font(.riffet(size: S(12), design: .monospaced))
                    .foregroundStyle(palette.fg)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Space.lg)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(palette.bgElevated)
            Divider().overlay(palette.lineSoft)
            HStack(spacing: Space.sm) {
                Spacer(minLength: Space.sm)
                Button("返回编辑", action: onCancel)
                    .buttonStyle(SolidButtonStyle())
                    .keyboardShortcut(.cancelAction)
                Button(confirmTitle, action: onConfirm)
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canConfirm)
            }
            .padding(Space.lg)
        }
        .frame(width: sheetSize.width, height: sheetSize.height)
        .background(palette.bg)
    }
}

struct ExtensionSourceChoice: Identifiable {
    let id: String
    let title: String
}

/// The plugin install form. Optional sources select the destination Agent.
struct ExtensionInstallSheet: View {
    @Binding var target: String
    @Binding var scope: String
    let scopes: [String]
    var sources: [ExtensionSourceChoice] = []
    @Binding var sourceId: String
    let error: String?
    let notice: String?
    let output: String?
    let busy: Bool
    let canInstall: Bool
    let onClose: () -> Void
    let onInstall: () -> Void

    @Environment(\.palette) private var palette
    @Environment(\.workbenchScope) private var workbench

    private var sheetSize: CGSize {
        let screen = workbench.flatMap { WorkbenchWindows.window(of: $0)?.screen } ?? NSScreen.main
        let visible = screen?.visibleFrame.size ?? CGSize(width: 1280, height: 900)
        return CGSize(width: min(560, visible.width - 64), height: min(360, visible.height - 112))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("安装插件")
                .font(.riffet(size: S(17), weight: .semibold))
                .foregroundStyle(palette.fg)
                .padding(Space.lg)
            Divider().overlay(palette.lineSoft)
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    if !sources.isEmpty {
                        Picker("Agent", selection: $sourceId) {
                            ForEach(sources) { Text($0.title).tag($0.id) }
                        }
                        .disabled(busy)
                    }
                    VStack(alignment: .leading, spacing: Space.sm) {
                        Text("插件来源").font(.riffet(size: S(12), weight: .medium))
                        TextField("插件名或来源（例如 name@marketplace）", text: $target)
                            .textFieldStyle(.roundedBorder)
                            .disabled(busy)
                    }
                    Picker("安装范围", selection: $scope) {
                        Text("用户级").tag("user")
                        if scopes.contains("project") { Text("当前项目").tag("project") }
                    }
                    .disabled(busy)
                    if let error { SettingsErrorText(message: error, details: output) }
                    if let notice { Text(notice).font(.riffet(size: S(12))).foregroundStyle(palette.fg3) }
                    if let output, !output.isEmpty, error == nil {
                        Text(output)
                            .font(.riffet(size: S(11), design: .monospaced))
                            .foregroundStyle(palette.fg2)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .foregroundStyle(palette.fg)
                .padding(Space.lg)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider().overlay(palette.lineSoft)
            HStack(spacing: Space.sm) {
                if busy { Spinner(size: .small) }
                Spacer(minLength: Space.sm)
                Button(notice == nil ? "取消" : "关闭", action: onClose)
                    .buttonStyle(SolidButtonStyle())
                    .keyboardShortcut(.cancelAction)
                    .disabled(busy)
                if notice == nil {
                    Button("安装", action: onInstall)
                        .buttonStyle(SolidButtonStyle(kind: .primary))
                        .keyboardShortcut(.defaultAction)
                        .disabled(!canInstall)
                }
            }
            .padding(Space.lg)
        }
        .frame(width: sheetSize.width, height: sheetSize.height)
        .background(palette.bg)
    }
}

/// The new-file form: target location, relative path and initial text.
struct ExtensionCreateFormContent: View {
    let targets: [ExtensionCreateTarget]
    let targetId: String
    let onTarget: (String) -> Void
    @Binding var path: String
    @Binding var text: String
    let pathLocked: Bool
    let busy: Bool
    let error: String?
    let canPreview: Bool
    let onPreview: () -> Void
    let onCancel: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Space.md) {
                Picker("目标位置", selection: Binding(get: { targetId }, set: onTarget)) {
                    ForEach(targets, id: \.id) { target in
                        Text("\(target.label) · \(ExtensionText.scope(target.scope))").tag(target.id)
                    }
                }
                .disabled(busy)
                TextField("相对路径", text: $path)
                    .font(.riffet(size: S(12), design: .monospaced))
                    .textFieldStyle(.roundedBorder)
                    .disabled(busy || pathLocked)
            }
            .padding(Space.lg)
            Divider().overlay(palette.lineSoft)
            TextEditor(text: $text)
                .font(.riffet(size: S(12), design: .monospaced))
                .foregroundStyle(palette.fg)
                .scrollContentBackground(.hidden)
                .padding(Space.md)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(palette.bgElevated)
                .disabled(busy)
            Divider().overlay(palette.lineSoft)
            VStack(alignment: .leading, spacing: Space.sm) {
                if let error { SettingsErrorText(message: error) }
                HStack(spacing: Space.sm) {
                    if busy { Spinner(size: .small) }
                    Spacer(minLength: Space.sm)
                    Button("取消", action: onCancel)
                        .buttonStyle(SolidButtonStyle())
                        .disabled(busy)
                    Button("预览并创建", action: onPreview)
                        .buttonStyle(SolidButtonStyle(kind: .primary))
                        .disabled(busy || !canPreview)
                }
            }
            .padding(Space.lg)
        }
        .background(palette.bg)
        .navigationTitle("新建扩展")
    }
}
