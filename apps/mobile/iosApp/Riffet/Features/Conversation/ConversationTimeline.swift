import SwiftUI
import UIKit
import RiffetKit
import Observation

struct ConversationTimelineRow: View, Equatable {
    let row: any TimelineRow
    let workbench: Workbench
    let projectID: String
    var parentItems: [any TimelineItem]? = nil
    var speed: SpeedTag? = nil
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.workbench === rhs.workbench && lhs.projectID == rhs.projectID &&
        lhs.parentItems == nil && rhs.parentItems == nil &&
        lhs.speed?.label == rhs.speed?.label && lhs.speed?.estimated == rhs.speed?.estimated && lhs.speed?.description_ == rhs.speed?.description_ &&
        ObjectIdentifier(lhs.row as AnyObject) == ObjectIdentifier(rhs.row as AnyObject)
    }
    var body: some View {
        switch onEnum(of: row) {
        case let .single(single):
            VStack(alignment: .leading, spacing: 8) {
                ConversationTimelineItem(item: single.item, workbench: workbench, projectID: projectID, active: !single.settled, parentItems: parentItems, speed: speed)
                if single.item is TimelineItemStatus, single.footer == .shown {
                    ConversationCopyActions(text: single.answerText ?? "", endedAt: ServerTime.date(timelineItemTime(item: single.item)), speed: speed)
                }
            }
        case let .process(process): ConversationProcess(row: process, workbench: workbench, projectID: projectID, parentItems: parentItems, speed: speed)
        case let .trigger(trigger):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(trigger.notices, id: \.key) { notice in ConversationTaskNotice(notice: notice) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct ConversationFocusedRowKey: EnvironmentKey { static let defaultValue: String? = nil }
private struct ConversationReadingHistoryKey: EnvironmentKey { static let defaultValue = false }
private struct ConversationReadActionKey: EnvironmentKey { static let defaultValue: () -> Void = {} }
private struct ConversationDisclosureStateKey: EnvironmentKey { static let defaultValue: ConversationDisclosureState? = nil }
private struct ConversationSelectTextKey: EnvironmentKey { static let defaultValue: ((String) -> Void)? = nil }
private struct ConversationQuoteKey: EnvironmentKey { static let defaultValue: ((String) -> Void)? = nil }

/// Keep explicit reading choices for this conversation while native cells are reused.
/// This contains only small flags; content, rendered views and persistent data live elsewhere.
@Observable final class ConversationDisclosureState {
    private var flags: [String: Bool] = [:]
    subscript(key: String) -> Bool? {
        get { flags[key] }
        set { flags[key] = newValue }
    }
}

extension EnvironmentValues {
    var conversationDisclosureState: ConversationDisclosureState? {
        get { self[ConversationDisclosureStateKey.self] }
        set { self[ConversationDisclosureStateKey.self] = newValue }
    }
    /// Opens a message in a native text view where any part of it can be selected.
    var conversationSelectText: ((String) -> Void)? {
        get { self[ConversationSelectTextKey.self] }
        set { self[ConversationSelectTextKey.self] = newValue }
    }
    /// Quotes a passage into this conversation's draft.
    var conversationQuote: ((String) -> Void)? {
        get { self[ConversationQuoteKey.self] }
        set { self[ConversationQuoteKey.self] = newValue }
    }
    var conversationReadAction: () -> Void {
        get { self[ConversationReadActionKey.self] }
        set { self[ConversationReadActionKey.self] = newValue }
    }
    var conversationFocusedRow: String? {
        get { self[ConversationFocusedRowKey.self] }
        set { self[ConversationFocusedRowKey.self] = newValue }
    }
    var conversationReadingHistory: Bool {
        get { self[ConversationReadingHistoryKey.self] }
        set { self[ConversationReadingHistoryKey.self] = newValue }
    }
}

private struct ConversationProcess: View {
    let row: TimelineRowProcess
    let workbench: Workbench
    let projectID: String
    let parentItems: [any TimelineItem]?
    let speed: SpeedTag?
    @State private var expanded: Bool?
    @State private var visible = false
    @Environment(\.conversationDisclosureState) private var disclosureState
    @Environment(\.conversationReadingHistory) private var readingHistory
    @Environment(\.conversationFocusedRow) private var focusedRow
    private var expansion: Bool? {
        get { disclosureState?["process." + row.key] ?? expanded }
        nonmutating set {
            if let disclosureState { disclosureState["process." + row.key] = newValue }
            else { expanded = newValue }
        }
    }
    private var open: Bool { expansion ?? (focusedRow == row.key || row.running || row.issueCount > 0) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ConversationProcessHeader(row: row, open: open) {
                expansion = !open
            }
            if open {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(row.items, id: \.key) { item in ConversationTimelineItem(item: item, workbench: workbench, projectID: projectID, active: row.turnActive, parentItems: parentItems, showsFooter: false) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if row.settled, let answer = row.answerText, row.endsTurn { ConversationCopyActions(text: answer, endedAt: ServerTime.date(row.endedAt)) }
        }
        .onScrollVisibilityChange(threshold: 0.1) { visible = $0 }
        .onChange(of: row.running) { old, running in
            if old && !running && expansion == nil && visible && readingHistory {
                expansion = true
            }
        }
    }
}

/// "3:12", or "1:02:33" past an hour — the elapsed form the process header shares with Android.
func conversationElapsed(from: Date, to: Date) -> String {
    let seconds = max(0, Int(to.timeIntervalSince(from)))
    let hours = seconds / 3600, minutes = (seconds % 3600) / 60, rest = seconds % 60
    return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
}

@MainActor
func conversationBackendLabel(_ workbench: Workbench, _ id: NativeBackendId) -> String {
    workbench.backends.first { $0.backendId == id }?.label ?? id.name.capitalized
}

/// A process header can be rendered independently in the transcript’s outer lazy stack.
/// One quiet line: a dot (a small turning arc while it works), how long it took, a faint chevron.
/// The details stay one tap away, folded; a failed call is not flagged here.
struct ConversationProcessHeader: View {
    let row: TimelineRowProcess
    let open: Bool
    let toggle: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.conversationReadAction) private var readAction
    private var start: Date? { ServerTime.date(row.startedAt) }
    private var live: Bool { row.running || row.turnActive }
    var body: some View {
        Button { readAction(); toggle() } label: {
            HStack(spacing: 8) {
                Group {
                    if live { ProgressView().controlSize(.mini).tint(palette.accent) }
                    else { RiffetStatusDot(state: .idle, size: 6) }
                }.frame(width: 16, height: 16)
                status.riffetFont(.label).monospacedDigit().foregroundStyle(palette.fg3).lineLimit(1)
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(palette.fg4)
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .riffetAnimation(RiffetMotion.chevron, value: open)
                Spacer(minLength: 0)
            }.frame(minHeight: 36).contentShape(Rectangle())
        }.buttonStyle(RiffetDimPressStyle())
            .accessibilityLabel(statusText)
            .accessibilityValue(open ? String(localized: "已展开", bundle: .riffet) : String(localized: "已折叠", bundle: .riffet))
            .accessibilityHint(open ? "轻点折叠过程" : "轻点查看过程")
            .accessibilityIdentifier("process.\(row.key)")
    }
    @ViewBuilder private var status: some View {
        if live, let start {
            TimelineView(.periodic(from: start, by: 1)) { context in
                Text("处理中 · \(conversationElapsed(from: start, to: context.date))")
            }
        } else if live {
            Text("处理中")
        } else if row.interrupted {
            Text("已中断")
        } else if let start, let end = ServerTime.date(row.endedAt), end > start {
            Text("已处理 · \(conversationElapsed(from: start, to: end))")
        } else {
            Text("已处理")
        }
    }
    private var statusText: String {
        if live, let start { return String(localized: "处理中 · \(conversationElapsed(from: start, to: Date()))", bundle: .riffet) }
        if live { return String(localized: "处理中", bundle: .riffet) }
        if row.interrupted { return String(localized: "已中断", bundle: .riffet) }
        if let start, let end = ServerTime.date(row.endedAt), end > start { return String(localized: "已处理 · \(conversationElapsed(from: start, to: end))", bundle: .riffet) }
        return String(localized: "已处理", bundle: .riffet)
    }
}

struct ConversationTimelineItem: View {
    @Environment(\.conversationFindHighlight) private var findHighlight
    let item: any TimelineItem
    let workbench: Workbench
    let projectID: String
    @Environment(\.palette) private var palette
    @Environment(\.conversationSelectText) private var selectText
    @Environment(\.conversationQuote) private var quote
    @Environment(\.conversationReadAction) private var readAction
    @Environment(\.conversationDisclosureState) private var disclosureState
    @State private var statusExpanded = false
    @State private var supportsRecovery = false
    @State private var checking = false
    @State private var recovery: NativeRunRecovery?
    @State private var confirmContinue = false
    var active = false
    var parentItems: [any TimelineItem]? = nil
    var speed: SpeedTag? = nil
    var showsFooter = true
    var body: some View {
        switch onEnum(of: item) {
        case let .user(user):
            let needsCheck = user.run.map { SendPhaseKt.messageRecovery(run: $0).needsCheck } ?? false
            VStack(alignment: .trailing, spacing: 8) {
                ForEach(Array(user.attachments.enumerated()), id: \.offset) { _, attachment in
                    if let id = attachment.id {
                        if !conversationAttachmentIsImage(attachment), attachment.name == id || (attachment.mimeType == nil && attachment.type == nil) {
                            ConversationUnresolvedAttachment(workbench: workbench, projectID: projectID, id: id, name: attachment.name)
                        } else if conversationAttachmentIsImage(attachment) { ConversationImage(workbench: workbench, projectID: projectID, source: "", label: attachment.name, attachmentID: id, pixelSize: conversationPixelSize(attachment.width?.doubleValue, attachment.height?.doubleValue), trailing: true) }
                        else { ConversationAttachmentLink(workbench: workbench, id: id, name: attachment.name) }
                    } else if let path = attachment.path, conversationAttachmentIsImage(attachment) {
                        ConversationImage(workbench: workbench, projectID: projectID, source: path, label: attachment.name, pixelSize: conversationPixelSize(attachment.width?.doubleValue, attachment.height?.doubleValue), trailing: true)
                    } else { Label(attachment.name, systemImage: "paperclip").riffetFont(.caption).foregroundStyle(palette.fg3) }
                }
                ForEach(user.references, id: \.snapshotRef) { reference in
                    ConversationSessionReferenceChip(workbench: workbench, recipientID: user.event.sessionId, reference: reference)
                }
                if !user.text.isEmpty {
                    Text(AttributedString(user.text).highlighting(findHighlight, only: findHighlight?.nth, color: palette.warning.opacity(0.4))).riffetFont(.body).lineSpacing(5).foregroundStyle(palette.fg).textSelection(.enabled)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(palette.selected, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .frame(maxWidth: 300, alignment: .trailing)
                    if let date = ServerTime.date(user.event.createdAt) {
                        Text(date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(AppLocalization.shared.locale))).riffetFont(.caption).monospacedDigit().foregroundStyle(palette.fg4)
                    }
                }
                if let run = user.run, !user.failureShown, !nativeDeliveryLabel(run).isEmpty {
                    let status = Label { Text(nativeDeliveryLabel(run)) } icon: {
                        if run.native?.intent == "steer" { Image(systemName: "arrow.turn.up.right") }
                    }
                    Group {
                        if let error = TimelineFormatKt.deliveryErrorDetails(run: run) {
                            DisclosureGroup {
                                Text(error).foregroundStyle(palette.fg3).frame(maxWidth: .infinity, alignment: .leading)
                            } label: { status }
                        } else { status }
                    }
                    .riffetFont(.caption)
                    .foregroundStyle(run.native?.delivery == .failed ? palette.danger : run.native?.delivery == .uncertain ? palette.warning : palette.fg3)
                    .textSelection(.enabled)
                }
                if let run = user.run, supportsRecovery, needsCheck {
                    HStack(spacing: 12) {
                        Button("检查状态") { Task {
                            checking = true
                            defer { checking = false }
                            await workbench.perform { recovery = try await workbench.store.checkRun(run: run) }
                        } }
                        if SendPhaseKt.messageRecovery(run: run).canRetry {
                            Button("重试发送") { Task {
                                checking = true
                                defer { checking = false }
                                await workbench.perform { _ = try await workbench.store.retryRun(run: run) }
                            } }
                        }
                        if let recovery, recovery.canContinue {
                            Button(recovery.queuedRunIds.isEmpty ? String(localized: "继续对话", bundle: .riffet) : String(localized: "继续发送 \(recovery.queuedRunIds.count) 条消息", bundle: .riffet)) { confirmContinue = true }
                        }
                    }.riffetFont(.caption).disabled(checking || workbench.sendState.pendingRunIds.contains(run.id))
                }
            }.frame(maxWidth: .infinity, alignment: .trailing).padding(.leading, 30)
                .task(id: "\(user.run?.id ?? ""):\(needsCheck):\(workbench.isConnected)") {
                    guard let run = user.run, needsCheck, let session = workbench.selected, session.id == run.sessionId else { return }
                    let entry = try? await workbench.loadCatalog(session.backendId ?? .cursor, profileID: session.backendProfileId, projectID: session.projectId)
                    guard !Task.isCancelled else { return }
                    supportsRecovery = entry?.capabilities.supportsRecovery?.boolValue == true
                }
                .alert(recovery?.queuedRunIds.isEmpty == false ? String(localized: "继续发送 \(recovery?.queuedRunIds.count ?? 0) 条消息", bundle: .riffet) : String(localized: "继续对话", bundle: .riffet), isPresented: $confirmContinue) {
                    Button("取消", role: .cancel) {}
                    Button(recovery?.queuedRunIds.isEmpty == false ? String(localized: "继续发送 \(recovery?.queuedRunIds.count ?? 0) 条消息", bundle: .riffet) : String(localized: "继续对话", bundle: .riffet)) {
                        guard let recovery else { return }
                        Task { await workbench.perform { _ = try await workbench.store.continueRun(run: recovery.run, queuedRunIds: recovery.queuedRunIds) } }
                    }
                } message: { Text("上一条消息是否已执行仍无法确认") }
                .contextMenu {
                    if !user.text.isEmpty {
                        Button("复制消息", systemImage: "doc.on.doc") { UIPasteboard.general.string = user.text }
                        if let selectText { Button("选择文字", systemImage: "selection.pin.in.out") { selectText(user.text) } }
                        if let quote { Button("引用", systemImage: "text.quote") { quote(user.text) } }
                    }
                    if let run = user.run, workbench.selected?.id == run.sessionId, SessionComposerKt.canRestoreUnsentMessage(run: run) {
                        Button("恢复未发送内容", systemImage: "arrow.uturn.backward") { Task { await workbench.perform {
                            guard let taken = try await workbench.store.takeBackQueued(run: run) else { return }
                            let draft = workbench.drafts.draft("session.\(run.sessionId)")
                            if draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft.text = taken.text }
                            else if draft.text != taken.text { draft.text += "\n\n" + taken.text }
                            let ids = Set(draft.attachments.map(\.id)); draft.attachments.append(contentsOf: taken.attachments.filter { !ids.contains($0.id) })
                            for reference in taken.context {
                                if !draft.references.contains(reference) { draft.references.append(reference) }
                            }
                            draft.save()
                        } } }
                    }
                }
                .accessibilityAction(named: "复制消息") { UIPasteboard.general.string = user.text }
        case let .assistant(assistant):
            VStack(alignment: .leading, spacing: 8) { ConversationMarkdown(source: assistant.text, workbench: workbench, projectID: projectID, stateID: "item." + assistant.key); if showsFooter && !active { ConversationCopyActions(text: assistant.text) } }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAction(named: "复制这段内容") { UIPasteboard.general.string = assistant.text }
        case let .thought(thought):
            ConversationThought(thought: thought, workbench: workbench, projectID: projectID, active: active)
        case let .tool(tool):
            VStack(alignment: .leading, spacing: 8) {
                ConversationTool(item: tool, workbench: workbench, projectID: projectID, active: active, parentItems: parentItems)
                if let job = tool.job { ConversationJob(job: job) }
            }
        case let .plan(plan): ConversationTodoList(entries: todoEntries(plan: plan))
        case let .image(image): ConversationImage(workbench: workbench, projectID: projectID, source: image.src)
        case let .status(status):
            Group {
                if let detail = status.detail, !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    DisclosureGroup(isExpanded: Binding(
                        get: { disclosureState?["status." + status.key] ?? statusExpanded },
                        set: { expanded in
                            readAction()
                            if let disclosureState { disclosureState["status." + status.key] = expanded }
                            else { statusExpanded = expanded }
                        }
                    )) {
                        ConversationCode(text: detail, language: "output", output: true, stateID: "status." + status.key)
                    } label: {
                        Label(status.text, systemImage: status.tone == .danger ? "exclamationmark.circle" : "info.circle")
                    }
                } else {
                    Label(status.text, systemImage: status.tone == .danger ? "exclamationmark.circle" : "info.circle")
                }
            }.riffetFont(.label, weight: .regular).foregroundStyle(status.tone == .danger ? palette.danger : palette.fg3).textSelection(.enabled)
        case let .taskNotification(notice): ConversationTaskNotice(notice: notice)
        case let .activity(item): ConversationActivityRow(item: item, workbench: workbench)
        }
    }
}

/// Narration stays readable as muted prose; raw reasoning folds to a one-line preview.
/// Expanded reasoning does not introduce an implicit platform indentation around its Markdown.
private struct ConversationThought: View {
    let thought: TimelineItemThought
    let workbench: Workbench
    let projectID: String
    let active: Bool
    @State private var expanded = false
    @State private var preview = ""
    @State private var streamingCandidate: String?
    @Environment(\.palette) private var palette
    @Environment(\.conversationReadAction) private var readAction
    @Environment(\.conversationDisclosureState) private var disclosureState
    private var isExpanded: Bool {
        get { disclosureState?["reasoning." + thought.key] ?? expanded }
        nonmutating set {
            if let disclosureState { disclosureState["reasoning." + thought.key] = newValue }
            else { expanded = newValue }
        }
    }
    private struct PreviewKey: Hashable { let text: String; let active: Bool }
    var body: some View {
        if thought.channel == .narration {
            ConversationMarkdown(source: thought.text, workbench: workbench, projectID: projectID, compact: true, stateID: "item." + thought.key)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            let candidate = conversationThoughtPreviewCandidate(thought.text, streaming: active, previous: streamingCandidate)
            VStack(alignment: .leading, spacing: 6) {
                Button { readAction(); isExpanded.toggle() } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "brain").font(.system(size: 12)).foregroundStyle(palette.fg4).frame(width: 16)
                        Text(preview.isEmpty ? String(localized: "思考", bundle: .riffet) : preview).riffetFont(.label).foregroundStyle(palette.fg3).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(palette.fg4).rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .riffetAnimation(RiffetMotion.chevron, value: isExpanded)
                    }.frame(maxWidth: .infinity, minHeight: 34, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityValue(isExpanded ? "已展开" : "已折叠").accessibilityHint("轻点查看或收起完整思考").accessibilityIdentifier("reasoning.\(thought.key)")
                if isExpanded { ConversationMarkdown(source: thought.text, workbench: workbench, projectID: projectID, compact: true, stateID: "item." + thought.key).frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 26).padding(.bottom, 6).transition(.asymmetric(insertion: .opacity.animation(RiffetMotion.release), removal: .identity)) }
            }.frame(maxWidth: .infinity, alignment: .leading)
                .task(id: PreviewKey(text: candidate, active: active)) {
                    if active { streamingCandidate = candidate }
                    do { preview = try await conversationThoughtPreview(candidate) }
                    catch is CancellationError {} catch {}
                }
        }
    }
}

