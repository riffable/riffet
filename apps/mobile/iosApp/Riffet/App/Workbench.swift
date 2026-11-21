import Foundation
import Observation
import RiffetKit

/// UI state mirrors the shared client; ordering, projection, retries and command IDs stay in Kotlin.
@MainActor @Observable
final class Workbench {
    let store: SessionStore
    let host: IOSHost
    /// Retained with this workbench so a suspended operation cannot pick up another server's API.
    let api: RiffetApi?
    let baseURL: URL
    let drafts: DraftStore
    let resources: ResourceClient
    private let subscriptions = FlowSubscriptions()
    var error: String?
    /// The deletion waiting for confirmation, the conversation whose preview is loading, and the last removal
    /// (here or on another device) for pages that show it to drop it.
    var deletion: SessionDeletion?
    private(set) var deletionLoading: String?
    private(set) var removal: SessionRemoval?
    private(set) var notificationError: String?
    var visibleSessionID: String? {
        didSet { if let id = visibleSessionID, id != oldValue { RiffetNotifications.shared.withdraw(sessionID: id) } }
    }
    /// The waiting conversations the last notification sweep saw; nil asks for a sweep at the next list.
    @ObservationIgnored private var sweptWaiting: Set<String>?
    private(set) var list: SessionListState
    private(set) var selected: Session?
    private(set) var status: NativeStatus?
    /// The server's control snapshot. Nil until hello or a control frame; the composer then keeps its own rules.
    private(set) var control: SessionControlSnapshot?
    private(set) var runs: [Run] = []
    private(set) var queued: [Run] = []
    private(set) var uncertain: [Run] = []
    private(set) var working = false
    private(set) var interaction: NativeInteraction?
    private(set) var sendState = ComposerSendState(sending: false, interrupting: false, pendingRunIds: [], error: nil, notice: nil)
    private(set) var connection: RiffetConnectionState = RiffetConnectionStateIdle.shared
    private(set) var context: NativeContext?
    private(set) var history: NativeHistoryState?
    private(set) var loadingHistory = false
    private(set) var historyError: String?
    private(set) var cachedAt: Int64?
    private(set) var subagents: [StoredSubagent] = []
    private(set) var loadingSubagent: String?
    private(set) var subagentError: String?
    private(set) var presentation: TimelinePresentation?
    var todos: [TodoEntry] { presentation?.todos ?? [] }
    var goal: SessionGoal? { presentation?.goal }
    /// Subagents still running while the main agent is idle; the stop button and the transcript hint.
    var backgroundSubagents: Int { presentation?.sessionId == selected?.id ? Int(presentation?.backgroundSubagents ?? 0) : 0 }
    /// Subagents and workflows still running after the main agent's turn ended; zero while it works.
    var delegatedAgents: Int { presentation?.sessionId == selected?.id ? Int(presentation?.delegatedAgents ?? 0) : 0 }
    var delegatedWorkflows: Int { presentation?.sessionId == selected?.id ? Int(presentation?.delegatedWorkflows ?? 0) : 0 }
    /// Compaction and background tasks above the composer; empty when the server reports no activity.
    var dock: ActivityDock { presentation?.sessionId == selected?.id ? presentation?.dock ?? ActivityDock(compacting: false, background: 0, tasks: []) : ActivityDock(compacting: false, background: 0, tasks: []) }
    /// The subagents the session spawned, presented by the shared `subagentEntries`.
    var subagentEntries: [SubagentEntry] { presentation?.sessionId == selected?.id ? presentation?.subagents ?? [] : [] }
    func isStopping(activity id: String) -> Bool { presentation?.stoppingActivities.contains(id) ?? false }
    /// The optimistic "停止中" is the store's; the server's later state is what the row finally shows.
    func stop(activity id: String) async { await perform { _ = try await store.stopActivity(activityId: id) } }
    func text(of blobRef: String) async -> String? { try? await store.activityText(blobRef: blobRef) }
    private(set) var backends: [NativeBackendCatalogEntry] = []
    private(set) var backendError: String?
    /// The first agent list has been read (or failed); until then "no agent" is not yet an answer.
    private(set) var backendsLoaded = false
    /// The owner's personal info on this server (docs/OWNER.md); nil until first loaded.
    private(set) var owner: OwnerInfo?
    var ownerAvatarURL: URL? { owner.flatMap { api?.ownerAvatarUrl(owner: $0) }.flatMap(URL.init(string:)) }
    var settings: AppSettings? { list.settings }
    var grouping: TimelineGrouping? { presentation?.sessionId == selected?.id ? presentation?.grouping : nil }
    var projects: [Project] { list.projects.filter { $0.archivedAt == nil && $0.isTaskTarget } }
    var selectedProject: Project? { project(selected?.projectId) }
    var isConnected: Bool { connection is RiffetConnectionStateLive }
    /// The server answered the latest list read: what "已连接" means outside a conversation.
    var serverReachable: Bool { list.error == nil && list.loaded && list.cachedAt == nil }
    private var catalogs: [String: NativeBackendCatalogEntry] = [:]
    private var catalogRevision: Int64 = -1

