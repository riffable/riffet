import CoreGraphics
import Foundation

/// The canvas's own text in the reader's language. The plain strings come from the layout engine (`CanvasLayoutEngine.strings`);
/// the three that carry a count are formed here, as `messages.ts` forms them.
struct CanvasStrings: Sendable {
    var table: [String: String]
    var english: Bool

    init(_ table: [String: String], locale: String) {
        self.table = table
        english = !locale.hasPrefix("zh")
    }

    subscript(_ key: String) -> String { table[key] ?? key }

    /// The strings that carry a count, as a template with `{n}` where the count goes (`files`, `moreFiles`, `attachments`), and for
    /// English the form for exactly one under `name#one`: the engine's table holds them when its script exports them. Until then
    /// the plural of "1 file" is derived from the singular the table does carry, and the other two are the bare number, which the
    /// icon beside it names.
    func files(_ count: Int) -> String {
        counted("files", count) {
            let word = table["oneFile"].map { String($0.drop(while: { $0.isNumber || $0 == " " })) } ?? ""
            return word.isEmpty ? "\(count)" : "\(count) " + (english && count != 1 && !word.hasSuffix("s") ? word + "s" : word)
        }
    }
    func moreFiles(_ count: Int) -> String { counted("moreFiles", count) { "+\(count)" } }
    func attachments(_ count: Int) -> String { counted("attachments", count) { "\(count)" } }

    private func counted(_ key: String, _ count: Int, fallback: () -> String) -> String {
        guard let template = (count == 1 ? table["\(key)#one"] : nil) ?? table[key] else { return fallback() }
        return template.replacingOccurrences(of: "{n}", with: "\(count)")
    }
}

/// Everything a painter reads besides the node itself: the palette, the canvas's pixel constants, the language, and the
/// camera zoom the bitmap is for, which only decides the far level. Strokes the web draws with `vector-effect: non-scaling-stroke`
/// are plain canvas units here: WebKit undoes only an SVG's own viewBox scale, not the plane's CSS transform.
/// A value type, safe to use from any thread.
struct CanvasPaint: Sendable {
    var palette: RiffetPaletteValues
    var dark: Bool
    var metrics: CanvasMetrics
    var strings: CanvasStrings
    /// The camera scale this paint is for.
    var zoom: CGFloat = 1
    /// Far level (k < 0.36): cards are colour blocks.
    var far = false
    /// The name of a backend by its id (the host's `backendLabel`).
    var backendLabel: @Sendable (String?) -> String = CanvasPaint.defaultBackendLabel
    /// An image by attachment id or artifact key, when the host has it loaded.
    var image: @Sendable (String) -> CGImage? = { _ in nil }
    var locale = "zh-Hans"
    /// The sans and mono families of the interface style, which every text of the canvas is set in.
    var faces = CanvasFaces.system
    /// The animated parts of a card are layers of the surface, not part of its bitmap (see `CanvasAccessory`).
    var layered = false
    /// Where a painter asked for the animated parts says what they are.
    var sink: CanvasAccessorySink?
    /// The file the pointer is on in some ledger: its row is lit in every ledger that has it.
    var focusPath: String?
    /// The call of this strip or bar that is marked, by its position among the marks.
    var marked: Int?
    /// The output rate of this card's running turn.
    var pulse: CanvasPulse?
    /// The card's column is lit, or the pointer is on the card.
    var lit = false
    var hot = false

    static let farThreshold: CGFloat = 0.36

    static let defaultBackendLabel: @Sendable (String?) -> String = { id in
        switch id {
        case "cursor": "Cursor"
        case "codex": "Codex"
        case nil, "claude": "Claude Code"
        case "dsh": "DeepSeek Harness"
        case "droid": "Droid"
        case "traex": "TRAE CLI"
        case "pi": "pi"
        case let other?: String(other[(other.lastIndex(of: ".").map { other.index(after: $0) } ?? other.startIndex)...])
        }
    }