/// Only bounded string edges are inspected per chunk. Keep the previous completed paragraph
/// when a very long unfinished paragraph has pushed its beginning outside the suffix window.
func conversationThoughtPreviewCandidate(_ source: String, streaming: Bool, previous: String? = nil) -> String {
    let limit = 1_536, window = 4_096
    func normalized(_ text: Substring) -> String {
        String(text).replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }
    func bounded(_ text: String) -> String { String(text.prefix(limit)) }
    func firstLine() -> String {
        let lines = normalized(source.prefix(window)).split(separator: "\n", omittingEmptySubsequences: false)
        return bounded(lines.lazy.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? "")
    }
    func retained() -> String {
        if let previous, !previous.isEmpty { return bounded(previous) }
        return firstLine()
    }
    guard streaming else { return firstLine() }
    let suffix = source.suffix(window)
    let truncated = suffix.startIndex != source.startIndex
    var tail = normalized(suffix)
    if truncated {
        // The first retained line may start halfway through a Markdown token or word.
        guard let newline = tail.firstIndex(of: "\n") else { return retained() }
        tail = String(tail[tail.index(after: newline)...])
    }
    guard let newline = tail.lastIndex(of: "\n") else { return truncated ? retained() : firstLine() }
    let completed = tail[..<newline].split(separator: "\n", omittingEmptySubsequences: false)
    var candidate: String?
    var hasParagraphBeginning = !truncated
    for line in completed.reversed() {
        let value = line.trimmingCharacters(in: .whitespaces)
        if value.isEmpty {
            if candidate != nil { hasParagraphBeginning = true; break }
        } else { candidate = value }
    }
    if hasParagraphBeginning, let candidate { return bounded(candidate) }
    return retained()
}

