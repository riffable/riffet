import Foundation
import SwiftUI
import JavaScriptCore
import ImageIO
import UIKit
import Observation

/// One serial parser keeps the stream from spawning a queue of competing full-document parses.
/// Callers debounce and check cancellation before publishing; completed answers share the macOS AST cache.
actor ConversationMarkdownParser {
    static let shared = ConversationMarkdownParser()
    func parse(_ source: String) -> [MarkdownSegmentModel] { MarkdownModel.segments(source) }
}

/// Throttle parsing instead of debouncing visible prose: a continuous fast stream must keep
/// advancing. There is only one pending source and one active parse for this message.
@MainActor @Observable
final class ConversationMarkdownContent {
    private(set) var segments: [MarkdownSegmentModel] = []
    private(set) var renderedSource: String?
    @ObservationIgnored private var latest = ""
    @ObservationIgnored private var worker: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()

    func update(_ source: String) {
        latest = source
        if source.isEmpty { cancel(); segments = []; renderedSource = source; return }
        guard worker == nil, renderedSource != source else { return }
        let token = generation
        worker = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let source = self.latest
                let parsed = await ConversationMarkdownParser.shared.parse(source)
                guard !Task.isCancelled, token == self.generation else { return }
                self.segments = parsed
                self.renderedSource = source
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                if self.latest == source { self.worker = nil; return }
            }
        }
    }
    func cancel() { generation = UUID(); worker?.cancel(); worker = nil }

    /// Content whose first frame already holds the parsed segments. A cell
    /// that starts empty and pops to full height once the async parse lands
    /// cannot be measured before display — and visibly grows after it. The
    /// parse is synchronous and shared (results are cached across the app),
    /// so the first frame is the real one; later source changes keep the
    /// throttled async path above.
    static func preRendered(_ source: String) -> ConversationMarkdownContent {
        let content = ConversationMarkdownContent()
        if !source.isEmpty {
            content.segments = MarkdownModel.segments(source)
            content.renderedSource = source
        }
        return content
    }
}

/// Long tool output and code remain readable without a nested vertical scroller swallowing the
/// conversation gesture. Copy always uses the complete original source, including hidden lines.
struct ConversationCodePresentation {
    static let previewLines = 60
    static let previewCharacters = 16_000

    /// Keep the full source and its bounded preview together. Expansion and unrelated SwiftUI
    /// invalidations must not recount a multi-megabyte tool result or rebuild its preview.
    final class Source {
        let text: String
        let preview: String
        let totalLines: Int
        let isTruncated: Bool
        let previewPlain: AttributedString
        lazy var expandedPlain = AttributedString(text)
        init(_ text: String) {
            self.text = text
            // Count LF bytes once, including CRLF, rather than walking every grapheme cluster.
            totalLines = text.utf8.withContiguousStorageIfAvailable { bytes in
                guard let base = bytes.baseAddress else { return 1 }
                let end = base + bytes.count
                var cursor = base
                var count = 1
                while cursor < end, let newline = memchr(cursor, 10, end - cursor) {
                    count += 1
                    cursor = UnsafePointer(newline.assumingMemoryBound(to: UInt8.self)) + 1
                }
                return count
            } ?? text.utf8.reduce(1) { $1 == 10 ? $0 + 1 : $0 }
            var lines = 1
            var end = text.startIndex
            var count = 0
            while end < text.endIndex && count < ConversationCodePresentation.previewCharacters {
                let character = text[end]
                if character == "\n" || character == "\r\n" {
                    if lines == ConversationCodePresentation.previewLines { break }
                    lines += 1
                }
                end = text.index(after: end)
                count += 1
            }
            preview = String(text[..<end])
            previewPlain = AttributedString(preview)
            isTruncated = end != text.endIndex
        }
    }
    /// This cache is deliberately not observable: filling a derived snapshot while reading the
    /// body must not publish state and start another layout pass. SwiftUI owns it via @State.
    final class Cache {
        private var source: Source?
        func presentation(text: String, expanded: Bool) -> ConversationCodePresentation {
            let value: Source
            if let source, source.text == text { value = source }
            else { value = Source(text); source = value }
            return ConversationCodePresentation(source: value, expanded: expanded)
        }
        func isCurrent(_ presentation: ConversationCodePresentation) -> Bool { source === presentation.source }
    }
    let source: Source
    let expanded: Bool
    var visibleText: String { expanded ? source.text : source.preview }
    var plainText: AttributedString { expanded ? source.expandedPlain : source.previewPlain }
    var totalLines: Int { source.totalLines }
    var isTruncated: Bool { !expanded && source.isTruncated }
    var canCollapse: Bool { expanded && source.isTruncated }
    init(text: String, expanded: Bool) { self.init(source: Source(text), expanded: expanded) }
    private init(source: Source, expanded: Bool) { self.source = source; self.expanded = expanded }
}

