import SwiftUI
import UIKit

/// Home-screen icon accents. `id` is the contract in `scripts/gen-brand.ts`: every variant but the
/// default ships as the alternate icon `AppIcon-<id>`.
struct AppIconVariant: Identifiable, Equatable {
    let id: String
    let name: String
    let accent: Color

    static let all: [AppIconVariant] = [
        AppIconVariant(id: "blue", name: String(localized: "蓝色", bundle: .riffet), rgb: 0x5b8cff),
        AppIconVariant(id: "purple", name: String(localized: "紫色", bundle: .riffet), rgb: 0xa78bfa),
        AppIconVariant(id: "magenta", name: String(localized: "品红", bundle: .riffet), rgb: 0xe879f9),
        AppIconVariant(id: "pink", name: String(localized: "粉色", bundle: .riffet), rgb: 0xf472b6),
        AppIconVariant(id: "red", name: String(localized: "红色", bundle: .riffet), rgb: 0xf87171),
        AppIconVariant(id: "orange", name: String(localized: "橙色", bundle: .riffet), rgb: 0xf5a142),
        AppIconVariant(id: "yellow", name: String(localized: "黄色", bundle: .riffet), rgb: 0xfacc15),
        AppIconVariant(id: "lime", name: String(localized: "青柠", bundle: .riffet), rgb: 0xa3e635),
        AppIconVariant(id: "green", name: String(localized: "绿色", bundle: .riffet), rgb: 0x3fcf8e),
        AppIconVariant(id: "cyan", name: String(localized: "青色", bundle: .riffet), rgb: 0x22d3ee),
        AppIconVariant(id: "graphite", name: String(localized: "石墨", bundle: .riffet), rgb: 0x9aa0a8),
        AppIconVariant(id: "white", name: String(localized: "白色", bundle: .riffet), rgb: 0xf4f4f2),
    ]

    /// The system keeps the choice; nil is the primary icon.
    @MainActor static var current: AppIconVariant {
        let name = UIApplication.shared.alternateIconName
        return all.first { $0.alternateIconName == name } ?? all[0]
    }

    var alternateIconName: String? { id == "blue" ? nil : "AppIcon-\(id)" }

    private init(id: String, name: String, rgb: UInt32) {
        self.id = id
        self.name = name
        accent = Color(red: Double(rgb >> 16 & 0xff) / 255, green: Double(rgb >> 8 & 0xff) / 255, blue: Double(rgb & 0xff) / 255)
    }
}

/// The Riffet mark's shapes on its 24-unit grid, a copy of the paths in `scripts/gen-brand.ts`; the
/// static and the living mark both draw from here. The mark's optical centre is (12.6, 11.8).
enum BrandGeometry {
    static let opticalCentre = CGPoint(x: 12.6, y: 11.8)
    static let strokeWidth: CGFloat = 1
    static let maneStrokeWidth: CGFloat = 0.6
    static let eye = CGRect(x: 11.5, y: 7.2, width: 2, height: 2)

