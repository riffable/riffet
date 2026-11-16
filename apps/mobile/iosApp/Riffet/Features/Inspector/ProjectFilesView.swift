import SwiftUI
import RiffetKit

enum InspectorFailure: LocalizedError {
    case disconnected, invalidURL
    var errorDescription: String? {
        switch self {
        case .disconnected: String(localized: "服务器未连接，请先恢复连接。", bundle: .riffet)
        case .invalidURL: String(localized: "无法生成文件地址。", bundle: .riffet)
        }
    }
}

struct InspectorExport: Identifiable {
    let id = UUID()
    let url: URL
}

struct ProjectFilesView: View {
    let workbench: Workbench
    let project: Project
    var path = ""
    @State private var entries: [FileEntry] = []
    @State private var hits: [SearchHit] = []
    @State private var query = ""
    @State private var contentSearch = false
    @State private var isSearching = false
    @State private var hasSearched = false
    @State private var loading = false
    @State private var hasMore = false
    @State private var error: String?
    @State private var exporting = false
    @State private var exported: InspectorExport?
    @State private var requestID = UUID()
    /// The project's favorite folders; listed at the root, starred on folders everywhere.
    @State private var favorites: FolderFavoritesModel
    @State private var renamingFavorite: FolderFavorite?
    @Environment(\.palette) private var palette

    init(workbench: Workbench, project: Project, path: String = "") {
        self.workbench = workbench
        self.project = project
        self.path = path
        _favorites = State(initialValue: FolderFavoritesModel(projectId: project.id))
    }

    private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private let pageSize: Int32 = 100

