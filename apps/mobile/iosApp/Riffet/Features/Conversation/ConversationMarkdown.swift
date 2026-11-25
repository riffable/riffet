import SwiftUI
import UIKit
import ImageIO
import RiffetKit

/// Keeps a markdown view's content for its lifetime. It never publishes: the content is observed directly.
final class ConversationMarkdownHolder: ObservableObject {
    let content: ConversationMarkdownContent
    init(_ content: ConversationMarkdownContent) { self.content = content }
}

/// The AST is shared with macOS; only the platform rendering lives here.
struct ConversationMarkdown: View {
    let source: String
    let workbench: Workbench
    let projectID: String
    var compact = false
    var stateID: String? = nil
    @State private var linkTarget: ConversationLinkTarget?
    @Environment(\.palette) private var palette
    @Environment(\.conversationFindHighlight) private var findHighlight
    @ScaledMetric(relativeTo: .body) private var bodySize = 16.0
    @StateObject private var holder: ConversationMarkdownHolder
    private var content: ConversationMarkdownContent { holder.content }

    init(source: String, workbench: Workbench, projectID: String, compact: Bool = false, stateID: String? = nil) {
        self.source = source
        self.workbench = workbench
        self.projectID = projectID
        self.compact = compact
        self.stateID = stateID
        // First frame carries the parsed content (see
        // `ConversationMarkdownContent.preRendered`): an initially empty
        // markdown would measure as zero height off-screen and then pop to
        // its real height inside the cell. `StateObject` runs this once per
        // view identity; `State(initialValue:)` would parse the whole source
        // again on every parent update — each streamed token — and discard it.
        _holder = StateObject(wrappedValue: ConversationMarkdownHolder(ConversationMarkdownContent.preRendered(source)))
    }

