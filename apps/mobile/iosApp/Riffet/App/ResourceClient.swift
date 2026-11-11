import Foundation
import RiffetKit

/// Native previews use the same origin boundary as Ktor. A redirect never carries a device token to another host.
@MainActor
final class ResourceClient {
    let baseURL: URL
    private let host: IOSHost
    private let redirects = ResourceRedirectPolicy()
    private lazy var session = URLSession(configuration: .ephemeral, delegate: redirects, delegateQueue: nil)
    init(baseURL: URL, host: IOSHost) { self.baseURL = baseURL; self.host = host }

    func request(for url: URL) async throws -> URLRequest {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil else {
            throw ClientFailure(String(localized: "不支持这个资源地址", bundle: .riffet))
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        if ServerAddress.sameOrigin(url, baseURL), let authorization = try await host.authorizationFor(url: url.absoluteString) {
            request.setValue(authorization, forHTTPHeaderField: "Authorization")
        }
        return request
    }
    func data(for url: URL) async throws -> Data {
        if url.scheme == "data", let comma = url.absoluteString.firstIndex(of: ","),
           let data = Data(base64Encoded: String(url.absoluteString[url.absoluteString.index(after: comma)...])) { return data }
        let (body, response) = try await session.data(for: request(for: url))
        try validate(response)
        guard body.count <= 32 * 1024 * 1024 else { throw ClientFailure(String(localized: "资源过大，请下载后预览", bundle: .riffet)) }
        return body
    }
    func file(for url: URL, name: String) async throws -> URL {
        let (temporary, response) = try await session.download(for: request(for: url))
        try validate(response)
        // A server path such as `/api/attachments/<id>` has no extension; the response's type supplies one.
        let name = (name as NSString).pathExtension.isEmpty ? response.suggestedFilename ?? name : name
        return try await Task.detached(priority: .userInitiated) {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("riffet-downloads/\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let leaf = (name as NSString).lastPathComponent
            let output = directory.appendingPathComponent(leaf.isEmpty || leaf == "." || leaf == ".." ? "download" : leaf)
            try FileManager.default.moveItem(at: temporary, to: output)
            return output
        }.value
    }
    func attachmentURL(_ id: String) -> URL? { endpoint("/api/attachments/\(id)") }
    func fileURL(projectID: String, path: String, image: Bool = false) -> URL? {
        endpoint("/api/projects/\(projectID)/file/\(image ? "image" : "raw")", query: [URLQueryItem(name: "path", value: path)])
    }
    func endpoint(_ path: String, query: [URLQueryItem] = []) -> URL? {
        var value = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        value?.path = path
        value?.queryItems = query.isEmpty ? nil : query
        return value?.url
    }
    private func validate(_ response: URLResponse) throws {
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw ClientFailure(status == 401 ? String(localized: "连接授权已失效，请重新配对", bundle: .riffet) : String(localized: "无法加载资源（HTTP \(status)）", bundle: .riffet))
        }
    }
}

private final class ResourceRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let original = task.originalRequest?.url, let next = request.url,
              ["http", "https"].contains(next.scheme?.lowercased() ?? ""),
              ServerAddress.sameOrigin(original, next) else { completionHandler(nil); return }
        completionHandler(request)
    }
}

enum ServerAddress {
    static func normalized(_ raw: String) throws -> URL {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = text.contains("://") ? text : "http://" + text
        guard var components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              components.port.map({ (1...65535).contains($0) }) ?? true else {
            throw ClientFailure(String(localized: "请输入服务器地址，例如 http://Mac.local:4337；不要包含路径、账号或配对码", bundle: .riffet))
        }
        components.scheme = scheme; components.path = ""
        // A bare plain-HTTP host is the `riffet` launcher's port; `https://host` keeps 443 (a TLS front door).
        if scheme == "http", components.port == nil { components.port = 4337 }
        guard let url = components.url else { throw ClientFailure(String(localized: "服务器地址无效", bundle: .riffet)) }
        return url
    }
    static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
        func port(_ url: URL) -> Int { url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80) }
        return left.scheme?.lowercased() == right.scheme?.lowercased() &&
            left.host?.lowercased() == right.host?.lowercased() && port(left) == port(right)
    }
}
