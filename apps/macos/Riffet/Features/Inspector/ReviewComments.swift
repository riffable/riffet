import AppKit
import SwiftUI
import RiffetKit

// MARK: Draft state

/// One remark on a line or range of a changed file, kept with the lines it quotes so it still reads
/// right after the file moves on. Lines count the new file, which is where the agent looks.
struct ReviewDraft: Identifiable, Equatable {
    let id = UUID()
    var path: String
    var line: Int?
    var endLine: Int?
    var body: String
    var quote: String

    var lineLabel: String {
        guard let line else { return String(localized: "整个文件") }
        if let endLine, endLine != line { return String(localized: "第 \(line)–\(endLine) 行") }
        return String(localized: "第 \(line) 行")
    }

    var wire: ReviewComment {
        ReviewComment(
            path: path,
            line: line.map { KotlinLong(value: Int64($0)) },
            endLine: endLine.map { KotlinLong(value: Int64($0)) },
            body: body,
            quote: quote.isEmpty ? nil : quote
        )
    }
}

/// The lines a remark is being written about (no lines: the whole file).
struct ReviewTarget: Equatable {
    var path: String
    var from: Int?
    var to: Int?
    var quote: String

    var label: String {
        guard let from else { return String(localized: "整个文件") }
        if let to, to != from { return String(localized: "第 \(from)–\(to) 行") }
        return String(localized: "第 \(from) 行")
    }
}

/// What the diff paints over its lines: the ranges with a remark and the range being written about.
struct ReviewMarks: Equatable {
    var commented: [ClosedRange<Int>] = []
    var selected: ClosedRange<Int>?
}

/// Remarks collected across the files of one project, until they are sent to the open conversation.
/// A retry of a failed send reuses the same `commandId` while nothing changed, so a request the server
/// did receive is not delivered twice.
@MainActor @Observable
final class ReviewDrafts {
    static let limit = 50
    /// The server's caps (`reviewComments`, the `note` of the review route), in UTF-16 units like its `length`.
    static let bodyLimit = 10_000
    static let noteLimit = 5_000

    /// The remarks of the most recently used projects, so they survive the panel closing or switching to
    /// the Files tab; the least recently used project is dropped past `cacheLimit`.
    private static let cacheLimit = 16
    private static var cache: [String: ReviewDrafts] = [:]
    private static var recent: [String] = []

    static func drafts(for projectId: String) -> ReviewDrafts {
        if let found = cache[projectId] {
            if recent.last != projectId {
                recent.removeAll { $0 == projectId }
                recent.append(projectId)
            }
            return found
        }
        let drafts = ReviewDrafts()
        cache[projectId] = drafts
        recent.append(projectId)
        while recent.count > cacheLimit {
            let oldest = recent.removeFirst()
            // A send still in flight keeps its remarks; they are only dropped from the cache.
            cache[oldest] = nil
        }
        return drafts
    }

    static func length(_ text: String) -> Int { text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count }

    var comments: [ReviewDraft] = []
    var note = ""
    var target: ReviewTarget?
    var draftBody = ""
    private(set) var sending = false
    var error: String?
    var notice: String?
    @ObservationIgnored private var command: (id: String, signature: String)?

    func count(for path: String) -> Int { comments.filter { $0.path == path }.count }

    func marks(for path: String) -> ReviewMarks {
        var marks = ReviewMarks()
        marks.commented = comments.compactMap { comment in
            guard comment.path == path, let line = comment.line else { return nil }
            return line...max(line, comment.endLine ?? line)
        }
        if let target, target.path == path, let from = target.from { marks.selected = from...max(from, target.to ?? from) }
        return marks
    }

    /// A click on a line number picks the line; shift-click stretches the pick into a range.
    func pick(path: String, line: Int, extend: Bool, quote: (Int, Int) -> String) {
        var from = line, to = line
        if extend, let current = target, current.path == path, let a = current.from, let b = current.to {
            from = min(a, line)
            to = max(b, line)
        }
        target = ReviewTarget(path: path, from: from, to: to, quote: quote(from, to))
    }

    func pickFile(path: String) {
        target = ReviewTarget(path: path, from: nil, to: nil, quote: "")
    }

    func cancelDraft() {
        target = nil
        draftBody = ""
    }

