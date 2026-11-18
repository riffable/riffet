import SwiftUI
import RiffetKit

private struct ConversationReturnToMainKey: EnvironmentKey { static let defaultValue: (() -> Void)? = nil }
extension EnvironmentValues {
    var conversationReturnToMain: (() -> Void)? {
        get { self[ConversationReturnToMainKey.self] }
        set { self[ConversationReturnToMainKey.self] = newValue }
    }
}

struct ConversationTool: View {
    let item: TimelineItemTool
    let workbench: Workbench
    let projectID: String
    let active: Bool
    var parentItems: [any TimelineItem]? = nil
    @State private var expanded: Bool?
    @Environment(\.palette) private var palette
    @Environment(\.conversationReadAction) private var readAction
    @Environment(\.conversationDisclosureState) private var disclosureState
    private var presentation: ToolPresentation { ConversationToolPresentations.value(item: item, root: workbench.list.projects.first { $0.id == projectID }?.cwd, stale: !active) }
    private var isExpanded: Bool {
        // Failures stay folded like everything else: bursting open with raw output is what made long turns
        // unreadable. The error is one tap away, preserved per tool.
        get { disclosureState?["tool.\(item.key).expanded"] ?? expanded ?? false }
        nonmutating set {
            if let disclosureState { disclosureState["tool.\(item.key).expanded"] = newValue }
            else { expanded = newValue }
        }
    }
    var body: some View {
        let tool = presentation
        VStack(alignment: .leading, spacing: 6) {
            if let activity = currentToolActivity(item: item) {
                TimelineView(.periodic(from: .now, by: activity.status.active ? 1 : 3600)) { context in
                    let view = activityView(activity: activity, stopping: workbench.isStopping(activity: activity.id), nowMillis: Int64(context.date.timeIntervalSince1970 * 1000))
                    header(tool, activityState: view)
                }
            } else {
                header(tool)
            }
            // Details sit under the title, past the 16pt icon slot, and fade in as the row opens.
            if !tool.opensSubagent && isExpanded { details(tool).padding(.leading, 24).padding(.bottom, 6).transition(.asymmetric(insertion: .opacity.animation(RiffetMotion.release), removal: .identity)) }
            ForEach(Array(tool.images.enumerated()), id: \.offset) { _, image in imageView(image) }
        }.frame(maxWidth: .infinity, alignment: .leading).multilineTextAlignment(.leading)
    }
    private func header(_ tool: ToolPresentation, activityState: ActivityView? = nil) -> some View {
        let activity = currentToolActivity(item: item)
        let stats: String?
        if let activity, activity.kind == .backgroundTask, let activityState {
            stats = conversationActivityStatus(activity, view: activityState)
        } else {
            stats = activityState?.stats
        }
        return HStack(spacing: 8) {
            if tool.opensSubagent {
                NavigationLink { ConversationSubagentPage(workbench: workbench, projectID: projectID, toolCallID: tool.id, title: tool.title, parentItems: parentItems) } label: {
                    ConversationToolHeader(tool: tool, activityStats: stats)
                }.accessibilityIdentifier("tool.\(tool.id)")
            } else {
                Button { readAction(); isExpanded.toggle() } label: {
                    ConversationToolHeader(tool: tool, chevronExpanded: isExpanded, activityStats: stats)
                        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityValue(isExpanded ? "已展开" : "已折叠").accessibilityIdentifier("tool.\(tool.id)")
            }
            if let activity = currentToolActivity(item: item), activityState?.canStop == true {
                ConversationActivityStopButton(workbench: workbench, task: activity)
            }
        }
    }
    private func details(_ tool: ToolPresentation) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let activity = currentToolActivity(item: item), activity.kind == .backgroundTask {
                if activity.status.active {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        if let stats = activityView(activity: activity, stopping: workbench.isStopping(activity: activity.id), nowMillis: Int64(context.date.timeIntervalSince1970 * 1000)).stats { Text(stats).riffetFont(.caption).foregroundStyle(palette.fg4) }
                    }
                } else if let stats = activityView(activity: activity, stopping: workbench.isStopping(activity: activity.id), nowMillis: 0).stats { Text(stats).riffetFont(.caption).foregroundStyle(palette.fg4) }
                if let date = ServerTime.date(activity.endedAt ?? activity.startedAt) { Text(date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale))).riffetFont(.caption).foregroundStyle(palette.fg4) }
            }
            // The full title in the code face; a command title is already the shell block below.
            if !(tool.isCommand && tool.command != nil) {
                ConversationCodeViewport(maximumHeight: 180, estimatedHeight: 44, memoKey: "tool.\(tool.id).summary") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(tool.title).riffetFont(.monoSmall).foregroundStyle(palette.fg).frame(maxWidth: .infinity, alignment: .leading)
                        if let detail = tool.detail { Text(detail).riffetFont(.monoSmall).foregroundStyle(palette.fg4).frame(maxWidth: .infinity, alignment: .leading) }
                    }.fixedSize(horizontal: false, vertical: true).padding(12).textSelection(.enabled)
                }
                .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: 10))
                .accessibilityIdentifier("toolSummary.\(tool.id)")
            }
            if let command = tool.command { ConversationCode(text: command, language: "shell", output: true, stateID: "tool.\(tool.id).command") }
            ForEach(Array(tool.locations.enumerated()), id: \.offset) { _, location in
                NavigationLink { ConversationFilePage(workbench: workbench, projectID: projectID, path: location.path, targetLine: location.line.map { Int($0.int64Value) }) } label: { Label(location.path + (location.line.map { ":\($0)" } ?? ""), systemImage: "doc.text").riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(2).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading) }
            }
            ForEach(Array(tool.blocks.enumerated()), id: \.offset) { blockIndex, block in
                switch onEnum(of: block) {
                case let .text(text): ConversationCode(text: text.text, language: "output", output: true, stateID: "tool.\(tool.id).block.\(blockIndex).text").accessibilityIdentifier("toolOutput.\(tool.id).\(blockIndex)")
                case let .questionAnswer(answer): VStack(alignment: .leading, spacing: 6) { if let question = answer.question { Text(question).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }; Text(answer.answers.isEmpty ? String(localized: "已跳过", bundle: .riffet) : answer.answers.joined(separator: String(localized: "、", bundle: .riffet))).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg2) }.frame(maxWidth: .infinity, alignment: .leading)
                case let .diff(diff): ConversationToolDiff(diff: diff, workbench: workbench, projectID: projectID, stateID: "tool.\(tool.id).block.\(blockIndex).diff").accessibilityIdentifier("toolDiff.\(tool.id).\(blockIndex)")
                case let .terminal(terminal): NavigationLink { TerminalPage(workbench: workbench, projectID: projectID, terminalID: terminal.terminalId) } label: { Label("打开终端输出", systemImage: "terminal").riffetFont(.caption).foregroundStyle(palette.fg3) }
                case let .image(image): if tool.failed { imageView(image.image) } // Successful images already appear once beneath the folded row.
                }
            }
            if !tool.hasDetails { Text("没有更多详情").riffetFont(.caption).foregroundStyle(palette.fg4) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    @ViewBuilder private func imageView(_ image: ToolImage) -> some View {
        if let src = image.path ?? image.dataUrl { ConversationImage(workbench: workbench, projectID: projectID, source: src, label: image.caption, pixelSize: conversationPixelSize(image.width?.doubleValue, image.height?.doubleValue)) }
        else if image.omitted { Label(image.placeholder, systemImage: "photo").riffetFont(.caption).foregroundStyle(palette.fg4) }
    }
}

