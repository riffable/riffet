import AppKit
import QuartzCore

/// The canvas as the surface draws it: every node of a layout is an item painted by `CanvasNodePainter`; the ground of `CanvasGroundBuilder`
/// is surface decorations (frames, track lines, seams, edges) and non-interactive items under the cards (frame labels, times, silences,
/// seam token pills). The paint states (hover column, file focus, marked call, selection, a running turn's pulse) change an item's version
/// only for the items they touch, so a state change draws those cards again and no others. What moves (the sweep on a working card, live
/// dots, spinners) is an accessory layer of its item, and a new card or edge comes in with the web's animation.
@MainActor
final class CanvasWorldScene: CanvasScene {
    private let strings: CanvasStrings
    private let locale: String
    private let images: CanvasImages
    private var palette: RiffetPaletteValues
    private var dark: Bool
    private var faces: CanvasFaces
    /// Bumped when every bitmap is stale (theme, language, fonts), so versions change without the layout doing so.
    private var epoch = 0
    private var pulses: [String: CanvasPulse] = [:]
    private let drawer = Drawer()
    private let scratch = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CanvasPaint.srgb, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

    private var groundKey = 0
    private var ground: CanvasGround?
    /// The layout the ground was last checked against, held so its arrays' storage cannot be reused while it is compared by address.
    private var groundLayout: CanvasLayout?
    /// Counts ground rebuilds: what is derived from the ground is current while it stands.
    private var groundSerial = 0
    private var base: (serial: Int, cutoff: Double, list: [SurfaceDecoration])?
    private var plainEdges: (key: EdgeKey, list: [SurfaceDecoration])?
    private var accessoryCache: [String: (key: Int, specs: [CanvasAccessory])] = [:]
    /// Nodes and edges seen so far, so only those that arrive later come in with an animation; edges stay in their own layer while they draw in.
    private var knownNodes = Set<String>()
    private var knownEdges = Set<String>()
    private var knownLevel: CanvasLevel?
    private var edgeUntil: [String: CFTimeInterval] = [:]

    var renderer: SurfaceRenderer { drawer }

    init(strings: [String: String], locale: String, images: CanvasImages, palette: RiffetPaletteValues, dark: Bool, faces: CanvasFaces) {
        self.strings = CanvasStrings(strings, locale: locale)
        self.locale = locale
        self.images = images
        self.palette = palette
        self.dark = dark
        self.faces = faces
    }

    func invalidate(palette: RiffetPaletteValues, dark: Bool, faces: CanvasFaces) {
        self.palette = palette
        self.dark = dark
        self.faces = faces
        epoch += 1
        ground = nil
        groundLayout = nil
        base = nil; plainEdges = nil
        accessoryCache.removeAll()
    }

    func setPulses(_ pulses: [String: CanvasPulse]) { self.pulses = pulses }

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    private func paint(_ layout: CanvasLayout, far: Bool) -> CanvasPaint {
        var paint = CanvasPaint(palette: palette, dark: dark, metrics: layout.metrics, strings: strings, zoom: far ? 0.2 : 1, locale: locale)
        paint.faces = faces
        paint.layered = true
        let images = images
        paint.image = { images.image($0) }
        var names: [String: String] = [:]
        for session in layout.sessions { if let id = session.backend { names[id] = AgentDirectory.shared.label(id) } }
        let labels = names
        paint.backendLabel = { id in id.flatMap { labels[$0] } ?? CanvasPaint.defaultBackendLabel(id) }
        return paint
    }

    // MARK: Items

    /// What differs between two draws of one card besides its node: the states that reach it.
    struct Look: Hashable {
        var pulse: CanvasPulse?
        var focus: String?
        var marked: Int?
        var lit = false
        var hot = false
    }

