import SwiftUI
import WebKit
import RiffetKit

struct ProjectFilePage: View {
    let workbench: Workbench
    @Environment(\.colorScheme) private var scheme
    @Environment(\.palette) private var palette
    let project: Project
    let path: String
    var targetLine: Int?
    @State private var preview: RiffetKit.FilePreview?
    @State private var image: UIImage?
    @State private var error: String?
    @State private var exported: InspectorExport?
    @State private var quickLook: InspectorExport?
    @State private var exporting = false
    @State private var renderHTML = false
    @State private var html: Data?
    @State private var pages: [ProjectFileChunk] = []
    @State private var shown = 1
    @State private var readingMarkdown = true
    @State private var actionError: String?
    /// The page a followed link has shown inside an HTML site; title, copy and download follow it.
    @State private var sitePage: String?
    @State private var siteReload = 0
    @State private var editing = false
    @State private var writable = false
    /// A PDF or Office document downloaded for Quick Look; the folder goes with the page.
    @State private var nativeCopy: ProjectTempCopy?
    private static let nativeKinds: Set<String> = ["pdf", "document", "presentation", "spreadsheet"]
    private var isSiteFile: Bool { !isMarkdown && ["html", "htm"].contains((effectivePath as NSString).pathExtension.lowercased()) }
    private var shownPath: String { (isSiteFile && renderHTML ? sitePage : nil) ?? effectivePath }
    private var effectivePath: String { preview?.path ?? path }
    private var isMarkdown: Bool { ["md", "markdown", "mdown", "mkd", "mdx", "mdc"].contains((effectivePath as NSString).pathExtension.lowercased()) }
    private var language: String {
        let leaf = (effectivePath as NSString).lastPathComponent.lowercased()
        if leaf == "dockerfile" { return "docker" }
        if leaf == "makefile" { return "makefile" }
        return ["m": "objectivec", "mm": "objectivec", "h": "c", "kt": "kotlin", "kts": "kotlin", "py": "python", "rb": "ruby", "sh": "bash", "yml": "yaml", "rs": "rust", "md": "markdown", "mdown": "markdown", "mkd": "markdown", "mdx": "markdown", "mdc": "markdown", "ts": "typescript", "tsx": "tsx", "js": "javascript", "jsx": "jsx"][((effectivePath as NSString).pathExtension.lowercased())] ?? (effectivePath as NSString).pathExtension.lowercased()
    }

