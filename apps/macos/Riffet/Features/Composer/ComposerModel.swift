import AppKit
import ImageIO
import UniformTypeIdentifiers
import RiffetKit

/// The draft, its attachments and their uploads. Limits are the server's: 24 MiB per file and 20
/// per message, rejected as a batch rather than silently trimmed.
@MainActor
@Observable
final class ComposerModel {
    struct Item: Identifiable {
        enum State {
            case uploading
            case uploaded(Attachment)
            case failed(String)
        }

        var id = UUID()
        var file: PickedFile
        var state: State

        /// Once uploaded, the server holds the bytes: keep only what the chip shows (name, size,
        /// preview), not the picked data and its Kotlin copy (up to 24 MiB each).
        func releasingBytes() -> Item {
            guard case .uploaded = state, !file.data.isEmpty else { return self }
            var item = self
            item.file = file.withoutBytes()
            return item
        }
    }

    var text = "" {
        didSet { if text != oldValue { textRevision += 1 }; saveDraft() }
    }
    private(set) var textRevision = 0
    private(set) var items: [Item] = []
    var notice: String?
    /// The caret as a UTF-16 offset into [text].
    var caret = 0
    /// Where the text view should put the caret after [replace]; the token makes a repeat apply.
    private(set) var caretRequest: ComposerTextView.CaretRequest?
    /// Bumped to pull focus into the text view.
    private(set) var focusToken = 0
    private var draftKey: String?
    @ObservationIgnored private var terminationObserver: NSObjectProtocol?

