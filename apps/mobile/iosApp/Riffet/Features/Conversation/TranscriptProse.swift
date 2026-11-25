import SwiftUI
import UIKit
import RiffetKit

// Transcript prose laid out off the main thread (docs/guide/ios-performance.md §2.16).
//
// A reply used to be one self-sizing SwiftUI cell: each time it scrolled in, SwiftUI built its whole
// view tree, a `UITextView` per paragraph laid its text out, and the row was measured, all in one frame
// (30–45 ms for a 1000–1500 pt reply). Here the layout queue parses the Markdown, builds the attributed
// text and lays it out with TextKit 1 (`TextLayout`, shared with the Mac), and the list knows a row's
// height before the row is on screen. The cell only places what was laid out (`TranscriptProseView`).
// Code blocks are laid out there too and drawn natively (`TranscriptCodeBlockView`). Blocks that are not
// prose — tables, formulas, images, code with a preview — keep their SwiftUI views, each hosted on its own
// and only near the screen, at the height it last had.

/// What a prose row draws with, captured on the main thread for the layout queue.
struct TranscriptProseStyle: @unchecked Sendable {
    /// Dynamic Type's body size (16 at the default size).
    let bodySize: Double
    let text: UIColor
    let muted: UIColor
    let link: UIColor
    let linkLine: UIColor
    let code: UIColor
    let codeMuted: UIColor
    let marker: UIColor
    let line: UIColor
    let find: Color
    let markerFont: UIFont
    let origin: URL
    let dark: Bool
    let scale: CGFloat
    /// The list's height, which caps a code block's viewport (`ConversationCodeViewport`); estimates only,
    /// so it is not part of `key`: the composer growing a line must not lay every row out again.
    let viewportHeight: CGFloat
    /// A code line in a code block (`ConversationCode.codeLineHeight`), scaled with Dynamic Type.
    let codeLineHeight: CGFloat
    /// The page width a diagram's picture is drawn at (`ConversationCodePreview.request`).
    let diagramWidth: Int
    /// Code as `ConversationCode` sets it: monospaced, the reply's text colour, the code theme's tokens.
    let codeFont: UIFont
    let codeItalicFont: UIFont
    let codeText: UIColor
    let codeTokens: [String: UIColor]
    let commentItalic: Bool
    /// Identifies everything above, for the caches.
    let key: String

    @MainActor
    init(palette: Palette, codeTheme: RiffetCodeThemeValues, traits: UITraitCollection, origin: URL, viewportHeight: CGFloat) {
        bodySize = UIFontMetrics(forTextStyle: .body).scaledValue(for: 16, compatibleWith: traits)
        text = palette.uiColor(\.fg); muted = palette.uiColor(\.fg3)
        link = palette.uiColor(\.accent); linkLine = palette.uiColor(\.lineStrong)
        code = palette.uiColor(\.fg2); codeMuted = palette.uiColor(\.fg3)
        marker = palette.uiColor(\.fg3); line = palette.uiColor(\.line)
        find = palette.warning.opacity(0.4)
        markerFont = UIFont.monospacedDigitSystemFont(ofSize: bodySize, weight: .regular)
        self.origin = origin
        dark = traits.userInterfaceStyle == .dark
        scale = max(1, traits.displayScale)
        self.viewportHeight = viewportHeight
        codeLineHeight = UIFontMetrics(forTextStyle: .body).scaledValue(for: 20, compatibleWith: traits)
        diagramWidth = ConversationCodePreview.pictureWidth
        codeFont = RiffetText.mono.uiFont(compatibleWith: traits)
        codeItalicFont = codeFont.fontDescriptor.withSymbolicTraits(.traitItalic).map { UIFont(descriptor: $0, size: 0) } ?? codeFont
        codeText = palette.uiColor(\.fg)
        commentItalic = (dark ? codeTheme.dark : codeTheme.light).commentItalic
        // The roles of `ConversationSyntax.Result.attributed`.
        let roles: [(String, KeyPath<RiffetCodePaletteValues, RiffetRGBA> & Sendable)] = [
            ("comment", \.comment), ("keyword", \.keyword), ("string", \.string), ("number", \.number), ("constant", \.constant),
            ("declaration", \.declaration), ("type", \.type), ("property", \.property), ("namespace", \.namespace), ("tag", \.tag),
            ("attribute", \.attribute), ("annotation", \.annotation), ("escape", \.escape), ("heading", \.heading),
        ]
        var tokens: [String: UIColor] = ["punctuation": palette.uiColor(\.fg3)]
        for (token, role) in roles { tokens[token] = UIColor(palette.codeColor(role, codeTheme: codeTheme)) }
        codeTokens = tokens
        key = "\(palette.id)|\(codeTheme.id)|\(dark)|\(bodySize)|\(scale)|\(origin.absoluteString)"
    }
}

