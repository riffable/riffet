import Foundation

/// Bare URLs, `www.` hosts and emails, read the way GFM's autolink literal reads them. The web
/// gets these from remark-gfm, while cmark-gfm here runs without the extension, so prose text is
/// scanned here instead. Code is never scanned (inline code and code blocks are separate nodes),
/// and the converter passes `Markdown.Link` children over.
enum BareURLs {
    private struct Match {
        let start: Int
        let end: Int
        let link: URL
    }

    /// [text] in runs, with a link on the URLs among them.
    static func split(_ text: String) -> [(text: String, link: URL?)] {
        guard text.contains("://") || text.contains("www.") || text.contains("@") else { return [(text, nil)] }
        let scalars = Array(text.unicodeScalars)
        var pieces: [(text: String, link: URL?)] = []
        var plain = 0
        var index = 0
        while index < scalars.count {
            guard let found = match(in: scalars, at: index) else {
                index += 1
                continue
            }
            if plain < index { pieces.append((string(scalars[plain..<index]), nil)) }
            pieces.append((string(scalars[found.start..<found.end]), found.link))
            index = found.end
            plain = index
        }
        if plain < scalars.count { pieces.append((string(scalars[plain...]), nil)) }
        return pieces
    }

    private static func match(in scalars: [Unicode.Scalar], at index: Int) -> Match? {
        if let match = url(in: scalars, at: index) { return match }
        return email(in: scalars, at: index)
    }

    private static func url(in scalars: [Unicode.Scalar], at index: Int) -> Match? {
        guard wordBoundary(scalars, at: index) else { return nil }
        if let scheme = schemeMatch(in: scalars, at: index) { return scheme }
        guard starts(scalars, at: index, with: www) else { return nil }
        let end = bodyEnd(in: scalars, from: index)
        // GFM wants a dot in the host — the part before any path — not merely somewhere in the URL.
        let hostEnd = scalars[index..<end].firstIndex { $0 == "/" || $0 == "?" || $0 == "#" } ?? end
        guard hostEnd > index + 4, scalars[(index + 4)..<hostEnd].contains(".") else { return nil }
        guard let link = URL(string: "http://" + string(scalars[index..<end])) else { return nil }
        return Match(start: index, end: end, link: link)
    }

    private static func schemeMatch(in scalars: [Unicode.Scalar], at index: Int) -> Match? {
        let scheme: Int
        if starts(scalars, at: index, with: http) {
            scheme = 7
        } else if starts(scalars, at: index, with: https) {
            scheme = 8
        } else {
            return nil
        }
        let end = bodyEnd(in: scalars, from: index)
        guard end > index + scheme, let link = URL(string: string(scalars[index..<end])) else { return nil }
        return Match(start: index, end: end, link: link)
    }

    /// `local@domain.tld`: at least one domain dot, and a last label of two or more letters.
    private static func email(in scalars: [Unicode.Scalar], at index: Int) -> Match? {
        guard wordBoundary(scalars, at: index), isASCIIAlphanumeric(scalars[index]) else { return nil }
        var local = index
        while local < scalars.count, isEmailLocal(scalars[local]) { local += 1 }
        guard local > index, local < scalars.count, scalars[local] == "@", scalars[local - 1] != "." else { return nil }
        var cursor = local + 1
        var labels = 0
        var lastLabel = cursor
        var labelStart = cursor
        while labelStart < scalars.count, isDomainLabel(scalars[labelStart]) {
            cursor = labelStart
            while cursor < scalars.count, isDomainLabel(scalars[cursor]) { cursor += 1 }
            labels += 1
            lastLabel = labelStart
            if cursor + 1 < scalars.count, scalars[cursor] == ".", isDomainLabel(scalars[cursor + 1]) {
                labelStart = cursor + 1
                continue
            }
            break
        }
        guard labels >= 2 else { return nil }
        let last = scalars[lastLabel..<cursor]
        guard last.count >= 2, last.allSatisfy(isASCIILetter) else { return nil }
        let text = string(scalars[index..<cursor])
        guard let link = URL(string: "mailto:" + text) else { return nil }
        return Match(start: index, end: cursor, link: link)
    }

    /// GFM keeps URL syntax and write-as-is paths (`/wiki/北京`); punctuation and symbols end the
    /// URL, as do quotes, `<>`, `*`, backticks and whitespace.
    private static func bodyEnd(in scalars: [Unicode.Scalar], from start: Int) -> Int {
        var end = start
        while end < scalars.count, keeps(scalars[end]) { end += 1 }
        while end > start {
            let last = scalars[end - 1]
            if last == ")" {
                var open = 0
                var close = 0
                for index in start..<end {
                    if scalars[index] == "(" { open += 1 }
                    else if scalars[index] == ")" { close += 1 }
                }
                if close <= open { break }
                end -= 1
                continue
            }
            guard trailing.contains(last) else { break }
            end -= 1
        }
        return end
    }

    private static func keeps(_ scalar: Unicode.Scalar) -> Bool {
        if scalar.value < 0x80 { return asciiURL.contains(scalar) }
        guard !scalar.properties.isWhitespace else { return false }
        switch scalar.properties.generalCategory {
        case .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation,
             .initialPunctuation, .finalPunctuation, .otherPunctuation,
             .mathSymbol, .currencySymbol, .modifierSymbol, .otherSymbol:
            return false
        default:
            return true
        }
    }

    private static func wordBoundary(_ scalars: [Unicode.Scalar], at index: Int) -> Bool {
        index == 0 || !isASCIIAlphanumeric(scalars[index - 1])
    }

    private static func starts(_ scalars: [Unicode.Scalar], at index: Int, with prefix: [Unicode.Scalar]) -> Bool {
        guard index + prefix.count <= scalars.count else { return false }
        return scalars[index..<(index + prefix.count)].elementsEqual(prefix)
    }

    private static let http = Array("http://".unicodeScalars)
    private static let https = Array("https://".unicodeScalars)
    private static let www = Array("www.".unicodeScalars)

    private static func isASCIIAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A: return true
        default: return false
        }
    }

    private static func isASCIILetter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x41...0x5A, 0x61...0x7A: return true
        default: return false
        }
    }

    private static func isEmailLocal(_ scalar: Unicode.Scalar) -> Bool {
        isASCIIAlphanumeric(scalar) || "._%+-".unicodeScalars.contains(scalar)
    }

    private static func isDomainLabel(_ scalar: Unicode.Scalar) -> Bool {
        isASCIIAlphanumeric(scalar) || scalar == "-"
    }

    private static func string(_ scalars: ArraySlice<Unicode.Scalar>) -> String {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars)
        return String(view)
    }

    private static let asciiURL: Set<Unicode.Scalar> = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!$&()+,;=%".unicodeScalars)
    /// Punctuation GFM trims from the end of an autolink literal.
    private static let trailing: Set<Unicode.Scalar> = Set("?!.,:;_~".unicodeScalars)
}
