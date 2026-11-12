import Foundation

/// JSON calls to the connected server for routes RiffetKit has no method for yet (bots, the share
/// capability). Credentials come from `ProjectDownloads.authorized`, like every other native request.
@MainActor
enum ServerJSON {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private struct Envelope: Decodable {
        struct Detail: Decodable { let message: String? }
        let error: Detail?
    }

    /// An empty answer (`{ ok: true }`) that is not read.
    struct Done: Decodable {}

    /// One path segment, escaped the way the web client's `encodeURIComponent` does.
    static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
    }

    static func send<T: Decodable>(
        _ method: String = "GET",
        _ path: String,
        query: [URLQueryItem] = [],
        body: [String: Any]? = nil,
        as type: T.Type = T.self
    ) async throws -> T {
        guard let base = AppModel.shared.host.api?.baseUrl, var components = URLComponents(string: base + path) else {
            throw Failure(message: String(localized: "未连接"))
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw Failure(message: String(localized: "未连接")) }
        var request = ProjectDownloads.authorized(url)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode(Envelope.self, from: data))?.error?.message
            throw Failure(message: message ?? HTTPURLResponse.localizedString(forStatusCode: status))
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

extension ServerTime {
    private nonisolated(unsafe) static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    /// "3 minutes ago" for a server timestamp.
    static func relative(_ value: String?) -> String? {
        date(value).map { relativeFormatter.localizedString(for: $0, relativeTo: .now) }
    }
}
