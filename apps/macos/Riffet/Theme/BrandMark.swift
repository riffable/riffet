import AppKit
import SwiftUI

/// The Riffet mark (`docs/brand/mark.svg`) on a 24×24 grid: a solid horse head in `front` with its
/// eye cut out, over a three-tooth mane in `back`. A copy of the paths in `scripts/gen-brand.ts`.
struct BrandMark: View {
    let front: Color
    let back: Color

    var body: some View {
        Canvas { context, size in
            let rect = CGRect(origin: .zero, size: size)
            let shape = Self.shape(in: rect)
            let side = min(size.width, size.height)
            context.fill(shape.mane, with: .color(back))
            context.stroke(shape.mane, with: .color(back), style: Self.style(width: 0.6, side: side))
            context.fill(shape.head, with: .color(front), style: FillStyle(eoFill: true))
            context.stroke(shape.outline, with: .color(front), style: Self.style(width: 1, side: side))
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }

    /// The mane, the head's outline, and the outline with the eye added (fill it even-odd for the
    /// hole), scaled into the largest square centred in `rect`. The mark's optical centre (12.6,
    /// 11.8) lands on the rect's centre: the head leans right and sits a little high on its grid.
    nonisolated static func shape(in rect: CGRect) -> (mane: Path, outline: Path, head: Path) {
        let side = min(rect.width, rect.height)
        let scale = side / 24
        let origin = CGPoint(x: rect.midX - 12.6 * scale, y: rect.midY - 11.8 * scale)
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x * scale, y: origin.y + y * scale) }
        var mane = Path()
        mane.move(to: p(8.77, 6.2)); mane.addQuadCurve(to: p(5.15, 8.55), control: p(6.51, 6.56))
        mane.addLine(to: p(7.76, 8.17)); mane.addQuadCurve(to: p(4.26, 11.65), control: p(5.43, 9.17))
        mane.addLine(to: p(6.94, 10.68)); mane.addQuadCurve(to: p(3.82, 15.1), control: p(4.72, 12.24))
        mane.addLine(to: p(6.42, 13.42)); mane.closeSubpath()
        var outline = Path()
        outline.move(to: p(6, 21))
        outline.addCurve(to: p(8.8, 5.8), control1: p(5.6, 14.4), control2: p(6.6, 9))
        outline.addLine(to: p(9.4, 2.6)); outline.addLine(to: p(11.2, 5.4))
        outline.addCurve(to: p(20, 10.8), control1: p(14.4, 6.6), control2: p(17.4, 8.4))
        outline.addCurve(to: p(19, 14.2), control1: p(21.3, 12), control2: p(20.7, 14.2))
        outline.addCurve(to: p(14.6, 13.6), control1: p(17.6, 14.2), control2: p(16, 13.9))
        outline.addCurve(to: p(12.2, 15.2), control1: p(13.2, 13.3), control2: p(12.3, 13.9))
        outline.addCurve(to: p(13, 21), control1: p(12.1, 17.2), control2: p(12.4, 19.2))
        outline.closeSubpath()
        var head = outline
        head.addEllipse(in: CGRect(x: p(11.5, 7.2).x, y: p(11.5, 7.2).y, width: 2 * scale, height: 2 * scale))
        return (mane, outline, head)
    }

    /// `width` grid units of round-join stroke.
    nonisolated static func style(width: CGFloat, side: CGFloat) -> StrokeStyle {
        StrokeStyle(lineWidth: width * side / 24, lineJoin: .round)
    }

    /// The single-colour mark as a template image, square like a menu bar symbol.
    nonisolated static func templateImage(side: CGFloat = 18) -> NSImage {
        let image = NSImage(size: NSSize(width: side, height: side), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            let shape = Self.shape(in: rect)
            let side = min(rect.width, rect.height)
            context.setFillColor(NSColor.black.cgColor)
            context.setStrokeColor(NSColor.black.cgColor)
            context.setLineJoin(.round)
            context.setLineWidth(0.6 * side / 24)
            context.addPath(shape.mane.cgPath)
            context.drawPath(using: .fillStroke)
            context.addPath(shape.head.cgPath)
            context.fillPath(using: .evenOdd)
            context.setLineWidth(side / 24)
            context.addPath(shape.outline.cgPath)
            context.strokePath()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Riffet"
        return image
    }
}

