import AppKit
import QuartzCore
import os

let surfaceSignposter = OSSignposter(subsystem: "io.github.riffable.mac", category: "Canvas")

/// Decides which bitmaps exist, makes them on background threads, and puts them on layers.
///
/// - Bitmaps come in tiers (0.25 / 0.5 / 1 / 2 times the backing scale). A new tier is drawn behind the old one, which
///   stays on the layer until every wanted piece of the new one has landed.
/// - At most `maxJobs` render at once, nearest the screen centre first, and at most `maxSwaps` land per frame, so a
///   jump to a cold area fills in from the middle without a frame growing long.
/// - One byte budget covers every bitmap held, attached or cached. Over it, the ones furthest from the viewport go
///   first; cached before attached, other tiers before the current one; what the screen needs now is never evicted.
/// - Far zoom holds no bitmaps at all, and they are released a chunk per frame rather than in one.
final class RasterScheduler {
    var renderer: SurfaceRenderer?
    var budget = 128 << 20
    var backing: CGFloat = 2
    /// Called when work appears while the display link may be paused.
    var wake: () -> Void = {}

    let maxJobs = 3, maxSwaps = 6
    private(set) var tier = 2
    private(set) var far = false
    private(set) var residentBytes = 0
    private(set) var peakBytes = 0

    private var camera = SurfaceCamera(x: 0, y: 0, k: 1)
    private var size = CGSize.zero
    private struct Job { let node: SurfaceNode; let key: RasterKey; let dist: CGFloat }
    private var queue: [Job] = []
    private var head = 0
    private var landed: [(SurfaceNode, Raster)] = []
    private var landedHead = 0
    private var budgetChecked = -1
    private var running = 0
    private var generation = 0
    private var residents: [ObjectIdentifier: SurfaceNode] = [:]
    private var farPending: [SurfaceNode] = []

    var isIdle: Bool { head >= queue.count && running == 0 && landedHead >= landed.count && farPending.isEmpty }

    /// Whether every bitmap wanted for the part of the plane on screen is on a layer.
    func screenReady(_ nodes: [SurfaceNode]) -> Bool {
        if far { return farPending.isEmpty }
        let view = camera.visibleWorld(size: size)
        for node in nodes where node.alive && node.frame.intersects(view) {
            let layout = node.layout(tier: tier, backing: backing)
            for key in node.wanted where node.rasters[key]?.layer == nil {
                if layout.whole { return false }
                let world = layout.region(col: Int(key.col), row: Int(key.row)).offsetBy(dx: node.frame.minX, dy: node.frame.minY)
                if world.intersects(view) { return false }
            }
        }
        return true
    }

    /// Records the camera and returns whether the tier or far mode changed, which asks for a fresh plan.
    func update(camera: SurfaceCamera, size: CGSize) -> Bool {
        self.camera = camera
        self.size = size
        let nowFar = camera.k < ZoomBand.farBelow
        var changed = false
        if nowFar != far {
            far = nowFar
            generation += 1
            queue.removeAll(); head = 0; clearLanded()
            // Leaving far before the release finished keeps what is left: it is still good, and a pending list would keep the link awake.
            if far { farPending = Array(residents.values); wake() } else { farPending.removeAll() }
            changed = true
        }
        let t = pickTier(camera.k)
        if t != tier { tier = t; changed = true }
        return changed && !far
    }

    /// The first tier that covers the zoom, allowing 15% softness so k just above 1 does not pay for a 2x bitmap, and
    /// holding a higher tier a little past its edge so a zoom hovering on a boundary does not redraw back and forth.
    private func pickTier(_ k: CGFloat) -> Int {
        let need = k * 0.85
        let candidate = rasterTiers.firstIndex { $0 >= need } ?? rasterTiers.count - 1
        if candidate < tier, tier > 0, need > rasterTiers[tier - 1] * 0.9 { return tier }
        return candidate
    }

    // MARK: planning

