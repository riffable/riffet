import Foundation
import Observation
import RiffetKit

/// What the 个人助理 needs from the server beyond RiffetKit's models: the project's `mainSessionId`,
/// the saved agent and model choice (`AppSettings.assistant`), its instructions and its memory
/// (docs/ASSISTANT.md §3). Read through `ServerJSON` until RiffetKit carries them.
@MainActor @Observable
final class AssistantModel {
    struct Choice: Equatable {
        var backendId: String?
        var profileId: String?
        var model: String?
    }

    struct Instructions: Decodable, Equatable {
        let text: String
        let custom: Bool
    }

    struct MemoryEntry: Decodable, Identifiable, Equatable {
        let name: String
        let text: String
        let modifiedAt: String
        var id: String { name }
    }

    struct Memory: Decodable, Equatable {
        let profile: String
        let index: String
        let entries: [MemoryEntry]
        let updatedAt: String?
    }

    private struct ProjectRow: Decodable {
        let id: String
        let system: String?
        let mainSessionId: String?
    }

    private struct SettingsRow: Decodable {
        struct Saved: Decodable {
            let backendId: String?
            let profileId: String?
            let model: String?
        }
        let assistant: Saved?
    }

    /// The conversation the project names as its main one; it may be archived or deleted, so check it against the list.
    private(set) var mainSessionId: String?
    private(set) var saved = Choice()
    /// The extensions page opens scoped to the assistant's directory once.
    var focusesExtensions = false
    @ObservationIgnored private var refreshing: Task<Void, Never>?

    func refresh() async {
        if let refreshing { return await refreshing.value }
        let task = Task { @MainActor in
            if let rows = try? await ServerJSON.send("GET", "/api/projects", as: [ProjectRow].self),
               let row = rows.first(where: { $0.system == "assistant" }), row.mainSessionId != mainSessionId {
                mainSessionId = row.mainSessionId
            }
            if let settings = try? await ServerJSON.send("GET", "/api/settings", as: SettingsRow.self) {
                let choice = Choice(backendId: settings.assistant?.backendId, profileId: settings.assistant?.profileId, model: settings.assistant?.model)
                if choice != saved { saved = choice }
            }
        }
        refreshing = task
        await task.value
        refreshing = nil
    }

    /// Keeps the agent, provider and model the reader picked on the assistant's composer, on every device.
    func save(_ choice: Choice) {
        guard choice != saved else { return }
        saved = choice
        Task {
            let body: [String: Any] = ["assistant": [
                "backendId": choice.backendId as Any? ?? NSNull(),
                "profileId": choice.profileId as Any? ?? NSNull(),
                "model": choice.model as Any? ?? NSNull(),
            ]]
            _ = try? await ServerJSON.send("PATCH", "/api/settings", body: body, as: ServerJSON.Done.self)
        }
    }

    func instructions() async throws -> Instructions {
        try await ServerJSON.send("GET", "/api/assistant/instructions")
    }

    /// Saves [text] as AGENTS.md; nil restores Riffet's own.
    func saveInstructions(_ text: String?) async throws -> Instructions {
        try await ServerJSON.send("PUT", "/api/assistant/instructions", body: ["text": text as Any? ?? NSNull()])
    }

    func memory() async throws -> Memory {
        try await ServerJSON.send("GET", "/api/assistant/memory")
    }
}
