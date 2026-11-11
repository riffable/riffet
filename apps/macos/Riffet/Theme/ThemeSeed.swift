import Foundation

/// The theme canvas, ported from `apps/web/src/lib/theme-seed.ts`: a couple of points become the
/// roles a reader feels as "the theme" — surfaces, ink, lines, the primary action and the accent.
/// Status, diff, agent and the remaining chart roles keep the draft's values.
///
/// The arithmetic follows the web line by line on purpose. A role counts as typed over when it
/// differs from what the previous seed produced, so a theme drawn on one client must redraw to the
/// same hex on the other, or the canvas would leave those roles alone.
enum ThemeSeedMath {
    typealias Palette = [String: String]

    /// How much colour the surface point can put into paper at the canvas edge.
    private static let surfaceChroma = 0.035
    /// The sidebar may carry more colour than the page: it frames the work rather than holding it.
    private static let sidebarChroma = 0.06

    /// Offsets from the surface hue the harmony control steps through, per number of points.
    private static let harmonies: [Int: [[Double]]] = [
        2: [[180], [120], [40]],
        3: [[150, 210], [120, 240], [40, 320]],
    ]

    static let roles = [
        "bg", "bg-sidebar", "bg-subtle", "bg-muted", "bg-elevated", "bg-popover", "bg-hover", "bg-active", "bg-bubble",
        "fg", "fg-2", "fg-3", "fg-4",
        "line", "line-soft", "line-strong",
        "primary", "primary-hover", "primary-fg",
        "accent", "accent-hover", "accent-soft", "accent-fg",
        "toast", "chart-1",
    ]

    /// Channels 0–255 and alpha 0–1, the shape the web works in.
    struct Rgba {
        var r: Double, g: Double, b: Double, a: Double
    }

    // MARK: - Colour

    private static func oklchToRgb(_ l: Double, _ c: Double, _ h: Double) -> [Double] {
        let a = c * cos(h * .pi / 180)
        let b = c * sin(h * .pi / 180)
        let l_ = pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m_ = pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
        let s_ = pow(l - 0.0894841775 * a - 1.2914855480 * b, 3)
        let linear = [
            4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
            -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
            -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
        ]
        return linear.map { value in
            (value <= 0.0031308 ? 12.92 * value : 1.055 * pow(value, 1 / 2.4) - 0.055) * 255
        }
    }

    private static func inGamut(_ rgb: [Double]) -> Bool {
        rgb.allSatisfy { $0 >= -0.5 && $0 <= 255.5 }
    }

    /// The OKLCH colour as sRGB, losing chroma (not lightness) until it fits.
    private static func fit(_ l: Double, _ c: Double, _ h: Double, _ alpha: Double = 1) -> Rgba {
        let lightness = min(1, max(0, l))
        var rgb = oklchToRgb(lightness, c, h)
        if !inGamut(rgb) {
            var low = 0.0
            var high = c
            for _ in 0..<14 {
                let mid = (low + high) / 2
                if inGamut(oklchToRgb(lightness, mid, h)) { low = mid } else { high = mid }
            }
            rgb = oklchToRgb(lightness, low, h)
        }
        let clamp = { (value: Double) in min(255, max(0, value)) }
        return Rgba(r: clamp(rgb[0]), g: clamp(rgb[1]), b: clamp(rgb[2]), a: alpha)
    }

    /// `colorToHex` from the contracts: lowercase, with an alpha byte only when translucent.
    private static func hex(_ color: Rgba) -> String {
        // `Math.round` rounds halves up; the channels are never negative, so this matches it.
        let byte = { (value: Double) in String(format: "%02x", Int((value + 0.5).rounded(.down))) }
        let rgb = "#" + byte(color.r) + byte(color.g) + byte(color.b)
        return color.a >= 1 ? rgb : rgb + byte(color.a * 255)
    }

    private static func hex(_ l: Double, _ c: Double, _ h: Double, _ alpha: Double = 1) -> String {
        hex(fit(l, c, h, alpha))
    }

