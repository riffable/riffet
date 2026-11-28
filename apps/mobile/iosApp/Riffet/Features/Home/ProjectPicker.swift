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
    var serverID: String? = nil
    var serverNames: [String: String] = [:]
    var onBrowse: (() -> Void)?
    let onSelect: (Project?) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var query = ""

    private var candidates: [Project] {
        let base = workbench.list.projects.filter { $0.archivedAt == nil && $0.isTaskTarget }
        guard let serverID else { return base }
        return base.filter { workbench.serverOf($0.id) == serverID }
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
                        if row.nested { Image(systemName: "arrow.triangle.branch").riffetFont(.caption).foregroundStyle(palette.fg3).padding(.leading, 16) }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.nested ? (project.worktree?.branch ?? project.name) : project.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                            if project.worktree == nil {
                                let hint = [serverNames[project.id], directoryHint(project)].compactMap { $0 }.joined(separator: " · ")
                                Text(hint).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head)
                            }
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
        if shown { Image(systemName: "checkmark").riffetFont(.label, weight: .semibold).foregroundStyle(palette.accent) }
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
    var serverID: String = ""
    var serverName: String? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var showArchived = false
    @State private var mutating: String?
    @State private var error: String?
    @State private var editing: ProjectEditTarget?
    /// The Mac's favorite folders: one tap makes one the project.
    @State private var favorites = FolderFavoritesModel()
    @State private var renamingFavorite: FolderFavorite?
    @Environment(\.palette) private var palette

    private var projects: [Project] {
        workbench.list.projects.filter {
            $0.isTaskTarget &&
            (serverID.isEmpty ? (workbench.homeServerOptions.isEmpty || workbench.serverOf($0.id).isEmpty) : workbench.serverOf($0.id) == serverID) &&
            (showArchived || $0.archivedAt == nil) &&
            (search.isEmpty || "\($0.name) \($0.cwd) \(($0.tags ?? []).joined(separator: " "))".localizedCaseInsensitiveContains(search))
        }
    }

    var body: some View {
        NavigationStack {
            RiffetList {
                RiffetNotice.section(.error, error)
                ForEach(projects, id: \.id) { project in
                    Button { Task { await choose(project) } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: project.archivedAt == nil ? "folder" : "archivebox").foregroundStyle(palette.fg2)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(project.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                                Text(project.archivedAt == nil ? directoryHint(project) : "\(String(localized: "已归档", bundle: .riffet)) · \(directoryHint(project))")
                                    .riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head)
                            }
                            Spacer(minLength: 4)
                            if mutating == project.id { ProgressView() }
                            else if selection == project.id { Image(systemName: "checkmark").riffetFont(.label, weight: .semibold).foregroundStyle(palette.accent) }
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
                        }.tint(palette.warning)
                        Button { editing = ProjectEditTarget(project: project, kind: .name) } label: { Label("重命名", systemImage: "pencil") }.tint(palette.accent)
                    }
                }
                if projects.isEmpty {
                    Group {
                        if search.isEmpty { ContentUnavailableView("没有项目", systemImage: "folder") }
                        else { ContentUnavailableView.search(text: search) }
                    }
                    .frame(maxWidth: .infinity).listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
                if serverID.isEmpty, search.isEmpty, !favorites.favorites.isEmpty {
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
                        .onMove { source, destination in Task { await favorites.reorder(fromOffsets: source, toOffset: destination) } }
                        if let error = favorites.error { RiffetNotice(kind: .error, message: error) }
                    } header: { Text("收藏的目录") }
                }
                Section {
                    NavigationLink {
                        RemoteDirectoryPicker(workbench: workbench, serverID: serverID, serverName: serverName) { project in selection = project.id; dismiss() }
                    } label: { Label(serverName.map { "选择 \($0) 上的目录" } ?? "选择 Mac 上的其他目录", systemImage: "folder.badge.plus") }
                    .disabled(mutating != nil)
                    Toggle("显示已归档项目", isOn: $showArchived).tint(palette.primary)
                }
            }
            .navigationTitle(String(localized: "项目范围", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: String(localized: "搜索名称、路径或标签", bundle: .riffet))
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.disabled(mutating != nil) }
                if favorites.favorites.count > 1 && search.isEmpty { ToolbarItem(placement: .cancellationAction) { EditButton() } }
            }
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
    @State private var confirming = false
    @FocusState private var focused: Bool
    private let original: String
    private var dirty: Bool { value != original }

    init(workbench: Workbench, target: ProjectEditTarget) {
        self.workbench = workbench; self.target = target
        original = target.kind == .name ? target.project.name : (target.project.tags ?? []).joined(separator: ", ")
        _value = State(initialValue: original)
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
                RiffetNotice.section(.error, error)
            }
            .navigationTitle(target.kind == .name ? String(localized: "重命名项目", bundle: .riffet) : String(localized: "项目标签", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { if dirty { confirming = true } else { dismiss() } }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "保存中…" : "保存") { Task { await save() } }
                        .disabled(saving || (target.kind == .name && value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
            .riffetUnsavedGuard(dirty: dirty, locked: saving, confirming: $confirming) { dismiss() }
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
    var serverID: String = ""
    var serverName: String? = nil
    let choose: (Project) -> Void
    @State private var directory: BrowseResult?
    @State private var path = ""
    @State private var loading = false
    @State private var selecting = false
    @State private var error: String?
    @State private var favorites = FolderFavoritesModel()
    @State private var renamingFavorite: FolderFavorite?
    @Environment(\.palette) private var palette
    private var showFavorites: Bool { serverID.isEmpty }
    private var hostLabel: String { serverName ?? workbench.baseURL.host ?? "Mac" }
    var body: some View {
        RiffetList {
            if showFavorites, !favorites.favorites.isEmpty {
                Section("收藏") {
                    ForEach(favorites.favorites, id: \.id) { favorite in
                        Button { Task { await load(favorite.path) } } label: { FolderFavoriteLabel(favorite: favorite, showsPath: false) }
                            .buttonStyle(.plain)
                            .disabled(!favorite.exists || loading)
                            .contextMenu { FolderFavoriteMenu(model: favorites, favorite: favorite) { renamingFavorite = favorite } }
                    }
                    .onMove { source, destination in Task { await favorites.reorder(fromOffsets: source, toOffset: destination) } }
                }
            }
            Section {
                RiffetField(prompt: String(localized: "Mac 上的目录", bundle: .riffet), text: $path, mono: true)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.go)
                    .onSubmit { Task { await load(path) } }
            }
            RiffetNotice.section(.error, error ?? favorites.error)
            if loading { ProgressView() }
            if let directory {
                if let parent = directory.parent { Button("上一级", systemImage: "arrow.up") { Task { await load(parent) } } }
                ForEach(directory.entries.filter { !$0.hidden }, id: \.name) { entry in
                    let child = (directory.path as NSString).appendingPathComponent(entry.name)
                    let starred = favorites.favorite(at: child) != nil
                    Button { Task { await load(child) } } label: {
                        HStack {
                            Label(entry.name, systemImage: "folder")
                            if starred { Spacer(); Image(systemName: "star.fill").foregroundStyle(palette.warning).riffetFont(.caption) }
                        }
                    }
                    .contextMenu { Button(starred ? "取消收藏" : "收藏", systemImage: starred ? "star.slash" : "star") { Task { await favorites.toggle(child) } } }
                    .swipeActions(edge: .trailing) {
                        Button { Task { await favorites.toggle(child) } } label: { Label(starred ? "取消收藏" : "收藏", systemImage: starred ? "star.slash" : "star") }.tint(palette.warning)
                    }
                }
                Section {
                    Button(selecting ? "正在添加…" : "使用这个目录") {
                        Task {
                            selecting = true
                            defer { selecting = false }
                            do {
                                let project = try await workbench.store.openDirectory(path: directory.path, serverId: serverID.isEmpty ? nil : serverID)
                                choose(project)
                            } catch { self.error = error.riffetMessage }
                        }
                    }.disabled(selecting || loading)
                } footer: { Text("目录位于 \(hostLabel)，不是 iPhone 的本机文件。") }
            }
        }
        .navigationTitle(serverName.map { "\($0) 上的目录" } ?? String(localized: "Mac 上的目录", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if showFavorites, favorites.favorites.count > 1 { ToolbarItem(placement: .topBarTrailing) { EditButton() } }
            if showFavorites, let current = directory?.path {
                let starred = favorites.favorite(at: current) != nil
                ToolbarItem(placement: .topBarTrailing) {
                    Button(starred ? "取消收藏此目录" : "收藏此目录", systemImage: starred ? "star.fill" : "star") { Task { await favorites.toggle(current) } }
                        .tint(starred ? palette.warning : nil)
                }
            }
        }
        .modifier(FolderFavoriteRenameAlert(model: favorites, target: $renamingFavorite))
        .task {
            if directory == nil { await load(nil) }
            if showFavorites { await favorites.load(workbench.api) }
        }
    }
    private func load(_ requested: String?) async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do { directory = try await workbench.apiForServer(serverID)?.browse(path: requested); path = directory?.path ?? requested ?? "" }
        catch { self.error = error.riffetMessage }
    }
}

/// Bottom sheet listing entry + linked servers for new sessions (`docs/SERVER-LINKS.md §10`).
struct ServerPickerSheet: View {
    let options: [HomeServerOption]
    let selectedID: String
    let onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        NavigationStack {
            List {
                ForEach(options, id: \.id) { item in
                    Button {
                        onSelect(item.id)
                        dismiss()
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: item.isSelf ? "laptopcomputer" : "server.rack")
                                .riffetFont(.label, weight: .regular)
                                .foregroundStyle(item.usable ? palette.fg2 : palette.fg4)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name)
                                    .riffetFont(.body)
                                    .foregroundStyle(item.usable ? palette.fg : palette.fg3)
                                    .lineLimit(1)
                                if item.reason == nil, !item.subtitle.isEmpty {
                                    Text(item.subtitle)
                                        .riffetFont(.caption)
                                        .foregroundStyle(palette.fg3)
                                        .lineLimit(1)
                                }
                            }
                            Spacer(minLength: 8)
                            if let reason = item.reason {
                                Text(reason).riffetFont(.caption).foregroundStyle(palette.fg3)
                            } else if item.id == selectedID {
                                Image(systemName: "checkmark").riffetFont(.label, weight: .semibold).foregroundStyle(palette.accent)
                            } else {
                                Circle()
                                    .fill(item.online ? palette.success : palette.fg4)
                                    .frame(width: 7, height: 7)
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(RiffetRowPressStyle(radius: 10))
                    .disabled(!item.usable)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden).background(palette.bg)
            .navigationTitle(String(localized: "在哪台服务器新建？", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }
}

/// Bottom sheet choosing the session list's server scope (`docs/SERVER-LINKS.md §10`).
struct ServerScopeSheet: View {
    let peers: [ServerInfo]
    let selectedScope: ServerScopeKind
    let selectedPeerID: String?
    let onSelect: (ServerScopeKind, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        NavigationStack {
            List {
                row(title: String(localized: "本机与本机发起", bundle: .riffet), symbol: "link", selected: selectedScope == .relevant) {
                    onSelect(.relevant, nil); dismiss()
                }
                row(title: String(localized: "全部服务器", bundle: .riffet), symbol: "globe", selected: selectedScope == .all) {
                    onSelect(.all, nil); dismiss()
                }
                row(title: String(localized: "仅本机", bundle: .riffet), symbol: "laptopcomputer", selected: selectedScope == .local) {
                    onSelect(.local, nil); dismiss()
                }
                ForEach(peers, id: \.id) { peer in
                    row(title: peer.name,
                        detail: peer.note?.isEmpty == false ? peer.note : HomeServersKt.formatServerPlatform(platform: peer.platform),
                        symbol: "server.rack",
                        trailing: peer.online ? nil : String(localized: "离线", bundle: .riffet),
                        selected: selectedScope == .peer && selectedPeerID == peer.id) {
                        onSelect(.peer, peer.id); dismiss()
                    }
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden).background(palette.bg)
            .navigationTitle(String(localized: "服务器范围", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }

    private func row(title: String, detail: String? = nil, symbol: String, trailing: String? = nil, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                    if let detail, !detail.isEmpty {
                        Text(detail).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if let trailing { Text(trailing).riffetFont(.caption).foregroundStyle(palette.fg3) }
                if selected { Image(systemName: "checkmark").riffetFont(.label, weight: .semibold).foregroundStyle(palette.accent) }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .buttonStyle(RiffetRowPressStyle(radius: 10))
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }
}

struct CachedSearchView: View {
    let workbench: Workbench
    let query: String
    @State private var hits: [IndexHit] = []
    @State private var loading = true
    @State private var error: String?
    @Environment(\.palette) private var palette
    var body: some View {
        RiffetList {
            if loading { ProgressView().frame(maxWidth: .infinity) }
            RiffetNotice.section(.error, error)
            ForEach(Array(hits.enumerated()), id: \.offset) { _, hit in
                NavigationLink {
                    ConversationView(workbench: workbench, sessionID: hit.sessionId, focusSequence: hit.sequence)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(workbench.listedSession(hit.sessionId)?.shownTitle ?? String(localized: "会话", bundle: .riffet)).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                        Text(hit.snippet).lineLimit(1).riffetFont(.caption).foregroundStyle(palette.fg3)
                    }
                }
            }
            if !loading && hits.isEmpty && error == nil { ContentUnavailableView.search(text: query).listRowBackground(Color.clear) }
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