    static let outline: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 6, y: 21))
        path.addCurve(to: CGPoint(x: 8.8, y: 5.8), control1: CGPoint(x: 5.6, y: 14.4), control2: CGPoint(x: 6.6, y: 9))
        path.addLine(to: CGPoint(x: 9.4, y: 2.6)); path.addLine(to: CGPoint(x: 11.2, y: 5.4))
        path.addCurve(to: CGPoint(x: 20, y: 10.8), control1: CGPoint(x: 14.4, y: 6.6), control2: CGPoint(x: 17.4, y: 8.4))
        path.addCurve(to: CGPoint(x: 19, y: 14.2), control1: CGPoint(x: 21.3, y: 12), control2: CGPoint(x: 20.7, y: 14.2))
        path.addCurve(to: CGPoint(x: 14.6, y: 13.6), control1: CGPoint(x: 17.6, y: 14.2), control2: CGPoint(x: 16, y: 13.9))
        path.addCurve(to: CGPoint(x: 12.2, y: 15.2), control1: CGPoint(x: 13.2, y: 13.3), control2: CGPoint(x: 12.3, y: 13.9))
        path.addCurve(to: CGPoint(x: 13, y: 21), control1: CGPoint(x: 12.1, y: 17.2), control2: CGPoint(x: 12.4, y: 19.2))
        path.closeSubpath()
        return path
    }()
    static let head: Path = { var path = outline; path.addEllipse(in: eye); return path }()

    /// The three-tooth mane as one shape.
    static let mane: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 8.77, y: 6.2)); path.addQuadCurve(to: CGPoint(x: 5.15, y: 8.55), control: CGPoint(x: 6.51, y: 6.56))
        path.addLine(to: CGPoint(x: 7.76, y: 8.17)); path.addQuadCurve(to: CGPoint(x: 4.26, y: 11.65), control: CGPoint(x: 5.43, y: 9.17))
        path.addLine(to: CGPoint(x: 6.94, y: 10.68)); path.addQuadCurve(to: CGPoint(x: 3.82, y: 15.1), control: CGPoint(x: 4.72, y: 12.24))
        path.addLine(to: CGPoint(x: 6.42, y: 13.42)); path.closeSubpath()
        return path
    }()

    /// The teeth as separate shapes reaching under the head so each can swing about its pivot.
    static let teeth: [(path: Path, pivot: CGPoint)] = {
        func tooth(_ start: (CGFloat, CGFloat), _ control: (CGFloat, CGFloat), _ tip: (CGFloat, CGFloat), _ a: (CGFloat, CGFloat),
                   _ b: (CGFloat, CGFloat), _ c: (CGFloat, CGFloat)) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: start.0, y: start.1))
            path.addQuadCurve(to: CGPoint(x: tip.0, y: tip.1), control: CGPoint(x: control.0, y: control.1))
            for point in [a, b, c] { path.addLine(to: CGPoint(x: point.0, y: point.1)) }
            path.closeSubpath()
            return path
        }
        return [
            (tooth((8.77, 6.2), (6.51, 6.56), (5.15, 8.55), (7.76, 8.17), (9.3, 9.2), (9.7, 6.4)), CGPoint(x: 8.9, y: 7.6)),
            (tooth((7.76, 8.17), (5.43, 9.17), (4.26, 11.65), (6.94, 10.68), (8.7, 11.8), (9.1, 8.4)), CGPoint(x: 8.2, y: 10.2)),
            (tooth((6.94, 10.68), (4.72, 12.24), (3.82, 15.1), (6.42, 13.42), (8.2, 14.6), (8.6, 11)), CGPoint(x: 7.6, y: 13)),
        ]
    }()
    static let ear: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 8.8, y: 5.8))
        for (x, y) in [(9.4, 2.6), (11.2, 5.4), (10.6, 7.2), (9.2, 7.2)] as [(CGFloat, CGFloat)] { path.addLine(to: CGPoint(x: x, y: y)) }
        path.closeSubpath()
        return path
    }()
    /// Three speed lines left of the head, as horizontal segments.
    static let speedLines: [Path] = [(1, 9, 3.2), (0, 13.5, 4), (2, 17.5, 2.6)].map { x, y, length in
        var path = Path()
        path.move(to: CGPoint(x: x, y: y)); path.addLine(to: CGPoint(x: x + length, y: y))
        return path
    }
}

/// The Riffet mark: a solid horse head in `front` with its eye cut out, over a three-tooth mane in
/// `back`, scaled into the largest square centred in the view, the mark's optical centre on its centre.
struct BrandMark: View {
    var front: Color
    var back: Color

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 24
            var context = context
            context.transform = CGAffineTransform(translationX: size.width / 2 - BrandGeometry.opticalCentre.x * scale,
                                                  y: size.height / 2 - BrandGeometry.opticalCentre.y * scale).scaledBy(x: scale, y: scale)
            context.fill(BrandGeometry.mane, with: .color(back))
            context.stroke(BrandGeometry.mane, with: .color(back), style: StrokeStyle(lineWidth: BrandGeometry.maneStrokeWidth, lineJoin: .round))
            context.fill(BrandGeometry.head, with: .color(front), style: FillStyle(eoFill: true))
            context.stroke(BrandGeometry.outline, with: .color(front), style: StrokeStyle(lineWidth: BrandGeometry.strokeWidth, lineJoin: .round))
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

// MARK: - The living mark

/// The six loops of `LiveBrandMark`, a port of the `brand-*` keyframes in `apps/web/src/styles/index.css`.
enum LiveBrandStyle: CaseIterable, Hashable {
    case mane, mood, beat, draw, run, gaze