/// The reply menu and the time and speed of a finished turn, under the prose.
struct TranscriptProseFooter: Hashable, Sendable {
    let text: String
    var time: String? = nil
}

/// A row of prose, as the page hands it to the list: the reply's Markdown, the line under it, or both.
struct TranscriptProseContent {
    /// The reply's Markdown; empty for a footer-only row.
    let source: String
    /// Where the row's code blocks keep their reader state (`ConversationDisclosureState`), as `ConversationMarkdown`'s `stateID`.
    let stateID: String
    /// Still streaming: parsed without filling the shared Markdown cache with versions about to change.
    let live: Bool
    let footer: TranscriptProseFooter?
    /// Under an open tool run's hairline (`ConversationEntryView.nestedRow`).
    let nested: Bool
    let top: CGFloat
    let highlight: ConversationFindHighlight?
}

/// A block of a reply that keeps its SwiftUI view, hosted on its own (`TranscriptProseView`).
struct TranscriptProseBlock: @unchecked Sendable {
    enum Kind {
        case code(language: String?, text: String, stateID: String)
        case math(String)
        case image(alt: String, src: String)
        case visualization(path: String, title: String?)
        case table(header: [AttributedString], rows: [[AttributedString]], alignments: [MarkdownTableAlignment])
    }
    /// Stable within the transcript: the row and the block's place in it.
    let key: String
    let kind: Kind
    /// Identifies the content: a block that grew while streaming gets its view's content again.
    let signature: Int
    init(key: String, kind: Kind) {
        self.key = key; self.kind = kind
        var hasher = Hasher()
        switch kind {
        case let .code(language, text, stateID): hasher.combine(0); hasher.combine(language); hasher.combine(text); hasher.combine(stateID)
        case let .math(tex): hasher.combine(1); hasher.combine(tex)
        case let .image(alt, src): hasher.combine(2); hasher.combine(alt); hasher.combine(src)
        case let .visualization(path, title): hasher.combine(3); hasher.combine(path); hasher.combine(title)
        case let .table(header, rows, alignments):
            hasher.combine(4); hasher.combine(header); hasher.combine(rows)
            for alignment in alignments { hasher.combine(String(describing: alignment)) }
        }
        signature = hasher.finalize()
    }
}

/// A code block without a preview, laid out once with lines that never wrap (`ConversationCode`).
final class TranscriptProseCode: @unchecked Sendable {
    enum Disclosure: Equatable { case none, expand(lines: Int), collapse }
    /// The block's place in the transcript; its view keeps its scroll position while the key holds.
    let key: String
    /// Where the block's expansion is kept (`TranscriptProseCodeState`).
    let stateID: String
    /// The language, or the cited file and lines.
    let title: String
    let cited: Bool
    /// The whole source, for the copy button.
    let source: String
    /// The visible lines, highlighted when the highlighter had them.
    let layout: TextLayout
    let selectable: NSAttributedString
    /// The text's size, read once here like `TranscriptProseText.height`.
    let textSize: CGSize
    let viewport: CGFloat
    let disclosure: Disclosure
    init(key: String, stateID: String, title: String, cited: Bool, source: String, text: NSAttributedString, viewport: (CGFloat) -> CGFloat, disclosure: Disclosure) {
        self.key = key; self.stateID = stateID; self.title = title; self.cited = cited; self.source = source
        selectable = text; self.disclosure = disclosure
        layout = TextLayout(text, width: 0, wraps: false)
        textSize = CGSize(width: max(1, layout.size.width), height: max(1, layout.size.height))
        self.viewport = viewport(textSize.height + TranscriptProse.codePadding * 2)
    }
    func height(scale: CGFloat) -> CGFloat {
        TranscriptProse.codeHeader + viewport + (disclosure == .none ? 0 : TranscriptProse.codeDisclosure + 1 / scale)
    }
}

