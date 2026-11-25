import SwiftUI
import WebKit
import RiffetKit

/// The project's files: a paged directory list, search by name or content, and a preview that
/// cites a file or a line into the next message (`ContextPanel.tsx`).
struct FilesPanel: View {
    let workbench: Workbench
    let project: Project
    @Environment(\.palette) private var palette
    @Environment(\.inspectorPanelVisible) private var panelVisible
    @State private var path = ""
    @State private var entries: [FileEntry] = []
    @State private var hasMore = false
    @State private var loading = false
    @State private var searching = false
    @State private var searchOpen = false
    @State private var searchMode = SearchMode.name
    @State private var query = ""
    @State private var found: [FileEntry]?
    @State private var hits: [SearchHit]?
    @State private var preview: (path: String, line: Int?, token: Int)?
    @State private var error: String?
    @State private var notice: String?
    /// The project's favorite folders, relative to its root; replaced with the project.
    @State private var favorites = FolderFavoritesModel()
    /// The files viewed last in this project, shown as tabs over the open file.
    @State private var recent = RecentFiles(projectId: "")
    /// A symbol's usages (or its several declarations) over the open file.
    @State private var usages: CodeUsages?
    @State private var usagesTask: Task<Void, Never>?
    /// The open file has edits the server does not have; leaving it asks first.
    @State private var unsaved = false
    @State private var pendingLeave: (() -> Void)?
    /// Counts given-up edits, so the open page ends its editing even when it stays on screen.
    @State private var discards = 0

    enum SearchMode: String { case name, content }

    private static let page = 100

    var body: some View {
        VStack(spacing: 0) {
            if preview != nil, !recent.files.isEmpty {
                RecentFilesStrip(files: recent.files.map(\.path), active: preview?.path, open: { file in leaving { open(file) } }, close: { file in leaving { closeTab(file) } })
            }
            ZStack {
                // The list stays under an open file, so going back keeps its folder and scroll position.
                listPage.keptAlive(hidden: preview != nil)
                if let preview {
                    FilePreviewPage(
                        workbench: workbench, project: project, path: preview.path, target: preview.line.map { ($0, preview.token) }, unsaved: $unsaved, discards: discards,
                        openFolder: { folder in leaving { browse(folder) } },
                        onShown: shown, onJump: { file, line in leaving { open(file, line: line) } }, onUsages: findUsages, onChoices: showChoices
                    ) { leaving { self.preview = nil } }
                        .id("\(project.id)|\(preview.path)")
                        .keptAlive(hidden: usages != nil)
                }
                if let usages {
                    CodeUsagesPage(usages: usages, open: { location in leaving { closeUsages(); open(location.path, line: location.line) } }, back: closeUsages)
                }
            }
        }
        // Pages switch without a slide: every frame of one re-laid out the whole window.
        .task(id: project.id) {
            // Edits of the file left open in the other project are asked about before they are dropped.
            let reset = {
                path = ""
                preview = nil
                closeUsages()
                recent = RecentFiles(projectId: project.id)
                found = nil
                hits = nil
            }
            if unsaved { pendingLeave = reset } else { reset() }
            // A request made together with switching conversations arrives before this reset.
            if let target = workbench.previewTarget, Date.now.timeIntervalSince(target.at) < 3 { consume(target) }
            if favorites.projectId != project.id { favorites = FolderFavoritesModel(projectId: project.id) }
            await load()
            await favorites.load(workbench.host.api)
        }
        .onChange(of: path) { _, _ in Task { await load() } }
        // Back on this tab, the folder is read again behind what it showed.
        .onChange(of: panelVisible) { _, visible in if visible { Task { await load() } } }
        .discardConfirmation(isPresented: Binding(get: { pendingLeave != nil }, set: { if !$0 { pendingLeave = nil } })) {
            let action = pendingLeave
            pendingLeave = nil
            unsaved = false
            discards += 1
            action?()
        }
        .onAppear { consume(workbench.previewTarget) }
        .onChange(of: workbench.previewTarget) { _, target in consume(target) }
    }

    private func consume(_ target: PreviewTarget?) {
        guard let target else { return }
        leaving { open(target.path, line: target.line) }
    }

    /// Runs [action] now, or after the edits of the open file are given up.
    private func leaving(_ action: @escaping () -> Void) {
        if unsaved { pendingLeave = action } else { action() }
    }

    private func open(_ file: String, line: Int? = nil) {
        preview = (file, line, (preview?.token ?? 0) + 1)
    }

    private func shown(_ file: String) {
        if recent.projectId != project.id { recent = RecentFiles(projectId: project.id) }
        recent.touch(file)
    }

    /// Closes a tab; the file on screen gives way to the one viewed before it, or to the list.
    private func closeTab(_ file: String) {
        recent.remove(file)
        guard preview?.path == file else { return }
        if let next = recent.byRecency.first { open(next.path) } else { preview = nil }
    }

    private func closeUsages() {
        usagesTask?.cancel()
        usages = nil
    }

    private func showChoices(_ word: String, _ locations: [CodeLocation], from origin: (path: String, line: Int)) {
        usagesTask?.cancel()
        usages = CodeUsages(word: word, origin: origin, locations: locations, searching: false)
    }

