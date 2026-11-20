import AppKit
import SwiftUI
import RiffetKit

/// What 导出图片 turns into a picture: a passage (a highlight or a selection) or a whole answer, and
/// where it was said. The layout rules are shared with the web (`docs/design/mark-share-demo.html`).
struct ShareSource {
    enum Kind { case span, message }

    var kind: Kind
    /// The passage, or the answer's Markdown.
    var text: String
    /// The highlight's colour; nil for an answer or an unsaved selection.
    var color: MarkColor?
    var note: String?
    var sessionTitle = ""
    var agent: String?
    /// The model selection (`model[k=v]`) of the run that wrote the passage; nil until known.
    var model: String?
    /// The catalog the model's display name is read from; empty when the Mac has none.
    var models: [ModelInfo] = []
    var project: String?
    var projectId: String?
    var at: Date?
    /// A passage's place in the answer's full Markdown, which it is laid out in when it has structure.
    var fullText: String?
    var quote: MarkQuote?
    /// The run of the answer's turn, whose model the transcript can name.
    var runId: String?
    /// The question that started the answer and the model that wrote it, as far as the server knows;
    /// resolves to nil when it cannot be read.
    var prompt: (@MainActor () async -> (text: String?, model: String?)?)?
}

extension ShareSource {
    init(mark: Mark, project: String?, models: [ModelInfo] = []) {
        self.models = models
        kind = mark.isSpan ? .span : .message
        text = mark.isSpan ? (mark.quote?.exact ?? mark.snapshot.text) : mark.snapshot.text
        color = mark.isSpan ? mark.markColor : nil
        note = mark.note?.isEmpty == false ? mark.note : nil
        sessionTitle = mark.snapshot.sessionTitle
        agent = Self.agent(mark.backendId)
        self.project = project
        projectId = mark.projectId
        at = ServerTime.date(mark.snapshot.at)
        if mark.isSpan {
            fullText = mark.snapshot.text
            quote = mark.quote
        }
        let id = mark.id
        prompt = { await MarksStore.shared.prompt(id) }
    }

    /// The label the rest of the app shows for a backend id sent as a string.
    static func agent(_ backendId: String?) -> String? {
        guard let raw = backendId?.lowercased(), !raw.isEmpty else { return nil }
        return builtinAgentLabel(raw)
    }
}

enum ShareTheme: String, CaseIterable {
    case paper, ink, theme

    var title: String {
        switch self {
        case .paper: String(localized: "纸白")
        case .ink: String(localized: "墨黑")
        case .theme: String(localized: "跟随主题")
        }
    }
}

enum ShareFace: String, CaseIterable {
    case sans, serif

    var title: String { self == .sans ? String(localized: "黑体") : String(localized: "宋体") }
}

enum ShareWidth: String, CaseIterable {
    case auto, narrow, wide

    var title: String {
        switch self {
        case .auto: String(localized: "自动")
        case .narrow: String(localized: "竖版")
        case .wide: String(localized: "宽版")
        }
    }
}

/// The export panel's choices. Theme, face, width and the source items are remembered; the question
/// and the note start off every time.
struct ShareOptions: Equatable {
    var theme: ShareTheme
    var face: ShareFace
    var width: ShareWidth
    var title = true
    var agent = true
    var model = true
    var project = true
    var date = true
    var ask = false
    var note = false

    private static let prefix = "riffet.share."

    static func load() -> ShareOptions {
        let defaults = UserDefaults.standard
        // The single source switch this replaced: off turns every item off until chosen again.
        let legacy = defaults.object(forKey: prefix + "source") as? Bool
        func item(_ name: String) -> Bool { defaults.object(forKey: prefix + "show." + name) as? Bool ?? legacy ?? true }
        return ShareOptions(
            theme: defaults.string(forKey: prefix + "theme").flatMap(ShareTheme.init) ?? .paper,
            face: defaults.string(forKey: prefix + "font").flatMap(ShareFace.init) ?? .sans,
            width: defaults.string(forKey: prefix + "width").flatMap(ShareWidth.init) ?? .auto,
            title: item("title"), agent: item("agent"), model: item("model"), project: item("project"), date: item("date")
        )
    }

