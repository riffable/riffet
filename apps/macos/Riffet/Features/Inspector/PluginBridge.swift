import AppKit
import Foundation

/*
 * The serving side of the plugin message bridge (packages/plugin-web/src/bridge.ts) for one web view,
 * the Mac counterpart of apps/web/src/plugins/isolated/bridgeHost.ts, with the same checks in the same
 * order: the request's id, the rate and pending limits, its size, its method, the package's
 * capabilities, the params, and only then a service. It knows nothing of WebKit: it is handed request
 * text and a way to send reply text, so who is calling is settled by the web view that owns the
 * handler, never by a field of a request. Closing it aborts what is pending and drops late replies.
 */

/// `BRIDGE_LIMITS` of the protocol.
enum PluginBridgeLimits {
    /// Serialized size of one request, counted in UTF-16 units as JavaScript counts a string.
    static let requestBytes = 64 * 1024
    /// Serialized size of one result, counted the same way.
    static let replyBytes = 1024 * 1024
    /// Requests answered at once.
    static let pending = 16
    /// A token bucket: a burst this large, refilled at `perSecond`.
    static let burst = 60.0
    static let perSecond = 30.0
    /// Characters of a notification or a path.
    static let text = 500
    static let rows = 200
    /// The most a timeline page may weigh, as the server counts it.
    static let pageBytes = 128 * 1024
}

enum PluginBridgeErrorCode: String {
    case invalidRequest = "invalid_request"
    case unknownMethod = "unknown_method"
    case invalidParams = "invalid_params"
    case denied, forbidden
    case notFound = "not_found"
    case rateLimited = "rate_limited"
    case tooLarge = "too_large"
    case unsupported, failed, aborted, timeout, closed
}

struct PluginBridgeFailure: Error {
    let code: PluginBridgeErrorCode
    let message: String

    init(_ code: PluginBridgeErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }
}

/// The server answered a bridge read with a status other than success.
struct PluginBridgeStatusError: Error {
    let status: Int
}

enum PluginBridgeMethod: String, CaseIterable {
    case hostInfo = "host.info"
    case projectsList = "projects.list"
    case sessionsList = "sessions.list"
    case sessionsRuns = "sessions.runs"
    case contextGet = "context.get"
    case themeGet = "theme.get"
    case sessionsGet = "sessions.get"
    case sessionsOutline = "sessions.outline"
    case sessionsTimeline = "sessions.timeline"
    case openSession = "navigation.openSession"
    case openPath = "navigation.openPath"
    case notifyInfo = "notify.info"
    case notifyError = "notify.error"
    case executeCommand = "commands.execute"

    /// `BRIDGE_CAPABILITY`: what a method needs; none means any view may call it.
    var capability: String? {
        switch self {
        case .sessionsGet, .sessionsOutline, .sessionsTimeline, .sessionsList, .sessionsRuns: "sessions.read"
        case .projectsList: "projects.read"
        default: nil
        }
    }
}

/// What the view is mounted for (`BridgeViewContext`). Fixed for the life of the channel except
/// `visible` and `locale`, which arrive as pushes.
struct PluginBridgeContext: Equatable {
    var serviceId: String
    var projectId: String?
    var sessionId: String?
    var instanceId: String
    var visible: Bool
    /// The app's language as a BCP-47 tag.
    var locale: String

    var json: [String: Any] {
        var value: [String: Any] = ["serviceId": serviceId, "instanceId": instanceId, "visible": visible, "locale": locale]
        if let projectId { value["projectId"] = projectId }
        if let sessionId { value["sessionId"] = sessionId }
        return value
    }
}

/// The palette in effect (`BridgeTheme`): `vars` maps `--<role>` to a CSS colour.
struct PluginBridgeTheme: Equatable {
    var scheme: String
    var vars: [String: String]

    var json: [String: Any] { ["scheme": scheme, "vars": vars] }
}

/// A conversation as a view may read it (`BridgeSession`): enough to name and place it, nothing that
/// routes or resumes it.
struct PluginBridgeSession {
    var id: String
    var projectId: String
    var title: String
    var state: String
    var backendId: String?
    var model: String?
    var mode: String
    var tags: [String]
    var archivedAt: String?
    var lastActivityAt: String?
    var createdAt: String
    var updatedAt: String