    /// Usages inside the module first, then the whole project, as the web does.
    private func findUsages(_ word: String, from origin: (path: String, line: Int)) {
        usagesTask?.cancel()
        usages = CodeUsages(word: word, origin: origin)
        let projectId = project.id
        usagesTask = Task {
            for scope in [CodeNavigation.Scope.module, .project] {
                do {
                    let result = try await CodeNavigation.references(projectId: projectId, path: origin.path, word: word, scope: scope)
                    guard !Task.isCancelled else { return }
                    usages?.locations = result.locations
                    usages?.searching = scope == .module
                } catch {
                    guard !Task.isCancelled else { return }
                    usages?.searching = false
                    usages?.failed = true
                    return
                }
            }
        }
    }

    /// A mentioned path that turned out to be a folder: list it instead of previewing it.
    private func browse(_ folder: String) {
        let root = project.cwd.hasSuffix("/") ? String(project.cwd.dropLast()) : project.cwd
        var relative = folder.hasSuffix("/") ? String(folder.dropLast()) : folder
        if relative == root { relative = "" } else if relative.hasPrefix(root + "/") { relative = String(relative.dropFirst(root.count + 1)) }
        if relative.hasPrefix("./") { relative = String(relative.dropFirst(2)) }
        searchOpen = false
        preview = nil
        path = relative
    }

    // MARK: List

