import XCTest
import RiffetKit
@testable import Riffet

@MainActor
final class DraftDurabilityTests: XCTestCase {
    private var server: String!
    override func setUp() { super.setUp(); server = "draft-durability-" + UUID().uuidString }
    override func tearDown() {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("riffet.ios.\(server!).") {
            UserDefaults.standard.removeObject(forKey: key)
        }
        super.tearDown()
    }

    func testBackgroundFlushPersistsBeforeScheduledSaveAndCancelledTaskCannotReappear() async throws {
        let store = DraftStore(server: server), draft = store.draft("flush")
        draft.text = "last input before background"
        draft.references = [PromptContextReference(path: "src/App.swift", line: nil, kind: nil, sessionId: nil, fromRunId: nil, title: nil)]
        store.flush()
        XCTAssertEqual(draft.persistenceWriteCount, 1)
        let restored = DraftStore(server: server).draft("flush")
        XCTAssertEqual(restored.text, draft.text)
        XCTAssertEqual(restored.references.first?.path, "src/App.swift")
        try await Task.sleep(for: .milliseconds(450))
        XCTAssertEqual(draft.persistenceWriteCount, 1, "flush cancels the queued actor save")
    }

    func testClearedSubmissionIsDurableAndOldDelayedEditCannotOverwriteNewInput() async throws {
        let draft = DraftStore(server: server).draft("clear")
        draft.text = "submitted text"
        draft.clear(sentText: "submitted text", sentAttachments: [])
        XCTAssertEqual(DraftStore(server: server).draft("clear").text, "", "successful send clears the persisted snapshot immediately")
        draft.text = "new text typed after sending"
        try await waitForPersistedText("new text typed after sending", key: "clear")
        XCTAssertEqual(DraftStore(server: server).draft("clear").text, "new text typed after sending")
        XCTAssertEqual(draft.persistenceWriteCount, 2)
    }

    func testCreationRecoveryIdentifierPersistsWithoutWaitingForScheduledSave() {
        let draft = DraftStore(server: server).draft("creation")
        draft.text = "create once"
        draft.pendingCreationID = "prepared-request-id"
        let restored = DraftStore(server: server).draft("creation")
        XCTAssertEqual(restored.text, "create once")
        XCTAssertEqual(restored.pendingCreationID, "prepared-request-id")
        draft.pendingCreationID = nil
        XCTAssertNil(DraftStore(server: server).draft("creation").pendingCreationID)
    }

    func testImportedFileMovesIntoDurableDraftStorageBeforeCacheIsRemoved() async throws {
        let sourceDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: sourceDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: sourceDirectory) }
        let source = sourceDirectory.appendingPathComponent("context.txt")
        let content = Data(repeating: 0x61, count: 1024 * 1024)
        try content.write(to: source)
        let file = ImportedAttachment(id: UUID(), url: source, name: "context.txt", mimeType: "text/plain", byteCount: content.count, width: nil, height: nil)
        let durable = try await Task.detached(priority: .userInitiated) {
            XCTAssertFalse(Thread.isMainThread)
            return try file.durableCopy()
        }.value
        defer { try? FileManager.default.removeItem(at: durable.url.deletingLastPathComponent()) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        XCTAssertEqual(try durable.data(), content)
        let store = DraftStore(server: server), draft = store.draft("file")
        draft.text = "read this file"; draft.pendingFiles = [durable]
        store.flush()
        let restored = DraftStore(server: server).draft("file")
        XCTAssertEqual(restored.pendingFiles.first?.url, durable.url)
        XCTAssertEqual(try restored.pendingFiles.first?.data(), content)
        XCTAssertFalse(restored.canSend, "file-only and unfinished uploads retain the existing send contract")
    }

    private func waitForPersistedText(_ expected: String, key: String) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            let savedKey = "riffet.ios.\(server!).draft.\(key)"
            if let data = UserDefaults.standard.data(forKey: savedKey),
               let json = try JSONSerialization.jsonObject(with: data) as? [String: Any], json["text"] as? String == expected { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTFail("queued draft was not persisted within the deadline")
    }
}