    init() {
        // The half-second write below may not have happened when the app quits.
        terminationObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.flushDraft() }
        }
    }

    /// A composer already holding the draft stored under [draftKey], so the first frame shows it.
    convenience init(draftKey: String) {
        self.init()
        load(draftKey: draftKey)
    }

    deinit {
        if let terminationObserver { NotificationCenter.default.removeObserver(terminationObserver) }
    }

    nonisolated static let maxBytes = 24 * 1024 * 1024
    nonisolated static let maxCount = 20
    nonisolated static let maxEdge: CGFloat = 2048

    var uploaded: [Attachment] {
        items.compactMap { if case let .uploaded(attachment) = $0.state { attachment } else { nil } }
    }

    /// A send-later request is in flight: send and the clock wait for it.
    var schedulingLater = false

    var uploading: Bool { items.contains { if case .uploading = $0.state { true } else { false } } }

    var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !uploading }

    /// Switches to another draft, retaining in-memory attachments per draft key and persisted
    /// uploaded attachments across app restarts.
    func load(draftKey: String) {
        if let current = self.draftKey {
            Self.cache(items, for: current)
        }
        flushDraft()
        self.draftKey = draftKey
        notice = nil
        text = UserDefaults.standard.string(forKey: "riffet.draft.\(draftKey)") ?? ""
        items = Self.items(for: draftKey)
    }

    /// Merge legacy home drafts once. Keep their storage until both text and attachments have
    /// reached the shared draft; a corrupt legacy attachment record is left intact for recovery.
    func migrateDrafts(from legacyKeys: [String]) {
        guard let draftKey else { return }
        flushDraft()
        let defaults = UserDefaults.standard
        for legacy in legacyKeys where legacy != draftKey {
            let textKey = "riffet.draft.\(legacy)"
            let attachmentKey = "riffet.draft.attachments.\(legacy)"
            let oldText = defaults.string(forKey: textKey) ?? ""
            let oldData = defaults.data(forKey: attachmentKey)
            if let oldData, (try? JSONDecoder().decode([StoredAttachment].self, from: oldData)) == nil { continue }
            let oldItems = Self.items(for: legacy)
            guard !oldText.isEmpty || !oldItems.isEmpty else { continue }
            let mergedText = oldText.isEmpty || oldText == text ? text : text.isEmpty ? oldText : text + "\n\n" + oldText
            var seen = Set(uploaded.map(\.id))
            let mergedItems = items + oldItems.filter {
                if case let .uploaded(attachment) = $0.state { return seen.insert(attachment.id).inserted }
                return true
            }
            let stored = mergedItems.compactMap { item -> StoredAttachment? in
                guard case let .uploaded(a) = item.state else { return nil }
                return StoredAttachment(id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, path: a.path, width: a.width?.int64Value, height: a.height?.int64Value)
            }
            guard let data = try? JSONEncoder().encode(stored) else { continue }
            defaults.set(mergedText, forKey: "riffet.draft.\(draftKey)")
            defaults.set(data, forKey: "riffet.draft.attachments.\(draftKey)")
            guard defaults.string(forKey: "riffet.draft.\(draftKey)") == mergedText,
                  defaults.data(forKey: "riffet.draft.attachments.\(draftKey)") == data else { continue }
            text = mergedText
            items = mergedItems
            Self.cache(items, for: draftKey)
            defaults.removeObject(forKey: textKey)
            defaults.removeObject(forKey: attachmentKey)
            Self.itemsByDraft[legacy] = nil
        }
    }

    /// Drafts left with an upload in flight or failed. Drafts whose attachments are all uploaded
    /// are not kept here: they are persisted and reload from defaults, so the cache does not grow
    /// with every conversation visited.
    @ObservationIgnored private static var itemsByDraft: [String: [Item]] = [:]

    private static func items(for draftKey: String) -> [Item] {
        itemsByDraft[draftKey] ?? loadStoredAttachments(for: draftKey)
    }

    private static func cache(_ items: [Item], for draftKey: String) {
        let pending = items.contains { if case .uploaded = $0.state { false } else { true } }
        itemsByDraft[draftKey] = pending ? items : nil
    }

    private struct StoredAttachment: Codable {
        let id: String
        let name: String
        let mimeType: String
        let size: Int64
        let path: String
        let width: Int64?
        let height: Int64?
    }

    private func saveAttachments() {
        guard let draftKey else { return }
        Self.cache(items, for: draftKey)
        let key = "riffet.draft.attachments.\(draftKey)"
        let stored = uploaded.map {
            StoredAttachment(
                id: $0.id, name: $0.name, mimeType: $0.mimeType, size: $0.size,
                path: $0.path, width: $0.width?.int64Value, height: $0.height?.int64Value
            )
        }
        if stored.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(stored) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    private static func loadStoredAttachments(for draftKey: String) -> [Item] {
        let key = "riffet.draft.attachments.\(draftKey)"
        guard let data = UserDefaults.standard.data(forKey: key),
              let stored = try? JSONDecoder().decode([StoredAttachment].self, from: data) else { return [] }
        return stored.map { entry in
            let attachment = Attachment(
                id: entry.id, name: entry.name, mimeType: entry.mimeType, size: entry.size,
                path: entry.path, width: entry.width.map(KotlinLong.init(value:)), height: entry.height.map(KotlinLong.init(value:))
            )
            let cached = ImageLoader.shared.cached(for: .attachment(entry.id), projectId: nil)
            let file = PickedFile(
                name: entry.name, mimeType: entry.mimeType, data: Data(),
                width: entry.width.map(Int.init), height: entry.height.map(Int.init), preview: cached
            )
            return Item(file: file, state: .uploaded(attachment))
        }
    }

    /// What a submit took from the draft, so success clears only that.
    struct Submission {
        let text: String
        let attachments: [Attachment]
        let itemIds: Set<UUID>
        let textRevision: Int
    }

    func submission() -> Submission {
        let ids = Set(items.compactMap { if case .uploaded = $0.state { $0.id } else { nil } })
        return Submission(text: text, attachments: uploaded, itemIds: ids, textRevision: textRevision)
    }

    /// Clears what [submission] sent; whatever was typed or attached while it was in flight stays.
    func clear(sent submission: Submission) {
        if textRevision == submission.textRevision && text == submission.text { text = "" }
        items.removeAll { submission.itemIds.contains($0.id) }
        saveAttachments()
        notice = nil
    }

    /// A restarted composer clears only the accepted text and attachment identities.
    func clearAccepted(text: String, attachmentIds: Set<String>) {
        if self.text == text { self.text = "" }
        items.removeAll { item in
            if case let .uploaded(attachment) = item.state { return attachmentIds.contains(attachment.id) }
            return false
        }
        saveAttachments()
    }

    /// Replaces the draft and places the caret, as a menu pick or a quote does.
    func replace(text: String, caret: Int) {
        self.text = text
        self.caret = caret
        caretRequest = ComposerTextView.CaretRequest(offset: caret, token: (caretRequest?.token ?? 0) + 1)
        focus()
    }

    func focus() { focusToken += 1 }

    /// Puts a message into the draft as a Markdown quote, after whatever is already there.
    func quote(_ message: String) {
        let block = message.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n")
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "\(block)\n\n" : "\(text.trimmingCharacters(in: .whitespacesAndNewlines))\n\n\(block)\n\n"
        replace(text: next, caret: (next as NSString).length)
    }

    func clear() {
        text = ""
        items = []
        saveAttachments()
        notice = nil
    }

    func restore(_ draft: QueuedDraft, merging: Bool = false) {
        let previous = merging ? items : []
        let existingIds = Set(merging ? uploaded.map(\.id) : [])
        if !merging || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { text = draft.text }
        else if text != draft.text { text = draft.text + "\n\n" + text }
        items = previous + draft.attachments.filter { !existingIds.contains($0.id) }.map { attachment in
            let cached = ImageLoader.shared.cached(for: .attachment(attachment.id), projectId: nil)
            return Item(file: PickedFile(name: attachment.name, mimeType: attachment.mimeType, data: Data(), width: attachment.width.map { Int($0.int64Value) }, height: attachment.height.map { Int($0.int64Value) }, preview: cached), state: .uploaded(attachment))
        }
        saveAttachments()
    }

    func remove(_ id: UUID) {
        items.removeAll { $0.id == id }
        saveAttachments()
    }

    @ObservationIgnored private var draftSave: DispatchWorkItem?
    @ObservationIgnored private var pendingDraft: (key: String, text: String)?

    /// Written half a second after typing pauses (and at once when cleared), not on every key.
    /// A write that changes nothing is skipped: it still posts `UserDefaults.didChange`, and a
    /// draft restored while SwiftUI rebuilds this view would rebuild the view again (see
    /// `AttemptsSheet`).
    private func saveDraft() {
        guard let draftKey else { return }
        let key = "riffet.draft.\(draftKey)"
        if pendingDraft?.key != key { flushDraft() }
        draftSave?.cancel()
        if text.isEmpty {
            pendingDraft = nil
            if UserDefaults.standard.string(forKey: key) != nil { UserDefaults.standard.removeObject(forKey: key) }
            return
        }
        let value = text
        guard UserDefaults.standard.string(forKey: key) != value else {
            pendingDraft = nil
            draftSave = nil
            return
        }
        pendingDraft = (key, value)
        // Captures the draft, not the model: it still lands if the conversation closes meanwhile.
        let work = DispatchWorkItem { UserDefaults.standard.set(value, forKey: key) }
        draftSave = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }

    /// Writes the draft still waiting, before the composer moves to another one.
    func flushDraft() {
        draftSave?.cancel()
        draftSave = nil
        guard let pending = pendingDraft else { return }
        pendingDraft = nil
        UserDefaults.standard.set(pending.text, forKey: pending.key)
    }

    // MARK: Intake

    func pickFiles(upload: @escaping (PickedFile) async throws -> Attachment) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.prompt = String(localized: "添加")
        guard panel.runModal() == .OK else { return }
        add(urls: panel.urls, upload: upload)
    }

    func accept(providers: [NSItemProvider], upload: @escaping (PickedFile) async throws -> Attachment) {
        Task {
            var urls: [URL] = []
            var images: [NSImage] = []
            for provider in providers {
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) as? Data,
                   let fileURL = URL(dataRepresentation: url, relativeTo: nil) {
                    urls.append(fileURL)
                } else if provider.canLoadObject(ofClass: NSImage.self) {
                    let image: NSImage? = await withCheckedContinuation { continuation in
                        _ = provider.loadObject(ofClass: NSImage.self) { object, _ in continuation.resume(returning: object as? NSImage) }
                    }
                    if let image { images.append(image) }
                }
            }
            add(urls: urls, upload: upload)
            add(images: images, upload: upload)
        }
    }

    /// ⌘V with files or an image on the pasteboard; plain text is left to the text view.
    func paste(upload: @escaping (PickedFile) async throws -> Attachment) -> Bool {
        let board = NSPasteboard.general
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            add(urls: urls, upload: upload)
            return true
        }
        if Self.holdsImage(board), let image = NSImage(pasteboard: board) {
            add(images: [image], upload: upload)
            return true
        }
        return false
    }

    /// What [paste] takes: files copied in Finder, or an image.
    static func holdsAttachment(_ board: NSPasteboard) -> Bool {
        board.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) || holdsImage(board)
    }

    private static func holdsImage(_ board: NSPasteboard) -> Bool {
        board.availableType(from: [.png, .tiff]) != nil
    }

    /// Sizes are checked from the file system first; reading, downscaling and encoding happen off
    /// the main thread.
    func add(urls: [URL], upload: @escaping (PickedFile) async throws -> Attachment) {
        guard !urls.isEmpty else { return }
        if let tooLarge = urls.first(where: { ((try? $0.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0) > Self.maxBytes }) {
            notice = String(localized: "「\(tooLarge.lastPathComponent)」超过 24 MiB，这一批没有添加")
            return
        }
        if items.count + urls.count > Self.maxCount {
            notice = String(localized: "一条消息最多 \(Self.maxCount) 个附件，这一批没有添加")
            return
        }
        let targetKey = draftKey
        Task {
            let files = await Task.detached(priority: .userInitiated) { urls.compactMap { Self.prepare(url: $0) } }.value
            enqueue(files, targetKey: targetKey, upload: upload)
        }
    }

    func add(images: [NSImage], upload: @escaping (PickedFile) async throws -> Attachment) {
        guard !images.isEmpty else { return }
        let datas = images.compactMap(\.tiffRepresentation)
        let targetKey = draftKey
        Task {
            let files = await Task.detached(priority: .userInitiated) {
                datas.compactMap { tiff -> PickedFile? in
                    guard let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return nil }
                    return Self.prepare(data: png, name: "粘贴的图片.png", type: .png) // i18n-ignore: generated attachment file name
                }
            }.value
            enqueue(files, targetKey: targetKey, upload: upload)
        }
    }

    private func enqueue(_ files: [PickedFile], targetKey: String?, upload: @escaping (PickedFile) async throws -> Attachment) {
        guard !files.isEmpty else { return }
        if let tooLarge = files.first(where: { Int($0.bytes.size) > Self.maxBytes }) {
            notice = String(localized: "「\(tooLarge.name)」超过 24 MiB，这一批没有添加")
            return
        }
        let currentItems = targetKey.flatMap { $0 == draftKey ? items : Self.items(for: $0) } ?? items
        if currentItems.count + files.count > Self.maxCount {
            notice = String(localized: "一条消息最多 \(Self.maxCount) 个附件，这一批没有添加")
            return
        }
        notice = nil
        for file in files {
            let existing = targetKey.flatMap { $0 == draftKey ? items : Self.items(for: $0) } ?? items
            if !file.data.isEmpty, existing.contains(where: { $0.file.name == file.name && $0.file.sameContent(as: file) }) { continue }
            let item = Item(file: file, state: .uploading)
            if targetKey == nil || targetKey == draftKey {
                items.append(item)
                saveAttachments()
            } else if let targetKey {
                Self.itemsByDraft[targetKey] = Self.items(for: targetKey) + [item]
            }
            Task {
                do {
                    let attachment = try await upload(file)
                    update(item.id, .uploaded(attachment), targetKey: targetKey)
                } catch {
                    update(item.id, .failed(error.riffetMessage), targetKey: targetKey)
                }
            }
        }
    }

    private func update(_ id: UUID, _ state: Item.State, targetKey: String?) {
        if targetKey == nil || targetKey == draftKey, let index = items.firstIndex(where: { $0.id == id }) {
            items[index].state = state
            items[index] = items[index].releasingBytes()
            saveAttachments()
        } else if let targetKey, var list = Self.itemsByDraft[targetKey], let index = list.firstIndex(where: { $0.id == id }) {
            list[index].state = state
            list[index] = list[index].releasingBytes()
            Self.cache(list, for: targetKey)
            let key = "riffet.draft.attachments.\(targetKey)"
            let stored = list.compactMap { item -> StoredAttachment? in
                guard case let .uploaded(attachment) = item.state else { return nil }
                return StoredAttachment(
                    id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size,
                    path: attachment.path, width: attachment.width?.int64Value, height: attachment.height?.int64Value
                )
            }
            if stored.isEmpty {
                UserDefaults.standard.removeObject(forKey: key)
            } else if let data = try? JSONEncoder().encode(stored) {
                UserDefaults.standard.set(data, forKey: key)
            }
        }
    }

    nonisolated static func prepare(url: URL) -> PickedFile? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let type = UTType(filenameExtension: url.pathExtension) ?? .data
        return prepare(data: data, name: url.lastPathComponent, type: type)
    }

    /// Images are reduced to a 2048px long edge before upload, as the phone does.
    nonisolated static func prepare(data: Data, name: String, type: UTType) -> PickedFile? {
        let mime = type.preferredMIMEType ?? "application/octet-stream"
        guard type.conforms(to: .image), let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
            return PickedFile(name: name, mimeType: mime, data: data, width: nil, height: nil, preview: nil)
        }
        let width = (properties[kCGImagePropertyPixelWidth] as? Int) ?? 0
        let height = (properties[kCGImagePropertyPixelHeight] as? Int) ?? 0
        let preview = NSImage(data: data)
        guard CGFloat(max(width, height)) > maxEdge else {
            return PickedFile(name: name, mimeType: mime, data: data, width: width, height: height, preview: preview)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        guard let scaled = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return PickedFile(name: name, mimeType: mime, data: data, width: width, height: height, preview: preview)
        }
        let hasAlpha = ![.none, .noneSkipFirst, .noneSkipLast].contains(scaled.alphaInfo)
        let output = NSMutableData()
        let outputType = hasAlpha ? UTType.png : UTType.jpeg
        guard let destination = CGImageDestinationCreateWithData(output, outputType.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, scaled, [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary)
        CGImageDestinationFinalize(destination)
        let renamed = hasAlpha ? name : ((name as NSString).deletingPathExtension + ".jpg")
        return PickedFile(
            name: renamed, mimeType: outputType.preferredMIMEType ?? mime, data: output as Data,
            width: scaled.width, height: scaled.height, preview: NSImage(cgImage: scaled, size: .zero)
        )
    }
}

/// The composers of the conversations opened lately, one per draft. Switching to a conversation
/// finds its composer already holding its draft, so the first frame never shows another one's;
/// older composers are written out and let go.
@MainActor
final class ComposerPool {
    private static let limit = 8
    private var models: [(key: String, model: ComposerModel)] = []

    /// A deleted conversation's draft goes with it, unwritten.
    func discard(_ draftKey: String) {
        models.removeAll { $0.key == draftKey }
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "riffet.draft.\(draftKey)")
        defaults.removeObject(forKey: "riffet.draft.attachments.\(draftKey)")
    }

    func model(for draftKey: String) -> ComposerModel {
        if let index = models.firstIndex(where: { $0.key == draftKey }) {
            if index != models.count - 1 { models.append(models.remove(at: index)) }
            return models[models.count - 1].model
        }
        let model = ComposerModel(draftKey: draftKey)
        models.append((draftKey, model))
        if models.count > Self.limit { models.removeFirst().model.flushDraft() }
        return model
    }
}