    private var listPage: some View {
        VStack(spacing: 0) {
            if project.isTaskWorkspace {
                HStack(spacing: Space.sm) {
                    Text(project.cwd).font(RiffetFont.codeSmall).lineLimit(1).truncationMode(.head).textSelection(.enabled)
                    Spacer(minLength: 0)
                    CopyButton(text: project.cwd, help: String(localized: "复制路径"))
                    if workbench.local {
                        Button { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: project.cwd)]) } label: { Image(icon: "folder") }
                            .buttonStyle(IconButtonStyle()).help("在 Finder 中显示")
                    }
                }
                .padding(.horizontal, Space.sm)
                .padding(.top, Space.sm)
            }
            HStack(spacing: Space.xxs) {
                if searchOpen { searchField } else { breadcrumb }
                Button { withAnimation(Motion.standard) { searchOpen.toggle() } } label: { Image(icon: searchOpen ? "list.bullet" : "magnifyingglass").font(.riffet(size: S(12))) }
                    .buttonStyle(IconButtonStyle(active: searchOpen))
                    .help(searchOpen ? "返回文件列表" : "搜索文件")
                if !searchOpen, !path.isEmpty {
                    let starred = favorites.favorite(at: path) != nil
                    Button { Task { await favorites.toggle(path) } } label: {
                        Image(icon: starred ? "star.fill" : "star").font(.riffet(size: S(12))).foregroundStyle(starred ? palette.warning : palette.fg3)
                    }
                    .buttonStyle(IconButtonStyle())
                    .help(starred ? "取消收藏此文件夹" : "收藏此文件夹")
                }
                if !searchOpen {
                    Button { Task { notice = await ProjectDownloads.saveFolder(projectId: project.id, path: path, projectName: project.name) } } label: {
                        Image(icon: "arrow.down.circle").font(.riffet(size: S(12)))
                    }
                    .buttonStyle(IconButtonStyle())
                    .help(path.isEmpty ? "下载整个项目（ZIP）" : "下载此文件夹（ZIP）")
                    Button { Task { await load() } } label: { Image(icon: "arrow.clockwise").font(.riffet(size: S(12))) }
                        .buttonStyle(IconButtonStyle())
                        .help("刷新")
                }
            }
            .padding(.trailing, Space.sm)
            .frame(height: InspectorMetrics.headerHeight)
            if searchOpen {
                SegmentedTrack(selection: $searchMode, fontSize: 12) {
                    Text("文件名").tag(SearchMode.name)
                    Text("内容").tag(SearchMode.content)
                }
                .accessibilityLabel("搜索方式")
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Space.md)
                .padding(.bottom, Space.sm)
                .onChange(of: searchMode) { _, _ in found = nil; hits = nil; Task { await search() } }
            }
            if let notice {
                Text(notice).font(.riffet(size: S(12))).foregroundStyle(palette.danger).padding(.horizontal, Space.md).padding(.bottom, 4)
            }
            if !searchOpen {
                // The project's favorite folders, a jump away from wherever the list is.
                FolderFavoriteStrip(model: favorites, currentPath: path) { path = $0.path }
                    .padding(.horizontal, Space.md)
                    .padding(.bottom, favorites.favorites.isEmpty ? 0 : Space.sm)
            }
            PanelRule()
            if searchOpen { searchResults } else { directoryList }
        }
    }

    private var searchField: some View {
        HStack(spacing: Space.sm) {
            Image(icon: "magnifyingglass").font(.riffet(size: S(12))).foregroundStyle(palette.fg4)
            TextField(searchMode == .name ? "按文件名查找" : "搜索文件内容", text: $query)
                .textFieldStyle(.plain)
                .font(.riffet(size: S(13)))
                .onSubmit { Task { await search() } }
            if searching { Spinner(size: .mini) }
            if !query.isEmpty {
                Button { query = ""; found = nil; hits = nil } label: { Image(icon: "xmark.circle.fill").font(.riffet(size: S(11))) }
                    .buttonStyle(.plain)
                    .foregroundStyle(palette.fg4)
            }
        }
        .padding(.horizontal, Space.sm + 2)
        .frame(height: 28)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
        .padding(.leading, Space.md)
    }

    private var directoryList: some View {
        Group {
            if let error {
                ContentUnavailableView("读不到目录", icon: "exclamationmark.triangle", description: Text(error))
            } else if loading, entries.isEmpty {
                Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(entries, id: \.name) { entry in
                            let full = [path, entry.name].filter { !$0.isEmpty }.joined(separator: "/")
                            FileListRow(entry: entry, path: full, showsDirectory: false, starred: entry.kind == .directory && favorites.favorite(at: full) != nil, onReference: entry.kind == .file ? { workbench.addReference(path: full) } : nil) {
                                if entry.kind == .directory { path = full } else { open(full) }
                            }
                            .contextMenu { menu(full, kind: entry.kind) }
                        }
                        if hasMore {
                            Button("加载更多") { Task { await loadMore() } }.buttonStyle(ChipButtonStyle()).padding(.vertical, Space.sm)
                        }
                        if entries.isEmpty {
                            Text("空目录").font(.riffet(size: S(12))).foregroundStyle(palette.fg4).padding(.top, Space.xl)
                        }
                    }
                    .padding(Space.xs + 2)
                }
            }
        }
        .frame(maxHeight: .infinity)
    }

    @ViewBuilder
    private var searchResults: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if searchMode == .name {
                    ForEach(found ?? [], id: \.path) { entry in
                        FileListRow(entry: entry, path: entry.path, showsDirectory: true, onReference: entry.kind == .file ? { workbench.addReference(path: entry.path) } : nil) {
                            if entry.kind == .directory { searchOpen = false; path = entry.path } else { open(entry.path) }
                        }
                        .contextMenu { menu(entry.path, kind: entry.kind) }
                    }
                    if found?.isEmpty == true { empty(String(localized: "没有找到匹配的文件")) }
                } else {
                    ForEach(Array((hits ?? []).enumerated()), id: \.offset) { _, hit in
                        SearchHitResult(hit: hit, onOpen: { open(hit.path, line: Int(hit.line)) }, onReference: { workbench.addReference(path: hit.path, line: Int(hit.line)) }, onEditor: workbench.local ? { FileOpener.open(path: hit.path, line: Int(hit.line), projectId: project.id, workbench: workbench) } : nil)
                    }
                    if hits?.isEmpty == true { empty(String(localized: "没有找到匹配的内容")) }
                }
                if found == nil, hits == nil, !searching {
                    empty(searchMode == .name ? String(localized: "输入文件名后按回车") : String(localized: "输入要搜索的文字后按回车"))
                }
            }
            .padding(Space.xs + 2)
        }
        .frame(maxHeight: .infinity)
    }

    private func empty(_ text: String) -> some View {
        Text(text).font(.riffet(size: S(12))).foregroundStyle(palette.fg4).frame(maxWidth: .infinity).padding(.top, Space.xl)
    }

    /// Where the list is, as segments that each go back up to that folder.
    private var breadcrumb: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    Button { path = "" } label: {
                        Label(project.name, icon: "folder").font(.riffet(size: S(12), weight: path.isEmpty ? .semibold : .regular))
                    }
                    .buttonStyle(ChipButtonStyle(active: path.isEmpty))
                    let parts = path.split(separator: "/").map(String.init)
                    ForEach(parts.indices, id: \.self) { index in
                        Image(icon: "chevron.right").font(.riffet(size: S(8), weight: .bold)).foregroundStyle(palette.fg4)
                        Button(parts[index]) { path = parts[0...index].joined(separator: "/") }
                            .buttonStyle(ChipButtonStyle(active: index == parts.count - 1))
                            .id(index)
                    }
                }
                .padding(.horizontal, Space.sm)
            }
            .onChange(of: path) { _, _ in proxy.scrollTo(path.split(separator: "/").count - 1, anchor: .trailing) }
        }
    }

    @ViewBuilder
    private func menu(_ file: String, kind: FileEntryKind) -> some View {
        if kind == .file {
            Button("引用到对话") { workbench.addReference(path: file) }
            Button("下载") { Task { notice = await ProjectDownloads.saveFile(projectId: project.id, path: file) } }
        } else {
            Button(favorites.favorite(at: file) == nil ? "收藏文件夹" : "取消收藏") { Task { await favorites.toggle(file) } }
            Button("下载为 ZIP") { Task { notice = await ProjectDownloads.saveFolder(projectId: project.id, path: file, projectName: project.name) } }
        }
        if workbench.local {
            Divider()
            Button("在编辑器中打开") { FileOpener.open(path: file, line: nil, projectId: project.id, workbench: workbench) }
            Button("在 Finder 中显示") {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: (project.cwd as NSString).appendingPathComponent(file))])
            }
        }
        Divider()
        Button("复制路径") { copyToPasteboard(file) }
        Button("复制绝对路径") { copyToPasteboard((project.cwd as NSString).appendingPathComponent(file)) }
    }

    // MARK: Loading

    private func sorted(_ list: [FileEntry]) -> [FileEntry] {
        list.sorted { a, b in
            if (a.kind == .directory) != (b.kind == .directory) { return a.kind == .directory }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    /// Shows the folder as it was last read, if it was, while it is read again.
    private func load() async {
        let requested = (project.id, path)
        let key = FileListing.key(project.id, path)
        if let cached = FileListing.cache.object(forKey: key) { show(cached.entries, hasMore: cached.hasMore) }
        loading = true
        defer { if requested == (project.id, path) { loading = false } }
        do {
            let listed = try await workbench.host.api?.files(projectId: project.id, path: path, limit: KotlinInt(int: Int32(Self.page)), offset: KotlinInt(int: 0)) ?? []
            guard requested == (project.id, path) else { return }
            show(sorted(listed), hasMore: listed.count == Self.page)
            FileListing.cache.setObject(FileListing(entries: entries, hasMore: hasMore), forKey: key)
        } catch {
            guard requested == (project.id, path) else { return }
            entries = []
            self.error = error.riffetMessage
        }
    }

    private func loadMore() async {
        let requested = (project.id, path)
        do {
            let next = try await workbench.host.api?.files(projectId: project.id, path: path, limit: KotlinInt(int: Int32(Self.page)), offset: KotlinInt(int: Int32(entries.count))) ?? []
            guard requested == (project.id, path) else { return }
            let names = Set(entries.map(\.name))
            entries += next.filter { !names.contains($0.name) }
            hasMore = next.count == Self.page
            FileListing.cache.setObject(FileListing(entries: entries, hasMore: hasMore), forKey: FileListing.key(project.id, path))
        } catch {
            notice = String(localized: "无法加载更多：\(error.riffetMessage)")
        }
    }

    /// Changes only what differs, so a reading that matches the screen redraws nothing.
    private func show(_ list: [FileEntry], hasMore more: Bool) {
        if entries != list { entries = list }
        if hasMore != more { hasMore = more }
        if error != nil { error = nil }
    }

    private func search() async {
        let text = query.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, let api = workbench.host.api else { return }
        let mode = searchMode
        searching = true
        defer { searching = false }
        do {
            if mode == .name {
                let result = try await api.find(projectId: project.id, query: text)
                guard mode == searchMode, text == query.trimmingCharacters(in: .whitespaces) else { return }
                found = result
            } else {
                let result = try await api.search(projectId: project.id, query: text)
                guard mode == searchMode, text == query.trimmingCharacters(in: .whitespaces) else { return }
                hits = result
            }
            notice = nil
        } catch {
            notice = String(localized: "搜索失败：\(error.riffetMessage)")
        }
    }
}

/// A folder's listing as last read, by project and path, so a reopened panel or a folder visited
/// again shows at once.
private final class FileListing {
    let entries: [FileEntry]
    let hasMore: Bool

    init(entries: [FileEntry], hasMore: Bool) {
        self.entries = entries
        self.hasMore = hasMore
    }

    static func key(_ projectId: String, _ path: String) -> NSString { "\(projectId)\u{1}\(path)" as NSString }

    nonisolated(unsafe) static let cache: NSCache<NSString, FileListing> = {
        let cache = NSCache<NSString, FileListing>()
        cache.countLimit = 64
        return cache
    }()
}

/// A file or folder row; files offer "cite" on hover where the size was.
struct FileListRow: View {
    let entry: FileEntry
    let path: String
    let showsDirectory: Bool
    /// A folder among the project's favorites carries a star after its name.
    var starred = false
    var onReference: (() -> Void)?
    let action: () -> Void
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        let style = DisplayPreferences.shared.style
        Button(action: action) {
            HStack(spacing: Space.xs + 2) {
                // Folders are drawn as files are, outlined in the icon grey.
                Image(icon: entry.kind == .directory ? "folder" : FileSymbols.symbol(entry.name))
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(palette.fg3)
                    .frame(width: 18)
                let nameColor = entry.name.hasPrefix(".") ? palette.fg3 : palette.fg
                let directory = (path as NSString).deletingLastPathComponent
                Text(entry.name).font(.riffet(size: S(style.text.body))).foregroundStyle(nameColor).lineLimit(1).layoutPriority(1)
                if starred { Image(icon: "star.fill").font(.riffet(size: S(9))).foregroundStyle(palette.warning) }
                if showsDirectory {
                    Text(directory.isEmpty ? "/" : directory).font(.riffet(size: S(style.text.secondary))).foregroundStyle(palette.fg4).lineLimit(1).truncationMode(.head)
                }
                Spacer(minLength: Space.sm)
                if entry.kind == .file {
                    if hovering, let onReference {
                        Button(action: onReference) { Image(icon: "plus").font(.riffet(size: S(11), weight: .semibold)) }
                            .buttonStyle(IconButtonStyle(size: 20))
                            .help("引用到对话")
                    } else if let size = entry.size?.int64Value {
                        Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
                            .font(.riffet(size: S(11)).monospacedDigit())
                            .foregroundStyle(palette.fg4)
                    }
                } else {
                    Image(icon: "chevron.right").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
                }
            }
            .padding(.horizontal, Space.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: style.layout.sidebarRow)
        }
        .buttonStyle(HoverRowStyle())
        .onHover { hovering = $0 }
    }
}