    var draftTooLong: Bool { Self.length(draftBody) > Self.bodyLimit }
    var noteTooLong: Bool { Self.length(note) > Self.noteLimit }

    var canAdd: Bool {
        target != nil && Self.length(draftBody) > 0 && !draftTooLong && comments.count < Self.limit
    }

    func addDraft() {
        let text = draftBody.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let target, canAdd else { return }
        let endLine = target.to.flatMap { $0 != target.from ? $0 : nil }
        comments.append(ReviewDraft(path: target.path, line: target.from, endLine: endLine, body: text, quote: target.quote))
        cancelDraft()
        error = nil
        notice = nil
    }

    func remove(_ id: UUID) {
        comments.removeAll { $0.id == id }
    }

    func update(_ id: UUID, body: String) {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= Self.bodyLimit, let index = comments.firstIndex(where: { $0.id == id }) else { return }
        comments[index].body = text
    }

    func clear() {
        comments = []
        note = ""
        error = nil
        notice = nil
        command = nil
    }

    /// `POST /api/sessions/:id/review`. The sent remarks leave the list; the rest (added while the
    /// request was in flight) stay.
    func send(api: RiffetApi?, sessionId: String) async {
        guard let api, !sending, !comments.isEmpty else { return }
        guard !noteTooLong else {
            error = String(localized: "总体备注不能超过 \(Self.noteLimit) 字，请精简后再发送")
            return
        }
        sending = true
        error = nil
        notice = nil
        let items = comments
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let signature = ([sessionId, text] + items.map { "\($0.path):\($0.line ?? 0):\($0.endLine ?? 0):\($0.body):\($0.quote)" }).joined(separator: "\u{1}")
        let commandId: String
        if let command, command.signature == signature {
            commandId = command.id
        } else {
            commandId = UUID().uuidString
            command = (commandId, signature)
        }
        do {
            _ = try await api.sendReview(sessionId: sessionId, commandId: commandId, comments: items.map(\.wire), note: text.isEmpty ? nil : text)
            let sent = Set(items.map(\.id))
            comments.removeAll { sent.contains($0.id) }
            note = ""
            command = nil
            notice = String(localized: "已把 \(items.count) 条审阅意见发给 Agent")
        } catch {
            self.error = String(localized: "无法发送审阅意见：\(error.riffetMessage)（可直接重试）")
        }
        sending = false
    }
}

/// The new-file lines of a diff in a range, as the text a remark quotes.
func reviewQuote(_ spec: DiffSpec, from: Int, to: Int) -> String {
    spec.lines.compactMap { line -> String? in
        guard line.kind != .gap, let number = Int(line.new), number >= from, number <= to else { return nil }
        return line.text
    }.joined(separator: "\n")
}

// MARK: Views

/// A multi-line field in the look of `GitField`.
struct GitTextArea: View {
    let placeholder: String
    @Binding var text: String
    var lines: ClosedRange<Int> = 2...6
    @Environment(\.palette) private var palette

    var body: some View {
        TextField(placeholder, text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            .lineLimit(lines)
            .font(.riffet(size: S(13)))
            .padding(.horizontal, Space.sm + 2)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
    }
}

/// Under a diff: the remark being written for the picked lines, or the hint for picking them.
struct ReviewComposer: View {
    @Bindable var review: ReviewDrafts
    let path: String
    /// A text diff with line numbers to pick (not binary, not a file too large to diff).
    let pickable: Bool
    /// The diff is a cut-off preview: its line numbers are not the file's, so only the whole file takes a remark.
    var truncated = false
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if let target = review.target, target.path == path {
                HStack(spacing: Space.sm) {
                    Image(icon: "text.bubble").font(.riffet(size: S(12))).foregroundStyle(palette.accent)
                    Text(target.label).font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg2)
                    if let first = target.quote.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first {
                        Text(first.trimmingCharacters(in: .whitespaces))
                            .font(.riffet(size: S(11), design: .monospaced))
                            .foregroundStyle(palette.fg4)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
                }
                GitTextArea(placeholder: String(localized: "写下要 Agent 修改的地方"), text: $review.draftBody)
                HStack(spacing: Space.xs) {
                    if review.draftTooLong {
                        Text("意见过长（\(ReviewDrafts.length(review.draftBody))/\(ReviewDrafts.bodyLimit) 字）").font(.riffet(size: S(11))).foregroundStyle(palette.warning)
                    } else if review.comments.count >= ReviewDrafts.limit {
                        Text("最多 \(ReviewDrafts.limit) 条，先发送已有的意见").font(.riffet(size: S(11))).foregroundStyle(palette.warning)
                    }
                    Spacer(minLength: 0)
                    Button("取消") { review.cancelDraft() }
                        .buttonStyle(ChipButtonStyle())
                    Button("添加意见") { review.addDraft() }
                        .buttonStyle(SolidButtonStyle(kind: .primary))
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(!review.canAdd)
                        .help("⌘↩ 添加")
                }
            } else {
                HStack(spacing: Space.sm) {
                    if !pickable {
                        Text(truncated ? "文件过大，不能逐行评论" : "这个文件没有可选的行")
                            .font(.riffet(size: S(11)))
                            .foregroundStyle(palette.fg4)
                    }
                    Spacer(minLength: 0)
                    Button("评论整个文件") { review.pickFile(path: path) }
                        .buttonStyle(ChipButtonStyle())
                        .disabled(review.comments.count >= ReviewDrafts.limit)
                }
            }
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
    }
}