/// ToolPresentation parses JSON and eagerly computes lineDiff for every diff block. Keep it once
/// per immutable timeline item rather than repeating that work for scrolling/expansion/footer ticks.
@MainActor
private enum ConversationToolPresentations {
    private final class Entry {
        let item: TimelineItemTool // Retain identity while its cache key exists.
        let value: ToolPresentation
        init(item: TimelineItemTool, value: ToolPresentation) { self.item = item; self.value = value }
    }
    private static let cache: NSCache<NSString, Entry> = CacheRegistry.cache("conversation.toolPresentations", bytes: CacheRegistry.Budget.toolPresentations, count: 96)
    static func value(item: TimelineItemTool, root: String?, stale: Bool) -> ToolPresentation {
        // The shared layer words titles in the app language, so a switch needs fresh entries.
        let key = "\(ObjectIdentifier(item))|\(root ?? "")|\(stale)|\(AppLocalization.shared.language)" as NSString
        if let cached = cache.object(forKey: key) { return cached.value }
        let value = toolPresentation(item: item, root: root, stale: stale)
        var cost = (value.command?.utf16.count ?? 0) * 2 + 1_024
        for block in value.blocks {
            switch onEnum(of: block) {
            case let .text(text): cost += text.text.utf16.count * 4
            case let .diff(diff): cost += (diff.before.utf16.count + diff.after.utf16.count) * 8
            case let .image(image): cost += (image.image.dataUrl?.utf16.count ?? 0) * 2
            default: break
            }
        }
        cache.setObject(Entry(item: item, value: value), forKey: key, cost: cost)
        return value
    }
}