private struct SearchHitResult: View {
    let hit: SearchHit
    let onOpen: () -> Void
    let onReference: () -> Void
    let onEditor: (() -> Void)?
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Space.xs) {
                    Text("\(hit.path):\(hit.line)").font(.riffet(size: S(11), design: .monospaced)).foregroundStyle(hovering ? palette.accent : palette.fg3).lineLimit(1).truncationMode(.head)
                    Spacer(minLength: Space.sm)
                    if hovering {
                        Button(action: onReference) { Image(icon: "plus").font(.riffet(size: S(10), weight: .semibold)) }
                            .buttonStyle(IconButtonStyle(size: 20)).help("引用到对话")
                        if let onEditor {
                            Button(action: onEditor) { Image(icon: "arrow.up.forward.app").font(.riffet(size: S(10))) }
                                .buttonStyle(IconButtonStyle(size: 20)).help("在编辑器中打开")
                        }
                    }
                }
                Text(hit.text.trimmingCharacters(in: .whitespaces)).font(.riffet(size: S(12), design: .monospaced)).foregroundStyle(palette.fg2).lineLimit(2)
            }
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(HoverRowStyle())
        .onHover { hovering = $0 }
    }
}

enum FileSymbols {
    static func symbol(_ name: String) -> String {
        let lower = name.lowercased()
        switch lower {
        case "dockerfile", "makefile", "justfile", "cmakelists.txt", "procfile":
            return "apple.terminal"
        case ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".npmrc", ".nvmrc", ".prettierrc", ".eslintrc", ".env":
            return "curlybraces"
        default:
            if lower.hasPrefix(".env.") { return "curlybraces" }
            if lower.hasPrefix("dockerfile.") { return "apple.terminal" }
        }
        switch (name as NSString).pathExtension.lowercased() {
        case "swift", "kt", "kts", "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
             "py", "pyi", "go", "rs", "java", "c", "cc", "cpp", "cxx", "h", "hpp", "m", "mm",
             "rb", "php", "cs", "dart", "vue", "svelte", "astro", "css", "scss", "sass", "less",
             "sql", "proto", "graphql", "gql", "lua", "r", "scala", "zig", "ex", "exs", "gradle":
            return "chevron.left.forwardslash.chevron.right"
        case "sh", "zsh", "bash", "fish", "ps1", "bat", "cmd":
            return "apple.terminal"
        case "md", "markdown", "mdown", "mkd", "mdx", "mdc", "txt", "rtf", "rst", "adoc", "log", "csv", "tsv":
            return "doc.text"
        case "json", "jsonc", "json5", "yml", "yaml", "toml", "plist", "xml", "lock", "ini", "cfg", "conf", "env", "properties", "entitlements", "pbxproj":
            return "curlybraces"
        case "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "heic", "icns", "tiff", "tif":
            return "photo"
        case "html", "htm", "xhtml", "po", "pot", "strings", "xcstrings", "xliff":
            return "globe"
        case "pdf":
            return "doc.richtext"
        case "zip", "tar", "gz", "tgz", "xz", "bz2", "7z", "dmg", "pkg":
            return "archivebox"
        case "apk", "ipa", "aab", "whl", "jar", "wasm":
            return "shippingbox"
        default:
            return "doc"
        }
    }
}