    static func random(except: LiveBrandStyle? = nil) -> LiveBrandStyle {
        allCases.filter { $0 != except }.randomElement() ?? .mane
    }
}

private enum LivePart: Hashable {
    case whole, tooth(Int), ear, eye, head, speed(Int)
}

/// What a keyframe animates on one part: a transform about the part's pivot, plus the opacity,
/// fill and stroke-trim the `draw` loop needs.
private struct LivePose {
    var rotate = 0.0, sx = 1.0, sy = 1.0, x = 0.0, y = 0.0
    var opacity = 1.0, fill = 1.0, trim = 1.0

    init(r: Double = 0, s: Double = 1, sx: Double? = nil, sy: Double? = nil, x: Double = 0, y: Double = 0,
         o: Double = 1, fill: Double = 1, trim: Double = 1) {
        rotate = r; self.sx = sx ?? s; self.sy = sy ?? s; self.x = x; self.y = y
        opacity = o; self.fill = fill; self.trim = trim
    }

    func mixed(with other: LivePose, _ f: Double) -> LivePose {
        func mix(_ a: Double, _ b: Double) -> Double { a + (b - a) * f }
        return LivePose(r: mix(rotate, other.rotate), sx: mix(sx, other.sx), sy: mix(sy, other.sy), x: mix(x, other.x), y: mix(y, other.y),
                        o: mix(opacity, other.opacity), fill: mix(fill, other.fill), trim: mix(trim, other.trim))
    }

    /// Translate, then rotate, then scale, all about `pivot`, as CSS applies `translate() rotate() scale()`.
    func matrix(about pivot: CGPoint) -> CGAffineTransform {
        CGAffineTransform(translationX: pivot.x + x, y: pivot.y + y)
            .rotated(by: rotate * .pi / 180).scaledBy(x: sx, y: sy)
            .translatedBy(x: -pivot.x, y: -pivot.y)
    }
}

private enum LiveEase {
    case bezier(Double, Double, Double, Double)
    case steps(Int)
    static let linear = LiveEase.bezier(0, 0, 1, 1)
    static let ease = LiveEase.bezier(0.25, 0.1, 0.25, 1)
    static let easeInOut = LiveEase.bezier(0.42, 0, 0.58, 1)
    static let easeOut = LiveEase.bezier(0, 0, 0.58, 1)

    func apply(_ progress: Double) -> Double {
        switch self {
        case let .steps(count): return (progress * Double(count)).rounded(.down) / Double(count)
        case let .bezier(x1, y1, x2, y2):
            if x1 == y1 && x2 == y2 { return progress }
            func point(_ t: Double, _ a: Double, _ b: Double) -> Double {
                let u = 1 - t
                return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
            }
            var low = 0.0, high = 1.0
            for _ in 0..<24 {
                let mid = (low + high) / 2
                if point(mid, x1, x2) < progress { low = mid } else { high = mid }
            }
            return point((low + high) / 2, y1, y2)
        }
    }
}

/// One looping CSS animation: keyframes (offset 0...1, ascending, first at 0 and last at 1), one
/// timing function applied between each pair, and a delay that is negative to start part-way in.
private struct LiveTrack {
    let duration: Double
    let ease: LiveEase
    let frames: [(at: Double, pose: LivePose)]
    var delay = 0.0

    init(_ duration: Double, _ ease: LiveEase, delay: Double = 0, _ frames: [(Double, LivePose)]) {
        self.duration = duration; self.ease = ease; self.delay = delay; self.frames = frames.map { (at: $0.0, pose: $0.1) }
    }

    func pose(at elapsed: Double) -> LivePose {
        let time = elapsed - delay
        guard time >= 0 else { return LivePose() }
        let progress = time.truncatingRemainder(dividingBy: duration) / duration
        guard let index = frames.lastIndex(where: { $0.at <= progress }), index + 1 < frames.count else { return frames[frames.count - 1].pose }
        let from = frames[index], to = frames[index + 1]
        return from.pose.mixed(with: to.pose, ease.apply((progress - from.at) / (to.at - from.at)))
    }
}

private extension LiveBrandStyle {
    static let tracks: [LiveBrandStyle: [LivePart: LiveTrack]] = Dictionary(uniqueKeysWithValues: allCases.map { ($0, $0.build()) })

