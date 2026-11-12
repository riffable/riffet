import AppKit
import QuartzCore
import os

/// A pannable, zoomable plane of items, drawn natively.
///
/// A layer-hosting view with one world layer: the camera is a single transform on it, so a pan or zoom changes one
/// property and nothing else. Items are plain layers whose contents are bitmaps from `RasterScheduler`; decorations are
/// shape layers whose widths are kept at screen pixels. Which items exist on screen, which get bitmaps and what is under
/// the pointer all come from a spatial grid, so a frame costs by what is visible, not by how large the plane is.
///
/// Coordinates: world and camera space are y down (like the web canvas); the layer tree underneath is y up and is
/// negated here. Overlay views (text fields, popovers) must be siblings of this view, not subviews: AppKit does not
/// support subviews in a layer-hosting view. Position them with `screenRect(forWorld:)`, then flip y with `bounds.height`.
final class CanvasSurfaceView: NSView {
    // MARK: public surface

    var renderer: SurfaceRenderer? { didSet { scheduler.renderer = renderer; replan() } }
    var onCameraChange: ((SurfaceCamera) -> Void)?
    var onBandChange: ((ZoomBand) -> Void)?
    /// The reader moved the camera by hand (wheel, pinch, drag), as opposed to code doing it.
    var onUserMove: (() -> Void)?
    var onHover: ((String?) -> Void)?
    /// The pointer moved over the plane (camera space) or left it; for hit tests finer than an item.
    var onPointer: ((CGPoint?) -> Void)?
    var onClick: ((String?) -> Void)?
    var onDoubleClick: ((String?) -> Void)?
    /// Per-frame main-thread cost, for the bench harness and instruments: (frame time, seconds spent, a morph is running).
    var onTick: ((CFTimeInterval, CFTimeInterval, Bool) -> Void)?
    /// Megabytes of bitmaps held, attached or cached; evicted by distance from the viewport above it.
    var memoryBudget: Int { get { scheduler.budget >> 20 } set { scheduler.budget = newValue << 20 } }
    var surfaceBackground: CGColor? { get { layer?.backgroundColor } set { layer?.backgroundColor = newValue } }

    private(set) var band: ZoomBand = .close
    /// Where the pointer is over the plane, in camera space.
    private(set) var pointer: CGPoint?
    var residentBytes: Int { scheduler.residentBytes }
    var peakResidentBytes: Int { scheduler.peakBytes }
    var itemCount: Int { nodes.count }
    var isMorphing: Bool { morphEnd > CACurrentMediaTime() }

    /// The camera as of now, following a flight in progress.
    var camera: SurfaceCamera { live(at: CACurrentMediaTime()) }

    /// Everything the reader sees is sharp and nothing is moving or pending.
    var isIdle: Bool { isSharp && !isMorphing && !hoverPending && scheduler.isIdle }

    /// Like `isIdle` but ignoring a morph still gliding and the margin that is only prefetched: every bitmap for what is
    /// on screen has landed. The catch-all plan that follows 120ms of stillness is not waited for either.
    var isSharp: Bool {
        flight == nil && zoomTarget == nil && !cameraDirty && !forceWindow && scheduler.screenReady(windowNodes)
    }

    // MARK: state

    private let world = CALayer(), decorLayer = CALayer(), itemsLayer = CALayer()
    private var nodes: [SurfaceNode] = []
    private var nodeById: [String: SurfaceNode] = [:]
    private var grid = SpatialGrid()
    private var scratch: [Int32] = []
    private var hitScratch: [Int32] = []
    private var applyToken = 0
    private let scheduler = RasterScheduler()

    private var model = SurfaceCamera(x: 0, y: 0, k: 1)
    private struct Flight { let from: SurfaceCamera, to: SurfaceCamera, start: CFTimeInterval, duration: CFTimeInterval, easing: SurfaceEasing }
    private var flight: Flight?
    private var zoomTarget: SurfaceCamera?
    private var zoomLast: CFTimeInterval = 0
    private var smartRestore: SurfaceCamera?

    private var cameraDirty = true, forceWindow = true, settlePending = false, hoverPending = false
    private var lastChange: CFTimeInterval = 0
    private var processed: SurfaceCamera?
    private var strokeK: CGFloat = 0

    private var windowNodes: [SurfaceNode] = []
    private var windowRect = CGRect.null
    private var windowK: CGFloat = 0
    private var windowSize = CGSize.zero
    private var windowToken = 0

