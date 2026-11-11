import Foundation

/// The rewrites that run on the source before it is parsed (`Footnotes`, `UnderscoreEmphasis`) share
/// one rule: never touch code, and see a fence inside a quote or a list item — which the block
/// scanner does not.
enum MarkdownSource {
    struct Fence {
        let marker: Character
        let size: Int
    }

    /// [document] line by line, with [map] applied to the lines that are not fenced code. [map]
    /// returns nil to drop the line. The inline-code state carries across lines, and a blank line
    /// ends the paragraph an unclosed span could continue into.
    static func mapProse(_ document: String, _ map: (Int, String, inout Int?) -> String?) -> String {
        var output: [String] = []
        var fence: Fence?
        var backticks: Int?
        for (index, line) in document.components(separatedBy: "\n").enumerated() {
            if let open = fence {
                if closes(line, open) { fence = nil }
                output.append(line)
                continue
            }
            if line.allSatisfy(\.isWhitespace) { backticks = nil }
            if let open = opener(line) {
                fence = open
                backticks = nil
                output.append(line)
                continue
            }
            if let mapped = map(index, line, &backticks) { output.append(mapped) }
        }
        return output.joined(separator: "\n")
    }

    /// [line] with the `>` and list markers in front of it removed, as the block parser reads them.
    static func withoutContainer(_ line: String) -> String {
        var rest = Substring(line)
        for _ in 0..<12 {
            var indent = 0
            while rest.first == " ", indent < 3 {
                rest = rest.dropFirst()
                indent += 1
            }
            if rest.first == ">" {
                rest = rest.dropFirst()
                if rest.first == " " { rest = rest.dropFirst() }
                continue
            }
            let text = String(rest)
            guard let marker = listMarker.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) else {
                return text
            }
            rest = rest.dropFirst(marker.range.length)
        }
        return String(rest)
    }

    private static let listMarker = try! NSRegularExpression(pattern: #"^(?:[-+*]|\d{1,9}[.)])[ \t]+"#)

    static func opener(_ line: String) -> Fence? {
        let rest = Substring(withoutContainer(line))
        guard let marker = rest.first, marker == "`" || marker == "~" else { return nil }
        let size = rest.prefix { $0 == marker }.count
        guard size >= 3 else { return nil }
        // A backtick fence's info string cannot contain a backtick.
        if marker == "`", rest.dropFirst(size).contains("`") { return nil }
        return Fence(marker: marker, size: size)
    }

    static func closes(_ line: String, _ fence: Fence) -> Bool {
        let rest = Substring(withoutContainer(line))
        let size = rest.prefix { $0 == fence.marker }.count
        guard size >= fence.size else { return false }
        return rest.dropFirst(size).allSatisfy { $0 == " " || $0 == "\t" }
    }

    /// The `\` escapes that keep the next character out of Markdown's hands.
    static func escaped(_ characters: [Character], _ index: Int) -> Bool {
        var slashes = 0
        var previous = index - 1
        while previous >= 0, characters[previous] == "\\" {
            slashes += 1
            previous -= 1
        }
        return slashes % 2 == 1
    }

    static func runLength(_ characters: [Character], _ start: Int) -> Int {
        var end = start
        while end < characters.count, characters[end] == characters[start] { end += 1 }
        return end - start
    }
}

/// Splits Markdown into top-level blocks that parse the same apart as together, so a streaming
/// message re-parses only its last, still-growing block. A port of the web's `markdownBlocks.ts`;
/// keep the two in step.
///
/// A split is made only at a blank line followed by a line in column 0 that is not a list marker:
/// no open block survives that except a fenced code or math block, which is tracked when it opens at
/// the top level. Whatever cannot be followed exactly ends the splitting and the rest stays one
/// block: a fence that may sit in a list item or quote, or an HTML block. A definition anywhere, or a
/// carriage return, keeps the whole text one block, since a definition reaches every block. Blocks
/// are cut before their separating blank lines.
enum MarkdownBlocks {
    private static func pattern(_ value: String) -> NSRegularExpression { try! NSRegularExpression(pattern: value) }

