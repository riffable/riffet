import AppKit
import SwiftTerm
import RiffetKit

/// One SwiftTerm view holds the pane's whole scrollback (docs/TERMINAL.md): the server's snapshot
/// seeds it and it scrolls, selects and routes the wheel (mouse report, arrow keys, scrollback)
/// itself. This enclosing scroll view only pans sideways when the pane is wider than the viewport.
@MainActor
final class TerminalScrollView: NSScrollView, TerminalSurfaceBackend {
    let live = ScrollingTerminalView(frame: .zero)
    var onInput: ((String) -> Void)?
    var onReply: ((String) -> Void)? {
        get { live.onReply }
        set { live.onReply = newValue }
    }
    var onTextPaste: ((String) -> Void)? {
        get { live.onTextPaste }
        set { live.onTextPaste = newValue }
    }
    var onAttachmentPaste: ((NSPasteboard) -> Bool)? {
        get { live.onAttachmentPaste }
        set { live.onAttachmentPaste = newValue }
    }
    var onViewportSize: ((Int, Int) -> Void)?
    var onScrollPositionChange: ((Bool) -> Void)?
    var onBell: (() -> Void)?
    var onClipboardCopy: ((String) -> Void)?
    var onOpenLink: ((URL) -> Void)?
    var onCommandExitCode: ((Int) -> Void)?
    var onOpenSearch: (() -> Void)?

    private var remoteGrid: (cols: Int, rows: Int)?
    var controlsRemote = false
    private var scrollOnInput = true
    private var scrollOnOutput = false
    var hasPromptMarkers: Bool {
        live.previousSemanticPromptRow() != nil || live.nextSemanticPromptRow() != nil
    }

    private let document = TerminalDocumentView()
    private var delegateProxy: DelegateProxy?
    private var eventMonitor: Any?
    private var viewportSize = NSSize.zero
    private var rebuilding = false

    var surfaceView: NSView { self }

    /// The live bottom: nothing to scroll, or the view follows new output.
    var atBottom: Bool { !live.canScroll || live.scrollPosition >= 1 }

    override init(frame: NSRect) {
        super.init(frame: frame)
        borderType = .noBorder
        drawsBackground = false
        hasVerticalScroller = true
        hasHorizontalScroller = true
        autohidesScrollers = true
        scrollerStyle = .overlay
        horizontalScrollElasticity = .none
        verticalScrollElasticity = .none
        documentView = document
        document.addSubview(live)
        live.registerForDraggedTypes([.fileURL, .png, .tiff])
        live.changeScrollback(Self.scrollbackRows)
        let proxy = DelegateProxy(owner: self)
        delegateProxy = proxy
        live.terminalDelegate = proxy
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        if let eventMonitor { NSEvent.removeMonitor(eventMonitor) }
    }

