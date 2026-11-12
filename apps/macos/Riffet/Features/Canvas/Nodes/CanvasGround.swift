import CoreGraphics
import Foundation

/// What the canvas draws under and between its cards (`ground.tsx`, the edges and track labels of `CanvasView.tsx`, the dot grid of
/// `Viewport.tsx`), described as data: vector shapes a surface can hand to shape layers, and small decorations (pills, times)
/// each drawn into a bitmap of its own. `CanvasGroundPainter` draws the same description straight into a context for snapshots.
struct CanvasGround: @unchecked Sendable {
    /// Frames, track lines, seams, edges, in the order the web stacks them (frames first). All in canvas units.
    var shapes: [CanvasShape] = []
    /// Pills and times, in canvas units; `trackLabels` are in screen points.
    var decorations: [CanvasDecoration] = []
    /// The slot for the next question (outline only), shown above the far level.
    var next: CanvasDecoration?
}

/// A path with how it is filled and stroked, in canvas units: `width` and `dash` scale with the camera like everything on the plane
/// (WebKit's `vector-effect: non-scaling-stroke` only undoes an SVG's own viewBox scale, not the plane's CSS transform).
struct CanvasShape: @unchecked Sendable {
    enum Role: Sendable { case frame, trackLine, seam, edge, edgeEnd }
    var role: Role
    var path: CGPath
    var fill: CGColor?
    var stroke: CGColor?
    var width: CGFloat = 1
    var dash: [CGFloat] = []
    var cap: CGLineCap = .butt
    /// Hidden at far level (the web draws a frame's name only up close, but frames and lines stay).
    var hiddenWhenFar = false
    /// The node it belongs to, for the edges (`from`/`to` indexes into `nodes`; -1 is the slot).
    var edgeKind: CanvasEdgeKind?
    var from = 0, to = 0
    /// When it came to be (epoch milliseconds), for replay; `-infinity` for what was always there.
    var t = -Double.infinity
}

/// A small box with text and icons in it, drawn at its own origin by `CanvasDecorationPainter`.
struct CanvasDecoration: Sendable {
    enum Content: Sendable {
        case frameLabel(project: String, branch: String?)
        case time(day: String?, clock: String)
        case silence(String)
        case seamTokens(String)
        case trackLabel(kind: CanvasTrackKind, text: String, external: Bool)
        case next(String)
    }
    /// Where it sits: canvas units (screen points for a track label).
    var rect: CGRect
    var content: Content
    var hiddenWhenFar = true
    /// When it came to be (epoch milliseconds), for replay.
    var t = -Double.infinity
}