/// Reuse the exact Prism/refractor bundle shipped by macOS and Web, with native Text rendering.
/// There is no WKWebView per code fence and no JavaScript executing on the main thread.
actor ConversationSyntax {
    static let shared = ConversationSyntax()
    struct Key: Hashable { let text: String; let language: String }
    struct Run { let text: String; let token: String? }
    final class Result: @unchecked Sendable {
        let text: String
        let language: String
        let runs: [Run]
        private let lock = NSLock()
        private var cache: [CacheKey: AttributedString] = [:]
        private struct CacheKey: Hashable { let uiTheme: String; let codeTheme: String; let dark: Bool }
        init(text: String, language: String, runs: [Run]) {
            self.text = text; self.language = language; self.runs = runs
        }
        func attributed(palette: Palette, codeTheme: RiffetCodeThemeValues, dark: Bool) -> AttributedString {
            let key = CacheKey(uiTheme: palette.id, codeTheme: codeTheme.id, dark: dark)
            lock.lock()
            if let hit = cache[key] { lock.unlock(); return hit }
            lock.unlock()
            let built = Self.styled(runs, palette: palette, codeTheme: codeTheme, dark: dark)
            lock.lock()
            cache[key] = built
            lock.unlock()
            return built
        }
        private static func styled(_ runs: [Run], palette: Palette, codeTheme: RiffetCodeThemeValues, dark: Bool) -> AttributedString {
            let commentItalic = (dark ? codeTheme.dark : codeTheme.light).commentItalic
            var output = AttributedString()
            for run in runs {
                var part = AttributedString(run.text)
                switch run.token {
                case "comment":
                    part.foregroundColor = palette.codeColor(\.comment, codeTheme: codeTheme)
                    if commentItalic { part.inlinePresentationIntent = .emphasized }
                case "punctuation": part.foregroundColor = palette.fg3
                case "keyword": part.foregroundColor = palette.codeColor(\.keyword, codeTheme: codeTheme)
                case "string": part.foregroundColor = palette.codeColor(\.string, codeTheme: codeTheme)
                case "number": part.foregroundColor = palette.codeColor(\.number, codeTheme: codeTheme)
                case "constant": part.foregroundColor = palette.codeColor(\.constant, codeTheme: codeTheme)
                case "declaration": part.foregroundColor = palette.codeColor(\.declaration, codeTheme: codeTheme)
                case "type": part.foregroundColor = palette.codeColor(\.type, codeTheme: codeTheme)
                case "property": part.foregroundColor = palette.codeColor(\.property, codeTheme: codeTheme)
                case "namespace": part.foregroundColor = palette.codeColor(\.namespace, codeTheme: codeTheme)
                case "tag": part.foregroundColor = palette.codeColor(\.tag, codeTheme: codeTheme)
                case "attribute": part.foregroundColor = palette.codeColor(\.attribute, codeTheme: codeTheme)
                case "annotation": part.foregroundColor = palette.codeColor(\.annotation, codeTheme: codeTheme)
                case "escape": part.foregroundColor = palette.codeColor(\.escape, codeTheme: codeTheme)
                case "heading": part.foregroundColor = palette.codeColor(\.heading, codeTheme: codeTheme)
                default: break
                }
                output += part
            }
            return output
        }
    }
    private let cache: NSCache<NSString, Result> = CacheRegistry.cache("conversation.highlights", bytes: CacheRegistry.Budget.highlights)
    private var function: JSValue?
    private var loaded = false

    func highlight(_ text: String, language: String) -> Result? {
        guard text.utf16.count <= 160_000, let language = Self.language(language) else { return nil }
        let key = "\(language)\0\(text)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        if !loaded {
            loaded = true
            if let url = Bundle.main.url(forResource: "highlight", withExtension: "js"),
               let source = try? String(contentsOf: url, encoding: .utf8), let context = JSContext() {
                context.evaluateScript(source)
                function = context.objectForKeyedSubscript("riffetHighlight")
            }
        }
        guard let result = function?.call(withArguments: [text, language]), result.isString,
              let json = result.toString()?.data(using: .utf8), let pairs = try? JSONSerialization.jsonObject(with: json) as? [[Any]] else { return nil }
        let runs = pairs.compactMap { pair -> Run? in
            guard let text = pair.first as? String else { return nil }
            let classes = pair.count > 1 ? (pair[1] as? [String] ?? []) : []
            return Run(text: text, token: classes.reversed().compactMap(Self.token).first)
        }
        // A broken grammar must never substitute, drop or reorder literal source characters.
        guard runs.map(\.text).joined() == text else { return nil }
        let value = Result(text: text, language: language, runs: runs)
        cache.setObject(value, forKey: key, cost: text.utf16.count * 12 + runs.count * 128)
        return value
    }
    static func language(_ info: String) -> String? {
        let word = info.lowercased().split(whereSeparator: { $0.isWhitespace || $0 == ":" || $0 == "," }).first.map(String.init) ?? ""
        guard !word.isEmpty else { return nil }
        // Refractor accepts its registered aliases directly; only presentation aliases differ.
        return ["shell": "bash", "console": "bash", "shellscript": "bash", "zsh": "bash", "jsonc": "json", "env": "ini", "conf": "ini", "cfg": "ini", "mdx": "markdown", "golang": "go", "c#": "csharp", "c++": "cpp", "objc": "objectivec", "ps1": "powershell"][word] ?? word
    }
    static func language(forPath path: String) -> String? {
        let name = (path as NSString).lastPathComponent
        let ext = (name as NSString).pathExtension.lowercased()
        guard !ext.isEmpty else { return nil }
        return [
            "ts": "typescript", "mts": "typescript", "cts": "typescript", "tsx": "tsx",
            "js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "jsx",
            "json": "json", "yaml": "yaml", "yml": "yaml", "toml": "toml",
            "sh": "bash", "bash": "bash", "zsh": "bash",
            "css": "css", "scss": "scss", "less": "less",
            "html": "markup", "htm": "markup", "xml": "markup", "svg": "markup", "vue": "markup", "svelte": "markup",
            "sql": "sql", "md": "markdown", "markdown": "markdown", "py": "python", "go": "go", "rs": "rust",
            "java": "java", "kt": "kotlin", "kts": "kotlin", "swift": "swift",
            "c": "c", "h": "c", "cc": "cpp", "cpp": "cpp", "cxx": "cpp", "hpp": "cpp", "hh": "cpp", "hxx": "cpp",
            "rb": "ruby", "php": "php", "cs": "csharp",
        ][ext]
    }
    private static func token(_ name: String) -> String? {
        switch name {
        case "comment", "prolog", "doctype", "cdata": return "comment"
        case "punctuation": return "punctuation"
        case "tag", "selector", "deleted": return "tag"
        case "attr-name": return "attribute"
        case "property": return "property"
        case "annotation", "decorator": return "annotation"
        case "boolean", "constant": return "constant"
        case "number": return "number"
        case "keyword", "atrule", "important", "builtin": return "keyword"
        case "string", "char", "attr-value", "regex", "inserted": return "string"
        case "escape": return "escape"
        case "function": return "declaration"
        case "title": return "heading"
        case "class-name", "symbol": return "type"
        case "namespace": return "namespace"
        case "operator", "entity", "url", "variable": return nil
        default: return nil
        }
    }
}

