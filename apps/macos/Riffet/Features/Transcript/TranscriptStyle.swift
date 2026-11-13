import AppKit
import RiffetKit

/// Everything a transcript layout depends on besides its content and width, captured on the main
/// thread and handed to the layout queue. Two layouts made with equal `key`s are interchangeable.
struct TranscriptStyle: @unchecked Sendable {
    let palette: Palette
    let scale: CGFloat
    let density: CGFloat
    /// The reading column the reader chose (640–1600).
    let column: CGFloat
    let dark: Bool
    /// The plugin fonts in effect, if any; text metrics follow them, so they are part of [key].
    let fonts: AppearanceFonts
    /// The interface style's fonts, which a plugin's override; part of [key] for the same reason.
    let styleFonts: StyleSpec.Fonts
    /// The interface style's corners, read on the main thread for the layout queue.
    let radii: StyleSpec.Radii
    /// How a run of tool calls is drawn; read with the radii, so a style switch lays the rows out again.
    let toolRun: StyleSpec.ToolRun
    /// How a block of content (code, tables, chips) is set off from the page.
    let block: StyleSpec.Block
    /// The paper the rows sit on (`Palette.page`): what an outlined block shows through.
    let paper: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable
    /// The icon pack in use; symbols are drawn from cached images, so a switch redraws every row.
    let iconPack: String
    /// What a checked box, a step in progress or a saved reply is marked with (`Palette.markRole`).
    var mark: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable = \.accent
    /// A link's colour: ink with its underline in the native style, the accent in the drawn ones.
    var link: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable = \.accent
    /// The native interface style (its `key` already differs through `link`).
    var native = false
    /// The prose line the style sets 14pt text on (`StyleSpec.Text.readingLine`).
    var bodyLineHeight: CGFloat = MarkdownStyle.bodyLineHeight
    /// Inline code as a tinted chip, or the code face alone on the sentence's paper.
    var inlineCode: StyleSpec.InlineCode = .chip
    /// Quiet, running work is told once, by the working line under the turn; its process header stays still.
    var ink: StyleSpec.Ink = .brand
    let gutter: CGFloat = TranscriptStyle.gutterWidth
    /// The reading column's side margin, also used to tell how much slack the column has around it.
    static let gutterWidth: CGFloat = 28

    /// The revision belongs in the key: editing a custom theme keeps its id and changes its colours.
    var key: String { "\(palette.values.id)|\(palette.revision)|\(scale)|\(density)|\(column)|\(dark)|\(fonts.key)|\(styleFonts.ui),\(styleFonts.mono)|\(radii.control),\(radii.container),\(radii.card),\(radii.floating)|\(toolRun.rawValue)|\(block.rawValue),\(paper == \.bg)|\(iconPack)|\(mark == \.accent),\(link == \.accent)|\(bodyLineHeight),\(inlineCode.rawValue),\(ink.rawValue)" }

    @MainActor
    static func current(dark: Bool) -> TranscriptStyle {
        let preferences = DisplayPreferences.shared
        let native = preferences.style.backend == .native
        return TranscriptStyle(palette: ThemeStore.shared.palette, scale: preferences.textScale, density: preferences.density, column: preferences.contentWidth, dark: dark, fonts: AppearanceStore.shared.fonts, styleFonts: preferences.style.fonts, radii: preferences.style.radii, toolRun: preferences.style.toolRun, block: preferences.style.block, paper: preferences.style.window == .flat ? \.bgElevated : \.bg, iconPack: IconPack.shared.effective, mark: preferences.style.ink == .quiet ? \.fg2 : Palette.markRole, link: native ? \.fg : \.accent, native: native, bodyLineHeight: preferences.style.text.readingLine, inlineCode: preferences.style.inlineCode, ink: preferences.style.ink)
    }

    func s(_ size: CGFloat) -> CGFloat { ladderTextSize(size) * scale }

