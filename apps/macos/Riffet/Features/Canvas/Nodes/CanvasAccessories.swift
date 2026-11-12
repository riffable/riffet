import CoreGraphics
import Foundation

/// A part of a card that moves (the sweep along a working answer's top edge, a pulsing live dot, a spinner). The bitmap leaves
/// it out and the surface carries it as a layer of its own, so animating it never draws the card again. Coordinates are
/// node-local canvas units, y down.
struct CanvasAccessory: @unchecked Sendable {
    enum Motion: Sendable {
        /// The accent band across a working card's top edge; the seconds one sweep takes.
        case shimmer(seconds: Double)
        /// `animate-pulse-dot`: 1 to 0.35 and back in 1.4 s.
        case dot
        /// Tailwind's `animate-pulse`: 1 to 0.5 and back in 2 s.
        case pulse
        /// A full turn a second.
        case spin
    }

    var id: String
    var motion: Motion
    /// The layer's box; `path` is relative to its origin.
    var frame: CGRect
    var path: CGPath?
    var fill: CGColor?
    var stroke: CGColor?
    var width: CGFloat = 1
    var cap: CGLineCap = .butt
    var dash: [CGFloat] = []
    /// Strokes of a Lucide icon scale with the icon's 24 box.
    var scaleToIcon = false
}

/// What a painter hands over for the animated parts of a card when it is asked to leave them out of its bitmap.
final class CanvasAccessorySink: @unchecked Sendable {
    private(set) var items: [CanvasAccessory] = []
    func add(_ item: CanvasAccessory) { items.append(item) }
}

extension CanvasPaint {
    /// A pulsing dot of 6 units, as the cards' live marks are.
    func liveDot(_ rect: CGRect, id: String = "dot") {
        guard let sink else { return }
        let local = CGRect(origin: .zero, size: rect.size)
        sink.add(CanvasAccessory(id: id, motion: .dot, frame: rect, path: CGPath(ellipseIn: local, transform: nil), fill: accent()))
    }

    /// A spinner icon of [size] units at [origin].
    func spinner(at origin: CGPoint, size: CGFloat, color: CGColor, id: String = "spinner") {
        guard let sink else { return }
        sink.add(CanvasAccessory(id: id, motion: .spin, frame: CGRect(origin: origin, size: CGSize(width: size, height: size)), path: CanvasIcons.path(.loaderCircle), stroke: color, width: 1.25, cap: .round, scaleToIcon: true))
    }
}

/// The pulse of a running turn: tokens written per second now and over the last samples.
struct CanvasPulse: Equatable, Hashable, Sendable {
    var rate: Double
    var series: [Double]
}

extension CanvasPaint {
    /// A path that pulses while something runs: an accessory layer on a surface, a plain stroke or fill in a bitmap.
    func pulsing(_ ctx: CGContext, id: String, path: CGPath, stroke: CGColor? = nil, fill: CGColor? = nil, width: CGFloat = 1, cap: CGLineCap = .butt, dash: [CGFloat] = []) {
        if layered {
            guard let sink else { return }
            let box = path.boundingBoxOfPath.insetBy(dx: -(width / 2 + 1), dy: -(width / 2 + 1))
            var shift = CGAffineTransform(translationX: -box.minX, y: -box.minY)
            sink.add(CanvasAccessory(id: id, motion: .pulse, frame: box, path: path.copy(using: &shift), fill: fill, stroke: stroke, width: width, cap: cap, dash: dash))
            return
        }
        ctx.saveGState()
        ctx.addPath(path)
        if let fill { ctx.setFillColor(fill); ctx.fillPath() }
        if let stroke {
            ctx.addPath(path)
            ctx.setStrokeColor(stroke); ctx.setLineWidth(width); ctx.setLineCap(cap)
            if !dash.isEmpty { ctx.setLineDash(phase: 0, lengths: dash) }
            ctx.strokePath()
        }
        ctx.restoreGState()
    }
}
