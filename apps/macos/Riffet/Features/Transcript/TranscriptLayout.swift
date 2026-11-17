import AppKit
import CoreText
import RiffetKit

/// The reader's disclosures: which process blocks, thoughts, tool calls and shells are open, which
/// code blocks are wrapped or rendered. Written on the main thread, read by layout on the
/// layout queue; each row carries a version so a toggle re-lays out only that row.
final class TranscriptUIStore: @unchecked Sendable {
    private let lock = NSLock()
    private let folds: ProcessFolds
    private var opened: Set<String> = []
    /// A tool run's fold as the reader set it; absent, the run follows `RowBuilder.toolRunOpen`.
    private var toolRunChoices: [String: Bool] = [:]
    /// The run each folded-able tool call belongs to, so a search hit inside a folded run can open it.
    private var toolRunOfItem: [String: String] = [:]
    private var wrapped: Set<String> = []
    private var rendered: Set<String> = []
    private var versions: [String: Int] = [:]
    /// Activities with a stop request out, and when; read as stopping for a while, then the server's word stands.
    private var stopping: [String: Date] = [:]
    private var activityTexts: [String: String] = [:]
    private var referencePages: [String: [String]] = [:]
    private var referencePositions: [String: Int] = [:]
    private var textsLoading: Set<String> = []
    private var textsFailed: Set<String> = []

    init(completedProcessesOpen: Bool) {
        folds = ProcessFolds(completedProcessesOpen: completedProcessesOpen)
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func processOpen(_ row: TimelineRowProcess, key: String) -> Bool {
        locked { folds.isOpen(key: key, running: row.running, issues: Int(row.issueCount), endsTurn: row.endsTurn, interrupted: row.interrupted) }
    }

    /// Applies a grouping's run states; the rows whose block opened or closed get a new version.
    func sync(_ states: [ProcessFolds.State], reading: (String) -> Bool) {
        locked {
            for key in folds.sync(states, reading: reading) { versions[key, default: 0] += 1 }
        }
    }

    func toggleProcess(_ row: TimelineRowProcess, key: String) {
        locked {
            folds.toggle(key: key, running: row.running, issues: Int(row.issueCount), endsTurn: row.endsTurn, interrupted: row.interrupted)
            versions[key, default: 0] += 1
        }
    }

    static let stopGrace: TimeInterval = 20

    func isStopping(_ id: String) -> Bool { locked { stopping[id].map { Date().timeIntervalSince($0) < Self.stopGrace } ?? false } }

    func setStopping(_ id: String, _ on: Bool, row: String) {
        locked {
            if on { stopping[id] = Date() } else { stopping[id] = nil }
            versions[row, default: 0] += 1
        }
    }

    func activityText(_ blobRef: String) -> String? { locked { activityTexts[blobRef] } }
    func referencePage(_ blobRef: String) -> (text: String, page: Int, count: Int)? { locked {
        guard let pages = referencePages[blobRef], !pages.isEmpty else { return nil }
        let page = referencePositions[blobRef, default: 0]
        return (pages[page], page, pages.count)
    } }
    func finishReference(_ blobRef: String, pages: [String]?, row: String) { locked {
        textsLoading.remove(blobRef)
        if let pages { referencePages[blobRef] = pages; referencePositions[blobRef] = 0 } else { textsFailed.insert(blobRef) }
        versions[row, default: 0] += 1
    } }
    func moveReference(_ blobRef: String, page: Int, row: String) { locked {
        guard let pages = referencePages[blobRef], pages.indices.contains(page) else { return }
        referencePositions[blobRef] = page
        versions[row, default: 0] += 1
    } }
    func activityTextState(_ blobRef: String) -> (loading: Bool, failed: Bool) { locked { (textsLoading.contains(blobRef), textsFailed.contains(blobRef)) } }

    func beginActivityText(_ blobRef: String, row: String) {
        locked { textsLoading.insert(blobRef); textsFailed.remove(blobRef); versions[row, default: 0] += 1 }
    }

    func finishActivityText(_ blobRef: String, text: String?, row: String) {
        locked {
            textsLoading.remove(blobRef)
            if let text { activityTexts[blobRef] = text } else { textsFailed.insert(blobRef) }
            versions[row, default: 0] += 1
        }
    }

    func toolRunChoice(_ id: String) -> Bool? { locked { toolRunChoices[id] } }

    func setToolRunChoice(_ id: String, open: Bool, row: String) {
        locked {
            toolRunChoices[id] = open
            versions[row, default: 0] += 1
        }
    }

    /// Notes which run [items] were laid out in; read by `revealToolRun`.
    func noteToolRun(_ id: String, items: [String]) {
        locked { for item in items { toolRunOfItem[item] = id } }
    }

    /// Opens the run holding [item]; false when it is in none.
    func revealToolRun(containing item: String, row: String) -> Bool {
        locked {
            guard let id = toolRunOfItem[item], toolRunChoices[id] != true else { return false }
            toolRunChoices[id] = true
            versions[row, default: 0] += 1
            return true
        }
    }

    func isOpen(_ id: String) -> Bool { locked { opened.contains(id) } }
    func isWrapped(_ id: String) -> Bool { locked { wrapped.contains(id) } }
    func isRendered(_ id: String, default defaultValue: Bool = false) -> Bool { locked { rendered.contains(id) ? !defaultValue : defaultValue } }

    func toggle(_ action: TranscriptAction, row: String) {
        locked {
            switch action {
            case let .toggle(id): flip(&opened, id)
            case let .toggleWrap(id): flip(&wrapped, id)
            case let .toggleRendered(id): flip(&rendered, id)
            default: return
            }
            versions[row, default: 0] += 1
        }
    }

    private func flip(_ set: inout Set<String>, _ id: String) {
        if set.remove(id) == nil { set.insert(id) }
    }

    func version(_ row: String) -> Int { locked { versions[row] ?? 0 } }
}

/// Where the conversation came from, as the transcript's first row (the web's `lead`): the title opens
/// the conversation it was forked or handed off from.
struct LineageSpec: Equatable {
    var forked: Bool
    /// The parent conversation's Agent label; nil when the parent is not in the list.
    var agent: String?
    var title: String
    var parentId: String
}

/// Where this conversation went, as the transcript's last row: it was handed to another Agent, whose
/// label opens the new conversation. The conversation itself stays usable, so this is a line in the
/// history rather than a bar by the composer.
struct HandedOffSpec: Equatable {
    /// The successor conversation's Agent label; nil when it is not in the list.
    var agent: String?
    var successorId: String
}

/// What a plugin command run on an answer's ⋯ menu answered, shown as a block under that answer. [text]
/// is nil while it runs. The runner (`PluginCommandRunner.results`) holds it; rows only draw it.
struct CommandResultSpec: Equatable, Sendable {
    let id: String
    let token: UUID
    let sessionId: String
    /// Names the answer it was run on (`match`), so the row of that answer finds it again.
    let match: String
    var title: String
    let symbol: String
    var text: String?

    /// The answer's identity: conversation, run and a hash of its text (the same text of two runs is two answers).
    static func match(sessionId: String, runId: String?, text: String) -> String {
        var value: UInt32 = 0x811c9dc5
        for byte in text.utf8 { value = (value ^ UInt32(byte)) &* 0x01000193 }
        return "\(sessionId)\0\(runId ?? "")\0\(text.utf8.count):\(value)"
    }
}

/// What one transcript row is made from.
enum RowSource {
    /// A command's result under the answer row before it.
    case commandResult(CommandResultSpec)
    /// [past]: a row before the latest user message (native style only), whose prose reads in fg2.
    case timeline(any TimelineRow, gap: RowGap, speed: SpeedTag?, past: Bool)
    case lineage(LineageSpec)
    case handedOff(HandedOffSpec)
    /// Shown only when an older page keeps failing; paging otherwise happens unseen.
    case olderFailed
    /// Shown above the oldest row while a page is being read, so reaching the top says why it is not the top yet.
    case olderLoading
    case working(WorkingSpec)
    /// A line of text on an otherwise empty transcript ("还没有消息", "正在启动…").
    case empty(String)
    case bottom
}

/// Turns one row into positioned fragments at one width. Pure apart from the caches it reads
/// (formula snapshots, image sizes, code colours), so it runs on the layout queue; what it had to
/// do without is returned in `RowLayout.pending`.
struct RowBuilder {
    let style: TranscriptStyle
    let width: CGFloat
    let ui: TranscriptUIStore
    let root: String?
    let projectId: String?
    /// The conversation is not running: a pending call will not finish.
    let stale: Bool
    let suppressesHeldFooter: Bool
    let supportsRecovery: Bool

    private var text: TranscriptText
    private var fragments: [Fragment] = []
    private var items: [RowLayout.ItemSpan] = []
    private var chapters: [RowLayout.Chapter] = []
    private var answerBody: CGRect?
    private var collectsChapters = false
    private var pending: Set<String> = []
    private var ticking = false
    private var codeIndex = 0
    private var owner = ""
    /// The row being laid out is still streaming: its Markdown is parsed without filling the shared cache.
    private var live = false
    /// The Markdown block being laid out may still grow: the last block of a streaming row's text.
    private var growing = false
    private var markdownDepth = 0
    private var past = false

    init(style: TranscriptStyle, width: CGFloat, ui: TranscriptUIStore, root: String?, projectId: String?, stale: Bool, suppressesHeldFooter: Bool = false, supportsRecovery: Bool = false) {
        self.style = style
        self.width = width
        self.ui = ui
        self.root = root
        self.projectId = projectId
        self.stale = stale
        self.suppressesHeldFooter = suppressesHeldFooter
        self.supportsRecovery = supportsRecovery
        text = TranscriptText(style: style)
    }

    /// Rows are laid out in the reading column's own coordinates ([width] is the column), so a wider
    /// or narrower window that keeps the column only moves the rows.
    var column: CGFloat { width }
    var left: CGFloat { 0 }

    // MARK: Rows