    /// A content block's tint; outlined blocks leave the paper bare.
    var blockFill: NSColor? { block == .filled ? color(\.bgSubtle) : nil }

    /// An outlined content block's hairline.
    var blockStroke: NSColor? { block == .outlined ? color(\.line) : nil }

    func blockBox(radius: CGFloat) -> BoxSpec { BoxSpec(fill: blockFill, stroke: blockStroke, radius: radius) }

    /// A one-line process row (a tool, a run, a thought): it grows with the text in it, so a larger
    /// text scale keeps the same air rather than crowding the line.
    var row: CGFloat { (24 * scale).rounded() }

    var rhythm: TranscriptRhythm { TranscriptRhythm(style: self) }

    func color(_ role: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable, _ opacity: CGFloat = 1) -> NSColor {
        palette.nsColor(role, opacity: opacity)
    }

    /// The role's colour in this appearance as `#rrggbb` (for pages that take a colour).
    func hex(_ role: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable) -> String {
        let rgba = (dark ? palette.values.dark : palette.values.light)[keyPath: role]
        return String(format: "#%02x%02x%02x", Int(rgba.red * 255), Int(rgba.green * 255), Int(rgba.blue * 255))
    }

    func font(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        RiffetFace.nsFont(size: s(size), weight: weight, mono: false, plugin: fonts, style: styleFonts) ?? .systemFont(ofSize: s(size), weight: weight)
    }

    func mono(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        RiffetFace.nsFont(size: s(size), weight: weight, mono: true, plugin: fonts, style: styleFonts) ?? .monospacedSystemFont(ofSize: s(size), weight: weight)
    }

    func italic(_ font: NSFont) -> NSFont {
        font.riffetItalic
    }

    /// The extra space between lines that puts a [size]pt face on a [lineHeight]pt line.
    func lineGap(size: CGFloat, lineHeight: CGFloat) -> CGFloat {
        let font = self.font(size)
        return max(0, s(lineHeight) - (font.ascender - font.descender + font.leading))
    }
}

/// What meets above a transcript row, which decides the space there (the web's `gap()` in
/// `transcriptRows.ts`). Worked out where rows are listed, since it depends on the row before.
enum RowGap: Equatable, Sendable {
    /// The first row of the history.
    case first
    /// A new turn starts: a user message, or the notices that woke the agent.
    case turn
    /// What answers a user message, under it.
    case answer
    /// Prose next to a one-line row (a tool, a process block's header), either way round.
    case proseRow
    /// Two one-line rows.
    case tight
    /// Any other two blocks of one turn.
    case block

    /// The gap between [previous] and [row]; [compact] is the shared rule for two one-line rows.
    static func between(_ previous: (any TimelineRow)?, _ row: any TimelineRow, compact: Bool) -> RowGap {
        guard let previous else { return .first }
        if row is TimelineRowTrigger || (row as? TimelineRowSingle)?.item is TimelineItemUser { return .turn }
        if (previous as? TimelineRowSingle)?.item is TimelineItemUser { return .answer }
        if compact { return .tight }
        if isProse(previous) != isProse(row), isLine(previous) || isLine(row) { return .proseRow }
        return .block
    }

    private static func isProse(_ row: any TimelineRow) -> Bool {
        guard let item = (row as? TimelineRowSingle)?.item else { return false }
        return item is TimelineItemAssistant || (item as? TimelineItemThought)?.channel == .narration
    }

    /// Rows whose top or bottom edge is a one-line row, centred in its height.
    private static func isLine(_ row: any TimelineRow) -> Bool {
        if row is TimelineRowProcess { return true }
        guard let item = (row as? TimelineRowSingle)?.item else { return false }
        if let thought = item as? TimelineItemThought { return thought.channel != .narration }
        return item is TimelineItemTool || item is TimelineItemActivity || item is TimelineItemTaskNotification || item is TimelineItemStatus
    }
}

