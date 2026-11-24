import SwiftUI
import UniformTypeIdentifiers
import RiffetKit

struct ConversationView: View {
    let workbench: Workbench
    let session: Session
    @Environment(\.palette) private var palette
    @Environment(\.covered) private var covered
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var subagents: [SubagentTarget] = []
    @State private var dropTargeted = false
    @State private var fullscreen = false
    @State private var catalogError: String?
    @State private var catalogLoading = false
    @State private var slash: NativeSlashCatalog?
    @State private var orchestrator = SessionOrchestrator()
    @State private var autoOpenSpent = false
    @State private var autoOpenTask: Task<Void, Never>?
    @State private var visualization: VisualizationTarget?
    @State private var nativeNoticeDetail: String?
    /// Whether the conversation is wide enough for the overview column (`SessionAsideHost`).
    @State private var asideFits = false
    @State private var asideLink = TranscriptScrollLink()

    /// Read from the workbench's cache, so a switch never shows another conversation's catalog
    /// or an empty one while the new one loads.
    private var catalog: NativeBackendCatalogEntry? { workbench.catalogs.cached(for: session) }
    /// The connection revision already moves when the stream becomes live (first connect, after a
    /// failure), so a switch, whose stream reconnects, keeps its catalog and `/` menu.
    private var catalogKey: String {
        "\(session.id)|\(session.agentID)|\(session.backendProfileId ?? "")|\(session.projectId)|\(workbench.backendRevision)|\(workbench.catalogs.connectionRevision)"
    }

    private var isCurrentSession: Bool {
        guard let selected = workbench.selected else { return false }
        return selected.id == session.id && selected.agent == session.agent
            && selected.backendProfileId == session.backendProfileId && selected.projectId == session.projectId
    }

    /// This conversation's own composer, with its draft loaded: a switch never shows the previous draft for a frame.
    private var composer: ComposerModel { workbench.pageModels.sessionComposers.model(for: "session.\(session.id)") }

    private var state: ConversationState { ConversationState(workbench: workbench, session: session, catalog: catalog) }

    /// A quick chat has no agent controls, terminal, project directory or context meter.
    private var quickChat: Bool { session.agentID == AgentDirectory.quickChat }

    /// The provider this conversation ran on is gone: readable and handable-off, never sendable.
    private var providerMissing: Bool { workbench.providerMissing(for: session) }
    private var defaultSendSteers: Bool { workbench.store.prefersSteerWhileRunning() }
    private var feedbackScope: String { "\(workbench.baseURL.absoluteString)|\(session.projectId)|\(session.id)" }
    private var feedbackActive: Bool { workbench.assembledSession == session.id && visualization == nil && subagents.isEmpty && nativeNoticeDetail == nil }