    var body: some View {
        Group {
            if let error {
                RiffetNotice(kind: .error, title: String(localized: "无法预览", bundle: .riffet), message: error,
                             actionTitle: String(localized: "重试", bundle: .riffet), action: { Task { await load() } }, boxed: true)
                    .padding(RiffetMetrics.pageInset)
                    .frame(maxHeight: .infinity, alignment: .top)
            } else if let preview {
                if let nativeCopy {
                    FilePreview(url: nativeCopy.url, title: (path as NSString).lastPathComponent).ignoresSafeArea(edges: .bottom)
                } else if isSiteFile, renderHTML, !preview.binary {
                    ProjectHTMLSite(workbench: workbench, projectID: project.id, entry: effectivePath, reload: siteReload,
                                    onPage: { sitePage = $0 }, failed: { error = $0 })
                } else if !isMarkdown, preview.render != nil, renderHTML, let url = previewURL {
                    ConversationWebPage(workbench: workbench, url: url)
                } else if preview.image != nil {
                    if let image { ProjectImagePreview(image: image).accessibilityLabel((path as NSString).lastPathComponent) }
                    else { ProgressView() }
                } else if preview.binary {
                    ContentUnavailableView {
                        Label("二进制文件", systemImage: "doc")
                    } description: {
                        Text(ByteCountFormatter.string(fromByteCount: preview.size, countStyle: .file))
                    } actions: {
                        Button("系统预览") { Task { await download(preview: true) } }.disabled(exporting)
                        Button("下载并分享") { Task { await download() } }.disabled(exporting)
                    }
                } else if renderHTML, let html {
                    InspectorHTMLPreview(data: html)
                } else {
                    textContent
                }
            } else { ProgressView() }
        }
        .navigationTitle((shownPath as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top, spacing: 0) { underBar }
        .toolbar(.hidden, for: .bottomBar)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if exporting { ProgressView() }
                if writable, showsEditableSource {
                    Button(String(localized: "编辑", bundle: .riffet)) { editing = true }
                }
                Menu {
                    Button("下载并分享", systemImage: "square.and.arrow.up") { Task { await download() } }
                    Button("系统预览", systemImage: "eye") { Task { await download(preview: true) } }
                    Button("复制路径", systemImage: "doc.on.doc") { UIPasteboard.general.string = shownPath }
                    if let preview, !preview.binary, !preview.truncated {
                        Button("复制内容", systemImage: "doc.on.clipboard") { UIPasteboard.general.string = preview.content }
                    }
                    Button("刷新", systemImage: "arrow.clockwise") {
                        if isSiteFile, renderHTML { siteReload += 1 } else { Task { await load() } }
                    }
                } label: { Label("文件操作", systemImage: "ellipsis.circle") }.disabled(exporting)
            }
        }
        .task(id: "\(project.id)|\(path)") { await load() }
        .task(id: project.id) {
            guard let api = workbench.api else { return }
            writable = (try? await api.health())?.protocol?.features.contains("file-write-v1") == true
        }
        .sheet(isPresented: $editing) {
            if let preview {
                ProjectFileEditor(path: effectivePath, original: preview.content, save: saveEdit) { reload in
                    editing = false
                    if reload { Task { await load() } }
                }
            }
        }
        .onChange(of: actionError) {
            guard let message = actionError else { return }
            actionError = nil
            RiffetToastCenter.shared.error(message)
        }
        .sheet(item: $exported) { NativeShareSheet(items: [$0.url]) }
        .sheet(item: $quickLook) { item in FilePreview(url: item.url, title: (shownPath as NSString).lastPathComponent) }
    }

    /// The plain source of an editable text file is what the page shows.
    private var showsEditableSource: Bool {
        guard let preview, preview.editable, !preview.binary, preview.image == nil, error == nil, nativeCopy == nil, !renderHTML else { return false }
        return !(isMarkdown && readingMarkdown)
    }

    private func saveEdit(_ content: String, overwrite: Bool) async -> ProjectFileSaveOutcome {
        guard let api = workbench.api, let preview else { return .failed(InspectorFailure.disconnected.errorDescription ?? "") }
        do {
            let hash = overwrite ? try await api.preview(projectId: project.id, path: effectivePath).hash_ : preview.hash_
            _ = try await api.saveFile(projectId: project.id, path: effectivePath, content: content, expectedHash: hash)
            return .saved
        } catch {
            return error.riffetCode == "FILE_CHANGED" ? .changed : .failed(error.riffetMessage)
        }
    }

    /// What can be shown as a rendered page: Markdown and HTML, never an image or a binary.
    private var previewable: Bool {
        guard let preview, !preview.binary, preview.image == nil, error == nil, nativeCopy == nil else { return false }
        if isMarkdown { return true }
        return preview.render != nil || ["html", "htm"].contains((effectivePath as NSString).pathExtension.lowercased())
    }

    private var showsPreview: Binding<Bool> {
        Binding(
            get: { isMarkdown ? readingMarkdown : renderHTML },
            set: { value in
                if isMarkdown { readingMarkdown = value }
                else if value != renderHTML { Task { await toggleHTML() } }
            }
        )
    }

    /// The preview or source switch and the one notice, together under the bar.
    @ViewBuilder private var underBar: some View {
        let truncated = preview?.truncated == true && preview?.binary == false && preview?.image == nil && !renderHTML
        if previewable || truncated {
            VStack(spacing: 0) {
                if previewable {
                    Picker("显示方式", selection: showsPreview) {
                        Text(String(localized: "预览", bundle: .riffet)).tag(true)
                        Text(String(localized: "源码", bundle: .riffet)).tag(false)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, RiffetMetrics.pageInset).padding(.vertical, 8)
                }
                if truncated {
                    RiffetNotice(kind: .info, message: String(localized: "文件较大，当前显示部分内容。下载可获取完整文件。", bundle: .riffet), boxed: true)
                        .padding(.horizontal, RiffetMetrics.pageInset).padding(.bottom, 8)
                }
            }
            .background(palette.bg)
        }
    }

    /// The text in bounded chunks that appear one after another as the reader scrolls, so a long file
    /// never builds all its rows at once.
    @ViewBuilder private var textContent: some View {
        if pages.isEmpty { ProgressView() } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(pages.prefix(shown).enumerated()), id: \.offset) { index, chunk in
                            chunkView(chunk).id(index)
                                .onAppear { if index == shown - 1, shown < pages.count { shown += 1 } }
                        }
                    }
                    .padding(.horizontal, RiffetMetrics.pageInset).padding(.bottom, RiffetMetrics.pageInset)
                }
                .task(id: pages.count) {
                    guard let targetLine, let index = pages.firstIndex(where: { $0.startLine <= targetLine && targetLine <= $0.endLine }) else { return }
                    proxy.scrollTo(index, anchor: .top)
                }
            }
        }
    }

    @ViewBuilder private func chunkView(_ chunk: ProjectFileChunk) -> some View {
        if isMarkdown && readingMarkdown {
            ConversationMarkdown(source: chunk.markdownText, workbench: workbench, projectID: project.id)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                if let targetLine, let focus = chunk.line(targetLine) {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("第 \(targetLine) 行", systemImage: "arrow.turn.down.right").riffetFont(.caption).foregroundStyle(palette.fg3)
                        Text(focus).riffetFont(.monoSmall).foregroundStyle(palette.fg).textSelection(.enabled)
                    }
                    .padding(RiffetMetrics.pageInset).frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.bgActive, in: RoundedRectangle(cornerRadius: RiffetMetrics.rowRadius, style: .continuous))
                }
                ConversationCode(text: chunk.text, language: language, workbench: workbench, projectID: project.id, capped: false)
            }
        }
    }

    private func load() async {
        error = nil
        image = nil
        preview = nil
        html = nil
        sitePage = nil
        nativeCopy = nil
        renderHTML = false
        pages = []; shown = 1
        readingMarkdown = targetLine == nil
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            let result = try await api.preview(projectId: project.id, path: path)
            guard !Task.isCancelled else { return }
            preview = result
            let site = !isMarkdown && ["html", "htm"].contains((result.path as NSString).pathExtension.lowercased()) && !result.binary
            renderHTML = !isMarkdown && (result.render != nil || site) && targetLine == nil
            if let kind = result.render?.kind, Self.nativeKinds.contains(kind), targetLine == nil,
               let url = workbench.resources.fileURL(projectID: project.id, path: result.path),
               let file = try? await workbench.resources.file(for: url, name: (result.path as NSString).lastPathComponent) {
                let copy = ProjectTempCopy(url: file)
                guard !Task.isCancelled else { return }
                renderHTML = false
                nativeCopy = copy
            } else if result.image != nil, let url = workbench.resources.fileURL(projectID: project.id, path: result.path, image: true) {
                let data = try await workbench.resources.data(for: url)
                guard !Task.isCancelled else { return }
                let decoded = await Task.detached(priority: .userInitiated) { ConversationImageDecoder.decode(data, maximumPixelSize: ConversationImageDecoder.viewerEdge) }.value
                try Task.checkCancellation()
                guard let decoded else { throw AttachmentImportError.unreadableImage }
                image = decoded
            } else if !result.binary {
                let content = result.content
                let chunks = await Task.detached(priority: .userInitiated) { ProjectFileChunk.split(content) }.value
                try Task.checkCancellation()
                pages = chunks
                if let targetLine { shown = (chunks.firstIndex(where: { $0.startLine <= targetLine && targetLine <= $0.endLine }) ?? max(0, chunks.count - 1)) + 1 }
            }
        } catch {
            guard !Task.isCancelled else { return }
            let blocked = error.riffetCode == "PATH_OUTSIDE_PROJECT" || error.riffetCode == "INVALID_PATH"
            self.error = blocked
                ? String(localized: "该文件在项目目录之外。可在「设置 → 文件与编辑器」中允许只读预览项目外文件。", bundle: .riffet)
                : error.riffetMessage
        }
    }

    private func download(preview: Bool = false) async {
        guard !exporting else { return }
        exporting = true
        defer { exporting = false }
        do {
            guard let url = workbench.resources.fileURL(projectID: project.id, path: shownPath) else { throw InspectorFailure.invalidURL }
            let file = try await workbench.resources.file(for: url, name: (shownPath as NSString).lastPathComponent)
            if preview { quickLook = InspectorExport(url: file) } else { exported = InspectorExport(url: file) }
        } catch { actionError = error.riffetMessage }
    }

    private var previewURL: URL? {
        guard let raw = workbench.resources.fileURL(projectID: project.id, path: effectivePath) else { return nil }
        return ConversationPreviewDocument.previewURL(raw, dark: scheme == .dark)
    }

    private func toggleHTML() async {
        // Back in the rendered view the site opens at the file itself again.
        if preview?.render != nil || isSiteFile { renderHTML.toggle(); sitePage = nil; return }
        if renderHTML { renderHTML = false; return }
        do {
            guard let url = workbench.resources.fileURL(projectID: project.id, path: effectivePath) else { throw InspectorFailure.invalidURL }
            html = try await workbench.resources.data(for: url)
            renderHTML = true
        } catch { actionError = error.riffetMessage }
    }
}