    mutating func build(_ source: RowSource, key: String) -> RowLayout {
        fragments = []
        items = []
        chapters = []
        answerBody = nil
        collectsChapters = false
        past = false
        pending = []
        ticking = false
        codeIndex = 0
        owner = key
        live = false
        growing = false
        markdownDepth = 0
        let x = left, w = column
        switch source {
        case .bottom:
            return RowLayout(height: 16, fragments: [])
        case let .empty(message):
            let line = TextLayout(text.plain(message, size: 13, color: style.color(\.fg4)), width: w)
            fragments.append(Fragment(frame: CGRect(x: x + (w - line.size.width) / 2, y: 120, width: line.size.width, height: line.size.height), kind: .text(line, selectable: false)))
            return RowLayout(height: 120 + line.size.height, fragments: fragments)
        case .olderLoading:
            let line = TextLayout(text.plain(String(localized: "正在加载更早的消息…"), size: 12, color: style.color(\.fg4)), width: w)
            fragments.append(Fragment(frame: CGRect(x: x + (w - line.size.width) / 2, y: 16, width: line.size.width, height: line.size.height), kind: .text(line, selectable: false)))
            return RowLayout(height: 16 + line.size.height + 8, fragments: fragments)
        case let .lineage(spec):
            // One centred quiet line: the symbol and where it came from, then the parent's title as a link.
            let quiet = style.color(\.fg3)
            let prefix = NSMutableAttributedString()
            prefix.append(text.symbol(spec.forked ? "arrow.triangle.branch" : "arrow.left.arrow.right", size: 11, color: quiet))
            prefix.append(text.plain(spec.forked ? String(localized: " 来源会话：") : String(localized: " 由 \(spec.agent ?? String(localized: "其他 Agent")) 交接自 "), size: 12, color: quiet))
            let head = TextLayout(prefix, width: w)
            let title = NSMutableAttributedString(attributedString: text.plain(spec.title, size: 12, color: style.color(\.fg2)))
            title.addAttributes([.link: SessionLink.url(spec.parentId), .underlineStyle: NSUnderlineStyle.single.rawValue, .underlineColor: style.color(\.lineStrong)], range: NSRange(location: 0, length: title.length))
            let tail = TextLayout(title, width: min(260, max(40, w - head.size.width)), maximumLines: 1)
            let lineHeight = max(head.size.height, tail.size.height)
            let startX = x + max(0, (w - head.size.width - tail.size.width) / 2)
            fragments.append(Fragment(frame: CGRect(x: startX, y: 20, width: head.size.width, height: lineHeight), kind: .text(head, selectable: false)))
            fragments.append(Fragment(frame: CGRect(x: startX + head.size.width, y: 20, width: tail.size.width, height: lineHeight), kind: .text(tail, selectable: false)))
            return RowLayout(height: 20 + lineHeight, fragments: fragments)
        case let .handedOff(spec):
            // One centred quiet line like the lineage row, the successor's Agent label as its link.
            let quiet = style.color(\.fg3)
            let prefix = NSMutableAttributedString()
            prefix.append(text.symbol("arrow.left.arrow.right", size: 11, color: quiet))
            prefix.append(text.plain(String(localized: " 已交接给 "), size: 12, color: quiet))
            let head = TextLayout(prefix, width: w)
            let link = NSMutableAttributedString(attributedString: text.plain(spec.agent ?? String(localized: "其他 Agent"), size: 12, color: style.color(\.fg2)))
            link.addAttributes([.link: SessionLink.url(spec.successorId), .underlineStyle: NSUnderlineStyle.single.rawValue, .underlineColor: style.color(\.lineStrong)], range: NSRange(location: 0, length: link.length))
            let middle = TextLayout(link, width: w)
            let tail = TextLayout(text.plain(String(localized: "，在新会话中继续。"), size: 12, color: quiet), width: w)
            let lineHeight = max(head.size.height, middle.size.height, tail.size.height)
            var startX = x + max(0, (w - head.size.width - middle.size.width - tail.size.width) / 2)
            for part in [head, middle, tail] {
                fragments.append(Fragment(frame: CGRect(x: startX, y: 20, width: part.size.width, height: lineHeight), kind: .text(part, selectable: false)))
                startX += part.size.width
            }
            return RowLayout(height: 20 + lineHeight, fragments: fragments)
        case let .commandResult(spec):
            let pad: CGFloat = 12
            let top = style.rhythm.footer
            let box = fragments.count
            fragments.append(Fragment(frame: .zero, kind: .box(style.blockBox(radius: style.radii.container))))
            let head = NSMutableAttributedString()
            head.append(text.symbol(spec.symbol, size: 12, color: style.color(\.fg3)))
            head.append(text.plain("  " + spec.title, size: 13, weight: .medium, color: style.color(\.fg)))
            let title = TextLayout(head, width: w - 2 * pad)
            let headerHeight = max(title.size.height, 24)
            fragments.append(Fragment(frame: CGRect(x: x + pad, y: top + pad + (headerHeight - title.size.height) / 2, width: title.size.width, height: title.size.height), kind: .text(title, selectable: false)))
            var edge = x + w - pad
            let close = ButtonSpec(title: String(localized: "关闭"), action: .dismissCommandResult(spec.id), loading: false, compact: true)
            let closeSize = buttonSize(close)
            edge -= closeSize.width
            fragments.append(Fragment(frame: CGRect(x: edge, y: top + pad + (headerHeight - closeSize.height) / 2, width: closeSize.width, height: closeSize.height), kind: .button(close)))
            let side = spec.text.map { ButtonSpec(title: String(localized: "复制"), action: .copyText($0), loading: false, compact: true) } ?? ButtonSpec(title: "", action: nil, loading: true)
            let sideSize = buttonSize(side)
            edge -= sideSize.width
            fragments.append(Fragment(frame: CGRect(x: edge, y: top + pad + (headerHeight - sideSize.height) / 2, width: sideSize.width, height: sideSize.height), kind: .button(side)))
            var cursor = top + pad + headerHeight
            if let body = spec.text {
                cursor += 6
                cursor += markdown(body, x: x + pad, y: cursor, width: w - 2 * pad, muted: false, compact: false)
            }
            cursor += pad
            fragments[box].frame = CGRect(x: x, y: top, width: w, height: cursor - top)
            return RowLayout(height: ceil(cursor), fragments: fragments, pending: pending.union(text.pending))
        case .olderFailed:
            let button = ButtonSpec(title: String(localized: "加载更早的消息失败，重试"), action: .retryHistory, loading: false)
            let size = buttonSize(button)
            fragments.append(Fragment(frame: CGRect(x: x + (w - size.width) / 2, y: 16, width: size.width, height: size.height), kind: .button(button)))
            return RowLayout(height: 16 + size.height, fragments: fragments)
        case let .working(spec):
            fragments.append(Fragment(frame: CGRect(x: x, y: 12, width: w, height: 28), kind: .working(spec)))
            return RowLayout(height: 40, fragments: fragments, ticking: true)
        case let .timeline(row, gap, speed, past):
            self.past = past
            let top = style.rhythm.gap(gap)
            let height: CGFloat
            var message: String?
            switch onEnum(of: row) {
            case let .single(single):
                live = !single.settled
                collectsChapters = single.item is TimelineItemAssistant
                height = singleItem(single.item, footer: single.footer, answerText: single.answerText, runId: runIdFromTurnKey(turnKey: single.turnKey), speed: speed, stopped: single.stopped, x: x, y: top, width: w)
                if let user = single.item as? TimelineItemUser { message = user.text }
                if let assistant = single.item as? TimelineItemAssistant { message = assistant.text }
                if single.settled, let answer = single.answerText { message = answer }
            case let .process(process):
                live = process.running
                height = processBlock(process, key: key, runId: runIdFromTurnKey(turnKey: process.turnKey), speed: speed, x: x, y: top, width: w)
                message = process.settled ? process.answerText : nil
            case let .trigger(trigger):
                height = triggerRow(trigger, x: x, y: top, width: w)
            }
            return RowLayout(height: ceil(top + height), fragments: fragments, pending: pending.union(text.pending), message: message, ticking: ticking, items: items, chapters: chapters, answerBody: answerBody)
        }
    }

    /// Markdown on its own (outside the transcript), at [width] from the left edge.
    mutating func markdownLayout(_ source: String, key: String, muted: Bool, compact: Bool) -> RowLayout {
        fragments = []
        chapters = []
        answerBody = nil
        collectsChapters = false
        pending = []
        codeIndex = 0
        owner = key
        live = false
        growing = false
        markdownDepth = 0
        let height = markdown(source, x: 0, y: 0, width: width, muted: muted, compact: compact)
        return RowLayout(height: ceil(height), fragments: fragments, pending: pending.union(text.pending), message: source)
    }

    // MARK: Messages

    /// [stopped]: the turn was stopped and this row ends it, so it is the one that says so.
    private mutating func singleItem(_ item: any TimelineItem, footer: TurnFooter, answerText: String?, runId: String?, speed: SpeedTag?, stopped: Bool = false, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        switch onEnum(of: item) {
        case let .user(user): return userMessage(user, stopShown: stopped, x: x, y: y, width: width)
        case let .assistant(assistant): return assistantMessage(assistant, footer: footer, runId: runId, speed: speed, stopped: stopped, x: x, y: y, width: width)
        default:
            var height = processItem(item, running: false, turnActive: !stale, x: x, y: y, width: width)
            if footer != .none, footer != .held || !suppressesHeldFooter {
                height += style.rhythm.footer
                turnFooter(footer, FooterSpec(time: timelineItemTime(item: item), speed: speed, copy: answerText ?? "", trailing: false, turnRunId: runId), x: x, y: y + height, width: width)
                height += style.rhythm.footerHeight
            }
            return height
        }
    }

    private mutating func userMessage(_ item: TimelineItemUser, stopShown: Bool = true, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let limit = max(120, width - 96)
        var cursor = y
        let attachments = Array(item.attachments)
        if !attachments.isEmpty {
            let imageCandidates = attachments.filter { attachment in
                let mimeType = attachment.id.flatMap { TranscriptAttachments.metadata($0)?.mimeType } ?? attachment.mimeType
                return mimeType.map { $0.hasPrefix("image/") } ?? (attachment.type != "file")
            }.count
            let tile = imageCandidates > 1
            var items: [(CGSize, Fragment.Kind)] = []
            for attachment in attachments {
                let metadata = attachment.id.flatMap { TranscriptAttachments.metadata($0) }
                let mimeType = metadata?.mimeType ?? attachment.mimeType
                let name = metadata?.name ?? (attachment.name == attachment.id ? String(localized: "附件") : attachment.name)
                // Uploaded images keep their stable id; a native CLI path is read through the project route.
                let source: TimelineImageSource? = if let id = attachment.id {
                    .attachment(id)
                } else if let path = attachment.path, let projectId {
                    .projectFile(projectId: projectId, path: path)
                } else {
                    nil
                }
                let imageFailed = source.flatMap { ImageSizes.size(ImageSizes.key($0, projectId: projectId)) }
                    .map { $0.width <= 0 || $0.height <= 0 } ?? false
                let isImage = mimeType.map { $0.hasPrefix("image/") } ?? (attachment.type != "file")
                if let source, isImage, !imageFailed {
                    let declared: CGSize? = if let w = attachment.width?.doubleValue, let h = attachment.height?.doubleValue, w > 0, h > 0 {
                        CGSize(width: w, height: h)
                    } else {
                        nil
                    }
                    let (size, spec) = userAttachmentImage(source, label: name, tile: tile, declared: declared, width: limit)
                    items.append((size, .image(spec)))
                } else {
                    let label = metadata.map { "\(name) · \(ByteCountFormatter.string(fromByteCount: $0.size, countStyle: .binary))" } ?? name
                    let action = attachment.id.map { TranscriptAction.previewAttachment(id: $0, name: name) }
                        ?? attachment.path.map { TranscriptAction.openFile(path: $0, line: nil) }
                    let help = attachment.id == nil ? nil : String(localized: "预览 \(name)")
                    let chip = ChipSpec(text: label, symbol: "doc", action: action, help: help)
                    items.append((chipSize(chip, size: 12, padX: 10, padY: 6, width: limit), .chip(chip)))
                }
            }
            cursor += flow(items, right: x + width, width: limit, y: cursor, spacing: 6) + 6
        }
        if !item.text.isEmpty {
            let body = text.plain(item.text, size: 14, color: style.color(\.fg), lineHeight: 22)
            let layout = TextLayout(body, width: limit - 28)
            let bubble = CGSize(width: layout.size.width + 28, height: layout.size.height + 20)
            let origin = CGPoint(x: x + width - bubble.width, y: cursor)
            fragments.append(Fragment(frame: CGRect(origin: origin, size: bubble), kind: .box(BoxSpec(fill: style.color(\.bgBubble), radius: style.radii.floating))))
            fragments.append(Fragment(frame: CGRect(x: origin.x + 14, y: origin.y + 10, width: layout.size.width, height: layout.size.height), kind: .text(layout, selectable: true)))
            cursor += bubble.height + 6
        }
        for reference in item.references {
            let id = "session-reference:\(reference.snapshotRef)"
            let detailX = x + width - min(limit, 480)
            let detailWidth = min(limit, 480)
            let open = ui.isOpen(id)
            fragments.append(Fragment(frame: CGRect(x: detailX, y: cursor, width: detailWidth, height: style.row), kind: .disclosure(DisclosureSpec(
                icon: .symbol("text.bubble", size: 12, color: style.color(\.fg3)),
                title: reference.title, titleFont: style.font(12), chevron: .always(open: open), action: .toggle(id)
            ))))
            cursor += style.row
            if open {
                let summary = String(localized: "引用于 \(formatDateTime(value: reference.capturedAt) ?? reference.capturedAt)") + "\n\n" + sessionReferenceExcerpt(excerpt: reference.excerpt) + (reference.coverage.completeness == "partial" ? "\n\n" + String(localized: "仅含部分历史") : "")
                    + (reference.coverage.activeTurnIncomplete?.boolValue == true ? "\n\n" + String(localized: "引用时本轮尚未结束") : "")
                    + "\n\n" + String(localized: "原文副本随本会话保存")
                    + "\n\n" + String(localized: "仅保存提问和回答文字，不含工具记录和附件内容")
                cursor += textBlock(text.plain(summary, size: 12, color: style.color(\.fg3), lineHeight: 18), x: detailX + 24, y: cursor, width: detailWidth - 24) + 6
                let source = ButtonSpec(title: String(localized: "打开原会话"), action: .openURL(SessionLink.url(reference.sessionId)), loading: false)
                cursor += flow([(buttonSize(source), Fragment.Kind.button(source))], right: x + width, width: detailWidth, y: cursor, spacing: 4)
                if let original = ui.referencePage(reference.snapshotRef) {
                    cursor += textBlock(text.plain(original.text, size: 12, color: style.color(\.fg), lineHeight: 18), x: detailX + 24, y: cursor, width: detailWidth - 24) + 6
                    var paging: [(CGSize, Fragment.Kind)] = []
                    if original.page > 0 {
                        let previous = ButtonSpec(title: String(localized: "上一页"), action: .sessionReferencePage(reference.snapshotRef, original.page - 1), loading: false)
                        paging.append((buttonSize(previous), .button(previous)))
                    }
                    if original.page + 1 < original.count {
                        let next = ButtonSpec(title: String(localized: "下一页"), action: .sessionReferencePage(reference.snapshotRef, original.page + 1), loading: false)
                        paging.append((buttonSize(next), .button(next)))
                    }
                    cursor += flow(paging, right: x + width, width: detailWidth, y: cursor, spacing: 4)
                } else {
                    let state = ui.activityTextState(reference.snapshotRef)
                    let read = ButtonSpec(title: String(localized: "查看引用时的记录"), action: .loadSessionReference(reference.snapshotRef), loading: state.loading)
                    cursor += flow([(buttonSize(read), Fragment.Kind.button(read))], right: x + width, width: detailWidth, y: cursor, spacing: 4)
                }
            }
        }
        // Status, its actions, time and copy share one line at the message's trailing edge; what
        // does not fit wraps leftwards beneath, and an opened error reads under the line.
        var footerStatus = userStatus(item, stopShown: stopShown)
        var actions: [(CGSize, Fragment.Kind)] = []
        var error: (id: String, text: String)?
        let metaFont = style.font(11)
        if let run = item.run, !item.failureShown, let details = TimelineFormatKt.deliveryErrorDetails(run: run) {
            let id = "delivery-error:\(item.key)"
            let title = footerStatus?.0 ?? String(localized: "发送失败")
            let spec = DisclosureSpec(
                icon: .symbol("exclamationmark.circle", size: 11, color: style.color(run.native?.delivery == .failed ? \.danger : \.warning)),
                title: title,
                titleFont: metaFont,
                danger: run.native?.delivery == .failed,
                chevron: .always(open: ui.isOpen(id)),
                action: .toggle(id)
            )
            // A plain disclosure: the 16pt icon column, 8 to the title, then 6 and the 12pt chevron.
            actions.append((CGSize(width: ceil(Self.lineWidth(title, font: metaFont)) + 42, height: 20), .disclosure(spec)))
            footerStatus = nil
            error = (id, details)
        }
        if let run = item.run, supportsRecovery {
            let recovery = SendPhaseKt.messageRecovery(run: run)
            if recovery.needsCheck {
                var buttons = [ButtonSpec(title: String(localized: "检查状态"), action: .checkRun(run), loading: false, compact: true)]
                if recovery.canRetry { buttons.append(ButtonSpec(title: String(localized: "重试发送"), action: .retryRun(run), loading: false, compact: true)) }
                actions += buttons.map { (buttonSize($0), Fragment.Kind.button($0)) }
            }
        }
        let time = timelineItemTime(item: item)
        let footer = FooterSpec(status: footerStatus, time: time, copy: item.text, trailing: true, statusSymbol: item.run?.native?.intent == "steer" ? "arrow.turn.up.right" : nil, keepsShown: !actions.isEmpty)
        if actions.isEmpty {
            fragments.append(Fragment(frame: CGRect(x: x, y: cursor, width: width, height: 20), kind: .footer(footer)))
            cursor += 20
        } else {
            // The footer takes only its time and copy, so the actions can stand beside it.
            let timeWidth = formatDateTime(value: time).map { ceil(Self.lineWidth($0, font: NSFont.riffetDigits(size: style.s(11)))) } ?? 0
            let footerWidth = min(width, timeWidth + (item.text.isEmpty ? 0 : (timeWidth > 0 ? 8 : 0) + 20))
            fragments.append(Fragment(frame: CGRect(x: x + width - footerWidth, y: cursor, width: footerWidth, height: 20), kind: .footer(footer)))
            let gap: CGFloat = footerWidth > 0 ? 8 : 0
            cursor += max(20, flow(actions, right: x + width - footerWidth - gap, width: width - footerWidth - gap, y: cursor, spacing: 8))
        }
        if let error, ui.isOpen(error.id) {
            let detailWidth = min(limit, 480)
            cursor += 4
            cursor += textBlock(text.plain(error.text, size: 12, color: style.color(\.fg3), lineHeight: 18), x: x + width - detailWidth, y: cursor, width: detailWidth) + 6
        }
        return cursor - y
    }

