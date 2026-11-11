import SwiftUI
import UIKit
import ImageIO
import RiffetKit

/// The AST is shared with macOS; only the platform rendering lives here.
struct ConversationMarkdown: View {
    let source: String
    let workbench: Workbench
    let projectID: String
    var compact = false
    var stateID: String? = nil
    @State private var fileTarget: ConversationFileTarget?
    @State private var mathTarget: ConversationMathTarget?
    @State private var serverTarget: ConversationServerTarget?
    @Environment(\.palette) private var palette
    @State private var content: ConversationMarkdownContent

    init(source: String, workbench: Workbench, projectID: String, compact: Bool = false, stateID: String? = nil) {
        self.source = source
        self.workbench = workbench
        self.projectID = projectID
        self.compact = compact
        self.stateID = stateID
        // First frame carries the parsed content (see
        // `ConversationMarkdownContent.preRendered`): an initially empty
        // markdown would measure as zero height off-screen and then pop to
        // its real height inside the cell.
        _content = State(initialValue: ConversationMarkdownContent.preRendered(source))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 8 : 14) {
            ForEach(Array(content.segments.enumerated()), id: \.offset) { index, segment in
                segmentView(segment, statePath: "segment.\(index)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .riffetFont(.body)
        .foregroundStyle(compact ? palette.fg3 : palette.fg)
        .textSelection(.enabled)
        .onChange(of: source, initial: true) { _, value in content.update(value) }
        .onAppear { content.update(source) }
        .onDisappear { content.cancel() }
        .environment(\.openURL, OpenURLAction { url in
            // A server path (`/api/…`) is not a project file: open it against the server, authenticated.
            if url.scheme == nil, url.path.hasPrefix("/api/"), let resolved = ConversationServerPath.url(url.absoluteString, base: workbench.resources.baseURL) {
                serverTarget = .init(url: resolved)
                return .handled
            }
            if let target = FileLink.parse(url) {
                fileTarget = .init(path: resolveMention(target.path), line: target.line)
                return .handled
            }
            if let tex = MathText.tex(url) { mathTarget = .init(tex: tex); return .handled }
            guard ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return .discarded }
            return .systemAction
        })
        .sheet(item: $mathTarget) { target in
            NavigationStack {
                VStack(spacing: 20) { ConversationMath(tex: target.tex, workbench: workbench); Text(target.tex).font(.body.monospaced()).textSelection(.enabled) }.padding().navigationTitle(String(localized: "公式", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { mathTarget = nil } } }
            }.presentationDetents([.medium, .large])
        }
        .sheet(item: $serverTarget) { target in
            NavigationStack {
                ConversationServerFile(workbench: workbench, url: target.url)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { serverTarget = nil } } }
            }
        }
        .sheet(item: $fileTarget) { target in
            NavigationStack {
                ConversationFilePage(workbench: workbench, projectID: projectID, path: target.path, targetLine: target.line)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { fileTarget = nil } } }
            }
        }
    }

    /// A bare file name written in prose names the file the conversation's tools touched.
    private func resolveMention(_ path: String) -> String {
        let items = workbench.grouping?.items ?? []
        return FileMentionsKt.resolveFileMention(path: path, files: FileMentionsKt.conversationFiles(items: items, root: workbench.project(projectID)?.cwd))
    }

    @ViewBuilder private func segmentView(_ segment: MarkdownSegmentModel, statePath: String) -> some View {
        switch segment {
        case let .blocks(parts): partsView(parts, statePath: statePath + ".blocks")
        case let .math(tex): ConversationMath(tex: tex, workbench: workbench)
        case let .image(alt, src): ConversationImage(workbench: workbench, projectID: projectID, source: src, label: alt)
        case let .visualization(path, title, _):
            NavigationLink {
                ConversationVisualization(workbench: workbench, projectID: projectID, path: path)
                    .navigationTitle(title ?? (path as NSString).lastPathComponent)
            } label: { Label(title ?? String(localized: "查看交互预览", bundle: .riffet), systemImage: "chart.xyaxis.line").padding(12).frame(maxWidth: .infinity, alignment: .leading).background(palette.press, in: RoundedRectangle(cornerRadius: 12)) }
        }
    }

    /// `muted` is a quote's tone: prose draws its own colour, so it is passed down rather than styled from outside.
    private func partsView(_ parts: [MarkdownPart], statePath: String, muted: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: compact ? 8 : 12) {
            ForEach(Array(parts.enumerated()), id: \.offset) { partIndex, part in
                switch part {
                case let .prose(run):
                    ForEach(Array(run.blocks.enumerated()), id: \.offset) { blockIndex, block in
                        blockView(block, statePath: statePath + ".part.\(partIndex).prose.\(blockIndex)", muted: muted)
                    }
                case let .block(block): blockView(block, statePath: statePath + ".part.\(partIndex).block", muted: muted)
                }
            }
        }
    }

    private func blockView(_ block: MarkdownBlock, statePath: String, muted: Bool = false) -> AnyView {
        switch block {
        // CJK prose reads best near 1.55× its size: 16pt body gets 6pt of leading (about 25pt a line), compact text 5.
        case let .paragraph(text): return AnyView(ConversationInlineText(source: text, origin: workbench.baseURL, secondary: compact || muted, spacing: compact ? 5 : 6).fixedSize(horizontal: false, vertical: true))
        case let .heading(level, text): return AnyView(ConversationInlineText(source: text, origin: workbench.baseURL, textStyle: level < 2 ? .title2 : level == 2 ? .title3 : .headline, bold: true, secondary: compact || muted, spacing: 3).padding(.top, compact ? 4 : 8).accessibilityAddTraits(.isHeader))
        case let .code(language, text):
            if ["math", "latex", "tex"].contains(language?.lowercased() ?? "") { return AnyView(ConversationMath(tex: text, workbench: workbench)) }
            return AnyView(ConversationCode(text: text, language: language, workbench: workbench, projectID: projectID, stateID: stateID.map { $0 + "." + statePath + ".code" }))
        case let .quote(parts): return AnyView(HStack(alignment: .top, spacing: 10) { RoundedRectangle(cornerRadius: 2).fill(palette.line).frame(width: 3); partsView(parts, statePath: statePath + ".quote", muted: true) }.fixedSize(horizontal: false, vertical: true))
        case let .list(ordered, start, items):
            return AnyView(VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: 8) {
                        if let check = item.checkbox { Image(systemName: check ? "checkmark.square" : "square").foregroundStyle(palette.fg3) }
                        else { Text(ordered ? "\(start + index)." : "•").foregroundStyle(palette.fg3).frame(minWidth: 14, alignment: .trailing) }
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(Array(item.blocks.enumerated()), id: \.offset) { blockIndex, block in
                                blockView(block, statePath: statePath + ".list.\(index).block.\(blockIndex)", muted: muted)
                            }
                        }
                    }
                }
            })
        case let .table(header, rows):
            return AnyView(ConversationMarkdownTable(header: header, rows: rows, origin: workbench.baseURL))
        case .rule: return AnyView(Divider())
        }
    }
}

