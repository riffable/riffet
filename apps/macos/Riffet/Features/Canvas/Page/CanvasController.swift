import AppKit
import Observation
import RiffetKit
import SwiftUI

/// One session's canvas page, AppKit side: it owns the surface and the overlays that follow the camera, turns the store's layouts
/// into surface items (keeping what the reader is looking at where it was), and carries the behaviour of `CanvasView.tsx`: level
/// switching with a morph, following the newest turn, hover lineage after 220 ms, click to inspect after 230 ms, double-click to
/// open a card and fly to it, the action bar, call tips, forks, replay. What SwiftUI shows (inspector, controls) is the observed part.
@MainActor
@Observable
final class CanvasController {
    struct Replay: Equatable { var index: Int, playing: Bool }
    struct Lightbox: Equatable { var key: String, name: String, session: String, path: String?, inline: String? }

    // MARK: Observed by the page

    private(set) var ready = false
    private(set) var strings: [String: String] = [:]
    private(set) var selectedNode: CanvasNode?
    private(set) var detail: CanvasNodeDetail?
    /// The call a click on a strip landed on, for the inspector to bring into view.
    private(set) var focusIndex: Int?
    private(set) var percent = 80
    private(set) var pulse: CanvasPulse?
    private(set) var replay: Replay?
    private(set) var moments: [Double] = []
    private(set) var hasLatest = false
    private(set) var forking: Set<String> = []
    private(set) var level: CanvasLevel = .summary
    private(set) var failed: String?
    /// The conversation's composer is open over the next question's slot.
    private(set) var nextOpen = false
    /// Counts thumbnails arriving, for the inspector's images.
    private(set) var imageRevision = 0