    init(palette: RiffetPaletteValues, dark: Bool, metrics: CanvasMetrics, strings: CanvasStrings, zoom: CGFloat = 1, locale: String = "zh-Hans") {
        self.palette = palette; self.dark = dark; self.metrics = metrics; self.strings = strings; self.zoom = zoom; self.locale = locale
        far = zoom < Self.farThreshold
    }

    func with(zoom: CGFloat) -> CanvasPaint { var copy = self; copy.zoom = zoom; copy.far = zoom < Self.farThreshold; return copy }

    // MARK: Colours

    func color(_ c: RiffetRGBA, _ alpha: CGFloat = 1) -> CGColor {
        CGColor(colorSpace: CanvasPaint.srgb, components: [CGFloat(c.red), CGFloat(c.green), CGFloat(c.blue), CGFloat(c.alpha) * alpha])!
    }
    static let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

    func faded(_ c: CGColor, _ k: CGFloat) -> CGColor { k == 1 ? c : c.copy(alpha: c.alpha * k) ?? c }
    func fg(_ a: CGFloat = 1) -> CGColor { color(palette.fg, a) }
    var fg2: CGColor { color(palette.fg2) }
    var fg3: CGColor { color(palette.fg3) }
    var fg4: CGColor { color(palette.fg4) }
    func fg4(_ a: CGFloat) -> CGColor { color(palette.fg4, a) }
    var line: CGColor { color(palette.line) }
    var lineSoft: CGColor { color(palette.lineSoft) }
    var lineStrong: CGColor { color(palette.lineStrong) }
    func elevated(_ a: CGFloat = 1) -> CGColor { color(palette.bgElevated, a) }
    func subtle(_ a: CGFloat = 1) -> CGColor { color(palette.bgSubtle, a) }
    var muted: CGColor { color(palette.bgMuted) }
    var bubble: CGColor { color(palette.bgBubble) }
    func accent(_ a: CGFloat = 1) -> CGColor { color(palette.accent, a) }
    func danger(_ a: CGFloat = 1) -> CGColor { color(palette.danger, a) }
    var success: CGColor { color(palette.success) }
    var addMarker: CGColor { color(palette.diffAddMarker) }
    var delMarker: CGColor { color(palette.diffDelMarker) }
    var diffAdd: CGColor { color(palette.diffAdd) }
    var diffDel: CGColor { color(palette.diffDel) }

    /// `--canvas-desk`: under everything, with the dots.
    var desk: CGColor { color(palette.canvasDesk(dark: dark)) }
    /// `--canvas-paper`: what a conversation lies on, a step above the desk and below the cards.
    func paper(_ a: CGFloat = 1) -> CGColor { color(palette.canvasPaper(dark: dark), a) }
    /// `color-mix(in oklab, var(--canvas-paper), var(--fg) 1.8%)`: the shade of the paper a ledger hides the track's line with.
    var ground: CGColor { color(Oklab.mix(palette.canvasPaper(dark: dark), palette.fg, 0.018)) }

    // MARK: Constants

    func row(_ key: String) -> CGFloat { CGFloat(metrics.row[key] ?? 0) }
    func change(_ key: String) -> CGFloat { CGFloat(metrics.change[key] ?? 0) }
    func art(_ key: String) -> CGFloat { CGFloat(metrics.art[key] ?? 0) }
    func strip(_ key: String) -> CGFloat { CGFloat(metrics.strip[key] ?? 0) }
    func bar(_ key: String) -> CGFloat { CGFloat(metrics.bar[key] ?? 0) }

    /// A text style by the CSS classes it stands for.
    func text(_ font: CanvasFont, _ color: CGColor, strike: CGColor? = nil) -> CanvasTextStyle { CanvasTextStyle(font.with(faces), color, strike: strike) }
    /// [font] in this paint's families, for the measures (baselines, widths) taken from a font outside a style.
    func font(_ font: CanvasFont) -> CanvasFont { font.with(faces) }
}