    func items(for layout: CanvasLayout, state: CanvasPaintState) -> [SurfaceItem] {
        let paint = paint(layout, far: state.far)
        let box = Drawing(layout: layout, paint: paint)
        let block = SurfaceFarStyle(color: paint.fg(0.1), cornerRadius: 6)
        let clear = SurfaceFarStyle(color: CGColor(gray: 0, alpha: 0), cornerRadius: 0)
        let fresh = noteArrivals(layout)
        noteEdges(layout)
        var items: [SurfaceItem] = []
        items.reserveCapacity(layout.nodes.count + layout.gutter.count + 8)
        for node in layout.nodes where node.t <= state.cutoff {
            let look = look(of: node, layout, state)
            let version = Self.hash(node.v, epoch, look, imageBits(node))
            let outset = CanvasNodePainter.outset(of: node, paint: paint)
            let real = CGRect(x: node.x, y: node.y, width: node.w, height: node.h)
            var item = SurfaceItem(id: node.id, frame: real.insetBy(dx: -outset, dy: -outset), version: version, farStyle: block, content: Content(box: box, node: node, look: look, outset: outset))
            if outset > 0 { item.hit = real }
            item.enter = fresh.contains(node.id)
            item.accessories = accessories(node, layout: layout, paint: paint, look: look, version: version, outset: outset, far: state.far)
            items.append(item)
        }
        if let next = layout.next, !state.far, !state.replaying {
            let frame = CGRect(x: next.x, y: next.y, width: next.w, height: next.h)
            let sending = state.sending
            var item = SurfaceItem(id: next.id, frame: frame, version: Self.hash(sending ? "next|sending" : "next", epoch), farStyle: SurfaceFarStyle(color: paint.fg(0.04), cornerRadius: 14), content: Slot(box: box, sending: sending))
            item.enter = fresh.contains(next.id)
            if sending {
                let spin = CanvasAccessory(id: "spin", motion: .spin, frame: CGRect(x: next.w - 16 - 12, y: 12 + 3, width: 12, height: 12), path: CanvasIcons.path(.loaderCircle), stroke: paint.fg3, width: 1.25, cap: .round, scaleToIcon: true)
                item.accessories = [accessory(spin, version: item.version, outset: 0)]
            }
            items.append(item)
        }
        // The text of the ground lies under the cards and answers no pointer.
        for (index, d) in ground(for: layout, paint: paint).decorations.enumerated() where d.t <= state.cutoff && !(state.far && d.hiddenWhenFar) {
            if case .next = d.content { continue }
            let tag: Int = {
                switch d.content {
                case .frameLabel: 1
                case .time: 2
                case .silence: 3
                case .seamTokens: 4
                default: 5
                }
            }()
            var item = SurfaceItem(id: "ground|\(tag)|\(index)", frame: d.rect, version: Self.hash(String(describing: d.content), Int(d.rect.width), epoch), farStyle: clear, content: Decor(box: box, decoration: d))
            item.interactive = false
            item.z = -1
            items.append(item)
        }
        return items
    }

    /// Node ids that came after the first layout of this level, for the entrance.
    private func noteArrivals(_ layout: CanvasLayout) -> Set<String> {
        var ids = Set(layout.nodes.map(\.id))
        if let next = layout.next { ids.insert(next.id) }
        defer { knownNodes = ids }
        guard knownLevel == layout.level, !knownNodes.isEmpty, !reduceMotion else { return [] }
        return ids.subtracting(knownNodes)
    }

    /// Edges that arrive after the first layout of a level draw themselves in, for 0.7 s.
    private func noteEdges(_ layout: CanvasLayout) {
        var keys = Set<String>()
        let first = knownEdges.isEmpty || knownLevel != layout.level
        let now = CACurrentMediaTime()
        for edge in layout.edges where edge.kind != .fork {
            let key = Self.edgeKey(edge.kind, edge.from, edge.to, layout)
            keys.insert(key)
            if !first, !knownEdges.contains(key) { edgeUntil[key] = now + 0.7 }
        }
        knownEdges = keys
        knownLevel = layout.level
        edgeUntil = edgeUntil.filter { $0.value > now }
    }