/// Code blocks the reader expanded, by `TranscriptProseCode.stateID`. Read on the layout queue.
final class TranscriptProseCodeState: @unchecked Sendable {
    static let shared = TranscriptProseCodeState()
    private let lock = NSLock()
    private var expanded: Set<String> = []
    func isExpanded(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return expanded.contains(id) }
    func set(_ id: String, expanded value: Bool) {
        lock.lock(); defer { lock.unlock() }
        if value { expanded.insert(id) } else { expanded.remove(id) }
    }
}

/// Code a row drew plain because the highlighter had not run on it yet; the row is laid out again once it has.
struct TranscriptProseHighlightRequest: Hashable, Sendable {
    let text: String
    let language: String
}

/// A block of prose laid out once, and its text as selection and copying want it.
final class TranscriptProseText: @unchecked Sendable {
    let layout: TextLayout
    /// The text with its links, for the text view a long press swaps in to select.
    let selectable: NSAttributedString
    let heading: Bool
    /// Read once here: after this the layout belongs to the main thread, which draws it.
    let height: CGFloat
    let findMark: NSRange?
    let hasLinks: Bool
    init(layout: TextLayout, selectable: NSAttributedString, heading: Bool) {
        self.layout = layout; self.selectable = selectable; self.heading = heading
        height = max(1, ceil(layout.manager.usedRect(for: layout.container).maxY))
        findMark = layout.storage.findMarkRange
        var links = false
        layout.storage.enumerateAttribute(.transcriptLink, in: NSRange(location: 0, length: layout.storage.length)) { value, _, stop in
            if value != nil { links = true; stop.pointee = true }
        }
        hasLinks = links
    }
}

extension NSAttributedString.Key {
    /// A link in drawn prose. Kept off `.link`, which TextKit outside a text view paints in its own colour.
    static let transcriptLink = NSAttributedString.Key("riffet.transcriptLink")
}

/// One row of prose at one width: what goes where. Built on the layout queue, read on the main thread.
final class TranscriptProseLayout: @unchecked Sendable {
    struct Piece {
        enum Kind {
            case text(TranscriptProseText)
            /// A list item's number or bullet.
            case marker(TextLayout)
            case checkbox(Bool)
            /// A quote's bar, a rule, a tool run's hairline.
            case bar(radius: CGFloat)
            case rule
            case block(TranscriptProseBlock)
            case code(TranscriptProseCode)
            case footer(TranscriptProseFooter)
        }
        var frame: CGRect
        let kind: Kind
    }
    let width: CGFloat
    let styleKey: String
    private(set) var pieces: [Piece]
    private(set) var height: CGFloat
    /// Inline formulas drawn as TeX until rendered; the row is laid out again once they are.
    let pendingFormulas: [ConversationInlineMathRequest]
    let pendingHighlights: [TranscriptProseHighlightRequest]
    /// The reply's text, for VoiceOver's copy action.
    let copyText: String

    init(width: CGFloat, styleKey: String, pieces: [Piece], height: CGFloat, pendingFormulas: [ConversationInlineMathRequest],
         pendingHighlights: [TranscriptProseHighlightRequest], copyText: String) {
        self.width = width; self.styleKey = styleKey; self.pieces = pieces; self.height = height
        self.pendingFormulas = pendingFormulas; self.pendingHighlights = pendingHighlights; self.copyText = copyText
    }