    var body: some View {
        let state = state
        Group {
            if workbench.showsTerminalPage, state.supportsTerminal {
                terminalPage(state)
            } else if workbench.showsTerminalPage, catalog == nil, catalogError == nil {
                // Whether this backend has a terminal page is not known until its catalog is: wait for
                // it rather than showing the conversation and flipping to the terminal a moment later.
                terminalConnecting(state)
            } else {
                chat(state)
            }
        }
        .environment(\.conversationProjectId, session.projectId)
        .stylePopover(isPresented: Binding(get: { nativeNoticeDetail != nil }, set: { if !$0 { nativeNoticeDetail = nil } })) {
            if let nativeNoticeDetail {
                VStack(alignment: .trailing, spacing: Space.sm) {
                    ScrollView {
                        Text(nativeNoticeDetail)
                            .font(.riffet(size: S(13)))
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    CopyButton(text: nativeNoticeDetail)
                }
                .padding(Space.md)
                .frame(width: 440, height: 280)
            }
        }
        .sessionOrchestration(orchestrator, workbench: workbench, session: session)
        .onDisappear { composer.flushDraft() }
        .onChange(of: covered) { _, covered in
            if covered { composer.flushDraft() } else { autoOpen(state.unknownAttention, state: state) }
        }
        // Again once the connection is live: a load attempted before the server answered found nothing.
        .task(id: catalogKey) {
            await loadCatalog(reload: false)
        }
        .task(id: catalogKey) {
            guard !Task.isCancelled else { return }
            let request = RequestContext { catalogKey }
            let loaded = await workbench.catalogs.slashCatalog(for: session)
            guard request.isCurrent, isCurrentSession, loaded !== slash else { return }
            slash = loaded
        }
        .onChange(of: state.unknownAttention) { _, attention in autoOpen(attention, state: state) }
        .onChange(of: state.recognizedInteraction) { _, recognized in
            if recognized, workbench.terminalDock.automatic { workbench.terminalDock.hide() }
        }
        // The page stays across conversations (rebuilding the composer and docks on every switch
        // cost a frame); what belongs to one conversation moves over here.
        // Each write re-renders the page, so only what differs is written; the `/` menu already read
        // for the new conversation shows at once instead of disappearing until it is read again.
        .onChange(of: session.id) { _, _ in
            if composer.notice != nil { composer.notice = nil }
            autoOpenTask?.cancel()
            if autoOpenSpent { autoOpenSpent = false }
            if !subagents.isEmpty { subagents = [] }
            if visualization != nil { visualization = nil }
            orchestrator.sheet = nil
            orchestrator.message = nil
            if catalogError != nil { catalogError = nil }
            let slash = workbench.catalogs.cachedSlashCatalog(for: session)
            if slash !== self.slash { self.slash = slash }
            if fullscreen { fullscreen = false }
        }
        .onChange(of: workbench.showsCanvas) { _, shows in
            if shows, fullscreen { fullscreen = false }
        }
        .onChange(of: feedbackScope) { _, _ in
            if nativeNoticeDetail != nil { nativeNoticeDetail = nil }
        }
        .onReceive(NotificationCenter.default.publisher(for: .riffetOpenSubagent)) { note in
            guard note.targets(workbench), let id = note.userInfo?["id"] as? String else { return }
            subagents = [SubagentTarget(id: id, title: note.userInfo?["title"] as? String ?? String(localized: "子 Agent"))]
        }
        .onReceive(NotificationCenter.default.publisher(for: .riffetOpenVisualization)) { note in
            guard note.targets(workbench), let path = note.userInfo?["path"] as? String else { return }
            visualization = VisualizationTarget(path: path, title: note.userInfo?["title"] as? String ?? path, wide: note.userInfo?["wide"] as? Bool ?? false)
        }
        .sheet(item: $visualization) { target in
            let size = VisualizationPresentation.sheetSize(wide: target.wide, visibleFrame: NSScreen.main?.visibleFrame)
            VisualizationSheet(path: target.path, title: target.title, projectId: session.projectId)
                .frame(width: size.width, height: size.height)
        }
        .sheet(isPresented: Binding(get: { !subagents.isEmpty }, set: { if !$0 { subagents = [] } })) {
            SubagentSheet(workbench: workbench, session: session, stack: $subagents)
        }
    }

    // MARK: Chat

    private func chat(_ state: ConversationState) -> some View {
        let shownBanner = banner(state)
        let missingBar = providerMissing && session.archivedAt == nil && session.handedOffTo == nil
        let notices = readingNotices(state)
        let status = catalogStatus
        let layout = ChatLayout(
            banner: shownBanner, providerMissing: missingBar,
            unknownAttention: state.unknownAttention, catalogStatus: status, notices: notices
        )
        // The column is the style's right-hand recipe; whether it fits is decided by width alone.
        let asideAllowed = DisplayPreferences.shared.style.rightPanel == .outline && DisplayPreferences.shared.sessionOverview && !quickChat && !fullscreen && !workbench.showsCanvas
        let asideShown = asideAllowed && asideFits
        return ChatMotion(workbench: workbench, composer: composer, sessionId: session.id, layout: layout) {
            VStack(spacing: 0) {
                if !fullscreen {
                    // The reading column arrives as one piece once the conversation has assembled.
                    VStack(spacing: 0) {
                        SessionOriginBar(workbench: workbench, session: session)
                            .frame(maxWidth: Column.width)
                            .padding(.horizontal, Column.gutter)
                            .frame(maxWidth: .infinity)
                        // Persistent notices take their room from the transcript (it keeps the rows being read in place).
                        persistentNoticeBars(notices)
                            .frame(maxWidth: Column.width)
                            .padding(.horizontal, Column.gutter)
                            .frame(maxWidth: .infinity)
                        if workbench.showsCanvas {
                            CanvasPage(workbench: workbench, session: session, composer: session.terminalHold != nil ? AnyView(TerminalHoldBar(workbench: workbench, session: session)) : AnyView(composerView(state, fullscreen: nil)), showTranscript: { workbench.showsCanvasPage = false })
                        } else {
                        // One list per conversation: another one's rows, scroll offset and row sizes never carry over.
                        TranscriptView(workbench: workbench, session: session, railHidden: asideShown, link: asideLink, restoreInput: { run in
                            let composer = composer
                            Task {
                                if let draft = await workbench.takeBack(run) { composer.restore(draft, merging: true) }
                            }
                        })
                            .id(session.id)
                            .environment(\.openSubagent) { id, title in subagents = [SubagentTarget(id: id, title: title)] }
                            .environment(\.quoteMessage) { text in composer.quote(text) }
                            .overlay(alignment: .topTrailing) {
                                if workbench.find?.open == true {
                                    FindBar(workbench: workbench)
                                        .padding(.top, Space.xs)
                                        .padding(.trailing, Space.md)
                                        .transition(.opacity)
                                }
                            }
                            // The dismissible one floats: it comes and goes without moving the transcript.
                            .overlay(alignment: .top) {
                                VStack(spacing: Space.xs) {
                                    nativeNoticeBars(notices)
                                    bookmarkNoticeBar(notices)
                                }
                                    .frame(maxWidth: Column.width)
                                    .padding(.horizontal, Column.gutter)
                                    .padding(.top, Space.xs)
                                    .frame(maxWidth: .infinity)
                            }
                        }
                    }
                    .modifier(AssemblyEntrance(workbench: workbench, sessionId: session.id))
                }
                VStack(spacing: Space.sm) {
                    if !fullscreen {
                        // What a conversation opens with joins its transcript's entrance.
                        Group {
                            bannerBar(shownBanner, state: state)
                            FeedbackRegion(value: missingBar ? true : nil, active: feedbackActive) { _, live in
                                NoticeBar(tone: live ? .warning : .neutral, symbol: "exclamationmark.triangle", text: String(localized: "提供商已移除，无法继续发送")) {
                                    if live {
                                        Button("交接会话…") {
                                            guard providerMissing else { return }
                                            orchestrator.handoff()
                                        }.buttonStyle(ChipButtonStyle())
                                    }
                                }
                                .transition(ComposerMotion.insert)
                            }
                            .id("\(feedbackScope)|provider-missing")
                            if let interaction = workbench.interaction {
                                InteractionCardView(workbench: workbench, interaction: interaction, openTerminal: state.supportsTerminal ? { openDrawer() } : nil)
                                    .id(interaction.id)
                                    .transition(ComposerMotion.insert)
                            }
                            FeedbackRegion(value: state.unknownAttention && state.supportsTerminal ? String(localized: "\(state.label) 正在等待操作。\(String(localized: "请打开终端继续。"))") : nil, active: feedbackActive) { text, live in
                                NoticeBar(tone: live ? .warning : .neutral, symbol: "sparkles", text: text) {
                                    if live && state.supportsTerminal {
                                        Button("打开终端") {
                                            guard self.state.unknownAttention else { return }
                                            openDrawer()
                                        }.buttonStyle(ChipButtonStyle())
                                    }
                                }
                                .transition(ComposerMotion.insert)
                            }
                            .id("\(feedbackScope)|attention")
                        }
                        .modifier(AssemblyEntrance(workbench: workbench, sessionId: session.id))
                    }
                    ComposerDocks(workbench: workbench, composer: composer, sessionId: session.id, supportsSteer: catalog?.capabilities.supportsSteer == true, supportsTargetedStop: catalog?.capabilities.supportsTargetedStop?.boolValue == true, recoveryOnly: fullscreen, planInAside: asideShown)
                    FeedbackRegion(value: workbench.configurationError ?? workbench.recoveryError?.text, active: feedbackActive) { error, live in
                        HStack {
                            Text(error).font(.riffet(size: S(12))).foregroundStyle(live ? palette.danger : palette.fg3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .transition(ComposerMotion.insert)
                    }
                    .id("\(feedbackScope)|configuration")
                    .modifier(AssemblyEntrance(workbench: workbench, sessionId: session.id))
                    // The canvas hosts the composer itself, over its next-question slot.
                    if !workbench.showsCanvas {
                        if session.terminalHold != nil {
                            TerminalHoldBar(workbench: workbench, session: session)
                                .onAppear { fullscreen = false }
                        } else {
                            composerView(state, fullscreen: $fullscreen)
                                .frame(maxHeight: fullscreen ? .infinity : nil)
                        }
                        if !fullscreen { catalogStatusLine(status) }
                    }
                }
                .frame(maxWidth: Column.width, maxHeight: fullscreen ? .infinity : nil)
                .padding(.horizontal, Column.gutter)
                .padding(.bottom, Space.lg + 2)
                .padding(.top, fullscreen ? Space.lg : Space.xs)
                .frame(maxWidth: .infinity)
                // Over the canvas what is left (a permission card, a notice) floats on the plane rather than taking a strip from it.
                .frame(height: workbench.showsCanvas ? 0 : nil, alignment: .bottom)
            }
            .frame(maxWidth: .infinity)
            .modifier(SessionAsideHost(
                workbench: workbench, session: session, link: asideLink, allowed: asideAllowed,
                needed: Column.width + Column.gutter * 2 + SessionAside.width, fits: $asideFits
            ))
        }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: Radius.floating)
                    .strokeBorder(palette.accent, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                    .background(palette.accentSoft.opacity(0.4), in: RoundedRectangle(cornerRadius: Radius.floating))
                    .overlay(Label("松开以添加附件", icon: "paperclip").font(.headline).foregroundStyle(palette.accent))
                    .padding(12)
                    .allowsHitTesting(false)
            }
        }
        .onDrop(of: [.fileURL, .image], isTargeted: $dropTargeted) { providers in
            composer.accept(providers: providers, upload: { try await workbench.upload($0, projectId: session.projectId) })
            return true
        }
    }

    private func composerView(_ state: ConversationState, fullscreen: Binding<Bool>?) -> some View {
        ComposerView(
            model: composer,
            placeholder: session.archivedAt != nil ? String(localized: "会话已归档") : quickChat ? String(localized: "发送消息…") : providerMissing ? String(localized: "提供商已移除，无法继续发送") : defaultSendSteers ? String(localized: "补充当前任务…") : workbench.working ? String(localized: "输入下一条消息…") : String(localized: "给 \(state.label) 发消息"),
            working: workbench.working,
            // Background tasks live in the toolbar; the composer still offers the global stop action.
            background: workbench.backgroundSubagents,
            sendState: workbench.sendState,
            features: features(state),
            sendEnabled: catalog?.capabilities.requiresLiveTerminal?.boolValue != true || state.live,
            fullscreen: fullscreen,
            onSend: { interrupt in
                let shown = interrupt ? workbench.stopSnapshot(sessionID: session.id) : nil
                guard !interrupt || shown != nil else { return }
                Task { await send(interrupt: interrupt, state: state, stopSnapshot: shown) }
            },
            onStop: state.canStop || workbench.sendState.interrupting ? { workbench.interrupt(sessionID: session.id) } : nil,
            upload: { file in try await workbench.upload(file, projectId: session.projectId) }
        ) {
            if !quickChat {
                SessionControls(workbench: workbench, session: session, catalog: catalog)
            }
        } trailing: {
            SessionModelControls(workbench: workbench, session: session, catalog: catalog, quickChat: quickChat, loading: catalogLoading && catalog?.models.isEmpty != false, refresh: { await loadCatalog(reload: true) })
        }
    }

    private func features(_ state: ConversationState) -> ComposerFeatures {
        ComposerFeatures(
            slash: slash,
            onSlashOpen: {
                let request = RequestContext { catalogKey }
                Task {
                    let loaded = await workbench.catalogs.slashCatalog(for: session, refresh: true)
                    guard request.isCurrent, isCurrentSession else { return }
                    slash = loaded
                }
            },
            unknownCommandHint: String(localized: "发送给 \(state.label)"),
            searchFiles: quickChat || workbench.isAssistantSession(session) ? nil : { query in (try? await workbench.host.api?.find(projectId: session.projectId, query: query)) ?? [] },
            references: quickChat ? [] : workbench.references(for: session.projectId),
            addReference: quickChat ? nil : { workbench.addReference(path: $0) },
            removeReference: quickChat ? nil : { workbench.removeReference($0) },
            sessionCandidates: catalog?.capabilities.supportsSessionReferences == true ? workbench.list.sessions : [],
            sessionProjects: workbench.list.projects,
            currentSessionId: session.id,
            projectId: session.projectId,
            addSessionReference: catalog?.capabilities.supportsSessionReferences == true ? { workbench.addSessionReference($0) } : nil,
            openSessionReference: { workbench.open(sessionId: $0) },
            enterSends: workbench.settings?.composerEnterBehavior != "newline",
            steersWhileRunning: quickChat ? false : defaultSendSteers,
            enqueue: defaultSendSteers ? { Task { await send(interrupt: false, state: state, enqueue: true) } } : nil,
            sendLater: quickChat || workbench.settings?.composerSendLater?.boolValue != true ? nil : { date in Task { await sendLater(date) } }
        )
    }

    // MARK: Banners

    /// The one banner above the composer, if any; its value keys the column's motion.
    fileprivate enum Banner: Equatable {
        case connection(conflict: Bool, detail: String?)
        case sessionError(String)
    }

    private func banner(_ state: ConversationState) -> Banner? {
        if !state.archived, state.connectionNotice == .failed || state.connectionNotice == .conflict {
            return .connection(conflict: state.connectionNotice == .conflict, detail: workbench.status?.connection?.message)
        }
        if !quickChat, !state.archived, !state.live, !state.starting, let error = session.error {
            return .sessionError(error)
        }
        return nil
    }

    private func bannerBar(_ banner: Banner?, state: ConversationState) -> some View {
        FeedbackRegion(value: banner, active: feedbackActive, holding: nativeNoticeDetail != nil) { held, live in
            switch held {
            case let .connection(conflict, detail):
                // The backend's reason is an untranslated diagnostic: the bar says what happened, the reason is one click away.
                NoticeBar(tone: live ? .warning : .neutral, symbol: "wifi.exclamationmark", text: conflict ? String(localized: "另一个连接可能正在使用此会话，Riffet 暂时无法接入。已有历史仍可查看。") : String(localized: "Riffet 暂时无法连接此会话。已有历史仍可查看。"), textLineLimit: 3) {
                    if let detail { Button("查看详情") { nativeNoticeDetail = detail }.buttonStyle(ChipButtonStyle()) }
                    if live {
                        Button {
                            guard self.banner(self.state) == held else { return }
                            workbench.store.retry()
                        } label: { Label("重试连接", icon: "arrow.clockwise") }.buttonStyle(ChipButtonStyle())
                    } else {
                        feedbackEnding(recovered: workbench.status?.connection?.state == "connected")
                    }
                }
                .transition(ComposerMotion.insert)
            case let .sessionError(error):
                NoticeBar(tone: live ? .danger : .neutral, symbol: "exclamationmark.circle", text: error, textLineLimit: 3, onTextDetails: { nativeNoticeDetail = error }) {
                    if live {
                        Button {
                            guard self.banner(self.state) == held else { return }
                            Task { _ = await workbench.reopen(session) }
                        } label: { Label("恢复会话", icon: "arrow.clockwise") }
                            .buttonStyle(ChipButtonStyle())
                            .disabled(workbench.reopening || (session.model != nil && catalog == nil))
                    } else {
                        feedbackEnding(recovered: state.live && !state.starting && !state.syncing)
                    }
                }
                .transition(ComposerMotion.insert)
            }
        }
        .id("\(feedbackScope)|banner")
    }

    @ViewBuilder
    private func feedbackEnding(recovered: Bool = false) -> some View {
        if recovered {
            Text("已恢复").font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
        }
    }

    /// The notices about reading this conversation, in order: the history warning, a non-info native
    /// notice, the bookmark notice.
    fileprivate struct ReadingNotices: Equatable {
        var history: String?
        var native: String?
        var nativeError = false
        var bookmark: String?
    }

    private func readingNotices(_ state: ConversationState) -> ReadingNotices {
        var notices = ReadingNotices(history: state.historyWarning)
        if let notice = state.notice, state.noticeLevel != "info" {
            notices.native = notice
            notices.nativeError = state.noticeLevel == "error"
        }
        if let notice = workbench.notice, notice.sessionId == session.id { notices.bookmark = notice.text }
        return notices
    }

    /// A persistent history failure stays beside its reader; raw backend notices float so a
    /// short-lived status cannot shrink and grow the transcript's viewport.
    private func persistentNoticeBars(_ notices: ReadingNotices) -> some View {
        FeedbackRegion(value: notices.history, active: feedbackActive, holding: nativeNoticeDetail != nil) { warning, live in
            NoticeBar(tone: live ? .warning : .neutral, symbol: "exclamationmark.triangle", text: warning, textLineLimit: 3, onTextDetails: { nativeNoticeDetail = warning }) {
                if live {
                    Button {
                        guard self.state.historyWarning == warning else { return }
                        workbench.store.retry()
                    } label: { Label("重试", icon: "arrow.clockwise") }.buttonStyle(ChipButtonStyle())
                } else {
                    feedbackEnding(recovered: workbench.status?.history?.state == "ready")
                }
            }
            .padding(.top, Space.xs)
            .transition(AnyTransition.opacity.combined(with: .offset(y: -8)))
        }
        .id("\(feedbackScope)|history")
    }

    private struct NativeNotice: Equatable {
        let text: String
        let error: Bool
    }

    private func nativeNoticeBars(_ notices: ReadingNotices) -> some View {
        let value = notices.native.map { NativeNotice(text: $0, error: notices.nativeError) }
        return FeedbackRegion(value: value, active: feedbackActive, holding: nativeNoticeDetail != nil) { notice, live in
            FloatingSessionNotice(text: notice.text, error: notice.error, live: live) { nativeNoticeDetail = notice.text }
            .transition(AnyTransition.opacity.combined(with: .offset(y: -8)))
        }
        .id("\(feedbackScope)|native-notice")

    }

    /// The bookmark notice, floating over the top of the transcript so it takes no room from it.
    @ViewBuilder
    private func bookmarkNoticeBar(_ notices: ReadingNotices) -> some View {
        if let text = notices.bookmark {
            NoticeBar(tone: .neutral, symbol: "bookmark", text: text, floating: true) {
                Button { workbench.notice = nil } label: { Image(icon: "xmark") }
                    .buttonStyle(IconButtonStyle(size: 20)).help("关闭")
            }
            .transition(AnyTransition.opacity.combined(with: .offset(y: -8)))
        }
    }

    fileprivate enum CatalogStatus: Equatable {
        case failed(String)
        case empty
    }

    private var catalogStatus: CatalogStatus? {
        if let catalogError, !providerMissing { return .failed(catalogError) }
        if let catalog, catalog.capabilities.supportsModelSelection, catalog.models.isEmpty { return .empty }
        return nil
    }

    private func catalogStatusLine(_ status: CatalogStatus?) -> some View {
        FeedbackRegion(value: status, active: feedbackActive) { held, live in
            switch held {
            case let .failed(catalogError):
                HStack(spacing: 6) {
                    Text("模型列表加载失败：\(catalogError)")
                        .foregroundStyle(!live || catalog?.models.isEmpty == false ? palette.fg3 : palette.danger)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    if live, !catalogLoading {
                        Button("重试") {
                            guard catalogStatus == held else { return }
                            Task { await loadCatalog(reload: true) }
                        }.buttonStyle(ChipButtonStyle())
                    }
                    Spacer()
                }
                .font(.riffet(size: S(12)))
                .transition(ComposerMotion.insert)
            case .empty:
                HStack(spacing: 6) {
                    Text("没有可用模型").foregroundStyle(palette.fg3)
                    if live, !catalogLoading {
                        Button("重试") {
                            guard catalogStatus == held else { return }
                            Task { await loadCatalog(reload: true) }
                        }.buttonStyle(ChipButtonStyle())
                    }
                    Spacer()
                }
                .font(.riffet(size: S(12)))
                .transition(ComposerMotion.insert)
            }
        }
        .id("\(feedbackScope)|catalog")
    }

    // MARK: Terminal

    @ViewBuilder
    private func terminalPage(_ state: ConversationState) -> some View {
        if state.live, let terminalId = session.terminalId {
            TerminalSurface(workbench: workbench, terminalId: terminalId, accessory: {
                Button { workbench.showsTerminalPage = false } label: { Label("对话", icon: "bubble.left.and.text.bubble.right") }
                    .buttonStyle(ChipButtonStyle())
                    .help("切换对话视图")
            })
            .id(terminalId)
        } else if !state.statusKnown, state.connectionNotice != .failed, !state.archived {
            // The session's status has not arrived: do not call it "not running" yet.
            terminalConnecting(state)
        } else {
            ContentUnavailableView {
                Label("终端未在运行", icon: "terminal")
            } description: {
                if let error = workbench.recoveryError?.text {
                    Text(error).foregroundStyle(palette.danger).textSelection(.enabled)
                }
            } actions: {
                Button {
                    Task { _ = await workbench.reopen(session) }
                } label: { Label("重新打开", icon: "terminal") }
                .buttonStyle(SolidButtonStyle(kind: .primary))
                .disabled(workbench.reopening || state.archived)
                Button("返回对话") { workbench.showsTerminalPage = false }.buttonStyle(SolidButtonStyle(kind: .secondary))
            }
        }
    }

    private func terminalConnecting(_ state: ConversationState) -> some View {
        VStack(spacing: Space.md) {
            Spinner(size: .small)
            Text("正在连接终端…").font(.riffet(size: S(13))).foregroundStyle(palette.fg3)
            Button("返回对话") { workbench.showsTerminalPage = false }.buttonStyle(ChipButtonStyle())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func openDrawer() {
        workbench.terminalDock.showAgentTerminal(session)
    }

    /// An interaction the card cannot render opens the terminal after a moment, once per
    /// conversation; it closes again when the attention clears (`NativeSession.tsx`).
    private func autoOpen(_ attention: Bool, state: ConversationState) {
        autoOpenTask?.cancel()
        guard attention, state.supportsTerminal else {
            if workbench.terminalDock.automatic { workbench.terminalDock.hide() }
            return
        }
        // Under the home page or a page the dock cannot open; it is tried again on the way back.
        guard !autoOpenSpent, !covered, !workbench.sendState.interrupting else { return }
        autoOpenTask = Task {
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            autoOpenSpent = true
            workbench.terminalDock.showAgentTerminal(session, automatically: true)
        }
    }

    // MARK: Actions

    private func loadCatalog(reload: Bool) async {
        guard !Task.isCancelled else { return }
        let request = RequestContext { catalogKey }
        // A catalog already on screen is refreshed quietly; only a missing one shows as loading.
        let shows = reload || catalog == nil
        if shows != catalogLoading { catalogLoading = shows }
        // Only the load for the current context owns its loading and error state.
        defer {
            if shows, request.isCurrent, isCurrentSession, catalogLoading { catalogLoading = false }
        }
        do {
            _ = try await workbench.catalogs.loadCatalog(session.agentID, profileId: session.backendProfileId, projectId: session.projectId, reload: reload)
            await workbench.catalogs.loadSessionCatalog(for: session)
            guard request.isCurrent, isCurrentSession else { return }
            catalogError = nil
        } catch {
            guard request.isCurrent, isCurrentSession else { return }
            catalogError = error.riffetMessage
        }
    }

    /// Schedules the draft as a later turn of this conversation; the draft is cleared once the server has it.
    private func sendLater(_ date: Date) async {
        let composer = composer
        guard composer.canSend, !composer.schedulingLater else { return }
        composer.schedulingLater = true
        defer { composer.schedulingLater = false }
        let submission = composer.submission()
        do {
            try await workbench.sendLater(submission.text, attachments: submission.attachments, at: date, id: UUID().uuidString)
            composer.clear(sent: submission)
            composer.flushDraft()
            workbench.pageModels.tasks.reload()
        } catch {
            composer.notice = String(localized: "无法安排稍后发送：\(error.riffetMessage)")
        }
    }

    private func send(interrupt: Bool, state: ConversationState, enqueue: Bool = false, stopSnapshot: OpenSessionState? = nil) async {
        // This conversation's composer, even if the page has moved on by the time the send returns.
        let composer = composer
        guard composer.canSend, !providerMissing, catalog?.capabilities.requiresLiveTerminal?.boolValue != true || state.live else { return }
        let submission = composer.submission()
        let text = submission.text
        // Before the message lands: once it does, the latest turn is the one being sent.
        TranscriptController.followSent(in: session.id)
        if await workbench.send(text, attachments: submission.attachments, interrupt: interrupt, enqueue: enqueue, stopSnapshot: stopSnapshot, onStored: {
            composer.clear(sent: submission)
            composer.flushDraft()
        }) {
            // The source draft was transferred to the Outbox before the network request.
            // As the fullscreen button leaves it.
            if fullscreen && composer.text.isEmpty && composer.items.isEmpty { withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) { fullscreen = false } }
            if let command = text.trimmingCharacters(in: .whitespaces).firstMatch(of: /^\/(\S+)/)?.1 {
                let name = String(command)
                let skill = slash?.items.contains { $0.name == name && $0.isSkill } == true
                // `/compact` is shown in the transcript as a system activity; the terminal has nothing more to say.
                if !skill, name != "compact", state.backend == "claude" || PluginAgentRegistry.renderer(for: state.backend, plugins: PluginsStore.shared.items)?.commandNeedsTerminal?(name) == true {
                    openDrawer()
                }
            }
        }
    }
}

/// What the open conversation's status means for the page: the flags and the header badge are
/// `:client`'s `conversationStatus` (the rules of `NativeSession.tsx`); the notices are this page's.
@MainActor
struct ConversationState {
    let backend: String
    let label: String
    let supportsTerminal: Bool
    let status: ConversationStatus
    let canStop: Bool
    let notice: String?
    let noticeLevel: String?
    let historyWarning: String?

    var live: Bool { status.live }
    var statusKnown: Bool { status.statusKnown }
    var starting: Bool { status.starting }
    var syncing: Bool { status.syncing }
    var archived: Bool { status.archived }
    var recognizedInteraction: Bool { status.recognizedInteraction }
    var unknownAttention: Bool { status.unknownAttention }
    var connectionNotice: ConnectionNotice? { status.connectionNotice }
    var needsResume: Bool { statusKnown && !live && !archived && !starting && !syncing && connectionNotice == nil }
    /// The header's status badge (`NativeSession.tsx`'s `status` slot).
    var badge: SessionBadge? { status.badge }

    init(workbench: Workbench, session: Session, catalog: NativeBackendCatalogEntry?) {
        backend = session.agentID
        label = catalog?.label ?? backendLabel(backend)
        let capabilities = catalog?.capabilities
        // Until the catalog arrives, a conversation that already has a terminal has one.
        supportsTerminal = capabilities.map { $0.supportsTerminal?.boolValue ?? ($0.interactionTransport == .terminal || $0.interactionTransport == .both) } ?? (session.terminalId != nil)
        let native = workbench.status
        let status = conversationStatus(
            session: session, status: native, connection: workbench.connection, runs: workbench.runs,
            interaction: workbench.interaction, reopening: workbench.reopening, supportsTerminal: supportsTerminal,
            requiresLiveTerminal: capabilities?.requiresLiveTerminal?.boolValue == true
        )
        self.status = status
        if let control = workbench.control {
            canStop = !status.archived && status.live && control.activeTurn?.canStop == true
        } else {
            canStop = !status.archived && status.live && (capabilities?.supportsInterrupt == true && capabilities?.supportsTargetedStop?.boolValue == true) && !status.starting
        }
        var historyWarning: String?
        if native?.history?.state == "error" {
            historyWarning = native?.history?.message ?? String(localized: "历史同步失败")
        } else if native?.history == nil, native?.transcript == "unparsed" {
            historyWarning = String(localized: "无法解析 \(label) 的会话存储，请查看后端版本与诊断信息。")
        }
        // A new thread may already have its native id while its first record has not been written.
        // Only an explicit history failure establishes missing history; unavailable alone does not.
        let showsConnection = !status.archived && (status.connectionNotice == .failed || status.connectionNotice == .conflict)
        if showsConnection, historyWarning == native?.connection?.message { historyWarning = nil }
        self.historyWarning = historyWarning
        // Only suppress a reason when the current page actually shows it in full elsewhere.
        let showsFailure = !status.archived && !status.live && !status.starting && status.connectionNotice != .failed && status.connectionNotice != .conflict
        if let notice = native?.notice, !notice.isEmpty,
           (!showsFailure || notice != session.error),
           (!showsConnection || notice != native?.connection?.message),
           notice != historyWarning {
            self.notice = notice
        } else { self.notice = nil }
        noticeLevel = native?.noticeLevel
    }
}

/// What the conversation page shows around the transcript, as far as it changes the column's height
/// (the bookmark notice only floats, but animates the same way).
private struct ChatLayout: Equatable {
    let banner: ConversationView.Banner?
    let providerMissing: Bool
    let unknownAttention: Bool
    let catalogStatus: ConversationView.CatalogStatus?
    let notices: ConversationView.ReadingNotices
}

/// Animates every change in what sits under the transcript (cards, docks, errors, the composer's
/// attachment and status rows) together with the transcript, which gives way to it instead of jumping
/// by its height. It reads the docks and the draft's attachments itself, so their changes re-render
/// only this. A switch to another conversation is not animated: the page just shows the other one.
private struct ChatMotion<Content: View>: View {
    let workbench: Workbench
    let composer: ComposerModel
    let sessionId: String
    let layout: ChatLayout
    @ViewBuilder let content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The conversation whose changes animate: one that has assembled, from the update after it did,
    /// so nothing that lands with its arrival (a notice, a card, the docks) moves on its own.
    @State private var settledSession: String?

    private struct Key: Equatable {
        let layout: ChatLayout
        let interaction: String?
        let goal: Bool
        let todos: Bool
        let uncertain: [String]
        let queued: [String]
        let error: String?
        let attachments: [UUID]
        let references: [String]
        let status: String?
        let uploading: Bool
    }

    var body: some View {
        let key = Key(
            layout: layout,
            interaction: workbench.interaction?.id,
            goal: workbench.goal != nil,
            todos: !workbench.todos.isEmpty,
            uncertain: workbench.uncertain.map(\.id),
            queued: workbench.queued.map(\.id),
            error: workbench.configurationError ?? workbench.recoveryError?.text,
            attachments: composer.items.map(\.id),
            references: workbench.references.map { $0.sessionId ?? $0.path },
            status: workbench.sendState.error ?? composer.notice,
            uploading: composer.uploading
        )
        let assembled = workbench.assembledSession == sessionId
        content
            .animation(reduceMotion || !assembled || settledSession != sessionId ? nil : ComposerMotion.resize, value: key)
            .onAppear { if assembled { settledSession = sessionId } }
            .onChange(of: assembled) { _, assembled in if assembled { settledSession = sessionId } }
    }
}

/// A switch shows the new conversation's transcript and its notices together, faded in once, when it
/// has assembled (`Workbench.assembledSession`), rather than each part popping in as it arrives.
/// Only the opacity animates, in the update after: what lands with the arrival keeps its place.
private struct AssemblyEntrance: ViewModifier {
    let workbench: Workbench
    let sessionId: String
    @State private var shownSession: String?
    @State private var presentedSession: String?

    func body(content: Content) -> some View {
        let assembled = workbench.assembledSession == sessionId
        content
            .environment(\.feedbackPresented, presentedSession == sessionId)
            .opacity(shownSession == sessionId ? 1 : 0)
            .onAppear { if assembled { show() } }
            .onChange(of: assembled) { _, assembled in if assembled { show() } }
    }

    private func show() {
        let target = sessionId
        withAnimation(.easeOut(duration: 0.18), completionCriteria: .logicallyComplete) {
            shownSession = target
        } completion: {
            guard shownSession == target else { return }
            presentedSession = target
        }
    }
}

/// Persistent problems use a surface; informational context stays a compact line near its owner.
struct NoticeBar<Actions: View>: View {
    enum Tone: Equatable { case neutral, warning, danger }

    let tone: Tone
    let symbol: String
    let text: String
    /// Over other content (the transcript): an opaque surface of its own, as the docks have.
    var floating = false
    var textLineLimit: Int?
    var onTextTruncation: ((Bool) -> Void)?
    var onTextDetails: (() -> Void)?
    @ViewBuilder let actions: Actions
    @Environment(\.palette) private var palette
    @State private var fullTextHeight: CGFloat = 0
    @State private var visibleTextHeight: CGFloat = 0
    @State private var textTruncated = false

    var body: some View {
        let bare = tone == .neutral && !floating
        let raised = DisplayPreferences.shared.style.surface == .raised
        HStack(spacing: Space.sm + 2) {
            Image(icon: symbol).font(.riffet(size: S(12))).foregroundStyle(color)
            Text(text).font(.riffet(size: S(13))).foregroundStyle(palette.fg2)
                .lineLimit(textLineLimit)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                    guard onTextTruncation != nil || onTextDetails != nil else { return }
                    visibleTextHeight = height
                    if fullTextHeight > 0 {
                        textTruncated = fullTextHeight > height + 1
                        onTextTruncation?(textTruncated)
                    }
                }
                .background {
                    if onTextTruncation != nil || onTextDetails != nil {
                        Text(text).font(.riffet(size: S(13)))
                            .fixedSize(horizontal: false, vertical: true)
                            .hidden().accessibilityHidden(true)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                                fullTextHeight = height
                                if visibleTextHeight > 0 {
                                    textTruncated = height > visibleTextHeight + 1
                                    onTextTruncation?(textTruncated)
                                }
                            }
                    }
                }
            Spacer(minLength: Space.sm)
            if textTruncated, let onTextDetails {
                Button("查看详情", action: onTextDetails).buttonStyle(ChipButtonStyle())
            }
            actions
        }
        .padding(.horizontal, bare ? 0 : Space.md)
        .padding(.vertical, bare ? 2 : Space.sm)
        .frame(minHeight: bare ? 24 : 38)
        .background(background, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .background {
            if floating {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous).fill(palette.bgElevated)
                    .elevation(raised ? .raised : nil)
            }
        }
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(bare ? Color.clear : raised ? palette.line : palette.lineStrong, lineWidth: 1))
    }

    private var color: Color {
        switch tone {
        case .neutral: palette.fg3
        case .warning: palette.warning
        case .danger: palette.danger
        }
    }

    private var background: Color {
        switch tone {
        case .neutral: .clear
        case .warning: palette.warningSoft.opacity(0.5)
        case .danger: palette.dangerSoft.opacity(0.5)
        }
    }
}