    private func look(of node: CanvasNode, _ layout: CanvasLayout, _ state: CanvasPaintState) -> Look {
        var look = Look()
        switch node.kind {
        case .agent(let agent):
            if agent.running == true, let ti = node.ti, layout.turns.indices.contains(ti), let run = layout.turns[ti].runId { look.pulse = pulses[run] }
            look.lit = state.related?.contains(node.id) == true && state.hovered != node.id
            look.hot = state.pointer == node.id
        case .change(let change):
            if let path = state.focusPath, change.files.contains(where: { $0.path == path }) { look.focus = path }
        case .tools, .actor:
            if let mark = state.marked, mark.node == node.id { look.marked = mark.index }
        default: break
        }
        return look
    }

    /// Which of a card's thumbnails have arrived: a card is drawn again when this changes, and only then.
    private func imageBits(_ node: CanvasNode) -> Int {
        var bits = 0
        switch node.kind {
        case .user(let user):
            for (i, id) in (user.images ?? []).prefix(60).enumerated() where images.image(id) != nil { bits |= 1 << i }
        case .artifacts(let shelf):
            for (i, item) in shelf.items.prefix(60).enumerated() where item.kind == "image" && images.image(item.key) != nil { bits |= 1 << i }
        default: break
        }
        return bits
    }

    private static func hash(_ values: AnyHashable...) -> Int {
        var h = Hasher()
        for v in values { h.combine(v) }
        return h.finalize()
    }

    // MARK: Accessories

    private func accessories(_ node: CanvasNode, layout: CanvasLayout, paint: CanvasPaint, look: Look, version: Int, outset: CGFloat, far: Bool) -> [SurfaceAccessory] {
        switch node.kind {
        case .header(let h): guard h.live == true, !far else { return [] }
        case .agent(let a): guard a.running == true, !far else { return [] }
        case .actor(let a): guard a.running == true else { return [] }
        case .tools(let t): guard t.marks.contains(where: \.running) else { return [] }
        case .signal(let s): guard !far, s.arrivals?.contains(where: { $0.status == "running" }) == true else { return [] }
        default: return []
        }
        let key = Self.hash(version, far)
        let specs: [CanvasAccessory]
        if let hit = accessoryCache[node.id], hit.key == key { specs = hit.specs } else {
            var p = paint
            p.pulse = look.pulse; p.marked = look.marked; p.lit = look.lit; p.hot = look.hot
            let sink = CanvasAccessorySink()
            p.sink = sink
            CanvasNodePainter.draw(node, in: scratch, layout: layout, paint: p)
            specs = sink.items
            accessoryCache[node.id] = (key, specs)
        }
        return specs.map { accessory($0, version: key, outset: outset) }
    }

    private func accessory(_ spec: CanvasAccessory, version: Int, outset: CGFloat) -> SurfaceAccessory {
        let reduce = reduceMotion
        return SurfaceAccessory(id: spec.id, version: version, frame: spec.frame.offsetBy(dx: outset, dy: outset), make: { CanvasAccessoryLayers.make(spec, reduceMotion: reduce) })
    }

    // MARK: Ground

    private enum Tone: String { case plain, lit, faded }
    private struct Group {
        var path = CGMutablePath()
        var shape: CanvasShape
        var tone: Tone
    }