    func build() -> [LivePart: LiveTrack] {
        var out: [LivePart: LiveTrack] = [:]
        func teeth(_ make: (Int) -> LiveTrack) { for index in 0..<3 { out[.tooth(index)] = make(index) } }
        let note = LivePose(r: 7, s: 1.34), rest = LivePose()
        switch self {
        case .mane:
            teeth { LiveTrack(1.8, .bezier(0.3, 0.7, 0.3, 1), delay: Double($0) * 0.13,
                              [(0, rest), (0.18, LivePose(r: 11)), (0.36, LivePose(r: -3)), (0.55, rest), (1, rest)]) }
        case .mood:
            out[.eye] = LiveTrack(5, .ease, [(0, rest), (0.44, rest), (0.47, LivePose(sy: 0.08)), (0.5, rest), (1, rest)])
            out[.ear] = LiveTrack(5, .easeOut, [(0, rest), (0.66, rest), (0.69, LivePose(r: -13)), (0.72, LivePose(r: -2)), (0.75, LivePose(r: -13)), (0.78, rest), (1, rest)])
            out[.whole] = LiveTrack(5, .easeInOut, [(0, rest), (0.5, LivePose(r: 1.6)), (1, rest)])
            teeth { LiveTrack(5, .easeInOut, delay: -0.4 * Double($0), [(0, rest), (0.5, LivePose(r: 3)), (1, rest)]) }
        case .beat:
            // Three notes and a chord, held on low-frame steps.
            let notes: [[(Double, LivePose)]] = [
                [(0, note), (0.125, note), (0.25, rest), (0.75, rest), (0.751, note), (0.8, note), (0.95, rest), (1, rest)],
                [(0, rest), (0.25, rest), (0.251, note), (0.375, note), (0.5, rest), (0.75, rest), (0.751, note), (0.8, note), (0.95, rest), (1, rest)],
                [(0, rest), (0.5, rest), (0.501, note), (0.625, note), (0.75, rest), (0.751, note), (0.8, note), (0.95, rest), (1, rest)],
            ]
            teeth { LiveTrack(2, .steps(12), notes[$0]) }
            let nod = LivePose(r: 2.4)
            out[.whole] = LiveTrack(2, .steps(16), [(0, nod), (0.12, rest), (0.25, nod), (0.37, rest), (0.5, nod), (0.62, rest), (0.75, nod), (0.9, rest), (1, nod)])
        case .draw:
            // The outline in one stroke, filled, then the mane tooth by tooth and the eye.
            out[.head] = LiveTrack(4.2, .easeInOut, [
                (0, LivePose(fill: 0, trim: 0)), (0.34, LivePose(fill: 0)), (0.44, rest), (0.92, rest), (1, LivePose(o: 0)),
            ])
            let starts = [0.44, 0.5, 0.56]
            teeth { index in
                let s = starts[index]
                return LiveTrack(4.2, .easeOut, [(0, LivePose(s: 0)), (s, LivePose(s: 0)), (s + 0.08, LivePose(s: 1.15)), (s + 0.12, rest), (0.92, rest), (1, LivePose(o: 0))])
            }
            out[.eye] = LiveTrack(4.2, .easeOut, [(0, LivePose(s: 0)), (0.68, LivePose(s: 0)), (0.74, LivePose(s: 1.2)), (0.78, rest), (1, rest)])
        case .run:
            out[.whole] = LiveTrack(0.46, .easeInOut, [(0, LivePose(r: -5)), (0.5, LivePose(r: -8, x: 0.3, y: -0.9)), (1, LivePose(r: -5))])
            let stream = [(0.0, LivePose(r: 14, sx: 1.18)), (0.5, LivePose(r: 22, sx: 1.3)), (1, LivePose(r: 14, sx: 1.18))]
            teeth { LiveTrack(0.23, .easeInOut, delay: -0.08 * Double($0), stream) }
            for index in 0..<3 {
                out[.speed(index)] = LiveTrack(0.7, .linear, delay: -0.25 * Double(index),
                                               [(0, LivePose(x: 9, o: 0)), (0.25, LivePose(x: 5, o: 1)), (1, LivePose(x: -7, o: 0))])
            }
        case .gaze:
            // On the web the eye follows the pointer; here it only wanders.
            let glance = [(0.0, rest), (0.2, rest), (0.26, LivePose(x: 0.55, y: 0.5)), (0.52, LivePose(x: 0.55, y: 0.5)),
                          (0.58, LivePose(x: 0.55, y: -0.25)), (0.8, LivePose(x: 0.55, y: -0.25)), (0.86, rest), (1, rest)]
            out[.eye] = LiveTrack(5, .bezier(0.4, 0, 0.2, 1), glance)
            let spring = LiveEase.bezier(0.3, 1.5, 0.5, 1)
            teeth { _ in LiveTrack(5, spring, [(0, rest), (0.56, rest), (0.6, LivePose(r: 15)), (0.78, LivePose(r: 15)), (0.82, rest), (1, rest)]) }
            out[.ear] = LiveTrack(5, spring, [(0, rest), (0.56, rest), (0.6, LivePose(r: 9)), (0.78, LivePose(r: 9)), (0.82, rest), (1, rest)])
        }
        return out
    }