enum CanvasGroundBuilder {
    /// The canvas's ground for [layout]: frames, track lines, seams, edges and the pills that go with them.
    static func make(layout: CanvasLayout, paint p: CanvasPaint) -> CanvasGround {
        var ground = CanvasGround()
        let measure = CanvasPen(ctx: scratch, paint: p)

        // Frames: rounded 26, a hair of ink inside, a hair more on the border.
        for frame in layout.frames {
            let rect = CGRect(x: frame.x, y: frame.y, width: frame.w, height: frame.h)
            ground.shapes.append(CanvasShape(role: .frame, path: canvasRoundedRect(rect, 26), fill: p.fg(0.018), stroke: nil))
            // The border: a ring of 1 unit, as a stroke along the inset line.
            ground.shapes.append(CanvasShape(role: .frame, path: canvasRoundedRect(rect.insetBy(dx: 0.5, dy: 0.5), 25.5), fill: nil, stroke: p.fg(0.06), width: 1))
        }
        for frame in layout.frames {
            guard let project = frame.project, !project.isEmpty else { continue }
            let size = CanvasDecorationPainter.frameLabelSize(project: project, branch: frame.branch, pen: measure)
            ground.decorations.append(CanvasDecoration(rect: CGRect(x: frame.x + 1 + 20, y: frame.y + 1 - size.height / 2, width: size.width, height: size.height), content: .frameLabel(project: project, branch: frame.branch)))
        }
        for mark in layout.gutter {
            let date = Date(timeIntervalSince1970: mark.t / 1000)
            let clock = CanvasGroundBuilder.clock.string(from: date)
            let day = mark.day == true ? CanvasGroundBuilder.day.string(from: date) : nil
            let size = CanvasDecorationPainter.timeSize(day: day, clock: clock, pen: measure)
            ground.decorations.append(CanvasDecoration(rect: CGRect(x: mark.x + 2, y: mark.y, width: size.width, height: 14), content: .time(day: day, clock: clock), hiddenWhenFar: false, t: mark.t))
        }
        for track in layout.tracks {
            let y = track.line
            let path = CGMutablePath()
            path.move(to: CGPoint(x: track.x, y: y)); path.addLine(to: CGPoint(x: track.x + track.w, y: y))
            ground.shapes.append(CanvasShape(role: .trackLine, path: path, stroke: p.fg(0.08), width: 1, dash: track.external == true ? [3, 4] : []))
        }
        for seam in layout.seams {
            let path = CGMutablePath()
            path.move(to: CGPoint(x: seam.x, y: seam.top)); path.addLine(to: CGPoint(x: seam.x, y: seam.bottom))
            var shape = CanvasShape(role: .seam, path: path, stroke: p.fg(0.22), width: 1, dash: [4, 4])
            shape.t = seam.t
            ground.shapes.append(shape)
        }
        for seam in layout.seams {
            guard let tokens = seam.tokens, !tokens.isEmpty else { continue }
            let size = CanvasDecorationPainter.seamTokensSize(tokens, pen: measure)
            ground.decorations.append(CanvasDecoration(rect: CGRect(x: seam.x - size.width / 2, y: seam.top - size.height / 2, width: size.width, height: size.height), content: .seamTokens(tokens), t: seam.t))
        }
        for edge in layout.edges {
            let path = SVGPath.parse(edge.path)
            let lead = edge.kind == .fork ? p.palette.accent : p.palette.fg
            let opacity: CGFloat = edge.kind == .fork ? 0.5 : 0.2
            var shape = CanvasShape(role: .edge, path: path, stroke: p.color(lead, opacity), width: 1.2, dash: edge.kind == .fork ? [6, 5] : [], cap: .round)
            shape.edgeKind = edge.kind; shape.from = edge.from; shape.to = edge.to; shape.t = edge.t
            ground.shapes.append(shape)
            if edge.kind != .reply {
                for (x, y) in [(edge.x1, edge.y1), (edge.x2, edge.y2)] {
                    var end = CanvasShape(role: .edgeEnd, path: CGPath(ellipseIn: CGRect(x: x - 2.5, y: y - 2.5, width: 5, height: 5), transform: nil), fill: p.elevated(), stroke: p.color(lead, max(opacity, 0.3)), width: 1)
                    end.edgeKind = edge.kind; end.from = edge.from; end.to = edge.to; end.t = edge.t
                    ground.shapes.append(end)
                }
            }
            if let gap = edge.gap, let mid = edge.mid, mid.count == 2 {
                let size = CanvasDecorationPainter.silenceSize(gap, pen: measure)
                ground.decorations.append(CanvasDecoration(rect: CGRect(x: mid[0] - size.width / 2, y: mid[1] - size.height / 2, width: size.width, height: size.height), content: .silence(gap), t: edge.t))
            }
        }
        if let next = layout.next {
            ground.next = CanvasDecoration(rect: CGRect(x: next.x, y: next.y, width: next.w, height: next.h), content: .next(p.strings["continueChat"]))
        }
        return ground
    }

    /// The track names held at the plane's left edge once the row's start has scrolled past: boxes in screen points
    /// for a camera `x`, `y`, `k` over a plane of [size].
    static func trackLabels(layout: CanvasLayout, camera: (x: CGFloat, y: CGFloat, k: CGFloat), size: CGSize, paint p: CanvasPaint) -> [CanvasDecoration] {
        var out: [CanvasDecoration] = []
        let measure = CanvasPen(ctx: scratch, paint: p)
        for track in layout.tracks {
            let y = track.line * camera.k + camera.y
            let start = track.x * camera.k + camera.x, end = (track.x + track.w) * camera.k + camera.x
            if y < 40 || y > size.height - 20 || end < 160 || start > size.width { continue }
            let external = track.external == true
            let width = CanvasDecorationPainter.trackLabelWidth(kind: track.kind, text: track.name, external: external, pen: measure)
            out.append(CanvasDecoration(rect: CGRect(x: max(12, start), y: y - 14, width: width, height: 28), content: .trackLabel(kind: track.kind, text: track.name, external: external)))
        }
        return out
    }