    /// The same row with a hosted block at a new height: what is below moves, what encloses it (a quote's
    /// bar, the tool run's hairline) grows. Text is not laid out again.
    func resizing(block key: String, to height: CGFloat) -> TranscriptProseLayout? {
        guard let index = pieces.firstIndex(where: { if case let .block(block) = $0.kind { block.key == key } else { false } }) else { return nil }
        let old = pieces[index].frame
        let delta = height - old.height
        guard abs(delta) > 0.5 else { return nil }
        var moved = pieces
        for i in moved.indices {
            let frame = moved[i].frame
            if i == index { moved[i].frame.size.height = height }
            else if frame.minY >= old.maxY - 0.5 { moved[i].frame.origin.y += delta }
            else if frame.minY <= old.minY + 0.5 && frame.maxY >= old.maxY - 0.5 { moved[i].frame.size.height += delta }
        }
        return TranscriptProseLayout(width: width, styleKey: styleKey, pieces: moved, height: self.height + delta, pendingFormulas: pendingFormulas,
                                     pendingHighlights: pendingHighlights, copyText: copyText)
    }
}

/// Heights hosted blocks settled to, by block and width, so a row laid out again or scrolled back to
/// reserves them from the start. Read on the layout queue.
final class TranscriptProseHeights: @unchecked Sendable {
    static let shared = TranscriptProseHeights()
    private final class Box { let value: CGFloat; init(_ value: CGFloat) { self.value = value } }
    private let heights: NSCache<NSString, Box> = CacheRegistry.cache("transcript.prose.heights", count: 4_096)
    func height(_ key: String, width: CGFloat) -> CGFloat? { heights.object(forKey: "\(key)|\(Int(width))" as NSString)?.value }
    func set(_ height: CGFloat, for key: String, width: CGFloat) { heights.setObject(Box(height), forKey: "\(key)|\(Int(width))" as NSString) }
}

enum TranscriptProse {
    /// Laid-out text blocks by content, style and width: a streamed reply lays out only the block that grew.
    private static let texts: NSCache<NSString, TranscriptProseText> = CacheRegistry.cache("transcript.prose.texts", bytes: CacheRegistry.Budget.proseLayouts / 4)
    /// Laid-out code blocks, the same way.
    private static let codes: NSCache<NSString, TranscriptProseCode> = CacheRegistry.cache("transcript.prose.codes", bytes: CacheRegistry.Budget.proseLayouts / 4)

    // The measures of `ConversationMarkdown` and `ConversationTimelineItem`, which this reproduces.
    /// Around the row (`transcriptRows`' padding).
    static let rowInset: CGFloat = 18
    /// Between blocks: a paragraph break reads as one and a half 26 pt lines (the web's `.md`).
    static let blockGap: CGFloat = 14
    /// Between list items; a second block in an item; a nested list.
    static let itemGap: CGFloat = 6
    static let itemBlockGap: CGFloat = 10
    static let nestedListGap: CGFloat = 4
    static let markerMinWidth: CGFloat = 14
    static let markerGap: CGFloat = 8
    static let quoteBar: CGFloat = 3
    static let quoteGap: CGFloat = 10
    static let headingTop: CGFloat = 8
    /// Between the reply and its menu; the menu's target.
    static let footerGap: CGFloat = 8
    static let footerHeight: CGFloat = 32
    /// A tool run's hairline (`ConversationEntryView.nestedRow`): 7 in, content 24 in.
    static let nestedIndent: CGFloat = 24
    static let nestedLine: CGFloat = 7
    /// A code block's title bar, the inset of its code, and its expand line (`ConversationCode`).
    static let codeHeader: CGFloat = 36
    static let codePadding: CGFloat = 12
    static let codeDisclosure: CGFloat = 44

