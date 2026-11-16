import Foundation
import Markdown
import RiffetKit

/// A link to a file in the project (`fileAccess.ts`'s `localFileLink`): it opens the file panel,
/// and ⌘-click opens it in the editor.
enum FileLink {
    static let scheme = "riffet-file"

    static func url(path: String, line: Int?) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "open"
        components.queryItems = [URLQueryItem(name: "path", value: path)] + (line.map { [URLQueryItem(name: "line", value: String($0))] } ?? [])
        return components.url
    }

    static func parse(_ url: URL) -> (path: String, line: Int?)? {
        guard url.scheme == scheme, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let path = items.first(where: { $0.name == "path" })?.value else { return nil }
        return (path, items.first { $0.name == "line" }?.value.flatMap(Int.init))
    }

    /// A Markdown href that names a local file: no scheme (or `file://`), not a directory, with an
    /// optional `#L12` anchor or `:12` suffix.
    static func target(href: String) -> (path: String, line: Int?)? {
        let value = href.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty, !value.hasPrefix("//"), !value.hasPrefix("/api/"), !value.hasPrefix("#"), !value.hasPrefix("?") else { return nil }
        var anchorLine: Int?
        if let anchor = value.range(of: #"#L(\d+)(?:-L?\d+)?$"#, options: [.regularExpression, .caseInsensitive]) {
            anchorLine = Int(value[anchor].dropFirst(2).prefix { $0.isNumber })
        }
        var path = value.components(separatedBy: "#")[0]
        if path.lowercased().hasPrefix("file://") {
            path = URL(string: path)?.path ?? ""
        } else if path.range(of: #"^[a-z][a-z0-9+.-]*:(?!\d)"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return nil
        }
        path = path.removingPercentEncoding ?? path
        guard !path.isEmpty, !path.hasSuffix("/") else { return nil }
        let ns = path as NSString
        if let match = Self.lineSuffix.firstMatch(in: path, range: NSRange(location: 0, length: ns.length)) {
            return (ns.substring(with: match.range(at: 1)), anchorLine ?? Int(ns.substring(with: match.range(at: 2))))
        }
        return (path, anchorLine)
    }

    private static let lineSuffix = try! NSRegularExpression(pattern: #"^(.+?):(\d+)(?::\d+)?$"#)

    /// Inline code that reads as a path (`src/app.ts:42`), not as a command or an identifier.
    static func target(code: String) -> (path: String, line: Int?)? {
        let text = code.trimmingCharacters(in: .whitespaces)
        guard text.count <= 300, text.range(of: #"^[\w.@~/-]+(:\d+)?$"#, options: .regularExpression) != nil else { return nil }
        guard text.contains("/") || text.contains(".") || text.range(of: #":\d+$"#, options: .regularExpression) != nil else { return nil }
        return target(href: text)
    }
}

enum MarkdownSegmentModel {
    case blocks([MarkdownPart])
    case math(String)
    case image(alt: String, src: String)
    case visualization(path: String, title: String?, wide: Bool)
}

indirect enum MarkdownBlock {
    case paragraph(AttributedString)
    case heading(Int, AttributedString)
    case code(language: String?, text: String)
    case list(ordered: Bool, start: Int, items: [MarkdownListItem])
    case quote([MarkdownPart])
    case table(header: [AttributedString], rows: [[AttributedString]])
    case rule
}

struct MarkdownListItem {
    let checkbox: Bool?
    let blocks: [MarkdownBlock]
}

extension MarkdownBlock {
    /// Set as text alone: paragraphs, headings and lists of nothing else.
    var isProse: Bool {
        switch self {
        case .paragraph, .heading: true
        case let .list(_, _, items): items.allSatisfy { $0.blocks.allSatisfy(\.isProse) }
        default: false
        }
    }
}

/// A run of prose blocks, drawn as one text, or a block that needs a fragment of its own.
enum MarkdownPart {
    case prose(ProseRun)
    case block(MarkdownBlock)

    static func group(_ blocks: [MarkdownBlock]) -> [MarkdownPart] {
        var parts: [MarkdownPart] = []
        var run: [MarkdownBlock] = []
        for block in blocks {
            if block.isProse {
                run.append(block)
                continue
            }
            if !run.isEmpty { parts.append(.prose(ProseRun(run))) }
            run = []
            parts.append(.block(block))
        }
        if !run.isEmpty { parts.append(.prose(ProseRun(run))) }
        return parts
    }
}

/// Consecutive paragraphs, headings and lists of them in one message.
final class ProseRun: @unchecked Sendable {
    let blocks: [MarkdownBlock]
    /// A leading heading's top margin; a paragraph's space before is ignored at the top of the text.
    let leadingHeading: Bool

    init(_ blocks: [MarkdownBlock]) {
        self.blocks = blocks
        if case .heading = blocks.first { leadingHeading = true } else { leadingHeading = false }
    }
}

/// An agent's Markdown cut the way Kotlin cuts it (`MarkdownSegments.kt`): block formulas, standalone
/// images and visualization references first, so a half-streamed `$$` stays text here exactly as it
/// does on the phone; the rest parsed by swift-markdown.
///
/// The source is first cut into top-level blocks that parse the same apart as together
/// (`MarkdownBlocks`, the web's `markdownBlocks.ts`), and each block's result is cached by its text:
/// a streamed answer re-parses only its last, growing block. A [live] source (still streaming) does
/// not store its growing block or the whole document, so intermediate versions do not fill the cache.
enum MarkdownModel {
    private final class Box {
        let segments: [MarkdownSegmentModel]
        init(_ segments: [MarkdownSegmentModel]) { self.segments = segments }
    }

    /// One block's parse before adjacent prose is grouped across block boundaries.
    private enum Piece {
        case blocks([MarkdownBlock])
        case segment(MarkdownSegmentModel)
    }

    private final class Pieces {
        let pieces: [Piece]
        init(_ pieces: [Piece]) { self.pieces = pieces }
    }

    nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.countLimit = 600
        cache.totalCostLimit = textCacheBytes / 4
        CacheRegistry.shared.register("markdown.documents", limit: Int64(textCacheBytes / 4), evictsOnWarning: false) { cache.removeAllObjects() }
        return cache
    }()

    nonisolated(unsafe) private static let blockCache: NSCache<NSString, Pieces> = {
        let cache = NSCache<NSString, Pieces>()
        cache.countLimit = 4_000
        cache.totalCostLimit = textCacheBytes / 4
        CacheRegistry.shared.register("markdown.blocks", limit: Int64(textCacheBytes / 4), evictsOnWarning: false) { cache.removeAllObjects() }
        return cache
    }()

    /// A quarter of the text-cache budget each; the highlighter and the other text caches share the other half.
    /// This file is compiled into the iPhone app too, which has the phone's budget.
    #if os(iOS)
    private static let textCacheBytes = Int(BudgetsKt.TEXT_CACHE_BYTES_PHONE)
    #else
    private static let textCacheBytes = Int(BudgetsKt.TEXT_CACHE_BYTES_MAC)
    #endif

    static func segments(_ source: String, live: Bool = false) -> [MarkdownSegmentModel] {
        if let hit = cache.object(forKey: source as NSString) { return hit.segments }
        // Footnote definitions reach every block, so a document that may hold them is parsed whole.
        let chunks = source.contains("[^") ? [source] : MarkdownBlocks.split(source)
        var pieces: [Piece] = []
        for (index, chunk) in chunks.enumerated() {
            if chunks.count > 1, let hit = blockCache.object(forKey: chunk as NSString) {
                pieces += hit.pieces
                continue
            }
            let parsed = parse(chunk)
            if chunks.count > 1, !live || index < chunks.count - 1 {
                blockCache.setObject(Pieces(parsed), forKey: chunk as NSString, cost: max(1, chunk.utf16.count * 8))
            }
            pieces += parsed
        }
        let result = assemble(pieces)
        if !live { cache.setObject(Box(result), forKey: source as NSString, cost: max(1, source.utf16.count * 8)) }
        return result
    }

    /// Adjacent blocks from neighbouring chunks become one run of parts, as a whole-document parse groups them.
    private static func assemble(_ pieces: [Piece]) -> [MarkdownSegmentModel] {
        var result: [MarkdownSegmentModel] = []
        var blocks: [MarkdownBlock]?
        for piece in pieces {
            switch piece {
            case let .blocks(more):
                blocks = (blocks ?? []) + more
            case let .segment(segment):
                if let pending = blocks { result.append(.blocks(MarkdownPart.group(pending))) }
                blocks = nil
                result.append(segment)
            }
        }
        if let pending = blocks { result.append(.blocks(MarkdownPart.group(pending))) }
        return result
    }

    private static func parse(_ source: String) -> [Piece] {
        let footnotes = Footnotes.rewrite(document: source)
        var result: [Piece] = []
        let segments = splitVisualizationReferences(document: footnotes.document).flatMap { segment -> [MarkdownSegment] in
            if let text = segment as? MarkdownSegmentText { return splitBlockMath(document: text.text) }
            return [segment]
        }
        for segment in segments {
            switch onEnum(of: segment) {
            case let .math(math):
                result.append(.segment(.math(math.tex)))
            case let .image(image):
                result.append(.segment(.image(alt: image.alt, src: image.src)))
            case let .visualization(reference):
                result.append(.segment(.visualization(path: reference.path, title: reference.title, wide: reference.wide)))
            case let .text(text):
                for part in splitStandaloneImages(document: text.text) {
                    switch onEnum(of: part) {
                    case let .text(prose): result.append(.blocks(MarkdownConverter().blocks(Document(parsing: cjkFriendlyEmphasis(document: UnderscoreEmphasis.rewrite(document: prose.text))))))
                    case let .image(image): result.append(.segment(.image(alt: image.alt, src: image.src)))
                    case let .math(math): result.append(.segment(.math(math.tex)))
                    case let .visualization(reference): result.append(.segment(.visualization(path: reference.path, title: reference.title, wide: reference.wide)))
                    }
                }
            }
        }
        if !footnotes.notes.isEmpty {
            let items = footnotes.notes.map { note in
                MarkdownListItem(checkbox: nil, blocks: MarkdownConverter().blocks(Document(parsing: cjkFriendlyEmphasis(document: UnderscoreEmphasis.rewrite(document: note)))))
            }
            result.append(.blocks([.rule, .list(ordered: true, start: 1, items: items)]))
        }
        return result
    }
}

private struct MarkdownConverter {
    func blocks(_ container: Markup) -> [MarkdownBlock] {
        container.children.compactMap(block)
    }

    private func block(_ markup: Markup) -> MarkdownBlock? {
        switch markup {
        case let paragraph as Paragraph:
            return .paragraph(inline(paragraph))
        case let heading as Heading:
            return .heading(heading.level, inline(heading))
        case let code as CodeBlock:
            return .code(language: code.language?.isEmpty == false ? code.language : nil, text: code.code.hasSuffix("\n") ? String(code.code.dropLast()) : code.code)
        case let list as UnorderedList:
            return .list(ordered: false, start: 1, items: list.listItems.map(item))
        case let list as OrderedList:
            return .list(ordered: true, start: Int(list.startIndex), items: list.listItems.map(item))
        case let quote as BlockQuote:
            return .quote(MarkdownPart.group(blocks(quote)))
        case let table as Markdown.Table:
            let header = table.head.cells.map { inline($0) }
            let rows = table.body.rows.map { row in Array(row.cells.map { inline($0) }) }
            return .table(header: Array(header), rows: Array(rows))
        case is ThematicBreak:
            return .rule
        case let html as HTMLBlock:
            // The web escapes raw HTML and shows it as text; so does this, tag for tag.
            return .paragraph(AttributedString(html.rawHTML))
        default:
            let text = markup.format()
            return text.isEmpty ? nil : .paragraph(AttributedString(text))
        }
    }

    private func item(_ item: ListItem) -> MarkdownListItem {
        let checkbox: Bool? = item.checkbox.map { $0 == .checked }
        return MarkdownListItem(checkbox: checkbox, blocks: blocks(item))
    }

    /// [linkify] is off inside a `Markdown.Link`, whose children must not become links of their own.
    func inline(_ markup: Markup, linkify: Bool = true) -> AttributedString {
        var result = AttributedString()
        for child in markup.children { result += span(child, linkify: linkify) }
        return result
    }

    private func span(_ markup: Markup, linkify: Bool) -> AttributedString {
        switch markup {
        case let text as Markdown.Text:
            var value = AttributedString()
            for (piece, math) in MathText.split(text.string.replacingOccurrences(of: "\u{200B}", with: "")) {
                if math {
                    var part = AttributedString(piece)
                    if let url = MathText.url(piece) { part.link = url }
                    value += part
                } else if linkify {
                    for run in BareURLs.split(piece) {
                        var part = AttributedString(run.text)
                        if let link = run.link { part.link = link }
                        value += part
                    }
                } else {
                    value += AttributedString(piece)
                }
            }
            return value
        case let strong as Strong:
            var value = inline(strong, linkify: linkify)
            value.inlinePresentationIntent = (value.inlinePresentationIntent ?? []).union(.stronglyEmphasized)
            return value
        case let emphasis as Emphasis:
            var value = inline(emphasis, linkify: linkify)
            value.inlinePresentationIntent = (value.inlinePresentationIntent ?? []).union(.emphasized)
            return value
        case let strike as Strikethrough:
            var value = inline(strike, linkify: linkify)
            value.strikethroughStyle = .single
            return value
        case let code as InlineCode:
            var value = AttributedString(code.code)
            value.inlinePresentationIntent = .code
            if let target = FileLink.target(code: code.code), let url = FileLink.url(path: target.path, line: target.line) { value.link = url }
            return value
        case let link as Markdown.Link:
            var value = inline(link, linkify: false)
            if let destination = link.destination {
                if let target = FileLink.target(href: destination) {
                    value.link = FileLink.url(path: target.path, line: target.line)
                } else if let url = URL(string: destination) {
                    value.link = url
                }
            }
            return value
        case let image as Markdown.Image:
            return AttributedString(image.plainText.isEmpty ? (image.source ?? "") : image.plainText)
        case is SoftBreak:
            return AttributedString(" ")
        case is LineBreak:
            return AttributedString("\n")
        case let html as InlineHTML:
            return AttributedString(html.rawHTML)
        default:
            return inline(markup, linkify: linkify)
        }
    }
}

/// Mirrors the web's folded reasoning preview: a completed line while streaming, otherwise the
/// first non-empty line; show only the first sentence and render Markdown syntax as plain prose.
/// This helper is used only for thought-row titles. Tool commands keep their literal characters.
func reasoningPreview(_ text: String, running: Bool = false, limit: Int32 = 160) -> String {
    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    let nsText = normalized as NSString
    let breaks = paragraphSeparator.matches(in: normalized, range: NSRange(location: 0, length: nsText.length))
    var paragraphs: [String] = []
    var cursor = 0
    for lineBreak in breaks {
        paragraphs.append(nsText.substring(with: NSRange(location: cursor, length: lineBreak.range.location - cursor)))
        cursor = NSMaxRange(lineBreak.range)
    }
    paragraphs.append(nsText.substring(from: cursor))
    var streamingLine: String?
    if running {
        for index in paragraphs.indices.reversed() {
            let paragraph = paragraphs[index]
            let newline = paragraph.firstIndex(of: "\n")
            if index == paragraphs.index(before: paragraphs.endIndex), newline == nil { continue }
            let line = (newline.map { String(paragraph[..<$0]) } ?? paragraph).trimmingCharacters(in: .whitespacesAndNewlines)
            if !line.isEmpty {
                streamingLine = line
                break
            }
        }
    }
    let firstLine = normalized.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    let line = streamingLine ?? firstLine
    let sentence: String
    if let match = line.range(of: #"[.。!！?？](?:\s|$)"#, options: .regularExpression) { // i18n-ignore: sentence-boundary regex
        sentence = String(line[..<match.upperBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
        sentence = line
    }
    let parsed = reasoningProseText(sentence, live: running)
    let summary = parsed ?? plainSummary(markdown: sentence, limit: limit)
    let compact = summary.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    let preview = truncateReasoningPreview(compact, limit: limit)
    return preview.isEmpty ? String(localized: "思考") : preview
}

private let paragraphSeparator = try! NSRegularExpression(pattern: #"\n[\t ]*\n"#)

/// Read inline Markdown through the same parser as the expanded transcript so formatting markers
/// disappear while literal characters inside code spans (such as `**/*.swift` and `foo_bar`) stay.
private func reasoningProseText(_ markdown: String, live: Bool) -> String? {
    for segment in MarkdownModel.segments(markdown, live: live) {
        guard case let .blocks(parts) = segment else { continue }
        for part in parts {
            guard case let .prose(run) = part else { continue }
            for block in run.blocks {
                let text: AttributedString
                switch block {
                case let .paragraph(value), let .heading(_, value):
                    text = value
                default:
                    continue
                }
                let content = String(text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                if !content.isEmpty { return content }
            }
        }
    }
    return nil
}

private func truncateReasoningPreview(_ text: String, limit: Int32) -> String {
    guard limit > 0 else { return "" }
    let utf16 = text.utf16
    guard utf16.count > Int(limit) else { return text }

    var end = utf16.index(utf16.startIndex, offsetBy: Int(limit - 1))
    while String.Index(end, within: text) == nil {
        utf16.formIndex(before: &end)
    }
    guard let boundary = String.Index(end, within: text) else { return text }
    return String(text[..<boundary]).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
}

/// [value] in native UTF-8, so hashing and comparing it stays inside Swift.
func nativeString(_ value: String) -> String {
    var copy = value
    copy.makeContiguousUTF8()
    return copy
}

/// Show delivery progress and problems; a confirmed send needs no success label.
func nativeDeliveryLabel(_ run: Run, stopShown: Bool = true) -> String {
    TimelineFormatKt.deliveryLabel(run: run, stopShown: stopShown) ?? ""
}

/// Running, failed and interrupted process blocks open by default; only work that completed
/// normally folds, as on the web (`TurnProcess`). Explicit choices and the completed-process
/// preference take priority. A block the reader is looking at when it ends (scrolled up to it)
/// stays open, as if they had opened it.
/// Not thread-safe; the transcript reads and writes it under its own lock.
final class ProcessFolds {
    /// Subagent detail views can show completed tool work by default, while the main transcript
    /// keeps the compact web-style default. Explicit reading choices override this preference.
    private let completedProcessesOpen: Bool

    /// What `sync` reads off a process row.
    struct State: Equatable {
        let key: String
        let running: Bool
        let issues: Int
        var endsTurn = false
        var interrupted = false
    }

    private struct Fold: Equatable {
        var open: Bool
        var manual: Bool
        var running: Bool
        var issues: Int
        var interrupted = false
    }

    private var folds: [String: Fold] = [:]

    init(completedProcessesOpen: Bool = false) {
        self.completedProcessesOpen = completedProcessesOpen
    }

    static func states(_ rows: [any TimelineRow]) -> [State] {
        rows.compactMap { ($0 as? TimelineRowProcess).map { State(key: nativeString($0.key), running: $0.running, issues: Int($0.issueCount), endsTurn: $0.endsTurn, interrupted: $0.interrupted) } }
    }

    /// Applies run-state transitions from a fresh grouping; returns the keys whose open state changed.
    @discardableResult
    func sync(_ states: [State], reading: (String) -> Bool = { _ in false }) -> Set<String> {
        var changed: Set<String> = []
        for state in states {
            guard var fold = folds[state.key] else {
                folds[state.key] = Fold(
                    open: opens(state.running, state.issues, state.interrupted),
                    manual: false,
                    running: state.running,
                    issues: state.issues,
                    interrupted: state.interrupted
                )
                continue
            }
            let before = fold
            if !fold.manual && state.running != fold.running {
                if !state.running && reading(state.key) && fold.open {
                    fold.manual = true
                } else {
                    fold.open = opens(state.running, state.issues, state.interrupted)
                }
            }
            if state.issues != fold.issues && state.issues > 0 && !fold.manual { fold.open = true }
            // The stop can be recorded after the block stopped running.
            if state.interrupted && !fold.interrupted && !fold.manual { fold.open = true }
            fold.running = state.running
            fold.issues = state.issues
            fold.interrupted = state.interrupted
            if fold != before {
                folds[state.key] = fold
                if fold.open != before.open { changed.insert(state.key) }
            }
        }
        return changed
    }

    func isOpen(_ row: TimelineRowProcess) -> Bool {
        isOpen(key: nativeString(row.key), running: row.running, issues: Int(row.issueCount), endsTurn: row.endsTurn, interrupted: row.interrupted)
    }

    func isOpen(key: String, running: Bool, issues: Int, endsTurn: Bool = false, interrupted: Bool = false) -> Bool {
        folds[key]?.open ?? opens(running, issues, interrupted)
    }

    private func opens(_ running: Bool, _ issues: Int, _ interrupted: Bool) -> Bool {
        running || issues > 0 || interrupted || completedProcessesOpen
    }

    func toggle(_ row: TimelineRowProcess) {
        toggle(key: nativeString(row.key), running: row.running, issues: Int(row.issueCount), endsTurn: row.endsTurn, interrupted: row.interrupted)
    }

    func toggle(key: String, running: Bool, issues: Int, endsTurn: Bool = false, interrupted: Bool = false) {
        var fold = folds[key] ?? Fold(open: isOpen(key: key, running: running, issues: issues, endsTurn: endsTurn, interrupted: interrupted), manual: false, running: running, issues: issues, interrupted: interrupted)
        fold.manual = true
        fold.open.toggle()
        folds[key] = fold
    }
}
