import XCTest
import RiffetKit
@testable import Riffet

final class ServerAddressTests: XCTestCase {
    func testNormalizesOnlyAPlainServerOrigin() throws {
        XCTAssertEqual(try ServerAddress.normalized("  Mac.local:4141/ \n").absoluteString, "http://Mac.local:4141")
        XCTAssertEqual(try ServerAddress.normalized("HTTPS://mac.local/").scheme, "https")
        XCTAssertEqual(try ServerAddress.normalized("http://[::1]:19471/").port, 19471)
        for invalid in ["", "ftp://mac.local", "http://user:secret@mac.local", "http://mac.local/api", "http://mac.local?code=secret", "http://mac.local#token", "http://mac.local:0", "http://mac.local:65536"] {
            XCTAssertThrowsError(try ServerAddress.normalized(invalid), invalid)
        }
    }
    func testOriginIncludesSchemeHostAndEffectivePort() {
        func origin(_ a: String, _ b: String) -> Bool { ServerAddress.sameOrigin(URL(string: a)!, URL(string: b)!) }
        XCTAssertTrue(origin("http://MAC.local/a", "http://mac.local:80/b"))
        XCTAssertTrue(origin("https://mac.local", "https://mac.local:443/a"))
        XCTAssertFalse(origin("https://mac.local", "http://mac.local"))
        XCTAssertFalse(origin("http://mac.local:4141", "http://mac.local:4142"))
        XCTAssertFalse(origin("https://mac.local", "https://mac.local.evil.example"))
        XCTAssertFalse(origin("http://127.0.0.1:4141", "http://localhost:4141"))
    }
}

@MainActor
final class DraftPersistenceTests: XCTestCase {
    private var server: String!
    override func setUp() { super.setUp(); server = "test-" + UUID().uuidString }
    override func tearDown() {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("riffet.ios.\(server!).") { UserDefaults.standard.removeObject(forKey: key) }
        super.tearDown()
    }
    private func attachment(_ id: String) -> Attachment {
        Attachment(id: id, name: "\(id).png", mimeType: "image/png", size: 1024, path: "attachments/\(id)", width: KotlinLong(value: 320), height: KotlinLong(value: 240))
    }
    func testRestoresEveryPartOfTheDraftAndKeepsServersAndSessionsIsolated() throws {
        let store = DraftStore(server: server)
        let draft = store.draft("one")
        let file = ImportedAttachment(id: UUID(), url: URL(fileURLWithPath: "/tmp/pending.png"), name: "pending.png", mimeType: "image/png", byteCount: 1024, width: 320, height: 240)
        draft.text = "保留中文草稿\nsecond line"
        draft.attachments = [attachment("uploaded")]
        draft.pendingFiles = [file]
        draft.references = [PromptContextReference(path: "src/login.swift", line: KotlinLong(value: 17), kind: nil, sessionId: nil, fromRunId: nil, title: nil)]
        draft.projectID = "project-one"; draft.backendName = "CODEX"; draft.profileID = "profile-one"
        draft.model = "model-one"; draft.mode = "agent"; draft.approval = "ask"
        store.setReadingAnchor("native-row-17", for: "one")
        store.flush()
        let restoredStore = DraftStore(server: server)
        let restored = restoredStore.draft("one")
        XCTAssertEqual(restored.text, draft.text)
        XCTAssertEqual(restored.attachments.first?.id, "uploaded")
        XCTAssertEqual(restored.attachments.first?.width?.int64Value, 320)
        XCTAssertEqual(restored.pendingFiles.first?.url, file.url)
        XCTAssertEqual(restored.pendingFiles.first?.id, file.id)
        XCTAssertEqual(restored.references.first?.path, "src/login.swift")
        XCTAssertEqual(restored.references.first?.line?.int64Value, 17)
        XCTAssertEqual(restored.projectID, "project-one"); XCTAssertEqual(restored.backendName, "CODEX")
        XCTAssertEqual(restored.profileID, "profile-one"); XCTAssertEqual(restored.model, "model-one")
        XCTAssertEqual(restored.mode, "agent"); XCTAssertEqual(restored.approval, "ask")
        XCTAssertEqual(restoredStore.readingAnchor("one"), "native-row-17")
        XCTAssertTrue(restoredStore.draft("two").text.isEmpty)
        XCTAssertTrue(DraftStore(server: server + "-other").draft("one").text.isEmpty)
        XCTAssertNil(restoredStore.readingAnchor("two"))
        XCTAssertFalse(restored.canSend, "a pending file must be uploaded before a send can begin")
    }
    func testSuccessfulSendClearsOnlyItsSubmittedSnapshot() {
        let draft = DraftStore(server: server).draft("one")
        let sentAttachment = attachment("sent"), newAttachment = attachment("new")
        let sentReference = PromptContextReference(path: "sent.swift", line: nil, kind: nil, sessionId: nil, fromRunId: nil, title: nil)
        let newReference = PromptContextReference(path: "new.swift", line: nil, kind: nil, sessionId: nil, fromRunId: nil, title: nil)
        draft.text = "submitted text"; draft.attachments = [sentAttachment]; draft.references = [sentReference]
        draft.text = "edited while request was in flight"
        draft.attachments.append(newAttachment); draft.references.append(newReference)
        draft.clear(sentText: "submitted text", sentAttachments: [sentAttachment], sentReferences: [sentReference])
        let restored = DraftStore(server: server).draft("one")
        XCTAssertEqual(restored.text, "edited while request was in flight")
        XCTAssertEqual(restored.attachments.map(\.id), ["new"])
        XCTAssertEqual(restored.references.map(\.path), ["new.swift"])
        restored.clear(sentText: restored.text, sentAttachments: restored.attachments, sentReferences: restored.references)
        XCTAssertFalse(DraftStore(server: server).draft("one").canSend)
    }
}