    /// A turn stopped after the prompt arrived says so where it ends; [stopShown] is false then.
    private func userStatus(_ item: TimelineItemUser, stopShown: Bool = true) -> (String, NSColor)? {
        guard !item.failureShown else { return nil }
        guard let run = item.run else { return nil }
        guard run.native != nil else {
            switch run.state {
            case .failed: return (String(localized: "发送失败"), style.color(\.danger))
            case .cancelled: return (String(localized: "已取消"), style.color(\.fg3))
            case .queued: return (String(localized: "排队中"), style.color(\.fg3))
            default: return nil
            }
        }
        let label = nativeDeliveryLabel(run, stopShown: stopShown)
        guard !label.isEmpty else { return nil }
        switch run.native?.delivery {
        case .failed: return (label, style.color(\.danger))
        case .uncertain: return (label, style.color(\.warning))
        default: return (label, style.color(\.fg3))
        }
    }

    private mutating func assistantMessage(_ item: TimelineItemAssistant, footer: TurnFooter, runId: String? = nil, speed: SpeedTag?, stopped: Bool = false, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let source = item.text
        var cursor = y + markdown(source, x: x, y: y, width: width, muted: false, compact: false, bodyColor: past ? style.color(\.fg2) : nil)
        if collectsChapters { answerBody = CGRect(x: x, y: y, width: width, height: cursor - y) }
        if footer != .none, footer != .held || !suppressesHeldFooter {
            cursor += style.rhythm.footer
            // A stopped turn's answer says so before its time, and keeps the line on screen.
            let status = stopped && footer == .shown ? (TimelineFormatKt.stoppedLabel(), style.color(\.fg3)) : nil
            turnFooter(footer, FooterSpec(status: status, time: timelineItemTime(item: item), speed: speed, copy: source, trailing: false, turnRunId: runId), x: x, y: cursor, width: width)
            cursor += style.rhythm.footerHeight
        }
        return cursor - y
    }

    /// A turn's footer: its time and actions once the turn settles, and until then a slot of the
    /// same height for the working line, so settling swaps what the slot shows and moves nothing.
    private mutating func turnFooter(_ footer: TurnFooter, _ spec: @autoclosure () -> FooterSpec, x: CGFloat, y: CGFloat, width: CGFloat) {
        let frame = CGRect(x: x, y: y, width: width, height: style.rhythm.footerHeight)
        if footer == .held {
            ticking = true
            fragments.append(Fragment(frame: frame, kind: .progress))
        } else {
            fragments.append(Fragment(frame: frame, kind: .footer(spec())))
        }
    }

    // MARK: Process blocks