/// A file filling the panel: highlighted source with clickable line numbers, an HTML page rendered
/// in its own sandbox, or an image; its actions in the header.
struct FilePreviewPage: View {
    let workbench: Workbench
    let project: Project
    let path: String
    var target: (Int, Int)?
    /// The page has edits the server does not have.
    @Binding var unsaved: Bool
    /// Changes when the owner gave the edits up: editing ends even if this page stays.
    var discards = 0
    var openFolder: ((String) -> Void)?
    /// A text or image file was read: it joins the recent files.
    var onShown: ((String) -> Void)?
    /// Code navigation: to a place in a file, to a symbol's usages, to the choice among its declarations.
    var onJump: ((String, Int) -> Void)?
    var onUsages: ((String, (path: String, line: Int)) -> Void)?
    var onChoices: ((String, [CodeLocation], (path: String, line: Int)) -> Void)?
    let back: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    @State private var navigation: Task<Void, Never>?
    @State private var preview: FilePreview?
    @State private var error: String?
    @State private var htmlRendered = true
    @State private var notice: String?
    @State private var reload = 0
    /// The page an HTML site preview shows after a link was followed; nil while it shows the opened file.
    @State private var sitePage: String?
    @State private var editing = false
    @State private var draft = ""
    @State private var saving = false
    /// The file changed on disk under the edits: the preview now holds the disk version, the draft is still the user's.
    @State private var conflict = false
    @State private var confirmEndEditing = false