/// The six loops of `LiveBrandMark`, as on web (`apps/web/src/styles/index.css`, `brand-*`).
enum LiveBrandStyle: CaseIterable {
    case mane, mood, beat, draw, run, gaze

    static func random(except: LiveBrandStyle? = nil) -> LiveBrandStyle {
        allCases.filter { $0 != except }.randomElement() ?? .mane
    }
}

/// The mark as a living logo: with no `style` it plays a random loop each time it appears and a
/// click swaps it for another; with one it plays just that, not interactive. Decoration only, so
/// it reports nothing. Drawn from the clock in one `Canvas`, paused while the window is hidden; the
/// frame fixes its size (the speed lines of `run` spill past it). Reduce Motion draws the static mark.
struct LiveBrandMark: View {
    let front: Color
    let back: Color
    var style: LiveBrandStyle?
    /// Plays the `draw` loop's first pass, faster, and stays drawn: the welcome page's one-time mark.
    var once = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var settled = false
    @State private var picked = LiveBrandStyle.random()
    @State private var startedAt = Date()
    @State private var bounceAt: Date?
    @State private var visible = true
    @State private var model = LiveBrandModel()

    /// How much larger than the frame the canvas is, so the speed lines and a bounce are not clipped.
    private static let spill: CGFloat = 1.8

    init(front: Color, back: Color, style: LiveBrandStyle? = nil, once: Bool = false) {
        self.front = front
        self.back = back
        self.style = once ? .draw : style
        self.once = once
    }

    var body: some View {
        if reduceMotion {
            BrandMark(front: front, back: back)
        } else {
            let current = style ?? picked
            GeometryReader { geo in
                // motion-loop: ambient brand mark in the logo slot, static under Reduce Motion
                TimelineView(.animation(minimumInterval: nil, paused: !visible || settled)) { timeline in
                    Canvas { context, size in
                        let now = timeline.date
                        let raw = max(0, now.timeIntervalSince(startedAt))
                        // The loop's drawn pose lasts from 78% to 92% of its 4.2 s; a first pass at 1.75x ends there.
                        let elapsed = once ? min(raw * 1.75, 3.5) : raw
                        let bounce = bounceAt.map { now.timeIntervalSince($0) } ?? 1
                        LiveBrandMark.draw(context: context, size: size, style: current, elapsed: elapsed,
                                           bounce: bounce, now: now, model: model, front: front, back: back)
                    }
                    .frame(width: geo.size.width * Self.spill, height: geo.size.height * Self.spill)
                    .frame(width: geo.size.width, height: geo.size.height)
                }
            }
            .background(LiveBrandProbe(probe: model.probe, visible: $visible))
            .contentShape(Rectangle())
            .onTapGesture { if style == nil { swap() } }
            .allowsHitTesting(style == nil)
            .pointerStyle(style == nil ? .link : .default)
            .accessibilityHidden(true)
            .task(id: once) {
                guard once else { return }
                try? await Task.sleep(for: .seconds(2.2))
                settled = true
            }
        }
    }

    private func swap() {
        picked = LiveBrandStyle.random(except: picked)
        startedAt = Date()
        bounceAt = Date()
    }
}

// MARK: - Keyframes

/// One part's pose. `fill`, `dash` and `opacity` serve `draw`; the rest is a CSS transform
/// (translate, rotate, scale), applied about the part's pivot.
private struct LivePose {
    var tx = 0.0, ty = 0.0, rot = 0.0, sx = 1.0, sy = 1.0, opacity = 1.0, fill = 1.0, dash = 0.0

    func mixed(_ other: LivePose, _ t: Double) -> LivePose {
        func m(_ a: Double, _ b: Double) -> Double { a + (b - a) * t }
        return LivePose(tx: m(tx, other.tx), ty: m(ty, other.ty), rot: m(rot, other.rot), sx: m(sx, other.sx), sy: m(sy, other.sy),
                        opacity: m(opacity, other.opacity), fill: m(fill, other.fill), dash: m(dash, other.dash))
    }
}

