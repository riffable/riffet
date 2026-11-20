import AppKit
import SwiftUI

/// An answer's Markdown set for an exported picture: the transcript's parse (`MarkdownModel`) drawn
/// in SwiftUI with the export typography — a 16pt body on a 1.8 line, quiet headings, wrapped code,
/// tables ruled by hairlines only. SwiftUI rather than the transcript's AppKit views, so the card
/// renders offscreen with `ImageRenderer` and the in-app reading style stays untouched.
struct ShareMarkdown: View {
    let blocks: [MarkdownBlock]
    let colors: ShareColors
    let type: ShareType
    let wide: Bool
    var projectId: String? = nil

    static let imageLanguage = "riffet-share-image"
    static let base: CGFloat = 16

    init(source: String, colors: ShareColors, type: ShareType, wide: Bool, projectId: String? = nil) {
        self.init(blocks: Self.blocks(source), colors: colors, type: type, wide: wide, projectId: projectId)
    }

    init(blocks: [MarkdownBlock], colors: ShareColors, type: ShareType, wide: Bool, projectId: String? = nil) {
        self.blocks = blocks
        self.colors = colors
        self.type = type
        self.wide = wide
        self.projectId = projectId
    }

    var body: some View {
        BlockStack(blocks: blocks, context: Context(colors: colors, type: type, wide: wide, quoted: false, projectId: projectId))
    }

    /// Every block in reading order, retaining image references for the export renderer.
    static func blocks(_ source: String) -> [MarkdownBlock] {
        MarkdownModel.segments(source).flatMap { segment -> [MarkdownBlock] in
            switch segment {
            case let .blocks(parts): flatten(parts)
            case let .math(tex): [.code(language: "math", text: tex)]
            case let .image(_, src): [.code(language: imageLanguage, text: src)]
            case let .visualization(path, title, _): [.paragraph(AttributedString(String(localized: "[可视化] \(VisualizationPresentation.title(path: path, supplied: title))")))]
            }
        }
    }

    static func flatten(_ parts: [MarkdownPart]) -> [MarkdownBlock] {
        parts.flatMap { part -> [MarkdownBlock] in
            switch part {
            case let .prose(run): run.blocks
            case let .block(block): [block]
            }
        }
    }

    /// Colours every code block of [source] and renders its formulas ahead of the picture; the card
    /// reads both from their caches, so the exported pixels never wait on a web view.
    @MainActor
    static func prepare(_ source: String, colors: ShareColors, projectId: String? = nil) async {
        await prepare(blocks: blocks(source), colors: colors, projectId: projectId)
    }