/// Debounce only the small preview; cancellation propagates to its detached parser. Markdown
/// rendering and copying the expanded thought continue to receive the original complete source.
func conversationThoughtPreview(_ candidate: String) async throws -> String {
    try Task.checkCancellation()
    try await Task.sleep(for: .milliseconds(60))
    try Task.checkCancellation()
    let bounded = String(candidate.prefix(1_536))
    let parser = Task.detached(priority: .userInitiated) {
        try Task.checkCancellation()
        let result = reasoningPreview(bounded)
        try Task.checkCancellation()
        return result
    }
    return try await withTaskCancellationHandler {
        let value = try await parser.value
        try Task.checkCancellation()
        return value
    } onCancel: { parser.cancel() }
}

/// The quiet line under a finished reply: a menu of what to do with it, when it ended and, when known, how fast it came.
struct ConversationCopyActions: View {
    let text: String
    var endedAt: Date? = nil
    var speed: SpeedTag? = nil
    @State private var copyFeedback = ConversationCopyFeedback()
    @Environment(\.palette) private var palette
    @Environment(\.conversationSelectText) private var selectText
    @Environment(\.conversationQuote) private var quote
    var body: some View {
        if !text.isEmpty || endedAt != nil || speed != nil {
            HStack(spacing: 4) {
                if !text.isEmpty {
                    Menu {
                        Button("复制消息", systemImage: "doc.on.doc") { UIPasteboard.general.string = text; copyFeedback.copy() }
                        if let selectText { Button("选择文字", systemImage: "selection.pin.in.out") { selectText(text) } }
                        if let quote { Button("引用", systemImage: "text.quote") { quote(text) } }
                    } label: {
                        Image(systemName: copyFeedback.copied ? "checkmark" : "ellipsis").riffetFont(.label, weight: .medium).foregroundStyle(palette.fg4)
                            .frame(width: 32, height: 32, alignment: .leading).contentShape(Rectangle().inset(by: -6))
                    }.menuIndicator(.hidden).accessibilityLabel(copyFeedback.copied ? "已复制消息" : "更多").accessibilityIdentifier("messageCopy")
                }
                let parts = [endedAt?.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(AppLocalization.shared.locale)), speed?.label].compactMap { $0 }
                if !parts.isEmpty { Text(parts.joined(separator: " · ")).riffetFont(.caption).foregroundStyle(palette.fg4).monospacedDigit() }
            }.frame(maxWidth: .infinity, alignment: .leading)
                .conversationCopyFeedback(copyFeedback)
        }
    }
}