    var inspectorOpen: Bool { selectedNode != nil }
    var replayStamp: String {
        guard let replay, !moments.isEmpty else { return "" }
        return Self.stamp.string(from: Date(timeIntervalSince1970: moments[min(replay.index, moments.count - 1)] / 1000))
    }
    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = AppLocale.current
        f.setLocalizedDateFormatFromTemplate("Md jj:mm")
        return f
    }()

    // MARK: Owned views

    @ObservationIgnored let container = CanvasContainerView()
    @ObservationIgnored private var surface: CanvasSurfaceView { container.surface }
    @ObservationIgnored private let actionHost = PassthroughHost(passesClicks: false)
    @ObservationIgnored private let tipHost = PassthroughHost(passesClicks: true)
    @ObservationIgnored private var labelHosts: [String: (host: PassthroughHost, name: String, kind: String, external: Bool)] = [:]
    @ObservationIgnored private var momentSet = Set<Double>()
    @ObservationIgnored private var draftSize: (text: String, width: Double, height: CGFloat)?
    @ObservationIgnored private var settledAt = CFAbsoluteTime.zero
    @ObservationIgnored private var lastPulses: [String: CanvasPulse] = [:]
    @ObservationIgnored private var lastFar = false
    @ObservationIgnored private var draftView: CanvasForkDraftView?
    @ObservationIgnored private var draftNode: String?
    @ObservationIgnored private var pressMonitor: Any?
    @ObservationIgnored private var nextMonitor: Any?
    /// Where the slot is on screen; the composer panel reads it, so only that panel re-renders as the camera moves.
    @ObservationIgnored let nextAnchor = CanvasNextAnchor()

    // MARK: Collaborators and state

    @ObservationIgnored private let workbench: Workbench
    @ObservationIgnored private let session: Session
    @ObservationIgnored private let showTranscript: () -> Void
    @ObservationIgnored private var store: CanvasStore?
    @ObservationIgnored private var scene: CanvasScene?
    @ObservationIgnored private var palette: Palette = PaletteEnvironmentDefault.value
    @ObservationIgnored private var dark = false
    @ObservationIgnored private var faces = CanvasFaces.system
    @ObservationIgnored private var pointerCard: String?

    @ObservationIgnored private var layout: CanvasLayout?
    @ObservationIgnored private var nodesById: [String: CanvasNode] = [:]
    @ObservationIgnored private var indexById: [String: Int] = [:]
    @ObservationIgnored private var tById: [String: Double] = [:]
    @ObservationIgnored private var placed = false
    @ObservationIgnored private var followedId = ""
    @ObservationIgnored private var awaiting = false
    @ObservationIgnored private var moved = false
    @ObservationIgnored private var flying: (id: String, until: CFTimeInterval)?
    @ObservationIgnored private var summaryVisible = CGRect.null
    @ObservationIgnored private var settleTask: Task<Void, Never>?

    @ObservationIgnored private var surfaceHover: String?
    @ObservationIgnored private var hovered: String?
    @ObservationIgnored private var related: Set<String>?
    @ObservationIgnored private var fileHit: String?
    @ObservationIgnored private var marked: CanvasPaintState.Mark?
    @ObservationIgnored private var tip: (node: String, index: Int, value: CanvasTip)?
    @ObservationIgnored private var tipTask: Task<Void, Never>?
    @ObservationIgnored private var lineageTask: Task<Void, Never>?
    @ObservationIgnored private var pointed: String?
    @ObservationIgnored private var leaveTask: Task<Void, Never>?
    @ObservationIgnored private var clickTask: Task<Void, Never>?
    @ObservationIgnored private var decorationsQueued = false

    @ObservationIgnored private var selectedId: String?
    @ObservationIgnored private var detailVersion = ""
    @ObservationIgnored private var forkTexts: [String: String] = [:]
    @ObservationIgnored private var replayTask: Task<Void, Never>?
    @ObservationIgnored private var sendingSince: Date?
    @ObservationIgnored private var sendingTurns = 0
    @ObservationIgnored private var sendingTask: Task<Void, Never>?
    @ObservationIgnored private var sending = false

    static let inspectorWidth: CGFloat = 424
    /// Opening the next question: room above its slot for the composer's menus, below for the composer, and the zoom to write at.
    private static let menuRoom: CGFloat = 290, composerRoom: CGFloat = 130, writeZoom: CGFloat = 0.5
    private static let wantsNext = true

    init(workbench: Workbench, session: Session, showTranscript: @escaping () -> Void) {
        self.workbench = workbench
        self.session = session
        self.showTranscript = showTranscript
        container.addSubview(tipHost)
        container.addSubview(actionHost)
        actionHost.isHidden = true
        tipHost.isHidden = true
        container.onEscape = { [weak self] in self?.escape() ?? false }
        container.onResize = { [weak self] _ in self?.resized() }
        wireSurface()
        surface.jump(to: SurfaceCamera(x: 40, y: 40, k: 0.8))
    }

    // MARK: Life

    func start() {
        guard store == nil else { return }
        let store = CanvasStore(workbench: workbench, sessionId: session.id)
        self.store = store
        store.onStart = { [weak self] in self?.storeStarted() }
        store.onLayout = { [weak self] layout in self?.receive(layout) }
        store.onPulses = { [weak self] pulses in self?.pulsesChanged(pulses) }
        store.onFailed = { [weak self] message in self?.failed = message }
        store.images.onLoaded = { [weak self] in self?.imagesLoaded() }
        store.setNext(Self.wantsNext && session.archivedAt == nil, sending: false)
        store.start()
    }

    func stop() {
        store?.stop()
        store = nil
        settleTask?.cancel(); lineageTask?.cancel(); leaveTask?.cancel(); clickTask?.cancel(); tipTask?.cancel()
        replayTask?.cancel(); sendingTask?.cancel()
        closeDraft()
        surface.onCameraChange = nil; surface.onHover = nil; surface.onClick = nil; surface.onDoubleClick = nil
        surface.onPointer = nil; surface.onBandChange = nil; surface.onUserMove = nil
        closeNext(); container.onEscape = nil; container.onResize = nil
    }

    private func storeStarted() {
        guard let store else { return }
        if strings != store.strings { strings = store.strings }
        makeScene()
    }

    private func makeScene() {
        guard let store else { return }
        let scene = CanvasWorldScene(strings: store.strings, locale: store.locale, images: store.images, palette: dark ? palette.values.dark : palette.values.light, dark: dark, faces: faces)
        scene.setPulses(lastPulses)
        self.scene = scene
        surface.renderer = scene.renderer
        if let layout { apply(layout, first: !placed) }
    }

    /// The theme, the appearance or the interface style's fonts changed: every bitmap is drawn again.
    func setTheme(palette: Palette, dark: Bool) {
        self.palette = palette
        self.dark = dark
        faces = CanvasFaces.current()
        container.setGround(background: palette.nsColor(\.bgSubtle), ink: palette.nsColor(\.fg))
        scene?.invalidate(palette: dark ? palette.values.dark : palette.values.light, dark: dark, faces: faces)
        if let layout, scene != nil { apply(layout, first: false, refresh: true) }
        if let draftView { styleDraft(draftView) }
        refreshActionBar()
        refreshTip()
        for (id, entry) in labelHosts { labelHosts[id] = (entry.host, "", "", false) }
        placeLabels()
    }

    // MARK: Surface wiring

    private func wireSurface() {
        surface.memoryBudget = 256
        surface.onCameraChange = { [weak self] camera in self?.cameraChanged(camera) }
        surface.onBandChange = { [weak self] band in self?.bandChanged(band) }
        surface.onUserMove = { [weak self] in
            guard let self else { return }
            moved = true
            if surface.window?.firstResponder !== surface, !(surface.window?.firstResponder is NSTextView) { surface.window?.makeFirstResponder(surface) }
        }
        surface.onHover = { [weak self] id in self?.surfaceHovered(id) }
        surface.onPointer = { [weak self] point in self?.pointerMoved(point) }
        surface.onClick = { [weak self] id in self?.clicked(id) }
        surface.onDoubleClick = { [weak self] id in self?.doubleClicked(id) }
    }

    private func resized() {
        maybePlace()
        reposition()
    }

    // MARK: Layouts

    private func receive(_ next: CanvasLayout) {
        if ready != next.ready { ready = next.ready }
        apply(next, first: layout == nil)
        if hasLatest != (next.latest != nil) { hasLatest = next.latest != nil }
    }

    private func apply(_ next: CanvasLayout, first: Bool, refresh: Bool = false) {
        let before = layout
        layout = next
        nodesById = Dictionary(next.nodes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        indexById = Dictionary(next.nodes.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
        var set = Set<Double>()
        for node in next.nodes where node.t > 0 { set.insert(node.t) }
        for edge in next.edges where edge.t > 0 { set.insert(edge.t) }
        // Sorted (and observed) only when the moments themselves changed; a layout tick usually leaves them.
        if set != momentSet { momentSet = set; moments = set.sorted() }
        guard let scene else { return }
        let state = paintState
        let items = scene.items(for: next, state: state)
        let decorations = decorationList(next, state)
        if first || before == nil || refresh {
            surface.setItems(items)
            surface.setDecorations(decorations)
        } else if let before, before.level != next.level {
            levelMorph(before, next, items, decorations)
        } else if let before {
            steady(before, next, items, decorations)
        }
        surface.setDimmed(except: litSet)
        if let selected = selectedId {
            if let node = nodesById[selected] {
                // `v` moves whenever what the inspector shows of the card does; a layout tick leaves it.
                if selectedNode?.id != node.id || selectedNode?.v != node.v { selectedNode = node }
                if node.v != detailVersion { loadDetail(node) }
            } else {
                deselect()
            }
        }
        maybePlace()
        follow()
        pushVisible()
        pulsesChanged(lastPulses)
        reposition()
    }

    /// A level change: every card glides to its new place while the one under the pointer (or in the middle) stays put; a card the
    /// reader opened is flown to.
    private func levelMorph(_ before: CanvasLayout, _ next: CanvasLayout, _ items: [SurfaceItem], _ decorations: [SurfaceDecoration]) {
        hovered = nil; related = nil
        if let flight = flying, CACurrentMediaTime() < flight.until, let node = nodesById[flight.id] {
            surface.morph(to: items, decorations: decorations, anchorId: flight.id)
            surface.animateTo(opened(node), duration: 0.56)
        } else {
            surface.morph(to: items, decorations: decorations)
        }
    }

    /// Cards re-formed within a level (a turn grew, a subagent's steps arrived): the card the reader is looking at stays where it was.
    /// Marks and bars move along a running column's clock on their own, so only cards hold the view.
    private func steady(_ before: CanvasLayout, _ next: CanvasLayout, _ items: [SurfaceItem], _ decorations: [SurfaceDecoration]) {
        let camera = surface.camera
        let screen = surface.pointer ?? CGPoint(x: surface.bounds.width / 2, y: surface.bounds.height / 2)
        let wx = (screen.x - camera.x) / camera.k, wy = (screen.y - camera.y) / camera.k
        var anchor: CanvasNode?, best = CGFloat.infinity
        for node in before.nodes {
            switch node.kind {
            case .tools, .actor: continue
            default: break
            }
            let d = hypot(max(node.x - wx, 0, wx - node.x - node.w), max(node.y - wy, 0, wy - node.y - node.h))
            if d < best { best = d; anchor = node }
        }
        surface.setItems(items)
        surface.setDecorations(decorations)
        guard let anchor, let after = nodesById[anchor.id], after.x != anchor.x || after.y != anchor.y || after.w != anchor.w || after.h != anchor.h else { return }
        let inside = best == 0
        let fx = inside ? (wx - anchor.x) / anchor.w : 0, fy = inside ? (wy - anchor.y) / anchor.h : 0
        let ax = anchor.x + fx * anchor.w, ay = anchor.y + fy * anchor.h
        let bx = after.x + fx * after.w, by = after.y + fy * after.h
        surface.slide(dx: bx - ax, dy: by - ay)
    }

    /// The camera that shows an opened card at reading size, a little left of the middle.
    private func opened(_ node: CanvasNode) -> SurfaceCamera {
        surface.centering(CGPoint(x: node.x + node.w / 2, y: node.y + min(node.h, 360) / 2), k: max(1.05, 0.95 + 0.05), fx: 0.45, fy: 0.42)
    }

    private var paintState: CanvasPaintState {
        CanvasPaintState(selected: selectedId, related: related, hovered: hovered, pointer: pointerCard, focusPath: hovered.flatMap { $0.hasPrefix("file|") ? String($0.dropFirst(5)) : nil }, marked: marked, sending: sending, cutoff: replayCutoff, far: surface.band == .far, replaying: replay != nil)
    }

    private var replayCutoff: Double {
        guard let replay, !moments.isEmpty else { return .infinity }
        return moments[min(replay.index, moments.count - 1)]
    }

    private var litSet: Set<String>? {
        guard var set = related else { return nil }
        if let next = layout?.next { set.insert(next.id) }
        return set
    }

    private func decorationList(_ layout: CanvasLayout, _ state: CanvasPaintState) -> [SurfaceDecoration] {
        var list = scene?.decorations(for: layout, state: state) ?? []
        if let tip, let node = nodesById[tip.node], let line = tipLine(node, tip.index, layout) {
            let path = CGMutablePath()
            path.move(to: CGPoint(x: line.x, y: line.top))
            path.addLine(to: CGPoint(x: line.x, y: line.bottom))
            list.append(SurfaceDecoration(kind: "tip.line", path: path, stroke: palette.nsColor(\.fg, opacity: 0.2).resolvedCGColor(container.effectiveAppearance), fill: nil))
        }
        return list
    }

    /// Redraws the ground after a hover, a selection or a tip changed; one pass per turn of the run loop.
    private func decorationsChanged() {
        guard !decorationsQueued else { return }
        decorationsQueued = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            decorationsQueued = false
            guard let layout, let scene else { return }
            let state = paintState
            surface.setDecorations(decorationList(layout, state))
            surface.setItems(scene.items(for: layout, state: state))
        }
    }

    /// Only the cards whose look changed are drawn again (their versions differ); the rest keep their bitmaps.
    private func itemsChanged() {
        guard let layout, let scene else { return }
        surface.setItems(scene.items(for: layout, state: paintState))
    }

    private func imagesLoaded() {
        imageRevision += 1
        // The cards that show a thumbnail that has landed are the ones whose version moves.
        itemsChanged()
    }

    // MARK: Camera, level and following

    private func cameraChanged(_ camera: SurfaceCamera) {
        container.cameraChanged(camera)
        let rounded = Int((camera.k * 100).rounded())
        if rounded != percent { percent = rounded }
        reposition()
        // One task waits for the camera to rest for 150 ms; a frame only moves the timestamp it checks.
        settledAt = CFAbsoluteTimeGetCurrent()
        guard settleTask == nil else { return }
        settleTask = Task { @MainActor [weak self] in
            while let self, !Task.isCancelled {
                let rest = 0.15 - (CFAbsoluteTimeGetCurrent() - settledAt)
                if rest <= 0 { break }
                try? await Task.sleep(for: .seconds(rest))
            }
            guard !Task.isCancelled, let self else { return }
            settleTask = nil
            pushVisible()
        }
    }

    private func pushVisible() {
        let camera = surface.camera
        let visible = camera.visibleWorld(size: surface.bounds.size, margin: 0.6)
        store?.setVisible(visible)
    }

    /// Detail opens at reading size and closes below the lower threshold, so it does not flicker; not while flying to a card.
    private func bandChanged(_ band: ZoomBand) {
        if let flight = flying, CACurrentMediaTime() < flight.until { return }
        if level == .summary, band == .close { setLevel(.detail) }
        else if level == .detail, band < .middle { setLevel(.summary) }
        // Far out the slot and the edge to it are not drawn.
        if (band == .far) != lastFar, let layout, scene != nil {
            lastFar = band == .far
            apply(layout, first: false, refresh: true)
        }
        reposition()
    }

    private func setLevel(_ level: CanvasLevel) {
        self.level = level
        store?.setLevel(level)
    }

    private func maybePlace() {
        guard !placed, let layout, layout.ready, surface.bounds.width > 0, scene != nil else { return }
        guard let latest = layout.latest else {
            if layout.nodes.isEmpty { return }
            placed = true
            surface.jump(to: surface.framing(CGRect(x: layout.bounds.x, y: layout.bounds.y, width: layout.bounds.w, height: layout.bounds.h), maxK: 0.9))
            return
        }
        placed = true
        followedId = latest.id
        showLatest(animated: false)
    }

    /// The newest turn's column, right of centre so the turns before it lead in from the left and the slot for the next is in view.
    private func showLatest(animated: Bool) {
        guard let layout, let latest = layout.latest, surface.bounds.width > 0 else { return }
        let box = CGRect(x: latest.x, y: latest.y, width: latest.w, height: min(latest.h, 560))
        let k = min(0.9, max(0.5, surface.framing(box, maxK: 0.9, padding: 120).k))
        let target = surface.centering(CGPoint(x: box.midX, y: box.midY), k: k, fx: layout.next != nil ? 0.5 : 0.62, fy: 0.5)
        if animated { surface.animateTo(target, duration: 0.52) } else { surface.jump(to: target) }
    }

    private func follow() {
        guard placed, replay == nil, let layout, let latest = layout.latest else { return }
        if latest.id != followedId, layout.live || awaiting, !moved {
            followedId = latest.id
            awaiting = false
            showLatest(animated: true)
        }
    }

    func latestTapped() {
        moved = false
        showLatest(animated: true)
    }

    func fit() {
        guard let layout else { return }
        moved = true
        surface.userMoved()
        surface.animateTo(surface.framing(CGRect(x: layout.bounds.x, y: layout.bounds.y, width: layout.bounds.w, height: layout.bounds.h), maxK: 1), duration: 0.52)
    }

    func zoom(by factor: CGFloat) {
        let c = surface.camera
        let k = SurfaceCamera.clampK(c.k * factor)
        let size = surface.bounds.size
        moved = true
        surface.userMoved()
        surface.animateTo(SurfaceCamera(x: size.width / 2 - (size.width / 2 - c.x) * (k / c.k), y: size.height / 2 - (size.height / 2 - c.y) * (k / c.k), k: k), duration: 0.2)
    }

    func resetZoom() {
        let c = surface.camera
        guard c.k > 0 else { return }
        zoom(by: 1 / c.k)
    }

    /// Moves the camera (the zoom only below [minK]) so [box] sits clear of the edges and of what the overlays need: [top] free above
    /// it and [bottom] below its lower edge.
    private func reveal(_ box: CGRect, top: CGFloat, bottom: CGFloat, minK: CGFloat = 0) {
        let c = surface.camera, size = surface.bounds.size
        let k = max(c.k, minK)
        let open = size.width - (selectedNode != nil ? Self.inspectorWidth : 0)
        let w = box.width * k, h = box.height * k
        let left = box.minX * c.k + c.x, edge = box.minY * c.k + c.y
        let hi = max(16, size.height - 16 - bottom - h), lo = min(top, hi)
        let sideways = k == c.k && left >= 16 && left + w <= open - 16
        if sideways, edge >= lo, edge <= hi { return }
        let wantLeft = sideways ? left : max(16, (open - w) / 2)
        let wantTop = min(max(k == c.k ? edge : size.height * 0.4, lo), hi)
        moved = true
        surface.userMoved()
        surface.animateTo(SurfaceCamera(x: wantLeft - box.minX * k, y: wantTop - box.minY * k, k: k), duration: 0.38)
    }

    // MARK: Hover

    private func surfaceHovered(_ id: String?) {
        surfaceHover = id
        let card = id.flatMap { nodesById[$0] }.flatMap { Self.actionable($0) ? $0.id : nil }
        if card != pointerCard { pointerCard = card; decorationsChanged() }
        updateLineage()
        point(id.flatMap { nodesById[$0] }.flatMap { Self.actionable($0) ? $0.id : nil })
    }

    private func updateLineage() {
        let target = fileHit.map { "file|\($0)" } ?? surfaceHover.flatMap { nodesById[$0] != nil ? $0 : nil }
        lineageTask?.cancel()
        guard let target else { setHovered(nil); return }
        lineageTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(220))
            guard !Task.isCancelled else { return }
            self?.setHovered(target)
        }
    }

    private func setHovered(_ id: String?) {
        guard id != hovered else { return }
        hovered = id
        related = id.flatMap(relatedSet)
        surface.setDimmed(except: litSet)
        decorationsChanged()
    }

    /// A file: every sheet that wrote it and the answers they hang from. A card: its whole column, down through every track.
    private func relatedSet(_ id: String) -> Set<String>? {
        guard let layout else { return nil }
        var set: Set<String> = [id]
        if id.hasPrefix("file|") {
            let path = String(id.dropFirst(5))
            for node in layout.nodes {
                guard case .change(let change) = node.kind, change.files.contains(where: { $0.path == path }) || change.hidden?.contains(path) == true else { continue }
                set.insert(node.id)
                if layout.nodes.indices.contains(change.agent) { set.insert(layout.nodes[change.agent].id) }
            }
            return set
        }
        if let card = nodesById[id], let ti = card.ti {
            let si = layout.turns[ti].si
            for node in layout.nodes {
                if let t = node.ti, layout.turns[t].si == si, t == ti { set.insert(node.id) }
            }
        }
        for edge in layout.edges {
            let from = edgeNode(edge.from, layout), to = edgeNode(edge.to, layout)
            if let from, let to, set.contains(from) && set.contains(to) || from == id || to == id {
                set.insert(from); set.insert(to)
            }
        }
        return set
    }

    private func edgeNode(_ index: Int, _ layout: CanvasLayout) -> String? {
        index >= 0 && index < layout.nodes.count ? layout.nodes[index].id : index == -1 ? layout.next?.id : nil
    }

    /// The action bar follows the pointer without delay and stays while the pointer is on it.
    private func point(_ id: String?) {
        leaveTask?.cancel()
        if let id {
            pointed = id
            refreshActionBar()
        } else {
            leaveTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(160))
                guard !Task.isCancelled else { return }
                self?.pointed = nil
                self?.refreshActionBar()
            }
        }
    }

    private static func actionable(_ node: CanvasNode) -> Bool {
        switch node.kind {
        case .header, .fold, .unknown: false
        default: true
        }
    }

    // MARK: Marks and files under the pointer

    private func pointerMoved(_ point: CGPoint?) {
        guard let point, let layout, let id = surface.item(at: point), let node = nodesById[id], !surface.isMorphing else {
            setMark(nil); setFile(nil)
            return
        }
        let world = surface.worldPoint(forScreen: point)
        let x = world.x - node.x, y = world.y - node.y
        switch node.kind {
        case .tools(let tools):
            let pad = layout.metrics.strip["pad"] ?? 6, marks = layout.metrics.strip["marks"] ?? 20, callout = layout.metrics.strip["callout"] ?? 17
            let below = pad + marks + 2
            var hit: Int?
            if y >= below {
                let row = Int(((y - below) / callout).rounded(.down))
                hit = tools.callouts.first { c in c.row == row && (c.side == "right" ? x >= c.x - 4 && x <= c.x + 6 + c.w : x >= c.x - 6 - c.w && x <= c.x + 4) }?.i
            } else {
                hit = nearestMark(tools.marks, x, scale: surface.camera.k)
            }
            setMark(hit.map { .init(node: id, index: $0) })
            setFile(nil)
        case .actor(let actor):
            let pad = layout.metrics.bar["pad"] ?? 4, label = layout.metrics.bar["label"] ?? 18, bar = layout.metrics.bar["bar"] ?? 12
            let inRow = y >= pad + label - 2 && y <= pad + label + bar + 2
            setMark(inRow ? nearestMark(actor.marks, x, scale: surface.camera.k).map { .init(node: id, index: $0) } : nil)
            setFile(nil)
        case .change(let change):
            setMark(nil)
            setFile(filePath(change, y, layout.metrics))
        default:
            setMark(nil); setFile(nil)
        }
    }

    private func nearestMark(_ marks: [CanvasMark], _ x: Double, scale: CGFloat) -> Int? {
        var best = max(5, 6 / Double(scale)), hit: Int?
        for (i, mark) in marks.enumerated() {
            let distance = x < mark.x ? mark.x - x : x > mark.x2 ? x - mark.x2 : 0
            if distance <= best { best = distance; hit = i }
        }
        return hit
    }

    private func filePath(_ change: CanvasNode.Change, _ y: Double, _ metrics: CanvasMetrics) -> String? {
        let head = metrics.change["head"] ?? 24, file = metrics.change["file"] ?? 22, line = metrics.change["line"] ?? 15
        let inset = metrics.change["inset"] ?? 5, gap = metrics.change["gap"] ?? 4
        var top = head
        for f in change.files {
            let lines = Double(f.preview?.count ?? 0)
            let block = file + (lines > 0 ? inset * 2 + lines * line + gap : 0)
            if y >= top && y < top + block { return f.path }
            top += block
        }
        return nil
    }

    private func setFile(_ path: String?) {
        guard path != fileHit else { return }
        fileHit = path
        updateLineage()
    }

    private func setMark(_ mark: CanvasPaintState.Mark?) {
        guard mark != marked else { return }
        marked = mark
        tipTask?.cancel()
        guard let mark else {
            tip = nil
            refreshTip()
            decorationsChanged()
            return
        }
        tipTask = Task { @MainActor [weak self] in
            guard let value = await self?.store?.tip(node: mark.node, index: mark.index), !Task.isCancelled, let self, marked == mark else { return }
            tip = (mark.node, mark.index, value)
            refreshTip()
            decorationsChanged()
        }
    }

    private func tipLine(_ node: CanvasNode, _ index: Int, _ layout: CanvasLayout) -> (x: Double, top: Double, bottom: Double)? {
        let mark: CanvasMark?
        switch node.kind {
        case .tools(let t): mark = t.marks.indices.contains(index) ? t.marks[index] : nil
        case .actor(let a): mark = a.marks.indices.contains(index) ? a.marks[index] : nil
        default: mark = nil
        }
        guard let mark, let ti = node.ti else { return nil }
        let si = layout.turns[ti].si
        let rows = layout.tracks.filter { $0.si == si }
        guard let top = rows.map(\.y).min(), let bottom = rows.map({ $0.y + $0.h }).max() else { return nil }
        return (node.x + mark.x, top, bottom)
    }

    // MARK: Overlays

    private func reposition() {
        placeActionBar()
        placeTip()
        placeLabels()
        placeDraft()
        placeNext()
    }

    private func hosted<V: View>(_ host: PassthroughHost, _ view: V) {
        host.rootView = AnyView(view.environment(\.palette, palette))
        host.layoutSubtreeIfNeeded()
        host.setFrameSize(host.fittingSize)
    }

    private func refreshActionBar() {
        guard let layout, let id = pointed, let node = nodesById[id], replay == nil, surface.band != .far, id != selectedId, tip == nil else {
            actionHost.isHidden = true
            return
        }
        let turn = node.ti.map { layout.turns[$0] }
        var facts: [String] = []
        switch node.kind {
        case .agent(let a): if let elapsed = a.elapsed { facts.append(elapsed) }
        case .actor(let a): if let elapsed = a.elapsed { facts.append(elapsed) }
        default: break
        }
        if let tokens = turn?.tokens, tokens > 0 { facts.append("\(Self.compact(tokens)) tokens") }
        let forkable = forkTarget(node)
        let key = forkable.map { "\($0.session)|\($0.run)" }
        hosted(actionHost, CanvasActionBar(
            facts: facts, strings: strings, canCopy: Self.canCopy(node), canOpen: { if case .actor = node.kind { false } else { true } }(),
            forking: forkable == nil ? nil : forking.contains(key ?? ""),
            onPoint: { [weak self] on in self?.point(on ? id : nil) },
            onCopy: { [weak self] in self?.copy(node) },
            onOpen: { [weak self] in self?.openInChat(node) },
            onFork: { [weak self] in self?.openFork(node) },
            onDetails: { [weak self] in self?.select(node) }
        ))
        actionHost.isHidden = false
        placeActionBar()
    }

    private func placeActionBar() {
        guard !actionHost.isHidden, let id = pointed, let node = nodesById[id] else { return }
        let c = surface.camera
        let right = (node.x + node.w) * c.k + c.x
        let top = max(40, node.y * c.k + c.y - 6)
        actionHost.setFrameOrigin(CGPoint(x: right - actionHost.frame.width, y: top - actionHost.frame.height))
    }

    private func refreshTip() {
        guard let tip, surface.band != .far, nodesById[tip.node] != nil else {
            tipHost.isHidden = true
            refreshActionBar()
            return
        }
        hosted(tipHost, CanvasCallTip(tip: tip.value))
        tipHost.isHidden = false
        actionHost.isHidden = true
        placeTip()
    }

    private func placeTip() {
        guard !tipHost.isHidden, let tip, let node = nodesById[tip.node], let layout else { return }
        let c = surface.camera
        var x = 0.0, y = 0.0
        switch node.kind {
        case .tools(let t) where t.marks.indices.contains(tip.index):
            x = node.x + t.marks[tip.index].x; y = node.y + (layout.metrics.strip["pad"] ?? 6)
        case .actor(let a) where a.marks.indices.contains(tip.index):
            x = node.x + a.marks[tip.index].x; y = node.y + (layout.metrics.bar["pad"] ?? 4) + (layout.metrics.bar["label"] ?? 18)
        default: return
        }
        let size = tipHost.frame.size
        let screenX = min(max(x * c.k + c.x - size.width / 2, 8), max(8, surface.bounds.width - size.width - 8))
        tipHost.setFrameOrigin(CGPoint(x: screenX, y: max(8, y * c.k + c.y - 8 - size.height)))
    }

    /// Each track's name at the start of its row, held at the plane's left edge once the row's start has scrolled past.
    private func placeLabels() {
        guard let layout, surface.band != .far else {
            for (_, entry) in labelHosts { entry.host.isHidden = true }
            return
        }
        let c = surface.camera, size = surface.bounds.size
        var shown = Set<String>()
        let present = Set(layout.tracks.map(\.id))
        for track in layout.tracks {
            let y = track.line * c.k + c.y
            let start = track.x * c.k + c.x, end = (track.x + track.w) * c.k + c.x
            if y < 40 || y > size.height - 20 || end < 160 || start > size.width { continue }
            shown.insert(track.id)
            let kind = track.kind.rawValue, external = track.external == true
            var entry = labelHosts[track.id]
            if entry == nil || entry!.name != track.name || entry!.kind != kind || entry!.external != external {
                let host = entry?.host ?? PassthroughHost()
                host.rootView = AnyView(CanvasTrackLabel(name: track.name, kind: track.kind, external: track.external == true).environment(\.palette, palette))
                host.layoutSubtreeIfNeeded()
                host.setFrameSize(host.fittingSize)
                if entry == nil { container.addSubview(host, positioned: .below, relativeTo: tipHost) }
                entry = (host, track.name, kind, external)
                labelHosts[track.id] = entry
            }
            guard let host = entry?.host else { continue }
            host.isHidden = false
            host.setFrameOrigin(CGPoint(x: max(12, start), y: y - host.frame.height / 2))
        }
        for (id, entry) in labelHosts where !shown.contains(id) { entry.host.isHidden = true }
        // Tracks that left the layout leave their hosts.
        for id in labelHosts.keys where !present.contains(id) {
            labelHosts[id]?.host.removeFromSuperview()
            labelHosts[id] = nil
        }
    }

    // MARK: Actions

    private static func canCopy(_ node: CanvasNode) -> Bool {
        switch node.kind {
        case .agent(let a): a.copy == true
        case .signal(let s): s.arrivals?.isEmpty == false
        case .header, .fold, .unknown: false
        default: true
        }
    }

    private static func compact(_ value: Int) -> String {
        guard value >= 1000 else { return String(value) }
        let thousands = Double(value) / 1000
        return String(format: value >= 10_000 ? "%.0fk" : "%.1fk", thousands)
    }

    private func copy(_ node: CanvasNode) {
        Task { @MainActor [weak self] in
            guard let text = await self?.store?.detail(node: node.id)?.copy, !text.isEmpty else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }

    /// Back in the conversation, at this turn's question.
    func openInChat(_ node: CanvasNode) {
        guard let layout else { return }
        let turn = node.ti.map { layout.turns[$0] }
        let session: String?
        if case .header(let header) = node.kind { session = layout.sessions.indices.contains(header.si) ? layout.sessions[header.si].id : nil }
        else { session = turn.flatMap { layout.sessions.indices.contains($0.si) ? layout.sessions[$0.si].id : nil } }
        guard let session else { return }
        var focus: TranscriptFocus?
        if let native = turn?.nativeId { focus = TranscriptFocus(sessionId: session, messageIds: [native], exact: true) }
        if session == self.session.id {
            if let focus { workbench.focus = focus }
            showTranscript()
        } else {
            workbench.open(sessionId: session, focus: focus)
        }
    }

    /// A finished turn with a run can be continued from in a fork.
    private func forkTarget(_ node: CanvasNode) -> (session: String, run: String)? {
        guard case .agent = node.kind, let layout, let ti = node.ti else { return nil }
        let turn = layout.turns[ti]
        guard let run = turn.runId, !turn.isRunning, layout.sessions.indices.contains(turn.si) else { return nil }
        return (layout.sessions[turn.si].id, run)
    }

    private func openFork(_ node: CanvasNode) {
        guard forkTarget(node) != nil else { return }
        clickTask?.cancel()
        // The card's lower edge, with room under it for the field.
        reveal(CGRect(x: node.x, y: node.y + max(0, node.h - 48), width: node.w, height: min(node.h, 48)), top: 56, bottom: 96)
        showDraft(for: node)
    }

    private func sendFork(node: CanvasNode, text: String) {
        guard let target = forkTarget(node), let store else { return }
        let key = "\(target.session)|\(target.run)"
        closeDraft()
        forkTexts[key] = nil
        forking.insert(key)
        refreshActionBar()
        Task { @MainActor [weak self] in
            let made = await store.fork(session: target.session, runId: target.run, note: text)
            guard let self else { return }
            if !made, !text.isEmpty { forkTexts[key] = text }
            forking.remove(key)
            refreshActionBar()
        }
    }

    // MARK: Fork draft

    private func showDraft(for node: CanvasNode) {
        guard let target = forkTarget(node) else { return }
        closeDraft()
        let key = "\(target.session)|\(target.run)"
        let view = CanvasForkDraftView(initial: forkTexts[key] ?? "", placeholder: strings["continueFromHere"] ?? "", accessibility: strings["forkFromHere"] ?? "")
        view.onChange = { [weak self] text in self?.forkTexts[key] = text }
        view.onSend = { [weak self] text in self?.sendFork(node: node, text: text) }
        view.onClose = { [weak self] in self?.closeDraft() }
        view.onResize = { [weak self] in self?.placeDraft() }
        styleDraft(view)
        container.addSubview(view)
        draftView = view
        draftNode = node.id
        placeDraft()
        view.focus()
        pressMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            guard let self, let view = draftView, event.window === view.window else { return event }
            let point = view.convert(event.locationInWindow, from: nil)
            if !view.bounds.contains(point) { closeDraft() }
            return event
        }
    }

    private func styleDraft(_ view: CanvasForkDraftView) {
        draftSize = nil
        view.apply(background: palette.nsColor(\.bgPopover), ink: palette.nsColor(\.fg), hint: palette.nsColor(\.fg4), primary: palette.nsColor(\.primary), onPrimary: palette.nsColor(\.primaryFg))
    }

    private func closeDraft() {
        if let pressMonitor { NSEvent.removeMonitor(pressMonitor) }
        pressMonitor = nil
        // The keyboard was in the draft: back to the plane, as when the next-question panel closes.
        if let window = surface.window, let view = draftView, let responder = window.firstResponder as? NSView, responder.isDescendant(of: view) {
            window.makeFirstResponder(surface)
        }
        draftView?.removeFromSuperview()
        draftView = nil
        draftNode = nil
        draftSize = nil
    }

    /// Under the card's lower edge, as wide as the card within 280...440, inside the plane (less the inspector).
    private func placeDraft() {
        guard let view = draftView, let id = draftNode, let node = nodesById[id] else { return }
        let c = surface.camera, size = surface.bounds.size
        let open = size.width - (selectedNode != nil ? Self.inspectorWidth : 0)
        let width = max(120, min(max(node.w * c.k, 280), 440, open - 24))
        // Measuring lays the text out: only when the width or the text moved.
        let text = view.content
        let height: CGFloat
        if let cached = draftSize, cached.width == width, cached.text == text { height = cached.height }
        else { height = view.height(for: width); draftSize = (text: text, width: width, height: height) }
        let x = min(max(node.x * c.k + c.x, 12), max(12, open - width - 12))
        let y = min(max((node.y + node.h) * c.k + c.y + 8, 12), max(12, size.height - height - 12))
        view.frame = NSRect(x: x, y: y, width: width, height: height)
    }

    // MARK: Selection and clicks

    private func clicked(_ id: String?) {
        if surface.window?.firstResponder !== surface, !(surface.window?.firstResponder is NSTextView) { surface.window?.makeFirstResponder(surface) }
        guard let id, let layout else { return }
        if id == layout.next?.id { openNext(); return }
        guard let node = nodesById[id], Self.selectable(node) else { return }
        if let item = shelfItem(node) { showLightbox(node: node, item: item); return }
        let call = marked.flatMap { $0.node == id ? $0.index : nil }
        clickTask?.cancel()
        // A double-click opens the card in place, so a single click waits a beat before opening the inspector.
        clickTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(230))
            guard !Task.isCancelled, let self else { return }
            focusIndex = call
            if selectedId == id, call == nil { deselect() } else { select(node) }
        }
    }

    private func doubleClicked(_ id: String?) {
        clickTask?.cancel()
        guard let id, let node = nodesById[id] else { return }
        switch node.kind {
        case .header, .fold: openInChat(node)
        case .unknown: break
        default: zoomInto(node)
        }
    }

    private static func selectable(_ node: CanvasNode) -> Bool {
        switch node.kind {
        case .header, .fold, .unknown: false
        default: true
        }
    }

    /// Brings a card to reading size, which opens it: switch level first, then fly to the opened card.
    private func zoomInto(_ node: CanvasNode) {
        moved = true
        surface.userMoved()
        setHovered(nil)
        if level == .summary {
            flying = (node.id, CACurrentMediaTime() + 1.2)
            setLevel(.detail)
            return
        }
        surface.animateTo(surface.centering(CGPoint(x: node.x + node.w / 2, y: node.y + min(node.h, 360) / 2), k: max(1.05, surface.camera.k), fx: 0.45, fy: 0.42), duration: 0.56)
    }

    /// The inspector takes the right of the plane; a card it would cover slides into the space left.
    func select(_ node: CanvasNode) {
        clickTask?.cancel()
        selectedId = node.id
        selectedNode = node
        detail = nil
        loadDetail(node)
        decorationsChanged()
        let c = surface.camera
        let open = surface.bounds.width - Self.inspectorWidth
        let left = node.x * c.k + c.x, right = left + node.w * c.k
        if right > open - 24 || left < 24 {
            surface.userMoved()
            surface.animateTo(SurfaceCamera(x: c.x + (open / 2 - (left + right) / 2), y: c.y, k: c.k), duration: 0.38)
        }
        refreshActionBar()
        placeDraft()
        placeNext()
    }

    func deselect() {
        selectedId = nil
        selectedNode = nil
        detail = nil
        focusIndex = nil
        detailVersion = ""
        decorationsChanged()
        placeDraft()
        placeNext()
    }

    private func loadDetail(_ node: CanvasNode) {
        detailVersion = node.v
        let id = node.id
        Task { @MainActor [weak self] in
            let value = await self?.store?.detail(node: id)
            guard let self, selectedId == id else { return }
            detail = value
        }
    }

    // MARK: Lightbox

    private func shelfItem(_ node: CanvasNode) -> CanvasNode.Artifacts.Item? {
        guard case .artifacts(let shelf) = node.kind, let layout, let point = surface.pointer else { return nil }
        let world = surface.worldPoint(forScreen: point)
        let x = world.x - node.x, y = world.y - node.y
        let w = layout.metrics.art["w"] ?? 96, gap = layout.metrics.art["gap"] ?? 10, h = layout.metrics.art["h"] ?? 64
        let index = Int((x / (w + gap)).rounded(.down))
        guard shelf.items.indices.contains(index), y >= 0, y <= h, x - Double(index) * (w + gap) <= w, shelf.items[index].kind == "image" else { return nil }
        return shelf.items[index]
    }

    private func showLightbox(node: CanvasNode, item: CanvasNode.Artifacts.Item) {
        guard let layout, let ti = node.ti, layout.sessions.indices.contains(layout.turns[ti].si) else { return }
        openViewer(key: item.key, name: item.name, session: layout.sessions[layout.turns[ti].si].id, path: item.path, inline: nil, inlineNode: item.inline == true ? node.id : nil)
    }

    /// The app's image viewer, from the thumbnail the card has.
    func openViewer(key: String, name: String, session: String, path: String?, inline src: String?, inlineNode: String? = nil) {
        let thumb = store?.images.image(key).map { NSImage(cgImage: $0, size: NSSize(width: $0.width, height: $0.height)) }
        let projectId = workbench.list.sessions.first { $0.id == session }?.projectId
        func present(_ source: TimelineImageSource) {
            guard let image = thumb ?? NSImage(systemSymbolName: "photo", accessibilityDescription: nil) else { return }
            ImageViewer.shared.show(image: image, source: source, projectId: projectId, label: name)
        }
        if let src { present(.url(src)); return }
        if let path, let url = URL(string: workbench.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/sessions/\(session.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? session)/media?path=\(path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path)") {
            present(.url(url.absoluteString))
        } else if let inlineNode {
            Task { @MainActor [weak self] in
                guard let detail = await self?.store?.detail(node: inlineNode), let src = detail.items?.first(where: { $0.key == key })?.src else { return }
                present(.url(src))
            }
        } else if key.count > 0 {
            present(.attachment(key))
        }
    }

    // MARK: Next question

    /// The slot was pressed: it comes into view with room for the composer's menus above and the composer below, and the
    /// conversation's own composer opens over it. A press on it again keeps it open.
    private func openNext() {
        guard let next = layout?.next, replay == nil else { return }
        closeDraft()
        reveal(CGRect(x: next.x, y: next.y, width: next.w, height: next.h), top: Self.menuRoom, bottom: Self.composerRoom, minK: Self.writeZoom)
        let wasOpen = nextOpen
        nextOpen = true
        placeNext()
        if nextMonitor == nil {
            nextMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
                self?.pressed(event)
                return event
            }
        }
        if !wasOpen {
            Task { @MainActor [weak self] in
                guard let self, nextOpen else { return }
                NotificationCenter.default.post(name: .riffetFocusComposer, object: workbench)
            }
        }
    }

    func closeNext() {
        if let nextMonitor { NSEvent.removeMonitor(nextMonitor) }
        nextMonitor = nil
        guard nextOpen else { return }
        nextOpen = false
        // Back to the plane, so the keyboard is not left in a view that is gone.
        if let window = surface.window, window.firstResponder is NSTextView { window.makeFirstResponder(surface) }
    }

    /// A press on the plane outside the panel closes it; the panel, its menus and the other controls are not the plane.
    private func pressed(_ event: NSEvent) {
        guard nextOpen, let window = container.window, event.window === window, let content = window.contentView else { return }
        let hit = content.hitTest(content.convert(event.locationInWindow, from: nil))
        guard let hit, hit.isDescendant(of: container) else { return }
        let point = container.convert(event.locationInWindow, from: nil)
        if !nextAnchor.slot.contains(point) { closeNext() }
    }

    /// Follows the slot: its screen box, and the room the panel may take (the plane less the inspector).
    private func placeNext() {
        guard nextOpen else { return }
        guard let next = layout?.next else { closeNext(); return }
        let c = surface.camera, size = surface.bounds.size
        let slot = CGRect(x: next.x * c.k + c.x, y: next.y * c.k + c.y, width: next.w * c.k, height: next.h * c.k)
        if nextAnchor.slot != slot { nextAnchor.slot = slot }
        let open = size.width - (selectedNode != nil ? Self.inspectorWidth : 0)
        if nextAnchor.open != open { nextAnchor.open = open }
        if nextAnchor.viewHeight != size.height { nextAnchor.viewHeight = size.height }
    }

    /// The composer is sending: the slot stands as a pending question until the outline has the turn (30 s at most).
    func noteSending(_ sendingNow: Bool) {
        guard sendingNow, !sending else { return }
        closeNext()
        let live = workbench.selected?.state.isActive == true
        awaiting = !live
        moved = false
        // Into a running turn the composer steers or queues: no new question comes of it.
        guard !live else { store?.refreshOutline(); return }
        sending = true
        sendingSince = Date()
        sendingTurns = focusTurnCount
        store?.setNext(Self.wantsNext, sending: true)
        decorationsChanged()
        sendingTask?.cancel()
        sendingTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.store?.refreshOutline()
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { return }
                if focusTurnCount > sendingTurns || Date().timeIntervalSince(sendingSince ?? .now) > 30 { endSending(); return }
            }
        }
    }

    private func endSending() {
        sending = false
        awaiting = false
        store?.setNext(Self.wantsNext, sending: false)
    }

    private var focusTurnCount: Int {
        guard let layout, let index = layout.sessions.firstIndex(where: { $0.id == session.id }) else { return 0 }
        return layout.turns.filter { $0.si == index }.count
    }

    // MARK: Replay

    func startReplay() {
        guard !moments.isEmpty, replay == nil, let layout else { return }
        closeDraft()
        closeNext()
        moved = true
        replay = Replay(index: 0, playing: true)
        surface.userMoved()
        surface.animateTo(surface.framing(CGRect(x: layout.bounds.x, y: layout.bounds.y, width: layout.bounds.w, height: layout.bounds.h), maxK: 0.8), duration: 0.52)
        replayChanged()
    }

    func endReplay() {
        replay = nil
        replayTask?.cancel()
        replayChanged()
    }

    func setReplayIndex(_ index: Int) {
        guard replay != nil else { return }
        replay = Replay(index: index, playing: false)
        replayChanged()
    }

    func toggleReplay() {
        guard var current = replay else { return }
        if current.playing { current.playing = false } else { current = Replay(index: current.index >= moments.count - 1 ? 0 : current.index, playing: true) }
        replay = current
        replayChanged()
    }

    private func replayChanged() {
        if let layout, scene != nil { apply(layout, first: false, refresh: true) }
        replayTask?.cancel()
        guard replay?.playing == true else { return }
        let interval = min(0.6, max(0.06, 14 / Double(max(moments.count, 1))))
        replayTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(interval))
                guard let self, !Task.isCancelled, var current = replay, current.playing else { return }
                if current.index >= moments.count - 1 { current.playing = false } else { current.index += 1 }
                replay = current
                if let layout { apply(layout, first: false, refresh: true) }
                if !current.playing { return }
            }
        }
    }

    // MARK: Pulse, Escape

    private func pulsesChanged(_ pulses: [String: CanvasPulse]) {
        let changed = lastPulses != pulses
        lastPulses = pulses
        if changed, let scene {
            scene.setPulses(pulses)
            // Only a running answer's card holds a pulse: its version is the one that moves.
            itemsChanged()
        }
        guard let layout, let index = layout.sessions.firstIndex(where: { $0.id == session.id }) else { pulse = nil; return }
        let running = layout.turns.first { $0.si == index && $0.isRunning }
        let value = running?.runId.flatMap { pulses[$0] }
        if value != pulse { pulse = value }
    }

    /// The topmost thing closes first: the next question's composer, then a fork draft, the replay, then the inspector.
    private func escape() -> Bool {
        if nextOpen { closeNext(); return true }
        if draftView != nil { closeDraft(); return true }
        if replay != nil { endReplay(); return true }
        if selectedId != nil { deselect(); return true }
        return false
    }

    // MARK: Inspector hooks

    /// A subagent's steps opened or closed from the inspector.
    func toggleLane(session: String, lane: String, open: Bool) { store?.toggleLane(session: session, lane: lane, open: open) }

    func nodeSession(_ node: CanvasNode) -> String? {
        guard let layout, let ti = node.ti, layout.sessions.indices.contains(layout.turns[ti].si) else { return nil }
        return layout.sessions[layout.turns[ti].si].id
    }

    func canFork(_ node: CanvasNode) -> Bool? {
        guard let target = forkTarget(node) else { return nil }
        return forking.contains("\(target.session)|\(target.run)")
    }

    /// A file in the files panel, when the project it belongs to is the one that is open.
    func openPath(_ path: String) {
        if workbench.currentProjectId == session.projectId { workbench.preview(path: path) }
    }

    func fork(_ node: CanvasNode) { openFork(node) }
    func open(_ node: CanvasNode) { openInChat(node) }
    func image(_ key: String) -> CGImage? { store?.images.image(key) }
    var projectId: String { session.projectId }
    var canReplay: Bool { !moments.isEmpty }
    var momentCount: Int { moments.count }
    func markBroken(_ key: String) { store?.markBroken(key) }
}

/// The next question's slot on screen, read by the composer panel alone: the camera writes it every frame.
@MainActor
@Observable
final class CanvasNextAnchor {
    var slot = CGRect.zero
    var open: CGFloat = 0
    var viewHeight: CGFloat = 0
    /// The panel's own height, which keeps it inside the plane.
    var height: CGFloat = 0
}

/// A hosting view that is only as large as its content and, unless it has buttons, lets the pointer through to the plane.
final class PassthroughHost: NSHostingView<AnyView> {
    var passesClicks = true

    convenience init(passesClicks: Bool = true) {
        self.init(rootView: AnyView(EmptyView()))
        self.passesClicks = passesClicks
        sizingOptions = []
        autoresizingMask = []
    }

    override func hitTest(_ point: NSPoint) -> NSView? { passesClicks ? nil : super.hitTest(point) }
}

/// The palette before the page has read one from its environment.
enum PaletteEnvironmentDefault {
    @MainActor static var value: Palette { EnvironmentValues().palette }
}

private extension NSColor {
    func resolvedCGColor(_ appearance: NSAppearance) -> CGColor {
        var out = cgColor
        appearance.performAsCurrentDrawingAppearance { out = self.cgColor }
        return out
    }
}