/// The symbol is a faint 12pt hint in a 16pt slot even at accessibility text sizes.
/// Only the title and its detail truncate. The diff counts, the row's state（失败/未完成）and the
/// chevron are a trailing column that keeps its own size, in the same quiet colours as the rest.
/// Expansion exposes the complete originals.
struct ConversationToolHeader: View {
    let tool: ToolPresentation
    /// Non-nil for a folding row: the chevron at the trailing edge, rotated while expanded.
    var chevronExpanded: Bool? = nil
    var activityStats: String? = nil
    @Environment(\.palette) private var palette
    // Text runs are concatenated, so the scale's sizes are applied here as fonts (label 15 Medium, caption and mono 13).
    @ScaledMetric(relativeTo: .subheadline) private var labelSize = 15.0
    @ScaledMetric(relativeTo: .footnote) private var smallSize = 13.0
    private var labelFont: Font { .system(size: labelSize, weight: .medium) }
    private var captionFont: Font { .system(size: smallSize) }
    private var monoFont: Font { .system(size: smallSize, design: .monospaced) }
    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Group {
                if tool.running { ProgressView().controlSize(.mini) }
                else { Image(systemName: tool.failed ? "exclamationmark.circle" : Self.symbol(tool)).font(.system(size: 12)) }
            }.foregroundStyle(tool.failed ? palette.fg3 : palette.fg4).frame(width: 16, height: 16)
            // Only the title truncates; the figures and the row's state are a trailing column of their own size.
            summary.lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
            if let activityStats { Text(activityStats).riffetFont(.caption).monospacedDigit().foregroundStyle(palette.fg4).lineLimit(1).fixedSize().layoutPriority(1) }
            else if tool.failed { Text("失败").riffetFont(.caption).foregroundStyle(palette.fg4).fixedSize().layoutPriority(1) }
            else if tool.dangling { Text("未完成").riffetFont(.caption).foregroundStyle(palette.fg4).fixedSize().layoutPriority(1) }
            if let figures { figures.lineLimit(1).fixedSize().layoutPriority(1) }
            if let chevronExpanded {
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(palette.fg4)
                    .rotationEffect(.degrees(chevronExpanded ? 90 : 0)).fixedSize()
                    .riffetAnimation(RiffetMotion.chevron, value: chevronExpanded)
            }
        }.frame(maxWidth: .infinity, minHeight: 34, alignment: .leading).contentShape(Rectangle())
    }
    /// The same per-kind icons as the web and Android, falling back to the wrench.
    private static func symbol(_ tool: ToolPresentation) -> String {
        tool.isCommand ? "terminal" : symbol(kind: tool.kind)
    }
    static func symbol(kind: String) -> String {
        switch kind {
        case "read": return "doc.text"
        case "edit": return "square.and.pencil"
        case "delete": return "trash"
        case "move": return "arrow.left.arrow.right"
        case "search": return "magnifyingglass"
        case "execute": return "terminal"
        case "think": return "brain"
        case "fetch": return "globe"
        case "switch_mode": return "arrow.2.squarepath"
        case "agent": return "person.crop.circle"
        case "message": return "paperplane"
        case "question": return "questionmark.bubble"
        case "goal": return "target"
        default: return "wrench.and.screwdriver"
        }
    }
    private var summary: Text {
        // Muted like reasoning: the work is context, the answer is what reads at full strength.
        Text(tool.title).font(tool.isCommand ? monoFont : labelFont).foregroundColor(palette.fg3)
        + Text(tool.detail.map { "  " + $0 } ?? "").font(captionFont).foregroundColor(palette.fg4)
    }
    /// The edit's file count and `+3 −1`; never cut, whatever the title's width.
    private var figures: Text? {
        guard tool.showsDiffStats else { return nil }
        var result = Text("")
        var any = false
        if tool.files > 1 { result = result + Text("  \(tool.files) 个文件").font(captionFont).foregroundColor(palette.fg4); any = true }
        if tool.added > 0 { result = result + Text("  +\(tool.added)").font(monoFont).foregroundColor(palette.success); any = true }
        if tool.removed > 0 { result = result + Text(" −\(tool.removed)").font(monoFont).foregroundColor(palette.danger); any = true }
        return any ? result : nil
    }
}