    private var decorations: [String: (layer: CAShapeLayer, spec: SurfaceDecoration)] = [:]
    private var decorOrder: [String] = []

    private var morphEnd: CFTimeInterval = 0
    private var placeholdersFar = false
    private var morphSignpost: OSSignpostIntervalState?

    private var link: CADisplayLink?
    private var hoverId: String?
    private var dimLit: Set<String>?
    private var dimOpacity: Float = 0.45
    private var drag: (start: CGPoint, camera: SurfaceCamera, moved: Bool)?

    // MARK: setup

    override init(frame: NSRect) {
        super.init(frame: frame)
        let root = CALayer()
        layer = root
        wantsLayer = true
        world.anchorPoint = .zero
        world.position = .zero
        world.addSublayer(decorLayer)
        world.addSublayer(itemsLayer)
        root.addSublayer(world)
        scheduler.wake = { [weak self] in self?.wake() }
    }
    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        link?.invalidate()
        link = nil
        guard window != nil else { return }
        scheduler.backing = window?.backingScaleFactor ?? 2
        let l = displayLink(target: self, selector: #selector(linkFired(_:)))
        l.add(to: .main, forMode: .common)
        link = l
        forceWindow = true
        cameraDirty = true
        wake()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        let scale = window?.backingScaleFactor ?? 2
        guard scale != scheduler.backing else { return }
        scheduler.backing = scale
        scheduler.releaseAll()
        nodes.forEach { $0.invalidateLayouts() }
        replan()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        withoutActions { world.transform = transform(for: model) }
        forceWindow = true
        cameraDirty = true
        wake()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    // MARK: items

    /// Diffs by id and version: new ids get layers, gone ids lose theirs, a changed version keeps its old bitmap
    /// (at its own size, from the top) until the new one lands. Ids must be unique.
    func setItems(_ items: [SurfaceItem]) {
        withoutActions { apply(items, morph: nil) }
    }

    func setDecorations(_ list: [SurfaceDecoration]) {
        withoutActions { applyDecorations(list, fadeIn: 0) }
    }

    /// Union of the item frames.
    var contentBounds: CGRect {
        let boxes = nodes.filter { $0.item.interactive }.map { $0.item.hit ?? $0.frame }
        guard var box = boxes.first else { return .zero }
        for b in boxes.dropFirst() { box = box.union(b) }
        return box
    }

    // MARK: emphasis

    /// Items outside `lit` are drawn at `opacity` (nil: all at full), cross-fading; new items pick it up on the next call.
    func setDimmed(except lit: Set<String>?, opacity: Float = 0.45) {
        dimLit = lit
        dimOpacity = opacity
        for n in nodes {
            let target: Float = lit.map { !n.item.interactive || $0.contains(n.item.id) ? 1 : opacity } ?? 1
            if n.layer.opacity != target { n.layer.opacity = target }
        }
    }

    // MARK: camera

    func jump(to target: SurfaceCamera) {
        stopMotion()
        setModel(target)
    }

    /// Flies to `target`; Core Animation runs the motion and the surface samples the same curve for culling and bitmaps.
    func animateTo(_ target: SurfaceCamera, duration: CFTimeInterval = 0.42, easing: SurfaceEasing = .outCubic) {
        let from = camera
        stopMotion()
        var target = target
        target.k = SurfaceCamera.clampK(target.k)
        guard duration > 0, !reduceMotion, target != from else { setModel(target); return }
        withoutActions {
            model = target
            world.transform = transform(for: target)
            let a = CABasicAnimation(keyPath: "transform")
            a.fromValue = NSValue(caTransform3D: transform(for: from))
            a.toValue = NSValue(caTransform3D: transform(for: target))
            a.duration = duration
            a.timingFunction = easing.timingFunction
            world.add(a, forKey: "camera")
        }
        flight = Flight(from: from, to: target, start: CACurrentMediaTime(), duration: duration, easing: easing)
        cameraDirty = true
        wake()
    }

    /// The camera that shows `box` whole, at most at `maxK`, with `padding` points around it.
    func framing(_ box: CGRect, maxK: CGFloat = 1, padding: CGFloat = 64) -> SurfaceCamera {
        let k = SurfaceCamera.clampK(min(maxK, (bounds.width - padding * 2) / max(box.width, 1), (bounds.height - padding * 2) / max(box.height, 1)))
        return SurfaceCamera(x: bounds.width / 2 - box.midX * k, y: bounds.height / 2 - box.midY * k, k: k)
    }

    /// The camera that puts world point `p` at the screen fraction (`fx`, `fy`).
    func centering(_ p: CGPoint, k: CGFloat, fx: CGFloat = 0.5, fy: CGFloat = 0.5) -> SurfaceCamera {
        SurfaceCamera(x: bounds.width * fx - p.x * k, y: bounds.height * fy - p.y * k, k: k)
    }

    func fit(_ box: CGRect? = nil, animated: Bool = true) {
        let target = framing(box ?? contentBounds, maxK: 2)
        if animated { animateTo(target) } else { jump(to: target) }
    }

    /// The world moved under the camera by (`dx`, `dy`) world units: follow it, taking any motion under way along.
    func slide(dx: CGFloat, dy: CGFloat) {
        func by(_ c: SurfaceCamera) -> SurfaceCamera { SurfaceCamera(x: c.x - dx * c.k, y: c.y - dy * c.k, k: c.k) }
        if let z = zoomTarget { zoomTarget = by(z) }
        if let d = drag { drag = (d.start, by(d.camera), d.moved) }
        if flight != nil { animateTo(by(model)) } else { setModel(by(model)) }
    }

    // MARK: coordinates

    func worldPoint(forScreen p: CGPoint) -> CGPoint { camera.world(p) }
    func screenPoint(forWorld p: CGPoint) -> CGPoint { camera.screen(p) }
    /// Camera space (y down). For an overlay view's frame use `bounds.height - maxY` as the AppKit y.
    func screenRect(forWorld r: CGRect) -> CGRect { camera.screen(r) }

    /// The topmost smallest item containing the camera-space point, found through the grid.
    func item(at screen: CGPoint) -> String? {
        let w = camera.world(screen)
        grid.hits(w, into: &hitScratch)
        var best: Int32?
        var area = CGFloat.infinity
        for i in hitScratch {
            let n = nodes[Int(i)]
            guard n.item.interactive else { continue }
            let f = n.item.hit ?? n.frame
            if n.item.hit != nil, !f.contains(w) { continue }
            let a = f.width * f.height
            if a < area || (a == area && best.map({ i > $0 }) == true) { best = i; area = a }
        }
        return best.map { nodes[Int($0)].item.id }
    }

    // MARK: morph

    /// Re-forms the plane into `items`: frames glide from where they were to where they are, and the item at
    /// `anchorId` (or else the one nearest the pointer or centre) stays where the reader was looking. Decorations fade in.
    func morph(to items: [SurfaceItem], decorations list: [SurfaceDecoration], anchorId: String? = nil, duration: CFTimeInterval = 0.46, easing: SurfaceEasing = .outCubic) {
        let state = surfaceSignposter.beginInterval("morph")
        let c0 = camera
        stopMotion()
        let focus = pointer ?? CGPoint(x: bounds.width / 2, y: bounds.height / 2)
        let p = c0.world(focus)
        var anchor: SurfaceNode?
        var newFrames: [String: CGRect] = [:]
        for i in items { newFrames[i.id] = i.frame }
        if let id = anchorId, let n = nodeById[id], newFrames[id] != nil { anchor = n } else {
            var best = CGFloat.infinity
            for n in windowNodes where n.alive && newFrames[n.item.id] != nil {
                let f = n.frame
                let d = hypot(max(f.minX - p.x, 0, p.x - f.maxX), max(f.minY - p.y, 0, p.y - f.maxY))
                if d < best { best = d; anchor = n }
            }
        }
        var c1 = c0
        if let a = anchor, let after = newFrames[a.item.id] {
            let before = a.frame
            let inside = before.contains(p)
            let fx = inside ? (p.x - before.minX) / before.width : 0, fy = inside ? (p.y - before.minY) / before.height : 0
            let ax = before.minX + fx * before.width, ay = before.minY + fy * before.height
            let bx = after.minX + fx * after.width, by = after.minY + fy * after.height
            c1 = SurfaceCamera(x: c0.x + (ax - bx) * c0.k, y: c0.y + (ay - by) * c0.k, k: c0.k)
        }
        let animate = !reduceMotion && duration > 0
        // Every card changes at once: what will be on screen is drawn first, so no card shows its old self for a frame.
        let ahead = prerender(items, view: c1.visibleWorld(size: bounds.size, margin: 0.1))
        let plan = animate ? MorphPlan(dx: (c0.x - c1.x) / c0.k, dy: (c0.y - c1.y) / c0.k, duration: duration, easing: easing, view: c1.visibleWorld(size: bounds.size, margin: 0.25), fromPresentation: isMorphing) : nil
        withoutActions {
            model = c1
            world.transform = transform(for: c1)
            apply(items, morph: plan)
            for staged in ahead { if let n = nodeById[staged.id] { scheduler.adopt(n, staged) } }
            applyDecorations(list, fadeIn: animate ? duration : 0)
        }
        if animate {
            morphEnd = CACurrentMediaTime() + duration
            if let old = morphSignpost { surfaceSignposter.endInterval("morph", old) }
            morphSignpost = state
        } else {
            surfaceSignposter.endInterval("morph", state)
        }
        forceWindow = true
        cameraDirty = true
        wake()
    }

    /// What a morph is waiting for: the changed and new items in `view`, for at most two frames of 60 Hz. What misses it
    /// still lands as soon as it is done rather than waiting for the plan.
    private func prerender(_ items: [SurfaceItem], view: CGRect) -> [RasterScheduler.Staged] {
        let changed = items.filter { item in
            guard let n = nodeById[item.id] else { return true }
            return n.item.frame.size != item.frame.size || n.item.version != item.version
        }
        return scheduler.prerender(changed, view: view, wait: 0.034) { [weak self] staged in
            guard let self, let n = nodeById[staged.id] else { return }
            withoutActions { self.scheduler.adopt(n, staged) }
        }
    }

    private struct MorphPlan {
        let dx: CGFloat, dy: CGFloat, duration: CFTimeInterval, easing: SurfaceEasing, view: CGRect, fromPresentation: Bool
        /// Only frames that touch the view before or after are worth a glide; the rest jump.
        func glides(_ old: CGRect, _ new: CGRect) -> Bool { old.offsetBy(dx: dx, dy: dy).intersects(view) || new.intersects(view) }
    }

    // MARK: diff

    private func apply(_ items: [SurfaceItem], morph: MorphPlan?) {
        applyToken += 1
        var next: [SurfaceNode] = []
        next.reserveCapacity(items.count)
        var arrivals: [SurfaceNode] = []
        for item in items {
            if let n = nodeById[item.id] {
                guard n.mark != applyToken else { continue }
                n.mark = applyToken
                update(n, to: item, morph: morph)
                next.append(n)
            } else {
                let n = SurfaceNode(item, far: scheduler.far)
                n.mark = applyToken
                n.syncAccessories()
                if let lit = dimLit, item.interactive, !lit.contains(item.id) { n.layer.opacity = dimOpacity }
                nodeById[item.id] = n
                itemsLayer.addSublayer(n.layer)
                next.append(n)
                arrivals.append(n)
            }
        }
        for n in nodes where n.mark != applyToken {
            nodeById[n.item.id] = nil
            n.alive = false
            scheduler.release(n)
            // Gone at once, as on the web: fading out over what replaces it (a row re-formed under another id) doubles it.
            n.layer.removeFromSuperlayer()
        }
        nodes = next
        grid.rebuild(next.map(\.frame))
        if let m = morph {
            for n in arrivals where m.glides(n.frame, n.frame) { fade(n.layer, from: 0, to: 1, duration: m.duration) }
        } else if !reduceMotion {
            for n in arrivals where n.item.enter { enter(n) }
        }
        forceWindow = true
        cameraDirty = true
        wake()
    }

    private func update(_ n: SurfaceNode, to item: SurfaceItem, morph: MorphPlan?) {
        let old = n.item
        n.item = item
        let resized = old.frame.size != item.frame.size
        if resized || old.version != item.version {
            n.stamp &+= 1
            scheduler.invalidated(n, heightChange: resized ? item.frame.height - old.frame.height : nil)
        }
        n.syncAccessories()
        if old.z != item.z { n.layer.zPosition = item.z }
        if old.interactive != item.interactive, let lit = dimLit { n.layer.opacity = !item.interactive || lit.contains(item.id) ? 1 : dimOpacity }
        if old.farStyle != item.farStyle, !n.hasContent { n.placeholder(far: scheduler.far) }
        let moved = old.frame != item.frame
        guard moved || morph != nil else { return }
        // A morph interrupting a morph starts from where the layer is drawn, not from where it was going.
        let shown = morph?.fromPresentation == true ? n.layer.presentation() : nil
        let dx = morph?.dx ?? 0, dy = morph?.dy ?? 0
        let fromPosition = shown.map { CGPoint(x: $0.position.x + dx, y: $0.position.y - dy) } ?? CGPoint(x: old.frame.minX + dx, y: -old.frame.maxY - dy)
        if moved { n.sync() }
        guard let m = morph else { return }
        // The camera moved under the plane by (dx, dy): a card that stays put in the world must glide that back too, and one
        // that no longer glides drops an earlier morph's motion, which was made for the camera before.
        guard m.glides(old.frame, item.frame) else { n.layer.removeAnimation(forKey: "position"); return }
        guard moved || dx != 0 || dy != 0 || shown != nil else { return }
        // Like the web's, a card glides by its top-left corner at its new size: its bitmap is never stretched in between.
        let p = CABasicAnimation(keyPath: "position")
        p.fromValue = NSValue(point: CGPoint(x: fromPosition.x, y: fromPosition.y + old.frame.height - item.frame.height))
        p.toValue = NSValue(point: n.layer.position)
        p.duration = m.duration
        p.timingFunction = m.easing.timingFunction
        n.layer.add(p, forKey: "position")
        n.layer.removeAnimation(forKey: "bounds")
    }

    /// `canvas-enter`: 0.38 s, from transparent, 6 pt low and a hair small, to rest.
    private func enter(_ n: SurfaceNode) {
        let curve = SurfaceEasing.outCubic.timingFunction
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = n.layer.opacity
        let size = n.item.frame.size, s: CGFloat = 0.985
        // The layer scales about its corner: shift so the scale is about the middle (y is up here, so low is negative).
        var from = CATransform3DMakeTranslation(size.width * (1 - s) / 2, size.height * (1 - s) / 2 - 6, 0)
        from = CATransform3DScale(from, s, s, 1)
        let move = CABasicAnimation(keyPath: "transform")
        move.fromValue = NSValue(caTransform3D: from)
        move.toValue = NSValue(caTransform3D: CATransform3DIdentity)
        for a in [fade, move] {
            a.duration = 0.38
            a.timingFunction = curve
            n.layer.add(a, forKey: a.keyPath)
        }
    }

    private func fade(_ layer: CALayer, from: Float, to: Float, duration: CFTimeInterval) {
        let a = CABasicAnimation(keyPath: "opacity")
        a.fromValue = from
        a.toValue = to
        a.duration = duration
        a.timingFunction = CAMediaTimingFunction(name: .easeIn)
        layer.opacity = to
        layer.add(a, forKey: "fade")
    }

    // MARK: decorations

    private func applyDecorations(_ list: [SurfaceDecoration], fadeIn: CFTimeInterval) {
        var flip = CGAffineTransform(scaleX: 1, y: -1)
        var kept = Set<String>()
        for (index, spec) in list.enumerated() {
            kept.insert(spec.kind)
            var fresh = false
            let shape = decorations[spec.kind]?.layer ?? {
                let s = CAShapeLayer()
                s.lineJoin = .round
                s.lineCap = .round
                decorLayer.addSublayer(s)
                fresh = true
                return s
            }()
            shape.zPosition = CGFloat(index)
            shape.path = spec.path.copy(using: &flip)
            shape.strokeColor = spec.stroke
            shape.fillColor = spec.fill
            decorations[spec.kind] = (shape, spec)
            if fadeIn > 0 { fade(shape, from: 0, to: 1, duration: fadeIn) }
            else if fresh, spec.drawIn, !reduceMotion {
                // `canvas-draw`: the line writes itself from its start.
                let draw = CABasicAnimation(keyPath: "strokeEnd")
                draw.fromValue = 0
                draw.toValue = 1
                draw.duration = 0.7
                draw.timingFunction = SurfaceEasing.outCubic.timingFunction
                shape.add(draw, forKey: "draw")
            }
        }
        for (kind, entry) in decorations where !kept.contains(kind) {
            entry.layer.removeFromSuperlayer()
            decorations[kind] = nil
        }
        strokeK = 0
        applyStrokes(camera.k)
    }

    /// Line widths and dashes are given in screen pixels, so they are divided by the zoom.
    private func applyStrokes(_ k: CGFloat) {
        guard k != strokeK else { return }
        strokeK = k
        for (layer, spec) in decorations.values {
            let divisor = spec.worldUnits ? 1 : k
            layer.lineWidth = spec.lineWidth / divisor
            layer.lineDashPattern = spec.dash.map { $0.map { NSNumber(value: Double($0 / divisor)) } }
        }
    }

    // MARK: camera plumbing

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    private func transform(for c: SurfaceCamera) -> CATransform3D {
        CATransform3DScale(CATransform3DMakeTranslation(c.x, bounds.height - c.y, 0), c.k, c.k, 1)
    }

    private func live(at t: CFTimeInterval) -> SurfaceCamera {
        guard let f = flight else { return model }
        return .lerp(f.from, f.to, f.easing.value(CGFloat((t - f.start) / f.duration)))
    }

    private func setModel(_ c: SurfaceCamera) {
        var c = c
        c.k = SurfaceCamera.clampK(c.k)
        guard c != model || flight != nil else { return }
        model = c
        withoutActions { world.transform = transform(for: c) }
        cameraDirty = true
        wake()
    }

    /// Takes the camera as it is now and cancels flights, and zoom easing unless `keepZoom`; called before any hand input.
    private func stopMotion(keepZoom: Bool = false) {
        if flight != nil {
            let now = camera
            flight = nil
            model = now
            withoutActions {
                world.removeAnimation(forKey: "camera")
                world.transform = transform(for: now)
            }
        }
        if !keepZoom { zoomTarget = nil }
    }

    private func withoutActions(_ body: () -> Void) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body()
        CATransaction.commit()
    }

