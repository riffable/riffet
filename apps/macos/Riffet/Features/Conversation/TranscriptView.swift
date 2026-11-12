import AppKit
import SwiftUI
import RiffetKit

/// The open conversation's transcript: the AppKit list (`TranscriptController`), which also draws
/// the turn rail, the back-to-bottom button and the reading-width handle. Nothing here reads the
/// transcript's rows, so streaming never re-evaluates this view. Until the first rows are on screen
/// it shows the loading or failure state instead (`TranscriptPlaceholder`).
struct TranscriptView: View {
    let workbench: Workbench
    let session: Session
    /// The overview column carries the turn navigation, so the rail is not drawn.
    var railHidden = false
    /// Where the overview column reads the list's turns and the one being read.
    var link: TranscriptScrollLink?
    let restoreInput: (Run) -> Void
    @State private var scroll = TranscriptScrollState()
    @State private var orchestrator = SessionOrchestrator()
    @Environment(\.openSubagent) private var openSubagent
    @Environment(\.quoteMessage) private var quote

    var body: some View {
        TranscriptHost(workbench: workbench, sessionId: session.id, projectId: session.projectId, scroll: scroll, actions: actions, railHidden: railHidden)
            .overlay { TranscriptPlaceholder(workbench: workbench, sessionId: session.id, scroll: scroll) }
            .sessionOrchestration(orchestrator, workbench: workbench, session: session)
            .onAppear {
                MarksStore.shared.watch(session.id)
                scroll.sessionId = session.id
                if let link, link.scroll !== scroll { link.scroll = scroll }
            }
            .onDisappear { MarksStore.shared.unwatch(session.id) }
    }

    private var actions: TranscriptActions {
        TranscriptActions(
            loadOlder: { [workbench] in workbench.loadOlder() },
            retryHistory: { [workbench] in workbench.store.retryHistory() },
            openSubagent: openSubagent,
            quote: quote,
            restoreInput: restoreInput,
            checkRun: { [workbench] run in Task { await workbench.checkRun(run) } },
            retryRun: { [workbench] run in Task { await workbench.retryRun(run) } },
            openVisualization: { [workbench] path, title, wide in
                NotificationCenter.default.post(name: .riffetOpenVisualization, object: workbench, userInfo: ["path": path, "title": title, "wide": wide])
            },
            openFile: { [workbench, projectId = session.projectId] path, line in
                FileOpener.activate(path: path, line: line, projectId: projectId, workbench: workbench)
            },
            fileMenu: { [workbench, projectId = session.projectId] path in
                FileOpener.menuItems(path: path, projectId: projectId, workbench: workbench)
            },
            resolveFile: { [workbench, sessionId = session.id, projectId = session.projectId] path in
                let items = TranscriptHost.loadedPresentation(workbench, sessionId: sessionId)?.grouping.items ?? []
                return FileMentionsKt.resolveFileMention(path: path, files: FileMentionsKt.conversationFiles(items: items, root: workbench.project(projectId)?.cwd))
            },
            stopActivity: { [workbench] id in await workbench.stop(activity: id) },
            activityText: { [workbench] ref in await workbench.text(of: ref) },
            turn: { [workbench, orchestrator, session] action, runId in
                orchestrator.perform(action, runId: runId, session: session, workbench: workbench)
            },
            mark: { [workbench, session] command in
                MarksStore.shared.perform(command, session: session, generation: workbench.history?.generation)
            },
            exportImage: { [workbench, session] source in
                var source = source
                source.sessionTitle = session.title
                source.agent = session.agent.map(backendLabel)
                source.project = workbench.project(session.projectId)?.name
                ShareImage.present(source)
            },
            focusMissed: { [workbench, sessionId = session.id] in
                workbench.notice = SessionNotice(sessionId: sessionId, text: String(localized: "没有在这段会话的历史里找到这条收藏，原文可能已被改写或删除。"))
            },
            openSession: { [workbench] id in workbench.open(sessionId: id) }
        )
    }
}

/// The main conversation's feed: the presenter's frame for this session, the history state and
/// the working line, read from `Workbench` (so the controller tracks exactly these).
struct TranscriptHost: NSViewControllerRepresentable {
    let workbench: Workbench
    let sessionId: String
    let projectId: String
    let scroll: TranscriptScrollState
    let actions: TranscriptActions
    var railHidden = false

