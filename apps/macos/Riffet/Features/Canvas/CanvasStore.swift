import Foundation
import Observation
import RiffetKit

/// The data behind one session's canvas: what the family of conversations is, what has been read of each (outlines, turns' rows,
/// runs, subagent lanes, summaries) and the layout the engine makes of it. It follows the web view's loading rules (`CanvasView.tsx`):
/// a conversation's outline is read again when its `updatedAt|state` changes, only the turns that changed are read for their rows,
/// a live conversation is polled (runs every 2 s, outline every 3 s) and laid out again every ten seconds, lanes and summaries are
/// fetched only for what is in view, summaries two at a time.
///
/// Every engine mutation runs in order through `serial`; layouts are coalesced, computed off the main thread, and only applied here.
@MainActor
final class CanvasStore {
    let sessionId: String
    let locale: String
    let images = CanvasImages()

    /// A new layout is ready. The layout is immutable and shared.
    var onLayout: ((CanvasLayout) -> Void)?
    /// The pulses of the running turns changed (by run id).
    var onPulses: (([String: CanvasPulse]) -> Void)?
    /// The engine is up; its plain strings (action names, states) are available.
    var onStart: (() -> Void)?
    /// The engine would not come up or a mutation failed.
    var onFailed: ((String) -> Void)?

    private(set) var strings: [String: String] = [:]
    private(set) var layout: CanvasLayout?
    private(set) var failed: String?

    private let workbench: Workbench
    private let reader: CanvasReader
    private var engine: CanvasLayoutEngine?
    private var stopped = false
    private var chain: Task<Void, Never>?

    // Options of the layout.
    private var level: CanvasLevel = .summary
    private var wantsNext = false
    private var sending = false
    private var layoutQueued = false

    // What the data is at.
    private var familyKey = 0
    private var projectsKey = 0
    private var familyIds: [String] = []
    private var outlineVersions: [String: String] = [:]
    private let queue = CanvasQueue(concurrency: 3)
    private let summaryQueue = CanvasQueue(concurrency: 2)
    private var summaries: [String: String] = [:]
    private var summariesOn = false
    private var asked: Set<String> = []
    private var requestedLanes: Set<String> = []
    private var broken: Set<String> = []
    private var artifactKeys: Set<String> = []
    private var inlineLoaded: Set<String> = []
    private var visible = CGRect.null
    private var nodeFrames: [String: CGRect] = [:]

    // Live time.
    private var timer: Task<Void, Never>?
    private var beat = 0
    private var samples: [String: [(at: Date, tokens: Double)]] = [:]
    private var pulses: [String: CanvasPulse] = [:]
    private var forkIds: [String: (clientSessionId: String, commandId: String)] = [:]
    private static let pulseSamples = 24

    init(workbench: Workbench, sessionId: String) {
        self.workbench = workbench
        self.sessionId = sessionId
        reader = CanvasReader(base: workbench.baseURL.absoluteString.hasSuffix("/") ? String(workbench.baseURL.absoluteString.dropLast()) : workbench.baseURL.absoluteString)
        locale = (Bundle.main.preferredLocalizations.first ?? "zh-Hans").hasPrefix("zh") ? "zh-Hans" : "en"
        images.onBroken = { [weak self] key in self?.imageBroken(key) }
    }

    // MARK: Life

    func start() {
        Task { [weak self] in
            guard let self else { return }
            do {
                let engine = try await CanvasLayoutEngine.make(locale: locale)
                guard !stopped else { return }
                self.engine = engine
                strings = engine.strings
                onStart?()
                observe()
                await sync()
                startTimer()
            } catch {
                fail(error)
            }
        }
    }

    private func fail(_ error: Error) {
        guard !stopped else { return }
        failed = error.localizedDescription
        onFailed?(error.localizedDescription)
    }

    /// Nothing starts after this; reads in flight are cancelled.
    func stop() {
        stopped = true
        timer?.cancel()
        queue.cancel()
        summaryQueue.cancel()
        onLayout = nil
        onPulses = nil
        onFailed = nil
        images.stop()
    }

    // MARK: Options

    func setLevel(_ level: CanvasLevel) {
        guard level != self.level else { return }
        self.level = level
        requestLayout()
    }

    /// Whether the focus conversation ends in a slot for the next question, and whether one is being sent into it.
    func setNext(_ enabled: Bool, sending: Bool) {
        guard enabled != wantsNext || sending != self.sending else { return }
        wantsNext = enabled
        self.sending = sending
        requestLayout()
    }

    /// The part of the world in view (with margin): lanes and summaries are fetched for what is in it.
    func setVisible(_ rect: CGRect) {
        visible = rect
        fetchWants()
    }