    /// Frames, track lines, seams and edges as shape layers, with the edge states of a hovered column and the selection ring.
    /// The frames, lines and seams depend on the ground and the replay cutoff alone, and the edges on the hover as well, so a hover
    /// or a mark change (most mouse moves over a strip) rebuilds at most the edges, and nothing while nothing is hovered.
    func decorations(for layout: CanvasLayout, state: CanvasPaintState) -> [SurfaceDecoration] {
        let paint = paint(layout, far: state.far)
        let ground = ground(for: layout, paint: paint)
        var out = baseDecorations(ground, cutoff: state.cutoff)
        let now = CACurrentMediaTime()
        let drawing = !reduceMotion && edgeUntil.values.contains { $0 > now }
        if state.related == nil, !drawing {
            let key = EdgeKey(serial: groundSerial, cutoff: state.cutoff, hidden: state.replaying || state.far)
            if let hit = plainEdges, hit.key == key {
                out += hit.list
            } else {
                let list = edgeDecorations(ground, layout: layout, state: state, paint: paint, now: now)
                plainEdges = (key, list)
                out += list
            }
        } else {
            out += edgeDecorations(ground, layout: layout, state: state, paint: paint, now: now)
        }
        if let selected = state.selected, let node = layout.nodes.first(where: { $0.id == selected }) {
            // `ring-2 ring-accent/50 ring-offset-2 ring-offset-[var(--canvas-paper)]`: two units of the paper, then two of the accent.
            let real = CGRect(x: node.x, y: node.y, width: node.w, height: node.h)
            let radius = Self.radius(of: node)
            out.append(Self.decoration("selection.offset", canvasRoundedRect(real.insetBy(dx: -1, dy: -1), radius + 1), stroke: paint.paper(), width: 2))
            out.append(Self.decoration("selection", canvasRoundedRect(real.insetBy(dx: -3, dy: -3), radius + 3), stroke: paint.accent(0.5), width: 2))
        }
        return out
    }

    private struct EdgeKey: Equatable { var serial: Int, cutoff: Double, hidden: Bool }

    private static func decoration(_ kind: String, _ path: CGPath, stroke: CGColor? = nil, fill: CGColor? = nil, width: CGFloat = 1, dash: [CGFloat] = []) -> SurfaceDecoration {
        var d = SurfaceDecoration(kind: kind, path: path, stroke: stroke, fill: fill, lineWidth: width, dash: dash.isEmpty ? nil : dash)
        d.worldUnits = true
        return d
    }

    private func baseDecorations(_ ground: CanvasGround, cutoff: Double) -> [SurfaceDecoration] {
        if let hit = base, hit.serial == groundSerial, hit.cutoff == cutoff { return hit.list }
        let frameFill = CGMutablePath(), frameBorder = CGMutablePath()
        var fillColor: CGColor?, borderColor: CGColor?
        let solid = CGMutablePath(), dotted = CGMutablePath(), seams = CGMutablePath()
        var trackColor: CGColor?, seamColor: CGColor?
        for shape in ground.shapes where shape.t <= cutoff {
            switch shape.role {
            case .frame:
                if shape.fill != nil { frameFill.addPath(shape.path); fillColor = shape.fill } else { frameBorder.addPath(shape.path); borderColor = shape.stroke }
            case .trackLine:
                if shape.dash.isEmpty { solid.addPath(shape.path) } else { dotted.addPath(shape.path) }
                trackColor = shape.stroke
            case .seam:
                seams.addPath(shape.path)
                seamColor = shape.stroke
            case .edge, .edgeEnd: break
            }
        }
        var out: [SurfaceDecoration] = []
        if !frameFill.isEmpty { out.append(Self.decoration("ground.frames.fill", frameFill, fill: fillColor)) }
        if !frameBorder.isEmpty { out.append(Self.decoration("ground.frames.border", frameBorder, stroke: borderColor)) }
        if !solid.isEmpty { out.append(Self.decoration("ground.tracks", solid, stroke: trackColor)) }
        if !dotted.isEmpty { out.append(Self.decoration("ground.tracks.external", dotted, stroke: trackColor, dash: [3, 4])) }
        if !seams.isEmpty { out.append(Self.decoration("ground.seams", seams, stroke: seamColor, dash: [4, 4])) }
        base = (groundSerial, cutoff, out)
        return out
    }