/**
 * The transcript's vertical rhythm, in one place: every space between two things in a conversation
 * is read from here, never written where the thing is laid out. The steps are the web's
 * `--timeline-gap-*` (turn 40, answer 24, block 16), scaled by 会话间距.
 *
 * A text box stops at its glyphs (TextKit puts no lead above the first line nor under the last),
 * while a row centres its one line in its height. Spaces between the two are worked out from the
 * font so they read the same as the space between two paragraphs, measured line centre to line centre.
 */
struct TranscriptRhythm {
    let style: TranscriptStyle

    var first: CGFloat { 24 }
    var turn: CGFloat { 40 * style.density }
    var answer: CGFloat { 24 * style.density }
    var block: CGFloat { 16 * style.density }
    /// Rows are already spaced by their own height.
    var tight: CGFloat { 0 }

    /// The height of one body line's glyphs, without the lead TextKit adds under it.
    var bodyLineBox: CGFloat {
        let font = style.font(MarkdownStyle.bodySize)
        return font.ascender - font.descender + font.leading
    }

    /// Between two paragraphs of prose: the gap a paragraph break leaves inside one text.
    var prose: CGFloat { MarkdownStyle.blockGap + style.lineGap(size: MarkdownStyle.bodySize, lineHeight: style.bodyLineHeight) }

    /// Between prose and a row, either way round: the row's centre sits a paragraph's distance
    /// from the centre of the nearest line, as the next paragraph's first line would.
    var proseRow: CGFloat { (bodyLineBox / 2 + prose - style.row / 2).rounded() }

    /// From the last line of an answer to its footer (time, copy, actions): the footer's 20-point
    /// slot centres a 12-point line, so the gap reads as a paragraph break, not as a line of the text.
    var footer: CGFloat { 14 }

    /// What a user message keeps under its bubble for its hover footer. It counts towards the space
    /// to the answer, which is measured from the bubble.
    var userFooter: CGFloat { 26 }

    func gap(_ kind: RowGap) -> CGFloat {
        switch kind {
        case .first: first
        case .turn: turn
        case .answer: max(0, answer - userFooter)
        case .proseRow: proseRow
        case .tight: tight
        case .block: block
        }
    }
}

/**
 * The Markdown reading scale, in one place.
 *
 * The values follow the shape of the open-source GitHub scales (MarkdownUI's `.gitHub` theme,
 * Primer's type tokens) shrunk to this transcript's density: a 14pt body instead of 16, block
 * spacing in multiples of one gap, heading space-before roughly twice the paragraph gap. The
 * prose, list and code measurements in `TranscriptText` and `TranscriptLayout` read from here, so
 * the prose path and the block path cannot drift into two typographies. Sizes are design points
 * at scale 1: fonts scale through `TranscriptStyle.font`/`mono`, spacing does not (as before).
 */
enum MarkdownStyle {
    static let bodySize: CGFloat = 14
    /// 1.8 of the body: Chinese text needs more lead than Latin to keep its lines apart.
    static let bodyLineHeight: CGFloat = 25
    /// Space between two prose blocks; also the gap the layout puts around a non-prose block.
    static let blockGap: CGFloat = 14
    /// The same gap in a compact surface (a card, a rendered code fence).
    static let compactBlockGap: CGFloat = 6
    static let listItemGap: CGFloat = 6
    /// Space between the blocks inside one list item (a paragraph and its code block, say):
    /// larger than the item gap, so a sub-block reads as belonging to the item above it.
    static let listBlockGap: CGFloat = 10
    /// Added to the block gap before a heading inside a prose run, and the whole top space when
    /// a heading follows a non-prose block: both sum to the same space before a heading.
    static let headingGapExtra: CGFloat = 10
    static var headingBlockTop: CGFloat { headingGapExtra }
    /// The marker column the two list layouts share: the bullet centres at 8pt (numbers end at
    /// 20pt), the text hangs 6pt after the marker box, at 22pt (26pt for numbers).
    static let unorderedMarkerBox: CGFloat = 16
    static let orderedMarkerBox: CGFloat = 20
    static let unorderedMarkerCentre: CGFloat = 8
    static let orderedMarkerRight: CGFloat = 20
    static let markerTextGap: CGFloat = 6
    static var unorderedContent: CGFloat { unorderedMarkerBox + markerTextGap }
    static var orderedContent: CGFloat { orderedMarkerBox + markerTextGap }
    static let quoteInset: CGFloat = 14
    static let inlineCodeSize: CGFloat = 12.5
    /// Inline code without its chip (`StyleSpec.InlineCode.plain`): 0.86 of the body.
    static let plainInlineCodeSize: CGFloat = 12
    static let codeSize: CGFloat = 12.5
    static let codeHeaderHeight: CGFloat = 28
    static let codeBodyInset: CGFloat = 11

