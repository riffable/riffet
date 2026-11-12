import Foundation
import JavaScriptCore

/// The canvas's fold and layout, run by the same code as the web view's (`canvas-layout.js`, built
/// by `scripts/build-canvas-layout.sh`) in a JavaScriptCore context of its own. All script work
/// happens on one serial queue; every call crosses the boundary as one JSON string, and results
/// are decoded on the caller's side of it, never on the main thread unless the caller is on it.
final class CanvasLayoutEngine: @unchecked Sendable {
    enum EngineError: LocalizedError {
        case missingScript
        case script(String)

        var errorDescription: String? {
            switch self {
            case .missingScript: "canvas-layout.js is not in the app bundle"
            case .script(let message): "Canvas layout script failed: \(message)"
            }
        }
    }

    /// The canvas's plain strings in the reader's language (action names, states, empty texts).
    let strings: [String: String]

    private let queue: DispatchQueue
    private let context: JSContext
    private let canvas: JSValue
    /// Written by the exception handler, which runs on `queue` inside the call that threw.
    private var thrown: String?

    /// Loads the script and picks the language (`zh-Hans` or `en`). [scriptURL] is for tests; the app uses its bundle.
    static func make(locale: String, scriptURL: URL? = nil) async throws -> CanvasLayoutEngine {
        guard let url = scriptURL ?? Bundle.main.url(forResource: "canvas-layout", withExtension: "js") else { throw EngineError.missingScript }
        return try await withCheckedThrowingContinuation { continuation in
            let queue = DispatchQueue(label: "io.github.riffable.canvas-layout", qos: .userInitiated)
            queue.async {
                do { continuation.resume(returning: try CanvasLayoutEngine(locale: locale, scriptURL: url, queue: queue)) } catch { continuation.resume(throwing: error) }
            }
        }
    }

    private init(locale: String, scriptURL: URL, queue: DispatchQueue) throws {
        self.queue = queue
        let source = try String(contentsOf: scriptURL, encoding: .utf8)
        guard let context = JSContext() else { throw EngineError.script("no JavaScript context") }
        self.context = context
        var captured: String?
        context.exceptionHandler = { _, value in
            let stack = value?.objectForKeyedSubscript("stack")?.toString() ?? ""
            captured = [value?.toString(), stack == "undefined" ? nil : stack].compactMap { $0 }.joined(separator: "\n")
        }
        context.evaluateScript(source, withSourceURL: scriptURL)
        if let captured { throw EngineError.script(captured) }
        guard let canvas = context.objectForKeyedSubscript("CanvasLayout"), !canvas.isUndefined else { throw EngineError.script("CanvasLayout is not defined") }
        self.canvas = canvas
        let table = canvas.invokeMethod("configure", withArguments: [locale])?.toString() ?? "{}"
        if let captured { throw EngineError.script(captured) }
        strings = (try? JSONDecoder().decode([String: String].self, from: Data(table.utf8))) ?? [:]
        context.exceptionHandler = { [unowned self] _, value in
            let stack = value?.objectForKeyedSubscript("stack")?.toString() ?? ""
            thrown = [value?.toString(), stack == "undefined" ? nil : stack].compactMap { $0 }.joined(separator: "\n")
        }
    }

    // MARK: State, mirroring what the web view keeps

    /// Every conversation the app knows and the one whose canvas this is; the family (what it was forked from, what was forked from it) is derived from them.
    func setSessions(focus: String, _ sessions: [CanvasSessionInput]) async throws {
        let json = try Self.json(sessions)
        _ = try await call("setSessions", focus, json)
    }

    func setProjects(_ projects: [CanvasProjectInput]) async throws {
        let json = try Self.json(projects)
        _ = try await call("setProjects", json)
    }

