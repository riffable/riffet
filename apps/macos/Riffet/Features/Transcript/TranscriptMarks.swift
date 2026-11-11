import AppKit
import RiffetKit

/// A saved span drawn behind the words of one text block (`TextLayoutView.highlights`).
struct TextHighlight: Equatable {
    let range: NSRange
    let color: MarkColor
    let markId: String
}

/// How a row's marks show: the bookmark beside a saved answer, and the highlights of its spans by
/// fragment, then by text block inside the fragment (a table's cells).
struct RowMarks {
    var saved = false
    var highlights: [Int: [Int: [TextHighlight]]] = [:]

    static let none = RowMarks()
    var isEmpty: Bool { !saved && highlights.isEmpty }
}

/// The rendered text of an answer: its text blocks in reading order, and that text as one string,
/// the plain text marks quote and offsets refer to (docs/MARKS.md, "片段匹配统一以渲染后的纯文本为准").
struct RowText {
    struct Block {
        let fragment: Int
        let cell: Int
        let layout: TextLayout
        /// Where the block starts in [text], in UTF-16 units.
        let offset: Int
    }

    static let separator = "\n\n"

    let blocks: [Block]
    let text: NSString

    init(_ row: RowLayout) {
        var blocks: [Block] = []
        var text = ""
        var offset = 0
        func add(_ fragment: Int, _ cell: Int, _ layout: TextLayout) {
            if !blocks.isEmpty {
                text += Self.separator
                offset += (Self.separator as NSString).length
            }
            blocks.append(Block(fragment: fragment, cell: cell, layout: layout, offset: offset))
            text += layout.string
            offset += layout.length
        }
        for (index, fragment) in row.fragments.enumerated() {
            switch fragment.kind {
            case let .text(layout, _): add(index, 0, layout)
            case let .codeBody(spec): add(index, 0, spec.text)
            case let .table(spec):
                for (cell, layout) in (spec.header + spec.rows.flatMap { $0 }).enumerated() { add(index, cell, layout) }
            default: break
            }
        }
        self.blocks = blocks
        self.text = text as NSString
    }

    /// The answer as plain text, attachments as what they stand for: a mark's snapshot.
    var plain: String {
        blocks.map { $0.layout.plain(NSRange(location: 0, length: $0.layout.length)) }.joined(separator: Self.separator)
    }

    func block(showing layout: TextLayout?) -> Block? {
        guard let layout else { return nil }
        return blocks.first { $0.layout === layout } ?? blocks.first { $0.layout.length == layout.length && $0.layout.string == layout.string }
    }

    /// The quote for [range] of [block]: the words, about 32 characters each side for context, and
    /// the offsets as hints.
    func quote(_ range: NSRange, in block: Block) -> MarkQuote {
        let start = block.offset + range.location
        let end = start + range.length
        let context = 32
        let before = max(0, start - context)
        let after = min(text.length, end + context)
        return MarkQuote(
            exact: text.substring(with: NSRange(location: start, length: range.length)),
            prefix: text.substring(with: NSRange(location: before, length: start - before)),
            suffix: text.substring(with: NSRange(location: end, length: after - end)),
            start: KotlinInt(int: Int32(start)),
            end: KotlinInt(int: Int32(end))
        )
    }

    /// Where [quote] is now: every occurrence of the words scored by how much of the context
    /// around it matches and how near it is to the old offset; failing that, the same with runs of
    /// whitespace collapsed (Markdown and its rendering differ in spacing between clients).
    func locate(_ quote: MarkQuote) -> NSRange? {
        guard !quote.exact.isEmpty else { return nil }
        if let range = Self.best(in: text, exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix, hint: quote.start.map { Int($0.int32Value) }) { return range }
        let (normal, map) = Self.collapse(text as String)
        let exact = Self.collapse(quote.exact).0.trimmingCharacters(in: .whitespaces)
        guard !exact.isEmpty else { return nil }
        let prefix = Self.collapse(quote.prefix).0, suffix = Self.collapse(quote.suffix).0
        guard let found = Self.best(in: normal as NSString, exact: exact, prefix: prefix, suffix: suffix, hint: nil),
              NSMaxRange(found) - 1 < map.count else { return nil }
        let start = map[found.location], end = map[NSMaxRange(found) - 1] + 1
        return NSRange(location: start, length: end - start)
    }

    /// [range] of [text] split over the blocks it covers, in each block's own coordinates.
    func pieces(_ range: NSRange) -> [(Block, NSRange)] {
        blocks.compactMap { block in
            let local = NSIntersectionRange(range, NSRange(location: block.offset, length: block.layout.length))
            guard local.length > 0 else { return nil }
            return (block, NSRange(location: local.location - block.offset, length: local.length))
        }
    }