    /// Documents the system previews natively; the server's pages cover the rest.
    private var systemPreviewed: Bool { ["pdf", "document", "presentation", "spreadsheet"].contains(preview?.render?.kind ?? "") }
    private var canRender: Bool { (preview?.render != nil && !systemPreviewed) || isHTML }
    private var showsSource: Bool {
        guard let preview else { return false }
        return preview.image == nil && !preview.binary && !systemPreviewed && !(canRender && htmlRendered)
    }
    private var canEdit: Bool { workbench.supportsFileWrite && preview?.editable == true && showsSource }
    private var isDirty: Bool { editing && draft != preview?.content }

    /// The files opened most recently.
    nonisolated(unsafe) private static let recent: NSCache<NSString, FilePreview> = {
        let cache = NSCache<NSString, FilePreview>()
        cache.countLimit = 12
        return cache
    }()

    private var isHTML: Bool { ["html", "htm"].contains(((preview?.path ?? path) as NSString).pathExtension.lowercased()) }
    private var effectivePath: String { (isHTML && htmlRendered ? sitePage : nil) ?? preview?.path ?? path }
    private var isAbsoluteOrTilde: Bool { effectivePath.hasPrefix("/") || effectivePath == "~" || effectivePath.hasPrefix("~/") }

    private func moreEntries() -> [NativeMenuEntry] {
        var entries: [NativeMenuEntry] = []
        if workbench.local {
            let targetPath: String = if effectivePath == "~" || effectivePath.hasPrefix("~/") {
                (effectivePath as NSString).expandingTildeInPath
            } else if effectivePath.hasPrefix("/") {
                effectivePath
            } else {
                (project.cwd as NSString).appendingPathComponent(effectivePath)
            }
            entries.append(.item(String(localized: "在 Finder 中显示")) {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: targetPath)])
            })
        }
        if preview?.binary == false { entries.append(.item(String(localized: "复制文件内容")) { Task { await copyContent() } }) }
        entries.append(.separator)
        entries.append(.item(String(localized: "复制路径")) { copyToPasteboard(effectivePath) })
        if !isAbsoluteOrTilde { entries.append(.item(String(localized: "复制绝对路径")) { copyToPasteboard((project.cwd as NSString).appendingPathComponent(effectivePath)) }) }
        entries.append(.separator)
        entries.append(.item(String(localized: "刷新")) { reload += 1 })
        return entries
    }

    var body: some View {
        VStack(spacing: 0) {
            DetailHeader(title: (effectivePath as NSString).lastPathComponent, subtitle: (effectivePath as NSString).deletingLastPathComponent, back: back) {
                if canRender, preview?.binary == false, !editing {
                    Button { htmlRendered.toggle() } label: { Image(icon: htmlRendered ? "chevron.left.forwardslash.chevron.right" : "eye").font(.riffet(size: S(12))) }
                        .buttonStyle(IconButtonStyle())
                        .help(htmlRendered ? "显示源码" : "渲染预览")
                }
                if editing, isDirty {
                    Button("保存") { Task { await save() } }
                        .buttonStyle(ChipButtonStyle())
                        .keyboardShortcut("s")
                        .disabled(saving)
                }
                if canEdit || editing {
                    Button { toggleEditing() } label: { Image(icon: "pencil").font(RiffetFont.caption) }
                        .buttonStyle(IconButtonStyle(active: editing))
                        .help("编辑")
                }
                Button { workbench.addReference(path: effectivePath) } label: { Image(icon: "plus").font(.riffet(size: S(12))) }
                    .buttonStyle(IconButtonStyle())
                    .help("引用整个文件")
                Button { Task { notice = await ProjectDownloads.saveFile(projectId: project.id, path: effectivePath) } } label: { Image(icon: "arrow.down.circle").font(.riffet(size: S(12))) }
                    .buttonStyle(IconButtonStyle())
                    .help("下载")
                if workbench.local {
                    Button { FileOpener.open(path: effectivePath, line: target?.0, projectId: project.id, workbench: workbench) } label: { Image(icon: "arrow.up.forward.app").font(.riffet(size: S(12))) }
                        .buttonStyle(IconButtonStyle())
                        .help("在编辑器中打开")
                }
                NativeMenuButton(entries: moreEntries) {
                    Image(icon: "ellipsis").font(.riffet(size: S(12)))
                }
                .buttonStyle(IconButtonStyle())
            }
            PanelRule()
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
            if conflict {
                HStack(spacing: Space.sm) {
                    Text("文件已在别处改动").font(RiffetFont.caption).foregroundStyle(palette.warning)
                    Spacer(minLength: Space.sm)
                    Button("用磁盘上的版本") { useDisk() }.buttonStyle(ChipButtonStyle()).disabled(saving)
                    Button("覆盖保存") { Task { await save() } }.buttonStyle(ChipButtonStyle()).disabled(saving)
                }
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.xs)
            }
            if let notice {
                Text(notice).font(.riffet(size: S(12))).foregroundStyle(palette.danger).padding(6)
            }
            if let preview, preview.truncated, !preview.binary, preview.image == nil, !(canRender && htmlRendered) {
                PanelRule()
                HStack {
                    Spacer()
                    Text("文件过大，仅显示前一部分").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                }
                .padding(.horizontal, Space.md)
                .frame(height: 28)
            }
        }
        .onChange(of: target?.1) { _, _ in if target != nil { htmlRendered = false } }
        .onChange(of: path) { _, _ in sitePage = nil }
        .onChange(of: isDirty) { _, value in unsaved = value }
        .onChange(of: discards) { _, _ in if editing { endEditing() } }
        .discardConfirmation(isPresented: $confirmEndEditing) { endEditing() }
        .onDisappear { navigation?.cancel(); unsaved = false }
        .task(id: "\(path)|\(reload)") {
            htmlRendered = target == nil
            // A file opened lately shows at once and is read again behind it; 刷新 always waits for the read.
            let key = "\(project.id)\u{1}\(path)" as NSString
            if reload == 0, preview == nil, let cached = Self.recent.object(forKey: key) { preview = cached }
            do {
                let next = try await workbench.host.api?.preview(projectId: project.id, path: path)
                if let next {
                    Self.recent.setObject(next, forKey: key)
                    // While editing, the preview stays the version the edits started from: it names the save's expected hash.
                    if !editing, preview?.hash_ != next.hash_ || preview?.path != next.path || preview?.truncated != next.truncated { preview = next }
                    if !next.binary || next.image != nil { onShown?(next.path) }
                } else if preview != nil, !editing {
                    preview = nil
                }
                error = nil
            } catch {
                Self.recent.removeObject(forKey: key)
                if error.riffetCode == "NOT_A_FILE", let openFolder { openFolder(path); return }
                let blocked = error.riffetCode == "PATH_OUTSIDE_PROJECT" || error.riffetCode == "INVALID_PATH"
                self.error = blocked ? String(localized: "该文件在项目目录之外。可在「设置 → 文件与编辑器」中允许只读预览项目外文件。") : error.riffetMessage
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let error {
            ContentUnavailableView("无法预览", icon: "exclamationmark.triangle", description: Text(error))
        } else if let preview {
            if preview.image != nil {
                ScrollView {
                    TimelineImageView(source: .projectFile(projectId: project.id, path: preview.path), label: preview.path, maxHeight: 2000, projectId: project.id)
                        .padding(Space.md)
                }
            } else if isHTML, htmlRendered, !preview.binary {
                HtmlSitePreview(projectId: project.id, entry: preview.path, version: preview.hash_, reload: reload) { page in
                    sitePage = page == preview.path ? nil : page
                }
            } else if canRender, htmlRendered,
                      let raw = ProjectDownloads.rawURL(projectId: project.id, path: preview.path),
                      let url = FilePreviewTheme(palette: palette, dark: colorScheme == .dark).url(raw) {
                RenderedFilePreview(url: url, rawURL: raw, name: (preview.path as NSString).lastPathComponent)
                    .id("\(preview.path)|\(preview.hash_)")
            } else if systemPreviewed || preview.binary, let url = ProjectDownloads.rawURL(projectId: project.id, path: preview.path) {
                SystemFilePreview(url: url, name: (preview.path as NSString).lastPathComponent)
                    .id("\(preview.path)|\(preview.hash_)")
            } else {
                CodeTextView(
                    text: editing ? draft : preview.content, language: CodeHighlighter.language(forPath: preview.path), palette: palette,
                    fontSize: S(12), target: target.map { (line: $0.0, token: $0.1) },
                    onLine: { line, _ in workbench.addReference(path: preview.path, line: line) },
                    onSymbol: { navigate($0, $1, in: preview.path) },
                    editable: editing, onChange: { draft = $0 }
                )
            }
        } else {
            ProgressView()
        }
    }

    private func toggleEditing() {
        if !editing {
            guard let preview else { return }
            draft = preview.content
            notice = nil
            editing = true
        } else if isDirty {
            confirmEndEditing = true
        } else {
            endEditing()
        }
    }

    private func endEditing() {
        editing = false
        conflict = false
        draft = ""
        notice = nil
    }

    private func useDisk() {
        guard let preview else { return }
        draft = preview.content
        conflict = false
        notice = nil
    }

    private func save() async {
        guard let api = workbench.host.api, let current = preview, editing, !saving else { return }
        saving = true
        defer { saving = false }
        notice = nil
        let text = draft
        let key = "\(project.id)\u{1}\(path)" as NSString
        do {
            _ = try await api.saveFile(projectId: project.id, path: current.path, content: text, expectedHash: current.hash_)
            let saved = try await api.preview(projectId: project.id, path: current.path)
            Self.recent.setObject(saved, forKey: key)
            preview = saved
            // Text typed while the save ran stays: it is now an edit over the saved version.
            if draft == text { draft = saved.content }
            conflict = false
        } catch {
            if error.riffetCode == "FILE_CHANGED" {
                do {
                    let disk = try await api.preview(projectId: project.id, path: current.path)
                    Self.recent.setObject(disk, forKey: key)
                    preview = disk
                    conflict = disk.content != draft
                } catch {
                    notice = error.riffetMessage
                }
            } else {
                notice = error.riffetMessage
            }
        }
    }

    /// ⌘-click: the definition, a choice among several, or the usages when the click is on the declaration.
    private func navigate(_ symbol: CodeSymbol, _ intent: CodeSymbolIntent, in file: String) {
        navigation?.cancel()
        notice = nil
        let origin = (path: file, line: symbol.line)
        if intent == .usages { onUsages?(symbol.word, origin); return }
        navigation = Task {
            do {
                let found = try await CodeNavigation.definitions(projectId: project.id, path: file, symbol: symbol)
                guard !Task.isCancelled else { return }
                if found.isEmpty {
                    notice = String(localized: "没有找到 \(symbol.word) 的定义")
                } else if found.contains(where: { $0.path == file && $0.line == symbol.line }) {
                    onUsages?(symbol.word, origin)
                } else if found.count == 1 {
                    onJump?(found[0].path, found[0].line)
                } else {
                    onChoices?(symbol.word, found, origin)
                }
            } catch {
                guard !Task.isCancelled else { return }
                notice = String(localized: "无法跳转到定义")
            }
        }
    }

    private func copyContent() async {
        guard let preview else { return }
        if !preview.truncated { copyToPasteboard(preview.content); return }
        do {
            copyToPasteboard(try await ProjectDownloads.text(projectId: project.id, path: effectivePath))
        } catch {
            notice = error.riffetMessage
        }
    }
}