    init(store: SessionStore, host: IOSHost, baseURL: URL, signedOut: @escaping () -> Void) {
        self.store = store
        self.host = host
        self.api = host.api
        self.baseURL = baseURL
        self.list = store.list.value
        self.projectRoots = Dictionary(store.list.value.projects.map { ($0.id, $0.cwd) }, uniquingKeysWith: { first, _ in first })
        self.drafts = DraftStore(server: baseURL.absoluteString)
        self.resources = ResourceClient(baseURL: baseURL, host: host)
        subscriptions.observe(store.list) { [weak self] in
            self?.list = $0
            self?.projectRoots = Dictionary($0.projects.map { ($0.id, $0.cwd) }, uniquingKeysWith: { first, _ in first })
            self?.sweepNotifications()
        }
        subscriptions.observe(store.selected) { [weak self] in self?.selected = $0 }
        subscriptions.observe(store.removedSessions) { [weak self] ids in self?.sessionsRemoved(ids) }
        subscriptions.observe(store.status) { [weak self] in self?.status = $0 }
        subscriptions.observe(store.control) { [weak self] in self?.control = $0 }
        subscriptions.observe(store.runs) { [weak self] in self?.runs = $0 }
        subscriptions.observe(store.queued) { [weak self] in self?.queued = $0 }
        subscriptions.observe(store.uncertain) { [weak self] in self?.uncertain = $0 }
        subscriptions.observe(store.working) { [weak self] in self?.working = $0.boolValue }
        subscriptions.observe(store.interaction) { [weak self] in self?.interaction = $0 }
        subscriptions.observe(store.sendState) { [weak self] in self?.sendState = $0 }
        subscriptions.observe(store.connection) { [weak self] in self?.connection = $0 }
        subscriptions.observe(store.context) { [weak self] in self?.context = $0 }
        subscriptions.observe(store.history) { [weak self] in self?.history = $0 }
        subscriptions.observe(store.loadingHistory) { [weak self] in self?.loadingHistory = $0.boolValue }
        subscriptions.observe(store.historyError) { [weak self] in self?.historyError = $0 }
        subscriptions.observe(store.cachedAt) { [weak self] in self?.cachedAt = $0?.int64Value }
        subscriptions.observe(store.subagents) { [weak self] in self?.subagents = $0 }
        subscriptions.observe(store.loadingSubagent) { [weak self] in self?.loadingSubagent = $0 }
        subscriptions.observe(store.subagentError) { [weak self] in self?.subagentError = $0 }
        subscriptions.observe(store.unauthenticated) { value in if value.boolValue { signedOut() } }
        if let presenter = host.presenter {
            subscriptions.observe(presenter.presentation) { [weak self] in self?.presentation = $0 }
        }
        subscriptions.observe(store.activity) { [weak self] activity in
            guard let self else { return }
            for alert in activity.alerts where alert.session.id != self.visibleSessionID {
                let body: String
                switch alert.kind {
                case .waiting: body = String(localized: "需要你处理", bundle: .riffet)
                case .failed: body = alert.session.error ?? String(localized: "任务失败", bundle: .riffet)
                case .interrupted: body = String(localized: "任务已停止", bundle: .riffet)
                default: body = String(localized: "本轮任务已完成", bundle: .riffet)
                }
                Task {
                    do { try await RiffetNotifications.shared.postSessionUpdate(sessionID: alert.session.id,
                        title: alert.session.shownTitle, body: body, eventID: alert.session.updatedAt, namespace: baseURL.absoluteString) }
                    catch { self.notificationError = String(localized: "通知发送失败：\(error.localizedDescription)", bundle: .riffet) }
                }
            }
        }
        Task { await loadBackends() }
    }