    func pose(_ part: LivePart, at elapsed: Double) -> LivePose {
        Self.tracks[self]?[part]?.pose(at: elapsed) ?? LivePose()
    }
}

/// The tap's bounce: scale .86 / -4 degrees, to 1.07 / 2 degrees, then settled.
private let liveBounce = LiveTrack(0.36, .bezier(0.2, 0.8, 0.3, 1), [(0, LivePose(r: -4, s: 0.86)), (0.55, LivePose(r: 2, s: 1.07)), (1, LivePose())])

/// The mark as a living logo: it plays one of six loops, a random one each time it appears, and a
/// tap swaps it for another with a short bounce. A fixed `style` plays that loop only and ignores
/// taps. Decoration only: it reports nothing, never changes its layout, and stands still under
/// Reduce Motion.
struct LiveBrandMark: View {
    var front: Color
    var back: Color
    var style: LiveBrandStyle? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var picked = LiveBrandStyle.random()
    @State private var started = Date()
    @State private var bounced = false
    private var current: LiveBrandStyle { style ?? picked }

    var body: some View {
        let animated = !reduceMotion
        let current = current
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                // The canvas is wider than the mark: speed lines and the bounce reach past its box.
                GeometryReader { box in
                    let side = min(box.size.width, box.size.height)
                    // motion-loop: ambient brand mark, animated is false under Reduce Motion
                    TimelineView(.animation(paused: !animated)) { timeline in
                        let elapsed = timeline.date.timeIntervalSince(started)
                        Canvas { context, size in
                            Self.draw(&context, size: size, unit: side / 24, style: current, elapsed: animated ? elapsed : nil,
                                      bounce: animated && bounced ? elapsed : nil, front: front, back: back)
                        }
                        .frame(width: side * 3, height: side * 3)
                    }
                    .frame(width: box.size.width, height: box.size.height)
                }
                .allowsHitTesting(false)
            }
            .contentShape(Rectangle())
            .onTapGesture {
                guard style == nil, animated else { return }
                picked = .random(except: picked); started = Date(); bounced = true
            }
            .accessibilityHidden(true)
    }