extension RiffetPaletteValues {
    /// The web's `--canvas-desk` (apps/web/src/styles/index.css).
    func canvasDesk(dark: Bool) -> RiffetRGBA { dark ? bg : bgSubtle }
    /// The web's `--canvas-paper`.
    func canvasPaper(dark: Bool) -> RiffetRGBA { dark ? Oklab.mix(bg, bgSubtle, 0.5) : Oklab.mix(bgSubtle, bgElevated, 0.7) }
}

struct Oklab {
    var l: Double, a: Double, b: Double
    /// `color-mix(in oklab, [from], [to] t)` of two opaque colours.
    static func mix(_ from: RiffetRGBA, _ to: RiffetRGBA, _ t: Double) -> RiffetRGBA {
        let a = Oklab(from), b = Oklab(to)
        let rgb = Oklab(l: a.l + (b.l - a.l) * t, a: a.a + (b.a - a.a) * t, b: a.b + (b.b - a.b) * t).srgb
        return RiffetRGBA(rgb.0, rgb.1, rgb.2, 1)
    }
    init(l: Double, a: Double, b: Double) { self.l = l; self.a = a; self.b = b }
    init(_ c: RiffetRGBA) {
        func lin(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        let r = lin(c.red), g = lin(c.green), bl = lin(c.blue)
        let l_ = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl)
        let m_ = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl)
        let s_ = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl)
        l = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
        a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
        b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    }
    var srgb: (Double, Double, Double) {
        let l_ = l + 0.3963377774 * a + 0.2158037573 * b
        let m_ = l - 0.1055613458 * a - 0.0638541728 * b
        let s_ = l - 0.0894841775 * a - 1.2914855480 * b
        let l3 = l_ * l_ * l_, m3 = m_ * m_ * m_, s3 = s_ * s_ * s_
        let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
        let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
        let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3
        func gamma(_ v: Double) -> Double { let c = min(1, max(0, v)); return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1 / 2.4) - 0.055 }
        return (gamma(r), gamma(g), gamma(bl))
    }
}

// MARK: - Shapes

struct CanvasShadow: @unchecked Sendable {
    var dx: CGFloat, dy: CGFloat, blur: CGFloat, spread: CGFloat
    var color: CGColor
}

func canvasRoundedRect(_ rect: CGRect, _ radius: CGFloat) -> CGPath {
    let r = min(radius, rect.width / 2, rect.height / 2)
    return r <= 0 ? CGPath(rect: rect, transform: nil) : CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
}

extension CGContext {
    func fillRounded(_ rect: CGRect, _ radius: CGFloat, _ color: CGColor) {
        setFillColor(color)
        addPath(canvasRoundedRect(rect, radius))
        fillPath()
    }

    /// A CSS border of [width] inside the box: the ring between the box and the box shrunk by [width].
    func borderRing(_ rect: CGRect, _ radius: CGFloat, width: CGFloat = 1, _ color: CGColor) {
        let outer = canvasRoundedRect(rect, radius)
        let inner = rect.insetBy(dx: width, dy: width)
        guard inner.width > 0, inner.height > 0 else { fillRounded(rect, radius, color); return }
        let path = CGMutablePath()
        path.addPath(outer)
        path.addPath(canvasRoundedRect(inner, max(0, min(radius, rect.width / 2, rect.height / 2) - width)))
        setFillColor(color)
        addPath(path)
        fillPath(using: .evenOdd)
    }