    /// A whitespace line reaching column 4 can still be indented code content, so it is not a gap here.
    private static let blank = pattern(#"^ {0,3}$"#)
    private static let whitespace = pattern(#"^[ \t]*$"#)
    private static let indented = pattern(#"^[ \t]"#)
    private static let listMarker = pattern(#"^ {0,3}(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]|$)"#)
    /// Backtick fences may not carry a backtick in their info string; `$$` math fences no `$`.
    private static let fence = pattern(#"^( {0,3})(`{3,}(?=[^`]*$)|~{3,}|\${2,}(?=[^$]*$))"#)
    /// A fence run anywhere a container could hold it: indented, or after `>` and list markers.
    private static let nestedFence = pattern(#"^(?:[ \t]+|[ \t]*(?:(?:>|[-*+]|[0-9]{1,9}[.)])[ \t]*)+)(?:`{3,}|~{3,}|\${2,})"#)
    /// The start of a possible HTML block; several kinds run on until a blank line or their end tag.
    private static let html = pattern(#"^[ \t>]*(?:(?:[-*+]|[0-9]{1,9}[.)])[ \t]+)*<[A-Za-z/!?]"#)
    /// An empty list item never starts a block.
    private static let emptyItem = pattern(#"^[ \t]*(?:(?:>|[-*+]|[0-9]{1,9}[.)])[ \t]*)*(?:[-*+]|[0-9]{1,9}[.)])[ \t]*$"#)
    /// Link reference and footnote definitions apply to the whole document, wherever they stand.
    private static let definition = pattern(#"^[ \t>]*(?:(?:[-*+]|[0-9]{1,9}[.)])[ \t]+)*\[(?:[^\]\\\n]|\\.)+\]:"#)

    private static func matches(_ expression: NSRegularExpression, _ line: NSString) -> Bool {
        expression.firstMatch(in: line as String, range: NSRange(location: 0, length: line.length)) != nil
    }

    static func split(_ text: String) -> [String] {
        // Scalars, not characters: "\r\n" is one Character and would not match "\r".
        if text.unicodeScalars.contains("\r") { return [text] }
        let source = text as NSString
        var blocks: [String] = []
        var blockStart = 0
        /// End of the last non-blank line, or -1 while the current block has none.
        var contentEnd = -1
        var blankSince = false
        var open: (marker: unichar, size: Int)?
        var listSeen = false
        var frozen = false
        var offset = 0
        while true {
            let newline = source.range(of: "\n", options: .literal, range: NSRange(location: offset, length: source.length - offset)).location
            let end = newline == NSNotFound ? source.length : newline
            let line = source.substring(with: NSRange(location: offset, length: end - offset)) as NSString
            if let current = open {
                // Once splitting has stopped the fence is only a guess, so a definition inside it still counts.
                if frozen, matches(definition, line) { return [text] }
                if let close = fence.firstMatch(in: line as String, range: NSRange(location: 0, length: line.length)) {
                    let run = close.range(at: 2)
                    let rest = line.substring(from: NSMaxRange(close.range)) as NSString
                    if line.character(at: run.location) == current.marker, run.length >= current.size, matches(whitespace, rest) { open = nil }
                }
                contentEnd = end
            } else if matches(blank, line) {
                if contentEnd >= 0 { blankSince = true }
            } else if matches(whitespace, line) {
                // Never a block of its own (it would parse to nothing), but it may still be code content.
                if contentEnd >= 0 {
                    contentEnd = end
                    blankSince = false
                }
            } else {
                if matches(definition, line) { return [text] }
                let marker = matches(listMarker, line)
                if blankSince, !frozen, !matches(indented, line), !marker, !matches(emptyItem, line) {
                    blocks.append(source.substring(with: NSRange(location: blockStart, length: contentEnd - blockStart)))
                    blockStart = offset
                    listSeen = false
                }
                blankSince = false
                contentEnd = end
                if marker { listSeen = true }
                if matches(html, line) { frozen = true }
                if let opener = fence.firstMatch(in: line as String, range: NSRange(location: 0, length: line.length)) {
                    if opener.range(at: 1).length > 0, listSeen { frozen = true }
                    let run = opener.range(at: 2)
                    open = (line.character(at: run.location), run.length)
                } else if matches(nestedFence, line) {
                    frozen = true
                }
            }
            if newline == NSNotFound { break }
            offset = newline + 1
        }
        blocks.append(source.substring(from: blockStart))
        return blocks
    }
}