    func save() {
        let defaults = UserDefaults.standard
        defaults.set(theme.rawValue, forKey: Self.prefix + "theme")
        defaults.set(face.rawValue, forKey: Self.prefix + "font")
        defaults.set(width.rawValue, forKey: Self.prefix + "width")
        for (name, on) in [("title", title), ("agent", agent), ("model", model), ("project", project), ("date", date)] {
            defaults.set(on, forKey: Self.prefix + "show." + name)
        }
    }
}

/// What the card shows of a source: the passage or the (possibly cut) Markdown, and the size it
/// is exported at.
struct ShareContent {
    let text: String
    /// "全文约 3,200 字" when a long answer was cut.
    let excerpt: String?
    let suggestsWide: Bool
    /// A passage's own Markdown structure, when it has one; nil sets it as a large quotation.
    let structure: [MarkdownBlock]?

    static let limit = 3000
    static let maxPixels: CGFloat = 16384

    init(_ source: ShareSource) {
        let trimmed = source.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard source.kind == .message else {
            text = trimmed
            excerpt = nil
            let blocks = source.fullText.flatMap { ShareSpan.blocks(of: trimmed, prefix: source.quote?.prefix ?? "", suffix: source.quote?.suffix ?? "", in: $0) }
            structure = blocks
            suggestsWide = blocks.map(Self.needsWide(blocks:)) ?? false
            return
        }
        structure = nil
        // Lengths are counted in UTF-16 units, as the web counts them.
        if trimmed.utf16.count > Self.limit {
            let head = String(trimmed.utf16.prefix(Self.limit)) ?? String(trimmed.prefix(Self.limit))
            // A paragraph break only counts when it still leaves most of the excerpt: a short intro
            // followed by one long paragraph would otherwise export the intro alone.
            let floor = Self.limit / 3
            var cut = head
            if let paragraph = head.range(of: "\n\n", options: .backwards), Self.offset(of: paragraph.lowerBound, in: head) >= floor {
                cut = String(head[..<paragraph.lowerBound])
            } else if let line = head.range(of: "\n", options: .backwards), Self.offset(of: line.lowerBound, in: head) >= floor {
                cut = String(head[..<line.lowerBound])
            }
            let fences = cut.components(separatedBy: "\n").filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }.count
            if fences % 2 == 1 { cut += "\n```" }
            text = cut
            excerpt = String(localized: "全文约 \(Self.roundedCount(trimmed)) 字")
        } else {
            text = trimmed
            excerpt = nil
        }
        suggestsWide = Self.needsWide(text)
    }

    /// [index]'s distance from the start of [text], in UTF-16 units — the unit the limit counts in.
    private static func offset(of index: String.Index, in text: String) -> Int {
        text[..<index].utf16.count
    }

    /// Non-whitespace characters, to the nearest hundred, with thousands separators.
    private static func roundedCount(_ text: String) -> String {
        let count = text.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }.reduce(0) { $0 + String($1).utf16.count }
        let rounded = Int((Double(count) / 100).rounded()) * 100
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        return formatter.string(from: NSNumber(value: rounded)) ?? String(rounded)
    }

    /// A table, or a code line longer than 60 characters, reads badly at the narrow width.
    private static func needsWide(_ markdown: String) -> Bool {
        MarkdownModel.segments(markdown).contains { segment in
            if case let .blocks(parts) = segment { return needsWide(blocks: ShareMarkdown.flatten(parts)) }
            return false
        }
    }

    static func needsWide(blocks: [MarkdownBlock]) -> Bool {
        blocks.contains { block in
            switch block {
            case .table: true
            case let .code(_, text): text.components(separatedBy: "\n").contains { $0.utf16.count > 60 }
            case let .list(_, _, items): items.contains { needsWide(blocks: $0.blocks) }
            case let .quote(parts): needsWide(blocks: ShareMarkdown.flatten(parts))
            default: false
            }
        }
    }
}

/// Sizes of the card at one width.
struct ShareMetrics {
    let wide: Bool
    var width: CGFloat { wide ? 720 : 480 }
    var pad: CGFloat { wide ? 28 : 20 }
    var cardX: CGFloat { wide ? 48 : 36 }
    var cardTop: CGFloat { wide ? 48 : 40 }
    var scale: CGFloat { wide ? 2 : 3 }