/// The remarks collected so far, with the note to go with them and the send button. Shown under the
/// change list and under every diff, so the remarks are never out of reach.
struct ReviewBar: View {
    @Bindable var review: ReviewDrafts
    let workbench: Workbench
    /// The open conversation of this project; without one there is nobody to send to.
    let sessionId: String?
    @Environment(\.palette) private var palette
    @State private var expanded = false

    var body: some View {
        if !review.comments.isEmpty || review.notice != nil || review.error != nil {
            VStack(spacing: 0) {
                PanelRule()
                if !review.comments.isEmpty { bar }
                if expanded, !review.comments.isEmpty { list }
                if let error = review.error { GitInlineError(message: error) }
                if let notice = review.notice {
                    Text(notice)
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.success)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Space.md)
                        .padding(.vertical, Space.sm)
                }
            }
        }
    }

    private var bar: some View {
        HStack(spacing: Space.sm) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 5) {
                    Image(icon: "chevron.right")
                        .font(.riffet(size: S(9), weight: .semibold))
                        .foregroundStyle(palette.fg4)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Image(icon: "text.bubble").font(.riffet(size: S(12))).foregroundStyle(palette.accent)
                    Text("\(review.comments.count) 条审阅意见").font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg2)
                }
                .padding(.horizontal, 6)
                .frame(height: 26)
            }
            .buttonStyle(HoverRowStyle())
            Spacer(minLength: Space.xs)
            Button("清空") { review.clear() }
                .buttonStyle(ChipButtonStyle())
                .disabled(review.sending)
            Button {
                guard let sessionId else { return }
                Task { await review.send(api: workbench.host.api, sessionId: sessionId) }
            } label: {
                HStack(spacing: 5) {
                    if review.sending { Spinner(size: .mini) }
                    Text(review.error != nil ? "重试发送" : "发送审阅")
                }
            }
            .buttonStyle(SolidButtonStyle(kind: .primary))
            .disabled(sessionId == nil || review.sending || review.noteTooLong)
            .help(sessionId == nil ? "打开这个项目的一个会话后可发送" : "作为一条消息发给当前会话")
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, Space.xs)
    }

    private var list: some View {
        VStack(spacing: Space.sm) {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(review.comments) { comment in
                        ReviewDraftRow(comment: comment, review: review, locked: review.sending)
                    }
                }
            }
            .frame(maxHeight: 200)
            GitField(placeholder: String(localized: "总体备注（可选）"), text: $review.note)
            if review.noteTooLong {
                Text("备注过长（\(ReviewDrafts.length(review.note))/\(ReviewDrafts.noteLimit) 字），请精简后再发送")
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(palette.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if sessionId == nil {
                Text("没有打开这个项目的会话，意见会先留在这里")
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(palette.fg4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, Space.sm)
        .padding(.bottom, Space.sm)
    }
}

private struct ReviewDraftRow: View {
    let comment: ReviewDraft
    let review: ReviewDrafts
    let locked: Bool
    @Environment(\.palette) private var palette
    @State private var editing = false
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: Space.xs) {
                Text("\((comment.path as NSString).lastPathComponent) · \(comment.lineLabel)")
                    .font(.riffet(size: S(11), design: .monospaced))
                    .foregroundStyle(palette.fg3)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(comment.path)
                Spacer(minLength: 0)
                if !editing {
                    Button { text = comment.body; editing = true } label: { Image(icon: "pencil").font(.riffet(size: S(11))) }
                        .buttonStyle(IconButtonStyle(size: 22))
                        .help("编辑")
                        .disabled(locked)
                    Button { review.remove(comment.id) } label: { Image(icon: "xmark").font(.riffet(size: S(10), weight: .semibold)) }
                        .buttonStyle(IconButtonStyle(size: 22))
                        .help("删除这条意见")
                        .disabled(locked)
                }
            }
            if editing {
                GitTextArea(placeholder: String(localized: "审阅意见"), text: $text)
                HStack(spacing: Space.xs) {
                    Spacer(minLength: 0)
                    Button("取消") { editing = false }.buttonStyle(ChipButtonStyle())
                    Button("保存") { review.update(comment.id, body: text); editing = false }
                        .buttonStyle(SolidButtonStyle(kind: .primary))
                        .disabled(ReviewDrafts.length(text) == 0 || ReviewDrafts.length(text) > ReviewDrafts.bodyLimit)
                }
                if ReviewDrafts.length(text) > ReviewDrafts.bodyLimit {
                    Text("意见过长（\(ReviewDrafts.length(text))/\(ReviewDrafts.bodyLimit) 字）").font(.riffet(size: S(11))).foregroundStyle(palette.warning)
                }
            } else {
                Text(comment.body)
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 6)
    }
}