/// Each cell receives a real text width before measuring its height. A Grid with only min/max
/// widths inside a horizontal ScrollView can choose an unbounded intrinsic width, then compress
/// the row to one line while its wrapped Text paints over adjacent rows.
struct ConversationMarkdownTable: View {
    let header: [AttributedString]
    let rows: [[AttributedString]]
    let origin: URL
    @ScaledMetric(relativeTo: .body) private var pointSize = 16.0
    @Environment(\.palette) private var palette
    private var widths: [CGFloat] { ConversationTableLayout.widths(header: header, rows: rows, pointSize: pointSize) }
    var body: some View {
        let columns = widths
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                row(header, columns: columns, heading: true)
                    .background(palette.bgSubtle)
                ForEach(rows.indices, id: \.self) { index in
                    row(rows[index], columns: columns, heading: false)
                        .overlay(alignment: .top) { Divider() }
                        .accessibilityIdentifier("markdownTable.row.\(index)")
                }
            }
            .fixedSize(horizontal: true, vertical: false)
        }
        .fixedSize(horizontal: false, vertical: true)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.line, lineWidth: 0.5))
        .accessibilityIdentifier("markdownTable")
    }
    private func row(_ values: [AttributedString], columns: [CGFloat], heading: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(columns.indices, id: \.self) { column in
                ConversationInlineText(source: column < values.count ? values[column] : AttributedString(), origin: origin, bold: heading)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: max(1, columns[column] - 20), alignment: .topLeading)
                    .padding(10)
            }
        }
    }
}