    func close() { subscriptions.cancelAll(); drafts.flush(); store.flush() }
    /// Back in the foreground: pushes that arrived meanwhile are checked against the next list read,
    /// not the one from before, which may predate them.
    func withdrawSettledNotifications() { sweptWaiting = nil }
    private func sweepNotifications() {
        guard list.loaded, list.cachedAt == nil else { return }
        let waiting = Set(list.sessions.filter { $0.state == .waiting }.map(\.id))
        guard waiting != sweptWaiting else { return }
        sweptWaiting = waiting
        RiffetNotifications.shared.withdrawSettled(waiting: waiting, known: Set(list.sessions.map(\.id)))
    }
    func project(_ id: String?) -> Project? { list.projects.first { $0.id == id } }
    /// A project's directory without observing the session list: transcript rows that show paths relative
    /// to it would otherwise all re-render on every list update.
    func projectRoot(_ id: String) -> String? { projectRoots[id] }
    /// A session of the list by id. Pages ask for theirs several times per pass; scanning thousands of
    /// sessions through the Kotlin list each time cost an open about 100 ms. Reads `list`, so callers
    /// still update when it changes; the index is rebuilt once per list.
    func listedSession(_ id: String) -> Session? {
        let list = list
        if sessionIndex.list !== list {
            sessionIndex = (list, Dictionary(list.sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }))
        }
        return sessionIndex.byID[id]
    }
    @ObservationIgnored private var sessionIndex: (list: SessionListState?, byID: [String: Session]) = (nil, [:])
    @ObservationIgnored private var projectRoots: [String: String] = [:]
    func refresh() { store.refresh() }
    func consumeNotificationError(_ displayed: String) {
        if notificationError == displayed { notificationError = nil }
    }
    func refreshAndWait() async {
        refresh()
        // Give the shared refresh coroutine a turn before observing its loading state.
        try? await Task.sleep(for: .milliseconds(120))
        let deadline = ContinuousClock.now + .seconds(15)
        while list.loading && ContinuousClock.now < deadline && !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(80))
        }
    }
    func loadOlder() { store.loadOlder() }
    func open(_ session: Session) { store.select(session: session) }
    func open(sessionID: String) async {
        if let session = listedSession(sessionID) { open(session); return }
        await perform {
            guard let session = try await api?.session(id: sessionID) else { throw ClientFailure(String(localized: "会话不存在或已移除", bundle: .riffet)) }
            open(session)
        }
    }
    private var runtimeActionPendingSession: String?
    var runtimeActionPending: Bool { runtimeActionPendingSession != nil && runtimeActionPendingSession == selected?.id }
    var runtimeControl: NativeRuntimeControl? {
        guard isConnected, let session = selected, session.archivedAt == nil else { return nil }
        return status?.runtimeControl
    }
    func runRuntimeAction(_ action: NativeRuntimeAction, sessionID: String) async {
        guard selected?.id == sessionID, let control = runtimeControl, !runtimeActionPending, let api = api else { return }
        runtimeActionPendingSession = sessionID
        defer { if runtimeActionPendingSession == sessionID { runtimeActionPendingSession = nil } }
        do {
            _ = try await api.nativeRuntimeAction(id: sessionID, action: action.id, revision: control.revision)
            if selected?.id == sessionID { error = nil }
        } catch is CancellationError {} catch {
            if selected?.id == sessionID { self.error = error.riffetMessage }
        }
    }
    func perform(_ action: () async throws -> Void) async {
        do { try await action(); error = nil } catch is CancellationError {} catch { self.error = error.riffetMessage }
    }
    func send(_ text: String, attachments: [Attachment], interrupt: Bool = false, context: [PromptContextReference] = [], enqueue: Bool = false, onStored: (() -> Void)? = nil) async -> Bool {
        do { return try await (enqueue ? store.enqueue(text: text, attachments: attachments, context: context, onStored: onStored) : store.send(text: text, attachments: attachments, context: context, interrupt: interrupt, onStored: onStored)).boolValue }
        catch { self.error = error.riffetMessage; return false }
    }
    func steer(_ text: String, attachments: [Attachment], context: [PromptContextReference], target: NativeTurnTarget) async -> Bool {
        do { return try await store.steer(text: text, attachments: attachments, context: context, target: target).boolValue }
        catch { self.error = error.riffetMessage; return false }
    }
    /// The conversation is on screen in the foreground; call again when its activity moves.
    func markSeen(_ sessionID: String) { store.markSeen(id: sessionID) }
    func markAllSeen() async { await perform { try await store.markAllSeen() } }
    func update(_ session: Session, title: String? = nil, tags: [String]? = nil, archived: Bool? = nil, pinned: Bool? = nil) async {
        await perform {
            _ = try await store.updateSession(id: session.id, body: SessionUpdate(title: title, tags: tags,
                archived: archived.map { KotlinBoolean(bool: $0) }, pinned: pinned.map { KotlinBoolean(bool: $0) }, toolGroups: nil, extensionsOff: nil))
        }
    }
    func requestDeletion(_ session: Session) async {
        guard deletionLoading == nil else { return }
        deletionLoading = session.id
        defer { deletionLoading = nil }
        do {
            let preview = try await store.deletionPreview(id: session.id)
            if let blocker = preview.blocker { error = blocker.text }
            else { deletion = SessionDeletion(session: session, preview: preview) }
        } catch {
            if let http = (error as NSError).userInfo["KotlinException"] as? RiffetHttpException, http.status == 410, http.code == "SESSION_DELETED" {
                sessionsRemoved([session.id])
            } else { self.error = error.riffetMessage }
        }
    }
    func confirmDeletion(_ request: SessionDeletion) async {
        guard !request.submitting else { return }
        request.submitting = true
        request.error = nil
        defer { request.submitting = false }
        do {
            _ = try await store.deleteSession(id: request.session.id, sessionIds: request.preview.sessionIds)
            if deletion === request { deletion = nil }
        } catch {
            let code = ((error as NSError).userInfo["KotlinException"] as? RiffetHttpException)?.code
            if code == "SESSION_DELETE_SCOPE_CHANGED", let fresh = try? await store.deletionPreview(id: request.session.id) {
                if let blocker = fresh.blocker { request.error = blocker.text }
                else { request.preview = fresh }
                return
            }
            request.error = error.riffetMessage
        }
    }
    private func sessionsRemoved(_ ids: [String]) {
        let gone = Set(ids)
        if let deletion, gone.contains(deletion.session.id) { self.deletion = nil }
        for id in gone { drafts.discard("session.\(id)"); drafts.setReadingAnchor(nil, for: id) }
        removal = SessionRemoval(serial: (removal?.serial ?? 0) + 1, ids: gone)
    }
    func updateProject(_ project: Project, name: String? = nil, tags: [String]? = nil, archived: Bool? = nil) async throws {
        guard let api = api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
        _ = try await api.updateProject(id: project.id, name: name, tags: tags, archived: archived.map(KotlinBoolean.init(bool:)))
        store.refresh()
    }
    func createSession(projectID: String, prompt: String, attachments: [Attachment], backend: NativeBackendId,
                       profileID: String?, model: String?, mode: String?, approval: String?, context: [PromptContextReference] = []) async throws -> Session {
        try await store.createSession(projectId: projectID, prompt: prompt, attachments: attachments,
            backendId: backend, backendProfileId: profileID, model: model, mode: mode, approval: approval, context: context, agentId: nil)
    }
    /// Quiet on failure: the header keeps whatever was last known. A full read is the server's word, even with a lower
    /// revision (a restored backup, a fresh state directory).
    func refreshOwner() async {
        if let info = try? await api?.owner() { owner = info }
    }
    func updateOwnerName(_ name: String) async throws {
        guard let api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
        acceptOwner(try await api.updateOwnerName(name: name))
    }
    func uploadOwnerAvatar(_ data: Data, type: String) async throws {
        guard let api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
        acceptOwner(try await api.uploadOwnerAvatar(bytes: byteArrayFromData(data: data), type: type))
    }
    func removeOwnerAvatar() async throws {
        guard let api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
        acceptOwner(try await api.removeOwnerAvatar())
    }
    func restoreOwnerAvatar(_ avatar: OwnerAvatar) async throws {
        guard let api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
        acceptOwner(try await api.restoreOwnerAvatar(sha256: avatar.sha256))
    }
    func deleteOwnerAvatarHistory(_ avatar: OwnerAvatar) async throws {
        guard let api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
        acceptOwner(try await api.deleteOwnerAvatarHistory(sha256: avatar.sha256))
    }
    func ownerAvatarURL(_ avatar: OwnerAvatar) -> URL? {
        api.flatMap { URL(string: $0.ownerAvatarUrl(avatar: avatar)) }
    }
    /// Empty on failure, which hides the random-avatar action.
    func ownerAvatarStyles() async -> [OwnerAvatarStyle] {
        (try? await api?.ownerAvatarStyles()) ?? []
    }
    func generateOwnerAvatar(style: OwnerAvatarStyle, seed: String, ink: String, paper: String) async throws {
        guard let api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
        acceptOwner(try await api.generateOwnerAvatar(style: style.id, seed: seed, ink: ink, paper: paper))
    }
    func ownerAvatarPreviewURL(style: OwnerAvatarStyle, seed: String, ink: String, paper: String) -> URL? {
        api.flatMap { URL(string: $0.ownerAvatarPreviewUrl(style: style.id, seed: seed, ink: ink, paper: paper)) }
    }
    /// A reply older than what is shown never replaces it.
    private func acceptOwner(_ info: OwnerInfo) {
        if let current = owner, info.revision < current.revision { return }
        owner = info
    }
    func loadBackends() async {
        defer { backendsLoaded = true }
        do { backends = try await api?.backends() ?? []; backendError = nil }
        catch { backendError = error.riffetMessage }
    }
    /// The catalog [loadCatalog] would answer without a request, so a page can show it in its first pass.
    func cachedCatalog(_ backend: NativeBackendId, profileID: String?, projectID: String?) -> NativeBackendCatalogEntry? {
        guard catalogRevision == list.backendRevision else { return nil }
        return catalogs["\(backend.name)|\(profileID ?? "")|\(projectID ?? "")"]
    }
    func loadCatalog(_ backend: NativeBackendId, profileID: String?, projectID: String?, reload: Bool = false) async throws -> NativeBackendCatalogEntry? {
        if catalogRevision != list.backendRevision {
            catalogs.removeAll(keepingCapacity: true)
            catalogRevision = list.backendRevision
        }
        let key = "\(backend.name)|\(profileID ?? "")|\(projectID ?? "")"
        if !reload, let entry = catalogs[key] { return entry }
        guard let api = api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
        let revision = list.backendRevision
        let entry = try await api.backendCatalog(backendId: backend, profileId: profileID, projectId: projectID, allModels: false, global: false)
        guard revision == list.backendRevision else { throw CancellationError() }
        catalogs[key] = entry
        return entry
    }
}