    /// Lays out `content` at `width` (the reading column). Pure apart from the caches it reads, so it runs
    /// on the layout queue; the main thread calls it only for a row it must show at once.
    static func layout(_ content: TranscriptProseContent, width: CGFloat, style: TranscriptProseStyle) -> TranscriptProseLayout {
        var builder = Builder(style: style, width: width, highlight: content.highlight)
        let x = rowInset + (content.nested ? nestedIndent : 0)
        let columnWidth = max(1, width - rowInset * 2 - (content.nested ? nestedIndent : 0))
        var y = content.top
        if !content.source.isEmpty {
            let segments = MarkdownModel.segments(content.source, live: content.live)
            builder.findOffsets = findOffsets(segments, highlight: content.highlight)
            var first = true
            for (index, segment) in segments.enumerated() {
                if !first { y += blockGap }
                first = false
                y = builder.segment(segment, path: "segment.\(index)", stateID: content.stateID, x: x, y: y, width: columnWidth)
            }
        }
        if let footer = content.footer {
            if !content.source.isEmpty { y += footerGap }
            builder.pieces.append(.init(frame: CGRect(x: x, y: y, width: columnWidth, height: footerHeight), kind: .footer(footer)))
            y += footerHeight
        }
        if content.nested {
            builder.pieces.insert(.init(frame: CGRect(x: rowInset + nestedLine, y: content.top, width: 1, height: max(0, y - content.top)), kind: .bar(radius: 0)), at: 0)
        }
        return TranscriptProseLayout(width: width, styleKey: style.key, pieces: builder.pieces, height: ceil(y * style.scale) / style.scale,
                                     pendingFormulas: Array(builder.pending), pendingHighlights: Array(builder.highlights),
                                     copyText: content.source.isEmpty ? content.footer?.text ?? "" : content.source)
    }

    /// Whether `ConversationCode` offers a preview for the language (a diagram, a page, Markdown): such a
    /// block keeps its SwiftUI view, the rest are drawn here.
    static func previews(_ language: String?) -> Bool {
        guard ConversationCodeCitation(language) == nil else { return false }
        let lowered = language?.lowercased() ?? ""
        return ConversationCodePreview.isDiagram(language) || ["html", "htm", "svg", "md", "markdown", "mdx"].contains(lowered)
    }

    /// Where each prose block starts in the row's count of the needle, when the blocks together hold the
    /// selected occurrence; nil otherwise, and every match is marked (`ConversationMarkdown.findOffsets`).
    private static func findOffsets(_ segments: [MarkdownSegmentModel], highlight: ConversationFindHighlight?) -> [String: Int]? {
        guard let highlight, !highlight.needle.isEmpty else { return nil }
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
        for (index, segment) in segments.enumerated() { if case let .blocks(parts) = segment { visit(parts, "segment.\(index).blocks") } }
        return total > highlight.nth ? offsets : nil
    }

    private struct Builder {
        let style: TranscriptProseStyle
        let width: CGFloat
        let highlight: ConversationFindHighlight?
        var findOffsets: [String: Int]?
        var pieces: [TranscriptProseLayout.Piece] = []
        var pending: Set<ConversationInlineMathRequest> = []
        var highlights: Set<TranscriptProseHighlightRequest> = []

        init(style: TranscriptProseStyle, width: CGFloat, highlight: ConversationFindHighlight?) {
            self.style = style; self.width = width; self.highlight = highlight
        }

        /// Lays out a segment with its top at `y`; returns its bottom.
        mutating func segment(_ segment: MarkdownSegmentModel, path: String, stateID: String, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
            switch segment {
            case let .blocks(parts): return self.parts(parts, path: path + ".blocks", stateID: stateID, x: x, y: y, width: width, muted: false)
            case let .math(tex): return hosted(.init(key: stateID + "." + path, kind: .math(tex)), estimate: 56, x: x, y: y, width: width)
            case let .image(alt, src):
                return hosted(.init(key: stateID + "." + path, kind: .image(alt: alt, src: src)), estimate: min(ConversationImageFrame.boxHeight, width * 0.75), x: x, y: y, width: width)
            case let .visualization(path: file, title, _):
                return hosted(.init(key: stateID + "." + path, kind: .visualization(path: file, title: title)), estimate: 48, x: x, y: y, width: width)
            }
        }

