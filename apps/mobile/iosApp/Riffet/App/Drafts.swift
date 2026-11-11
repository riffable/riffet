import Foundation
import Observation
import RiffetKit

@MainActor @Observable
final class DraftStore {
    private let prefix: String
    private var entries: [String: MessageDraft] = [:]
    @ObservationIgnored private var unloadedContent: [String: Bool] = [:]
    init(server: String) { prefix = "riffet.ios.\(server)." }
    func draft(_ key: String) -> MessageDraft {
        if let entry = entries[key] { return entry }
        let entry = MessageDraft(key: prefix + "draft." + key)
        entries[key] = entry
        return entry
    }
    /// Avoid constructing and retaining a draft for every row in a large session list.
    /// Existing entries remain observable, so editing a loaded draft updates its row immediately.
    func hasContent(_ key: String) -> Bool {
        if let entry = entries[key] { return entry.hasContent }
        if let saved = unloadedContent[key] { return saved }
        let saved = MessageDraft.savedHasContent(key: prefix + "draft." + key)
        unloadedContent[key] = saved
        return saved
    }
    func readingAnchor(_ sessionID: String) -> String? { UserDefaults.standard.string(forKey: prefix + "anchor." + sessionID) }
    func setReadingAnchor(_ anchor: String?, for sessionID: String) { UserDefaults.standard.set(anchor, forKey: prefix + "anchor." + sessionID) }
    func flush() { entries.values.forEach { $0.save() } }
    /// A deleted conversation's draft goes with it, unwritten.
    func discard(_ key: String) {
        entries[key] = nil
        unloadedContent[key] = nil
        UserDefaults.standard.removeObject(forKey: prefix + "draft." + key)
    }
}