private struct FloatingSessionNotice: View {
    let text: String
    let error: Bool
    let live: Bool
    let openDetails: () -> Void
    @State private var truncated = false
    @Environment(\.palette) private var palette

    var body: some View {
        NoticeBar(tone: live ? (error ? .danger : .warning) : .neutral,
                  symbol: error ? "exclamationmark.circle" : "exclamationmark.triangle", text: text,
                  floating: true, textLineLimit: 3, onTextTruncation: { truncated = $0 }) {
            if truncated { Button("查看详情", action: openDetails).buttonStyle(ChipButtonStyle()) }
        }
    }
}

struct VisualizationTarget: Identifiable {
    let id = UUID()
    let path: String
    let title: String
    let wide: Bool
}

struct SubagentTarget: Identifiable {
    let id: String
    let title: String
}

/// What floats above the input: the goal, the todo list and queued messages.
struct ComposerDocks: View {
    let workbench: Workbench
    let composer: ComposerModel
    let sessionId: String
    var supportsSteer = false
    var supportsTargetedStop = false
    var recoveryOnly = false
    /// The overview column shows the goal and the todos, so they are not here as well.
    var planInAside = false
    private var canSteer: Bool {
        if let control = workbench.control {
            return workbench.connection is RiffetConnectionStateLive && control.activeTurn?.canSteer == true && workbench.uncertain.isEmpty && !workbench.sendState.sending && !workbench.sendState.interrupting
        }
        return workbench.connection is RiffetConnectionStateLive && workbench.status?.phase == .busy && workbench.interaction == nil && workbench.uncertain.isEmpty && !workbench.sendState.sending && !workbench.sendState.interrupting
    }
    private func allows(_ action: String, on run: Run) -> Bool {
        guard let control = workbench.control else { return false }
        return SessionStoreStateKt.allowsQueuedAction(control: control, runId: run.id, commandId: run.commandId, action: action)
    }
    @Environment(\.palette) private var palette