    init(kind: ShareSource.Kind, width: ShareWidth, content: ShareContent) {
        switch width {
        case .narrow: wide = false
        case .wide: wide = true
        case .auto: wide = content.suggestsWide
        }
    }

    /// The export scale for a card [height] points tall: lowered so the picture stays within the
    /// largest bitmap image viewers reliably open.
    func scale(height: CGFloat) -> CGFloat {
        guard height > 0 else { return scale }
        return min(scale, floor(ShareContent.maxPixels / height * 100) / 100)
    }
}

/// The card's colours: fixed paper and ink palettes, or the app's own palette resolved for one
/// appearance. Concrete colours, so an offscreen render cannot pick the wrong appearance.
struct ShareColors {
    let dark: Bool
    let canvas, card, ink, ink2, ink3, ink4, hair, hair2, code: Color
    /// [ink] as `#rrggbb`, which the formula renderer takes.
    let inkHex: String
    let keyword, string, number, comment, function, punctuation: Color
    let ring: Color
    let near: Color?
    /// The large soft shadow: colour, blur, y offset and spread (negative), as in CSS.
    let far: (color: Color, blur: CGFloat, y: CGFloat, spread: CGFloat)

    @MainActor
    init(_ theme: ShareTheme, dark appDark: Bool, palette: Palette) {
        func hex(_ value: UInt32, _ alpha: Double = 1) -> Color {
            Color(.sRGB, red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255, opacity: alpha)
        }
        switch theme {
        case .paper:
            dark = false
            inkHex = "#1C1B19"
            canvas = hex(0xEFECE6); card = hex(0xFBFAF7); ink = hex(0x1C1B19); ink2 = hex(0x4A4740); ink3 = hex(0x6F6B64); ink4 = hex(0xA29D94)
            hair = hex(0x1C1B19, 0.08); hair2 = hex(0x1C1B19, 0.16); code = hex(0xF2EFE9)
            keyword = hex(0x9A4D8C); string = hex(0x4F7F3A); number = hex(0xB5622C); comment = hex(0xA29D94); function = hex(0x2F5D9E); punctuation = hex(0x6F6B64)
            ring = hex(0x1C1B19, 0.06); near = hex(0x1C1B19, 0.04); far = (hex(0x3C2D14, 0.22), 40, 18, -20)
        case .ink:
            dark = true
            inkHex = "#ECEAE6"
            canvas = hex(0x0E0E0F); card = hex(0x18181A); ink = hex(0xECEAE6); ink2 = hex(0xC9C6C0); ink3 = hex(0xA09D97); ink4 = hex(0x6E6B66)
            hair = hex(0xFFFFFF, 0.07); hair2 = hex(0xFFFFFF, 0.14); code = hex(0x212123)
            keyword = hex(0xD49BD0); string = hex(0xA8C98A); number = hex(0xE3A578); comment = hex(0x6E6B66); function = hex(0x8FB4E8); punctuation = hex(0xA09D97)
            ring = hex(0xFFFFFF, 0.06); near = nil; far = (hex(0x000000, 0.7), 56, 24, -24)
        case .theme:
            dark = appDark
            let values = appDark ? palette.values.dark : palette.values.light
            func color(_ rgba: RiffetRGBA) -> Color { Color(.sRGB, red: rgba.red, green: rgba.green, blue: rgba.blue, opacity: rgba.alpha) }
            func ns(_ rgba: RiffetRGBA) -> NSColor { NSColor(srgbRed: rgba.red, green: rgba.green, blue: rgba.blue, alpha: rgba.alpha) }
            // The transcript's code colours: semantic hues pulled toward the grey scale.
            func muted(_ rgba: RiffetRGBA) -> Color { Color(nsColor: ns(rgba).blended(withFraction: 0.38, of: ns(values.fg3)) ?? ns(rgba)) }
            canvas = color(appDark ? values.bg : values.bgMuted)
            card = color(appDark ? values.bgElevated : values.bg)
            code = color(appDark ? values.bgMuted : values.bgSubtle)
            ink = color(values.fg); ink2 = color(values.fg2); ink3 = color(values.fg3); ink4 = color(values.fg4)
            inkHex = values.fg.hex
            hair = color(values.line); hair2 = color(values.lineStrong)
            keyword = muted(values.accent); string = muted(values.success); number = muted(values.warning)
            comment = color(values.fg4); function = muted(values.accentHover); punctuation = color(values.fg3)
            if appDark {
                ring = hex(0xFFFFFF, 0.06); near = nil; far = (hex(0x000000, 0.7), 56, 24, -24)
            } else {
                ring = hex(0x0F172A, 0.07); near = hex(0x0F172A, 0.04); far = (hex(0x0F172A, 0.2), 40, 18, -20)
            }
        }
    }