    private func replan() {
        settlePending = false
        cameraDirty = true
        forceWindow = true
        processed = nil
        wake()
    }

    func wake() { link?.isPaused = false }

    // MARK: frame

    @objc private func linkFired(_ link: CADisplayLink) {
        let t0 = CACurrentMediaTime()
        withoutActions { tick(link, now: t0) }
        onTick?(t0, CACurrentMediaTime() - t0, isMorphing)
        if isIdle && !settlePending { link.isPaused = true }
    }

    private func tick(_ link: CADisplayLink, now: CFTimeInterval) {
        if let target = zoomTarget {
            // Frame-rate independent smoothing: about 90% of the way in 120ms, like the web canvas.
            let dt = min(0.05, max(0.001, zoomLast > 0 ? link.timestamp - zoomLast : link.duration))
            zoomLast = link.timestamp
            let blend = 1 - exp(-dt / 0.052)
            let from = model
            let next = SurfaceCamera(x: from.x + (target.x - from.x) * blend, y: from.y + (target.y - from.y) * blend, k: from.k + (target.k - from.k) * blend)
            if abs(next.k - target.k) < 0.0005, abs(next.x - target.x) < 0.3, abs(next.y - target.y) < 0.3 {
                zoomTarget = nil
                zoomLast = 0
                setModel(target)
            } else {
                setModel(next)
            }
        }
        let sample = link.targetTimestamp
        if let f = flight {
            if sample >= f.start + f.duration { flight = nil }
            cameraDirty = true
        }
        if cameraDirty {
            cameraDirty = false
            processCamera(live(at: sample), now: now)
        }
        if settlePending, now - lastChange >= 0.12 {
            settlePending = false
            if !scheduler.far { scheduler.plan(windowNodes) }
        }
        scheduler.tick()
        if morphEnd > 0, now >= morphEnd {
            morphEnd = 0
            if let s = morphSignpost { surfaceSignposter.endInterval("morph", s); morphSignpost = nil }
        }
        if hoverPending, now - lastChange >= 0.08 {
            hoverPending = false
            updateHover()
        }
    }