    var json: [String: Any] {
        var value: [String: Any] = ["id": id, "projectId": projectId, "title": title, "state": state, "mode": mode, "tags": tags, "createdAt": createdAt, "updatedAt": updatedAt]
        if let backendId, !backendId.isEmpty { value["backendId"] = backendId }
        if let model, !model.isEmpty { value["model"] = model }
        if let archivedAt, !archivedAt.isEmpty { value["archivedAt"] = archivedAt }
        if let lastActivityAt, !lastActivityAt.isEmpty { value["lastActivityAt"] = lastActivityAt }
        return value
    }
}

enum PluginNoticeTone {
    case info, error
}

/// What the package holds: the grant of the installed version, or what a trusted development package
/// asks for, and the commands it declares.
struct PluginBridgeGrant {
    /// The package's id; its commands are `<id>/<name>`.
    var packageId: String
    var capabilities: Set<String>
    var commands: Set<String>
}

/// The app's side of the bridge. The bridge has already settled who may ask and for which project;
/// these only do the work. The reads throw `PluginBridgeStatusError` or `CancellationError` as they
/// fail, and observe the cancellation of the call that awaits them.
@MainActor
protocol PluginBridgeServices: AnyObject {
    /// The context and palette as they are now; the host replaces them before it pushes a change.
    var context: PluginBridgeContext { get set }
    var theme: PluginBridgeTheme { get set }
    /// The conversation the app holds under this id, whichever project it belongs to.
    func sessions() -> [PluginBridgeSession]
    func projects() -> [[String: String]]
    func runs(sessionId: String) async throws -> [[String: Any]]
    func session(_ id: String) -> PluginBridgeSession?
    /// The turns of one lane, oldest first: a JSON array.
    func outline(sessionId: String, lane: String) async throws -> Any
    /// One page of a lane, as the server answers it: a JSON object.
    func timeline(sessionId: String, lane: String, from: Int, rows: Int) async throws -> Any
    /// Whether the user is working in the view now: it is shown and holds the keyboard focus. Steering
    /// the app follows the user's own action in the view, never a script on its own.
    var userIsInteracting: Bool { get }
    /// The web view that shows the page, handed over once it exists; `userIsInteracting` looks at it.
    func attach(_ view: NSView)
    func openSession(_ id: String)
    func openPath(_ path: String)
    func notify(_ tone: PluginNoticeTone, _ text: String)
    /// Runs the package's command `<pluginId>/<name>` on the server and answers what it answered
    /// (`CommandResult`), as parsed JSON; the host takes no action of its own from it.
    func execute(command: String, args: [String: Any]) async throws -> Any
}

extension PluginBridgeServices {
    func sessions() -> [PluginBridgeSession] { [] }
    func projects() -> [[String: String]] { [] }
    func runs(sessionId: String) async throws -> [[String: Any]] { throw PluginBridgeFailure(.unsupported, "This host has no run directory") }
}

@MainActor
final class PluginBridge {
    private let grant: PluginBridgeGrant
    private let services: PluginBridgeServices
    private let send: (String) -> Void
    private let now: () -> TimeInterval
    private var closed = false
    private var pending = 0
    private var tokens = PluginBridgeLimits.burst
    private var refilled: TimeInterval
    private var tasks: [Int: Task<Void, Never>] = [:]