/// The timing function between two keyframes (CSS applies it per interval).
private enum LiveEase {
    case bezier(Double, Double, Double, Double)
    case steps(Int)
    case linear

    static let ease = LiveEase.bezier(0.25, 0.1, 0.25, 1)
    static let easeInOut = LiveEase.bezier(0.42, 0, 0.58, 1)
    static let easeOut = LiveEase.bezier(0, 0, 0.58, 1)

    func apply(_ x: Double) -> Double {
        switch self {
        case .linear: return x
        case let .steps(n): return min(1, (x * Double(n)).rounded(.down) / Double(n))
        case let .bezier(x1, y1, x2, y2):
            func curve(_ t: Double, _ a: Double, _ b: Double) -> Double {
                let u = 1 - t
                return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
            }
            var lo = 0.0, hi = 1.0
            for _ in 0..<24 {
                let mid = (lo + hi) / 2
                if curve(mid, x1, x2) < x { lo = mid } else { hi = mid }
            }
            return curve((lo + hi) / 2, y1, y2)
        }
    }
}

/// A looping CSS animation: keyframes at percent offsets, one timing function per interval.
private struct LiveTrack {
    let duration: Double
    let ease: LiveEase
    var delay = 0.0
    let frames: [(Double, LivePose)]

    func pose(at time: Double) -> LivePose {
        let elapsed = time - delay
        guard elapsed >= 0 else { return LivePose() }
        let percent = elapsed.truncatingRemainder(dividingBy: duration) / duration * 100
        for index in 1..<frames.count where percent < frames[index].0 {
            let (from, to) = (frames[index - 1], frames[index])
            let span = to.0 - from.0
            return from.1.mixed(to.1, ease.apply(span > 0 ? (percent - from.0) / span : 1))
        }
        return frames[frames.count - 1].1
    }
}

private struct LiveRig {
    var whole: LiveTrack?
    var teeth: [LiveTrack?] = [nil, nil, nil]
    var ear: LiveTrack?
    var eye: LiveTrack?
    var head: LiveTrack?
    var speed: [LiveTrack] = []
    var hidesEar = false
}