    /// Works out what each node in the window needs at the current tier and queues what is missing, centre first.
    func plan(_ nodes: [SurfaceNode]) {
        queue.removeAll(keepingCapacity: true)
        head = 0
        guard !far, renderer != nil else { return }
        let rect = camera.visibleWorld(size: size, margin: 0.35)
        let view = camera.visibleWorld(size: size)
        let c = camera.world(CGPoint(x: size.width / 2, y: size.height / 2))
        for node in nodes {
            node.wanted.removeAll(keepingCapacity: true)
            guard node.alive, node.frame.intersects(rect) else { continue }
            let layout = node.layout(tier: tier, backing: backing)
            guard let (cols, rows) = layout.tiles(touching: rect.offsetBy(dx: -node.frame.minX, dy: -node.frame.minY)) else { continue }
            var missing = 0
            for row in rows {
                for col in cols {
                    let key = RasterKey(stamp: node.stamp, tier: Int8(tier), col: Int16(col), row: Int16(row))
                    node.wanted.append(key)
                    if let r = node.rasters[key] {
                        if r.layer == nil { land(node, r); missing += 1 }
                    } else {
                        missing += 1
                        if !node.inflight.contains(key) {
                            let region = layout.region(col: col, row: row)
                            let world = region.offsetBy(dx: node.frame.minX, dy: node.frame.minY)
                            let dx = world.midX - c.x, dy = world.midY - c.y
                            // What is on screen goes before the margin that is only prefetched.
                            queue.append(Job(node: node, key: key, dist: dx * dx + dy * dy + (world.intersects(view) ? 0 : 1e15)))
                        }
                    }
                }
            }
            if missing == 0 { cleanStale(node) }
        }
        queue.sort { $0.dist < $1.dist }
        pump()
        if !isIdle { wake() }
    }

    // MARK: frame

    func tick() {
        if far { dropChunk() }
        var swaps = 0
        while swaps < maxSwaps, landedHead < landed.count {
            let (node, raster) = landed[landedHead]
            landedHead += 1
            raster.queued = false
            if attach(node, raster) { swaps += 1 }
        }
        if landedHead >= landed.count { landed.removeAll(keepingCapacity: true); landedHead = 0 }
        pump()
        // Over budget with nothing left that may go (the screen alone needs more), the scan would only repeat itself.
        if residentBytes > budget, residentBytes != budgetChecked { enforceBudget(); budgetChecked = residentBytes }
    }

    private func clearLanded() {
        for (_, r) in landed { r.queued = false }
        landed.removeAll(); landedHead = 0
    }

    /// Queues a drawn bitmap for a layer, once.
    private func land(_ node: SurfaceNode, _ raster: Raster) {
        guard !raster.queued else { return }
        raster.queued = true
        landed.append((node, raster))
    }

    private func dropChunk() {
        var n = 0
        while n < 40, let node = farPending.popLast() {
            for r in Array(node.rasters.values) { evict(node, r) }
            n += 1
        }
    }

    // MARK: jobs