    private mutating func processBlock(_ row: TimelineRowProcess, key: String, runId: String?, speed: SpeedTag?, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let open = ui.processOpen(row, key: key)
        let running = row.running
        // The list form's summaries are text alone, as its tool runs' are.
        let list = style.toolRun == .list
        // Quiet, the header names the process without its clock: the working line under the turn
        // already counts the time, and one turn shows one running state.
        let live = running && style.ink != .quiet
        let header = DisclosureSpec(
            icon: .symbol("sparkles", size: 12, color: live ? style.color(style.mark) : style.color(\.fg4)),
            title: running && !live ? "Working" : processHeaderLabel(row: row, nowMillis: Int64(Date().timeIntervalSince1970 * 1000)),
            titleFont: style.figures(list ? 14 : 13),
            chevron: .always(open: open),
            shimmer: live,
            clock: live ? .process(row) : nil,
            action: .toggleProcess,
            variant: list ? .listSummary : .plain
        )
        if live { ticking = true }
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: width, height: style.row), kind: .disclosure(header)))
        var cursor = y + style.row
        if open {
            cursor += 2
            let items = Array(row.items)
            var index = 0
            // The space between two items is decided here, by what meets, never by the items
            // themselves: the header counts as a row.
            var previousProse = false
            while index < items.count {
                var end = index
                while end < items.count, Self.joinsToolRun(items[end]) { end += 1 }
                let run = Array(items[index..<end])
                if run.count > 1, run.contains(where: { isToolRunItem(item: $0) }) {
                    if previousProse { cursor += style.rhythm.proseRow }
                    previousProse = false
                    cursor += toolRun(run, followedByContent: !row.endsTurn || end < items.count, running: running, turnActive: row.turnActive, x: x, y: cursor, width: width)
                    index = end
                    continue
                }
                let item = items[index]
                let prose = Self.isProse(item)
                if prose || previousProse { cursor += prose && previousProse ? style.rhythm.prose : style.rhythm.proseRow }
                previousProse = prose
                let start = fragments.count
                cursor += processItem(item, running: running, turnActive: row.turnActive, x: x, y: cursor, width: width)
                noteItem(item, from: start)
                index += 1
            }
            // Prose that closes the block keeps the little air it had before the footer.
            if previousProse { cursor += 6 }
        }
        if row.footer != .none, row.footer != .held || !suppressesHeldFooter {
            cursor += style.rhythm.block
            // A turn with no prose to copy still shows its time and turn actions.
            turnFooter(row.footer, FooterSpec(time: row.endedAt, speed: speed, copy: row.answerText ?? "", trailing: false, turnRunId: runId), x: x, y: cursor, width: width)
            cursor += style.rhythm.footerHeight
        }
        return cursor - y
    }

    /// Records the fragments [item] drew from [start]; a list-form call has noted its own already (`toolBox`).
    private mutating func noteItem(_ item: any TimelineItem, from start: Int) {
        guard items.last?.item.key != item.key else { return }
        items.append(RowLayout.ItemSpan(item: item, fragments: start..<fragments.count))
    }

    /// Text read as prose inside a process block (an answer, a narration), as against a one-line row.
    private static func isProse(_ item: any TimelineItem) -> Bool {
        switch onEnum(of: item) {
        case .assistant: true
        case let .thought(thought): thought.channel == .narration
        default: false
        }
    }

    /// What a run gathers: ordinary tool calls and folded reasoning between them, so a thought does
    /// not split one stretch of work into lone calls. Prose, delegations and anything else end it; a
    /// run needs a call in it and two items, or its items stand on their own.
    private static func joinsToolRun(_ item: any TimelineItem) -> Bool {
        isToolRunItem(item: item) || (item as? TimelineItemThought)?.channel == .thinking
    }

    /// A stretch of tool calls (and the folded reasoning between them), folded into one line naming
    /// what the calls did (the web's `ToolRun`). A working or unsettled run opens by default,
    /// and once finished folds when delegation or the answer follows; the reader's choice wins.
    private mutating func toolRun(_ run: [any TimelineItem], followedByContent: Bool, running: Bool, turnActive: Bool, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let id = "toolrun:\(run[0].key)"
        let tools = run.compactMap { $0 as? TimelineItemTool }
        let presentations = tools.map { toolPresentation(item: $0, root: root, stale: !turnActive) }
        // Reasoning still streaming at the end of the block keeps its run open, as a working call does.
        let thinking = running && !followedByContent && run.last is TimelineItemThought
        let active = thinking || zip(tools, presentations).contains { tool, presentation in
            tool.job.map { $0.status == .running } ?? presentation.running
        }
        let incomplete = presentations.contains { $0.dangling }
        let open = ui.toolRunChoice(id) ?? (active || incomplete || !followedByContent)
        ui.noteToolRun(id, items: run.map(\.key))
        let kinds = toolRunKinds(items: tools)
        let names = kinds.prefix(2).map(Self.toolRunLabel).joined(separator: String(localized: "、"))
        let title = kinds.count > 2 ? String(localized: "\(names)等") : names
        let list = style.toolRun == .list
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: width, height: style.row), kind: .disclosure(DisclosureSpec(
            icon: .symbol(ToolSymbols.symbol(kinds.first ?? "other"), size: 12, color: style.color(\.fg4)),
            title: title,
            titleFont: list ? style.font(14) : style.font(13),
            chevron: list ? .always(open: open) : .hover(open: open),
            action: .toggleToolRun(id: id, open: open),
            variant: list ? .listSummary : .plain
        ))))
        guard open else { return style.row }
        if list {
            // The calls sit in bordered lists under the line; reasoning between them stands on its own row.
            var cursor = y + style.row + 10
            var index = 0
            while index < run.count {
                var end = index
                while end < run.count, run[end] is TimelineItemTool { end += 1 }
                if end > index {
                    if index > 0 { cursor += Self.listGap }
                    cursor += toolBox(run[index..<end].compactMap { $0 as? TimelineItemTool }, turnActive: turnActive, x: x, y: cursor, width: width)
                    if end < run.count { cursor += Self.listGap }
                    index = end
                } else {
                    let start = fragments.count
                    cursor += processItem(run[index], running: running, turnActive: turnActive, x: x, y: cursor, width: width)
                    noteItem(run[index], from: start)
                    index += 1
                }
            }
            return cursor + 4 - y
        }
        // The calls hang off a hairline under the run's icon, so they read as its contents.
        var cursor = y + style.row + 2
        let indent: CGFloat = 16
        let edge = fragments.count
        fragments.append(Fragment(frame: .zero, kind: .box(BoxSpec(fill: style.color(\.line)))))
        for item in run {
            let start = fragments.count
            cursor += processItem(item, running: running, turnActive: turnActive, x: x + indent, y: cursor, width: width - indent)
            noteItem(item, from: start)
        }
        fragments[edge].frame = CGRect(x: x + 6, y: y + style.row + 2, width: 1, height: cursor - (y + style.row + 2))
        return cursor + 4 - y
    }

    /// The room between a bordered list and the line or list next to it.
    private static let listGap: CGFloat = 8

    /// Calls in one bordered list (the Claude style): a row each, a hairline between them. The rows
    /// are inset by the border, so their hover wash and the box share the corners.
    private mutating func toolBox(_ tools: [TimelineItemTool], turnActive: Bool, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let box = fragments.count
        fragments.append(Fragment(frame: .zero, kind: .box(BoxSpec(stroke: style.color(\.lineStrong), radius: style.radii.card))))
        var cursor = y + 1
        for (index, tool) in tools.enumerated() {
            if index > 0 {
                fragments.append(Fragment(frame: CGRect(x: x + 1, y: cursor, width: width - 2, height: 1), kind: .box(BoxSpec(fill: style.color(\.line)))))
                cursor += 1
            }
            let start = fragments.count
            listPlace = tools.count == 1 ? .only : index == 0 ? .first : index == tools.count - 1 ? .last : .middle
            cursor += toolCall(tool, turnActive: turnActive, x: x + 1, y: cursor, width: width - 2)
            listPlace = nil
            items.append(RowLayout.ItemSpan(item: tool, fragments: start..<fragments.count))
        }
        cursor += 1
        fragments[box].frame = CGRect(x: x, y: y, width: width, height: cursor - y)
        return cursor - y
    }

    /// A call's one-line height: the Claude list gives it more air.
    private var callRow: CGFloat { style.toolRun == .list ? (32 * style.scale).rounded() : style.row }

    /// The place of the call being laid out in its list; `.plain` outside one.
    private var listPlace: DisclosureSpec.Place?

    /// The variant of a call's row: a row whose call opens below it no longer ends the list at its own bottom.
    private func callVariant(extended: Bool) -> DisclosureSpec.Variant {
        guard let place = listPlace else { return .plain }
        guard extended else { return .listRow(place) }
        return .listRow(place == .only || place == .first ? .first : .middle)
    }

    private static let actionTitle = try! NSRegularExpression(pattern: "^(Read|Search|List files|Edit|Write|MultiEdit|NotebookEdit)\\s+(.+)$")
    private static let pathActions: Set<String> = ["Read", "List files", "Edit", "Write", "MultiEdit", "NotebookEdit"]

    /// A one-action title split into its verb and its object (the web's `toolAction`). A title naming
    /// the file by basename takes the location's path, which says where it lives; a compound title
    /// (`Read a · Search b`) is one call doing several things and stays whole.
    static func toolAction(_ presentation: ToolPresentation) -> (verb: String, object: String, path: Bool)? {
        let title = presentation.title
        guard !title.contains(" · "),
              let match = actionTitle.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)),
              let verbRange = Range(match.range(at: 1), in: title), let objectRange = Range(match.range(at: 2), in: title) else { return nil }
        let verb = String(title[verbRange])
        let named = String(title[objectRange])
        let path = pathActions.contains(verb)
        if path, let location = presentation.locations.first?.path, location.split(separator: "/").last.map(String.init) == named {
            return (verb, location, path)
        }
        return (verb, named, path)
    }

    /// The web's `toolRunSummary` wording, one category at a time.
    private static func toolRunLabel(_ kind: String) -> String {
        switch kind {
        case "read": String(localized: "读取文件")
        case "search": String(localized: "搜索内容")
        case "execute": String(localized: "运行命令")
        case "edit": String(localized: "修改文件")
        case "delete": String(localized: "删除文件")
        case "move": String(localized: "移动文件")
        case "fetch": String(localized: "访问网页")
        case "agent": String(localized: "委派任务")
        case "think": String(localized: "思考")
        case "switch_mode": String(localized: "切换模式")
        case "question": String(localized: "询问用户")
        case "plan": String(localized: "更新计划")
        default: String(localized: "调用工具")
        }
    }

    private mutating func processItem(_ item: any TimelineItem, running: Bool, turnActive: Bool, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        switch onEnum(of: item) {
        case let .thought(thought):
            return self.thought(thought, running: running, x: x, y: y, width: width)
        case let .tool(tool):
            // In the Claude style a call lives in a bordered list, a lone one in a list of its own.
            // The box keeps the room a summary line has around it, so it never touches its neighbours.
            if style.toolRun == .list { return toolBox([tool], turnActive: turnActive, x: x, y: y + Self.listGap, width: width) + 2 * Self.listGap }
            return toolCall(tool, turnActive: turnActive, x: x, y: y, width: width)
        case let .plan(plan):
            return self.plan(todoEntries(plan: plan), x: x + 24, y: y + 4, width: width - 24) + 8
        case let .image(image):
            let (size, spec) = self.image(.url(image.src), label: String(localized: "图片"), maxHeight: 360, width: width - 24)
            fragments.append(Fragment(frame: CGRect(x: x + 24, y: y + 4, width: size.width, height: size.height), kind: .image(spec)))
            return size.height + 8
        case let .status(status):
            let danger = status.tone == .danger
            if let detail = status.detail, !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let id = "status:\(status.key)"
                let open = ui.isOpen(id)
                fragments.append(Fragment(frame: CGRect(x: x, y: y, width: width, height: style.row), kind: .disclosure(DisclosureSpec(
                    icon: .symbol(danger ? "exclamationmark.circle" : "info.circle", size: 12, color: danger ? style.color(\.danger) : style.color(\.fg4)),
                    title: status.text,
                    titleFont: style.font(13),
                    danger: danger,
                    chevron: .always(open: open),
                    action: .toggle(id)
                ))))
                guard open else { return style.row }
                return style.row + 4 + codeBlock(detail, language: "output", prefix: nil, maxHeight: 320, syntax: nil, x: x + 24, y: y + style.row + 4, width: width - 24) + 8
            }
            let layout = TextLayout(text.plain(status.text, size: 13, color: danger ? style.color(\.danger) : style.color(\.fg3)), width: width - 24)
            fragments.append(Fragment(frame: CGRect(x: x + 24, y: y + 3, width: layout.size.width, height: layout.size.height), kind: .text(layout, selectable: true)))
            return layout.size.height + 6
        case let .taskNotification(notice):
            return self.notice(notice, x: x, y: y, width: width)
        case let .activity(item):
            return activity(item, x: x, y: y, width: width)
        case let .user(user):
            return userMessage(user, x: x, y: y, width: width)
        case let .assistant(assistant):
            // The space around it is the process block's to give (`TranscriptRhythm.proseRow`).
            return assistantMessage(assistant, footer: .none, speed: nil, x: x, y: y, width: width)
        }
    }

    private mutating func toolCall(_ tool: TimelineItemTool, turnActive: Bool, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        if let job = tool.job { return self.job(job, key: tool.key, x: x, y: y, width: width) }
        return self.tool(toolPresentation(item: tool, root: root, stale: !turnActive), key: tool.key, activity: currentToolActivity(item: tool), x: x, y: y, width: width)
    }

    private mutating func thought(_ item: TimelineItemThought, running: Bool, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let source = item.text
        if item.channel == .narration {
            return markdown(source, x: x, y: y, width: width, muted: true, compact: false)
        }
        let id = "thought:\(item.key)"
        let open = ui.isOpen(id)
        // Folded, the preview is one line; opened, the body says it in full under a plain title.
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: width, height: style.row), kind: .disclosure(DisclosureSpec(
            icon: .symbol("brain", size: 12, color: style.color(\.fg4)),
            title: open ? String(localized: "思考") : reasoningPreview(source, running: running),
            titleFont: style.font(13),
            chevron: .hover(open: open),
            action: .toggle(id)
        ))))
        guard open else { return style.row }
        // The opened thought is still the same row: its 13/20 type and muted colour stay, so
        // expanding it does not read as a different kind of content.
        let body = markdown(source, x: x + 24, y: y + style.row + 4, width: width - 24, muted: true, compact: false,
                            bodySize: 13, bodyLineHeight: 20, bodyColor: style.color(\.fg3))
        return style.row + 4 + body + 4
    }

    private mutating func tool(_ presentation: ToolPresentation, key: String, activity: NativeActivity?, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let id = "tool:\(key)"
        let list = style.toolRun == .list
        let rowH = callRow
        // Where the row's content starts and stops: the Claude list pads 16 from the border.
        let lead: CGFloat = list ? 15 : 24
        let tail: CGFloat = list ? 15 : 0
        let open = ui.isOpen(id) && !presentation.opensSubagent
        let stopping = activity.map { ui.isStopping($0.id) } ?? false
        let activityState = activity.map { activityView(activity: $0, stopping: stopping, nowMillis: Int64(Date().timeIntervalSince1970 * 1000)) }
        let background = activity?.kind == .backgroundTask
        let stop = activity.flatMap { task in activityState?.canStop == true ? ButtonSpec(title: String(localized: "停止"), action: .stopActivity(id: task.id, warning: activityState?.stopWarning), loading: false) : nil }
        let stopSize = stop.map(buttonSize)
        // The list's row spans the full width, its hover wash with it; the call's own row keeps clear of the button.
        let reserve = stopSize.map { $0.width + 6 + tail } ?? 0
        let headerWidth = list ? width : width - reserve
        if activityState?.running == true { ticking = true }
        var trailing: [DisclosureSpec.Piece] = []
        var inline: [DisclosureSpec.Piece] = []
        if let activity, let stoppingLabel = stoppingPiece(activity, stopping: stopping) {
            trailing.append(stoppingLabel)
        }
        if let activity, let outcome = outcomePiece(activity) {
            inline.append(outcome)
        } else if presentation.dangling {
            inline.append(outcomePiece(failed: false))
        } else if presentation.failed, presentation.opensSubagent {
            inline.append(outcomePiece(failed: true))
        } else if presentation.showsDiffStats {
            // The counts describe this edit, so they travel with the title.
            if presentation.files > 1 { inline.append(.init(text: String(localized: "\(presentation.files) 个文件"), font: style.font(12), color: style.color(\.fg4))) }
            if presentation.added > 0 { inline.append(.init(text: "+\(presentation.added)", font: style.mono(12), color: style.color(\.success))) }
            if presentation.removed > 0 { inline.append(.init(text: "−\(presentation.removed)", font: style.mono(12), color: style.color(\.danger))) }
        }
        // A call reads in one type, whatever its title: a command, `Read` and its path, a compound
        // title. Only a path's directory steps back, so the file it names stands out.
        let action = presentation.isCommand || presentation.opensSubagent || background ? nil : Self.toolAction(presentation)
        let mono = !presentation.opensSubagent && (!background || presentation.isCommand)
        let detail: DisclosureSpec.Piece? = if list {
            // A path shows the file it names; the rest reads in mono.
            if let action, action.path {
                .init(text: action.object.split(separator: "/").last.map(String.init) ?? action.object, font: style.font(14), color: style.color(\.fg))
            } else if let action {
                .init(text: action.object, font: style.mono(13), color: style.color(\.fg))
            } else {
                presentation.detail.map { .init(text: $0, font: style.mono(13), color: style.color(\.fg)) }
            }
        } else if let action {
            .init(text: action.object, font: style.mono(12), color: style.color(\.fg3),
                  quiet: action.path ? (action.object.lastIndex(of: "/").map { action.object[...$0].utf16.count } ?? 0) : 0,
                  quietColor: style.color(\.fg4))
        } else {
            presentation.detail.map { .init(text: $0, font: style.mono(12), color: style.color(\.fg3)) }
        }
        // Labelled, only a command reads in code type: a verb (`Read`) is a name, a description is prose.
        let titleFont = list ? style.font(14)
            : style.toolRun == .labelled ? (presentation.isCommand ? style.mono(12) : style.font(13, action == nil ? .regular : .medium))
            : mono ? style.mono(12) : style.font(13)
        let header = DisclosureSpec(
            icon: presentation.running ? .spinner : .symbol(ToolSymbols.symbol(presentation.kind), size: 12, color: style.color(\.fg4)),
            title: action?.verb ?? presentation.title,
            titleFont: titleFont,
            detail: background ? nil : detail,
            inline: inline,
            trailing: trailing,
            chevron: presentation.opensSubagent ? .arrow : list ? .always(open: open) : .hover(open: open),
            action: presentation.opensSubagent ? .openSubagent(id: presentation.id, title: presentation.title) : .toggle(id),
            help: list ? action.flatMap { $0.path ? $0.object : nil } : nil,
            variant: callVariant(extended: open || !presentation.images.isEmpty),
            reserve: list ? reserve : 0
        )
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: headerWidth, height: rowH), kind: .disclosure(header)))
        if let stop, let stopSize {
            fragments.append(Fragment(frame: CGRect(x: x + width - tail - stopSize.width, y: list ? y + (rowH - stopSize.height) / 2 : y, width: stopSize.width, height: stopSize.height), kind: .button(stop)))
        }
        var cursor = y + rowH
        let images = Array(presentation.images)
        if !open, !images.isEmpty {
            cursor += 4
            for (index, image) in images.enumerated() {
                if index > 0 { cursor += 8 }
                cursor += toolImage(image, maxHeight: 220, x: x + lead, y: cursor, width: width - lead - tail)
            }
            cursor += 4
        }
        if open {
            cursor += 4
            if background, !presentation.isCommand {
                cursor += textBlock(text.plain(presentation.title, size: 13, color: style.color(\.fg2)), x: x + lead, y: cursor, width: width - lead - tail) + 8
            }
            cursor += toolDetails(presentation, x: x + lead, y: cursor, width: width - lead - tail)
            if background, let activity {
                cursor += 8 + backgroundTaskMetadata(activity, fallbackTime: nil, x: x + lead, y: cursor + 8, width: width - lead - tail)
            }
            cursor += 8
        }
        return cursor - y
    }

    private mutating func toolDetails(_ presentation: ToolPresentation, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        var cursor = y
        var first = true
        func gap() -> CGFloat {
            defer { first = false }
            return first ? 0 : 8
        }
        if let command = presentation.command {
            cursor += gap()
            cursor += codeBlock(command, language: "shell", prefix: "$ ", maxHeight: 220, syntax: nil, x: x, y: cursor, width: width)
        }
        let locations = Array(presentation.locations)
        if !locations.isEmpty {
            cursor += gap()
            var items: [(CGSize, Fragment.Kind)] = []
            for location in locations {
                let line = location.line?.intValue
                let chip = ChipSpec(text: line.map { "\(location.path):\($0)" } ?? location.path, symbol: "doc", action: .openFile(path: location.path, line: line), help: String(localized: "预览 \(location.path)（⌘ 点击用编辑器打开）"))
                items.append((chipSize(chip, size: 12, padX: 7, padY: 3, width: width), .chip(chip)))
            }
            cursor += flow(items, left: x, width: width, y: cursor, spacing: 6)
        }
        for block in presentation.blocks {
            cursor += gap()
            switch onEnum(of: block) {
            case let .questionAnswer(answer):
                let value = NSMutableAttributedString()
                if let question = answer.question { value.append(text.plain(question + "\n", size: 13, color: style.color(\.fg3))) }
                if !answer.options.isEmpty { value.append(text.plain(String(localized: "选项：\(answer.options.joined(separator: String(localized: "、")))\n"), size: 12, color: style.color(\.fg3))) }
                value.append(text.plain(answer.answers.isEmpty ? String(localized: "已跳过") : answer.answers.joined(separator: String(localized: "、")), size: 13, color: style.color(\.fg)))
                cursor += textBlock(value, x: x, y: cursor, width: width)
            case let .diff(diff):
                cursor += self.diff(path: diff.path, diff: diff.diff, before: diff.before, after: diff.after, x: x, y: cursor, width: width)
            case let .terminal(terminal):
                cursor += textBlock(text.plain(String(localized: "终端输出 · \(terminal.terminalId)"), size: 12, color: style.color(\.fg4)), x: x, y: cursor, width: width, selectable: false)
            case let .text(output):
                cursor += codeBlock(output.text, language: nil, prefix: nil, maxHeight: 320, syntax: outputSyntax(output.text, presentation), x: x, y: cursor, width: width)
            case let .image(image):
                cursor += toolImage(image.image, maxHeight: 420, x: x, y: cursor, width: width)
            }
        }
        if !presentation.hasDetails {
            cursor += gap()
            cursor += textBlock(text.plain(String(localized: "没有更多详情"), size: 12, color: style.color(\.fg4)), x: x, y: cursor, width: width, selectable: false)
        }
        return cursor - y
    }

    /// Output of a tool that touched exactly one file reads in that file's language.
    private func outputSyntax(_ output: String, _ presentation: ToolPresentation) -> String? {
        let head = output.first { !$0.isWhitespace }
        if head == "{" || head == "[" { return "json" }
        guard presentation.locations.count == 1 else { return nil }
        return CodeHighlighter.language(forPath: presentation.locations[0].path)
    }

    private mutating func toolImage(_ image: ToolImage, maxHeight: CGFloat, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let source: TimelineImageSource
        let label: String
        if let path = image.path {
            source = .url(path)
            label = image.caption
        } else if let data = image.dataUrl {
            source = .url(data)
            label = image.mimeType ?? image.caption
        } else {
            let line = TextLayout(text.plain(image.placeholder, size: 12, color: style.color(\.fg4)), width: width)
            fragments.append(Fragment(frame: CGRect(x: x, y: y, width: line.size.width, height: line.size.height), kind: .text(line, selectable: false)))
            return line.size.height
        }
        let (size, spec) = self.image(source, label: label, maxHeight: maxHeight, width: width)
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: size.width, height: size.height), kind: .image(spec)))
        return size.height
    }

    private mutating func job(_ job: NativeJob, key: String, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let id = "job:\(job.id ?? key)"
        let list = style.toolRun == .list
        let rowH = callRow
        let lead: CGFloat = list ? 15 : 24
        let tail: CGFloat = list ? 15 : 0
        let open = ui.isOpen(id)
        let running = job.status == .running
        if running { ticking = true }
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: width, height: rowH), kind: .disclosure(DisclosureSpec(
            icon: running ? .spinner : .symbol("apple.terminal", size: 12, color: style.color(\.fg4)),
            title: job.title,
            titleFont: list ? style.font(14) : style.font(13),
            inline: job.status == .failed ? [outcomePiece(failed: true)] : job.status == .unknown ? [outcomePiece(failed: false)] : [],
            chevron: list ? .always(open: open) : .hover(open: open),
            action: .toggle(id),
            variant: callVariant(extended: open)
        ))))
        guard open else { return rowH }
        var cursor = y + rowH + 4
        if !job.title.isEmpty, job.title.trimmingCharacters(in: .whitespacesAndNewlines) != job.command.trimmingCharacters(in: .whitespacesAndNewlines) {
            cursor += textBlock(text.plain(job.title, size: 13, color: style.color(\.fg2)), x: x + lead, y: cursor, width: width - lead - tail) + 8
        }
        if !job.command.isEmpty {
            cursor += codeBlock(job.command, language: "shell", prefix: "$ ", maxHeight: 220, syntax: nil, x: x + lead, y: cursor, width: width - lead - tail) + 8
        }
        if let output = job.output, !output.isEmpty {
            cursor += codeBlock(output, language: "output", prefix: nil, maxHeight: 384, syntax: nil, x: x + lead, y: cursor, width: width - lead - tail)
        } else {
            cursor += textBlock(text.plain(running ? String(localized: "还没有输出…") : String(localized: "没有输出"), size: 12, color: style.color(\.fg4)), x: x + lead, y: cursor, width: width - lead - tail, selectable: false)
        }
        cursor += 6
        fragments.append(Fragment(frame: CGRect(x: x + lead, y: cursor, width: width - lead - tail, height: 20), kind: .footer(FooterSpec(time: job.startedAt, copy: "", trailing: false, clock: .job(job)))))
        cursor += 20
        let info = NSMutableAttributedString()
        if let shell = job.id { info.append(text.plain("shell \(shell)", size: 11, color: style.color(\.fg4), mono: true)) }
        if let exit = job.exitCode?.int64Value, exit != 0 {
            if info.length > 0 { info.append(text.plain("   ", size: 11, color: style.color(\.fg4))) }
            info.append(text.plain("exit \(exit)", size: 11, color: style.color(\.fg3), mono: true))
        }
        if job.truncated?.boolValue == true {
            if info.length > 0 { info.append(text.plain("   ", size: 11, color: style.color(\.fg4))) }
            info.append(text.plain(String(localized: "输出过大，只显示末尾"), size: 12, color: style.color(\.fg4)))
        }
        if info.length > 0 {
            cursor += 6
            cursor += textBlock(info, x: x + lead, y: cursor, width: width - lead - tail)
        }
        return cursor + 8 - y
    }

    private mutating func plan(_ entries: [TodoEntry], x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        var cursor = y
        for (index, entry) in entries.enumerated() {
            if index > 0 { cursor += 5 }
            let done = entry.status == .completed
            let value = NSMutableAttributedString(attributedString: text.symbol(
                done ? "checkmark.circle.fill" : entry.status == .inProgress ? "circle.dotted.circle" : "circle",
                size: 12, color: done ? style.color(\.success) : entry.status == .inProgress ? style.color(style.mark) : style.color(\.fg4),
                plain: done ? "[x] " : "[ ] "
            ))
            value.append(text.plain("\t", size: 13, color: style.color(\.fg2)))
            var attributes: [NSAttributedString.Key: Any] = [.font: style.font(13), .foregroundColor: done ? style.color(\.fg4) : style.color(\.fg2)]
            if done {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                attributes[.strikethroughColor] = style.color(\.fg4)
            }
            value.append(NSAttributedString(string: entry.content, attributes: attributes))
            let paragraph = NSMutableParagraphStyle()
            paragraph.tabStops = [NSTextTab(textAlignment: .left, location: style.s(12) + 8)]
            paragraph.headIndent = style.s(12) + 8
            value.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: value.length))
            cursor += textBlock(value, x: x, y: cursor, width: width)
        }
        return cursor - y
    }

    private mutating func notice(_ notice: TimelineItemTaskNotification, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let id = "notice:\(notice.key)"
        let open = ui.isOpen(id)
        let running = notice.status == .running
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: width, height: style.row), kind: .disclosure(DisclosureSpec(
            icon: running ? .spinner : .symbol(notice.taskKind == "subagent" ? "person.crop.square" : "apple.terminal", size: 12, color: style.color(\.fg4)),
            title: notice.title,
            titleFont: style.font(13),
            inline: notice.status == .failed ? [outcomePiece(failed: true)] : notice.status == .unknown ? [outcomePiece(failed: false)] : [],
            chevron: .hover(open: open),
            action: .toggle(id),
            help: notice.title
        ))))
        guard open else { return style.row }
        var cursor = y + style.row + 4
        if let command = notice.command, !command.isEmpty {
            cursor += codeBlock(command, language: "shell", prefix: "$ ", maxHeight: 220, syntax: nil, x: x + 24, y: cursor, width: width - 24) + 8
        }
        if let detail = notice.detail, !detail.isEmpty {
            cursor += codeBlock(detail, language: "output", prefix: nil, maxHeight: 320, syntax: nil, x: x + 24, y: cursor, width: width - 24) + 8
        }
        let metadata = [
            formatDateTime(value: timelineItemTime(item: notice)),
            notice.jobResult?.runningMs.map { formatDurationMs(millis: $0.int64Value) },
            notice.jobResult?.exitCode.map { "exit \($0.int64Value)" }
        ].compactMap { $0 }.joined(separator: " · ")
        if !metadata.isEmpty {
            cursor += textBlock(text.plain(metadata, size: 12, color: style.color(\.fg4)), x: x + 24, y: cursor, width: width - 24) + 8
        }
        return cursor - y
    }

    /// 系统活动: compaction, a background task, a local command's output. The words come from the shared
    /// `activityView`; this is the Mac's drawing of them.
    private mutating func activity(_ item: TimelineItemActivity, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let activity = item.activity
        let stopping = ui.isStopping(activity.id)
        let view = activityView(activity: activity, stopping: stopping, nowMillis: Int64(Date().timeIntervalSince1970 * 1000))
        if activity.kind == .localCommand, let command = activity.task?.command, !command.isEmpty {
            return shellRow(item, command: command, x: x, y: y, width: width)
        }
        if activity.kind == .localCommand || activity.kind == .unknown {
            // A command's own output: one quiet line, nothing to open.
            let layout = TextLayout(text.plain(view.summary, size: 12, color: style.color(\.fg4)), width: width - 24)
            fragments.append(Fragment(frame: CGRect(x: x + 24, y: y + 3, width: layout.size.width, height: layout.size.height), kind: .text(layout, selectable: true)))
            return layout.size.height + 6
        }
        let background = activity.kind == .backgroundTask
        let id = "activity:\(item.key)"
        let open = (background || view.expandable) && ui.isOpen(id)
        if view.running { ticking = true }
        let stop = view.canStop ? ButtonSpec(title: String(localized: "停止"), action: .stopActivity(id: activity.id, warning: view.stopWarning), loading: false) : nil
        let stopSize = stop.map(buttonSize)
        let headerWidth = width - (stopSize.map { $0.width + 6 } ?? 0)
        // A compaction's numbers once it is done (`29.4 万 → 5.2 万 · 2 分 8 秒`) are what it did, and
        // follow its title; a task's own clock lives in the expansion.
        let figures = !background && !view.running && view.tone != .failed ? view.stats : nil
        var inline: [DisclosureSpec.Piece] = figures.map { [.init(text: "· \($0)", font: style.figures(13), color: style.color(\.fg3))] } ?? []
        if background, let outcome = outcomePiece(activity) { inline.append(outcome) }
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: headerWidth, height: style.row), kind: .disclosure(DisclosureSpec(
            icon: view.running ? .spinner : .symbol(activity.kind == .compaction ? "arrow.down.right.and.arrow.up.left" : view.tone == .failed ? "exclamationmark.circle" : "apple.terminal", size: 12, color: style.color(\.fg4)),
            title: background ? (view.subject ?? view.label) : view.label,
            titleFont: style.font(13),
            detail: background ? nil : view.subject.map { .init(text: $0, font: style.font(13), color: style.color(\.fg3)) },
            inline: inline,
            trailing: background ? stoppingPiece(activity, stopping: stopping).map { [$0] } ?? [] : [],
            chevron: .hover(open: open),
            action: .toggle(id)
        ))))
        if let stop, let stopSize {
            fragments.append(Fragment(frame: CGRect(x: x + width - stopSize.width, y: y, width: stopSize.width, height: stopSize.height), kind: .button(stop)))
        }
        guard open else { return style.row }
        var cursor = y + style.row + 4
        if background, !activity.title.isEmpty, activity.title.trimmingCharacters(in: .whitespacesAndNewlines) != activity.task?.command?.trimmingCharacters(in: .whitespacesAndNewlines) {
            cursor += textBlock(text.plain(activity.title, size: 13, color: style.color(\.fg2)), x: x + 24, y: cursor, width: width - 24) + 8
        }
        if let command = activity.task?.command, !command.isEmpty, background || command.trimmingCharacters(in: .whitespaces) != activity.title.trimmingCharacters(in: .whitespaces) {
            cursor += codeBlock(command, language: "shell", prefix: "$ ", maxHeight: 220, syntax: nil, x: x + 24, y: cursor, width: width - 24) + 8
        }
        let full = activity.blobRef.flatMap { ui.activityText($0) }
        if let body = full ?? activity.detail, !body.isEmpty {
            cursor += codeBlock(body, language: "output", prefix: nil, maxHeight: 320, syntax: nil, x: x + 24, y: cursor, width: width - 24) + 8
        }
        if let ref = activity.blobRef, full == nil {
            let state = ui.activityTextState(ref)
            let button = ButtonSpec(title: state.failed ? String(localized: "读取失败，重试") : String(localized: "查看全文"), action: state.loading ? nil : .loadActivityText(blobRef: ref), loading: state.loading)
            let size = buttonSize(button)
            fragments.append(Fragment(frame: CGRect(x: x + 24, y: cursor, width: size.width, height: size.height), kind: .button(button)))
            cursor += size.height + 8
        }
        if background {
            cursor += backgroundTaskMetadata(activity, fallbackTime: timelineItemTime(item: item), x: x + 24, y: cursor, width: width - 24)
        }
        if let warning = view.stopWarning, view.canStop {
            cursor += textBlock(text.plain(warning, size: 12, color: style.color(\.fg4)), x: x + 24, y: cursor, width: width - 24, selectable: false) + 8
        }
        return cursor - y
    }

    /// A command the reader ran themselves (`!cmd`): a tool-row header, the command's output beneath.
    private mutating func shellRow(_ item: TimelineItemActivity, command: String, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let activity = item.activity
        let id = "activity:\(item.key)"
        let running = activity.status == .running
        if running { ticking = true }
        let detail = activity.detail ?? ""
        let ref = activity.blobRef
        let expandable = !detail.isEmpty || ref != nil
        let open = expandable && ui.isOpen(id)
        let firstLine = command.split(whereSeparator: \.isNewline).first.map(String.init) ?? command
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: width, height: style.row), kind: .disclosure(DisclosureSpec(
            icon: running ? .spinner : .symbol(ToolSymbols.symbol("execute"), size: 12, color: style.color(\.fg4)),
            title: "!",
            titleFont: style.mono(12),
            detail: .init(text: firstLine, font: style.mono(12), color: style.color(\.fg3)),
            inline: activity.status == .unknown ? [outcomePiece(failed: false)] : [],
            chevron: .hover(open: open),
            action: .toggle(id),
            help: command
        ))))
        guard open || (!running && !detail.isEmpty) else { return style.row }
        var cursor = y + style.row + 4
        if !open {
            let tail = detail.split(separator: "\n", omittingEmptySubsequences: false).suffix(6).joined(separator: "\n")
            cursor += codeBlock(tail, language: "output", prefix: nil, maxHeight: 320, syntax: nil, x: x + 24, y: cursor, width: width - 24) + 8
            return cursor - y
        }
        let full = ref.flatMap { ui.activityText($0) }
        if let body = full ?? (detail.isEmpty ? nil : detail) {
            cursor += codeBlock(body, language: "output", prefix: nil, maxHeight: 320, syntax: nil, x: x + 24, y: cursor, width: width - 24) + 8
        }
        if let ref, full == nil {
            let state = ui.activityTextState(ref)
            let button = ButtonSpec(title: state.failed ? String(localized: "读取失败，重试") : String(localized: "查看全文"), action: state.loading ? nil : .loadActivityText(blobRef: ref), loading: state.loading)
            let size = buttonSize(button)
            fragments.append(Fragment(frame: CGRect(x: x + 24, y: cursor, width: size.width, height: size.height), kind: .button(button)))
            cursor += size.height + 8
        }
        return cursor - y
    }

    /// The one thing a row's end shows besides its stop button: a stop under way, which the reader asked for.
    private func stoppingPiece(_ activity: NativeActivity, stopping: Bool) -> DisclosureSpec.Piece? {
        guard activity.status == .stopping || (stopping && activity.status == .running) else { return nil }
        return .init(text: String(localized: "停止中"), font: style.font(12), color: style.color(\.fg4))
    }

    /// The word after a row's title when it did not end well: a task that failed, or one that never settled.
    private func outcomePiece(failed: Bool) -> DisclosureSpec.Piece {
        .init(text: failed ? String(localized: "失败") : String(localized: "未完成"), font: style.font(12), color: failed ? style.color(\.danger) : style.color(\.fg4))
    }

    private func outcomePiece(_ activity: NativeActivity) -> DisclosureSpec.Piece? {
        let exit = activity.task?.exitCode?.int64Value
        if activity.status == .failed || (activity.status == .completed && exit != nil && exit != 0) { return outcomePiece(failed: true) }
        return activity.status == .unknown ? outcomePiece(failed: false) : nil
    }


    private mutating func backgroundTaskMetadata(_ activity: NativeActivity, fallbackTime: String?, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: width, height: 20), kind: .footer(FooterSpec(
            time: activity.startedAt ?? fallbackTime, copy: "", trailing: false,
            clock: .activity(activity, stopping: ui.isStopping(activity.id))
        ))))
        return 28
    }

    private mutating func triggerRow(_ row: TimelineRowTrigger, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        var cursor = y
        for (index, notice) in row.notices.enumerated() {
            if index > 0 { cursor += 4 }
            let start = fragments.count
            cursor += self.notice(notice, x: x, y: cursor, width: width)
            items.append(RowLayout.ItemSpan(item: notice, fragments: start..<fragments.count))
        }
        return cursor - y
    }

    // MARK: Markdown

    /// An agent's Markdown at [width]; returns its height.
    mutating func markdown(_ source: String, x: CGFloat, y: CGFloat, width: CGFloat, muted: Bool, compact: Bool, bodySize: CGFloat = MarkdownStyle.bodySize, bodyLineHeight: CGFloat? = nil, bodyColor: NSColor? = nil) -> CGFloat {
        let bodyLineHeight = bodyLineHeight ?? style.bodyLineHeight
        let gap: CGFloat = compact ? MarkdownStyle.compactBlockGap : MarkdownStyle.blockGap
        var cursor = y
        var first = true
        // Of a streaming row's text only the last block can still grow; Markdown inside a block (a
        // rendered fence) grows only when that block does.
        let enclosing = markdownDepth == 0 ? live : growing
        markdownDepth += 1
        defer {
            markdownDepth -= 1
            growing = enclosing && markdownDepth > 0
        }
        let segments = MarkdownModel.segments(source, live: live)
        for (segmentIndex, segment) in segments.enumerated() {
            switch segment {
            case let .blocks(parts):
                for (partIndex, part) in parts.enumerated() {
                    if !first { cursor += gap }
                    first = false
                    growing = enclosing && segmentIndex == segments.count - 1 && partIndex == parts.count - 1
                    cursor += self.part(part, x: x, y: cursor, width: width, muted: muted, quoted: false, gap: gap, size: bodySize, lineHeight: bodyLineHeight, color: bodyColor)
                }
            case let .math(tex):
                if !first { cursor += gap }
                first = false
                cursor += displayMath(tex, x: x, y: cursor, width: width)
            case let .image(alt, src):
                if !first { cursor += gap }
                first = false
                let (size, spec) = image(.url(src), label: alt.isEmpty ? src : alt, maxHeight: 420, width: width)
                fragments.append(Fragment(frame: CGRect(x: x, y: cursor, width: size.width, height: size.height), kind: .image(spec)))
                cursor += size.height
            case let .visualization(path, title, wide):
                if !first { cursor += gap }
                first = false
                let card = CardSpec(path: path, title: VisualizationPresentation.title(path: path, supplied: title), wide: wide)
                fragments.append(Fragment(frame: CGRect(x: x, y: cursor, width: width, height: 52), kind: .card(card)))
                cursor += 52
            }
        }
        return cursor - y
    }

    private mutating func part(_ part: MarkdownPart, x: CGFloat, y: CGFloat, width: CGFloat, muted: Bool, quoted: Bool, gap: CGFloat, size: CGFloat = MarkdownStyle.bodySize, lineHeight: CGFloat? = nil, color: NSColor? = nil) -> CGFloat {
        let lineHeight = lineHeight ?? style.bodyLineHeight
        switch part {
        case let .prose(run):
            let top: CGFloat = run.leadingHeading ? MarkdownStyle.headingBlockTop : 0
            let value = text.prose(run.blocks, muted: muted, quoted: quoted, gap: gap, size: size, lineHeight: lineHeight, color: color, headings: collectsChapters && markdownDepth == 1 && !quoted)
            return top + textBlock(value, x: x, y: y + top, width: width)
        case let .block(block):
            return self.block(block, x: x, y: y, width: width, muted: muted, quoted: quoted, size: size, lineHeight: lineHeight, color: color)
        }
    }

    private mutating func block(_ block: MarkdownBlock, x: CGFloat, y: CGFloat, width: CGFloat, muted: Bool, quoted: Bool, size: CGFloat = MarkdownStyle.bodySize, lineHeight: CGFloat? = nil, color: NSColor? = nil) -> CGFloat {
        let lineHeight = lineHeight ?? style.bodyLineHeight
        switch block {
        case .paragraph, .heading:
            let value = text.prose([block], muted: muted, quoted: quoted, gap: 0, size: size, lineHeight: lineHeight, color: color)
            let top: CGFloat = if case .heading = block { MarkdownStyle.headingBlockTop } else { 0 }
            return top + textBlock(value, x: x, y: y + top, width: width)
        case let .code(language, code):
            if let language, ["math", "latex", "tex"].contains(language.lowercased()) {
                return displayMath(code, x: x, y: y, width: width)
            }
            return codeBlock(code, language: language, prefix: nil, maxHeight: 520, syntax: nil, x: x, y: y, width: width)
        case let .list(ordered, start, items):
            // The same marker column as the prose path in `TranscriptText.list`, from the shared
            // tokens: a list that gains a code block must not change its geometry mid-document.
            var cursor = y
            let markerWidth: CGFloat = ordered ? MarkdownStyle.orderedMarkerBox : MarkdownStyle.unorderedMarkerBox
            let content = x + markerWidth + MarkdownStyle.markerTextGap
            for (index, item) in items.enumerated() {
                if index > 0 { cursor += MarkdownStyle.listItemGap }
                let marker = TextLayout(text.marker(ordered: ordered, number: start + index, checkbox: item.checkbox, size: size), width: markerWidth)
                let markerX = ordered ? x + markerWidth - marker.size.width : x + (markerWidth - marker.size.width) / 2
                fragments.append(Fragment(frame: CGRect(x: markerX, y: cursor + max(0, (style.s(lineHeight) - marker.size.height) / 2), width: marker.size.width, height: marker.size.height), kind: .text(marker, selectable: false)))
                var inner = cursor
                for (blockIndex, child) in item.blocks.enumerated() {
                    if blockIndex > 0 { inner += MarkdownStyle.listBlockGap }
                    inner += self.block(child, x: content, y: inner, width: width - (content - x), muted: muted, quoted: quoted, size: size, lineHeight: lineHeight, color: color)
                }
                cursor = max(inner, cursor + marker.size.height)
            }
            return cursor - y
        case let .quote(parts):
            var cursor = y
            for (index, part) in parts.enumerated() {
                if index > 0 { cursor += MarkdownStyle.blockGap }
                cursor += self.part(part, x: x + MarkdownStyle.quoteInset, y: cursor, width: width - MarkdownStyle.quoteInset, muted: muted, quoted: true, gap: MarkdownStyle.blockGap, size: size, lineHeight: lineHeight, color: color)
            }
            fragments.append(Fragment(frame: CGRect(x: x, y: y, width: 2, height: cursor - y), kind: .box(BoxSpec(fill: style.color(\.lineStrong), radius: 1))))
            return cursor - y
        case let .table(header, rows, alignments):
            return table(header: header, rows: rows, alignments: alignments, x: x, y: y, width: width)
        case .rule:
            fragments.append(Fragment(frame: CGRect(x: x, y: y + 8, width: width, height: 1), kind: .box(BoxSpec(fill: style.color(\.line)))))
            return 17
        }
    }

    private mutating func displayMath(_ tex: String, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let request = MathRequest(tex: tex, theme: style.palette.values.id, dark: style.dark, display: true, scale: style.scale, color: style.hex(\.fg))
        if let rendered = MathImages.image(request) {
            var size = rendered.image.size
            if size.width > width, size.width > 0 { size = CGSize(width: width, height: size.height * width / size.width) }
            fragments.append(Fragment(frame: CGRect(x: x, y: y + 4, width: size.width, height: size.height), kind: .math(rendered.image)))
            return size.height + 8
        }
        pending.insert(MathImages.token(request))
        guard !MathImages.isFailed(request) else {
            return textBlock(text.plain(tex, size: MarkdownStyle.codeSize, color: style.color(\.fg3), mono: true), x: x, y: y, width: width)
        }
        // While it renders the formula's room stays empty, at the size it had before or an estimate,
        // rather than flashing its TeX; the snapshot fades in there.
        var size = MathImages.size(request)?.size ?? CGSize(width: 1, height: Self.estimatedMathHeight(tex, style: style))
        if size.width > width, size.width > 0 { size = CGSize(width: width, height: size.height * width / size.width) }
        return size.height + 8
    }

    /// A display formula's height before its first snapshot: a line of KaTeX per `\\` row.
    private static func estimatedMathHeight(_ tex: String, style: TranscriptStyle) -> CGFloat {
        let rows = min(12, tex.components(separatedBy: "\\\\").count)
        let tall = tex.contains("\\frac") || tex.contains("\\sum") || tex.contains("\\int") || tex.contains("\\begin")
        return style.s(CGFloat(rows) * 26 + (tall ? 14 : 4))
    }

    // MARK: Blocks

    @discardableResult
    private mutating func textBlock(_ value: NSAttributedString, x: CGFloat, y: CGFloat, width: CGFloat, selectable: Bool = true) -> CGFloat {
        let layout = TextLayout(value, width: width)
        var headings: [RowLayout.Chapter] = []
        value.enumerateAttribute(.riffetHeading, in: NSRange(location: 0, length: value.length)) { level, range, _ in
            guard let level = level as? Int else { return }
            let title = layout.plain(range).components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
            guard !title.isEmpty else { return }
            let glyphs = layout.manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            let rect = layout.manager.boundingRect(forGlyphRange: glyphs, in: layout.container).offsetBy(dx: x, dy: y)
            headings.append(RowLayout.Chapter(level: level, title: title, rect: rect))
        }
        chapters += headings
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: max(layout.size.width, min(width, layout.size.width + 4)), height: layout.size.height), kind: .text(layout, selectable: selectable)))
        return layout.size.height
    }

    /// A fenced block or tool output: header, the source (folded past [maxHeight]), a fold bar.
    private mutating func codeBlock(_ code: String, language: String?, prefix: String?, maxHeight: CGFloat, syntax: String?, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        codeIndex += 1
        let id = "\(owner)#code\(codeIndex)"
        let grammar = syntax ?? language.flatMap(CodeHighlighter.language(forFence:))
        let isDiagram = MermaidRequest.supports(language) && prefix == nil
        let canRender = (grammar == "markdown" || isDiagram) && prefix == nil
        let wantsRendered = canRender && ui.isRendered(id, default: isDiagram)
        var diagram: NSImage?
        // A diagram on its way that was drawn before: its room, kept empty until it lands.
        var reserved: CGSize?
        // Only the block still streaming waits; a finished fence above it renders now rather than
        // all at once when the reply ends.
        if isDiagram && wantsRendered && !growing {
            let request = MermaidRequest(source: code, dark: style.dark, scale: style.scale, color: style.hex(\.fg), background: style.hex(style.block == .filled ? \.bgSubtle : style.paper), line: style.hex(\.lineStrong), accent: style.hex(\.accent), language: language?.lowercased() ?? "mermaid")
            switch MermaidImages.image(request) {
            case let .image(image): diagram = image
            case let .pending(token):
                pending.insert(token)
                reserved = MermaidImages.size(request)
            case .failed: break
            }
        }
        let rendered = isDiagram ? diagram != nil || reserved != nil : wantsRendered
        // A diagram loading for the first time, or an invalid one, is still a normal source block.
        // Offer the preview action once there is a usable image, or when the reader has explicitly
        // switched to source.
        let renderAvailable = canRender && (!isDiagram || (!growing && (!wantsRendered || diagram != nil)))
        let wraps = ui.isWrapped(id)
        let boxIndex = fragments.count
        fragments.append(Fragment(frame: .zero, kind: .box(style.blockBox(radius: style.radii.container))))
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: width, height: MarkdownStyle.codeHeaderHeight), kind: .codeHeader(CodeHeaderSpec(id: id, label: language ?? "code", copy: code, canRender: renderAvailable, rendered: rendered, wraps: wraps))))
        var cursor = y + MarkdownStyle.codeHeaderHeight
        if let natural = diagram?.size ?? reserved {
            let available = max(1, width - 24)
            let factor = min(1, available / max(1, natural.width))
            let size = CGSize(width: natural.width * factor, height: natural.height * factor)
            if let diagram {
                fragments.append(Fragment(frame: CGRect(x: x + 12, y: cursor + 12, width: size.width, height: size.height), kind: .math(diagram)))
            }
            cursor += size.height + 24
        } else if rendered {
            cursor += markdown(code, x: x + 12, y: cursor, width: width - 24, muted: false, compact: true) + 12
        } else {
            var runs: [CodeHighlighter.Run]?
            if let grammar {
                runs = CodeHighlighter.shared.cached(code, language: grammar)
                if runs == nil, code.utf16.count <= CodeHighlighter.maxLength {
                    let token = "code:\(grammar)|\(code.hashValue)"
                    if CodeHighlighter.shared.prepare(code, language: grammar, token: token, slot: id) { pending.insert(token) }
                }
            }
            let lines = code.reduce(into: 1) { count, character in if character == "\n" { count += 1 } }
            let tail = language == "output"
            var value = text.code(code, runs: runs, prefix: prefix)
            // Past this, the rest stays behind the copy button: laying out tens of thousands of lines
            // costs more than anyone scrolls through inside a block.
            if lines > Self.codeLineLimit { value = Self.slice(value, lines: Self.codeLineLimit, tail: tail) }
            let layout = TextLayout(value, width: width - 24, wraps: wraps)
            let contentHeight = layout.size.height + 12
            let bodyHeight = min(contentHeight, max(60, maxHeight - MarkdownStyle.codeHeaderHeight))
            fragments.append(Fragment(frame: CGRect(x: x + 1, y: cursor, width: width - 2, height: bodyHeight), kind: .codeBody(CodeBodySpec(text: layout, wraps: wraps, inset: MarkdownStyle.codeBodyInset, contentHeight: contentHeight, startAtEnd: tail))))
            cursor += bodyHeight
        }
        fragments[boxIndex].frame = CGRect(x: x, y: y, width: width, height: cursor - y)
        return cursor - y
    }

    static let codeLineLimit = 4000

    /// The first (or last) [lines] lines of [value].
    private static func slice(_ value: NSAttributedString, lines: Int, tail: Bool) -> NSAttributedString {
        let string = value.string as NSString
        if tail {
            var location = string.length
            var count = 0
            while location > 0 {
                let range = string.range(of: "\n", options: .backwards, range: NSRange(location: 0, length: location))
                guard range.location != NSNotFound else { location = 0; break }
                count += 1
                if count == lines { location = range.location + 1; break }
                location = range.location
            }
            return value.attributedSubstring(from: NSRange(location: location, length: string.length - location))
        }
        var location = 0
        for _ in 0..<lines {
            let range = string.range(of: "\n", range: NSRange(location: location, length: string.length - location))
            guard range.location != NSNotFound else { return value }
            location = range.location + 1
        }
        return value.attributedSubstring(from: NSRange(location: 0, length: max(0, location - 1)))
    }

    private mutating func diff(path: String?, diff: LineDiff?, before: String, after: String, x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let boxIndex = fragments.count
        fragments.append(Fragment(frame: .zero, kind: .box(BoxSpec(fill: style.color(\.bg), stroke: style.color(\.line), radius: min(8, style.radii.container)))))
        var cursor = y
        if let path {
            let first = diff?.lines.first { $0.type == .add || $0.type == .del }.flatMap { ($0.newNo ?? $0.oldNo)?.intValue }
            fragments.append(Fragment(frame: CGRect(x: x + 1, y: cursor + 1, width: width - 2, height: 27), kind: .diffHeader(DiffHeaderSpec(path: path, line: first, added: Int(diff?.added ?? 0), removed: Int(diff?.removed ?? 0)))))
            cursor += 28
        }
        let lines = Self.diffLines(diff, before: before, after: after, limit: Self.codeLineLimit)
        let spec = Self.diffSpec(lines, style: style)
        let height = min(CGFloat(lines.count) * spec.lineHeight + 8, 420)
        fragments.append(Fragment(frame: CGRect(x: x + 1, y: cursor, width: width - 2, height: height), kind: .diff(spec)))
        cursor += height
        fragments[boxIndex].frame = CGRect(x: x, y: y, width: width, height: cursor - y)
        return cursor - y
    }

    private mutating func table(header: [AttributedString], rows: [[AttributedString]], alignments: [MarkdownTableAlignment], x: CGFloat, y: CGFloat, width: CGFloat) -> CGFloat {
        let columns = max(header.count, rows.map(\.count).max() ?? 0)
        guard columns > 0 else { return 0 }
        let maxText: CGFloat = 336
        func nsAlignment(_ column: Int) -> NSTextAlignment {
            guard column < alignments.count else { return .left }
            switch alignments[column] {
            case .center: return .center
            case .right: return .right
            case .left: return .left
            }
        }
        func attributed(_ value: AttributedString?, header: Bool, alignment: NSTextAlignment) -> NSAttributedString {
            text.cell(value ?? AttributedString(""), size: 13, lineHeight: 20, weight: header ? .medium : .regular, color: header ? style.color(\.fg2) : style.color(\.fg), alignment: alignment)
        }
        func naturalLayout(_ value: AttributedString?, header: Bool, alignment: NSTextAlignment) -> TextLayout {
            let attr = attributed(value, header: header, alignment: alignment)
            let natural = TextLayout(attr, width: maxText, wraps: false)
            return natural.size.width <= maxText ? natural : TextLayout(attr, width: maxText)
        }
        var headerCells = (0..<columns).map { naturalLayout($0 < header.count ? header[$0] : nil, header: true, alignment: nsAlignment($0)) }
        var bodyCells = rows.map { row in (0..<columns).map { naturalLayout($0 < row.count ? row[$0] : nil, header: false, alignment: nsAlignment($0)) } }
        var widths = headerCells.map { $0.size.width + 24 }
        for row in bodyCells {
            for (index, layout) in row.enumerated() { widths[index] = max(widths[index], layout.size.width + 24) }
        }
        widths = widths.map { ceil(min(360, max(40, $0))) }
        for column in 0..<columns {
            let align = nsAlignment(column)
            guard align != .left else { continue }
            let cellWidth = max(1, widths[column] - 24)
            headerCells[column] = TextLayout(attributed(column < header.count ? header[column] : nil, header: true, alignment: align), width: cellWidth)
            for rowIndex in rows.indices {
                bodyCells[rowIndex][column] = TextLayout(attributed(column < rows[rowIndex].count ? rows[rowIndex][column] : nil, header: false, alignment: align), width: cellWidth)
            }
        }
        let headerHeight = (headerCells.map(\.size.height).max() ?? 0) + 14
        let rowHeights = bodyCells.map { ($0.map(\.size.height).max() ?? 0) + 14 }
        let spec = TableSpec(header: headerCells, rows: bodyCells, columns: widths, headerHeight: headerHeight, rowHeights: rowHeights)
        let height = headerHeight + rowHeights.reduce(0) { $0 + $1 + 1 } + 2
        fragments.append(Fragment(frame: CGRect(x: x, y: y, width: width, height: height), kind: .table(spec)))
        return height
    }

    // MARK: Small pieces

    /// Matches `MessageAttachments.tsx`'s `imageBox`: uniform 72×72 square tiles when a message has
    /// multiple images, and a clamped 240pt box when there is only one.
    private mutating func userAttachmentImage(_ source: TimelineImageSource, label: String, tile: Bool, declared: CGSize?, width: CGFloat) -> (CGSize, ImageSpec) {
        let key = ImageSizes.key(source, projectId: projectId)
        let known = ImageSizes.size(key)
        if let known, known.width <= 0 || known.height <= 0 {
            return (CGSize(width: min(width, 240), height: 18), ImageSpec(source: source, projectId: projectId, label: label, placeholder: false, failed: true, crop: true))
        }
        if tile {
            if known == nil { pending.insert("image:\(key)") }
            let edge = min(72, width)
            return (CGSize(width: edge, height: edge), ImageSpec(source: source, projectId: projectId, label: label, placeholder: known == nil, failed: false, crop: true))
        }
        // Not loaded in this launch: the size the message declares, else the one it had last time
        // (checked again when the image arrives).
        var remembered: CGSize?
        if known == nil, declared == nil {
            remembered = ImageSizes.remembered(key)
            if remembered != nil { pending.insert("image:\(key)") }
        }
        guard let size = known ?? declared ?? remembered, size.width > 0, size.height > 0 else {
            pending.insert("image:\(key)")
            let edge = min(240, width)
            return (CGSize(width: edge, height: edge), ImageSpec(source: source, projectId: projectId, label: label, placeholder: true, failed: false, crop: true))
        }
        let longEdge = min(240, width)
        let natural = size.width / size.height
        let ratio = min(4.0, max(0.25, natural))
        let boxWidth = ratio >= 1 ? longEdge : longEdge * ratio
        let boxHeight = ratio >= 1 ? longEdge / ratio : longEdge
        let scale = min(1.0, min(size.width / boxWidth, size.height / boxHeight))
        return (
            CGSize(width: max(1, round(boxWidth * scale)), height: max(1, round(boxHeight * scale))),
            ImageSpec(source: source, projectId: projectId, label: label, placeholder: false, failed: false, crop: true)
        )
    }

    private mutating func image(_ source: TimelineImageSource, label: String, maxHeight: CGFloat, width: CGFloat) -> (CGSize, ImageSpec) {
        let key = ImageSizes.key(source, projectId: projectId)
        guard let size = ImageSizes.size(key) else {
            pending.insert("image:\(key)")
            // Loaded in an earlier launch: its room now, checked again when it arrives.
            if let remembered = ImageSizes.remembered(key) {
                let fitted = min(remembered.width, 720, remembered.width * maxHeight / remembered.height, width)
                return (CGSize(width: floor(fitted), height: floor(fitted * remembered.height / remembered.width)), ImageSpec(source: source, projectId: projectId, label: label, placeholder: true, failed: false))
            }
            return (CGSize(width: min(180, width), height: 110), ImageSpec(source: source, projectId: projectId, label: label, placeholder: true, failed: false))
        }
        guard size.width > 0, size.height > 0 else {
            return (CGSize(width: min(width, 240), height: 18), ImageSpec(source: source, projectId: projectId, label: label, placeholder: false, failed: true))
        }
        let fitted = min(size.width, 720, size.width * maxHeight / size.height, width)
        return (CGSize(width: floor(fitted), height: floor(fitted * size.height / size.width)), ImageSpec(source: source, projectId: projectId, label: label, placeholder: false, failed: false))
    }

    private func chipSize(_ chip: ChipSpec, size: CGFloat, padX: CGFloat, padY: CGFloat, width: CGFloat) -> CGSize {
        let font = size == 12 ? style.font(size) : style.mono(size)
        let textWidth = Self.lineWidth(chip.text, font: font)
        return CGSize(width: min(width, ceil(textWidth + style.s(size) + 4 + padX * 2)), height: ceil(font.ascender - font.descender) + padY * 2)
    }

    func buttonSize(_ button: ButtonSpec) -> CGSize {
        if button.compact { return CGSize(width: ceil(Self.lineWidth(button.title, font: style.font(11)) + 12), height: 20) }
        if button.loading { return CGSize(width: 24, height: style.row) }
        return CGSize(width: ceil(Self.lineWidth(button.title, font: style.font(12.5)) + 24), height: style.row)
    }

    /// Lays [items] out in lines; aligned to [left] (or to [right], wrapping leftwards). Returns the height.
    private mutating func flow(_ items: [(CGSize, Fragment.Kind)], left: CGFloat? = nil, right: CGFloat? = nil, width: CGFloat, y: CGFloat, spacing: CGFloat) -> CGFloat {
        var lines: [[(CGSize, Fragment.Kind)]] = [[]]
        var used: CGFloat = 0
        for item in items {
            if !lines[lines.count - 1].isEmpty, used + spacing + item.0.width > width {
                lines.append([])
                used = 0
            }
            used += (lines[lines.count - 1].isEmpty ? 0 : spacing) + item.0.width
            lines[lines.count - 1].append(item)
        }
        var cursor = y
        for (index, line) in lines.enumerated() {
            if index > 0 { cursor += spacing }
            let lineWidth = line.reduce(0) { $0 + $1.0.width } + spacing * CGFloat(max(0, line.count - 1))
            var cx = left ?? ((right ?? 0) - lineWidth)
            let height = line.map(\.0.height).max() ?? 0
            for item in line {
                fragments.append(Fragment(frame: CGRect(x: cx, y: cursor, width: item.0.width, height: item.0.height), kind: item.1))
                cx += item.0.width + spacing
            }
            cursor += height
        }
        return cursor - y
    }

    /// A unified diff as lines; without one (a file too large to diff), before then after, each
    /// side with half of [limit] so the new text always shows. A cut ends in a line saying so.
    static func diffLines(_ diff: LineDiff?, before: String, after: String, limit: Int = .max, english: Bool = false) -> [DiffLineSpec] {
        var lines: [DiffLineSpec] = []
        func omitted(_ count: Int) -> DiffLineSpec { DiffLineSpec(kind: .gap, old: "", new: "", text: english ? "\(count) more lines not shown" : String(localized: "还有 \(count) 行未显示")) }
        if let diff {
            let shown = diff.lines.count > limit ? max(0, limit - 1) : diff.lines.count
            lines.reserveCapacity(shown + 1)
            for line in diff.lines.prefix(shown) {
                let kind: DiffLineSpec.Kind = switch line.type {
                case .add: .add
                case .del: .del
                case .gap: .gap
                default: .context
                }
                lines.append(DiffLineSpec(kind: kind, old: line.oldNo.map { String($0.int64Value) } ?? "", new: line.newNo.map { String($0.int64Value) } ?? "", text: line.text))
            }
            if shown < diff.lines.count { lines.append(omitted(diff.lines.count - shown)) }
        } else {
            lines.append(DiffLineSpec(kind: .gap, old: "", new: "", text: english ? "Too large to diff" : String(localized: "文件较大，未计算差异")))
            let budget = limit == .max ? Int.max : max(1, (limit - 3) / 2)
            for (text, kind) in [(before, DiffLineSpec.Kind.del), (after, .add)] {
                let parts = text.split(separator: "\n", omittingEmptySubsequences: false)
                for part in parts.prefix(budget) { lines.append(DiffLineSpec(kind: kind, old: "", new: "", text: String(part))) }
                if parts.count > budget { lines.append(omitted(parts.count - budget)) }
            }
        }
        return lines
    }

    static func diffLineHeight(_ style: TranscriptStyle) -> CGFloat {
        let font = style.mono(12)
        return ceil(font.ascender - font.descender + font.leading) + 2
    }

    /// [lines] measured for drawing: the widest line sets how far the strip scrolls.
    static func diffSpec(_ lines: [DiffLineSpec], style: TranscriptStyle) -> DiffSpec {
        let font = style.mono(12)
        let gutter: CGFloat = 38 + 4 + 38 + 4 + 14
        let advance = lineWidth("0", font: font)
        var widest: CGFloat = 0
        for line in lines {
            let count = line.text.utf16.count
            guard CGFloat(count) * advance * 2 > widest else { continue }
            let measured = line.text.allSatisfy(\.isASCII) ? CGFloat(count) * advance : lineWidth(line.text, font: font)
            widest = max(widest, measured)
        }
        return DiffSpec(lines: lines, lineHeight: diffLineHeight(style), gutter: gutter, contentWidth: gutter + widest + 12, font: font, gutterFont: style.mono(10.5))
    }

    static func lineWidth(_ string: String, font: NSFont) -> CGFloat {
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: [.font: font]))
        return CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    }
}

enum ToolSymbols {
    static func symbol(_ kind: String) -> String {
        switch kind {
        case "read": "doc.text"
        case "edit": "square.and.pencil"
        case "delete": "trash"
        case "move": "arrow.left.arrow.right"
        case "search": "magnifyingglass"
        case "execute": "apple.terminal"
        case "think": "brain"
        case "fetch": "globe"
        case "switch_mode": "repeat"
        case "agent": "person.crop.circle"
        case "question": "questionmark.bubble"
        case "goal": "target"
        default: "wrench.and.screwdriver"
        }
    }
}

extension TranscriptStyle {
    /// The style's UI face with tabular figures, for text whose digits tick (the system face's own variant where the style has none).
    nonisolated func figures(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        guard let face = RiffetFace.nsFont(size: s(size), weight: weight, mono: false, plugin: fonts, style: styleFonts) else {
            return .riffetDigits(size: s(size), weight: weight)
        }
        return face.riffetTabular
    }
}