private extension LiveBrandStyle {
    var rig: LiveRig {
        func P(tx: Double = 0, ty: Double = 0, rot: Double = 0, sx: Double = 1, sy: Double = 1, opacity: Double = 1, fill: Double = 1, dash: Double = 0) -> LivePose {
            LivePose(tx: tx, ty: ty, rot: rot, sx: sx, sy: sy, opacity: opacity, fill: fill, dash: dash)
        }
        func T(_ duration: Double, _ ease: LiveEase, delay: Double = 0, _ frames: [(Double, LivePose)]) -> LiveTrack {
            LiveTrack(duration: duration, ease: ease, delay: delay, frames: frames)
        }
        let rest = P()
        switch self {
        case .mane:
            let gust: (Double) -> LiveTrack = { delay in
                T(1.8, .bezier(0.3, 0.7, 0.3, 1), delay: delay, [(0, rest), (18, P(rot: 11)), (36, P(rot: -3)), (55, rest), (100, rest)])
            }
            return LiveRig(teeth: [gust(0), gust(0.13), gust(0.26)])
        case .mood:
            let sway: (Double) -> LiveTrack = { delay in T(5, .easeInOut, delay: delay, [(0, rest), (50, P(rot: 3)), (100, rest)]) }
            return LiveRig(
                whole: T(5, .easeInOut, [(0, rest), (50, P(rot: 1.6)), (100, rest)]),
                teeth: [sway(0), sway(-0.4), sway(-0.8)],
                ear: T(5, .easeOut, [(0, rest), (66, rest), (69, P(rot: -13)), (72, P(rot: -2)), (75, P(rot: -13)), (78, rest), (100, rest)]),
                eye: T(5, .ease, [(0, rest), (44, rest), (47, P(sy: 0.08)), (50, rest), (100, rest)])
            )
        case .beat:
            let note = P(rot: 7, sx: 1.34, sy: 1.34)
            let step = LiveEase.steps(12)
            let chord: [(Double, LivePose)] = [(75, rest), (75.1, note), (80, note), (95, rest), (100, rest)]
            return LiveRig(
                whole: T(2, .steps(16), [(0, P(rot: 2.4)), (12, rest), (25, P(rot: 2.4)), (37, rest), (50, P(rot: 2.4)), (62, rest), (75, P(rot: 2.4)), (90, rest), (100, P(rot: 2.4))]),
                teeth: [
                    T(2, step, [(0, note), (12.5, note), (25, rest)] + chord),
                    T(2, step, [(0, rest), (25, rest), (25.1, note), (37.5, note), (50, rest)] + chord),
                    T(2, step, [(0, rest), (50, rest), (50.1, note), (62.5, note)] + chord),
                ]
            )
        case .draw:
            let pop: (Double) -> LiveTrack = { start in
                T(4.2, .easeOut, [(0, P(sx: 0, sy: 0)), (start, P(sx: 0, sy: 0)), (start + 8, P(sx: 1.15, sy: 1.15)), (start + 12, rest), (92, rest), (100, P(opacity: 0))])
            }
            return LiveRig(
                teeth: [pop(44), pop(50), pop(56)],
                eye: T(4.2, .easeOut, [(0, P(sx: 0, sy: 0)), (68, P(sx: 0, sy: 0)), (74, P(sx: 1.2, sy: 1.2)), (78, rest), (100, rest)]),
                head: T(4.2, .easeInOut, [(0, P(fill: 0, dash: 1)), (34, P(fill: 0)), (44, rest), (92, rest), (100, P(opacity: 0))]),
                hidesEar: true
            )
        case .run:
            let stream: (Double) -> LiveTrack = { delay in
                T(0.23, .easeInOut, delay: delay, [(0, P(rot: 14, sx: 1.18)), (50, P(rot: 22, sx: 1.3)), (100, P(rot: 14, sx: 1.18))])
            }
            let dash: (Double) -> LiveTrack = { delay in
                T(0.7, .linear, delay: delay, [(0, P(tx: 9, opacity: 0)), (25, P(tx: 5)), (100, P(tx: -7, opacity: 0))])
            }
            return LiveRig(
                whole: T(0.46, .easeInOut, [(0, P(rot: -5)), (50, P(tx: 0.3, ty: -0.9, rot: -8)), (100, P(rot: -5))]),
                teeth: [stream(0), stream(-0.08), stream(-0.16)],
                speed: [dash(0), dash(-0.25), dash(-0.5)]
            )
        case .gaze:
            let alert = LiveEase.bezier(0.3, 1.5, 0.5, 1)
            let raise: (Double) -> LiveTrack = { angle in T(5, alert, [(0, rest), (56, rest), (60, P(rot: angle)), (78, P(rot: angle)), (82, rest), (100, rest)]) }
            return LiveRig(
                teeth: [raise(15), raise(15), raise(15)],
                ear: raise(9),
                eye: T(5, .bezier(0.4, 0, 0.2, 1), [(0, rest), (20, rest), (26, P(tx: 0.55, ty: 0.5)), (52, P(tx: 0.55, ty: 0.5)), (58, P(tx: 0.55, ty: -0.25)), (80, P(tx: 0.55, ty: -0.25)), (86, rest), (100, rest)])
            )
        }
    }

    /// Computed once per style.
    static let rigs: [LiveBrandStyle: LiveRig] = Dictionary(uniqueKeysWithValues: allCases.map { ($0, $0.rig) })
}

// MARK: - Geometry