    static func parse(_ value: String?) -> Rgba? {
        guard let value, let rgba = RiffetRGBA(hex: value) else { return nil }
        return Rgba(r: rgba.red * 255, g: rgba.green * 255, b: rgba.blue * 255, a: rgba.alpha)
    }

    private static func luminance(_ r: Double, _ g: Double, _ b: Double) -> Double {
        let linear = { (channel: Double) -> Double in
            let scaled = channel / 255
            return scaled <= 0.03928 ? scaled / 12.92 : pow((scaled + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }

    /// WCAG 2.x contrast, compositing as `contrastRatio` in the contracts does.
    private static func contrast(_ front: Rgba, _ back: Rgba) -> Double {
        let composite = { (color: Rgba, base: (Double, Double, Double)) in
            (color.r * color.a + base.0 * (1 - color.a), color.g * color.a + base.1 * (1 - color.a), color.b * color.a + base.2 * (1 - color.a))
        }
        let backdrop = composite(back, (255, 255, 255))
        let ink = composite(front, (back.r, back.g, back.b))
        let a = luminance(ink.0, ink.1, ink.2)
        let b = luminance(backdrop.0, backdrop.1, backdrop.2)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// Steps lightness away from [background] until the ink reaches [minimum]:1.
    private static func readable(_ l: Double, _ c: Double, _ h: Double, on background: Rgba, minimum: Double, darker: Bool) -> String {
        var lightness = l
        var step = 0
        while step < 60, contrast(fit(lightness, c, h), background) < minimum {
            lightness += darker ? -0.01 : 0.01
            step += 1
        }
        return hex(lightness, c, h)
    }

    /// Whichever of two inks reads better on [fill].
    private static func onFill(_ fill: Rgba, _ a: String, _ b: String) -> String {
        let ratio = { (ink: String) in parse(ink).map { contrast($0, fill) } ?? 0 }
        return ratio(a) >= ratio(b) ? a : b
    }

    /// Yellow and green look muddy at the lightness that suits blue, so their accents sit higher.
    private static func yellowness(_ h: Double) -> Double {
        pow(max(0, cos((h - 100) * .pi / 180)), 3)
    }

    /// The colour a point shows on the canvas: the hue at a lightness every hue can reach.
    static func pointColor(_ point: CachedThemeSeed.Point) -> Rgba {
        fit(0.74, 0.02 + point.radius * 0.15, point.hue)
    }

    // MARK: - Derivation

    static func derive(_ seed: CachedThemeSeed, dark: Bool) -> Palette {
        let surface = seed.points[0]
        let accentPoint = seed.points.count > 1 ? seed.points[1] : surface
        let sidebarPoint: CachedThemeSeed.Point? = seed.points.count > 2 ? seed.points[2] : nil
        let h = surface.hue
        let cs = surface.radius * surfaceChroma
        let ha = accentPoint.hue
        let ca = 0.02 + accentPoint.radius * 0.2
        let soft = seed.softness

        if !dark {
            let bgL = 1 - 0.012 * surface.radius - 0.05 * soft
            let bg = fit(bgL, cs * 0.6, h)
            let elevatedL = bgL + (1 - bgL) * 0.6
            let accentL = 0.57 + 0.12 * yellowness(ha)
            let accent = fit(accentL, ca, ha)
            let ink = min(cs * 1.4, 0.05)
            let fg = readable(0.29, cs * 0.5, h, on: bg, minimum: 12, darker: true)
            return [
                "bg": hex(bg),
                "bg-sidebar": sidebarPoint.map { hex(bgL - 0.014 - 0.02 * $0.radius, $0.radius * sidebarChroma, $0.hue) } ?? hex(bgL - 0.014, cs * 0.8, h),
                "bg-subtle": hex(bgL - 0.018, cs * 0.8, h),
                "bg-muted": hex(bgL - 0.04, cs, h),
                "bg-elevated": hex(elevatedL, cs * 0.4, h),
                "bg-popover": hex(elevatedL, cs * 0.4, h),
                "bg-hover": hex(0.3, ink, h, 0.055),
                "bg-active": hex(0.3, ink, h, 0.09),
                "bg-bubble": hex(bgL - 0.03, min(ca * 0.12, 0.03), ha),
                "fg": fg,
                "fg-2": readable(0.44, cs * 0.5, h, on: bg, minimum: 7, darker: true),
                "fg-3": readable(0.51, cs * 0.5, h, on: bg, minimum: 4.5, darker: true),
                "fg-4": hex(0.76, cs * 0.4, h),
                "line": hex(0.2, ink, h, 0.08),
                "line-soft": hex(0.2, ink, h, 0.055),
                "line-strong": hex(0.2, ink, h, 0.13),
                "primary": hex(0.2, cs * 0.5, h),
                "primary-hover": hex(0.33, cs * 0.5, h),
                "primary-fg": hex(elevatedL, cs * 0.4, h),
                "accent": hex(accent),
                "accent-hover": hex(accentL - 0.04, ca, ha),
                "accent-soft": hex(Rgba(r: accent.r, g: accent.g, b: accent.b, a: 0.1)),
                "accent-fg": onFill(accent, "#ffffff", fg),
                "toast": hex(0.27, cs * 0.6, h),
                "chart-1": hex(accent),
            ]
        }

        let bgL = 0.185 + 0.07 * soft
        let bg = fit(bgL, cs * 0.7, h)
        let bgHex = hex(bg)
        let accentL = 0.7 + 0.08 * yellowness(ha)
        let accent = fit(accentL, ca, ha)
        let ink = min(cs, 0.03)
        return [
            "bg": bgHex,
            "bg-sidebar": sidebarPoint.map { hex(bgL + 0.022, $0.radius * sidebarChroma, $0.hue) } ?? hex(bgL + 0.022, cs * 0.7, h),
            "bg-subtle": hex(bgL + 0.03, cs * 0.7, h),
            "bg-muted": hex(bgL + 0.075, cs * 0.7, h),
            "bg-elevated": hex(bgL + 0.04, cs * 0.7, h),
            "bg-popover": hex(bgL + 0.06, cs * 0.7, h),
            "bg-hover": hex(0.98, ink, h, 0.06),
            "bg-active": hex(0.98, ink, h, 0.1),
            "bg-bubble": hex(bgL + 0.075, min(ca * 0.15, 0.035), ha),
            "fg": readable(0.87, cs * 0.4, h, on: bg, minimum: 11, darker: false),
            "fg-2": readable(0.8, cs * 0.4, h, on: bg, minimum: 8, darker: false),
            "fg-3": readable(0.72, cs * 0.4, h, on: bg, minimum: 5, darker: false),
            "fg-4": hex(0.5, cs * 0.4, h),
            "line": hex(0.98, ink, h, 0.075),
            "line-soft": hex(0.98, ink, h, 0.05),
            "line-strong": hex(0.98, ink, h, 0.12),
            "primary": hex(0.95, cs * 0.4, h),
            "primary-hover": hex(0.87, cs * 0.4, h),
            "primary-fg": bgHex,
            "accent": hex(accent),
            "accent-hover": hex(accentL - 0.04, ca, ha),
            "accent-soft": hex(Rgba(r: accent.r, g: accent.g, b: accent.b, a: 0.15)),
            "accent-fg": onFill(accent, bgHex, "#ffffff"),
            "toast": hex(bgL + 0.12, cs * 0.7, h),
            "chart-1": hex(accent),
        ]
    }

    /// Redraws one half from [next]. A seed role the author has typed over — one that no longer
    /// matches what [previous] produced — keeps the author's value; without a previous seed the
    /// canvas is being picked up for the first time and owns every seed role.
    static func apply(_ current: Palette, previous: CachedThemeSeed?, next: CachedThemeSeed, dark: Bool) -> Palette {
        let before = previous.map { derive($0, dark: dark) }
        let after = derive(next, dark: dark)
        var out = current
        for role in roles {
            let typed = before.map { current[role]?.lowercased() != $0[role] } ?? false
            if !typed { out[role] = after[role] }
        }
        return out
    }

    /// Rounds as the server does, so the stored seed redraws exactly what the editor showed.
    static func normalized(_ seed: CachedThemeSeed) -> CachedThemeSeed {
        let round = { (value: Double) in (value * 1000).rounded() / 1000 }
        return CachedThemeSeed(
            points: seed.points.map { .init(hue: round($0.hue.truncatingRemainder(dividingBy: 360)), radius: round($0.radius)) },
            softness: round(seed.softness)
        )
    }

    private static func oklch(_ value: String?) -> (l: Double, c: Double, h: Double)? {
        guard let color = parse(value) else { return nil }
        let linear = [color.r, color.g, color.b].map { channel -> Double in
            let scaled = channel / 255
            return scaled <= 0.04045 ? scaled / 12.92 : pow((scaled + 0.055) / 1.055, 2.4)
        }
        let l = cbrt(0.4122214708 * linear[0] + 0.5363325363 * linear[1] + 0.0514459929 * linear[2])
        let m = cbrt(0.2119034982 * linear[0] + 0.6806995451 * linear[1] + 0.1073969566 * linear[2])
        let s = cbrt(0.0883024619 * linear[0] + 0.2817188376 * linear[1] + 0.6299787005 * linear[2])
        let lab = (
            0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
        )
        return (lab.0, hypot(lab.1, lab.2), (atan2(lab.2, lab.1) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360))
    }

    /// Where a palette without a seed would sit on the canvas, so picking it up starts close by.
    static func infer(light: Palette) -> CachedThemeSeed {
        let clamp = { (value: Double) in min(1, max(0, value)) }
        let surface = oklch(light["bg-muted"]).map { CachedThemeSeed.Point(hue: $0.h, radius: clamp($0.c / surfaceChroma)) }
            ?? .init(hue: 0, radius: 0)
        let accent = oklch(light["accent"]).map { CachedThemeSeed.Point(hue: $0.h, radius: clamp(($0.c - 0.02) / 0.2)) } ?? surface
        let softness = oklch(light["bg"]).map { clamp((1 - 0.012 * surface.radius - $0.l) / 0.05) } ?? 0
        return normalized(CachedThemeSeed(points: [surface, accent], softness: softness))
    }

    private static func distance(_ a: Double, _ b: Double) -> Double {
        min(abs(a - b), 360 - abs(a - b))
    }

    /// The next pairing in the harmony cycle, measured from the surface point; the surface stays put.
    static func nextHarmony(_ seed: CachedThemeSeed) -> CachedThemeSeed {
        guard let surface = seed.points.first, let cycle = harmonies[seed.points.count] else { return seed }
        let others = Array(seed.points.dropFirst())
        let offsets = others.map { ($0.hue - surface.hue + 360).truncatingRemainder(dividingBy: 360) }
        let misfit = { (set: [Double]) in zip(set, offsets).reduce(0) { $0 + distance($1.0, $1.1) } }
        var nearest = 0
        for index in cycle.indices where misfit(cycle[index]) < misfit(cycle[nearest]) { nearest = index }
        let next = cycle[(nearest + 1) % cycle.count]
        var points = [surface]
        for (index, point) in others.enumerated() {
            points.append(.init(hue: (surface.hue + next[index]).truncatingRemainder(dividingBy: 360), radius: point.radius))
        }
        return CachedThemeSeed(points: points, softness: seed.softness)
    }

    /// One more point: the accent opposite the surface, then a sidebar mirroring the accent.
    static func addPoint(_ seed: CachedThemeSeed) -> CachedThemeSeed {
        guard let surface = seed.points.first, seed.points.count < 3 else { return seed }
        var next = seed
        if seed.points.count == 1 {
            next.points.append(.init(hue: (surface.hue + 180).truncatingRemainder(dividingBy: 360), radius: max(surface.radius, 0.7)))
            return next
        }
        let offset = (seed.points[1].hue - surface.hue + 360).truncatingRemainder(dividingBy: 360)
        // A mirror of an opposite accent lands on the accent itself; a neighbour reads better there.
        let mirrored = abs(offset - 180) < 20 ? 40 : 360 - offset
        next.points.append(.init(hue: (surface.hue + mirrored).truncatingRemainder(dividingBy: 360), radius: max(surface.radius, 0.5)))
        return next
    }
}
