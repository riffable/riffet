import JavaScriptCore
import SwiftUI

/// Syntax highlighting with the web's highlighter: refractor (Prism) and the same grammars, bundled
/// as `highlight.js` (`scripts/build-highlighter.sh`) and run by JavaScriptCore on its own queue.
/// Results are cached by language and text, so a re-rendered row never tokenizes twice.
final class CodeHighlighter: @unchecked Sendable {
    static let shared = CodeHighlighter()

    /// One run of source text and the token class that colors it.
    struct Run: Sendable {
        let text: String
        let token: Token?
    }

    /// The shared 14 syntax roles (plus punctuation), matching the web's `--code-*` palette.
    enum Token: Sendable {
        case comment, punctuation, keyword, string, number, constant, declaration, type, property, namespace, tag, attribute, annotation, escape, heading
    }

    /// Larger sources stay plain: tokenizing them costs more than the colors are worth.
    static let maxLength = 160_000

    private let queue = DispatchQueue(label: "io.github.riffable.highlight", qos: .userInitiated)
    private var function: JSValue?
    private var loaded = false
    private let cache = NSCache<NSString, Box>()

    private final class Box {
        let runs: [Run]
        init(_ runs: [Run]) { self.runs = runs }
    }

    private init() {
        cache.totalCostLimit = 24 * 1024 * 1024
    }

    func cached(_ code: String, language: String) -> [Run]? {
        cache.object(forKey: Self.key(code, language))?.runs
    }

    /// The runs for [code], or nil when the language has no grammar or the source is too large.
    func runs(_ code: String, language: String) async -> [Run]? {
        guard code.utf16.count <= Self.maxLength else { return nil }
        let key = Self.key(code, language)
        if let hit = cache.object(forKey: key) { return hit.runs }
        return await withCheckedContinuation { continuation in
            queue.async {
                let runs = self.tokenize(code, language: language)
                if let runs { self.cache.setObject(Box(runs), forKey: key, cost: code.utf16.count * 2) }
                continuation.resume(returning: runs)
            }
        }
    }

    private let preparing = NSLock()
    private var inflight: Set<String> = []
    private var unavailable: Set<String> = []
    private var latest: [String: String] = [:]

    /// Tokenizes [code] in the background if it is not cached yet and names [token] ready when done,
    /// so a transcript row drawn in plain text picks up its colours. Returns false when it never will.
    /// [slot] names the block: while one is streaming only its latest text is tokenized.
    @discardableResult
    func prepare(_ code: String, language: String, token: String, slot: String) -> Bool {
        preparing.lock()
        if unavailable.contains(token) {
            preparing.unlock()
            return false
        }
        latest[slot] = token
        let start = inflight.insert(token).inserted
        preparing.unlock()
        guard start else { return true }
        queue.async {
            self.preparing.lock()
            let superseded = self.latest[slot] != token
            if superseded { self.inflight.remove(token) }
            self.preparing.unlock()
            guard !superseded else { return }
            let key = Self.key(code, language)
            var ok = self.cache.object(forKey: key) != nil
            if !ok, let runs = self.tokenize(code, language: language) {
                self.cache.setObject(Box(runs), forKey: key, cost: code.utf16.count * 2)
                ok = true
            }
            self.preparing.lock()
            self.inflight.remove(token)
            if !ok { self.unavailable.insert(token) }
            self.preparing.unlock()
            if ok { TranscriptResources.ready(token) }
        }
        return true
    }

    private static func key(_ code: String, _ language: String) -> NSString {
        "\(language)\u{0}\(code)" as NSString
    }

    private func tokenize(_ code: String, language: String) -> [Run]? {
        if !loaded {
            loaded = true
            if let url = Bundle.main.url(forResource: "highlight", withExtension: "js"),
               let source = try? String(contentsOf: url, encoding: .utf8),
               let context = JSContext() {
                context.evaluateScript(source)
                function = context.objectForKeyedSubscript("riffetHighlight")
            }
        }
        guard let function, let result = function.call(withArguments: [code, language]), result.isString,
              let json = result.toString(), let data = json.data(using: .utf8),
              let tokens = try? JSONSerialization.jsonObject(with: data) as? [[Any]] else { return nil }
        return tokens.compactMap { pair in
            guard let text = pair.first as? String else { return nil }
            let classes = pair.count > 1 ? (pair[1] as? [String] ?? []) : []
            return Run(text: text, token: Self.token(for: classes))
        }
    }