/// The parts on the 24-unit grid: the mane's teeth extend under the head so each can swing.
private enum LiveGeometry {
    static let grid = BrandMark.shape(in: CGRect(x: 0.6, y: -0.2, width: 24, height: 24))
    static let eye = Path(ellipseIn: CGRect(x: 11.5, y: 7.2, width: 2, height: 2))
    static let ear: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 8.8, y: 5.8)); path.addLine(to: CGPoint(x: 9.4, y: 2.6)); path.addLine(to: CGPoint(x: 11.2, y: 5.4))
        path.addLine(to: CGPoint(x: 10.6, y: 7.2)); path.addLine(to: CGPoint(x: 9.2, y: 7.2)); path.closeSubpath()
        return path
    }()
    static let teeth: [(path: Path, pivot: CGPoint)] = [
        (tooth(8.77, 6.2, 6.51, 6.56, 5.15, 8.55, 7.76, 8.17, 9.3, 9.2, 9.7, 6.4), CGPoint(x: 8.9, y: 7.6)),
        (tooth(7.76, 8.17, 5.43, 9.17, 4.26, 11.65, 6.94, 10.68, 8.7, 11.8, 9.1, 8.4), CGPoint(x: 8.2, y: 10.2)),
        (tooth(6.94, 10.68, 4.72, 12.24, 3.82, 15.1, 6.42, 13.42, 8.2, 14.6, 8.6, 11), CGPoint(x: 7.6, y: 13)),
    ]
    static let speed: [Path] = [(1, 9, 3.2), (0, 13.5, 4), (2, 17.5, 2.6)].map { x, y, length in
        var path = Path()
        path.move(to: CGPoint(x: x, y: y)); path.addLine(to: CGPoint(x: x + length, y: y))
        return path
    }
    static let wholePivot = CGPoint(x: 9, y: 21)
    static let earPivot = CGPoint(x: 10, y: 5.9)
    static let eyePivot = CGPoint(x: 12.5, y: 8.2)

    /// M a Q c b L d L e L f Z
    private static func tooth(_ ax: CGFloat, _ ay: CGFloat, _ cx: CGFloat, _ cy: CGFloat, _ bx: CGFloat, _ by: CGFloat,
                              _ dx: CGFloat, _ dy: CGFloat, _ ex: CGFloat, _ ey: CGFloat, _ fx: CGFloat, _ fy: CGFloat) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: ax, y: ay))
        path.addQuadCurve(to: CGPoint(x: bx, y: by), control: CGPoint(x: cx, y: cy))
        path.addLine(to: CGPoint(x: dx, y: dy)); path.addLine(to: CGPoint(x: ex, y: ey)); path.addLine(to: CGPoint(x: fx, y: fy))
        path.closeSubpath()
        return path
    }
}

// MARK: - Drawing

private extension GraphicsContext {
    /// Moves by `pose` about `pivot` (CSS order: translate, rotate, scale).
    mutating func apply(_ pose: LivePose, about pivot: CGPoint) {
        translateBy(x: pivot.x + pose.tx, y: pivot.y + pose.ty)
        rotate(by: .degrees(pose.rot))
        scaleBy(x: pose.sx, y: pose.sy)
        translateBy(x: -pivot.x, y: -pivot.y)
    }
}

