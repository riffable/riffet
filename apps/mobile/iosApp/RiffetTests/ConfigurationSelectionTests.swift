import XCTest
import RiffetKit
@testable import Riffet

@MainActor
final class ConfigurationSelectionTests: XCTestCase {
    private func catalog(available: Bool = true, profiles: [NativeBackendProfile] = [NativeBackendProfile(id: "new-profile", backendId: .cursor, name: "Gateway", description: nil, isDefault: nil, agentId: nil)]) -> NativeBackendCatalogEntry {
        NativeBackendCatalogEntry(backendId: .cursor, label: "Cursor", available: available, reason: nil, profiles: profiles,
            capabilities: NativeBackendCapabilities(backendId: .cursor, label: "Cursor", modes: [NativeBackendOption(id: "plan", label: "Plan", description: nil), NativeBackendOption(id: "agent", label: "Agent", description: nil)], permissions: [NativeBackendOption(id: "allowlist", label: "Allowlist", description: nil), NativeBackendOption(id: "auto-review", label: "Auto review", description: nil)], interactionTransport: .terminal,
                supportsResume: true, supportsInterrupt: true, supportsHistory: true, supportsModelSelection: true,
                supportsModeSelection: false, supportsPermissionSelection: false, supportsTerminal: nil, supportsPrewarm: nil,
                supportsInitialPromptArgs: nil, slashCommands: nil, inlineSkills: nil, supportsSteer: false, supportsRecovery: nil, supportsTargetedStop: nil, consumesProtocols: nil, agentId: nil, supportsSessionReferences: nil, supportsRiffetTools: false, extensionToggles: nil),
            models: [ModelInfo(value: "model-one", name: "Model One", configOptions: [], nativeVariants: nil, contextWindow: nil, aliases: nil)], defaultModel: "model-one", needsLogin: nil, agentId: nil, continuations: [])
    }
    private func status(approval: String? = nil, permission: String? = nil) -> NativeStatus {
        NativeStatus(phase: .idle, profilePending: nil, model: nil, permission: permission, approval: approval, transcript: nil, notice: nil, noticeLevel: nil, interaction: nil, outputRate: nil, activeTurnId: nil, activeTurn: nil, connection: nil, history: nil, activity: nil, runtimeControl: nil, queue: nil)
    }
    func testCreationDefaultsMatchTheDisplayedModeAndValidSavedPermission() {
        func resolve(_ draft: NewSessionDraft = NewSessionDraft(profileId: nil, model: nil, mode: nil, approval: nil), approval: String? = nil) -> NewSessionChoice {
            draft.resolve(catalog: catalog(), saved: NativeBackendDefaults(profileId: nil, model: nil, mode: nil, approval: approval), cursorModel: nil, listed: nil)
        }
        XCTAssertEqual(resolve().mode, "agent")
        XCTAssertEqual(resolve(NewSessionDraft(profileId: nil, model: nil, mode: "plan", approval: nil)).mode, "plan")
        XCTAssertEqual(resolve(approval: "auto-review").approval, "auto-review")
        XCTAssertEqual(resolve(approval: "removed").approval, "allowlist")
        XCTAssertEqual(resolve(NewSessionDraft(profileId: nil, model: nil, mode: nil, approval: "allowlist"), approval: "auto-review").approval, "allowlist")
    }
    func testCLIApprovalWinsAndCursorPermissionFallbackDoesNotAffectOtherAgents() {
        XCTAssertEqual(NativeConfigurationSummary.approval(status: status(approval: "auto-review", permission: "Run Everything"), backend: .cursor, sessionApproval: "allowlist"), "auto-review")
        XCTAssertEqual(NativeConfigurationSummary.approval(status: status(permission: "Run Everything"), backend: .cursor, sessionApproval: "allowlist"), "unrestricted")
        XCTAssertEqual(NativeConfigurationSummary.approval(status: status(permission: "Auto review"), backend: .cursor, sessionApproval: "allowlist"), "auto-review")
        XCTAssertEqual(NativeConfigurationSummary.approval(status: status(permission: "YOLO"), backend: .codex, sessionApproval: "read-only"), "read-only")
    }
    func testSavedModelAndPermissionBelongOnlyToTheirProvider() {
        let saved = NativeBackendDefaults(profileId: "new-profile", model: "saved-model?reasoning=high", mode: nil, approval: "auto-review")
        func model(_ profile: String?, saved: NativeBackendDefaults?, cursor: String?) -> String {
            let catalog = catalog(profiles: [NativeBackendProfile(id: "new-profile", backendId: .cursor, name: "Gateway", description: nil, isDefault: true, agentId: nil),
                                             NativeBackendProfile(id: "another-profile", backendId: .cursor, name: "Other", description: nil, isDefault: nil, agentId: nil)])
            return NewSessionDraft(profileId: profile, model: nil, mode: nil, approval: nil).resolve(catalog: catalog, saved: saved, cursorModel: cursor, listed: nil).model
        }
        XCTAssertEqual(model("new-profile", saved: saved, cursor: "legacy-cursor"), "saved-model?reasoning=high")
        XCTAssertEqual(model("another-profile", saved: saved, cursor: "legacy-cursor"), "model-one")
        XCTAssertEqual(model(nil, saved: nil, cursor: ""), "model-one")
    }
    func testModelChoiceCarriesProviderAndRejectsStaleProjectBackendOrUnknownModels() {
        let namespace = "configuration-test-" + UUID().uuidString
        defer {
            for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("riffet.ios.\(namespace).") { UserDefaults.standard.removeObject(forKey: key) }
        }
        let draft = DraftStore(server: namespace).draft("new")
        draft.projectID = "project-1"; draft.backendName = NativeBackendId.cursor.name
        draft.profileID = "old-profile"; draft.model = "previous-model"
        XCTAssertFalse(NativeConfigurationSummary.chooseModel(catalog: catalog(), projectID: "project-2", profileID: "new-profile", value: "model-one", draft: draft))
        XCTAssertFalse(NativeConfigurationSummary.chooseModel(catalog: catalog(available: false), projectID: "project-1", profileID: "new-profile", value: "model-one", draft: draft))
        XCTAssertFalse(NativeConfigurationSummary.chooseModel(catalog: catalog(), projectID: "project-1", profileID: "new-profile", value: "missing-model", draft: draft))
        XCTAssertEqual(draft.profileID, "old-profile"); XCTAssertEqual(draft.model, "previous-model")
        draft.backendName = NativeBackendId.codex.name
        XCTAssertFalse(NativeConfigurationSummary.chooseModel(catalog: catalog(), projectID: "project-1", profileID: "new-profile", value: "model-one", draft: draft))
        draft.backendName = NativeBackendId.cursor.name
        XCTAssertTrue(NativeConfigurationSummary.chooseModel(catalog: catalog(), projectID: "project-1", profileID: "new-profile", value: "model-one", draft: draft))
        XCTAssertEqual(draft.profileID, "new-profile"); XCTAssertEqual(draft.model, "model-one")
    }
}