    private static func best(in text: NSString, exact: String, prefix: String, suffix: String, hint: Int?) -> NSRange? {
        var best: (range: NSRange, score: Int)?
        var search = NSRange(location: 0, length: text.length)
        while search.length > 0 {
            let found = text.range(of: exact, options: [], range: search)
            guard found.location != NSNotFound else { break }
            let lead = min(found.location, (prefix as NSString).length)
            let trail = min(text.length - NSMaxRange(found), (suffix as NSString).length)
            let before = text.substring(with: NSRange(location: found.location - lead, length: lead))
            let after = text.substring(with: NSRange(location: NSMaxRange(found), length: trail))
            var score = commonSuffix(before, prefix) + commonPrefix(after, suffix)
            if let hint { score = score * 1000 - min(999, abs(found.location - hint)) } else { score *= 1000 }
            if best == nil || score > best!.score { best = (found, score) }
            let next = found.location + 1
            search = NSRange(location: next, length: text.length - next)
        }
        return best?.range
    }

    private static func commonSuffix(_ a: String, _ b: String) -> Int {
        zip(a.utf16.reversed(), b.utf16.reversed()).prefix { $0 == $1 }.count
    }

    private static func commonPrefix(_ a: String, _ b: String) -> Int {
        zip(a.utf16, b.utf16).prefix { $0 == $1 }.count
    }

    /// [text] with each run of whitespace as one space, and for each UTF-16 unit of the result the
    /// unit of [text] it came from.
    private static func collapse(_ text: String) -> (String, [Int]) {
        var units: [UInt16] = []
        var map: [Int] = []
        var space = false
        for (index, unit) in text.utf16.enumerated() {
            let isSpace = unit == 0x20 || unit == 0x09 || unit == 0x0A || unit == 0x0D || unit == 0xA0
            if isSpace {
                if space { continue }
                space = true
                units.append(0x20)
            } else {
                space = false
                units.append(unit)
            }
            map.append(index)
        }
        return (String(utf16CodeUnits: units, count: units.count), map)
    }
}

/// The marks of one transcript, indexed by message id, with each row's resolved highlights kept
/// until the marks or the row's layout change.
@MainActor
final class TranscriptMarkIndex {
    private(set) var marks: [Mark] = []
    private var byId: [String: [Mark]] = [:]
    private var cache: [String: (layout: ObjectIdentifier, marks: RowMarks)] = [:]

    var isEmpty: Bool { marks.isEmpty }

    /// False when [next] is what it already holds.
    func update(_ next: [Mark]) -> Bool {
        guard next != marks else { return false }
        marks = next
        byId = [:]
        for mark in next {
            for id in Set(mark.anchor.ids) { byId[id, default: []].append(mark) }
        }
        cache = [:]
        return true
    }

    /// The marks made on [item].
    func marks(for item: any TimelineItem) -> [Mark] {
        var seen = Set<String>()
        return MarksStore.ids(of: item).flatMap { byId[$0] ?? [] }.filter { seen.insert($0.id).inserted }
    }

    func mark(_ id: String) -> Mark? { marks.first { $0.id == id } }

    func rowMarks(key: String, item: TimelineItemAssistant?, layout: RowLayout) -> RowMarks {
        guard !marks.isEmpty, let item else { return .none }
        if let hit = cache[key], hit.layout == ObjectIdentifier(layout) { return hit.marks }
        let found = marks(for: item)
        var result = RowMarks()
        result.saved = found.contains(where: \.isMessage)
        let spans = found.filter(\.isSpan)
        if !spans.isEmpty {
            let text = RowText(layout)
            for mark in spans.reversed() {
                guard let quote = mark.quote, let range = text.locate(quote) else { continue }
                for (block, local) in text.pieces(range) {
                    result.highlights[block.fragment, default: [:]][block.cell, default: []].append(TextHighlight(range: local, color: mark.markColor, markId: mark.id))
                }
            }
        }
        cache[key] = (ObjectIdentifier(layout), result)
        return result
    }
}

/// What a row's menu needs to mark its answer: the message, the marks already on it, and where
/// commands go (`TranscriptActions.mark`).
@MainActor
struct TranscriptMarkContext {
    let item: TimelineItemAssistant
    let marks: [Mark]
    let perform: (MarkCommand) -> Void

    var saved: Bool { marks.contains(where: \.isMessage) }
    func mark(_ id: String) -> Mark? { marks.first { $0.id == id } }
}
