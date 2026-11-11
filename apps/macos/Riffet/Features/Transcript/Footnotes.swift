import Foundation

/// GFM footnotes for a parser that has none: cmark-gfm reads `[^1]: note` as a link reference
/// definition and drops it, and leaves `[^1]` literal. Definitions are lifted out before parsing,
/// references become `[n]` numbered by first use (GFM's order), and the referenced note bodies come
/// back for the converter to append after the prose.
enum Footnotes {
    struct Result {
        /// The source with definitions removed and references numbered.
        let document: String
        /// Referenced note bodies in first-reference order; a definition nobody refers to is not
        /// shown, as in GFM.
        let notes: [String]
    }

    static func rewrite(document: String) -> Result {
        guard document.contains("[^") else { return Result(document: document, notes: []) }
        let lines = document.components(separatedBy: "\n")
        let (definitions, removed) = definitions(in: lines)
        var numbers: [String: Int] = [:]
        var notes: [String] = []
        let rewritten = MarkdownSource.mapProse(document) { index, line, backticks in
            guard !removed.contains(index) else { return nil }
            return replacingReferences(in: line, backticks: &backticks) { label in
                let key = label.lowercased()
                guard let note = definitions[key] else { return nil }
                if let number = numbers[key] { return number }
                let number = notes.count + 1
                numbers[key] = number
                notes.append(note)
                return number
            }
        }
        return Result(document: rewritten, notes: notes)
    }

    // MARK: Definitions

    private static func definitions(in lines: [String]) -> ([String: String], Set<Int>) {
        var definitions: [String: String] = [:]
        var removed: Set<Int> = []
        var fence: MarkdownSource.Fence?
        var index = 0
        while index < lines.count {
            let line = lines[index]
            if let open = fence {
                if MarkdownSource.closes(line, open) { fence = nil }
                index += 1
                continue
            }
            if let open = MarkdownSource.opener(line) {
                fence = open
                index += 1
                continue
            }
            guard let found = definition(line) else {
                index += 1
                continue
            }
            var text = found.text
            removed.insert(index)
            var cursor = index + 1
            var blanks = 0
            while cursor < lines.count {
                let line = lines[cursor]
                if line.allSatisfy(\.isWhitespace) {
                    blanks += 1
                    cursor += 1
                    continue
                }
                guard let next = continuation(line) else { break }
                // A blank line between paragraphs belongs to the note, as GFM reads it.
                text += String(repeating: "\n", count: blanks + 1) + next
                removed.formUnion((cursor - blanks)..<cursor)
                removed.insert(cursor)
                blanks = 0
                cursor += 1
            }
            definitions[found.label.lowercased()] = text.trimmingCharacters(in: .whitespacesAndNewlines)
            index = cursor
        }
        return (definitions, removed)
    }

    private static let definitionPattern = try! NSRegularExpression(pattern: #"^\[\^([^\]\s]+)\]:[ \t]*(.*)$"#)

    private static func definition(_ line: String) -> (label: String, text: String)? {
        let string = MarkdownSource.withoutContainer(line.hasSuffix("\r") ? String(line.dropLast()) : line)
        let ns = string as NSString
        guard let match = definitionPattern.firstMatch(in: string, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (ns.substring(with: match.range(at: 1)), ns.substring(with: match.range(at: 2)))
    }

    private static func continuation(_ line: String) -> String? {
        if line.hasPrefix("    ") { return String(line.dropFirst(4)) }
        if line.hasPrefix("\t") { return String(line.dropFirst()) }
        return nil
    }

    // MARK: References

    private static func replacingReferences(in line: String, backticks: inout Int?, number: (String) -> Int?) -> String {
        let characters = Array(line)
        var output = ""
        var index = 0
        while index < characters.count {
            let character = characters[index]
            if character == "`" {
                let run = MarkdownSource.runLength(characters, index)
                if !MarkdownSource.escaped(characters, index) {
                    if backticks == nil {
                        backticks = run
                    } else if backticks == run {
                        backticks = nil
                    }
                }
                output.append(contentsOf: characters[index..<(index + run)])
                index += run
                continue
            }
            if backticks != nil {
                output.append(character)
                index += 1
                continue
            }
            if character == "\\", index + 1 < characters.count {
                output.append(character)
                output.append(characters[index + 1])
                index += 2
                continue
            }
            if character == "[", index + 1 < characters.count, characters[index + 1] == "^",
               let end = referenceEnd(characters, from: index), let replacement = number(String(characters[(index + 2)..<end])) {
                // The zero-width space keeps a following `(` or `[…]` from reading `[n]` as a link;
                // the converter drops it again when the text is built.
                output.append("[\(replacement)]\u{200B}")
                index = end + 1
                continue
            }
            output.append(character)
            index += 1
        }
        return output
    }

    /// The `]` closing a `[^label]` that starts at [start], or nil when the label is empty or has
    /// whitespace.
    private static func referenceEnd(_ characters: [Character], from start: Int) -> Int? {
        var index = start + 2
        while index < characters.count {
            let character = characters[index]
            if character == "]" { return index > start + 2 ? index : nil }
            if character.isWhitespace { return nil }
            index += 1
        }
        return nil
    }
}
