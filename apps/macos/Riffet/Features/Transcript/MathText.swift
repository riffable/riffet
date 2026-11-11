import Foundation

struct MathText {
    static let scheme = "riffet-math"

    static func url(_ tex: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "tex"
        components.queryItems = [URLQueryItem(name: "t", value: tex)]
        return components.url
    }

    static func tex(_ url: URL) -> String? {
        guard url.scheme == scheme else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "t" }?.value
    }

    static func contains(_ text: AttributedString) -> Bool {
        text.runs.contains { $0.link?.scheme == scheme }
    }

    /// Splits prose on `$…$` the way pandoc does: no space just inside the dollars, and a closing
    /// dollar is not followed by a digit, so "$5 and $10" stays money.
    static func split(_ text: String) -> [(String, Bool)] {
        guard text.contains("$") else { return [(text, false)] }
        var parts: [(String, Bool)] = []
        var plain = ""
        let chars = Array(text)
        var index = 0
        while index < chars.count {
            let char = chars[index]
            if char == "\\", index + 1 < chars.count, chars[index + 1] == "$" {
                plain.append("$")
                index += 2
                continue
            }
            if char == "$", index + 1 < chars.count, chars[index + 1] != "$", !chars[index + 1].isWhitespace,
               let close = closing(chars, from: index + 1) {
                if !plain.isEmpty { parts.append((plain, false)); plain = "" }
                parts.append((String(chars[(index + 1)..<close]), true))
                index = close + 1
                continue
            }
            plain.append(char)
            index += 1
        }
        if !plain.isEmpty { parts.append((plain, false)) }
        return parts
    }

    private static func closing(_ chars: [Character], from start: Int) -> Int? {
        var index = start
        while index < chars.count {
            if chars[index] == "\n" { return nil }
            if chars[index] == "$", chars[index - 1] != "\\" {
                guard !chars[index - 1].isWhitespace else { return nil }
                if index + 1 < chars.count, chars[index + 1].isNumber { return nil }
                return index
            }
            index += 1
        }
        return nil
    }
}