enum ConversationImageDecoder {
    /// Decode downsampled thumbnails off the main actor, rather than allocating e.g. a 48MP bitmap
    /// for a 360pt transcript image. The preview keeps sufficient resolution for a phone display.
    static func decode(_ data: Data, maximumPixelSize: Int = 2_048) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

struct ConversationImageKey: Hashable { let source: String; let attachmentID: String?; let retry: Int }

/// Prose is a read-only text view so a long press selects a range, as in any system reader.
/// Formulas become TextKit attachments that sit on the text baseline without a web view per row.
struct ConversationInlineText: View {
    let source: AttributedString
    let origin: URL
    var textStyle: UIFont.TextStyle = .body
    var bold = false
    var secondary = false
    var spacing: CGFloat = 5
    var alignment: NSTextAlignment = .left
    /// Occurrences of the needle in the markdown blocks before this one; nil marks every match.
    var findOffset: Int? = nil
    @Environment(\.colorScheme) private var scheme
    @Environment(\.palette) private var palette
    @Environment(\.openURL) private var openURL
    @Environment(\.conversationQuote) private var quote
    @Environment(\.conversationFindHighlight) private var findHighlight
    @ScaledMetric(relativeTo: .body) private var bodySize = 16.0
    @State private var images: [String: ConversationInlineMathRenderer.Rendered] = [:]
    @State private var renderedKey: String?
    private var fontSize: Double {
        let base: Double = textStyle == .title2 ? 21 : textStyle == .title3 ? 19 : textStyle == .headline ? 17 : 16
        return bodySize * base / 16
    }
    private var formulas: [String] { Array(Set(source.runs.compactMap { $0.link.flatMap(MathText.tex) })).sorted() }
    private var key: String { "\(origin.absoluteString)|\(fontSize)|\(scheme == .dark)|\(formulas.joined(separator: "\u{0}"))" }
    /// Formulas rendered earlier are laid out from the first frame, so the paragraph does not reflow.
    private var cachedImages: [String: ConversationInlineMathRenderer.Rendered] {
        var ready: [String: ConversationInlineMathRenderer.Rendered] = [:]
        for tex in formulas {
            let request = ConversationInlineMathRequest(origin: origin, tex: tex, fontSize: fontSize, dark: scheme == .dark)
            if let rendered = ConversationInlineMathRenderer.shared.cached(request) { ready[tex] = rendered }
        }
        return ready
    }
    var body: some View {
        let colors = ConversationParagraph.Colors(text: palette.uiColor(secondary ? \.fg3 : \.fg), link: palette.uiColor(\.accent), linkLine: palette.uiColor(\.lineStrong), code: UIColor(palette.press))
        ConversationParagraph(source: source.highlighting(findHighlight, only: findHighlight.flatMap { h in findOffset.map { h.nth - $0 } }, color: palette.warning.opacity(0.4)), images: renderedKey == key ? images : cachedImages, fontSize: fontSize, bold: bold, colors: colors, spacing: spacing, alignment: alignment, open: { openURL($0) }, quote: quote)
            .task(id: key) {
                    guard !formulas.isEmpty else { return }
                    var ready: [String: ConversationInlineMathRenderer.Rendered] = [:]
                    for tex in formulas {
                        guard !Task.isCancelled else { return }
                        let request = ConversationInlineMathRequest(origin: origin, tex: tex, fontSize: fontSize, dark: scheme == .dark)
                        if let rendered = await ConversationInlineMathRenderer.shared.image(request) { ready[tex] = rendered }
                        guard !Task.isCancelled else { return }
                    }
                    images = ready; renderedKey = key
            }
    }
}

struct ConversationParagraph: UIViewRepresentable {
    struct Colors: Equatable { let text: UIColor; let link: UIColor; let linkLine: UIColor; let code: UIColor }
    let source: AttributedString
    let images: [String: ConversationInlineMathRenderer.Rendered]
    let fontSize: Double
    let bold: Bool
    let colors: Colors
    let spacing: CGFloat
    var alignment: NSTextAlignment = .left
    let open: (URL) -> Void
    let quote: ((String) -> Void)?
    func makeCoordinator() -> Coordinator { Coordinator(open: open) }
    func makeUIView(context: Context) -> UITextView {
        let view = ConversationParagraphTextView.make()
        view.backgroundColor = .clear; view.isEditable = false; view.isSelectable = true; view.isScrollEnabled = false
        view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 0
        view.delegate = context.coordinator
        view.widthChanged = { [weak coordinator = context.coordinator, weak view] width in
            guard let view else { return }; coordinator?.publish(to: view, width: width); coordinator?.reportMark(view)
        }
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.open = open
        context.coordinator.quote = quote
        if view.tintColor != colors.link || view.linkTextAttributes[.underlineColor] as? UIColor != colors.linkLine { view.tintColor = colors.link; view.linkTextAttributes = [.foregroundColor: colors.link, .underlineStyle: NSUnderlineStyle.single.rawValue, .underlineColor: colors.linkLine] }
        context.coordinator.configure(self)
        context.coordinator.publish(to: view, width: view.bounds.width > 0 ? view.bounds.width : 320)
        context.coordinator.probe = context.environment.conversationFindProbe
        context.coordinator.reportMark(view)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        context.coordinator.configure(self)
        // SwiftUI probes several widths while laying out a lazy row. Never write attributedText,
        // textContainer or bounds on the live UIView during a probe: each write invalidates the
        // very layout being measured, and fresh attachment identities keep that loop alive.
        return CGSize(width: width, height: context.coordinator.layout(width: width).height)
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        private struct ImageKey: Equatable { let identity: ObjectIdentifier; let descent: CGFloat }
        private struct ContentKey: Equatable {
            let source: AttributedString
            let images: [String: ImageKey]
            let fontSize: Double
            let bold: Bool
            let colors: Colors
            let spacing: CGFloat
            let alignment: NSTextAlignment
        }
        struct Layout { let text: NSAttributedString; let height: CGFloat }
        private var key: ContentKey?
        private var factory: ((CGFloat) -> NSAttributedString)?
        private var layouts: [Int: Layout] = [:]
        private var generation = 0
        private var presentedGeneration = -1
        private var presentedWidth: Int?
        var open: (URL) -> Void
        var quote: ((String) -> Void)?
        /// The transcript's, where this paragraph reports drawing find's mark; nil outside a transcript.
        weak var probe: ConversationTranscriptProbe?
        init(open: @escaping (URL) -> Void) { self.open = open }
        func reportMark(_ view: UITextView) { probe?.report(view, marked: view.attributedText.findMarkRange != nil) }
        func configure(_ value: ConversationParagraph) {
            let next = ContentKey(source: value.source, images: value.images.mapValues { ImageKey(identity: ObjectIdentifier($0.image), descent: $0.descent) }, fontSize: value.fontSize, bold: value.bold, colors: value.colors, spacing: value.spacing, alignment: value.alignment)
            guard key != next else { return }
            key = next; generation += 1; layouts.removeAll(keepingCapacity: true)
            factory = { width in ConversationFormulaText.attributed(value.source, images: value.images, fontSize: value.fontSize, bold: value.bold, color: value.colors.text, codeFill: value.colors.code, spacing: value.spacing, alignment: value.alignment, maximumWidth: width) }
        }
        private func widthKey(_ width: CGFloat) -> Int { max(1, min(10_000, Int(width.rounded(.down)))) }
        func layout(width: CGFloat) -> Layout {
            let width = widthKey(width)
            if let cached = layouts[width] { return cached }
            let text = factory?(CGFloat(width)) ?? NSAttributedString(string: "")
            let storage = NSTextStorage(attributedString: text)
            let manager = NSLayoutManager()
            let container = NSTextContainer(size: CGSize(width: CGFloat(width), height: .greatestFiniteMagnitude))
            container.lineFragmentPadding = 0
            storage.addLayoutManager(manager); manager.addTextContainer(container)
            manager.ensureLayout(for: container)
            let measured = Layout(text: text, height: max(1, ceil(manager.usedRect(for: container).maxY)))
            if layouts.count >= 8 { layouts.removeAll(keepingCapacity: true) }
            layouts[width] = measured
            return measured
        }
        func publish(to view: UITextView, width: CGFloat) {
            guard width.isFinite, width > 0 else { return }
            let width = widthKey(width)
            guard presentedGeneration != generation || presentedWidth != width else { return }
            let value = layout(width: CGFloat(width))
            presentedGeneration = generation; presentedWidth = width
            let selected = view.selectedRange
            view.attributedText = value.text
            if selected.location != NSNotFound, NSMaxRange(selected) <= value.text.length { view.selectedRange = selected }
        }
        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            let url: URL?
            if case let .link(link) = textItem.content { url = link }
            else if textItem.range.location < textView.attributedText.length {
                url = textView.attributedText.attribute(.link, at: textItem.range.location, effectiveRange: nil) as? URL
            } else { url = nil }
            guard let url else { return defaultAction }
            return UIAction { [weak self] _ in self?.open(url) }
        }
        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard let quote, range.length > 0 else { return nil }
            let text = ConversationFormulaText.copyText(textView.attributedText, range: range)
            let action = UIAction(title: String(localized: "引用", bundle: .riffet), image: UIImage(systemName: "text.quote")) { _ in quote(text) }
            // Beside 拷贝, rather than behind the overflow arrow.
            var items = suggestedActions; items.insert(action, at: min(1, items.count))
            return UIMenu(children: items)
        }
    }
}

