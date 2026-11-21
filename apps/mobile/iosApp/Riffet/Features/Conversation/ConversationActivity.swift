import SwiftUI
import RiffetKit

/// 系统活动: compaction, a background task, a local command's output. The words come from the shared
/// `activityView`, so every client prints the same line; only the drawing is this platform's.
struct ConversationActivityRow: View {
    let item: TimelineItemActivity
    let workbench: Workbench
    @State private var expanded = false
    @State private var confirming = false
    @State private var fullText: String?
    @State private var loading = false
    @State private var failed = false
    @Environment(\.palette) private var palette
    @Environment(\.conversationReadAction) private var readAction
    @Environment(\.conversationDisclosureState) private var disclosureState
    @ScaledMetric(relativeTo: .footnote) private var monoSize = 13.0
    private var activity: NativeActivity { item.activity }
    private var background: Bool { activity.kind == .backgroundTask }
    /// A `!cmd` the user ran: drawn like an agent shell tool row, the command as the title and its output beneath.
    private var shell: Bool { activity.kind == .localCommand && !(activity.task?.command ?? "").isEmpty }
    private var hasOutput: Bool { !(fullText ?? activity.detail ?? "").isEmpty || activity.blobRef != nil }
    /// Collapsed, a finished command shows only the end of its output.
    private var shellTail: Bool { shell && !isExpanded }
    private var isExpanded: Bool {
        get { disclosureState?["activity." + item.key] ?? expanded }
        nonmutating set {
            if let disclosureState { disclosureState["activity." + item.key] = newValue }
            else { expanded = newValue }
        }
    }
    var body: some View {
        if (activity.kind == .localCommand || activity.kind == .unknown) && !shell {
            // A command's own output: quiet, one line, nothing to open.
            TimelineView(.periodic(from: .now, by: 3600)) { context in
                Text(view(at: context.date).summary).riffetFont(.caption).foregroundStyle(palette.fg4).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                // The clock ticks only while the activity runs; a finished one holds no timer.
                TimelineView(.periodic(from: .now, by: activity.status == .running || activity.status == .stopping ? 1 : 3600)) { context in
                    if shell { shellHeader(view(at: context.date)) } else { header(view(at: context.date)) }
                }
                if isExpanded || (shellTail && activity.status != .running) { detail }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func view(at date: Date) -> ActivityView {
        activityView(activity: activity, stopping: workbench.isStopping(activity: activity.id), nowMillis: Int64(date.timeIntervalSince1970 * 1000))
    }
    private func header(_ view: ActivityView) -> some View {
        HStack(spacing: 8) {
            Button { readAction(); isExpanded.toggle() } label: {
                HStack(spacing: 8) {
                    if view.running { ProgressView().controlSize(.mini).frame(width: 16) }
                    else { Image(systemName: icon(view)).font(.system(size: 12)).foregroundStyle(palette.fg4).frame(width: 16) }
                    Text(background ? (view.subject ?? view.label) : [view.label, view.subject].compactMap { $0 }.joined(separator: " · ")).riffetFont(.label).foregroundStyle(palette.fg3).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    if let stats = background ? conversationActivityStatus(activity, view: view) : view.stats { Text(stats).riffetFont(.caption).monospacedDigit().foregroundStyle(palette.fg4).lineLimit(1).fixedSize() }
                    if background || view.expandable { Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(palette.fg4).rotationEffect(.degrees(isExpanded ? 90 : 0)) }
                }.frame(maxWidth: .infinity, minHeight: 36, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(RiffetDimPressStyle()).disabled(!background && !view.expandable)
                .accessibilityLabel(view.summary).accessibilityValue(background || view.expandable ? (isExpanded ? String(localized: "已展开", bundle: .riffet) : String(localized: "已折叠", bundle: .riffet)) : "")
                .accessibilityIdentifier("activity.\(item.key)")
            if view.canStop {
                Button("停止") { if view.stopWarning != nil { confirming = true } else { Task { await workbench.stop(activity: activity.id) } } }
                    .riffetFont(.caption).foregroundStyle(palette.fg3).frame(minHeight: 44).buttonStyle(.plain)
                    .confirmationDialog("停止后台任务「\(view.subject ?? view.label)」？", isPresented: $confirming, titleVisibility: .visible) {
                        Button("停止", role: .destructive) { Task { await workbench.stop(activity: activity.id) } }
                    } message: { Text(view.stopWarning ?? "") }
            }
        }
    }
    private func shellHeader(_ view: ActivityView) -> some View {
        Button { readAction(); isExpanded.toggle() } label: {
            HStack(spacing: 8) {
                if view.running { ProgressView().controlSize(.mini).frame(width: 16, height: 16) }
                else { Image(systemName: "terminal").font(.system(size: 12)).foregroundStyle(palette.fg4).frame(width: 16, height: 16) }
                (Text("! ").foregroundStyle(palette.fg4) + Text(activity.task?.command?.components(separatedBy: .newlines).first ?? activity.title).foregroundStyle(palette.fg2))
                    .font(.system(size: monoSize, design: .monospaced)).lineLimit(1).truncationMode(.tail)
                if hasOutput {
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(palette.fg4)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0)).fixedSize()
                        .riffetAnimation(RiffetMotion.chevron, value: isExpanded)
                }
                Spacer(minLength: 0)
                if activity.status == .unknown, let state = conversationActivityStatus(activity, view: view) { Text(state).riffetFont(.caption).foregroundStyle(palette.fg4).fixedSize() }
            }.frame(maxWidth: .infinity, minHeight: 36, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(RiffetDimPressStyle()).disabled(!hasOutput)
            .accessibilityLabel(view.summary).accessibilityValue(hasOutput ? (isExpanded ? String(localized: "已展开", bundle: .riffet) : String(localized: "已折叠", bundle: .riffet)) : "")
            .accessibilityIdentifier("activity.\(item.key)")
    }
    private func icon(_ view: ActivityView) -> String {
        switch view.tone {
        case .failed: "exclamationmark.circle"
        case .done: activity.kind == .compaction ? "arrow.down.right.and.arrow.up.left" : "checkmark.circle"
        default: activity.kind == .compaction ? "arrow.down.right.and.arrow.up.left" : "terminal"
        }
    }
    @ViewBuilder private var detail: some View {
        if background {
            if activity.title.trimmingCharacters(in: .whitespacesAndNewlines) != activity.task?.command?.trimmingCharacters(in: .whitespacesAndNewlines) { Text(activity.title).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            if activity.status.active {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if let stats = view(at: context.date).stats { Text(stats).riffetFont(.caption).foregroundStyle(palette.fg4) }
                }
            } else if let stats = view(at: Date()).stats { Text(stats).riffetFont(.caption).foregroundStyle(palette.fg4) }
            if let date = ServerTime.date(activity.endedAt ?? activity.startedAt) { Text(date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale))).riffetFont(.caption).foregroundStyle(palette.fg4) }
        }
        if !shell, let command = activity.task?.command, !command.isEmpty {
            ConversationCode(text: command, language: "shell", output: true, stateID: "activity." + item.key + ".command")
        }
        if let text = fullText ?? activity.detail, !text.isEmpty {
            ConversationCode(text: shellTail ? conversationLastLines(text, 6) : text, language: "output", output: true, stateID: "activity." + item.key + ".output")
                .padding(.leading, shell ? 24 : 0)
        }
        if let ref = activity.blobRef, fullText == nil, !shellTail {
            Button(loading ? "正在读取全文…" : failed ? "读取失败 · 重试" : "查看全文") {
                loading = true; failed = false
                Task { fullText = await workbench.text(of: ref); failed = fullText == nil; loading = false }
            }.riffetFont(.caption).disabled(loading).frame(minHeight: 44, alignment: .leading)
                .padding(.leading, shell ? 24 : 0)
        }
    }
}

/// One live background task in the "子任务" list: what it runs, how long, and its stop button.
struct ConversationBackgroundTaskRow: View {
    let workbench: Workbench
    let task: NativeActivity
    @Environment(\.palette) private var palette
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let view = activityView(activity: task, stopping: workbench.isStopping(activity: task.id), nowMillis: Int64(context.date.timeIntervalSince1970 * 1000))
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(view.subject ?? view.label).riffetFont(.label).foregroundStyle(palette.fg3).lineLimit(1)
                    if let stats = view.stats { Text(stats).riffetFont(.caption).monospacedDigit().foregroundStyle(palette.fg4) }
                }
                Spacer(minLength: 0)
                ConversationActivityStopButton(workbench: workbench, task: task)
            }
        }
    }
}