enum ConversationTableLayout {
    static func widths(header: [AttributedString], rows: [[AttributedString]], pointSize: Double = 16) -> [CGFloat] {
        let count = max(header.count, rows.map(\.count).max() ?? 0)
        return (0..<count).map { column in
            let values = [header] + rows
            let longest = values.reduce(0.0) { width, row in
                guard column < row.count else { return width }
                let text = String(row[column].characters)
                let units = text.split(separator: "\n", omittingEmptySubsequences: false).map { line in
                    line.reduce(0.0) { $0 + ($1.asciiValue != nil ? 0.56 : 1) }
                }.max() ?? 0
                return max(width, units * pointSize)
            }
            return CGFloat(min(260, max(110, ceil(longest + 20))))
        }
    }
}

struct ConversationCode: View {
    let text: String
    var language: String?
    var workbench: Workbench? = nil
    var projectID: String? = nil
    /// Tool output can scroll locally without giving the conversation an enormous row.
    var maximumBodyHeight: CGFloat? = nil
    /// Stable transcript identity; standalone file/preview pages keep their local state by default.
    var stateID: String? = nil
    @ScaledMetric(relativeTo: .footnote) private var estimatedLineHeight = 18.0
    @Environment(\.colorScheme) private var scheme
    @Environment(\.palette) private var palette
    @Environment(\.conversationReadAction) private var readAction
    @Environment(\.conversationDisclosureState) private var disclosureState
    @State private var expanded = false
    @State private var preview: Bool? = nil
    @State private var copyFeedback = ConversationCopyFeedback()
    @State private var highlighting: ConversationSyntax.Result?
    @State private var presentationCache = ConversationCodePresentation.Cache()
    private var isDiagram: Bool { ConversationCodePreview.isDiagram(language) }
    private var canPreview: Bool { (isDiagram || ["html", "htm", "svg", "md", "markdown", "mdx"].contains(language?.lowercased() ?? "")) && workbench != nil && projectID != nil }
    private var isExpanded: Bool {
        get { stateID.flatMap { disclosureState?[$0 + ".expanded"] } ?? expanded }
        nonmutating set {
            if let stateID, let disclosureState { disclosureState[stateID + ".expanded"] = newValue }
            else { expanded = newValue }
        }
    }
    private var isPreviewing: Bool {
        get { stateID.flatMap { disclosureState?[$0 + ".preview"] } ?? (preview ?? isDiagram) }
        nonmutating set {
            if let stateID, let disclosureState { disclosureState[stateID + ".preview"] = newValue }
            else { preview = newValue }
        }
    }

