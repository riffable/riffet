import AppKit
import SwiftUI
import RiffetKit

struct ProjectConfigSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var projectId = ""
    @State private var configs: [ConfigFile]?
    @State private var selected: ConfigFile?
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @State private var conflict = false
    @State private var creating = false
    @State private var kind = "rules"
    @State private var path = ""
    @State private var content = ""
    @State private var confirmDiscard = false
    @State private var pending: Pending?

    private enum Pending { case open(String), beginCreate, cancelCreate }

    var body: some View {
        Group {
            if let workbench = model.workbench {
                editor(workbench)
            } else {
                DisconnectedSettings()
            }
        }
        // The grouped Form panes sit on the window's own surface; this custom master-detail
        // layout must not fall back to the theme's page colour or the window changes shade here.
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func editor(_ workbench: Workbench) -> some View {
        HStack(spacing: 0) {
            sidebar(workbench)
                .frame(width: 240)
            Rectangle()
                .fill(palette.lineSoft)
                .frame(width: 1)
            detail(workbench)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(Space.lg)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: projectId) { await loadList(workbench) }
        .onAppear { pickInitial(workbench) }
        .confirmationDialog("放弃未保存的配置？", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("放弃更改", role: .destructive) { if let pending { perform(workbench, pending) }; self.pending = nil }
            Button("继续编辑", role: .cancel) { pending = nil }
        } message: {
            Text("当前配置或新建表单中的内容尚未保存。")
        }
    }

    // MARK: - Project column

    private func sidebar(_ workbench: Workbench) -> some View {
        let projects = workbench.projects
        return VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: Space.sm) {
                Text("项目")
                    .font(.riffet(size: S(11.5), weight: .semibold))
                    .foregroundStyle(palette.fg3)
                Spacer(minLength: Space.sm)
                Button { ask(.beginCreate) } label: { Image(icon: "plus") }
                    .buttonStyle(IconButtonStyle(size: 22))
                    .help("新建配置")
                    .disabled(projects.isEmpty)
            }
            if projects.isEmpty {
                ContentUnavailableView("还没有项目", icon: "folder")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Picker("项目", selection: $projectId) {
                    ForEach(projects, id: \.id) { Text($0.name).tag($0.id) }
                }
                .labelsHidden()
                .formPicker()
                configList
            }
        }
        .padding(Space.lg)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    /// The configurations of the chosen project in one hairline card. A row is a button rather than
    /// a `List` selection so the selected treatment stays in the theme's own colours.
    private var configList: some View {
        Group {
            if configs == nil {
                Spinner(size: .small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let configs, configs.isEmpty {
                ContentUnavailableView {
                    Label("还没有配置", icon: "doc")
                } actions: {
                    Button("新建") { ask(.beginCreate) }
                        .buttonStyle(SolidButtonStyle(kind: .primary))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(configs ?? [], id: \.id) { item in
                            configRow(item)
                            if item.id != configs?.last?.id {
                                Rectangle()
                                    .fill(palette.lineSoft)
                                    .frame(height: 1)
                                    .padding(.leading, Space.md)
                            }
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.formFill(palette.bgElevated), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.line))
    }

    private func configRow(_ item: ConfigFile) -> some View {
        let isSelected = selected?.id == item.id
        return Button {
            ask(.open(item.id))
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Space.sm) {
                    Text(item.label)
                        .font(.riffet(size: S(12.5), weight: .medium))
                        .foregroundStyle(isSelected ? palette.accent : palette.fg)
                        .lineLimit(1)
                    if item.scope == .user {
                        Text("用户")
                            .font(.riffet(size: S(10), weight: .medium))
                            .foregroundStyle(palette.fg3)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1.5)
                            .background(palette.bgMuted, in: Capsule())
                            .overlay(Capsule().strokeBorder(palette.lineSoft))
                    }
                    Spacer(minLength: 0)
                }
                Text(item.exists ? item.path : String(localized: "未创建"))
                    .font(.riffet(size: S(11), design: .monospaced))
                    .foregroundStyle(palette.fg3)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? palette.bgActive : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Detail

    @ViewBuilder
    private func detail(_ workbench: Workbench) -> some View {
        if projectId.isEmpty {
            ContentUnavailableView("先选择一个项目", icon: "folder")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if creating {
            createForm(workbench)
        } else if let selected {
            fileEditor(workbench, file: selected)
        } else if configs == nil {
            Spinner(size: .small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView("选择一项配置", icon: "doc")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func fileEditor(_ workbench: Workbench, file: ConfigFile) -> some View {
        let readOnly = file.scope == .user
        let dirty = text != (file.content ?? "")
        return VStack(alignment: .leading, spacing: Space.md) {
            HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(file.label)
                        .font(.riffet(size: S(13), weight: .medium))
                        .foregroundStyle(palette.fg)
                    HStack(spacing: Space.sm) {
                        Text(file.path)
                            .font(.riffet(size: S(11), design: .monospaced))
                            .foregroundStyle(palette.fg3)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if file.fingerprint.isEmpty {
                            SpanBadge(text: String(localized: "新文件"))
                        }
                    }
                }
                Spacer(minLength: Space.sm)
                if readOnly {
                    SettingsStatusBadge(text: String(localized: "只读"), tint: palette.fg3)
                } else {
                    SettingsActionButton("保存", symbol: "square.and.arrow.down", kind: .primary) {
                        Task { await save(workbench, file: file) }
                    }
                    .disabled(!dirty || busy)
                }
                if busy { Spinner(size: .small) }
            }
            Rectangle()
                .fill(palette.lineSoft)
                .frame(height: 1)
            TextEditor(text: $text)
                .font(.riffet(size: S(13), design: .monospaced))
                .disabled(readOnly || busy)
                .scrollContentBackground(.hidden)
                .padding(Space.sm)
                .background(palette.formFill(palette.bgSubtle), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            SettingsErrorText(message: error)
            if conflict {
                SettingsActionButton("重新读取", symbol: "arrow.clockwise") {
                    Task { await open(workbench, id: file.id, force: true) }
                }
            }
        }
        .padding(Space.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(palette.formFill(palette.bgElevated), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.line))
    }

    private func createForm(_ workbench: Workbench) -> some View {
        let projectName = workbench.projects.first { $0.id == projectId }?.name
        return VStack(alignment: .leading, spacing: Space.md) {
            HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                Text(projectName.map { String(localized: "新建配置 · \($0)") } ?? String(localized: "新建配置"))
                    .font(.riffet(size: S(13), weight: .medium))
                    .foregroundStyle(palette.fg)
                Spacer(minLength: Space.sm)
            }
            Rectangle()
                .fill(palette.lineSoft)
                .frame(height: 1)
            SettingsFieldRow("类型") {
                FormSegmented("类型", selection: $kind) {
                    Text("Rule").tag("rules")
                    Text("Skill").tag("skills")
                    Text("Command").tag("commands")
                }
                .labelsHidden()
            }
            SettingsFieldRow("路径") {
                TextField("路径", text: $path, prompt: Text(pathPlaceholder))
                    .textFieldStyle(.plain)
                    .font(.riffet(size: S(13), design: .monospaced))
                    .padding(.horizontal, Space.sm)
                    .padding(.vertical, 6)
                    .background(palette.formFill(palette.bgSubtle), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
            }
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("内容")
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(palette.fg)
                TextEditor(text: $content)
                    .font(.riffet(size: S(13), design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(Space.sm)
                    .background(palette.formFill(palette.bgSubtle), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
                    .frame(minHeight: 180, maxHeight: .infinity)
            }
            .padding(.vertical, 1)
            HStack(spacing: Space.sm) {
                SettingsActionButton("创建", symbol: "plus", kind: .primary) { Task { await create(workbench) } }
                    .disabled(busy || path.trimmingCharacters(in: .whitespaces).isEmpty || content.trimmingCharacters(in: .whitespaces).isEmpty)
                SettingsActionButton("取消") { ask(.cancelCreate) }
                Spacer(minLength: 0)
                if busy { Spinner(size: .small) }
            }
            SettingsErrorText(message: error)
        }
        .padding(Space.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(palette.formFill(palette.bgElevated), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.line))
    }

    /// A path in the shape the Agent's own project files take, learned from the files it lists.
    private var pathPlaceholder: String {
        guard let sample = (configs ?? []).first(where: { $0.kind.name.lowercased() == kind && $0.scope == .project && $0.path.contains("/") }) else { return "" }
        var parts = sample.path.split(separator: "/").map(String.init)
        let file = parts.removeLast()
        if file == "SKILL.md" {
            _ = parts.popLast()
            return (parts + ["name", file]).joined(separator: "/")
        }
        let suffix = file.firstIndex(of: ".").map { String(file[$0...]) } ?? ""
        return (parts + ["name\(suffix)"]).joined(separator: "/")
    }

    private var dirty: Bool {
        if let selected, text != (selected.content ?? "") { return true }
        if creating, kind != "rules" || !path.trimmingCharacters(in: .whitespaces).isEmpty || !content.trimmingCharacters(in: .whitespaces).isEmpty { return true }
        return false
    }

    private func pickInitial(_ workbench: Workbench) {
        guard projectId.isEmpty else { return }
        projectId = workbench.selected?.projectId ?? workbench.homeProjectId ?? workbench.projects.first?.id ?? ""
    }

    private func ask(_ action: Pending) {
        if dirty {
            pending = action
            confirmDiscard = true
        } else {
            guard let workbench = model.workbench else { return }
            perform(workbench, action)
        }
    }

    private func perform(_ workbench: Workbench, _ action: Pending) {
        switch action {
        case let .open(id):
            Task { await open(workbench, id: id, force: true) }
        case .beginCreate:
            selected = nil
            text = ""
            kind = "rules"
            path = ""
            content = ""
            creating = true
            error = nil
            conflict = false
        case .cancelCreate:
            creating = false
            kind = "rules"
            path = ""
            content = ""
            error = nil
        }
    }

    private func loadList(_ workbench: Workbench) async {
        if projectId.isEmpty {
            // The first run comes before a project is picked: pick it here, and let the run for
            // that id load, instead of showing an empty list that then turns into a spinner.
            pickInitial(workbench)
            if !projectId.isEmpty { return }
        }
        guard !projectId.isEmpty, let api = workbench.host.api else {
            configs = []
            return
        }
        configs = nil
        selected = nil
        text = ""
        creating = false
        error = nil
        conflict = false
        do { configs = try await api.configs(projectId: projectId) }
        catch { self.error = error.riffetMessage; configs = [] }
    }

    private func open(_ workbench: Workbench, id: String, force: Bool) async {
        guard let api = workbench.host.api else { return }
        if !force, selected?.id == id, !creating { return }
        creating = false
        busy = true
        error = nil
        conflict = false
        do {
            let full = try await api.config(projectId: projectId, configId: id)
            selected = full
            text = full.content ?? ""
            configs = configs?.map { $0.id == full.id ? full : $0 }
        } catch {
            self.error = error.riffetMessage
        }
        busy = false
    }

    private func save(_ workbench: Workbench, file: ConfigFile) async {
        guard let api = workbench.host.api else { return }
        busy = true
        error = nil
        conflict = false
        do {
            let updated = try await api.saveConfig(projectId: projectId, configId: file.id, content: text, expectedHash: file.fingerprint)
            selected = updated
            text = updated.content ?? text
            configs = configs?.map { $0.id == updated.id ? updated : $0 }
        } catch {
            conflict = isConfigConflict(error)
            self.error = conflict ? String(localized: "文件已被其他地方修改。重新读取后再保存。") : error.riffetMessage
        }
        busy = false
    }

    private func create(_ workbench: Workbench) async {
        guard let api = workbench.host.api else { return }
        busy = true
        error = nil
        do {
            let created = try await api.createConfig(projectId: projectId, kind: kind, path: path.trimmingCharacters(in: .whitespaces), content: content)
            let list = try await api.configs(projectId: projectId)
            configs = list
            path = ""
            content = ""
            creating = false
            let match = list.first { $0.id == created.id || $0.path == created.path } ?? created
            await open(workbench, id: match.id, force: true)
        } catch {
            self.error = error.riffetMessage
        }
        busy = false
    }
}

/// A compact capsule for a config's fingerprint or "new file" state.
private struct SpanBadge: View {
    let text: String
    var monospaced = false
    @Environment(\.palette) private var palette

    var body: some View {
        Text(text)
            .font(.riffet(size: S(10), weight: monospaced ? .regular : .medium, design: monospaced ? .monospaced : .default))
            .foregroundStyle(palette.fg4)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(palette.bgMuted, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
}