    var body: some View {
        let tasks = workbench.pageModels.tasks
        VStack(spacing: 6) {
            if !recoveryOnly, !planInAside {
                if let goal = workbench.goal { GoalDockView(goal: goal).transition(ComposerMotion.insert) }
                if !workbench.todos.isEmpty { TodoDockView(entries: workbench.todos).transition(ComposerMotion.insert) }
            }
            ForEach(recoveryOnly ? [] : tasks.followUps(for: sessionId), id: \.id) { followUp in
                DockCard {
                    Image(icon: "clock").font(.riffet(size: S(12))).foregroundStyle(palette.fg4)
                    Text("\(formatDateTime(value: followUp.nextRunAt) ?? "") · \(TasksModel.name(of: followUp.prompt))")
                        .lineLimit(1).font(.riffet(size: S(13))).foregroundStyle(palette.fg2).monospacedDigit()
                    if followUp.input?.attachmentIds.isEmpty == false {
                        Image(icon: "paperclip").font(.riffet(size: S(12))).foregroundStyle(palette.fg4).layoutPriority(1)
                    }
                    Spacer(minLength: Space.sm)
                    Button { Task { await tasks.delete(followUp) } } label: { Image(icon: "xmark").font(.riffet(size: S(11), weight: .semibold)) }
                        .buttonStyle(IconButtonStyle(size: 26))
                        .help("取消")
                        .accessibilityLabel("取消")
                }
                .transition(ComposerMotion.insert)
            }
            ForEach(recoveryOnly ? [] : workbench.queued, id: \.id) { run in
                // A send still submitting has no run on the server to act on yet.
                let blocked = workbench.sendState.pendingRunIds.contains(run.id) || !SendPhaseKt.inQueue(run: run, control: workbench.control)
                let governed = workbench.control != nil
                let target = SessionStoreStateKt.steerTarget(control: workbench.control, status: workbench.status)
                let showSteer = governed ? allows("steer", on: run) : (supportsSteer && workbench.status?.activeTurn != nil)
                let showSendNow = governed ? allows("send_now", on: run) && workbench.control?.activeTurn?.canStop == true : supportsTargetedStop
                let showEdit = !governed || allows("edit", on: run)
                let showCancel = !governed || allows("cancel", on: run)
                DockCard {
                    Image(icon: "clock").font(.riffet(size: S(12))).foregroundStyle(palette.fg4)
                    Text(run.prompt).lineLimit(1).font(.riffet(size: S(13))).foregroundStyle(palette.fg2)
                    Spacer(minLength: Space.sm)
                    HStack(spacing: 0) {
                        if showSteer {
                            Button {
                                guard let target else { return }
                                Task { _ = try? await workbench.store.steerQueued(run: run, target: target) }
                            } label: { Image(icon: "arrow.turn.up.right").font(.riffet(size: S(12), weight: .medium)) }
                                .buttonStyle(IconButtonStyle(size: 26))
                                .disabled(!canSteer || blocked)
                                .help("补充到当前任务").accessibilityLabel("补充到当前任务")
                        }
                        if showSendNow {
                        Button { workbench.sendQueuedNow(run) } label: { Image(icon: "arrow.up").font(.riffet(size: S(11), weight: .semibold)) }
                            .buttonStyle(IconButtonStyle(size: 26))
                            .disabled(blocked)
                            .help("停止并发送")
                        }
                        if showEdit {
                        Button {
                            Task { if let draft = await workbench.takeBack(run) { composer.restore(draft) } }
                        } label: { Image(icon: "pencil.line").font(.riffet(size: S(12))) }
                            .buttonStyle(IconButtonStyle(size: 26))
                            .help("移回输入框编辑")
                            .disabled(blocked)
                        }
                        if showCancel {
                        Button { Task { await workbench.cancelRun(run) } } label: { Image(icon: "trash").font(.riffet(size: S(11))) }
                            .buttonStyle(IconButtonStyle(size: 26))
                            .help("移出队列")
                            .disabled(blocked)
                        }
                    }
                    .fixedSize()
                }
                .transition(ComposerMotion.insert)
            }
        }
        .task(id: sessionId) {
            while !Task.isCancelled {
                await tasks.load()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }
}

struct DockCard<Content: View>: View {
    @ViewBuilder let content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) { content }
            .padding(.leading, Space.md)
            .padding(.trailing, Space.xs)
            .frame(minHeight: 34)
            .dockSurface(palette)
    }
}