    private func processCamera(_ sampled: SurfaceCamera, now: CFTimeInterval) {
        var cam = sampled
        let moved = cam != processed
        processed = cam
        // Far mode first, so what the band change below makes (a morph's new nodes) starts with the right placeholder.
        var replan = scheduler.update(camera: cam, size: bounds.size)
        if scheduler.far != placeholdersFar {
            placeholdersFar = scheduler.far
            // A node without a bitmap is a block far out and nothing closer in, whether or not it ever had one.
            for n in nodes where !n.hasContent { n.placeholder(far: placeholdersFar) }
        }
        if moved {
            lastChange = now
            settlePending = true
            let b = ZoomBand(k: cam.k)
            if b != band {
                band = b
                // The consumer usually answers with a morph, which moves the camera: carry on from where it left it.
                onBandChange?(b)
                if cameraDirty { cameraDirty = false; cam = live(at: CACurrentMediaTime()); processed = cam }
            }
            applyStrokes(cam.k)
            onCameraChange?(cam)
            if hoverId != nil { hoverId = nil; onHover?(nil) }
            if pointer != nil { hoverPending = true }
        }
        replan = scheduler.update(camera: cam, size: bounds.size) || replan
        if forceWindow || windowStale(cam) { refreshWindow(cam) } else if replan { scheduler.plan(windowNodes) }
    }