/// Shared by a background task and the subagent row that owns that task's stop capability.
struct ConversationActivityStopButton: View {
    let workbench: Workbench
    let task: NativeActivity
    @State private var confirming = false
    @Environment(\.palette) private var palette
    var body: some View {
        let view = activityView(activity: task, stopping: workbench.isStopping(activity: task.id), nowMillis: 0)
        if view.canStop {
            Button("停止") { if view.stopWarning != nil { confirming = true } else { Task { await workbench.stop(activity: task.id) } } }
                .riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3).frame(minHeight: 44).buttonStyle(.borderless)
                .confirmationDialog("停止后台任务「\(view.subject ?? view.label)」？", isPresented: $confirming, titleVisibility: .visible) {
                    Button("停止", role: .destructive) { Task { await workbench.stop(activity: task.id) } }
                } message: { Text(view.stopWarning ?? "") }
        }
    }
}

/// The compact task header carries one state; statistics stay in its disclosure.
func conversationActivityStatus(_ activity: NativeActivity, view: ActivityView) -> String? {
    if view.stopping { return String(localized: "停止中", bundle: .riffet) }
    if view.running { return String(localized: "运行中", bundle: .riffet) }
    switch activity.status {
    case .completed: return String(localized: "已完成", bundle: .riffet)
    case .failed: return String(localized: "失败", bundle: .riffet)
    case .stopped: return String(localized: "已停止", bundle: .riffet)
    default: return String(localized: "状态未知", bundle: .riffet)
    }
}

/// The last `count` lines of `text`, found from its end: a running command's output can be thousands
/// of lines, and splitting all of it on every pass to keep six walked the whole output each time.
func conversationLastLines(_ text: String, _ count: Int) -> String {
    let bytes = text.utf8
    var index = bytes.endIndex, newlines = 0
    while index > bytes.startIndex {
        let previous = bytes.index(before: index)
        if bytes[previous] == UInt8(ascii: "\n") {
            newlines += 1
            if newlines == count { return String(text[index...]) }
        }
        index = previous
    }
    return text
}