@MainActor @Observable
final class MessageDraft {
    private(set) var textRevision = 0
    var text: String { didSet { if text != oldValue { textRevision += 1 }; scheduleSave() } }
    var attachments: [Attachment] { didSet { scheduleSave() } }
    var pendingFiles: [ImportedAttachment] { didSet { scheduleSave() } }
    var references: [PromptContextReference] { didSet { scheduleSave() } }
    var projectID: String? { didSet { scheduleSave() } }
    var backendName: String? { didSet { scheduleSave() } }
    var profileID: String? { didSet { scheduleSave() } }
    var model: String? { didSet { scheduleSave() } }
    var mode: String? { didSet { scheduleSave() } }
    var approval: String? { didSet { scheduleSave() } }
    var pendingCreationID: String? { didSet { save() } }
    var uploading = false
    var error: String?
    private let key: String
    @ObservationIgnored private var scheduledSave: Task<Void, Never>?
    // @Observable optional properties already have an implicit nil backing value, so
    // assigning them in init can run didSet. Restoring a draft must remain read-only.
    @ObservationIgnored private var restoring = true
    // A single queue orders writes across draft instances as well as individual fields.
    // Explicit save() drains earlier writes before persisting the current snapshot.
    private static let persistence = DispatchQueue(label: "io.github.riffetai.iphone.drafts", qos: .userInitiated)
    @ObservationIgnored private(set) var persistenceWriteCount = 0
    private struct SavedAttachment: Codable, Sendable {
        let id: String, name: String, mimeType: String, path: String
        let size: Int64
        let width: Int64?, height: Int64?
        init(_ value: Attachment) {
            id = value.id; name = value.name; mimeType = value.mimeType; path = value.path
            size = value.size; width = value.width?.int64Value; height = value.height?.int64Value
        }
        var value: Attachment { Attachment(id: id, name: name, mimeType: mimeType, size: size, path: path,
            width: width.map(KotlinLong.init(value:)), height: height.map(KotlinLong.init(value:))) }
    }
    private struct SavedReference: Codable, Sendable {
        let path: String
        let line: Int64?
        let kind: String?, sessionId: String?, fromRunId: String?, title: String?
        init(_ value: PromptContextReference) {
            path = value.path; line = value.line?.int64Value; kind = value.kind
            sessionId = value.sessionId; fromRunId = value.fromRunId; title = value.title
        }
        var value: PromptContextReference { PromptContextReference(path: path, line: line.map(KotlinLong.init(value:)), kind: kind, sessionId: sessionId, fromRunId: fromRunId, title: title) }
    }
    private struct SavedFile: Codable, Sendable {
        let id: UUID, url: URL, name: String, mimeType: String, byteCount: Int, width: Int?, height: Int?
        init(_ file: ImportedAttachment) {
            id = file.id; url = file.url; name = file.name; mimeType = file.mimeType; byteCount = file.byteCount; width = file.width; height = file.height
        }
        var value: ImportedAttachment { ImportedAttachment(id: id, url: url, name: name, mimeType: mimeType, byteCount: byteCount, width: width, height: height) }
    }
    private struct Snapshot: Codable, Sendable {
        let text: String
        let attachments: [SavedAttachment]
        let pendingFiles: [SavedFile]?
        let references: [SavedReference]?
        let pendingCreationID: String?
        let projectID: String?, backendName: String?, profileID: String?, model: String?, mode: String?, approval: String?
    }
    init(key: String) {
        self.key = key
        let saved = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) }
        text = saved?.text ?? ""; attachments = saved?.attachments.map(\.value) ?? []
        pendingFiles = saved?.pendingFiles?.map(\.value) ?? []
        references = saved?.references?.map(\.value) ?? []
        projectID = saved?.projectID; backendName = saved?.backendName; profileID = saved?.profileID
        model = saved?.model; mode = saved?.mode; approval = saved?.approval
        pendingCreationID = saved?.pendingCreationID
        restoring = false
    }
    var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !uploading && pendingFiles.isEmpty }
    var hasContent: Bool { !text.isEmpty || !attachments.isEmpty || !pendingFiles.isEmpty || !references.isEmpty }
    static func savedHasContent(key: String) -> Bool {
        guard let data = UserDefaults.standard.data(forKey: key),
              let saved = try? JSONDecoder().decode(Snapshot.self, from: data) else { return false }
        return !saved.text.isEmpty || !saved.attachments.isEmpty || !(saved.pendingFiles?.isEmpty ?? true) || !(saved.references?.isEmpty ?? true)
    }
    private func snapshot() -> Snapshot {
        Snapshot(text: text, attachments: attachments.map(SavedAttachment.init), pendingFiles: pendingFiles.map(SavedFile.init),
            references: references.map(SavedReference.init), pendingCreationID: pendingCreationID, projectID: projectID, backendName: backendName, profileID: profileID, model: model, mode: mode, approval: approval)
    }
    private func scheduleSave() {
        guard !restoring, scheduledSave == nil else { return }
        // Coalesce synchronous edits within this actor turn, not across a wall-clock
        // debounce window. The next actor job submits the latest snapshot immediately,
        // including when automation or the user terminates just after finishing input.
        scheduledSave = Task { [weak self] in
            guard let self, !Task.isCancelled else { return }
            self.scheduledSave = nil
            let snapshot = self.snapshot(), key = self.key
            self.persistenceWriteCount += 1
            Self.persistence.async {
                if let data = try? JSONEncoder().encode(snapshot) { UserDefaults.standard.set(data, forKey: key) }
            }
        }
    }
    /// Sending, backgrounding and closing use an immediate durability boundary. A queued
    /// edit never captures old state, and all earlier writes finish before this one returns.
    func save() {
        guard !restoring else { return }
        scheduledSave?.cancel(); scheduledSave = nil
        let snapshot = snapshot(), key = key
        persistenceWriteCount += 1
        Self.persistence.sync {
            if let data = try? JSONEncoder().encode(snapshot) { UserDefaults.standard.set(data, forKey: key) }
        }
    }
    func clear(sentText: String, sentAttachments: [Attachment], sentReferences: [PromptContextReference] = [], sentRevision: Int? = nil) {
        if (sentRevision == nil || textRevision == sentRevision) && text == sentText { text = "" }
        let ids = Set(sentAttachments.map(\.id))
        attachments.removeAll { ids.contains($0.id) }
        references.removeAll { sentReferences.contains($0) }
        save()
    }
    func add(files: [ImportedAttachment], workbench: Workbench, projectID: String) async {
        guard !uploading else { return }
        guard attachments.count + pendingFiles.count + files.count <= 20 else {
            files.forEach { $0.removeLocalCopy() }
            error = String(localized: "每条消息最多添加 20 个附件", bundle: .riffet); return
        }
        uploading = true; error = nil
        defer { uploading = false }
        do {
            for file in files {
                let durable = try await Task.detached(priority: .userInitiated) { try file.durableCopy() }.value
                pendingFiles.append(durable)
                save()
            }
        } catch { self.error = error.riffetMessage; return }
        await uploadPending(workbench: workbench, projectID: projectID)
    }
    func retry(workbench: Workbench, projectID: String) async {
        guard !uploading else { return }
        uploading = true; error = nil
        defer { uploading = false }
        await uploadPending(workbench: workbench, projectID: projectID)
    }
    private func uploadPending(workbench: Workbench, projectID: String) async {
        for file in pendingFiles {
            do {
                // NSData reading and the bulk Kotlin byte-array copy are CPU/file work, not
                // UI work. This immutable upload is handed back only after construction.
                let picked = try await Task.detached(priority: .userInitiated) { try NativeUpload(file) }.value
                guard pendingFiles.contains(where: { $0.id == file.id }) else { continue }
                let uploaded = try await workbench.store.uploadAttachment(picked: picked, projectId: projectID)
                guard pendingFiles.contains(where: { $0.id == file.id }) else { continue }
                attachments.append(uploaded)
                removePending(file.id)
            } catch {
                guard pendingFiles.contains(where: { $0.id == file.id }) else { continue }
                self.error = "\(file.name)：\(error.riffetMessage)"; break
            }
        }
    }
    func removePending(_ id: UUID) {
        let file = pendingFiles.first(where: { $0.id == id })
        pendingFiles.removeAll { $0.id == id }
        save()
        if let file {
            Task.detached(priority: .utility) { try? FileManager.default.removeItem(at: file.url.deletingLastPathComponent()) }
        }
    }
}

// Kotlin/Native's shared heap permits crossing threads. Only construction mutates the
// byte array; the published upload is immutable and consumed by the shared upload API.
final class NativeUpload: NSObject, UploadableAttachment, @unchecked Sendable {
    let name: String, mimeType: String
    let bytes: KotlinByteArray
    let width: KotlinInt?, height: KotlinInt?
    init(_ file: ImportedAttachment) throws {
        name = file.name; mimeType = file.mimeType
        bytes = byteArrayFromData(data: try file.data())
        width = file.width.map { KotlinInt(int: Int32($0)) }; height = file.height.map { KotlinInt(int: Int32($0)) }
    }
}
