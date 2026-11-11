import SwiftUI
import RiffetKit

/// Where a directory lives without repeating its name: the parent folder when the last segment is the
/// project's name (the usual case), otherwise the whole path; the home directory is written `~`.
func directoryHint(_ project: Project) -> String {
    var path = project.cwd
    while path.count > 1, path.hasSuffix("/") { path.removeLast() }
    path = path.replacingOccurrences(of: #"^(/Users/[^/]+|(/[^/]+)?/home/[^/]+|/root)(?=/|$)"#, with: "~", options: .regularExpression)
    if let slash = path.lastIndex(of: "/"), path[path.index(after: slash)...] == project.name {
        return slash == path.startIndex ? "/" : String(path[..<slash])
    }
    return path
}

/// The project bottom sheet shared by the new-session page and the tasks filter. Worktrees are not
/// listed, except the selected one under its origin. [allLabel] adds a first row that selects nothing;
/// [onBrowse] adds "选择其他目录…" and runs before the sheet closes.
struct ProjectSheet: View {
    let workbench: Workbench
    let selection: String?
    var allLabel: String?
    var onBrowse: (() -> Void)?
    let onSelect: (Project?) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var query = ""

    private var candidates: [Project] {
        workbench.list.projects.filter { $0.archivedAt == nil && $0.isTaskTarget }
    }
    private var searchable: Bool { candidates.count { $0.worktree == nil } > 8 }
    /// Origins in list order, each followed by its worktrees; a worktree whose origin is gone lists on its own.
    private var rows: [(project: Project, nested: Bool)] {
        let all = candidates
        let ids = Set(all.map(\.id))
        let byOrigin = Dictionary(grouping: all.filter { $0.worktree.map { ids.contains($0.originProjectId) } == true }) { $0.worktree?.originProjectId ?? "" }
        let nested = Set(byOrigin.values.joined().map(\.id))
        let ordered = all.filter { !nested.contains($0.id) }.flatMap { origin in
            [(origin, false)] + (byOrigin[origin.id] ?? []).map { ($0, true) }
        }
        let listed = ordered.filter { $0.0.worktree == nil || $0.0.id == selection }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return listed }
        return listed.filter { "\($0.0.name) \($0.0.worktree?.branch ?? "") \($0.0.cwd)".localizedCaseInsensitiveContains(needle) }
    }
    var body: some View {
        NavigationStack {
            List {
                if query.isEmpty, let onBrowse {
                    plainRow { Label("选择其他目录…", systemImage: "folder.badge.plus").riffetFont(.body).foregroundStyle(palette.fg) } action: { onBrowse(); dismiss() }
                }
                if query.isEmpty, let allLabel {
                    plainRow { Text(allLabel).riffetFont(.body).foregroundStyle(palette.fg); Spacer(minLength: 8); check(selection == nil) } action: { choose(nil) }
                }
                ForEach(rows, id: \.project.id) { row in
                    let project = row.project
                    plainRow {
                        if row.nested { Image(systemName: "arrow.triangle.branch").font(.system(size: 13)).foregroundStyle(palette.fg3).padding(.leading, 16) }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.nested ? (project.worktree?.branch ?? project.name) : project.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                            if project.worktree == nil { Text(directoryHint(project)).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head) }
                        }
                        Spacer(minLength: 8)
                        check(project.id == selection)
                    } action: { choose(project) }
                    .accessibilityIdentifier("projectChoice.\(project.id)")
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden).background(palette.bg)
            .navigationTitle(String(localized: "项目", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .modifier(ProjectSearch(enabled: searchable, text: $query))
        }
        .presentationDetents([.medium, .large])
    }
    private func choose(_ project: Project?) { onSelect(project); dismiss() }
    @ViewBuilder private func check(_ shown: Bool) -> some View {
        if shown { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.accent) }
    }
    private func plainRow<Content: View>(@ViewBuilder _ content: () -> Content, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10, content: content).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .buttonStyle(RiffetRowPressStyle(radius: 10))
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16)).listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
}

