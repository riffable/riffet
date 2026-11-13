import SwiftUI
import RiffetKit

struct ConversationView: View {
    let workbench: Workbench
    let sessionID: String
    var focusApproval = false
    var focusSequence: Int64? = nil
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale
    @Environment(\.scenePhase) private var scenePhase
    @State private var feedback = ConversationFeedback()
    @State private var feedbackRowVisible = false
    @State private var feedbackDetail: ConversationFeedback.Entry?
    @State private var restored = false
    @State private var scrollRequest: ConversationTranscriptList.Request?
    @State private var userScrolled = false
    @State private var nearBottom = true
    @State private var atBottom = false
    @State private var nearTop = false
    @State private var followsTail = true
    @State private var unread = false
    @State private var approvalVisible = false
    /// The floating composer zone's height; the transcript ends above it.
    @State private var composerHeight: CGFloat = 0
    /// The last read, with the key it was read for; it redraws the page when the read lands.
    @State private var loadedCatalog: (key: String, entry: NativeBackendCatalogEntry)?
    /// Rows newer than the resident window exist: its tail is not the session's latest.
    @State private var hasNewer = false
    @State private var catalogError: String?
    @State private var catalogLoading = false
    @State private var sendingScroll = 0
    @State private var terminal = false
    @State private var terminalResume = false
    /// A reopen is in flight; `restarting` when it is 「重启并应用」 rather than a plain resume.
    @State private var resuming = false
    @State private var restarting = false
    @State private var restartBinding: SessionNativeRuntime?
    @State private var didFocusApproval = false
    @State private var didFocusMessage = false
    @State private var focusCursor: String?
    @State private var focusError: String?
    @State private var focusedRow: String?
    @State private var outline = false
    @State private var turnQuery = ""
    @State private var jumpTarget: String?
    @State private var information = false
    @State private var processExpansion: [String: Bool] = [:]
    @State private var runningProcesses: Set<String> = []
    @State private var disclosureState = ConversationDisclosureState()
    @State private var selection: ConversationSelection?
    @State private var composerFocus = 0
    @State private var renaming = false
    @State private var renameTitle = ""
    @State private var findState: FindState?
    @State private var probe = ConversationTranscriptProbe()
    /// A find target whose cell is not drawn yet, and how many passes it has waited for it.
    @State private var pendingFind: (target: FindTarget, passes: Int)?
    /// How far the find bar reaches below the top bar; rows rest below it.
    @State private var findReach: CGFloat = 0
    private let ledger = ConversationInteractionLedger.shared
    private var ledgerKey: String { "\(workbench.baseURL.absoluteString)|\(sessionID)" }
    private var session: Session? { (workbench.selected?.id == sessionID ? workbench.selected : nil) ?? workbench.list.sessions.first { $0.id == sessionID } }
    private var rows: [any TimelineRow] { workbench.presentation?.sessionId == sessionID ? workbench.grouping?.rows ?? [] : [] }
    private var ready: Bool { workbench.presentation?.sessionId == sessionID && workbench.presentation?.loaded == true }
    private var lastVersion: String { guard workbench.presentation?.sessionId == sessionID, let item = workbench.grouping?.items.last else { return "" }; return "\(item.key)|\(ObjectIdentifier(item as AnyObject))" }
    /// Changes when the rows held are replaced or grow, e.g. by the page a find step loaded.
    private var findWindow: String { "\(workbench.grouping?.items.first?.key ?? "")|\(workbench.grouping?.items.count ?? 0)" }
    private var processVersion: [String] { rows.compactMap { $0 as? TimelineRowProcess }.map { "\($0.key)|\($0.running)|\($0.endsTurn)|\($0.issueCount)|\($0.interrupted)" } }
    private var scrollAccessibilityValue: String {
        let position = !ready ? String(localized: "正在加载", bundle: .riffet) : atBottom ? String(localized: "已到会话结尾", bundle: .riffet) : String(localized: "正在回看历史", bundle: .riffet)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-conversation-diagnostics") {
            return position + ";route=" + sessionID + ";selected=" + (workbench.selected?.id ?? "nil") + ";presentation=" + (workbench.presentation?.sessionId ?? "nil") + ";loaded=\(workbench.presentation?.loaded == true);rows=\(rows.count);restored=\(restored);follows=\(followsTail);userScrolled=\(userScrolled)"
        }
        #endif
        return position
    }
    /// The row find landed on and what to mark in it; nil unless a target is selected.
    private var findHighlight: (key: String, value: ConversationFindHighlight)? {
        guard let state = findState, state.open, !state.needle.isEmpty, let target = state.target else { return nil }
        return (target.key, ConversationFindHighlight(needle: state.needle, nth: Int(target.nth), request: target.request))
    }
    private func landFind(_ target: FindTarget) {
        pendingFind = (target, 0)
        resolveFind()
    }
    /// Lands the pending find target once its item is held: a process holding it opens first, and the
    /// scroll waits for the cell that draws the item (the folded run holding it, if it stays folded).
    private func resolveFind() {
        guard let pending = pendingFind else { return }
        let target = pending.target, passes = pending.passes
        guard findState?.open == true, findState?.target?.request == target.request else { pendingFind = nil; return }
        guard let grouping = workbench.grouping, let index = grouping.items.firstIndex(where: { $0.key == target.key }),
              index < grouping.rowOfItem.size else { return } // the page around it is still loading
        let rowIndex = Int(grouping.rowOfItem.get(index: Int32(index)))
        guard rowIndex < grouping.rows.count else { pendingFind = nil; return }
        let row = grouping.rows[rowIndex]
        followsTail = false; userScrolled = true
        focusedRow = row.key
        if row is TimelineRowProcess, processExpansion[row.key] != true { processExpansion[row.key] = true }
        if let cell = probe.cells[target.key] {
            pendingFind = nil
            scrollRequest = .init(target: cell, anchor: .find)
        } else if passes < 3 {
            // The opened process draws its children on the next pass.
            pendingFind = (target, passes + 1)
            DispatchQueue.main.async { resolveFind() }
        } else {
            pendingFind = nil
            scrollRequest = .init(target: row.key, anchor: .find)
        }
    }
    /// The highlight for a cell drawing the target item. The occurrence index counts within that item,
    /// so a cell drawing several items (a folded run, a batch of notices), or one that cannot mark the
    /// words, is tinted instead (an empty needle), held until the next step as marked words are.
    private static func findHighlight(_ found: (key: String, value: ConversationFindHighlight), in entry: ConversationRenderPlan.Entry) -> ConversationFindHighlight? {
        let keys = entry.itemKeys
        guard keys.contains(found.key) else { return nil }
        return keys.count == 1 && entry.marksFindWords ? found.value : ConversationFindHighlight(needle: "", nth: 0, request: found.value.request)
    }
    private var supportsTerminal: Bool { catalog?.capabilities.supportsTerminal?.boolValue ?? ((session?.backendId ?? .cursor) == .cursor) }
    private var interactionVersion: String { workbench.interaction.map { $0.id + "|" + $0.revision } ?? "" }
    /// The catalog the page can draw now: the one cached from an earlier visit first, the fresh read after it.
    private var catalog: NativeBackendCatalogEntry? {
        SessionCatalogCache.entries[catalogCacheKey] ?? loadedCatalog.flatMap { $0.key == catalogCacheKey ? $0.entry : nil }
    }
    private var catalogCacheKey: String { workbench.baseURL.absoluteString + "|" + catalogKey }
    private var catalogKey: String { "\(sessionID)|\(session?.backendId?.name ?? "")|\(session?.backendProfileId ?? "")|\(workbench.list.backendRevision)" }
    private var connectionStatus: ConversationStatus? {
        session.map { conversationStatus(session: $0, status: workbench.status, connection: workbench.connection,
            runs: workbench.runs, interaction: workbench.interaction, reopening: resuming, supportsTerminal: supportsTerminal,
            requiresLiveTerminal: catalog?.capabilities.requiresLiveTerminal?.boolValue == true) }
    }
    private var needsResume: Bool {
        guard let state = connectionStatus else { return false }
        return state.statusKnown && !state.live && !state.archived && !state.starting && !state.syncing && state.connectionNotice == nil
    }

    private var feedbackSource: [ConversationFeedbackValue] {
        guard workbench.selected?.id == sessionID else { return [] }
        let status = workbench.status
        let showsConnection = connectionStatus?.connectionNotice == .failed || connectionStatus?.connectionNotice == .conflict
        let connectionMessage = showsConnection ? status?.connection?.message : nil
        var result: [ConversationFeedbackValue] = []
        if showsConnection, let message = connectionMessage ?? (connectionStatus?.connectionNotice == .conflict ? String(localized: "会话连接失败", bundle: .riffet) : nil) {
            result.append(.init(key: "connection", text: message, retry: true))
        }
        var historyMessage: String?
        if status?.history?.state == "error" {
            historyMessage = status?.history?.message ?? String(localized: "历史同步失败", bundle: .riffet)
        } else if status?.history == nil, status?.transcript == "unparsed", connectionStatus?.starting != true, connectionStatus?.syncing != true {
            historyMessage = String(localized: "无法解析 Agent 的会话记录，请检查后端版本。", bundle: .riffet)
        }
        if let message = historyMessage, message != connectionMessage {
            result.append(.init(key: "history", text: message, retry: true))
        }
        // Info is routine progress and lives in the information sheet; a missing level is a warning.
        if let notice = status?.notice, !notice.isEmpty, status?.noticeLevel != "info", notice != connectionMessage, notice != historyMessage {
            result.append(.init(key: "notice:" + notice, text: notice, error: status?.noticeLevel == "error", warning: true))
        }
        return result
    }
    /// On screen in the foreground: what arrives is seen, on every device.
    private var seenActivity: String? {
        guard scenePhase == .active, workbench.visibleSessionID == sessionID, let session else { return nil }
        return session.lastActivityAt ?? session.createdAt
    }
    private var feedbackVisible: Bool {
        scenePhase == .active && ready && workbench.visibleSessionID == sessionID && !terminal && !information && !outline && selection == nil && feedbackDetail == nil && !renaming && restartBinding == nil
    }
    private var persistentFeedback: [ConversationFeedback.Entry] { feedback.presented(in: ledgerKey).filter { !$0.value.key.hasPrefix("notice:") } }
    private var floatingFeedback: [ConversationFeedback.Entry] { feedback.presented(in: ledgerKey).filter { $0.value.key.hasPrefix("notice:") } }
    private func updateFeedback() {
        var recovered = Set<String>()
        if workbench.status?.connection?.state == "connected" { recovered.insert("connection") }
        if workbench.status?.history?.state == "ready" { recovered.insert("history") }
        feedback.update(scope: ledgerKey, source: feedbackSource, visible: feedbackVisible, recovered: recovered)
    }

    var body: some View {
        Group {
            if let session { conversation(session) }
            else if let error = workbench.error {
                ContentUnavailableView { Label("无法打开会话", systemImage: "exclamationmark.bubble") } description: { Text(AppModel.connectionMessage(error)) } actions: { Button("重试") { Task { await workbench.open(sessionID: sessionID) } } }
            } else { ProgressView("正在读取会话…") }
        }
        .onAppear { workbench.visibleSessionID = sessionID }
        .onDisappear { feedback.pause(); if workbench.visibleSessionID == sessionID { workbench.visibleSessionID = nil } }
        .onChange(of: feedbackSource, initial: true) { _, _ in updateFeedback() }
        .onChange(of: feedbackVisible) { _, _ in updateFeedback() }
        .onChange(of: seenActivity, initial: true) { _, activity in if activity != nil { workbench.markSeen(sessionID) } }
        .onChange(of: ledgerKey, initial: true) { _, _ in
            feedbackDetail = nil
            feedbackRowVisible = false
            updateFeedback()
        }
        .task(id: sessionID) { await workbench.open(sessionID: sessionID) }
        .onChange(of: workbench.removal) { _, removal in if removal?.ids.contains(sessionID) == true { dismiss() } }
        .task(id: catalogKey) { if let session { await loadCatalog(session) } }
    }

    private func conversation(_ session: Session) -> some View {
        let draft = workbench.drafts.draft("session.\(sessionID)")
        return Group {
            if ready {
                ConversationTranscriptList(
                    rows: transcriptRows(session, draft: draft), request: scrollRequest,
                    followsTail: followsTail, accessibilityValue: scrollAccessibilityValue,
                    currentApprovalID: workbench.interaction != nil || workbench.status?.phase == .attention ? approvalID : nil,
                    bottomInset: composerHeight,
                    topInset: findState?.open == true ? findReach : 0,
                    onPosition: { near, at, approval, top in
                        nearBottom = near; atBottom = at; approvalVisible = approval; nearTop = top
                        if near { unread = false }
                    },
                    onBeginDragging: { userScrolled = true; followsTail = false },
                    onEndDragging: { followsTail = $0 },
                    onReady: { observeInteraction(); restore() },
                    onFeedbackVisibility: { feedbackRowVisible = $0 },
                    probe: probe
                )
                // Under the bars: the system's soft edge fades what scrolls beneath them.
                .ignoresSafeArea(.container, edges: [.top, .bottom])
                .environment(\.conversationReadAction, { followsTail = false; userScrolled = true })
                .environment(\.conversationDisclosureState, disclosureState)
                .environment(\.conversationSelectText, { selection = ConversationSelection(text: $0) })
                .environment(\.conversationQuote, { quote($0, into: draft) })
                .environment(\.conversationFeedbackActive, feedbackVisible)
                .environment(\.conversationFindProbe, probe)
            } else { ProgressView("正在读取会话…").frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
        .background(palette.bg)
        // Rows passing under the bar are blurred, fading out just below it, so the title never sits on bare prose.
        .overlay(alignment: .top) { RiffetBarScrim() }
        .overlay(alignment: .top) {
            if !floatingFeedback.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(floatingFeedback) { entry in feedbackNotice(entry) }
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.bgElevated, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.line, lineWidth: 0.5))
                .padding(.horizontal, 18).padding(.top, findState?.open == true ? findReach : 8) // below the find bar
                .frame(maxWidth: RiffetMetrics.readingWidth)
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.18), value: floatingFeedback.map(\.id))
        .modifier(ConversationFindLayer(find: workbench.store.find, state: $findState, land: landFind, topRowKey: { probe.topRowKey() }, window: findWindow, retry: resolveFind, reach: $findReach))
        .onChange(of: lastVersion) { _, _ in
            guard restored else { return }
            if focusSequence != nil && !didFocusMessage { focusMessage(); return }
            if !followsTail { unread = true }
        }
        .onChange(of: interactionVersion) { _, _ in
            observeInteraction()
            if workbench.interaction != nil && focusApproval && !didFocusApproval && !userScrolled {
                followsTail = false; scrollRequest = .init(target: approvalID, anchor: .center); didFocusApproval = true
            }
        }
        .onChange(of: ready) { _, loaded in if loaded { observeInteraction() } }
        .onChange(of: processVersion, initial: true) { _, _ in updateProcessExpansion() }
        .onChange(of: rows.first?.key) { _, _ in if focusSequence != nil && !didFocusMessage { focusMessage() } }
        // Older history is read before the reader reaches it; the store ignores a request while one is
        // in flight, so this fires again only when a page has landed and the reader is still near the top.
        .onChange(of: wantsOlder) { _, wants in if wants { workbench.loadOlder() } }
        .onChange(of: workbench.loadingHistory) { _, loading in if !loading && focusSequence != nil && !didFocusMessage { focusMessage() } }
        // What the reader just sent is what they want to watch.
        .onChange(of: sendingScroll) { _, _ in jumpToLatest() }
        .task(id: sessionID) {
            let flow = workbench.store.hasNewerHistory
            hasNewer = flow.value.boolValue
            for await _ in flow { hasNewer = flow.value.boolValue }
        }
        .onChange(of: jumpTarget) { _, key in
            guard let key else { return }
            followsTail = false; focusedRow = key; userScrolled = true; processExpansion[key] = true
            scrollRequest = .init(target: key, anchor: .top); jumpTarget = nil
        }
        .task { if ready { observeInteraction() } }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer(session, draft: draft) }
        .navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $terminal) { TerminalPage(workbench: workbench, projectID: session.projectId, terminalID: session.terminalId) }
        .sheet(isPresented: $information) { ConversationInformation(workbench: workbench, session: session, catalog: catalog, connectionStatus: connectionStatus) }
        .sheet(isPresented: $outline) { turnOutline }
        .sheet(isPresented: $terminalResume) { TerminalResumeSheet(workbench: workbench, sessionID: sessionID) }
        .sheet(item: $selection) { ConversationSelectionSheet(selection: $0) }
        .sheet(item: $feedbackDetail) { entry in
            NavigationStack {
                ScrollView {
                    Text(entry.value.text).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding()
                }
                .navigationTitle(String(localized: "详情", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { feedbackDetail = nil } } }
            }
            .presentationDetents([.medium, .large])
        }
        .alert("重启并应用？", isPresented: Binding(get: { restartBinding != nil }, set: { if !$0 { restartBinding = nil } })) {
            Button("取消", role: .cancel) { restartBinding = nil }
            Button("重启并应用", role: .destructive) {
                let binding = restartBinding
                restartBinding = nil
                Task { await resume(restartBinding: binding) }
            }
        } message: { Text("运行中的任务会中断，对话记录保留") }
        .alert("重命名会话", isPresented: $renaming) {
            TextField("名称", text: $renameTitle)
            Button("保存") {
                let title = renameTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                if !title.isEmpty { Task { await workbench.update(session, title: title) } }
            }.disabled(renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("取消", role: .cancel) {}
        }
        // Felt, not seen: a message left, the agent needs you, or the turn ended while you watch.
        .sensoryFeedback(.impact(weight: .light), trigger: sendingScroll)
        .sensoryFeedback(trigger: hapticPhase) { old, new in
            if new == "attention" && old != "attention" { return .warning }
            if old == "busy" && new == "idle" { return .success }
            return nil
        }
        .toolbar(.hidden, for: .bottomBar)
        .toolbar { conversationToolbar(session) }
    }

    private func transcriptRows(_ session: Session, draft: MessageDraft) -> [ConversationTranscriptList.Row] {
        let records = ledger.records(for: ledgerKey)
        let byRow = Dictionary(grouping: records, by: \.afterRow)
        let presentation = workbench.presentation?.sessionId == sessionID ? workbench.presentation : nil
        let rows = presentation?.grouping.rows ?? []
        let compactAbove = (presentation?.compactAbove ?? []).map(\.boolValue)
        let speeds = presentation?.speeds ?? [:]
        let rowKeys = Set(rows.map(\.key))
        let entries = ConversationRenderPlan.entries(rows: rows, compactAbove: compactAbove, expanded: effectiveProcessExpansion(), focusedRow: focusedRow,
                                                     scope: workbench.baseURL.absoluteString + "|" + sessionID, readingAbove: !nearBottom)
        var result: [ConversationTranscriptList.Row] = []
        let find = findHighlight
        func append<V: View>(_ id: String, revision: AnyHashable, top: CGFloat = 0, highlight: ConversationFindHighlight? = nil, content: V) {
            result.append(.init(id: id, revision: rowRevision(revision, colorScheme, dynamicTypeSize, locale.identifier, highlight ?? ConversationFindHighlight(needle: "", nth: 0)), content: AnyView(content
                .environment(\.conversationFindHighlight, highlight)
                .modifier(ConversationFindFlash(highlight: highlight))
                .environment(\.colorScheme, colorScheme).environment(\.dynamicTypeSize, dynamicTypeSize).environment(\.locale, locale)
                .environment(\.conversationReadingHistory, !nearBottom).environment(\.conversationFocusedRow, focusedRow)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.top, top))))
        }
        func appendRecords(_ values: [ConversationInteractionLedger.Record]) {
            for record in values {
                append("approval." + record.id,
                       revision: rowRevision(record.interaction.revision, record.waiting, record.confirmed, record.result ?? ""),
                       top: 12, content: interactionRecord(record, session: session))
            }
        }
        if !persistentFeedback.isEmpty {
            let revision = persistentFeedback.map { "\($0.id)|\($0.value.text)|\($0.current)|\($0.recovered)" }.joined(separator: "|")
            append("meta.connection", revision: revision, top: 8, content: connectionNotice(session))
        }
        if let cached = workbench.cachedAt {
            append("meta.cache", revision: cached, top: 8, content: Label("显示设备缓存 · \(Date(timeIntervalSince1970: Double(cached) / 1000).formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale)))", systemImage: "clock.arrow.circlepath").font(.caption).foregroundStyle(.secondary))
        }
        if let error = workbench.historyError {
            append("meta.history", revision: error, top: 8, content: historyRetry(error))
        }
        if focusSequence != nil && !didFocusMessage {
            if let focusError { append("meta.focus", revision: focusError, top: 8, content: Text(focusError).font(.caption).foregroundStyle(.secondary)) }
            else { append("meta.focus", revision: "loading", top: 8, content: Label("正在定位搜索结果…", systemImage: "magnifyingglass").font(.caption).foregroundStyle(.secondary)) }
        }
        if rows.isEmpty && !workbench.working {
            append("meta.empty", revision: 0, top: 20, content: ContentUnavailableView("还没有消息", systemImage: "bubble.left.and.text.bubble.right"))
        }
        appendRecords(byRow[nil] ?? [])
        var readingKeys: [String: String] = [:], cells: [String: String] = [:]
        for entry in entries {
            if let key = entry.readingKey { readingKeys[entry.id] = key }
            for key in entry.itemKeys where cells[key] == nil || entry.itemKeys.count == 1 { cells[key] = entry.id }
        }
        probe.readingKeys = readingKeys
        probe.cells = cells
        for entry in entries {
            let speed = speeds[entry.rowKey]
            // Only a process rendered as one cell reads `readingHistory` (to
            // decide its post-run fold). Putting the scroll-derived flag in
            // every row's revision reconfigured — and re-measured — the whole
            // list each time the reader crossed the near-bottom threshold.
            let historySensitive = switch entry.content {
            case let .row(row): row is TimelineRowProcess
            default: false
            }
            append(entry.id, revision: rowRevision(ConversationRenderPlan.revision(entry, speed: speed), historySensitive ? !nearBottom : false, focusedRow ?? ""), top: entry.topSpacing,
                   highlight: find.flatMap { found in Self.findHighlight(found, in: entry) }, content: transcriptEntry(entry, session: session, speed: speed))
            if entry.isLastInRow { appendRecords(byRow[entry.rowKey] ?? []) }
        }
        appendRecords(records.filter { $0.afterRow.map { !rowKeys.contains($0) } ?? false })
        if workbench.interaction == nil && workbench.status?.phase == .attention {
            append("unknownApproval", revision: supportsTerminal, top: 12, content: unknownInteraction(session))
        }
        if workbench.goal != nil || !workbench.todos.isEmpty || !workbench.queued.isEmpty {
            append("docks", revision: rowRevision(catalog?.capabilities.supportsSteer ?? false, workbench.status?.activeTurn?.turnId ?? ""), top: 12, content: ConversationRunDocks(workbench: workbench, draft: draft, supportsSteer: catalog?.capabilities.supportsSteer == true, supportsTargetedStop: catalog?.capabilities.supportsTargetedStop?.boolValue == true))
        }
        // The compaction activity already shows progress in the timeline.
        if workbench.selected?.id == sessionID && (workbench.sendState.interrupting || workbench.status?.phase == .busy && !workbench.dock.compacting) {
            // Just that it is working: the current step is already the live row above.
            append("working", revision: workbench.sendState.interrupting, top: 12,
                   content: HStack(spacing: 8) {
                ProgressView().controlSize(.small).tint(.secondary).frame(width: 18)
                Text(workbench.sendState.interrupting ? "停止中" : "正在处理").font(.subheadline)
                Spacer(minLength: 0)
            }.foregroundStyle(.secondary)
                .accessibilityElement(children: .ignore).accessibilityLabel(workbench.sendState.interrupting ? "停止中" : "正在处理")
                .accessibilityIdentifier("conversationWorking"))
        }
        if workbench.selected?.id == sessionID && workbench.status?.phase != .busy && workbench.backgroundSubagents > 0 {
            let count = workbench.backgroundSubagents
            append("background", revision: count, top: 12,
                   content: Label("后台 \(count) 个任务运行中", systemImage: "gearshape.2").font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("conversationBackground"))
        }
        append("transcriptEnd", revision: 0, content: Color.clear.frame(height: 18).accessibilityHidden(true))
        return result
    }

    private func rowRevision(_ values: AnyHashable...) -> AnyHashable {
        var hasher = Hasher()
        for value in values { hasher.combine(value) }
        return hasher.finalize()
    }

    private func transcriptEntry(_ entry: ConversationRenderPlan.Entry, session: Session, speed: SpeedTag?) -> some View {
        ConversationEntryView(entry: entry, workbench: workbench, projectID: session.projectId, backend: session.backendId ?? .cursor, speed: speed) { process, open in
            followsTail = false; userScrolled = true; processExpansion[process.key] = !open
        }
    }

    /// The expansion this entries pass must use, derived in the same pass that
    /// observes the rows: a process that has just stopped running keeps the
    /// openness it had while live when the reader is in history, rather than
    /// folding in this pass and being re-opened by `updateProcessExpansion`
    /// after it — two snapshots, one visible slide of everything above.
    private func effectiveProcessExpansion() -> [String: Bool] {
        var expanded = processExpansion
        let running = Set(rows.compactMap { $0 as? TimelineRowProcess }.filter(\.running).map(\.key))
        for process in rows.compactMap({ $0 as? TimelineRowProcess })
        where runningProcesses.contains(process.key) && !running.contains(process.key)
            && process.issueCount == 0 {
            // One direction only: never un-pin on account of the scroll
            // position. `nearBottom` flips as the reader crosses its threshold,
            // and deriving a fold from it made settled blocks collapse and
            // re-expand mid-scroll, sliding everything after them.
            if !nearBottom && expanded[process.key] != false { expanded[process.key] = true }
        }
        return expanded
    }

    private func updateProcessExpansion() {
        let processes = rows.compactMap { $0 as? TimelineRowProcess }
        let running = Set(processes.filter(\.running).map(\.key))
        let keys = Set(processes.map(\.key))
        processExpansion = processExpansion.filter { keys.contains($0.key) }
        for process in processes {
            if runningProcesses.contains(process.key) && !running.contains(process.key),
               process.issueCount == 0 && processExpansion[process.key] == nil {
                // Keep an active process open while the reader is reviewing history; its
                // header may already be offscreen, so header visibility is not sufficient.
                if !nearBottom { processExpansion[process.key] = true }
            }
        }
        runningProcesses = running
    }

    /// Shown only after the store has retried a page several times; paging otherwise happens unseen.
    private func historyRetry(_ error: String) -> some View {
        Button { workbench.store.retryHistory() } label: { Label("更早的消息加载失败", systemImage: "arrow.clockwise").font(.caption) }
            .buttonStyle(.plain).foregroundStyle(.secondary).frame(maxWidth: .infinity).accessibilityHint(error)
    }
    private var hapticPhase: String {
        guard workbench.selected?.id == sessionID, let phase = workbench.status?.phase else { return "" }
        return phase.wire
    }
    /// Appends the passage as a Markdown quote and puts the cursor after it.
    private func quote(_ text: String, into draft: MessageDraft) {
        let quoted = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n").map { $0.isEmpty ? ">" : "> " + $0 }.joined(separator: "\n")
        let current = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        draft.text = (current.isEmpty ? "" : draft.text + "\n\n") + quoted + "\n\n"
        composerFocus += 1
    }
    /// `nearTop` is false for a long transcript read at its bottom; a short one keeps paging until it fills the screen.
    private var wantsOlder: Bool { ready && nearTop && workbench.history?.hasMore == true && !workbench.loadingHistory && workbench.historyError == nil }
    private var approvalID: String { workbench.interaction.map { "approval." + $0.id } ?? "unknownApproval" }
    @ViewBuilder private func interactionRecord(_ record: ConversationInteractionLedger.Record, session: Session) -> some View {
        if record.waiting, workbench.interaction?.id == record.id || InteractionDrafts.shared.hasPendingSubmission(for: "\(workbench.baseURL.absoluteString):\(sessionID):\(record.id)") {
            InteractionCardView(workbench: workbench, interaction: record.interaction, sessionID: sessionID,
                                openTerminal: supportsTerminal ? { terminal = true } : nil,
                                onSubmitted: { ledger.submitted($0, interaction: record.interaction, for: ledgerKey) })
                .id("approval." + record.id)
        } else {
            InteractionCardView(workbench: workbench, interaction: record.interaction, sessionID: sessionID,
                                readOnly: true, confirmed: record.confirmed, result: record.result ?? String(localized: "Agent 已不再等待此请求。", bundle: .riffet))
                .id("approval." + record.id).accessibilityIdentifier("approvalResult")
        }
    }
    private func observeInteraction() {
        guard ready else { return }
        ledger.observe(workbench.interaction, for: ledgerKey, after: rows.last?.key, authoritative: workbench.connection is RiffetConnectionStateLive)
    }
    private func unknownInteraction(_ session: Session) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Agent 正在等待操作", systemImage: "exclamationmark.bubble").font(.headline)
            Text(supportsTerminal ? "这个交互需要在原生终端里继续。" : "正在同步可处理的交互。若持续等待，可重试同步或到电脑查看。").font(.subheadline).foregroundStyle(.secondary)
            if supportsTerminal { Button("打开终端") { terminal = true } }
            Button("重新同步") { Task { await workbench.perform { _ = try await workbench.store.syncInteraction() } } }
        }.padding(12).background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }
    private func composer(_ session: Session, draft: MessageDraft) -> some View {
        VStack(spacing: 0) {
            if let notice = workbench.runtimeControl?.notice {
                let pending = workbench.runtimeActionPending
                let label = localizedText(notice.label, fallback: "")
                HStack(spacing: 8) {
                    if pending || notice.tone == "progress" { ProgressView().controlSize(.small) }
                    if !label.isEmpty && !pending {
                        Text(label).font(.caption).foregroundStyle(notice.tone == "danger" ? Color.red : Color.secondary)
                            .accessibilityHint(notice.detail ?? "")
                    }
                    Spacer(minLength: 8)
                    if let action = notice.action, !pending {
                        Button(localizedText(action.label, fallback: "")) { Task { await workbench.runRuntimeAction(action, sessionID: sessionID) } }
                            .disabled(action.disabled?.boolValue == true)
                    }
                }.padding(.horizontal, 16).padding(.vertical, 8)
                .riffetGlass(in: Capsule()).padding(.horizontal, 12).padding(.bottom, 4)
            }
            if workbench.interaction != nil && !approvalVisible {
                Button { followsTail = false; scrollRequest = .init(target: approvalID, anchor: .center) } label: { Label("等待你处理 · 查看", systemImage: "hand.raised").font(.subheadline).frame(maxWidth: .infinity).frame(minHeight: 42) }.riffetGlass(in: Capsule(), interactive: true).padding(.horizontal, 12).padding(.bottom, 4).accessibilityIdentifier("pendingApprovalLink")
            }
            ConversationComposer(workbench: workbench, session: session, draft: draft, supportsInterrupt: catalog?.capabilities.supportsInterrupt == true && catalog?.capabilities.supportsTargetedStop?.boolValue == true, catalog: catalog,
                                 catalogLoading: catalogLoading, catalogError: catalogError,
                                 onOptionsClosed: { if catalogError != nil, !catalogLoading { Task { await loadCatalog(session) } } },
                                 focusRequest: composerFocus) { sendingScroll += 1 }
        }
        // The transcript's column (see `TranscriptLayout.columnWidth`).
        .frame(maxWidth: RiffetMetrics.readingWidth)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { composerHeight = $0 }
        .overlay(alignment: .topTrailing) {
            Group {
                if workbench.interaction == nil && (hasNewer || !followsTail && !nearBottom) {
                    Button { jumpToLatest() } label: {
                        Image(systemName: "arrow.down").font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(palette.fg).frame(width: 40, height: 40)
                            .riffetGlass(in: Circle(), interactive: true)
                            .frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget).contentShape(Circle())
                    }.buttonStyle(.plain)
                        .overlay(alignment: .topTrailing) { if unread || hasNewer { Circle().fill(palette.accent).frame(width: 8, height: 8).padding(4).allowsHitTesting(false) } }
                        .accessibilityLabel(unread || hasNewer ? "有新内容，回到最新" : "回到最新")
                        .accessibilityIdentifier("latestContent").padding(.bottom, 8).padding(.trailing, 14)
                        .transition(.opacity)
                }
            }.alignmentGuide(.top) { $0[.bottom] }
                .animation(RiffetMotion.effects, value: hasNewer || !followsTail && !nearBottom)
        }
        .frame(maxWidth: .infinity)
    }
    /// Back to the newest content of the session: when paging moved the window away from the head, the
    /// store brings the latest rows back first; the list then follows the tail.
    private func jumpToLatest() {
        if hasNewer { workbench.store.jumpToLatest() }
        followsTail = true; unread = false
        scrollRequest = .init(target: nil, anchor: .bottom)
    }
    @ToolbarContentBuilder private func conversationToolbar(_ session: Session) -> some ToolbarContent {
        // A remedy is the bar's own glass button; a connection that is fine shows nothing.
        let reconnects = connectionStatus?.connectionNotice == .failed
        // A resume reads as "starting" at once, which ends needsResume; the button stays and spins
        // until the request returns. A restart has its own entry and shows the title's badge instead.
        let resumingHere = resuming && !restarting
        let resumes = resumingHere || (needsResume && catalog?.capabilities.supportsResume == true)
        // The principal slot spans from the back button to the trailing buttons; a leading item
        // would only get its content's width and cut the title to a character or two.
        ToolbarItem(placement: .principal) {
            Button { information = true } label: {
                HStack(spacing: 4) {
                    // A generated sentence, not a page name: list-title size, so it reads as content and truncates later.
                    Text(session.title).riffetFont(.headline).lineLimit(1).truncationMode(.tail)
                    // Only states that need attention; whether it runs is in the information sheet.
                    if let badge = connectionStatus?.badge, !reconnects, !resumingHere {
                        if badge.loading { ProgressView().controlSize(.mini).accessibilityLabel(badge.text) }
                        else { Image(systemName: "exclamationmark.circle").foregroundStyle(badge.warning ? palette.warning : palette.fg3).accessibilityLabel(badge.text) }
                    }
                }.foregroundStyle(palette.fg).frame(maxWidth: .infinity, minHeight: RiffetMetrics.hitTarget, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel(String(localized: "会话信息：\(session.title)", bundle: .riffet))
                .accessibilityValue(connectionStatus?.badge?.text ?? (needsResume ? String(localized: "此会话当前未运行", bundle: .riffet) : ""))
                .accessibilityIdentifier("conversationInformation")
        }
        .sharedBackgroundHidden()
        if reconnects || resumes {
            ToolbarItem(placement: .topBarTrailing) {
                if reconnects {
                    Button("重连") { workbench.store.retry() }
                        .tint(palette.warning).accessibilityIdentifier("conversationReconnect")
                } else {
                    Button { Task { await resume() } } label: {
                        ZStack { Text("恢复").opacity(resumingHere ? 0 : 1); if resumingHere { ProgressView().controlSize(.mini) } }
                    }.tint(palette.accent).disabled(resuming).accessibilityIdentifier("conversationResume")
                }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button(String(localized: "查找", bundle: .riffet), systemImage: "magnifyingglass") { workbench.store.find.open(readingPos: nil) }.accessibilityIdentifier("conversationFind")
                Button("会话目录", systemImage: "list.bullet") { outline = true }.disabled(workbench.presentation?.turns.isEmpty != false).accessibilityIdentifier("conversationOutline")
                Divider()
                if connectionStatus?.connectionNotice == .failed || connectionStatus?.connectionNotice == .conflict {
                    Button("重试连接", systemImage: "arrow.clockwise") { workbench.store.retry() }
                }
                if needsResume, catalog?.capabilities.supportsResume == true {
                    Button("恢复会话", systemImage: "arrow.clockwise") { Task { await resume() } }
                }
                if workbench.status?.profilePending?.boolValue == true, session.archivedAt == nil, let binding = session.nativeRuntime {
                    Button("重启并应用", systemImage: "arrow.clockwise") { restartBinding = binding }.disabled(resuming)
                }
                NavigationLink { SessionOptionsView(workbench: workbench, session: session) } label: { Label("会话选项", systemImage: "slider.horizontal.3") }
                if let actions = workbench.runtimeControl?.actions, !actions.isEmpty {
                    ForEach(actions, id: \.id) { action in
                        Button { Task { await workbench.runRuntimeAction(action, sessionID: sessionID) } } label: {
                            // A menu shows a label's second text as the item's subtitle.
                            Label {
                                Text(localizedText(action.label, fallback: action.id))
                                if let hint = action.hint { Text(localizedText(hint, fallback: "")) }
                            } icon: { Image(systemName: "puzzlepiece.extension") }
                        }.disabled(action.disabled?.boolValue == true || workbench.runtimeActionPending)
                    }
                }
                if supportsTerminal { Button("终端", systemImage: "terminal") { terminal = true } }
                if session.backendId != .chat, session.archivedAt == nil, session.nativeSessionId != nil, session.terminalHold == nil {
                    Button("在终端恢复…", systemImage: "apple.terminal") { terminalResume = true }
                }
                // A quick chat's project is the server's own empty directory, not something to browse.
                if session.backendId != .chat, let project = workbench.project(session.projectId) {
                    NavigationLink { ProjectFilesView(workbench: workbench, project: project) } label: { Label("项目文件", systemImage: "folder") }
                    NavigationLink { ProjectChangesView(workbench: workbench, project: project) } label: { Label("项目变更", systemImage: "point.3.connected.trianglepath.dotted") }
                }
                Button("重命名", systemImage: "pencil") { renameTitle = session.title; renaming = true }
                Button(session.pinnedAt != nil ? "取消置顶" : "置顶会话", systemImage: session.pinnedAt != nil ? "pin.slash" : "pin") { Task { await workbench.update(session, pinned: session.pinnedAt == nil) } }
                Button(session.archivedAt == nil ? "归档会话" : "恢复会话", systemImage: session.archivedAt == nil ? "archivebox" : "arrow.uturn.backward") { Task { await workbench.update(session, archived: session.archivedAt == nil) } }
                if workbench.list.canDeleteSessions {
                    Button("删除…", systemImage: "trash", role: .destructive) { Task { await workbench.requestDeletion(session) } }.disabled(workbench.deletionLoading != nil)
                }
            } label: { Image(systemName: "ellipsis") }.accessibilityLabel("会话菜单")
        }
    }
    private var turnOutline: some View {
        NavigationStack {
            List {
                ForEach((workbench.presentation?.turns ?? []).filter { turnQuery.isEmpty || $0.preview.localizedCaseInsensitiveContains(turnQuery) }, id: \.rowKey) { turn in
                    Button { jumpTarget = turn.rowKey; outline = false } label: {
                        VStack(alignment: .leading, spacing: 5) { Text(turn.preview).foregroundStyle(.primary).lineLimit(3); if let time = turn.time, let date = ServerTime.date(time) { Text(date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale))).font(.caption).foregroundStyle(.secondary) } }.padding(.vertical, 4)
                    }
                }
            }.searchable(text: $turnQuery, prompt: String(localized: "搜索本次会话的提问", bundle: .riffet)).navigationTitle(String(localized: "会话目录", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { outline = false } } }
        }.presentationDragIndicator(.visible)
    }
    private func restore() {
        guard ready, !restored, workbench.visibleSessionID == sessionID else { return }
        restored = true
        guard !userScrolled else { return }
        if focusSequence != nil { followsTail = false; focusMessage() }
        else if focusApproval, workbench.interaction != nil || workbench.status?.phase == .attention {
            followsTail = false; scrollRequest = .init(target: approvalID, anchor: .center); didFocusApproval = true
        } else { followsTail = true; scrollRequest = .init(target: nil, anchor: .bottom) }
    }
    private func focusMessage() {
        guard let sequence = focusSequence, ready, !didFocusMessage, !workbench.loadingHistory,
              let grouping = workbench.grouping else { return }
        guard let first = grouping.items.first else { focusError = String(localized: "没有可定位的会话内容。", bundle: .riffet); return }
        if first.event.base.sequence > sequence {
            guard workbench.historyError == nil else { focusError = String(localized: "历史加载失败，请重试上方的历史加载。", bundle: .riffet); return }
            guard workbench.history?.hasMore == true else { focusError = String(localized: "搜索命中已不在可读取的历史中。", bundle: .riffet); return }
            let cursor = workbench.history?.cursor
            guard cursor != focusCursor else { focusError = String(localized: "历史未继续向前加载，请刷新后重试。", bundle: .riffet); return }
            focusCursor = cursor
            workbench.loadOlder()
            return
        }
        guard let index = grouping.items.lastIndex(where: { $0.event.base.sequence <= sequence }), index < grouping.rowOfItem.size else { focusError = String(localized: "无法定位这条搜索结果。", bundle: .riffet); return }
        let rowIndex = Int(grouping.rowOfItem.get(index: Int32(index)))
        guard rowIndex < grouping.rows.count else { focusError = String(localized: "无法定位这条搜索结果。", bundle: .riffet); return }
        let key = grouping.rows[rowIndex].key
        focusedRow = key
        processExpansion[key] = true
        scrollRequest = .init(target: key, anchor: .top)
        didFocusMessage = true
        focusError = nil
    }
    @ViewBuilder private func connectionNotice(_ session: Session) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(persistentFeedback) { entry in feedbackNotice(entry) }
        }
    }
    private func feedbackNotice(_ entry: ConversationFeedback.Entry) -> some View {
        let live = entry.current && feedbackSource.contains { $0.key == entry.value.key && $0.text == entry.value.text }
        return VStack(alignment: .leading, spacing: 8) {
            if !live && entry.recovered {
                Text("已恢复").font(.caption2).foregroundStyle(.secondary)
            }
            ConversationFeedbackText(text: entry.value.text, preview: true) { feedbackDetail = entry }
                .foregroundStyle(live ? (entry.value.error ? Color.red : entry.value.warning ? .orange : .secondary) : .secondary)
            if live && entry.value.retry {
                Button("重试") {
                    if feedbackSource.contains(where: { $0.key == entry.value.key && $0.text == entry.value.text }) { workbench.store.retry() }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .conversationFeedbackVisibility(feedback, id: entry.id, visible: entry.value.key.hasPrefix("notice:") || feedbackRowVisible)
    }
    private func resume(restartBinding: SessionNativeRuntime? = nil) async {
        guard !resuming else { return }
        resuming = true; restarting = restartBinding != nil
        defer { resuming = false; restarting = false }
        await workbench.perform {
            guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
            let result = if let restartBinding {
                try await api.restartSession(id: sessionID, fingerprint: restartBinding.fingerprint, address: restartBinding.address)
            } else {
                try await api.startSession(id: sessionID)
            }
            if let session = result.session { workbench.store.applySession(session: session) }
        }
    }
    private func loadCatalog(_ session: Session) async {
        let key = catalogKey
        // A catalog from an earlier visit stays on screen; the read below only refreshes it.
        let cached = SessionCatalogCache.entries[catalogCacheKey] != nil
        if !cached { catalogLoading = true }
        catalogError = nil
        defer { if key == catalogKey { catalogLoading = false } }
        do {
            guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
            let loaded = try await api.sessionCatalog(id: session.id)
            guard key == catalogKey else { return }
            SessionCatalogCache.entries[catalogCacheKey] = loaded
            loadedCatalog = (catalogCacheKey, loaded)
            catalogError = nil
        } catch is CancellationError {} catch { if key == catalogKey && !cached { catalogError = error.riffetMessage } }
    }
}

/// The session catalogs read so far, kept for the process so a conversation opens with its model label ready.
@MainActor private enum SessionCatalogCache {
    static var entries: [String: NativeBackendCatalogEntry] = [:]
}

private extension ToolbarContent {
    /// The title is text on the page, not a control: no glass capsule behind it.
    @ToolbarContentBuilder func sharedBackgroundHidden() -> some ToolbarContent {
        if #available(iOS 26.0, *) { sharedBackgroundVisibility(.hidden) } else { self }
    }
}

private struct ConversationInformation: View {
    let workbench: Workbench
    let session: Session
    let catalog: NativeBackendCatalogEntry?
    let connectionStatus: ConversationStatus?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var current: Session { workbench.selected?.id == session.id ? workbench.selected! : session }
    private var project: Project? { workbench.project(current.projectId) }
    private var subagents: [SubagentEntry] { workbench.subagentEntries }
    /// Live background tasks; a background subagent also reports as one, and is listed once, as the subagent.
    private var tasks: [NativeActivity] {
        let owned = Set(subagents.map(\.toolCallId))
        return workbench.dock.tasks.filter { $0.toolCallId.map { !owned.contains($0) } ?? true }
    }

    var body: some View {
        let current = current
        NavigationStack {
            List {
                Section {
                    Text(current.title).font(.headline).textSelection(.enabled)
                    LabeledContent("状态", value: current.state.label)
                    if let badge = connectionStatus?.badge { Text(badge.text).font(.caption).foregroundStyle(.secondary) }
                    if workbench.status?.profilePending?.boolValue == true { Text("新配置将在后端重启后生效").font(.caption).foregroundStyle(.secondary) }
                    if let notice = workbench.status?.notice, workbench.status?.noticeLevel == "info" { Text(notice).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                }
                Section("运行配置") {
                    LabeledContent("Agent", value: catalog?.label ?? workbench.backends.first { $0.backendId == (current.backendId ?? .cursor) }?.label ?? (current.backendId ?? .cursor).name.capitalized)
                        .accessibilityIdentifier("sessionInformationAgent")
                    if let profile = NativeConfigurationSummary.profile(catalog: catalog, profileID: current.backendProfileId) {
                        information("服务商", profile)
                    }
                    information("模型与参数", NativeConfigurationSummary.model(catalog: catalog, selection: current.model))
                    LabeledContent("运行模式", value: catalog?.capabilities.modes.first { $0.id == current.mode }?.label ?? current.mode)
                    if let approval = NativeConfigurationSummary.approval(status: workbench.status, backend: current.backendId ?? .cursor, sessionApproval: current.approval) {
                        LabeledContent("操作确认", value: catalog?.capabilities.permissions.first { $0.id == approval }?.label ?? approval)
                    }
                    NavigationLink("会话选项") { SessionOptionsView(workbench: workbench, session: current) }
                }
                if !subagents.isEmpty {
                    Section("子 Agent") {
                        ForEach(subagents, id: \.toolCallId) { entry in
                            HStack(spacing: 8) {
                                NavigationLink {
                                    ConversationSubagentPage(workbench: workbench, projectID: current.projectId, toolCallID: entry.toolCallId, title: entry.name, parentItems: nil)
                                        .environment(\.conversationReturnToMain, { dismiss() })
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(entry.name).font(.subheadline).lineLimit(1)
                                        Text([state(entry), entry.detail].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(entry.state == .failed ? .red : .secondary).lineLimit(1)
                                    }
                                }
                                if let task = workbench.dock.tasks.first(where: { $0.toolCallId == entry.toolCallId }) {
                                    ConversationActivityStopButton(workbench: workbench, task: task)
                                }
                            }
                        }
                    }.accessibilityIdentifier("conversationSubagents")
                }
                if !tasks.isEmpty {
                    Section("后台任务") {
                        ForEach(tasks, id: \.id) { ConversationBackgroundTaskRow(workbench: workbench, task: $0) }
                    }.accessibilityIdentifier("conversationBackgroundTasks")
                }
                Section("工作区") {
                    if let project {
                        information("项目", project.name)
                        information("工作目录", project.cwd, monospaced: true)
                            .accessibilityIdentifier("sessionInformationDirectory")
                        if let branch = project.worktree?.branch { information("Worktree 分支", branch) }
                    } else { Text("正在同步工作目录…").foregroundStyle(.secondary) }
                }
                Section("会话") {
                    information("会话 ID", current.id, monospaced: true)
                    if let nativeID = current.nativeSessionId ?? current.cursorSessionId {
                        information("Agent 会话 ID", nativeID, monospaced: true)
                    }
                    if !current.tags.isEmpty { information("标签", current.tags.map { "#" + $0 }.joined(separator: " ")) }
                    information("创建时间", date(current.createdAt))
                    information("最近活动", date(current.lastActivityAt ?? current.updatedAt))
                    information("服务器", workbench.baseURL.absoluteString)
                }
            }
            .accessibilityIdentifier("conversationInformationList")
            .navigationTitle(String(localized: "会话信息", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        .presentationDetents(dynamicTypeSize.isAccessibilitySize ? [.large] : [.medium, .large]).presentationDragIndicator(.visible)
    }
    private func information(_ title: LocalizedStringKey, _ value: String, monospaced: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(monospaced ? .subheadline.monospaced() : .subheadline)
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(.vertical, 3).accessibilityElement(children: .combine)
    }
    private func state(_ entry: SubagentEntry) -> String? {
        if let task = workbench.dock.tasks.first(where: { $0.toolCallId == entry.toolCallId }),
           activityView(activity: task, stopping: workbench.isStopping(activity: task.id), nowMillis: 0).stopping { return String(localized: "停止中", bundle: .riffet) }
        switch entry.state { case .running: return String(localized: "运行中", bundle: .riffet); case .failed: return String(localized: "失败", bundle: .riffet); default: return nil }
    }
    private func date(_ value: String) -> String {
        ServerTime.date(value)?.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale)) ?? value
    }
}