    /// The highlight's colour as a small accent (the quote glyph, the note's rule).
    func accent(_ color: MarkColor?) -> Color? {
        guard let color else { return nil }
        let value: UInt32 = switch (color, dark) {
        case (.yellow, false): 0xC9951A
        case (.green, false): 0x3C9A5F
        case (.blue, false): 0x3A74D0
        case (.red, false): 0xCC4F46
        case (.yellow, true): 0xE2B341
        case (.green, true): 0x6CC08A
        case (.blue, true): 0x78A6EE
        case (.red, true): 0xEC7C73
        }
        return Color(.sRGB, red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }
}

/// The card's faces. Serif is Songti SC throughout: behind New York its Han punctuation was set
/// with a wide gap after it. Mono is JetBrains Mono when installed, SF Mono otherwise.
struct ShareType {
    let serif: Bool

    func body(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        serif ? Self.serif(size, weight) : Self.sans(size, weight)
    }

    static func sans(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        .systemFont(ofSize: size, weight: weight)
    }

    static func serif(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        NSFont(name: weight.rawValue >= NSFont.Weight.semibold.rawValue ? "STSongti-SC-Bold" : "STSongti-SC-Regular", size: size)
            ?? NSFont(descriptor: NSFont.systemFont(ofSize: size, weight: weight).fontDescriptor.withDesign(.serif) ?? NSFont.systemFont(ofSize: size).fontDescriptor, size: size)
            ?? .systemFont(ofSize: size, weight: weight)
    }

    private static let jetBrains = NSFontManager.shared.availableFontFamilies.contains("JetBrains Mono")

    static func mono(_ size: CGFloat) -> NSFont {
        if jetBrains, let font = NSFont(name: "JetBrainsMono-Regular", size: size) { return font }
        return .monospacedSystemFont(ofSize: size, weight: .regular)
    }

    /// Han text sets the height of most lines here, so line spacing is measured against the face
    /// the system falls back to for it as well as the Latin one.
    func lineGap(_ font: NSFont, lineHeight: CGFloat) -> CGFloat {
        let manager = NSLayoutManager()
        let han = serif ? NSFont(name: "STSongti-SC-Regular", size: font.pointSize) : NSFont(name: "PingFangSC-Regular", size: font.pointSize)
        let natural = max(manager.defaultLineHeight(for: font), han.map(manager.defaultLineHeight(for:)) ?? 0)
        return max(0, lineHeight - natural)
    }
}

extension View {
    /// CSS line-height: the gap between lines, and half of it above the first and below the last.
    func shareLines(_ gap: CGFloat) -> some View {
        lineSpacing(gap).padding(.vertical, gap / 2)
    }
}

/// The exported picture: a canvas, the card on it, and inside the card the question, the passage or
/// the answer, the note and the source line.
struct ShareCard: View {
    let source: ShareSource
    let content: ShareContent
    let options: ShareOptions
    let metrics: ShareMetrics
    let colors: ShareColors
    /// The question, when it is to be shown.
    let prompt: String?
    /// The model's display name, when there is one.
    let model: String?