        mutating func parts(_ parts: [MarkdownPart], path: String, stateID: String, x: CGFloat, y: CGFloat, width: CGFloat, muted: Bool) -> CGFloat {
            var y = y
            var first = true
            for (partIndex, part) in parts.enumerated() {
                switch part {
                case let .prose(run):
                    for (blockIndex, block) in run.blocks.enumerated() {
                        if !first { y += TranscriptProse.blockGap }
                        first = false
                        y = self.block(block, path: path + ".part.\(partIndex).prose.\(blockIndex)", stateID: stateID, x: x, y: y, width: width, muted: muted)
                    }
                case let .block(block):
                    if !first { y += TranscriptProse.blockGap }
                    first = false
                    y = self.block(block, path: path + ".part.\(partIndex).block", stateID: stateID, x: x, y: y, width: width, muted: muted)
                }
            }
            return y
        }

        mutating func block(_ block: MarkdownBlock, path: String, stateID: String, x: CGFloat, y: CGFloat, width: CGFloat, muted: Bool) -> CGFloat {
            switch block {
            case let .paragraph(text):
                return self.text(text, path: path, size: style.bodySize, bold: false, leading: ConversationProse.bodyLeading, muted: muted, heading: false, x: x, y: y, width: width)
            case let .heading(level, text):
                // Title 2, title 3 and headline over the body's 16 (`ConversationInlineText.fontSize`).
                let base: Double = level < 2 ? 21 : level == 2 ? 19 : 17
                return self.text(text, path: path, size: style.bodySize * base / 16, bold: true, leading: ConversationProse.headingLeading, muted: muted, heading: true, x: x, y: y + TranscriptProse.headingTop, width: width)
            case let .code(language, text):
                if ["math", "latex", "tex"].contains(language?.lowercased() ?? "") {
                    return hosted(.init(key: stateID + "." + path, kind: .math(text)), estimate: 56, x: x, y: y, width: width)
                }
                if !TranscriptProse.previews(language) {
                    return code(language, text, key: stateID + "." + path, x: x, y: y, width: width)
                }
                return hosted(.init(key: stateID + "." + path, kind: .code(language: language, text: text, stateID: stateID + "." + path + ".code")),
                              estimate: codeEstimate(language: language, text: text, width: width), x: x, y: y, width: width)
            case let .quote(parts):
                let inner = x + TranscriptProse.quoteBar + TranscriptProse.quoteGap
                let barIndex = pieces.count
                let bottom = self.parts(parts, path: path + ".quote", stateID: stateID, x: inner, y: y, width: max(1, width - (inner - x)), muted: true)
                pieces.insert(.init(frame: CGRect(x: x, y: y, width: TranscriptProse.quoteBar, height: max(0, bottom - y)), kind: .bar(radius: 2)), at: barIndex)
                return bottom
            case let .list(ordered, start, items):
                var y = y
                let lineBox = (style.bodySize * ConversationProse.bodyLeading).rounded()
                for (index, item) in items.enumerated() {
                    if index > 0 { y += TranscriptProse.itemGap }
                    // The marker fills the first line's box, so it centres on that line's text.
                    let markerWidth: CGFloat
                    if let check = item.checkbox {
                        markerWidth = max(TranscriptProse.markerMinWidth, ceil(style.bodySize * 1.1))
                        pieces.append(.init(frame: CGRect(x: x, y: y, width: markerWidth, height: lineBox), kind: .checkbox(check)))
                    } else {
                        let marker = TextLayout(NSAttributedString(string: ordered ? "\(start + index)." : "•", attributes: [.font: style.markerFont, .foregroundColor: style.marker]), width: 1_000, wraps: false)
                        markerWidth = max(TranscriptProse.markerMinWidth, marker.size.width)
                        let top = y + max(0, (lineBox - marker.size.height) / 2)
                        pieces.append(.init(frame: CGRect(x: x + markerWidth - marker.size.width, y: top, width: marker.size.width, height: marker.size.height), kind: .marker(marker)))
                    }
                    let inner = x + markerWidth + TranscriptProse.markerGap
                    var bottom = y
                    for (blockIndex, block) in item.blocks.enumerated() {
                        let top = blockIndex == 0 ? y : bottom + (block.isList ? TranscriptProse.nestedListGap : TranscriptProse.itemBlockGap)
                        bottom = self.block(block, path: path + ".list.\(index).block.\(blockIndex)", stateID: stateID, x: inner, y: top, width: max(1, width - (inner - x)), muted: muted)
                    }
                    y = max(bottom, y + lineBox)
                }
                return y
            case let .table(header, rows, alignments):
                let estimate = CGFloat(rows.count + 1) * (style.bodySize * ConversationProse.tableLeading + 16) + 2
                return hosted(.init(key: stateID + "." + path, kind: .table(header: header, rows: rows, alignments: alignments)), estimate: estimate, x: x, y: y, width: width)
            case .rule:
                pieces.append(.init(frame: CGRect(x: x, y: y, width: width, height: 1 / style.scale), kind: .rule))
                return y + 1 / style.scale
            }
        }

