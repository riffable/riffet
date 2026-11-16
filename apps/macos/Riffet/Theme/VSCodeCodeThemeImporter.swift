import Foundation

/// Parses a VS Code / Shiki JSON(C) theme into Riffet's 14 code syntax roles, mirroring
/// `packages/contracts/src/vscode-code-theme.ts`.
enum VSCodeCodeThemeImporter {
    struct Imported {
        var name: String?
        var mode: String?
        var syntax: CachedThemeSyntax?
        var half: CachedThemeSyntaxHalf?
    }

    enum ImportError: LocalizedError {
        case invalidJSON
        case notTheme

        var errorDescription: String? {
            switch self {
            case .invalidJSON: String(localized: "JSON 格式无法解析")
            case .notTheme: String(localized: "未找到可用的 VS Code 语法配色字段")
            }
        }
    }

    private static let roles = [
        "comment", "keyword", "string", "number", "constant", "declaration", "type",
        "property", "namespace", "tag", "attribute", "annotation", "escape", "heading",
    ]

    private static let scopeMatchers: [(role: String, scopes: [String])] = [
        ("comment", ["comment", "punctuation.definition.comment", "string.comment"]),
        ("keyword", ["keyword", "storage", "storage.type", "keyword.control", "storage.modifier"]),
        ("string", ["string", "string.quoted", "markup.inline.raw"]),
        ("number", ["constant.numeric", "number"]),
        ("constant", ["constant.language", "variable.other.constant", "variable.other.enummember", "support.constant", "constant", "variable.language"]),
        ("declaration", ["entity.name.function", "entity.name.function.declaration", "support.function", "meta.function-call", "variable.function"]),
        ("type", ["entity.name.type", "entity.name.class", "entity.name.type.class", "support.type", "support.class"]),
        ("property", ["variable.other.property", "variable.other.object.property", "support.variable.property", "variable.other.member", "property"]),
        ("namespace", ["entity.name.namespace", "entity.name.type.module", "support.module", "entity.name.package", "namespace", "meta.import"]),
        ("tag", ["entity.name.tag", "meta.tag"]),
        ("attribute", ["entity.other.attribute-name", "support.type.property-name", "meta.object-literal.key", "meta.property-name", "attribute.name"]),
        ("annotation", ["storage.type.annotation", "entity.name.function.decorator", "meta.decorator", "punctuation.definition.annotation", "entity.name.type.annotation"]),
        ("escape", ["constant.character.escape", "variable.string-escape", "punctuation.definition.template-expression"]),
        ("heading", ["markup.heading", "entity.name.section", "heading.1.markdown", "markup.heading.1"]),
    ]

    static func parse(_ raw: String) throws -> Imported {
        let stripped = stripJsonCommentsAndTrailingCommas(raw)
        guard let data = stripped.data(using: .utf8),
              let doc = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw ImportError.invalidJSON
        }

