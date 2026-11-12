import AppKit
import CoreText
import Foundation

/// The families the interface style (or an appearance plugin) names for the canvas's sans and mono text; nil is the system face.
/// Captured on the main thread, read from any.
struct CanvasFaces: Hashable, Sendable {
    var ui: String?
    var mono: String?
    static let system = CanvasFaces(ui: nil, mono: nil)
}

/// A font the way the canvas's CSS asks for it: size, weight, italic, tabular figures, letter spacing, sans or mono.
struct CanvasFont: Hashable, Sendable {
    var size: CGFloat
    var weight: Int = 400
    var mono = false
    var italic = false
    var tabular = false
    /// CSS `letter-spacing` in em.
    var tracking: CGFloat = 0
    var faces = CanvasFaces.system

    func with(_ faces: CanvasFaces) -> CanvasFont { var copy = self; copy.faces = faces; return copy }

    static func sans(_ size: CGFloat, _ weight: Int = 400, italic: Bool = false, tabular: Bool = false, tracking: CGFloat = 0) -> CanvasFont {
        CanvasFont(size: size, weight: weight, mono: false, italic: italic, tabular: tabular, tracking: tracking)
    }
    static func mono(_ size: CGFloat, _ weight: Int = 400, tabular: Bool = false) -> CanvasFont {
        CanvasFont(size: size, weight: weight, mono: true, tabular: tabular)
    }

    /// CoreText font, cached: building one per draw call is the slowest part of a text run.
    var ct: CTFont { CanvasFontCache.font(self) }
    var cjk: CTFont { CanvasFontCache.cjk(self) }
    /// WebKit rounds a font's ascent and descent to whole pixels before it lays a line out.
    var ascent: CGFloat { CanvasFontCache.metrics(self).0 }
    var descent: CGFloat { CanvasFontCache.metrics(self).1 }
    /// Distance from a line box's top to the baseline, for a CSS `line-height` of [lineHeight].
    func baseline(top: CGFloat, lineHeight: CGFloat) -> CGFloat { top + (lineHeight - (ascent + descent)) / 2 + ascent }
    /// Baseline of a line box of [lineHeight] centred on [center].
    func baseline(centeredAt center: CGFloat, lineHeight: CGFloat = 0) -> CGFloat { center + (ascent - descent) / 2 }
}

enum CanvasFontCache {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var fonts: [CanvasFont: CTFont] = [:]
    nonisolated(unsafe) private static var measured: [CanvasFont: (CGFloat, CGFloat)] = [:]

    static func font(_ spec: CanvasFont) -> CTFont {
        lock.lock(); defer { lock.unlock() }
        if let hit = fonts[spec] { return hit }
        var base: NSFont
        if let family = spec.mono ? spec.faces.mono : spec.faces.ui, let named = named(family, spec) {
            base = named
        } else {
            let weight: NSFont.Weight = switch spec.weight {
            case ..<350: .light
            case ..<450: .regular
            case ..<550: .medium
            case ..<650: .semibold
            default: .bold
            }
            base = spec.mono ? .monospacedSystemFont(ofSize: spec.size, weight: weight) : .systemFont(ofSize: spec.size, weight: weight)
            if spec.italic, let italic = NSFont(descriptor: base.fontDescriptor.withSymbolicTraits(.italic), size: spec.size) { base = italic }
        }
        // The web's stack names PingFang SC after the system face: CJK text and full-width punctuation come from it.
        var attributes: [CFString: Any] = [kCTFontCascadeListAttribute: [CTFontDescriptorCreateWithNameAndSize("PingFang SC" as CFString, spec.size)]]
        if spec.tabular {
            attributes[kCTFontFeatureSettingsAttribute] = [[kCTFontFeatureTypeIdentifierKey: kNumberSpacingType, kCTFontFeatureSelectorIdentifierKey: kMonospacedNumbersSelector] as [CFString: Any]]
        }
        let font = CTFontCreateCopyWithAttributes(base as CTFont, spec.size, nil, CTFontDescriptorCreateWithAttributes(attributes as CFDictionary))
        fonts[spec] = font
        return font
    }

    /// A face the style names (Inter, JetBrains Mono, a plugin's), at the CSS weight of [spec]; the bundled ones have no italic file, so those are slanted.
    private static func named(_ family: String, _ spec: CanvasFont) -> NSFont? {
        let descriptor = NSFontDescriptor(fontAttributes: [.family: family, .traits: [NSFontDescriptor.TraitKey.weight: cssWeight(spec.weight)]])
        guard var font = NSFont(descriptor: descriptor, size: spec.size) else { return nil }
        if spec.italic {
            var slant = CGAffineTransform(a: 1, b: 0, c: 0.2126, d: 1, tx: 0, ty: 0)
            font = CTFontCreateCopyWithAttributes(font as CTFont, spec.size, &slant, nil) as NSFont
        }
        return font
    }