// MARK: Diff gutter

/// A transparent layer over the diff's lines: it paints the lines with remarks and the picked range,
/// and takes clicks on the line-number gutter, leaving everything else to the lines underneath.
/// Only the lines in the dirty rectangle are drawn, like the diff itself.
final class ReviewGutterOverlay: NSView {
    var spec: DiffSpec? {
        didSet { window?.invalidateCursorRects(for: self) }
    }
    var marks = ReviewMarks()
    var commentedTint: NSColor = .clear
    var selectedTint: NSColor = .clear
    var barTint: NSColor = .clear
    /// Nil when the diff takes no remarks: the layer is then invisible to the pointer.
    var onPick: ((Int, Bool) -> Void)? {
        didSet { window?.invalidateCursorRects(for: self) }
    }

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private func newNumber(atY y: CGFloat) -> Int? {
        guard let spec else { return nil }
        let index = Int((y - 4) / spec.lineHeight)
        guard y >= 4, index >= 0, index < spec.lines.count else { return nil }
        let line = spec.lines[index]
        return line.kind == .gap ? nil : Int(line.new)
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard onPick != nil, let spec else { return nil }
        let local = convert(point, from: superview)
        guard local.x >= 0, local.x < spec.gutter, newNumber(atY: local.y) != nil else { return nil }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        let local = convert(event.locationInWindow, from: nil)
        guard let number = newNumber(atY: local.y) else { return }
        onPick?(number, event.modifierFlags.contains(.shift))
    }

    override func resetCursorRects() {
        guard onPick != nil, let spec else { return }
        addCursorRect(NSRect(x: 0, y: 0, width: spec.gutter, height: bounds.height), cursor: .pointingHand)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let spec, marks.selected != nil || !marks.commented.isEmpty else { return }
        let first = max(0, Int((dirtyRect.minY - 4) / spec.lineHeight))
        let last = min(spec.lines.count, Int((dirtyRect.maxY - 4) / spec.lineHeight) + 1)
        guard first < last else { return }
        for index in first..<last {
            let line = spec.lines[index]
            guard line.kind != .gap, let number = Int(line.new) else { continue }
            let rect = NSRect(x: 0, y: 4 + CGFloat(index) * spec.lineHeight, width: bounds.width, height: spec.lineHeight)
            if marks.selected?.contains(number) == true {
                selectedTint.setFill()
                rect.fill()
            } else if marks.commented.contains(where: { $0.contains(number) }) {
                commentedTint.setFill()
                rect.fill()
            }
            if marks.commented.contains(where: { $0.contains(number) }) {
                barTint.setFill()
                NSRect(x: 0, y: rect.minY, width: 2, height: rect.height).fill()
            }
        }
    }
}