/// A downloaded file in its own temporary folder, removed when the page lets go of it.
private final class ProjectTempCopy {
    let url: URL
    init(url: URL) { self.url = url }
    deinit { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}

/// Chunking runs off the main actor. Even a file consisting of one enormous line has a
/// bounded native Text/Markdown workload; page changes never construct all visible rows.
private struct ProjectFileChunk: Sendable {
    let text: String
    let startLine: Int
    let endLine: Int
    private var leadingFence: String?
    private var trailingFence: String?
    var markdownText: String {
        (leadingFence.map { $0 + "\n" } ?? "") + text + (trailingFence.map { "\n" + $0 } ?? "")
    }
    init(text: String, startLine: Int, endLine: Int) { self.text = text; self.startLine = startLine; self.endLine = endLine }
    func line(_ target: Int) -> String? {
        let offset = target - startLine
        guard offset >= 0, target <= endLine else { return nil }
        return text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" || $0 == "\r" }).dropFirst(offset).first.map(String.init)
    }
    static func split(_ text: String) -> [ProjectFileChunk] {
        var result: [ProjectFileChunk] = []
        var start = text.startIndex, cursor = start
        var line = 1, firstLine = 1, count = 0, pageLines = 0
        while cursor < text.endIndex {
            let character = text[cursor]
            cursor = text.index(after: cursor); count += 1
            let newline = character == "\n" || character == "\r\n" || character == "\r"
            if newline { line += 1; pageLines += 1 }
            if count >= 16_000 || pageLines >= 200 {
                result.append(ProjectFileChunk(text: String(text[start..<cursor]), startLine: firstLine, endLine: max(firstLine, line - (newline ? 1 : 0))))
                start = cursor; firstLine = line; count = 0; pageLines = 0
            }
        }
        if start < text.endIndex || result.isEmpty {
            let remaining = String(text[start...])
            result.append(ProjectFileChunk(text: remaining, startLine: firstLine, endLine: max(firstLine, line - (remaining.hasSuffix("\n") || remaining.hasSuffix("\r") ? 1 : 0))))
        }
        preserveMarkdownFences(&result)
        return result
    }
    /// Carry fenced-code context between bounded pages. Synthetic delimiters affect only
    /// reading mode; source, copying and line numbering always use the exact original bytes.
    private static func preserveMarkdownFences(_ chunks: inout [ProjectFileChunk]) {
        var active: (marker: Character, count: Int, opening: String)?
        var continuedLine = false
        for index in chunks.indices {
            chunks[index].leadingFence = active?.opening
            let text = chunks[index].text
            let endsAtNewline = text.hasSuffix("\n") || text.hasSuffix("\r")
            let lines = text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" || $0 == "\r" })
            for (offset, line) in lines.enumerated() {
                if offset == 0 && continuedLine { continue }
                if offset == lines.count - 1 && !endsAtNewline && index + 1 < chunks.count { continue }
                guard let fence = fence(String(line)) else { continue }
                if let current = active {
                    if current.marker == fence.marker && fence.count >= current.count && fence.rest.trimmingCharacters(in: .whitespaces).isEmpty { active = nil }
                } else {
                    active = (fence.marker, fence.count, String(line).trimmingCharacters(in: .whitespaces))
                }
            }
            chunks[index].trailingFence = active.map { String(repeating: String($0.marker), count: $0.count) }
            continuedLine = !endsAtNewline
        }
    }
    private static func fence(_ line: String) -> (marker: Character, count: Int, rest: String)? {
        let spaces = line.prefix(while: { $0 == " " }).count
        guard spaces <= 3 else { return nil }
        let content = line.dropFirst(spaces)
        guard let marker = content.first, marker == "`" || marker == "~" else { return nil }
        let count = content.prefix(while: { $0 == marker }).count
        guard count >= 3 else { return nil }
        return (marker, count, String(content.dropFirst(count)))
    }
}

/// UIScrollView provides familiar pinch, pan and double-tap zoom without eagerly decoding
/// the full raster. The display image is already downsampled by ConversationImageDecoder.
struct ProjectImagePreview: UIViewRepresentable {
    let image: UIImage
    func makeUIView(context: Context) -> Canvas { let view = Canvas(); view.show(image); return view }
    func updateUIView(_ view: Canvas, context: Context) { view.show(image) }
    final class Canvas: UIScrollView, UIScrollViewDelegate {
        private let picture = UIImageView()
        private var previousSize = CGSize.zero
        override init(frame: CGRect) {
            super.init(frame: frame)
            delegate = self; minimumZoomScale = 1; maximumZoomScale = 5
            picture.contentMode = .scaleAspectFit; addSubview(picture)
            backgroundColor = .systemBackground
            let doubleTap = UITapGestureRecognizer(target: self, action: #selector(zoom(_:)))
            doubleTap.numberOfTapsRequired = 2; addGestureRecognizer(doubleTap)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        func show(_ image: UIImage) {
            guard picture.image !== image else { return }
            setZoomScale(1, animated: false); picture.image = image; setNeedsLayout()
        }
        override func layoutSubviews() {
            super.layoutSubviews()
            if previousSize != bounds.size {
                previousSize = bounds.size; setZoomScale(1, animated: false)
                picture.frame = CGRect(origin: .zero, size: bounds.size); contentSize = bounds.size
            }
        }
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { picture }
        @objc private func zoom(_ recognizer: UITapGestureRecognizer) {
            if zoomScale > 1 { setZoomScale(1, animated: true); return }
            let point = recognizer.location(in: picture), size = CGSize(width: bounds.width / 3, height: bounds.height / 3)
            zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }
}

/// Plain project HTML has no script execution, network resources or navigation privileges.
private struct InspectorHTMLPreview: UIViewRepresentable {
    let data: Data
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        let policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"
        // The trusted policy is parsed before any tag in the untrusted document. Later policies
        // can only further restrict it. The view has no app origin, cookies, scripts or bridge.
        let prefix = "<meta http-equiv=\"Content-Security-Policy\" content=\"" + policy + "\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        view.loadHTMLString(prefix + (String(data: data, encoding: .utf8) ?? ""), baseURL: URL(string: "about:blank"))
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(action.request.url?.scheme == "about" ? .allow : .cancel)
        }
    }
}
