import AppKit
import Foundation
import ImageIO

// The live channel of the browser plugin (docs/BROWSER.md §5, `plugins/riffet/browser/protocol.ts`): the state of
// the conversation's browser and JPEG frames of its active tab come in; the user's input and answers go out.

struct BrowserLiveTab: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let url: String
    let active: Bool
}

struct BrowserViewport: Decodable, Equatable {
    let width: Double
    let height: Double
}

/// What the agent waits on the user for: a risky step to allow, or the browser handed over.
struct BrowserPending: Decodable, Equatable {
    let id: String
    let kind: String
    let category: String?
    let target: String?
    let reason: String?
    let url: String
}

struct BrowserLiveState: Decodable, Equatable {
    let installed: Bool
    let running: Bool
    let tabs: [BrowserLiveTab]
    let viewport: BrowserViewport
    let pending: BrowserPending?
}

struct BrowserModifiers: Encodable, Equatable {
    var alt = false, ctrl = false, meta = false, shift = false

    init(_ flags: NSEvent.ModifierFlags) {
        alt = flags.contains(.option); ctrl = flags.contains(.control); meta = flags.contains(.command); shift = flags.contains(.shift)
    }

    var isEmpty: Bool { !alt && !ctrl && !meta && !shift }
}

/// One conversation's connection; built again for another conversation.
@MainActor
@Observable
final class BrowserLive {
    let sessionId: String
    private(set) var state: BrowserLiveState?
    private(set) var frame: CGImage?

    @ObservationIgnored private var task: URLSessionWebSocketTask?
    @ObservationIgnored private var lastMove = Date.distantPast

    init(sessionId: String) { self.sessionId = sessionId }

    /// Connects and reads until cancelled, reconnecting with backoff; the caller runs it while the panel is visible.
    func run() async {
        var delay: Double = 1
        while !Task.isCancelled {
            guard let request = Self.request(sessionId: sessionId) else { return }
            let socket = URLSession.shared.webSocketTask(with: request)
            socket.maximumMessageSize = 8 * 1024 * 1024
            task = socket
            socket.resume()
            let closedForGood = await receive(socket) { delay = 1 }
            socket.cancel(with: .goingAway, reason: nil)
            if task === socket { task = nil }
            if closedForGood || Task.isCancelled { return }
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 10)
        }
    }

    /// Reads messages until the socket fails; true when the server said the conversation does not exist.
    private func receive(_ socket: URLSessionWebSocketTask, connected: () -> Void) async -> Bool {
        var first = true
        while !Task.isCancelled {
            let message: URLSessionWebSocketTask.Message
            do { message = try await socket.receive() } catch { return socket.closeCode.rawValue == 4404 }
            if first { first = false; connected() }
            switch message {
            case .data(let data): await decode(data)
            case .string(let text):
                guard let data = text.data(using: .utf8), let value = try? JSONDecoder().decode(Envelope.self, from: data), value.type == "state",
                      let state = try? JSONDecoder().decode(BrowserLiveState.self, from: data) else { continue }
                if state != self.state { self.state = state }
            @unknown default: continue
            }
        }
        return false
    }

    private struct Envelope: Decodable { let type: String }

    /// Decodes off the main thread; only the newest frame is kept.
    private func decode(_ data: Data) async {
        let image = await Task.detached(priority: .userInitiated) { () -> CGImage? in
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            return CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        }.value
        if let image { frame = image }
    }

    /// The channel URL with this Mac's token, as every other request to the server carries it.
    private static func request(sessionId: String) -> URLRequest? {
        guard let base = AppModel.shared.host.api?.baseUrl,
              var components = URLComponents(string: base.hasSuffix("/") ? String(base.dropLast()) : base) else { return nil }
        components.path += "/api/integrations/riffet.browser/channels/live"
        components.queryItems = [URLQueryItem(name: "sessionId", value: sessionId)]
        guard let http = components.url else { return nil }
        var request = ProjectDownloads.authorized(http)
        guard var socketURL = request.url.flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }) else { return nil }
        socketURL.scheme = socketURL.scheme == "https" ? "wss" : "ws"
        request.url = socketURL.url
        return request
    }

    // MARK: Sending

    private func send(_ fields: [String: Any]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: fields), let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func modifiers(_ value: BrowserModifiers) -> [String: Any] {
        guard !value.isEmpty else { return [:] }
        return ["modifiers": ["alt": value.alt, "ctrl": value.ctrl, "meta": value.meta, "shift": value.shift]]
    }

    func mouse(_ action: String, at point: CGPoint, button: String = "left", clickCount: Int = 1, modifiers flags: BrowserModifiers) {
        if action == "move" {
            // About 60 moves a second is all a page needs.
            guard Date().timeIntervalSince(lastMove) > 0.016 else { return }
            lastMove = Date()
        }
        send(["type": "mouse", "action": action, "x": point.x, "y": point.y, "button": button, "clickCount": min(max(clickCount, 1), 3)].merging(modifiers(flags)) { $1 })
    }

    func wheel(at point: CGPoint, deltaX: Double, deltaY: Double) { send(["type": "wheel", "x": point.x, "y": point.y, "deltaX": deltaX, "deltaY": deltaY]) }
    func key(_ action: String, key: String, code: String?, modifiers flags: BrowserModifiers) {
        send(["type": "key", "action": action, "key": key].merging(code.map { ["code": $0] } ?? [:]) { $1 }.merging(modifiers(flags)) { $1 })
    }
    func text(_ text: String) { if !text.isEmpty { send(["type": "text", "text": text]) } }
    func navigate(_ url: String) { send(["type": "navigate", "url": url]) }
    func command(_ type: String) { send(["type": type]) }
    func select(_ tab: String) { send(["type": "select", "tab": tab]) }
    func answer(_ id: String, allow: Bool) { send(["type": "answer", "id": id, "allow": allow]) }
}
