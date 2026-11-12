import AppKit
import QuartzCore

/// Bitmaps are made at one of these multiples of the backing scale, the first that covers the zoom.
let rasterTiers: [CGFloat] = [0.25, 0.5, 1, 2]

/// How an item is cut into bitmaps at one tier.
///
/// Wide and tall items (a 28,000 pt bar is 115,000 px at the top tier) are tiled rather than capped: capping would blur
/// them at exactly the zoom where the reader looks closest, while tiles cost only the part in view. Tiles overlap their
/// right and bottom neighbours by one pixel so the layer edges never open a hairline at fractional camera offsets.
struct TileLayout {
    static let tilePx = 512
    static let wholeMaxArea = 1_200_000
    static let wholeMaxSide = 4096

    let scale: CGFloat
    let pxW: Int, pxH: Int
    let whole: Bool
    let cols: Int, rows: Int

    init(size: CGSize, scale: CGFloat) {
        self.scale = scale
        pxW = max(1, Int(ceil(size.width * scale)))
        pxH = max(1, Int(ceil(size.height * scale)))
        whole = pxW * pxH <= Self.wholeMaxArea && max(pxW, pxH) <= Self.wholeMaxSide
        cols = whole ? 1 : (pxW + Self.tilePx - 1) / Self.tilePx
        rows = whole ? 1 : (pxH + Self.tilePx - 1) / Self.tilePx
    }

    /// Pixel rect of one tile including the apron, in item pixels (y down).
    func pixelRect(col: Int, row: Int) -> (x: Int, y: Int, w: Int, h: Int) {
        if whole { return (0, 0, pxW, pxH) }
        let x = col * Self.tilePx, y = row * Self.tilePx
        return (x, y, min(pxW, x + Self.tilePx + 1) - x, min(pxH, y + Self.tilePx + 1) - y)
    }

    /// The tile's region in item-local points.
    func region(col: Int, row: Int) -> CGRect {
        let p = pixelRect(col: col, row: row)
        return CGRect(x: CGFloat(p.x) / scale, y: CGFloat(p.y) / scale, width: CGFloat(p.w) / scale, height: CGFloat(p.h) / scale)
    }

    /// Tile ranges that touch `rect` (item-local points).
    func tiles(touching rect: CGRect) -> (cols: ClosedRange<Int>, rows: ClosedRange<Int>)? {
        if whole { return (0...0, 0...0) }
        let t = CGFloat(Self.tilePx)
        let c0 = max(0, Int((rect.minX * scale / t).rounded(.down))), c1 = min(cols - 1, Int((rect.maxX * scale / t).rounded(.down)))
        let r0 = max(0, Int((rect.minY * scale / t).rounded(.down))), r1 = min(rows - 1, Int((rect.maxY * scale / t).rounded(.down)))
        return c0 <= c1 && r0 <= r1 ? (c0...c1, r0...r1) : nil
    }
}

struct RasterKey: Hashable {
    /// Changes when the version or the size does, which makes every older bitmap stale.
    var stamp: Int32
    var tier: Int8
    var col: Int16
    var row: Int16
}

final class Raster {
    let key: RasterKey
    let buffer: RasterBuffer
    /// Non-nil while the bitmap is on screen.
    var layer: CALayer?
    /// Waiting in the scheduler's landing queue.
    var queued = false
    init(key: RasterKey, buffer: RasterBuffer) { self.key = key; self.buffer = buffer }
}

/// The surface's bookkeeping for one item: its layer, its bitmaps, and what the scheduler wants of it.
final class SurfaceNode {
    var item: SurfaceItem
    /// Y-up copy of the frame in the world layer's space.
    let layer = CALayer()
    var stamp: Int32 = 0
    var alive = true
    var windowStamp = 0
    var mark = 0
    var rasters: [RasterKey: Raster] = [:]
    var tileLayers: [RasterKey: CALayer] = [:]
    var inflight: Set<RasterKey> = []
    /// The bitmap sitting on the item layer itself (an item that fits in one bitmap).
    var whole: Raster?
    var wanted: [RasterKey] = []
    var accessoryLayers: [CALayer] = []
    var accessoryKeys: [String] = []
    var unattached = 0
    private var layouts: [Int8: TileLayout] = [:]
    private var layoutScale: CGFloat = 0

    init(_ item: SurfaceItem, far: Bool) {
        self.item = item
        layer.anchorPoint = .zero
        // A whole-item bitmap is shown at its own size from the top-left (`contentsScale` is its scale): while a resized item's
        // new bitmap is drawn the old one stays as it was rather than stretched, and another tier's lands within a pixel.
        layer.contentsGravity = .topLeft
        layer.magnificationFilter = .linear
        layer.minificationFilter = .linear
        layer.isOpaque = false
        layer.isHidden = true
        sync()
        placeholder(far: far)
    }

    var frame: CGRect { item.frame }
    var hasContent: Bool { layer.contents != nil || !tileLayers.isEmpty }

    func layout(tier: Int, backing: CGFloat) -> TileLayout {
        let scale = rasterTiers[tier] * backing
        if scale != layoutScale { layouts.removeAll(); layoutScale = scale }
        if let l = layouts[Int8(tier)] { return l }
        let l = TileLayout(size: item.frame.size, scale: scale)
        layouts[Int8(tier)] = l
        return l
    }

    /// The layer tree is y-up: world y is negated.
    func sync() {
        layer.bounds = CGRect(origin: .zero, size: item.frame.size)
        layer.position = CGPoint(x: item.frame.minX, y: -item.frame.maxY)
        if layer.zPosition != item.z { layer.zPosition = item.z }
    }

    /// Puts the item's moving parts on its layer, new ones only when their id or version changed.
    func syncAccessories() {
        let keys = item.accessories.map { "\($0.id)#\($0.version)" }
        guard keys != accessoryKeys else { return }
        accessoryKeys = keys
        accessoryLayers.forEach { $0.removeFromSuperlayer() }
        accessoryLayers = item.accessories.map { spec in
            let child = spec.make()
            // The item's layer is y up; the part is made y down inside its own box.
            child.isGeometryFlipped = true
            child.anchorPoint = .zero
            child.bounds = CGRect(origin: .zero, size: spec.frame.size)
            child.position = CGPoint(x: spec.frame.minX, y: item.frame.height - spec.frame.maxY)
            child.zPosition = 10
            layer.addSublayer(child)
            return child
        }
    }

    /// What shows without a bitmap: the block far out, nothing closer in (a grey box flashing before a card's first bitmap
    /// lands reads as a flicker; the prefetch margin keeps that moment off screen).
    func placeholder(far: Bool) {
        if far { showBlock() } else { clearBlock() }
    }
    func showBlock() {
        layer.backgroundColor = item.farStyle.color
        layer.cornerRadius = item.farStyle.cornerRadius
    }
    func clearBlock() {
        layer.backgroundColor = nil
        layer.cornerRadius = 0
    }
    func invalidateLayouts() { layouts.removeAll() }
}