extension View {
    /// The web's `dockSurface`: an elevated card with a strong hairline, so it stands off the
    /// transcript scrolling behind it.
    /// An outlined style (`StyleSpec.Surface.outlined`) draws it by a stronger hairline, no shadow.
    @MainActor
    func dockSurface(_ palette: Palette) -> some View {
        let raised = DisplayPreferences.shared.style.surface == .raised
        return background(palette.bgElevated, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(raised ? palette.line : palette.lineStrong, lineWidth: 1))
            .elevation(raised ? .raised : nil)
    }
}

struct GoalDockView: View {
    let goal: SessionGoal
    @Environment(\.palette) private var palette
    @State private var open = false

    var body: some View {
        let blocked = goal.status == "blocked"
        VStack(alignment: .leading, spacing: Space.xs) {
            Button { withAnimation(.snappy(duration: 0.18)) { open.toggle() } } label: {
                HStack(spacing: Space.sm) {
                    Image(icon: "target").font(.riffet(size: S(12))).foregroundStyle(blocked ? palette.warning : palette.fg3)
                    Text("目标").font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg2)
                    Text(goalStatusLabel(goal: goal)).font(.riffet(size: S(12))).foregroundStyle(blocked ? palette.warning : palette.fg4)
                    if !open { Text(goal.objective).font(.riffet(size: S(13))).foregroundStyle(palette.fg3).lineLimit(1) }
                    Spacer(minLength: 0)
                    Image(icon: "chevron.up").rotationEffect(.degrees(open ? 180 : 0)).font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
                }
                .frame(minHeight: 34)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                Text(goal.objective).font(.riffet(size: S(13))).foregroundStyle(palette.fg2).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if blocked, let reason = goal.reason, !reason.isEmpty {
                    Text(reason).font(.riffet(size: S(12))).foregroundStyle(palette.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, Space.md)
        .padding(.bottom, open ? Space.sm : 0)
        .dockSurface(palette)
    }
}

struct TodoDockView: View {
    let entries: [TodoEntry]
    @Environment(\.palette) private var palette
    @AppStorage("riffet.todo-open") private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Button { withAnimation(.snappy(duration: 0.18)) { open.toggle() } } label: {
                HStack(spacing: Space.sm) {
                    Image(icon: "checklist").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    Text("待办").font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg2)
                    Text(todoProgress(entries: entries)).font(.riffet(size: S(12))).foregroundStyle(palette.fg4)
                    if !open, let current = entries.first(where: { $0.status == .inProgress }) {
                        Text(current.content).font(.riffet(size: S(13))).foregroundStyle(palette.fg3).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(icon: "chevron.up").rotationEffect(.degrees(open ? 180 : 0)).font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
                }
                .frame(minHeight: 34)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                ScrollView {
                    PlanView(entries: entries).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 220)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, Space.sm)
            }
        }
        .padding(.horizontal, Space.md)
        .dockSurface(palette)
    }
}

