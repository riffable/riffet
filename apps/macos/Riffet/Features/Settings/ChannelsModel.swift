import Foundation
import Observation

/// The bots of this server (`packages/contracts/src/channels.ts`), as `GET /api/channels` sends them.
struct ChannelCard: Codable, Equatable {
    struct Footer: Codable, Equatable {
        var model = true
        var changes = true
        var context = true
        var elapsed = true

        init() {}
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            model = try c.decodeIfPresent(Bool.self, forKey: .model) ?? true
            changes = try c.decodeIfPresent(Bool.self, forKey: .changes) ?? true
            context = try c.decodeIfPresent(Bool.self, forKey: .context) ?? true
            elapsed = try c.decodeIfPresent(Bool.self, forKey: .elapsed) ?? true
        }
    }

    var header = true
    var process = true
    var stopButton = true
    var footer = Footer()

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        header = try c.decodeIfPresent(Bool.self, forKey: .header) ?? true
        process = try c.decodeIfPresent(Bool.self, forKey: .process) ?? true
        stopButton = try c.decodeIfPresent(Bool.self, forKey: .stopButton) ?? true
        footer = try c.decodeIfPresent(Footer.self, forKey: .footer) ?? Footer()
    }
}

struct ChannelAccount: Decodable, Identifiable, Equatable {
    struct Status: Decodable, Equatable {
        let state: String
        let error: String?
        let lastEventAt: String?
    }

    struct Links: Decodable, Equatable {
        let open: String?
        let console: String?
    }

    let id: String
    let appId: String
    let domain: String
    var enabled: Bool
    let botName: String?
    let avatarUrl: String?
    let status: Status
    let links: Links
    var card: ChannelCard

    var name: String { botName ?? appId }
    var isLark: Bool { domain == "lark" }
}

struct ChannelIdentity: Decodable, Identifiable, Equatable {
    let id: String
    let account: String
    let userId: String
    let name: String?
    let boundAt: String
}

struct ChannelChat: Decodable, Identifiable, Equatable {
    let key: String
    let account: String
    let chatId: String
    let chatType: String
    let name: String?
    var projectId: String?
    var flat: Bool

    var id: String { key }
    var isGroup: Bool { chatType == "group" }
}

struct ChannelsState: Decodable, Equatable {
    var accounts: [ChannelAccount]
    var identities: [ChannelIdentity]
    var chats: [ChannelChat]
}

struct ChannelHealth: Decodable, Equatable {
    let connected: Bool
    let activated: Bool?
    let missingScopes: [String]?
    let grantUrl: String?
    let lastEventAt: String?
    let needsLongConnection: Bool?
}

struct ChannelBindCode: Decodable, Equatable {
    let code: String
    let expiresAt: String
}

struct ChannelRegistration: Decodable {
    let id: String
    let url: String
    let expiresAt: String
}

struct ChannelRegistrationState: Decodable {
    let state: String
    let accountId: String?
    let error: String?
}

/// The routes of `/api/channels`; RiffetKit has none of them.
@MainActor
enum ChannelsAPI {
    private static let root = "/api/channels"

    static func state() async throws -> ChannelsState { try await ServerJSON.send("GET", root) }

    static func create(appId: String, appSecret: String, domain: String) async throws -> ChannelAccount {
        try await ServerJSON.send("POST", "\(root)/accounts", body: ["kind": "feishu", "appId": appId, "appSecret": appSecret, "domain": domain, "enabled": true])
    }

    @discardableResult
    static func update(_ id: String, _ patch: [String: Any]) async throws -> ChannelAccount {
        try await ServerJSON.send("PATCH", "\(root)/accounts/\(ServerJSON.segment(id))", body: patch)
    }

    static func delete(_ id: String) async throws {
        _ = try await ServerJSON.send("DELETE", "\(root)/accounts/\(ServerJSON.segment(id))", as: ServerJSON.Done.self)
    }

    static func bindCode(_ accountId: String) async throws -> ChannelBindCode {
        try await ServerJSON.send("POST", "\(root)/accounts/\(ServerJSON.segment(accountId))/bind-code")
    }

    static func health(_ accountId: String, refresh: Bool = false) async throws -> ChannelHealth {
        try await ServerJSON.send("GET", "\(root)/accounts/\(ServerJSON.segment(accountId))/health", query: refresh ? [URLQueryItem(name: "refresh", value: "1")] : [])
    }

    static func deleteIdentity(_ id: String) async throws {
        _ = try await ServerJSON.send("DELETE", "\(root)/identities/\(ServerJSON.segment(id))", as: ServerJSON.Done.self)
    }

    static func updateChat(_ key: String, _ patch: [String: Any]) async throws {
        _ = try await ServerJSON.send("PATCH", "\(root)/chats/\(ServerJSON.segment(key))", body: patch, as: ServerJSON.Done.self)
    }

    static func deleteChat(_ key: String) async throws {
        _ = try await ServerJSON.send("DELETE", "\(root)/chats/\(ServerJSON.segment(key))", as: ServerJSON.Done.self)
    }

    static func createRegistration(appId: String?) async throws -> ChannelRegistration {
        var body: [String: Any] = ["kind": "feishu"]
        if let appId { body["appId"] = appId }
        return try await ServerJSON.send("POST", "\(root)/registrations", body: body)
    }

    static func registration(_ id: String) async throws -> ChannelRegistrationState {
        try await ServerJSON.send("GET", "\(root)/registrations/\(ServerJSON.segment(id))")
    }

    static func deleteRegistration(_ id: String) async {
        _ = try? await ServerJSON.send("DELETE", "\(root)/registrations/\(ServerJSON.segment(id))", as: ServerJSON.Done.self)
    }
}

/// What the page shows: the server's bots and each one's live checks.
@MainActor
@Observable
final class ChannelsModel {
    private(set) var state: ChannelsState?
    private(set) var healths: [String: ChannelHealth] = [:]
    private(set) var loadError: String?
    private(set) var busy = false
    var error: String?

    func reload() async {
        do {
            state = try await ChannelsAPI.state()
            loadError = nil
        } catch {
            if state == nil { loadError = error.riffetMessage } else { self.error = error.riffetMessage }
            return
        }
        for account in state?.accounts ?? [] {
            if let health = try? await ChannelsAPI.health(account.id) { healths[account.id] = health }
        }
    }

    func refreshHealth(_ accountId: String) async {
        if let health = try? await ChannelsAPI.health(accountId, refresh: true) { healths[accountId] = health }
    }

    /// One write at a time; the page is read again afterwards whatever happened.
    func perform(_ action: () async throws -> Void) async {
        busy = true
        error = nil
        do { try await action() } catch { self.error = error.riffetMessage }
        busy = false
        await reload()
    }

    /// A card switch shows at once; a refused write is put back by the reload.
    func setCard(_ accountId: String, _ patch: [String: Any], apply: (inout ChannelCard) -> Void) async {
        if let index = state?.accounts.firstIndex(where: { $0.id == accountId }) { apply(&state!.accounts[index].card) }
        await perform { try await ChannelsAPI.update(accountId, ["card": patch]) }
    }

    /// What still stands between a connected bot and its first message.
    func pending(_ account: ChannelAccount) -> Int {
        guard let health = healths[account.id] else { return 0 }
        return [
            !health.connected && account.enabled,
            health.activated == false,
            !(health.missingScopes ?? []).isEmpty,
            (health.lastEventAt ?? account.status.lastEventAt) == nil,
            health.needsLongConnection == true,
        ].filter { $0 }.count
    }
}