    /// An artifact whose image would not load leaves its track.
    func markBroken(_ key: String) {
        guard artifactKeys.contains(key), broken.insert(key).inserted else { return }
        let keys = broken
        enqueue { [self] in try await engine?.setBroken(keys); requestLayout() }
    }

    private func imageBroken(_ key: String) { markBroken(key) }

    // MARK: Questions of the last layout

    func detail(node: String) async -> CanvasNodeDetail? {
        guard let engine else { return nil }
        return try? await serial { try await engine.detail(node: node) }
    }

    func tip(node: String, index: Int) async -> CanvasTip? {
        guard let engine else { return nil }
        return try? await serial { try await engine.tip(node: node, index: index) }
    }

    /// Opens or closes a subagent's steps in the inspector.
    func toggleLane(session: String, lane: String, open: Bool) {
        if open {
            loadLane(session: session, lane: lane)
        } else {
            enqueue { [self] in try await engine?.dropLane(session: session, lane: lane); requestLayout() }
        }
    }

    // MARK: Fork

    /// Continues from a finished turn in a conversation of its own; the note, when there is one, is the new conversation's first line.
    /// The conversation joins the family and the canvas grows a row. Returns whether it was made.
    func fork(session: String, runId: String, note: String) async -> Bool {
        guard let api = workbench.host.api else { return false }
        let key = "\(session)|\(runId)"
        let ids = forkIds[key] ?? (UUID().uuidString, UUID().uuidString)
        forkIds[key] = ids
        do {
            let result = try await api.forkSession(sessionId: session, clientSessionId: ids.clientSessionId, commandId: ids.commandId, runId: runId, target: nil, isolate: false, note: note.isEmpty ? nil : note)
            forkIds[key] = nil
            workbench.store.applySession(session: result.session)
            workbench.refresh()
            return true
        } catch {
            workbench.notice = SessionNotice(sessionId: sessionId, text: strings["forkFailed"] ?? error.riffetMessage)
            return false
        }
    }

    // MARK: Following the app's lists