    var body: some View {
        List {
            if searching {
                Picker("搜索方式", selection: $contentSearch) {
                    Text("文件名").tag(false)
                    Text("内容").tag(true)
                }.pickerStyle(.segmented)
            }
            RiffetNotice.section(.error, error ?? favorites.error, actionTitle: error == nil ? nil : String(localized: "重试", bundle: .riffet)) { Task { await load() } }
            if path.isEmpty, !searching, !favorites.favorites.isEmpty {
                Section("收藏") {
                    ForEach(favorites.favorites, id: \.id) { favorite in
                        NavigationLink {
                            ProjectFilesView(workbench: workbench, project: project, path: favorite.path)
                        } label: { FolderFavoriteLabel(favorite: favorite, showsPath: false) }
                        .disabled(!favorite.exists)
                        .contextMenu { FolderFavoriteMenu(model: favorites, favorite: favorite) { renamingFavorite = favorite } }
                    }
                    .onMove { source, destination in Task { await favorites.reorder(fromOffsets: source, toOffset: destination) } }
                }
            }
            if isSearching || loading && entries.isEmpty { ProgressView().frame(maxWidth: .infinity) }
            if searching, contentSearch {
                ForEach(Array(hits.enumerated()), id: \.offset) { _, hit in
                    NavigationLink {
                        ProjectFilePage(workbench: workbench, project: project, path: hit.path, targetLine: Int(hit.line))
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(hit.text.trimmingCharacters(in: .whitespaces)).riffetFont(.mono).foregroundStyle(palette.fg).lineLimit(1)
                            Text("\(hit.path):\(hit.line)").riffetFont(.monoSmall).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head)
                        }
                    }
                }
            } else {
                ForEach(entries, id: \.path) { entry in
                    let fullPath = searching ? entry.path : [path, entry.name].filter { !$0.isEmpty }.joined(separator: "/")
                    NavigationLink {
                        if entry.kind == .directory {
                            ProjectFilesView(workbench: workbench, project: project, path: fullPath)
                        } else {
                            ProjectFilePage(workbench: workbench, project: project, path: fullPath)
                        }
                    } label: {
                        HStack {
                            Image(systemName: entry.kind == .directory ? "folder" : "doc")
                                .foregroundStyle(entry.kind == .directory ? palette.accent : palette.fg3)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 4) {
                                    Text(entry.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                                    if entry.kind == .directory, favorites.favorite(at: fullPath) != nil { Image(systemName: "star.fill").riffetFont(.caption).foregroundStyle(palette.warning) }
                                }
                                if searching { Text(fullPath).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head) }
                            }
                            Spacer()
                            if let bytes = entry.size { Text(ByteCountFormatter.string(fromByteCount: bytes.int64Value, countStyle: .file)).riffetFont(.caption).foregroundStyle(palette.fg3) }
                        }
                    }
                    .contextMenu {
                        if entry.kind == .directory {
                            let starred = favorites.favorite(at: fullPath) != nil
                            Button(starred ? "取消收藏" : "收藏文件夹", systemImage: starred ? "star.slash" : "star") { Task { await favorites.toggle(fullPath) } }
                        }
                        Button("复制路径", systemImage: "doc.on.doc") { UIPasteboard.general.string = fullPath }
                        Button(entry.kind == .directory ? "下载为 ZIP" : "下载并分享", systemImage: "square.and.arrow.up") {
                            Task { await export(path: fullPath, directory: entry.kind == .directory) }
                        }
                    }
                }
                if hasMore && !searching {
                    ProgressView().frame(maxWidth: .infinity)
                        .id(entries.count).onAppear { Task { await load(more: true) } }
                }
            }
            if !loading && !isSearching && error == nil && entries.isEmpty && (!contentSearch || hits.isEmpty) {
                if searching {
                    if hasSearched { ContentUnavailableView.search(text: query) }
                    else { ContentUnavailableView("搜索项目文件", systemImage: "magnifyingglass") }
                } else {
                    ContentUnavailableView("空目录", systemImage: "folder")
                }
            }
        }
        .navigationTitle(path.isEmpty ? String(localized: "项目文件", bundle: .riffet) : (path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .riffetSearchable(text: $query, prompt: String(localized: "搜索 Mac 上的项目文件", bundle: .riffet))
        .onSubmit(of: .search) { Task { await load() } }
        .task(id: "\(project.id)|\(path)|\(query)|\(contentSearch)") {
            if searching {
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            }
            await load()
        }
        .refreshable { await load() }
        .task { await favorites.load(workbench.api) }
        .modifier(FolderFavoriteRenameAlert(model: favorites, target: $renamingFavorite))
        .toolbar {
            if !path.isEmpty {
                let starred = favorites.favorite(at: path) != nil
                ToolbarItem(placement: .topBarTrailing) {
                    Button(starred ? "取消收藏此文件夹" : "收藏此文件夹", systemImage: starred ? "star.fill" : "star") { Task { await favorites.toggle(path) } }
                        .tint(starred ? palette.warning : nil)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if exporting { ProgressView() } else {
                    Button("下载目录", systemImage: "arrow.down.circle") { Task { await export(path: path, directory: true) } }
                }
            }
        }
        .toolbar(.hidden, for: .bottomBar)
        .sheet(item: $exported) { NativeShareSheet(items: [$0.url]) }
    }

    private func load(more: Bool = false) async {
        guard let api = workbench.api else { error = InspectorFailure.disconnected.localizedDescription; return }
        if more && loading { return }
        let token = UUID()
        requestID = token
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let content = contentSearch
        let offset = more ? entries.count : 0
        if text.isEmpty { loading = true } else { isSearching = true }
        defer { if requestID == token { loading = false; isSearching = false } }
        do {
            if text.isEmpty {
                let result = try await api.files(projectId: project.id, path: path, limit: KotlinInt(int: pageSize), offset: KotlinInt(int: Int32(offset)))
                guard requestID == token, !Task.isCancelled else { return }
                if more {
                    let known = Set(entries.map(\.name))
                    entries += result.filter { !known.contains($0.name) }
                } else { entries = result }
                entries.sort {
                    if ($0.kind == .directory) != ($1.kind == .directory) { return $0.kind == .directory }
                    return $0.name.localizedStandardCompare($1.name) == .orderedAscending
                }
                hasMore = result.count == pageSize
                hits = []
            } else if content {
                let result = try await api.search(projectId: project.id, query: text)
                guard requestID == token, !Task.isCancelled else { return }
                hits = result
                entries = []
                hasMore = false
                hasSearched = true
            } else {
                let result = try await api.find(projectId: project.id, query: text)
                guard requestID == token, !Task.isCancelled else { return }
                entries = result
                hits = []
                hasMore = false
                hasSearched = true
            }
            error = nil
        } catch {
            guard requestID == token, !Task.isCancelled else { return }
            self.error = error.riffetMessage
        }
    }

    private func export(path: String, directory: Bool) async {
        guard !exporting else { return }
        exporting = true
        defer { exporting = false }
        do {
            let url: URL
            let name: String
            if directory {
                guard let api = workbench.api else { throw InspectorFailure.disconnected }
                let info = try await api.archiveInfo(projectId: project.id, path: path)
                var components = URLComponents(url: workbench.baseURL.appending(path: "api/projects/\(project.id)/archive"), resolvingAgainstBaseURL: false)
                components?.queryItems = [URLQueryItem(name: "path", value: path)]
                guard let archive = components?.url else { throw InspectorFailure.invalidURL }
                url = archive
                name = info.name.hasSuffix(".zip") ? info.name : info.name + ".zip"
            } else {
                guard let file = workbench.resources.fileURL(projectID: project.id, path: path) else { throw InspectorFailure.invalidURL }
                url = file
                name = (path as NSString).lastPathComponent
            }
            let local = try await workbench.resources.file(for: url, name: name)
            exported = InspectorExport(url: local)
        } catch { self.error = error.riffetMessage }
    }
}

