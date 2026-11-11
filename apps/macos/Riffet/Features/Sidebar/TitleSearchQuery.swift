import Foundation

/// Matches titles first, with bounded spelling tolerance for longer Latin words.
struct TitleSearchQuery {
    private let phrase: String
    private let tokens: [String]
    private let isEmpty: Bool

    init(_ query: String) {
        phrase = Self.normalize(query)
        let chunks = phrase.unicodeScalars.split {
            CharacterSet.whitespacesAndNewlines.contains($0) || $0 == "_" ||
                $0.properties.generalCategory == .dashPunctuation
        }.map { String(String.UnicodeScalarView($0)) }
        let words = chunks.flatMap { chunk in
            chunk.unicodeScalars.allSatisfy(Self.isLetterOrNumber) ? Self.words(in: chunk) : [chunk]
        }
        tokens = words.isEmpty ? [phrase] : words
        isEmpty = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Lower scores rank ahead of higher scores; nil means no match.
    func score(_ title: String) -> Int? {
        let title = Self.normalize(title)
        if phrase.isEmpty { return isEmpty ? 0 : nil }
        if title == phrase { return 0 }
        if title.contains(phrase) { return 100 }
        if tokens.allSatisfy({ title.contains($0) }) { return 200 }

        let candidates = Self.words(in: title).filter(Self.isLatinWord)
        var edits = 0
        for token in tokens where !title.contains(token) {
            guard Self.isLatinWord(token), token.count >= 4 else { return nil }
            let limit = token.count < 8 ? 1 : 2
            guard let distance = candidates.compactMap({ Self.distance(token, $0, limit: limit) }).min() else {
                return nil
            }
            edits += distance
        }
        return 300 + edits
    }

    private static func normalize(_ text: String) -> String {
        let unmarked = text.decomposedStringWithCompatibilityMapping.unicodeScalars.filter { scalar in
            switch scalar.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark: return false
            default: return true
            }
        }
        let lowercased = String(String.UnicodeScalarView(unmarked)).lowercased()
        var normalized = ""
        var pendingSpace = false
        for scalar in lowercased.unicodeScalars {
            if CharacterSet.whitespacesAndNewlines.contains(scalar) {
                pendingSpace = !normalized.isEmpty
            } else {
                if pendingSpace { normalized.append(" ") }
                normalized.unicodeScalars.append(scalar)
                pendingSpace = false
            }
        }
        return normalized
    }

    /// Latin runs are separate words even when a title joins them directly to Chinese.
    private static func words(in text: String) -> [String] {
        var words: [String] = []
        var current = ""
        var previousLatin: Bool?
        for scalar in text.unicodeScalars {
            let latin = isLatinScalar(scalar)
            if scalar == " " || (previousLatin != nil && previousLatin != latin) {
                if !current.isEmpty { words.append(current); current = "" }
            }
            if scalar == " " {
                previousLatin = nil
            } else {
                current.unicodeScalars.append(scalar)
                previousLatin = latin
            }
        }
        if !current.isEmpty { words.append(current) }
        return words
    }

    private static func isLatinScalar(_ scalar: Unicode.Scalar) -> Bool {
        (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57)
    }

    private static func isLetterOrNumber(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber: return true
        default: return false
        }
    }

    private static func isLatinWord(_ word: String) -> Bool {
        word.unicodeScalars.allSatisfy(isLatinScalar) && word.utf8.contains { $0 >= 97 && $0 <= 122 }
    }

    /// Optimal string alignment distance includes adjacent transpositions.
    private static func distance(_ left: String, _ right: String, limit: Int) -> Int? {
        let left = Array(left.utf8), right = Array(right.utf8)
        guard abs(left.count - right.count) <= limit else { return nil }
        var previousPrevious = Array(repeating: 0, count: right.count + 1)
        var previous = Array(0...right.count)
        for i in 1...left.count {
            var current = Array(repeating: 0, count: right.count + 1)
            current[0] = i
            for j in 1...right.count {
                current[j] = min(previous[j] + 1, current[j - 1] + 1,
                                 previous[j - 1] + (left[i - 1] == right[j - 1] ? 0 : 1))
                if i > 1, j > 1, left[i - 1] == right[j - 2], left[i - 2] == right[j - 1] {
                    current[j] = min(current[j], previousPrevious[j - 2] + 1)
                }
            }
            previousPrevious = previous
            previous = current
        }
        return previous[right.count] <= limit ? previous[right.count] : nil
    }
}