    var body: some View {
        let presentation = presentationCache.presentation(text: text, expanded: isExpanded)
        let source = presentation.visibleText
        let highlighted = highlighting?.text == source && highlighting?.language == ConversationSyntax.language(language ?? "")
        let displayed = highlighted ? highlighting!.attributed(dark: scheme == .dark) : presentation.plainText
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Text((language?.isEmpty == false ? language! : "text").uppercased()).riffetFont(.monoSmall).tracking(0.8).foregroundStyle(palette.fg3).lineLimit(1)
                Spacer(minLength: 8)
                if canPreview {
                    Button { readAction(); isPreviewing.toggle() } label: { Image(systemName: isPreviewing ? "chevron.left.forwardslash.chevron.right" : "eye").font(.system(size: 13)).frame(width: 44, height: Self.headerHeight) }.accessibilityLabel(isPreviewing ? "显示源码" : "预览")
                }
                Button { UIPasteboard.general.string = text; copyFeedback.copy() } label: { Image(systemName: copyFeedback.copied ? "checkmark" : "doc.on.doc").font(.system(size: 13)).frame(width: 44, height: Self.headerHeight) }.accessibilityLabel(copyFeedback.copied ? "已复制代码" : "复制代码")
                    .conversationCopyFeedback(copyFeedback)
            }.padding(.leading, 12).foregroundStyle(palette.fg3).frame(height: Self.headerHeight).background(palette.press)
            if isPreviewing, let workbench, let projectID {
                if isDiagram || ["html", "htm", "svg"].contains(language?.lowercased() ?? "") {
                    ConversationCodePreview(source: text, language: language ?? "mermaid", workbench: workbench)
                } else {
                    ConversationMarkdown(source: text, workbench: workbench, projectID: projectID, stateID: stateID.map { $0 + ".preview" }).padding(12)
                }
            } else {
                // Long lines wrap: a phone column has no room for a sideways scroller inside the transcript.
                if let maximumBodyHeight {
                    ConversationCodeViewport(maximumHeight: maximumBodyHeight, estimatedHeight: CGFloat(min(presentation.totalLines, 60)) * estimatedLineHeight + 24, axes: .vertical,
                                             memoKey: stateID.map { "\($0)|\(isExpanded)" }) {
                        code(displayed).fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    }
                } else {
                    code(displayed).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading).padding(12)
                }
                if presentation.isTruncated {
                    Divider()
                    Button { readAction(); isExpanded = true } label: { Label("展开全部 \(presentation.totalLines) 行", systemImage: "chevron.down").riffetFont(.caption).foregroundStyle(palette.fg3).frame(maxWidth: .infinity, minHeight: 44) }
                } else if presentation.canCollapse {
                    Divider()
                    Button { readAction(); isExpanded = false } label: { Label("收起代码", systemImage: "chevron.up").riffetFont(.caption).foregroundStyle(palette.fg3).frame(maxWidth: .infinity, minHeight: 44) }
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .contain)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: 10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .task(id: ConversationSyntax.Key(text: presentation.visibleText, language: language ?? "")) {
            do {
                try await Task.sleep(for: .milliseconds(100))
                try Task.checkCancellation()
                let result = await ConversationSyntax.shared.highlight(source, language: language ?? "")
                try Task.checkCancellation()
                guard presentationCache.isCurrent(presentation) else { return }
                highlighting = result
            } catch { }
        }
    }
    private static let headerHeight: CGFloat = 36
    private func code(_ displayed: AttributedString) -> some View {
        // Tool output stays a notch smaller than code the reply itself shows.
        Text(displayed)
            .riffetFont(maximumBodyHeight == nil ? .mono : .monoSmall).lineSpacing(3).foregroundStyle(palette.fg).textSelection(.enabled)
    }
}

private struct ConversationViewportHeightKey: EnvironmentKey {
    static let defaultValue: CGFloat? = nil
}
extension EnvironmentValues {
    /// Native transcript adapters inject their visible collection height, excluding obscured insets.
    /// The optional default lets independently hosted code use its current window as a fallback.
    var conversationViewportHeight: CGFloat? {
        get { self[ConversationViewportHeightKey.self] }
        set { self[ConversationViewportHeightKey.self] = newValue }
    }
}