    private static let scrollbackRows = Int(StreamKt.TERMINAL_SCROLLBACK_ROWS)

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let eventMonitor { NSEvent.removeMonitor(eventMonitor); self.eventMonitor = nil }
        guard window != nil else { return }
        // Intercept horizontal scroll (SwiftTerm only handles vertical wheel) and terminal-local
        // Cmd+F / Cmd+Up / Cmd+Down shortcuts when this terminal view is first responder.
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .keyDown]) { [weak self] event in
            guard let self, let window, event.window === window, !isHiddenOrHasHiddenAncestor else { return event }
            if event.type == .scrollWheel {
                guard abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY),
                      bounds.contains(convert(event.locationInWindow, from: nil)) else { return event }
                scrollWheel(with: event)
                return nil
            }
            if event.type == .keyDown, window.firstResponder === live {
                let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                let mods = flags.subtracting([.numericPad, .function, .capsLock])
                if mods == .command, event.charactersIgnoringModifiers?.lowercased() == "f" {
                    onOpenSearch?()
                    return nil
                }
                if mods == .command, event.charactersIgnoringModifiers?.lowercased() == "k" {
                    // Clear scrollback locally and ask the remote shell to redraw the prompt via Ctrl+L.
                    live.feed(text: "\u{1b}[3J")
                    onInput?("\u{0c}")
                    return nil
                }
                if mods == .command || mods == [.command, .shift] {
                    let chars = event.charactersIgnoringModifiers ?? ""
                    if chars == "=" || chars == "+" {
                        let prefs = DisplayPreferences.shared
                        prefs.terminalFontSize = min(DisplayPreferences.terminalFontSizeRange.upperBound, prefs.terminalFontSize + 1)
                        return nil
                    }
                    if chars == "-" || chars == "_" {
                        let prefs = DisplayPreferences.shared
                        prefs.terminalFontSize = max(DisplayPreferences.terminalFontSizeRange.lowerBound, prefs.terminalFontSize - 1)
                        return nil
                    }
                    if mods == .command, chars == "0" {
                        DisplayPreferences.shared.terminalFontSize = DisplayPreferences.defaultTerminalFontSize
                        return nil
                    }
                }
                if mods == .command {
                    if event.keyCode == 126, jumpToPreviousPrompt() { return nil }
                    if event.keyCode == 125, jumpToNextPrompt() { return nil }
                }
            }
            return event
        }
    }

    override func layout() {
        super.layout()
        guard !rebuilding, contentSize.width > 0, contentSize.height > 0, contentSize != viewportSize else { return }
        viewportSize = contentSize
        rebuilding = true
        defer { rebuilding = false }
        let dimensions = live.terminalDimensions
        let optimal = live.getOptimalFrameSize().size
        let cellWidth = optimal.width / CGFloat(max(1, dimensions.cols))
        let cellHeight = optimal.height / CGFloat(max(1, dimensions.rows))
        onViewportSize?(max(20, Int(viewportSize.width / max(1, cellWidth))), max(5, Int(viewportSize.height / max(1, cellHeight))))
        if let remoteGrid {
            live.setFrameSize(NSSize(width: cellWidth * CGFloat(remoteGrid.cols), height: cellHeight * CGFloat(remoteGrid.rows)))
        } else {
            live.setFrameSize(viewportSize)
        }
        fitDocument()
    }

    func feed(_ text: String, fresh: Bool, cols: Int, rows: Int) {
        if fresh {
            setRemoteGrid(cols: cols, rows: rows)
            live.resetToInitialState()
        }
        scanCommandExitCode(in: text)
        live.feed(text: text)
        if !fresh, scrollOnOutput, !atBottom {
            scrollToLive()
        }
    }

    /// Lightweight scan for OSC 133;D;<exitCode> markers emitted by Shell Integration.
    private func scanCommandExitCode(in text: String) {
        let needle = "\u{1b}]133;D;"
        guard text.contains(needle) else { return }
        var searchStart = text.startIndex
        var latestCode: Int?
        while let range = text.range(of: needle, range: searchStart..<text.endIndex) {
            let after = range.upperBound
            var cursor = after
            while cursor < text.endIndex, text[cursor].isNumber {
                cursor = text.index(after: cursor)
            }
            if cursor > after, let code = Int(text[after..<cursor]) {
                latestCode = code
            }
            searchStart = cursor
        }
        if let latestCode { onCommandExitCode?(latestCode) }
    }

    func applyAppearance(_ appearance: TerminalSurfaceAppearance) {
        drawsBackground = true
        backgroundColor = appearance.background
        contentView.drawsBackground = true
        contentView.backgroundColor = appearance.background
        live.font = appearance.font
        live.nativeBackgroundColor = appearance.background
        live.nativeForegroundColor = appearance.foreground
        live.caretColor = appearance.cursor
        live.caretTextColor = appearance.cursorText
        live.selectedTextBackgroundColor = appearance.selection
        // The contrast resolver and the emulator must agree on the 256-color cube.
        live.ansi256PaletteStrategy = .xterm
        live.installColors(appearance.ansiColors)
        live.updateColorScheme(appearance.dark ? .dark : .light, notify: false)
        live.optionAsMetaKey = appearance.optionAsMeta
        live.autoCopyOnSelect = appearance.copyOnSelect
        live.rightClickCopyPaste = appearance.rightClick == .copyPaste
        live.scrollSensitivity = CGFloat(appearance.scrollSensitivity)
        scrollOnInput = appearance.scrollOnInput
        scrollOnOutput = appearance.scrollOnOutput
        let resolvedCursor: SwiftTerm.CursorStyle = switch (appearance.cursorStyle, appearance.cursorBlink) {
        case (.block, true): .blinkBlock
        case (.block, false): .steadyBlock
        case (.underline, true): .blinkUnderline
        case (.underline, false): .steadyUnderline
        case (.bar, true): .blinkBar
        case (.bar, false): .steadyBar
        }
        live.setCursorStyle(resolvedCursor)
        refreshAppearance()
    }

    /// The display frame follows the server grid; local bounds only propose an owner resize.
    func setRemoteGrid(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        remoteGrid = (cols, rows)
        if live.terminalDimensions.cols != cols || live.terminalDimensions.rows != rows { live.resize(cols: cols, rows: rows) }
        live.setFrameSize(live.getOptimalFrameSize().size)
        viewportSize = .zero
        needsLayout = true
    }

    /// A font change resizes the cells; the grid and the proposed pane size follow.
    func refreshAppearance() {
        if let remoteGrid { setRemoteGrid(cols: remoteGrid.cols, rows: remoteGrid.rows) } else { viewportSize = .zero; needsLayout = true }
    }

    private func fitDocument() {
        document.frame = NSRect(x: 0, y: 0, width: max(viewportSize.width, live.frame.width), height: max(viewportSize.height, live.frame.height))
        live.setFrameOrigin(.zero)
    }

    func scrollToLive() {
        live.scroll(toPosition: 1)
    }

    func notifyColorScheme() {
        live.notifyColorScheme()
    }

    func focusSurface() {
        guard let window = live.window else { return }
        window.makeFirstResponder(live)
    }

    @discardableResult
    func findNext(_ term: String, caseSensitive: Bool, regex: Bool) -> Bool {
        guard !term.isEmpty else { clearSearch(); return false }
        return live.findNext(term, options: SearchOptions(caseSensitive: caseSensitive, regex: regex))
    }

    @discardableResult
    func findPrevious(_ term: String, caseSensitive: Bool, regex: Bool) -> Bool {
        guard !term.isEmpty else { clearSearch(); return false }
        return live.findPrevious(term, options: SearchOptions(caseSensitive: caseSensitive, regex: regex))
    }

    func searchMatchSummary(_ term: String, caseSensitive: Bool, regex: Bool) -> (index: Int, total: Int) {
        guard !term.isEmpty else { return (0, 0) }
        return live.searchMatchSummary(term, options: SearchOptions(caseSensitive: caseSensitive, regex: regex))
    }

    func clearSearch() {
        live.clearSearch()
    }

    @discardableResult
    func jumpToPreviousPrompt() -> Bool {
        guard let target = live.previousSemanticPromptRow() else { return false }
        live.scrollTo(row: target)
        onScrollPositionChange?(atBottom)
        return true
    }

    @discardableResult
    func jumpToNextPrompt() -> Bool {
        guard let target = live.nextSemanticPromptRow() else { return false }
        live.scrollTo(row: target)
        onScrollPositionChange?(atBottom)
        return true
    }

    private final class DelegateProxy: NSObject, TerminalViewDelegate {
        weak var owner: TerminalScrollView?

        init(owner: TerminalScrollView) { self.owner = owner }

        // Only the enclosing viewport proposes a pane size. The emulator follows snapshots.
        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {}

        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            let text = String(decoding: Array(data), as: UTF8.self)
            MainActor.assumeIsolated {
                guard let owner, source === owner.live else { return }
                if owner.scrollOnInput, !owner.atBottom { owner.scrollToLive() }
                owner.onInput?(text)
            }
        }

        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}

        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}

        func scrolled(source: SwiftTerm.TerminalView, position: Double) {
            MainActor.assumeIsolated {
                guard let owner, source === owner.live else { return }
                owner.onScrollPositionChange?(owner.atBottom)
            }
        }

        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link) {
                MainActor.assumeIsolated { owner?.onOpenLink?(url) }
            }
        }

        func bell(source: SwiftTerm.TerminalView) {
            MainActor.assumeIsolated { owner?.onBell?() }
        }

        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {
            if let text = String(data: content, encoding: .utf8) {
                MainActor.assumeIsolated { owner?.onClipboardCopy?(text) }
            }
        }

        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}
    }
}