    private var type: ShareType { ShareType(serif: options.face == .serif) }
    private var note: String? { options.note ? source.note : nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let prompt, source.kind == .message { ask(prompt).padding(.bottom, 26) }
            switch source.kind {
            case .span: passage
            case .message: answer
            }
            if let note { noteBlock(note).padding(.top, 30) }
            footer.padding(.top, 34)
        }
        .padding(EdgeInsets(top: metrics.cardTop, leading: metrics.cardX, bottom: 26, trailing: metrics.cardX))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardBackground)
        .padding(metrics.pad)
        .frame(width: metrics.width)
        .background(colors.canvas)
        .environment(\.colorScheme, colors.dark ? .dark : .light)
    }

    private var cardBackground: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.floating, style: .continuous)
        return ZStack {
            // A negative spread shrinks the shadow's shape, so only its lower edge shows past the card.
            RoundedRectangle(cornerRadius: max(0, 16 + colors.far.spread), style: .continuous)
                .fill(colors.card)
                .padding(-colors.far.spread)
                .shadow(color: colors.far.color, radius: colors.far.blur / 2, y: colors.far.y)
            shape.fill(colors.card)
                .shadow(color: colors.near ?? .clear, radius: 1, y: 1)
            shape.stroke(colors.ring, lineWidth: 1).padding(-0.5)
        }
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .font(Font(ShareType.sans(11, .semibold)))
            .tracking(11 * 0.12)
            .foregroundStyle(colors.ink4)
            .padding(.bottom, 7)
    }

    private var title: String? {
        guard options.title else { return nil }
        return source.sessionTitle.isEmpty ? String(localized: "未命名会话") : source.sessionTitle
    }

    private func ask(_ prompt: String) -> some View {
        let font = type.body(14)
        return VStack(alignment: .leading, spacing: 0) {
            label(String(localized: "提问"))
            Text(prompt.trimmingCharacters(in: .whitespacesAndNewlines))
                .font(Font(font))
                .foregroundStyle(colors.ink3)
                .lineLimit(3)
                .shareLines(type.lineGap(font, lineHeight: 14 * 1.75))
                .fixedSize(horizontal: false, vertical: true)
            Rectangle().fill(colors.hair2).frame(width: 20, height: 1).padding(.top, 22)
        }
    }

    private var passage: some View {
        let count = content.text.utf16.count
        let (size, height): (CGFloat, CGFloat) = count <= 60 ? (26, 1.62) : count <= 160 ? (21, 1.72) : (18, 1.8)
        let font = type.body(size)
        return VStack(alignment: .leading, spacing: 0) {
            QuoteGlyph(color: (colors.accent(source.color) ?? colors.ink3).opacity(0.85))
                .padding(.bottom, 14)
            if let structure = content.structure {
                ShareMarkdown(blocks: structure, colors: colors, type: type, wide: metrics.wide, projectId: source.projectId)
            } else {
                Text(content.text)
                    .font(Font(font))
                    .tracking(size * (type.serif ? 0.02 : 0.01))
                    .foregroundStyle(colors.ink)
                    .shareLines(type.lineGap(font, lineHeight: size * height))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var answer: some View {
        VStack(alignment: .leading, spacing: 0) {
            ShareMarkdown(source: content.text, colors: colors, type: type, wide: metrics.wide, projectId: source.projectId)
            if content.excerpt != nil {
                Text("……")
                    .font(Font(ShareType.sans(15)))
                    .tracking(15 * 0.2)
                    .foregroundStyle(colors.ink4)
                    .padding(.top, 6)
            }
        }
    }

    private func noteBlock(_ note: String) -> some View {
        let font = type.body(14)
        return VStack(alignment: .leading, spacing: 0) {
            label(String(localized: "批注"))
            Text(note)
                .font(Font(font))
                .foregroundStyle(colors.ink2)
                .shareLines(type.lineGap(font, lineHeight: 14 * 1.75))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 14)
        .overlay(alignment: .leading) { Rectangle().fill(colors.accent(source.color) ?? colors.hair2).frame(width: 2) }
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Rectangle().fill(colors.hair).frame(height: 1)
            HStack(alignment: .bottom, spacing: 20) {
                if title != nil || !sublineParts.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        if let title {
                            Text(title)
                                .font(Font(ShareType.sans(13, .medium)))
                                .foregroundStyle(colors.ink2)
                                .lineLimit(1)
                        }
                        if !sublineParts.isEmpty {
                            subline
                                .font(Font(ShareType.sans(12)))
                                .monospacedDigit()
                                .foregroundStyle(colors.ink4)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Spacer(minLength: 0)
                }
                RiffetWordmark()
                    .stroke(colors.ink4, style: StrokeStyle(lineWidth: 2.8 * RiffetWordmark.height / 22, lineCap: .round, lineJoin: .round))
                    .frame(width: RiffetWordmark.width, height: RiffetWordmark.height)
                    .padding(.bottom, 3)
            }
            .padding(.top, 16)
        }
    }

    /// Agent · model · project · date, then the excerpt note: what is on and has a value.
    private var sublineParts: [String] {
        [options.agent ? source.agent : nil, options.model ? model : nil, options.project ? source.project : nil,
         options.date ? source.at.map(Self.date) : nil, content.excerpt.map { String(localized: "节选 · \($0)") }]
            .compactMap { $0 }.filter { !$0.isEmpty }
    }

    private var subline: Text {
        let parts = sublineParts
        var result = AttributedString()
        for (index, part) in parts.enumerated() {
            if index > 0 {
                var separator = AttributedString("\u{2002}·\u{2002}")
                separator.foregroundColor = colors.ink4.opacity(0.7)
                result += separator
            }
            result += AttributedString(part)
        }
        return Text(result)
    }

    static func date(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = AppLocale.current
        formatter.setLocalizedDateFormatFromTemplate("yMMMd")
        return formatter.string(from: date)
    }
}

/// The opening quotation mark over a passage: Georgia at 68pt, set on a 34pt line pulled up 4pt, as
/// the web lays it out.
private struct QuoteGlyph: View {
    let color: Color

    var body: some View {
        let font = NSFont(name: "Georgia", size: 68) ?? .systemFont(ofSize: 68)
        // CSS centres the face's ascent and descent on a 68pt line box; SwiftUI starts the text at its ascent.
        let lift = (68 - font.ascender + font.descender) / 2 - 4
        Text("\u{201C}")
            .font(Font(font))
            .foregroundStyle(color)
            .fixedSize()
            .offset(x: -3, y: lift)
            .frame(height: 30, alignment: .topLeading)
    }
}

/// The Riffet wordmark (`docs/brand`), as strokes on its 67.2×22 drawing.
struct RiffetWordmark: Shape {
    static let height: CGFloat = 12
    static let width: CGFloat = 67.2 * height / 22

    func path(in rect: CGRect) -> Path {
        var path = Path()
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x + 1.6, y: y) }
        /// A circular arc by angle in degrees, y down, so a larger angle turns clockwise on screen.
        func arc(_ cx: CGFloat, _ cy: CGFloat, _ radius: CGFloat, from: CGFloat, to: CGFloat) {
            let steps = Int((abs(to - from) / 90).rounded(.up))
            let sweep = (to - from) / CGFloat(steps) * .pi / 180
            let k = 4 / 3 * tan(sweep / 4) * radius
            var angle = from * .pi / 180
            for _ in 0..<steps {
                let next = angle + sweep
                path.addCurve(
                    to: p(cx + radius * cos(next), cy + radius * sin(next)),
                    control1: p(cx + radius * cos(angle) - k * sin(angle), cy + radius * sin(angle) + k * cos(angle)),
                    control2: p(cx + radius * cos(next) + k * sin(next), cy + radius * sin(next) - k * cos(next)))
                angle = next
            }
        }
        // R: stem and bowl, then the leg from the middle of the bowl
        path.move(to: p(0, 20)); path.addLine(to: p(0, 2)); path.addLine(to: p(5, 2))
        arc(5, 6.5, 4.5, from: -90, to: 90)
        path.addLine(to: p(0, 11))
        path.move(to: p(3.6, 11)); path.addLine(to: p(10, 20))
        // i, its dot a round-capped point as wide as the dot
        path.move(to: p(15.4, 8)); path.addLine(to: p(15.4, 20))
        path.addEllipse(in: CGRect(x: p(15.4, 2.6).x - 0.336, y: 2.6 - 0.336, width: 0.672, height: 0.672))
        // f, f: each with its own crossbar
        for x: CGFloat in [23, 32.8] {
            path.move(to: p(x, 20)); path.addLine(to: p(x, 6))
            arc(x + 4, 6, 4, from: 180, to: 270)
            path.move(to: p(x - 2.2, 8)); path.addLine(to: p(x + 2.2, 8))
        }
        // e
        path.move(to: p(40.4, 14)); path.addLine(to: p(52.4, 14))
        arc(46.4, 14, 6, from: 0, to: -315)
        // t: hooked, with a crossbar
        path.move(to: p(60, 2)); path.addLine(to: p(60, 16))
        arc(64, 16, 4, from: 180, to: 90)
        path.move(to: p(57.8, 8)); path.addLine(to: p(62.2, 8))
        let scale = rect.height / 22
        return path.applying(CGAffineTransform(scaleX: scale, y: scale).concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
    }
}
