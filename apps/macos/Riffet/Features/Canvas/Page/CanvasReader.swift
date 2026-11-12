import Foundation

/// What the canvas reads from the server, with the authenticated client and the same routes `PluginBridgeServices` reads:
/// requests are made on the main actor (they carry the device's token), then sent and parsed off it. Each read returns the JSON
/// the layout engine takes, never decoded into models here.
@MainActor
struct CanvasReader {
    struct Failure: Error { var status: Int }

    private static let pageBytes = 1024 * 1024
    private static let pageRows = 500

    let base: String

    private func request(_ path: String) -> URLRequest? {
        URL(string: base + path).map { ProjectDownloads.authorized($0) }
    }

    private static func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? ""
    }

    /// The turns of a conversation's main lane, as the outline API's JSON array.
    func outline(session: String) async throws -> Data {
        guard let request = request("/api/v3/sessions/\(Self.component(session))/outline?lane=main") else { throw URLError(.badURL) }
        return try await Self.send(request) { object in
            let turns = (object as? [String: Any])?["turns"] ?? []
            return try JSONSerialization.data(withJSONObject: turns)
        }
    }

    /// A conversation's runs: the API's JSON array, their ids, and the output tokens of those still running.
    func runs(session: String) async throws -> (json: Data, ids: [String], running: [Running]) {
        guard let request = request("/api/sessions/\(Self.component(session))/runs") else { throw URLError(.badURL) }
        return try await Self.send(request) { object in
            let list = object as? [[String: Any]] ?? []
            let running = list.compactMap { run -> Running? in
                guard run["state"] as? String == "running", let id = run["id"] as? String,
                      let metrics = (run["native"] as? [String: Any])?["metrics"] as? [String: Any],
                      let tokens = metrics["outputTokens"] as? Double else { return nil }
                return Running(id: id, sessionId: run["sessionId"] as? String ?? session, tokens: tokens)
            }
            return (try JSONSerialization.data(withJSONObject: list), list.compactMap { $0["id"] as? String }, running)
        }
    }

    /// One page of a lane, already filtered; plain JSON values, handed across once.
    private struct Page: @unchecked Sendable { var rows: [Any], last: Double?, more: Bool }

    struct Running: Sendable { var id: String, sessionId: String, tokens: Double }

    /// The rows of a lane from [from] on, a page at a time; with [turns] only rows of those turns. A JSON array of rows.
    func rows(session: String, lane: String, from: Double, turns: Set<String>? = nil, pages: Int = 40) async throws -> Data {
        var rows: [Any] = []
        var position = from
        for _ in 0..<pages {
            try Task.checkCancellation()
            guard let request = request("/api/v3/sessions/\(Self.component(session))/timeline?lane=\(Self.component(lane))&from=\(Int(position))&rows=\(Self.pageRows)&budget=\(Self.pageBytes)") else { throw URLError(.badURL) }
            let page = try await Self.send(request) { object -> Page in
                let body = object as? [String: Any] ?? [:]
                let all = body["rows"] as? [[String: Any]] ?? []
                let kept = all.filter { row in turns.map { $0.contains(row["turn"] as? String ?? "") } ?? true }
                return Page(rows: kept, last: all.last?["pos"] as? Double, more: body["hasAfter"] as? Bool == true && !all.isEmpty)
            }
            rows.append(contentsOf: page.rows)
            guard page.more, let last = page.last else { break }
            position = last + 1
        }
        return try JSONSerialization.data(withJSONObject: rows)
    }

    /// One turn's one-sentence summary; nil when the server has none to give.
    func summary(session: String, turn: String) async throws -> String? {
        guard let request = request("/api/sessions/\(Self.component(session))/turns/\(Self.component(turn))/summary") else { throw URLError(.badURL) }
        return try await Self.send(request) { ($0 as? [String: Any])?["summary"] as? String }
    }

    /// The request for a file an agent wrote, through the session's media route.
    func media(session: String, path: String) -> URLRequest? {
        request("/api/sessions/\(Self.component(session))/media?path=\(Self.component(path))")
    }

    func attachment(_ id: String) -> URLRequest? { request("/api/attachments/\(Self.component(id))") }

    private nonisolated static func send<T: Sendable>(_ request: URLRequest, parse: @Sendable @escaping (Any) throws -> T) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Failure(status: status) }
        return try await Task.detached(priority: .userInitiated) {
            try parse(try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
        }.value
    }
}
