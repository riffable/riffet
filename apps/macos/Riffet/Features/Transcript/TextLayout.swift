#if os(macOS)
import AppKit
#else
import UIKit
#endif

extension NSAttributedString.Key {
    /// What an attachment run copies as (a formula's TeX, a checkbox's mark).
    static let riffetPlain = NSAttributedString.Key("riffet.plain")
    /// A top-level answer heading's rank, retained while its paragraphs share one text layout.
    static let riffetHeading = NSAttributedString.Key("riffet.heading")
}

/// Text laid out once with TextKit 1, on whichever thread builds it, and afterwards only drawn.
/// Nothing re-lays it out: a different width or content is a different `TextLayout`.
/// Compiled into the iPhone app too (its transcript prose, `TranscriptProse`); the views below are Mac only.
final class TextLayout: @unchecked Sendable {
    let storage: NSTextStorage
    let manager: NSLayoutManager
    let container: NSTextContainer
    let size: CGSize

    var string: String { storage.string }
    var length: Int { storage.length }

    init(_ text: NSAttributedString, width: CGFloat, wraps: Bool = true, maximumLines: Int = 0) {
        storage = NSTextStorage(attributedString: text)
        let manager = NSLayoutManager()
        #if os(macOS)
        manager.backgroundLayoutEnabled = false
        #endif
        manager.allowsNonContiguousLayout = false
        #if os(macOS)
        manager.delegate = OwnLinkStyle.shared
        #endif
        self.manager = manager
        container = NSTextContainer(size: CGSize(width: wraps ? max(1, width) : 1_000_000, height: 10_000_000))
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = maximumLines
        if maximumLines > 0 { container.lineBreakMode = .byTruncatingTail }
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        size = CGSize(width: ceil(used.width), height: ceil(used.height))
    }

    /// Keep TextKit's selection widths, including selected newlines, without painting the space
    /// between lines or paragraphs. Used rects exclude paragraph spacing but include line spacing.
    func enumerateHighlightRects(forGlyphRange range: NSRange, using body: @escaping (CGRect) -> Void) {
        let end = NSMaxRange(manager.glyphRange(for: container))
        let hasExtraLine = manager.extraLineFragmentTextContainer === container
        manager.enumerateLineFragments(forGlyphRange: range) { [self] _, used, _, lineGlyphs, _ in
            let shown = NSIntersectionRange(range, lineGlyphs)
            guard shown.length > 0 else { return }
            let index = manager.characterIndexForGlyph(at: lineGlyphs.location)
            let paragraph = storage.attribute(.paragraphStyle, at: index, effectiveRange: nil) as? NSParagraphStyle
            // TextKit omits line spacing on the last laid-out line unless a trailing line break
            // creates an extra line fragment. Use the container's range, which also handles truncation.
            let spacing = NSMaxRange(lineGlyphs) < end || hasExtraLine ? max(0, paragraph?.lineSpacing ?? 0) : 0
            manager.enumerateEnclosingRects(forGlyphRange: shown, withinSelectedGlyphRange: range, in: container) { rect, _ in
                let top = max(rect.minY, used.minY)
                let bottom = min(rect.maxY, used.maxY - spacing)
                guard bottom > top else { return }
                body(CGRect(x: rect.minX, y: top, width: rect.width, height: bottom - top))
            }
        }
    }