private struct ProjectSearch: ViewModifier {
    let enabled: Bool
    @Binding var text: String
    func body(content: Content) -> some View {
        if enabled { content.searchable(text: $text, placement: .navigationBarDrawer(displayMode: .always), prompt: String(localized: "搜索项目", bundle: .riffet)) } else { content }
    }
}

struct ProjectPicker: View {
    let workbench: Workbench
    @Binding var selection: String?
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var showArchived = false
    @State private var mutating: String?
    @State private var error: String?
    @State private var editing: ProjectEditTarget?
    /// The Mac's favorite folders: one tap makes one the project.
    @State private var favorites = FolderFavoritesModel()
    @State private var renamingFavorite: FolderFavorite?

    private var projects: [Project] {
        workbench.list.projects.filter {
            $0.isTaskTarget && (showArchived || $0.archivedAt == nil) &&
            (search.isEmpty || "\($0.name) \($0.cwd) \(($0.tags ?? []).joined(separator: " "))".localizedCaseInsensitiveContains(search))
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let error { Label(error, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(.red) }
                ForEach(projects, id: \.id) { project in
                    Button { Task { await choose(project) } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: project.archivedAt == nil ? "folder" : "archivebox").foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(project.name).foregroundStyle(.primary)
                                Text(project.cwd).font(.caption).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
                                if let tags = project.tags, !tags.isEmpty {
                                    Text(tags.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                                if project.archivedAt != nil { Text("已归档 · 选择后恢复").font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer(minLength: 4)
                            if mutating == project.id { ProgressView() }
                            else if selection == project.id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                        }.frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("projectChoice.\(project.id)")
                    .disabled(mutating != nil)
                    .contextMenu {
                        Button("重命名", systemImage: "pencil") { editing = ProjectEditTarget(project: project, kind: .name) }
                        Button("编辑标签", systemImage: "tag") { editing = ProjectEditTarget(project: project, kind: .tags) }
                        if project.archivedAt == nil {
                            Button("归档项目", systemImage: "archivebox") { Task { await archive(project, archived: true) } }
                        } else {
                            Button("恢复项目", systemImage: "arrow.uturn.backward") { Task { await archive(project, archived: false) } }
                        }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button { Task { await archive(project, archived: project.archivedAt == nil) } } label: {
                            Label(project.archivedAt == nil ? "归档" : "恢复", systemImage: project.archivedAt == nil ? "archivebox" : "arrow.uturn.backward")
                        }.tint(.orange)
                        Button { editing = ProjectEditTarget(project: project, kind: .name) } label: { Label("重命名", systemImage: "pencil") }.tint(.blue)
                    }
                }
                if projects.isEmpty { Text(search.isEmpty ? "暂无项目" : "没有匹配的项目").foregroundStyle(.secondary) }
                if search.isEmpty, !favorites.favorites.isEmpty {
                    Section {
                        ForEach(favorites.favorites, id: \.id) { favorite in
                            Button { Task { await open(favorite) } } label: {
                                HStack {
                                    FolderFavoriteLabel(favorite: favorite)
                                    if mutating == favorite.id { ProgressView() }
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(mutating != nil || !favorite.exists)
                            .contextMenu { FolderFavoriteMenu(model: favorites, favorite: favorite) { renamingFavorite = favorite } }
                        }
                        if let error = favorites.error { Text(error).font(.caption).foregroundStyle(.red) }
                    } header: { Text("收藏的目录") }
                }
                Section {
                    NavigationLink {
                        RemoteDirectoryPicker(workbench: workbench) { project in selection = project.id; dismiss() }
                    } label: { Label("选择 Mac 上的其他目录", systemImage: "folder.badge.plus") }
                    .disabled(mutating != nil)
                    Toggle("显示已归档项目", isOn: $showArchived)
                }
            }
            .navigationTitle(String(localized: "项目范围", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: String(localized: "搜索名称、路径或标签", bundle: .riffet))
            .scrollDismissesKeyboard(.interactively)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.disabled(mutating != nil) } }
            .sheet(item: $editing) { target in ProjectEditSheet(workbench: workbench, target: target) }
            .modifier(FolderFavoriteRenameAlert(model: favorites, target: $renamingFavorite))
            .task { await favorites.load(workbench.api) }
        }
    }

    private func choose(_ project: Project) async {
        guard mutating == nil else { return }
        error = nil
        if project.archivedAt != nil {
            mutating = project.id
            defer { mutating = nil }
            do { try await workbench.updateProject(project, archived: false) }
            catch { self.error = error.riffetMessage; return }
        }
        selection = project.id; dismiss()
    }

    /// A favorite becomes the project in one tap; the server stamps it as used.
    private func open(_ favorite: FolderFavorite) async {
        guard mutating == nil else { return }
        mutating = favorite.id; error = nil
        defer { mutating = nil }
        do {
            let project = try await workbench.store.openDirectory(path: favorite.path)
            selection = project.id; dismiss()
        } catch { self.error = error.riffetMessage }
    }
    private func archive(_ project: Project, archived: Bool) async {
        guard mutating == nil else { return }
        mutating = project.id; error = nil
        defer { mutating = nil }
        do { try await workbench.updateProject(project, archived: archived) }
        catch { self.error = error.riffetMessage }
    }
}

private struct ProjectEditTarget: Identifiable {
    enum Kind { case name, tags }
    let id = UUID()
    let project: Project
    let kind: Kind
}

private struct ProjectEditSheet: View {
    let workbench: Workbench
    let target: ProjectEditTarget
    @Environment(\.dismiss) private var dismiss
    @State private var value: String
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focused: Bool

    init(workbench: Workbench, target: ProjectEditTarget) {
        self.workbench = workbench; self.target = target
        _value = State(initialValue: target.kind == .name ? target.project.name : (target.project.tags ?? []).joined(separator: ", "))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(target.kind == .name ? "项目名称" : "标签", text: $value, axis: .vertical)
                        .focused($focused).disabled(saving).lineLimit(1...5)
                } footer: {
                    if target.kind == .tags { Text("多个标签用逗号分隔；清空后保存可移除全部标签。") }
                    else { Text("只更改显示名称，不会移动 Mac 上的目录。") }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(target.kind == .name ? String(localized: "重命名项目", bundle: .riffet) : String(localized: "项目标签", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "保存中…" : "保存") { Task { await save() } }
                        .disabled(saving || (target.kind == .name && value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
            .interactiveDismissDisabled(saving)
            .task { focused = true }
        }.presentationDetents([.medium, .large])
    }

    private func save() async {
        guard !saving else { return }
        saving = true; error = nil
        defer { saving = false }
        do {
            if target.kind == .name {
                try await workbench.updateProject(target.project, name: value.trimmingCharacters(in: .whitespacesAndNewlines))
            } else {
                var seen = Set<String>()
                let tags = value.components(separatedBy: CharacterSet(charactersIn: ",，\n"))
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && seen.insert($0).inserted }
                try await workbench.updateProject(target.project, tags: tags)
            }
            dismiss()
        } catch { self.error = error.riffetMessage }
    }
}

struct RemoteDirectoryPicker: View {
    let workbench: Workbench
    let choose: (Project) -> Void
    @State private var directory: BrowseResult?
    @State private var path = ""
    @State private var loading = false
    @State private var selecting = false
    @State private var error: String?
    @State private var favorites = FolderFavoritesModel()
    @State private var renamingFavorite: FolderFavorite?
    var body: some View {
        List {
            if !favorites.favorites.isEmpty {
                Section("收藏") {
                    ForEach(favorites.favorites, id: \.id) { favorite in
                        Button { Task { await load(favorite.path) } } label: { FolderFavoriteLabel(favorite: favorite, showsPath: false) }
                            .buttonStyle(.plain)
                            .disabled(!favorite.exists || loading)
                            .contextMenu { FolderFavoriteMenu(model: favorites, favorite: favorite) { renamingFavorite = favorite } }
                    }
                }
            }
            Section {
                TextField("Mac 上的目录", text: $path).textInputAutocapitalization(.never).autocorrectionDisabled().onSubmit { Task { await load(path) } }
                Button("前往") { Task { await load(path) } }.disabled(loading)
            }
            if let error = error ?? favorites.error { Text(error).foregroundStyle(.red) }
            if loading { ProgressView() }
            if let directory {
                if let parent = directory.parent { Button("上一级", systemImage: "arrow.up") { Task { await load(parent) } } }
                ForEach(directory.entries.filter { !$0.hidden }, id: \.name) { entry in
                    let child = (directory.path as NSString).appendingPathComponent(entry.name)
                    let starred = favorites.favorite(at: child) != nil
                    Button { Task { await load(child) } } label: {
                        HStack {
                            Label(entry.name, systemImage: "folder")
                            if starred { Spacer(); Image(systemName: "star.fill").foregroundStyle(.orange).font(.caption) }
                        }
                    }
                    .contextMenu { Button(starred ? "取消收藏" : "收藏", systemImage: starred ? "star.slash" : "star") { Task { await favorites.toggle(child) } } }
                    .swipeActions(edge: .trailing) {
                        Button { Task { await favorites.toggle(child) } } label: { Label(starred ? "取消收藏" : "收藏", systemImage: starred ? "star.slash" : "star") }.tint(.orange)
                    }
                }
                Section {
                    Button(selecting ? "正在添加…" : "使用这个目录") {
                        Task {
                            selecting = true
                            defer { selecting = false }
                            do { let project = try await workbench.store.openDirectory(path: directory.path); choose(project) }
                            catch { self.error = error.riffetMessage }
                        }
                    }.disabled(selecting || loading)
                } footer: { Text("目录位于 \(workbench.baseURL.host ?? "Mac")，不是 iPhone 的本机文件。") }
            }
        }
        .navigationTitle(String(localized: "Mac 上的目录", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let current = directory?.path {
                let starred = favorites.favorite(at: current) != nil
                ToolbarItem(placement: .topBarTrailing) {
                    Button(starred ? "取消收藏此目录" : "收藏此目录", systemImage: starred ? "star.fill" : "star") { Task { await favorites.toggle(current) } }
                        .tint(starred ? .orange : nil)
                }
            }
        }
        .modifier(FolderFavoriteRenameAlert(model: favorites, target: $renamingFavorite))
        .task {
            if directory == nil { await load(nil) }
            await favorites.load(workbench.api)
        }
    }
    private func load(_ requested: String?) async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do { directory = try await workbench.api?.browse(path: requested); path = directory?.path ?? requested ?? "" }
        catch { self.error = error.riffetMessage }
    }
}

struct CachedSearchView: View {
    let workbench: Workbench
    let query: String
    @State private var hits: [IndexHit] = []
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        List {
            if loading { ProgressView() }
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(Array(hits.enumerated()), id: \.offset) { _, hit in
                NavigationLink {
                    ConversationView(workbench: workbench, sessionID: hit.sessionId, focusSequence: hit.sequence)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(workbench.list.sessions.first { $0.id == hit.sessionId }?.title ?? String(localized: "会话", bundle: .riffet)).font(.headline)
                        Text(hit.snippet).lineLimit(4).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            if !loading && hits.isEmpty && error == nil { Text("没有缓存消息匹配“\(query)”").foregroundStyle(.secondary) }
        }
        .navigationTitle(String(localized: "消息搜索", bundle: .riffet)).navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .bottomBar)
        .task(id: query) {
            loading = true
            defer { loading = false }
            do { hits = try await workbench.store.searchMessages(query: query, sessionId: nil); error = nil }
            catch { self.error = error.riffetMessage }
        }
    }
}