    // MARK: window

    /// The window is the part of the plane whose layers are shown, and the part the scheduler plans bitmaps for. It is
    /// retaken only when the view nears its edge or the zoom moved far from where it was taken, so most frames of a
    /// pan do no index work at all.
    private func windowStale(_ cam: SurfaceCamera) -> Bool {
        guard windowSize == bounds.size, windowK > 0 else { return true }
        let r = cam.k / windowK
        if r >= 1.6 || 1 / r >= 1.25 { return true }
        let edge = 0.35 * max(bounds.width, bounds.height) / cam.k
        return !windowRect.insetBy(dx: edge, dy: edge).contains(cam.visibleWorld(size: bounds.size))
    }

    private func refreshWindow(_ cam: SurfaceCamera) {
        forceWindow = false
        windowRect = cam.visibleWorld(size: bounds.size, margin: 0.6)
        windowK = cam.k
        windowSize = bounds.size
        grid.query(windowRect, into: &scratch)
        windowToken += 1
        var next: [SurfaceNode] = []
        next.reserveCapacity(scratch.count)
        for i in scratch {
            let n = nodes[Int(i)]
            if n.layer.isHidden { n.layer.isHidden = false }
            n.windowStamp = windowToken
            next.append(n)
        }
        for n in windowNodes where n.alive && n.windowStamp != windowToken { n.layer.isHidden = true }
        windowNodes = next
        scheduler.plan(next)
    }