final class ConversationParagraphTextView: UITextView {
    /// TextKit 1, the same engine `Coordinator.layout` measures with, so the drawn height is the fitted one.
    static func make() -> ConversationParagraphTextView {
        let storage = NSTextStorage()
        let manager = InlineCodeLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        storage.addLayoutManager(manager); manager.addTextContainer(container)
        let view = ConversationParagraphTextView(frame: .zero, textContainer: container)
        view.storage = storage
        return view
    }
    /// The text view does not own a storage it was handed; this keeps it alive.
    private var storage: NSTextStorage?
    var widthChanged: ((CGFloat) -> Void)?
    private var previousWidth = -1
    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width.isFinite, bounds.width > 0 else { return }
        let width = Int(bounds.width.rounded(.down))
        guard width != previousWidth else { return }
        previousWidth = width
        widthChanged?(CGFloat(width))
    }
    override func copy(_ sender: Any?) {
        guard selectedRange.location != NSNotFound, selectedRange.length > 0 else { super.copy(sender); return }
        UIPasteboard.general.string = ConversationFormulaText.copyText(attributedText, range: selectedRange)
    }
}

/// Inline code keeps its fill to its own glyphs, rounded. TextKit 1's own fill runs to the
/// container edge when a code span wraps, and paints the line spacing below it.
private final class InlineCodeLayoutManager: NSLayoutManager {
    override func fillBackgroundRectArray(_ rectArray: UnsafePointer<CGRect>, count rectCount: Int, forCharacterRange charRange: NSRange, color: UIColor) {
        guard let container = textContainers.first, let storage = textStorage, charRange.location < storage.length,
              let font = storage.attribute(.font, at: charRange.location, effectiveRange: nil) as? UIFont else {
            super.fillBackgroundRectArray(rectArray, count: rectCount, forCharacterRange: charRange, color: color); return
        }
        let glyphs = glyphRange(forCharacterRange: charRange, actualCharacterRange: nil)
        color.setFill()
        enumerateLineFragments(forGlyphRange: glyphs) { line, used, _, lineGlyphs, _ in
            let part = NSIntersectionRange(glyphs, lineGlyphs)
            guard part.length > 0 else { return }
            let bounds = self.boundingRect(forGlyphRange: part, in: container)
            let baseline = line.minY + self.location(forGlyphAt: part.location).y
            let right = min(bounds.maxX, used.maxX)
            guard right > bounds.minX else { return }
            let rect = CGRect(x: bounds.minX - 2, y: baseline - font.ascender - 2, width: right - bounds.minX + 4, height: font.ascender - font.descender + 4)
            UIBezierPath(roundedRect: rect, cornerRadius: 4).fill()
        }
    }
}

