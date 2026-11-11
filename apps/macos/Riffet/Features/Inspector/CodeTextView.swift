import AppKit
import SwiftUI

/// A read-only source file in an `NSTextView`: line numbers in a gutter that cite a line when
/// clicked, the web's syntax colors, and a jump to a line that flashes it. AppKit lays out only
/// what is on screen, so a large file scrolls as smoothly as a small one.
struct CodeTextView: NSViewRepresentable {
    let text: String
    let language: String?
    let palette: Palette
    var fontSize: CGFloat = 12
    /// The line to scroll to and flash; the token repeats a jump to the same line.
    var target: (line: Int, token: Int)?
    var onLine: ((Int, String) -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Fills what it is offered; the document's width must never become the panel's.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 320, height: proposal.height ?? 320)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.clipsToBounds = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        guard let textView = scroll.documentView as? NSTextView else { return scroll }
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 6, height: 8)
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.autoresizingMask = []
        textView.layoutManager?.allowsNonContiguousLayout = true
        let ruler = LineNumberRuler(textView: textView)
        scroll.verticalRulerView = ruler
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = true
        context.coordinator.ruler = ruler
        context.coordinator.textView = textView
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        guard let textView = coordinator.textView, let ruler = coordinator.ruler else { return }
        ruler.palette = palette
        ruler.onLine = onLine
        ruler.fontSize = fontSize
        let styleFonts = DisplayPreferences.shared.style.fonts
        let key = "\(language ?? "")|\(fontSize)|\(palette.values.id)|\(palette.revision)|\(AppearanceFonts.current.key)|\(styleFonts)"
        if coordinator.applied != key || coordinator.appliedText != text {
            coordinator.applied = key
            coordinator.appliedText = text
            // Colours, paragraph style and line starts are built off the main thread; a file of
            // thousands of lines took the main thread for a noticeable moment.
            textView.textStorage?.setAttributedString(NSAttributedString())
            let text = text, language = language, palette = palette, fontSize = fontSize
            coordinator.build?.cancel()
            coordinator.build = Task { @MainActor in
                let cached = language.flatMap { CodeHighlighter.shared.cached(text, language: $0) }
                let first = await Task.detached(priority: .userInitiated) { Self.prepare(text, runs: cached, palette: palette, fontSize: fontSize, styleFonts: styleFonts) }.value
                guard !Task.isCancelled, coordinator.applied == key, coordinator.appliedText == text else { return }
                textView.textStorage?.setAttributedString(first.text)
                ruler.reset(text: text, starts: first.starts)
                if let target = coordinator.pendingTarget { coordinator.pendingTarget = nil; coordinator.jump(to: target, palette: palette) }
                guard let language, cached == nil, text.utf16.count <= CodeHighlighter.maxLength,
                      let runs = await CodeHighlighter.shared.runs(text, language: language), !Task.isCancelled, coordinator.applied == key, coordinator.appliedText == text else { return }
                let colored = await Task.detached(priority: .userInitiated) { Self.prepare(text, runs: runs, palette: palette, fontSize: fontSize, styleFonts: styleFonts, starts: first.starts) }.value
                guard !Task.isCancelled, coordinator.applied == key, coordinator.appliedText == text else { return }
                textView.textStorage?.setAttributedString(colored.text)
            }
        }
        if let target, coordinator.targetToken != target.token {
            coordinator.targetToken = target.token
            if textView.textStorage?.length == 0, !text.isEmpty {
                coordinator.pendingTarget = target.line
            } else {
                DispatchQueue.main.async { coordinator.jump(to: target.line, palette: palette) }
            }
        }
    }

    /// The styled text and where each line starts, built on any thread.
    nonisolated static func prepare(_ text: String, runs: [CodeHighlighter.Run]?, palette: Palette, fontSize: CGFloat, styleFonts: StyleSpec.Fonts, starts known: [Int]? = nil) -> (text: NSAttributedString, starts: [Int]) {
        let font = RiffetFace.nsFont(size: fontSize, mono: true, plugin: AppearanceFonts.current, style: styleFonts) ?? NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        let italic = font.riffetItalic
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineHeightMultiple = 1.25
        let base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: palette.nsColor(\.fg), .paragraphStyle: paragraph]
        let value: NSMutableAttributedString
        if let runs {
            value = NSMutableAttributedString()
            value.beginEditing()
            for run in runs {
                var attributes = base
                switch run.token {
                case .comment: attributes[.foregroundColor] = palette.nsColor(\.fg3); attributes[.font] = italic
                case .punctuation: attributes[.foregroundColor] = palette.nsColor(\.fg3)
                case .tag: attributes[.foregroundColor] = palette.nsColor(\.danger)
                case .constant: attributes[.foregroundColor] = palette.nsColor(\.warning)
                case .string: attributes[.foregroundColor] = palette.nsColor(\.success)
                case .keyword: attributes[.foregroundColor] = palette.nsColor(\.accent)
                case .function: attributes[.foregroundColor] = palette.nsColor(\.accentHover)
                case .variable: attributes[.foregroundColor] = palette.nsColor(\.fg2)
                case nil: break
                }
                value.append(NSAttributedString(string: run.text, attributes: attributes))
            }
            value.endEditing()
        } else {
            value = NSMutableAttributedString(string: text, attributes: base)
        }
        if let known { return (value, known) }
        let string = text as NSString
        var starts = [0]
        starts.reserveCapacity(string.length / 40 + 1)
        let length = string.length
        var index = 0
        while index < length {
            let range = string.range(of: "\n", options: .literal, range: NSRange(location: index, length: length - index))
            guard range.location != NSNotFound else { break }
            starts.append(range.location + 1)
            index = range.location + 1
        }
        return (value, starts)
    }

    final class Coordinator {
        weak var textView: NSTextView?
        weak var ruler: LineNumberRuler?
        var applied = ""
        var appliedText = ""
        var targetToken = -1
        /// A jump asked for before the text arrived.
        var pendingTarget: Int?
        var build: Task<Void, Never>?

        @MainActor
        func jump(to line: Int, palette: Palette) {
            guard let textView, let ruler, let range = ruler.range(ofLine: line) else { return }
            if let layout = textView.layoutManager, let container = textView.textContainer, let scroll = textView.enclosingScrollView {
                layout.ensureLayout(forCharacterRange: NSRange(location: 0, length: NSMaxRange(range)))
                let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
                let rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
                let clip = scroll.contentView
                clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: max(0, rect.midY + textView.textContainerInset.height - clip.bounds.height / 2)))
                scroll.reflectScrolledClipView(clip)
            }
            textView.showFindIndicator(for: range)
            ruler.flash(line: line)
        }
    }
}