struct ConversationTodoList: View {
    let entries: [TodoEntry]
    @Environment(\.palette) private var palette
    var body: some View {
        VStack(alignment: .leading, spacing: 8) { ForEach(entries.indices, id: \.self) { index in
            let entry = entries[index]
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: entry.status == .completed ? "checkmark.circle.fill" : entry.status == .inProgress ? "circle.dotted.circle" : "circle")
                    .foregroundStyle(entry.status == .inProgress ? palette.accent : palette.fg4)
                Text(entry.content).strikethrough(entry.status == .completed).foregroundStyle(entry.status == .completed ? palette.fg4 : entry.status == .inProgress ? palette.fg : palette.fg3)
            }.riffetFont(.label, weight: .regular)
        } }
    }
}

/// Whether an attachment is a picture: by its declared type, its MIME type or its file extension.
/// Vector images open as documents, not pictures.
func conversationAttachmentIsImage(_ attachment: UserAttachment) -> Bool {
    let mime = attachment.mimeType?.lowercased()
    if mime == "image/svg+xml" { return false }
    if mime?.hasPrefix("image/") == true || attachment.type == "image" { return true }
    if mime == nil, attachment.type != "file", attachment.id == nil, attachment.path != nil { return true }
    let ext = ((attachment.path ?? attachment.name) as NSString).pathExtension.lowercased()
    return ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "avif"].contains(ext)
}