/// The task identity reads together on the left; its live status and window action sit on the right.
struct SubagentHeader: View {
    let title: String
    let role: String?
    let model: String?
    var breadcrumb: String? = nil
    let status: String
    let statusColor: Color
    var running = false
    var goBack: (() -> Void)? = nil
    var confirmInMain: (() -> Void)? = nil
    let close: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.lg) {
            if let goBack {
                Button(action: goBack) { Image(icon: "chevron.left").font(.riffet(size: S(12), weight: .semibold)) }
                    .buttonStyle(IconButtonStyle())
                    .help("返回上一层")
            }
            VStack(alignment: .leading, spacing: 4) {
                if let breadcrumb {
                    Text(breadcrumb).font(.riffet(size: S(10))).foregroundStyle(palette.fg4)
                        .lineLimit(1).truncationMode(.head)
                }
                Text(title).font(.riffet(size: S(14), weight: .semibold)).foregroundStyle(palette.fg)
                    .lineLimit(1)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let role, role != title {
                        Text(role)
                        Text("·").foregroundStyle(palette.fg4)
                    }
                    if let model {
                        Text(model).font(.riffet(size: S(11), design: .monospaced))
                    } else {
                        Text("模型未提供")
                    }
                }
                .font(.riffet(size: S(11))).foregroundStyle(palette.fg3).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 5) {
                if running { Spinner(size: .mini) } else { Circle().fill(statusColor).frame(width: 5, height: 5) }
                Text(status).foregroundStyle(statusColor)
            }
            .font(.riffet(size: S(11)))
            .fixedSize()
            if let confirmInMain {
                Button("等待确认", action: confirmInMain)
                    .buttonStyle(ChipButtonStyle())
                    .help("返回主会话")
            }
            Button("完成", action: close).keyboardShortcut(.cancelAction)
                .buttonStyle(SolidButtonStyle(kind: .secondary))
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
    }
}