    /// CSS `font-weight` as the NSFont weight axis (400 is 0, 500 about 0.23, 600 about 0.3, 700 0.4).
    private static func cssWeight(_ css: Int) -> CGFloat {
        let table: [(Int, CGFloat)] = [(100, -0.8), (200, -0.6), (300, -0.4), (400, 0), (500, 0.23), (600, 0.3), (700, 0.4), (800, 0.56), (900, 0.62)]
        let w = min(900, max(100, css))
        for (a, b) in zip(table, table.dropFirst()) where w <= b.0 { return a.1 + (b.1 - a.1) * CGFloat(w - a.0) / CGFloat(b.0 - a.0) }
        return 0.62
    }

    /// PingFang SC at [spec]'s size and weight, for the CJK characters of a run (the web's stack names it right after the system face).
    static func cjk(_ spec: CanvasFont) -> CTFont {
        var key = spec; key.mono = false; key.tabular = false; key.tracking = 0; key.faces = .system
        key.weight = key.weight >= 550 ? 600 : key.weight >= 450 ? 500 : 400
        lock.lock(); defer { lock.unlock() }
        if let hit = cjkFonts[key] { return hit }
        let name = key.weight == 600 ? "PingFangSC-Semibold" : key.weight == 500 ? "PingFangSC-Medium" : "PingFangSC-Regular"
        var matrix = key.italic ? CGAffineTransform(a: 1, b: 0, c: 0.2126, d: 1, tx: 0, ty: 0) : .identity
        var font = CTFontCreateWithName(name as CFString, key.size, &matrix)
        // Contextual half-width spacing: WebKit shapes CJK punctuation with it on.
        let chws: [CFString: Any] = [kCTFontOpenTypeFeatureTag: "chws", kCTFontOpenTypeFeatureValue: 1]
        font = CTFontCreateCopyWithAttributes(font, key.size, nil, CTFontDescriptorCreateWithAttributes([kCTFontFeatureSettingsAttribute: [chws]] as CFDictionary))
        cjkFonts[key] = font
        return font
    }
    nonisolated(unsafe) private static var cjkFonts: [CanvasFont: CTFont] = [:]

    static func metrics(_ spec: CanvasFont) -> (CGFloat, CGFloat) {
        let ct = font(spec)
        lock.lock(); defer { lock.unlock() }
        if let hit = measured[spec] { return hit }
        let value = (CTFontGetAscent(ct).rounded(), CTFontGetDescent(ct).rounded())
        measured[spec] = value
        return value
    }
}

/// How text is set: the font, the colour, and the language CoreText should pick CJK glyphs for.
struct CanvasTextStyle {
    var font: CanvasFont
    var color: CGColor
    var strike: CGColor?

    init(_ font: CanvasFont, _ color: CGColor, strike: CGColor? = nil) { self.font = font; self.color = color; self.strike = strike }
}

enum CanvasText {
    static let ellipsis = "…"

    /// CJK ideographs, kana and the full-width forms: the characters PingFang SC draws.
    @inline(__always) static func isCJK(_ u: UInt32) -> Bool {
        (u >= 0x2E80 && u <= 0x9FFF) || (u >= 0xF900 && u <= 0xFAFF) || (u >= 0xFF00 && u <= 0xFFEF) || (u >= 0x20000 && u <= 0x2FFFF)
    }

    /// Han and kana: what `text-autospace` calls ideographs (not the CJK punctuation or the full-width forms).
    @inline(__always) static func isIdeograph(_ u: UInt32) -> Bool {
        (u >= 0x3040 && u <= 0x9FFF && !(u >= 0x3000 && u <= 0x303F)) || (u >= 0xF900 && u <= 0xFAFF) || (u >= 0x20000 && u <= 0x2FFFF)
    }
    @inline(__always) static func isWord(_ c: Unicode.Scalar) -> Bool {
        c.value < 0x2E80 && (c.properties.isAlphabetic || c.properties.numericType == .decimal)
    }