    /// `elapsed` nil draws the resting mark.
    private static func draw(_ context: inout GraphicsContext, size: CGSize, unit: CGFloat, style: LiveBrandStyle,
                             elapsed: Double?, bounce: Double?, front: Color, back: Color) {
        let centre = CGPoint(x: size.width / 2, y: size.height / 2)
        var root = CGAffineTransform(translationX: centre.x - BrandGeometry.opticalCentre.x * unit,
                                     y: centre.y - BrandGeometry.opticalCentre.y * unit).scaledBy(x: unit, y: unit)
        if let bounce, bounce < liveBounce.duration {
            root = root.concatenating(liveBounce.pose(at: bounce).matrix(about: centre))
        }
        func pose(_ part: LivePart) -> LivePose { elapsed.map { style.pose(part, at: $0) } ?? LivePose() }
        func layer(_ matrix: CGAffineTransform, in base: GraphicsContext) -> GraphicsContext {
            var copy = base
            copy.transform = matrix.concatenating(root)
            return copy
        }

        if elapsed != nil, style == .run {
            for (index, line) in BrandGeometry.speedLines.enumerated() {
                let state = pose(.speed(index))
                var ctx = layer(CGAffineTransform(translationX: state.x, y: 0), in: context)
                ctx.opacity = state.opacity
                ctx.stroke(line, with: .color(back), style: StrokeStyle(lineWidth: 0.7, lineCap: .round))
            }
        }

        let whole = pose(.whole).matrix(about: CGPoint(x: 9, y: 21))
        for (index, tooth) in BrandGeometry.teeth.enumerated() {
            let state = pose(.tooth(index))
            guard state.sx > 0.001, state.opacity > 0 else { continue }
            var ctx = layer(state.matrix(about: tooth.pivot).concatenating(whole), in: context)
            ctx.opacity = state.opacity
            ctx.fill(tooth.path, with: .color(back))
            ctx.stroke(tooth.path, with: .color(back), style: StrokeStyle(lineWidth: BrandGeometry.maneStrokeWidth, lineJoin: .round))
        }

        // Head and ear in one layer so the eye can be cut out of both.
        let body = layer(whole, in: context)
        body.drawLayer { group in
            let head = pose(.head)
            if head.opacity > 0 {
                var ctx = group
                ctx.opacity = head.opacity
                ctx.fill(BrandGeometry.outline, with: .color(front.opacity(head.fill)))
                if head.trim >= 1 {
                    ctx.stroke(BrandGeometry.outline, with: .color(front), style: StrokeStyle(lineWidth: BrandGeometry.strokeWidth, lineJoin: .round))
                } else if head.trim > 0 {
                    ctx.stroke(BrandGeometry.outline.trimmedPath(from: 0, to: head.trim), with: .color(front),
                               style: StrokeStyle(lineWidth: BrandGeometry.strokeWidth, lineJoin: .round))
                }
            }
            if style != .draw || elapsed == nil {
                var ctx = group
                ctx.transform = pose(.ear).matrix(about: CGPoint(x: 10, y: 5.9)).concatenating(group.transform)
                ctx.fill(BrandGeometry.ear, with: .color(front))
                ctx.stroke(BrandGeometry.ear, with: .color(front), style: StrokeStyle(lineWidth: BrandGeometry.strokeWidth, lineJoin: .round))
            }
            let eye = pose(.eye)
            if eye.sx > 0.001 {
                var ctx = group
                ctx.transform = eye.matrix(about: CGPoint(x: 12.5, y: 8.2)).concatenating(group.transform)
                ctx.blendMode = .destinationOut
                ctx.fill(Path(ellipseIn: BrandGeometry.eye), with: .color(.black))
            }
        }
    }
}

/// The app icon as the home screen draws it, at preview size.
struct AppIconTile: View {
    let accent: Color
    let size: CGFloat

    var body: some View {
        let tile = RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
        // The 24-unit grid at 1.06 per unit of a 32-unit tile, as in the favicon.
        let mark = size * 24 * 1.06 / 32
        tile.fill(Color(red: 0x15 / 255, green: 0x17 / 255, blue: 0x1a / 255))
            .overlay { tile.strokeBorder(.white.opacity(0.09), lineWidth: 0.5) }
            .overlay { BrandMark(front: .white, back: accent).frame(width: mark, height: mark) }
            .frame(width: size, height: size)
    }
}

struct AppIconPicker: View {
    @Binding var selection: AppIconVariant
    @State private var switching = false
    @State private var error: String?

    private let tileSize: CGFloat = 64
    private let ringGap: CGFloat = 5

    var body: some View {
        RiffetForm {
            Section {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: 3), spacing: 20) {
                    ForEach(AppIconVariant.all) { variant in
                        Button { Task { await select(variant) } } label: {
                            AppIconTile(accent: variant.accent, size: tileSize)
                                .padding(ringGap)
                                .overlay {
                                    if variant == selection {
                                        RoundedRectangle(cornerRadius: tileSize * 0.225 + ringGap, style: .continuous)
                                            .strokeBorder(Color.accentColor, lineWidth: 2.5)
                                    }
                                }
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(variant.name)
                        .accessibilityAddTraits(variant == selection ? .isSelected : [])
                    }
                }
                .padding(.vertical, 12)
                .disabled(switching)
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle(String(localized: "应用图标", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }

    private func select(_ variant: AppIconVariant) async {
        guard !switching, variant != .current else { return }
        switching = true
        defer { switching = false }
        do {
            try await UIApplication.shared.setAlternateIconName(variant.alternateIconName)
            error = nil
        } catch {
            self.error = String(localized: "无法更换图标：\(error.localizedDescription)", bundle: .riffet)
        }
        selection = .current
    }
}