    @MainActor
    static func prepare(blocks parts: [MarkdownBlock], colors: ShareColors, projectId: String? = nil) async {
        func codes(_ blocks: [MarkdownBlock]) -> [(String, String)] {
            blocks.flatMap { block -> [(String, String)] in
                switch block {
                case let .code(language, text): [(text, language ?? "")]
                case let .list(_, _, items): items.flatMap { codes($0.blocks) }
                case let .quote(parts): codes(flatten(parts))
                default: []
                }
            }
        }
        let allCodes = codes(parts)
        let diagrams = allCodes.filter { MermaidRequest.supports($0.1) }.map { diagramRequest($0.0, language: $0.1, colors: colors) }
        let formulas = math(parts, colors: colors)
        let images = allCodes.filter { $0.1 == imageLanguage }.map { $0.0 }
        // Queue independent assets together. Export has one deadline for the whole answer; assets
        // that cannot finish remain visible as source or image references in the resulting card.
        let deadline = Date().addingTimeInterval(8)
        for request in diagrams { _ = MermaidImages.image(request) }
        for request in formulas { _ = MathImages.image(request) }
        let loads = images.map { source in Task { _ = await ImageLoader.shared.image(for: .url(source), projectId: projectId) } }
        let highlights = allCodes.compactMap { code, language in
            CodeHighlighter.language(forFence: language).map { (code, $0) }
        }
        let coloring = highlights.map { code, language in Task { _ = await CodeHighlighter.shared.runs(code, language: language) } }
        defer { (loads + coloring).forEach { $0.cancel() } }
        while Date() < deadline && !Task.isCancelled {
            let waiting = diagrams.contains { if case .pending = MermaidImages.image($0) { return true }; return false }
                || formulas.contains { MathImages.image($0) == nil }
                || images.contains { ImageLoader.shared.cached(for: .url($0), projectId: projectId) == nil }
                || highlights.contains { CodeHighlighter.shared.cached($0.0, language: $0.1) == nil && $0.0.utf16.count <= CodeHighlighter.maxLength }
            if !waiting { break }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    @MainActor
    static func diagramRequest(_ source: String, language: String, colors: ShareColors) -> MermaidRequest {
        func hex(_ color: Color) -> String {
            let value = NSColor(color).usingColorSpace(.sRGB) ?? .black
            let background = NSColor(colors.card).usingColorSpace(.sRGB) ?? .white
            let alpha = value.alphaComponent
            return String(format: "#%02x%02x%02x",
                          Int((value.redComponent * alpha + background.redComponent * (1 - alpha)) * 255),
                          Int((value.greenComponent * alpha + background.greenComponent * (1 - alpha)) * 255),
                          Int((value.blueComponent * alpha + background.blueComponent * (1 - alpha)) * 255))
        }
        return MermaidRequest(source: source, dark: colors.dark, scale: base / 14, color: colors.inkHex,
                              background: hex(colors.card), line: hex(colors.hair2), accent: hex(colors.function), language: language.lowercased())
    }

    /// The display formulas a card shows, in the colours it paints them in.
    static func math(_ blocks: [MarkdownBlock], colors: ShareColors) -> [MathRequest] {
        blocks.flatMap { block -> [MathRequest] in
            switch block {
            case let .code(language, text): language == "math" ? [mathRequest(text, colors: colors)] : []
            case let .list(_, _, items): math(items.flatMap(\.blocks), colors: colors)
            case let .quote(parts): math(flatten(parts), colors: colors)
            default: []
            }
        }
    }

    static func mathRequest(_ tex: String, colors: ShareColors) -> MathRequest {
        MathRequest(tex: tex, theme: "share", dark: colors.dark, display: true, scale: 1, color: colors.inkHex)
    }

    struct Context {
        let colors: ShareColors
        let type: ShareType
        let wide: Bool
        let quoted: Bool
        var projectId: String? = nil

        var body: Color { quoted ? colors.ink3 : colors.ink }
    }
}

/// Blocks one under another, spaced like CSS margins: the larger of the bottom margin above and
/// the top margin below, nothing above the first or below the last.
private struct BlockStack: View {
    let blocks: [MarkdownBlock]
    let context: ShareMarkdown.Context

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                BlockView(block: block, context: context)
                    .padding(.top, index == 0 ? 0 : max(Self.margins(blocks[index - 1]).bottom, Self.margins(block).top))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func margins(_ block: MarkdownBlock) -> (top: CGFloat, bottom: CGFloat) {
        let base = ShareMarkdown.base
        switch block {
        case .paragraph, .list: return (0, base * 0.95)
        case let .heading(level, _):
            let size = BlockView.headingSize(level)
            return level <= 1 ? (size * 1.4, size * 0.6) : level == 2 ? (size * 1.5, size * 0.55) : (size * 1.4, size * 0.45)
        case .code: return (0, 13)
        case .table: return (0, 14 * 1.1)
        case .quote: return (0, base)
        case .rule: return (base * 1.7, base * 1.7)
        }
    }
}

private struct BlockView: View {
    let block: MarkdownBlock
    let context: ShareMarkdown.Context

    private var colors: ShareColors { context.colors }
    private var type: ShareType { context.type }

    static func headingSize(_ level: Int) -> CGFloat {
        level <= 1 ? 22 : level == 2 ? 19 : 16.5
    }

    var body: some View {
        switch block {
        case let .paragraph(text):
            paragraph(text)
        case let .heading(level, text):
            heading(level, text)
        case let .code(language, text):
            if language == "math" {
                formula(text)
            } else if language == ShareMarkdown.imageLanguage {
                picture(text)
            } else if MermaidRequest.supports(language) {
                diagram(text, language: language ?? "mermaid")
            } else {
                code(text, language: language)
            }
        case let .list(ordered, start, items):
            list(ordered: ordered, start: start, items: items)
        case let .quote(parts):
            BlockStack(blocks: ShareMarkdown.flatten(parts), context: ShareMarkdown.Context(colors: colors, type: type, wide: context.wide, quoted: true, projectId: context.projectId))
                .padding(.leading, 16)
                .overlay(alignment: .leading) { Rectangle().fill(colors.hair2).frame(width: 2) }
        case let .table(header, rows, alignments):
            table(header: header, rows: rows, alignments: alignments)
        case .rule:
            Text("·  ·  ·")
                .font(Font(ShareType.sans(14)))
                .tracking(14 * 0.3)
                .foregroundStyle(colors.ink4)
                .frame(maxWidth: .infinity)
                .frame(height: ShareMarkdown.base * 1.8)
        }
    }

    private func paragraph(_ text: AttributedString) -> some View {
        let size = ShareMarkdown.base
        let font = type.body(size)
        return Text(inline(text, size: size, weight: .regular, color: context.body))
            .shareLines(type.lineGap(font, lineHeight: size * 1.8))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func heading(_ level: Int, _ text: AttributedString) -> some View {
        let size = Self.headingSize(level)
        let weight: NSFont.Weight = type.serif ? .bold : .semibold
        let font = type.body(size, weight)
        return Text(inline(text, size: size, weight: weight, color: colors.ink, tracking: 0))
            .shareLines(type.lineGap(font, lineHeight: size * 1.45))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func list(ordered: Bool, start: Int, items: [MarkdownListItem]) -> some View {
        let size = ShareMarkdown.base
        let gutter = size * 1.5
        return VStack(alignment: .leading, spacing: size * 0.28) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    marker(ordered: ordered, number: start + index, checkbox: item.checkbox)
                        .frame(width: gutter - 7, alignment: .trailing)
                        .padding(.trailing, 7)
                    BlockStack(blocks: item.blocks, context: context)
                }
            }
        }
    }

    @ViewBuilder
    private func marker(ordered: Bool, number: Int, checkbox: Bool?) -> some View {
        let size = ShareMarkdown.base
        if let checked = checkbox {
            Image(icon: checked ? "checkmark.square" : "square")
                .font(.riffet(size: size * 0.85))
                .foregroundStyle(colors.ink4)
        } else if ordered {
            Text("\(number).")
                .font(Font(ShareType.sans(size * 0.92)))
                .monospacedDigit()
                .foregroundStyle(colors.ink4)
        } else {
            Text("•")
                .font(Font(ShareType.sans(size)))
                .foregroundStyle(colors.ink4)
        }
    }

    /// A display formula from the KaTeX page the transcript uses; its TeX stands in until the
    /// snapshot is there (a card is exported only after `prepare` has waited for it).
    @ViewBuilder
    private func formula(_ tex: String) -> some View {
        let request = ShareMarkdown.mathRequest(tex, colors: colors)
        if let image = MathImages.image(request)?.image {
            let across: CGFloat = context.wide ? 720 - 96 : 480 - 72
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: min(image.size.width, across))
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, ShareMarkdown.base * 1.8)
        } else {
            code(tex, language: "math")
        }
    }

    @ViewBuilder
    private func diagram(_ source: String, language: String) -> some View {
        let request = ShareMarkdown.diagramRequest(source, language: language, colors: colors)
        if case let .image(image) = MermaidImages.image(request) {
            renderedImage(image)
        } else {
            code(source, language: language)
        }
    }

    @ViewBuilder
    private func picture(_ source: String) -> some View {
        if let image = ImageLoader.shared.cached(for: .url(source), projectId: context.projectId) {
            renderedImage(image)
        } else {
            paragraph(AttributedString(String(localized: "[图片] \(source)")))
        }
    }

    private func renderedImage(_ image: NSImage) -> some View {
        let across: CGFloat = context.wide ? 720 - 96 : 480 - 72
        return Image(nsImage: image)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(maxWidth: min(image.size.width, across))
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 8)
    }

    private func code(_ text: String, language: String?) -> some View {
        let font = ShareType.mono(13)
        let source = text.replacingOccurrences(of: "\t", with: "    ")
        return Text(highlighted(source, language: language, font: font))
            .shareLines(ShareType(serif: false).lineGap(font, lineHeight: 13 * 1.65))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, context.wide ? 16 : 14)
            .padding(.horizontal, context.wide ? 20 : 16)
            .background(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).fill(colors.code))
    }

    private func highlighted(_ text: String, language: String?, font: NSFont) -> AttributedString {
        var base = AttributedString(text)
        base.font = Font(font)
        base.foregroundColor = colors.ink2
        guard let grammar = language.flatMap(CodeHighlighter.language(forFence:)),
              let runs = CodeHighlighter.shared.cached(text, language: grammar) else { return base }
        var result = AttributedString()
        let italic = Font(NSFont(descriptor: font.fontDescriptor.withSymbolicTraits(.italic), size: font.pointSize) ?? font)
        for run in runs {
            var piece = AttributedString(run.text)
            piece.font = Font(font)
            switch run.token {
            case .keyword?, .tag?, .heading?: piece.foregroundColor = colors.keyword
            case .string?, .escape?: piece.foregroundColor = colors.string
            case .constant?, .number?, .annotation?: piece.foregroundColor = colors.number
            case .comment?:
                piece.foregroundColor = colors.comment
                piece.font = italic
            case .declaration?, .type?, .property?, .attribute?: piece.foregroundColor = colors.function
            case .punctuation?, .namespace?: piece.foregroundColor = colors.punctuation
            case nil: piece.foregroundColor = colors.ink2
            }
            result += piece
        }
        return result
    }

    private func table(header: [AttributedString], rows: [[AttributedString]], alignments: [MarkdownTableAlignment]) -> some View {
        let columns = max(header.count, rows.map(\.count).max() ?? 0)
        let size: CGFloat = 14
        let gap = ShareType(serif: false).lineGap(ShareType.sans(size), lineHeight: size * 1.6)
        func frameAlignment(_ column: Int) -> Alignment {
            guard column < alignments.count else { return .leading }
            switch alignments[column] {
            case .center: return .center
            case .right: return .trailing
            case .left: return .leading
            }
        }
        func textAlignment(_ column: Int) -> TextAlignment {
            guard column < alignments.count else { return .leading }
            switch alignments[column] {
            case .center: return .center
            case .right: return .trailing
            case .left: return .leading
            }
        }
        func horizontalAlignment(_ column: Int) -> HorizontalAlignment {
            guard column < alignments.count else { return .leading }
            switch alignments[column] {
            case .center: return .center
            case .right: return .trailing
            case .left: return .leading
            }
        }
        func cell(_ value: AttributedString?, header: Bool, column: Int) -> some View {
            Text(inline(value ?? AttributedString(""), size: size, weight: header ? .semibold : .regular, color: header ? colors.ink2 : colors.ink, sans: true, tracking: 0))
                .monospacedDigit()
                .multilineTextAlignment(textAlignment(column))
                .shareLines(gap)
                .fixedSize(horizontal: false, vertical: true)
                .gridColumnAlignment(horizontalAlignment(column))
                .frame(maxWidth: column == columns - 1 ? .infinity : nil, alignment: frameAlignment(column))
        }
        return Grid(alignment: .topLeading, horizontalSpacing: 16, verticalSpacing: 0) {
            GridRow {
                ForEach(0..<columns, id: \.self) { column in
                    cell(column < header.count ? header[column] : nil, header: true, column: column).padding(.bottom, 8)
                }
            }
            Rectangle().fill(colors.hair2).frame(height: 1)
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                GridRow {
                    ForEach(0..<columns, id: \.self) { column in
                        cell(column < row.count ? row[column] : nil, header: false, column: column).padding(.vertical, 9)
                    }
                }
                if index < rows.count - 1 { Rectangle().fill(colors.hair).frame(height: 1) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Inline Markdown in the export style: semibold strong, emphasis as a quieter colour rather than
    /// italics (Han has none), inline code in the code face on its tint, links underlined by a hairline.
    private func inline(_ text: AttributedString, size: CGFloat, weight: NSFont.Weight, color: Color, sans: Bool = false, tracking: CGFloat? = nil) -> AttributedString {
        let tracking = tracking ?? size * 0.01
        let face = { (weight: NSFont.Weight) in sans ? ShareType.sans(size, weight) : type.body(size, weight) }
        var result = AttributedString()
        for run in text.runs {
            let piece = String(text[run.range].characters)
            if let link = run.link, let tex = MathText.tex(link) {
                var part = AttributedString(tex)
                part.font = Font(ShareType.mono(size * 0.84))
                part.foregroundColor = colors.ink2
                result += part
                continue
            }
            let intent = run.inlinePresentationIntent ?? []
            let inlineTag = run[MarkdownInlineTagKey.self]
            var part = AttributedString(piece)
            if inlineTag == .sup || inlineTag == .sub {
                let scriptSize = max(9, size * 0.75)
                let strong = intent.contains(.stronglyEmphasized)
                part.font = Font(sans ? ShareType.sans(scriptSize, strong ? .semibold : weight) : type.body(scriptSize, strong ? (type.serif ? .bold : .semibold) : weight))
                part.foregroundColor = color
                part.swiftUI.baselineOffset = inlineTag == .sup ? size * 0.35 : -size * 0.18
            } else if intent.contains(.code) {
                part.font = Font(ShareType.mono(size * 0.84))
                part.foregroundColor = colors.ink2
                part.backgroundColor = colors.code
                var pad = AttributedString("\u{00A0}")
                pad.font = Font(ShareType.sans(size * 0.84))
                pad.backgroundColor = colors.code
                part = pad + part + pad
            } else {
                let strong = intent.contains(.stronglyEmphasized)
                part.font = Font(face(strong ? (type.serif && !sans ? .bold : .semibold) : weight))
                part.foregroundColor = strong ? colors.ink : intent.contains(.emphasized) ? colors.ink2 : color
                part.swiftUI.tracking = tracking
            }
            if intent.contains(.strikethrough) || run.strikethroughStyle != nil {
                part.swiftUI.strikethroughStyle = Text.LineStyle.single
            }
            if let link = run.link, link.scheme != FileLink.scheme {
                part.foregroundColor = colors.ink
                part.swiftUI.underlineStyle = Text.LineStyle(pattern: .solid, color: colors.hair2)
            }
            result += part
        }
        return result
    }
}

/// Finds a passage in its answer's Markdown blocks, so a span exported as an image keeps the
/// structure it had: the covering blocks, the first and last paragraph cut to the passage. Matching
/// compares letters and digits only, which survives the whitespace, list markers and punctuation
/// that a rendered selection and the source write differently.
enum ShareSpan {
    /// The blocks covering [exact] in [full]; nil when it is not found, or is one plain paragraph.
    static func blocks(of exact: String, prefix: String, suffix: String, in full: String) -> [MarkdownBlock]? {
        let top = ShareMarkdown.blocks(full.trimmingCharacters(in: .whitespacesAndNewlines))
        let needle = key(exact)
        guard !needle.isEmpty else { return nil }
        // One entry per letter or digit of the answer: its block, and its rank within that block.
        var hay: [Character] = []
        var owner: [(block: Int, rank: Int, offset: Int)] = []
        var counts: [Int] = []
        for (index, block) in top.enumerated() {
            var rank = 0
            for (offset, character) in plain(block).enumerated() where character.isLetter || character.isNumber {
                hay.append(Character(character.lowercased()))
                owner.append((index, rank, offset))
                rank += 1
            }
            counts.append(rank)
        }
        guard hay.count >= needle.count else { return nil }
        let before = key(prefix), after = key(suffix)
        var best: (start: Int, score: Int)?
        for start in 0...(hay.count - needle.count) where hay[start] == needle[0] && Array(hay[start..<start + needle.count]) == needle {
            let score = common(hay[..<start].reversed(), before.reversed()) + common(hay[(start + needle.count)...], after)
            if best == nil || score > best!.score { best = (start, score) }
        }
        guard let best else { return nil }
        let first = owner[best.start], last = owner[best.start + needle.count - 1]
        var result = Array(top[first.block...last.block])
        if result.count == 1, case .paragraph = result[0] { return nil }
        if first.rank > 0, case let .paragraph(text) = result[0] {
            result[0] = .paragraph(slice(text, from: first.offset, to: nil))
        }
        if last.rank < counts[last.block] - 1, result.count > 1, case let .paragraph(text) = result[result.count - 1] {
            result[result.count - 1] = .paragraph(slice(text, from: nil, to: last.offset + 1))
        }
        return result
    }

    private static func key(_ text: String) -> [Character] {
        text.filter { $0.isLetter || $0.isNumber }.map { Character($0.lowercased()) }
    }

    private static func common<A: Sequence, B: Sequence>(_ left: A, _ right: B) -> Int where A.Element == Character, B.Element == Character {
        zip(left, right).prefix { $0 == $1 }.count
    }

    private static func slice(_ text: AttributedString, from: Int?, to: Int?) -> AttributedString {
        let characters = text.characters
        let lower = from.map { characters.index(characters.startIndex, offsetBy: $0) } ?? characters.startIndex
        let upper = to.map { characters.index(characters.startIndex, offsetBy: $0) } ?? characters.endIndex
        return AttributedString(text[lower..<upper])
    }

    /// A block's text as the reader sees it, without markup.
    private static func plain(_ block: MarkdownBlock) -> String {
        switch block {
        case let .paragraph(text), let .heading(_, text): String(text.characters)
        case let .code(_, text): text
        case let .list(_, _, items): items.map { $0.blocks.map(plain).joined(separator: "\n") }.joined(separator: "\n")
        case let .quote(parts): ShareMarkdown.flatten(parts).map(plain).joined(separator: "\n")
        case let .table(header, rows, _): ([header] + rows).map { $0.map { String($0.characters) }.joined(separator: " ") }.joined(separator: "\n")
        case .rule: ""
        }
    }
}
