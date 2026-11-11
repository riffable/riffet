import AppKit
import Foundation
import RiffetKit

/// A saved reply (收藏): `Mark` in `:contracts`, mirroring `packages/contracts` (docs/MARKS.md).
extension Mark: @retroactive Identifiable {}

extension Mark {
    var markColor: MarkColor { color.flatMap(MarkColor.init(rawValue:)) ?? .yellow }
}

enum MarkColor: String, CaseIterable {
    case yellow, green, blue, red

    var label: String {
        switch self {
        case .yellow: String(localized: "黄")
        case .green: String(localized: "绿")
        case .blue: String(localized: "蓝")
        case .red: String(localized: "红")
        }
    }

    var nsColor: NSColor {
        switch self {
        case .yellow: .systemYellow
        case .green: .systemGreen
        case .blue: .systemBlue
        case .red: .systemRed
        }
    }

    /// The highlight drawn behind the words: light enough to read the text through.
    var fill: NSColor { nsColor.withAlphaComponent(0.32) }
}

/// What the transcript asks of the marks: everything that writes goes through `MarksStore.perform`.
enum MarkCommand {
    /// Saves the whole answer, or removes its saved copy when there is one.
    case toggleMessage(TimelineItemAssistant, text: String)
    case highlight(TimelineItemAssistant, quote: MarkQuote, text: String, color: MarkColor)
    /// Saves a picture an item showed, or removes its saved copy.
    case toggleImage(any TimelineItem, image: NSImage, name: String, path: String?)
    /// Saves a file a tool call read or wrote, or removes it.
    case toggleFile(any TimelineItem, path: String, name: String, detail: String?)
    case recolor(id: String, color: MarkColor)
    case editNote(Mark)
    case delete(id: String)
}

/// The 收藏 page's filters as the reader sets them; several kinds are comma-joined.
struct MarkQuery: Equatable {
    var sessionId: String?
    var projectId: String?
    var kind: String?
    var state: String?
    var q = ""
    var limit = 50
    var cursor: String?

    var wire: MarkListQuery {
        MarkListQuery(
            sessionId: sessionId, projectId: projectId,
            kinds: kind?.split(separator: ",").map(String.init) ?? [],
            state: state, q: q, limit: Int32(limit), cursor: cursor
        )
    }
}

struct MarksError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// The marks of the conversations on screen, mirrored from `:client`'s `SessionMarks` (which keeps
/// them current with the session-list poll), and the 收藏 page's server calls. One for the app; the
/// main workbench attaches the installed server's.
@MainActor
@Observable
final class MarksStore {
    static let shared = MarksStore()

    /// The marks of each watched conversation, newest first.
    private(set) var bySession: [String: [Mark]] = [:]
    /// The conversations with at least one mark, per watched project.
    private(set) var markedSessions: [String: Set<String>] = [:]
    /// Bumped whenever marks may have changed; the 收藏 page reloads on it.
    private(set) var revision: Int64 = 0
    /// Transcripts and pages on screen; replayed onto the next server's `SessionMarks`.
    @ObservationIgnored private var watched: [String: Int] = [:]
    /// Projects whose lists show a bookmark on marked conversations.
    @ObservationIgnored private var watchedProjects: [String: Int] = [:]
    @ObservationIgnored private var followers = 0
    @ObservationIgnored private var source: SessionMarks?
    @ObservationIgnored private let subscriptions = FlowSubscriptions()

    private init() {}

    // MARK: Connection

    /// Follows [marks], the installed server's; nil detaches.
    func attach(_ marks: SessionMarks?) {
        guard marks !== source else { return }
        subscriptions.cancelAll()
        source = marks
        guard let marks else {
            bySession = [:]
            markedSessions = [:]
            return
        }
        for id in watched.keys { marks.watch(sessionId: id) }
        for id in watchedProjects.keys { marks.watchProject(projectId: id) }
        for _ in 0..<followers { marks.follow() }
        subscriptions.observe(marks.bySession) { [weak self] value in
            if self?.bySession != value { self?.bySession = value }
        }
        subscriptions.observe(marks.markedSessions) { [weak self] value in
            if self?.markedSessions != value { self?.markedSessions = value }
        }
        // Counted here rather than copied: a new server's revision starts again from zero.
        subscriptions.observe(marks.revision) { [weak self] _ in self?.revision += 1 }
    }

    // MARK: Conversations on screen

    func marks(for sessionId: String) -> [Mark] { bySession[sessionId] ?? [] }

    /// Whether [sessionId] has a saved reply or other mark.
    func isMarked(_ sessionId: String, in projectId: String) -> Bool {
        markedSessions[projectId]?.contains(sessionId) == true
    }

    /// A list showing [projectId]'s conversations appeared; their marked subset is kept current.
    func watchProject(_ projectId: String) {
        watchedProjects[projectId, default: 0] += 1
        if watchedProjects[projectId] == 1 { source?.watchProject(projectId: projectId) }
    }

    func unwatchProject(_ projectId: String) {
        guard let count = watchedProjects[projectId] else { return }
        if count <= 1 {
            watchedProjects[projectId] = nil
            source?.unwatchProject(projectId: projectId)
        } else {
            watchedProjects[projectId] = count - 1
        }
    }

    /// A transcript showing [sessionId] appeared; its marks are read and kept current until it goes.
    func watch(_ sessionId: String) {
        watched[sessionId, default: 0] += 1
        if watched[sessionId] == 1 { source?.watch(sessionId: sessionId) }
    }

    func unwatch(_ sessionId: String) {
        guard let count = watched[sessionId] else { return }
        if count <= 1 {
            watched[sessionId] = nil
            source?.unwatch(sessionId: sessionId)
        } else {
            watched[sessionId] = count - 1
        }
    }