extension LiveBrandMark {
    fileprivate static func draw(context: GraphicsContext, size: CGSize, style: LiveBrandStyle, elapsed: Double, bounce: Double,
                                 now: Date, model: LiveBrandModel, front: Color, back: Color) {
        let rig = LiveBrandStyle.rigs[style] ?? LiveRig()
        let side = min(size.width, size.height) / spill
        let scale = side / 24
        var root = context
        // The click bounce turns the whole view about its centre.
        if bounce < 0.36 {
            let bounced = LiveTrack(duration: 0.36, ease: .bezier(0.2, 0.8, 0.3, 1), frames: [
                (0, LivePose(rot: -4, sx: 0.86, sy: 0.86)), (55, LivePose(rot: 2, sx: 1.07, sy: 1.07)), (100, LivePose()),
            ]).pose(at: bounce)
            root.apply(bounced, about: CGPoint(x: size.width / 2, y: size.height / 2))
        }
        // Grid units from here, the mark's optical centre (12.6, 11.8) on the canvas centre.
        root.translateBy(x: size.width / 2 - 12.6 * scale, y: size.height / 2 - 11.8 * scale)
        root.scaleBy(x: scale, y: scale)

        for (index, track) in rig.speed.enumerated() {
            let pose = track.pose(at: elapsed)
            var line = root
            line.opacity = pose.opacity
            line.translateBy(x: pose.tx, y: 0)
            line.stroke(LiveGeometry.speed[index], with: .color(back), style: StrokeStyle(lineWidth: 0.7, lineCap: .round, lineJoin: .round))
        }

        var whole = root
        whole.apply(rig.whole?.pose(at: elapsed) ?? LivePose(), about: LiveGeometry.wholePivot)

        for (index, tooth) in LiveGeometry.teeth.enumerated() {
            let pose = rig.teeth[index]?.pose(at: elapsed) ?? LivePose()
            guard abs(pose.sx) > 0.001, abs(pose.sy) > 0.001 else { continue }
            var part = whole
            part.opacity = pose.opacity
            part.apply(pose, about: tooth.pivot)
            part.fill(tooth.path, with: .color(back))
            part.stroke(tooth.path, with: .color(back), style: StrokeStyle(lineWidth: 0.6, lineJoin: .round))
        }

        let head = rig.head?.pose(at: elapsed) ?? LivePose()
        let eye = rig.eye?.pose(at: elapsed) ?? LivePose()
        let ear = rig.hidesEar ? nil : (rig.ear?.pose(at: elapsed) ?? LivePose())
        var look = CGSize.zero
        if style == .gaze { look = model.gaze(now: now, scale: scale) }
        let stroke = StrokeStyle(lineWidth: 1, lineJoin: .round)

        var headContext = whole
        headContext.opacity = head.opacity
        headContext.drawLayer { layer in
            layer.fill(LiveGeometry.grid.outline, with: .color(front.opacity(head.fill)))
            let trimmed = head.dash > 0 ? LiveGeometry.grid.outline.trimmedPath(from: 0, to: max(0, min(1, 1 - head.dash + 0.02))) : LiveGeometry.grid.outline
            layer.stroke(trimmed, with: .color(front), style: stroke)
            if let ear {
                var part = layer
                part.apply(ear, about: LiveGeometry.earPivot)
                part.fill(LiveGeometry.ear, with: .color(front))
                part.stroke(LiveGeometry.ear, with: .color(front), style: stroke)
            }
            // The eye is a hole: cut it out of what is drawn, so whatever is behind shows through.
            if abs(eye.sx) > 0.001, abs(eye.sy) > 0.001 {
                var hole = layer
                hole.blendMode = .destinationOut
                hole.apply(eye, about: LiveGeometry.eyePivot)
                hole.translateBy(x: look.width, y: look.height)
                hole.fill(LiveGeometry.eye, with: .color(.black))
            }
        }
    }
}

// MARK: - Pointer and visibility

/// Per-view state that is not a SwiftUI value: the eye's smoothed offset in `gaze`, and the probe.
@MainActor
private final class LiveBrandModel {
    lazy var probe = LiveBrandProbeView()
    private var offset = CGSize.zero
    private var lastPointer: CGPoint?
    private var lastMove = Date.distantPast
    private var lastFrame: Date?

    /// Where the eye looks, in grid units: toward the pointer while it moves, and for 4s after it
    /// rests; otherwise the wander of the `gaze` keyframes (offset zero here, the track supplies it).
    /// The pointer is read from the screen each frame, so it is followed across the whole window.
    func gaze(now: Date, scale: CGFloat) -> CGSize {
        if let pointer = probe.pointer() {
            if let last = lastPointer, hypot(pointer.x - last.x, pointer.y - last.y) > 0.5 { lastMove = now }
            lastPointer = pointer
        }
        let tracking = now.timeIntervalSince(lastMove) < 4
        var target = CGSize.zero
        if tracking, let pointer = lastPointer {
            let size = probe.bounds.size
            let dx = pointer.x - size.width / 2 - (11.9 - 12.6) * scale
            let dy = pointer.y - size.height / 2 - (8.4 - 11.8) * scale
            let distance = max(hypot(dx, dy), 0.001)
            let reach = min(1, distance / 140) * 0.6
            target = CGSize(width: dx / distance * reach, height: dy / distance * reach)
        }
        let dt = lastFrame.map { min(0.1, now.timeIntervalSince($0)) } ?? 1 / 60
        lastFrame = now
        let k = 1 - pow(1 - 0.16, dt * 60)
        offset.width += (target.width - offset.width) * k
        offset.height += (target.height - offset.height) * k
        return offset
    }
}