enum ConversationFormulaText {
    static func copyText(_ source: NSAttributedString, range: NSRange) -> String {
        guard range.location != NSNotFound, NSMaxRange(range) <= source.length else { return "" }
        var text = ""
        source.enumerateAttributes(in: range) { attributes, span, _ in
            if attributes[.attachment] != nil, let url = attributes[.link] as? URL, let tex = MathText.tex(url) { text += "$" + tex + "$" }
            else { text += (source.string as NSString).substring(with: span) }
        }
        return text
    }
    static func attributed(_ source: AttributedString, images: [String: ConversationInlineMathRenderer.Rendered], fontSize: Double, bold: Bool = false, color: UIColor = .label, codeFill: UIColor = .tertiarySystemFill, spacing: CGFloat = 5, alignment: NSTextAlignment = .left, maximumWidth: CGFloat = 320) -> NSAttributedString {
        let result = NSMutableAttributedString(string: "")
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = spacing; paragraph.alignment = alignment
        for run in source.runs {
            // Strong text is Medium, not Bold; headings are Semibold.
            let strong = run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
            let inlineTag = run[MarkdownInlineTagKey.self]
            let isScript = inlineTag == .sup || inlineTag == .sub
            let size = isScript ? max(10.0, fontSize * 0.75) : fontSize
            var font = UIFont.systemFont(ofSize: size, weight: bold ? .semibold : strong ? .medium : .regular)
            var traits: UIFontDescriptor.SymbolicTraits = []
            if run.inlinePresentationIntent?.contains(.emphasized) == true { traits.insert(.traitItalic) }
            if !isScript && run.inlinePresentationIntent?.contains(.code) == true { font = UIFont.monospacedSystemFont(ofSize: fontSize * 0.875, weight: .regular) }
            if let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(traits)) { font = UIFont(descriptor: descriptor, size: font.pointSize) }
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
            if isScript { attributes[.baselineOffset] = inlineTag == .sup ? fontSize * 0.35 : -fontSize * 0.18 }
            if let link = run.link { attributes[.link] = link }
            if run.strikethroughStyle != nil { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if !isScript && run.inlinePresentationIntent?.contains(.code) == true { attributes[.backgroundColor] = codeFill }
            // Only find sets a run's background: the run is also tagged, so the list can find where it is drawn.
            if let mark = run.backgroundColor { attributes[.backgroundColor] = UIColor(mark); attributes[.conversationFindMark] = true }
            if let tex = run.link.flatMap(MathText.tex), let rendered = images[tex] {
                let attachment = NSTextAttachment(); attachment.image = rendered.image
                let ratio = min(1, max(1, maximumWidth) / max(1, rendered.image.size.width))
                attachment.bounds = CGRect(x: 0, y: -rendered.descent * ratio, width: rendered.image.size.width * ratio, height: rendered.image.size.height * ratio)
                let formula = NSMutableAttributedString(attachment: attachment)
                formula.addAttributes(attributes, range: NSRange(location: 0, length: formula.length))
                result.append(formula)
            } else { result.append(NSAttributedString(string: String(source[run.range].characters), attributes: attributes)) }
        }
        return result
    }
}