    private func observe() {
        guard !stopped else { return }
        withObservationTracking {
            _ = workbench.list
            _ = workbench.projectList
            _ = workbench.settings
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, !stopped else { return }
                observe()
                await sync()
            }
        }
    }

    /// Hands the engine the family and the projects when they changed, and reads what is out of date.
    private func sync() async {
        guard let engine, !stopped else { return }
        let all = workbench.list.sessions
        var family = Self.family(of: sessionId, in: all)
        if family.isEmpty, let own = workbench.selected, own.id == sessionId { family = [own] }
        var hasher = Hasher()
        for s in family {
            hasher.combine(s.id); hasher.combine(s.shownTitle); hasher.combine(s.state.name); hasher.combine(s.updatedAt)
            hasher.combine(s.archivedAt); hasher.combine(s.model); hasher.combine(s.agent); hasher.combine(s.origin?.sessionId); hasher.combine(s.origin?.kind)
        }
        let key = hasher.finalize()
        let projects = workbench.projectList.map { CanvasProjectInput(id: $0.id, cwd: $0.cwd, name: $0.name, branch: $0.worktree?.branch) }
        var projectHasher = Hasher()
        for p in projects { projectHasher.combine(p.id); projectHasher.combine(p.cwd); projectHasher.combine(p.name); projectHasher.combine(p.branch) }
        let projectKey = projectHasher.finalize()
        let on = workbench.settings?.auxiliaryModels?.summary != nil
        let inputs = family.map(Self.input)
        let ids = family.map(\.id)
        let changed = key != familyKey, projectsChanged = projectKey != projectsKey, summariesChanged = on != summariesOn
        familyKey = key; projectsKey = projectKey; familyIds = ids
        if summariesChanged { summariesOn = on; asked.removeAll() }
        if changed || projectsChanged || summariesChanged {
            let sessionId = sessionId, known = summaries
            enqueue {
                if projectsChanged { try await engine.setProjects(projects) }
                if changed { try await engine.setSessions(focus: sessionId, inputs) }
                if summariesChanged { try await engine.setSummaries(on ? known : nil) }
            }
            requestLayout()
        }
        for s in family {
            let version = "\(s.updatedAt)|\(s.state.name.lowercased())"
            guard outlineVersions[s.id] != version else { continue }
            loadOutline(session: s.id, version: version)
            loadRuns(session: s.id)
        }
    }

    /// The conversation asked for, the line it came down by, and what was forked from the root since: `sessionFamily` of the web view.
    static func family(of id: String, in sessions: [Session]) -> [Session] {
        let byId = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var line: Set<String> = []
        guard var root = byId[id] else { return [] }
        line.insert(root.id)
        var hops = 0
        while let parent = root.origin?.sessionId, let next = byId[parent], hops < 16 {
            root = next
            line.insert(next.id)
            hops += 1
        }
        var family = [root]
        var members: Set<String> = [root.id]
        var children: [String: [Session]] = [:]
        for s in sessions { if let parent = s.origin?.sessionId { children[parent, default: []].append(s) } }
        var index = 0
        while index < family.count {
            for s in children[family[index].id] ?? [] where !members.contains(s.id) {
                if line.contains(s.id) || (s.archivedAt == nil && family.count < 24) {
                    family.append(s)
                    members.insert(s.id)
                }
            }
            index += 1
        }
        return family
    }

    private static func input(_ s: Session) -> CanvasSessionInput {
        CanvasSessionInput(
            id: s.id, projectId: s.projectId, kind: "native", title: s.shownTitle, state: s.state.name.lowercased(), createdAt: s.createdAt,
            backendId: s.agent, model: s.model,
            origin: s.origin.map { CanvasSessionInput.Origin(kind: $0.kind, sessionId: $0.sessionId, runId: $0.runId) },
            archivedAt: s.archivedAt
        )
    }

    // MARK: Reads

    private func loadOutline(session id: String, version: String) {
        outlineVersions[id] = version
        queue.enqueue(key: "outline|\(id)") { [self] in
            guard let engine, !stopped else { return }
            do {
                let json = try await reader.outline(session: id)
                let diff = try await serial { try await engine.setOutline(session: id, json: json) }
                requestLayout()
                guard !diff.turns.isEmpty else { return }
                queue.enqueue { [self] in await loadRows(session: id, diff: diff) }
            } catch {
                // An outline that cannot be read leaves the row with no turns rather than the canvas waiting for it.
                if (try? await serial({ try await engine.setOutline(session: id, json: Data("[]".utf8)) })) != nil { requestLayout() }
                outlineVersions[id] = nil
            }
        }
    }

    private func loadRows(session id: String, diff: CanvasOutlineDiff) async {
        guard let engine, !stopped else { return }
        do {
            let rows = try await reader.rows(session: id, lane: "main", from: diff.from, turns: Set(diff.turns))
            try await serial { try await engine.setTurnRows(session: id, turns: diff.turns, rows: rows) }
            requestLayout()
        } catch {
            try? await serial { try await engine.failTurns(session: id, turns: diff.turns) }
        }
    }

    private func loadRuns(session id: String) {
        queue.enqueue(key: "runs|\(id)") { [self] in
            guard let engine, !stopped else { return }
            guard let result = try? await reader.runs(session: id) else { return }
            try? await serial { try await engine.setRuns(result.json) }
            let at = Date()
            var beats: [String: CanvasPulse] = [:]
            for run in result.running {
                let history = Array(((samples[run.id] ?? []) + [(at, run.tokens)]).suffix(Self.pulseSamples + 1))
                samples[run.id] = history
                let series = zip(history.dropFirst(), history).map { next, previous in max(0, (next.tokens - previous.tokens) / max(0.5, next.at.timeIntervalSince(previous.at))) }
                if let rate = series.last { beats[run.id] = CanvasPulse(rate: rate, series: series) }
            }
            // This conversation's runs are all in the list: those no longer running lose their pulse.
            var next = pulses.filter { !result.ids.contains($0.key) }
            for (run, beat) in beats { next[run] = beat }
            for id in result.ids where beats[id] == nil { samples[id] = nil }
            if next != pulses { pulses = next; onPulses?(next) }
            requestLayout()
        }
    }

    private func loadLane(session id: String, lane: String) {
        let key = "\(id)|\(lane)"
        requestedLanes.insert(key)
        queue.enqueue { [self] in
            guard let engine, !stopped else { return }
            try? await serial { try await engine.setLane(session: id, lane: lane, rows: nil) }
            requestLayout()
            do {
                let rows = try await reader.rows(session: id, lane: lane, from: 0, pages: 6)
                try await serial { try await engine.setLane(session: id, lane: lane, rows: rows) }
            } catch {
                try? await serial { try await engine.dropLane(session: id, lane: lane) }
                workbench.notice = SessionNotice(sessionId: sessionId, text: strings["laneFailed"] ?? "")
            }
            requestLayout()
        }
    }

    /// Opened subagents' steps and finished answers' summaries, for the cards in view.
    private func fetchWants() {
        guard let wants = layout?.wants, !stopped else { return }
        for want in wants.lanes where nodeFrames[want.id].map({ $0.intersects(visible) }) == true {
            if !requestedLanes.contains("\(want.sid)|\(want.lane)") { loadLane(session: want.sid, lane: want.lane) }
        }
        guard summariesOn else { return }
        for want in wants.summaries where nodeFrames[want.id].map({ $0.intersects(visible) }) == true {
            let key = "\(want.sid)|\(want.turn)"
            guard asked.insert(key).inserted else { continue }
            summaryQueue.enqueue(key: "summary|\(key)") { [self] in
                guard let engine, !stopped else { return }
                guard let text = try? await reader.summary(session: want.sid, turn: want.turn), !text.isEmpty else { return }
                summaries[key] = text
                let known = summaries
                try? await serial { try await engine.setSummaries(known) }
                requestLayout()
            }
        }
    }

    // MARK: Time

    private func startTimer() {
        timer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { return }
                tick()
            }
        }
    }

    /// Once a second while something is at work: runs every 2 s, the outline every 3 s, the layout (its clock) every 10 s.
    private func tick() {
        let live = Set(workbench.list.sessions.filter { familyIds.contains($0.id) && $0.state.isActive }.map(\.id))
        guard !live.isEmpty || layout?.live == true else { return }
        beat += 1
        for id in live {
            if beat % 2 == 0 { loadRuns(session: id) }
            if beat % 3 == 0 { loadOutline(session: id, version: "beat|\(beat)") }
        }
        if beat % 10 == 0 { requestLayout() }
    }

    /// Asks for the outline of the focus conversation now (a message was just sent).
    func refreshOutline() {
        guard familyIds.contains(sessionId) else { return }
        loadOutline(session: sessionId, version: "sent|\(Date().timeIntervalSince1970)")
    }

    // MARK: Layout

    private func requestLayout() {
        guard !layoutQueued, !stopped else { return }
        layoutQueued = true
        enqueue { [self] in
            layoutQueued = false
            guard let engine else { return }
            let next = try await engine.layout(level: level, now: Date(), next: wantsNext, sending: sending)
            apply(next)
        }
    }

    private func apply(_ next: CanvasLayout) {
        guard !stopped else { return }
        layout = next
        var frames: [String: CGRect] = [:]
        frames.reserveCapacity(next.nodes.count)
        var keys: Set<String> = []
        for node in next.nodes {
            frames[node.id] = CGRect(x: node.x, y: node.y, width: node.w, height: node.h)
            switch node.kind {
            case .user(let user):
                for id in user.images ?? [] { if let request = reader.attachment(id) { images.register(id, request: request) } }
            case .artifacts(let shelf):
                for item in shelf.items {
                    keys.insert(item.key)
                    if let path = item.path, item.kind == "image", item.inline != true, let ti = node.ti, next.turns.indices.contains(ti) {
                        let turn = next.turns[ti]
                        if next.sessions.indices.contains(turn.si), let request = reader.media(session: next.sessions[turn.si].id, path: path) { images.register(item.key, request: request) }
                    } else if item.inline == true, item.kind == "image", inlineLoaded.insert(item.key).inserted {
                        loadInline(node: node.id)
                    }
                }
            default: break
            }
        }
        nodeFrames = frames
        artifactKeys = keys
        onLayout?(next)
        fetchWants()
    }

    /// An image the agent wrote inline has no file: its data comes with the node's detail.
    private func loadInline(node id: String) {
        enqueue { [self] in
            guard let engine, let detail = try await engine.detail(node: id) else { return }
            for item in detail.items ?? [] where item.inline == true {
                if let src = item.src, let url = URL(string: src) { images.register(item.key, request: URLRequest(url: url)) }
            }
        }
    }

    // MARK: Ordering

    /// Runs [body] after everything asked for before it, so the engine sees mutations in the order they were requested.
    /// The place in line is taken when this is called, not when the work starts.
    private func ordered<T>(_ body: @MainActor @escaping () async throws -> T) -> Task<T, Error> {
        let previous = chain
        let task = Task { @MainActor () async throws -> T in
            await previous?.value
            if stopped { throw CancellationError() }
            return try await body()
        }
        chain = Task { _ = try? await task.value }
        return task
    }

    private func serial<T>(_ body: @MainActor @escaping () async throws -> T) async throws -> T {
        try await ordered(body).value
    }

    private func enqueue(_ body: @MainActor @escaping () async throws -> Void) {
        let task = ordered(body)
        Task { @MainActor in
            do { try await task.value } catch { if !(error is CancellationError) { fail(error) } }
        }
    }
}