/// A subagent's own transcript, read-only, opened from its Task row. A subagent row inside it opens
/// that one on top (up to eight deep, like the web). Main-conversation confirmations stay in the
/// main conversation; the header offers a way back without displacing this transcript.
struct SubagentSheet: View {
    let workbench: Workbench
    let session: Session
    @Binding var stack: [SubagentTarget]
    @Environment(\.palette) private var palette
    @State private var subscriptions = FlowSubscriptions()
    @State private var pages = SubagentPages()
    @State private var loadingSubagent: String?
    @State private var subagentError: String?

    private var target: SubagentTarget? { stack.last }
    private var activePage: SubagentPresentation? { target.flatMap { pages.page($0.id) } }
    private var activeTitle: String { stack.isEmpty ? String(localized: "子 Agent") : title(for: stack.count - 1) }

    var body: some View {
        VStack(spacing: 0) {
            SubagentHeader(
                title: activeTitle,
                role: activePage?.info?.type ?? activePage?.transcript?.subagentType,
                model: activePage?.info?.model,
                breadcrumb: stack.count > 1 ? stack.indices.dropLast().map { title(for: $0) }.joined(separator: " › ") : nil,
                status: statusLabel,
                statusColor: statusColor,
                running: activePage?.loaded == true && activePage?.running == true,
                goBack: stack.count > 1 ? { stack.removeLast() } : nil,
                confirmInMain: workbench.interaction != nil ? { stack = [] } : nil,
                close: { stack = [] }
            )
            Divider()
            if let target, let page = activePage, page.loaded {
                if page.hasBefore {
                    HStack {
                        Spacer()
                        olderRecordButton(toolCallId: target.id)
                        Spacer()
                    }
                    .padding(.vertical, Space.sm)
                }
                SubagentTranscriptPane(
                    workbench: workbench,
                    pages: pages,
                    toolCallId: target.id,
                    projectId: session.projectId,
                    running: page.running,
                    openNested: { id, title in openNested(id: id, title: title) }
                )
                .id(target.id)
            } else if let target, let error = activePage?.error {
                // The lane's stream failed before anything arrived: say so instead of spinning for good.
                VStack(spacing: Space.sm) {
                    Image(icon: "exclamationmark.triangle").font(.riffet(size: 22)).foregroundStyle(palette.fg4)
                    Text("无法加载子 Agent 执行记录").font(.riffet(size: S(13))).foregroundStyle(palette.fg3)
                    Text(error).font(.riffet(size: S(12))).foregroundStyle(palette.fg4).lineLimit(3).multilineTextAlignment(.center)
                    Button("重试") { pages.reopen(target.id, stack: stack.map(\.id), presenter: workbench.presenter) }
                        .buttonStyle(ChipButtonStyle())
                }
                .padding(.horizontal, Space.lg)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: Space.sm) {
                    Spinner(size: .mini)
                    Text("正在同步子 Agent 执行记录…").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 760, idealWidth: 860, minHeight: 600, idealHeight: 720)
        .background(palette.bg)
        .overlay { ImageViewerOverlay() }
        .environment(\.conversationProjectId, session.projectId)
        .onAppear {
            subscriptions.observe(workbench.store.loadingSubagent) { loadingSubagent = $0 }
            subscriptions.observe(workbench.store.subagentError) { subagentError = $0 }
            pages.follow(stack.map(\.id), presenter: workbench.presenter)
        }
        .onChange(of: stack.map(\.id)) { _, ids in pages.follow(ids, presenter: workbench.presenter) }
        .onChange(of: target?.id) { _, _ in workbench.store.clearSubagentError() }
        .onDisappear {
            subscriptions.cancelAll()
            pages.follow([], presenter: nil)
        }
    }

    private func title(for level: Int) -> String {
        guard stack.indices.contains(level) else { return String(localized: "子 Agent") }
        let target = stack[level]
        return pages.page(target.id)?.info?.title ?? target.title
    }

    @ViewBuilder
    private func olderRecordButton(toolCallId: String) -> some View {
        if loadingSubagent == toolCallId {
            HStack(spacing: Space.xs) {
                Spinner(size: .mini)
                Text("加载更早的执行记录…")
            }
            .font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
        } else if let subagentError {
            HStack(spacing: Space.sm) {
                Text("加载失败").font(.riffet(size: S(12))).foregroundStyle(palette.fg3).help(subagentError)
                Button("重试") {
                    workbench.store.clearSubagentError()
                    workbench.store.loadOlderSubagent(toolCallId: toolCallId)
                }
                .buttonStyle(ChipButtonStyle())
            }
        } else {
            Button("加载更早的执行记录") { workbench.store.loadOlderSubagent(toolCallId: toolCallId) }
                .buttonStyle(ChipButtonStyle())
        }
    }

    private func openNested(id: String, title: String) {
        if stack.last?.id != id { stack = Array((stack + [SubagentTarget(id: id, title: title)]).suffix(8)) }
    }

    private var statusLabel: String {
        guard let page = activePage, page.loaded else { return String(localized: "同步中") }
        return page.running ? String(localized: "运行中") : String(localized: "已结束")
    }

    private var statusColor: Color {
        guard let page = activePage, page.loaded else { return palette.fg4 }
        return page.running ? palette.accent : palette.success
    }
}

/// The open levels of a subagent sheet, each the shared presenter's page of its child's lane
/// (`TimelinePresenter.subagent`, as on iPhone and Android). A lane streams while its level is open.
@MainActor
@Observable
final class SubagentPages {
    private var pages: [String: SubagentPresentation] = [:]
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]