/// The gutter: one number per source line, drawn for the lines on screen only.
final class LineNumberRuler: NSRulerView {
    var palette: Palette?
    var onLine: ((Int, String) -> Void)?
    var fontSize: CGFloat = 12
    private var starts: [Int] = [0]
    private var text: NSString = ""
    private var flashed: Int?

    init(textView: NSTextView) {
        super.init(scrollView: textView.enclosingScrollView, orientation: .verticalRuler)
        clientView = textView
        clipsToBounds = true
        ruleThickness = 44
        NotificationCenter.default.addObserver(self, selector: #selector(redraw), name: NSView.boundsDidChangeNotification, object: textView.enclosingScrollView?.contentView)
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func redraw() { needsDisplay = true }

    func reset(text: String, starts: [Int]) {
        self.text = text as NSString
        self.starts = starts
        let digits = max(3, String(starts.count).count)
        ruleThickness = CGFloat(digits) * fontSize * 0.62 + 18
        needsDisplay = true
    }

    func range(ofLine line: Int) -> NSRange? {
        guard line >= 1, line <= starts.count else { return nil }
        let start = starts[line - 1]
        let end = line < starts.count ? starts[line] - 1 : text.length
        return NSRange(location: start, length: max(0, end - start))
    }

    func flash(line: Int) {
        flashed = line
        needsDisplay = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
            if self?.flashed == line { self?.flashed = nil; self?.needsDisplay = true }
        }
    }

    private func line(atCharacter index: Int) -> Int {
        var low = 0, high = starts.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if starts[mid] <= index { low = mid } else { high = mid - 1 }
        }
        return low + 1
    }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let textView = clientView as? NSTextView, let layout = textView.layoutManager, let container = textView.textContainer, let palette else { return }
        palette.nsColor(\.bg).setFill()
        bounds.intersection(rect).fill()
        let visible = textView.visibleRect
        let glyphs = layout.glyphRange(forBoundingRect: visible, in: container)
        let characters = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let font = NSFont.monospacedDigitSystemFont(ofSize: fontSize - 1, weight: .regular)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: palette.nsColor(\.fg4)]
        let inset = textView.textContainerInset.height
        let offset = convert(NSPoint.zero, from: textView).y
        var line = self.line(atCharacter: characters.location)
        while line <= starts.count, starts[line - 1] <= NSMaxRange(characters) {
            let start = starts[line - 1]
            let glyphIndex = layout.glyphIndexForCharacter(at: min(start, max(0, text.length - 1)))
            var fragment = layout.lineFragmentRect(forGlyphAt: glyphIndex, effectiveRange: nil)
            if start >= text.length, text.length > 0 { fragment = layout.extraLineFragmentRect }
            let y = fragment.minY + inset + offset
            if line == flashed {
                palette.nsColor(\.accentSoft).setFill()
                NSRect(x: 0, y: y, width: bounds.width, height: fragment.height).fill()
            }
            let label = "\(line)" as NSString
            let size = label.size(withAttributes: attributes)
            label.draw(at: NSPoint(x: bounds.width - size.width - 8, y: y + (fragment.height - size.height) / 2), withAttributes: attributes)
            line += 1
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let textView = clientView as? NSTextView, let layout = textView.layoutManager, let container = textView.textContainer else { return }
        let point = textView.convert(event.locationInWindow, from: nil)
        let glyph = layout.glyphIndex(for: NSPoint(x: 0, y: point.y - textView.textContainerInset.height), in: container)
        let character = layout.characterIndexForGlyph(at: glyph)
        let number = line(atCharacter: character)
        guard let range = range(ofLine: number) else { return }
        onLine?(number, text.substring(with: range))
        flash(line: number)
    }

    override func resetCursorRects() {
        if onLine != nil { addCursorRect(bounds, cursor: .pointingHand) }
    }
}