    static func attributed(_ text: String, _ style: CanvasTextStyle) -> CFAttributedString {
        var attributes: [CFString: Any] = [
            kCTFontAttributeName: style.font.ct,
            kCTForegroundColorAttributeName: style.color,
        ]
        if style.font.tracking != 0 { attributes[kCTKernAttributeName] = style.font.tracking * style.font.size }
        guard text.utf8.contains(where: { $0 >= 0x80 }) else { return CFAttributedStringCreate(nil, text as CFString, attributes as CFDictionary) }
        let result = CFAttributedStringCreateMutable(nil, 0)!
        CFAttributedStringReplaceString(result, CFRange(location: 0, length: 0), text as CFString)
        let whole = CFRange(location: 0, length: CFAttributedStringGetLength(result))
        CFAttributedStringSetAttributes(result, whole, attributes as CFDictionary, true)
        let cjk = style.font.cjk
        let scalars = Array(text.unicodeScalars)
        let track = style.font.tracking * style.font.size
        let autospace = style.font.size / 8
        var offset = 0, runStart = -1
        // `text-autospace: normal`: an eighth of an em between an ideograph and an adjacent letter or digit. CoreText adds a spacing of
        // its own at those joins (and a wide one after full-width punctuation), which is what a kern of zero on the letter switches off.
        func kern(_ at: Int, _ width: Int, _ value: CGFloat) {
            CFAttributedStringSetAttribute(result, CFRange(location: at, length: width), kCTKernAttributeName, (track + value) as CFNumber)
        }
        var suppress = false
        for (i, scalar) in scalars.enumerated() {
            let width = scalar.value > 0xFFFF ? 2 : 1
            // The rest of the word after such a join keeps the zero kern too, or CoreText moves its spacing into the word.
            if suppress { if !isCJK(scalar.value) && !scalar.properties.isWhitespace { kern(offset, width, 0) } else { suppress = false } }
            if isCJK(scalar.value) { if runStart < 0 { runStart = offset } } else if runStart >= 0 {
                CFAttributedStringSetAttribute(result, CFRange(location: runStart, length: offset - runStart), kCTFontAttributeName, cjk); runStart = -1
            }
            if i > 0 {
                let prev = scalars[i - 1]
                let prevOffset = offset - (prev.value > 0xFFFF ? 2 : 1)
                let prevIdeo = isIdeograph(prev.value), curIdeo = isIdeograph(scalar.value)
                let prevWord = isWord(prev), curWord = isWord(scalar)
                if prevIdeo && curWord { kern(prevOffset, prev.value > 0xFFFF ? 2 : 1, autospace); kern(offset, width, 0); suppress = true }
                else if prevWord && curIdeo { kern(prevOffset, prev.value > 0xFFFF ? 2 : 1, autospace) }
                else if isCJK(prev.value) && !prevIdeo && curWord { kern(offset, width, 0); suppress = true }
            }
            offset += width
        }
        if runStart >= 0 { CFAttributedStringSetAttribute(result, CFRange(location: runStart, length: offset - runStart), kCTFontAttributeName, cjk) }
        return result
    }

    static func line(_ text: String, _ style: CanvasTextStyle) -> CTLine { CTLineCreateWithAttributedString(attributed(text, style)) }

    static func width(_ text: String, _ style: CanvasTextStyle) -> CGFloat {
        text.isEmpty ? 0 : CGFloat(CTLineGetTypographicBounds(line(text, style), nil, nil, nil))
    }

    /// `white-space: normal`: runs of whitespace (newlines too) collapse to one space and the ends are trimmed.
    static func collapse(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        var pendingSpace = false
        for ch in text {
            if ch == " " || ch == "\n" || ch == "\t" || ch == "\r" { pendingSpace = !out.isEmpty } else {
                if pendingSpace { out.append(" "); pendingSpace = false }
                out.append(ch)
            }
        }
        return out
    }