    /// Stores a conversation's outline (the API's JSON array) and says which turns to read rows for, from which position: those that changed since they were folded.
    func setOutline(session: String, json: Data) async throws -> CanvasOutlineDiff {
        let reply = try await call("setOutline", session, Self.string(json))
        return try JSONDecoder().decode(CanvasOutlineDiff.self, from: Data(reply.utf8))
    }

    /// A read of rows failed: those turns are asked for again with the next outline.
    func failTurns(session: String, turns: [String]) async throws {
        _ = try await call("failTurns", session, Self.string(JSONEncoder().encode(turns)))
    }

    /// Folds [turns] from [rows] (the API's JSON array); only those turns are folded again.
    func setTurnRows(session: String, turns: [String], rows: Data, now: Date = Date()) async throws {
        _ = try await call("setTurnRows", session, Self.string(JSONEncoder().encode(turns)), Self.string(rows), Self.millis(now))
    }

    /// A subagent's lane: its rows folded whole. Pass nil rows to mark it as being read.
    func setLane(session: String, lane: String, rows: Data?, now: Date = Date()) async throws {
        _ = try await call("setLane", session, lane, rows.map { Self.string($0) as Any } ?? NSNull(), Self.millis(now))
    }

    /// A lane that failed to read, or that the reader closed; it is not offered in `wants` again until set.
    func dropLane(session: String, lane: String) async throws {
        _ = try await call("dropLane", session, lane)
    }

    /// Runs (the API's JSON array): what a turn cost.
    func setRuns(_ json: Data) async throws {
        _ = try await call("setRuns", Self.string(json))
    }

    /// One-sentence answers by `session|turn`; nil when summaries are off.
    func setSummaries(_ summaries: [String: String]?) async throws {
        let json = try summaries.map { Self.string(try JSONEncoder().encode($0)) as Any } ?? NSNull()
        _ = try await call("setSummaries", json)
    }

    /// Artifacts whose image would not load leave the track.
    func setBroken(_ keys: Set<String>) async throws {
        _ = try await call("setBroken", Self.string(JSONEncoder().encode(keys.sorted())))
    }

    // MARK: Results

    /// The layout as JSON, undecoded; `layout` is this plus `CanvasLayout.decode`.
    func layoutJSON(level: CanvasLevel, now: Date = Date(), next: Bool = false, sending: Bool = false) async throws -> String {
        let options = "{\"next\":\(next),\"sending\":\(sending)}"
        return try await call("layout", level.rawValue, Self.millis(now), options)
    }

    /// Lays the family out at [level]. A running turn's column stretches with [now], rounded to ten seconds inside, so ask again as time passes.
    func layout(level: CanvasLevel, now: Date = Date(), next: Bool = false, sending: Bool = false) async throws -> CanvasLayout {
        try CanvasLayout.decode(try await layoutJSON(level: level, now: now, next: next, sending: sending))
    }

    /// The inspector's content for a node of the last layout.
    func detail(node: String) async throws -> CanvasNodeDetail? {
        let reply = try await call("detail", node)
        return try JSONDecoder().decode(CanvasNodeDetail?.self, from: Data(reply.utf8))
    }

    /// The tooltip of call [index] of a strip or bar of the last layout.
    func tip(node: String, index: Int) async throws -> CanvasTip? {
        let reply = try await call("tip", node, index)
        return try JSONDecoder().decode(CanvasTip?.self, from: Data(reply.utf8))
    }

    // MARK: Plumbing

    private func call(_ method: String, _ arguments: Any...) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.thrown = nil
                let value = self.canvas.invokeMethod(method, withArguments: arguments)
                if let thrown = self.thrown {
                    continuation.resume(throwing: EngineError.script("\(method): \(thrown)"))
                } else {
                    continuation.resume(returning: value?.isString == true ? value!.toString() : "")
                }
            }
        }
    }

    private static func millis(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }
    private static func string(_ data: Data) -> String { String(decoding: data, as: UTF8.self) }
    private static func json<T: Encodable>(_ value: T) throws -> String { string(try JSONEncoder().encode(value)) }
}