    /// `(size, lineHeight)` for a heading level; below level 3 the size reaches the body's and
    /// the weight and the space before it carry the hierarchy.
    static func heading(_ level: Int) -> (CGFloat, CGFloat) {
        level <= 1 ? (20, 27) : level == 2 ? (17, 25) : level == 3 ? (15, 23) : (14, 23)
    }
}

/// Things a layout may have to wait for — a formula's snapshot, an image's size, code colours — each
/// named by a token. A layout lists the tokens it laid out without; when one is ready the
/// transcript lays those rows out again.
enum TranscriptResources {
    static let notification = Notification.Name("riffet.transcript.resource")

    static func ready(_ token: String) {
        let post = { NotificationCenter.default.post(name: notification, object: nil, userInfo: ["token": token]) }
        if Thread.isMainThread { post() } else { DispatchQueue.main.async(execute: post) }
    }
}

/// Display sizes of transcript images already loaded, readable from the layout queue, so a row
/// that shows a known image is laid out at its final height on the first pass.
enum ImageSizes {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var sizes: [String: CGSize] = [:]
    /// Sizes of images loaded in an earlier launch (or earlier in this one): a transcript opened
    /// again reserves them before the image is read. Kept under a hash of the key: keys hold URLs
    /// (with their query strings), paths and attachment ids, which the caches folder should not.
    private static let memory: SizeMemory = {
        // The first version kept the keys themselves.
        SizeMemory.remove(name: "image-sizes")
        return SizeMemory(name: "image-sizes-hashed", limit: 6000)
    }()

    static func key(_ source: TimelineImageSource, projectId: String?) -> String {
        switch source {
        case let .attachment(id): "a|\(id)"
        case let .projectFile(project, path): "p|\(project)|\(path)"
        case let .url(raw): raw.count > 256 ? "uh|\(projectId ?? "")|\(raw.hashValue)" : "u|\(projectId ?? "")|\(raw)"
        case let .local(data): "l|\(data.hashValue)"
        }
    }

    /// `hashValue` changes between launches: those keys mean nothing to the next one.
    private static func remembers(_ key: String) -> Bool { !key.hasPrefix("uh|") && !key.hasPrefix("l|") }

    /// The size of an image loaded in this launch; `.zero` when it could not be read.
    static func size(_ key: String) -> CGSize? {
        lock.lock()
        defer { lock.unlock() }
        return sizes[key]
    }

    /// The size the image had when it was last loaded, in this launch or an earlier one; it may have
    /// changed since (a project file), so a layout that uses it still waits for the image.
    static func remembered(_ key: String) -> CGSize? {
        guard remembers(key), let value = memory.value(stableHash(key)), value.count >= 2, value[0] > 0, value[1] > 0 else { return nil }
        return CGSize(width: value[0], height: value[1])
    }

    static func store(_ key: String, _ size: CGSize) {
        lock.lock()
        let known = sizes[key] != nil
        sizes[key] = size
        lock.unlock()
        if size.width > 0, size.height > 0, remembers(key) { memory.store(stableHash(key), [Double(size.width), Double(size.height)]) }
        if !known { TranscriptResources.ready("image:\(key)") }
    }

