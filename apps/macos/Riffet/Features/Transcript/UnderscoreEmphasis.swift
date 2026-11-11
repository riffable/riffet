import Foundation

/// CommonMark lets `_` open and close only where it is not surrounded by word characters, which in
/// Chinese is every `_…_` next to a Han character: `__加粗__中文` and `_斜体_中文` stay literal.
/// `**` has no such rule, and `cjkFriendlyEmphasis` relaxes the one it has, so the same emphasis
/// written with asterisks renders. Rewriting a paired run to asterisks gives `_` the same reading;
/// only runs that touch CJK are touched, so `snake_case` identifiers are left alone.
enum UnderscoreEmphasis {
    private static let pair = try! NSRegularExpression(pattern: #"(^|[^A-Za-z0-9_])(_{1,3})(\S(?:.*?\S)?)\2(?=$|[^A-Za-z0-9_])"#)

    static func rewrite(document: String) -> String {
        guard document.contains("_") else { return document }
        return MarkdownSource.mapProse(document) { _, line, backticks in relax(line, backticks: &backticks) }
    }

    /// One line of prose with its inline-code state carried in; code spans are copied as they are.
    static func relax(_ line: String, backticks: inout Int?) -> String {
        guard line.contains("_") || line.contains("`") else { return line }
        let characters = Array(line)
        var output = ""
        var prose = ""
        var index = 0
        while index < characters.count {
            let character = characters[index]
            if character == "`" {
                let run = MarkdownSource.runLength(characters, index)
                if !MarkdownSource.escaped(characters, index) {
                    if backticks == nil { backticks = run } else if backticks == run { backticks = nil }
                }
                output += replacePairs(prose) + String(characters[index..<(index + run)])
                prose = ""
                index += run
                continue
            }
            if backticks == nil { prose.append(character) } else { output.append(character) }
            index += 1
        }
        return output + replacePairs(prose)
    }

    private static func replacePairs(_ prose: String) -> String {
        guard prose.contains("_") else { return prose }
        let text = prose as NSString
        var out = ""
        var cursor = 0
        for match in pair.matches(in: prose, range: NSRange(location: 0, length: text.length)) {
            let before = text.substring(with: match.range(at: 1))
            let run = text.substring(with: match.range(at: 2))
            let content = text.substring(with: match.range(at: 3))
            // Only Chinese text is emphasis here: `调用__init__方法` and `文档 _config_说明.md` are
            // identifiers and file names, where the underscores are the point.
            guard touchesCjk(content) else { continue }
            // A path can hold underscores; its text is not prose emphasis.
            if text.substring(to: match.range.location).range(of: #"https?://\S*$"#, options: .regularExpression) != nil { continue }
            let stars = String(repeating: "*", count: run.count)
            out += text.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            out += before + stars + content + stars
            cursor = NSMaxRange(match.range)
        }
        return cursor == 0 ? prose : out + text.substring(from: cursor)
    }

    private static func touchesCjk(_ character: String) -> Bool {
        character.unicodeScalars.contains { scalar in
            // Han, kana, Hangul, Bopomofo and the full-width forms beside them.
            switch scalar.value {
            case 0x2E80...0x9FFF, 0x3040...0x30FF, 0xAC00...0xD7AF, 0xF900...0xFAFF, 0xFE30...0xFE4F, 0xFF00...0xFFEF: return true
            default: return false
            }
        }
    }
}