    /// `white-space: pre-line`: newlines stay, other runs of whitespace collapse, each line is trimmed.
    static func paragraphs(_ text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).map { collapse(String($0)) }
    }

    /// The text of [text] that fits [width] on one line, followed by an ellipsis when something had to go (`text-overflow: ellipsis`).
    static func truncated(_ text: String, _ style: CanvasTextStyle, width: CGFloat, fromStart: Bool = false) -> String {
        if width <= 0 { return "" }
        if self.width(text, style) <= width + 0.01 { return text }
        let chars = Array(text)
        var lo = 0, hi = chars.count
        // Largest kept length whose text plus the ellipsis fits.
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            let kept = fromStart ? String(chars[(chars.count - mid)...]) : String(chars[..<mid])
            let candidate = fromStart ? ellipsis + kept : kept + ellipsis
            if self.width(candidate, style) <= width + 0.01 { lo = mid } else { hi = mid - 1 }
        }
        if lo == 0 { return self.width(ellipsis, style) <= width ? ellipsis : "" }
        let kept = fromStart ? String(chars[(chars.count - lo)...]) : String(chars[..<lo])
        return fromStart ? ellipsis + kept : kept.trimmingTrailingSpaces() + ellipsis
    }

    /// Breaks [paragraph] into lines of at most [width], the way a browser does for `overflow-wrap: break-word`.
    static func breakLines(_ paragraph: String, _ style: CanvasTextStyle, width: CGFloat, limit: Int = .max) -> [String] {
        if paragraph.isEmpty { return [""] }
        let paragraph = glueSlashes(paragraph)
        let attributed = attributed(paragraph, style)
        let typesetter = CTTypesetterCreateWithAttributedString(attributed)
        let ns = paragraph as NSString
        var lines: [String] = []
        var start = 0
        while start < ns.length, lines.count < limit {
            var count = max(1, CTTypesetterSuggestLineBreak(typesetter, start, Double(width)))
            // CoreText lets closing punctuation hang past the edge; a browser does not.
            var room = Double(width)
            while count > 1, lineWidth(typesetter, start, count) > Double(width) + 0.01, room > 1 {
                room -= 1
                count = max(1, CTTypesetterSuggestLineBreak(typesetter, start, room))
            }
            lines.append(ns.substring(with: NSRange(location: start, length: count)))
            start += count
            // A line break swallows the spaces it broke at.
            while start < ns.length, ns.character(at: start) == 32 { start += 1 }
        }
        return lines
    }

    /// WebKit does not break after a slash that follows Latin text or starts a word (`word/word`, `/var/folders`), where the Unicode
    /// line-break rules CoreText follows would: a word joiner after such a slash keeps it whole. After an ideograph it breaks, as ICU does.
    static func glueSlashes(_ text: String) -> String {
        guard text.contains("/") else { return text }
        let scalars = Array(text.unicodeScalars)
        var out = String.UnicodeScalarView()
        for (i, c) in scalars.enumerated() {
            out.append(c)
            if c == "/", i + 1 < scalars.count, !scalars[i + 1].properties.isWhitespace, scalars[i + 1] != "/" || true, i == 0 || !isCJK(scalars[i - 1].value) { out.append("\u{2060}") }
        }
        return String(out)
    }

    private static func lineWidth(_ typesetter: CTTypesetter, _ start: Int, _ count: Int) -> Double {
        let line = CTTypesetterCreateLine(typesetter, CFRange(location: start, length: count))
        return CTLineGetTypographicBounds(line, nil, nil, nil) - CTLineGetTrailingWhitespaceWidth(line)
    }

    struct Block {
        var lines: [String]
        /// More text followed the last line: it ends in an ellipsis.
        var clamped: Bool
    }

    /// `-webkit-line-clamp: [maxLines]` over [paragraphs]: lines broken normally, the last one cut to fit an ellipsis when the text goes on.
    static func clamp(_ paragraphs: [String], _ style: CanvasTextStyle, width: CGFloat, maxLines: Int) -> Block {
        var all: [String] = []
        for paragraph in paragraphs {
            let room = maxLines + 1 - all.count
            if room <= 0 { break }
            all += breakLines(paragraph, style, width: width, limit: room)
        }
        if all.count > maxLines { return finish(Array(all.prefix(maxLines)), style, width: width, more: true) }
        return Block(lines: all, clamped: false)
    }

    private static func finish(_ lines: [String], _ style: CanvasTextStyle, width: CGFloat, more: Bool) -> Block {
        var lines = lines
        guard let last = lines.popLast() else { return Block(lines: [], clamped: false) }
        let trimmed = last.trimmingTrailingSpaces()
        var kept = Array(trimmed)
        while !kept.isEmpty, self.width(String(kept) + ellipsis, style) > width + 0.01 { kept.removeLast() }
        lines.append(String(kept).trimmingTrailingSpaces() + ellipsis)
        return Block(lines: lines, clamped: true)
    }

    // MARK: Drawing

    /// Draws [text] with its baseline at [baseline], left edge at [x]. The context is y-down.
    @discardableResult
    static func draw(_ text: String, _ style: CanvasTextStyle, in ctx: CGContext, x: CGFloat, baseline: CGFloat, alignRight: Bool = false) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        let line = line(text, style)
        let width = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
        let originX = alignRight ? x - width : x
        ctx.saveGState()
        ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        ctx.textPosition = CGPoint(x: originX, y: baseline)
        CTLineDraw(line, ctx)
        ctx.restoreGState()
        if let strike = style.strike {
            // `line-through`: a thin rule through the x-height's middle.
            let y = baseline - style.font.size * 0.3
            ctx.setFillColor(strike)
            ctx.fill(CGRect(x: originX, y: y - 0.5, width: width, height: max(1, style.font.size / 14)))
        }
        return width
    }

    /// A block of [lines] from [top], each [lineHeight] tall.
    static func drawLines(_ lines: [String], _ style: CanvasTextStyle, in ctx: CGContext, x: CGFloat, top: CGFloat, lineHeight: CGFloat) {
        var y = style.font.baseline(top: top, lineHeight: lineHeight)
        for line in lines { draw(line, style, in: ctx, x: x, baseline: y); y += lineHeight }
    }
}

extension String {
    func trimmingTrailingSpaces() -> String {
        var s = Substring(self)
        while s.last == " " { s = s.dropLast() }
        return String(s)
    }
}