    private func edgeDecorations(_ ground: CanvasGround, layout: CanvasLayout, state: CanvasPaintState, paint: CanvasPaint, now: CFTimeInterval) -> [SurfaceDecoration] {
        var out: [SurfaceDecoration] = []
        var groups: [String: Group] = [:], ends: [String: Group] = [:]
        var fresh: [(key: String, shape: CanvasShape, tone: Tone)] = []
        let related = state.related
        let drawing = !reduceMotion
        for shape in ground.shapes where shape.t <= state.cutoff && (shape.role == .edge || shape.role == .edgeEnd) {
            if (state.replaying || state.far) && shape.to == -1 { continue }
            let tone: Tone = related.map { Self.touches(shape, layout, $0) ? .lit : .faded } ?? .plain
            let kind = shape.edgeKind ?? .reply
            if shape.role == .edge {
                let key = Self.edgeKey(kind, shape.from, shape.to, layout)
                if drawing, kind != .fork, let until = edgeUntil[key], until > now { fresh.append((key, shape, tone)); continue }
                let name = "edge.\(kind.rawValue).\(tone.rawValue)"
                let entry = groups[name] ?? Group(shape: shape, tone: tone)
                entry.path.addPath(shape.path)
                groups[name] = entry
            } else {
                let name = "edge.ends.\(kind == .fork ? "fork" : "plain").\(tone.rawValue)"
                let entry = ends[name] ?? Group(shape: shape, tone: tone)
                entry.path.addPath(shape.path)
                ends[name] = entry
            }
        }
        // A hovered column lights its own edges and fades the rest (the web fades the whole group to 0.35 on top of that).
        func edge(_ name: String, _ path: CGPath, _ shape: CanvasShape, _ tone: Tone, drawIn: Bool = false) {
            let fork = shape.edgeKind == .fork
            let lead = fork ? paint.palette.accent : paint.palette.fg
            let alpha: CGFloat = tone == .lit ? 0.55 : tone == .faded ? 0.06 * 0.35 : fork ? 0.5 : 0.2
            var d = Self.decoration(name, path, stroke: paint.color(lead, alpha), width: tone == .lit ? 1.6 : 1.2, dash: shape.dash)
            d.drawIn = drawIn
            out.append(d)
        }
        for (name, entry) in groups.sorted(by: { $0.key < $1.key }) { edge(name, entry.path, entry.shape, entry.tone) }
        for item in fresh { edge("edge.fresh.\(item.key)", item.shape.path, item.shape, item.tone, drawIn: true) }
        for (name, entry) in ends.sorted(by: { $0.key < $1.key }) {
            let fork = entry.shape.edgeKind == .fork
            let lead = fork ? paint.palette.accent : paint.palette.fg
            let strokeAlpha: CGFloat = entry.tone == .lit ? 0.55 : entry.tone == .faded ? 0.3 * 0.35 : fork ? 0.5 : 0.3
            out.append(Self.decoration(name, entry.path, stroke: paint.color(lead, strokeAlpha), fill: paint.elevated(entry.tone == .faded ? 0.35 : 1)))
        }
        return out
    }

    private static func radius(of node: CanvasNode) -> CGFloat {
        switch node.kind {
        case .agent: 14
        case .user(let u): u.variant == .command ? 12 : 14
        case .signal: 12
        case .change: 6
        default: 8
        }
    }

    /// The ground for [layout], built again only when something it draws moved.
    private func ground(for layout: CanvasLayout, paint: CanvasPaint) -> CanvasGround {
        // The same layout again (a hover or a mark moved): the same arrays, so nothing to hash.
        if let ground, let last = groundLayout, Self.sameGround(last, layout) { return ground }
        var h = Hasher()
        h.combine(epoch); h.combine(layout.level.rawValue)
        for f in layout.frames { h.combine(f.x); h.combine(f.y); h.combine(f.w); h.combine(f.h); h.combine(f.project); h.combine(f.branch) }
        for t in layout.tracks { h.combine(t.x); h.combine(t.w); h.combine(t.line); h.combine(t.name); h.combine(t.external) }
        for s in layout.seams { h.combine(s.x); h.combine(s.top); h.combine(s.bottom); h.combine(s.tokens); h.combine(s.t) }
        for g in layout.gutter { h.combine(g.x); h.combine(g.y); h.combine(g.t); h.combine(g.day) }
        for e in layout.edges { h.combine(e.path); h.combine(e.gap); h.combine(e.t); h.combine(e.from); h.combine(e.to) }
        if let n = layout.next { h.combine(n.x); h.combine(n.y); h.combine(n.w); h.combine(n.h) }
        let key = h.finalize()
        groundLayout = layout
        if let ground, key == groundKey { return ground }
        let built = CanvasGroundBuilder.make(layout: layout, paint: paint)
        groundKey = key
        ground = built
        groundSerial += 1
        return built
    }