    private func pump() {
        guard let renderer else { return }
        while running < maxJobs, head < queue.count {
            let job = queue[head]
            head += 1
            let node = job.node, key = job.key
            guard node.alive, key.stamp == node.stamp, Int(key.tier) == tier, node.rasters[key] == nil, !node.inflight.contains(key) else { continue }
            running += 1
            node.inflight.insert(key)
            let layout = node.layout(tier: tier, backing: backing)
            let px = layout.pixelRect(col: Int(key.col), row: Int(key.row))
            let region = layout.region(col: Int(key.col), row: Int(key.row))
            let item = node.item, gen = generation, scale = layout.scale
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let id = surfaceSignposter.makeSignpostID()
                let state = surfaceSignposter.beginInterval("raster", id: id)
                let buffer = RasterBuffer.render(item: item, region: region, pixelWidth: px.w, pixelHeight: px.h, scale: scale, zoom: rasterTiers[Int(key.tier)], renderer: renderer)
                surfaceSignposter.endInterval("raster", state)
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.running -= 1
                    node.inflight.remove(key)
                    // A bitmap for the key may have come another way meanwhile (drawn ahead for a morph): keep that one.
                    if let buffer, gen == self.generation, node.alive, key.stamp == node.stamp, node.rasters[key] == nil {
                        let raster = Raster(key: key, buffer: buffer)
                        node.rasters[key] = raster
                        self.residents[ObjectIdentifier(node)] = node
                        self.residentBytes += buffer.bytes
                        self.peakBytes = max(self.peakBytes, self.residentBytes)
                        if node.wanted.contains(key) { self.land(node, raster) }
                    }
                    self.pump()
                    self.wake()
                }
            }
        }
    }

    // MARK: layers

    /// Puts a bitmap on screen. Returns false when it no longer applies. `standIn` puts one drawn ahead (`adopt`) up even if
    /// the zoom has since moved to another tier: it is better than nothing until the plan's own lands.
    @discardableResult
    private func attach(_ node: SurfaceNode, _ raster: Raster, standIn: Bool = false) -> Bool {
        let key = raster.key
        // `landed` can still hold a bitmap the budget has since dropped: put on a layer, nothing would ever take it off again.
        guard raster.layer == nil, node.rasters[key] === raster, node.alive, !far, key.stamp == node.stamp, standIn || (Int(key.tier) == tier && node.wanted.contains(key)) else { return false }
        // A new version of an item already on screen (a hover's border, a turn that grew) changes in one frame: its tiles wait
        // until every one on screen is drawn, then all go up together, rather than the card showing two versions side by side.
        // Whichever arrives last (from the plan or drawn ahead) puts up the ones held before it.
        if node.rasters.values.contains(where: { $0.key.stamp != node.stamp && $0.layer != nil }) {
            let t = Int(key.tier)
            guard visibleKeys(node, tier: t).allSatisfy({ node.rasters[$0] != nil }) else { return false }
            for r in Array(node.rasters.values) where r !== raster && r.layer == nil && r.key.stamp == node.stamp && Int(r.key.tier) == t {
                place(node, r)
            }
        }
        place(node, raster)
        // A stand-in lands before the plan has asked for the new stamp: `wanted` may still list the old one's.
        if !standIn, node.wanted.allSatisfy({ node.rasters[$0]?.layer != nil }) { cleanStale(node) }
        else if shows(node, tier: Int(key.tier)) { retire(node) }
        return true
    }

    private func place(_ node: SurfaceNode, _ raster: Raster) {
        let key = raster.key
        let layout = node.layout(tier: Int(key.tier), backing: backing)
        let target: CALayer
        if layout.whole {
            target = node.layer
            target.contentsScale = layout.scale
            node.whole?.layer = nil
            node.whole = raster
        } else {
            let region = layout.region(col: Int(key.col), row: Int(key.row))
            if let existing = node.tileLayers[key] { target = existing } else {
                target = CALayer()
                target.anchorPoint = .zero
                target.bounds = CGRect(origin: .zero, size: region.size)
                target.position = CGPoint(x: region.minX, y: node.frame.height - region.maxY)
                target.magnificationFilter = .linear
                target.minificationFilter = .linear
                node.layer.addSublayer(target)
                node.tileLayers[key] = target
            }
        }
        target.contents = raster.buffer.contents
        raster.layer = target
        node.clearBlock()
    }

    /// Whether the node's current stamp at `tier` is on every part of it that is on screen. A whole bitmap sits under any tile
    /// and a resized item's old tiles reach past its new box, so the old stamp has to go as soon as this holds, not once the
    /// prefetch margin has landed too (which waits for the zoom to stop).
    private func shows(_ node: SurfaceNode, tier t: Int) -> Bool {
        visibleKeys(node, tier: t).allSatisfy { node.rasters[$0]?.layer != nil }
    }

    /// The node's current-stamp keys at `tier` for the part of it on screen.
    private func visibleKeys(_ node: SurfaceNode, tier t: Int) -> [RasterKey] {
        let layout = node.layout(tier: t, backing: backing)
        let view = camera.visibleWorld(size: size).offsetBy(dx: -node.frame.minX, dy: -node.frame.minY)
        guard let (cols, rows) = layout.tiles(touching: view) else { return [] }
        var keys: [RasterKey] = []
        for row in rows { for col in cols { keys.append(RasterKey(stamp: node.stamp, tier: Int8(t), col: Int16(col), row: Int16(row))) } }
        return keys
    }

    /// Drops the bitmaps of the node's older stamps.
    private func retire(_ node: SurfaceNode) {
        for r in Array(node.rasters.values) where r.key.stamp != node.stamp { evict(node, r) }
        node.layer.masksToBounds = false
    }

    /// Once the current tier is fully on screen, the bitmaps of other tiers and versions stop being needed.
    private func cleanStale(_ node: SurfaceNode) {
        for r in Array(node.rasters.values) {
            if r.key.stamp != node.stamp { evict(node, r) }
            else if Int(r.key.tier) != tier, r.layer != nil { detach(node, r) }
        }
        node.layer.masksToBounds = false
    }

    private func detach(_ node: SurfaceNode, _ r: Raster) {
        guard let layer = r.layer else { return }
        if layer === node.layer {
            layer.contents = nil
            node.whole = nil
        } else {
            layer.contents = nil
            layer.removeFromSuperlayer()
            node.tileLayers[r.key] = nil
        }
        r.layer = nil
        if !node.hasContent { node.placeholder(far: far) }
    }

    private func evict(_ node: SurfaceNode, _ r: Raster) {
        detach(node, r)
        guard node.rasters.removeValue(forKey: r.key) != nil else { return }
        residentBytes -= r.buffer.bytes
        if node.rasters.isEmpty { residents[ObjectIdentifier(node)] = nil }
    }

    /// Drops every bitmap of a node, e.g. when it leaves the plane or its backing scale changed.
    func release(_ node: SurfaceNode) {
        for r in Array(node.rasters.values) { evict(node, r) }
        node.whole = nil
        node.layer.masksToBounds = false
    }

    func releaseAll() {
        generation += 1
        queue.removeAll(); head = 0; clearLanded()
        for node in Array(residents.values) { release(node) }
    }

    /// A node's version or size changed: bitmaps of the old stamp that are not on screen can never be shown again. The ones on
    /// screen stay, at their own size and pinned to the item's top (tiles are placed from the layer's bottom, so they move by
    /// the change in height), until the new stamp's have all landed.
    func invalidated(_ node: SurfaceNode, heightChange: CGFloat?) {
        if let dy = heightChange {
            for layer in node.tileLayers.values { layer.position.y += dy }
            node.invalidateLayouts()
            // An old bitmap larger than the new box would lie over the neighbours until it goes.
            if node.hasContent { node.layer.masksToBounds = true }
        }
        for r in Array(node.rasters.values) where r.layer == nil { evict(node, r) }
        node.inflight.removeAll()
    }

    /// Draws `items` ahead of them reaching the plane (a morph re-forms every card at once): the bitmaps a camera showing
    /// `view` would ask for, at the current tier, all at once on every core. Waits up to `wait` and returns what is done;
    /// the rest go to `late` on the main queue as they finish.
    func prerender(_ items: [SurfaceItem], view: CGRect, wait: TimeInterval, late: @escaping (Staged) -> Void) -> [Staged] {
        guard !far, let renderer else { return [] }
        let t = tier, scale = rasterTiers[t] * backing
        struct Job { let item: SurfaceItem; let layout: TileLayout; let col: Int; let row: Int }
        var jobs: [Job] = []
        for item in items where item.frame.intersects(view) {
            let layout = TileLayout(size: item.frame.size, scale: scale)
            guard let (cols, rows) = layout.tiles(touching: view.offsetBy(dx: -item.frame.minX, dy: -item.frame.minY)) else { continue }
            for row in rows { for col in cols { jobs.append(Job(item: item, layout: layout, col: col, row: row)) } }
        }
        guard !jobs.isEmpty else { return [] }
        let lock = NSLock()
        var done: [Staged] = []
        var closed = false
        let group = DispatchGroup()
        for job in jobs {
            DispatchQueue.global(qos: .userInteractive).async(group: group) {
                let px = job.layout.pixelRect(col: job.col, row: job.row)
                guard let buffer = RasterBuffer.render(item: job.item, region: job.layout.region(col: job.col, row: job.row), pixelWidth: px.w, pixelHeight: px.h, scale: scale, zoom: rasterTiers[t], renderer: renderer) else { return }
                let staged = Staged(id: job.item.id, size: job.item.frame.size, version: job.item.version, tier: Int8(t), col: Int16(job.col), row: Int16(job.row), scale: scale, buffer: buffer)
                lock.lock()
                let isLate = closed
                if !isLate { done.append(staged) }
                lock.unlock()
                if isLate { DispatchQueue.main.async { late(staged) } }
            }
        }
        _ = group.wait(timeout: .now() + wait)
        lock.lock()
        closed = true
        let ready = done
        lock.unlock()
        return ready
    }

    /// A bitmap drawn ahead for one item: it applies while the item is still that size and version.
    struct Staged {
        let id: String
        let size: CGSize
        let version: Int
        let tier: Int8, col: Int16, row: Int16
        let scale: CGFloat
        let buffer: RasterBuffer
    }

    /// Takes a bitmap drawn ahead onto the node it was drawn for, straight onto its layer.
    func adopt(_ node: SurfaceNode, _ staged: Staged) {
        guard node.alive, !far, node.item.frame.size == staged.size, node.item.version == staged.version, staged.scale == rasterTiers[Int(staged.tier)] * backing else { return }
        let key = RasterKey(stamp: node.stamp, tier: staged.tier, col: staged.col, row: staged.row)
        guard node.rasters[key] == nil else { return }
        let raster = Raster(key: key, buffer: staged.buffer)
        node.rasters[key] = raster
        residents[ObjectIdentifier(node)] = node
        residentBytes += staged.buffer.bytes
        peakBytes = max(peakBytes, residentBytes)
        attach(node, raster, standIn: true)
    }

    // MARK: budget

    private func enforceBudget() {
        let view = camera.visibleWorld(size: size)
        var candidates: [(score: CGFloat, node: SurfaceNode, raster: Raster)] = []
        for node in residents.values {
            for r in node.rasters.values {
                let current = r.key.stamp == node.stamp && Int(r.key.tier) == tier
                // What the plan wants stays, landed on a layer or waiting for its frame.
                if current, node.wanted.contains(r.key) { continue }
                let region = node.layout(tier: Int(r.key.tier), backing: backing).region(col: Int(r.key.col), row: Int(r.key.row))
                let rect = region.offsetBy(dx: node.frame.minX, dy: node.frame.minY)
                // What is on screen stays until what replaces it is up, whatever its version: dropping it opens a hole.
                if r.layer != nil, rect.intersects(view) { continue }
                let dx = max(view.minX - rect.maxX, 0, rect.minX - view.maxX), dy = max(view.minY - rect.maxY, 0, rect.minY - view.maxY)
                var score = hypot(dx, dy) * camera.k
                if r.layer == nil { score += 1e5 }
                if !current { score += 5e4 }
                candidates.append((score, node, r))
            }
        }
        candidates.sort { $0.score > $1.score }
        let target = budget / 10 * 9
        for c in candidates where residentBytes > target { evict(c.node, c.raster) }
    }
}