    /// A `border-dashed` border: dashes of three times the width along the box's border line.
    func dashedBorder(_ rect: CGRect, _ radius: CGFloat, width: CGFloat = 1, _ color: CGColor) {
        let half = rect.insetBy(dx: width / 2, dy: width / 2)
        guard half.width > 0, half.height > 0 else { return }
        saveGState()
        setStrokeColor(color)
        setLineWidth(width)
        setLineDash(phase: 0, lengths: [width * 3, width * 3])
        addPath(canvasRoundedRect(half, max(0, min(radius, rect.width / 2, rect.height / 2) - width / 2)))
        strokePath()
        restoreGState()
    }

    /// CSS `box-shadow`s of a rounded box, outside the box only; [shadows] is in CSS order (the first is on top).
    /// Drawn in device space (the offset and blur of a CoreGraphics shadow do not follow the CTM), so a shadow is the same size
    /// at every scale of the context. The context is a bitmap context whose base space is its pixels.
    func boxShadows(_ rect: CGRect, _ radius: CGFloat, _ shadows: [CanvasShadow]) {
        let ctm = self.ctm
        let scale = hypot(ctm.a, ctm.b)
        guard scale > 0 else { return }
        let inverse = ctm.inverted()
        let away: CGFloat = 20000
        for shadow in shadows.reversed() {
            let box = rect.insetBy(dx: -shadow.spread, dy: -shadow.spread)
            guard box.width > 0, box.height > 0 else { continue }
            saveGState()
            let hole = CGMutablePath()
            hole.addRect(rect.insetBy(dx: -4000, dy: -4000))
            hole.addPath(canvasRoundedRect(rect, radius))
            addPath(hole)
            self.clip(using: .evenOdd)
            concatenate(inverse)
            var shift = ctm.concatenating(CGAffineTransform(translationX: -away, y: 0))
            let path = canvasRoundedRect(box, max(0, radius + shadow.spread)).copy(using: &shift)!
            let offset = CGSize(width: ctm.a * shadow.dx + ctm.c * shadow.dy + away, height: ctm.b * shadow.dx + ctm.d * shadow.dy)
            setShadow(offset: offset, blur: shadow.blur * scale, color: shadow.color)
            setFillColor(CGColor(gray: 0, alpha: 1))
            addPath(path)
            fillPath()
            restoreGState()
        }
    }
}

// MARK: - Icons

enum CanvasIcons {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [CanvasIcon: CGPath] = [:]

    static func path(_ icon: CanvasIcon) -> CGPath {
        lock.lock(); defer { lock.unlock() }
        if let hit = cache[icon] { return hit }
        let path = CGMutablePath()
        for d in icon.paths { path.addPath(SVGPath.parse(d)) }
        cache[icon] = path
        return path
    }

    /// The transcript's icon for a tool kind (`toolIcons` in Timeline.tsx).
    static func tool(_ kind: String) -> CanvasIcon {
        switch kind {
        case "read": .fileText
        case "edit": .filePenLine
        case "delete": .trash2
        case "move": .arrowRightLeft
        case "search": .search
        case "execute": .squareTerminal
        case "think": .brain
        case "fetch": .globe
        case "switch_mode": .repeat
        case "agent": .bot
        case "question": .messageCircleQuestion
        case "plan": .listChecks
        default: .wrench
        }
    }
}

extension CGContext {
    /// A Lucide icon of [size] canvas units at [x], [y]: drawn as the web draws it, a round stroke of 1.25 screen pixels
    /// (`icons-base.tsx` plus `.lucide * { vector-effect: non-scaling-stroke }`), or [scalingStroke] user units of the 24 box.
    func icon(_ icon: CanvasIcon, x: CGFloat, y: CGFloat, size: CGFloat, color: CGColor, zoom: CGFloat, scalingStroke: CGFloat? = nil) {
        saveGState()
        translateBy(x: x, y: y)
        let k = size / 24
        scaleBy(x: k, y: k)
        setStrokeColor(color)
        setLineWidth(scalingStroke ?? (1.25 / k))
        setLineCap(.round)
        setLineJoin(.round)
        addPath(CanvasIcons.path(icon))
        strokePath()
        restoreGState()
    }
}