    func page(_ toolCallId: String) -> SubagentPresentation? { pages[toolCallId] }

    /// Follows the levels in [stack] and stops the rest. A nested child is spawned in the level
    /// below it, so that level's rows are its parent transcript; the first level reads the conversation's.
    func follow(_ stack: [String], presenter: TimelinePresenter?) {
        for id in Array(tasks.keys) where !stack.contains(id) {
            tasks.removeValue(forKey: id)?.cancel()
            pages.removeValue(forKey: id)
        }
        guard let presenter else { return }
        for (level, id) in stack.enumerated() where tasks[id] == nil {
            let parent: [any TimelineItem]? = level == 0 ? nil : pages[stack[level - 1]]?.items
            tasks[id] = Task { @MainActor [weak self] in
                for await next in presenter.subagent(toolCallId: id, parent: parent) {
                    if Task.isCancelled { return }
                    self?.pages[id] = next
                }
            }
        }
    }

    /// Opens [toolCallId]'s lane again after its stream failed.
    func reopen(_ toolCallId: String, stack: [String], presenter: TimelinePresenter?) {
        tasks.removeValue(forKey: toolCallId)?.cancel()
        pages.removeValue(forKey: toolCallId)
        follow(stack, presenter: presenter)
    }
}

/// One subagent's transcript in the same AppKit list as the conversation; its lane is grouped by the
/// shared presenter, and completed tool work starts open.
private struct SubagentTranscriptPane: View {
    let workbench: Workbench
    let pages: SubagentPages
    let toolCallId: String
    let projectId: String
    let running: Bool
    let openNested: (String, String) -> Void
    @State private var scroll = TranscriptScrollState()
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            SubagentTranscriptHost(workbench: workbench, pages: pages, toolCallId: toolCallId, projectId: projectId, scroll: scroll, openNested: openNested)
                .overlay {
                    if !scroll.loaded {
                        Spinner(size: .small).frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if !scroll.hasRows {
                        VStack(spacing: Space.md) {
                            Image(icon: "sparkle.magnifyingglass").font(.riffet(size: 22)).foregroundStyle(palette.fg4)
                            Text(running ? "子 Agent 正在启动…" : "这个子 Agent 暂时没有执行记录。")
                                .font(.riffet(size: S(13))).foregroundStyle(palette.fg3)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(palette.bg)
                    }
                }
        }
    }
}

private struct SubagentTranscriptHost: NSViewControllerRepresentable {
    let workbench: Workbench
    let pages: SubagentPages
    let toolCallId: String
    let projectId: String
    let scroll: TranscriptScrollState
    let openNested: (String, String) -> Void

    func makeNSViewController(context: Context) -> TranscriptController {
        let workbench = workbench, pages = pages, toolCallId = toolCallId, projectId = projectId
        let controller = TranscriptController(
            ui: TranscriptUIStore(completedProcessesOpen: true),
            scrollState: scroll,
            feed: { Self.feed(workbench, pages: pages, toolCallId: toolCallId, projectId: projectId) }
        )
        controller.showsChrome = false
        controller.actions = TranscriptActions(openSubagent: openNested, openFile: { path, line in
            FileOpener.activate(path: path, line: line, projectId: projectId, workbench: workbench)
        }, fileMenu: { path in
            FileOpener.menuItems(path: path, projectId: projectId, workbench: workbench)
        }, resolveFile: { path in
            let items = pages.page(toolCallId)?.items ?? []
            return FileMentionsKt.resolveFileMention(path: path, files: FileMentionsKt.conversationFiles(items: items, root: workbench.project(projectId)?.cwd))
        })
        return controller
    }

    func updateNSViewController(_ controller: TranscriptController, context: Context) {
        controller.actions.openSubagent = openNested
    }

    @MainActor
    static func feed(_ workbench: Workbench, pages: SubagentPages, toolCallId: String, projectId: String) -> TranscriptFeed? {
        guard let page = pages.page(toolCallId), page.loaded else { return nil }
        let compactionShowsProgress = page.running && page.grouping.items.contains { item in
            guard let activity = item as? TimelineItemActivity else { return false }
            return activity.activity.kind == .compaction && activity.activity.status.active
        }
        let working: WorkingSpec? = page.running && !page.items.isEmpty && !compactionShowsProgress
            ? WorkingSpec(step: SessionActivityKt.currentStep(timeline: page.items), since: (page.transcript?.startedAt).flatMap { ServerTime.date($0) }, speed: nil)
            : nil
        return TranscriptFeed(
            sessionId: toolCallId,
            identity: page,
            rows: {
                let prompted = page.items.contains { $0.event.base.type == "user_message_chunk" }
                return TranscriptRows(rows: page.grouping.rows, flags: prompted ? ["userPrompt"] : [], heldFooter: TimelineRowsKt.heldFooterRow(rows: page.grouping.rows))
            },
            older: nil,
            working: working,
            suppressesHeldFooter: compactionShowsProgress,
            sessionWorking: page.running,
            root: workbench.project(projectId)?.cwd,
            projectId: projectId,
            emptyText: false
        )
    }
}