    static let clock: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "HH:mm"; return f }()
    static let day: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "M/d"; return f }()

    /// A context only to hold text measurements.
    nonisolated(unsafe) static let scratch = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CanvasPaint.srgb, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

/// Draws a decoration at the origin of [ctx] (y-down): the box is `(0, 0, rect.width, rect.height)`.
enum CanvasDecorationPainter {
    static func draw(_ d: CanvasDecoration, in ctx: CGContext, paint p: CanvasPaint) {
        ctx.saveGState()
        ctx.setShouldSmoothFonts(false); ctx.setAllowsFontSmoothing(false)
        ctx.setShouldSubpixelPositionFonts(true); ctx.setShouldSubpixelQuantizeFonts(false)
        let pen = CanvasPen(ctx: ctx, paint: p)
        let box = CGRect(x: 0, y: 0, width: d.rect.width, height: d.rect.height)
        let cy = box.height / 2
        switch d.content {
        case .frameLabel(let project, let branch):
            canvasCard(ctx, box, radius: box.height / 2, fill: p.subtle(), border: p.fg(0.06))
            var x: CGFloat = 1 + 10
            pen.icon(.folderClosed, x: x, centerY: cy, p.fg4); x += 12 + 6
            let style = p.text(.sans(11), p.fg3)
            x += pen.text(project, style, x: x, centerY: cy, maxWidth: 224) + 6
            if let branch, !branch.isEmpty {
                x += 4
                pen.icon(.gitBranch, x: x, centerY: cy, p.fg4); x += 12 + 6
                pen.text(branch, p.text(.mono(10.5), p.fg3), x: x, centerY: cy, maxWidth: 160)
            }
        case .time(let day, let clock):
            let style = p.font(.mono(10.5, 400, tabular: true))
            let baseline = style.baseline(top: 0, lineHeight: 14)
            var x: CGFloat = 0
            if let day { x += CanvasText.draw(day, p.text(style, p.fg3), in: ctx, x: x, baseline: baseline) + 6 }
            CanvasText.draw(clock, p.text(style, p.fg4), in: ctx, x: x, baseline: baseline)
        case .silence(let text):
            canvasCard(ctx, box, radius: box.height / 2, fill: p.subtle(), border: p.lineSoft)
            pen.text(text, p.text(.sans(10.5), p.fg4), x: 1 + 8, centerY: cy)
        case .seamTokens(let tokens):
            canvasCard(ctx, box, radius: box.height / 2, fill: p.subtle(), border: p.lineStrong, dashed: true)
            pen.icon(.foldHorizontal, x: 1 + 6, centerY: cy, p.fg4)
            pen.text(tokens, p.text(.mono(10, 400, tabular: true), p.fg4), x: 1 + 6 + 12 + 4, centerY: cy)
        case .trackLabel(let kind, let text, let external):
            canvasCard(ctx, box, radius: box.height / 2, fill: p.subtle(0.9), border: p.lineSoft)
            var x: CGFloat = 1 + 8
            if kind == .artifacts {
                ctx.icon(.image, x: x, y: cy - 6, size: 12, color: p.fg4, zoom: p.zoom, scalingStroke: 2)
            } else {
                pen.icon(trackIcon(kind), x: x, centerY: cy, p.fg4)
            }
            x += 12 + 6
            let room = box.width - x - 1 - 8
            if kind == .write && external {
                let style = p.text(.mono(10.5), p.fg2)
                let shown = CanvasText.truncated(text, style, width: room, fromStart: true)
                CanvasText.draw(shown, style, in: ctx, x: x + room, baseline: style.font.baseline(centeredAt: cy), alignRight: true)
            } else {
                pen.text(text, p.text(.sans(11), p.fg3), x: x, centerY: cy, maxWidth: room)
            }
        case .next(let label):
            ctx.borderRing(box, 14, p.line)
            pen.icon(.plus, x: 1 + 16, centerY: cy, size: 14, p.fg3)
            pen.text(label, p.text(.sans(13), p.fg3), x: 1 + 16 + 14 + 8, centerY: cy, maxWidth: box.width - 34 - 16 - 8 - 1)
        }
        ctx.restoreGState()
    }

    static func trackIcon(_ kind: CanvasTrackKind) -> CanvasIcon {
        switch kind {
        case .write: .folder
        case .artifacts: .image
        case .actors: .sparkles
        case .shell: .squareTerminal
        case .explore: .search
        case .web: .globe
        case .ask: .messageCircleQuestion
        case .other: .wrench
        }
    }