    // MARK: hover and input helpers (used by the input extension)

    func updateHover() {
        guard let p = pointer else { return }
        let id = item(at: p)
        if id != hoverId { hoverId = id; onHover?(id) }
    }

    func setPointer(_ p: CGPoint?) {
        pointer = p
        onPointer?(p)
        if p == nil, hoverId != nil { hoverId = nil; onHover?(nil) }
    }

    func beginDrag(at p: CGPoint) {
        stopMotion()
        drag = (p, model, false)
    }

    func continueDrag(to p: CGPoint) {
        guard var d = drag else { return }
        let dx = p.x - d.start.x, dy = p.y - d.start.y
        if !d.moved {
            guard hypot(dx, dy) >= 4 else { return }
            d.moved = true
            drag = d
            userMoved()
            NSCursor.closedHand.push()
        }
        setModel(SurfaceCamera(x: d.camera.x + dx, y: d.camera.y + dy, k: d.camera.k))
    }

    /// Returns whether the press was a drag, in which case it is not also a click.
    func endDrag() -> Bool {
        defer { drag = nil }
        guard let d = drag else { return false }
        if d.moved { NSCursor.pop() }
        return d.moved
    }

    func userMoved() {
        stopMotion(keepZoom: true)
        smartRestore = nil
        onUserMove?()
    }

    func zoomEased(by factor: CGFloat, at p: CGPoint) {
        stopMotion(keepZoom: true)
        let base = zoomTarget ?? model
        let k = SurfaceCamera.clampK(base.k * factor)
        zoomTarget = SurfaceCamera(x: p.x - (p.x - base.x) * (k / base.k), y: p.y - (p.y - base.y) * (k / base.k), k: k)
        wake()
    }

    func panBy(dx: CGFloat, dy: CGFloat) {
        zoomTarget = nil
        stopMotion()
        setModel(SurfaceCamera(x: model.x + dx, y: model.y + dy, k: model.k))
    }

    func toggleSmartFit() {
        if let back = smartRestore {
            smartRestore = nil
            animateTo(back)
        } else {
            let here = camera
            animateTo(framing(contentBounds, maxK: 2))
            smartRestore = here
        }
    }

    func clickAt(_ p: CGPoint, count: Int) {
        let id = item(at: p)
        if count >= 2 { onDoubleClick?(id) } else { onClick?(id) }
    }
}
