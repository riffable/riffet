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

    /// [text] in runs, with a link on the URLs among them. Pass `includeEmails: false` for plain
    /// user messages where only web links (`http(s)://` and `www.`) should become clickable.
    static func split(_ text: String, includeEmails: Bool = true) -> [(text: String, link: URL?)] {
        let hasHint = text.contains("://")
            || text.range(of: "www.", options: .caseInsensitive) != nil
            || (includeEmails && text.contains("@"))
        guard hasHint else { return [(text, nil)] }
        let scalars = Array(text.unicodeScalars)
        var pieces: [(text: String, link: URL?)] = []
        var plain = 0
        var index = 0
        while index < scalars.count {
            guard let found = match(in: scalars, at: index, includeEmails: includeEmails) else {
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

    private static func match(in scalars: [Unicode.Scalar], at index: Int, includeEmails: Bool) -> Match? {
        if let match = url(in: scalars, at: index) { return match }
        return includeEmails ? email(in: scalars, at: index) : nil
    }

    private static func url(in scalars: [Unicode.Scalar], at index: Int) -> Match? {
        if let scheme = schemeMatch(in: scalars, at: index) { return scheme }
        return wwwMatch(in: scalars, at: index)
    }

    private static func schemeMatch(in scalars: [Unicode.Scalar], at index: Int) -> Match? {
        let schemeLen: Int
        let normalizedScheme: String
        if startsIgnoreCase(scalars, at: index, with: http) {
            schemeLen = 7
            normalizedScheme = "http://"
        } else if startsIgnoreCase(scalars, at: index, with: https) {
            schemeLen = 8
            normalizedScheme = "https://"
        } else {
            return nil
        }
        guard schemeBoundary(scalars, at: index) else { return nil }
        let authStart = index + schemeLen
        // Optional `userinfo@` before host.
        var hostStart = authStart
        var probe = authStart
        while probe < scalars.count, isUserInfo(scalars[probe]) { probe += 1 }
        if probe > authStart, probe < scalars.count, scalars[probe] == "@" {
            hostStart = probe + 1
        }
        let hostEnd: Int
        if hostStart < scalars.count, scalars[hostStart] == "[" {
            var close = hostStart + 1
            var hasColon = false
            while close < scalars.count, isIPv6Scalar(scalars[close]) {
                if scalars[close] == ":" { hasColon = true }
                close += 1
            }
            guard hasColon, close > hostStart + 2, close < scalars.count, scalars[close] == "]" else { return nil }
            hostEnd = close + 1
        } else {
            var scanEnd = hostStart
            while scanEnd < scalars.count, isHostScalar(scalars[scanEnd]) { scanEnd += 1 }
            var trimmedEnd = scanEnd
            if scanEnd < scalars.count, scalars[scanEnd] == "/", trimmedEnd > hostStart, scalars[trimmedEnd - 1] == "." {
                trimmedEnd -= 1
            } else {
                while trimmedEnd > hostStart, scalars[trimmedEnd - 1] == "." { trimmedEnd -= 1 }
                scanEnd = trimmedEnd
            }
            guard isValidHostname(scalars[hostStart..<trimmedEnd]) else { return nil }
            hostEnd = scanEnd
        }
        guard let authEnd = scanPort(in: scalars, from: hostEnd) else { return nil }
        let end = authEnd < scalars.count && isTailStart(scalars[authEnd]) ? scanTail(in: scalars, from: authEnd) : authEnd
        let raw = normalizedScheme + string(scalars[authStart..<end])
        guard let link = URL(string: raw) else { return nil }
        return Match(start: index, end: end, link: link)
    }

    private static func wwwMatch(in scalars: [Unicode.Scalar], at index: Int) -> Match? {
        guard startsIgnoreCase(scalars, at: index, with: www), wwwBoundary(scalars, at: index) else { return nil }
        var scanEnd = index
        while scanEnd < scalars.count, isHostScalar(scalars[scanEnd]) { scanEnd += 1 }
        var trimmedEnd = scanEnd
        if scanEnd < scalars.count, scalars[scanEnd] == "/", trimmedEnd > index, scalars[trimmedEnd - 1] == "." {
            trimmedEnd -= 1
        } else {
            while trimmedEnd > index, scalars[trimmedEnd - 1] == "." { trimmedEnd -= 1 }
            scanEnd = trimmedEnd
        }
        guard isValidWwwHost(scalars[index..<trimmedEnd]) else { return nil }
        guard let authEnd = scanPort(in: scalars, from: scanEnd) else { return nil }
        let end = authEnd < scalars.count && isTailStart(scalars[authEnd]) ? scanTail(in: scalars, from: authEnd) : authEnd
        guard let link = URL(string: "http://" + string(scalars[index..<end])) else { return nil }
        return Match(start: index, end: end, link: link)
    }

    /// Parses optional `:port` at `start`. Returns `nil` when `:` introduces an invalid port.
    private static func scanPort(in scalars: [Unicode.Scalar], from start: Int) -> Int? {
        guard start < scalars.count, scalars[start] == ":" else { return start }
        var end = start + 1
        while end < scalars.count, isASCIIDigit(scalars[end]) { end += 1 }
        if end == start + 1 { return start }
        if end < scalars.count, isASCIIAlphanumeric(scalars[end]) { return nil }
        let digits = end - (start + 1)
        guard digits <= 5, let port = Int(string(scalars[(start + 1)..<end])), (1...65535).contains(port) else { return nil }
        return end
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

    /// Scans path/query/fragment from [start], stopping on punctuation/symbols or unmatched `)` / `]`.
    private static func scanTail(in scalars: [Unicode.Scalar], from start: Int) -> Int {
        var end = start
        var parenDepth = 0
        var bracketDepth = 0
        while end < scalars.count {
            let scalar = scalars[end]
            if scalar == "(" {
                parenDepth += 1
                end += 1
                continue
            }
            if scalar == ")" {
                if parenDepth == 0 { break }
                parenDepth -= 1
                end += 1
                continue
            }
            if scalar == "[" {
                bracketDepth += 1
                end += 1
                continue
            }
            if scalar == "]" {
                if bracketDepth == 0 { break }
                bracketDepth -= 1
                end += 1
                continue
            }
            guard keeps(scalar) else { break }
            end += 1
        }
        while end > start {
            let last = scalars[end - 1]
            if trailing.contains(last) {
                end -= 1
                continue
            }
            if (last == "(" || last == "["), hasUnclosedOpen(scalars, start: start, end: end, open: last, close: last == "(" ? ")" : "]") {
                end -= 1
                continue
            }
            break
        }
        return end
    }

    private static func hasUnclosedOpen(_ scalars: [Unicode.Scalar], start: Int, end: Int, open: Unicode.Scalar, close: Unicode.Scalar) -> Bool {
        var depth = 0
        for index in start..<end {
            if scalars[index] == open { depth += 1 }
            else if scalars[index] == close, depth > 0 { depth -= 1 }
        }
        return depth > 0
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

    private static func schemeBoundary(_ scalars: [Unicode.Scalar], at index: Int) -> Bool {
        index == 0 || (!isASCIIAlphanumeric(scalars[index - 1]) && scalars[index - 1] != "_")
    }

    private static func wwwBoundary(_ scalars: [Unicode.Scalar], at index: Int) -> Bool {
        guard index > 0 else { return true }
        let prev = scalars[index - 1]
        return !isASCIIAlphanumeric(prev) && prev != "." && prev != "_" && prev != "/" && prev != "-" && prev != "@"
    }

    private static func startsIgnoreCase(_ scalars: [Unicode.Scalar], at index: Int, with prefix: [Unicode.Scalar]) -> Bool {
        guard index + prefix.count <= scalars.count else { return false }
        for offset in 0..<prefix.count {
            let scalar = scalars[index + offset]
            let lower = (scalar.value >= 0x41 && scalar.value <= 0x5A) ? Unicode.Scalar(scalar.value + 32)! : scalar
            if lower != prefix[offset] { return false }
        }
        return true
    }

    private static func isValidHostname(_ host: ArraySlice<Unicode.Scalar>) -> Bool {
        guard !host.isEmpty else { return false }
        var labelStart = host.startIndex
        var cursor = host.startIndex
        while cursor <= host.endIndex {
            if cursor == host.endIndex || host[cursor] == "." {
                guard cursor > labelStart else { return false }
                guard isASCIIAlphanumeric(host[labelStart]), isASCIIAlphanumeric(host[cursor - 1]) else { return false }
                labelStart = cursor + 1
            } else if !isDomainLabel(host[cursor]) {
                return false
            }
            cursor += 1
        }
        return true
    }

    private static func isValidWwwHost(_ host: ArraySlice<Unicode.Scalar>) -> Bool {
        guard isValidHostname(host) else { return false }
        var dots = 0
        var lastLabelStart = host.startIndex
        for index in host.indices where host[index] == "." {
            dots += 1
            lastLabelStart = index + 1
        }
        guard dots >= 2 else { return false }
        let tld = host[lastLabelStart..<host.endIndex]
        guard tld.count >= 2 else { return false }
        if tld.allSatisfy(isASCIILetter) { return true }
        let tldArray = Array(tld)
        return tldArray.count >= 6
            && startsIgnoreCase(tldArray, at: 0, with: xnPrefix)
            && tldArray[4...].allSatisfy(isASCIIAlphanumeric)
    }

    private static let http = Array("http://".unicodeScalars)
    private static let https = Array("https://".unicodeScalars)
    private static let www = Array("www.".unicodeScalars)
    private static let xnPrefix = Array("xn--".unicodeScalars)

    private static func isTailStart(_ scalar: Unicode.Scalar) -> Bool {
        scalar == "/" || scalar == "?" || scalar == "#"
    }

    private static func isASCIIDigit(_ scalar: Unicode.Scalar) -> Bool {
        (0x30...0x39).contains(scalar.value)
    }

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

    private static func isHostScalar(_ scalar: Unicode.Scalar) -> Bool {
        isASCIIAlphanumeric(scalar) || scalar == "." || scalar == "-"
    }

    private static func isIPv6Scalar(_ scalar: Unicode.Scalar) -> Bool {
        isASCIIDigit(scalar) || (0x41...0x46).contains(scalar.value) || (0x61...0x66).contains(scalar.value) || scalar == ":" || scalar == "."
    }

    private static func isUserInfo(_ scalar: Unicode.Scalar) -> Bool {
        isASCIIAlphanumeric(scalar) || userInfoExtra.contains(scalar)
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
    private static let userInfoExtra: Set<Unicode.Scalar> = Set("-._~%:+".unicodeScalars)
    /// Punctuation GFM trims from the end of an autolink literal.
    private static let trailing: Set<Unicode.Scalar> = Set("?!.,:;_~".unicodeScalars)
}