        let name = (doc["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedName = name?.isEmpty == false ? name : nil

        if let lightObj = doc["light"] as? [String: Any],
           let darkObj = doc["dark"] as? [String: Any],
           let lightHalf = parseDirectHalf(lightObj),
           let darkHalf = parseDirectHalf(darkObj) {
            return Imported(name: resolvedName, mode: nil, syntax: CachedThemeSyntax(light: lightHalf, dark: darkHalf), half: nil)
        }
        if let single = parseDirectHalf(doc) {
            return Imported(name: resolvedName, mode: detectMode(doc), syntax: nil, half: single)
        }

        guard let rawRules = (doc["tokenColors"] as? [[String: Any]]) ?? (doc["settings"] as? [[String: Any]]) else {
            throw ImportError.notTheme
        }

        var rules: [(scopes: [String], foreground: String?, fontStyle: String?)] = []
        for item in rawRules {
            guard let settings = item["settings"] as? [String: Any] else { continue }
            let foreground = (settings["foreground"] as? String).flatMap(normalizeHex)
            let fontStyle = settings["fontStyle"] as? String
            let scopes = normalizeScopes(item["scope"])
            if !scopes.isEmpty && (foreground != nil || fontStyle != nil) {
                rules.append((scopes: scopes, foreground: foreground, fontStyle: fontStyle))
            }
        }

        let mode = detectMode(doc)
        let editorColors = doc["colors"] as? [String: Any]
        let editorFg = (editorColors?["editor.foreground"] as? String).flatMap(normalizeHex)
        let fallbackFg = editorFg ?? (mode == "dark" ? "#d2d4d7" : "#2a2c2e")

        var picked: [String: String] = [:]
        var commentItalic = true
        var matchedCount = 0

        for (role, targets) in scopeMatchers {
            var bestScore = 0
            var bestColor: String?
            var bestStyle: String?
            for (index, target) in targets.enumerated() {
                let priority = (targets.count - index) * 10
                for rule in rules {
                    let match = scopeMatch(rule.scopes, target: target)
                    if match == 0 { continue }
                    let score = priority + match
                    if let fg = rule.foreground, score > bestScore {
                        bestScore = score
                        bestColor = fg
                        bestStyle = rule.fontStyle
                    } else if role == "comment", let style = rule.fontStyle, score >= bestScore {
                        bestStyle = style
                    }
                }
            }
            if let bestColor {
                picked[role] = bestColor
                matchedCount += 1
            }
            if role == "comment", let bestStyle {
                commentItalic = bestStyle.lowercased().contains("italic")
            }
        }

        guard matchedCount > 0 else { throw ImportError.notTheme }

        func pick(_ candidates: [String]) -> String {
            for role in candidates {
                if let value = picked[role] { return value }
            }
            return fallbackFg
        }

        let colors: [String: String] = [
            "comment": picked["comment"] ?? (mode == "dark" ? "#7a7e85" : "#8c8c8c"),
            "keyword": pick(["keyword"]),
            "string": pick(["string"]),
            "number": pick(["number", "constant"]),
            "constant": pick(["constant", "number", "keyword"]),
            "declaration": pick(["declaration", "constant"]),
            "type": pick(["type", "declaration"]),
            "property": pick(["property", "attribute", "constant"]),
            "namespace": pick(["namespace", "type"]),
            "tag": pick(["tag", "keyword"]),
            "attribute": pick(["attribute", "property", "tag"]),
            "annotation": pick(["annotation", "keyword", "type"]),
            "escape": pick(["escape", "constant", "string"]),
            "heading": pick(["heading", "keyword", "constant"]),
        ]

        return Imported(
            name: resolvedName,
            mode: mode,
            syntax: nil,
            half: CachedThemeSyntaxHalf(colors: colors, commentItalic: commentItalic)
        )
    }

    private static func parseDirectHalf(_ dict: [String: Any]) -> CachedThemeSyntaxHalf? {
        guard let rawColors = dict["colors"] as? [String: Any] else { return nil }
        var colors: [String: String] = [:]
        for role in roles {
            guard let raw = rawColors[role] as? String, let hex = normalizeHex(raw) else { return nil }
            colors[role] = hex
        }
        let italic = (dict["commentItalic"] as? Bool) ?? true
        return CachedThemeSyntaxHalf(colors: colors, commentItalic: italic)
    }

    private static func detectMode(_ doc: [String: Any]) -> String? {
        if let type = doc["type"] as? String {
            if type == "light" || type == "hcLight" { return "light" }
            if type == "dark" || type == "hcDark" { return "dark" }
        }
        if let colors = doc["colors"] as? [String: Any],
           let bgHex = (colors["editor.background"] as? String).flatMap(normalizeHex),
           let rgba = RiffetRGBA(hex: bgHex) {
            func linear(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
            let lum = 0.2126 * linear(rgba.red) + 0.7152 * linear(rgba.green) + 0.0722 * linear(rgba.blue)
            return lum < 0.25 ? "dark" : "light"
        }
        return nil
    }

    private static func normalizeHex(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("#") else { return nil }
        let hex = String(trimmed.dropFirst())
        let expanded: String
        if hex.count == 3 || hex.count == 4 {
            expanded = hex.map { "\($0)\($0)" }.joined()
        } else if hex.count == 6 || hex.count == 8 {
            expanded = hex
        } else {
            return nil
        }
        let parsed = RiffetRGBA(hex: "#\(expanded)")
        return parsed?.hex.lowercased()
    }

    private static func normalizeScopes(_ value: Any?) -> [String] {
        if let str = value as? String {
            return str.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        if let arr = value as? [Any] {
            return arr.compactMap { $0 as? String }
                .flatMap { $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } }
                .filter { !$0.isEmpty }
        }
        return []
    }

    private static func scopeMatch(_ ruleScopes: [String], target: String) -> Int {
        var best = 0
        for scope in ruleScopes {
            if scope == target { best = max(best, 3) }
            else if scope.hasPrefix("\(target).") { best = max(best, 2) }
            else if target.hasPrefix("\(scope).") { best = max(best, 1) }
        }
        return best
    }

    private static func stripJsonCommentsAndTrailingCommas(_ raw: String) -> String {
        var out = ""
        let chars = Array(raw)
        var i = 0
        var inString = false
        var escaped = false
        while i < chars.count {
            let ch = chars[i]
            if inString {
                out.append(ch)
                if escaped { escaped = false }
                else if ch == "\\" { escaped = true }
                else if ch == "\"" { inString = false }
                i += 1
                continue
            }
            if ch == "\"" {
                inString = true
                out.append(ch)
                i += 1
                continue
            }
            if ch == "/", i + 1 < chars.count, chars[i + 1] == "/" {
                i += 2
                while i < chars.count && chars[i] != "\n" && chars[i] != "\r" { i += 1 }
                continue
            }
            if ch == "/", i + 1 < chars.count, chars[i + 1] == "*" {
                i += 2
                while i + 1 < chars.count && !(chars[i] == "*" && chars[i + 1] == "/") { i += 1 }
                i += 2
                continue
            }
            out.append(ch)
            i += 1
        }
        let cleanedChars = Array(out)
        var cleaned = ""
        inString = false
        escaped = false
        for j in 0..<cleanedChars.count {
            let ch = cleanedChars[j]
            if inString {
                cleaned.append(ch)
                if escaped { escaped = false }
                else if ch == "\\" { escaped = true }
                else if ch == "\"" { inString = false }
                continue
            }
            if ch == "\"" {
                inString = true
                cleaned.append(ch)
                continue
            }
            if ch == "," {
                var k = j + 1
                while k < cleanedChars.count && cleanedChars[k].isWhitespace { k += 1 }
                if k < cleanedChars.count && (cleanedChars[k] == "}" || cleanedChars[k] == "]") {
                    continue
                }
            }
            cleaned.append(ch)
        }
        return cleaned
    }
}