    /// The 收藏 page is showing and reloads on [revision].
    func follow() {
        followers += 1
        source?.follow()
    }

    func unfollow() {
        guard followers > 0 else { return }
        followers -= 1
        source?.unfollow()
    }

    // MARK: Writes

    /// Runs a transcript's mark command; failures are shown as an alert, as the transcript has no
    /// place of its own for them.
    func perform(_ command: MarkCommand, session: Session, generation: String?) {
        Task {
            do {
                let marks = try connected()
                switch command {
                case let .toggleMessage(item, text):
                    if let existing = marks.messageMark(sessionId: session.id, item: item) {
                        try await marks.delete(ids: [existing.id])
                    } else {
                        _ = try await marks.create(sessionId: session.id, kind: "message", item: item, text: text, quote: nil, asset: nil, color: nil, generation: generation)
                    }
                case let .highlight(item, quote, text, color):
                    _ = try await marks.create(sessionId: session.id, kind: "span", item: item, text: text, quote: quote, asset: nil, color: color.rawValue, generation: generation)
                case let .toggleImage(item, image, name, path):
                    if let existing = marks.assetMark(sessionId: session.id, item: item, kind: "image", name: name, path: path) {
                        try await marks.delete(ids: [existing.id])
                    } else {
                        guard let png = Self.png(image) else { throw MarksError(message: String(localized: "无法读取这张图片")) }
                        guard png.count <= 10 * 1024 * 1024 else { throw MarksError(message: String(localized: "图片超过 10 MB，无法收藏")) }
                        let asset = MarkCreateAsset(name: name, path: path, mimeType: "image/png", detail: nil, data: png.base64EncodedString())
                        _ = try await marks.create(sessionId: session.id, kind: "image", item: item, text: path ?? name, quote: nil, asset: asset, color: nil, generation: generation)
                    }
                case let .toggleFile(item, path, name, detail):
                    if let existing = marks.assetMark(sessionId: session.id, item: item, kind: "file", name: name, path: path) {
                        try await marks.delete(ids: [existing.id])
                    } else {
                        let asset = MarkCreateAsset(name: name, path: path, mimeType: nil, detail: detail, data: nil)
                        _ = try await marks.create(sessionId: session.id, kind: "file", item: item, text: path, quote: nil, asset: asset, color: nil, generation: generation)
                    }
                case let .recolor(id, color):
                    _ = try await marks.update(id: id, note: nil, color: color.rawValue)
                case let .editNote(mark):
                    guard let note = Self.askNote(mark.note) else { return }
                    _ = try await setNote(mark.id, note)
                case let .delete(id):
                    try await marks.delete(ids: [id])
                }
            } catch {
                let alert = NSAlert()
                alert.messageText = String(localized: "收藏操作失败")
                alert.informativeText = error.riffetMessage
                alert.runModal()
            }
        }
    }

    /// [image] as PNG, the format a saved picture is kept in whatever it was drawn from.
    static func png(_ image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
        return bitmap.representation(using: .png, properties: [:])
    }

    static func ids(of item: any TimelineItem) -> [String] { markIds(item: item) }

    /// Answers still being written carry provisional ids, which cannot be marked (`markable` in `:client`).
    static func markable(_ item: any TimelineItem) -> Bool { RiffetKit.markable(item: item) }

    /// An empty [note] clears it. Answers with the mark as the server now has it.
    func setNote(_ id: String, _ note: String) async throws -> Mark {
        try await connected().update(id: id, note: note, color: nil)
    }

    func delete(_ ids: [String]) async throws {
        try await connected().delete(ids: ids)
    }

    private func connected() throws -> SessionMarks {
        guard let source else { throw MarksError(message: String(localized: "服务器未连接")) }
        return source
    }

    // MARK: Reads

    func list(_ query: MarkQuery) async throws -> MarkListPage {
        guard let api = AppModel.shared.host.api else { throw MarksError(message: String(localized: "服务器未连接")) }
        do {
            return try await api.marks(query: query.wire)
        } catch where error.riffetStatus == 404 {
            throw MarksError(message: String(localized: "当前服务器版本不支持收藏，请更新服务器"))
        }
    }

    /// A saved image's kept copy, through the same authorized request as every other image.
    func asset(_ id: String) async throws -> NSImage {
        guard let base = AppModel.shared.host.api?.baseUrl,
              let url = URL(string: "\(base)/api/marks/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id)/asset") else { throw MarksError(message: String(localized: "服务器未连接")) }
        let (data, response) = try await URLSession.shared.data(for: ProjectDownloads.authorized(url))
        guard (response as? HTTPURLResponse)?.statusCode == 200, let image = NSImage(data: data) else { throw MarksError(message: String(localized: "图片无法加载")) }
        return image
    }

    func locate(_ id: String) async throws -> MarkLocation {
        guard let api = AppModel.shared.host.api else { throw MarksError(message: String(localized: "服务器未连接")) }
        return try await api.locateMark(id: id)
    }

    /// The question that started a saved answer; nil when it is not known or cannot be read.
    func prompt(_ id: String) async -> String? {
        try? await AppModel.shared.host.api?.markPrompt(id: id)
    }

    // MARK: Note

    /// Asks for a note; nil when cancelled, empty to clear it.
    static func askNote(_ current: String?) -> String? {
        let alert = NSAlert()
        alert.messageText = String(localized: "编辑备注")
        alert.informativeText = String(localized: "留空即清除备注。")
        alert.addButton(withTitle: String(localized: "保存"))
        alert.addButton(withTitle: String(localized: "取消"))
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 64))
        field.stringValue = current ?? ""
        field.placeholderString = String(localized: "写点什么，方便以后找到它")
        field.usesSingleLineMode = false
        field.cell?.wraps = true
        field.cell?.isScrollable = false
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        return field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