struct ClientFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

extension SessionState {
    var isActive: Bool { self == .starting || self == .running || self == .waiting || self == .cancelling }
    var label: String {
        switch self {
        case .starting: String(localized: "正在启动", bundle: .riffet)
        case .running: String(localized: "正在处理", bundle: .riffet)
        case .waiting: String(localized: "等待你处理", bundle: .riffet)
        case .cancelling: String(localized: "正在停止", bundle: .riffet)
        case .interrupted: String(localized: "已停止", bundle: .riffet)
        case .failed: String(localized: "执行失败", bundle: .riffet)
        case .archived: String(localized: "已归档", bundle: .riffet)
        default: String(localized: "本轮已结束", bundle: .riffet)
        }
    }
}

/// Conversations the server no longer has; `serial` makes two removals of the same ids distinct.
struct SessionRemoval: Equatable {
    let serial: Int
    let ids: Set<String>
}

/// A deletion waiting for the reader's word: what the server said it removes, and how the confirmation is going.
@MainActor @Observable
final class SessionDeletion: Identifiable {
    let session: Session
    var preview: SessionDeletionPreview
    var submitting = false
    var error: String?
    init(session: Session, preview: SessionDeletionPreview) { self.session = session; self.preview = preview }
}

extension Project {
    /// A directory a task can run in: not the server's quick-chat home, a task's private workspace or the assistant's directory.
    var isTaskTarget: Bool { !isQuickChat && system != "task-workspace" && system != "assistant" }
}