    /// Where each prose block starts in the row's count of the needle, when the blocks together hold the
    /// selected occurrence; nil otherwise (every match is marked, and the row flashes).
    private var findOffsets: [String: Int]? {
        guard let highlight = findHighlight, !highlight.needle.isEmpty else { return nil }
        var offsets: [String: Int] = [:]
        var total = 0
        func count(_ text: AttributedString, _ path: String) { offsets[path] = total; total += highlight.ranges(in: String(text.characters)).count }
        func visit(_ parts: [MarkdownPart], _ path: String) {
            for (partIndex, part) in parts.enumerated() {
                switch part {
                case let .prose(run): for (index, block) in run.blocks.enumerated() { visit(block, path + ".part.\(partIndex).prose.\(index)") }
                case let .block(block): visit(block, path + ".part.\(partIndex).block")
                }
            }
        }
        func visit(_ block: MarkdownBlock, _ path: String) {
            switch block {
            case let .paragraph(text), let .heading(_, text): count(text, path)
            case let .quote(parts): visit(parts, path + ".quote")
            case let .list(_, _, items):
                for (index, item) in items.enumerated() { for (blockIndex, block) in item.blocks.enumerated() { visit(block, path + ".list.\(index).block.\(blockIndex)") } }
            default: break
            }
        }
        for (index, segment) in content.segments.enumerated() { if case let .blocks(parts) = segment { visit(parts, "segment.\(index).blocks") } }
        return total > highlight.nth ? offsets : nil
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
            switch ConversationLinkTarget.route(url, workbench: workbench, projectID: projectID) {
            case let .some(.page(target)): linkTarget = target; return .handled
            case .some(.system): return .systemAction
            case nil: return .discarded
            }
        })
        .modifier(ConversationLinkSheets(target: $linkTarget, workbench: workbench, projectID: projectID))
    }

    @ViewBuilder private func segmentView(_ segment: MarkdownSegmentModel, statePath: String) -> some View {
        switch segment {
        case let .blocks(parts): partsView(parts, statePath: statePath + ".blocks")
        case let .math(tex): ConversationMath(tex: tex, workbench: workbench)
        case let .image(alt, src): ConversationImage(workbench: workbench, projectID: projectID, source: src, label: alt)
        case let .visualization(path, title, _): ConversationVisualizationLink(workbench: workbench, projectID: projectID, path: path, title: title)
        }
    }

    /// `muted` is a quote's tone: prose draws its own colour, so it is passed down rather than styled from outside.
    private func partsView(_ parts: [MarkdownPart], statePath: String, muted: Bool = false) -> some View {
        // 14 between blocks over a 26 line, as the web's `.md`: a paragraph break reads as one and a half lines.
        VStack(alignment: .leading, spacing: compact ? 8 : 14) {
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

    private var leading: Double { compact ? ConversationProse.compactLeading : ConversationProse.bodyLeading }

    private func blockView(_ block: MarkdownBlock, statePath: String, muted: Bool = false) -> AnyView {
        switch block {
        case let .paragraph(text): return AnyView(ConversationInlineText(source: text, origin: workbench.baseURL, secondary: compact || muted, leading: leading, findOffset: findOffsets?[statePath]).fixedSize(horizontal: false, vertical: true))
        case let .heading(level, text): return AnyView(ConversationInlineText(source: text, origin: workbench.baseURL, textStyle: level < 2 ? .title2 : level == 2 ? .title3 : .headline, bold: true, secondary: compact || muted, leading: ConversationProse.headingLeading, findOffset: findOffsets?[statePath]).padding(.top, compact ? 4 : 8).accessibilityAddTraits(.isHeader))
        case let .code(language, text):
            if ["math", "latex", "tex"].contains(language?.lowercased() ?? "") { return AnyView(ConversationMath(tex: text, workbench: workbench)) }
            return AnyView(ConversationCode(text: text, language: language, workbench: workbench, projectID: projectID, stateID: stateID.map { $0 + "." + statePath + ".code" }))
        case let .quote(parts): return AnyView(HStack(alignment: .top, spacing: 10) { RoundedRectangle(cornerRadius: 2).fill(palette.line).frame(width: 3); partsView(parts, statePath: statePath + ".quote", muted: true) }.fixedSize(horizontal: false, vertical: true))
        case let .list(ordered, start, items):
            // Items 6 apart, a second paragraph in an item 10 below the first, a nested list 4 (the web's `li`).
            return AnyView(VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: 8) {
                        // The marker fills the first line's box, so it centres on that line's text.
                        Group {
                            if let check = item.checkbox { Image(systemName: check ? "checkmark.square" : "square") }
                            else { Text(ordered ? "\(start + index)." : "•").monospacedDigit() }
                        }
                        .foregroundStyle(palette.fg3).frame(minWidth: 14, minHeight: (bodySize * leading).rounded(), alignment: .trailing)
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(item.blocks.enumerated()), id: \.offset) { blockIndex, block in
                                blockView(block, statePath: statePath + ".list.\(index).block.\(blockIndex)", muted: muted)
                                    .padding(.top, blockIndex == 0 ? 0 : block.isList ? 4 : 10)
                            }
                        }
                    }
                }
            })
        case let .table(header, rows, alignments):
            return AnyView(ConversationMarkdownTable(header: header, rows: rows, alignments: alignments, origin: workbench.baseURL))
        case .rule: return AnyView(Divider())
        }
    }
}

/// A reply's interactive visualization: a link to its page.
struct ConversationVisualizationLink: View {
    let workbench: Workbench
    let projectID: String
    let path: String
    let title: String?
    @Environment(\.palette) private var palette
    var body: some View {
        NavigationLink {
            ConversationVisualization(workbench: workbench, projectID: projectID, path: path)
                .navigationTitle(title ?? (path as NSString).lastPathComponent)
        } label: { Label(title ?? String(localized: "查看交互预览", bundle: .riffet), systemImage: "chart.xyaxis.line").padding(12).frame(maxWidth: .infinity, alignment: .leading).background(palette.press, in: RoundedRectangle(cornerRadius: 12)) }
    }
}