    static func frameLabelSize(project: String, branch: String?, pen: CanvasPen) -> CGSize {
        let p = pen.paint
        var w: CGFloat = 2 + 20 + 12 + 6 + min(224, pen.width(project, p.text(.sans(11), p.fg3)))
        if let branch, !branch.isEmpty { w += 6 + 4 + 12 + 6 + min(160, pen.width(branch, p.text(.mono(10.5), p.fg3))) }
        return CGSize(width: w, height: 28)
    }
    static func timeSize(day: String?, clock: String, pen: CanvasPen) -> CGSize {
        let s = pen.paint.text(.mono(10.5, 400, tabular: true), pen.paint.fg4)
        return CGSize(width: (day.map { pen.width($0, s) + 6 } ?? 0) + pen.width(clock, s), height: 14)
    }
    static func silenceSize(_ text: String, pen: CanvasPen) -> CGSize {
        CGSize(width: pen.width(text, pen.paint.text(.sans(10.5), pen.paint.fg4)) + 18, height: 26)
    }
    static func seamTokensSize(_ text: String, pen: CanvasPen) -> CGSize {
        CGSize(width: pen.width(text, pen.paint.text(.mono(10, 400, tabular: true), pen.paint.fg4)) + 2 + 12 + 12 + 4, height: 26)
    }
    static func trackLabelWidth(kind: CanvasTrackKind, text: String, external: Bool, pen: CanvasPen) -> CGFloat {
        let p = pen.paint
        let style = kind == .write && external ? p.text(.mono(10.5), p.fg2) : p.text(.sans(11), p.fg3)
        return min(180, 2 + 16 + 12 + 6 + pen.width(text, style))
    }
}

/// Draws the ground straight into a context, as a CALayer surface would from the same description (snapshots, tests).
enum CanvasGroundPainter {
    /// [ctx] has the camera applied (canvas units); [zoom] is the camera scale.
    static func draw(_ ground: CanvasGround, in ctx: CGContext, paint p: CanvasPaint, visible: CGRect? = nil) {
        func stroke(_ s: CanvasShape) {
            guard let color = s.stroke else { return }
            ctx.saveGState()
            ctx.setStrokeColor(color)
            ctx.setLineWidth(s.width)
            ctx.setLineCap(s.cap); ctx.setLineJoin(.round)
            if !s.dash.isEmpty { ctx.setLineDash(phase: 0, lengths: s.dash) }
            ctx.addPath(s.path); ctx.strokePath()
            ctx.restoreGState()
        }
        func drawShapes(_ roles: Set<CanvasShape.Role>) {
            for s in ground.shapes where roles.contains(s.role) {
                if let visible, !s.path.boundingBoxOfPath.insetBy(dx: -4, dy: -4).intersects(visible) { continue }
                if let fill = s.fill { ctx.setFillColor(fill); ctx.addPath(s.path); ctx.fillPath() }
                stroke(s)
            }
        }
        func drawDecorations(where test: (CanvasDecoration) -> Bool) {
            for d in ground.decorations where test(d) {
                if p.far && d.hiddenWhenFar { continue }
                if let visible, !d.rect.insetBy(dx: -4, dy: -4).intersects(visible) { continue }
                ctx.saveGState()
                ctx.translateBy(x: d.rect.minX, y: d.rect.minY)
                CanvasDecorationPainter.draw(d, in: ctx, paint: p)
                ctx.restoreGState()
            }
        }
        drawShapes([.frame])
        drawDecorations { if case .frameLabel = $0.content { true } else { false } }
        drawDecorations { if case .time = $0.content { true } else { false } }
        drawShapes([.trackLine])
        drawShapes([.seam])
        drawDecorations { if case .seamTokens = $0.content { true } else { false } }
        drawShapes([.edge, .edgeEnd])
        drawDecorations { if case .silence = $0.content { true } else { false } }
    }