        /// A paragraph or heading, laid out as `ConversationInlineText` draws it.
        mutating func text(_ source: AttributedString, path: String, size: Double, bold: Bool, leading: Double, muted: Bool, heading: Bool, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
            let only = highlight.flatMap { h in findOffsets?[path].map { h.nth - $0 } }
            let marked = source.highlighting(highlight, only: only, color: style.find)
            let formulas = Array(Set(marked.runs.compactMap { $0.link.flatMap(MathText.tex) })).sorted()
            var images: [String: ConversationInlineMathRenderer.Rendered] = [:]
            for tex in formulas {
                let request = ConversationInlineMathRequest(origin: style.origin, tex: tex, fontSize: size, dark: style.dark)
                if let rendered = ConversationInlineMathRenderer.shared.cachedOffMain(request) { images[tex] = rendered } else { pending.insert(request) }
            }
            // The text itself is part of the key: two blocks must never share a layout by a hash collision.
            let key = "\(style.key)|\(Int(width))|\(size)|\(bold)|\(leading)|\(muted)|\(images.keys.sorted().joined(separator: "\u{0}"))|\(marked.hashValue)|" + String(marked.characters)
            let piece: TranscriptProseText
            if let cached = TranscriptProse.texts.object(forKey: key as NSString) {
                piece = cached
            } else {
                let colors = ConversationParagraph.Colors(text: muted ? style.muted : style.text, link: style.link, linkLine: style.linkLine, code: muted ? style.codeMuted : style.code)
                let attributed = ConversationFormulaText.attributed(marked, images: images, fontSize: size, bold: bold, colors: colors, lineHeight: (size * leading).rounded(), maximumWidth: width)
                piece = TranscriptProseText(layout: TextLayout(Self.drawable(attributed), width: width), selectable: attributed, heading: heading)
                TranscriptProse.texts.setObject(piece, forKey: key as NSString, cost: max(1, attributed.length * 64))
            }
            pieces.append(.init(frame: CGRect(x: x, y: y, width: width, height: piece.height), kind: .text(piece)))
            return y + piece.height
        }

        /// Links move to `.transcriptLink`: TextKit outside a text view paints `.link` runs in its own colour.
        static func drawable(_ text: NSAttributedString) -> NSAttributedString {
            let result = NSMutableAttributedString(attributedString: text)
            text.enumerateAttribute(.link, in: NSRange(location: 0, length: text.length)) { value, range, _ in
                guard let value else { return }
                result.removeAttribute(.link, range: range)
                result.addAttribute(.transcriptLink, value: value, range: range)
            }
            return result
        }