    private static func token(for classes: [String]) -> Token? {
        for name in classes.reversed() {
            switch name {
            case "comment", "prolog", "doctype", "cdata": return .comment
            case "punctuation": return .punctuation
            case "tag", "selector": return .tag
            case "attr-name": return .attribute
            case "property": return .property
            case "annotation", "decorator": return .annotation
            case "boolean", "constant": return .constant
            case "number": return .number
            case "keyword", "atrule", "important", "builtin": return .keyword
            case "string", "char", "attr-value", "regex", "inserted": return .string
            case "escape": return .escape
            case "function": return .declaration
            case "title": return .heading
            case "class-name", "symbol": return .type
            case "namespace": return .namespace
            case "deleted": return .tag
            case "operator", "entity", "url", "variable": return nil
            default: continue
            }
        }
        return nil
    }

    // MARK: Languages (apps/web/src/lib/highlight.ts)

    private static let byExtension: [String: String] = [
        "ts": "typescript", "mts": "typescript", "cts": "typescript", "tsx": "tsx",
        "js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "jsx",
        "json": "json", "yaml": "yaml", "yml": "yaml", "toml": "toml",
        "sh": "bash", "bash": "bash", "zsh": "bash",
        "css": "css", "scss": "scss", "less": "less",
        "html": "markup", "htm": "markup", "xml": "markup", "svg": "markup", "vue": "markup", "svelte": "markup",
        "sql": "sql", "md": "markdown", "markdown": "markdown", "py": "python", "go": "go", "rs": "rust",
        "java": "java", "kt": "kotlin", "kts": "kotlin", "swift": "swift",
        "c": "c", "h": "c", "cc": "cpp", "cpp": "cpp", "cxx": "cpp", "hpp": "cpp", "hh": "cpp", "hxx": "cpp",
        "rb": "ruby", "php": "php", "cs": "csharp",
    ]

    private static let byFence: [String: String] = [
        "ts": "typescript", "typescript": "typescript", "tsx": "tsx",
        "js": "javascript", "javascript": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "jsx",
        "json": "json", "jsonc": "json", "json5": "json5", "yml": "yaml", "yaml": "yaml", "toml": "toml",
        "ini": "ini", "cfg": "ini", "conf": "ini", "properties": "ini", "env": "ini",
        "sh": "bash", "bash": "bash", "zsh": "bash", "shell": "bash", "console": "bash", "shellscript": "bash",
        "ps1": "powershell", "powershell": "powershell",
        "py": "python", "python": "python", "python3": "python", "go": "go", "golang": "go",
        "rs": "rust", "rust": "rust", "java": "java", "kt": "kotlin", "kts": "kotlin", "kotlin": "kotlin",
        "swift": "swift", "c": "c", "h": "c",
        "cc": "cpp", "cpp": "cpp", "c++": "cpp", "cxx": "cpp", "hpp": "cpp", "hh": "cpp", "hxx": "cpp",
        "cs": "csharp", "csharp": "csharp", "c#": "csharp", "rb": "ruby", "ruby": "ruby", "php": "php",
        "dart": "dart", "scala": "scala", "lua": "lua", "r": "r", "pl": "perl", "perl": "perl",
        "m": "objectivec", "mm": "objectivec", "objc": "objectivec", "objectivec": "objectivec",
        "ex": "elixir", "exs": "elixir", "elixir": "elixir", "erl": "erlang", "erlang": "erlang",
        "hs": "haskell", "haskell": "haskell", "clj": "clojure", "cljs": "clojure", "clojure": "clojure",
        "graphql": "graphql", "gql": "graphql", "proto": "protobuf", "protobuf": "protobuf",
        "dockerfile": "docker", "docker": "docker", "makefile": "makefile", "make": "makefile", "mk": "makefile",
        "nginx": "nginx", "apache": "apacheconf", "apacheconf": "apacheconf",
        "diff": "diff", "patch": "diff", "regex": "regex", "regexp": "regex",
        "html": "markup", "htm": "markup", "xml": "markup", "svg": "markup", "vue": "markup", "svelte": "markup",
        "css": "css", "scss": "scss", "less": "less", "md": "markdown", "markdown": "markdown", "sql": "sql",
    ]

    static func language(forPath path: String) -> String? {
        let base = (path as NSString).lastPathComponent
        let lower = base.lowercased()
        if lower == "dockerfile" { return "docker" }
        if lower == "makefile" { return "makefile" }
        guard let dot = base.lastIndex(of: "."), dot != base.startIndex else { return nil }
        return byExtension[String(base[base.index(after: dot)...]).lowercased()]
    }

    static func language(forFence info: String) -> String? {
        let token = info.trimmingCharacters(in: .whitespaces).lowercased()
            .split(whereSeparator: { $0 == " " || $0 == ":" || $0 == "," }).first.map(String.init) ?? ""
        return byFence[token]
    }
}