    /// One tile of the dot grid, [tileDev] device pixels square, the dot in its middle (what a repeating background of it shows): the dot is
    /// evaluated at pixel centres, as the browser's gradient is, full ink to 1 css px and none from 1.2.
    static func dotTile(ink: CGColor, tileDev: Int, scale: CGFloat) -> CGImage? {
        let n = tileDev
        let c = CGFloat(n) / 2
        let rgb = ink.converted(to: CanvasPaint.srgb, intent: .defaultIntent, options: nil)?.components ?? [0, 0, 0, 1]
        let alpha = 0.0985 * (rgb.count > 3 ? rgb[3] : 1)
        var pixels = [UInt8](repeating: 0, count: n * n * 4)
        let r1 = 1.0 * scale, r2 = 1.2 * scale
        for j in max(0, Int(c - r2) - 1)..<min(n, Int(c + r2) + 2) {
            for i in max(0, Int(c - r2) - 1)..<min(n, Int(c + r2) + 2) {
                let d = hypot(CGFloat(i) + 0.5 - c, CGFloat(j) + 0.5 - c)
                let cover = d <= r1 ? 1 : d >= r2 ? 0 : (r2 - d) / (r2 - r1)
                let a = alpha * Double(cover)
                let o = (j * n + i) * 4
                pixels[o] = UInt8((Double(rgb[0]) * a * 255).rounded()); pixels[o + 1] = UInt8((Double(rgb[1]) * a * 255).rounded()); pixels[o + 2] = UInt8((Double(rgb[2]) * a * 255).rounded()); pixels[o + 3] = UInt8((a * 255).rounded())
            }
        }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
        return CGImage(width: n, height: n, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: n * 4, space: CanvasPaint.srgb, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    /// The dots under the world: `radial-gradient(fg 9%, 1px, transparent 1.2px)` tiled every `22 * k` (four times that below k 0.5).
    /// The browser snaps the tile and the layer's offset to whole device pixels, and so does this; [scale] is the device scale.
    static func drawDots(in ctx: CGContext, paint p: CanvasPaint, camera: (x: CGFloat, y: CGFloat, k: CGFloat), size: CGSize, scale: CGFloat = 2) {
        let tile = 22 * camera.k * (camera.k < 0.5 ? 4 : 1)
        let tileDev = max(1, (tile * scale).rounded())
        func offset(_ v: CGFloat) -> CGFloat {
            let css = (v.truncatingRemainder(dividingBy: tile) + tile).truncatingRemainder(dividingBy: tile) - tile
            return (css * scale).rounded()
        }
        let ox = offset(camera.x), oy = offset(camera.y)
        // The dot is evaluated at pixel centres, as the browser's gradient is: full ink to 1 css px, none from 1.2.
        let odd = Int(tileDev) % 2 == 1
        let n = 8
        let c = CGFloat(n) / 2 + (odd ? 0.5 : 0)   // the dot's centre in the image's pixel space: a pixel centre or a pixel corner
        let ink = p.palette.fg
        let alpha = 0.0985
        var pixels = [UInt8](repeating: 0, count: n * n * 4)
        for j in 0..<n { for i in 0..<n {
            let d = hypot(CGFloat(i) + 0.5 - c, CGFloat(j) + 0.5 - c)
            let r1 = 1.0 * scale, r2 = 1.2 * scale
            let cover = d <= r1 ? 1 : d >= r2 ? 0 : (r2 - d) / (r2 - r1)
            let a = alpha * Double(cover)
            let o = (j * n + i) * 4
            pixels[o] = UInt8((ink.red * a * 255).rounded()); pixels[o + 1] = UInt8((ink.green * a * 255).rounded()); pixels[o + 2] = UInt8((ink.blue * a * 255).rounded()); pixels[o + 3] = UInt8((a * 255).rounded())
        } }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
              let image = CGImage(width: n, height: n, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: n * 4, space: CanvasPaint.srgb, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { return }
        ctx.saveGState()
        ctx.interpolationQuality = .none
        var y = oy + tileDev / 2
        while y < size.height * scale + 4 {
            var x = ox + tileDev / 2
            while x < size.width * scale + 4 {
                // The image is y-up under a y-down CTM: flip it about its own box.
                let rect = CGRect(x: (x.rounded(.down) - CGFloat(n) / 2) / scale, y: (y.rounded(.down) - CGFloat(n) / 2) / scale, width: CGFloat(n) / scale, height: CGFloat(n) / scale)
                ctx.saveGState()
                ctx.translateBy(x: rect.minX, y: rect.maxY); ctx.scaleBy(x: 1, y: -1)
                ctx.draw(image, in: CGRect(x: 0, y: 0, width: rect.width, height: rect.height))
                ctx.restoreGState()
                x += tileDev
            }
            y += tileDev
        }
        ctx.restoreGState()
    }
}