/// Only tool details opt into a local vertical scroller. Measure content, not its scroll offset,
/// and cap the measurement before publishing so scrolling cannot drive parent layout updates.
/// No SwiftUI ScrollView ancestor is required, including inside UIHostingConfiguration cells.
struct ConversationCodeViewport<Content: View>: View {
    let maximumHeight: CGFloat
    let estimatedHeight: CGFloat
    var axes: Axis.Set = .vertical
    /// Stable identity of the content: a reused cell starts at the height measured before.
    var memoKey: String? = nil
    @ViewBuilder var content: () -> Content
    @State private var contentHeight: CGFloat?
    @Environment(\.conversationViewportHeight) private var viewportHeight
    static func height(available: CGFloat, content: CGFloat, maximum: CGFloat) -> CGFloat {
        min(maximum, max(64, available * 0.65), max(1, content))
    }
    var body: some View {
        ScrollView(axes) {
            content().onGeometryChange(for: CGFloat.self) { geometry in
                min(maximumHeight, max(1, ceil(geometry.size.height)))
            } action: { height in
                guard contentHeight != height else { return }; contentHeight = height
                if let memoKey { ConversationLayoutMemo.shared.setHeight(height, for: "viewport|" + memoKey) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: Self.height(available: viewportHeight ?? Self.windowHeight(), content: contentHeight ?? memoKey.flatMap { ConversationLayoutMemo.shared.height("viewport|" + $0) } ?? estimatedHeight, maximum: maximumHeight), alignment: .topLeading)
        .scrollBounceBehavior(.basedOnSize)
        .defaultScrollAnchor(.topLeading)
        .clipped()
        .accessibilityIdentifier("codeOutputScroll")
    }
    private static func windowHeight() -> CGFloat {
        let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }.flatMap(\.windows).first(where: \.isKeyWindow)
        guard let window else { return 600 }
        return max(64, window.bounds.height - window.safeAreaInsets.top - window.safeAreaInsets.bottom)
    }
}

/// A server-relative path (`/api/…`) in a message resolves against the server this app is paired with;
/// the resource client adds the device authorization for that origin.
enum ConversationServerPath {
    static func url(_ source: String, base: URL) -> URL? {
        guard source.hasPrefix("/api/"), !source.hasPrefix("//") else { return nil }
        return URL(string: source, relativeTo: base)?.absoluteURL
    }
}

struct ConversationServerTarget: Identifiable { let id = UUID(); let url: URL }
struct ConversationMathTarget: Identifiable { let id = UUID(); let tex: String }
struct ConversationFileTarget: Identifiable { let id = UUID(); let path: String; var line: Int? = nil }
struct ConversationFilePage: View {
    let workbench: Workbench
    let projectID: String
    let path: String
    var targetLine: Int? = nil
    var body: some View {
        if let project = workbench.project(projectID) {
            ProjectFilePage(workbench: workbench, project: project, path: path, targetLine: targetLine)
        } else { ContentUnavailableView("项目不可用", systemImage: "folder.badge.questionmark", description: Text("项目可能已移除，请刷新会话列表后重试。")) }
    }
}

struct ConversationImage: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.palette) private var palette
    let workbench: Workbench
    let projectID: String
    let source: String
    var label = String(localized: "图片", bundle: .riffet)
    var attachmentID: String? = nil
    /// Pixel size when the producer recorded it (uploads, tool images); reserves the exact frame.
    var pixelSize: CGSize? = nil
    var trailing = false
    @State private var image: UIImage?
    @State private var error: String?
    @State private var retry = 0
    @State private var preview = false
    private var memoKey: String { ConversationLayoutMemo.imageKey(source: source, attachmentID: attachmentID, projectID: projectID) }
    private var vectorURL: URL? {
        guard attachmentID == nil, ((URL(string: source)?.path ?? source) as NSString).pathExtension.lowercased() == "svg", URL(string: source)?.scheme == nil else { return nil }
        // A server path is served as is; a project file goes through the themed preview renderer.
        if let server = ConversationServerPath.url(source, base: workbench.resources.baseURL) { return server }
        guard let raw = workbench.resources.fileURL(projectID: projectID, path: source) else { return nil }
        return ConversationPreviewDocument.previewURL(raw, dark: scheme == .dark)
    }
    var body: some View {
        let key = memoKey
        // A reused cell starts with the decoded picture instead of a spinner that then resizes.
        let shown = image ?? ConversationLayoutMemo.shared.image(key)
        Group {
            if let vectorURL {
                ConversationWebPage(workbench: workbench, url: vectorURL).frame(height: 320)
            } else {
                ConversationImageFrame(shape: ConversationLayoutMemo.shared.imageShape(key, pixelSize: pixelSize), trailing: trailing) {
                    if let shown {
                        Button { preview = true } label: { Image(uiImage: shown).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 10)) }.buttonStyle(.plain).accessibilityLabel(label.isEmpty ? String(localized: "查看图片", bundle: .riffet) : label)
                            .transition(.opacity)
                    } else if let error {
                        VStack(alignment: .leading, spacing: 6) {
                            Label(error, systemImage: "photo.badge.exclamationmark").riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(3)
                            Button("重新加载图片") { retry += 1 }.riffetFont(.caption)
                        }.padding(12).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: 10))
                    } else {
                        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: 10))
                            .transition(.opacity)
                    }
                }
            }
        }
        .task(id: ConversationImageKey(source: source, attachmentID: attachmentID, retry: retry)) {
            guard vectorURL == nil else { return }
            if retry == 0, let cached = ConversationLayoutMemo.shared.image(key) { image = cached; return }
            await load(key)
        }
        .sheet(isPresented: $preview) {
            NavigationStack { Group { if let shown { ProjectImagePreview(image: shown).accessibilityLabel(label.isEmpty ? String(localized: "图片", bundle: .riffet) : label) } }.navigationTitle(label.isEmpty ? String(localized: "图片", bundle: .riffet) : label).navigationBarTitleDisplayMode(.inline).toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { preview = false } }
                if let shown {
                    ToolbarItem(placement: .topBarLeading) {
                        let picture = Image(uiImage: shown)
                        ShareLink(item: picture, preview: SharePreview(label.isEmpty ? String(localized: "图片", bundle: .riffet) : label, image: picture))
                    }
                }
            } }
        }
    }
    private func load(_ key: String) async {
        error = nil
        image = nil
        do {
            let data: Data
            if source.hasPrefix("data:"), let comma = source.firstIndex(of: ",") {
                let payload = String(source[source.index(after: comma)...])
                guard let decoded = await Task.detached(priority: .userInitiated, operation: { Data(base64Encoded: payload) }).value else { throw AttachmentImportError.unreadableImage }
                data = decoded
            }
            else {
                let url: URL?
                if let attachmentID { url = workbench.resources.attachmentURL(attachmentID) }
                else if let candidate = URL(string: source), candidate.scheme != nil { url = candidate }
                else if let server = ConversationServerPath.url(source, base: workbench.resources.baseURL) { url = server }
                else { url = workbench.resources.fileURL(projectID: projectID, path: source, image: true) }
                guard let url else { throw URLError(.badURL) }
                data = try await workbench.resources.data(for: url)
            }
            try Task.checkCancellation()
            let decoded = await Task.detached(priority: .userInitiated) { ConversationImageDecoder.decode(data) }.value
            try Task.checkCancellation()
            guard let decoded else { throw AttachmentImportError.unreadableImage }
            ConversationLayoutMemo.shared.store(decoded, for: key)
            // The frame was reserved up front, so only the picture fades in; nothing moves.
            withAnimation(.easeOut(duration: 0.25)) { image = decoded }
        } catch is CancellationError { } catch { self.error = error.riffetMessage }
    }
}

/// A server path linked from a reply, downloaded with the device's authorization and shown in Quick
/// Look, which reads images, documents and pages alike.
private struct ConversationServerFile: View {
    let workbench: Workbench
    let url: URL
    @State private var file: URL?
    @State private var error: String?
    @Environment(\.palette) private var palette
    var body: some View {
        Group {
            if let file { FilePreview(url: file).ignoresSafeArea(edges: .bottom) }
            else if let error { Text(error).riffetFont(.caption).foregroundStyle(palette.fg3).padding() }
            else { ProgressView() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: url) {
            do { file = try await workbench.resources.file(for: url, name: url.lastPathComponent) }
            catch is CancellationError {} catch { self.error = error.riffetMessage }
        }
    }
}