@MainActor
final class ScrollingTerminalView: SwiftTerm.TerminalView {
    /// Parser replies have no authority to take the input lease from another client.
    var onReply: ((String) -> Void)?
    var onAttachmentPaste: ((NSPasteboard) -> Bool)?
    /// Pasted text goes to the server, which brackets it when the program asked for that.
    var onTextPaste: ((String) -> Void)?
    var autoCopyOnSelect = false
    var rightClickCopyPaste = false
    private var copyWorkItem: DispatchWorkItem?

    nonisolated override func send(source: SwiftTerm.Terminal, data: ArraySlice<UInt8>) {
        let text = String(decoding: data, as: UTF8.self)
        DispatchQueue.main.async { [weak self] in self?.onReply?(text) }
    }

    nonisolated override func selectionChanged(source: SwiftTerm.Terminal) {
        super.selectionChanged(source: source)
        DispatchQueue.main.async { [weak self] in
            guard let self, self.autoCopyOnSelect else { return }
            self.copyWorkItem?.cancel()
            let item = DispatchWorkItem { [weak self] in
                guard let self, self.autoCopyOnSelect, let text = self.getSelection(), !text.isEmpty else { return }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
            self.copyWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(120), execute: item)
        }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        ComposerModel.holdsAttachment(sender.draggingPasteboard) ? .copy : []
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        window?.makeFirstResponder(self)
        return onAttachmentPaste?(sender.draggingPasteboard) ?? false
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        guard rightClickCopyPaste else { return super.menu(for: event) }
        if let text = getSelection(), !text.isEmpty {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            selectNone()
        } else {
            paste(self)
        }
        return nil
    }

    override func paste(_ sender: Any) {
        if onAttachmentPaste?(NSPasteboard.general) == true { return }
        guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else { return }
        scrollToBottom()
        onTextPaste?(text)
    }

    private func scrollToBottom() { scroll(toPosition: 1) }
}

private final class TerminalDocumentView: NSView {
    override var isFlipped: Bool { true }
}