    /// `send` receives the text of each reply and push; `now` is a clock in seconds.
    init(grant: PluginBridgeGrant, services: PluginBridgeServices, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }, send: @escaping (String) -> Void) {
        self.grant = grant
        self.services = services
        self.now = now
        self.send = send
        refilled = now()
    }

    /// Sends a push to the view; nothing once closed.
    func push(_ event: String, _ data: [String: Any]) {
        guard !closed, let text = Self.encode(["event": event, "data": data]) else { return }
        send(text)
    }

    /// Aborts every pending call and ends the channel. Idempotent.
    func close() {
        guard !closed else { return }
        closed = true
        for task in tasks.values { task.cancel() }
        tasks = [:]
    }

    /// One request as the page serialized it.
    func receive(_ text: String) {
        guard !closed else { return }
        let request: [String: Any]?
        let id: Int
        if text.utf16.count > PluginBridgeLimits.requestBytes {
            // Not parsed: the id is read from the head of the text, where the client writes it, so the
            // caller can be told. A request that does not start with one is ignored.
            guard let found = Self.leadingId(text) else { return }
            id = found
            request = nil
        } else {
            guard let object = Self.parse(text) as? [String: Any] else { return }
            if object["close"] as? Bool == true { close(); return }
            if let cancelled = Self.requestId(object["cancel"]) { tasks[cancelled]?.cancel(); return }
            guard let found = Self.requestId(object["id"]) else { return }
            id = found
            request = object
        }
        if tasks[id] != nil { return fail(id, .invalidRequest, "Request id is already pending") }
        if pending >= PluginBridgeLimits.pending || !takeToken() { return fail(id, .rateLimited, "Too many requests") }
        guard let request else { return fail(id, .tooLarge, "The request is too large") }
        guard let method = request["method"] as? String else { return fail(id, .invalidRequest, "method must be text") }
        guard let known = PluginBridgeMethod(rawValue: method) else { return fail(id, .unknownMethod, "Unknown method") }
        if let needed = known.capability, !grant.capabilities.contains(needed) { return fail(id, .denied, "This package does not hold \(needed)") }
        dispatch(id, known, request["params"])
    }

    // MARK: Methods

    private func dispatch(_ id: Int, _ method: PluginBridgeMethod, _ params: Any?) {
        do {
            switch method {
            case .hostInfo:
                try Self.expectNoParams(params)
                finish(id, .success(["platform": "macos", "webApiVersion": PluginEntry.webApiVersion, "bridgeVersion": PluginEntry.bridgeVersion, "renderers": ["tasks", "list", "form", "detail"], "methods": PluginBridgeMethod.allCases.map(\.rawValue), "execution": ["server": services.context.serviceId, "client": "macos"]]))
            case .projectsList:
                let input = try Self.only(params ?? [:], ["offset", "limit"])
                let projectId = services.context.projectId
                finish(id, .success(try page(input, services.projects().filter { $0["id"] == projectId })))
            case .sessionsList:
                let input = try Self.only(params ?? [:], ["offset", "limit"])
                let projectId = services.context.projectId
                finish(id, .success(try page(input, services.sessions().filter { $0.projectId == projectId }.map(\.json))))
            case .sessionsRuns:
                let input = try Self.only(params, ["sessionId", "offset", "limit"])
                let sessionId = try Self.text(input, "sessionId", max: 200)
                _ = try ownSession(sessionId)
                let offset = input["offset"] == nil ? 0 : try Self.integer(input, "offset", min: 0, max: 9_007_199_254_740_991)
                let limit = input["limit"] == nil ? 50 : try Self.integer(input, "limit", min: 1, max: PluginBridgeLimits.rows)
                later(id) { [services] in
                    let all = try await services.runs(sessionId: sessionId)
                    var reply: [String: Any] = ["items": Array(all.dropFirst(offset).prefix(limit))]
                    if offset + limit < all.count { reply["next"] = offset + limit }
                    return reply
                }
            case .contextGet:
                try Self.expectNoParams(params)
                finish(id, .success(services.context.json))
            case .themeGet:
                try Self.expectNoParams(params)
                finish(id, .success(services.theme.json))
            case .sessionsGet:
                let input = try Self.only(params, ["sessionId"])
                finish(id, .success(try ownSession(Self.text(input, "sessionId", max: 200)).json))
            case .sessionsOutline:
                let input = try Self.only(params, ["sessionId", "lane"])
                let sessionId = try Self.text(input, "sessionId", max: 200), lane = try Self.lane(input)
                _ = try ownSession(sessionId)
                later(id) { [services] in ["turns": try await services.outline(sessionId: sessionId, lane: lane)] }
            case .sessionsTimeline:
                let input = try Self.only(params, ["sessionId", "lane", "from", "rows"])
                let sessionId = try Self.text(input, "sessionId", max: 200), lane = try Self.lane(input)
                let from = try Self.integer(input, "from", min: 0, max: 9_007_199_254_740_991)
                let rows = input["rows"] == nil ? PluginBridgeLimits.rows : try Self.integer(input, "rows", min: 1, max: PluginBridgeLimits.rows)
                _ = try ownSession(sessionId)
                later(id) { [services] in try await services.timeline(sessionId: sessionId, lane: lane, from: from, rows: rows) }
            case .openSession:
                let sessionId = try Self.text(Self.only(params, ["sessionId"]), "sessionId", max: 200)
                try requireInteraction()
                services.openSession(try ownSession(sessionId).id)
                finish(id, .success(NSNull()))
            case .openPath:
                let path = try Self.projectPath(Self.only(params, ["path"]))
                try requireInteraction()
                // A file of the project the view belongs to; a view with no project has none.
                guard services.context.projectId != nil else { throw PluginBridgeFailure(.forbidden, "This view has no project") }
                services.openPath(path)
                finish(id, .success(NSNull()))
            case .notifyInfo, .notifyError:
                let text = try Self.text(Self.only(params, ["text"]), "text", max: PluginBridgeLimits.text)
                services.notify(method == .notifyError ? .error : .info, text)
                finish(id, .success(NSNull()))
            case .executeCommand:
                let input = try Self.only(params, ["id", "args"])
                let command = try Self.text(input, "id", max: 200)
                guard grant.commands.contains(command) else { throw PluginBridgeFailure(.forbidden, "The package does not declare this command") }
                // Only the package's own commands: `<pluginId>/<name>`.
                guard command.hasPrefix(grant.packageId + "/"), command.utf16.count > grant.packageId.utf16.count + 1 else { throw PluginBridgeFailure(.forbidden, "Not a command of this package") }
                let args = input["args"]
                if let args, !((args as? [String: Any])?.values.allSatisfy { $0 is String || $0 is NSNumber } ?? false) { throw Self.invalid("args must map names to text, numbers or booleans") }
                later(id) { [services] in try await services.execute(command: command, args: args as? [String: Any] ?? [:]) }
            }
        } catch {
            finish(id, .failure(error))
        }
    }

    private func page<T>(_ input: [String: Any], _ values: [T]) throws -> [String: Any] {
        let offset = input["offset"] == nil ? 0 : try Self.integer(input, "offset", min: 0, max: 9_007_199_254_740_991)
        let limit = input["limit"] == nil ? 50 : try Self.integer(input, "limit", min: 1, max: PluginBridgeLimits.rows)
        var reply: [String: Any] = ["items": Array(values.dropFirst(offset).prefix(limit))]
        if offset + limit < values.count { reply["next"] = offset + limit }
        return reply
    }

    private func requireInteraction() throws {
        if !services.userIsInteracting { throw PluginBridgeFailure(.denied, "Click in the view first") }
    }

    /// The conversation of the view's own project, or a refusal. Another project's conversation reads
    /// as absent, so a view cannot probe which ids exist.
    private func ownSession(_ sessionId: String) throws -> PluginBridgeSession {
        guard let session = services.session(sessionId), let projectId = services.context.projectId, session.projectId == projectId else {
            throw PluginBridgeFailure(.notFound, "No such conversation in this project")
        }
        return session
    }

    /// Answers `id` with what `work` returns, in a task `close()` cancels.
    private func later(_ id: Int, _ work: @escaping @MainActor () async throws -> Any) {
        pending += 1
        let key = id
        tasks[key] = Task { [weak self] in
            let outcome: Result<Any, Error>
            do { let value = try await work(); try Task.checkCancellation(); outcome = .success(value) } catch { outcome = .failure(error) }
            guard let self else { return }
            self.tasks[key] = nil
            self.pending -= 1
            self.finish(id, outcome)
        }
    }

    // MARK: Replies

    private func finish(_ id: Int, _ outcome: Result<Any, Error>) {
        guard !closed else { return }
        switch outcome {
        case .success(let result):
            guard let json = Self.fragment(result) else { return fail(id, .failed, "The request failed") }
            if json.utf16.count > PluginBridgeLimits.replyBytes { return fail(id, .tooLarge, "The result is too large") }
            send("{\"id\":\(id),\"result\":\(json)}")
        case .failure(let error):
            let body = Self.failure(error)
            fail(id, body.code, body.message)
        }
    }

    private func fail(_ id: Int, _ code: PluginBridgeErrorCode, _ message: String) {
        guard !closed, let text = Self.encode(["id": id, "error": ["code": code.rawValue, "message": message]]) else { return }
        send(text)
    }

    private func takeToken() -> Bool {
        let at = now()
        tokens = min(PluginBridgeLimits.burst, tokens + (at - refilled) * PluginBridgeLimits.perSecond)
        refilled = at
        guard tokens >= 1 else { return false }
        tokens -= 1
        return true
    }

    private static func failure(_ error: Error) -> PluginBridgeFailure {
        if let failure = error as? PluginBridgeFailure { return failure }
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return PluginBridgeFailure(.aborted, "The call was cancelled") }
        if let status = (error as? PluginBridgeStatusError)?.status, status > 0 { return PluginBridgeFailure(.failed, "The request failed (\(status))") }
        return PluginBridgeFailure(.failed, "The request failed")
    }

    // MARK: JSON

    private static func parse(_ text: String) -> Any? {
        try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
    }

    private static func encode(_ object: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// A result as JSON text; nil for a value that is not JSON.
    private static func fragment(_ value: Any) -> String? {
        if value is NSNull { return "null" }
        return encode(value)
    }

    /// The id of an oversized request, from `{"id":<digits>` at the head of its text.
    private static func leadingId(_ text: String) -> Int? {
        let head = String(decoding: text.utf8.prefix(32), as: UTF8.self)
        guard head.hasPrefix("{\"id\":") else { return nil }
        let digits = head.dropFirst(6).prefix { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty, digits.count <= 15 else { return nil }
        return Int(digits)
    }

    private static func requestId(_ value: Any?) -> Int? {
        number(value, min: 0, max: 9_007_199_254_740_991)
    }

    /// An integral JSON number in `min...max`; a boolean is not one.
    private static func number(_ value: Any?, min: Int, max: Int) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double == double.rounded(), double >= Double(min), double <= Double(max) else { return nil }
        return Int(double)
    }

    // MARK: Params

    private static func invalid(_ message: String) -> PluginBridgeFailure {
        PluginBridgeFailure(.invalidParams, message)
    }

    /// No params, or an empty object.
    private static func expectNoParams(_ params: Any?) throws {
        if let params, !((params as? [String: Any])?.isEmpty ?? false) { throw invalid("takes no params") }
    }

    /// Only the named keys may be present.
    private static func only(_ params: Any?, _ keys: Set<String>) throws -> [String: Any] {
        guard let record = params as? [String: Any] else { throw invalid("params must be an object") }
        if let extra = record.keys.sorted().first(where: { !keys.contains($0) }) { throw invalid("unknown param \(extra)") }
        return record
    }

    /// A required string of 1 to `max` characters with no control characters.
    private static func text(_ record: [String: Any], _ key: String, max: Int) throws -> String {
        guard let value = record[key] as? String, !value.isEmpty, value.utf16.count <= max,
              !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) else {
            throw invalid("\(key) must be text of at most \(max) characters")
        }
        return value
    }

    /// `main` or `sub:<id>`; `main` when absent.
    private static func lane(_ record: [String: Any]) throws -> String {
        guard let value = record["lane"] else { return "main" }
        if let lane = value as? String, lane == "main" || (lane.hasPrefix("sub:") && lane.utf16.count > 4 && lane.utf16.count <= 204) { return lane }
        throw invalid("lane must be main or sub:<id>")
    }

    private static func integer(_ record: [String: Any], _ key: String, min: Int, max: Int) throws -> Int {
        guard let value = number(record[key], min: min, max: max) else { throw invalid("\(key) must be an integer from \(min) to \(max)") }
        return value
    }

    /// A path inside the project: relative, no `..`, no drive letter. Returns it without a leading `./`.
    private static func projectPath(_ record: [String: Any]) throws -> String {
        let value = try text(record, "path", max: PluginBridgeLimits.text)
        let scalars = Array(value.unicodeScalars)
        let driveLetter = scalars.count >= 2 && scalars[1] == ":" && scalars[0].isASCII && scalars[0].properties.isAlphabetic
        if value.hasPrefix("/") || value.hasPrefix("\\") || driveLetter || value.contains("\\") || value.split(separator: "/", omittingEmptySubsequences: false).contains("..") {
            throw invalid("path must be relative to the project root")
        }
        var path = Substring(value)
        while path.hasPrefix("./") { path = path.dropFirst(2) }
        return path.isEmpty ? "." : String(path)
    }
}