    func makeNSViewController(context: Context) -> TranscriptController {
        let workbench = workbench, sessionId = sessionId, projectId = projectId
        // Disclosures and the reading position outlive the list: coming back from another page
        // or conversation opens it as it was left.
        let memory = TranscriptMemory.memory(for: sessionId)
        let controller = TranscriptController(
            ui: memory.ui,
            scrollState: scroll,
            feed: { Self.feed(workbench, sessionId: sessionId, projectId: projectId) },
            focus: { workbench.focus.flatMap { $0.sessionId == nil || $0.sessionId == sessionId ? $0 : nil } },
            memory: memory
        )
        controller.actions = actions
        controller.marksProvider = { MarksStore.shared.marks(for: sessionId) }
        workbench.readingKey = { [weak controller] in controller?.topItemKey() }
        controller.findProvider = { [weak workbench] in workbench?.find }
        controller.findRow = { [weak workbench] key in
            guard let grouping = workbench?.grouping,
                  let index = grouping.items.firstIndex(where: { $0.key == key }), index < grouping.rowOfItem.size else { return nil }
            let row = Int(grouping.rowOfItem.get(index: Int32(index)))
            guard row < grouping.rows.count else { return nil }
            let rowKey = nativeString(grouping.rows[row].key)
            return (rowKey, key == rowKey ? nil : key)
        }
        controller.focusRowKey = { [weak workbench] focus in
            guard let workbench, workbench.selected?.id == sessionId, let grouping = workbench.grouping else { return nil }
            let match = Self.match(focus, in: grouping)
            if case .row = match { workbench.focus = nil }
            return match
        }
        return controller
    }

    /// The row of [focus]: the item carrying one of its message ids, else the last item at or before
    /// its sequence. An exact focus whose message is older than the loaded part asks for a page.
    static func match(_ focus: TranscriptFocus, in grouping: TimelineGrouping) -> TranscriptFocusMatch {
        let items = grouping.items
        func row(_ index: Int) -> TranscriptFocusMatch {
            guard index < grouping.rowOfItem.size else { return .older }
            let row = Int(grouping.rowOfItem.get(index: Int32(index)))
            guard row < grouping.rows.count else { return .older }
            let key = nativeString(grouping.rows[row].key)
            let item = items[index].key
            return .row(key, item: item == key ? nil : item)
        }
        if !focus.messageIds.isEmpty {
            let ids = Set(focus.messageIds)
            if let index = items.lastIndex(where: { item in
                item.event.nativeId.map(ids.contains) == true || (item.event.nativeAliases ?? []).contains(where: ids.contains)
            }) { return row(index) }
        }
        guard let sequence = focus.sequence else { return focus.exact ? .older : row(0) }
        if focus.exact, let first = items.first, first.event.base.sequence > sequence { return .older }
        return row(items.lastIndex { $0.event.base.sequence <= sequence } ?? 0)
    }

    func updateNSViewController(_ controller: TranscriptController, context: Context) {
        controller.actions = actions
        controller.covered = context.environment.covered
        controller.railHidden = railHidden
    }

    /// The presenter's frame for the session once its history has arrived.
    @MainActor
    static func loadedPresentation(_ workbench: Workbench, sessionId: String) -> TimelinePresentation? {
        guard let presentation = workbench.presentation, presentation.sessionId == sessionId, presentation.loaded else { return nil }
        return presentation
    }

    /// Where this conversation came from, for the transcript's first row; the parent's title and Agent
    /// are read from the session list, so they fill in when the list catches up.
    @MainActor
    static func lineage(_ workbench: Workbench, sessionId: String) -> LineageSpec? {
        guard let session = workbench.list.sessions.first(where: { $0.id == sessionId }),
              let origin = session.origin, origin.kind == "fork" || origin.kind == "handoff",
              let parentId = origin.sessionId else { return nil }
        let parent = SessionGlance(of: parentId, in: workbench.list)
        return LineageSpec(forked: origin.kind == "fork", agent: parent?.agent, title: parent?.title ?? String(localized: "原会话"), parentId: parentId)
    }

    /// Where this conversation went, for the transcript's last row, when it was handed off.
    @MainActor
    static func handedOff(_ workbench: Workbench, sessionId: String) -> HandedOffSpec? {
        guard let session = workbench.list.sessions.first(where: { $0.id == sessionId }),
              let successorId = session.handedOffTo else { return nil }
        return HandedOffSpec(agent: SessionGlance(of: successorId, in: workbench.list)?.agent, successorId: successorId)
    }