/// Each cell receives a real text width before measuring its height. A Grid with only min/max
/// widths inside a horizontal ScrollView can choose an unbounded intrinsic width, then compress
/// the row to one line while its wrapped Text paints over adjacent rows.
struct ConversationMarkdownTable: View {
    let header: [AttributedString]
    let rows: [[AttributedString]]
    var alignments: [MarkdownTableAlignment] = []
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
    private func columnAlignment(_ column: Int) -> Alignment {
        guard column < alignments.count else { return .topLeading }
        switch alignments[column] {
        case .center: return .top
        case .right: return .topTrailing
        case .left: return .topLeading
        }
    }
    private func textAlignment(_ column: Int) -> NSTextAlignment {
        guard column < alignments.count else { return .left }
        switch alignments[column] {
        case .center: return .center
        case .right: return .right
        case .left: return .left
        }
    }
    private func row(_ values: [AttributedString], columns: [CGFloat], heading: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(columns.indices, id: \.self) { column in
                ConversationInlineText(source: column < values.count ? values[column] : AttributedString(), origin: origin, bold: heading, leading: ConversationProse.tableLeading, alignment: textAlignment(column))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: max(1, columns[column] - 20), alignment: columnAlignment(column))
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

/// Some agents cite code as ```12:40:path/to/file.ts — a line range and a file, not a language.
struct ConversationCodeCitation {
    let start: Int
    let end: Int
    let path: String

    init?(_ info: String?) {
        guard let trimmed = info?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        let ns = trimmed as NSString
        guard let match = Self.regex.firstMatch(in: trimmed, range: NSRange(location: 0, length: ns.length)),
              let start = Int(ns.substring(with: match.range(at: 1))),
              let end = Int(ns.substring(with: match.range(at: 2))) else { return nil }
        self.start = start
        self.end = end
        self.path = ns.substring(with: match.range(at: 3))
    }

    private static let regex = try! NSRegularExpression(pattern: #"^(\d+):(\d+):(.+)$"#)
}

struct ConversationCode: View {
    let text: String
    var language: String?
    var workbench: Workbench? = nil
    var projectID: String? = nil
    /// Tool commands and output read a notch smaller than code a reply shows, and stop lower.
    var output = false
    /// False on a page that scrolls the code itself (a file): the body is not capped, only scrolled sideways.
    var capped = true
    /// Stable transcript identity; standalone file/preview pages keep their local state by default.
    var stateID: String? = nil
    @ScaledMetric(relativeTo: .footnote) private var outputLineHeight = 19.0
    @ScaledMetric(relativeTo: .body) private var codeLineHeight = 20.0
    @Environment(\.colorScheme) private var scheme
    @Environment(\.palette) private var palette
    @Environment(ThemeStore.self) private var themeStore
    @Environment(\.conversationReadAction) private var readAction
    @Environment(\.conversationDisclosureState) private var disclosureState
    @State private var expanded = false
    @State private var preview: Bool? = nil
    @State private var highlighting: ConversationSyntax.Result?
    @State private var presentationCache = ConversationCodePresentation.Cache()
    private var cited: ConversationCodeCitation? { ConversationCodeCitation(language) }
    private var syntaxLanguage: String? {
        if let cited { return ConversationSyntax.language(forPath: cited.path) }
        return language.flatMap { ConversationSyntax.language($0) }
    }
    private var isDiagram: Bool { cited == nil && ConversationCodePreview.isDiagram(language) }
    private var canPreview: Bool { cited == nil && (isDiagram || ["html", "htm", "svg", "md", "markdown", "mdx"].contains(language?.lowercased() ?? "")) && workbench != nil && projectID != nil }
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
        let highlighted = highlighting?.text == source && highlighting?.language == syntaxLanguage
        let displayed = highlighted ? highlighting!.attributed(palette: palette, codeTheme: themeStore.codeTheme, dark: scheme == .dark) : presentation.plainText
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                if let cited {
                    Text("\(cited.path) · L\(cited.start)–\(cited.end)")
                        .riffetFont(.monoSmall)
                        .foregroundStyle(palette.fg3)
                        .lineLimit(1)
                        .truncationMode(.head)
                } else {
                    Text((language?.isEmpty == false ? language! : "text").uppercased()).riffetFont(.monoSmall).tracking(0.8).foregroundStyle(palette.fg3).lineLimit(1)
                }
                Spacer(minLength: 8)
                if canPreview {
                    Button { readAction(); isPreviewing.toggle() } label: { Image(systemName: isPreviewing ? "chevron.left.forwardslash.chevron.right" : "eye").riffetFont(.caption).frame(width: 44, height: Self.headerHeight) }.accessibilityLabel(isPreviewing ? "显示源码" : "预览")
                }
                RiffetCopyButton(text: text, label: String(localized: "复制代码", bundle: .riffet), height: Self.headerHeight)
            }.padding(.leading, 12).foregroundStyle(palette.fg3).frame(height: Self.headerHeight).background(palette.press)
            if isPreviewing, let workbench, let projectID {
                if isDiagram || ["html", "htm", "svg"].contains(language?.lowercased() ?? "") {
                    ConversationCodePreview(source: text, language: language ?? "mermaid", workbench: workbench)
                } else {
                    ConversationMarkdown(source: text, workbench: workbench, projectID: projectID, stateID: stateID.map { $0 + ".preview" }).padding(12)
                }
            } else {
                // Lines never wrap: the block keeps a fixed cap and scrolls inside, up and down and sideways,
                // so a long line or a long output never widens or lengthens the page.
                if capped {
                    let lineHeight = output ? outputLineHeight : codeLineHeight
                    ConversationCodeViewport(maximumHeight: output ? RiffetMetrics.codeOutputMaxHeight : RiffetMetrics.codeBlockMaxHeight,
                                             estimatedHeight: CGFloat(min(presentation.totalLines, 60)) * lineHeight + 24, axes: [.vertical, .horizontal],
                                             memoKey: stateID.map { "\($0)|\(isExpanded)" }) {
                        code(displayed).fixedSize(horizontal: true, vertical: true).padding(12)
                    }
                } else {
                    ScrollView(.horizontal) {
                        code(displayed).fixedSize(horizontal: true, vertical: true).padding(12)
                    }
                    .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
                    .defaultScrollAnchor(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
        .task(id: ConversationSyntax.Key(text: presentation.visibleText, language: syntaxLanguage ?? "")) {
            do {
                try await Task.sleep(for: .milliseconds(100))
                try Task.checkCancellation()
                guard let syntaxLanguage else { return }
                let result = await ConversationSyntax.shared.highlight(source, language: syntaxLanguage)
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
            .riffetFont(output ? .monoSmall : .mono).lineSpacing(3).foregroundStyle(palette.fg).textSelection(.enabled)
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

/// A code block's local scroller (both axes in the transcript). Measure content, not its scroll offset,
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

/// Where a link in a reply leads: a page of the app's own, or the system. Shared by `ConversationMarkdown`
/// and the transcript's drawn prose (`TranscriptProseActions.open`).
enum ConversationLinkTarget: Identifiable {
    case file(ConversationFileTarget)
    case math(ConversationMathTarget)
    case server(ConversationServerTarget)
    var id: UUID {
        switch self {
        case let .file(target): target.id
        case let .math(target): target.id
        case let .server(target): target.id
        }
    }
    enum Route { case page(ConversationLinkTarget), system }

    /// nil: not a link this app opens.
    @MainActor static func route(_ url: URL, workbench: Workbench, projectID: String) -> Route? {
        // A server path (`/api/…`) is not a project file: open it against the server, authenticated.
        if url.scheme == nil, url.path.hasPrefix("/api/"), let resolved = ConversationServerPath.url(url.absoluteString, base: workbench.resources.baseURL) {
            return .page(.server(.init(url: resolved)))
        }
        if let target = FileLink.parse(url) {
            // A bare file name written in prose names the file the conversation's tools touched.
            let items = workbench.grouping?.items ?? []
            let path = FileMentionsKt.resolveFileMention(path: target.path, files: FileMentionsKt.conversationFiles(items: items, root: workbench.project(projectID)?.cwd))
            return .page(.file(.init(path: path, line: target.line)))
        }
        if let tex = MathText.tex(url) { return .page(.math(.init(tex: tex))) }
        guard ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return .system
    }
}

/// The pages a link in a reply opens.
struct ConversationLinkSheets: ViewModifier {
    @Binding var target: ConversationLinkTarget?
    let workbench: Workbench
    let projectID: String
    func body(content: Content) -> some View {
        content.sheet(item: $target) { target in
            switch target {
            case let .math(math):
                NavigationStack {
                    VStack(spacing: 20) { ConversationMath(tex: math.tex, workbench: workbench); Text(math.tex).riffetFont(.mono).textSelection(.enabled) }.padding().navigationTitle(String(localized: "公式", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { self.target = nil } } }
                }.presentationDetents([.medium, .large])
            case let .server(server):
                NavigationStack {
                    ConversationServerFile(workbench: workbench, url: server.url)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { self.target = nil } } }
                }
            case let .file(file):
                NavigationStack {
                    ConversationFilePage(workbench: workbench, projectID: projectID, path: file.path, targetLine: file.line)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { self.target = nil } } }
                }
            }
        }
    }
}
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
            if let shown { ConversationImageViewer(inline: shown, label: label.isEmpty ? String(localized: "图片", bundle: .riffet) : label, load: data, done: { preview = false }) }
        }
    }
    /// The encoded image, read again for the viewer rather than kept: only attachments, which never
    /// change, come from the disk cache (`ResourceClient`).
    private func data() async throws -> Data {
        if source.hasPrefix("data:"), let comma = source.firstIndex(of: ",") {
            let payload = String(source[source.index(after: comma)...])
            guard let decoded = await Task.detached(priority: .userInitiated, operation: { Data(base64Encoded: payload) }).value else { throw AttachmentImportError.unreadableImage }
            return decoded
        }
        let url: URL?
        if let attachmentID { url = workbench.resources.attachmentURL(attachmentID) }
        else if let candidate = URL(string: source), candidate.scheme != nil { url = candidate }
        else if let server = ConversationServerPath.url(source, base: workbench.resources.baseURL) { url = server }
        else { url = workbench.resources.fileURL(projectID: projectID, path: source, image: true) }
        guard let url else { throw URLError(.badURL) }
        return try await workbench.resources.data(for: url)
    }
    private func load(_ key: String) async {
        error = nil
        image = nil
        do {
            let data = try await data()
            try Task.checkCancellation()
            let decoded = await Task.detached(priority: .userInitiated) { ConversationImageDecoder.decode(data) }.value
            try Task.checkCancellation()
            guard let decoded else { throw AttachmentImportError.unreadableImage }
            ConversationLayoutMemo.shared.store(decoded, for: key)
            // The frame was reserved up front, so only the picture fades in; nothing moves.
            withAnimation(RiffetMotion.release) { image = decoded }
        } catch is CancellationError { } catch { self.error = error.riffetMessage }
    }
}

/// The viewer starts from the inline picture, decoded at display size, and replaces it with one decoded
/// for zooming once that is ready (docs/guide/ios-performance.md §2.9).
private struct ConversationImageViewer: View {
    let inline: UIImage
    let label: String
    let load: () async throws -> Data
    let done: () -> Void
    @State private var full: UIImage?
    var body: some View {
        let shown = full ?? inline
        NavigationStack {
            ProjectImagePreview(image: shown).accessibilityLabel(label)
                .navigationTitle(label).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("完成", action: done) }
                    ToolbarItem(placement: .topBarLeading) {
                        let picture = Image(uiImage: shown)
                        ShareLink(item: picture, preview: SharePreview(label, image: picture))
                    }
                }
        }
        .task {
            guard let data = try? await load(), !Task.isCancelled else { return }
            let decoded = await Task.detached(priority: .userInitiated) { ConversationImageDecoder.decode(data, maximumPixelSize: ConversationImageDecoder.viewerEdge) }.value
            guard let decoded, !Task.isCancelled, decoded.size.width * decoded.scale > inline.size.width * inline.scale else { return }
            full = decoded
        }
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

extension MarkdownBlock {
    var isList: Bool { if case .list = self { return true }; return false }
}