    /// The selection's shape: one block per paragraph, hugging the text. Lines of a paragraph join
    /// across their line spacing instead of reading as stripes; each line stops where its text does
    /// (plus a sliver for a selected line break) rather than at the container's edge; the space
    /// between paragraphs stays open, so the selection keeps to the text as a highlight does.
    func enumerateSelectionRects(forGlyphRange range: NSRange, using body: (CGRect) -> Void) {
        struct Line { let rect: CGRect; let used: CGRect; let shown: NSRange; let glyphs: NSRange; let paragraph: NSRange }
        let text = storage.string as NSString
        var lines: [Line] = []
        manager.enumerateLineFragments(forGlyphRange: range) { [self] rect, used, _, lineGlyphs, _ in
            let shown = NSIntersectionRange(range, lineGlyphs)
            guard shown.length > 0 else { return }
            let first = manager.characterIndexForGlyph(at: lineGlyphs.location)
            lines.append(Line(rect: rect, used: used, shown: shown, glyphs: lineGlyphs,
                              paragraph: text.paragraphRange(for: NSRange(location: min(first, max(0, text.length - 1)), length: 0))))
        }
        let end = NSMaxRange(manager.glyphRange(for: container))
        let hasExtraLine = manager.extraLineFragmentTextContainer === container
        let lineBreak: CGFloat = 4
        for (index, line) in lines.enumerated() {
            var minX = CGFloat.greatestFiniteMagnitude
            var maxX: CGFloat = 0
            manager.enumerateEnclosingRects(forGlyphRange: line.shown, withinSelectedGlyphRange: range, in: container) { rect, _ in
                minX = min(minX, rect.minX)
                maxX = max(maxX, rect.maxX)
            }
            guard maxX > minX else { continue }
            maxX = min(maxX, max(line.used.maxX, minX) + lineBreak)
            let joinsAbove = index > 0 && lines[index - 1].paragraph == line.paragraph
            let joinsBelow = index + 1 < lines.count && lines[index + 1].paragraph == line.paragraph
            let top = joinsAbove ? line.rect.minY : line.used.minY
            let bottom: CGFloat
            if joinsBelow {
                bottom = lines[index + 1].rect.minY
            } else {
                let index = manager.characterIndexForGlyph(at: line.glyphs.location)
                let style = storage.attribute(.paragraphStyle, at: index, effectiveRange: nil) as? NSParagraphStyle
                let spacing = NSMaxRange(line.glyphs) < end || hasExtraLine ? max(0, style?.lineSpacing ?? 0) : 0
                bottom = line.used.maxY - spacing
            }
            guard bottom > top else { continue }
            body(CGRect(x: minX, y: top, width: maxX - minX, height: bottom - top))
        }
    }

    /// The text of [range] as it copies: attachments become what they stand for.
    func plain(_ range: NSRange) -> String {
        guard range.length > 0, NSMaxRange(range) <= storage.length else { return "" }
        var result = ""
        storage.enumerateAttributes(in: range) { attributes, sub, _ in
            if attributes[.attachment] != nil {
                result += attributes[.riffetPlain] as? String ?? ""
            } else {
                result += (storage.string as NSString).substring(with: sub)
            }
        }
        return result
    }
}

#if os(macOS)
/// Outside a text view TextKit still paints every `.link` run in the system link blue with an
/// underline, over the run's own colour. Links here style themselves (the accent, a file mention in body
/// colour), so the drawing-time attributes are dropped.
private final class OwnLinkStyle: NSObject, NSLayoutManagerDelegate, @unchecked Sendable {
    static let shared = OwnLinkStyle()

    func layoutManager(_ layoutManager: NSLayoutManager, shouldUseTemporaryAttributes attrs: [NSAttributedString.Key: Any] = [:], forDrawingToScreen toScreen: Bool, atCharacterIndex charIndex: Int, effectiveRange effectiveCharRange: NSRangePointer?) -> [NSAttributedString.Key: Any]? {
        [:]
    }
}

/// A `TextLayout` on screen: drawn straight from its glyphs, selectable with the mouse (double-click
/// a word, triple-click a paragraph, shift-click to extend), ⌘C and ⌘A, links that open on click,
/// and the message menu on right-click. One view per text block; selection stays inside it.
final class TextLayoutView: NSView {
    /// The view holding a selection; selecting in another clears it.
    private static weak var selecting: TextLayoutView?
    static var selectedView: TextLayoutView? {
        guard let view = selecting, view.selection.length > 0 else { return nil }
        return view
    }

    var layout: TextLayout? {
        didSet {
            guard layout !== oldValue else { return }
            // A row laid out again hands over equal text for the blocks that did not change.
            if let old = oldValue, let new = layout, old.size == new.size, old.length == new.length, old.storage.isEqual(to: new.storage) {
                layout = old
                return
            }
            selection = NSRange(location: 0, length: 0)
            highlights = []
            needsDisplay = true
            setAccessibilityValue(layout?.string)
        }
    }
    /// Saved spans (收藏) drawn behind the text like a selection; the text itself is not touched.
    var highlights: [TextHighlight] = [] {
        didSet { if highlights != oldValue { needsDisplay = true } }
    }
    /// The character under the last right-click, for a menu that acts on the highlight there.
    private(set) var menuIndex: Int?
    /// The link actually under the last right-click, rather than the nearest character's link.
    private(set) var menuLink: URL?
    var selectable = true
    var onLink: ((URL) -> Void)?
    var menuProvider: ((TextLayoutView) -> NSMenu?)?

    private(set) var selection = NSRange(location: 0, length: 0)
    private var anchor = 0
    private var dragged = false
    private var downPoint: NSPoint?

