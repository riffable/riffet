import AppKit
import RiffetKit

/// Files and folders of a project, saved to this Mac: `GET /api/projects/:id/file/raw?download=1`
/// for one file, `GET /api/projects/:id/archive?path=` for a folder as ZIP (`apps/web/src/lib/files.ts`).
@MainActor
enum ProjectDownloads {
    static func rawURL(projectId: String, path: String, download: Bool = false) -> URL? {
        guard let base = AppModel.shared.host.api?.baseUrl else { return nil }
        guard var components = URLComponents(string: "\(base)/api/projects/\(projectId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectId)/file/raw") else { return nil }
        components.queryItems = [URLQueryItem(name: "path", value: path)] + (download ? [URLQueryItem(name: "download", value: "1")] : [])
        let encoded = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        components.percentEncodedQuery = encoded
        return components.url
    }

    /// Raw project file rendered by the server's visualization wrapper. Authorization is added to
    /// the native request below; the token is never included in the page URL or JavaScript.
    static func visualizationURL(projectId: String, path: String, scheme: String) -> URL? {
        guard let base = AppModel.shared.host.api?.baseUrl else { return nil }
        return visualizationURL(baseURL: base, projectId: projectId, path: path, scheme: scheme)
    }

    /// Pure URL construction is shared with the overload above so it can be checked independently
    /// of the app's active server connection.
    static func visualizationURL(baseURL: String, projectId: String, path: String, scheme: String) -> URL? {
        guard scheme == "light" || scheme == "dark" else { return nil }
        var segmentCharacters = CharacterSet.alphanumerics
        segmentCharacters.insert(charactersIn: "-._~")
        guard let escapedProject = projectId.addingPercentEncoding(withAllowedCharacters: segmentCharacters) else { return nil }
        let base = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        var components = URLComponents(string: "\(base)/api/projects/\(escapedProject)/file/raw")
        components?.queryItems = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "render", value: "visualize"),
            URLQueryItem(name: "scheme", value: scheme),
        ]
        return components?.url
    }

    static func archiveURL(projectId: String, path: String) -> URL? {
        guard let base = AppModel.shared.host.api?.baseUrl else { return nil }
        var components = URLComponents(string: "\(base)/api/projects/\(projectId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectId)/archive")
        components?.queryItems = [URLQueryItem(name: "path", value: path)]
        return components?.url
    }

    /// A request to the server with this device's token.
    static func authorized(_ url: URL) -> URLRequest {
        var address = url
        if let base = AppModel.shared.host.api?.baseUrl, allowsAuthorization(url, baseURL: base) {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            var query = components?.queryItems ?? []
            query.removeAll { $0.name == "features" }
            query.append(URLQueryItem(name: "features", value: "quick-chat,pi-agent,antigravity-agent,projectless-tasks,plugin-agents"))
            components?.queryItems = query
            address = components?.url ?? url
        }
        var request = URLRequest(url: address)
        if let base = AppModel.shared.host.api?.baseUrl, allowsAuthorization(url, baseURL: base) {
            request.setValue("quick-chat,pi-agent,antigravity-agent,projectless-tasks,plugin-agents", forHTTPHeaderField: "X-Riffet-Features")
        }
        if let base = AppModel.shared.host.api?.baseUrl, allowsAuthorization(url, baseURL: base),
           let token = AppSecrets.shared.read(account: tokenAccount(baseUrl: base)) {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    /// A textual URL prefix is not an authority boundary (host.attacker and /base-other).
    /// Compare the origin and normalized path before reading any device credential.
    static func allowsAuthorization(_ url: URL, baseURL: String) -> Bool {
        guard let target = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let base = URLComponents(string: baseURL),
              let scheme = base.scheme?.lowercased(), ["http", "https"].contains(scheme),
              target.scheme?.lowercased() == scheme,
              let host = base.host?.lowercased(), !host.isEmpty,
              target.host?.lowercased() == host,
              target.user == nil, target.password == nil, base.user == nil, base.password == nil else { return false }
        let basePort = base.port ?? (scheme == "https" ? 443 : 80)
        let targetPort = target.port ?? (scheme == "https" ? 443 : 80)
        guard (1...65535).contains(basePort), targetPort == basePort,
              let basePath = base.percentEncodedPath.removingPercentEncoding,
              let targetPath = target.percentEncodedPath.removingPercentEncoding,
              !basePath.contains("\\"), !targetPath.contains("\\") else { return false }
        let root = (basePath.isEmpty ? "/" : basePath as NSString).standardizingPath
        let path = (targetPath.isEmpty ? "/" : targetPath as NSString).standardizingPath
        return root == "/" || path == root || path.hasPrefix(root + "/")
    }

    /// The whole file as text, for "copy contents" on a preview the server cut short.
    static func text(projectId: String, path: String) async throws -> String {
        guard let url = rawURL(projectId: projectId, path: path) else { throw LocalPairing.Failure(message: String(localized: "未连接")) }
        let (data, response) = try await URLSession.shared.data(for: authorized(url))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw LocalPairing.Failure(message: String(localized: "无法读取完整的文件内容")) }
        return String(decoding: data, as: UTF8.self)
    }

    static func saveFile(projectId: String, path: String) async -> String? {
        guard let url = rawURL(projectId: projectId, path: path, download: true) else { return String(localized: "未连接") }
        return await save(url, suggestedName: (path as NSString).lastPathComponent)
    }

    static func saveAttachment(id: String, name: String) async -> String? {
        guard let api = AppModel.shared.host.api,
              let url = URL(string: "\(api.baseUrl)/api/attachments/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)") else { return String(localized: "未连接") }
        // Older message receipts carry only an id; resolve the original name before opening Save.
        let metadata = try? await api.attachmentMetadata(attachmentId: id)
        return await save(url, suggestedName: metadata?.name ?? name)
    }

    static func attachmentURL(id: String) -> URL? {
        guard let base = AppModel.shared.host.api?.baseUrl,
              let escaped = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) else { return nil }
        return URL(string: "\(base)/api/attachments/\(escaped)")
    }

    /// A private, correctly named local copy for Quick Look, including files on remote hosts.
    static func previewFile(_ url: URL, name: String) async throws -> URL {
        let (temporary, response) = try await URLSession.shared.download(for: authorized(url))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw LocalPairing.Failure(message: String(localized: "无法读取文件（\((response as? HTTPURLResponse)?.statusCode ?? 0)）"))
        }
        try Task.checkCancellation()
        let files = FileManager.default
        let directory = files.temporaryDirectory.appendingPathComponent("riffet-preview-\(UUID().uuidString)", isDirectory: true)
        do {
            try files.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            var safe = (name as NSString).lastPathComponent
            if safe.isEmpty || safe == "." || safe == ".." { safe = "file" }
            let local = directory.appendingPathComponent(safe)
            try files.moveItem(at: temporary, to: local)
            try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: local.path)
            return local
        } catch {
            try? files.removeItem(at: directory)
            throw error
        }
    }

    /// Checked first: a folder over the server's limits would otherwise save an error page.
    static func saveFolder(projectId: String, path: String, projectName: String) async -> String? {
        guard let api = AppModel.shared.host.api, let url = archiveURL(projectId: projectId, path: path) else { return String(localized: "未连接") }
        do {
            let info = try await api.archiveInfo(projectId: projectId, path: path)
            let name = info.name.hasSuffix(".zip") ? info.name : info.name + ".zip"
            return await save(url, suggestedName: name.isEmpty ? "\((path.isEmpty ? projectName : (path as NSString).lastPathComponent)).zip" : name)
        } catch {
            return error.riffetCode == "ARCHIVE_TOO_LARGE" ? String(localized: "文件夹太大，无法打包下载（上限 2 万个文件或 2 GiB）") : error.riffetMessage
        }
    }

    private static func save(_ url: URL, suggestedName: String) async -> String? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let destination = panel.url else { return nil }
        do {
            let (temporary, response) = try await URLSession.shared.download(for: authorized(url))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return String(localized: "下载失败（\((response as? HTTPURLResponse)?.statusCode ?? 0)）") }
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: temporary, to: destination)
            NSWorkspace.shared.activateFileViewerSelecting([destination])
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