        /// A code block as `ConversationCode` shows it, drawn by `TranscriptCodeBlockView`.
        mutating func code(_ language: String?, _ text: String, key: String, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
            let stateID = key + ".code"
            let cited = ConversationCodeCitation(language)
            let syntax = cited.map { ConversationSyntax.language(forPath: $0.path) } ?? language.flatMap { ConversationSyntax.language($0) }
            let expanded = TranscriptProseCodeState.shared.isExpanded(stateID)
            let presentation = ConversationCodePresentation(text: text, expanded: expanded)
            let visible = presentation.visibleText
            let highlighted = syntax.flatMap { ConversationSyntax.shared.cached(visible, language: $0) }
            if highlighted == nil, let syntax, visible.utf16.count <= 160_000 { highlights.insert(.init(text: visible, language: syntax)) }
            let cacheKey = "\(style.key)|\(Int(style.viewportHeight))|\(expanded)|\(highlighted != nil)|\(syntax ?? "")|\(key)|\(language ?? "")|" + text
            let piece: TranscriptProseCode
            if let cached = TranscriptProse.codes.object(forKey: cacheKey as NSString) {
                piece = cached
            } else {
                let title = cited.map { "\($0.path) · L\($0.start)–\($0.end)" } ?? (language?.isEmpty == false ? language! : "text").uppercased()
                let disclosure: TranscriptProseCode.Disclosure = presentation.isTruncated ? .expand(lines: presentation.totalLines)
                    : presentation.canCollapse ? .collapse : .none
                let style = style
                piece = TranscriptProseCode(key: key, stateID: stateID, title: title, cited: cited != nil, source: text,
                                            text: Self.code(visible, runs: highlighted?.runs, style: style),
                                            viewport: { ConversationCodeViewport<EmptyView>.height(available: style.viewportHeight, content: $0, maximum: RiffetMetrics.codeBlockMaxHeight) },
                                            disclosure: disclosure)
                TranscriptProse.codes.setObject(piece, forKey: cacheKey as NSString, cost: max(1, visible.utf16.count * 64))
            }
            let height = piece.height(scale: style.scale)
            pieces.append(.init(frame: CGRect(x: x, y: y, width: width, height: height), kind: .code(piece)))
            return y + height
        }

        /// The code's text with the highlighter's tokens, as `ConversationSyntax.Result.attributed` colours them.
        static func code(_ text: String, runs: [ConversationSyntax.Run]?, style: TranscriptProseStyle) -> NSAttributedString {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 3
            let base: [NSAttributedString.Key: Any] = [.font: style.codeFont, .foregroundColor: style.codeText, .paragraphStyle: paragraph]
            guard let runs else { return NSAttributedString(string: text, attributes: base) }
            let result = NSMutableAttributedString()
            for run in runs {
                var attributes = base
                if let token = run.token, let color = style.codeTokens[token] {
                    attributes[.foregroundColor] = color
                    if token == "comment", style.commentItalic { attributes[.font] = style.codeItalicFont }
                }
                result.append(NSAttributedString(string: run.text, attributes: attributes))
            }
            return result
        }

        mutating func hosted(_ block: TranscriptProseBlock, estimate: CGFloat, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
            let height = TranscriptProseHeights.shared.height(block.key, width: width) ?? estimate
            pieces.append(.init(frame: CGRect(x: x, y: y, width: width, height: height), kind: .block(block)))
            return y + height
        }

        /// What `ConversationCode` will measure before it is built: its header, a viewport of at most 60 lines
        /// capped as `ConversationCodeViewport` caps it, and the expand line of a longer block. A diagram or
        /// page shows its picture, at the size it was last drawn.
        func codeEstimate(language: String?, text: String, width: CGFloat) -> CGFloat {
            let header: CGFloat = 36
            let lowered = language?.lowercased()
            if ConversationDiagramRequest.supports(lowered) {
                let request = ConversationDiagramRequest(origin: style.origin, source: text, language: lowered ?? "mermaid", dark: style.dark, width: style.diagramWidth)
                if let size = ConversationDiagramImages.size(for: request), size.width > 0 {
                    return header + min(size.height, size.height * width / size.width)
                }
                return header + 320
            }
            var lines = 1
            for byte in text.utf8 where byte == 10 { lines += 1 }
            let content = CGFloat(min(lines, ConversationCodePresentation.previewLines)) * style.codeLineHeight + 24
            let viewport = ConversationCodeViewport<EmptyView>.height(available: style.viewportHeight, content: content, maximum: RiffetMetrics.codeBlockMaxHeight)
            return header + viewport + (lines > ConversationCodePresentation.previewLines ? 45 : 0)
        }
    }
}