    override init(frame: NSRect) {
        super.init(frame: frame)
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { selectable }
    override var isOpaque: Bool { false }

    var selectedText: String { layout?.plain(selection) ?? "" }

    override func draw(_ dirtyRect: NSRect) {
        guard let layout else { return }
        let manager = layout.manager
        let glyphs = manager.glyphRange(forBoundingRect: dirtyRect, in: layout.container)
        guard glyphs.length > 0 else { return }
        manager.drawBackground(forGlyphRange: glyphs, at: .zero)
        for highlight in highlights where NSMaxRange(highlight.range) <= layout.length {
            (highlight.find ? NSColor.findHighlightColor : highlight.color.fill).setFill()
            let marked = manager.glyphRange(forCharacterRange: highlight.range, actualCharacterRange: nil)
            layout.enumerateHighlightRects(forGlyphRange: marked) { rect in
                NSBezierPath(roundedRect: rect, xRadius: 3, yRadius: 3).fill()
            }
        }
        if selection.length > 0 {
            let focused = window?.firstResponder === self && window?.isKeyWindow == true
            (focused ? NSColor.selectedTextBackgroundColor : NSColor.unemphasizedSelectedTextBackgroundColor).setFill()
            let selected = manager.glyphRange(forCharacterRange: selection, actualCharacterRange: nil)
            layout.enumerateSelectionRects(forGlyphRange: selected) { rect in
                rect.fill()
            }
        }
        manager.drawGlyphs(forGlyphRange: glyphs, at: .zero)
    }

    // MARK: Mouse

    private func characterIndex(at point: NSPoint) -> Int {
        guard let layout, layout.length > 0 else { return 0 }
        if point.y < 0 { return 0 }
        if point.y > layout.size.height { return layout.length }
        var fraction: CGFloat = 0
        let glyph = layout.manager.glyphIndex(for: point, in: layout.container, fractionOfDistanceThroughGlyph: &fraction)
        var index = layout.manager.characterIndexForGlyph(at: glyph)
        if fraction > 0.5 { index = NSMaxRange((layout.string as NSString).rangeOfComposedCharacterSequence(at: min(index, layout.length - 1))) }
        return min(max(0, index), layout.length)
    }

    private func link(at point: NSPoint) -> URL? {
        guard let layout, layout.length > 0 else { return nil }
        let glyph = layout.manager.glyphIndex(for: point, in: layout.container)
        let rect = layout.manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: layout.container)
        guard rect.insetBy(dx: -1, dy: -2).contains(point) else { return nil }
        let index = layout.manager.characterIndexForGlyph(at: glyph)
        guard index < layout.length else { return nil }
        let value = layout.storage.attribute(.link, at: index, effectiveRange: nil)
        return value as? URL ?? (value as? String).flatMap(URL.init(string:))
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        downPoint = point
        dragged = false
        guard selectable, let layout else { return }
        window?.makeFirstResponder(self)
        claimSelection()
        let index = characterIndex(at: point)
        switch event.clickCount {
        case 2:
            let range = layout.storage.doubleClick(at: min(index, max(0, layout.length - 1)))
            anchor = range.location
            selection = range
        case 3:
            let range = (layout.string as NSString).paragraphRange(for: NSRange(location: min(index, max(0, layout.length - 1)), length: 0))
            anchor = range.location
            selection = range
        default:
            if event.modifierFlags.contains(.shift), selection.length > 0 || anchor > 0 {
                selection = NSRange(location: min(anchor, index), length: abs(index - anchor))
            } else {
                anchor = index
                selection = NSRange(location: index, length: 0)
            }
        }
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard selectable, layout != nil else { return }
        let point = convert(event.locationInWindow, from: nil)
        if let downPoint, hypot(point.x - downPoint.x, point.y - downPoint.y) > 2 { dragged = true }
        guard dragged else { return }
        let index = characterIndex(at: point)
        selection = NSRange(location: min(anchor, index), length: abs(index - anchor))
        needsDisplay = true
        autoscroll(with: event)
    }

    override func mouseUp(with event: NSEvent) {
        defer { downPoint = nil }
        guard !dragged, event.clickCount <= 1, selection.length == 0 else { return }
        let point = convert(event.locationInWindow, from: nil)
        if let url = link(at: point) { onLink?(url) }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        menuIndex = layout == nil ? nil : characterIndex(at: point)
        menuLink = link(at: point)
        return menuProvider?(self) ?? super.menu(for: event)
    }