/// An HTML file rendered as its own document: no shared storage, cookies or app bridge, so a
/// generated page's scripts cannot reach the workbench (the server also sends a sandbox CSP).
/// `samePage` is used by interactive visualizations to keep links and script navigation in the
/// document that was explicitly opened by the user.
struct SandboxedPage: NSViewRepresentable {
    let request: URLRequest
    var navigation: Navigation = .allow
    var onLoadingChange: ((Bool) -> Void)? = nil
    var onFailure: ((String) -> Void)? = nil
    var onUnsupportedContent: (() -> Void)? = nil

    enum Navigation: Equatable {
        case allow
        case samePage
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        _ = context.coordinator.configure(request: request, navigation: navigation, onLoadingChange: onLoadingChange, onFailure: onFailure, onUnsupportedContent: onUnsupportedContent)
        view.navigationDelegate = context.coordinator
        view.load(request)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        if context.coordinator.configure(request: request, navigation: navigation, onLoadingChange: onLoadingChange, onFailure: onFailure, onUnsupportedContent: onUnsupportedContent) {
            view.load(request)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private var initialURL: URL?
        private var navigation: Navigation = .allow
        private var initialRequestAllowed = false
        private var onLoadingChange: ((Bool) -> Void)?
        private var onFailure: ((String) -> Void)?
        private var onUnsupportedContent: (() -> Void)?

        @discardableResult
        func configure(request: URLRequest, navigation: Navigation, onLoadingChange: ((Bool) -> Void)?, onFailure: ((String) -> Void)?, onUnsupportedContent: (() -> Void)? = nil) -> Bool {
            let requestChanged = initialURL != request.url
            if requestChanged {
                initialURL = request.url
                initialRequestAllowed = false
            }
            self.navigation = navigation
            self.onLoadingChange = onLoadingChange
            self.onFailure = onFailure
            self.onUnsupportedContent = onUnsupportedContent
            return requestChanged
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard navigation == .samePage else { decisionHandler(.allow); return }
            if action.targetFrame?.isMainFrame == false,
               let target = action.request.url,
               ["about:blank", "about:srcdoc"].contains(target.absoluteString) {
                decisionHandler(.allow)
                return
            }
            guard action.targetFrame?.isMainFrame == true, let target = action.request.url, let initialURL else {
                decisionHandler(.cancel)
                return
            }
            if !initialRequestAllowed, Self.samePage(target, initialURL) {
                initialRequestAllowed = true
                decisionHandler(.allow)
            } else {
                decisionHandler(Self.samePage(target, initialURL) ? .allow : .cancel)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if navigation == .samePage, response.isForMainFrame,
               let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
                onLoadingChange?(false)
                onFailure?(String(localized: "预览加载失败（HTTP \(http.statusCode)）"))
                decisionHandler(.cancel)
                return
            }
            if response.isForMainFrame, let onUnsupportedContent,
               !["text/html", "application/xhtml+xml"].contains(response.response.mimeType ?? "") {
                onUnsupportedContent()
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            onLoadingChange?(true)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onLoadingChange?(false)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // Never create a second web view, even for a link with target="_blank".
            nil
        }

        private func fail(_ error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            onLoadingChange?(false)
            onFailure?(error.localizedDescription)
        }

        private static func samePage(_ lhs: URL, _ rhs: URL) -> Bool {
            func withoutFragment(_ url: URL) -> URL? {
                guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
                components.fragment = nil
                return components.url
            }
            return withoutFragment(lhs) == withoutFragment(rhs)
        }
    }
}

extension View {
    /// Asks before edits that were not saved are given up; [discard] runs on the destructive choice.
    func discardConfirmation(isPresented: Binding<Bool>, discard: @escaping () -> Void) -> some View {
        confirmationDialog("放弃未保存的修改？", isPresented: isPresented, titleVisibility: .visible) {
            Button("放弃修改", role: .destructive, action: discard)
        }
    }
}
