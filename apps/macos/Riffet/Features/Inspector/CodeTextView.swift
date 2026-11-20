import AppKit
import SwiftUI

/// A source file in an `NSTextView`, read-only until `editable`: line numbers in a gutter that cite a line when
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
    /// ⌘-click on an identifier (definition) or its context menu (definition, usages); nil turns it off.
    var onSymbol: ((CodeSymbol, CodeSymbolIntent) -> Void)?
    /// Typing changes the file; the owner keeps the edited text and passes it back as `text`.
    var editable = false
    var onChange: ((String) -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Fills what it is offered; the document's width must never become the panel's.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 320, height: proposal.height ?? 320)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.clipsToBounds = true
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude))
        layout.addTextContainer(container)
        let textView = SymbolTextView(frame: .zero, textContainer: container)
        scroll.documentView = textView
        textView.isEditable = false
        textView.isSelectable = true
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.delegate = context.coordinator
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
        textView.ruler = ruler
        context.coordinator.ruler = ruler
        context.coordinator.textView = textView
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        guard let textView = coordinator.textView, let ruler = coordinator.ruler else { return }
        ruler.palette = palette
        ruler.onLine = onLine
        textView.isEditable = editable
        coordinator.onChange = onChange
        if let symbolView = textView as? SymbolTextView {
            symbolView.onSymbol = onSymbol
            symbolView.linkColor = palette.nsColor(\.accent)
        }
        ruler.fontSize = fontSize
        let styleFonts = DisplayPreferences.shared.style.fonts
        let codeTheme = ThemeStore.shared.codeTheme
        let codeRevision = ThemeStore.shared.codeThemeRevision
        let commentItalic = (scroll.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? codeTheme.dark : codeTheme.light).commentItalic
        let key = "\(language ?? "")|\(fontSize)|\(palette.values.id)|\(palette.revision)|\(codeTheme.id)|\(codeRevision)|\(commentItalic)|\(AppearanceFonts.current.key)|\(styleFonts)"
        let codeLanguage = language, codePalette = palette, codeSize = fontSize
        coordinator.typing = Self.baseAttributes(palette: codePalette, fontSize: codeSize, styleFonts: styleFonts)
        textView.typingAttributes = coordinator.typing
        // Edits are colored again a moment after typing stops, over the same string so the caret and undo stay.
        coordinator.restyle = { [weak textView] text in
            guard let textView, let language = codeLanguage, text.utf16.count <= CodeHighlighter.maxLength,
                  let runs = await CodeHighlighter.shared.runs(text, language: language), !Task.isCancelled, textView.string == text else { return }
            let colored = await Task.detached(priority: .userInitiated) { Self.prepare(text, runs: runs, palette: codePalette, codeTheme: codeTheme, codeRevision: codeRevision, commentItalic: commentItalic, fontSize: codeSize, styleFonts: styleFonts, starts: []) }.value
            guard !Task.isCancelled, textView.string == text, let storage = textView.textStorage, storage.length == colored.text.length else { return }
            storage.beginEditing()
            colored.text.enumerateAttributes(in: NSRange(location: 0, length: colored.text.length)) { attributes, range, _ in storage.setAttributes(attributes, range: range) }
            storage.endEditing()
        }
        if coordinator.applied != key || coordinator.appliedText != text {
            coordinator.applied = key
            coordinator.appliedText = text
            coordinator.debounce?.cancel()
            textView.undoManager?.removeAllActions()
            // Colours, paragraph style and line starts are built off the main thread; a file of
            // thousands of lines took the main thread for a noticeable moment.
            textView.textStorage?.setAttributedString(NSAttributedString())
            let text = text, language = language, palette = palette, fontSize = fontSize
            coordinator.build?.cancel()
            coordinator.build = Task { @MainActor in
                let cached = language.flatMap { CodeHighlighter.shared.cached(text, language: $0) }
                let first = await Task.detached(priority: .userInitiated) { Self.prepare(text, runs: cached, palette: palette, codeTheme: codeTheme, codeRevision: codeRevision, commentItalic: commentItalic, fontSize: fontSize, styleFonts: styleFonts) }.value
                guard !Task.isCancelled, coordinator.applied == key, coordinator.appliedText == text else { return }
                textView.textStorage?.setAttributedString(first.text)
                ruler.reset(text: text, starts: first.starts)
                if let target = coordinator.pendingTarget { coordinator.pendingTarget = nil; coordinator.jump(to: target, palette: palette) }
                guard let language, cached == nil, text.utf16.count <= CodeHighlighter.maxLength,
                      let runs = await CodeHighlighter.shared.runs(text, language: language), !Task.isCancelled, coordinator.applied == key, coordinator.appliedText == text else { return }
                let colored = await Task.detached(priority: .userInitiated) { Self.prepare(text, runs: runs, palette: palette, codeTheme: codeTheme, codeRevision: codeRevision, commentItalic: commentItalic, fontSize: fontSize, styleFonts: styleFonts, starts: first.starts) }.value
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
    nonisolated static func prepare(_ text: String, runs: [CodeHighlighter.Run]?, palette: Palette, codeTheme: RiffetCodeThemeValues = RiffetCodeThemeCatalog.all[0], codeRevision: String = "builtin", commentItalic: Bool = true, fontSize: CGFloat, styleFonts: StyleSpec.Fonts, starts known: [Int]? = nil) -> (text: NSAttributedString, starts: [Int]) {
        let base = baseAttributes(palette: palette, fontSize: fontSize, styleFonts: styleFonts)
        let font = base[.font] as! NSFont
        let italic = font.riffetItalic
        let value: NSMutableAttributedString
        if let runs {
            value = NSMutableAttributedString()
            value.beginEditing()
            for run in runs {
                var attributes = base
                switch run.token {
                case .comment:
                    attributes[.foregroundColor] = palette.codeNSColor(\.comment, codeTheme: codeTheme, codeRevision: codeRevision)
                    if commentItalic { attributes[.font] = italic }
                case .punctuation: attributes[.foregroundColor] = palette.nsColor(\.fg3)
                case .keyword: attributes[.foregroundColor] = palette.codeNSColor(\.keyword, codeTheme: codeTheme, codeRevision: codeRevision)
                case .string: attributes[.foregroundColor] = palette.codeNSColor(\.string, codeTheme: codeTheme, codeRevision: codeRevision)
                case .number: attributes[.foregroundColor] = palette.codeNSColor(\.number, codeTheme: codeTheme, codeRevision: codeRevision)
                case .constant: attributes[.foregroundColor] = palette.codeNSColor(\.constant, codeTheme: codeTheme, codeRevision: codeRevision)
                case .declaration: attributes[.foregroundColor] = palette.codeNSColor(\.declaration, codeTheme: codeTheme, codeRevision: codeRevision)
                case .type: attributes[.foregroundColor] = palette.codeNSColor(\.type, codeTheme: codeTheme, codeRevision: codeRevision)
                case .property: attributes[.foregroundColor] = palette.codeNSColor(\.property, codeTheme: codeTheme, codeRevision: codeRevision)
                case .namespace: attributes[.foregroundColor] = palette.codeNSColor(\.namespace, codeTheme: codeTheme, codeRevision: codeRevision)
                case .tag: attributes[.foregroundColor] = palette.codeNSColor(\.tag, codeTheme: codeTheme, codeRevision: codeRevision)
                case .attribute: attributes[.foregroundColor] = palette.codeNSColor(\.attribute, codeTheme: codeTheme, codeRevision: codeRevision)
                case .annotation: attributes[.foregroundColor] = palette.codeNSColor(\.annotation, codeTheme: codeTheme, codeRevision: codeRevision)
                case .escape: attributes[.foregroundColor] = palette.codeNSColor(\.escape, codeTheme: codeTheme, codeRevision: codeRevision)
                case .heading: attributes[.foregroundColor] = palette.codeNSColor(\.heading, codeTheme: codeTheme, codeRevision: codeRevision)
                case nil: break
                }
                value.append(NSAttributedString(string: run.text, attributes: attributes))
            }
            value.endEditing()
        } else {
            value = NSMutableAttributedString(string: text, attributes: base)
        }
        if let known { return (value, known) }
        return (value, lineStarts(text))
    }

    nonisolated static func baseAttributes(palette: Palette, fontSize: CGFloat, styleFonts: StyleSpec.Fonts) -> [NSAttributedString.Key: Any] {
        let font = RiffetFace.nsFont(size: fontSize, mono: true, plugin: AppearanceFonts.current, style: styleFonts) ?? NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineHeightMultiple = 1.25
        return [.font: font, .foregroundColor: palette.nsColor(\.fg), .paragraphStyle: paragraph]
    }

    nonisolated static func lineStarts(_ text: String) -> [Int] {
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
        return starts
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        weak var textView: NSTextView?
        weak var ruler: LineNumberRuler?
        var applied = ""
        var appliedText = ""
        var targetToken = -1
        /// A jump asked for before the text arrived.
        var pendingTarget: Int?
        var build: Task<Void, Never>?
        var onChange: ((String) -> Void)?
        var restyle: ((String) async -> Void)?
        var typing: [NSAttributedString.Key: Any] = [:]
        var debounce: Task<Void, Never>?

        @MainActor
        func textDidChange(_ notification: Notification) {
            guard let textView, textView.isEditable else { return }
            let text = textView.string
            appliedText = text
            build?.cancel()
            ruler?.reset(text: text, starts: CodeTextView.lineStarts(text))
            textView.typingAttributes = typing
            onChange?(text)
            debounce?.cancel()
            debounce = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled, let self else { return }
                await self.restyle?(text)
            }
        }

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

    func line(atCharacter index: Int) -> Int {
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

/// An identifier in a source file, with where it stands: `line` and `column` are 1-based, the column
/// in UTF-16 units, as the server's code navigation counts them.
struct CodeSymbol: Equatable {
    let word: String
    let line: Int
    let column: Int
    let range: NSRange
}

enum CodeSymbolIntent { case definition, usages }

/// The preview's text view: with ⌘ held, the identifier under the pointer is underlined and a click
/// goes to its definition; its context menu offers the definition and the usages.
final class SymbolTextView: NSTextView {
    var onSymbol: ((CodeSymbol, CodeSymbolIntent) -> Void)?
    var linkColor: NSColor = .linkColor
    weak var ruler: LineNumberRuler?
    private var hovered: NSRange?
    private var monitor: Any?

    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        guard window != nil else { return }
        // Pressing or releasing ⌘ under a resting pointer sends no mouse event.
        monitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            guard let self, let window = self.window else { return event }
            self.refreshHover(command: event.modifierFlags.contains(.command), at: self.convert(window.mouseLocationOutsideOfEventStream, from: nil))
            return event
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas where area.owner === self { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        refreshHover(command: event.modifierFlags.contains(.command), at: convert(event.locationInWindow, from: nil))
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        setHover(nil)
    }

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command), let onSymbol, let symbol = symbol(at: convert(event.locationInWindow, from: nil)) {
            setHover(nil)
            onSymbol(symbol, .definition)
            return
        }
        super.mouseDown(with: event)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event)
        guard let onSymbol, let menu, let symbol = symbol(at: convert(event.locationInWindow, from: nil)) else { return menu }
        menu.insertItem(MenuAction.item(String(localized: "跳转到定义"), symbol: "arrow.turn.down.right") { onSymbol(symbol, .definition) }, at: 0)
        menu.insertItem(MenuAction.item(String(localized: "查找用法"), symbol: "magnifyingglass") { onSymbol(symbol, .usages) }, at: 1)
        menu.insertItem(.separator(), at: 2)
        return menu
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        guard let hovered, let rect = rect(of: hovered) else { return }
        addCursorRect(rect.intersection(visibleRect), cursor: .pointingHand)
    }

    private func refreshHover(command: Bool, at point: NSPoint) {
        guard onSymbol != nil, command, let symbol = symbol(at: point) else { setHover(nil); return }
        setHover(symbol.range)
    }

    private func setHover(_ range: NSRange?) {
        guard range != hovered else { return }
        let length = textStorage?.length ?? 0
        if let old = hovered {
            let clamped = NSIntersectionRange(old, NSRange(location: 0, length: length))
            layoutManager?.removeTemporaryAttribute(.underlineStyle, forCharacterRange: clamped)
            layoutManager?.removeTemporaryAttribute(.foregroundColor, forCharacterRange: clamped)
        }
        hovered = range
        if let range, NSMaxRange(range) <= length {
            layoutManager?.addTemporaryAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, forCharacterRange: range)
            layoutManager?.addTemporaryAttribute(.foregroundColor, value: linkColor, forCharacterRange: range)
        }
        window?.invalidateCursorRects(for: self)
    }

    private func rect(of range: NSRange) -> NSRect? {
        guard let layout = layoutManager, let container = textContainer, NSMaxRange(range) <= (textStorage?.length ?? 0) else { return nil }
        let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
        rect.origin.x += textContainerOrigin.x
        rect.origin.y += textContainerOrigin.y
        return rect
    }

    /// The identifier under [point] (view coordinates); nil off the text, on punctuation or on a number.
    private func symbol(at point: NSPoint) -> CodeSymbol? {
        guard let layout = layoutManager, let container = textContainer, let ruler, let text = textStorage?.string as NSString?, text.length > 0 else { return nil }
        let local = NSPoint(x: point.x - textContainerOrigin.x, y: point.y - textContainerOrigin.y)
        let glyph = layout.glyphIndex(for: local, in: container)
        guard glyph < layout.numberOfGlyphs,
              layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container).contains(local) else { return nil }
        let index = layout.characterIndexForGlyph(at: glyph)
        func isWord(_ unit: unichar) -> Bool {
            (unit >= 48 && unit <= 57) || (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122) || unit == 95 || unit == 36
        }
        guard index < text.length, isWord(text.character(at: index)) else { return nil }
        var start = index, end = index + 1
        while start > 0, index - start < 200, isWord(text.character(at: start - 1)) { start -= 1 }
        while end < text.length, end - index < 200, isWord(text.character(at: end)) { end += 1 }
        let first = text.character(at: start)
        guard !(first >= 48 && first <= 57), end - start <= 200 else { return nil }
        let line = ruler.line(atCharacter: start)
        let lineStart = ruler.range(ofLine: line)?.location ?? 0
        return CodeSymbol(word: text.substring(with: NSRange(location: start, length: end - start)), line: line, column: start - lineStart + 1, range: NSRange(location: start, length: end - start))
    }
}