    /// The saved span under the last right-click.
    var highlightAtMenu: TextHighlight? {
        guard let menuIndex else { return nil }
        return highlights.last { !$0.find && (NSLocationInRange(menuIndex, $0.range) || (menuIndex == NSMaxRange($0.range) && menuIndex > $0.range.location)) }
    }

    /// The cursor for [point]: a pointing hand over a link, an I-beam over selectable text.
    func cursor(at point: NSPoint) -> NSCursor {
        if link(at: point) != nil { return .pointingHand }
        return selectable ? .iBeam : .arrow
    }

    // MARK: Selection and copy

    private func claimSelection() {
        if let previous = Self.selecting, previous !== self { previous.clearSelection() }
        Self.selecting = self
    }

    func clearSelection() {
        guard selection.length > 0 else { return }
        selection = NSRange(location: selection.location, length: 0)
        needsDisplay = true
    }

    override func becomeFirstResponder() -> Bool {
        needsDisplay = true
        return true
    }

    override func resignFirstResponder() -> Bool {
        needsDisplay = true
        return true
    }

    @objc func copy(_ sender: Any?) {
        let text = selectedText
        guard !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    override func selectAll(_ sender: Any?) {
        guard let layout, selectable else { return }
        claimSelection()
        anchor = 0
        selection = NSRange(location: 0, length: layout.length)
        needsDisplay = true
    }

}

extension TextLayoutView: NSMenuItemValidation {
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(copy(_:)) { return selection.length > 0 }
        if item.action == #selector(selectAll(_:)) { return selectable && layout != nil }
        return true
    }
}

/// A block's own viewport inside a transcript row: the system's scrolling, with its velocity,
/// momentum, elastic edges and overlay scrollers. A gesture belongs to whichever view it began on:
/// the block when it can move that way, the transcript otherwise, so a block already at its edge
/// never holds the transcript still and a block's gesture never carries on into the transcript.
final class ScrollStrip: NSScrollView { // perf-lint: allow the one scroll view inside rows; CursorGuard drops the repeated cursor sets its scrollers cause
    /// Who the current gesture belongs to: nil before one starts, true for the block.
    private var mine: Bool?

    override init(frame: NSRect) {
        super.init(frame: frame)
        contentView = FlippedClip()
        drawsBackground = false
        hasVerticalScroller = true
        hasHorizontalScroller = true
        autohidesScrollers = true
        scrollerStyle = .overlay
        usesPredominantAxisScrolling = true
        wantsLayer = true
        layer?.masksToBounds = true
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Shows the end of the content (a command's latest output).
    func scrollToEnd() {
        guard let document = documentView else { return }
        contentView.scroll(to: NSPoint(x: 0, y: max(0, document.frame.height - contentView.bounds.height)))
        reflectScrolledClipView(contentView)
    }

    func scrollToStart() {
        contentView.scroll(to: .zero)
        reflectScrolledClipView(contentView)
    }

    override func scrollWheel(with event: NSEvent) {
        let wheel = event.phase.isEmpty && event.momentumPhase.isEmpty
        if wheel || event.phase.contains(.began) { mine = canScroll(dx: event.scrollingDeltaX, dy: event.scrollingDeltaY) }
        let owner = mine ?? (event.phase.contains(.mayBegin) && canScroll(dx: 0, dy: 0))
        if wheel || event.momentumPhase.contains(.ended) || event.momentumPhase.contains(.cancelled) { mine = nil }
        if owner { super.scrollWheel(with: event) } else { nextResponder?.scrollWheel(with: event) }
    }

    /// Whether the content can move the way [dx], [dy] push it; both zero asks whether it can move at all.
    private func canScroll(dx: CGFloat, dy: CGFloat) -> Bool {
        guard let document = documentView else { return false }
        let shown = contentView.bounds
        let size = document.frame.size
        let room = (up: shown.minY > 0.5, down: shown.maxY < size.height - 0.5, left: shown.minX > 0.5, right: shown.maxX < size.width - 0.5)
        if dx == 0, dy == 0 { return room.up || room.down || room.left || room.right }
        if abs(dy) >= abs(dx) { return dy > 0 ? room.up : room.down }
        return dx > 0 ? room.left : room.right
    }
}

final class FlippedClip: NSClipView {
    override var isFlipped: Bool { true }
}

/// A plain flipped container.
class FlippedView: NSView {
    override var isFlipped: Bool { true }
}
#endif