    private static func sameGround(_ a: CanvasLayout, _ b: CanvasLayout) -> Bool {
        func same<T>(_ x: [T], _ y: [T]) -> Bool {
            x.count == y.count && x.withUnsafeBufferPointer { px in y.withUnsafeBufferPointer { py in px.baseAddress == py.baseAddress } }
        }
        return a.level == b.level && a.next?.id == b.next?.id && a.next?.x == b.next?.x && a.next?.y == b.next?.y && a.next?.w == b.next?.w && a.next?.h == b.next?.h
            && same(a.frames, b.frames) && same(a.tracks, b.tracks) && same(a.seams, b.seams) && same(a.gutter, b.gutter) && same(a.edges, b.edges)
    }

    private static func nodeId(_ i: Int, _ layout: CanvasLayout) -> String? {
        i >= 0 && i < layout.nodes.count ? layout.nodes[i].id : i == -1 ? layout.next?.id : nil
    }

    private static func edgeKey(_ kind: CanvasEdgeKind, _ from: Int, _ to: Int, _ layout: CanvasLayout) -> String {
        "\(kind.rawValue)|\(nodeId(from, layout) ?? "")>\(nodeId(to, layout) ?? "")"
    }

    private static func touches(_ shape: CanvasShape, _ layout: CanvasLayout, _ related: Set<String>) -> Bool {
        nodeId(shape.from, layout).map(related.contains) == true && nodeId(shape.to, layout).map(related.contains) == true
    }

    // MARK: Drawing

    /// A layout and its paint, shared by every item of one scene so the layout is held once.
    final class Drawing: @unchecked Sendable {
        let layout: CanvasLayout
        let paint: CanvasPaint
        init(layout: CanvasLayout, paint: CanvasPaint) { self.layout = layout; self.paint = paint }
    }
    final class Content {
        let box: Drawing, node: CanvasNode, look: Look, outset: CGFloat
        init(box: Drawing, node: CanvasNode, look: Look, outset: CGFloat) { self.box = box; self.node = node; self.look = look; self.outset = outset }
    }
    final class Slot {
        let box: Drawing, sending: Bool
        init(box: Drawing, sending: Bool) { self.box = box; self.sending = sending }
    }
    final class Decor {
        let box: Drawing, decoration: CanvasDecoration
        init(box: Drawing, decoration: CanvasDecoration) { self.box = box; self.decoration = decoration }
    }

    private final class Drawer: SurfaceRenderer {
        func draw(_ item: SurfaceItem, region: CGRect, in ctx: CGContext, scale: CGFloat, zoom: CGFloat) {
            if let content = item.content as? Content {
                var paint = content.box.paint.with(zoom: zoom)
                paint.pulse = content.look.pulse; paint.focusPath = content.look.focus; paint.marked = content.look.marked
                paint.lit = content.look.lit; paint.hot = content.look.hot
                // The frame was widened by what the card paints outside its box: the card itself starts that far in.
                ctx.translateBy(x: content.outset, y: content.outset)
                CanvasNodePainter.draw(content.node, in: ctx, layout: content.box.layout, paint: paint)
            } else if let slot = item.content as? Slot {
                Self.drawSlot(slot, item.frame.size, ctx)
            } else if let decor = item.content as? Decor {
                CanvasDecorationPainter.draw(decor.decoration, in: ctx, paint: decor.box.paint.with(zoom: 1))
            }
        }

        /// The question not yet asked: the outline with a plus and the invitation; sent, a filled bubble (its spinner is a layer).
        private static func drawSlot(_ slot: Slot, _ size: CGSize, _ ctx: CGContext) {
            let p = slot.box.paint
            if slot.sending {
                canvasCard(ctx, CGRect(origin: .zero, size: size), radius: 14, fill: p.bubble, border: nil)
                return
            }
            let d = CanvasDecoration(rect: CGRect(origin: .zero, size: size), content: .next(p.strings["continueChat"]))
            CanvasDecorationPainter.draw(d, in: ctx, paint: p)
        }
    }
}