/// A transparent view behind the mark that knows its window: the pointer in its own coordinates,
/// and whether the window is on screen.
private final class LiveBrandProbeView: NSView {
    var onVisibility: ((Bool) -> Void)?
    private var observers: [NSObjectProtocol] = []

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        if let window {
            observers = [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification].map {
                NotificationCenter.default.addObserver(forName: $0, object: window, queue: .main) { [weak self] _ in self?.report() }
            }
        }
        report()
    }

    private func report() {
        let visible = window.map { $0.occlusionState.contains(.visible) && !$0.isMiniaturized } ?? false
        onVisibility?(visible)
    }

    /// The pointer in this view's coordinates, while the app is active.
    func pointer() -> CGPoint? {
        guard let window, NSApp.isActive else { return nil }
        return convert(window.convertPoint(fromScreen: NSEvent.mouseLocation), from: nil)
    }
}

private struct LiveBrandProbe: NSViewRepresentable {
    let probe: LiveBrandProbeView
    @Binding var visible: Bool

    func makeNSView(context: Context) -> LiveBrandProbeView {
        probe.onVisibility = { value in DispatchQueue.main.async { if visible != value { visible = value } } }
        return probe
    }

    func updateNSView(_ view: LiveBrandProbeView, context: Context) {}
}

/// The Dock icon choices (`scripts/gen-brand.ts`): one dark tile, a different accent on the mane.
/// The default is the bundle's own icon; the others are the `AppIcon-<id>` image sets.
struct AppIconVariant: Identifiable {
    let id: String
    let name: String
    let accent: Color

    static let defaultId = "blue"
    static let tile = rgb(0x15171A)

    static let all: [AppIconVariant] = [
        AppIconVariant(id: defaultId, name: String(localized: "蓝色"), accent: rgb(0x5B8CFF)),
        AppIconVariant(id: "purple", name: String(localized: "紫色"), accent: rgb(0xA78BFA)),
        AppIconVariant(id: "magenta", name: String(localized: "品红"), accent: rgb(0xE879F9)),
        AppIconVariant(id: "pink", name: String(localized: "粉色"), accent: rgb(0xF472B6)),
        AppIconVariant(id: "red", name: String(localized: "红色"), accent: rgb(0xF87171)),
        AppIconVariant(id: "orange", name: String(localized: "橙色"), accent: rgb(0xF5A142)),
        AppIconVariant(id: "yellow", name: String(localized: "黄色"), accent: rgb(0xFACC15)),
        AppIconVariant(id: "lime", name: String(localized: "青柠"), accent: rgb(0xA3E635)),
        AppIconVariant(id: "green", name: String(localized: "绿色"), accent: rgb(0x3FCF8E)),
        AppIconVariant(id: "cyan", name: String(localized: "青色"), accent: rgb(0x22D3EE)),
        AppIconVariant(id: "graphite", name: String(localized: "石墨"), accent: rgb(0x9AA0A8)),
        AppIconVariant(id: "white", name: String(localized: "白色"), accent: rgb(0xF4F4F2)),
    ]

    /// The variant with this id; an unknown id reads as the default.
    static func named(_ id: String) -> AppIconVariant {
        all.first { $0.id == id } ?? all[0]
    }

    var isDefault: Bool { id == Self.defaultId }

    /// The image to put in the Dock, or nil for the bundle's icon.
    var image: NSImage? { isDefault ? nil : NSImage(named: "AppIcon-\(id)") }

    private static func rgb(_ value: UInt32) -> Color {
        Color(.sRGB, red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }
}