private struct ConversationToolDiff: View {
    let diff: ToolBlockDiff
    let workbench: Workbench
    let projectID: String
    let stateID: String
    @State private var expanded = false
    @Environment(\.palette) private var palette
    @Environment(\.conversationReadAction) private var readAction
    @Environment(\.conversationDisclosureState) private var disclosureState
    private var isExpanded: Bool {
        get { disclosureState?[stateID + ".expanded"] ?? expanded }
        nonmutating set {
            if let disclosureState { disclosureState[stateID + ".expanded"] = newValue }
            else { expanded = newValue }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let path = diff.path { NavigationLink(path) { ConversationFilePage(workbench: workbench, projectID: projectID, path: path) }.riffetFont(.caption) }
            if let lines = diff.diff?.lines {
                HStack(spacing: 12) {
                    Text("变更").riffetFont(.caption).foregroundStyle(palette.fg4)
                    Spacer(minLength: 0)
                    RiffetCopyButton(text: diff.before, label: String(localized: "复制修改前源码", bundle: .riffet))
                    RiffetCopyButton(text: diff.after, label: String(localized: "复制修改后源码", bundle: .riffet), symbol: "doc.on.doc.fill")
                }
                let count = isExpanded ? lines.count : min(80, lines.count)
                ConversationCodeViewport(maximumHeight: 300, estimatedHeight: CGFloat(count) * 20 + 16, axes: [.vertical, .horizontal], memoKey: stateID + "|\(isExpanded)") {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(0..<count, id: \.self) { index in
                            diffLine(lines[index])
                        }
                    }.fixedSize(horizontal: true, vertical: false).padding(8)
                }.background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: RiffetMetrics.rowRadius)).textSelection(.enabled)
                if lines.count > 80 { Button(isExpanded ? "收起变更" : "展开全部 \(lines.count) 行变更") { readAction(); isExpanded.toggle() }.riffetFont(.caption).foregroundStyle(palette.fg3).frame(minHeight: 44) }
            } else {
                ConversationCode(text: diff.before, language: String(localized: "修改前", bundle: .riffet), output: true, stateID: stateID + ".before")
                ConversationCode(text: diff.after, language: String(localized: "修改后", bundle: .riffet), output: true, stateID: stateID + ".after")
            }
        }.accessibilityElement(children: .contain)
    }
    private func diffLine(_ line: DiffLine) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(line.oldNo.map { "\($0)" } ?? "").foregroundStyle(palette.fg4).frame(width: 34, alignment: .trailing)
            Text(line.newNo.map { "\($0)" } ?? "").foregroundStyle(palette.fg4).frame(width: 34, alignment: .trailing)
            Text((line.type == .add ? "+ " : line.type == .del ? "− " : line.type == .gap ? "⋯ " : "  ") + line.text).foregroundStyle(palette.fg)
        }.riffetFont(.monoSmall).fixedSize(horizontal: true, vertical: true).padding(.vertical, 2)
            .background(line.type == .add ? palette.success.opacity(0.1) : line.type == .del ? palette.danger.opacity(0.1) : Color.clear)
    }
}

