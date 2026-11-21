import AppKit
import Foundation
import UserNotifications
import RiffetKit

/// The app's side of the plugin bridge for one view
/// (apps/web/src/plugins/isolated/services.ts): reads go through the user's own session via
/// `ProjectDownloads.authorized`, navigation through the workbench, and nothing returns a store or a
/// credential. The bridge has already settled who may ask and for which project.
@MainActor
final class WorkbenchPluginServices: PluginBridgeServices {
    var context: PluginBridgeContext
    var theme: PluginBridgeTheme

    private let workbench: Workbench
    private let base: String
    private let package: PluginWebPackage
    private weak var view: NSView?

    init(workbench: Workbench, base: String, package: PluginWebPackage, context: PluginBridgeContext, theme: PluginBridgeTheme) {
        self.workbench = workbench
        self.base = base
        self.package = package
        self.context = context
        self.theme = theme
    }

    func session(_ id: String) -> PluginBridgeSession? {
        guard let session = workbench.list.sessions.first(where: { $0.id == id }) else { return nil }
        return PluginBridgeSession(
            id: session.id, projectId: session.projectId, title: session.shownTitle, state: session.state.name.lowercased(),
            backendId: session.agent, model: session.model, mode: session.mode, tags: session.tags,
            archivedAt: session.archivedAt, lastActivityAt: session.lastActivityAt, createdAt: session.createdAt, updatedAt: session.updatedAt
        )
    }

    func sessions() -> [PluginBridgeSession] {
        workbench.list.sessions.filter { $0.projectId == context.projectId }.compactMap { session($0.id) }
    }
    func projects() -> [[String: String]] {
        workbench.list.projects.filter { $0.id == context.projectId }.map { ["id": $0.id, "name": $0.name] }
    }
    func runs(sessionId: String) async throws -> [[String: Any]] {
        let values = try await read("/api/sessions/\(Self.component(sessionId))/runs") as? [[String: Any]] ?? []
        return values.map { run in
            var result: [String: Any] = ["id": run["id"] ?? "", "state": run["state"] ?? ""]
            result["startedAt"] = run["createdAt"]
            if ["completed", "failed", "cancelled"].contains(run["state"] as? String ?? "") { result["endedAt"] = run["updatedAt"] }
            let native = run["native"] as? [String: Any], metrics = native?["metrics"] as? [String: Any]
            result["outputTokens"] = metrics?["outputTokens"]
            return result
        }
    }

    func outline(sessionId: String, lane: String) async throws -> Any {
        let reply = try await read("/api/v3/sessions/\(Self.component(sessionId))/outline?lane=\(Self.component(lane))")
        return (reply as? [String: Any])?["turns"] ?? []
    }

    func timeline(sessionId: String, lane: String, from: Int, rows: Int) async throws -> Any {
        try await read("/api/v3/sessions/\(Self.component(sessionId))/timeline?lane=\(Self.component(lane))&from=\(from)&rows=\(rows)&budget=\(PluginBridgeLimits.pageBytes)")
    }

    func attach(_ view: NSView) {
        self.view = view
    }

    /// The view is on screen and holds the keyboard focus (it is, or contains, the window's first responder).
    var userIsInteracting: Bool {
        guard context.visible, let view, let window = view.window, !view.isHidden, let responder = window.firstResponder as? NSView else { return false }
        return responder === view || responder.isDescendant(of: view)
    }

    func openSession(_ id: String) {
        if let session = workbench.list.sessions.first(where: { $0.id == id }) { workbench.open(session) }
    }

    func openPath(_ path: String) {
        // The files panel shows the project that is open; a view of another project does not steer it.
        if workbench.currentProjectId == context.projectId { workbench.preview(path: path) }
    }

    func openExternal(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    /// The Mac has no in-app notice that fits a plugin (the only one belongs to a conversation and
    /// reads as a bookmark), so a notice is a system notification. A package's notices replace one
    /// another, so it cannot fill the list.
    func notify(_ tone: PluginNoticeTone, _ text: String) {
        let content = UNMutableNotificationContent()
        content.title = "Riffet"
        content.body = "\(package.title): \(text)"
        if tone == .error { content.sound = .default }
        let request = UNNotificationRequest(identifier: "plugin-notice." + package.id, content: content, trigger: nil)
        Task { try? await UNUserNotificationCenter.current().add(request) }
    }

    /// The command is the package's own, `<pluginId>/<name>` (the bridge has checked that). The server
    /// answers with the result of the command; a fresh request id makes each call its own run.
    func execute(command: String, args: [String: Any]) async throws -> Any {
        let name = String(command.dropFirst(package.id.count + 1))
        guard let url = URL(string: base + "/api/integrations/\(Self.component(package.id))/commands/\(Self.component(name))") else { throw URLError(.badURL) }
        var body: [String: Any] = ["requestId": UUID().uuidString, "args": args]
        if let projectId = context.projectId { body["projectId"] = projectId }
        if let sessionId = context.sessionId { body["sessionId"] = sessionId }
        var request = ProjectDownloads.authorized(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw PluginBridgeStatusError(status: status) }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    // MARK: Reads

    private static func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? ""
    }

    /// A GET of the server, answered as parsed JSON.
    private func read(_ path: String) async throws -> Any {
        guard let url = URL(string: base + path) else { throw URLError(.badURL) }
        let (data, response) = try await URLSession.shared.data(for: ProjectDownloads.authorized(url))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw PluginBridgeStatusError(status: status) }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }
}

/// The entry script through the authenticated client, read no further than the limit.
enum PluginEntryFetcher {
    @MainActor
    static func fetch(_ url: URL) async throws -> Data {
        try await download(ProjectDownloads.authorized(url))
    }

    private nonisolated static func download(_ request: URLRequest) async throws -> Data {
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw PluginPageFailure("The view's script could not be read (\(status))") }
        if response.expectedContentLength > Int64(PluginEntry.maxBytes) { throw PluginPageFailure("The view's script is too large") }
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count > PluginEntry.maxBytes { throw PluginPageFailure("The view's script is too large") }
        }
        return data
    }
}