private struct ConversationTaskNotice: View {
    let notice: TimelineItemTaskNotification
    @State private var expanded = false
    @Environment(\.palette) private var palette
    @Environment(\.conversationReadAction) private var readAction
    @Environment(\.conversationDisclosureState) private var disclosureState
    private var isExpanded: Bool {
        get { disclosureState?["notice." + notice.key] ?? expanded }
        nonmutating set {
            if let disclosureState { disclosureState["notice." + notice.key] = newValue }
            else { expanded = newValue }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { readAction(); isExpanded.toggle() } label: {
                HStack(spacing: 8) {
                    if notice.status == .running { ProgressView().controlSize(.mini).frame(width: 16) }
                    else { Image(systemName: notice.status == .failed ? "exclamationmark.circle" : "terminal").font(.system(size: 12)).foregroundStyle(palette.fg4).frame(width: 16) }
                    Text(notice.title).riffetFont(.label).foregroundStyle(palette.fg3).lineLimit(isExpanded ? nil : 1).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                    Text(status).riffetFont(.caption).foregroundStyle(palette.fg4).fixedSize()
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(palette.fg4).rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .riffetAnimation(RiffetMotion.chevron, value: isExpanded)
                }.frame(maxWidth: .infinity, minHeight: 36, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(RiffetDimPressStyle()).accessibilityValue(isExpanded ? "已展开" : "已折叠")
            if isExpanded {
                if let date = ServerTime.date(notice.event.createdAt) { Text(date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale))).riffetFont(.caption).foregroundStyle(palette.fg4) }
                if let detail = notice.detail { Text(detail).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                if let command = notice.command { ConversationCode(text: command, language: "shell", output: true, stateID: "notice." + notice.key + ".command") }
                if let result = notice.jobResult {
                    if let exit = result.exitCode { Text("exit \(exit)").riffetFont(.caption).foregroundStyle(palette.fg4) }
                    if let duration = result.runningMs { Text(formatDurationMs(millis: duration.int64Value)).riffetFont(.caption).foregroundStyle(palette.fg4) }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var status: String {
        switch notice.status {
        case .running: String(localized: "运行中", bundle: .riffet)
        case .completed: String(localized: "已完成", bundle: .riffet)
        case .failed: String(localized: "失败", bundle: .riffet)
        case .cancelled: String(localized: "已取消", bundle: .riffet)
        default: String(localized: "状态未知", bundle: .riffet)
        }
    }

}

private struct ConversationJob: View {
    let job: NativeJob
    @State private var expanded = false
    @Environment(\.palette) private var palette
    @Environment(\.conversationReadAction) private var readAction
    @Environment(\.conversationDisclosureState) private var disclosureState
    private var isExpanded: Bool {
        get { disclosureState?["job." + job.toolCallId] ?? expanded }
        nonmutating set {
            if let disclosureState { disclosureState["job." + job.toolCallId] = newValue }
            else { expanded = newValue }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { readAction(); isExpanded.toggle() } label: {
                HStack(spacing: 8) {
                    Label(job.title, systemImage: "terminal").riffetFont(.label).foregroundStyle(palette.fg3).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    Text(job.status == .running ? "运行中" : job.status == .failed ? "失败" : job.status == .unknown ? "状态未知" : "完成").riffetFont(.caption).foregroundStyle(palette.fg4).fixedSize()
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(palette.fg4).rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .riffetAnimation(RiffetMotion.chevron, value: isExpanded)
                }.frame(maxWidth: .infinity, minHeight: 36, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(RiffetDimPressStyle()).accessibilityValue(isExpanded ? "已展开" : "已折叠")
            if isExpanded {
                if job.title.trimmingCharacters(in: .whitespacesAndNewlines) != job.command.trimmingCharacters(in: .whitespacesAndNewlines) { Text(job.title).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                if !job.command.isEmpty { ConversationCode(text: job.command, language: "shell", output: true, stateID: "job." + job.toolCallId + ".command") }
                TimelineView(.periodic(from: .now, by: job.status == .running ? 1 : 3600)) { context in
                    let start = ServerTime.date(job.startedAt)
                    let elapsed = max(job.runningMs?.int64Value ?? 0, job.status == .running ? Int64(start.map { max(0, context.date.timeIntervalSince($0) * 1000) } ?? 0) : 0)
                    HStack(spacing: 8) {
                        if let start { Text(start.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale))) }
                        if elapsed > 0 { Text(formatDurationMs(millis: elapsed)) }
                    }.riffetFont(.caption).foregroundStyle(palette.fg4)
                }
                ConversationCode(text: job.output ?? (job.status == .running ? String(localized: "还没有输出…", bundle: .riffet) : String(localized: "没有输出", bundle: .riffet)), language: "output", output: true, stateID: "job." + job.toolCallId + ".output")
                if let exit = job.exitCode { Text("exit \(exit)").riffetFont(.caption).foregroundStyle(palette.fg4) }
                if job.truncated?.boolValue == true { Text("输出较长，此处仅显示末尾。").riffetFont(.caption).foregroundStyle(palette.fg4) }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// An attachment the timeline knows only by id (native runs): shown as a chip until its
/// metadata arrives, then as the picture or a file chip with the real name.
private struct ConversationUnresolvedAttachment: View {
    let workbench: Workbench
    let projectID: String
    let id: String
    let name: String
    @State private var metadata: Attachment?
    var body: some View {
        let known = metadata ?? ConversationLayoutMemo.shared.metadata(attachment: id)
        Group {
            if let known {
                if known.mimeType.lowercased().hasPrefix("image/"), known.mimeType.lowercased() != "image/svg+xml" {
                    ConversationImage(workbench: workbench, projectID: projectID, source: "", label: known.name, attachmentID: id, pixelSize: conversationPixelSize(known.width?.doubleValue, known.height?.doubleValue), trailing: true)
                } else { ConversationAttachmentLink(workbench: workbench, id: id, name: known.name) }
            } else { ConversationAttachmentLink(workbench: workbench, id: id, name: name) }
        }
        .task(id: id) {
            guard known == nil, let api = workbench.api else { return }
            if let fetched = try? await api.attachmentMetadata(attachmentId: id) {
                ConversationLayoutMemo.shared.setMetadata(fetched, attachment: id)
                metadata = fetched
            }
        }
    }
}

private struct ConversationAttachmentLink: View {
    let workbench: Workbench
    let id: String
    let name: String
    @Environment(\.colorScheme) private var scheme
    @Environment(\.palette) private var palette
    @State private var showPreview = false
    @State private var file: URL?
    @State private var error: String?
    @State private var loading = false
    var body: some View {
        VStack(alignment: .trailing) {
            Button { showPreview = true } label: {
                Label(name, systemImage: "doc").riffetFont(.caption).lineLimit(1).truncationMode(.middle)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(palette.press, in: Capsule())
            }.buttonStyle(.plain).foregroundStyle(palette.fg3).frame(maxWidth: 240, alignment: .trailing)
        }.sheet(isPresented: $showPreview) {
            NavigationStack {
                Group {
                    if let raw = workbench.resources.attachmentURL(id), let url = ConversationPreviewDocument.previewURL(raw, dark: scheme == .dark) {
                        ConversationWebPage(workbench: workbench, url: url)
                    }
                }.navigationTitle(name).navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("完成") { showPreview = false } }
                        ToolbarItem(placement: .primaryAction) {
                            Button { Task { await systemPreview() } } label: { if loading { ProgressView() } else { Label("系统预览", systemImage: "square.and.arrow.up") } }.disabled(loading)
                        }
                    }
                    .sheet(isPresented: Binding(get: { file != nil }, set: { if !$0 { file = nil } })) { if let file { FilePreview(url: file) } }
                    .onChange(of: error) { _, message in
                        guard let message else { return }
                        RiffetToastCenter.shared.error(message); error = nil
                    }
            }
            // A sheet covers the page's toasts; it shows its own.
            .riffetToastHost()
        }
    }
    private func systemPreview() async {
        loading = true
        defer { loading = false }
        do {
            guard let url = workbench.resources.attachmentURL(id) else { throw URLError(.badURL) }
            file = try await workbench.resources.file(for: url, name: name)
        } catch { self.error = error.riffetMessage }
    }
}

struct ConversationSelection: Identifiable { let id = UUID(); let text: String }

/// The passage as plain text in a native text view: drag handles select any range.
struct ConversationSelectionSheet: View {
    let selection: ConversationSelection
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ConversationSelectableTextView(text: Self.plain(selection.text))
                .ignoresSafeArea(.container, edges: .bottom)
                .navigationTitle(String(localized: "选择文字", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
                    ToolbarItem(placement: .primaryAction) { Button("全部复制", systemImage: "doc.on.doc") { UIPasteboard.general.string = selection.text; dismiss() } }
                }
        }
        .presentationDragIndicator(.visible)
    }
    /// Inline Markdown marks (emphasis, code, links) are removed; line structure is kept.
    private static func plain(_ source: String) -> String {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: source, options: options)).map { String($0.characters) } ?? source
    }
}

private struct ConversationSelectableTextView: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.alwaysBounceVertical = true
        view.backgroundColor = .clear
        view.adjustsFontForContentSizeCategory = true
        view.font = .preferredFont(forTextStyle: .body)
        view.textColor = .label
        view.textContainerInset = UIEdgeInsets(top: 16, left: 14, bottom: 32, right: 14)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
}

private struct ConversationSessionReferenceChip: View {
    let workbench: Workbench
    let recipientID: String
    let reference: CapturedSessionReference
    @State private var opened = false
    @State private var original: [String]?
    @State private var page = 0
    @State private var loading = false
    @State private var error: String?
    @Environment(\.palette) private var palette
    var body: some View {
        Button { opened = true } label: { Label(reference.title, systemImage: "text.bubble").riffetFont(.caption) }
        .sheet(isPresented: $opened) {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("引用于 \(ServerTime.date(reference.capturedAt)?.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale)) ?? reference.capturedAt)").riffetFont(.caption).foregroundStyle(palette.fg3)
                        if reference.coverage.completeness == "partial" { Text("仅含部分历史").riffetFont(.caption).foregroundStyle(palette.fg3) }
                        if reference.coverage.activeTurnIncomplete?.boolValue == true { Text("引用时本轮尚未结束").riffetFont(.caption).foregroundStyle(palette.fg3) }
                        Text(sessionReferenceExcerpt(excerpt: reference.excerpt)).textSelection(.enabled)
                        Text("原文副本随本会话保存").riffetFont(.caption).foregroundStyle(palette.fg3)
                        Text("仅保存提问和回答文字，不含工具记录和附件内容").riffetFont(.caption).foregroundStyle(palette.fg3)
                        Button("打开原会话") { opened = false; Task { await workbench.open(sessionID: reference.sessionId) } }
                        Button("查看引用时的记录") { Task {
                            loading = true
                            defer { loading = false }
                            do {
                                let pages = try await workbench.store.sessionReferencePages(sessionId: recipientID, snapshotRef: reference.snapshotRef)
                                guard opened else { return }
                                original = pages; page = 0; error = nil
                            } catch { self.error = error.riffetMessage }
                        } }.disabled(loading)
                        if let original, original.indices.contains(page) {
                            Text(original[page]).riffetFont(.body).textSelection(.enabled)
                            if original.count > 1 { HStack {
                                Button("上一页") { page -= 1 }.disabled(page == 0)
                                Text("\(page + 1) / \(original.count)").riffetFont(.caption).foregroundStyle(palette.fg3)
                                Button("下一页") { page += 1 }.disabled(page == original.count - 1)
                            } }
                        }
                        if let error { RiffetNotice(kind: .error, message: error, boxed: true) }
                    }.padding().frame(maxWidth: .infinity, alignment: .leading)
                }.navigationTitle(reference.title).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { opened = false } } }
            }
        }
    }
}