/// A subagent's own conversation: the same transcript as the session page — rows, folds,
/// paging, selection — over the child's events, opening on the prompt it was given.
struct ConversationSubagentPage: View {
    let workbench: Workbench
    let projectID: String
    let toolCallID: String
    let title: String
    /// The spawning transcript when it is itself a subagent's; nil reads the open session's live timeline.
    let parentItems: [any TimelineItem]?
    /// The child's projection, info and grouping, computed off the main thread by the shared presenter.
    @State private var page: SubagentPresentation?
    @State private var processExpansion: [String: Bool] = [:]
    @State private var nearTop = false
    @State private var followsTail = false
    @State private var disclosureState = ConversationDisclosureState()
    @State private var selection: ConversationSelection?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.palette) private var palette
    @Environment(\.conversationReturnToMain) private var returnToMain
    @Environment(\.dismiss) private var dismiss
    private var current: SubagentPresentation? { page?.toolCallId == toolCallID ? page : nil }
    private var transcript: SubagentTranscript? { current?.transcript ?? workbench.subagents.first { $0.toolCallId == toolCallID }?.transcript }
    private var running: Bool { transcript?.running?.boolValue == true }
    private var backend: NativeBackendId { workbench.selected?.backendId ?? .cursor }
    private var items: [any TimelineItem] { current?.items ?? [] }
    private var wantsOlder: Bool { nearTop && current?.hasBefore == true && workbench.loadingSubagent == nil && workbench.subagentError == nil }
    private var subtitle: String {
        [current?.info?.type, current?.info?.model, running ? String(localized: "运行中", bundle: .riffet) : String(localized: "已结束", bundle: .riffet)].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        Group {
            if transcript != nil {
                ConversationTranscriptList(
                    rows: rows, request: nil, followsTail: followsTail, accessibilityValue: subtitle, currentApprovalID: nil,
                    onPosition: { _, _, _, top in nearTop = top },
                    onBeginDragging: { followsTail = false },
                    onEndDragging: { followsTail = $0 },
                    onReady: {}
                )
                .environment(\.conversationDisclosureState, disclosureState)
                .environment(\.conversationSelectText, { selection = ConversationSelection(text: $0) })
            } else {
                ContentUnavailableView("正在等待子 Agent 会话", systemImage: "person.crop.circle.badge.clock")
            }
        }
        // Nested children return through the first child's dismissal, reaching the main session in one step.
        .environment(\.conversationReturnToMain, returnToMain ?? { dismiss() })
        .background(palette.bg)
        .navigationTitle(current?.info?.title ?? title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if workbench.interaction != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("待确认", systemImage: "exclamationmark.circle", action: returnToMain ?? { dismiss() })
                        .accessibilityLabel("主会话有待处理的确认")
                }
            }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(current?.info?.title ?? title).riffetFont(.label, weight: .semibold).lineLimit(1)
                    Text(subtitle).riffetFont(.caption).foregroundStyle(running ? palette.accent : palette.fg3).lineLimit(1)
                }
            }
        }
        .onChange(of: wantsOlder) { _, wants in if wants { workbench.store.loadOlderSubagent(toolCallId: toolCallID) } }
        .sheet(item: $selection) { ConversationSelectionSheet(selection: $0) }
        .task(id: toolCallID) {
            guard let presenter = workbench.host.presenter else { return }
            for await next in presenter.subagent(toolCallId: toolCallID, parent: parentItems) {
                if Task.isCancelled { return }
                page = next
            }
        }
    }

    private var rows: [ConversationTranscriptList.Row] {
        var result: [ConversationTranscriptList.Row] = []
        func append<V: View>(_ id: String, revision: AnyHashable, top: CGFloat, _ content: V) {
            var hasher = Hasher()
            hasher.combine(revision); hasher.combine(colorScheme); hasher.combine(dynamicTypeSize)
            result.append(.init(id: id, revision: hasher.finalize(), content: AnyView(content
                .environment(\.colorScheme, colorScheme).environment(\.dynamicTypeSize, dynamicTypeSize)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.top, top))))
        }
        if let error = workbench.subagentError {
            append("meta.history", revision: error, top: 8, Button {
                workbench.store.clearSubagentError(); workbench.store.loadOlderSubagent(toolCallId: toolCallID)
            } label: { Label("更早的消息加载失败", systemImage: "arrow.clockwise").riffetFont(.caption) }
                .buttonStyle(.plain).foregroundStyle(palette.fg3).frame(maxWidth: .infinity))
        }
        let entries = ConversationRenderPlan.entries(rows: current?.grouping.rows ?? [], compactAbove: [], expanded: processExpansion, focusedRow: nil,
                                                     scope: workbench.baseURL.absoluteString + "|subagent:" + toolCallID, readingAbove: false)
        for entry in entries {
            append(entry.id, revision: ConversationRenderPlan.revision(entry, speed: nil), top: entry.topSpacing,
                   ConversationEntryView(entry: entry, workbench: workbench, projectID: projectID, backend: backend, parentItems: items) { process, open in
                followsTail = false; processExpansion[process.key] = !open
            })
        }
        if current != nil && items.isEmpty {
            append("meta.empty", revision: 0, top: 20, ContentUnavailableView("还没有子 Agent 输出", systemImage: "person.crop.circle.badge.clock"))
        }
        append("transcriptEnd", revision: 0, top: 0, Color.clear.frame(height: 18).accessibilityHidden(true))
        return result
    }
}