    static func fail(_ key: String) {
        store(key, .zero)
    }
}

/// Measured sizes (images, diagrams, formulas) kept across launches in the caches folder, so a
/// conversation opened again lays out at its final heights before anything has loaded. Readable
/// from any thread; failures are never stored, so a passing network error does not outlive itself.
final class SizeMemory: @unchecked Sendable {
    private let lock = NSLock()
    private let file: URL?
    private let limit: Int
    /// Each value ends with the order it was stored in, which decides what goes when full.
    private var values: [String: [Double]] = [:]
    private var loaded = false
    private var counter: Double = 0
    private var saving = false
    private static let queue = DispatchQueue(label: "io.github.riffable.transcript.sizes", qos: .utility)

    init(name: String, limit: Int) {
        file = Self.location(name)
        self.limit = limit
    }

    private static func location(_ name: String) -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Riffet", isDirectory: true)
            .appendingPathComponent("\(name).plist")
    }

    /// Deletes a memory no longer used, off the calling thread.
    static func remove(name: String) {
        guard let file = location(name) else { return }
        queue.async { try? FileManager.default.removeItem(at: file) }
    }

    func value(_ key: String) -> [Double]? {
        lock.lock()
        defer { lock.unlock() }
        loadIfNeeded()
        guard let stored = values[key], stored.count > 1 else { return nil }
        return Array(stored.dropLast())
    }

    func store(_ key: String, _ value: [Double]) {
        lock.lock()
        defer { lock.unlock() }
        loadIfNeeded()
        if let stored = values[key], Array(stored.dropLast()) == value { return }
        counter += 1
        values[key] = value + [counter]
        if values.count > limit {
            // The most recently measured three quarters stay.
            let kept = values.sorted { ($0.value.last ?? 0) > ($1.value.last ?? 0) }.prefix(limit * 3 / 4)
            values = Dictionary(uniqueKeysWithValues: kept.map { ($0.key, $0.value) })
        }
        scheduleSave()
    }

    /// Called with the lock held.
    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        guard let file, let data = try? Data(contentsOf: file),
              let stored = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: [Double]] else { return }
        values = stored
        counter = stored.values.compactMap(\.last).max() ?? 0
    }

    /// Called with the lock held; writes a moment later, once for a burst of stores.
    private func scheduleSave() {
        guard !saving, file != nil else { return }
        saving = true
        Self.queue.asyncAfter(deadline: .now() + 2) { [self] in
            lock.lock()
            let snapshot = values
            saving = false
            lock.unlock()
            guard let file, let data = try? PropertyListSerialization.data(fromPropertyList: snapshot, format: .binary, options: 0) else { return }
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
        }
    }
}

/// A hash of [string] that is the same in every launch (FNV-1a over its UTF-8, with its length),
/// unlike `hashValue`: keys of sizes kept across launches.
func stableHash(_ string: String) -> String {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    var copy = string
    let count = copy.withUTF8 { bytes -> Int in
        for byte in bytes { hash = (hash ^ UInt64(byte)) &* 0x0000_0100_0000_01b3 }
        return bytes.count
    }
    return "\(String(hash, radix: 36))-\(count)"
}

/// Metadata recovered for id-only receipts. Immutable values are safe on the layout queue.
enum TranscriptAttachments {
    struct Metadata {
        let name: String
        let mimeType: String
        let size: Int64
    }
    private static let lock = NSLock()
    nonisolated(unsafe) private static var values: [String: Metadata] = [:]

    static func metadata(_ id: String) -> Metadata? {
        lock.lock()
        defer { lock.unlock() }
        return values[id]
    }

    static func store(_ id: String, name: String, mimeType: String, size: Int64) {
        lock.lock()
        values[id] = Metadata(name: name, mimeType: mimeType, size: size)
        lock.unlock()
    }
}