/// The layers of `CanvasAccessory`: each in a plain container the surface places, drawn y down inside it, moved by Core Animation alone.
/// Under Reduce Motion they stand still (`canvas-shimmer` in its first position).
enum CanvasAccessoryLayers {
    static func make(_ spec: CanvasAccessory, reduceMotion: Bool) -> CALayer {
        let box = CALayer()
        let size = spec.frame.size
        switch spec.motion {
        case .shimmer(let seconds):
            // `background-size: 50%` sliding from past the right edge to past the left one.
            box.masksToBounds = true
            let color = spec.fill ?? CGColor(gray: 1, alpha: 0.7)
            let band = CAGradientLayer()
            band.colors = [color.copy(alpha: 0) as Any, color, color.copy(alpha: 0) as Any]
            band.locations = [0, 0.5, 1]
            band.startPoint = CGPoint(x: 0, y: 0.5)
            band.endPoint = CGPoint(x: 1, y: 0.5)
            band.anchorPoint = .zero
            band.bounds = CGRect(x: 0, y: 0, width: size.width / 2, height: size.height)
            band.position = .zero
            band.actions = ["position": NSNull(), "position.x": NSNull()]
            box.addSublayer(band)
            if !reduceMotion {
                let slide = CABasicAnimation(keyPath: "position.x")
                slide.fromValue = size.width
                slide.toValue = -size.width / 2
                slide.duration = seconds
                slide.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                slide.repeatCount = .infinity
                band.add(slide, forKey: "shimmer")
            }
        case .dot, .pulse:
            let shape = shapeLayer(spec, size: size)
            box.addSublayer(shape)
            if !reduceMotion {
                let dot: Bool = { if case .dot = spec.motion { true } else { false } }()
                let pulse = CAKeyframeAnimation(keyPath: "opacity")
                pulse.values = [1, dot ? 0.35 : 0.5, 1]
                pulse.keyTimes = [0, 0.5, 1]
                let curve = dot ? CAMediaTimingFunction(name: .easeInEaseOut) : CAMediaTimingFunction(controlPoints: 0.4, 0, 0.6, 1)
                pulse.timingFunctions = [curve, curve]
                pulse.duration = dot ? 1.4 : 2
                pulse.repeatCount = .infinity
                shape.add(pulse, forKey: "pulse")
            }
        case .spin:
            let shape = shapeLayer(spec, size: size)
            shape.anchorPoint = CGPoint(x: 0.5, y: 0.5)
            shape.position = CGPoint(x: size.width / 2, y: size.height / 2)
            box.addSublayer(shape)
            if !reduceMotion {
                let turn = CABasicAnimation(keyPath: "transform.rotation.z")
                turn.fromValue = 0
                turn.toValue = 2 * Double.pi
                turn.duration = 1
                turn.repeatCount = .infinity
                shape.add(turn, forKey: "spin")
            }
        }
        return box
    }

    private static func shapeLayer(_ spec: CanvasAccessory, size: CGSize) -> CAShapeLayer {
        let shape = CAShapeLayer()
        shape.bounds = CGRect(origin: .zero, size: size)
        shape.anchorPoint = .zero
        shape.position = .zero
        var path = spec.path ?? CGPath(rect: shape.bounds, transform: nil)
        if spec.scaleToIcon {
            var scale = CGAffineTransform(scaleX: size.width / 24, y: size.height / 24)
            path = path.copy(using: &scale) ?? path
        }
        shape.path = path
        shape.fillColor = spec.fill
        shape.strokeColor = spec.stroke
        shape.lineWidth = spec.width
        shape.lineCap = spec.cap == .round ? .round : spec.cap == .square ? .square : .butt
        shape.lineJoin = .round
        if !spec.dash.isEmpty { shape.lineDashPattern = spec.dash.map { NSNumber(value: Double($0)) } }
        return shape
    }
}