    @MainActor
    static func feed(_ workbench: Workbench, sessionId: String, projectId: String) -> TranscriptFeed? {
        guard let presentation = loadedPresentation(workbench, sessionId: sessionId) else { return nil }
        let older: TranscriptFeed.Older?
        if workbench.history?.hasMore == true || workbench.loadingHistory {
            older = workbench.loadingHistory ? .loading : workbench.historyError != nil ? .failed : .idle
        } else {
            older = nil
        }
        // The timeline's compaction activity already describes the current work, including its
        // elapsed time. Restore the generic working line when that activity finishes.
        let compactionShowsProgress = presentation.dock.compacting && presentation.grouping.items.contains { item in
            guard let activity = item as? TimelineItemActivity else { return false }
            return activity.activity.kind == .compaction && activity.activity.status.active
        }
        let working: WorkingSpec? = workbench.sendState.interrupting || presentation.showsWorking && !compactionShowsProgress
            ? WorkingSpec(step: workbench.sendState.interrupting ? nil : presentation.step, since: workbench.sendState.interrupting ? nil : workbench.runs.first { $0.state == .running }.flatMap { ServerTime.date($0.updatedAt) }, speed: workbench.sendState.interrupting ? nil : presentation.sessionSpeed, stopping: workbench.sendState.interrupting)
            : nil
        return TranscriptFeed(
            sessionId: sessionId,
            identity: presentation,
            rows: {
                TranscriptRows(rows: presentation.grouping.rows, compact: presentation.compactAbove.map(\.boolValue), speeds: presentation.speeds, turns: presentation.turns, heldFooter: presentation.heldFooter)
            },
            older: older,
            working: working,
            suppressesHeldFooter: compactionShowsProgress && !workbench.sendState.interrupting,
            sessionWorking: workbench.working,
            root: workbench.project(projectId)?.cwd,
            projectId: projectId,
            emptyText: !workbench.working,
            startingText: workbench.working,
            lineage: lineage(workbench, sessionId: sessionId),
            handedOff: handedOff(workbench, sessionId: sessionId),
            supportsRecovery: workbench.list.sessions.first(where: { $0.id == sessionId }).flatMap { workbench.catalogs.cached(for: $0) }?.capabilities.supportsRecovery?.boolValue == true
        )
    }
}

/// What the transcript area says until the first rows are on screen: that the conversation is
/// loading, or, when the stream failed before anything arrived, why it is empty and how to retry.
/// Reads the connection only while it shows, so streaming never re-evaluates it afterwards.
private struct TranscriptPlaceholder: View {
    let workbench: Workbench
    let sessionId: String
    let scroll: TranscriptScrollState
    @Environment(\.palette) private var palette
    /// A conversation read from the device's copy is on screen within a few frames; only a wait
    /// longer than that says it is loading, so a switch does not flash the line on its way.
    @State private var waited = false

    var body: some View {
        if !scroll.loaded {
            VStack(spacing: Space.md) {
                if workbench.connection is RiffetConnectionStateFailed, TranscriptHost.loadedPresentation(workbench, sessionId: sessionId) == nil {
                    Image(icon: "wifi.exclamationmark").font(.riffet(size: 22)).foregroundStyle(palette.fg4)
                    Text("暂时无法加载对话").font(.riffet(size: S(13))).foregroundStyle(palette.fg3)
                    Button { workbench.store.retry() } label: { Label("重试", icon: "arrow.clockwise") }
                        .buttonStyle(ChipButtonStyle())
                } else if waited {
                    Spinner(size: .small)
                    Text("正在加载对话…").font(.riffet(size: S(13))).foregroundStyle(palette.fg3)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .task {
                try? await Task.sleep(for: Workbench.assemblyWait)
                waited = true
            }
        }
    }
}

extension Notification.Name {
    static let riffetOpenVisualization = Notification.Name("riffet.open-visualization")
}

private struct OpenSubagentKey: EnvironmentKey {
    static let defaultValue: ((String, String) -> Void)? = nil
}

private struct QuoteMessageKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}

extension EnvironmentValues {
    /// Puts a message into the composer as a quote.
    var quoteMessage: ((String) -> Void)? {
        get { self[QuoteMessageKey.self] }
        set { self[QuoteMessageKey.self] = newValue }
    }

    var openSubagent: ((String, String) -> Void)? {
        get { self[OpenSubagentKey.self] }
        set { self[OpenSubagentKey.self] = newValue }
    }
}
