import SwiftUI
import RiffetKit

/// 文件与编辑器. Text fields save when the reader presses Return or leaves them; switches, pickers
/// and the folder panel save at once. There is no save button.
struct FilesSettings: View {
    private enum Field { case editor, workspaceRoot }

    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @AppStorage("riffet.editor") private var localEditor = Self.editors.first?.id ?? ""
    /// Installed editors are a Launch Services lookup each; read once, then re-read off the main thread.
    @State private var installed = Self.editors
    @State private var editor = ""
    @State private var savedEditor = ""
    @State private var save = SettingsSaveState()
    @State private var workspaceRoot = ""
    @State private var savedWorkspaceRoot = ""
    @State private var workspaceLocation: TaskWorkspaceLocation?
    @State private var workspaceSave = SettingsSaveState()
    @State private var refreshedAt = Date.distantPast
    @FocusState private var focus: Field?

    private static var editors = EditorLauncher.installed

    var body: some View {
        Form {
            // The local editor is this Mac's; the server command is shared, so the two are apart.
            SettingsBlock("编辑器", scope: .mac) {
                SettingsRow("在这台 Mac 上打开") {
                    Picker("在这台 Mac 上打开", selection: $localEditor) {
                        Text("系统默认").tag("")
                        ForEach(installed) { Text($0.name).tag($0.id) }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
            }
            Section {
                if let workbench = model.workbench {
                    SettingsRow(String(localized: "服务器命令"), detail: workbench.local ? nil : String(localized: "在服务器电脑上运行。")) {
                        HStack(spacing: Space.sm) {
                            SettingsFeedback(state: save, explicit: true)
                            TextField("服务器命令", text: $editor, prompt: Text(verbatim: "cursor"))
                                .labelsHidden()
                                .font(.riffet(size: S(13), design: .monospaced))
                                .formField()
                                .frame(width: 200)
                                .focused($focus, equals: .editor)
                                .onSubmit { Task { await saveEditor(workbench) } }
                                .disabled(save.busy)
                        }
                    }
                } else {
                    SettingsHint("连接服务器后可修改其余设置。")
                }
            }
            if let workbench = model.workbench {
                serverSections(workbench)
            }

            SettingsScopeFooter()
        }
        .riffetForm()
        .onChange(of: focus) { previous, _ in
            guard let workbench = model.workbench else { return }
            switch previous {
            case .editor: Task { await saveEditor(workbench) }
            case .workspaceRoot: Task { await saveWorkspaceRoot(workbench) }
            case nil: break
            }
        }
        .task {
            syncFromServer(force: true)
            await refreshEditors()
        }
        .task(id: model.workbench?.supportsProjectlessTasks) {
            await loadWorkspaceLocation()
        }
        .onChange(of: model.workbench?.settings?.taskWorkspaceRoot) { _, _ in
            let value = model.workbench?.settings?.taskWorkspaceRoot ?? ""
            if workspaceRoot == savedWorkspaceRoot { workspaceRoot = value }
            savedWorkspaceRoot = value
            Task { await loadWorkspaceLocation() }
        }
        .onChange(of: model.workbench?.settings?.editorCommand) { _, _ in syncFromServer(force: false) }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == SettingsSection.files.rawValue,
                  Date.now.timeIntervalSince(refreshedAt) > 30 else { return }
            refreshedAt = .now
            Task { await refreshEditors() }
            guard let workbench = model.workbench else { return }
            Task {
                if let latest = try? await workbench.host.api?.settings() {
                    workbench.store.applySavedSettings(settings: latest)
                }
                syncFromServer(force: false)
            }
        }
    }

    @ViewBuilder
    private func serverSections(_ workbench: Workbench) -> some View {
        let outside = workbench.settings?.allowOutsideRead?.boolValue != false
        if workbench.supportsProjectlessTasks {
            SettingsBlock("无项目会话的目录") {
                SettingsFieldRow(
                    String(localized: "存放位置"),
                    detail: workbench.local ? String(localized: "仅影响新任务。") : String(localized: "服务器目录，仅影响新任务。")
                ) {
                    HStack(spacing: Space.sm) {
                        TextField("存放位置", text: $workspaceRoot, prompt: Text(workspaceLocation?.path ?? ""))
                            .font(.riffet(size: S(13), design: .monospaced))
                            .formField()
                            .focused($focus, equals: .workspaceRoot)
                            .onSubmit { Task { await saveWorkspaceRoot(workbench) } }
                        if workbench.local {
                            Button {
                                Task {
                                    guard let url = await DirectoryPanel.choose(prompt: String(localized: "无项目会话的目录")) else { return }
                                    workspaceRoot = url.path
                                    await saveWorkspaceRoot(workbench)
                                }
                            } label: {
                                Image(icon: "folder").font(.riffet(size: S(12)))
                            }
                            .buttonStyle(IconButtonStyle(size: 26))
                            .help("浏览…")
                        }
                        if !savedWorkspaceRoot.isEmpty {
                            Button("默认") {
                                workspaceRoot = ""
                                Task { await saveWorkspaceRoot(workbench) }
                            }
                            .buttonStyle(SolidButtonStyle(kind: .secondary))
                            .controlSize(.small)
                        }
                        SettingsFeedback(state: workspaceSave, explicit: true)
                    }
                    .disabled(workspaceSave.busy)
                }
                if let location = workspaceLocation {
                    // The resolved directory, when what was typed is not already it.
                    if !savedWorkspaceRoot.isEmpty, savedWorkspaceRoot != location.path {
                        HStack(spacing: Space.sm) {
                            Text(location.path)
                                .font(RiffetFont.codeSmall)
                                .foregroundStyle(palette.fg3)
                                .textSelection(.enabled)
                            Spacer(minLength: 0)
                            CopyButton(text: location.path, help: String(localized: "复制路径"))
                        }
                    }
                    if !location.available {
                        SettingsErrorText(message: location.error.flatMap { L10n.shared.errorText(code: $0, params: [:], message: "") }
                            ?? String(localized: "无法写入此位置，请选择其他目录"))
                    }
                }
            }
        }
        SettingsBlock("文件访问") {
            SettingsRow(String(localized: "允许预览项目外的文件"), detail: String(localized: "只读打开项目外路径；文件树与搜索仍限项目内。")) {
                Toggle("允许预览项目外的文件", isOn: Binding(
                    get: { outside },
                    set: { value in Task { await saveOutside(workbench, value) } }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .disabled(save.busy)
            }
        }
    }

    private func refreshEditors() async {
        let found = await Task.detached(priority: .userInitiated) { EditorLauncher.installed }.value
        Self.editors = found
        if found != installed { installed = found }
    }

    private func syncFromServer(force: Bool) {
        let value = model.workbench?.settings?.editorCommand ?? ""
        if force || editor == savedEditor { editor = value }
        savedEditor = value
        let root = model.workbench?.settings?.taskWorkspaceRoot ?? ""
        if force || workspaceRoot == savedWorkspaceRoot { workspaceRoot = root }
        savedWorkspaceRoot = root
    }

    private func loadWorkspaceLocation() async {
        guard let workbench = model.workbench, workbench.supportsProjectlessTasks else { return }
        let request = RequestContext { model.workbench?.baseURL }
        let location = try? await workbench.host.api?.taskWorkspaceLocation()
        guard request.isCurrent else { return }
        workspaceLocation = location
    }

    private func saveWorkspaceRoot(_ workbench: Workbench) async {
        guard workspaceRoot.trimmingCharacters(in: .whitespacesAndNewlines) != savedWorkspaceRoot, !workspaceSave.busy else { return }
        await workspaceSave.run {
            try await SettingsStore.save(workbench, SettingsPatch.make(taskWorkspaceRoot: workspaceRoot.trimmingCharacters(in: .whitespacesAndNewlines)))
            savedWorkspaceRoot = workbench.settings?.taskWorkspaceRoot ?? ""
            workspaceRoot = savedWorkspaceRoot
            await loadWorkspaceLocation()
        }
    }

    private func saveOutside(_ workbench: Workbench, _ enabled: Bool) async {
        await save.run {
            try await SettingsStore.save(workbench, SettingsPatch.make(allowOutsideRead: enabled))
        }
    }

    private func saveEditor(_ workbench: Workbench) async {
        guard editor != savedEditor, !save.busy else { return }
        await save.run {
            try await SettingsStore.save(workbench, SettingsPatch.make(editorCommand: editor))
            savedEditor = model.workbench?.settings?.editorCommand ?? editor
            editor = savedEditor
        }
    }
}
