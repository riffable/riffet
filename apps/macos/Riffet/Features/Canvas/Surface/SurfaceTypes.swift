import AppKit
import QuartzCore

/// Maps world to screen as `screen = world * k + (x, y)`, y down, like the web canvas.
struct SurfaceCamera: Equatable {
    var x: CGFloat
    var y: CGFloat
    var k: CGFloat

    static let zoomRange: ClosedRange<CGFloat> = 0.05...2
    static func clampK(_ k: CGFloat) -> CGFloat { min(zoomRange.upperBound, max(zoomRange.lowerBound, k)) }

    func screen(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * k + x, y: p.y * k + y) }
    func world(_ p: CGPoint) -> CGPoint { CGPoint(x: (p.x - x) / k, y: (p.y - y) / k) }
    func screen(_ r: CGRect) -> CGRect { CGRect(x: r.minX * k + x, y: r.minY * k + y, width: r.width * k, height: r.height * k) }

    /// The part of the world on screen, widened by `screens` viewport sizes on every side.
    func visibleWorld(size: CGSize, margin screens: CGFloat = 0) -> CGRect {
        let w = size.width / k, h = size.height / k
        return CGRect(x: -x / k - screens * w, y: -y / k - screens * h, width: w * (1 + 2 * screens), height: h * (1 + 2 * screens))
    }

    static func lerp(_ a: SurfaceCamera, _ b: SurfaceCamera, _ t: CGFloat) -> SurfaceCamera {
        SurfaceCamera(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, k: a.k + (b.k - a.k) * t)
    }
}

/// Which side of the far, wide and close thresholds the zoom is on. The two middle bands let a consumer keep a
/// hysteresis (switch to detail when entering `close`, back when dropping below `wide`).
enum ZoomBand: Int, Comparable {
    case far, wide, middle, close

    static let farBelow: CGFloat = 0.36
    static let closeOut: CGFloat = 0.8
    static let closeIn: CGFloat = 0.95

    init(k: CGFloat) {
        self = k < Self.farBelow ? .far : k < Self.closeOut ? .wide : k < Self.closeIn ? .middle : .close
    }
    static func < (a: ZoomBand, b: ZoomBand) -> Bool { a.rawValue < b.rawValue }
}

/// A cubic Bezier timing curve, evaluated here for camera sampling and handed to Core Animation for the real motion.
struct SurfaceEasing {
    var x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat

    /// `cubic-bezier(0.33, 1, 0.68, 1)`: web's ease-out cubic for flights and morphs.
    static let outCubic = SurfaceEasing(x1: 0.33, y1: 1, x2: 0.68, y2: 1)
    static let inOut = SurfaceEasing(x1: 0.42, y1: 0, x2: 0.58, y2: 1)

    var timingFunction: CAMediaTimingFunction { CAMediaTimingFunction(controlPoints: Float(x1), Float(y1), Float(x2), Float(y2)) }

    func value(_ t: CGFloat) -> CGFloat {
        if t <= 0 { return 0 }
        if t >= 1 { return 1 }
        func b(_ a: CGFloat, _ c: CGFloat, _ s: CGFloat) -> CGFloat { 3 * a * (1 - s) * (1 - s) * s + 3 * c * (1 - s) * s * s + s * s * s }
        var lo: CGFloat = 0, hi: CGFloat = 1, s = t
        for _ in 0..<20 {
            let x = b(x1, x2, s)
            if abs(x - t) < 0.0005 { break }
            if x < t { lo = s } else { hi = s }
            s = (lo + hi) / 2
        }
        return b(y1, y2, s)
    }
}

/// How an item looks without a bitmap: far zoom, and the moment before its first raster lands.
struct SurfaceFarStyle: Equatable {
    var color: CGColor
    var cornerRadius: CGFloat
}

/// One thing on the plane. The surface knows nothing about what it is; the renderer draws it.
struct SurfaceItem {
    var id: String
    /// World rect, y down.
    var frame: CGRect
    /// Bump when what the renderer would draw changes without the frame changing.
    var version: Int
    var farStyle: SurfaceFarStyle
    /// Immutable data for the renderer, read on background threads.
    var content: AnyObject?
    /// What the reader points at and selects, when it is smaller than `frame` (a card's frame is widened by what it paints outside its box,
    /// such as a shadow); nil is the frame itself.
    var hit: CGRect?
    /// False for what only lies on the plane (a label, a time): never under the pointer, never dimmed.
    var interactive = true
    /// Stacking among the items, higher above.
    var z: CGFloat = 0
    /// The moving parts of the item, as layers on top of its bitmap.
    var accessories: [SurfaceAccessory] = []
    /// Comes in the way a new card does (`canvas-enter`) when it first appears outside a morph.
    var enter = false
}

/// A part of an item that Core Animation moves on its own, so the item's bitmap is not drawn again for it. `make` builds the layer
/// once per `version`; its geometry is the item's, y down, `frame` in item-local points.
struct SurfaceAccessory {
    var id: String
    var version: Int
    var frame: CGRect
    var make: () -> CALayer
}

/// Draws one item on a background thread. Implementations must not touch main-thread state.
protocol SurfaceRenderer: AnyObject {
    /// `ctx` is in item-local points, y down, origin at the item's top-left, already scaled and clipped to `region`.
    /// A wide item is drawn as several tiles, so skip anything outside `region`. `zoom` is the camera zoom the bitmap is
    /// for (its scale over the window's backing scale).
    func draw(_ item: SurfaceItem, region: CGRect, in ctx: CGContext, scale: CGFloat, zoom: CGFloat)
}

/// A shape drawn in the world under the items (edges, frames, track lines). Widths stay constant on screen.
struct SurfaceDecoration {
    var kind: String
    /// World coordinates, y down.
    var path: CGPath
    var stroke: CGColor?
    var fill: CGColor?
    /// Screen pixels at every zoom.
    var lineWidth: CGFloat = 1
    /// Screen pixels, or nil for a solid line.
    var dash: [CGFloat]?
    /// The width and dashes are in world units and follow the zoom, as the web's strokes on the plane do.
    var worldUnits = false
    /// The line draws itself in when it first appears (`canvas-draw`).
    var drawIn = false

    /// Rounded rectangles, one stroked path.
    static func frames(kind: String, rects: [CGRect], cornerRadius: CGFloat, stroke: CGColor?, fill: CGColor? = nil, lineWidth: CGFloat = 1, dash: [CGFloat]? = nil) -> SurfaceDecoration {
        let path = CGMutablePath()
        for r in rects { path.addRoundedRect(in: r, cornerWidth: min(cornerRadius, r.width / 2), cornerHeight: min(cornerRadius, r.height / 2)) }
        return SurfaceDecoration(kind: kind, path: path, stroke: stroke, fill: fill, lineWidth: lineWidth, dash: dash)
    }
}
